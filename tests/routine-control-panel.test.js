import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineRequest, parseWeeklyRoutineCommand, parseWeeklyRoutineTimezoneCommand, renderRoutineControlPanel, routineApiFailureMessage } from '../src/ui/routine-control-panel.js';

test('routine request supports one-time and weekly supervised local actions with explicit completion conditions', () => {
  const result = createRoutineRequest({ scheduleText: ' 내일 오전 9시 ', objective: ' 자료를 읽고 요약 초안을 저장해 ',
    successCriteria: '요약 파일이 생성된다.\n내용이 다시 읽혀 검증된다.' }, 'routine_test_1');
  assert.equal(result.scheduleText, '내일 오전 9시');
  assert.equal(result.timeZone, 'Asia/Seoul');
  assert.deepEqual(result.missionRequest.successCriteria, ['요약 파일이 생성된다.', '내용이 다시 읽혀 검증된다.']);
  assert.deepEqual(result.missionRequest.authorization, { mode: 'supervised', grants: ['read_only', 'local_reversible'] });
  assert.ok(result.missionRequest.constraints.some(item => item.includes('구매·결제·송금')));
  assert.ok(result.missionRequest.constraints.some(item => item.includes('차단')));
  const weekly = createRoutineRequest({ scheduleText: '내일 오전 9시', objective: '자료 요약', successCriteria: '요약 파일 생성',
    recurrenceEnabled: true, weekday: 3, hour: 9, minute: 30, timeZone: 'Asia/Seoul' }, 'routine_weekly');
  assert.deepEqual(weekly.recurrence, { frequency: 'weekly', weekday: 3, hour: 9, minute: 30 });
  assert.throws(() => createRoutineRequest({ scheduleText: '내일 오전 9시', objective: '자료 요약', successCriteria: '완료', recurrenceEnabled: true, weekday: 8 }, 'routine_invalid'), /주간 반복/u);
});

test('routine request fails closed on missing goals, criteria, oversized expressions, and unsafe ids', () => {
  const valid = { scheduleText: '내일 오전 9시', objective: '자료 요약', successCriteria: '요약 파일 생성' };
  assert.throws(() => createRoutineRequest({ ...valid, scheduleText: ' ' }, 'routine_1'), /예약 시각/u);
  assert.throws(() => createRoutineRequest({ ...valid, objective: ' ' }, 'routine_1'), /실행할 작업/u);
  assert.throws(() => createRoutineRequest({ ...valid, successCriteria: '' }, 'routine_1'), /완료 기준/u);
  assert.throws(() => createRoutineRequest({ ...valid, scheduleText: 'x'.repeat(301) }, 'routine_1'), /예약 시각/u);
  assert.throws(() => createRoutineRequest(valid, '../outside'), /예약 식별값/u);
});

test('natural Korean weekly command becomes a supervised recurring Mission request', () => {
  const parsed = parseWeeklyRoutineCommand('매주 월요일 오전 9시에 작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘', 'routine_test_1');
  assert.equal(parsed.matched, true);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.request.scheduleText, '매주 월요일 오전 9시');
  assert.equal(parsed.request.missionRequest.objective, '작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘');
  assert.deepEqual(parsed.request.missionRequest.authorization.grants, ['read_only', 'local_reversible']);
  assert.ok(parsed.request.missionRequest.constraints.some(item => item.includes('메일·메신저 발송')));
});

test('natural weekly command refuses incomplete timing and recurring external commits', () => {
  const missingTime = parseWeeklyRoutineCommand('매주 오전에 받은 메일을 요약해줘', 'routine_test_2');
  assert.equal(missingTime.matched, true);
  assert.equal(missingTime.valid, false);
  assert.match(missingTime.reason, /요일과 오전\/오후 시각/u);

  const externalCommit = parseWeeklyRoutineCommand('매주 금요일 오후 4시에 교회 공지 메일을 보내줘', 'routine_test_3');
  assert.equal(externalCommit.matched, true);
  assert.equal(externalCommit.valid, false);
  assert.match(externalCommit.reason, /발송·거래·물리 기기 동작/u);

  assert.deepEqual(parseWeeklyRoutineCommand('매주 보고서를 작성하는 방법을 조사해줘', 'routine_not_schedule'), { matched: false });
});

