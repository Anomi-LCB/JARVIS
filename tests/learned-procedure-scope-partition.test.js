import test from 'node:test';
import assert from 'node:assert/strict';
import { GrowthRuntime, PatternMiner } from '../apps/growth-memory/src/growth-runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('procedure mining and distillation keep identical commands and style evidence in their source scopes', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-procedure-partition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new GrowthRuntime({ auditRoot: root });
  const scopes = ['alice', 'bob'].map(userId => ({ userId, workspaceRoot: root, conversationId: null }));
  const preferences = new Map();
  for (const [index, scope] of scopes.entries()) {
    for (let count = 0; count < 3; count++) runtime.ingestor.ingest({ eventId: `${scope.userId}-${count}`, taskId: `${scope.userId}-task-${count}`,
      eventType: 'task.created', source: { memoryScope: scope }, payload: { rawText: '연구 자료를 읽고 근거를 정리해줘' },
      learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true, externalContent: false } });
    runtime.ingestor.ingest({ eventId: `${scope.userId}-style`, taskId: `${scope.userId}-style-task`, eventType: 'feedback.good',
      source: { memoryScope: scope }, payload: { text: index === 0 ? '간단 간단 간단' : '표 크게 굵게 강조' },
      trustBoundary: { userProvided: true, externalContent: false } });
    for (let count = 0; count < 3; count++) runtime.ingestor.ingest({ eventId: `${scope.userId}-preference-${count}`,
      taskId: `${scope.userId}-preference-task-${count}`, eventType: 'approval.edited', source: { memoryScope: scope },
      payload: { editRequest: '자료의 근거를 정리해줘' }, learningFlags: { canBeUsedForPreference: true },
      trustBoundary: { userProvided: true, externalContent: false } });
    const candidate = runtime.query('자료', { scope }).find(item => item.hypothesisId && !item.preferenceId);
    const result = runtime.decidePreference({ hypothesisId: candidate.hypothesisId, decision: 'confirm', decidedBy: scope.userId });
    assert.equal(result.success, true);
    preferences.set(scope.userId, result.item.preferenceId);
  }
  const advanced = runtime.advancedLearningModels();
  const draftIds = advanced.skillDistillations.map(item => item.distilledSkillId).sort();
  assert.equal(advanced.skillDistillations.length, 2);
  for (const scope of scopes) {
    const draft = advanced.skillDistillations.find(item => item.memoryScope?.userId === scope.userId);
    assert.ok(draft);
    assert.ok(draft.evidenceEventIds.every(id => id.startsWith(`${scope.userId}-`)));
    assert.deepEqual(draft.confirmedPreferenceIds, [preferences.get(scope.userId)]);
    assert.equal(draft.styleHints.some(hint => /표|시각|강조/.test(hint)), scope.userId === 'bob', JSON.stringify(draft.styleHints));
    assert.equal(runtime.reviewSkillDraft(draft.distilledSkillId, { decision: 'approve', decidedBy: scope.userId }).success, true);
    assert.equal(runtime.missionSkillGuidance('연구 자료를 읽고 근거를 정리해줘', { scope }).length, 1);
  }
  assert.deepEqual(runtime.advancedLearningModels().skillDistillations.map(item => item.distilledSkillId).sort(), draftIds,
    'repeated derivation retains scoped IDs and approved procedure binding');
});

test('cross-scope evidence cannot satisfy occurrence thresholds or penalize another owner', () => {
  const scopes = ['alice', 'bob'].map(userId => ({ userId, workspaceRoot: tmpdir(), conversationId: null }));
  const event = (scope, id, eventType = 'task.created') => ({ eventId: id, taskId: id, eventType,
    createdAt: '2026-09-30T00:00:00Z', source: { memoryScope: scope }, payload: { rawText: '연구 자료를 읽고 근거를 정리해줘' },
    learningFlags: {}, trustBoundary: {} });
  const events = scopes.flatMap(scope => [event(scope, `${scope.userId}-0`), event(scope, `${scope.userId}-1`)]);
  const miner = new PatternMiner();
  assert.deepEqual(miner.mine(events), [], 'two events each cannot combine into an approved repeated candidate');
  for (const scope of scopes) events.push(event(scope, `${scope.userId}-2`));
  events.push(event(scopes[0], 'alice-failed', 'execution.failed'));
  const patterns = miner.mine(events);
  assert.equal(patterns.length, 2);
  assert.deepEqual(patterns.find(item => item.memoryScope.userId === 'alice').negativeEvidence.eventIds, ['alice-failed']);
  assert.deepEqual(patterns.find(item => item.memoryScope.userId === 'bob').negativeEvidence.eventIds, []);
  assert.deepEqual(miner.mine([...events].reverse()).map(item => item.patternId).sort(), patterns.map(item => item.patternId).sort());
});
