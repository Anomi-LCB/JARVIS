import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { FileMissionStore } from '../packages/core/src/mission/mission-store.js';
import { DurableRoutineScheduler } from '../packages/core/src/runtime/durable-routine-scheduler.js';
import { MemoryDurableRoutineStore, SqliteDurableRoutineStore } from '../packages/core/src/runtime/durable-routine-store.js';
import { nextWeeklyOccurrence, resolveWeeklyWallTime } from '../packages/core/src/runtime/weekly-routine-time.js';
import { parseKoreanWeeklyRoutineExpression } from '../packages/core/src/runtime/korean-weekly-routine-expression.js';
import { CoreWorkerDaemon } from '../packages/core/src/runtime/core-worker-daemon.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { CoreClient } from '../packages/core/src/client/core-client.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { parseWeeklyRoutineCommand } from '../packages/core/src/runtime/korean-weekly-routine-command.js';
import { parseWeeklyRoutineTimezoneCommand } from '../src/ui/routine-control-panel.js';

function fakeMissionRuntime({ status = 'COMPLETED' } = {}) {
  const byKey = new Map(); let executions = 0;
  return {
    get executions() { return executions; },
    createMission(request) {
      const previous = byKey.get(request.idempotencyKey);
      if (previous) return previous;
      const mission = { missionId: `mission-${byKey.size + 1}`, request, status: 'CREATED' };
      byKey.set(request.idempotencyKey, mission); return mission;
    },
    async runMission(missionId) {
      const mission = [...byKey.values()].find(item => item.missionId === missionId);
      if (!mission) throw new Error('mission not found');
      if (mission.status === 'CREATED') { executions += 1; mission.status = status; }
      return { missionId, status: mission.status };
    }
  };
}

function scheduledRequest(extra = {}) {
  return { objective: '정해 둔 작업 폴더에서 공개 자료를 정리해 요약 초안을 만든다.',
    successCriteria: ['요약 초안이 생성되거나 필요한 승인 상태가 명확히 남는다.'],
    constraints: ['외부 전송과 계정 접근을 하지 않는다.'],
    authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }, ...extra };
}

