import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PersonalMandateBudget } from '../personal-operations/mandate-budget.js';
import { normalizeMandateRequestScope } from '../personal-operations/mandate-scope.js';
import { MissionBudgetGate } from '../personal-operations/mission-budget-gate.js';
import { validateRemoteArtifactIntent } from './remote-artifact-contract.js';

const VERSION = 'a-mission-sqlite-store-v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f]/.test(value)) fail('A_DURABLE_ID_INVALID');
  return value;
};
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('A_DURABLE_JSON_INVALID');
}
function validateLegacyMissions(missions) {
  const statuses = new Set(['CREATED', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED']);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const dates = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const ids = new Set();
  for (const mission of missions) {
    if (!object(mission) || mission.missionVersion !== 'a-autonomous-mission-v1' || typeof mission.missionId !== 'string' || !mission.missionId.trim() || ids.has(mission.missionId)
      || typeof mission.objective !== 'string' || !mission.objective.trim() || !statuses.has(mission.status)
      || !dates(mission.createdAt) || !dates(mission.updatedAt)
      || !['successCriteria', 'constraints', 'waves', 'gates', 'observations', 'planHistory'].every(key => Array.isArray(mission[key]))
      || !['budgets', 'authorization', 'metadata', 'failureSignatures', 'metrics'].every(key => object(mission[key]))
      || !mission.successCriteria.every(criterion => object(criterion) && typeof criterion.criterionId === 'string' && typeof criterion.statement === 'string')
      || !mission.waves.every(wave => object(wave) && Array.isArray(wave.actions) && wave.actions.every(action => object(action) && typeof action.actionId === 'string' && typeof action.status === 'string'))
      || !mission.gates.every(object) || !mission.observations.every(object) || !mission.planHistory.every(object)) fail('A_MISSION_IMPORT_SCHEMA_INVALID');
    ids.add(mission.missionId);
  }
}
let savepointSequence = 0;
// Reuse the existing reservation rules inside the enclosing Mission transaction.
class EnlistedBudget extends PersonalMandateBudget {
  transaction(action) {
    const name = `mission_budget_${++savepointSequence}`;
    this.store.db.exec(`SAVEPOINT ${name}`);
    try { const result = action(); this.store.db.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.store.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
}

/** Borrow a single Core's PersonalOperationsStore connection. This is storage, never execution authority. */
export class SqliteMissionStore {
  constructor({ operationsStore, clock = operationsStore?.clock } = {}) {
    if (!operationsStore?.db || typeof clock !== 'function') fail('A_DURABLE_OPERATIONS_STORE_REQUIRED');
    this.operationsStore = operationsStore;
    this.db = operationsStore.db;
    this.clock = clock;
    const budgetStore = Object.create(operationsStore);
    budgetStore.now = () => {
      const observed = this.db.prepare('SELECT clock_ms FROM mission_sqlite_meta WHERE id=1').get().clock_ms;
      return new Date(Math.max(observed, this.clock().getTime())).toISOString();
    };
    this.budget = new EnlistedBudget(budgetStore);
    this.quotaGate = new MissionBudgetGate({store:budgetStore,budget:this.budget});
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mission_sqlite_meta(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,clock_ms INTEGER NOT NULL);
      INSERT OR IGNORE INTO mission_sqlite_meta VALUES(1,'${VERSION}',0);
      CREATE TABLE IF NOT EXISTS mission_sqlite_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL,persisted_at TEXT,reason TEXT NOT NULL);
      INSERT OR IGNORE INTO mission_sqlite_snapshot VALUES(1,0,'[]',NULL,'initial');
      CREATE TABLE IF NOT EXISTS mission_sqlite_imports(sha256 TEXT PRIMARY KEY,source_path TEXT NOT NULL,imported_at TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mission_service_authority(id INTEGER PRIMARY KEY CHECK(id=1),service_id TEXT NOT NULL,last_token INTEGER NOT NULL,initial_token INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mission_effects(effect_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,request_sha256 TEXT NOT NULL,intent_sha256 TEXT NOT NULL,intent_json TEXT NOT NULL,
        provider_idempotency_key TEXT,mandate_id TEXT,mandate_revision TEXT,budget_reservation_id TEXT UNIQUE REFERENCES personal_budget_reservations(id),
        state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','uncertain','succeeded','failed')),resource_key TEXT NOT NULL,owner_id TEXT,fence INTEGER,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mission_dispatch_outbox(effect_id TEXT PRIMARY KEY REFERENCES mission_effects(effect_id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mission_resource_leases(resource_key TEXT PRIMARY KEY,owner_id TEXT,token INTEGER NOT NULL,expires_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mission_followup_outbox(event_id TEXT PRIMARY KEY,effect_id TEXT NOT NULL REFERENCES mission_effects(effect_id),body TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mission_run_budget_bindings(mission_id TEXT PRIMARY KEY,mandate_id TEXT NOT NULL REFERENCES personal_mandates(id),mandate_revision TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE REFERENCES personal_budget_reservations(id));
    `);
    if(!this.db.prepare('PRAGMA table_info(mission_effects)').all().some(column=>column.name==='mission_run_reservation_id'))
      this.db.exec('ALTER TABLE mission_effects ADD COLUMN mission_run_reservation_id TEXT REFERENCES personal_budget_reservations(id)');
    if (this.db.prepare('SELECT version FROM mission_sqlite_meta WHERE id=1').get().version !== VERSION) fail('A_MISSION_STORE_VERSION_UNSUPPORTED');
    if(!this.db.prepare('PRAGMA table_info(mission_service_authority)').all().some(c=>c.name==='initial_token'))this.db.exec('ALTER TABLE mission_service_authority ADD COLUMN initial_token INTEGER');
    this.revision = this._snapshot().revision;
  }

  _transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      this.db.exec('ROLLBACK');
      // Clock observation is monotonic metadata, independent of the rolled-back business change.
      // Otherwise an expired heartbeat followed by a wall-clock rollback could revive its lease.
      if (Number.isSafeInteger(this.observedClockMs)) this.db.prepare('UPDATE mission_sqlite_meta SET clock_ms=MAX(clock_ms,?) WHERE id=1').run(this.observedClockMs);
      throw error;
    }
  }
  _now() {
    const requested = this.clock().getTime();
    if (!Number.isSafeInteger(requested) || requested < 0) fail('A_DURABLE_CLOCK_INVALID');
    const previous = this.db.prepare('SELECT clock_ms FROM mission_sqlite_meta WHERE id=1').get().clock_ms;
    // Backward wall-clock changes must not revive expired leases.
    const milliseconds = Math.max(previous, requested, this.observedClockMs ?? 0);
    this.observedClockMs = Math.max(this.observedClockMs ?? 0, milliseconds);
    this.db.prepare('UPDATE mission_sqlite_meta SET clock_ms=? WHERE id=1').run(milliseconds);
    return { milliseconds, iso: new Date(milliseconds).toISOString() };
  }
  _snapshot() { return this.db.prepare('SELECT * FROM mission_sqlite_snapshot WHERE id=1').get(); }
  load() {
    const row = this._snapshot();
    this.revision = row.revision;
    return JSON.parse(row.body);
  }
  metadata() {
    const row = this._snapshot();
    return { storeVersion: VERSION, revision: row.revision, loadedRevision: this.revision, persistedAt: row.persisted_at, sharedPersonalOperationsConnection: true, executionAuthority: false };
  }
  save(missions, { reason = 'snapshot', expectedRevision = this.revision, effects = [] } = {}) {
    const result = this._transaction(() => this._save(missions, { reason, expectedRevision, effects }));
    this.revision = result.revision;
    return result;
  }
  /** The existing count quota and Mission snapshot share one commit. No money or authority is inferred. */
  saveWithMissionQuota(missions,{missionId,phase,expectedRevision=this.revision}={}) {
    if(!['begin','finish'].includes(phase))fail('A_MISSION_QUOTA_PHASE_INVALID');
    const values=[...missions],mission=values.find(value=>value.missionId===id(missionId));
    if(!mission?.executionMandateId)fail('A_MISSION_QUOTA_BINDING_REQUIRED');
    const result=this._transaction(()=>{
      const prior=this.missionQuotaBinding(missionId);
      if(prior&&prior.mandate_id!==mission.executionMandateId)fail('A_MISSION_QUOTA_BINDING_CONFLICT');
      if(phase==='begin'){
        this.quotaGate.beforeRun(mission);
        const reservation=this.quotaGate.reservation(mission);
        const revision=this._mandateRevision(mission.executionMandateId);
        if(prior&&(prior.reservation_id!==reservation.id||prior.mandate_revision!==revision))fail('A_MISSION_QUOTA_BINDING_CONFLICT');
        this.db.prepare('INSERT OR IGNORE INTO mission_run_budget_bindings VALUES(?,?,?,?)').run(missionId,mission.executionMandateId,revision,reservation.id);
      }else{
        if(!prior){
          // Upgrade an already terminal legacy count quota without dispatching or
          // inventing its historical authorization revision. Require its exact saved result.
          const original=JSON.parse(this._snapshot().body).find(value=>value.missionId===missionId);
          const reservation=this.quotaGate.reservation(mission);
          const row=reservation?this.budget.get(reservation.id):null;
          const mandate=this.db.prepare('SELECT body FROM personal_mandates WHERE id=?').get(mission.executionMandateId);
          if(!original||original.executionMandateId!==mission.executionMandateId||!['COMPLETED','FAILED','CANCELLED','BLOCKED'].includes(original.status)
            ||original.status!==mission.status||canonical(original.completion??null)!==canonical(mission.completion??null)
            ||!row||canonical(JSON.parse(row.request_json))!==canonical(this.quotaGate.request(mission.executionMandateId))
            ||!mandate||JSON.parse(mandate.body).maxAmountMinor!==0||this.budget.summary(mission.executionMandateId).totalMinor!==0)
            fail('A_MISSION_QUOTA_BINDING_REQUIRED');
          // An empty revision marks historical authority as unknown. It can never authorize a new effect.
          this.db.prepare('INSERT INTO mission_run_budget_bindings VALUES(?,?,?,?)').run(missionId,mission.executionMandateId,'',reservation.id);
        }
        this.quotaGate.afterRun(mission);
      }
      return this._save(values,{reason:`mission-quota-${phase}`,expectedRevision,effects:[]});
    });
    this.revision=result.revision;return result;
  }
  missionQuotaBinding(missionId){
    return this.db.prepare('SELECT * FROM mission_run_budget_bindings WHERE mission_id=?').get(id(missionId))??null;
  }
  _assertMissionQuota(effect){
    if(!effect.mission_run_reservation_id)return;
    const binding=this.missionQuotaBinding(effect.mission_id);
    if(!binding||binding.reservation_id!==effect.mission_run_reservation_id||this._mandateRevision(binding.mandate_id)!==binding.mandate_revision)
      fail('A_DURABLE_MANDATE_CHANGED');
    const reservation=this.budget.get(binding.reservation_id);
    if(!['in_flight','uncertain'].includes(reservation.state))fail('A_MISSION_QUOTA_RESERVATION_CLOSED');
    this.quotaGate.validate(binding.mandate_id);
  }
  _save(missions, { reason, expectedRevision, effects }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('A_MISSION_STORE_REVISION_INVALID');
    const values = [...missions], ids = new Set();
    for (const mission of values) {
      const missionId = id(mission?.missionId);
      if (ids.has(missionId)) fail('A_MISSION_STORE_DUPLICATE_ID');
      ids.add(missionId);
    }
    for (const row of this.db.prepare('SELECT DISTINCT mission_id FROM mission_effects').all()) {
      if (!ids.has(row.mission_id)) fail('A_MISSION_STORE_EFFECT_OWNER_MISSING');
    }
    for(const binding of this.db.prepare('SELECT mission_id,mandate_id FROM mission_run_budget_bindings').all()){
      if(!values.some(mission=>mission.missionId===binding.mission_id&&mission.executionMandateId===binding.mandate_id))
        fail('A_MISSION_QUOTA_BINDING_CONFLICT');
    }
    // Match FileMissionStore serialization: optional undefined object members are omitted.
    const body = canonical(JSON.parse(JSON.stringify(values))), now = this._now();
    const changed = this.db.prepare('UPDATE mission_sqlite_snapshot SET revision=revision+1,body=?,persisted_at=?,reason=? WHERE id=1 AND revision=?')
      .run(body, now.iso, String(reason), expectedRevision);
    if (!changed.changes) fail('A_MISSION_STORE_REVISION_CONFLICT');
    for (const effect of effects) {
      if (!ids.has(effect.missionId)) fail('A_DURABLE_EFFECT_MISSION_MISSING');
      this._stageEffect(effect, now);
    }
    return { storeVersion: VERSION, revision: expectedRevision + 1, persistedAt: now.iso, reason, missions: JSON.parse(body) };
  }

  /** Legacy JSON is only read. A different import cannot replace an active SQL snapshot. */
  importLegacySnapshot(filePath) {
    const bytes = readFileSync(filePath), sha256 = hash(bytes);
    let snapshot;
    try { snapshot = JSON.parse(bytes.toString('utf8')); } catch { fail('A_MISSION_STORE_CORRUPT'); }
    if (snapshot?.storeVersion !== 'a-mission-store-v1' || !Array.isArray(snapshot.missions)) fail('A_MISSION_STORE_VERSION_UNSUPPORTED');
    validateLegacyMissions(snapshot.missions);
    const result = this._transaction(() => {
      const prior = this.db.prepare('SELECT * FROM mission_sqlite_imports WHERE sha256=?').get(sha256);
      if (prior) return { imported: false, replayed: true, sha256, revision: this._snapshot().revision, sourcePreserved: true };
      const current = this._snapshot();
      if (current.revision !== 0 || current.body !== '[]') fail('A_MISSION_IMPORT_TARGET_NOT_EMPTY');
      const saved = this._save(snapshot.missions, { reason: 'legacy-json-import', expectedRevision: 0, effects: [] });
      this.db.prepare('INSERT INTO mission_sqlite_imports VALUES(?,?,?,?)').run(sha256, resolve(filePath), saved.persistedAt, saved.revision);
      return { imported: true, replayed: false, sha256, revision: saved.revision, sourcePreserved: true };
    });
    this.revision = result.revision;
    return result;
  }

  _mandateRevision(mandateId) {
    const row = this.db.prepare('SELECT body,revoked FROM personal_mandates WHERE id=?').get(id(mandateId));
    if (!row) fail('A_DURABLE_MANDATE_MISSING');
    return hash(canonical({ body: JSON.parse(row.body), revoked: !!row.revoked }));
  }
  _stageEffect(input, now) {
    const effectId = id(input.effectId), operationId = id(input.operationId), missionId = id(input.missionId);
    const requestSha256 = hash(canonical(input.request));
    if (input.requestSha256 && input.requestSha256 !== requestSha256) fail('A_DURABLE_REQUEST_HASH_MISMATCH');
    const resourceKey = id(input.resourceKey ?? `effect:${effectId}`);
    if (Object.hasOwn(input.request ?? {},'remoteArtifactIntent')) {
      const contract=validateRemoteArtifactIntent(input.request.remoteArtifactIntent,{binding:input.request.remoteArtifactIntent?.binding,
        taskId:input.request.taskId,operationId,action:input.request.action});
      if(resourceKey!==contract.resourceKey) fail('A_REMOTE_ARTIFACT_RESOURCE_MISMATCH');
      if(input.providerIdempotencyKey!==operationId) fail('A_REMOTE_ARTIFACT_IDEMPOTENCY_MISMATCH');
    }
    const providerIdempotencyKey = input.providerIdempotencyKey == null ? null : id(input.providerIdempotencyKey);
    const intent = { effectId, operationId, missionId, resourceKey, request: input.request, providerIdempotencyKey, budget: input.budget ?? null };
    const intentJson = canonical(intent), intentSha256 = hash(intentJson);
    const prior = this.db.prepare('SELECT * FROM mission_effects WHERE effect_id=? OR operation_id=?').get(effectId, operationId);
    if (prior) {
      if (prior.intent_sha256 !== intentSha256) fail('A_DURABLE_EFFECT_CONFLICT');
      return this.getEffect(prior.effect_id);
    }
    let reservation = null, mandateRevision = null;
    if (input.budget) {
      // Bind explicit intent fields to the reservation. Tool-specific argument interpretation
      // still belongs to the authenticated policy/adapter boundary, not this persistence layer.
      for (const key of ['action', 'target', 'currency', 'amountMinor']) {
        if (Object.hasOwn(input.request, key) && input.request[key] !== input.budget.request?.[key]) fail('A_DURABLE_BUDGET_REQUEST_MISMATCH');
      }
      // Account, data and delegation revision are part of the same intent as
      // the monetary reservation. Missing scope must not inherit authority.
      let requestScope, budgetScope;
      try {
        requestScope = normalizeMandateRequestScope(input.request);
        budgetScope = normalizeMandateRequestScope(input.budget.request);
      } catch { fail('A_DURABLE_BUDGET_REQUEST_MISMATCH'); }
      if (canonical(requestScope) !== canonical(budgetScope)) fail('A_DURABLE_BUDGET_REQUEST_MISMATCH');
      mandateRevision = this._mandateRevision(input.budget.mandateId);
      reservation = this.budget.reserve(input.budget);
      if (reservation.state !== 'reserved' || reservation.replayed) fail('A_DURABLE_BUDGET_ALREADY_BOUND');
    }
    this.db.prepare(`INSERT INTO mission_effects(effect_id,mission_id,operation_id,request_sha256,intent_sha256,intent_json,provider_idempotency_key,mandate_id,mandate_revision,budget_reservation_id,state,resource_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`).run(effectId, missionId, operationId, requestSha256, intentSha256, intentJson, providerIdempotencyKey, input.budget?.mandateId ?? null, mandateRevision, reservation?.id ?? null, resourceKey, now.iso, now.iso);
    const runBinding=this.missionQuotaBinding(missionId);
    if(runBinding){
      this.db.prepare('UPDATE mission_effects SET mission_run_reservation_id=? WHERE effect_id=?').run(runBinding.reservation_id,effectId);
      this._assertMissionQuota(this.getEffect(effectId));
    }
    this.db.prepare('INSERT INTO mission_dispatch_outbox VALUES(?,?)').run(effectId, now.iso);
    return this.getEffect(effectId);
  }
  /** Read-only revalidation against the caller's currently approved device scope. */
  getRemoteArtifactIntent(effectId, binding) {
    const effect=this.getEffect(effectId);
    if(!effect?.intent?.request?.remoteArtifactIntent) fail('A_REMOTE_ARTIFACT_INTENT_MISSING');
    if(hash(canonical(effect.intent))!==effect.intent_sha256||effect.intent.effectId!==effect.effect_id
      ||effect.intent.missionId!==effect.mission_id||effect.intent.operationId!==effect.operation_id
      ||effect.intent.resourceKey!==effect.resource_key
      ||effect.intent.providerIdempotencyKey!==effect.provider_idempotency_key) fail('A_REMOTE_ARTIFACT_REQUEST_MISMATCH');
    const request=effect.intent.request;
    if(hash(canonical(request))!==effect.request_sha256) fail('A_REMOTE_ARTIFACT_REQUEST_MISMATCH');
    const contract=validateRemoteArtifactIntent(request.remoteArtifactIntent,{binding,taskId:request.taskId,
      operationId:effect.operation_id,action:request.action});
    if(effect.resource_key!==contract.resourceKey) fail('A_REMOTE_ARTIFACT_RESOURCE_MISMATCH');
    return structuredClone(contract);
  }
  getEffect(effectId) {
    const row = this.db.prepare('SELECT * FROM mission_effects WHERE effect_id=?').get(id(effectId));
    if (!row) fail('A_DURABLE_EFFECT_MISSING');
    return { ...row, intent: JSON.parse(row.intent_json), receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, executionAuthority: false };
  }
  pendingEffects() {
    return this.db.prepare("SELECT e.effect_id FROM mission_dispatch_outbox o JOIN mission_effects e USING(effect_id) WHERE e.state='prepared' ORDER BY o.created_at,e.effect_id").all().map(row => this.getEffect(row.effect_id));
  }
  _acquireLease(resourceKey, ownerId, ttlMs, now) {
    id(resourceKey); id(ownerId);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000) fail('A_DURABLE_LEASE_TTL_INVALID');
    const prior = this.db.prepare('SELECT * FROM mission_resource_leases WHERE resource_key=?').get(resourceKey);
    if (prior?.owner_id && prior.expires_ms > now.milliseconds) return null;
    const token = (prior?.token ?? 0) + 1, expiresMs = now.milliseconds + ttlMs;
    this.db.prepare(`INSERT INTO mission_resource_leases VALUES(?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET owner_id=excluded.owner_id,token=excluded.token,expires_ms=excluded.expires_ms`).run(resourceKey, ownerId, token, expiresMs);
    return { resourceKey, ownerId, token, expiresMs };
  }
  acquireLease({ resourceKey, ownerId, ttlMs = 30_000 }) {
    return this._transaction(() => this._acquireLease(resourceKey, ownerId, ttlMs, this._now()));
  }
  coreAuthorityStatus() {
    const row = this.db.prepare("SELECT * FROM mission_resource_leases WHERE resource_key='mission-core-authority'").get();
    return { ownerId: row?.owner_id ?? null, token: row?.token ?? 0, expiresMs: row?.expires_ms ?? 0 };
  }
  _assertCoreQuiescent() {
    if (JSON.parse(this._snapshot().body).some(m => ['PLANNING','RUNNING'].includes(m.status))) fail('A_CORE_AUTHORITY_MISSIONS_ACTIVE');
    if (this.db.prepare("SELECT 1 FROM mission_effects WHERE state IN ('in_flight','uncertain') LIMIT 1").get()) fail('A_CORE_AUTHORITY_EFFECT_RECONCILIATION_REQUIRED');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='microsoft_collection_effects'").get()
      &&this.db.prepare("SELECT 1 FROM microsoft_collection_effects WHERE state IN ('in_flight','uncertain') LIMIT 1").get())fail('A_CORE_AUTHORITY_EFFECT_RECONCILIATION_REQUIRED');
  }
  /** Explicit same-host authority acquisition, never automatic cross-host failover. */
  acquireCoreAuthority({ ownerId, expectedToken, ttlMs = 30_000, recoveryOnly = false, serviceId = null }) {
    return this._transaction(() => {
      if(typeof recoveryOnly!=='boolean')fail('A_CORE_AUTHORITY_RECOVERY_INVALID');
      const now = this._now(), prior = this.coreAuthorityStatus();
      if (!Number.isSafeInteger(expectedToken) || expectedToken < 0) fail('A_CORE_AUTHORITY_REVISION_CONFLICT');
      if(serviceId!==null){
        if(typeof serviceId!=='string'||!/^service:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(serviceId))fail('A_CORE_SERVICE_AUTHORITY_ID_INVALID');
        const binding=this.db.prepare('SELECT service_id,last_token,initial_token FROM mission_service_authority WHERE id=1').get();
        if(binding){if(binding.service_id!==serviceId||binding.last_token!==prior.token||binding.initial_token!==expectedToken)fail('A_CORE_SERVICE_AUTHORITY_CONTINUATION_DENIED');}
        else if(expectedToken!==prior.token)fail('A_CORE_AUTHORITY_REVISION_CONFLICT');
      }else if(expectedToken!==prior.token)fail('A_CORE_AUTHORITY_REVISION_CONFLICT');
      if (prior.ownerId && prior.expiresMs > now.milliseconds) return null;
      if(!recoveryOnly)this._assertCoreQuiescent();
      const lease=this._acquireLease('mission-core-authority',ownerId,ttlMs,now);
      if(serviceId!==null&&lease)this.db.prepare('INSERT INTO mission_service_authority(id,service_id,last_token,initial_token) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET last_token=excluded.last_token').run(serviceId,lease.token,expectedToken);
      return lease;
    });
  }
  assertCoreAuthority(lease) {
    const check=() => {
      if (lease?.resourceKey !== 'mission-core-authority') fail('A_CORE_AUTHORITY_BINDING_INVALID');
      return this._assertFence(lease,this._now());
    };
    // A host-owned inbox commit can share this connection. Keep the exact
    // fence/clock checks inside its atomic transaction without nesting BEGIN.
    return this.db.isTransaction?check():this._transaction(check);
  }
  releaseCoreAuthority(lease) {
    return this._transaction(() => {
      if (lease?.resourceKey !== 'mission-core-authority') fail('A_CORE_AUTHORITY_BINDING_INVALID');
      this._assertFence(lease,this._now());this._assertCoreQuiescent();
      this.db.prepare("UPDATE mission_resource_leases SET owner_id=NULL,expires_ms=0 WHERE resource_key='mission-core-authority'").run();
      return true;
    });
  }
  _assertFence({ resourceKey, ownerId, token }, now) {
    const row = this.db.prepare('SELECT * FROM mission_resource_leases WHERE resource_key=?').get(id(resourceKey));
    if (!row || row.owner_id !== id(ownerId) || row.token !== token || row.expires_ms <= now.milliseconds) fail('A_DURABLE_STALE_FENCE');
    return row;
  }
  heartbeatLease(lease, ttlMs = 30_000) {
    return this._transaction(() => {
      const now = this._now(); this._assertFence(lease, now);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000) fail('A_DURABLE_LEASE_TTL_INVALID');
      const expiresMs = now.milliseconds + ttlMs;
      this.db.prepare('UPDATE mission_resource_leases SET expires_ms=? WHERE resource_key=?').run(expiresMs, lease.resourceKey);
      return { ...lease, expiresMs };
    });
  }
  releaseLease(lease) {
    return this._transaction(() => {
      this._assertFence(lease, this._now());
      this.db.prepare('UPDATE mission_resource_leases SET owner_id=NULL,expires_ms=0 WHERE resource_key=?').run(lease.resourceKey);
      return true;
    });
  }
  claimEffect({ effectId, ownerId, ttlMs = 30_000 }) {
    return this._transaction(() => {
      const now = this._now(), effect = this.getEffect(effectId);
      if (effect.state !== 'prepared') return null;
      this._assertMissionQuota(effect);
      // An unresolved effect on the same resource needs reconciliation before another dispatch.
      if (this.db.prepare("SELECT 1 FROM mission_effects WHERE resource_key=? AND effect_id!=? AND state IN ('in_flight','uncertain')").get(effect.resource_key, effectId)) return null;
      const lease = this._acquireLease(effect.resource_key, ownerId, ttlMs, now);
      if (!lease) return null;
      if (effect.mandate_id) {
        if (this._mandateRevision(effect.mandate_id) !== effect.mandate_revision) fail('A_DURABLE_MANDATE_CHANGED');
        this.budget.begin(effect.budget_reservation_id);
      }
      this.db.prepare("UPDATE mission_effects SET state='in_flight',owner_id=?,fence=?,updated_at=? WHERE effect_id=? AND state='prepared'").run(ownerId, lease.token, now.iso, effectId);
      return { effect: this.getEffect(effectId), lease, executionAuthority: false };
    });
  }
  assertEffectDispatch({ effectId, lease, requestSha256 }) {
    return this._transaction(() => {
      const effect = this.getEffect(effectId);
      this._assertEffectFence(effect, lease, this._now());
      this._assertMissionQuota(effect);
      if (effect.state !== 'in_flight' || effect.request_sha256 !== requestSha256) fail('A_DURABLE_DISPATCH_MISMATCH');
      if (effect.budget_reservation_id) {
        if (this._mandateRevision(effect.mandate_id) !== effect.mandate_revision) fail('A_DURABLE_MANDATE_CHANGED');
        const reservation = this.budget.get(effect.budget_reservation_id);
        if (reservation.mandate_id !== effect.mandate_id || reservation.state !== 'in_flight') fail('A_DURABLE_BUDGET_NOT_IN_FLIGHT');
        const { intentFingerprint, ...request } = JSON.parse(reservation.request_json);
        // The enlisted store observes the durable monotonic clock. A denied
        // dispatch must not become eligible after clock rollback or reopen.
        if (!this.budget.store.evaluateMandate(effect.mandate_id, request).matches) fail('A_DURABLE_MANDATE_EXECUTION_DENIED');
      }
      return { allowed: true, effectId, executionAuthority: false };
    });
  }
  /** Resume only an already-bound local publication; never redispatch an uncertain action. */
  claimWorkflowPublicationRecovery({ effectId, requestSha256, ownerId, ttlMs = 30_000 }) {
    return this._transaction(() => {
      const now = this._now(), effect = this.getEffect(effectId), request = effect.intent.request;
      if (effect.state !== 'uncertain' || effect.receipt || effect.request_sha256 !== requestSha256
        || request.toolName !== 'workflow.execute' || request.executorBinding?.kind !== 'pc-local'
        || effect.operation_id !== effect.provider_idempotency_key || effect.budget_reservation_id) return null;
      this._assertMissionQuota(effect);
      if (this.db.prepare("SELECT 1 FROM mission_effects WHERE resource_key=? AND effect_id!=? AND state IN ('in_flight','uncertain')").get(effect.resource_key, effectId)) return null;
      const lease = this._acquireLease(effect.resource_key, ownerId, ttlMs, now);
      if (!lease) return null;
      this.db.prepare("UPDATE mission_effects SET state='in_flight',owner_id=?,fence=?,updated_at=? WHERE effect_id=? AND state='uncertain'").run(ownerId, lease.token, now.iso, effectId);
      return { effect: this.getEffect(effectId), lease, executionAuthority: false };
    });
  }
  /** Only a prepared effect is provably not handed to B. In-flight/uncertain are never released here. */
  failUndispatchedEffect({ effectId, reason }) {
    return this._transaction(() => {
      const effect = this.getEffect(effectId), now = this._now();
      if (effect.state !== 'prepared') fail('A_DURABLE_EFFECT_ALREADY_DISPATCHED');
      if (effect.budget_reservation_id) this.budget.release(effect.budget_reservation_id);
      this.db.prepare("UPDATE mission_effects SET state='failed',receipt_json=?,updated_at=? WHERE effect_id=?")
        .run(canonical({ notDispatched: true, reason: String(reason ?? 'preflight-rejected') }), now.iso, effectId);
      this.db.prepare('DELETE FROM mission_dispatch_outbox WHERE effect_id=?').run(effectId);
      return this.getEffect(effectId);
    });
  }
  markUncertain({ effectId, lease }) {
    return this._transaction(() => {
      const now = this._now(), effect = this.getEffect(effectId);
      this._assertEffectFence(effect, lease, now);
      this._uncertain(effect, now);
      return this.getEffect(effectId);
    });
  }
  /** Only the trusted HTTP client invokes this after exact B operation cancellation confirmation. */
  confirmRemoteCancellation({ effectId, lease, cancellation }) {
    return this._transaction(() => {
      const effect = this.getEffect(effectId), now = this._now();
      this._assertEffectFence(effect, lease, now);
      if (effect.state !== 'in_flight' || effect.intent.request.executorBinding?.kind !== 'pc-http-loopback'
        || cancellation?.version !== 'b-durable-operation-v1' || cancellation.state !== 'cancelled'
        || cancellation.cancellationConfirmed !== true || cancellation.operationId !== effect.operation_id
        || cancellation.taskId !== effect.intent.request.taskId) fail('A_DURABLE_CANCELLATION_UNCONFIRMED');
      if (effect.budget_reservation_id) this.budget.release(effect.budget_reservation_id);
      this.db.prepare("UPDATE mission_effects SET state='failed',receipt_json=?,updated_at=? WHERE effect_id=?")
        .run(canonical({ notDispatched: true, reason: 'remote-prepared-cancelled', cancellation }), now.iso, effectId);
      this.db.prepare('DELETE FROM mission_dispatch_outbox WHERE effect_id=?').run(effectId);
      this.db.prepare('UPDATE mission_resource_leases SET owner_id=NULL,expires_ms=0 WHERE resource_key=?').run(lease.resourceKey);
      return this.getEffect(effectId);
    });
  }
  _uncertain(effect, now) {
    if (effect.state !== 'in_flight') fail('A_DURABLE_EFFECT_NOT_IN_FLIGHT');
    if (effect.budget_reservation_id) this.budget.uncertain(effect.budget_reservation_id);
    this.db.prepare("UPDATE mission_effects SET state='uncertain',updated_at=? WHERE effect_id=?").run(now.iso, effect.effect_id);
  }
  recoverExpiredEffects() {
    return this._transaction(() => {
      const now = this._now(), effects = this.db.prepare("SELECT * FROM mission_effects WHERE state='in_flight'").all(), recovered = [];
      for (const effect of effects) {
        const lease = this.db.prepare('SELECT * FROM mission_resource_leases WHERE resource_key=?').get(effect.resource_key);
        if (!lease || lease.owner_id !== effect.owner_id || lease.token !== effect.fence || lease.expires_ms <= now.milliseconds) {
          this._uncertain(effect, now); recovered.push(effect.effect_id);
        }
      }
      return { uncertainEffectIds: recovered, replayedEffects: 0 };
    });
  }
  _assertEffectFence(effect, lease, now) {
    this._assertFence(lease, now);
    if (effect.resource_key !== lease.resourceKey || effect.owner_id !== lease.ownerId || effect.fence !== lease.token) fail('A_DURABLE_STALE_FENCE');
  }
  /** Call only after provider I/O finishes, outside SQL transactions. Receipt is evidence, not G verification. */
  completeEffect({ effectId, lease, receipt, actualMinor, followup = { type: 'verify-and-remember' }, snapshot = null }) {
    const result = this._transaction(() => {
      const now = this._now(), effect = this.getEffect(effectId);
      if (effect.state === 'succeeded') {
        if (effect.resource_key !== lease?.resourceKey || effect.owner_id !== lease?.ownerId || effect.fence !== lease?.token) fail('A_DURABLE_STALE_FENCE');
        return this._replayCompletion(effect, receipt, actualMinor, followup);
      }
      this._assertEffectFence(effect, lease, now);
      if (effect.state !== 'in_flight') fail('A_DURABLE_EFFECT_NOT_IN_FLIGHT');
      const saved = snapshot ? this._save(snapshot.missions, { reason: snapshot.reason ?? 'effect-result', expectedRevision: snapshot.expectedRevision ?? this.revision, effects: [] }) : null;
      return { ...this._complete(effect, receipt, actualMinor, followup, now), ...(saved ? { snapshot: saved } : {}) };
    });
    if (result.snapshot) this.revision = result.snapshot.revision;
    return result;
  }
  /** A separate provider read/reconciliation supplies evidence; this method never redispatches. */
  reconcileEffect({ effectId, reconciliation, receipt, actualMinor, followup = { type: 'verify-and-remember' }, snapshot = null }) {
    const result = this._transaction(() => {
      const effect = this.getEffect(effectId);
      if (!reconciliation || reconciliation.operationId !== effect.operation_id || reconciliation.requestSha256 !== effect.request_sha256 || typeof reconciliation.evidenceRef !== 'string' || !reconciliation.evidenceRef.trim()) fail('A_DURABLE_RECONCILIATION_REQUIRED');
      if (effect.state === 'succeeded') return this._replayCompletion(effect, { ...receipt, reconciliation }, actualMinor, followup);
      if (effect.state !== 'uncertain') fail('A_DURABLE_EFFECT_NOT_UNCERTAIN');
      const saved = snapshot ? this._save(snapshot.missions, { reason: snapshot.reason ?? 'effect-reconciled', expectedRevision: snapshot.expectedRevision ?? this.revision, effects: [] }) : null;
      return { ...this._complete(effect, { ...receipt, reconciliation }, actualMinor, followup, this._now()), ...(saved ? { snapshot: saved } : {}) };
    });
    if (result.snapshot) this.revision = result.snapshot.revision;
    return result;
  }
  _complete(effect, receipt, actualMinor, followup, now) {
    if (!receipt || typeof receipt.receiptRef !== 'string' || !receipt.receiptRef.trim()) fail('A_DURABLE_RECEIPT_REQUIRED');
    const body = canonical(receipt), eventBody = canonical(followup);
    if (effect.budget_reservation_id) {
      if (!Number.isSafeInteger(actualMinor) || actualMinor < 0) fail('A_DURABLE_ACTUAL_COST_REQUIRED');
      this.budget.settle({ id: effect.budget_reservation_id, actualMinor, receiptRef: receipt.receiptRef });
    }
    this.db.prepare("UPDATE mission_effects SET state='succeeded',receipt_json=?,updated_at=? WHERE effect_id=?").run(body, now.iso, effect.effect_id);
    this.db.prepare('DELETE FROM mission_dispatch_outbox WHERE effect_id=?').run(effect.effect_id);
    const eventId = `effect-result:${effect.effect_id}`;
    this.db.prepare('INSERT INTO mission_followup_outbox VALUES(?,?,?,0,?)').run(eventId, effect.effect_id, eventBody, now.iso);
    this.db.prepare('UPDATE mission_resource_leases SET owner_id=NULL,expires_ms=0 WHERE resource_key=? AND owner_id=? AND token=?').run(effect.resource_key, effect.owner_id, effect.fence);
    return { effect: this.getEffect(effect.effect_id), eventId, providerReceiptRecorded: true, independentVerification: false };
  }
  _replayCompletion(effect, receipt, actualMinor, followup) {
    const eventId = `effect-result:${effect.effect_id}`;
    const event = this.db.prepare('SELECT body FROM mission_followup_outbox WHERE event_id=?').get(eventId);
    if (canonical(receipt) !== effect.receipt_json || canonical(followup) !== event?.body) fail('A_DURABLE_RECEIPT_CONFLICT');
    if (effect.budget_reservation_id) {
      const reservation = this.budget.get(effect.budget_reservation_id);
      if (reservation.actual_minor !== actualMinor) fail('A_DURABLE_RECEIPT_CONFLICT');
    }
    return { effect: this.getEffect(effect.effect_id), eventId, providerReceiptRecorded: true, independentVerification: false, replayed: true };
  }
  pendingFollowups() {
    return this.db.prepare('SELECT * FROM mission_followup_outbox WHERE acked=0 ORDER BY created_at,event_id').all().map(row => ({ ...row, body: JSON.parse(row.body) }));
  }
  acknowledgeFollowup(eventId, { snapshot = null } = {}) {
    const result = this._transaction(() => {
      const row = this.db.prepare('SELECT * FROM mission_followup_outbox WHERE event_id=?').get(id(eventId));
      if (!row) fail('A_DURABLE_FOLLOWUP_MISSING');
      this.db.prepare('UPDATE mission_followup_outbox SET acked=1 WHERE event_id=?').run(eventId);
      const saved = snapshot ? this._save(snapshot.missions, { reason: snapshot.reason ?? 'effect-verified', expectedRevision: snapshot.expectedRevision ?? this.revision, effects: [] }) : null;
      return { eventId, acknowledged: true, replayed: !!row.acked, externalDispatch: false, ...(saved ? { snapshot: saved } : {}) };
    });
    if (result.snapshot) this.revision = result.snapshot.revision;
    return result;
  }
}
