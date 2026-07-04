export class CoreRuntimeSupervisor {
  constructor({
    runtime,
    worker = null,
    clock = () => new Date(),
    supervisorId = 'a-core-runtime-supervisor',
    restartPolicy = {}
  } = {}) {
    if (!runtime) {
      throw new Error('CoreRuntimeSupervisor requires runtime.');
    }
    this.runtime = runtime;
    this.worker = worker;
    this.clock = clock;
    this.supervisorId = supervisorId;
    this.restartPolicy = {
      maxRestarts: 3,
      faultThreshold: 3,
      unhealthyStatuses: ['stopped', 'unhealthy'],
      ...restartPolicy
    };
    this.running = false;
    this.startedAt = null;
    this.stoppedAt = null;
    this.heartbeats = [];
    this.restartAttempts = 0;
  }

  start({ reason = 'manual-start' } = {}) {
    if (!this.runtime.initialized) this.runtime.init({ profile: 'supervised-core' });
    if (!this.runtime.started) this.runtime.start();
    this.running = true;
    this.startedAt = this.clock().toISOString();
    this.runtime.eventBus.publish('core.supervisor.started', {
      supervisorId: this.supervisorId,
      reason,
      startedAt: this.startedAt,
      restartPolicy: this.restartPolicy
    });
    return this.status();
  }

  stop({ reason = 'manual-stop' } = {}) {
    this.running = false;
    this.stoppedAt = this.clock().toISOString();
    this.runtime.eventBus.publish('core.supervisor.stopped', {
      supervisorId: this.supervisorId,
      reason,
      stoppedAt: this.stoppedAt
    });
    return this.status();
  }

  async tick({ reason = 'manual-tick', drainLimit = 0 } = {}) {
    if (!this.running) this.start({ reason: 'tick-auto-start' });
    let drain = null;
    if (this.worker?.drain && drainLimit > 0) {
      drain = await this.worker.drain({ limit: drainLimit });
    }
    const before = this.runtime.health();
    const decision = this.recoveryDecision(before);
    let recoveryAction = 'none';
    let after = before;
    if (decision.restartRecommended) {
      if (this.restartAttempts < this.restartPolicy.maxRestarts) {
        this.restartAttempts += 1;
        after = this.runtime.restart(`supervisor:${decision.reason}`);
        recoveryAction = 'runtime-restarted';
      } else {
        recoveryAction = 'restart-budget-exhausted';
      }
    }
    const heartbeat = {
      heartbeatVersion: 'a-core-supervisor-heartbeat-v1',
      supervisorId: this.supervisorId,
      heartbeatId: `core_hb_${this.heartbeats.length + 1}`,
      at: this.clock().toISOString(),
      reason,
      status: this.heartbeatStatus(after, decision),
      restartRecommended: decision.restartRecommended,
      recoveryAction,
      restartAttempts: this.restartAttempts,
      runtime: {
        beforeStatus: before.status,
        afterStatus: after.status,
        startCount: after.metrics.startCount,
        restartCount: after.metrics.restartCount,
        faultCount: after.metrics.faultCount
      },
      worker: this.worker?.queueStatus ? this.worker.queueStatus() : null,
      drain
    };
    this.heartbeats.unshift(heartbeat);
    this.runtime.eventBus.publish('core.supervisor.heartbeat', heartbeat);
    return heartbeat;
  }

  recoveryDecision(health = this.runtime.health()) {
    const faultCount = health.metrics?.faultCount ?? 0;
    const stoppedOrUnhealthy = this.restartPolicy.unhealthyStatuses.includes(health.status);
    const faultBudgetExceeded = faultCount > this.restartPolicy.faultThreshold;
    return {
      restartRecommended: stoppedOrUnhealthy || faultBudgetExceeded,
      reason: stoppedOrUnhealthy ? `runtime-${health.status}` : faultBudgetExceeded ? 'fault-budget-exceeded' : 'healthy',
      faultBudgetExceeded,
      stoppedOrUnhealthy
    };
  }

  heartbeatStatus(health, decision) {
    if (decision.restartRecommended && this.restartAttempts >= this.restartPolicy.maxRestarts && health.status !== 'running') {
      return 'blocked';
    }
    if (health.status === 'running') return 'healthy';
    if (health.status === 'degraded') return 'degraded';
    return 'unhealthy';
  }

  servicePlan({ serviceName = 'JARVIS Core Runtime', command = 'npm run core:dev' } = {}) {
    return {
      planVersion: 'a-core-service-supervision-plan-v1',
      supervisorId: this.supervisorId,
      serviceName,
      command,
      localOnly: true,
      restartPolicy: this.restartPolicy,
      watchdog: {
        heartbeatEvent: 'core.supervisor.heartbeat',
        healthEndpoint: '/health',
        diagnosticsEndpoint: '/admin/diagnostics',
        supervisorStatusEndpoint: '/runtime/supervisor'
      },
      integrationTargets: ['B.windows-service-planner', 'A.core-http-api']
    };
  }

  status() {
    const latestHeartbeat = this.heartbeats[0] ?? null;
    return {
      supervisorVersion: 'a-core-runtime-supervisor-v1',
      supervisorId: this.supervisorId,
      running: this.running,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      restartPolicy: this.restartPolicy,
      restartAttempts: this.restartAttempts,
      runtimeHealth: this.runtime.health(),
      workerQueue: this.worker?.queueStatus ? this.worker.queueStatus() : null,
      latestHeartbeat,
      recentHeartbeats: this.heartbeats.slice(0, 10),
      servicePlan: this.servicePlan()
    };
  }
}
