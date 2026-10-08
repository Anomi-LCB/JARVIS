import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { verifySourceOutcome } from '../packages/core/src/mission/mission-source-outcome-oracle.js';

const objective = [
  "'live/source.json' JSON을 '원본'으로 읽고",
  "'원본'에 '금액' = '수량' * '가격'를 계산해 '계산'으로 만들고",
  "'계산'을 '금액' 내림차순으로 정렬해 '순위'로 만들고",
  "'순위'를 'live/ranked.json' JSON으로 저장하고",
  "'live/ranked.json' JSON을 '재조회'로 읽고",
  "'재조회'의 '금액' 통계를 계산해 '통계'로 만들고",
  "'통계'를 'live/stats.json' JSON으로 저장하고",
  "'재조회'의 행 수가 3인지 검증해"
].join('; ');
const uiCriterion = `${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`;

async function runWithCriterion(statement, inspect) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-live-natural-criteria-'));
  try {
    await mkdir(join(root, 'live'));
    await writeFile(join(root, 'live/source.json'), JSON.stringify([
      { 이름: '연필', 수량: 2, 가격: 3 }, { 이름: '종이', 수량: 4, 가격: 5 }, { 이름: '펜', 수량: 1, 가격: 10 }
    ]));
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
    assert.ok(runtime.missionPlanner instanceof GoalExecutivePlanner);
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'natural-live-criterion-test', durationMinutes: 5 });
    const created = runtime.missionRuntime.createMission({
      objective,
      successCriteria: [statement, '요청한 형식과 저장 위치에 실제 산출물이 생성되고 다시 열 수 있음이 확인된다.'],
      constraints: [
        '허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.',
        '최신 정보가 필요하면 출처와 조회 시점을 실행 증거에 남긴다.',
        '외부 전송과 되돌릴 수 없는 작업은 행동별 승인을 받는다.'
      ],
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] }
    });
    const result = await runtime.missionRuntime.runMission(created.missionId);
    const execution = result.observations.find((observation) => observation.toolName === 'workflow.execute');
    assert.equal(execution?.outcome, 'success');
    assert.equal(execution.verification?.status, 'passed');
    assert.equal(execution.data.workflow.nodeCount, 8);
    const original = runtime.missionRuntime.missions.get(created.missionId);
    const criterionEvidence = runtime.missionRuntime.verifyCriterionEvidence(original, original.successCriteria[0], [execution.actionId]);
    await inspect({ root, result, execution, criterionEvidence, mission: original });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('full UI-shaped local mission independently verifies source, computations, assertions, G artifacts and default constraints', async () => {
  await runWithCriterion(uiCriterion, async ({ root, result, criterionEvidence, mission }) => {
    assert.equal(result.status, 'COMPLETED', JSON.stringify({ reason: result.stopReason, observations: result.observations }));
    assert.equal(criterionEvidence.status, 'passed');
    assert.ok(criterionEvidence.checks.some(check => check.checkId === 'independent-source-outcome-oracle' && check.passed));
    assert.equal(mission.verificationSummary.verifiedCount, 2);
    assert.ok(mission.goalCompletionCoverage.constraintChecks.every(check => check.supported && check.passed));
    const oracle = criterionEvidence.checks.find((check) => check.checkId === 'independent-source-outcome-oracle');
    assert.deepEqual(oracle.verifiedArtifactPaths.sort(), ['live/ranked.json', 'live/stats.json']);
    assert.equal(criterionEvidence.checks.some((check) => check.checkId === 'live_data_provenance_present'), false);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'live/ranked.json'), 'utf8')).map((row) => row.금액), [20, 10, 6]);
    assert.equal(JSON.parse(await readFile(join(root, 'live/stats.json'), 'utf8')).mean, 12);
  });
});

