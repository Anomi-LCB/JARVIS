export class CoreWorkerDaemon {
  constructor({
    worker,
    daemonId = 'a-core-worker-daemon',
    enabled = true,
    intervalMs = 1_000,
    drainLimit = 5,
    recoverLeases = true,
    maxConsecutiveFailures = 3,
    clock = () => new Date(),
    setTimer = setInterval,
    clearTimer = clearInterval
  } = {}) {
    if (!worker) {
      throw new Error('CoreWorkerDaemon requires worker.');
    }
    this.worker = worker;
    this.daemonId = daemonId;
    this.enabled = enabled;
    this.intervalMs = Number(intervalMs);
    this.drainLimit = Number(drainLimit);
    this.recoverLeases = recoverLeases;
    this.maxConsecutiveFailures = Number(maxConsecutiveFailures);
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
      const drain = this.worker.drain && Number(drainLimit) > 0
        ? await this.worker.drain({ limit: Number(drainLimit), now: this.lastTickAt })
        : null;
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
      lastRecovery: this.lastRecovery,
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
