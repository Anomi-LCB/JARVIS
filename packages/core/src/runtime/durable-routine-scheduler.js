import { randomUUID } from 'node:crypto';
import { createRoutineRecord } from './durable-routine-store.js';
import { parseKoreanOneTimeSchedule } from './korean-time-expression.js';
import { parseKoreanWeeklyRoutineExpression } from './korean-weekly-routine-expression.js';
import {RoutineNotificationOutbox} from './routine-notification-outbox.js';
import {RoutineMissionTemporalGuard,routineMissionRequest} from './routine-mission-temporal-guard.js';

const DEFAULT_GRACE_MS = 5 * 60_000;

/** Runs explicitly scheduled, one-shot low-impact Mission requests through the existing MissionRuntime. */
export class DurableRoutineScheduler {
  constructor({ store, missionRuntime, clock = () => new Date(), ownerId = `routine-worker:${process.pid}:${randomUUID()}`,
    lateGraceMs = DEFAULT_GRACE_MS, onNotification = null, notificationTimeoutMs=10000 } = {}) {
    if (!store || typeof store.create !== 'function' || typeof store.completeOccurrence !== 'function' || typeof store.transitionDispatch !== 'function' || !missionRuntime?.createMission || !missionRuntime?.runMission) throw new Error('DurableRoutineScheduler requires a fenced routine store and MissionRuntime.');
    if (!Number.isSafeInteger(lateGraceMs) || lateGraceMs < 0 || lateGraceMs > 24 * 60 * 60_000) throw new Error('Invalid routine late grace window.');
    this.store = store; this.missionRuntime = missionRuntime; this.clock = clock; this.ownerId = ownerId;
    this.lateGraceMs = lateGraceMs; this.onNotification = onNotification??(()=>{}); this.running = false;
    this.notificationOutbox=store.db?new RoutineNotificationOutbox({store,onNotification,clock,ownerId,timeoutMs:notificationTimeoutMs}):null;
    this.stats = { ticks: 0, dispatched: 0, missed: 0, failures: 0, lastTickAt: null, lastError: null };
    if(missionRuntime.missions instanceof Map&&missionRuntime.activeRuns instanceof Map){
      missionRuntime.routineTemporalGuard??=new RoutineMissionTemporalGuard({clock:missionRuntime.clock??clock});
      missionRuntime.routineTemporalGuard.registerStore(store);
      this.temporalGuard=missionRuntime.routineTemporalGuard;
    }
  }
  schedule({ routineId, scheduledAt, scheduleText, timeZone = 'Asia/Seoul', missionRequest, recurrence = null } = {}) {
    let timeExpression = null;
    if ((typeof scheduledAt === 'string') === (typeof scheduleText === 'string')) throw Object.assign(new Error('Provide exactly one of scheduledAt or scheduleText.'), { code: 'A_ROUTINE_TIME_INPUT_CONFLICT' });
    if (typeof scheduleText === 'string') {
      const weekly = parseKoreanWeeklyRoutineExpression(scheduleText, { clock: this.clock, timeZone });
      if (weekly.success) {
        if (recurrence && ['frequency', 'weekday', 'hour', 'minute'].some(key => recurrence[key] !== weekly.recurrence[key])) throw Object.assign(new Error('Weekly text conflicts with the supplied recurrence.'), { code: 'A_ROUTINE_TIME_INPUT_CONFLICT' });
        recurrence = weekly.recurrence; scheduledAt = weekly.scheduledAt; timeZone = weekly.timeZone; timeExpression = weekly.expression;
      } else if (weekly.code !== 'A_ROUTINE_TIME_EXPRESSION_UNSUPPORTED') {
        throw Object.assign(new Error(weekly.reason ?? weekly.code), { code: weekly.code });
      } else {
        const parsed = parseKoreanOneTimeSchedule(scheduleText, { clock: this.clock, timeZone });
        if (!parsed.success) throw Object.assign(new Error(parsed.reason ?? parsed.code), { code: parsed.code });
        scheduledAt = parsed.scheduledAt; timeZone = parsed.timeZone; timeExpression = parsed.expression;
      }
    }
    const normalizedRequest = normalizeMissionRequest(missionRequest);
    if(normalizedRequest.executionMandateId){
      if(!this.missionRuntime.executionBudget)throw Object.assign(new Error('Mission quota service is unavailable.'),{code:'A_ROUTINE_MANDATE_UNAVAILABLE'});
      try{this.missionRuntime.executionBudget.validate(normalizedRequest.executionMandateId);}
      catch{throw Object.assign(new Error('The selected Mission quota is not currently valid.'),{code:'A_ROUTINE_MANDATE_DENIED'});}
    }
    const record = createRoutineRecord({ routineId, scheduledAt, timeZone, timeExpression, missionRequest: normalizedRequest, recurrence });
    return this.store.create(record);
  }
  get(routineId) { return this.store.get(routineId); }
  list() { return this.store.list(); }
  cancel(routineId) {
    const nowIso = this.clock().toISOString();
    const result = this.store.cancelScheduled?.(routineId, nowIso) ?? null;
    if (result?.routine?.notification?.kind === 'routine-cancelled-by-user') {
      if (result.cancelled) this.emit({ kind: 'routine-cancelled', routineId, cancelledAt: result.routine.cancelledAt });
      return { ...result, cancelled: true, alreadyCancelled: !result.cancelled };
    }
    return result;
  }
  reviseTimezone(routineId, timeZone) {
    const nowIso = this.clock().toISOString();
    if (!this.store.reviseTimezone) return { updated: false, code: 'A_ROUTINE_SCHEDULER_UNAVAILABLE', routine: this.get(routineId) };
    return this.store.reviseTimezone(routineId, timeZone, nowIso);
  }
  status() { return { version: 'a-durable-routine-scheduler-v1', storage: this.store.metadata?.() ?? { durable: false }, ownerId: this.ownerId, lateGraceMs: this.lateGraceMs, notifications:this.notificationOutbox?.status()??{durable:false}, ...this.stats }; }
  async startupReconcile() {
    await this.notificationOutbox?.flush();
    const now = this.clock(); const nowIso = now.toISOString();
    // Once the process is coming back, any not-yet-claimed occurrence whose instant passed
    // while it was unavailable is reported as missed; grace is only for an already-running daemon tick.
    const missed = this.store.markOverdueMissed(nowIso, nowIso);
    for (const routine of missed) this.notifyMissed(routine);
    // A persisted dispatch was claimed before the process stopped. The Mission idempotency key
    // makes replay safe: terminal Missions return their stored result and are never re-executed.
    const interrupted = this.store.recoverDispatching?.(this.ownerId) ?? [];
    let recoveredDispatches = 0;
    for (const routine of interrupted) {
      const claimed = this.store.claimRecovery?.(routine.routineId, { expectedOwnerId: routine.ownerId, ownerId: this.ownerId, nowIso });
      if (claimed) { await this.dispatch(claimed, { recovering: true }); recoveredDispatches += 1; }
    }
    await this.notificationOutbox?.flush();
    return { success: true, missed: missed.length, recoveredDispatches, at: nowIso };
  }
  async tick() {
    if (this.running) return { success: true, status: 'skipped', reason: 'routine-tick-already-running' };
    this.running = true; this.stats.ticks += 1; this.stats.lastTickAt = this.clock().toISOString();
    const nowIso = this.stats.lastTickAt;
    try {
      await this.notificationOutbox?.flush();
      const now = new Date(nowIso);
      for (const routine of this.store.markOverdueMissed(new Date(now.getTime() - this.lateGraceMs).toISOString(), nowIso)) this.notifyMissed(routine);
      const processed = [];
      for (const due of this.store.due(nowIso)) {
        const claimed = this.store.claim(due.routineId, { nowIso, ownerId: this.ownerId });
        if (claimed) processed.push(await this.dispatch(claimed));
      }
      await this.notificationOutbox?.flush();
      return { success: true, processed };
    } catch (error) {
      this.stats.failures += 1; this.stats.lastError = { code: error.code ?? 'A_ROUTINE_TICK_FAILED', message: error.message, at: nowIso };
      return { success: false, error: this.stats.lastError };
    } finally { this.running = false; }
  }
  async dispatch(routine, { recovering = false } = {}) {
    try {
      // Keep the immutable creation request identical for initial and recovery runs.
      const created = this.missionRuntime.createMission(routineMissionRequest(routine));
      if (!created?.missionId) {
        const code = created?.error?.code ?? created?.code ?? 'A_ROUTINE_MISSION_CREATE_FAILED';
        const state = code === 'A_MISSION_IDEMPOTENCY_CONFLICT' ? 'failed' : 'blocked';
        const updated = this.store.transitionDispatch(routine.routineId, { expectedOwnerId: routine.ownerId, expectedAttempts: routine.attempts, status: state,
          patch: { notification: { kind: 'routine-dispatch-not-created', code } } });
        if (!updated) return null;
        this.emit({ kind: state === 'blocked' ? 'routine-blocked' : 'routine-failed', routineId: routine.routineId, reason: updated.notification });
        return updated;
      }
      const run=()=>this.missionRuntime.runMission(created.missionId);
      const result=this.temporalGuard?await this.temporalGuard.runClaimed({store:this.store,routine,missionId:created.missionId,
        lateGraceMs:this.lateGraceMs},run):await run();
      const state = result?.status === 'COMPLETED' ? 'completed'
        : ['FAILED', 'CANCELLED'].includes(result?.status) ? 'failed' : 'blocked';
      const notification = { kind: state === 'completed' ? 'routine-completed' : 'routine-needs-attention', missionId: created.missionId,
        missionStatus: result?.status ?? null, stopReason: result?.stopReason ?? null };
      // A null result is a rejected stale claim, never permission for an unfenced fallback.
      const updated = this.store.completeOccurrence(routine.routineId, { expectedOwnerId: routine.ownerId, expectedAttempts: routine.attempts,
        nowIso: this.clock().toISOString(), missionId: created.missionId, missionStatus: result?.status ?? null, notification });
      if (!updated) return null;
      if (state === 'completed') this.stats.dispatched += 1;
      this.emit({ ...notification, routineId: routine.routineId });
      return updated;
    } catch (error) {
      const updated = this.store.transitionDispatch(routine.routineId, { expectedOwnerId: routine.ownerId, expectedAttempts: routine.attempts, status: 'failed',
        patch: { notification: { kind: 'routine-execution-failed', code: error.code ?? 'A_ROUTINE_EXECUTION_FAILED', message: error.message } } });
      if (!updated) return null;
      this.emit({ kind: 'routine-failed', routineId: routine.routineId, reason: updated?.notification });
      return updated;
    }
  }
  notifyMissed(routine) { this.stats.missed += 1; this.emit({ kind: 'routine-missed', routineId: routine.routineId, scheduledAt: routine.missedOccurrenceAt ?? routine.scheduledAt,
    timeZone: routine.timeZone, nextAction: '재실행 여부를 선택하거나 새 실행 시각을 예약하세요.' }); }
  emit(notification) {
    if(this.notificationOutbox)return; // Delivery follows persisted state at tick/startup boundaries.
    try { const pending=this.onNotification(notification);if(pending?.then)Promise.resolve(pending).catch(()=>{}); } catch { /* Preview callback failure cannot rewrite routine state. */ }
  }
}

function normalizeMissionRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw Object.assign(new Error('Scheduled Mission request is required.'), { code: 'A_ROUTINE_MISSION_INVALID' });
  const allowed = new Set(['objective', 'successCriteria', 'constraints', 'budgets', 'authorization', 'metadata', 'executionMandateId']);
  if (Object.keys(request).some(key => !allowed.has(key))) throw Object.assign(new Error('Scheduled Mission request contains unsupported fields.'), { code: 'A_ROUTINE_MISSION_FIELD_INVALID' });
  if(request.executionMandateId!==undefined&&(typeof request.executionMandateId!=='string'||!request.executionMandateId.trim()||request.executionMandateId.length>100||/[\u0000-\u001f]/u.test(request.executionMandateId)))throw Object.assign(new Error('Invalid Mission quota ID.'),{code:'A_ROUTINE_MANDATE_INVALID'});
  const authorization = request.authorization ?? {};
  const grants = authorization.grants ?? ['read_only'];
  // A durable schedule is not a durable grant. High-impact and trusted-session authority must be re-issued at execution time.
  if (authorization.mode === 'trusted_session' || grants.some(grant => !['read_only', 'local_reversible'].includes(grant))) {
    throw Object.assign(new Error('Scheduled routines cannot persist trusted-session or high-impact authority.'), { code: 'A_ROUTINE_AUTHORITY_NOT_PERSISTABLE' });
  }
  return { objective: request.objective, successCriteria: request.successCriteria ?? [], constraints: request.constraints ?? [],
    budgets: request.budgets ?? {}, ...(request.executionMandateId?{executionMandateId:request.executionMandateId}:{}), authorization: { ...authorization, mode: 'supervised', grants: [...new Set(['read_only', ...grants])] }, metadata: request.metadata ?? {} };
}
