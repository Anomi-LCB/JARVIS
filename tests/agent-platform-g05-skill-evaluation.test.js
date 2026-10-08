import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SkillDraftRegistry } from '../apps/growth-memory/src/growth-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-platform-g05-cross-material.json', import.meta.url), 'utf8'));

test('G05 keeps a skill draft non-executable until a renamed-column holdout passes, then requires review to promote', () => {
  const registry = new SkillDraftRegistry({ clock: () => new Date('2026-09-29T13:00:00.000Z') });
  const seeded = registry.review({ draftId: 'g05-demonstration-source', decidedBy: 'synthetic-owner', reason: 'captured demonstration procedure',
    drafts: [{ distilledSkillId: 'g05-demonstration-source', title: fixture.procedureDefinition.reportTitle,
      suggestedSteps: ['표의 그룹 열과 금액 열을 찾아 그룹별 합계를 계산한다.', '새 자료의 열 이름이 달라도 합계와 건수를 검산한다.'],
      styleHints: [], safetyConstraints: ['requires_user_review', 'requires_policy_check', 'no_sensitive_reconstruction'],
      confidence: 0.7, evidenceEventIds: ['g05-demo-source-hash'] }] });
  assert.equal(seeded.success, true);
  const baseRevisionId = seeded.registryEntry.activeRevisionId;

  const regressed = registry.createRevision({ skillId: seeded.registryEntry.skillId, expectedActiveRevisionId: baseRevisionId,
    suggestedSteps: ['그룹 열과 금액 열을 찾아 그룹별 합계를 계산한다.'],
    procedureDefinition: { ...fixture.procedureDefinition, valueAliases: ['Amount', '금액', '비용'] },
    reason: 'failure injection: holdout column alias omitted' });
  assert.equal(regressed.success, true);
  assert.equal(regressed.revision.status, 'draft');
  assert.equal(registry.reviewRevision({ skillId: seeded.registryEntry.skillId, revisionId: regressed.revision.revisionId,
    decision: 'approve' }).error.code, 'F_SKILL_REVISION_TRIALS_REQUIRED');
  const failedEval = registry.evaluateRevision({ skillId: seeded.registryEntry.skillId, revisionId: regressed.revision.revisionId,
    trialCases: fixture.cases });
  assert.equal(failedEval.success, true);
  assert.equal(failedEval.revision.status, 'evaluation_failed');
  assert.equal(failedEval.revision.evaluation.trialEvaluation.cases[1].status, 'failed');
  const activeRevisionIdAfterFailedTrial = registry.status([]).registryEntries
    .find(entry => entry.skillId === seeded.registryEntry.skillId).activeRevisionId;
  assert.equal(registry.reviewRevision({ skillId: seeded.registryEntry.skillId, revisionId: regressed.revision.revisionId,
    decision: 'approve' }).error.code, 'F_SKILL_REVISION_TRIALS_REQUIRED');
  assert.equal(registry.promoteRevision({ skillId: seeded.registryEntry.skillId, revisionId: regressed.revision.revisionId,
    expectedActiveRevisionId: baseRevisionId }).error.code, 'F_SKILL_REVISION_TRIALS_REQUIRED');

  const draft = registry.createRevision({ skillId: seeded.registryEntry.skillId, expectedActiveRevisionId: baseRevisionId,
    suggestedSteps: ['의미가 맞는 그룹 및 금액 열을 고른다.', '독립 자료의 그룹별 합계와 건수를 정답과 비교한다.'],
    procedureDefinition: fixture.procedureDefinition, reason: 'cross-material validation with renamed input headers' });
  assert.equal(draft.success, true);
  const noTrials = registry.evaluateRevision({ skillId: seeded.registryEntry.skillId, revisionId: draft.revision.revisionId });
  assert.equal(noTrials.success, false);
  assert.equal(noTrials.error.code, 'F_SKILL_REVISION_TRIALS_REQUIRED');
  const evaluated = registry.evaluateRevision({ skillId: seeded.registryEntry.skillId, revisionId: draft.revision.revisionId,
    trialCases: fixture.cases });
  assert.equal(evaluated.success, true);
  assert.equal(evaluated.revision.evaluation.mode, 'cross-material-deterministic-procedure-trials-v1');
  assert.equal(evaluated.revision.status, 'awaiting_user_review');
  assert.equal(evaluated.revision.evaluation.trialEvaluation.status, 'passed');
  assert.deepEqual(evaluated.revision.evaluation.trialEvaluation.checks.map(item => item.status), ['passed', 'passed', 'passed']);

  const ownerReview = registry.reviewRevision({ skillId: seeded.registryEntry.skillId, revisionId: draft.revision.revisionId,
    decision: 'approve', decidedBy: 'synthetic-owner', reason: 'reviewed cross-material output evidence' });
  assert.equal(ownerReview.success, true);
  const promoted = registry.promoteRevision({ skillId: seeded.registryEntry.skillId, revisionId: draft.revision.revisionId,
    expectedActiveRevisionId: baseRevisionId, promotedBy: 'synthetic-owner', reason: 'tested and explicitly reviewed' });
  assert.equal(promoted.success, true);
  assert.equal(promoted.registryEntry.activeRevisionId, draft.revision.revisionId);
  assert.equal(promoted.registryEntry.policy.executableByDefault, false);
  assert.equal(promoted.registryEntry.policy.requiresUserReview, true);

  const serialized = JSON.stringify(registry.status([]));
  assert.equal(serialized.includes('Education'), false, 'raw holdout values must not be stored in the skill registry');
  assert.equal(serialized.includes('Total KRW'), true, 'declared safe column aliases are procedure metadata, not trial rows');
  const evidence = {
    schemaVersion: 1, scenarioId: 'G05', fixtureId: fixture.fixtureId,
    registry: { skillId: seeded.registryEntry.skillId, baseRevisionId,
      failedRevision: { revisionId: failedEval.revision.revisionId, status: failedEval.revision.status,
        trialStatus: failedEval.revision.evaluation.trialEvaluation.status,
        holdoutStatus: failedEval.revision.evaluation.trialEvaluation.cases.find(item => item.split === 'holdout').status,
        activeRevisionIdAfterFailure: activeRevisionIdAfterFailedTrial },
      promotedRevision: { revisionId: promoted.activeRevision.revisionId, status: promoted.activeRevision.status,
        evaluation: promoted.activeRevision.evaluation, review: promoted.activeRevision.review },
      activeRevisionId: promoted.registryEntry.activeRevisionId, policy: promoted.registryEntry.policy,
      rawTrialValuesPersisted: serialized.includes('Education') },
    expectedCases: fixture.cases.map(item => ({ caseId: item.caseId, sourceId: item.sourceId, split: item.split,
      expectedRows: item.expectedRows })),
    procedureDefinition: fixture.procedureDefinition
  };
  const evidencePath = process.env.JARVIS_G05_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});
