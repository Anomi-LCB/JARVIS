import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { GrowthRuntime, PreferenceHypothesisEngine, FailureMemoryBuilder } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { CognitiveRuntime } from '../packages/core/src/cognition/cognitive-runtime.js';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-memory-provenance-')), stores = [];
  let tick = Date.parse('2026-09-27T00:00:00Z');
  const clock = () => new Date(tick++);
  const open = () => {
    const store = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups'), clock });
    stores.push(store);
    return new GrowthRuntime({ memoryStore: store, auditRoot: root, clock });
  };
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    const target = resolve(root); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('jarvis-memory-provenance-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, open, stores, runtime: open(), scope: { userId: 'synthetic-owner', workspaceRoot: root, conversationId: 'synthetic-conversation' } };
}
function ingestPreference(runtime, scope, prefix, statement = '회의자료를 표로 정리해줘') {
  for (let i = 1; i <= 3; i++) assert.equal(runtime.ingestor.ingest({ eventId: `${prefix}-${i}`, taskId: `${prefix}-task-${i}`, eventType: 'approval.edited', source: { module: 'CORE', memoryScope: scope },
    payload: { editRequest: statement }, learningFlags: { canBeUsedForPreference: true, canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false } }).stored, true);
  return runtime.query('회의자료', { scope }).find(item => item.hypothesisId && !item.preferenceId);
}
function confirm(runtime, candidate) {
  const result = runtime.decidePreference({ hypothesisId: candidate.hypothesisId, decision: 'confirm', decidedBy: 'synthetic-user-review' });
  assert.equal(result.success, true, JSON.stringify(result));
  return result.item;
}

test('query distinguishes inferred procedure/preference candidates from user confirmation and verified outcomes', t => {
  const f = fixture(t), candidate = ingestPreference(f.runtime, f.scope, 'original');
  assert.equal(candidate.provenance.memoryKind, 'preference_hypothesis');
  assert.equal(candidate.provenance.independentlyVerifiedOutcome, false);
  assert.equal(candidate.provenance.procedureValidated, false);
  const confirmed = confirm(f.runtime, candidate);
  const result = f.runtime.query('회의자료', { scope: f.scope }).find(item => item.preferenceId === confirmed.preferenceId);
  assert.equal(result.provenance.memoryKind, 'user_confirmed_preference');
  assert.deepEqual(result.provenance.sourceKinds, ['user_statement']);
  assert.equal(result.provenance.sourceEventIds.length, 3);
  assert.equal(result.provenance.executionAuthority, false);
});

test('source deletion removes derived preference from recall and persists review-required state across reopen', t => {
  const f = fixture(t), preference = confirm(f.runtime, ingestPreference(f.runtime, f.scope, 'deleted'));
  const result = f.runtime.decideHygiene({ targetType: 'memory_event', targetId: 'deleted-1', action: 'delete', decidedBy: 'synthetic-user' });
  assert.equal(result.success, true);
  for (const runtime of [f.runtime, f.open()]) {
    assert.equal(runtime.query('회의자료', { scope: f.scope }).some(item => item.preferenceId === preference.preferenceId), false);
    assert.equal(runtime.planningPreferenceContext('회의자료', { scope: f.scope }).confirmedPreferenceHints.length, 0);
    const inactive = runtime.confirmedPreferenceRegistry.all({ includeInactive: true }).find(item => item.preferenceId === preference.preferenceId);
    assert.equal(inactive.status, 'source_review_required');
    assert.ok(inactive.history.some(entry => entry.by === 'source-retraction'));
    assert.equal(runtime.ingestor.events.get('deleted-1').learningFlags.doNotRemember, true);
  }
});

test('redaction also invalidates derived preference while preserving unrelated source and user decision history', t => {
  const f = fixture(t), preference = confirm(f.runtime, ingestPreference(f.runtime, f.scope, 'redacted'));
  const otherScope = { ...f.scope, userId: 'unrelated-user' };
  const other = confirm(f.runtime, ingestPreference(f.runtime, otherScope, 'untouched', '회의자료를 문장으로 정리해줘'));
  f.runtime.decideHygiene({ targetId: 'redacted-1', action: 'redact' });
  assert.equal(f.runtime.confirmedPreferenceRegistry.confirmed.get(preference.preferenceId).status, 'source_review_required');
  assert.equal(f.runtime.query('회의자료', { scope: otherScope }).some(item => item.preferenceId === other.preferenceId), true);
});