test('weekly wall-clock recurrence defines DST gap and overlap behavior deterministically', () => {
  assert.equal(nextWeeklyOccurrence('2026-03-02T00:00:00.000Z', { frequency: 'weekly', weekday: 7, hour: 2, minute: 30 }, 'America/New_York'), '2026-03-15T06:30:00.000Z');
  assert.equal(resolveWeeklyWallTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(nextWeeklyOccurrence('2026-09-29T00:00:00.000Z', { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, 'Asia/Seoul'), '2026-09-30T00:00:00.000Z');
});

test('weekly routine persistence rejects an initial occurrence that contradicts the local recurrence', () => {
  const scheduler = new DurableRoutineScheduler({ store: new MemoryDurableRoutineStore(), missionRuntime: fakeMissionRuntime() });
  assert.throws(() => scheduler.schedule({ routineId: 'weekly-wrong-first-time',
    scheduledAt: '2026-10-01T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, missionRequest: scheduledRequest() }),
  { code: 'A_ROUTINE_RECURRENCE_SCHEDULE_MISMATCH' });
  assert.equal(scheduler.schedule({ routineId: 'weekly-correct-first-time',
    scheduledAt: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, missionRequest: scheduledRequest() }).created, true);
});

test('Korean weekly expressions resolve explicit weekday and wall-clock without guessing', () => {
  const clock = () => new Date('2026-09-29T00:00:00.000Z');
  const parsed = parseKoreanWeeklyRoutineExpression('매주 수요일 오전 9시', { clock, timeZone: 'Asia/Seoul' });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.recurrence, { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 });
  assert.equal(parsed.scheduledAt, '2026-09-30T00:00:00.000Z');
  assert.equal(parseKoreanWeeklyRoutineExpression('매주 월요일 오후 13시', { clock }).code, 'A_ROUTINE_TIME_EXPRESSION_INVALID');
  assert.equal(parseKoreanWeeklyRoutineExpression('아무 때나 해 줘', { clock }).code, 'A_ROUTINE_TIME_EXPRESSION_UNSUPPORTED');
});

test('weekly routine advances each occurrence with a distinct durable Mission idempotency key', async () => {
  let now = new Date('2026-09-29T00:00:00.000Z');
  const store = new MemoryDurableRoutineStore(); const missions = fakeMissionRuntime();
  const scheduler = new DurableRoutineScheduler({ store, missionRuntime: missions, clock: () => now, ownerId: 'weekly-worker' });
  scheduler.schedule({ routineId: 'weekly-report', scheduledAt: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, missionRequest: scheduledRequest() });
  now = new Date('2026-09-30T00:00:00.000Z');
  assert.equal((await scheduler.tick()).processed[0].status, 'scheduled');
  assert.equal(scheduler.get('weekly-report').scheduledAt, '2026-10-07T00:00:00.000Z');
  assert.equal(scheduler.get('weekly-report').lastOccurrence.missionStatus, 'COMPLETED');
  now = new Date('2026-10-07T00:00:00.000Z');
  assert.equal((await scheduler.tick()).processed[0].status, 'scheduled');
  assert.equal(missions.executions, 2);
  assert.equal(scheduler.get('weekly-report').occurrenceIndex, 2);
});

test('scheduler accepts an explicit weekly Korean schedule expression through its existing schedule API', () => {
  const scheduler = new DurableRoutineScheduler({ store: new MemoryDurableRoutineStore(), missionRuntime: fakeMissionRuntime(), clock: () => new Date('2026-09-29T00:00:00.000Z') });
  const created = scheduler.schedule({ routineId: 'weekly-korean-expression', scheduleText: '매주 수요일 오전 9시', timeZone: 'Asia/Seoul', missionRequest: scheduledRequest() });
  assert.equal(created.routine.scheduledAt, '2026-09-30T00:00:00.000Z');
  assert.equal(created.routine.recurrence.weekday, 3);
  assert.equal(created.routine.timeExpression, '매주 수요일 오전 9시');
  assert.throws(() => scheduler.schedule({ routineId: 'weekly-conflict', scheduleText: '매주 수요일 오전 9시', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 4, hour: 9, minute: 0 }, missionRequest: scheduledRequest() }), { code: 'A_ROUTINE_TIME_INPUT_CONFLICT' });
});

test('timezone revision retires an unclaimed weekly occurrence and refuses a claimed one', () => {
  const now = () => new Date('2026-09-29T00:00:00.000Z');
  const store = new MemoryDurableRoutineStore(); const scheduler = new DurableRoutineScheduler({ store, missionRuntime: fakeMissionRuntime(), clock: now, ownerId: 'tz-worker' });
  scheduler.schedule({ routineId: 'weekly-tz', scheduledAt: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, missionRequest: scheduledRequest() });
  const revised = scheduler.reviseTimezone('weekly-tz', 'America/Los_Angeles');
  assert.equal(revised.updated, true);
  assert.equal(revised.routine.timeZone, 'America/Los_Angeles');
  assert.equal(revised.routine.scheduledAt, '2026-09-30T16:00:00.000Z');
  assert.equal(revised.routine.recurrenceRevision, 2);
  assert.equal(scheduler.reviseTimezone('weekly-tz', 'Invalid/Zone').code, 'A_ROUTINE_TIMEZONE_INVALID');
  const claimed = store.claim('weekly-tz', { nowIso: revised.routine.scheduledAt, ownerId: 'tz-worker' });
  assert.ok(claimed);
  assert.equal(scheduler.reviseTimezone('weekly-tz', 'Asia/Seoul').code, 'A_ROUTINE_NOT_REVISABLE');
});

test('SQLite timezone revision atomically supersedes the old occurrence across service connections', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-routine-tz-revision-')); let firstOperations; let secondOperations;
  t.after(() => { firstOperations?.close(); secondOperations?.close(); rmSync(root, { recursive: true, force: true }); });
  const dbPath = join(root, 'personal.sqlite'); const clock = () => new Date('2026-09-29T00:00:00.000Z');
  firstOperations = new PersonalOperationsStore({ dbPath, clock }); const first = new SqliteDurableRoutineStore({ operationsStore: firstOperations, clock });
  first.create({ routineId: 'sqlite-weekly-tz', scheduledAt: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, recurrenceRevision: 1, occurrenceIndex: 0,
    missionRequest: scheduledRequest(), status: 'scheduled', attempts: 0 });
  secondOperations = new PersonalOperationsStore({ dbPath, clock }); const second = new SqliteDurableRoutineStore({ operationsStore: secondOperations, clock });
  const revision = second.reviseTimezone('sqlite-weekly-tz', 'America/Los_Angeles', clock().toISOString());
  assert.equal(revision.updated, true);
  assert.equal(first.get('sqlite-weekly-tz').recurrenceRevision, 2);
  assert.equal(first.due('2026-09-30T00:00:00.000Z').length, 0);
  assert.equal(first.claim('sqlite-weekly-tz', { nowIso: '2026-09-30T00:00:00.000Z', ownerId: 'old-tick' }), null);
  assert.equal(first.claim('sqlite-weekly-tz', { nowIso: '2026-09-30T16:00:00.000Z', ownerId: 'new-tick' }).recurrenceRevision, 2);
  assert.equal(second.reviseTimezone('sqlite-weekly-tz', 'Asia/Seoul', clock().toISOString()).code, 'A_ROUTINE_NOT_REVISABLE');
});

test('one-time routine dispatches once through MissionRuntime when due', async () => {
  let now = new Date('2026-09-29T00:00:00.000Z');
  const store = new MemoryDurableRoutineStore(); const missions = fakeMissionRuntime(); const notifications = [];
  const scheduler = new DurableRoutineScheduler({ store, missionRuntime: missions, clock: () => now, ownerId: 'test-worker', onNotification: item => notifications.push(item) });
  const created = scheduler.schedule({ routineId: 'g03-once', scheduledAt: '2026-09-29T00:00:05.000Z', missionRequest: scheduledRequest() });
  assert.equal(created.created, true);
  now = new Date('2026-09-29T00:00:05.000Z');
  const tick = await scheduler.tick();
  assert.equal(tick.success, true);
  assert.equal(missions.executions, 1);
  assert.equal(scheduler.get('g03-once').status, 'completed');
  await scheduler.tick();
  assert.equal(missions.executions, 1);
  assert.equal(notifications.filter(item => item.kind === 'routine-completed').length, 1);
});

test('startup marks an offline-overdue one-time routine missed without late execution', async () => {
  const now = new Date('2026-09-29T01:00:00.000Z'); const store = new MemoryDurableRoutineStore(); const missions = fakeMissionRuntime(); const notifications = [];
  const scheduler = new DurableRoutineScheduler({ store, missionRuntime: missions, clock: () => now, onNotification: item => notifications.push(item) });
  scheduler.schedule({ routineId: 'g03-missed', scheduledAt: '2026-09-29T00:00:00.000Z', missionRequest: scheduledRequest() });
  const result = await scheduler.startupReconcile();
  assert.equal(result.missed, 1);
  assert.equal(scheduler.get('g03-missed').status, 'missed');
  assert.equal(missions.executions, 0);
  assert.equal(notifications[0].kind, 'routine-missed');
});

test('startup reports an occurrence missed even when the service returns shortly after its due instant', async () => {
  const now = new Date('2026-09-29T00:00:06.000Z'); const store = new MemoryDurableRoutineStore(); const missions = fakeMissionRuntime(); const notices = [];
  const scheduler = new DurableRoutineScheduler({ store, missionRuntime: missions, clock: () => now, onNotification: item => notices.push(item) });
  scheduler.schedule({ routineId: 'g03-boot-late', scheduledAt: '2026-09-29T00:00:05.000Z', missionRequest: scheduledRequest() });
  await scheduler.startupReconcile();
  assert.equal(scheduler.get('g03-boot-late').status, 'missed');
  assert.equal(missions.executions, 0);
  assert.equal(notices[0].kind, 'routine-missed');
});

test('interrupted dispatch reuses the same mission idempotency key after restart', async () => {
  let now = new Date('2026-09-29T00:00:05.000Z'); const store = new MemoryDurableRoutineStore(); const missions = fakeMissionRuntime();
  const first = new DurableRoutineScheduler({ store, missionRuntime: missions, clock: () => now, ownerId: 'old-worker' });
  first.schedule({ routineId: 'g03-restart', scheduledAt: now.toISOString(), missionRequest: scheduledRequest() });
  assert.ok(store.claim('g03-restart', { nowIso: now.toISOString(), ownerId: 'old-worker' }));
  const recovered = new DurableRoutineScheduler({ store, missionRuntime: missions, clock: () => now, ownerId: 'new-worker' });
  const result = await recovered.startupReconcile();
  assert.equal(result.recoveredDispatches, 1);
  assert.equal(recovered.get('g03-restart').status, 'completed');
  assert.equal(missions.executions, 1);
});

test('durable routine store survives SQLite connection restart and rejects changed idempotency payload', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-routines-'));
  let operations;
  t.after(() => { operations?.close(); rmSync(root, { recursive: true, force: true }); });
  const dbPath = join(root, 'personal.sqlite'); const now = () => new Date('2026-09-29T00:00:00.000Z');
  operations = new PersonalOperationsStore({ dbPath, clock: now }); let store = new SqliteDurableRoutineStore({ operationsStore: operations, clock: now });
  const input = { routineId: 'persisted', scheduledAt: '2026-09-29T00:10:00.000Z', timeZone: 'Asia/Seoul', missionRequest: scheduledRequest(), status: 'scheduled', attempts: 0 };
  assert.equal(store.create(input).created, true); operations.close();
  operations = new PersonalOperationsStore({ dbPath, clock: now }); store = new SqliteDurableRoutineStore({ operationsStore: operations, clock: now });
  assert.equal(store.get('persisted').missionRequest.objective, input.missionRequest.objective);
  assert.equal(store.metadata().durable, true);
  assert.equal(store.create(input).created, false);
  assert.throws(() => store.create({ ...input, missionRequest: scheduledRequest({ objective: '바뀐 임무' }) }), { code: 'A_ROUTINE_IDEMPOTENCY_CONFLICT' });
});

