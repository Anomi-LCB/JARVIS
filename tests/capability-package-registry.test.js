import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CapabilityPackageRegistry } from '../packages/core/src/capabilities/capability-package-registry.js';
import { CapabilityPackagePromotionManager } from '../packages/core/src/capabilities/capability-package-promotion.js';
import { createContainerCapabilityPackageEvaluator } from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
import { PersonalOwnerSessionManager } from '../packages/core/src/security/personal-owner-session.js';
import {
  missionArgumentFields,
  registerMissionArgumentSchema
} from '../packages/core/src/planning/mission-action-arguments.js';

const TEST_VERIFIER_FINGERPRINT = 'c'.repeat(64);

test('admission snapshot survives actual isolated evaluation, promotion and rollback without permission or budget widening', async () => {
  const registry = new CapabilityPackageRegistry(), t = targets();
  const initial = definition(), active = registry.activate(initial, t), candidate = improvementDefinition();
  candidate.artifactSource = "export function createAdapter(){return {shadow(){return {value:42}},execute(){return {value:42}}}}";
  candidate.artifactSha256 = createHash('sha256').update(candidate.artifactSource).digest('hex');
  candidate.createAdapter = () => ({ contract: { toolName: 'workflow.execute', evidence: ['workflow'], modes: ['shadow', 'execute'] },
    shadow() { return { value: 42 }; }, execute() { return { value: 42 }; } });
  const originalSkill = structuredClone(candidate.skill), originalEvidence = structuredClone(candidate.evidenceSchema);
  const manager = new CapabilityPackagePromotionManager({ registry, targets: t, protectImprovementContract: true,
    authorizeArtifact: input => {
      candidate.skill.capability = { allowedModes: ['execute'], scopes: ['*'] };
      candidate.skill.budget = { unlimited: true };
      candidate.evidenceSchema.required = ['weakerEvidence'];
      return { approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test:exact-synthetic-artifact' };
    },
    evaluateInIsolation: createContainerCapabilityPackageEvaluator({ timeoutMs: 20_000, casesForPackage: async () => ({
      suiteId: 'admission-snapshot-fixed-oracle', cases: [
        { id: 'shadow', method: 'shadow', args: {}, packet: {}, expected: { value: 42 } },
        { id: 'execute', method: 'execute', args: {}, packet: {}, expected: { value: 42 } }
      ] }) }),
    authorizeReview: async input => ({ approved: true, reviewerId: 'synthetic-owner', packageDigest: input.packageDigest, artifactSha256: input.artifactSha256 })
  });
  const staged = manager.stage(candidate), evaluated = await manager.evaluate(staged.stageId);
  assert.equal(evaluated.evaluation.receipt.isolationEnforced, true);
  assert.equal(evaluated.evaluation.receipt.restrictions.networkMode, 'none');
  assert.equal(evaluated.evaluation.receipt.passedCount, 2);
  await manager.review(staged.stageId); const promoted = await manager.promote(staged.stageId);
  assert.deepEqual(t.skills.at(-1), originalSkill);
  assert.deepEqual(t.schemas.get('workflow.execute'), originalEvidence.required);
  assert.deepEqual(t.adapters.get('workflow.execute').execute(), { value: 42 });
  assert.equal(registry.packages.get(candidate.packageId).verifyEvidence, initial.verifyEvidence);
  const rollback = await manager.rollback(promoted.rollbackId);
  assert.equal(rollback.activation.packageDigest, active.packageDigest);
});

for (const mutation of ['permission', 'budget', 'arguments', 'evidence']) {
  test(`staging snapshots the candidate before artifact admission callback mutation: ${mutation}`, async () => {
    const registry = new CapabilityPackageRegistry(), t = targets();
    const initial = definition(); registry.activate(initial, t);
    const candidate = improvementDefinition(), originalSkill = structuredClone(candidate.skill), originalArguments = structuredClone(candidate.argumentSchema), originalEvidence = structuredClone(candidate.evidenceSchema);
    let evaluatedManifest;
    const manager = new CapabilityPackagePromotionManager({ registry, targets: t, protectImprovementContract: true,
      authorizeArtifact: input => {
        if (mutation === 'permission') candidate.skill.capability = { allowedModes: ['execute'], scopes: ['*'] };
        if (mutation === 'budget') candidate.skill.budget = { unlimited: true };
        if (mutation === 'arguments') candidate.argumentSchema.fields.push('unreviewedCommand');
        if (mutation === 'evidence') candidate.evidenceSchema.required = ['weakerEvidence'];
        return { approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test:admission-snapshot' };
      },
      evaluateInIsolation: async input => {
        evaluatedManifest = input.manifest;
        return { status: 'passed', actualIsolatedExecution: true, packageDigest: input.packageDigest,
          artifactSha256: input.artifactSha256, evidenceRef: 'test:contract-only' };
      },
      authorizeReview: async input => ({ approved: true, reviewerId: 'test-owner', packageDigest: input.packageDigest, artifactSha256: input.artifactSha256 })
    });
    const staged = manager.stage(candidate);
    await manager.evaluate(staged.stageId); await manager.review(staged.stageId); await manager.promote(staged.stageId);
    assert.deepEqual(evaluatedManifest.skill, originalSkill);
    assert.deepEqual(evaluatedManifest.argumentSchema, originalArguments);
    assert.deepEqual(evaluatedManifest.evidenceSchema, originalEvidence);
    assert.deepEqual(t.skills.at(-1), originalSkill);
    assert.deepEqual(t.argumentsByTool.get('workflow.execute'), originalArguments.fields);
    assert.deepEqual(t.schemas.get('workflow.execute'), originalEvidence.required);
  });
}

test('improvement cannot weaken the evaluator, required evidence or permission contract', () => {
  for (const change of [
    d => { d.verifierId = 'always-pass'; },
    d => { d.verifierFingerprint = 'd'.repeat(64); },
    d => { d.evidenceSchema.required = []; },
    d => { d.skill.capability = { allowedModes: ['execute'], scopes: ['*'] }; },
    d => { d.skill.budget = { unlimited: true }; },
    d => { d.argumentSchema.fields = ['unreviewedCommand']; }
  ]) {
    const registry = new CapabilityPackageRegistry(), t = targets();
    const active = registry.activate(definition(), t);
    let admitted = 0;
    const manager = new CapabilityPackagePromotionManager({ registry, targets: t, protectImprovementContract: true,
      authorizeArtifact: () => { admitted++; return { approved: true }; }
    });
    const candidate = improvementDefinition(); change(candidate);
    assert.throws(() => manager.stage(candidate), { code: 'A_CAPABILITY_PACKAGE_PROTECTED_CONTRACT_CHANGED' });
    assert.equal(admitted, 0);
    assert.equal(registry.activations.get('workflow.execute').packageDigest, active.packageDigest);
    assert.equal(manager.status().inMemoryStageCount, 0);
  }
});

test('same-fingerprint always-pass candidate is replaced by the active trusted verifier', async () => {
  const registry = new CapabilityPackageRegistry(), t = targets(), initial = definition();
  registry.activate(initial, t);
  let admittedVerifier;
  const manager = new CapabilityPackagePromotionManager({ registry, targets: t, protectImprovementContract: true,
    authorizeArtifact: input => { admittedVerifier = input.verifyEvidence; return { approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test:fixed-verifier' }; },
    evaluateInIsolation: async input => ({ status: 'passed', actualIsolatedExecution: true, packageDigest: input.packageDigest, artifactSha256: input.artifactSha256, evidenceRef: 'test:contract-only' }),
    authorizeReview: async input => ({ approved: true, reviewerId: 'test-owner', packageDigest: input.packageDigest, artifactSha256: input.artifactSha256 })
  });
  const candidate = improvementDefinition();
  candidate.verifyEvidence = () => ({ valid: true });
  Object.defineProperty(candidate.verifyEvidence, 'verifierFingerprint', { value: TEST_VERIFIER_FINGERPRINT });
  const staged = manager.stage(candidate);
  assert.equal(admittedVerifier, initial.verifyEvidence);
  await manager.evaluate(staged.stageId); await manager.review(staged.stageId);
  await manager.promote(staged.stageId);
  const installed = registry.packages.get(candidate.packageId).verifyEvidence;
  assert.equal(installed, initial.verifyEvidence);
  assert.equal(installed({}).valid, false);
  assert.equal(installed({ adapterEvidence: { workflow: { status: 'verified' } } }).valid, true);
});

function targets({ failAt = null } = {}) {
  const skills = [];
  const adapters = new Map();
  const contracts = new Map();
  const schemas = new Map();
  const argumentsByTool = new Map();
  const maybeFail = (step) => {
    if (failAt === step) {
      const error = new Error(`injected-${step}-failure`);
      error.code = `INJECTED_${step.toUpperCase()}_FAILURE`;
      throw error;
    }
  };
  const skillRouter = {
    skills,
    validateSkillManifest: () => ({ valid: true, errors: [] }),
    capabilityMatrix: () => skills,
    registerSkill: (skill) => { skills.push(skill); maybeFail('skill'); return skill; }
  };
  const adapterRegistry = {
    adapters,
    contracts,
    validateAdapter: (toolName, adapter) => ({ valid: adapter.contract.toolName === toolName, errors: [] }),
    get: (toolName) => adapters.get(toolName),
    register: (toolName, adapter) => {
      adapters.set(toolName, adapter);
      contracts.set(toolName, adapter.contract);
      maybeFail('adapter');
    }
  };
  const evidenceSchemaRegistry = {
    schemas,
    register: (toolName, required) => { schemas.set(toolName, required); maybeFail('evidence'); }
  };
  const registerArgumentSchema = (toolName, fields) => {
    argumentsByTool.set(toolName, fields);
    maybeFail('arguments');
  };
  registerArgumentSchema.snapshot = () => new Map(argumentsByTool);
  registerArgumentSchema.restore = (snapshot) => {
    argumentsByTool.clear();
    for (const [toolName, fields] of snapshot) argumentsByTool.set(toolName, fields);
  };
  return {
    skills,
    adapters,
    contracts,
    schemas,
    argumentsByTool,
    skillRouter,
    adapterRegistry,
    evidenceSchemaRegistry,
    registerArgumentSchema
  };
}

function definition(toolName = 'workflow.execute') {
  const verifyEvidence = (evidence) => ({ valid: evidence?.adapterEvidence?.workflow?.status === 'verified' });
  Object.defineProperty(verifyEvidence, 'verifierFingerprint', { value: TEST_VERIFIER_FINGERPRINT });
  return {
    packageId: 'jarvis.local-workflow',
    version: '1.0.0',
    skill: { skillId: 'local_workflow', toolName },
    argumentSchema: { type: 'object', fields: ['specPath'] },
    evidenceSchema: { required: ['adapterEvidence.workflow'], adapterEvidence: ['workflow'] },
    verifierId: 'workflow-proof-v1',
    verifierFingerprint: TEST_VERIFIER_FINGERPRINT,
    verifyEvidence,
    createAdapter: () => ({
      contract: { toolName, evidence: ['workflow'], modes: ['shadow', 'execute'] },
      shadow() {},
      execute() {}
    })
  };
}

function replacementDefinition(version = '2.0.0', { failAdapter = false } = {}) {
  const next = definition();
  next.version = version;
  next.packageId = 'jarvis.local-workflow-next';
  next.skill = { ...next.skill, skillId: `local_workflow_${version.replaceAll('.', '_')}`, version };
  next.argumentSchema = { type: 'object', fields: ['specPath', 'mode'] };
  next.artifactSource = `export const version = '${version}';\n`;
  next.artifactSha256 = createHash('sha256').update(next.artifactSource).digest('hex');
  next.createAdapter = () => {
    if (failAdapter) throw Object.assign(new Error('candidate adapter construction failed'), { code: 'INJECTED_FACTORY_FAILURE' });
    return {
      contract: { toolName: 'workflow.execute', evidence: ['workflow'], modes: ['shadow', 'execute'] },
      shadow() {}, execute() {}
    };
  };
  return next;
}
function improvementDefinition(){const next=replacementDefinition();next.argumentSchema=definition().argumentSchema;return next;}

test('failed reevaluation preserves bound diagnostic receipt and invalidates the earlier review',async()=>{
 const registry=new CapabilityPackageRegistry(),t=targets();registry.activate(definition(),t);
 let passes=true;
 const manager=new CapabilityPackagePromotionManager({registry,targets:t,
  authorizeArtifact:i=>({approved:true,artifactSha256:i.artifactSha256,admissionRef:'synthetic:diagnostics'}),
  evaluateInIsolation:async i=>({status:passes?'passed':'failed',actualIsolatedExecution:true,packageDigest:i.packageDigest,artifactSha256:i.artifactSha256,evidenceRef:'synthetic:fixed-receipt',receipt:{diagnostic:'bound synthetic receipt, not actual Docker'}}),
  authorizeReview:async i=>({approved:true,reviewerId:'synthetic-owner',packageDigest:i.packageDigest,artifactSha256:i.artifactSha256})});
 const staged=manager.stage(replacementDefinition());await manager.evaluate(staged.stageId);await manager.review(staged.stageId);
 assert.ok(manager.getStage(staged.stageId).review);
 passes=false;await assert.rejects(manager.evaluate(staged.stageId),{code:'A_CAPABILITY_PACKAGE_ISOLATION_FAILED'});
 const failed=manager.getStage(staged.stageId);assert.equal(failed.review,null);assert.equal(failed.evaluation.status,'failed');assert.equal(failed.status,'evaluation_failed');
 failed.evaluation.status='passed';assert.equal(manager.getStage(staged.stageId).evaluation.status,'failed');
 await assert.rejects(manager.review(staged.stageId),{code:'A_CAPABILITY_PACKAGE_EVALUATION_REQUIRED'});
 await assert.rejects(manager.promote(staged.stageId),{code:'A_CAPABILITY_PACKAGE_REVIEW_REQUIRED'});
});

test('capability package activates every runtime projection together', () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  const activation = registry.activate(definition(), t);
  assert.equal(activation.status, 'active');
  assert.deepEqual(activation.projections, { skill: true, arguments: true, adapter: true, evidence: true, verifier: true });
  assert.equal(t.skills.length, 1);
  assert.equal(t.adapters.has('workflow.execute'), true);
  assert.deepEqual(t.schemas.get('workflow.execute'), ['adapterEvidence.workflow']);
  assert.deepEqual(t.argumentsByTool.get('workflow.execute'), ['specPath']);
  assert.equal(registry.status().ghostRouteCount, 0);
  assert.equal(registry.status().orphanAdapterCount, 0);
});

test('capability package rejects a manifest-adapter tool mismatch before mutation', () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  const invalid = definition();
  invalid.createAdapter = () => ({
    contract: { toolName: 'wrong.tool', evidence: ['workflow'], modes: ['execute'] },
    shadow() {},
    execute() {}
  });
  assert.throws(() => registry.activate(invalid, t), { code: 'A_CAPABILITY_PACKAGE_INVALID' });
  assert.equal(t.skills.length, 0);
  assert.equal(t.adapters.size, 0);
  assert.equal(t.schemas.size, 0);
  assert.equal(t.argumentsByTool.size, 0);
});

test('capability package rolls back every prior projection, including a mutate-then-throw argument registrar', () => {
  for (const failAt of ['skill', 'evidence', 'adapter', 'arguments']) {
    const registry = new CapabilityPackageRegistry();
    const t = targets({ failAt });
    assert.throws(() => registry.activate(definition(), t), {
      code: `INJECTED_${failAt.toUpperCase()}_FAILURE`
    });
    assert.equal(t.skills.length, 0, `${failAt}: skill projection leaked`);
    assert.equal(t.adapters.size, 0, `${failAt}: adapter projection leaked`);
    assert.equal(t.contracts.size, 0, `${failAt}: adapter contract leaked`);
    assert.equal(t.schemas.size, 0, `${failAt}: evidence schema leaked`);
    assert.equal(t.argumentsByTool.size, 0, `${failAt}: argument schema leaked`);
    assert.equal(registry.status().packageCount, 0, `${failAt}: activation record leaked`);
  }
});

test('one registry projects the same package into each distinct runtime target set', () => {
  const registry = new CapabilityPackageRegistry();
  const first = targets();
  const second = targets();

  const firstActivation = registry.activate(definition(), first);
  const secondActivation = registry.activate(definition(), second);

  for (const target of [first, second]) {
    assert.equal(target.skills.length, 1);
    assert.equal(target.adapters.has('workflow.execute'), true);
    assert.deepEqual(target.schemas.get('workflow.execute'), ['adapterEvidence.workflow']);
    assert.deepEqual(target.argumentsByTool.get('workflow.execute'), ['specPath']);
  }
  assert.equal(firstActivation.packageDigest, secondActivation.packageDigest);
  assert.equal(registry.status().packageCount, 1);
  assert.equal(registry.status().targetActivationCount, 2);

  registry.activate(definition(), second);
  assert.equal(second.skills.length, 1, 'same runtime activation must remain idempotent');
  assert.equal(registry.status().targetActivationCount, 2);
});

test('production mission argument registrar snapshot compensates a mutate-then-throw wrapper', () => {
  const toolName = 'workflow.atomicRollbackProbe';
  const original = registerMissionArgumentSchema.snapshot();
  const registrar = (...args) => {
    registerMissionArgumentSchema(...args);
    const error = new Error('injected-after-production-argument-mutation');
    error.code = 'INJECTED_ARGUMENTS_AFTER_MUTATION';
    throw error;
  };
  registrar.snapshot = registerMissionArgumentSchema.snapshot;
  registrar.restore = registerMissionArgumentSchema.restore;
  const t = targets();
  t.registerArgumentSchema = registrar;

  try {
    assert.throws(() => new CapabilityPackageRegistry().activate(definition(toolName), t), {
      code: 'INJECTED_ARGUMENTS_AFTER_MUTATION'
    });
    assert.equal(Object.hasOwn(missionArgumentFields, toolName), false);
    assert.equal(t.skills.length, 0);
    assert.equal(t.adapters.size, 0);
    assert.equal(t.schemas.size, 0);
  } finally {
    registerMissionArgumentSchema.restore(original);
  }
});

test('package digest rejects verifier replacement and retains the previously active projections', () => {
  const registry = new CapabilityPackageRegistry();
  const installed = targets();
  const active = registry.activate(definition(), installed);
  const activeAdapter = installed.adapters.get('workflow.execute');
  const replacement = definition();
  const replacementFingerprint = 'd'.repeat(64);
  const replacementVerifier = () => ({ valid: true, reasons: [] });
  Object.defineProperty(replacementVerifier, 'verifierFingerprint', { value: replacementFingerprint });
  replacement.verifierFingerprint = replacementFingerprint;
  replacement.verifyEvidence = replacementVerifier;

  assert.throws(() => registry.activate(replacement, installed), {
    code: 'A_CAPABILITY_PACKAGE_CONFLICT'
  });
  assert.equal(installed.skills.length, 1);
  assert.equal(installed.adapters.size, 1);
  assert.equal(installed.adapters.get('workflow.execute'), activeAdapter);
  assert.deepEqual(installed.schemas.get('workflow.execute'), ['adapterEvidence.workflow']);
  assert.deepEqual(installed.argumentsByTool.get('workflow.execute'), ['specPath']);
  assert.equal(registry.status().activations[0].packageDigest, active.packageDigest);
  assert.equal(registry.status().activations[0].status, 'active');
});

test('activated package keeps the verified function reference when the caller mutates its definition', () => {
  const registry = new CapabilityPackageRegistry();
  const activatedDefinition = definition();
  registry.activate(activatedDefinition, targets());
  const replacementVerifier = () => ({ valid: true, reasons: [] });
  Object.defineProperty(replacementVerifier, 'verifierFingerprint', { value: TEST_VERIFIER_FINGERPRINT });
  activatedDefinition.verifyEvidence = replacementVerifier;

  const result = registry.verify('workflow.execute', {
    adapterEvidence: { workflow: { status: 'tampered' } }
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.reasons, ['capability-evidence-rejected']);
});

test('one packageId cannot silently activate a different tool contract', () => {
  const registry = new CapabilityPackageRegistry();
  registry.activate(definition('workflow.execute'), targets());
  const untouched = targets();

  assert.throws(() => registry.activate(definition('workflow.executeAlternate'), untouched), {
    code: 'A_CAPABILITY_PACKAGE_ID_CONFLICT'
  });
  assert.equal(untouched.skills.length, 0);
  assert.equal(untouched.adapters.size, 0);
  assert.equal(untouched.schemas.size, 0);
  assert.equal(untouched.argumentsByTool.size, 0);
});

test('package code readiness does not imply account or device availability', () => {
  const now = new Date('2026-09-27T00:00:00.000Z');
  const registry = new CapabilityPackageRegistry({ clock: () => now });
  const activation = registry.activate(definition(), targets());
  const binding = { capabilityId: 'workflow.execute', providerId: 'local', scopes: [] };
  assert.equal(registry.status().readyCount, 1);
  assert.equal(registry.status().codeReadyCount, 1);
  assert.equal(registry.status().readyCountBasis, 'code-projections-only');
  assert.equal(registry.status().availability.liveAvailableCount, 0);
  assert.equal(registry.availabilityFor(binding).status, 'unknown');
  registry.recordAvailability({ ...binding, codeVersion: activation.packageDigest,
    observedAt: now.toISOString(), verificationLevel: 'synthetic' });
  assert.equal(registry.status().availability.liveAvailableCount, 0);
  const result = registry.recordAvailability({ ...binding, codeVersion: activation.packageDigest,
    observedAt: now.toISOString(), verificationLevel: 'live-execution', evidenceRef: 'run-1' });
  assert.equal(result.available, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(registry.status().availability.liveAvailableCount, 1);
  assert.equal(registry.status().availability.liveExecutionVerifiedCount, 1);
  assert.equal(registry.recordAvailability({ ...binding, capabilityId: 'not.activated',
    codeVersion: 'different', observedAt: now.toISOString(), verificationLevel: 'live-probe',
    evidenceRef: 'probe-2' }).available, false);
});

test('promotion stages without running the factory and requires isolated evidence plus explicit review', async () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  registry.activate(definition(), t);
  let factoryCalls = 0;
  const candidate = replacementDefinition();
  const originalFactory = candidate.createAdapter;
  candidate.createAdapter = (...args) => { factoryCalls += 1; return originalFactory(...args); };
  const manager = new CapabilityPackagePromotionManager({
    registry,
    targets: t,
    authorizeArtifact: input => ({ approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test-admission:fixture' }),
    evaluateInIsolation: async input => ({
      status: 'passed', actualIsolatedExecution: true, packageDigest: input.packageDigest,
      artifactSha256: input.artifactSha256, evidenceRef: 'isolated-run:test-1'
    }),
    authorizeReview: async () => ({ approved: false })
  });
  const staged = manager.stage(candidate);
  assert.equal(factoryCalls, 0);
  assert.equal(staged.status, 'staged');
  assert.equal(registry.activations.get('workflow.execute').version, '1.0.0');
  await manager.evaluate(staged.stageId);
  assert.equal(factoryCalls, 0);
  await assert.rejects(manager.review(staged.stageId), { code: 'A_CAPABILITY_PACKAGE_REVIEW_DENIED' });
  assert.equal(registry.activations.get('workflow.execute').version, '1.0.0');
  assert.equal(t.skills.length, 1);
});

test('staged promotion uses digest-bound review, swaps projections, and restores the previous package', async () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  const lifecycleEvents = [];
  const journal = {
    fault: null,
    append: (eventType, payload) => { lifecycleEvents.push({ eventType, payload }); },
    status: () => ({ pendingTransitions: [] })
  };
  const initial = registry.activate(definition(), t);
  const initialAdapter = t.adapters.get('workflow.execute');
  const manager = new CapabilityPackagePromotionManager({
    registry,
    targets: t,
    authorizeArtifact: input => ({ approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test-admission:fixture' }),
    evaluateInIsolation: async input => ({
      status: 'passed', actualIsolatedExecution: true, packageDigest: input.packageDigest,
      artifactSha256: input.artifactSha256, evidenceRef: 'isolated-run:contract-42'
    }),
    authorizeReview: async input => ({ approved: true, reviewerId: 'owner:test', packageDigest: input.packageDigest, artifactSha256: input.artifactSha256 }),
    journal
  });
  const staged = manager.stage(replacementDefinition());
  await manager.evaluate(staged.stageId);
  await manager.review(staged.stageId, { reason: 'reviewed isolated package receipt' });
  const promoted = await manager.promote(staged.stageId);
  assert.equal(promoted.activation.version, '2.0.0');
  assert.notEqual(t.adapters.get('workflow.execute'), initialAdapter);
  assert.deepEqual(t.argumentsByTool.get('workflow.execute'), ['specPath', 'mode']);
  assert.equal(registry.verify('workflow.execute', { adapterEvidence: { workflow: { status: 'verified' } } }).valid, true);

  const rollback = await manager.rollback(promoted.rollbackId);
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(rollback.restoredPriorDigest, true);
  assert.equal(registry.activations.get('workflow.execute').packageDigest, initial.packageDigest);
  assert.equal(t.skills.length, 1);
  assert.equal(t.skills[0].skillId, 'local_workflow');
  assert.equal(t.adapters.get('workflow.execute').contract.toolName, 'workflow.execute');
  assert.deepEqual(t.argumentsByTool.get('workflow.execute'), ['specPath']);
  assert.equal(registry.verify('workflow.execute', { adapterEvidence: { workflow: { status: 'verified' } } }).valid, true);
  assert.deepEqual(lifecycleEvents.map(item => item.eventType), [
    'stage_created', 'evaluation_started', 'evaluation_passed', 'owner_reviewed', 'promotion_started', 'promotion_committed', 'rollback_started', 'rollback_committed'
  ]);
  assert.equal(JSON.stringify(lifecycleEvents).includes('ownerSessionId'), false);
});

test('failed replacement factory restores every active projection and the verifier record', async () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  const initial = registry.activate(definition(), t);
  const adapter = t.adapters.get('workflow.execute');
  const manager = new CapabilityPackagePromotionManager({
    registry,
    targets: t,
    authorizeArtifact: input => ({ approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test-admission:fixture' }),
    evaluateInIsolation: async input => ({ status: 'passed', actualIsolatedExecution: true,
      packageDigest: input.packageDigest, artifactSha256: input.artifactSha256, evidenceRef: 'isolated-run:pass' }),
    authorizeReview: async input => ({ approved: true, reviewerId: 'owner:test', packageDigest: input.packageDigest, artifactSha256: input.artifactSha256 })
  });
  const staged = manager.stage(replacementDefinition('2.0.0', { failAdapter: true }));
  await manager.evaluate(staged.stageId);
  await manager.review(staged.stageId);
  await assert.rejects(manager.promote(staged.stageId), { code: 'INJECTED_FACTORY_FAILURE' });
  assert.equal(registry.activations.get('workflow.execute').packageDigest, initial.packageDigest);
  assert.equal(t.skills.length, 1);
  assert.equal(t.adapters.get('workflow.execute'), adapter);
  assert.deepEqual(t.schemas.get('workflow.execute'), ['adapterEvidence.workflow']);
  assert.deepEqual(t.argumentsByTool.get('workflow.execute'), ['specPath']);
  assert.equal(registry.verify('workflow.execute', { adapterEvidence: { workflow: { status: 'verified' } } }).valid, true);
});

test('promotion fails closed for missing artifact digest, isolation receipt, or review authority', async () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  registry.activate(definition(), t);
  const candidate = replacementDefinition();
  candidate.artifactSha256 = '0'.repeat(64);
  const manager = new CapabilityPackagePromotionManager({ registry, targets: t,
    authorizeArtifact: input => ({ approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test-admission:fixture' }),
    evaluateInIsolation: async () => ({ status: 'passed', actualIsolatedExecution: true }),
    authorizeReview: async input => ({ approved: true, reviewerId: 'owner:test', packageDigest: input.packageDigest, artifactSha256: input.artifactSha256 }) });
  assert.throws(() => manager.stage(candidate), { code: 'A_CAPABILITY_PACKAGE_ARTIFACT_DIGEST_MISMATCH' });
  const stage = manager.stage(replacementDefinition('3.0.0'));
  await assert.rejects(manager.evaluate(stage.stageId), { code: 'A_CAPABILITY_PACKAGE_ISOLATION_FAILED' });
  await assert.rejects(manager.promote(stage.stageId), { code: 'A_CAPABILITY_PACKAGE_REVIEW_REQUIRED' });
});

test('review digest mismatch and stale active version cannot authorize a staged replacement', async () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  registry.activate(definition(), t);
  const manager = new CapabilityPackagePromotionManager({
    registry,
    targets: t,
    authorizeArtifact: input => ({ approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test-admission:fixture' }),
    evaluateInIsolation: async input => ({ status: 'passed', actualIsolatedExecution: true,
      packageDigest: input.packageDigest, artifactSha256: input.artifactSha256, evidenceRef: 'isolated-run:cas' }),
    authorizeReview: async input => ({ approved: true, reviewerId: 'owner:test',
      packageDigest: input.packageDigest, artifactSha256: 'f'.repeat(64) })
  });
  const stage = manager.stage(replacementDefinition());
  await manager.evaluate(stage.stageId);
  await assert.rejects(manager.review(stage.stageId), { code: 'A_CAPABILITY_PACKAGE_REVIEW_DENIED' });
  assert.equal(registry.activations.get('workflow.execute').version, '1.0.0');
});

test('owner session revocation blocks promotion and a fresh owner session can authorize promotion and rollback', async () => {
  const registry = new CapabilityPackageRegistry();
  const t = targets();
  registry.activate(definition(), t);
  const owner = new PersonalOwnerSessionManager();
  const manager = new CapabilityPackagePromotionManager({
    registry, targets: t,
    authorizeArtifact: input => ({ approved: true, artifactSha256: input.artifactSha256, admissionRef: 'test-admission:owner-session' }),
    evaluateInIsolation: async input => ({ status: 'passed', actualIsolatedExecution: true,
      packageDigest: input.packageDigest, artifactSha256: input.artifactSha256, evidenceRef: 'isolated-run:owner-session' }),
    authorizeReview: async input => {
      const decision = owner.authorizeCapabilityPackageReview({
        action: input.action,
        sessionId: input.reviewContext?.ownerSessionId,
        packageDigest: input.packageDigest,
        artifactSha256: input.artifactSha256,
        deviceId: input.reviewContext?.deviceId,
        remoteAddress: input.reviewContext?.remoteAddress
      });
      return { approved: decision.allowed, reviewerId: decision.reviewerId,
        packageDigest: decision.packageDigest, artifactSha256: decision.artifactSha256 };
    }
  });
  const staged = manager.stage(replacementDefinition());
  await manager.evaluate(staged.stageId);
  const first = owner.activate({ grants: ['high_impact'] });
  await manager.review(staged.stageId, { ownerSessionId: first.session.sessionId, deviceId: 'local-test' });
  owner.revoke();
  await assert.rejects(manager.promote(staged.stageId), { code: 'A_CAPABILITY_PACKAGE_REVIEW_AUTHORIZATION_EXPIRED' });
  assert.equal(registry.activations.get('workflow.execute').version, '1.0.0');

  const second = owner.activate({ grants: ['high_impact'] });
  await manager.review(staged.stageId, { ownerSessionId: second.session.sessionId, deviceId: 'local-test' });
  const promoted = await manager.promote(staged.stageId);
  const rollback = await manager.rollback(promoted.rollbackId, {
    ownerSessionId: second.session.sessionId, deviceId: 'local-test'
  });
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(rollback.restoredPriorDigest, true);
});
