import test from 'node:test';
import assert from 'node:assert/strict';
import { routineView } from '../src/ui/workspace/model.js';
import { translate } from '../src/ui/workspace/i18n.js';

test('uncertain routine preserves blocked state and guides to one existing Mission', () => {
  const item = { status: 'blocked', missionId: 'mission_합성-1', notification: { missionId: 'mission_합성-1', stopReason: 'action-recovery-required' } };
  assert.deepEqual(routineView(item), { statusKey: 'blocked', noticeKey: 'routineUncertainHelp', missionId: 'mission_합성-1' });
  assert.match(translate('ko', routineView(item).noticeKey), /다시 보내지 말고.*기존 작업/u);
  assert.match(translate('en', routineView(item).noticeKey), /Do not resubmit/u);
});
test('conflicting, missing and invalid Mission bindings never open a guessed task', () => {
  for (const item of [
    { status: 'blocked', missionId: 'first', notification: { missionId: 'second' } },
    { status: 'blocked', notification: {} },
    { status: 'blocked', missionId: '../other' },
    { status: 'blocked', missionId: '<script>' },
    { status: 'blocked', missionId: 'x'.repeat(201) }
  ]) assert.equal(routineView(item).missionId, null);
});
test('actual cancellation notification is shown as cancelled without an inspect action', () => {
  assert.deepEqual(routineView({ status: 'blocked', missionId: 'not-started', notification: { kind: 'routine-cancelled-by-user' } }),
    { statusKey: 'cancelled', noticeKey: 'routineCancelledHelp', missionId: null });
});
test('known conflict, missed time and unknown failure have distinct safe instructions', () => {
  assert.equal(routineView({ status: 'failed', notification: { code: 'A_MISSION_IDEMPOTENCY_CONFLICT' } }).noticeKey, 'routineConflictHelp');
  assert.equal(routineView({ status: 'missed' }).noticeKey, 'routineMissedHelp');
  const view = routineView({ status: 'failed', notification: { message: 'secret / private body', code: 'UNRECOGNIZED' } });
  assert.equal(view.noticeKey, 'routineBlockedHelp');
  assert.doesNotMatch(translate('ko', view.noticeKey), /secret|private/u);
  assert.equal(routineView({ status: 'completed', missionId: 'existing' }).missionId, 'existing');
  assert.equal(routineView({ status: 'completed' }).noticeKey, null);
});
test('weekly history never substitutes an older task for an unbound failed occurrence', () => {
  assert.equal(routineView({ status: 'failed', lastOccurrence: { missionId: 'previous' } }).missionId, null);
  assert.equal(routineView({ status: 'blocked', missionId: 'current', notification: { missionId: 'current' }, lastOccurrence: { missionId: 'previous' } }).missionId, 'current');
  assert.equal(routineView({ status: 'scheduled', lastOccurrence: { missionId: 'previous' } }).missionId, 'previous');
});
