import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createLocalWorkflowCapabilityPackage } from '../apps/runtime-compose/src/workflow-capability-package.js';

test('composed runtime host cap blocks a second actual isolated evaluation without changing the active package', async () => {
  const runtime = createAgRuntime({ capabilityPackageEvaluationMaxCalls: 1, capabilityPackageEvaluationTimeoutMs: 20_000,
    capabilityPackageArtifactAuthorizer: input => ({ approved: true, artifactSha256: input.artifactSha256, admissionRef: 'synthetic:budget-artifact' }),
    capabilityPackageEvaluationCases: async () => ({ suiteId: 'runtime-budget-fixed', cases: [
      { id: 'one', method: 'execute', args: {}, packet: {}, expected: 42 }
    ] })
  });
  try {
    const active = runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
    const createCandidate = version => {
      const candidate = createLocalWorkflowCapabilityPackage();
      candidate.packageId = 'jarvis.local-workflow-budget-' + version; candidate.version = version;
      candidate.skill = { ...candidate.skill, skillId: 'synthetic_budget_' + version.replaceAll('.', '_'), version };
      candidate.artifactSource = 'export function createAdapter(){return {execute(){return 42}}}';
      candidate.artifactSha256 = createHash('sha256').update(candidate.artifactSource).digest('hex'); return candidate;
    };
    const first = runtime.capabilityPackagePromotionManager.stage(createCandidate('1.4.0'));
    const evaluated = await runtime.capabilityPackagePromotionManager.evaluate(first.stageId);
    assert.equal(evaluated.evaluation.receipt.isolationEnforced, true);
    const second = runtime.capabilityPackagePromotionManager.stage(createCandidate('1.5.0'));
    await assert.rejects(runtime.capabilityPackagePromotionManager.evaluate(second.stageId), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_BUDGET_EXHAUSTED' });
    assert.equal(runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest, active);
    assert.equal(runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts, 1);
  } finally { runtime.coreFacade.cognition.close(); }
});

test('composed runtime keeps the admitted permission contract when caller data changes inside admission', async () => {
  let candidate, evaluated;
  const runtime = createAgRuntime({
    capabilityPackageArtifactAuthorizer: input => {
      candidate.skill.budget = { unlimited: true };
      candidate.skill.capability.allowedModes.push('unrestricted');
      return { approved: true, artifactSha256: input.artifactSha256, admissionRef: 'synthetic:runtime-snapshot' };
    },
    capabilityPackageEvaluator: async input => {
      evaluated = input.manifest;
      return { status: 'passed', actualIsolatedExecution: true, packageDigest: input.packageDigest,
        artifactSha256: input.artifactSha256, evidenceRef: 'synthetic:contract-only' };
    }
  });
  try {
    candidate = createLocalWorkflowCapabilityPackage();
    candidate.packageId = 'jarvis.local-workflow-admission-snapshot'; candidate.version = '1.3.0';
    candidate.skill = { ...candidate.skill, skillId: 'local_workflow_admission_snapshot', version: candidate.version };
    candidate.artifactSource = 'export const synthetic = true;';
    candidate.artifactSha256 = createHash('sha256').update(candidate.artifactSource).digest('hex');
    const expected = structuredClone(candidate.skill);
    const staged = runtime.capabilityPackagePromotionManager.stage(candidate);
    await runtime.capabilityPackagePromotionManager.evaluate(staged.stageId);
    assert.deepEqual(evaluated.skill, expected);
    const owner = runtime.personalOwnerSession.activate({ grants: ['high_impact'] });
    await runtime.capabilityPackagePromotionManager.review(staged.stageId, {
      ownerSessionId: owner.session.sessionId, deviceId: 'synthetic-test', remoteAddress: '127.0.0.1'
    });
    const promoted = await runtime.capabilityPackagePromotionManager.promote(staged.stageId);
    assert.equal(promoted.status, 'promoted');
    assert.deepEqual(runtime.capabilityPackageRegistry.packages.get(candidate.packageId)._definition.skill, expected);
  } finally { runtime.coreFacade.cognition.close(); }
});

test('composed runtime rejects permission widening before artifact admission or candidate execution', () => {
  let admissions = 0, executions = 0;
  const runtime = createAgRuntime({
    capabilityPackageArtifactAuthorizer: () => { admissions++; return { approved: true }; }
  });
  const candidate = createLocalWorkflowCapabilityPackage();
  candidate.packageId = 'test.forbidden-widening'; candidate.version = '1.1.0';
  candidate.skill = { ...candidate.skill, capability: { ...candidate.skill.capability, allowedModes: ['shadow','execute','unrestricted'] } };
  candidate.createAdapter = () => { executions++; throw new Error('must not execute'); };
  assert.throws(() => runtime.capabilityPackagePromotionManager.stage(candidate), { code: 'A_CAPABILITY_PACKAGE_PROTECTED_CONTRACT_CHANGED' });
  assert.equal(admissions, 0); assert.equal(executions, 0);
  assert.equal(runtime.capabilityPackagePromotionManager.status().inMemoryStageCount, 0);
});

test('default runtime promotion authority is bound to the active local owner session', async () => {
  const runtime = createAgRuntime({
    capabilityPackageArtifactAuthorizer: input => ({
      approved: true, artifactSha256: input.artifactSha256, admissionRef: 'runtime-test:admitted'
    }),
    capabilityPackageEvaluator: async input => ({
      status: 'passed', actualIsolatedExecution: true, packageDigest: input.packageDigest,
      artifactSha256: input.artifactSha256, evidenceRef: 'runtime-test:evaluation'
    })
  });
  const candidate = createLocalWorkflowCapabilityPackage();
  candidate.packageId = 'jarvis.local-workflow-review-integration';
  candidate.version = '1.2.0';
  candidate.skill = { ...candidate.skill, skillId: 'local_workflow_review_integration', version: candidate.version };
  candidate.artifactSource = 'export const candidate = true;';
  candidate.artifactSha256 = createHash('sha256').update(candidate.artifactSource).digest('hex');
  const staged = runtime.capabilityPackagePromotionManager.stage(candidate);
  await runtime.capabilityPackagePromotionManager.evaluate(staged.stageId);
  await assert.rejects(runtime.capabilityPackagePromotionManager.review(staged.stageId, {
    ownerSessionId: 'unrecognized-session', deviceId: 'local-test', remoteAddress: '127.0.0.1'
  }), { code: 'A_CAPABILITY_PACKAGE_REVIEW_DENIED' });

  const owner = runtime.personalOwnerSession.activate({ grants: ['high_impact'] });
  const reviewed = await runtime.capabilityPackagePromotionManager.review(staged.stageId, {
    ownerSessionId: owner.session.sessionId, deviceId: 'local-test', remoteAddress: '127.0.0.1'
  });
  assert.equal(reviewed.status, 'reviewed');
  runtime.capabilityPackagePromotionManager.authorizeReview = async input => {
    const decision = runtime.personalOwnerSession.authorizeCapabilityPackageReview({
      action: input.action,
      sessionId: input.reviewContext?.ownerSessionId,
      packageDigest: input.packageDigest,
      artifactSha256: input.artifactSha256,
      deviceId: input.reviewContext?.deviceId,
      remoteAddress: input.reviewContext?.remoteAddress
    });
    if (input.action === 'promote') runtime.personalOwnerSession.revoke({ reason: 'authorization-race-test' });
    return { approved: decision.allowed, reviewerId: decision.reviewerId,
      packageDigest: decision.packageDigest, artifactSha256: decision.artifactSha256 };
  };
  await assert.rejects(runtime.capabilityPackagePromotionManager.promote(staged.stageId), {
    code: 'A_CAPABILITY_PACKAGE_REVIEW_AUTHORIZATION_EXPIRED'
  });
});

test('required durable promotion journal fails closed when no signer or journal is configured', () => {
  const runtime = createAgRuntime({ capabilityPackagePromotionJournalRequired: true });
  assert.equal(['unavailable', 'not-configured'].includes(runtime.capabilityPackagePromotionManager.status().lifecycleJournal.integrity), true);
  assert.throws(() => runtime.capabilityPackagePromotionManager.stage({}), {
    code: 'A_CAPABILITY_PACKAGE_JOURNAL_UNAVAILABLE'
  });
});
