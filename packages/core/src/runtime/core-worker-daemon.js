export class CoreWorkerDaemon {
  constructor({
    worker,
    daemonId = 'a-core-worker-daemon',
    enabled = true,
    intervalMs = 1_000,
    drainLimit = 5,
    sourceRetractionIntervalMs = 5_000,
    recoverLeases = true,
    maxConsecutiveFailures = 3,
    routineScheduler = null,
    sourceRevisionScheduler = null,
    personalOperationsScheduler = null,
    clock = () => new Date(),
    setTimer = setInterval,
    clearTimer = clearInterval
  } = {}) {
    if (!worker) {
      throw new Error('CoreWorkerDaemon requires worker.');
    }
    if (!Number.isSafeInteger(sourceRetractionIntervalMs) || sourceRetractionIntervalMs < 100 || sourceRetractionIntervalMs > 60_000) {
      throw new RangeError("Invalid source retraction interval.");
    }
    this.sourceRetractionIntervalMs = sourceRetractionIntervalMs;
    this.lastSourceRetractionAttemptMs = null;
    this.lastSourceRetractionSync = null;
    this.worker = worker;
    this.daemonId = daemonId;
    this.enabled = enabled;
    this.intervalMs = Number(intervalMs);
    this.drainLimit = Number(drainLimit);
    this.recoverLeases = recoverLeases;
    this.maxConsecutiveFailures = Number(maxConsecutiveFailures);
    this.routineScheduler = routineScheduler;
    this.sourceRevisionScheduler = sourceRevisionScheduler;
    this.personalOperationsScheduler = personalOperationsScheduler;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.draining = false;
    this.startedAt = null;
    this.stoppedAt = null;
    this.tickCount = 0;
    this.processedTotal = 0;
    this.recoveredLeaseTotal = 0;
    this.consecutiveFailures = 0;
    this.lastTickAt = null;
    this.lastDrain = null;
    this.lastRecovery = null;
    this.lastMemoryReplay = null;
    this.lastError = null;
    this.lastWatchdog = null;
  }

  start({ reason = 'manual-start' } = {}) {
    if (!this.enabled) {
      return { success: false, status: 'disabled', daemon: this.status() };
    }
    if (this.timer) {
      return { success: true, status: 'already-running', daemon: this.status() };
    }
    this.startedAt = this.clock().toISOString();
    this.stoppedAt = null;
    this.timer = this.setTimer(() => {
      this.tick({ reason: 'interval' }).catch((error) => {
        this.recordFailure(error, { reason: 'interval' });
      });
    }, this.intervalMs);
    this.publish('core.worker.daemon.started', {
      daemonId: this.daemonId,
      reason,
      intervalMs: this.intervalMs,
      drainLimit: this.drainLimit,
      recoverLeases: this.recoverLeases
    });
    return { success: true, status: 'started', daemon: this.status() };
  }

  stop({ reason = 'manual-stop' } = {}) {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.stoppedAt = this.clock().toISOString();
    this.publish('core.worker.daemon.stopped', {
      daemonId: this.daemonId,
      reason,
      tickCount: this.tickCount,
      processedTotal: this.processedTotal,
      recoveredLeaseTotal: this.recoveredLeaseTotal
    });
    return { success: true, status: 'stopped', daemon: this.status() };
  }

  async tick({ reason = 'manual', drainLimit = this.drainLimit, recoverLeases = this.recoverLeases } = {}) {
    if (!this.enabled) {
      return { success: false, status: 'disabled', daemon: this.status() };
    }
    if (this.draining) {
      const skipped = { success: true, status: 'skipped', reason: 'drain-already-running', daemon: this.status() };
      this.publish('core.worker.daemon.skipped', { daemonId: this.daemonId, reason: skipped.reason });
      return skipped;
    }
    this.draining = true;
    this.tickCount += 1;
    this.lastTickAt = this.clock().toISOString();
    try {
      const before = this.worker.queueStatus();
      const recovery = recoverLeases && this.worker.recoverExpiredLeases
        ? this.worker.recoverExpiredLeases({ now: this.lastTickAt })
        : null;
      // Replay retained learning even when there is no new Core task. A memory
      // outage must remain visible without preventing unrelated task execution.
      const memoryReplay = await this.replayPendingMemory();
      const sourceRetractions = await this.retrySourceRetractions();
      const drain = this.worker.drain && Number(drainLimit) > 0
        ? await this.worker.drain({ limit: Number(drainLimit), now: this.lastTickAt })
        : null;
      const routines = this.routineScheduler?.tick ? await this.routineScheduler.tick() : null;
      if (routines?.success === false) {
        const error = Object.assign(new Error(routines.error?.message ?? 'Durable routine scheduler tick failed.'), {
          code: routines.error?.code ?? 'A_ROUTINE_TICK_FAILED'
        });
        throw error;
      }
      const sourceRevisions = this.sourceRevisionScheduler?.tick ? await this.sourceRevisionScheduler.tick() : null;
      if (sourceRevisions?.success === false) {
        const error = Object.assign(new Error(sourceRevisions.error?.message ?? 'Source revision scheduler tick failed.'), {
          code: sourceRevisions.error?.code ?? 'A_SOURCE_REVISION_TICK_FAILED'
        });
        throw error;
      }
      const personalOperations = this.personalOperationsScheduler?.tickAsync
        ? await this.personalOperationsScheduler.tickAsync()
        : this.personalOperationsScheduler?.tick ? await this.personalOperationsScheduler.tick() : null;
      if (personalOperations?.success === false) {
        const error = Object.assign(new Error(personalOperations.error?.message ?? 'Personal operations reminder tick failed.'), {
          code: personalOperations.error?.code ?? 'A_PERSONAL_REMINDER_TICK_FAILED'
        });
        throw error;
      }
      const after = this.worker.queueStatus();
      this.processedTotal += drain?.processed ?? 0;
      this.recoveredLeaseTotal += recovery?.recoveredCount ?? 0;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastRecovery = recovery;
      this.lastDrain = {
        reason,
        at: this.lastTickAt,
        before,
        after,
        processed: drain?.processed ?? 0,
        routines,
        sourceRevisions,
        personalOperations,
        memoryReplay,
        sourceRetractions,
        recoveredLeaseCount: recovery?.recoveredCount ?? 0
      };
      this.publish('core.worker.daemon.tick.succeeded', this.lastDrain);
      const watchdog = this.watchdog({ reason, write: true });
      return {
        success: true,
        status: watchdog.status,
        recovery,
        drain,
        watchdog,
        daemon: this.status({ includeWatchdog: false })
      };
    } catch (error) {
      const failure = this.recordFailure(error, { reason });
      return { success: false, status: failure.watchdog.status, error: failure.error, watchdog: failure.watchdog, daemon: this.status({ includeWatchdog: false }) };
    } finally {
      this.draining = false;
    }
  }

  async replayPendingMemory() {
    const growth = this.worker.growthRuntime;
    if (!growth?.drainPendingMemory) return null;
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
    try {
      const result = await growth.drainPendingMemory({ limit: 10 });
      this.lastMemoryReplay = {
        at: this.lastTickAt,
        success: result?.success === true,
        stored: count(result?.stored),
        suppressed: count(result?.suppressed),
        failed: count(result?.failed),
        pendingCount: count(result?.pendingCount),
        // Provider messages and event payloads must not enter daemon telemetry.
        error: result?.success === true ? null : 'A_MEMORY_REPLAY_FAILED',
        executionAuthority: false
      };
    } catch {
      this.lastMemoryReplay = {
        at: this.lastTickAt, success: false, stored: null, suppressed: null,
        failed: null, pendingCount: null, error: 'A_MEMORY_REPLAY_FAILED',
        executionAuthority: false
      };
    }
    return this.lastMemoryReplay;
  }

  async retrySourceRetractions() {
    const growth = this.worker.growthRuntime;
    if (!growth?.synchronizeSourceRetractions) return null;
    const now = this.clock().getTime();
    if (this.lastSourceRetractionAttemptMs !== null && now >= this.lastSourceRetractionAttemptMs
      && now - this.lastSourceRetractionAttemptMs < this.sourceRetractionIntervalMs) return this.lastSourceRetractionSync;
    this.lastSourceRetractionAttemptMs = now;
    try {
      if (growth.ensureMemoryGeneration && !growth.ensureMemoryGeneration()) throw new Error('Memory unavailable');
      const result = await growth.synchronizeSourceRetractions({ deliveryLimit: 10 });
      if (!Array.isArray(result?.deliveries) || !Number.isSafeInteger(result.deferredDeliveryCount)
        || !Number.isSafeInteger(result.dispatchedCount) || result.dispatchedCount < 0
        || result.deferredDeliveryCount < 0 || !Number.isSafeInteger(result.preferenceUpdateFailedCount)
        || result.preferenceUpdateFailedCount < 0) throw new Error('Invalid synchronization result');
      this.lastSourceRetractionSync = {
        at: this.lastTickAt, success: true,
        preferenceUpdateFailedCount: result.preferenceUpdateFailedCount,
        projectionConfigured: result.projectionConfigured === true,
        dispatchedCount: result.dispatchedCount,
        pendingCount: result.deliveries.filter(item => item.propagated !== true).length + result.deferredDeliveryCount,
        deferredCount: result.deferredDeliveryCount, error: null, executionAuthority: false
      };
    } catch {
      this.lastSourceRetractionSync = { at: this.lastTickAt, success: false,
        preferenceUpdateFailedCount: null, projectionConfigured: null, dispatchedCount: null, pendingCount: null, deferredCount: null,
        error: 'A_SOURCE_RETRACTION_SYNC_FAILED', executionAuthority: false };
    }
    return this.lastSourceRetractionSync;
  }

  recordFailure(error, { reason = 'manual' } = {}) {
    this.consecutiveFailures += 1;
    this.lastError = {
      at: this.clock().toISOString(),
      reason,
      code: error?.code ?? 'A_CORE_WORKER_DAEMON_TICK_FAILED',
      message: error?.message ?? String(error)
    };
    this.publish('core.worker.daemon.tick.failed', {
      daemonId: this.daemonId,
      ...this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures
    });
    const watchdog = this.watchdog({ reason, write: true });
    return { error: this.lastError, watchdog };
  }

  watchdog({ reason = 'manual', write = false } = {}) {
    const queue = this.worker.queueStatus?.() ?? null;
    const leaseStatus = queue?.leases ?? this.worker.leaseTable?.status?.() ?? null;
    const checks = [
      { id: 'queue-status-readable', status: queue ? 'pass' : 'fail', detail: { total: queue?.total ?? null } },
      { id: 'lease-status-readable', status: leaseStatus ? 'pass' : 'fail', detail: { activeLeaseCount: leaseStatus?.activeLeaseCount ?? null } },
      {
        id: 'queue-persistence-configured',
        status: queue?.persistence?.enabled ? 'pass' : 'warning',
        detail: queue?.persistence ?? null
      },
      {
        id: 'lease-persistence-configured',
        status: leaseStatus?.persistence?.enabled ? 'pass' : 'warning',
        detail: leaseStatus?.persistence ?? null
      },
      {
        id: 'failure-budget',
        status: this.consecutiveFailures >= this.maxConsecutiveFailures ? 'fail' : 'pass',
        detail: {
          consecutiveFailures: this.consecutiveFailures,
          maxConsecutiveFailures: this.maxConsecutiveFailures
        }
      },
      {
        id: 'drain-not-overlapping',
        status: 'pass',
        detail: { draining: this.draining }
      }
    ];
    if (this.lastMemoryReplay) {
      checks.push({
        id: 'pending-memory-replay',
        status: !this.lastMemoryReplay.success || this.lastMemoryReplay.failed > 0
          || this.lastMemoryReplay.pendingCount > 0 ? 'warning' : 'pass',
        detail: this.lastMemoryReplay
      });
    }
    if (this.lastSourceRetractionSync) checks.push({
      id: "source-retraction-retry",
      status: !this.lastSourceRetractionSync.success || this.lastSourceRetractionSync.pendingCount > 0
        || this.lastSourceRetractionSync.preferenceUpdateFailedCount > 0 ? "warning" : "pass",
      detail: this.lastSourceRetractionSync
    });
    const failed = checks.filter((check) => check.status === 'fail');
    const warnings = checks.filter((check) => check.status === 'warning');
    const heartbeat = {
      watchdogVersion: 'a-core-worker-daemon-watchdog-v1',
      daemonId: this.daemonId,
      status: failed.length ? 'unhealthy' : warnings.length ? 'degraded' : 'healthy',
      reason,
      checkedAt: this.clock().toISOString(),
      restartRecommended: this.consecutiveFailures >= this.maxConsecutiveFailures,
      queue,
      leaseStatus,
      checks
    };
    this.lastWatchdog = heartbeat;
    if (write) this.publish('core.worker.daemon.watchdog', heartbeat);
    return heartbeat;
  }

  status({ includeWatchdog = true } = {}) {
    const running = Boolean(this.timer);
    const base = {
      daemonVersion: 'a-core-worker-daemon-v1',
      daemonId: this.daemonId,
      enabled: this.enabled,
      running,
      status: !this.enabled
        ? 'disabled'
        : this.consecutiveFailures >= this.maxConsecutiveFailures
          ? 'unhealthy'
          : running
            ? 'running'
            : 'stopped',
      intervalMs: this.intervalMs,
      drainLimit: this.drainLimit,
      recoverLeases: this.recoverLeases,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      draining: this.draining,
      tickCount: this.tickCount,
      processedTotal: this.processedTotal,
      recoveredLeaseTotal: this.recoveredLeaseTotal,
      consecutiveFailures: this.consecutiveFailures,
      lastTickAt: this.lastTickAt,
      lastDrain: this.lastDrain,
      routineScheduler: this.routineScheduler?.status?.() ?? null,
      sourceRevisionScheduler: this.sourceRevisionScheduler?.status?.() ?? null,
      personalOperationsScheduler: this.personalOperationsScheduler?.status?.() ?? null,
      lastRecovery: this.lastRecovery,
      lastMemoryReplay: this.lastMemoryReplay,
      lastSourceRetractionSync: this.lastSourceRetractionSync,
      lastError: this.lastError
    };
    if (!includeWatchdog) return base;
    return {
      ...base,
      watchdog: this.lastWatchdog ?? this.watchdog({ reason: 'status', write: false })
    };
  }

  publish(eventType, payload) {
    this.worker.coreFacade?.eventBus?.publish?.(eventType, payload);
  }
}