test('SQLite routine recovery claim is compare-and-set across two service connections', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-routine-cas-')); let firstOperations; let secondOperations;
  t.after(() => { firstOperations?.close(); secondOperations?.close(); rmSync(root, { recursive: true, force: true }); });
  const dbPath = join(root, 'personal.sqlite'); const clock = () => new Date('2026-09-29T00:00:05.000Z');
  firstOperations = new PersonalOperationsStore({ dbPath, clock }); const firstStore = new SqliteDurableRoutineStore({ operationsStore: firstOperations, clock });
  firstStore.create({ routineId: 'cas-recovery', scheduledAt: clock().toISOString(), timeZone: 'Asia/Seoul', missionRequest: scheduledRequest(), status: 'scheduled', attempts: 0 });
  assert.ok(firstStore.claim('cas-recovery', { nowIso: clock().toISOString(), ownerId: 'old-process' }));
  secondOperations = new PersonalOperationsStore({ dbPath, clock }); const secondStore = new SqliteDurableRoutineStore({ operationsStore: secondOperations, clock });
  const old = firstStore.get('cas-recovery');
  assert.ok(firstStore.claimRecovery('cas-recovery', { expectedOwnerId: old.ownerId, ownerId: 'recovery-one', nowIso: clock().toISOString() }));
  assert.equal(secondStore.claimRecovery('cas-recovery', { expectedOwnerId: old.ownerId, ownerId: 'recovery-two', nowIso: clock().toISOString() }), null);
  assert.equal(secondStore.get('cas-recovery').ownerId, 'recovery-one');
});

