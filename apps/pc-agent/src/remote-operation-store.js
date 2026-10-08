import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = value => { if (typeof value !== 'string' || !/^[\w.:-]{1,180}$/u.test(value)) fail('B_OPERATION_ID_INVALID'); return value; };
const resourcesFor = descriptor => {
  const values = descriptor.resourceKeys ?? [descriptor.resourceKey];
  if (!Array.isArray(values) || values.length < 1 || values.length > 128
    || values.some(key => typeof key !== 'string' || !key || key.length > 1024)
    || new Set(values).size !== values.length || !values.includes(descriptor.resourceKey)) fail('B_OPERATION_RESOURCES_INVALID');
  return [...values].sort();
};

/** B-owned effect journal. Never shares the Core DB and never grants E authority. */
export class RemoteOperationStore {
  constructor({ path, clock = () => new Date(), recoverInFlight = true }) {
    mkdirSync(dirname(path), { recursive: true }); this.clock = clock;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operation_clock (id INTEGER PRIMARY KEY CHECK(id=1), milliseconds INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_operations (
        operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, fingerprint TEXT NOT NULL, resource_key TEXT NOT NULL, authorization_hash TEXT,
        state TEXT NOT NULL, generation INTEGER NOT NULL, ticket_hash TEXT, expires_ms INTEGER NOT NULL,
        receipt_json TEXT, updated_ms INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS remote_active_resource ON remote_operations(resource_key)
        WHERE state IN ('in_flight','uncertain');`);
    if (!this.db.prepare('PRAGMA table_info(remote_operations)').all().some(column => column.name === 'authorization_hash')) {
      this.db.exec('ALTER TABLE remote_operations ADD COLUMN authorization_hash TEXT');
    }
    if (!this.db.prepare('PRAGMA table_info(remote_operations)').all().some(column => column.name === 'resource_keys_json')) {
      this.db.exec('ALTER TABLE remote_operations ADD COLUMN resource_keys_json TEXT');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_operation_claims (
      resource_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS remote_claim_owner ON remote_operation_claims(operation_id);
      CREATE TABLE IF NOT EXISTS workflow_publication_contracts (
        operation_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, intent_sha256 TEXT NOT NULL);`);
    // A fresh B cannot prove what its predecessor did after the last durable checkpoint.
    if (recoverInFlight) this.db.prepare("UPDATE remote_operations SET state='uncertain' WHERE state='in_flight'").run();
    this.tx(() => {
      for (const row of this.db.prepare("SELECT * FROM remote_operations WHERE state IN ('in_flight','uncertain')").all()) {
        for (const key of this.resources(row)) {
          this.db.prepare('INSERT OR IGNORE INTO remote_operation_claims VALUES(?,?)').run(key, row.operation_id);
          if (this.db.prepare('SELECT operation_id FROM remote_operation_claims WHERE resource_key=?').get(key)?.operation_id !== row.operation_id)
            fail('B_OPERATION_RESOURCE_UNRESOLVED');
        }
      }
    });
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  now() {
    const wall = this.clock().getTime(), previous = this.db.prepare('SELECT milliseconds FROM operation_clock WHERE id=1').get()?.milliseconds ?? 0;
    const now = Math.max(wall, previous); if (!Number.isSafeInteger(now)) fail('B_OPERATION_CLOCK_INVALID');
    this.db.prepare('INSERT INTO operation_clock VALUES(1,?) ON CONFLICT(id) DO UPDATE SET milliseconds=excluded.milliseconds').run(now); return now;
  }
  row(operationId) { return this.db.prepare('SELECT * FROM remote_operations WHERE operation_id=?').get(id(operationId)) ?? null; }
  resources(row) { return row.resource_keys_json ? JSON.parse(row.resource_keys_json) : [row.resource_key]; }
  bound(descriptor) {
    id(descriptor.operationId); if (typeof descriptor.taskId !== 'string' || !descriptor.taskId || !/^[a-f0-9]{64}$/u.test(descriptor.fingerprint ?? '')) fail('B_OPERATION_BINDING_INVALID');
    const row = this.row(descriptor.operationId);
    if (row && (row.task_id !== descriptor.taskId || row.fingerprint !== descriptor.fingerprint)) fail('B_OPERATION_BINDING_MISMATCH');
    if (row && descriptor.resourceKeys !== undefined && JSON.stringify(this.resources(row)) !== JSON.stringify(resourcesFor(descriptor))) fail('B_OPERATION_RESOURCE_CHANGED');
    return row;
  }
  public(row) { return row ? { version: 'b-durable-operation-v1', operationId: row.operation_id, taskId: row.task_id,
    fingerprint: row.fingerprint, state: row.state, generation: row.generation, expiresAt: new Date(row.expires_ms).toISOString(),
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, executionAuthority: false } : null; }
  assertAuthorization(descriptor) {
    const row = this.bound(descriptor);
    if (!row?.authorization_hash || row.authorization_hash !== descriptor.authorizationHash) fail('B_OPERATION_AUTHORIZATION_BINDING_MISMATCH');
  }
  prepare(descriptor, { ttlMs = 15_000 } = {}) {
    return this.tx(() => {
      const now = this.now(), row = this.bound(descriptor), resources = resourcesFor(descriptor);
      if (row && row.state !== 'prepared') return this.public(row);
      if (!/^[a-f0-9]{64}$/u.test(descriptor.authorizationHash ?? '')) fail('B_OPERATION_AUTHORIZATION_BINDING_REQUIRED');
      if (row && row.authorization_hash !== descriptor.authorizationHash) fail('B_OPERATION_AUTHORIZATION_BINDING_MISMATCH');
      if (typeof descriptor.resourceKey !== 'string' || !descriptor.resourceKey || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30_000) fail('B_OPERATION_PREPARE_INVALID');
      if (row && row.resource_key !== descriptor.resourceKey) fail('B_OPERATION_RESOURCE_CHANGED');
      if (row && JSON.stringify(this.resources(row)) !== JSON.stringify(resources)) fail('B_OPERATION_RESOURCE_CHANGED');
      const ticket = randomBytes(32).toString('hex'), generation = (row?.generation ?? 0) + 1;
      this.db.prepare(`INSERT INTO remote_operations(operation_id,task_id,fingerprint,resource_key,state,generation,ticket_hash,expires_ms,receipt_json,updated_ms,authorization_hash) VALUES(?,?,?,?,'prepared',?,?,?,NULL,?,?)
        ON CONFLICT(operation_id) DO UPDATE SET generation=excluded.generation,ticket_hash=excluded.ticket_hash,expires_ms=excluded.expires_ms,updated_ms=excluded.updated_ms`)
        .run(descriptor.operationId, descriptor.taskId, descriptor.fingerprint, descriptor.resourceKey, generation, hash(ticket), now + ttlMs, now, descriptor.authorizationHash);
      this.db.prepare('UPDATE remote_operations SET resource_keys_json=? WHERE operation_id=?').run(JSON.stringify(resources), descriptor.operationId);
      return { ...this.public(this.row(descriptor.operationId)), ticket };
    });
  }
  claim(descriptor, ticket, generation) {
    const observedNow = this.tx(() => this.now());
    return this.tx(() => {
      const now = Math.max(observedNow, this.now()), row = this.bound(descriptor);
      if (!row?.authorization_hash || row.authorization_hash !== descriptor.authorizationHash) fail('B_OPERATION_AUTHORIZATION_BINDING_MISMATCH');
      if (!row || row.state !== 'prepared' || row.generation !== generation || row.ticket_hash !== hash(String(ticket)) || row.expires_ms <= now) fail('B_OPERATION_CLAIM_REJECTED');
      if (this.db.prepare("SELECT 1 FROM remote_operations WHERE resource_key=? AND state IN ('in_flight','uncertain')").get(row.resource_key)) fail('B_OPERATION_RESOURCE_UNRESOLVED');
      for (const key of this.resources(row)) {
        if (this.db.prepare('SELECT 1 FROM remote_operation_claims WHERE resource_key=?').get(key)) fail('B_OPERATION_RESOURCE_UNRESOLVED');
      }
      for (const key of this.resources(row)) this.db.prepare('INSERT INTO remote_operation_claims VALUES(?,?)').run(key, row.operation_id);
      this.db.prepare("UPDATE remote_operations SET state='in_flight',updated_ms=? WHERE operation_id=? AND state='prepared'").run(now, row.operation_id);
      return { operationId: row.operation_id, generation, fingerprint: row.fingerprint };
    });
  }
  assertFence(claim) {
    // Persist observed time even when the assertion fails: rollback cannot revive an expired ticket.
    const now = this.tx(() => this.now()), row = this.row(claim.operationId);
    if (!row || row.state !== 'in_flight' || row.generation !== claim.generation || row.fingerprint !== claim.fingerprint || row.expires_ms <= now) fail('B_OPERATION_STALE_FENCE');
    for (const key of this.resources(row)) if (this.db.prepare('SELECT operation_id FROM remote_operation_claims WHERE resource_key=?').get(key)?.operation_id !== row.operation_id) fail('B_OPERATION_STALE_FENCE');
  }
  complete(descriptor, receipt) {
    return this.tx(() => {
      const row = this.bound(descriptor), now = this.now();
      if (!row || !['in_flight', 'uncertain', 'succeeded'].includes(row.state)) fail('B_OPERATION_RECEIPT_STATE_INVALID');
      if (descriptor.publicationGeneration !== undefined && (row.state !== 'in_flight'
        || row.generation !== descriptor.publicationGeneration)) fail('B_OPERATION_STALE_FENCE');
      const body = JSON.stringify(receipt);
      if (row.state === 'succeeded' && row.receipt_json !== body) fail('B_OPERATION_RECEIPT_MISMATCH');
      this.db.prepare("UPDATE remote_operations SET state='succeeded',ticket_hash=NULL,receipt_json=?,updated_ms=? WHERE operation_id=?").run(body, now, row.operation_id);
      this.db.prepare('DELETE FROM remote_operation_claims WHERE operation_id=?').run(row.operation_id);
      return this.public(this.row(row.operation_id));
    });
  }
  recordPublicationIntent(descriptor, claim, intent) {
    if (claim.operationId !== descriptor.operationId || claim.fingerprint !== descriptor.fingerprint) fail('B_OPERATION_STALE_FENCE');
    this.assertFence(claim);
    const body = JSON.stringify(intent);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024 || intent.taskId !== descriptor.taskId
      || intent.publicationOperationId !== descriptor.operationId || intent.phase !== 'prepared'
      || intent.version !== 'workflow-publication-journal-v1') fail('B_PUBLICATION_CONTRACT_INVALID');
    return this.tx(() => {
      const row = this.bound(descriptor);
      if (row.state !== 'in_flight' || row.generation !== claim.generation || row.expires_ms <= this.now()) fail('B_OPERATION_STALE_FENCE');
      for (const key of this.resources(row)) {
        if (this.db.prepare('SELECT operation_id FROM remote_operation_claims WHERE resource_key=?').get(key)?.operation_id !== row.operation_id) fail('B_OPERATION_STALE_FENCE');
      }
      const prior = this.db.prepare('SELECT intent_json FROM workflow_publication_contracts WHERE operation_id=?').get(descriptor.operationId);
      if (prior && prior.intent_json !== body) fail('B_PUBLICATION_CONTRACT_CHANGED');
      this.db.prepare('INSERT OR IGNORE INTO workflow_publication_contracts VALUES(?,?,?)').run(descriptor.operationId, body, hash(body));
      return hash(body);
    });
  }
  publicationIntent(descriptor) {
    this.bound(descriptor);
    const row = this.db.prepare('SELECT intent_json,intent_sha256 FROM workflow_publication_contracts WHERE operation_id=?').get(descriptor.operationId);
    if (!row || Buffer.byteLength(row.intent_json) > 2 * 1024 * 1024 || hash(row.intent_json) !== row.intent_sha256) fail('B_PUBLICATION_CONTRACT_INVALID');
    return JSON.parse(row.intent_json);
  }
  resumePublicationClaim(descriptor, intent) {
    return this.tx(() => {
      const row = this.bound(descriptor), now = this.now();
      if (!row || row.state !== 'uncertain' || row.receipt_json
        || JSON.stringify(this.publicationIntent(descriptor)) !== JSON.stringify(intent)
        || !/^[a-f0-9]{64}$/u.test(descriptor.authorizationHash ?? '')) fail('B_PUBLICATION_RESUME_REJECTED');
      for (const key of this.resources(row)) {
        if (this.db.prepare('SELECT operation_id FROM remote_operation_claims WHERE resource_key=?').get(key)?.operation_id !== row.operation_id) fail('B_OPERATION_STALE_FENCE');
      }
      this.db.prepare("UPDATE remote_operations SET state='in_flight',generation=generation+1,authorization_hash=?,expires_ms=?,updated_ms=? WHERE operation_id=?")
        .run(descriptor.authorizationHash, now + 15000, now, row.operation_id);
      return { operationId: row.operation_id, generation: row.generation + 1, fingerprint: row.fingerprint };
    });
  }
  uncertain(operationId) { return this.tx(() => { const now = this.now(); this.db.prepare("UPDATE remote_operations SET state='uncertain',updated_ms=? WHERE operation_id=? AND state='in_flight'").run(now, id(operationId)); return this.public(this.row(operationId)); }); }
  cancel(descriptor) { return this.tx(() => { const row = this.bound(descriptor), now = this.now();
    if (!row) return { state: 'absent', cancellationConfirmed: false };
    const state = row.state === 'prepared' ? 'cancelled' : row.state === 'in_flight' ? 'uncertain' : row.state;
    this.db.prepare('UPDATE remote_operations SET state=?,ticket_hash=NULL,updated_ms=? WHERE operation_id=?').run(state, now, row.operation_id);
    return { ...this.public(this.row(row.operation_id)), cancellationConfirmed: state === 'cancelled' };
  }); }
  close() { this.db.close(); }
}

// No table creation, recovery, claim mutation or receipt completion during observation.
export function inspectPublicationContract(path, { operationId, taskId, intentSha256 } = {}) {
  if (!existsSync(path)) return { status: 'unavailable', reason: 'contract-store-missing' };
  let db;
  try {
    id(operationId); db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(`SELECT o.task_id, o.fingerprint, c.intent_json, c.intent_sha256
      FROM remote_operations o JOIN workflow_publication_contracts c USING(operation_id) WHERE operation_id=?`).get(operationId);
    if (!row) return { status: 'unavailable', reason: 'contract-not-found' };
    if (row.task_id !== taskId || hash(row.intent_json) !== row.intent_sha256
      || row.intent_sha256 !== intentSha256) return { status: 'conflict', reason: 'publication-contract-mismatch' };
    return { status: 'bound', packetFingerprint: row.fingerprint, intentSha256: row.intent_sha256 };
  } catch (error) { return { status: 'unavailable', reason: error.code ?? 'contract-unreadable' }; }
  finally { db?.close(); }
}