test('Mission resolves a unique prior output referent and verifies the reopened artifact end to end', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-live-file-reference-'));
  await mkdir(join(root, 'inputs'));
  await mkdir(join(root, 'outputs'));
  await writeFile(join(root, 'inputs/source.json'), JSON.stringify([{ id: 'A' }, { id: 'B' }]));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
  t.after(async () => { await runtime.close?.(); await rm(root, { recursive: true, force: true }); });
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'natural-live-file-reference-test', durationMinutes: 5 });
  const objective = "'inputs/source.json' JSON을 '원본'으로 읽고; '원본'에서 필드 'id'만 추출해 '결과'로 만들고; '결과'를 'outputs/export.json' JSON으로 저장하고; 그 파일을 '재조회'로 다시 읽고; '재조회'의 행 수가 2인지 검증해";
  const created = runtime.missionRuntime.createMission({
    objective,
    successCriteria: [{ criterionId: 'export-exists', statement: '내보낸 결과 파일이 존재한다.', verificationSpec: { version: 1, kind: 'file.exists', path: 'outputs/export.json' } }],
    constraints: ['작업공간 안의 파일만 읽고 쓴다.', '외부 전송은 하지 않는다.'],
    authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
      grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
  });
  const result = await runtime.missionRuntime.runMission(created.missionId);
  const mission = runtime.missionRuntime.missions.get(created.missionId);
  assert.equal(result.status, 'COMPLETED', JSON.stringify({ stopReason: result.stopReason, coverage: mission.goalCompletionCoverage,
    missionConstraints: mission.constraints, actions: mission.waves.flatMap(wave => wave.actions).map(action => ({ actionId: action.actionId,
      taskId: action.taskId, actualToolName: action.actualToolName, status: action.status, requirementIds: action.requirementIds,
      dispatch: action.operation?.dispatch, observationId: action.observationId })), observations: result.observations }));
  const clauseEvidence = mission.goalCompletionCoverage.sourceClauseEvidence[3];
  const binding = clauseEvidence.resolvedReferences?.[0];
  assert.equal(binding?.text, '그 파일');
  assert.equal(binding?.path, 'outputs/export.json');
  assert.equal(binding?.requirementId, mission.goalContract.requirements[2].requirementId);
  assert.equal(binding?.sourceSpan.start, objective.indexOf('그 파일'));
  assert.ok(clauseEvidence.nodeIds.length > 0);
  const workflow = result.observations.find(item => item.toolName === 'workflow.execute');
  assert.equal(workflow?.outcome, 'success');
  assert.equal(workflow?.verification?.status, 'passed');
  assert.equal(workflow.data.workflow.nodeCount, 5);
  assert.equal(workflow.data.workflow.receipts.filter(item => item.op === 'data.readJson').length, 2);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'outputs/export.json'), 'utf8')), [{ id: 'A' }, { id: 'B' }]);
});

test('Mission blocks an ambiguous prior file referent before any workflow dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-live-file-reference-ambiguous-'));
  await mkdir(join(root, 'inputs'));
  await mkdir(join(root, 'outputs'));
  await writeFile(join(root, 'inputs/source.json'), JSON.stringify([{ id: 'A' }]));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
  t.after(async () => { await runtime.close?.(); await rm(root, { recursive: true, force: true }); });
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'natural-live-file-reference-ambiguous-test', durationMinutes: 5 });
  const objective = "'inputs/source.json' JSON을 '원본'으로 읽고; '원본'을 'outputs/first.json' JSON으로 저장하고; '원본'을 'outputs/second.json' JSON으로 저장하고; 그 파일을 '재조회'로 다시 읽고; '재조회'의 행 수가 1인지 검증해";
  const created = runtime.missionRuntime.createMission({ objective,
    successCriteria: ['모호한 파일 지시어를 실행 전에 차단한다.'],
    authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
      grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
  });
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.notEqual(result.status, 'COMPLETED');
  assert.equal(result.observations.some(item => item.toolName === 'workflow.execute'), false);
  assert.equal(result.waveCount ?? result.waves?.length ?? 0, 0);
  await assert.rejects(readFile(join(root, 'outputs/first.json')));
  await assert.rejects(readFile(join(root, 'outputs/second.json')));
});

test('ordinary source prose outside the filename still requires genuine provenance and blocks unsupported completion', async () => {
  await runWithCriterion(`${uiCriterion} source를 실제 조회한 증거로 확인해야 한다.`, async ({ result, criterionEvidence }) => {
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.stopReason, 'verification-incomplete');
    const provenance = criterionEvidence.checks.find((check) => check.checkId === 'live_data_provenance_present');
    assert.ok(provenance);
    assert.equal(provenance.passed, false);
    assert.ok(criterionEvidence.reasons.includes('live_data_provenance_present'));
  });
});

