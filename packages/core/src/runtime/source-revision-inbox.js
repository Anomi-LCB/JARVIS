const fail = code => { throw Object.assign(new Error(code), { code }); };
const iso = (value, code) => {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(time)) fail(code);
  return new Date(time).toISOString();
};
const validText = (value, max, code) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(code);
  return value.trim();
};

/** Durable latest-revision inbox. Events carry hashes only; workflow bodies stay in Mission storage. */
export class SqliteSourceRevisionInbox {
  constructor({ operationsStore, clock = operationsStore?.clock } = {}) {
    if (!operationsStore?.db || typeof clock !== 'function') fail('A_SOURCE_REVISION_DB_REQUIRED');
    this.db = operationsStore.db;
    this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_revision_inbox (
      source_key TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
      revision INTEGER NOT NULL, observed_at TEXT NOT NULL, quiet_until TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','dispatching','completed','failed')),
      claim_owner TEXT, claim_revision INTEGER, claim_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      completed_revision INTEGER, last_error TEXT, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS source_revision_watches (
      source_key TEXT PRIMARY KEY, source_path TEXT NOT NULL, quiet_period_ms INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS source_revision_events (
      event_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, observed_at TEXT NOT NULL,
      source_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS source_revision_due ON source_revision_inbox(state,quiet_until,claim_until);`);
  }

  registerWatch({ sourceKey, sourcePath, quietPeriodMs = 750 } = {}) {
    sourceKey = validText(sourceKey, 200, 'A_SOURCE_REVISION_KEY_INVALID');
    sourcePath = validText(sourcePath, 2048, 'A_SOURCE_REVISION_PATH_INVALID');
    if (!Number.isSafeInteger(quietPeriodMs) || quietPeriodMs < 0 || quietPeriodMs > 60_000) fail('A_SOURCE_REVISION_QUIET_PERIOD_INVALID');
    const now = this.clock().toISOString();
    const prior = this.db.prepare('SELECT * FROM source_revision_watches WHERE source_key=?').get(sourceKey);
    if (prior && prior.source_path !== sourcePath) fail('A_SOURCE_REVISION_PATH_CONFLICT');
    this.db.prepare(`INSERT INTO source_revision_watches(source_key,source_path,quiet_period_ms,active,created_at,updated_at)
      VALUES(?,?,?,1,?,?) ON CONFLICT(source_key) DO UPDATE SET quiet_period_ms=excluded.quiet_period_ms,active=1,updated_at=excluded.updated_at`)
      .run(sourceKey, sourcePath, quietPeriodMs, now, now);
    return this.listWatches().find(item => item.sourceKey === sourceKey);
  }

  removeWatch(sourceKey) {
    sourceKey = validText(sourceKey, 200, 'A_SOURCE_REVISION_KEY_INVALID');
    const now = this.clock().toISOString();
    return this.db.prepare('UPDATE source_revision_watches SET active=0,updated_at=? WHERE source_key=? AND active=1').run(now, sourceKey).changes === 1;
  }

  listWatches({ activeOnly = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM source_revision_watches ${activeOnly ? 'WHERE active=1' : ''} ORDER BY source_key`).all();
    return rows.map(row => ({ sourceKey: row.source_key, sourcePath: row.source_path, quietPeriodMs: row.quiet_period_ms,
      active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  list() {
    return this.db.prepare('SELECT * FROM source_revision_inbox ORDER BY updated_at DESC,source_key').all().map(row => this.normalize(row));
  }

  ingest({ sourceKey, eventId, sourcePath, sourceSha256, observedAt = this.clock().toISOString(), quietPeriodMs = 750 } = {}) {
    sourceKey = validText(sourceKey, 200, 'A_SOURCE_REVISION_KEY_INVALID');
    eventId = validText(eventId, 200, 'A_SOURCE_REVISION_EVENT_INVALID');
    sourcePath = validText(sourcePath, 2048, 'A_SOURCE_REVISION_PATH_INVALID');
    if (!/^[a-f0-9]{64}$/u.test(sourceSha256 ?? '')) fail('A_SOURCE_REVISION_HASH_INVALID');
    if (!Number.isSafeInteger(quietPeriodMs) || quietPeriodMs < 0 || quietPeriodMs > 60_000) fail('A_SOURCE_REVISION_QUIET_PERIOD_INVALID');
    observedAt = iso(observedAt, 'A_SOURCE_REVISION_TIME_INVALID');
    const now = this.clock().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT event_id FROM source_revision_events WHERE event_id=?').get(eventId)) {
        this.db.exec('COMMIT');
        return { accepted: false, duplicate: true, reason: 'event-already-seen', current: this.get(sourceKey) };
      }
      const current = this.get(sourceKey);
      if (current && current.sourcePath !== sourcePath) fail('A_SOURCE_REVISION_PATH_CONFLICT');
      this.db.prepare('INSERT INTO source_revision_events(event_id,source_key,observed_at,source_sha256,created_at) VALUES(?,?,?,?,?)')
        .run(eventId, sourceKey, observedAt, sourceSha256, now);
      if (current && observedAt < current.observedAt) {
        this.db.exec('COMMIT');
        return { accepted: false, duplicate: false, reason: 'stale-event-time', current };
      }
      if (current && current.sourceSha256 === sourceSha256) {
        this.db.exec('COMMIT');
        return { accepted: false, duplicate: true, reason: 'content-unchanged', current };
      }
      const revision = (current?.revision ?? 0) + 1;
      const quietUntil = new Date(Date.parse(now) + quietPeriodMs).toISOString();
      const state = current?.state === 'dispatching' ? 'dispatching' : 'pending';
      const record = { sourceKey, sourcePath, sourceSha256, revision, observedAt, quietUntil, state,
        claimOwner: current?.claimOwner ?? null, claimRevision: current?.claimRevision ?? null,
        claimUntil: current?.claimUntil ?? null, attempts: current?.attempts ?? 0,
        completedRevision: current?.completedRevision ?? null, lastError: null, updatedAt: now };
      this.db.prepare(`INSERT INTO source_revision_inbox(source_key,source_path,source_sha256,revision,observed_at,quiet_until,state,claim_owner,claim_revision,claim_until,attempts,completed_revision,last_error,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET
        source_path=excluded.source_path,source_sha256=excluded.source_sha256,revision=excluded.revision,
        observed_at=excluded.observed_at,quiet_until=excluded.quiet_until,state=excluded.state,
        claim_owner=excluded.claim_owner,claim_revision=excluded.claim_revision,claim_until=excluded.claim_until,
        last_error=NULL,updated_at=excluded.updated_at`)
        .run(record.sourceKey,record.sourcePath,record.sourceSha256,record.revision,record.observedAt,record.quietUntil,record.state,
          record.claimOwner,record.claimRevision,record.claimUntil,record.attempts,record.completedRevision,record.lastError,record.updatedAt);
      this.db.exec('COMMIT');
      return { accepted: true, duplicate: false, current: record };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get(sourceKey) {
    const row = this.db.prepare('SELECT * FROM source_revision_inbox WHERE source_key=?').get(sourceKey);
    return row ? this.normalize(row) : null;
  }

  due(nowIso, limit = 10) {
    const now = iso(nowIso, 'A_SOURCE_REVISION_TIME_INVALID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('A_SOURCE_REVISION_LIMIT_INVALID');
    return this.db.prepare(`SELECT * FROM source_revision_inbox WHERE state='pending' AND quiet_until<=? ORDER BY quiet_until,source_key LIMIT ?`)
      .all(now, limit).map(row => this.normalize(row));
  }

  claim(sourceKey, { ownerId, nowIso, leaseMs = 30_000 } = {}) {
    ownerId = validText(ownerId, 160, 'A_SOURCE_REVISION_OWNER_INVALID');
    const now = iso(nowIso, 'A_SOURCE_REVISION_TIME_INVALID');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) fail('A_SOURCE_REVISION_LEASE_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT * FROM source_revision_inbox WHERE source_key=? AND quiet_until<=?
        AND (state='pending' OR (state='dispatching' AND claim_until<=?))`).get(sourceKey, now, now);
      if (!row) { this.db.exec('COMMIT'); return null; }
      const claimRevision = row.revision;
      const claimUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const changed = this.db.prepare(`UPDATE source_revision_inbox SET state='dispatching',claim_owner=?,claim_revision=?,claim_until=?,attempts=attempts+1,updated_at=?
        WHERE source_key=? AND revision=? AND (state='pending' OR (state='dispatching' AND claim_until<=?))`)
        .run(ownerId, claimRevision, claimUntil, now, sourceKey, claimRevision, now).changes;
      const claimed = changed === 1 ? this.get(sourceKey) : null;
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  renewClaim(sourceKey, { ownerId, claimRevision, nowIso, leaseMs = 30_000 } = {}) {
    ownerId = validText(ownerId, 160, 'A_SOURCE_REVISION_OWNER_INVALID');
    const now = iso(nowIso, 'A_SOURCE_REVISION_TIME_INVALID');
    if (!Number.isSafeInteger(claimRevision) || claimRevision < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
      fail('A_SOURCE_REVISION_LEASE_INVALID');
    }
    const claimUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    return this.db.prepare(`UPDATE source_revision_inbox SET claim_until=?,updated_at=? WHERE source_key=?
      AND state='dispatching' AND claim_owner=? AND claim_revision=?`).run(claimUntil, now, sourceKey, ownerId, claimRevision).changes === 1;
  }

  settle(sourceKey, { ownerId, claimRevision, nowIso, error = null } = {}) {
    const now = iso(nowIso, 'A_SOURCE_REVISION_TIME_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT * FROM source_revision_inbox WHERE source_key=? AND state='dispatching'
        AND claim_owner=? AND claim_revision=?`).get(sourceKey, ownerId, claimRevision);
      if (!row) { this.db.exec('COMMIT'); return { settled: false, reason: 'claim-fenced', current: this.get(sourceKey) }; }
      const currentRevision = row.revision;
      const superseded = currentRevision !== claimRevision;
      const state = superseded ? 'pending' : error ? 'failed' : 'completed';
      const completedRevision = !superseded && !error ? claimRevision : row.completed_revision;
      const changed = this.db.prepare(`UPDATE source_revision_inbox SET state=?,claim_owner=NULL,claim_revision=NULL,claim_until=NULL,
        completed_revision=?,last_error=?,updated_at=? WHERE source_key=? AND state='dispatching' AND claim_owner=? AND claim_revision=?`)
        .run(state, completedRevision, error ? validText(String(error), 300, 'A_SOURCE_REVISION_ERROR_INVALID') : null, now, sourceKey, ownerId, claimRevision).changes;
      const result = changed === 1 ? this.get(sourceKey) : null;
      this.db.exec('COMMIT');
      return { settled: changed === 1, superseded, current: result };
    } catch (caught) { this.db.exec('ROLLBACK'); throw caught; }
  }

  normalize(row) {
    return { sourceKey: row.source_key, sourcePath: row.source_path, sourceSha256: row.source_sha256,
      revision: row.revision, observedAt: row.observed_at, quietUntil: row.quiet_until, state: row.state,
      claimOwner: row.claim_owner, claimRevision: row.claim_revision, claimUntil: row.claim_until,
      attempts: row.attempts, completedRevision: row.completed_revision, lastError: row.last_error, updatedAt: row.updated_at };
  }

  status() { return { version: 'a-source-revision-inbox-v1', durable: true,
    pending: this.db.prepare("SELECT COUNT(*) AS count FROM source_revision_inbox WHERE state='pending'").get().count,
    dispatching: this.db.prepare("SELECT COUNT(*) AS count FROM source_revision_inbox WHERE state='dispatching'").get().count,
    completed: this.db.prepare("SELECT COUNT(*) AS count FROM source_revision_inbox WHERE state='completed'").get().count };
  }
}

/** Coalesces quiet-period file revision signals and executes one callback at a time per source key. */
export class SourceRevisionScheduler {
  constructor({ store, processRevision, clock = () => new Date(), ownerId = `source-revision:${process.pid}`, leaseMs = 30_000,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!store?.due || !store?.claim || !store?.renewClaim || !store?.settle || typeof processRevision !== 'function') fail('A_SOURCE_REVISION_SCHEDULER_INVALID');
    this.store = store; this.processRevision = processRevision; this.clock = clock; this.ownerId = ownerId; this.leaseMs = leaseMs;
    this.setIntervalFn = setIntervalFn; this.clearIntervalFn = clearIntervalFn;
    this.running = false; this.stats = { processed: 0, superseded: 0, failures: 0, lastTickAt: null };
  }
  ingestEvent(event) { return this.store.ingest(event); }
  status() { return { version: 'a-source-revision-scheduler-v1', ownerId: this.ownerId, leaseMs: this.leaseMs, ...this.stats, inbox: this.store.status?.() ?? null }; }
  async tick({ limit = 10 } = {}) {
    if (this.running) return { success: true, status: 'skipped', reason: 'source-revision-tick-already-running' };
    this.running = true; this.stats.lastTickAt = this.clock().toISOString();
    const results = [];
    try {
      for (const item of this.store.due(this.stats.lastTickAt, limit)) {
        const claimed = this.store.claim(item.sourceKey, { ownerId: this.ownerId, nowIso: this.clock().toISOString(), leaseMs: this.leaseMs });
        if (!claimed) continue;
        let error = null;
        let claimLost = false;
        const heartbeat = this.setIntervalFn(() => {
          try {
            if (!this.store.renewClaim?.(claimed.sourceKey, { ownerId: this.ownerId, claimRevision: claimed.claimRevision,
              nowIso: this.clock().toISOString(), leaseMs: this.leaseMs })) claimLost = true;
          } catch { claimLost = true; }
        }, Math.max(250, Math.floor(this.leaseMs / 3)));
        heartbeat?.unref?.();
        try { await this.processRevision(claimed); this.stats.processed += 1; }
        catch (caught) { error = caught?.code ?? caught?.message ?? 'A_SOURCE_REVISION_PROCESS_FAILED'; }
        finally { this.clearIntervalFn(heartbeat); }
        if (claimLost && !error) error = 'A_SOURCE_REVISION_CLAIM_LOST';
        const settled = this.store.settle(claimed.sourceKey, { ownerId: this.ownerId, claimRevision: claimed.claimRevision,
          nowIso: this.clock().toISOString(), error });
        if (error && !settled.superseded) this.stats.failures += 1;
        if (settled.superseded) this.stats.superseded += 1;
        results.push({ sourceKey: claimed.sourceKey, revision: claimed.claimRevision, status: settled.superseded ? 'superseded' : error ? 'failed' : 'completed',
          settlement: settled.current?.state ?? 'fenced', error });
      }
      return { success: true, processed: results.length, results, status: this.status() };
    } finally { this.running = false; }
  }
}
