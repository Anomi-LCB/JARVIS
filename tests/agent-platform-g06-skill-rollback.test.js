import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SkillDraftRegistry } from '../apps/growth-memory/src/growth-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-platform-g06-skill-rollback.json', import.meta.url), 'utf8'));

test('G06 rolls back a regressed approved revision and quarantines its failed artifact', () => {
  const registry = new SkillDraftRegistry({ clock: () => new Date('2026-09-29T06:30:00.000Z') });
  const seeded = registry.review({ draftId: 'g06-seed', decidedBy: 'synthetic-fixture-reviewer',
    reason: 'initial fixed fixture approval', drafts: [{ distilledSkillId: 'g06-seed', title: fixture.title,
      suggestedSteps: fixture.initialSteps, styleHints: [], safetyConstraints: ['requires_user_review', 'requires_policy_check', 'no_sensitive_reconstruction'],
      confidence: 0.9, evidenceEventIds: ['fixture-source-1'] }] });
  assert.equal(seeded.success, true);
  const initialRevisionId = seeded.registryEntry.activeRevisionId;

  const created = registry.createRevision({ skillId: seeded.registryEntry.skillId,
    expectedActiveRevisionId: initialRevisionId, suggestedSteps: fixture.regressedSteps,
    createdBy: 'synthetic-fixture-reviewer', reason: 'regression injected on held-out material' });
  assert.equal(created.success, true);
  const failedRevisionId = created.revision.revisionId;
  assert.notEqual(failedRevisionId, initialRevisionId, 'same-clock revisions must never collide');
  assert.equal(registry.evaluateRevision({ skillId: seeded.registryEntry.skillId, revisionId: failedRevisionId }).revision.status, 'awaiting_user_review');
  assert.equal(registry.reviewRevision({ skillId: seeded.registryEntry.skillId, revisionId: failedRevisionId,
    decision: 'approve', decidedBy: 'synthetic-fixture-reviewer', reason: 'promotion path fixture' }).success, true);
  assert.equal(registry.promoteRevision({ skillId: seeded.registryEntry.skillId, revisionId: failedRevisionId,
    expectedActiveRevisionId: initialRevisionId, promotedBy: 'synthetic-fixture-reviewer', reason: 'controlled regression test' }).success, true);

  const failedArtifact = { status: 'quarantined', verified: false, completionClaimed: false,
    expectedValue: fixture.expectedValue, observedValue: fixture.observedValue };
  assert.equal(registry.rollbackRevision({ skillId: seeded.registryEntry.skillId, targetRevisionId: initialRevisionId,
    expectedActiveRevisionId: failedRevisionId, rolledBackBy: 'synthetic-fixture-reviewer', reason: 'held-out fixture detected regression' }).success, true);
  const status = registry.status([]).registryEntries.find(item => item.skillId === seeded.registryEntry.skillId);
  const evidence = { schemaVersion: 1, scenarioId: 'G06', fixtureId: fixture.fixtureId,
    registry: { initialRevisionId, beforeRevisionId: initialRevisionId, failedRevisionId,
      afterRevisionId: failedRevisionId, activeRevisionId: status.activeRevisionId,
      activeSteps: status.suggestedSteps, policy: status.policy,
      revisions: status.revisions.map(({ revisionId, parentRevisionId, version, status: revisionStatus }) =>
        ({ revisionId, parentRevisionId, version, status: revisionStatus })),
      rollbackEvent: status.lifecycleEvents.at(-1) },
    failedArtifact };
  const evidencePath = process.env.JARVIS_G06_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  assert.equal(status.activeRevisionId, initialRevisionId);
  assert.deepEqual(status.suggestedSteps, fixture.initialSteps);
  assert.equal(failedArtifact.status, 'quarantined');
});