test('routine cancellation atomically blocks only an undispatched occurrence across service connections', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-routine-cancel-')); let firstOperations; let secondOperations;
  t.after(() => { firstOperations?.close(); secondOperations?.close(); rmSync(root, { recursive: true, force: true }); });
  const dbPath = join(root, 'personal.sqlite'); const clock = () => new Date('2026-09-29T00:00:00.000Z');
  firstOperations = new PersonalOperationsStore({ dbPath, clock }); const firstStore = new SqliteDurableRoutineStore({ operationsStore: firstOperations, clock });
  firstStore.create({ routineId: 'cancel-before-dispatch', scheduledAt: '2026-09-29T00:10:00.000Z', timeZone: 'Asia/Seoul', missionRequest: scheduledRequest(), status: 'scheduled', attempts: 0 });
  secondOperations = new PersonalOperationsStore({ dbPath, clock }); const secondStore = new SqliteDurableRoutineStore({ operationsStore: secondOperations, clock });
  const cancelled = firstStore.cancelScheduled('cancel-before-dispatch', clock().toISOString());
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.routine.notification.kind, 'routine-cancelled-by-user');
  assert.equal(secondStore.cancelScheduled('cancel-before-dispatch', clock().toISOString()).cancelled, false);
  assert.equal(secondStore.get('cancel-before-dispatch').status, 'blocked');
  assert.deepEqual(secondStore.due('2026-09-29T00:20:00.000Z'), []);
  firstStore.create({ routineId: 'already-claimed', scheduledAt: clock().toISOString(), timeZone: 'Asia/Seoul', missionRequest: scheduledRequest(), status: 'scheduled', attempts: 0 });
  assert.ok(firstStore.claim('already-claimed', { nowIso: clock().toISOString(), ownerId: 'worker' }));
  assert.equal(secondStore.cancelScheduled('already-claimed', clock().toISOString()).cancelled, false);
  assert.equal(secondStore.get('already-claimed').status, 'dispatching');
});

