import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileWorkerLeaseStore {
  constructor({ filePath, clock = () => new Date(), lockPath = `${filePath}.lock`, lockTtlMs = 10_000, lockWaitMs = 250 } = {}) {
    if (!filePath) {
      throw new Error('FileWorkerLeaseStore requires filePath.');
    }
    this.filePath = filePath;
    this.clock = clock;
    this.lockPath = lockPath;
    this.lockTtlMs = lockTtlMs;
    this.lockWaitMs = lockWaitMs;
  }

  load() {
    if (!existsSync(this.filePath)) return null;
    try {
      const snapshot = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (snapshot?.storeVersion !== 'a-worker-lease-store-v1') {
        const error = new Error('Unsupported worker lease store version.');
        error.code = 'A_WORKER_LEASE_STORE_VERSION_UNSUPPORTED';
        throw error;
      }
      return snapshot;
    } catch (error) {
      if (!error.code) error.code = 'A_WORKER_LEASE_STORE_CORRUPT';
      throw error;
    }
  }

  save(snapshot) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    return this.withFileLock(() => this.writeSnapshot(snapshot));
  }

  writeSnapshot(snapshot) {
    const persistedAt = this.clock().toISOString();
    const payload = {
      storeVersion: 'a-worker-lease-store-v1',
      persistedAt,
      ...snapshot
    };
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.filePath);
    return payload;
  }

  withFileLock(operation) {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    const startedAt = Date.now();
    let lockFd = null;
    while (lockFd === null) {
      try {
        lockFd = openSync(this.lockPath, 'wx');
        writeFileSync(lockFd, JSON.stringify({
          lockVersion: 'a-worker-lease-file-lock-backend-v1',
          pid: process.pid,
          acquiredAt: this.clock().toISOString(),
          expiresAt: new Date(this.clock().getTime() + this.lockTtlMs).toISOString()
        }), 'utf8');
      } catch (error) {
        if (error.code === 'EEXIST' && this.removeStaleLock()) {
          continue;
        }
        if (Date.now() - startedAt >= this.lockWaitMs) {
          const timeout = new Error('Timed out acquiring worker lease file lock.');
          timeout.code = 'A_WORKER_LEASE_FILE_LOCK_TIMEOUT';
          throw timeout;
        }
      }
    }
    try {
      return operation();
    } finally {
      closeSync(lockFd);
      try {
        unlinkSync(this.lockPath);
      } catch {
        // The lock may already be removed by a stale-lock cleanup after a crash.
      }
    }
  }

  removeStaleLock() {
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (Date.parse(lock.expiresAt) > this.clock().getTime()) return false;
      unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  metadata() {
    return {
      storeVersion: 'a-worker-lease-store-v1',
      filePath: this.filePath,
      lockBackendVersion: 'a-worker-lease-file-lock-backend-v1',
      lockPath: this.lockPath,
      lockTtlMs: this.lockTtlMs
    };
  }
}

export class WorkerLeaseTable {
  constructor({ clock = () => new Date(), defaultTtlMs = 30_000, store = null, storePath = null } = {}) {
    this.clock = clock;
    this.defaultTtlMs = defaultTtlMs;
    this.store = store ?? (storePath ? new FileWorkerLeaseStore({ filePath: storePath, clock }) : null);
    this.leases = new Map();
    this.history = [];
    this.lastPersistedAt = null;
    this.loadPersistedState();
  }

  acquire(taskId, {
    ownerId = 'core-worker',
    queueId = null,
    ttlMs = this.defaultTtlMs,
    now = this.clock().toISOString(),
    metadata = {}
  } = {}) {
    const existing = this.leases.get(taskId);
    if (existing && Date.parse(existing.expiresAt) > Date.parse(now) && existing.ownerId !== ownerId) {
      return {
        acquired: false,
        reason: 'lease-active',
        lease: existing
      };
    }
    const lease = {
      leaseVersion: 'a-worker-task-lease-v1',
      taskId,
      queueId,
      ownerId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      ttlMs,
      metadata
    };
    this.leases.set(taskId, lease);
    this.record('lease.acquired', lease);
    return {
      acquired: true,
      lease
    };
  }

  heartbeat(taskId, {
    ownerId = 'core-worker',
    ttlMs = this.defaultTtlMs,
    now = this.clock().toISOString()
  } = {}) {
    const lease = this.leases.get(taskId);
    if (!lease) return { renewed: false, reason: 'lease-not-found' };
    if (lease.ownerId !== ownerId) return { renewed: false, reason: 'lease-owner-mismatch', lease };
    lease.heartbeatAt = now;
    lease.expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    this.record('lease.heartbeat', lease);
    return { renewed: true, lease };
  }