test('natural timezone revision resolves only one exact scheduled weekly objective', () => {
  const routines = [
    { routineId: 'weekly_1', status: 'scheduled', recurrence: { frequency: 'weekly' }, missionRequest: { objective: '매주 새 자료 요약하기' } },
    { routineId: 'once_1', status: 'scheduled', missionRequest: { objective: '한 번만 실행' } }
  ];
  assert.deepEqual(parseWeeklyRoutineTimezoneCommand('예약 “매주 새 자료 요약하기” 시간대를 America/Los_Angeles로 바꿔줘', routines), {
    matched: true, valid: true, routineId: 'weekly_1', timeZone: 'America/Los_Angeles'
  });
  assert.equal(parseWeeklyRoutineTimezoneCommand('예약 “매주 새 자료 요약하기” 시간대를 Asia/Tokyo로 변경해줘', [...routines, routines[0]]).valid, false);
  assert.equal(parseWeeklyRoutineTimezoneCommand('예약 “없는 업무” 시간대를 Asia/Tokyo로 바꿔줘', routines).valid, false);
});

test('routine panel explains credential and offline-miss state and escapes stored content', () => {
  const authMarkup = renderRoutineControlPanel({ status: 'auth-required', canManage: false });
  assert.match(authMarkup, /Core 관리자 토큰/u);
  assert.match(authMarkup, /name="scheduleText"[^>]*disabled/u);
  assert.match(authMarkup, /놓친 작업은 늦게 실행하지 않습니다/u);
  const xss = '<img src=x onerror=alert(1)>';
  const markup = renderRoutineControlPanel({ status: 'ready', canManage: true, items: [{
    routineId: 'routine_1', status: 'missed', scheduledAt: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul',
    missionRequest: { objective: xss }, notification: { nextAction: xss }
  }] });
  assert.doesNotMatch(markup, /<img src=x/u);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(markup, /놓침/u);
  const cancellable = renderRoutineControlPanel({ status: 'ready', canManage: true, items: [{
    routineId: 'pending_1', status: 'scheduled', scheduledAt: '2026-09-30T00:00:00.000Z',
    missionRequest: { objective: '예약 작업' }
  }] });
  assert.match(cancellable, /data-routine-cancel="pending_1"/u);
  assert.match(cancellable, /예약 취소/u);
  const weekly = renderRoutineControlPanel({ status: 'ready', canManage: true, timezoneDrafts: { weekly_1: 'America/Los_Angeles' }, items: [{
    routineId: 'weekly_1', status: 'scheduled', scheduledAt: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, missionRequest: { objective: '주간 보고' }
  }] });
  assert.match(weekly, /매주 반복/u);
  assert.match(weekly, /data-routine-timezone="weekly_1"/u);
  assert.match(weekly, /value="America\/Los_Angeles"/u);
  const weeklyForm = renderRoutineControlPanel({ status: 'ready', canManage: true, draft: { recurrenceEnabled: true, weekday: 3, hour: 9, minute: 30 } });
  assert.match(weeklyForm, /name="weekday"/u);
  assert.match(weeklyForm, /name="hour"[^>]+value="9"/u);
  assert.match(weeklyForm, /매주 예약/u);
  const cancelled = renderRoutineControlPanel({ status: 'ready', canManage: true, items: [{
    routineId: 'pending_1', status: 'blocked', scheduledAt: '2026-09-30T00:00:00.000Z',
    missionRequest: { objective: '예약 작업' }, notification: { kind: 'routine-cancelled-by-user' }
  }] });
  assert.match(cancelled, /취소됨/u);
  assert.doesNotMatch(cancelled, /data-routine-cancel=/u);
});

test('routine errors expose known safe guidance instead of arbitrary server messages', () => {
  assert.match(routineApiFailureMessage({ payload: { error: { code: 'A_ROUTINE_TIME_IN_PAST' } } }), /이미 지났습니다/u);
  assert.match(routineApiFailureMessage({ payload: { error: { code: 'A_ROUTINE_RECURRENCE_SCHEDULE_MISMATCH' } } }), /주간 반복 규칙과 일치하지 않습니다/u);
  assert.doesNotMatch(routineApiFailureMessage({ message: 'secret / private error body' }), /secret|private/u);
});