test('a routine cannot persist trusted-session or high-impact authority', () => {
  const scheduler = new DurableRoutineScheduler({ store: new MemoryDurableRoutineStore(), missionRuntime: fakeMissionRuntime() });
  assert.throws(() => scheduler.schedule({ routineId: 'unsafe-high', scheduledAt: '2026-09-29T00:10:00.000Z',
    missionRequest: scheduledRequest({ authorization: { mode: 'trusted_session', grants: ['read_only', 'high_impact'] } }) }),
  { code: 'A_ROUTINE_AUTHORITY_NOT_PERSISTABLE' });
});

test('routine API requires admin authentication and returns observable persisted status', async t => {
  const notices = [];
  const scheduler = new DurableRoutineScheduler({ store: new MemoryDurableRoutineStore(), missionRuntime: fakeMissionRuntime(), clock: () => new Date('2026-09-29T00:00:00.000Z'), onNotification: item => notices.push(item) });
  const server = createCoreServer(new CoreFacade(), { adminToken: 'g03-test-admin-token', routineScheduler: scheduler });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = { routineId: 'api-routine', scheduledAt: '2026-09-29T00:10:00.000Z', timeZone: 'Asia/Seoul', missionRequest: scheduledRequest() };
  const denied = await fetch(`${base}/routines`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(denied.status, 401);
  const created = await fetch(`${base}/routines`, { method: 'POST', headers: { authorization: 'Bearer g03-test-admin-token', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(created.status, 201);
  const listing = await fetch(`${base}/routines`, { headers: { authorization: 'Bearer g03-test-admin-token' } });
  assert.equal(listing.status, 200);
  const data = await listing.json();
  assert.equal(data.items[0].routineId, 'api-routine');
  assert.equal(data.status.version, 'a-durable-routine-scheduler-v1');
  const deniedCancel = await fetch(`${base}/routines/api-routine/cancel`, { method: 'POST' });
  assert.equal(deniedCancel.status, 401);
  const cancelled = await fetch(`${base}/routines/api-routine/cancel`, { method: 'POST', headers: { authorization: 'Bearer g03-test-admin-token' } });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).routine.notification.kind, 'routine-cancelled-by-user');
  const cancelledAgain = await fetch(`${base}/routines/api-routine/cancel`, { method: 'POST', headers: { authorization: 'Bearer g03-test-admin-token' } });
  assert.equal(cancelledAgain.status, 200);
  assert.equal((await cancelledAgain.json()).alreadyCancelled, true);
  assert.equal(notices.filter(item => item.kind === 'routine-cancelled').length, 1);
  const naturalTime = await fetch(`${base}/routines`, { method: 'POST', headers: { authorization: 'Bearer g03-test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ routineId: 'api-korean-time', scheduleText: '내일 오전 9시에 자료를 정리해', timeZone: 'Asia/Seoul', missionRequest: scheduledRequest() }) });
  assert.equal(naturalTime.status, 201);
  const scheduled = await naturalTime.json();
  assert.equal(scheduled.routine.scheduledAt, '2026-09-30T00:00:00.000Z');
  assert.equal(scheduled.routine.timeExpression, '내일 오전 9시');
  const weekly = await fetch(`${base}/routines`, { method: 'POST', headers: { authorization: 'Bearer g03-test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ routineId: 'api-weekly', scheduleText: '매주 수요일 오전 9시', timeZone: 'Asia/Seoul', missionRequest: scheduledRequest() }) });
  assert.equal(weekly.status, 201);
  const mismatchedFirstOccurrence = await fetch(`${base}/routines`, { method: 'POST', headers: { authorization: 'Bearer g03-test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ routineId: 'api-weekly-mismatch', scheduledAt: '2026-10-01T00:00:00.000Z', timeZone: 'Asia/Seoul',
      recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, missionRequest: scheduledRequest() }) });
  assert.equal(mismatchedFirstOccurrence.status, 409);
  assert.equal((await mismatchedFirstOccurrence.json()).error.code, 'A_ROUTINE_RECURRENCE_SCHEDULE_MISMATCH');
  const deniedRevision = await fetch(`${base}/routines/api-weekly/timezone`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeZone: 'America/Los_Angeles' }) });
  assert.equal(deniedRevision.status, 401);
  const revised = await fetch(`${base}/routines/api-weekly/timezone`, { method: 'PATCH', headers: { authorization: 'Bearer g03-test-admin-token', 'content-type': 'application/json' }, body: JSON.stringify({ timeZone: 'America/Los_Angeles' }) });
  assert.equal(revised.status, 200);
  assert.equal((await revised.json()).routine.recurrenceRevision, 2);
});

test('natural weekly command creates and revises one exact target through authenticated Core API', async t => {
  const scheduler = new DurableRoutineScheduler({ store: new MemoryDurableRoutineStore(), missionRuntime: fakeMissionRuntime(),
    clock: () => new Date('2026-09-29T00:00:00.000Z') });
  const server = createCoreServer(new CoreFacade(), { adminToken: 'g03-natural-command-test-token', routineScheduler: scheduler });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer g03-natural-command-test-token', 'content-type': 'application/json' };

  const create = parseWeeklyRoutineCommand('매주 수요일 오전 9시에 작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘', 'routine-natural-command');
  assert.equal(create.valid, true);
  const createdResponse = await fetch(`${base}/routines`, { method: 'POST', headers, body: JSON.stringify(create.request) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.routine.missionRequest.objective, '작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘');
  assert.deepEqual(created.routine.recurrence, { frequency: 'weekly', weekday: 3, hour: 9, minute: 0, dstGap: 'skip', dstOverlap: 'earlier' });

  const listed = await fetch(`${base}/routines`, { headers: { authorization: headers.authorization } });
  const routines = (await listed.json()).items;
  const revision = parseWeeklyRoutineTimezoneCommand('예약 “작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘” 시간대를 America/Los_Angeles로 바꿔줘', routines);
  assert.deepEqual(revision, { matched: true, valid: true, routineId: 'routine-natural-command', timeZone: 'America/Los_Angeles' });
  const revisedResponse = await fetch(`${base}/routines/${encodeURIComponent(revision.routineId)}/timezone`, {
    method: 'PATCH', headers, body: JSON.stringify({ timeZone: revision.timeZone })
  });
  assert.equal(revisedResponse.status, 200);
  const revised = await revisedResponse.json();
  assert.equal(revised.routine.timeZone, 'America/Los_Angeles');
  assert.equal(revised.routine.recurrenceRevision, 2);
  assert.equal(revised.routine.recurrence.weekday, 3);
  assert.equal(revised.routine.recurrence.hour, 9);
  assert.equal(revised.routine.scheduledAt, '2026-09-30T16:00:00.000Z');
});

test('Core accepts a natural weekly command directly and refuses unauthenticated, ambiguous, or unsafe requests', async t => {
  const scheduler = new DurableRoutineScheduler({ store: new MemoryDurableRoutineStore(), missionRuntime: fakeMissionRuntime(),
    clock: () => new Date('2026-09-29T00:00:00.000Z') });
  const server = createCoreServer(new CoreFacade(), { adminToken: 'g03-command-endpoint-token', routineScheduler: scheduler });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/routines/command`;
  const body = { command: '매주 수요일 오전 9시에 작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘', routineId: 'mobile-weekly-safe' };
  const denied = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(denied.status, 401);
  const headers = { authorization: 'Bearer g03-command-endpoint-token', 'content-type': 'application/json' };
  const client = new CoreClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminToken: 'g03-command-endpoint-token' });
  const created = await client.createRoutineFromCommand(body.command, body.routineId);
  assert.equal(created.created, true);
  assert.equal(created.routine.missionRequest.objective, '작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘');
  assert.deepEqual(created.routine.missionRequest.authorization, { mode: 'supervised', grants: ['read_only', 'local_reversible'] });
  const unsafe = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...body, routineId: 'mobile-weekly-unsafe', command: '매주 수요일 오전 9시에 뉴스 메일을 자동 발송해줘' }) });
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json()).error.code, 'A_ROUTINE_COMMAND_UNSUPPORTED');
  const ambiguous = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...body, routineId: 'mobile-weekly-ambiguous', command: '매주 오전 9시에 자료를 정리해줘' }) });
  assert.equal(ambiguous.status, 400);
  const notWeekly = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...body, command: '매일 오전 9시에 자료를 정리해줘' }) });
  assert.equal(notWeekly.status, 400);
  const extraProperty = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...body, token: 'must-not-be-accepted' }) });
  assert.equal(extraProperty.status, 400);
  const listed = await fetch(`http://127.0.0.1:${server.address().port}/routines`, { headers: { authorization: headers.authorization } });
  const items = (await listed.json()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].routineId, 'mobile-weekly-safe');
});

test('CoreWorkerDaemon tick drives the durable routine scheduler', async () => {
  const now = new Date('2026-09-29T00:00:05.000Z'); const store = new MemoryDurableRoutineStore(); const missions = fakeMissionRuntime();
  const scheduler = new DurableRoutineScheduler({ store, missionRuntime: missions, clock: () => now });
  scheduler.schedule({ routineId: 'g03-daemon', scheduledAt: now.toISOString(), missionRequest: scheduledRequest() });
  const daemon = new CoreWorkerDaemon({ worker: { queueStatus: () => ({ total: 0 }), drain: async () => ({ processed: 0 }) }, routineScheduler: scheduler, clock: () => now });
  const result = await daemon.tick();
  assert.equal(result.success, true);
  assert.equal(result.drain.processed, 0);
  assert.equal(result.daemon.routineScheduler.dispatched, 1);
  assert.equal(missions.executions, 1);
});

test('G03 local product proxy schedules one Mission, writes and verifies its file, and stays complete after SQLite restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-g03-product-')); const workspace = join(root, 'workspace');
  const dbPath = join(root, 'personal.sqlite'); const auditRoot = join(root, 'audit');
  const missionStorePath = join(root, 'missions.json');
  const content = '예약 미션 결과: 입력 자료 목록을 확인하고 검토할 항목을 정리했습니다.\n';
  let now = new Date('2026-09-28T23:59:55.000Z'); let operations; let runtime; let plannerCalls = 0;
  t.after(async () => { try { await runtime?.missionRuntime.requestShutdown({ reason: 'test-cleanup' }); } catch {} operations?.close(); rmSync(root, { recursive: true, force: true }); });
  const planner = { async planNextWave(context) {
    plannerCalls += 1;
    const write = context.observations.find(item => item.outcome === 'success' && item.toolName === 'filesystem.createTextFile');
    if (!write) return { decision: 'continue', summary: '예약된 자료 정리 결과 저장', actions: [{
      id: 'g03-write-summary', title: '정리 결과 초안 저장', command: '예약된 자료 정리 결과를 summary.txt로 저장한다.',
      expectedToolName: 'filesystem.createTextFile', arguments: { path: join(workspace, 'summary.txt'), content }, dependencies: [],
      successSignal: 'summary.txt 파일 생성 및 내용 검사'
    }], criteriaAssessment: [] };
    return { decision: 'complete', summary: '파일 내용 검증 완료', actions: [],
      criteriaAssessment: context.successCriteria.map(criterion => ({ criterionId: criterion.criterionId, status: 'satisfied', evidenceActionIds: [write.actionId] })) };
  } };
  const buildRuntime = () => createAgRuntime({ allowedRoots: [workspace], auditRoot, cwd: () => workspace, env: { JARVIS_TEST_MODE: '1' },
    missionPlanner: planner, workerDaemonEnabled: false, clock: () => now,
    missionStore: new FileMissionStore({ filePath: missionStorePath, clock: () => now }) });
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }));
  operations = new PersonalOperationsStore({ dbPath, clock: () => now }); runtime = buildRuntime();
  const routineStore = new SqliteDurableRoutineStore({ operationsStore: operations, clock: () => now });
  const userRequest = '내일 오전 9시에 자료 정리를 한 번만 실행해 summary.txt를 만들고 내용을 확인해.';
  const initialNotifications=[];
  const scheduler = new DurableRoutineScheduler({ store: routineStore, missionRuntime: runtime.missionRuntime, clock: () => now, ownerId: 'g03-product-worker',
    onNotification:notice=>initialNotifications.push(notice) });
  scheduler.schedule({ routineId: 'g03-product-one-shot', scheduleText: userRequest, timeZone: 'Asia/Seoul', missionRequest: {
    objective: '내일 오전 9시에 자료 정리를 한 번만 실행해 summary.txt를 만들고 내용을 확인해.',
    successCriteria: [{ statement: 'summary.txt 내용이 고정된 예약 자료 요약과 일치한다.', verificationSpec: { version: 1, kind: 'text.equals', path: 'summary.txt', equals: content } }],
    constraints: ['허용된 작업 폴더 안에서만 파일을 읽고 쓴다.', '외부 계정과 네트워크를 사용하지 않는다.'],
    authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }
  } });
  const dueAt = scheduler.get('g03-product-one-shot').scheduledAt;
  await scheduler.startupReconcile(); now = new Date(dueAt);
  const daemon = new CoreWorkerDaemon({ worker: runtime.orchestrationWorker, routineScheduler: scheduler, clock: () => now });
  const tick = await daemon.tick({ reason: 'g03-due-one-shot' });
  assert.equal(tick.success, true, JSON.stringify(tick));
  assert.equal(scheduler.get('g03-product-one-shot').status, 'completed', JSON.stringify({
    routine: scheduler.get('g03-product-one-shot'),
    mission: (() => {
      const item = runtime.missionRuntime.getMission(scheduler.get('g03-product-one-shot').missionId);
      return { status: item?.status, stopReason: item?.stopReason, metrics: item?.metrics,
        failures: (item?.observations ?? []).filter(observation => observation.outcome === 'failed')
          .map(observation => ({ code: observation.error?.code, message: observation.error?.message })) };
    })()
  }));
  assert.equal(await (await import('node:fs/promises')).readFile(join(workspace, 'summary.txt'), 'utf8'), content);
  assert.equal(runtime.missionRuntime.listMissions().items.length, 1);
  const callsAfterFirstRun = plannerCalls;
  // A restart must not replay an acknowledged completion. An absent consumer
  // is now explicitly tested as pending by routine-notification-outbox.test.js.
  assert.equal(initialNotifications.length,1);
  assert.equal(initialNotifications[0].kind,'routine-completed');
  assert.equal(scheduler.status().notifications.pending,0);
  const missedAt = new Date(Date.parse(dueAt) + 60_000).toISOString();
  scheduler.schedule({ routineId: 'g03-offline-missed', scheduledAt: missedAt, timeZone: 'Asia/Seoul', missionRequest: {
    objective: '꺼져 있는 동안 놓친 자료 정리 예약을 실행하지 말고 누락 상태를 남긴다.',
    successCriteria: ['놓친 예약은 자동으로 늦게 실행되지 않고 missed로 기록된다.'],
    constraints: ['놓친 예약을 자동으로 실행하지 않는다.', '외부 계정과 네트워크를 사용하지 않는다.'],
    authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }
  } });
  await runtime.missionRuntime.requestShutdown({ reason: 'simulated-app-restart' });
  operations.close();
  now = new Date(Date.parse(missedAt) + 5 * 60_000);
  operations = new PersonalOperationsStore({ dbPath, clock: () => now }); runtime = buildRuntime();
  const restartedStore = new SqliteDurableRoutineStore({ operationsStore: operations, clock: () => now });
  const restartNotifications = [];
  const restartedScheduler = new DurableRoutineScheduler({ store: restartedStore, missionRuntime: runtime.missionRuntime, clock: () => now,
    ownerId: 'g03-product-worker-restarted', onNotification: item => restartNotifications.push(item) });
  const recovery = await restartedScheduler.startupReconcile(); await restartedScheduler.tick();
  assert.equal(restartedScheduler.get('g03-product-one-shot').status, 'completed');
  assert.equal(restartedScheduler.get('g03-offline-missed').status, 'missed');
  assert.equal(recovery.missed, 1);
  assert.equal(restartNotifications.length, 1);
  assert.equal(restartNotifications[0].kind, 'routine-missed');
  assert.equal(runtime.missionRuntime.listMissions().items.length, 1);
  assert.equal(plannerCalls, callsAfterFirstRun);
  const evidencePath = process.env.JARVIS_G03_ORACLE_EVIDENCE_PATH;
  if (evidencePath) {
    const bytes = Buffer.from(await (await import('node:fs/promises')).readFile(join(workspace, 'summary.txt')));
    const missions = runtime.missionRuntime.listMissions().items;
    const routine = restartedScheduler.get('g03-product-one-shot');
    await writeFile(evidencePath, `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'G03',
      userRequest,
      parsedLocalTime: { scheduleText: routine.timeExpression, timeZone: routine.timeZone, scheduledAt: routine.scheduledAt },
      parserReferenceAt: '2026-09-28T23:59:55.000Z',
      dueAt,
      routineStatusAfterRestart: routine.status,
      missedRoutine: { scheduledAt: missedAt, status: restartedScheduler.get('g03-offline-missed').status,
        startupMissedCount: recovery.missed, notification: restartNotifications[0] },
      missionCountAfterRestart: missions.length,
      mission: missions[0] ?? null,
      plannerCallsBeforeAndAfterRestart: { before: callsAfterFirstRun, after: plannerCalls },
      artifact: { relativePath: 'summary.txt', byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});
