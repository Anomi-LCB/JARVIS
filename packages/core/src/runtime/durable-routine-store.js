import { initializeRoutineNotifications, journalRoutineNotifications } from './routine-notification-outbox.js';
import { randomUUID } from 'node:crypto';
import { isWeeklyOccurrence, nextWeeklyOccurrence, validateWeeklyRecurrence } from './weekly-routine-time.js';

const VERSION = 'a-durable-routine-store-v1';
const STATES = new Set(['scheduled', 'dispatching', 'completed', 'missed', 'blocked', 'failed']);
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };

function validateRoutine(routine) {
  if (!routine || typeof routine !== 'object' || Array.isArray(routine)) fail('A_ROUTINE_INVALID');
  if (typeof routine.routineId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/u.test(routine.routineId)) fail('A_ROUTINE_ID_INVALID');
  if (!Number.isFinite(Date.parse(routine.scheduledAt)) || new Date(routine.scheduledAt).toISOString() !== routine.scheduledAt) fail('A_ROUTINE_TIME_INVALID');
  if (typeof routine.timeZone !== 'string' || routine.timeZone.length > 100) fail('A_ROUTINE_TIMEZONE_INVALID');
  try { new Intl.DateTimeFormat('en', { timeZone: routine.timeZone }); } catch { fail('A_ROUTINE_TIMEZONE_INVALID'); }
  if (routine.recurrence) {
    validateWeeklyRecurrence(routine.recurrence);
    if (!isWeeklyOccurrence(routine.scheduledAt, routine.recurrence, routine.timeZone)) fail('A_ROUTINE_RECURRENCE_SCHEDULE_MISMATCH');
  }
  if (!routine.missionRequest || typeof routine.missionRequest.objective !== 'string' || !routine.missionRequest.objective.trim() || routine.missionRequest.objective.length > 32768) fail('A_ROUTINE_MISSION_INVALID');
  if (!['scheduled', 'dispatching', 'completed', 'missed', 'blocked', 'failed'].includes(routine.status)) fail('A_ROUTINE_STATE_INVALID');
}

