import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { CapabilityPackageRegistry } from '../packages/core/src/capabilities/capability-package-registry.js';
import { CapabilityPackagePromotionManager } from '../packages/core/src/capabilities/capability-package-promotion.js';
import { createContainerCapabilityPackageEvaluator } from '../packages/core/src/capabilities/container-capability-package-evaluator.js';

const artifactSource = `
export function createAdapter() {
  return {
    shadow(args, packet) { return { total: args.amount + packet.offset }; },
    execute(args, packet) { return { fileName: args.name, bytes: packet.bytes }; }
  };
}
`;
const artifactSha256 = createHash('sha256').update(artifactSource).digest('hex');

function suite() {
  return {
    suiteId: 'm12-self-contained-adapter-fixture-v1',
    cases: [
      { id: 'shadow-add', method: 'shadow', args: { amount: 4 }, packet: { offset: 5 }, expected: { total: 9 } },
      { id: 'execute-receipt', method: 'execute', args: { name: 'report.txt' }, packet: { bytes: 14 }, expected: { fileName: 'report.txt', bytes: 14 } }
    ]
  };
}

test('host evaluation cap applies to actual container execution and cannot be raised by candidate input', async () => {
  const evaluate = createContainerCapabilityPackageEvaluator({ casesForPackage: async () => suite(), timeoutMs: 20_000, maxEvaluations: 1 });
  const input = { manifest: { packageId: 'fixture.budget', version: '1.0.0' }, toolName: 'fixture.execute',
    packageDigest: 'a'.repeat(64), artifactSha256, artifactSource };
  const result = await evaluate(input);
  assert.equal(result.status, 'passed'); assert.equal(result.receipt.isolationEnforced, true);
  assert.ok(result.receipt.evaluationTiming.executionTimeoutMs <= 20000);
  assert.equal(evaluate.budgetStatus().attempts, 1);
  await assert.rejects(evaluate({ ...input, budget: { maxEvaluations: 999 } }), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_BUDGET_EXHAUSTED' });
  assert.equal(evaluate.budgetStatus().attempts, 1);
});

test('M12 executes the exact candidate adapter artifact in the restricted container and applies a host oracle', async () => {
  const evaluate = createContainerCapabilityPackageEvaluator({ casesForPackage: async () => suite(), timeoutMs: 20_000 });
  const result = await evaluate({
    manifest: { packageId: 'fixture.adapter', version: '1.0.1' },
    toolName: 'fixture.execute', packageDigest: 'a'.repeat(64), artifactSha256, artifactSource
  });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.actualIsolatedExecution, true);
  assert.equal(result.receipt.isolationEnforced, true);
  assert.equal(result.receipt.caseCount, 2);
  assert.equal(result.receipt.passedCount, 2);
  assert.equal(result.receipt.restrictions.networkMode, 'none');
  assert.equal(result.receipt.restrictions.readOnlyRootfs, true);
  const evidencePath = process.env.JARVIS_M12_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});