  release(taskId, {
    ownerId = 'core-worker',
    now = this.clock().toISOString(),
    reason = 'worker-finished'
  } = {}) {
    const lease = this.leases.get(taskId);
    if (!lease) return { released: false, reason: 'lease-not-found' };
    if (lease.ownerId !== ownerId) return { released: false, reason: 'lease-owner-mismatch', lease };
    this.leases.delete(taskId);
    const released = { ...lease, releasedAt: now, releaseReason: reason };
    this.record('lease.released', released);
    return { released: true, lease: released };
  }

  recoverExpired({ now = this.clock().toISOString() } = {}) {
    const recovered = [];
    for (const lease of this.leases.values()) {
      if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
        this.leases.delete(lease.taskId);
        const item = { ...lease, recoveredAt: now, recoveryReason: 'lease-expired' };
        recovered.push(item);
        this.record('lease.recovered', item);
      }
    }
    return {
      recoveryVersion: 'a-worker-lease-recovery-v1',
      now,
      recoveredCount: recovered.length,
      recovered
    };
  }

  status({ now = this.clock().toISOString() } = {}) {
    const leases = [...this.leases.values()].map((lease) => ({
      ...lease,
      expired: Date.parse(lease.expiresAt) <= Date.parse(now)
    }));
    return {
      leaseTableVersion: 'a-worker-lease-table-v1',
      now,
      activeLeaseCount: leases.filter((lease) => !lease.expired).length,
      expiredLeaseCount: leases.filter((lease) => lease.expired).length,
      leases,
      recentHistory: this.history.slice(0, 20),
      persistence: this.persistenceStatus(),
      backend: this.leaseBackendStatus(),
      heartbeatMonitor: this.heartbeatMonitor({ now })
    };
  }

  heartbeatMonitor({ now = this.clock().toISOString(), staleAfterMs = this.defaultTtlMs } = {}) {
    const nowMs = Date.parse(now);
    const leases = [...this.leases.values()].map((lease) => {
      const heartbeatAgeMs = Math.max(0, nowMs - Date.parse(lease.heartbeatAt));
      const expired = Date.parse(lease.expiresAt) <= nowMs;
      const stale = heartbeatAgeMs > staleAfterMs;
      return {
        taskId: lease.taskId,
        queueId: lease.queueId,
        ownerId: lease.ownerId,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt,
        heartbeatAgeMs,
        stale,
        expired,
        status: expired ? 'expired' : stale ? 'stale_heartbeat' : 'healthy'
      };
    });
    return {
      monitorVersion: 'a-worker-crashed-heartbeat-monitor-v1',
      now,
      staleAfterMs,
      staleLeaseCount: leases.filter((lease) => lease.stale).length,
      expiredLeaseCount: leases.filter((lease) => lease.expired).length,
      crashedWorkerCandidates: leases.filter((lease) => lease.stale || lease.expired),
      leases
    };
  }

  leaseBackendStatus() {
    const persistence = this.persistenceStatus();
    return {
      backendVersion: 'a-worker-multiprocess-lease-backend-v1',
      activeBackend: persistence.enabled ? 'file-lock-json' : 'memory-only',
      durable: persistence.enabled === true,
      fileLock: persistence.lockBackendVersion === 'a-worker-lease-file-lock-backend-v1',
      adapterContracts: [
        'a-worker-lease-file-lock-backend-v1',
        'a-worker-lease-sqlite-backend-contract-v1',
        'a-worker-lease-redis-backend-contract-v1'
      ],
      persistence
    };
  }

  record(eventType, lease) {
    this.history.unshift({
      eventType,
      taskId: lease.taskId,
      queueId: lease.queueId,
      ownerId: lease.ownerId,
      at: lease.releasedAt ?? lease.recoveredAt ?? lease.heartbeatAt ?? lease.acquiredAt
    });
    this.history = this.history.slice(0, 200);
    this.persist(eventType);
  }

  loadPersistedState() {
    if (!this.store) return null;
    const snapshot = this.store.load();
    if (!snapshot) return null;
    this.leases = new Map((snapshot.leases ?? []).map((lease) => [lease.taskId, lease]));
    this.history = snapshot.history ?? [];
    this.lastPersistedAt = snapshot.persistedAt ?? null;
    return snapshot;
  }

  persist(reason = 'snapshot') {
    if (!this.store) return null;
    const saved = this.store.save({
      reason,
      defaultTtlMs: this.defaultTtlMs,
      leases: [...this.leases.values()],
      history: this.history
    });
    this.lastPersistedAt = saved.persistedAt;
    return saved;
  }

  persistenceStatus() {
    if (!this.store) {
      return { enabled: false };
    }
    return {
      enabled: true,
      ...this.store.metadata?.(),
      lastPersistedAt: this.lastPersistedAt
    };
  }
}