/** A small in-memory adapter used by deterministic tests and non-durable previews. */
export class MemoryDurableRoutineStore {
  constructor() { this.items = new Map(); }
  create(routine) {
    validateRoutine(routine);
    const prior = this.items.get(routine.routineId);
    if (prior) {
      if (JSON.stringify(prior.missionRequest) !== JSON.stringify(routine.missionRequest) || prior.scheduledAt !== routine.scheduledAt || prior.timeZone !== routine.timeZone || JSON.stringify(prior.recurrence ?? null) !== JSON.stringify(routine.recurrence ?? null)) fail('A_ROUTINE_IDEMPOTENCY_CONFLICT');
      return { created: false, routine: structuredClone(prior) };
    }
    this.items.set(routine.routineId, structuredClone(routine));
    return { created: true, routine: structuredClone(routine) };
  }
  get(routineId) { const value = this.items.get(routineId); return value ? structuredClone(value) : null; }
  list() { return [...this.items.values()].map(value => structuredClone(value)); }
  due(nowIso) { return this.list().filter(item => item.status === 'scheduled' && item.scheduledAt <= nowIso).sort((a,b) => a.scheduledAt.localeCompare(b.scheduledAt)); }
  claim(routineId, { nowIso, ownerId }) {
    const item = this.items.get(routineId);
    if (!item || item.status !== 'scheduled' || item.scheduledAt > nowIso) return null;
    const updated = { ...item, status: 'dispatching', ownerId, attempts: (item.attempts ?? 0) + 1, updatedAt: nowIso };
    this.items.set(routineId, updated); return structuredClone(updated);
  }
  cancelScheduled(routineId, nowIso) {
    const item = this.items.get(routineId);
    if (!item) return null;
    if (item.status !== 'scheduled') return { cancelled: false, routine: structuredClone(item) };
    const updated = { ...item, status: 'blocked', cancelledAt: nowIso, updatedAt: nowIso,
      notification: { kind: 'routine-cancelled-by-user', reason: 'cancelled-before-dispatch' } };
    this.items.set(routineId, updated);
    return { cancelled: true, routine: structuredClone(updated) };
  }
  transition(routineId, status, patch = {}) {
    if (!STATES.has(status)) fail('A_ROUTINE_STATE_INVALID');
    const item = this.items.get(routineId); if (!item) return null;
    const updated = { ...item, ...structuredClone(patch), status }; this.items.set(routineId, updated); return structuredClone(updated);
  }
  reviseTimezone(routineId, timeZone, nowIso) {
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { return { updated: false, code: 'A_ROUTINE_TIMEZONE_INVALID', routine: this.items.get(routineId) ? structuredClone(this.items.get(routineId)) : null }; }
    const item = this.items.get(routineId);
    if (!item) return { updated: false, code: 'A_ROUTINE_NOT_FOUND', routine: null };
    if (item.status !== 'scheduled' || !item.recurrence) return { updated: false, code: 'A_ROUTINE_NOT_REVISABLE', routine: structuredClone(item) };
    const updated = { ...item, timeZone, scheduledAt: nextWeeklyOccurrence(nowIso, item.recurrence, timeZone), recurrenceRevision: (item.recurrenceRevision ?? 1) + 1,
      occurrenceIndex: 0, updatedAt: nowIso, timezoneRevisedAt: nowIso };
    validateRoutine(updated); this.items.set(routineId, updated); return { updated: true, routine: structuredClone(updated) };
  }
  transitionDispatch(routineId, { expectedOwnerId, expectedAttempts, status, patch = {} }) {
    if (!STATES.has(status)) fail('A_ROUTINE_STATE_INVALID');
    const item = this.items.get(routineId);
    if (!item || item.status !== 'dispatching' || item.ownerId !== expectedOwnerId || item.attempts !== expectedAttempts) return null;
    return this.transition(routineId, status, patch);
  }
  completeOccurrence(routineId, { expectedOwnerId, expectedAttempts, nowIso, missionId, missionStatus, notification }) {
    const item = this.items.get(routineId);
    if (!item || item.status !== 'dispatching' || item.ownerId !== expectedOwnerId || (expectedAttempts !== undefined && item.attempts !== expectedAttempts)) return null;
    if (!item.recurrence) return this.transition(routineId, missionStatus === 'COMPLETED' ? 'completed' : ['FAILED', 'CANCELLED'].includes(missionStatus) ? 'failed' : 'blocked', { missionId, missionStatus, notification });
    const next = nextWeeklyOccurrence(nowIso, item.recurrence, item.timeZone);
    const updated = { ...item, status: 'scheduled', scheduledAt: next, occurrenceIndex: (item.occurrenceIndex ?? 0) + 1,
      lastOccurrence: { scheduledAt: item.scheduledAt, missionId, missionStatus, finishedAt: nowIso, notification },
      ownerId: null, missionId: null, missionStatus: null, notification, updatedAt: nowIso };
    this.items.set(routineId, updated); return structuredClone(updated);
  }
  recoverDispatching(ownerId) { return this.list().filter(item => item.status === 'dispatching' && item.ownerId !== ownerId); }
  claimRecovery(routineId, { expectedOwnerId, ownerId, nowIso }) {
    const item = this.items.get(routineId);
    if (!item || item.status !== 'dispatching' || item.ownerId !== expectedOwnerId) return null;
    const updated = { ...item, ownerId, attempts: (item.attempts ?? 0) + 1, updatedAt: nowIso, recoveredDispatch: true };
    this.items.set(routineId, updated); return structuredClone(updated);
  }
  markOverdueMissed(cutoffIso, nowIso) {
    const missed = [];
    for (const item of this.items.values()) if (item.status === 'scheduled' && item.scheduledAt < cutoffIso) {
      const updated = item.recurrence
        ? { ...item, status: 'scheduled', scheduledAt: nextWeeklyOccurrence(nowIso, item.recurrence, item.timeZone), occurrenceIndex: (item.occurrenceIndex ?? 0) + 1,
          updatedAt: nowIso, missedOccurrenceAt: item.scheduledAt, missedAt: nowIso, missedReason: 'service-was-offline-past-grace-window' }
        : { ...item, status: 'missed', updatedAt: nowIso, missedAt: nowIso, missedReason: 'service-was-offline-past-grace-window' };
      this.items.set(item.routineId, updated); missed.push(structuredClone(updated));
    }
    return missed;
  }
  metadata() { return { version: VERSION, durable: false }; }
}