test('Korean explicit provenance remains required after removing file references from the criterion', async () => {
  await runWithCriterion(`${uiCriterion} 뉴스 출처와 조회 시점을 증명해야 한다.`, async ({ result, criterionEvidence }) => {
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.stopReason, 'verification-incomplete');
    const provenance = criterionEvidence.checks.find((check) => check.checkId === 'live_data_provenance_present');
    assert.equal(provenance?.passed, false);
  });
});

test('typed input exemption does not remove a separately required missing output', async () => {
  await runWithCriterion(`${uiCriterion} 추가로 final-proof.json 파일을 생성한다.`, async ({ result, criterionEvidence }) => {
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.stopReason, 'verification-incomplete');
    const names = criterionEvidence.checks.find((check) => check.checkId === 'named_artifacts_match');
    assert.equal(names.passed, false);
    assert.ok(names.expected.includes('final-proof.json'));
    assert.equal(names.expected.includes('source.json'), false);
  });
});

test('independent outcome oracle rejects post-G edits, changed inputs, reused receipts and unsupported suffixes', async () => {
  await runWithCriterion(uiCriterion, async ({ root, execution }) => {
    const verify = statement => verifySourceOutcome({ objective, statement, observations: [execution], allowedRoots: [root] });
    assert.equal(verify(uiCriterion).status, 'passed');
    const rankedPath = join(root, 'live/ranked.json');
    const originalRanked = await readFile(rankedPath, 'utf8');
    await writeFile(rankedPath, JSON.stringify([{ 이름: '조작', 수량: 1, 가격: 1, 금액: 1 }]));
    assert.ok(verify(uiCriterion).reasons.some(reason => reason.includes('current-artifact-content-mismatch')));
    await writeFile(rankedPath, originalRanked);
    const sourcePath = join(root, 'live/source.json');
    const originalSource = await readFile(sourcePath, 'utf8');
    await writeFile(sourcePath, originalSource.replace('"수량":2', '"수량":99'));
    assert.ok(verify(uiCriterion).reasons.includes('actual-input-read-does-not-match-independent-snapshot'));
    await writeFile(sourcePath, originalSource);
    assert.notEqual(verify(`${uiCriterion} 그리고 더 많은 일을 했다고 확인한다.`).status, 'passed');
    const skippedReceipt = structuredClone(execution);
    skippedReceipt.data.workflow.receipts[7].status = 'skipped';
    assert.notEqual(verifySourceOutcome({ objective, statement: uiCriterion, observations: [skippedReceipt], allowedRoots: [root] }).status, 'passed');
    await writeFile(sourcePath, '[{"이름":"x","수량":1,"수량":2,"가격":3},{"이름":"y","수량":1,"가격":4},{"이름":"z","수량":2,"가격":5}]');
    assert.ok(verify(uiCriterion).reasons.includes('duplicate-json-key'));
  });
});

test('ambiguous duplicate-key source is blocked by the independent preflight before workflow writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-source-outcome-preflight-'));
  try {
    await mkdir(join(root, 'live'));
    await writeFile(join(root, 'live/source.json'), '[{"이름":"연필","수량":2,"수량":99,"가격":3},{"이름":"종이","수량":4,"가격":5},{"이름":"펜","수량":1,"가격":10}]');
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'source-outcome-preflight-test', durationMinutes: 5 });
    const created = runtime.missionRuntime.createMission({ objective,
      successCriteria: [uiCriterion, '요청한 형식과 저장 위치에 실제 산출물이 생성되고 다시 열 수 있음이 확인된다.'],
      constraints: ['허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.',
        '최신 정보가 필요하면 출처와 조회 시점을 실행 증거에 남긴다.', '외부 전송과 되돌릴 수 없는 작업은 행동별 승인을 받는다.'],
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] } });
    const result = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.stopReason, 'source-outcome-preparation-blocked');
    assert.equal(result.observations.some(observation => observation.toolName === 'workflow.execute'), false);
    await assert.rejects(readFile(join(root, 'live/ranked.json')));
    await assert.rejects(readFile(join(root, 'live/stats.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
