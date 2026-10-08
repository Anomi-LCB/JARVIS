import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteDurableRoutineStore } from '../packages/core/src/runtime/durable-routine-store.js';
import { DurableRoutineScheduler } from '../packages/core/src/runtime/durable-routine-scheduler.js';
import { nextWeeklyOccurrence } from '../packages/core/src/runtime/weekly-routine-time.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const request = {
  objective: '합성 자료를 읽고 주간 요약 초안을 만든다.',
  successCriteria: ['초안 결과가 검증된다.'],
  constraints: ['외부 전송·계정 접근 금지'],
  authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }
};

test('S09 atomically revises a weekly timezone, retires the old occurrence, and dispatches the replacement once', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'jarvis-s09-weekly-revision-'));
  let firstOperations; let secondOperations;
  t.after(() => {
    firstOperations?.close();
    secondOperations?.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });
  let now = new Date('2026-09-29T00:00:00.000Z');
  const clock = () => new Date(now);
  const dbPath = join(stateRoot, 'personal.sqlite');
  firstOperations = new PersonalOperationsStore({ dbPath, clock });
  secondOperations = new PersonalOperationsStore({ dbPath, clock });
  const firstStore = new SqliteDurableRoutineStore({ operationsStore: firstOperations, clock });
  const secondStore = new SqliteDurableRoutineStore({ operationsStore: secondOperations, clock });
  const missions = new Map();
  let dispatches = 0;
  const missionRuntime = {
    createMission(input) {
      const prior = missions.get(input.idempotencyKey);
      if (prior) return prior;
      const value = { missionId: `s09-mission-${missions.size + 1}`, request: input, status: 'CREATED' };
      missions.set(input.idempotencyKey, value);
      return value;
    },
    async runMission(missionId) {
      dispatches += 1;
      const item = [...missions.values()].find(candidate => candidate.missionId === missionId);
      item.status = 'COMPLETED';
      return { missionId, status: item.status };
    }
  };
  const first = new DurableRoutineScheduler({ store: firstStore, missionRuntime, clock, ownerId: 's09-first-worker' });
  const second = new DurableRoutineScheduler({ store: secondStore, missionRuntime, clock, ownerId: 's09-second-worker' });
  const created = first.schedule({ routineId: 's09-weekly', scheduledAt: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { frequency: 'weekly', weekday: 3, hour: 9, minute: 0 }, missionRequest: request });
  assert.equal(created.created, true);
  const oldOccurrence = created.routine.scheduledAt;
  const revised = second.reviseTimezone('s09-weekly', 'America/Los_Angeles');
  assert.equal(revised.updated, true);
  assert.equal(revised.routine.scheduledAt, '2026-09-30T16:00:00.000Z');
  assert.equal(revised.routine.recurrenceRevision, 2);

  now = new Date(oldOccurrence);
  const oldTick = await first.tick();
  assert.equal(oldTick.processed.length, 0);
  assert.equal(dispatches, 0);
  assert.equal(firstStore.claim('s09-weekly', { nowIso: oldOccurrence, ownerId: 'stale-old-tick' }), null);

  now = new Date(revised.routine.scheduledAt);
  const newTick = await first.tick();
  assert.equal(newTick.processed.length, 1);
  assert.equal(dispatches, 1);
  const afterDispatch = secondStore.get('s09-weekly');
  assert.equal(afterDispatch.status, 'scheduled');
  assert.equal(afterDispatch.occurrenceIndex, 1);
  assert.equal(secondStore.claim('s09-weekly', { nowIso: now.toISOString(), ownerId: 'duplicate-worker' }), null);
  const concurrentSameInstant = await second.tick();
  assert.equal(concurrentSameInstant.processed.length, 0);
  assert.equal(dispatches, 1);

  const dstGapNext = nextWeeklyOccurrence('2026-03-02T00:00:00.000Z',
    { frequency: 'weekly', weekday: 7, hour: 2, minute: 30 }, 'America/New_York');
  const dstOverlapNext = nextWeeklyOccurrence('2026-10-26T00:00:00.000Z',
    { frequency: 'weekly', weekday: 7, hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(dstGapNext, '2026-03-15T06:30:00.000Z');
  assert.equal(dstOverlapNext, '2026-11-01T05:30:00.000Z');

  const evidencePath = process.env.JARVIS_S09_WEEKLY_EVIDENCE_PATH;
  if (evidencePath) {
    writeFileSync(evidencePath, `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'S09',
      runMode: 'sqlite-two-store-local-scheduler',
      routine: { recurrenceRevision: revised.routine.recurrenceRevision, timeZone: revised.routine.timeZone,
        oldOccurrence, revisedOccurrence: revised.routine.scheduledAt, nextOccurrence: afterDispatch.scheduledAt,
        occurrenceIndex: afterDispatch.occurrenceIndex, status: afterDispatch.status },
      dispatch: { oldTickCount: oldTick.processed.length, newTickCount: newTick.processed.length,
        competingTickCount: concurrentSameInstant.processed.length, totalDispatches: dispatches,
        staleClaimAccepted: false, duplicateClaimAccepted: false },
      dst: { gapOccurrence: dstGapNext, overlapOccurrence: dstOverlapNext,
        gapPolicy: 'skip-nonexistent-wall-time-week', overlapPolicy: 'earlier-instant' }
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});