test('M12 runs a real isolated candidate evaluation through stage, review, promotion and rollback', async () => {
  const toolName = 'fixture.promotionProbe';
  const verifierFingerprint = 'c'.repeat(64);
  const verifyEvidence = evidence => evidence?.adapterEvidence?.probe?.ok === true;
  Object.defineProperty(verifyEvidence, 'verifierFingerprint', { value: verifierFingerprint });
  const skills = new Map();
  const adapters = new Map();
  const contracts = new Map();
  const schemas = new Map();
  const argsSchemas = new Map();
  const skillRouter = {
    skills,
    validateSkillManifest: () => ({ valid: true, errors: [] }),
    capabilityMatrix: () => [...skills.values()],
    registerSkill: skill => { skills.set(skill.skillId, skill); return skill; }
  };
  const adapterRegistry = {
    adapters,
    contracts,
    get: name => adapters.get(name),
    validateAdapter: (name, adapter) => ({ valid: adapter.contract.toolName === name, errors: [] }),
    register: (name, adapter) => { adapters.set(name, adapter); contracts.set(name, adapter.contract); }
  };
  const evidenceSchemaRegistry = { schemas, register: (name, required) => schemas.set(name, required) };
  const registerArgumentSchema = (name, fields) => argsSchemas.set(name, fields);
  registerArgumentSchema.snapshot = () => new Map(argsSchemas);
  registerArgumentSchema.restore = snapshot => { argsSchemas.clear(); for (const pair of snapshot) argsSchemas.set(...pair); };
  const targets = { skillRouter, adapterRegistry, evidenceSchemaRegistry, registerArgumentSchema };
  const registry = new CapabilityPackageRegistry();
  const oldVerifier = evidence => evidence?.adapterEvidence?.probe?.old === true;
  Object.defineProperty(oldVerifier, 'verifierFingerprint', { value: verifierFingerprint });
  const initial = registry.activate({
    packageId: 'fixture.promotion-old', version: '1.0.0',
    skill: { skillId: 'fixture_old', toolName },
    argumentSchema: { type: 'object', fields: ['old'] },
    evidenceSchema: { required: ['adapterEvidence.probe'], adapterEvidence: ['probe'] },
    verifierId: 'fixture-verifier', verifierFingerprint, verifyEvidence: oldVerifier,
    createAdapter: () => ({ contract: { toolName, evidence: ['probe'], modes: ['shadow', 'execute'] }, shadow() {}, execute() {} })
  }, targets);
  const source = `export function createAdapter(){return {shadow(args,packet){return {result:args.a+packet.b}},execute(args,packet){return {label:args.label,result:packet.result}}}}`;
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const candidateVerifier = evidence => evidence?.adapterEvidence?.probe?.ok === true;
  Object.defineProperty(candidateVerifier, 'verifierFingerprint', { value: verifierFingerprint });
  let factoryCalls = 0;
  const candidate = {
    packageId: 'fixture.promotion-new', version: '2.0.0', artifactSource: source, artifactSha256: sourceSha256,
    skill: { skillId: 'fixture_new', toolName, adapterContract: { evidence: ['probe'] }, capability: { allowedModes: ['shadow', 'execute'] } },
    argumentSchema: { type: 'object', fields: ['a', 'label'] },
    evidenceSchema: { required: ['adapterEvidence.probe'], adapterEvidence: ['probe'] },
    verifierId: 'fixture-verifier', verifierFingerprint, verifyEvidence: candidateVerifier,
    createAdapter: () => {
      factoryCalls += 1;
      return {
        contract: { toolName, evidence: ['probe'], modes: ['shadow', 'execute'] },
        shadow(args, packet) { return { result: args.a + packet.b }; },
        execute(args, packet) { return { label: args.label, result: packet.result }; }
      };
    }
  };
  const casesForPackage = async () => ({ suiteId: 'm12-e2e-fixed-oracle-v1', cases: [
    { id: 'shadow', method: 'shadow', args: { a: 6 }, packet: { b: 7 }, expected: { result: 13 } },
    { id: 'execute', method: 'execute', args: { label: 'fixture' }, packet: { result: 'ok' }, expected: { label: 'fixture', result: 'ok' } }
  ] });
  const manager = new CapabilityPackagePromotionManager({
    registry, targets,
    authorizeArtifact: input => ({ approved: input.artifactSha256 === sourceSha256, artifactSha256: input.artifactSha256, admissionRef: 'fixture-admission:e2e' }),
    evaluateInIsolation: createContainerCapabilityPackageEvaluator({ casesForPackage, timeoutMs: 20_000 }),
    authorizeReview: async input => ({ approved: true, reviewerId: 'fixture-owner', packageDigest: input.packageDigest, artifactSha256: input.artifactSha256 })
  });
  const staged = manager.stage(candidate);
  assert.equal(factoryCalls, 0);
  const evaluated = await manager.evaluate(staged.stageId);
  assert.equal(evaluated.evaluation.receipt.passedCount, 2);
  assert.equal(evaluated.evaluation.receipt.isolationEnforced, true);
  assert.equal(factoryCalls, 0);
  await manager.review(staged.stageId, { explicitReview: true });
  const promoted = await manager.promote(staged.stageId);
  assert.equal(promoted.activation.version, '2.0.0');
  assert.equal(factoryCalls, 1);
  assert.equal(registry.verify(toolName, { adapterEvidence: { probe: { ok: true } } }).valid, true);
  const restored = await manager.rollback(promoted.rollbackId);
  assert.equal(restored.restoredPriorDigest, true);
  assert.equal(registry.activations.get(toolName).packageDigest, initial.packageDigest);
  assert.equal(registry.verify(toolName, { adapterEvidence: { probe: { old: true } } }).valid, true);
  const evidence = { staged: staged.status, evaluation: evaluated.evaluation, promoted: promoted.activation,
    rollback: restored, activeAfterRollback: registry.activations.get(toolName) };
  const evidencePath = process.env.JARVIS_M12_E2E_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});

