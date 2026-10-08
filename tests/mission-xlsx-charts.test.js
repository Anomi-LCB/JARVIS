import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareTypedCriterionContent, normalizeVerificationSpec, verifyTypedCriterion } from '../packages/core/src/mission/criteria-evidence.js';
import { ExcelWorkbookWorker } from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const spec = { version: 1, kind: 'xlsx.charts', path: 'chart.xlsx', sheetName: "성과 O'Brien", equals: [
  { type: 'bar', title: '선택 실적', series: [
    { name: '매출', categoryFormula: "'성과 O''Brien'!$B$2:$B$3", valueFormula: "'성과 O''Brien'!$C$2:$C$3", categories: ['1월', '2월'], values: [100, 120] },
    { name: '이익', categoryFormula: "'성과 O''Brien'!$B$2:$B$3", valueFormula: "'성과 O''Brien'!$D$2:$D$3", categories: ['1월', '2월'], values: [10, -5] }
  ] }
] };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-chart-criterion-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'chart.xlsx');
  await new ExcelWorkbookWorker().writeWorkbook({ outputPath: path, sheetName: spec.sheetName, columns: ['제외', '월', '매출', '이익'], rows: [['x', '1월', 100, 10], ['y', '2월', 120, -5], ['z', '3월', 90, 12]], charts: [{ type: 'bar', title: '선택 실적', range: 'B1:D3' }], ...options });
  const bytes = await readFile(path), observation = { actionId: 'chart', outcome: 'success', verification: { status: 'passed' }, artifacts: [
    { rootIndex: 0, relativePath: 'chart.xlsx', pathHash: hash(path), contentSha256: hash(bytes) }
  ] };
  return { root, path, bytes, observation };
}
test('chart criteria compare attached chart type, title, exact references, all series and actual cells', async t => {
  const { bytes } = await fixture(t);
  assert.deepEqual(normalizeVerificationSpec(spec), spec);
  assert.equal(compareTypedCriterionContent({ spec, bytes }).status, 'passed');
  for (const change of [chart => { chart.type = 'line'; }, chart => { chart.title = '다른 제목'; }, chart => { chart.series.pop(); },
    chart => { chart.series[0].values[1] = 999; }, chart => { chart.series[0].valueFormula = "'성과 O''Brien'!$C$2:$C$4"; }]) {
    const wrong = structuredClone(spec); change(wrong.equals[0]); assert.equal(compareTypedCriterionContent({ spec: wrong, bytes }).status, 'failed');
  }
});
test('chart criterion uses the existing G digest and physical file identity instead of a producer claim', async t => {
  const { root, path, observation } = await fixture(t);
  const verify = observations => verifyTypedCriterion({ allowedRoots: [root], observations, evidenceActionIds: ['chart'], criterion: { verificationSpec: spec } });
  assert.equal(verify([observation]).status, 'passed');
  const remote = MissionRuntime.prototype.verifyCriterionEvidence.call({ allowedRoots: [root], effectCoordinator: { effect: () => ({ intent: { request: { remoteArtifactIntent: { opaque: true } } } }) } },
    { observations: [observation], waves: [{ actions: [{ actionId: 'chart' }] }] }, { statement: '차트 대조', verificationSpec: spec }, ['chart']);
  assert.equal(remote.status, 'unverified'); assert.ok(remote.reasons.includes('remote-current-observation-required'));
  assert.equal(verify([]).status, 'unverified');
  await writeFile(path, 'changed'); assert.equal(verify([observation]).status, 'failed');
});
test('fresh ZIP CRC cannot disguise stale caches, changed cells, detached or external charts', async t => {
  const { root, path } = await fixture(t);
  for (const mode of ['cache', 'cache-index', 'cache-count', 'series-index', 'external-formula', 'no-drawing', 'cell', 'formula-cell', 'external-drawing', 'external-chart', 'duplicate-chart', 'mixed-source']) {
    const target = join(root, mode + '.xlsx');
    execFileSync('python', ['tests/fixtures/rewrite-xlsx-charts.py', path, target, mode], { windowsHide: true, stdio: 'pipe' });
    const proof = compareTypedCriterionContent({ spec, bytes: await readFile(target) });
    assert.equal(proof.status, mode === 'formula-cell' ? 'unverified' : 'failed', mode);
    if (['cache', 'cell'].includes(mode)) assert.ok(proof.reasons.includes('criterion-xlsx-chart-cache-mismatch'), mode);
  }
});
test('explicit count charts reread the hidden derived cells while retaining original statuses', async t => {
  const { bytes } = await fixture(t, { sheetName: '보고서', columns: ['이름', '상태'], rows: [['A', '완료'], ['B', '대기'], ['C', '완료']],
    charts: [{ type: 'bar', title: '상태 건수', range: 'A1:B4', aggregation: 'count' }] });
  const expected = { ...spec, sheetName: '보고서', equals: [{ type: 'bar', title: '상태 건수', series: [{ name: '건수',
    categoryFormula: "'_JARVIS_차트_1'!$A$2:$A$3", valueFormula: "'_JARVIS_차트_1'!$B$2:$B$3", categories: ['완료', '대기'], values: [2, 1] }] }] };
  assert.equal(compareTypedCriterionContent({ spec: expected, bytes }).status, 'passed');
  assert.equal(compareTypedCriterionContent({ spec: { version: 1, kind: 'xlsx.cells', path: 'chart.xlsx', sheetName: '보고서', equals: { B2: '완료', B3: '대기', B4: '완료' } }, bytes }).status, 'passed');
});
test('line and pie data are checked separately and missing or extra charts do not pass', async t => {
  const { bytes } = await fixture(t, { sheetName: '실적', columns: ['월', '실적'], rows: [['1월', 0], ['2월', 2], ['3월', 10]], charts: [{ type: 'line', title: '추세', range: 'A1:B3' }, { type: 'pie', title: '비율', range: 'A1:B4' }] });
  const expected = { ...spec, sheetName: '실적', equals: [
    { type: 'line', title: '추세', series: [{ name: '실적', categoryFormula: "'실적'!$A$2:$A$3", valueFormula: "'실적'!$B$2:$B$3", categories: ['1월', '2월'], values: [0, 2] }] },
    { type: 'pie', title: '비율', series: [{ name: '실적', categoryFormula: "'실적'!$A$2:$A$4", valueFormula: "'실적'!$B$2:$B$4", categories: ['1월', '2월', '3월'], values: [0, 2, 10] }] }
  ] };
  assert.equal(compareTypedCriterionContent({ spec: expected, bytes }).status, 'passed');
  assert.equal(compareTypedCriterionContent({ spec: { ...expected, equals: expected.equals.slice(0, 1) }, bytes }).status, 'failed');
  assert.equal(compareTypedCriterionContent({ spec: { ...expected, equals: [] }, bytes }).status, 'failed');
  const empty = await fixture(t, { charts: [] });
  assert.equal(compareTypedCriterionContent({ spec: { ...spec, equals: [] }, bytes: empty.bytes }).status, 'passed');
});
test('chart contract rejects missing series values, unknown fields and unsupported types', () => {
  for (const mutate of [s => { s.equals[0].type = 'scatter'; }, s => { delete s.equals[0].title; }, s => { s.equals[0].series[0].values = [100]; },
    s => { s.equals[0].series[0].values[0] = '100'; }, s => { s.equals[0].series[0].hiddenExecutable = 'run()'; }, s => { s.equals[0].series = []; },
    s => { s.equals[0].series[0].valueFormula = "'[external.xlsx]실적'!$C$2:$C$3"; }, s => { s.equals[0].series[0].categoryFormula = "'실적'!$XFE$2:$XFE$3"; }]) {
    const next = structuredClone(spec); mutate(next); assert.throws(() => normalizeVerificationSpec(next), { code: 'A_MISSION_CRITERION_INVALID' });
  }
});
test('real Mission completes a matching chart and refuses wrong requirements or CRC-valid cache corruption', async t => {
  for (const mode of ['correct', 'wrong-requirement', 'corrupt-cache']) {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-chart-mission-')); t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'chart.xlsx'), expected = structuredClone(spec);
    if (mode === 'wrong-requirement') expected.equals[0].series[0].values[1] = 999;
    const planner = { async planNextWave() { return { decision: 'continue', summary: '격리된 선택 범위 차트 작성', criteriaAssessment: [], actions: [{
      id: 'chart', title: '실적 차트', command: 'chart.xlsx 엑셀 파일을 만들어줘.', expectedToolName: 'excel.createWorkbook',
      arguments: { outputPath: path, sheetName: spec.sheetName, columns: ['제외', '월', '매출', '이익'], rows: [['x', '1월', 100, 10], ['y', '2월', 120, -5], ['z', '3월', 90, 12]], charts: [{ type: 'bar', title: '선택 실적', range: 'B1:D3' }] },
      dependencies: [], successSignal: '선택한 두 계열과 값이 실제 차트로 저장된다.'
    }] }; } };
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root, env, taskEnv: env, missionPlanner: planner, workerDaemonEnabled: false });
    if (mode === 'corrupt-cache') {
      const verify = runtime.orchestrationWorker.verifyExecution.bind(runtime.orchestrationWorker); let injected = false;
      runtime.orchestrationWorker.verifyExecution = async (...args) => {
        if (!injected) { execFileSync('python', ['tests/fixtures/rewrite-xlsx-charts.py', path, path, 'cache'], { windowsHide: true, stdio: 'pipe' }); injected = true; }
        return verify(...args);
      };
    }
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'chart-oracle-test', durationMinutes: 5 });
    const created = runtime.missionRuntime.createMission({ objective: '성과 표에서 B1:D3 범위를 막대 차트로 저장하고 매출·이익 두 계열의 원래 값을 재확인해.',
      successCriteria: [{ criterionId: 'chart-data', statement: '선택한 범위·계열·값·캐시가 실제 결과에서 일치한다.', verificationSpec: expected }],
      budgets: { maxPlannerCalls: 1, maxWaves: 2, maxActions: 1 }, authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
    assert.equal(created.success, true, JSON.stringify(created));
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(completed.observations[0]?.verification?.status, 'passed', JSON.stringify(completed));
    if (mode === 'correct') {
      assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed));
      assert.equal(completed.completion.criteria[0].deterministicChecks.find(c => c.checkId === 'typed_xlsx_charts')?.passed, true);
    } else { assert.notEqual(completed.status, 'COMPLETED'); assert.equal(completed.completion, null); }
    const stored = runtime.missionRuntime.missions.get(created.missionId);
    const finalProof = runtime.missionRuntime.verifyCriterionEvidence(stored, stored.successCriteria[0], completed.observations.map(o => o.actionId));
    assert.equal(finalProof.status, mode === 'correct' ? 'passed' : 'failed');
    console.log(JSON.stringify({ chartMission: { mode, status: completed.status, criterionProof: finalProof.status, reasons: finalProof.reasons,
      producerGPassed: true, simulatedPlanner: true, actualRenderingVerified: false } }));
  }
});