test('owner, workspace and conversation scope cannot leak hints or combine unrelated evidence', t => {
  const f = fixture(t);
  const scopes = [f.scope, { ...f.scope, userId: 'second-owner' }, { ...f.scope, workspaceRoot: join(f.root, 'other') }, { ...f.scope, conversationId: 'other-conversation' }];
  const preferences = scopes.map((scope, i) => confirm(f.runtime, ingestPreference(f.runtime, scope, `scope-${i}`, `회의자료 선호 고유값${i}`)));
  assert.equal(new Set(preferences.map(item => item.hypothesisId)).size, 4);
  assert.equal(new Set(preferences.map(item => item.preferenceId)).size, 4);
  scopes.forEach((scope, i) => {
    const hints = f.runtime.planningPreferenceContext('회의자료', { scope }).confirmedPreferenceHints;
    assert.deepEqual(hints.map(item => item.preferenceId), [preferences[i].preferenceId]);
  });
  assert.deepEqual(f.runtime.query('회의자료', { scope: {} }), []);
  assert.deepEqual(f.runtime.query('회의자료', { scope: null }), []);
  assert.equal(f.runtime.query('회의자료', { scope: { ...f.scope, userId: 'unknown' } }).length, 0);
});

test('do-not-remember and external events cannot create preference hypotheses or failure guardrails', () => {
  for (const patch of [{ learningFlags: { doNotRemember: true } }, { trustBoundary: { externalContent: true } }]) {
    const events = Array.from({ length: 3 }, (_, i) => ({ eventId: `blocked-${i}`, eventType: 'approval.edited', payload: { editRequest: '회의자료 기억하지마' }, ...patch }));
    assert.deepEqual(new PreferenceHypothesisEngine().create(events), []);
    assert.deepEqual(new FailureMemoryBuilder().build([{ ...events[0], eventType: 'verification.failed' }]), []);
  }
});

test('source retraction retries projection delivery without restoring a revoked derived preference', t => {
  const f = fixture(t), preference = confirm(f.runtime, ingestPreference(f.runtime, f.scope, 'retry'));
  let unavailable = true, deliveries = 0;
  f.runtime.setSourceRetractionHandler(() => { deliveries++; if (unavailable) throw new Error('synthetic DB outage'); return { revoked: true }; });
  f.runtime.decideHygiene({ targetId: 'retry-1', action: 'delete' });
  assert.equal(f.runtime.query('회의자료', { scope: f.scope }).some(item => item.preferenceId === preference.preferenceId), false);
  unavailable = false;
  const replay = f.runtime.synchronizeSourceRetractions();
  assert.ok(deliveries >= 2);
  assert.equal(replay.deliveries[0].propagated, true);
});