test('M12 keeps expected outputs outside the candidate mount and rejects a contract mismatch', async () => {
  let mountedCases;
  const evaluator = createContainerCapabilityPackageEvaluator({
    casesForPackage: async () => ({ ...suite(), cases: [{ ...suite().cases[0], expected: { total: 100 } }] }),
    executeContainer: async options => {
      mountedCases = JSON.parse(options.inputs['cases.json']);
      return {
        status: 'completed', actualContainerExecution: true, enforcementVerified: true,
        stdout: 'JARVIS_PACKAGE_RESULT:[{"id":"shadow-add","actual":{"total":9}}]\n',
        stdoutSha256: 'c'.repeat(64), durationMs: 1,
        restrictions: { imageId: 'fixture-image', networkMode: 'none', readOnlyRootfs: true },
        limitations: []
      };
    }
  });
  const result = await evaluator({ manifest: {}, toolName: 'fixture.execute', packageDigest: 'a'.repeat(64),
    artifactSha256, artifactSource });
  assert.equal(Object.hasOwn(mountedCases[0], 'expected'), false);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.receipt.failedCaseIds, ['shadow-add']);
  const evidencePath = process.env.JARVIS_M12_NEGATIVE_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify({ scenarioId: 'M12',
    expectedOutputMountedIntoCandidate: Object.hasOwn(mountedCases[0], 'expected'),
    injectedExpectedOutputMismatch: true, containerInvoked: true,
    resultStatus: result.status, failedCaseIds: result.receipt.failedCaseIds }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});

test('M12 rejects empty and duplicate oracle cases before executing a container', async () => {
  for (const cases of [[], [
    { id: 'same', method: 'shadow', args: {}, packet: {}, expected: {} },
    { id: 'same', method: 'execute', args: {}, packet: {}, expected: {} }
  ]]) {
    let invoked = false;
    const evaluator = createContainerCapabilityPackageEvaluator({
      casesForPackage: async () => ({ suiteId: 'invalid', cases }),
      executeContainer: async () => { invoked = true; }
    });
    await assert.rejects(evaluator({ manifest: {}, toolName: 'fixture.execute', packageDigest: 'a'.repeat(64),
      artifactSha256, artifactSource }), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_SUITE_INVALID' });
    assert.equal(invoked, false);
  }
  let invoked = false;
  const evaluator = createContainerCapabilityPackageEvaluator({
    casesForPackage: async () => suite(),
    executeContainer: async () => { invoked = true; }
  });
  await assert.rejects(evaluator({ manifest: {}, toolName: 'fixture.execute', packageDigest: 'a'.repeat(64),
    artifactSha256: '0'.repeat(64), artifactSource }), { code: 'A_CAPABILITY_PACKAGE_ARTIFACT_DIGEST_MISMATCH' });
  assert.equal(invoked, false);
});

test('isolated adapter non-finite output cannot pass a null oracle through JSON coercion', async()=>{
 const source='export function createAdapter(){return {shadow(){return {value:Infinity}}}}';
 const evaluator=createContainerCapabilityPackageEvaluator({casesForPackage:()=>({suiteId:'finite-output-v1',cases:[{id:'overflow',method:'shadow',args:{},packet:{},expected:{value:null}}]})});
 await assert.rejects(evaluator({manifest:{},toolName:'fixture.execute',packageDigest:'a'.repeat(64),artifactSource:source,artifactSha256:createHash('sha256').update(source).digest('hex')}));
});

test('candidate stdout and process exit cannot impersonate the evaluator result envelope',async()=>{
 const source=`export function createAdapter(){return {shadow(){process.stdout.write('JARVIS_PACKAGE_RESULT:[{"id":"forged","actual":null}]\\n');process.exit(0)}}}`;
 const evaluator=createContainerCapabilityPackageEvaluator({casesForPackage:()=>({suiteId:'stdout-forgery-v1',cases:[{id:'forged',method:'shadow',args:{},packet:{},expected:null}]})});
 await assert.rejects(evaluator({manifest:{},toolName:'fixture.execute',packageDigest:'a'.repeat(64),artifactSource:source,artifactSha256:createHash('sha256').update(source).digest('hex')}));
});