/** Shares the Core PersonalOperations SQLite connection so routine state survives service restarts. */
export class SqliteDurableRoutineStore {
  constructor({ operationsStore, clock = operationsStore?.clock } = {}) {
    if (!operationsStore?.db || typeof clock !== 'function') fail('A_DURABLE_ROUTINE_DB_REQUIRED');
    this.db = operationsStore.db; this.clock = clock;
    initializeRoutineNotifications(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS durable_routines (
      routine_id TEXT PRIMARY KEY, scheduled_at TEXT NOT NULL, timezone TEXT NOT NULL,
      mission_request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('scheduled','dispatching','completed','missed','blocked','failed')),
      body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner_id TEXT
    ); CREATE INDEX IF NOT EXISTS durable_routines_due ON durable_routines(state,scheduled_at);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(durable_routines)').all().map(row => row.name));
    if (!columns.has('owner_id')) this.db.exec('ALTER TABLE durable_routines ADD COLUMN owner_id TEXT');
  }
  create(input) {
    validateRoutine(input);
    const now = this.clock().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(input.routineId);
      if (prior) {
        if (JSON.stringify(prior.missionRequest) !== JSON.stringify(input.missionRequest) || prior.scheduledAt !== input.scheduledAt || prior.timeZone !== input.timeZone || JSON.stringify(prior.recurrence ?? null) !== JSON.stringify(input.recurrence ?? null)) fail('A_ROUTINE_IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT'); return { created: false, routine: prior };
      }
      const body = JSON.stringify({ ...structuredClone(input), createdAt: input.createdAt ?? now, updatedAt: now });
      this.db.prepare('INSERT INTO durable_routines(routine_id,scheduled_at,timezone,mission_request,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(input.routineId, input.scheduledAt, input.timeZone, JSON.stringify(input.missionRequest), input.status, body, now, now);
      const routine = this.get(input.routineId);
      journalRoutineNotifications(this.db,routine,now);
      this.db.exec('COMMIT'); return { created: true, routine };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(routineId) { const row = this.db.prepare('SELECT body FROM durable_routines WHERE routine_id=?').get(routineId); return row ? JSON.parse(row.body) : null; }
  list() { return this.db.prepare('SELECT body FROM durable_routines ORDER BY scheduled_at,routine_id').all().map(row => JSON.parse(row.body)); }
  due(nowIso) { return this.db.prepare("SELECT body FROM durable_routines WHERE state='scheduled' AND scheduled_at<=? ORDER BY scheduled_at,routine_id").all(nowIso).map(row => JSON.parse(row.body)); }
  claim(routineId, { nowIso, ownerId }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT body FROM durable_routines WHERE routine_id=? AND state='scheduled' AND scheduled_at<=?").get(routineId, nowIso);
      if (!row) { this.db.exec('COMMIT'); return null; }
      const item = JSON.parse(row.body);
      const claimed = { ...item, status: 'dispatching', ownerId, attempts: (item.attempts ?? 0) + 1, updatedAt: nowIso };
      const changed = this.db.prepare("UPDATE durable_routines SET state='dispatching',body=?,owner_id=?,updated_at=? WHERE routine_id=? AND state='scheduled'").run(JSON.stringify(claimed), ownerId, nowIso, routineId).changes;
      this.db.exec('COMMIT'); return changed === 1 ? claimed : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cancelScheduled(routineId, nowIso) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT body,state FROM durable_routines WHERE routine_id=?').get(routineId);
      if (!row) { this.db.exec('COMMIT'); return null; }
      const routine = JSON.parse(row.body);
      if (row.state !== 'scheduled') { this.db.exec('COMMIT'); return { cancelled: false, routine }; }
      const updated = { ...routine, status: 'blocked', cancelledAt: nowIso, updatedAt: nowIso,
        notification: { kind: 'routine-cancelled-by-user', reason: 'cancelled-before-dispatch' } };
      const changed = this.db.prepare("UPDATE durable_routines SET state='blocked',body=?,owner_id=NULL,updated_at=? WHERE routine_id=? AND state='scheduled'")
        .run(JSON.stringify(updated), nowIso, routineId).changes;
      if(changed === 1)journalRoutineNotifications(this.db,updated,nowIso);
      this.db.exec('COMMIT');
      return changed === 1 ? { cancelled: true, routine: updated } : { cancelled: false, routine: this.get(routineId) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reviseTimezone(routineId, timeZone, nowIso) {
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { return { updated: false, code: 'A_ROUTINE_TIMEZONE_INVALID', routine: this.get(routineId) }; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT body,state FROM durable_routines WHERE routine_id=?').get(routineId);
      if (!row) { this.db.exec('COMMIT'); return { updated: false, code: 'A_ROUTINE_NOT_FOUND', routine: null }; }
      const item = JSON.parse(row.body);
      if (row.state !== 'scheduled' || !item.recurrence) { this.db.exec('COMMIT'); return { updated: false, code: 'A_ROUTINE_NOT_REVISABLE', routine: item }; }
      const updated = { ...item, timeZone, scheduledAt: nextWeeklyOccurrence(nowIso, item.recurrence, timeZone), recurrenceRevision: (item.recurrenceRevision ?? 1) + 1,
        occurrenceIndex: 0, updatedAt: nowIso, timezoneRevisedAt: nowIso };
      const changed = this.db.prepare("UPDATE durable_routines SET scheduled_at=?,timezone=?,body=?,updated_at=? WHERE routine_id=? AND state='scheduled'")
        .run(updated.scheduledAt, timeZone, JSON.stringify(updated), nowIso, routineId).changes;
      this.db.exec('COMMIT'); return changed === 1 ? { updated: true, routine: updated } : { updated: false, code: 'A_ROUTINE_NOT_REVISABLE', routine: this.get(routineId) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  transitionDispatch(routineId, { expectedOwnerId, expectedAttempts, status, patch = {} }) {
    if (!STATES.has(status)) fail('A_ROUTINE_STATE_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT body,owner_id FROM durable_routines WHERE routine_id=? AND state='dispatching'").get(routineId);
      if (!row || row.owner_id !== expectedOwnerId || JSON.parse(row.body).attempts !== expectedAttempts) { this.db.exec('COMMIT'); return null; }
      const prior = JSON.parse(row.body);
      const updated = { ...prior, ...structuredClone(patch), status, updatedAt: this.clock().toISOString() };
      this.db.prepare("UPDATE durable_routines SET state=?,body=?,owner_id=?,updated_at=? WHERE routine_id=? AND state='dispatching' AND owner_id=?")
        .run(status, JSON.stringify(updated), updated.ownerId ?? null, updated.updatedAt, routineId, expectedOwnerId);
      journalRoutineNotifications(this.db,updated,updated.updatedAt);
      this.db.exec('COMMIT'); return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  completeOccurrence(routineId, { expectedOwnerId, expectedAttempts, nowIso, missionId, missionStatus, notification }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT body,owner_id FROM durable_routines WHERE routine_id=? AND state='dispatching'").get(routineId);
      if (!row || row.owner_id !== expectedOwnerId) { this.db.exec('COMMIT'); return null; }
      const item = JSON.parse(row.body);
      if (expectedAttempts !== undefined && item.attempts !== expectedAttempts) { this.db.exec('COMMIT'); return null; }
      const terminalState = missionStatus === 'COMPLETED' ? 'completed' : ['FAILED', 'CANCELLED'].includes(missionStatus) ? 'failed' : 'blocked';
      const updated = item.recurrence
        ? { ...item, status: 'scheduled', scheduledAt: nextWeeklyOccurrence(nowIso, item.recurrence, item.timeZone), occurrenceIndex: (item.occurrenceIndex ?? 0) + 1,
          lastOccurrence: { scheduledAt: item.scheduledAt, missionId, missionStatus, finishedAt: nowIso, notification }, ownerId: null, missionId: null, missionStatus: null, notification, updatedAt: nowIso }
        : { ...item, status: terminalState, missionId, missionStatus, notification, updatedAt: nowIso };
      const changed = this.db.prepare("UPDATE durable_routines SET state=?,scheduled_at=?,body=?,owner_id=?,updated_at=? WHERE routine_id=? AND state='dispatching' AND owner_id=?")
        .run(updated.status, updated.scheduledAt, JSON.stringify(updated), updated.ownerId ?? null, nowIso, routineId, expectedOwnerId).changes;
      if(changed === 1)journalRoutineNotifications(this.db,updated,nowIso);
      this.db.exec('COMMIT'); return changed === 1 ? updated : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  transition(routineId, status, patch = {}) {
    if (!STATES.has(status)) fail('A_ROUTINE_STATE_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(routineId); if (!prior) { this.db.exec('COMMIT'); return null; }
      const updated = { ...prior, ...structuredClone(patch), status, updatedAt: this.clock().toISOString() };
      this.db.prepare('UPDATE durable_routines SET state=?,body=?,owner_id=?,updated_at=? WHERE routine_id=?').run(status, JSON.stringify(updated), updated.ownerId ?? null, updated.updatedAt, routineId);
      journalRoutineNotifications(this.db,updated,updated.updatedAt);
      this.db.exec('COMMIT'); return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recoverDispatching(ownerId) { return this.list().filter(item => item.status === 'dispatching' && item.ownerId !== ownerId); }
  claimRecovery(routineId, { expectedOwnerId, ownerId, nowIso }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT body,owner_id FROM durable_routines WHERE routine_id=? AND state='dispatching'").get(routineId);
      if (!row || row.owner_id !== expectedOwnerId) { this.db.exec('COMMIT'); return null; }
      const item = JSON.parse(row.body);
      const updated = { ...item, ownerId, attempts: (item.attempts ?? 0) + 1, updatedAt: nowIso, recoveredDispatch: true };
      const changed = this.db.prepare("UPDATE durable_routines SET body=?,owner_id=?,updated_at=? WHERE routine_id=? AND state='dispatching' AND owner_id IS ?")
        .run(JSON.stringify(updated), ownerId, nowIso, routineId, expectedOwnerId).changes;
      this.db.exec('COMMIT'); return changed === 1 ? updated : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  markOverdueMissed(cutoffIso, nowIso) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare("SELECT body FROM durable_routines WHERE state='scheduled' AND scheduled_at<? ORDER BY scheduled_at").all(cutoffIso);
      const missed = rows.map(({ body }) => {
        const item = JSON.parse(body);
        return item.recurrence
          ? { ...item, status: 'scheduled', scheduledAt: nextWeeklyOccurrence(nowIso, item.recurrence, item.timeZone), occurrenceIndex: (item.occurrenceIndex ?? 0) + 1,
            updatedAt: nowIso, missedOccurrenceAt: item.scheduledAt, missedAt: nowIso, missedReason: 'service-was-offline-past-grace-window' }
          : { ...item, status: 'missed', updatedAt: nowIso, missedAt: nowIso, missedReason: 'service-was-offline-past-grace-window' };
      });
      const update = this.db.prepare("UPDATE durable_routines SET state=?,scheduled_at=?,body=?,updated_at=? WHERE routine_id=? AND state='scheduled'");
      for (const item of missed) {
        update.run(item.status, item.scheduledAt, JSON.stringify(item), nowIso, item.routineId);
        journalRoutineNotifications(this.db,item,nowIso);
      }
      this.db.exec('COMMIT'); return missed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  metadata() { return { version: VERSION, durable: true, sharedCoreOperationsDatabase: true }; }
}

export function createRoutineRecord({ routineId = `routine-${randomUUID()}`, scheduledAt, timeZone = 'Asia/Seoul', timeExpression = null, missionRequest, recurrence = null }) {
  const record = { routineVersion: VERSION, routineId, scheduledAt: new Date(scheduledAt).toISOString(), timeZone,
    ...(typeof timeExpression === 'string' ? { timeExpression: timeExpression.slice(0, 300) } : {}),
    ...(recurrence ? { recurrence: validateWeeklyRecurrence(recurrence), recurrenceRevision: 1, occurrenceIndex: 0 } : {}),
    missionRequest: structuredClone(missionRequest), status: 'scheduled', attempts: 0, notification: null };
  validateRoutine(record); return record;
}