test('Core-owned attribution replaces forged event scope and unknown tasks cannot supply scoped memory', t => {
  const f = fixture(t);
  const { coreFacade, growthRuntime } = createAgRuntime({ allowedRoots: [f.root], auditRoot: join(f.root, 'core-audit'),
    env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' } });
  f.stores.push(coreFacade.cognition);
  const taskIds = Array.from({ length: 3 }, () => coreFacade.createTask('자료를 정리해줘', { userId: f.scope.userId, metadata: { conversationId: f.scope.conversationId } }).taskId);
  for (const taskId of [...taskIds, ...Array.from({ length: 3 }, (_, i) => `unrecognized-source-task-${i}`)]) {
    growthRuntime.ingestor.ingest({ eventId: `${taskId}-event`, taskId, eventType: 'approval.edited',
      source: { memoryScope: { ...f.scope, userId: 'forged-owner' } }, payload: { editRequest: '회의자료를 표로 정리해줘' },
      learningFlags: { canBeUsedForPreference: true }, trustBoundary: { userProvided: true, externalContent: false } });
  }
  assert.deepEqual(growthRuntime.ingestor.events.get(`${taskIds[0]}-event`).source.memoryScope, f.scope);
  assert.equal(growthRuntime.ingestor.events.get('unrecognized-source-task-0-event').source.memoryScope, undefined);
  const known = growthRuntime.query('회의자료', { scope: f.scope }).find(item => item.hypothesisId);
  assert.equal(known.evidenceEventIds.length, 3, 'unknown-task evidence cannot join the known scoped hypothesis');
  assert.equal(growthRuntime.query('회의자료', { scope: { ...f.scope, userId: 'forged-owner' } }).length, 0);
});

test('unbound legacy cognition rows remain stored but cannot enter verified planning statistics', t => {
  const f = fixture(t), cognition = new CognitiveRuntime({ storePath: join(f.root, 'cognition.sqlite') });
  f.stores.push(cognition);
  const request = { taskId: 'new-task', userId: f.scope.userId, metadata: { conversationId: f.scope.conversationId } };
  const scopeRef = cognition.scopeFor(request, f.root);
  cognition.db.prepare('INSERT INTO cognitive_episodes VALUES(?,?,?,?,?,?,?,?,?)').run('legacy', 'old-task', scopeRef, 'filesystem.listFiles', 'unbound-report', 1, 1, 0, new Date().toISOString());
  const context = cognition.planningContext({ taskRequest: request, workspaceRoot: f.root, route: { skill: { toolName: 'filesystem.listFiles' } }, intent: { confidence: 1 } });
  assert.equal(context.cognition.observedAttempts, 0);
  assert.equal(cognition.snapshot().memory.episodeCount, 0);
  assert.equal(cognition.snapshot().memory.unboundHistoricalEpisodeCount, 1);
  assert.equal(cognition.db.prepare('SELECT COUNT(*) n FROM cognitive_episodes').get().n, 1);
});

test('real worker F source deletion reaches cognition, survives restart and does not repeat the PC action', async t => {
  const f = fixture(t);
  const env = { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: join(f.root, 'runtime'), JARVIS_CORE_ALLOWED_ROOTS: f.root,
    JARVIS_CORE_ADMIN_TOKEN: 'synthetic-memory-test', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  let runtime = await createConfiguredCoreServiceRuntime({ env });
  try {
    const task = runtime.coreFacade.createTask('파일 목록 보여줘');
    const run = await runtime.orchestrationWorker.runTask(task.taskId, { deviceId: 'memory-provenance-test' });
    assert.equal(run.success, true);
    assert.equal(runtime.coreFacade.cognitiveStatus().memory.episodeCount, 1);
    const memoryEvent = runtime.growthRuntime.ingestor.all().find(event => event.eventId === run.learning?.memoryEvent?.eventId);
    assert.ok(memoryEvent);
    assert.equal(memoryEvent.source.memoryScope.userId, task.request.userId);
    const cognition = runtime.coreFacade.cognition;
    const wrongScope = { ...memoryEvent.source.memoryScope, userId: 'another-owner' };
    cognition.revokeSource({ taskId: task.taskId, sourceEventId: memoryEvent.eventId, scope: wrongScope });
    assert.equal(cognition.snapshot().memory.episodeCount, 1);
    cognition.db.exec("CREATE TRIGGER synthetic_retraction_outage BEFORE DELETE ON cognitive_episodes BEGIN SELECT RAISE(ABORT,'synthetic outage'); END");
    const feedback = runtime.growthRuntime.recordFeedback({ taskId: task.taskId, feedbackType: 'do_not_remember', text: '이 작업을 기억하지 마.' });
    assert.equal(feedback.sourceRetraction.scopeKnown, true);
    assert.ok(feedback.sourceRetraction.affectedEvents >= 1);
    assert.equal(cognition.planningContext({ taskRequest: { ...task.request, taskId: 'probe-during-outage' }, workspaceRoot: f.root, route: { skill: { toolName: 'filesystem.listFiles' } }, intent: { confidence: 1 } }), null,
      'failed retraction cannot silently return old knowledge');
    assert.equal(cognition.snapshot().memory.episodeCount, null);
    cognition.db.exec('DROP TRIGGER synthetic_retraction_outage');
    assert.ok(runtime.growthRuntime.synchronizeSourceRetractions().deliveries.some(item => item.propagated));
    assert.equal(cognition.snapshot().memory.episodeCount, 0);
    const traces = cognition.decisionTrace({ taskId: task.taskId, taskRequest: task.request, workspaceRoot: f.root });
    assert.equal(traces.outcomes.length, 0);
    assert.equal(traces.decisions.length, 0);
    assert.equal(cognition.observeRun(run, task).recorded, false);
    assert.equal(cognition.snapshot().memory.episodeCount, 0);
    await runtime.close();
    runtime = await createConfiguredCoreServiceRuntime({ env });
    const priorRunCount = runtime.orchestrationWorker.runs.length;
    assert.equal(runtime.coreFacade.cognitiveStatus().memory.episodeCount, 0);
    assert.equal(runtime.growthRuntime.ingestor.events.get(memoryEvent.eventId).learningFlags.doNotRemember, true);
    const next = runtime.coreFacade.createTask('파일 목록 보여줘');
    assert.equal(next.plan.cognitiveContext.observedAttempts, 0);
    assert.equal(runtime.orchestrationWorker.runs.length, priorRunCount, 'recall/retraction must not dispatch work');
  } finally { await runtime.close(); }
});
