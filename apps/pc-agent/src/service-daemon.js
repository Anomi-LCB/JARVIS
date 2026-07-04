export class PcAgentServiceSupervisor {
  constructor({
    pcAgent,
    enabled = true,
    intervalMs = 1_000,
    batchLimit = 5,
    maxConsecutiveFailures = 3,
    clock = () => new Date(),
    setTimer = setInterval,
    clearTimer = clearInterval
  } = {}) {
    if (!pcAgent) throw new Error('pcAgent is required');
    this.pcAgent = pcAgent;
    this.enabled = enabled;
    this.intervalMs = Number(intervalMs);
    this.batchLimit = Number(batchLimit);
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
    this.consecutiveFailures = 0;
    this.lastTickAt = null;
    this.lastDrain = null;
    this.lastError = null;
    this.lastWatchdog = null;
  }

  start() {
    if (!this.enabled) {
      return { success: false, status: 'disabled', supervisor: this.status() };
    }
    if (this.timer) {
      return { success: true, status: 'already-running', supervisor: this.status() };
    }
    this.startedAt = this.clock().toISOString();
    this.stoppedAt = null;
    this.timer = this.setTimer(() => {
      this.tick({ reason: 'interval' }).catch((error) => {
        this.recordFailure(error, { reason: 'interval' });
      });
    }, this.intervalMs);
    this.pcAgent.auditLog.write('service.supervisor.started', {
      intervalMs: this.intervalMs,
      batchLimit: this.batchLimit,
      maxConsecutiveFailures: this.maxConsecutiveFailures
    });
    return { success: true, status: 'started', supervisor: this.status() };
  }

  stop() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.stoppedAt = this.clock().toISOString();
    this.pcAgent.auditLog.write('service.supervisor.stopped', {
      tickCount: this.tickCount,
      processedTotal: this.processedTotal,
      consecutiveFailures: this.consecutiveFailures
    });
    return { success: true, status: 'stopped', supervisor: this.status() };
  }

  async tick({ reason = 'manual' } = {}) {
    if (!this.enabled) {
      return { success: false, status: 'disabled', supervisor: this.status() };
    }
    if (this.draining) {
      const skipped = { success: true, status: 'skipped', reason: 'drain-already-running', supervisor: this.status() };
      this.pcAgent.auditLog.write('service.queue_drain.skipped', { reason: skipped.reason });
      return skipped;
    }
    this.draining = true;
    this.tickCount += 1;
    this.lastTickAt = this.clock().toISOString();
    try {
      const before = this.pcAgent.executionQueueStatus();
      const drain = await this.pcAgent.processExecutionQueue({ limit: this.batchLimit });
      const after = this.pcAgent.executionQueueStatus();
      this.processedTotal += drain.processed;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastDrain = {
        reason,
        at: this.lastTickAt,
        before,
        after,
        processed: drain.processed,
        succeeded: drain.status.succeeded,
        failed: drain.status.failed,
        retryScheduled: drain.status.retryScheduled,
        quarantined: drain.status.quarantined
      };
      this.pcAgent.auditLog.write('service.queue_drain.succeeded', this.lastDrain);
      const watchdog = this.watchdog({ reason, write: true });
      return {
        success: true,
        status: watchdog.status,
        drain,
        watchdog,
        supervisor: this.status({ includeWatchdog: false })
      };
    } catch (error) {
      const failure = this.recordFailure(error, { reason });
      return { success: false, status: failure.watchdog.status, error: failure.error, watchdog: failure.watchdog, supervisor: this.status({ includeWatchdog: false }) };
    } finally {
      this.draining = false;
    }
  }

  recordFailure(error, { reason = 'manual' } = {}) {
    this.consecutiveFailures += 1;
    this.lastError = {
      at: this.clock().toISOString(),
      reason,
      code: error?.code ?? 'B_SERVICE_QUEUE_DRAIN_FAILED',
      message: error?.message ?? String(error)
    };
    this.pcAgent.auditLog.write('service.queue_drain.failed', {
      ...this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures
    });
    const watchdog = this.watchdog({ reason, write: true });
    return { error: this.lastError, watchdog };
  }

  watchdog({ reason = 'manual', write = false } = {}) {
    const queue = this.pcAgent.executionQueueStatus();
    const checks = [
      { id: 'queue-status-readable', status: queue ? 'pass' : 'fail', detail: { queued: queue?.queued ?? null } },
      { id: 'undo-chain-valid', status: this.pcAgent.undoJournal.verifyChain().status === 'valid' ? 'pass' : 'fail' },
      { id: 'rollback-transaction-chain-valid', status: this.pcAgent.rollbackTransactionStatus().chain.status === 'valid' ? 'pass' : 'fail' },
      {
        id: 'queue-drain-failure-budget',
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
      status: failed.length ? 'unhealthy' : warnings.length ? 'degraded' : 'healthy',
      reason,
      checkedAt: this.clock().toISOString(),
      restartRecommended: this.consecutiveFailures >= this.maxConsecutiveFailures,
      queue,
      checks
    };
    this.lastWatchdog = heartbeat;
    if (write) this.pcAgent.auditLog.write('service.watchdog.heartbeat', heartbeat);
    return heartbeat;
  }

  status({ includeWatchdog = true } = {}) {
    const running = Boolean(this.timer);
    const base = {
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
      batchLimit: this.batchLimit,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      draining: this.draining,
      tickCount: this.tickCount,
      processedTotal: this.processedTotal,
      consecutiveFailures: this.consecutiveFailures,
      lastTickAt: this.lastTickAt,
      lastDrain: this.lastDrain,
      lastError: this.lastError
    };
    if (!includeWatchdog) return base;
    return {
      ...base,
      watchdog: this.lastWatchdog ?? this.watchdog({ reason: 'status', write: false })
    };
  }
}

export function createPcAgentServiceSupervisor(pcAgent, daemonConfig = {}, options = {}) {
  const queueDrain = daemonConfig.queueDrain ?? {};
  return new PcAgentServiceSupervisor({
    pcAgent,
    enabled: options.enabled ?? queueDrain.enabled ?? true,
    intervalMs: options.intervalMs ?? queueDrain.intervalMs ?? 1_000,
    batchLimit: options.batchLimit ?? queueDrain.batchLimit ?? 5,
    maxConsecutiveFailures: options.maxConsecutiveFailures ?? queueDrain.maxConsecutiveFailures ?? 3,
    clock: options.clock,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer
  });
}
