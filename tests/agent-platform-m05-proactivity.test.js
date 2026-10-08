import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalOperationsReminderScheduler } from '../packages/core/src/personal-operations/reminder-scheduler.js';

test('M05 emits a due reminder and only meaningful Mission blocker transitions', t => {
  const now = { value: new Date('2026-09-29T00:00:00.000Z') };
  const store = new PersonalOperationsStore({ dbPath: ':memory:', clock: () => new Date(now.value) });
  t.after(() => store.close());
  const dueAt = '2026-09-29T12:00:00.000Z';
  const commitment = store.createCommitment({ title: 'synthetic M05 title', dueAt, sourceRef: 'fixture:M05' });
  const mission = { missionId: 'm05-synthetic-mission', objective: 'private objective must stay local', status: 'PAUSED', stopReason: 'action-recovery-required', gates: [] };
  const runtime = { missions: new Map() };
  const events = [];
  const scheduler = new PersonalOperationsReminderScheduler({ store, missionRuntime: runtime,
    onNotification: event => events.push(event) });
  const samples = [];
  const runTick = tick => {
    const start = events.length;
    const result = scheduler.tick();
    const emitted = events.slice(start);
    samples.push({ tick, eventsDelivered: emitted.length });
    return { result, emitted };
  };

  assert.equal(runTick(1).emitted[0]?.kind, 'commitment-due-soon');
  assert.equal(runTick(2).emitted.length, 0);
  runtime.missions.set(mission.missionId, mission);
  assert.equal(runTick(3).emitted[0]?.kind, 'mission-blocked');
  assert.equal(runTick(4).emitted.length, 0);
  mission.stopReason = 'capability-unavailable'; mission.gates = [{ status: 'pending' }];
  assert.equal(runTick(5).emitted[0]?.kind, 'mission-blocker-changed');
  mission.status = 'COMPLETED'; mission.stopReason = null; mission.gates = [];
  assert.equal(runTick(6).emitted[0]?.kind, 'mission-blocker-cleared');
  assert.equal(events.length, 4);

  const evidence = { schemaVersion: 1, scenarioId: 'M05', fixtureId: 'm05-local-deadline-and-blocker-transitions-v1',
    expected: { commitmentId: commitment.id, dueAt, horizonEnd: '2026-09-30T00:00:00.000Z' }, samples, events,
    metrics: { externalWrites: 0, networkRequests: 0, providerCalls: 0, executionAuthority: false } };
  if (process.env.JARVIS_M05_EVIDENCE_PATH) writeFileSync(process.env.JARVIS_M05_EVIDENCE_PATH,
    `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  assert.equal(new Set(events.map(event => event.eventId)).size, 4);
  assert.ok(events.every(event => !('objective' in event) && !('title' in event)));
});
