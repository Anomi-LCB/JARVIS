import { existsSync, readFileSync } from 'node:fs';
import { ModuleId } from '../../../shared/src/types.js';
import { EventBus } from './event-bus.js';
import { createDefaultContractRegistry } from '../contracts/default-contracts.js';

export class CoreRuntime {
  constructor({ configPath = 'configs/core.json', clock = () => new Date(), eventBus = null, eventLogPath = 'logs/core-events.jsonl' } = {}) {
    this.configPath = configPath;
    this.clock = clock;
    this.eventBus = eventBus ?? new EventBus({ clock, eventLogPath });
    this.contractRegistry = createDefaultContractRegistry();
    this.config = null;
    this.started = false;
    this.initialized = false;
    this.startedAt = null;
    this.stoppedAt = null;
    this.startCount = 0;
    this.restartCount = 0;
    this.faults = [];
  }

  init(overrides = {}) {
    this.config = {
      module: ModuleId.CORE,
      version: '1.0.0',
      localOnly: true,
      loadedFrom: existsSync(this.configPath) ? this.configPath : null,
      ...(existsSync(this.configPath) ? JSON.parse(readFileSync(this.configPath, 'utf8')) : {}),
      ...overrides
    };
    this.initialized = true;
    this.eventBus.publish('core.initialized', { config: this.config });
    return this.config;
  }

  start() {
    if (!this.initialized) this.init();
    this.started = true;
    this.startedAt = this.clock().toISOString();
    this.startCount += 1;
    this.eventBus.publish('core.started', { startedAt: this.startedAt, startCount: this.startCount });
    return this.health();
  }

  stop() {
    this.started = false;
    this.stoppedAt = this.clock().toISOString();
    this.eventBus.publish('core.stopped', { stoppedAt: this.stoppedAt });
    return this.health();
  }

  restart(reason = 'manual-restart') {
    this.restartCount += 1;
    this.eventBus.publish('core.restart.requested', { reason, restartCount: this.restartCount });
    if (this.started) this.stop();
    const health = this.start();
    this.eventBus.publish('core.restarted', { reason, restartCount: this.restartCount, health });
    return health;
  }

  recordFault(error, { severity = 'error', recoverable = true, context = {} } = {}) {
    const fault = {
      faultId: `fault_${this.faults.length + 1}`,
      message: error?.message ?? String(error),
      name: error?.name ?? 'RuntimeFault',
      severity,
      recoverable,
      context,
      at: this.clock().toISOString()
    };
    this.faults.unshift(fault);
    this.eventBus.publish('core.fault.recorded', { fault });
    return fault;
  }

  metrics() {
    const now = this.clock().toISOString();
    return {
      module: ModuleId.CORE,
      initialized: this.initialized,
      running: this.started,
      startCount: this.startCount,
      restartCount: this.restartCount,
      faultCount: this.faults.length,
      recoverableFaultCount: this.faults.filter((fault) => fault.recoverable).length,
      eventCount: this.eventBus.recent(Number.MAX_SAFE_INTEGER).length,
      uptimeMs: this.startedAt && this.started ? Math.max(0, Date.parse(now) - Date.parse(this.startedAt)) : 0,
      lastFault: this.faults[0] ?? null,
      time: now
    };
  }

  healthChecks() {
    const metrics = this.metrics();
    return [
      {
        id: 'config-loaded',
        status: this.initialized && this.config ? 'pass' : 'warn',
        evidence: this.config?.loadedFrom ?? 'defaults'
      },
      {
        id: 'event-bus-writable',
        status: this.eventBus ? 'pass' : 'fail',
        evidence: `events:${metrics.eventCount}`
      },
      {
        id: 'contracts-registered',
        status: this.contractRegistry ? 'pass' : 'fail',
        evidence: 'default A contracts available'
      },
      {
        id: 'fault-budget',
        status: metrics.faultCount === 0 ? 'pass' : metrics.faultCount <= 3 ? 'warn' : 'fail',
        evidence: `faults:${metrics.faultCount}`
      }
    ];
  }

  diagnostics() {
    return {
      health: this.health(),
      metrics: this.metrics(),
      faults: this.faults.slice(0, 10),
      recentEvents: this.eventBus.recent(10)
    };
  }

  health() {
    const checks = this.healthChecks();
    const hasFailure = checks.some((check) => check.status === 'fail');
    const hasWarning = checks.some((check) => check.status === 'warn');
    return {
      status: this.started ? (hasFailure ? 'unhealthy' : hasWarning ? 'degraded' : 'running') : 'stopped',
      module: ModuleId.CORE,
      version: this.config?.version ?? '1.0.0',
      initialized: this.initialized,
      startedAt: this.startedAt ?? null,
      stoppedAt: this.stoppedAt ?? null,
      checks,
      metrics: this.metrics(),
      time: this.clock().toISOString()
    };
  }
}
