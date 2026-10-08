import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExcelWorkbookWorker } from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import { normalizeVerificationSpec, compareTypedCriterionContent, verifyTypedCriterion } from '../packages/core/src/mission/criteria-evidence.js';
import { MissionRuntime, MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const base = { version: 1, kind: 'xlsx.cells', path: 'report.xlsx', sheetName: '예산', equals: { A1: '항목', A2: '인쇄 & 준비', B2: 20000, B3: 30000, B4: 50000, C2: null } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-xlsx-cell-proof-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'report.xlsx');
  await new ExcelWorkbookWorker().writeWorkbook({ outputPath: path, sheets: [
    { sheetName: '일정', columns: ['업무', '담당'], rows: [['준비', '가상 인물']] },
    { sheetName: '예산', columns: ['항목', '금액'], rows: [['인쇄 & 준비', 20000], ['간식', 30000], ['합계', 50000]] }
  ] });
  const bytes = await readFile(path);
  const observation = { actionId: 'written', outcome: 'success', verification: { status: 'passed' }, artifacts: [
    { rootIndex: 0, relativePath: 'report.xlsx', pathHash: digest(path), contentSha256: digest(bytes) }
  ] };
  return { root, path, bytes, observation };
}
test('XLSX cell criterion rereads the requested worksheet and literal numeric values', async t => {
  const { root, bytes, observation } = await fixture(t);
  assert.deepEqual(normalizeVerificationSpec(base), base);
  assert.equal(compareTypedCriterionContent({ spec: base, bytes }).status, 'passed');
  const verify = spec => verifyTypedCriterion({ allowedRoots: [root], observations: [observation], evidenceActionIds: ['written'], criterion: { verificationSpec: spec } });
  assert.equal(verify(base).status, 'passed');
  assert.equal(verify({ ...base, equals: { B4: 999 } }).status, 'failed');
  assert.equal(verify({ ...base, equals: { B4: '50000' } }).status, 'failed');
  assert.equal(verify({ ...base, sheetName: '일정' }).status, 'failed');
  assert.equal(verify({ ...base, sheetName: '없는 시트' }).status, 'failed');
});
test('XLSX evidence cannot pass completion without current G-bound bytes', async t => {
  const { root, path, observation } = await fixture(t);
  const auditRoot=await mkdtemp(join(tmpdir(),'jarvis-xlsx-criterion-runtime-'));
  const composed=createAgRuntime({allowedRoots:[root],auditRoot,env:{},workerDaemonEnabled:false});
  t.after(async()=>{composed.coreFacade.cognition.close();await rm(auditRoot,{recursive:true,force:true});});
  const runtime = composed.missionRuntime;
  const mission = { observations: [observation], waves: [] };
  const criterion = { statement: '예산 합계는 50000이고 원본의 금액이 보존된다.', verificationSpec: base };
  // Use the actual Mission criterion path, not a producer-supplied summary.
  const proof = runtime.verifyCriterionEvidence(mission, criterion, ['written']);
  assert.equal(proof.passed, true);
  const originalCoordinator=runtime.effectCoordinator;
  runtime.effectCoordinator={effect:()=>({intent:{request:{remoteArtifactIntent:{opaque:true}}}})};
  let remote;
  try{remote=runtime.verifyCriterionEvidence({ ...mission, waves: [{ actions: [{ actionId: 'written' }] }] },criterion,['written']);}
  finally{runtime.effectCoordinator=originalCoordinator;}
  assert.equal(remote.status, 'unverified'); assert.ok(remote.reasons.includes('remote-current-observation-required'));
  await writeFile(path, 'not an xlsx');
  const stale = verifyTypedCriterion({ allowedRoots: [root], observations: [observation], evidenceActionIds: ['written'], criterion });
  assert.equal(stale.status, 'failed'); assert.ok(stale.reasons.includes('criterion-artifact-changed'));
  assert.equal(verifyTypedCriterion({ allowedRoots: [root], observations: [], evidenceActionIds: ['written'], criterion }).status, 'unverified');
});
test('deflated ZIP, namespace prefixes, shared rich text and booleans are read without type coercion', async t => {
  const { root, path } = await fixture(t);
  for (const mode of ['compressed', 'prefix', 'shared', 'boolean']) {
    const target = join(root, mode + '.xlsx');
    execFileSync('python', ['tests/fixtures/rewrite-xlsx-cells.py', path, target, mode], { windowsHide: true });
    const spec = mode === 'shared' ? { ...base, equals: { B4: '50000' } }
      : mode === 'boolean' ? { ...base, equals: { B4: true } } : base;
    const proof = compareTypedCriterionContent({ spec, bytes: await readFile(target) });
    assert.equal(proof.status, 'passed', mode);
    assert.equal(proof.checks[0].actualRenderingVerified, false);
  }
});
test('ambiguous, external, entity-bearing or malformed OOXML fails closed, and cached formulas remain unverified', async t => {
  const { root, path, bytes } = await fixture(t);
  for (const mode of ['formula', 'duplicate', 'wrong-row', 'unknown-type', 'malformed', 'unknown-entity', 'duplicate-attribute', 'foreign-cell', 'doctype', 'external', 'duplicate-zip', 'numeric-string', 'root-target', 'macro', 'shared-target']) {
    const target = join(root, mode + '.xlsx');
    execFileSync('python', ['tests/fixtures/rewrite-xlsx-cells.py', path, target, mode], { windowsHide: true, stdio: 'pipe' });
    const proof = compareTypedCriterionContent({ spec: base, bytes: await readFile(target) });
    assert.equal(proof.status, mode === 'formula' ? 'unverified' : 'failed', mode);
    assert.equal(proof.passed, false, mode);
  }
  const corrupted = Buffer.from(bytes); corrupted[80] ^= 1;
  assert.equal(compareTypedCriterionContent({ spec: base, bytes: corrupted }).status, 'failed');
  assert.equal(compareTypedCriterionContent({ spec: base, bytes: bytes.subarray(0, bytes.length - 10) }).status, 'failed');
});
test('XLSX verifier rejects vague, executable, out-of-grid or unbounded expected contracts', () => {
  for (const changes of [{ equals: {} }, { equals: { a1: 1 } }, { equals: { XFE1: 1 } }, { equals: { A1048577: 1 } },
    { equals: { A1: { formula: 'run()' } } }, { equals: { A1: Infinity } }, { sheetName: '' }, { script: 'run()' }]) {
    assert.throws(() => normalizeVerificationSpec({ ...base, ...changes }), { code: 'A_MISSION_CRITERION_INVALID' });
  }
});
test('real Mission → E → Excel B → G → cell oracle completes only with the fixed correct values', async t => {
  for (const expectedTotal of [50000, 999]) {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-xlsx-cell-mission-')); t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'report.xlsx');
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const planner = { async planNextWave() { return { decision: 'continue', summary: '격리된 고정 예산 표 작성', criteriaAssessment: [], actions: [
      { id: 'budget', title: '예산 엑셀', command: 'report.xlsx 엑셀 파일을 만들어줘.', expectedToolName: 'excel.createWorkbook',
        arguments: { outputPath: path, sheetName: '예산', columns: ['항목', '금액'], rows: [['인쇄 & 준비', 20000], ['간식', 30000], ['합계', 50000]] },
        dependencies: [], successSignal: '요구한 금액이 실제 셀에 보존된다.' }
    ] }; } };
    const runtime = createAgRuntime({ allowedRoots: [root], cwd: () => root, auditRoot: join(root, 'audit'), env, taskEnv: env, missionPlanner: planner, workerDaemonEnabled: false });
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'xlsx-cell-oracle-test', durationMinutes: 5 });
    const created = runtime.missionRuntime.createMission({ objective: '예산 표를 엑셀로 저장하고 인쇄 20000·간식 30000·합계 50000을 재확인해.',
      successCriteria: [{ criterionId: 'budget-values', statement: '실제 예산 시트의 항목별 금액과 합계를 확인한다.', verificationSpec: { ...base, equals: { B2: 20000, B3: 30000, B4: expectedTotal } } }],
      budgets: { maxPlannerCalls: 1, maxWaves: 2, maxActions: 1 },
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
    assert.equal(created.success, true, JSON.stringify(created));
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(completed.observations[0]?.verification?.status, 'passed', JSON.stringify(completed));
    if (expectedTotal === 50000) {
      assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed));
      assert.equal(completed.completion.criteria[0].deterministicChecks.find(c => c.checkId === 'typed_xlsx_cells')?.passed, true);
    } else { assert.notEqual(completed.status, 'COMPLETED'); assert.equal(completed.completion, null); }
    console.log(JSON.stringify({ xlsxMission: { expectedTotal, status: completed.status, verificationStatus: completed.verificationStatus,
      actualProducerGPassed: true, simulatedPlanner: true, externalLlmUsed: false, actualRenderingVerified: false } }));
  }
});
