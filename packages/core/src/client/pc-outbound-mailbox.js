import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {validPcReadiness} from '../../../shared/src/pc-readiness-contract.js';
import {validPcDeviceObservation} from '../../../shared/src/pc-device-observation-contract.js';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/u.test(value);
const taskIdValid = value => typeof value === 'string' && /^[\p{L}\p{N}._-]{1,128}$/u.test(value);
const fingerprint = value => String(value).replaceAll(':', '').toUpperCase();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(`A_PC_OUTBOUND_${code}`); };

/** Durable read/reconciliation mailbox. This deliberately grants no execution authority. */
export class PcOutboundMailbox {
  constructor({ dbPath, clock = Date.now, leaseMs = 15000, freshnessMs = 15000, authorityGuard = null } = {}) {
    if (!dbPath || !Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 30000) fail('CONFIG_INVALID');
    if (!Number.isInteger(freshnessMs) || freshnessMs < 100 || freshnessMs > 30000
      || (authorityGuard !== null && typeof authorityGuard !== 'function')) fail('CONFIG_INVALID');
    this.clock = clock; this.leaseMs = leaseMs; this.freshnessMs = freshnessMs; this.authorityGuard = authorityGuard;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pc_outbound_devices(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_outbound_reads(id TEXT PRIMARY KEY, device TEXT NOT NULL,
        device_generation INTEGER NOT NULL, request TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0, lease TEXT, expires INTEGER, result TEXT, result_digest TEXT);
      CREATE TABLE IF NOT EXISTS pc_outbound_clock(id INTEGER PRIMARY KEY CHECK(id=1), time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_outbound_scopes(device TEXT PRIMARY KEY, generation INTEGER NOT NULL, tasks TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_outbound_artifact_scopes(device TEXT PRIMARY KEY, generation INTEGER NOT NULL, tasks TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_outbound_presence(device TEXT PRIMARY KEY, generation INTEGER NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_outbound_observed(request TEXT PRIMARY KEY, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_outbound_read_authority(request TEXT PRIMARY KEY, token INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_outbound_labels(device TEXT PRIMARY KEY,label TEXT NOT NULL);`);
  }
  authorityEpoch() {
    if (!this.authorityGuard) return 0;
    let authority;
    try { authority = this.authorityGuard(); } catch { fail('AUTHORITY_LOST'); }
    if (!Number.isSafeInteger(authority?.token) || authority.token < 1) fail('AUTHORITY_INVALID');
    return authority.token;
  }
  transaction(fn) {
    this.authorityEpoch();
    // Persist the high-water clock even when authorization later rejects/rolls back.
    this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.authorityEpoch(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  now() {
    const current = this.clock();
    if (!Number.isSafeInteger(current) || current < 0) fail('CLOCK_INVALID');
    const old = this.db.prepare('SELECT time FROM pc_outbound_clock WHERE id=1').get()?.time ?? 0;
    const time = Math.max(old, current);
    this.db.prepare('INSERT INTO pc_outbound_clock VALUES(1,?) ON CONFLICT(id) DO UPDATE SET time=MAX(pc_outbound_clock.time,excluded.time)').run(time);
    return this.db.prepare('SELECT time FROM pc_outbound_clock WHERE id=1').get().time;
  }
  enroll({ deviceId, certificateFingerprint, expiresAt, allowedTaskIds = [], allowedArtifactTaskIds = [], expectedGeneration, label = deviceId }) {
    if (!id(deviceId) || !/^[A-F0-9]{64}$/u.test(fingerprint(certificateFingerprint)) || !Array.isArray(allowedTaskIds)
      || allowedTaskIds.length > 1000 || allowedTaskIds.some(task => !taskIdValid(task))) fail('IDENTITY_INVALID');
    if (!Array.isArray(allowedArtifactTaskIds) || allowedArtifactTaskIds.length > 1000
      || allowedArtifactTaskIds.some(task => !taskIdValid(task) || !allowedTaskIds.includes(task))) fail('READ_SCOPE_DENIED');
    if (typeof label !== 'string' || !label.trim() || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) fail('INPUT_INVALID');
    return this.transaction(() => {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) fail('IDENTITY_EXPIRED');
      const oldGeneration = this.db.prepare('SELECT generation FROM pc_outbound_devices WHERE id=?').get(deviceId)?.generation ?? 0;
      if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration !== oldGeneration)) fail('IDENTITY_CONFLICT');
      const generation = oldGeneration + 1;
      this.db.prepare(`INSERT INTO pc_outbound_devices VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET
        fingerprint=excluded.fingerprint,generation=excluded.generation,expires=excluded.expires,revoked=0`)
        .run(deviceId, fingerprint(certificateFingerprint), generation, expiresAt);
      this.db.prepare(`INSERT INTO pc_outbound_scopes VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET
        generation=excluded.generation,tasks=excluded.tasks`).run(deviceId, generation, JSON.stringify([...new Set(allowedTaskIds)]));
      this.db.prepare(`INSERT INTO pc_outbound_artifact_scopes VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET
        generation=excluded.generation,tasks=excluded.tasks`).run(deviceId, generation, JSON.stringify([...new Set(allowedArtifactTaskIds)]));
      this.db.prepare('INSERT INTO pc_outbound_labels VALUES(?,?) ON CONFLICT(device) DO UPDATE SET label=excluded.label').run(deviceId,label.trim());
      this.db.prepare("UPDATE pc_outbound_reads SET state='invalidated' WHERE device=? AND state IN ('queued','leased')").run(deviceId);
      return { deviceId, generation, expiresAt };
    });
  }
  device(peer) {
    const device = this.db.prepare('SELECT * FROM pc_outbound_devices WHERE fingerprint=?').get(fingerprint(peer));
    if (!device || device.revoked || device.expires <= this.now()) fail('DEVICE_DENIED');
    return device;
  }
  revoke(deviceId, { expectedGeneration } = {}) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT generation FROM pc_outbound_devices WHERE id=?').get(deviceId);
      if (!current) fail('DEVICE_NOT_FOUND');
      if (expectedGeneration !== undefined && expectedGeneration !== current.generation) fail('IDENTITY_CONFLICT');
      this.db.prepare('UPDATE pc_outbound_devices SET revoked=1 WHERE id=?').run(deviceId);
      this.db.prepare("UPDATE pc_outbound_reads SET state='invalidated' WHERE device=? AND state IN ('queued','leased')").run(deviceId);
    });
  }
  enqueue({ requestId, deviceId, operation, taskId = null, operationId, action, offset, limit }) {
    if (!id(requestId) || !id(deviceId) || !['health','device-observation','task-catalog','task-readiness','task-result','task-publication','operation-receipt','operation-artifact'].includes(operation)
      || (['health','device-observation','task-catalog'].includes(operation) ? taskId !== null : !taskIdValid(taskId))) fail('READ_CONTRACT_INVALID');
    if(operation==='task-catalog'&&(!Number.isSafeInteger(offset)||offset<0||offset>1000||!Number.isSafeInteger(limit)||limit<1||limit>100)||operation!=='task-catalog'&&(offset!==undefined||limit!==undefined))fail('READ_CONTRACT_INVALID');
    if(['operation-receipt','operation-artifact'].includes(operation)&&(!/^mission_op_[a-f0-9]{32}$/u.test(operationId??'')
      ||!action||Array.isArray(action)||action.toolName!=='filesystem.createTextFile'
      ||typeof action.arguments?.path!=='string'||typeof (action.arguments?.content??'')!=='string'))fail('READ_CONTRACT_INVALID');
    if(!['operation-receipt','operation-artifact'].includes(operation)&&(operationId!==undefined||action!==undefined))fail('READ_CONTRACT_INVALID');
    return this.transaction(() => {
      const device = this.db.prepare('SELECT * FROM pc_outbound_devices WHERE id=?').get(deviceId);
      if (!device || device.revoked || device.expires <= this.now()) fail('DEVICE_DENIED');
      const scope = this.db.prepare('SELECT * FROM pc_outbound_scopes WHERE device=?').get(deviceId);
      if (!['health','device-observation','task-catalog'].includes(operation) && (scope?.generation !== device.generation || !JSON.parse(scope.tasks).includes(taskId))) fail('READ_SCOPE_DENIED');
      if (operation === 'operation-artifact') {
        const artifactScope = this.db.prepare('SELECT * FROM pc_outbound_artifact_scopes WHERE device=?').get(deviceId);
        if (artifactScope?.generation !== device.generation || !JSON.parse(artifactScope.tasks).includes(taskId)) fail('ARTIFACT_SCOPE_DENIED');
      }
      const selectedTasks=JSON.parse(scope?.tasks??'[]');
      const request = operation==='task-catalog'?{operation,taskId:null,offset,limit,totalEntries:selectedTasks.length,taskIds:selectedTasks.slice(offset,offset+limit)}:['operation-receipt','operation-artifact'].includes(operation)?{operation,taskId,operationId,action}:{operation,taskId};
      if(Buffer.byteLength(JSON.stringify(request))>65536)fail('READ_CONTRACT_INVALID');
      const digest = hash(request);
      const existing = this.db.prepare('SELECT * FROM pc_outbound_reads WHERE id=?').get(requestId);
      if (existing) {
        if (existing.device !== deviceId || existing.device_generation !== device.generation || existing.digest !== digest) fail('REQUEST_CONFLICT');
        return this.result(requestId);
      }
      this.db.prepare("INSERT INTO pc_outbound_reads(id,device,device_generation,request,digest,state) VALUES(?,?,?,?,?,'queued')")
        .run(requestId, deviceId, device.generation, JSON.stringify(request), digest);
      this.db.prepare('INSERT INTO pc_outbound_read_authority VALUES(?,?)').run(requestId, this.authorityEpoch());
      return this.result(requestId);
    });
  }
  pull(peer) {
    return this.transaction(() => {
      const device = this.device(peer), now = this.now();
      this.db.prepare(`UPDATE pc_outbound_reads SET state='invalidated' WHERE device=? AND state IN ('queued','leased')
        AND COALESCE((SELECT token FROM pc_outbound_read_authority WHERE request=pc_outbound_reads.id),0)<>?`).run(device.id, this.authorityEpoch());
      this.db.prepare(`INSERT INTO pc_outbound_presence VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET
        generation=excluded.generation,seen=excluded.seen`).run(device.id, device.generation, now);
      // Only the fixed, idempotent reads above may be redelivered after a lost response.
      const row = this.db.prepare(`SELECT * FROM pc_outbound_reads WHERE device=? AND device_generation=?
        AND (state='queued' OR (state='leased' AND expires<=?)) ORDER BY rowid LIMIT 1`).get(device.id, device.generation, now);
      if (!row) return null;
      const lease = randomUUID(), generation = row.generation + 1, expiresAt = Math.min(now + this.leaseMs, device.expires);
      this.db.prepare("UPDATE pc_outbound_reads SET state='leased',generation=?,lease=?,expires=? WHERE id=?")
        .run(generation, lease, expiresAt, row.id);
      return { requestId: row.id, deviceId: device.id, deviceGeneration: device.generation,
        generation, lease, expiresAt, request: JSON.parse(row.request) };
    });
  }
  submit(peer, input) {
    return this.transaction(() => {
      const device = this.device(peer);
      if (!input || !id(input.requestId) || typeof input.lease !== 'string' || !Number.isInteger(input.generation)
        || !input.result || !['observed','unavailable'].includes(input.result.status)
        || Object.keys(input).some(key => !['requestId','generation','lease','result'].includes(key))) fail('RESULT_INVALID');
      const encoded = JSON.stringify(input.result);
      if (Buffer.byteLength(encoded) > 262144) fail('RESULT_TOO_LARGE');
      const row = this.db.prepare('SELECT * FROM pc_outbound_reads WHERE id=?').get(input.requestId);
      const epoch = this.db.prepare('SELECT token FROM pc_outbound_read_authority WHERE request=?').get(input.requestId)?.token ?? 0;
      if (epoch !== this.authorityEpoch()) fail('AUTHORITY_CHANGED');
      if (!row || row.device !== device.id || row.device_generation !== device.generation
        || row.generation !== input.generation || row.lease !== input.lease) fail('STALE_LEASE');
      if(JSON.parse(row.request).operation==='device-observation'
        &&(Object.keys(input.result).sort().join(',')!==(input.result.status==='observed'?'observedAt,status,value':'observedAt,reason,status')
          ||typeof input.result.observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.result.observedAt)
          ||!Number.isFinite(Date.parse(input.result.observedAt))
          ||input.result.status==='observed'&&!validPcDeviceObservation(input.result.value)
          ||input.result.status==='unavailable'&&input.result.reason!=='선택한 PC 자료를 조회할 수 없습니다.'))fail('RESULT_INVALID');
      if(JSON.parse(row.request).operation==='task-readiness'&&input.result.status==='observed'
        &&!validPcReadiness(input.result.value,JSON.parse(row.request).taskId))fail('RESULT_INVALID');
      if(JSON.parse(row.request).operation==='task-readiness'
        &&(Object.keys(input.result).sort().join(',')!==(input.result.status==='observed'?'observedAt,status,value':'observedAt,reason,status')
          ||typeof input.result.observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.result.observedAt)
          ||!Number.isFinite(Date.parse(input.result.observedAt))||input.result.status==='unavailable'&&input.result.reason!=='선택한 PC 자료를 조회할 수 없습니다.'))fail('RESULT_INVALID');
      if(JSON.parse(row.request).operation==='task-catalog'&&input.result.status==='observed'){
        const query=JSON.parse(row.request),value=input.result.value;
        if(!value||Object.keys(value).sort().join(',')!=='executionAuthority,hasMore,items,offset,totalEntries,verifiedCompletion'
          ||value.executionAuthority!==false||value.verifiedCompletion!==false||value.offset!==query.offset||value.totalEntries!==query.totalEntries
          ||value.hasMore!==(query.offset+query.taskIds.length<query.totalEntries)||!Array.isArray(value.items)||value.items.length!==query.taskIds.length
          ||value.items.some((item,i)=>!item||Object.keys(item).sort().join(',')!=='available,dryRun,status,taskId,title'||item.taskId!==query.taskIds[i]
            ||typeof item.available!=='boolean'||!(item.dryRun===null||typeof item.dryRun==='boolean')||typeof item.title!=='string'||item.title.length>80
            ||/[\u0000-\u001f\u007f]/u.test(item.title)||typeof item.status!=='string'||!/^[A-Z_]{1,40}$/u.test(item.status)))fail('RESULT_INVALID');
      }
      if (row.state === 'observed') {
        if (row.result_digest !== hash(input.result)) fail('RESULT_CONFLICT');
        return { accepted: true, duplicate: true };
      }
      if (row.state !== 'leased' || row.expires <= this.now()) fail('STALE_LEASE');
      this.db.prepare("UPDATE pc_outbound_reads SET state='observed',result=?,result_digest=? WHERE id=?")
        .run(encoded, hash(input.result), row.id);
      this.db.prepare('INSERT INTO pc_outbound_observed VALUES(?,?)').run(row.id, this.now());
      return { accepted: true, duplicate: false };
    });
  }
  result(requestId) {
    const row = this.db.prepare('SELECT * FROM pc_outbound_reads WHERE id=?').get(requestId);
    if (!row) return null;
    const device = this.db.prepare('SELECT * FROM pc_outbound_devices WHERE id=?').get(row.device), now = this.now();
    const currentIdentity = Boolean(device && !device.revoked && device.expires > now && device.generation === row.device_generation);
    const observed = this.db.prepare('SELECT time FROM pc_outbound_observed WHERE request=?').get(row.id);
    const epoch = this.db.prepare('SELECT token FROM pc_outbound_read_authority WHERE request=?').get(row.id)?.token ?? 0;
    return { requestId: row.id, deviceId: row.device, deviceGeneration: row.device_generation, state: row.state,
      observation: row.result ? JSON.parse(row.result) : null, recordedAt: observed ? new Date(observed.time).toISOString() : null,
      observationCurrentUntil: observed&&device ? new Date(Math.min(device.expires,observed.time+this.freshnessMs)).toISOString() : null,
      authorityToken: epoch, observationCurrent: epoch === this.authorityEpoch() && currentIdentity && Boolean(observed && now - observed.time < this.freshnessMs),
      executionAuthority: false, verifiedCompletion: false };
  }
  status() {
    const now = this.now();
    const devices = this.db.prepare('SELECT * FROM pc_outbound_devices ORDER BY id LIMIT 1001').all();
    return { mode: 'outbound-observation', executionAuthority: false, devices: devices.slice(0, 1000).map(device => {
      const presence = this.db.prepare('SELECT * FROM pc_outbound_presence WHERE device=?').get(device.id);
      const scope = this.db.prepare('SELECT * FROM pc_outbound_scopes WHERE device=?').get(device.id);
      const identityValid = !device.revoked && device.expires > now;
      const connected = identityValid && presence?.generation === device.generation && now - presence.seen < this.freshnessMs;
      const label = this.db.prepare('SELECT label FROM pc_outbound_labels WHERE device=?').get(device.id)?.label ?? device.id;
      return { deviceId: device.id, label, generation: device.generation, expiresAt: new Date(device.expires).toISOString(),
        status: device.revoked ? 'revoked' : !identityValid ? 'expired' : connected ? 'connected' : 'waiting',
        lastSeenAt: presence?.generation === device.generation ? new Date(presence.seen).toISOString() : null,
        selectedTaskCount: scope?.generation === device.generation ? JSON.parse(scope.tasks).length : 0,
        readCapabilities: ['health', 'task-result', 'task-publication','operation-receipt',
          ...(this.db.prepare('SELECT generation,tasks FROM pc_outbound_artifact_scopes WHERE device=?').get(device.id)?.generation === device.generation
            && JSON.parse(this.db.prepare('SELECT tasks FROM pc_outbound_artifact_scopes WHERE device=?').get(device.id).tasks).length ? ['operation-artifact'] : [])], effectExecution: 'not-enabled' };
    }), truncated: devices.length > 1000 };
  }
  scope(deviceId) {
    if (!id(deviceId)) fail('INPUT_INVALID');
    const device = this.db.prepare('SELECT * FROM pc_outbound_devices WHERE id=?').get(deviceId);
    if (!device) fail('DEVICE_NOT_FOUND');
    const scope = this.db.prepare('SELECT * FROM pc_outbound_scopes WHERE device=?').get(deviceId);
    const artifactScope = this.db.prepare('SELECT * FROM pc_outbound_artifact_scopes WHERE device=?').get(deviceId);
    return { deviceId, generation:device.generation, certificateFingerprint:device.fingerprint, expiresAt:new Date(device.expires).toISOString(),
      allowedTaskIds: scope?.generation === device.generation ? JSON.parse(scope.tasks) : [],
      allowedArtifactTaskIds: artifactScope?.generation === device.generation ? JSON.parse(artifactScope.tasks) : [] };
  }
  close() { this.db.close(); }
}
