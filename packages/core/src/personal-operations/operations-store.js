import { DatabaseSync } from 'node:sqlite';
import {assertLedgerPathSyntax} from '../runtime/local-ledger-storage.js';
import { normalizeMandateScope, mandateScopeReasons } from './mandate-scope.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {normalizeStrictIsoInstant} from '../../../shared/src/strict-iso-instant.js';

function fail(message) { throw new Error(`A_PERSONAL_OPS_INVALID: ${message}`); }
function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(name);
  return value.trim();
}
function date(value, name) {
  const normalized=normalizeStrictIsoInstant(value);
  if(normalized===null)fail(name);
  return normalized;
}
function money(value) { if (!Number.isSafeInteger(value) || value < 0) fail('amountMinor'); return value; }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail('fields');
}

/** Local single-owner ledger. Mandate evaluation NEVER issues execution authority. */
export class PersonalOperationsStore {
  constructor({ dbPath, clock = () => new Date() }) {
    if (!dbPath) fail('dbPath');
    assertLedgerPathSyntax(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.clock = clock;
    this.db = new DatabaseSync(dbPath);
    this.db.function('personal_source_fingerprint',{deterministic:true},(body,withdrawn)=>createHash('sha256').update(JSON.stringify({body,withdrawn})).digest('hex'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS personal_ops_meta(version INTEGER NOT NULL);
      INSERT INTO personal_ops_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM personal_ops_meta);
      CREATE TABLE IF NOT EXISTS personal_goals(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_commitments(id TEXT PRIMARY KEY, goal_id TEXT REFERENCES personal_goals(id), title TEXT NOT NULL, due_at TEXT NOT NULL, source_ref TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','done','cancelled')), created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS personal_due ON personal_commitments(state,due_at);
      CREATE TABLE IF NOT EXISTS personal_followups(id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL UNIQUE REFERENCES personal_commitments(id), state TEXT NOT NULL CHECK(state IN ('pending','done','dismissed')), created_at TEXT NOT NULL, resolution TEXT);
      CREATE TABLE IF NOT EXISTS personal_reminder_outbox(event_id TEXT PRIMARY KEY, followup_id TEXT NOT NULL UNIQUE REFERENCES personal_followups(id), body TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, claimed_by TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS personal_reminder_outbox_pending ON personal_reminder_outbox(acked,created_at,event_id);
      CREATE TABLE IF NOT EXISTS personal_mission_proactive_state(mission_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_mission_proactive_outbox(event_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, claimed_by TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS personal_mission_proactive_pending ON personal_mission_proactive_outbox(acked,created_at,event_id);
      CREATE TABLE IF NOT EXISTS personal_notification_seen(event_id TEXT PRIMARY KEY,seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_mandates(id TEXT PRIMARY KEY, body TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    `);
    const reminderColumns = new Set(this.db.prepare('PRAGMA table_info(personal_reminder_outbox)').all().map(column => column.name));
    for (const [name, definition] of [['claimed_by', 'TEXT'], ['lease_until', 'TEXT'], ['attempts', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!reminderColumns.has(name)) this.db.exec(`ALTER TABLE personal_reminder_outbox ADD COLUMN ${name} ${definition}`);
    }
    if (!this.db.prepare('PRAGMA table_info(personal_commitments)').all().some(c => c.name === 'revision')) this.db.exec('ALTER TABLE personal_commitments ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    this.db.exec(`CREATE TABLE IF NOT EXISTS personal_deadline_changes(change_id TEXT PRIMARY KEY,commitment_id TEXT NOT NULL,request TEXT NOT NULL,receipt TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS personal_reminder_archive(event_id TEXT PRIMARY KEY,record TEXT NOT NULL,archived_at TEXT NOT NULL);`);
    if (this.db.prepare('SELECT version FROM personal_ops_meta').get().version !== 1) { this.close(); fail('schema version'); }
  }
  close() { this.db.close(); }
  now() { return date(this.clock().toISOString(), 'clock'); }
  commitmentSourceDependency(commitmentId,boundSourceHash=undefined){
    const sourceRef=this.db.prepare('SELECT source_ref FROM personal_commitments WHERE id=?').get(commitmentId)?.source_ref;
    if(!sourceRef?.startsWith('source-inbox:'))return {required:false,current:true,status:'not-required',executionAuthority:false};
    const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_source_items'").get();
    const source=exists?this.db.prepare('SELECT * FROM personal_source_items WHERE id=? AND commitment_id=?').get(sourceRef.slice(13),commitmentId):null;
    const currentHash=source?createHash('sha256').update(JSON.stringify({body:source.body,withdrawn:source.withdrawn})).digest('hex'):null;
    const boundHash=boundSourceHash===undefined?source?.accepted_source_hash:boundSourceHash;
    const status=!source||!boundHash?'unknown':source.withdrawn?'withdrawn':boundHash!==currentHash?'changed':'current';
    return {required:true,current:status==='current',status,sourceId:sourceRef.slice(13),boundSourceHash:boundHash??null,currentSourceHash:currentHash,observedAt:source?.observed_at??null,executionAuthority:false};
  }
  createGoal(input) {
    object(input, ['title']); const title = text(input.title, 'title'); const id = randomUUID();
    this.db.prepare('INSERT INTO personal_goals VALUES(?,?,?)').run(id, title, this.now());
    return { id, title };
  }
  createCommitment(input) {
    object(input, ['goalId','title','dueAt','sourceRef']);
    const title = text(input.title,'title'), due = date(input.dueAt,'dueAt'), source = text(input.sourceRef,'sourceRef',500);
    const goal = input.goalId == null ? null : text(input.goalId,'goalId',100);
    if (goal && !this.db.prepare('SELECT id FROM personal_goals WHERE id=?').get(goal)) fail('unknown goal');
    const id = randomUUID();
    this.db.prepare('INSERT INTO personal_commitments(id,goal_id,title,due_at,source_ref,state,created_at) VALUES(?,?,?,?,?,?,?)').run(id,goal,title,due,source,'open',this.now());
    return { id, title, dueAt: due, revision: 1 };
  }
  deadlineChangeReceipt(changeId){
    text(changeId,'changeId',100);
    const row=this.db.prepare('SELECT receipt,created_at FROM personal_deadline_changes WHERE change_id=?').get(changeId);
    return row?{...JSON.parse(row.receipt),changeId,recordedAt:row.created_at,meaning:'historical-change-receipt'}:null;
  }
  changeDeadline(id, input) {
    text(id,'id',100); object(input,['dueAt','expectedRevision','changeId']);
    const dueAt=date(input.dueAt,'dueAt'), changeId=text(input.changeId,'changeId',100);
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)fail('expectedRevision');
    const request=JSON.stringify({id,dueAt,expectedRevision:input.expectedRevision});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare('SELECT request,receipt FROM personal_deadline_changes WHERE change_id=?').get(changeId);
      if(old){if(old.request!==request)fail('changeId conflict');this.db.exec('COMMIT');return {...JSON.parse(old.receipt),repeated:true};}
      const row=this.db.prepare('SELECT * FROM personal_commitments WHERE id=?').get(id);
      if(!row||row.state!=='open')fail('commitment not open');
      if(row.revision!==input.expectedRevision){const e=new Error('A_PERSONAL_DEADLINE_REVISION_CONFLICT');e.code='A_PERSONAL_DEADLINE_REVISION_CONFLICT';throw e;}
      const revision=row.revision+1, now=this.now();
      const alerts=this.db.prepare('SELECT o.* FROM personal_reminder_outbox o JOIN personal_followups f ON f.id=o.followup_id WHERE f.commitment_id=?').all(id);
      for(const alert of alerts){this.db.prepare('INSERT INTO personal_reminder_archive VALUES(?,?,?)').run(alert.event_id,JSON.stringify(alert),now);this.db.prepare('DELETE FROM personal_reminder_outbox WHERE event_id=?').run(alert.event_id);}
      this.db.prepare('UPDATE personal_commitments SET due_at=?,revision=? WHERE id=?').run(dueAt,revision,id);
      const followup=this.db.prepare('SELECT state FROM personal_followups WHERE commitment_id=?').get(id);
      const receipt={commitmentId:id,previousDueAt:row.due_at,dueAt,revision,remindersEnabled:!followup||followup.state==='pending',completionVerified:false,executionAuthority:false};
      this.db.prepare('INSERT INTO personal_deadline_changes VALUES(?,?,?,?,?)').run(changeId,id,request,JSON.stringify(receipt),now);
      this.db.exec('COMMIT');return {...receipt,repeated:false};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  resolveCommitment(id, state) {
    text(id,'id',100); if (!['done','cancelled'].includes(state)) fail('commitment state');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare("UPDATE personal_commitments SET state=? WHERE id=? AND state='open'").run(state,id).changes) fail('commitment not open');
      this.db.prepare("UPDATE personal_followups SET state='dismissed', resolution=? WHERE commitment_id=? AND state='pending'").run(`commitment-${state}`,id);
      this.db.prepare(`UPDATE personal_reminder_outbox SET acked=1 WHERE followup_id IN
        (SELECT id FROM personal_followups WHERE commitment_id=?)`).run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id, state };
  }
  tick({ horizonHours = 24 } = {}) {
    if (!Number.isInteger(horizonHours) || horizonHours < 0 || horizonHours > 24*30) fail('horizonHours');
    const now = this.now(), until = new Date(Date.parse(now)+horizonHours*3600000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Commitments and one reminder event are reserved in one transaction. The
      // stable IDs let downstream event consumers deduplicate crash retries.
      const suppressedIds=new Set();
      const oldAlerts=this.db.prepare('SELECT o.*,f.commitment_id FROM personal_reminder_outbox o JOIN personal_followups f ON f.id=o.followup_id').all();
      for(const alert of oldAlerts){
        const source=this.commitmentSourceDependency(alert.commitment_id);if(source.current)continue;
        this.db.prepare('INSERT OR IGNORE INTO personal_reminder_archive VALUES(?,?,?)').run(alert.event_id,JSON.stringify({...alert,suppressionReason:`source-${source.status}`}),now);
        this.db.prepare('DELETE FROM personal_reminder_outbox WHERE event_id=?').run(alert.event_id);suppressedIds.add(alert.commitment_id);
      }
      const createdRows = this.db.prepare(`INSERT OR IGNORE INTO personal_followups(id,commitment_id,state,created_at)
        SELECT 'followup:'||id,id,'pending',? FROM personal_commitments WHERE state='open' AND due_at<=?
        RETURNING id,commitment_id`).all(now,until);
      const addAlert = this.db.prepare(`INSERT OR IGNORE INTO personal_reminder_outbox(event_id,followup_id,body,created_at)
        SELECT ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM personal_followups WHERE id=?)`);
      const eligibleRows=this.db.prepare(`SELECT f.id,f.commitment_id FROM personal_followups f JOIN personal_commitments c ON c.id=f.commitment_id WHERE f.state='pending' AND c.state='open' AND c.due_at<=? AND NOT EXISTS(SELECT 1 FROM personal_reminder_outbox o WHERE o.followup_id=f.id)`).all(until);
      let alertsCreated=0;
      for (const row of eligibleRows) {
        if(!this.commitmentSourceDependency(row.commitment_id).current){suppressedIds.add(row.commitment_id);continue;}
        const commitment = this.db.prepare('SELECT due_at,revision FROM personal_commitments WHERE id=?').get(row.commitment_id);
        const eventId = `personal-reminder:${row.id}${commitment.revision>1 ? `:revision:${commitment.revision}` : ''}`;
        const body = JSON.stringify({ eventId, kind: 'commitment-due-soon', followUpId: row.id,
          commitmentId: row.commitment_id, dueAt: commitment.due_at, commitmentRevision:commitment.revision });
        addAlert.run(eventId, row.id, body, now, row.id);
        alertsCreated++;
      }
      const pendingReminders = this.db.prepare('SELECT event_id AS eventId, followup_id AS followUpId, body, created_at AS createdAt FROM personal_reminder_outbox WHERE acked=0 ORDER BY created_at,event_id').all()
        .map(item => ({ ...item, body: JSON.parse(item.body) }));
      this.db.exec('COMMIT');
      return { evaluatedAt:now, until, created:alertsCreated, sourceSuppressed:suppressedIds.size, pendingReminders, ...this.summary() };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claimPendingReminders({ ownerId, leaseMs = 30_000, limit = 50 } = {}) {
    ownerId = text(ownerId, 'ownerId', 100);
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) fail('reminder lease');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('reminder limit');
    const now = this.now(), leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`UPDATE personal_reminder_outbox SET claimed_by=?, lease_until=?, attempts=attempts+1
        WHERE event_id IN (SELECT event_id FROM personal_reminder_outbox WHERE acked=0 AND
          (claimed_by IS NULL OR lease_until<=?) ORDER BY created_at,event_id LIMIT ?)
        RETURNING event_id AS eventId, followup_id AS followUpId, body, created_at AS createdAt, attempts`).all(ownerId, leaseUntil, now, limit);
      this.db.exec('COMMIT');
      return rows.map(item => ({ ...item, body: JSON.parse(item.body) }));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reminderClaimCurrent(eventId, ownerId, claimAttempt) {
    if(!Number.isSafeInteger(claimAttempt)||claimAttempt<1)fail('reminder claim attempt');
    const row=this.db.prepare(`SELECT c.id FROM personal_reminder_outbox o
      JOIN personal_followups f ON f.id=o.followup_id
      JOIN personal_commitments c ON c.id=f.commitment_id
      WHERE o.event_id=? AND o.claimed_by=? AND o.acked=0 AND f.state='pending' AND c.state='open' AND o.lease_until>? AND o.attempts=?`).get(eventId, ownerId, this.now(), claimAttempt);
    return Boolean(row&&this.commitmentSourceDependency(row.id).current);
  }
  acknowledgeReminder(eventId, ownerId, claimAttempt) {
    if(!Number.isSafeInteger(claimAttempt)||claimAttempt<1)fail('reminder claim attempt');
    text(eventId, 'eventId', 300);
    ownerId = text(ownerId, 'ownerId', 100);
    this.db.exec('BEGIN IMMEDIATE');
    try{
    if(!this.reminderClaimCurrent(eventId,ownerId,claimAttempt)){this.db.exec('COMMIT');return {eventId,acknowledged:false};}
    const result = this.db.prepare(`UPDATE personal_reminder_outbox SET acked=1,claimed_by=NULL,lease_until=NULL
      WHERE event_id=? AND acked=0 AND claimed_by=? AND lease_until>? AND attempts=? AND EXISTS (
        SELECT 1 FROM personal_followups f JOIN personal_commitments c ON c.id=f.commitment_id
        WHERE f.id=personal_reminder_outbox.followup_id AND f.state='pending' AND c.state='open')`).run(eventId, ownerId, this.now(), claimAttempt);
    this.db.exec('COMMIT');return { eventId, acknowledged: Number(result.changes) === 1 };
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  releaseReminder(eventId, ownerId, claimAttempt) {
    if(!Number.isSafeInteger(claimAttempt)||claimAttempt<1)fail('reminder claim attempt');
    text(eventId, 'eventId', 300); ownerId = text(ownerId, 'ownerId', 100);
    const result = this.db.prepare(`UPDATE personal_reminder_outbox SET claimed_by=NULL,lease_until=NULL
      WHERE event_id=? AND acked=0 AND claimed_by=? AND attempts=?`).run(eventId, ownerId, claimAttempt);
    return { eventId, released: Number(result.changes) === 1 };
  }
  observeMissionBlockers(missions = [], { completeSnapshot = false } = {}) {
    if (!Array.isArray(missions) || missions.length > 10_000) fail('mission states');
    const now = this.now(), blockedStatuses = new Set(['BLOCKED','PAUSED','WAITING_APPROVAL','FAILED']);
    const updates = [];
    for (const mission of missions) {
      if (!mission || typeof mission.missionId !== 'string' || !mission.missionId.trim() || mission.missionId.length > 200
        || typeof mission.status !== 'string') fail('mission state item');
      const status = mission.status;
      const pendingGateCount = Array.isArray(mission.gates) ? mission.gates.filter(gate => gate?.status === 'pending').length : 0;
      const rawReason = typeof mission.stopReason === 'string' ? mission.stopReason.toLowerCase() : '';
      const blockerCode = /^[a-z][a-z0-9-]{0,79}$/u.test(rawReason) ? rawReason : (blockedStatuses.has(status) ? 'requires-review' : null);
      const blocked = blockedStatuses.has(status);
      const fingerprint = JSON.stringify({ status, blocked, blockerCode, pendingGateCount });
      updates.push({ missionId: mission.missionId, status, blocked, blockerCode, pendingGateCount, fingerprint });
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let created = 0, changed = 0;
      const find = this.db.prepare('SELECT fingerprint,sequence,status FROM personal_mission_proactive_state WHERE mission_id=?');
      const save = this.db.prepare(`INSERT INTO personal_mission_proactive_state(mission_id,fingerprint,status,sequence,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET fingerprint=excluded.fingerprint,status=excluded.status,sequence=excluded.sequence,updated_at=excluded.updated_at`);
      const supersede = this.db.prepare('UPDATE personal_mission_proactive_outbox SET acked=1,claimed_by=NULL,lease_until=NULL WHERE mission_id=? AND acked=0');
      const add = this.db.prepare('INSERT INTO personal_mission_proactive_outbox(event_id,mission_id,sequence,body,created_at) VALUES(?,?,?,?,?)');
      if (completeSnapshot) {
        const currentIds = new Set(updates.map(state => state.missionId));
        for (const row of this.db.prepare('SELECT mission_id FROM personal_mission_proactive_state').all()) {
          if (!currentIds.has(row.mission_id)) updates.push({ missionId: row.mission_id, status: 'UNAVAILABLE', blocked: false,
            fingerprint: JSON.stringify({ status: 'UNAVAILABLE', blocked: false, blockerCode: null, pendingGateCount: 0 }) });
        }
      }
      for (const state of updates) {
        const previous = find.get(state.missionId);
        if (previous?.fingerprint === state.fingerprint) continue;
        changed += 1;
        const sequence = (previous?.sequence ?? 0) + 1;
        if (state.blocked) {
          const kind = previous ? 'mission-blocker-changed' : 'mission-blocked';
          const eventId = `mission-blocker:${state.missionId}:${sequence}`;
          const body = JSON.stringify({ eventId, kind, missionId: state.missionId, status: state.status,
            blockerCode: state.blockerCode, pendingGateCount: state.pendingGateCount });
          supersede.run(state.missionId);
          add.run(eventId, state.missionId, sequence, body, now);
          created += 1;
        } else if (previous && blockedStatuses.has(previous.status) && state.status !== 'UNAVAILABLE'
          && this.db.prepare('SELECT 1 FROM personal_mission_proactive_outbox WHERE mission_id=? AND sequence=? AND acked=1').get(state.missionId, previous.sequence)) {
          const eventId = `mission-blocker:${state.missionId}:${sequence}`;
          const body = JSON.stringify({ eventId, kind: 'mission-blocker-cleared', missionId: state.missionId,
            status: state.status, blockerCode: null, pendingGateCount: 0 });
          supersede.run(state.missionId);
          add.run(eventId, state.missionId, sequence, body, now);
          created += 1;
        } else {
          // A resolved or missing Mission invalidates pending claims, but an
          // unpublished blocker does not warrant a separate recovery notice.
          supersede.run(state.missionId);
        }
        save.run(state.missionId, state.fingerprint, state.status, sequence, now);
      }
      this.db.exec('COMMIT');
      return { observed: updates.length, changed, created };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claimMissionProactiveEvents({ ownerId, leaseMs = 30_000, limit = 50 } = {}) {
    ownerId = text(ownerId, 'ownerId', 100);
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) fail('proactive lease');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('proactive limit');
    const now = this.now(), leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`UPDATE personal_mission_proactive_outbox SET claimed_by=?,lease_until=?,attempts=attempts+1
        WHERE event_id IN (SELECT event_id FROM personal_mission_proactive_outbox WHERE acked=0 AND
          (claimed_by IS NULL OR lease_until<=?) ORDER BY created_at,event_id LIMIT ?)
        RETURNING event_id AS eventId,mission_id AS missionId,sequence,body,created_at AS createdAt,attempts`).all(ownerId,leaseUntil,now,limit);
      this.db.exec('COMMIT');
      return rows.map(item => ({ ...item, body: JSON.parse(item.body) }));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  missionProactiveClaimCurrent(eventId, ownerId, claimAttempt) {
    if(!Number.isSafeInteger(claimAttempt)||claimAttempt<1)fail('reminder claim attempt');
    return Boolean(this.db.prepare(`SELECT 1 FROM personal_mission_proactive_outbox o JOIN personal_mission_proactive_state s
      ON s.mission_id=o.mission_id AND s.sequence=o.sequence WHERE o.event_id=? AND o.claimed_by=? AND o.acked=0 AND o.lease_until>? AND o.attempts=?`)
      .get(eventId,ownerId,this.now(),claimAttempt));
  }
  acknowledgeMissionProactiveEvent(eventId, ownerId, claimAttempt) {
    if(!Number.isSafeInteger(claimAttempt)||claimAttempt<1)fail('reminder claim attempt');
    text(eventId,'eventId',300); ownerId=text(ownerId,'ownerId',100);
    const result=this.db.prepare(`UPDATE personal_mission_proactive_outbox SET acked=1,claimed_by=NULL,lease_until=NULL
      WHERE event_id=? AND acked=0 AND claimed_by=? AND lease_until>? AND attempts=? AND EXISTS(SELECT 1 FROM personal_mission_proactive_state s
        WHERE s.mission_id=personal_mission_proactive_outbox.mission_id AND s.sequence=personal_mission_proactive_outbox.sequence)`).run(eventId,ownerId,this.now(),claimAttempt);
    return {eventId,acknowledged:Number(result.changes)===1};
  }
  releaseMissionProactiveEvent(eventId, ownerId, claimAttempt) {
    if(!Number.isSafeInteger(claimAttempt)||claimAttempt<1)fail('reminder claim attempt');
    text(eventId,'eventId',300); ownerId=text(ownerId,'ownerId',100);
    const result=this.db.prepare('UPDATE personal_mission_proactive_outbox SET claimed_by=NULL,lease_until=NULL WHERE event_id=? AND acked=0 AND claimed_by=? AND attempts=?').run(eventId,ownerId,claimAttempt);
    return {eventId,released:Number(result.changes)===1};
  }
  resolveFollowUp(id, state, resolution) {
    text(id,'id',150); if (!['done','dismissed'].includes(state)) fail('followup state');
    resolution=text(resolution,'resolution');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare("UPDATE personal_followups SET state=?,resolution=? WHERE id=? AND state='pending'").run(state,resolution,id).changes) fail('followup not pending');
      this.db.prepare('UPDATE personal_reminder_outbox SET acked=1 WHERE followup_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id,state, commitmentCompletionVerified:false };
  }
  notificationQuery(){
    const sourceTable=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_source_items'").get();
    const sourceColumns=sourceTable?this.db.prepare('PRAGMA table_info(personal_source_items)').all().map(c=>c.name):[];
    // Pure SQL predicate keeps pagination and unread counts on the same current-source population.
    const sourcePredicate=sourceColumns.includes('accepted_source_hash')
      ?`(substr(c.source_ref,1,13) != 'source-inbox:' OR EXISTS(SELECT 1 FROM personal_source_items p WHERE p.id=substr(c.source_ref,14) AND p.commitment_id=c.id AND p.withdrawn=0 AND p.accepted_source_hash=personal_source_fingerprint(p.body,p.withdrawn)))`
      :`substr(c.source_ref,1,13) != 'source-inbox:'`;
    const routineInbox=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='durable_routine_notifications'").get()
      ?" UNION ALL SELECT event_id,body,created_at FROM durable_routine_notifications WHERE state='delivered'":'';
    return `SELECT o.event_id,o.body,o.created_at FROM personal_reminder_outbox o
      JOIN personal_followups f ON f.id=o.followup_id JOIN personal_commitments c ON c.id=f.commitment_id
      WHERE o.acked=1 AND f.state='pending' AND c.state='open' AND ${sourcePredicate}
      UNION ALL SELECT o.event_id,o.body,o.created_at FROM personal_mission_proactive_outbox o
      JOIN personal_mission_proactive_state s ON s.mission_id=o.mission_id AND s.sequence=o.sequence WHERE o.acked=1${routineInbox}`;
  }
  notificationDetail(eventId){
    text(eventId,'notification event',300);
    const row=this.db.prepare(`SELECT o.event_id,c.id,c.title,c.due_at,c.source_ref,c.state,c.revision,f.id AS followup_id,f.state AS followup_state
      FROM personal_reminder_outbox o JOIN personal_followups f ON f.id=o.followup_id JOIN personal_commitments c ON c.id=f.commitment_id
      WHERE o.event_id=? AND o.acked=1 AND c.state='open' AND f.state='pending'`).get(eventId);
    if(!row||!this.commitmentSourceDependency(row.id).current)return null;
    return {eventId:row.event_id,kind:'commitment',commitmentId:row.id,title:row.title,dueAt:row.due_at,sourceRef:row.source_ref,
      revision:row.revision,state:row.state,followUpId:row.followup_id,followUpState:row.followup_state,observedAt:this.now(),completionVerified:false,executionAuthority:false};
  }
  dismissNotification(eventId){
    text(eventId,'notification event',300);
    const row=this.db.prepare(`SELECT f.id,f.state,c.id AS commitment_id FROM personal_reminder_outbox o JOIN personal_followups f ON f.id=o.followup_id
      JOIN personal_commitments c ON c.id=f.commitment_id WHERE o.event_id=? AND o.acked=1 AND c.state='open'`).get(eventId);
    if(!row||!['pending','dismissed'].includes(row.state)||!this.commitmentSourceDependency(row.commitment_id).current)return null;
    if(row.state==='pending')this.resolveFollowUp(row.id,'dismissed','User dismissed this deadline notification.');
    return {eventId,dismissed:true,repeated:row.state==='dismissed',commitmentCompletionVerified:false,executionAuthority:false};
  }
  listNotifications({limit=50,before=null}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('notification limit');
    let cursor=null;
    if(before!==null){
      if(typeof before!=='string'||before.length>1000||!/^[A-Za-z0-9_-]+$/u.test(before))fail('notification cursor');
      try{cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{fail('notification cursor');}
      object(cursor,['createdAt','eventId']);date(cursor.createdAt,'cursor date');text(cursor.eventId,'cursor event',300);
    }
    const query=this.notificationQuery();
    const rows=this.db.prepare(`SELECT n.*,s.seen_at FROM (${query}) n LEFT JOIN personal_notification_seen s ON s.event_id=n.event_id
      ${cursor?'WHERE n.created_at<? OR (n.created_at=? AND n.event_id<?)':''}
      ORDER BY n.created_at DESC,n.event_id DESC LIMIT ?`).all(...(cursor?[cursor.createdAt,cursor.createdAt,cursor.eventId]:[]),limit+1);
    const more=rows.length>limit;const items=rows.slice(0,limit).map(row=>({eventId:row.event_id,createdAt:row.created_at,...JSON.parse(row.body),seenAt:row.seen_at??null}));
    const last=items.at(-1);
    const unread=Number(this.db.prepare(`SELECT COUNT(*) AS total FROM (${query}) n LEFT JOIN personal_notification_seen s ON s.event_id=n.event_id WHERE s.event_id IS NULL`).get().total);
    return {items,unread,observedAt:this.now(),nextCursor:more?Buffer.from(JSON.stringify({createdAt:last.createdAt,eventId:last.eventId})).toString('base64url'):null,
      deliveryMeaning:'local-event-published',userReadVerified:false};
  }
  acknowledgeNotification(eventId){
    text(eventId,'notification event',300);
    const seenAt=this.now();
    const result=this.db.prepare(`INSERT INTO personal_notification_seen(event_id,seen_at)
      SELECT event_id,? FROM (${this.notificationQuery()}) WHERE event_id=? ON CONFLICT(event_id) DO NOTHING`).run(seenAt,eventId);
    const receipt=this.db.prepare('SELECT seen_at FROM personal_notification_seen WHERE event_id=?').get(eventId);
    return {eventId,recorded:Number(result.changes)===1,seenAt:receipt?.seen_at??null,userReadVerified:false};
  }
  createMandate(input) {
    object(input,['action','target','validFrom','expiresAt','currency','maxAmountMinor','scope']);
    const body={ action:text(input.action,'action',100), target:text(input.target,'target',300), validFrom:date(input.validFrom,'validFrom'), expiresAt:date(input.expiresAt,'expiresAt'), currency:text(input.currency,'currency',3), maxAmountMinor:money(input.maxAmountMinor) };
    if (!/^[A-Z]{3}$/u.test(body.currency) || body.validFrom>=body.expiresAt) fail('mandate interval or currency');
    if (Object.hasOwn(input,'scope')) { body.scope=normalizeMandateScope(input.scope); body.revision=1; }
    const id=randomUUID(); this.db.prepare('INSERT INTO personal_mandates(id,body) VALUES(?,?)').run(id,JSON.stringify(body));
    return { id,...body, executionAuthority:false };
  }
  revokeMandate(id) {
    if (!this.db.prepare('UPDATE personal_mandates SET revoked=1 WHERE id=?').run(text(id,'id',100)).changes) fail('unknown mandate');
    return { id,revoked:true };
  }
  evaluateMandate(id, input) {
    object(input,['action','target','currency','amountMinor','accountRef','dataRefs','mandateRevision']);
    text(input.action,'action',100);text(input.target,'target',300);text(input.currency,'currency',3);money(input.amountMinor);
    const row=this.db.prepare('SELECT * FROM personal_mandates WHERE id=?').get(text(id,'id',100));
    const reasons=[]; const now=this.now();
    if (!row) reasons.push('unknown-mandate');
    else {
      const m=JSON.parse(row.body);
      if(row.revoked)reasons.push('revoked');
      if(now<m.validFrom || now>=m.expiresAt)reasons.push('outside-validity');
      for(const key of ['action','target','currency'])if(m[key]!==input[key])reasons.push(`${key}-mismatch`);
      if(input.amountMinor>m.maxAmountMinor)reasons.push('amount-exceeded');
      reasons.push(...mandateScopeReasons(m,input));
    }
    return { matches:reasons.length===0, reasons, executionAuthority:false, budgetReserved:false, requiresExistingPolicyEvaluation:true };
  }
  summary() {
    return {
      goals:this.db.prepare('SELECT * FROM personal_goals ORDER BY created_at,id').all(),
      commitments:this.db.prepare('SELECT * FROM personal_commitments ORDER BY due_at,id').all(),
      followUps:this.db.prepare(`SELECT f.*,c.title,c.due_at FROM personal_followups f JOIN personal_commitments c ON c.id=f.commitment_id ORDER BY c.due_at,f.id`).all(),
      schedulerInstalled:false, externalActionsExecuted:0
    };
  }
}
