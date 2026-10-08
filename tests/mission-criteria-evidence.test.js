import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';
import { compileNaturalWorkflowMission } from '../packages/core/src/mission/natural-workflow-mission-plan.js';
import { normalizeCriterionExtensions, normalizeVerificationSpec, verifyTypedCriterion } from '../packages/core/src/mission/criteria-evidence.js';
import { canonicalJson } from '../packages/core/src/mission/artifact-consistency.js';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, { workspaceRoot = null, preserve = false } = {}) {
  const root = workspaceRoot ? resolve(workspaceRoot) : await mkdtemp(join(tmpdir(), 'jarvis-criterion-proof-'));
  if (!preserve) t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'outputs'), { recursive: true });
  return root;
}
async function artifact(root, name, contents) {
  const path = join(root, name);
  await writeFile(path, contents);
  return { path, evidence: { actionId: 'verified-action', outcome: 'success', verification: { status: 'passed' },
    artifacts: [{ rootIndex: 0, relativePath: name.replaceAll('\\', '/'), pathHash: digest(path), contentSha256: digest(contents), outsideAllowedRoots: false }] } };
}
const verify = (root, evidence, verificationSpec, extra = {}) => verifyTypedCriterion({
  allowedRoots: [root], observations: [evidence], evidenceActionIds: ['verified-action'],
  criterion: { statement: '독립 산출물 검사', verificationSpec, ...extra }
});
async function verifierRuntime(t){
  const root=await fixture(t);
  const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
    env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
  t.after(()=>runtime.coreFacade.cognition.close());
  return {root,verifier:runtime.missionRuntime};
}

test('unknown semantic criteria cannot pass with zero checks or only generic G words', async t => {
  const {verifier}=await verifierRuntime(t);
  for (const statement of ['전체 합계가 999이고 중복 거래는 하나도 없다.', '모든 요청 내용이 검증되었다.']) {
    const proof = verifier.verifyCriterionEvidence({ observations: [], waves: [] }, { statement }, []);
    assert.equal(proof.passed, false);
    assert.equal(proof.status, 'unverified');
    assert.ok(proof.reasons.includes('criterion-verifier-unavailable'));
  }
});

test('a filename and passed G do not prove an arithmetic value in the criterion', async t => {
  const {verifier}=await verifierRuntime(t);
  const proof = verifier.verifyCriterionEvidence({ observations: [{ actionId: 'a',
    verification: { status: 'passed' }, artifacts: [{ name: 'summary.csv' }] }], waves: [] },
  { statement: 'summary.csv에 north=999 합계가 정확히 기록된다.' }, ['a']);
  assert.equal(proof.status, 'unverified');
  assert.equal(proof.passed, false);
  assert.equal(proof.checks.find(check => check.checkId === 'named_artifacts_match').passed, true);
});

test('complete positive grammar rejects unknown Korean/English claims, appended predicates and specialized-check laundering', async t => {
  const {root,verifier}=await verifierRuntime(t);
  const produced=await artifact(root,'result.txt','Known fixture output.');
  produced.evidence.toolName='filesystem.createTextFile';produced.evidence.artifacts[0].name='result.txt';
  const observation = { actionId: 'a', outcome: 'success', toolName: 'browser.search',
    artifacts: [{ name: 'result.txt' }], verification: { status: 'passed' },
    data: { searchResults: [{ url: 'https://developer.mozilla.org/' }],
      webProvenance: { live: true, capturedAt: '2026-09-27T00:00:00Z', navigationStatus: 200 } } };
  const check = statement => verifier.verifyCriterionEvidence(
    { observations: [observation,produced.evidence], waves: [{actions:[{actionId:'verified-action',expectedToolName:'filesystem.createTextFile',arguments:{path:produced.path}}]}] },
    { statement }, ['a','verified-action']);
  for (const statement of ['result.txt 문서가 법적으로 타당하다', 'result.txt에 임의의 요구 X가 충족된다',
    'result.txt proves the diagnosis is correct', 'result.txt가 생성된다. 법적으로 타당하다.',
    'result.txt exists and diagnosis is correct', 'result.txt가 생성되고 공식 출처 확인 및 의학적으로 타당하다.',
    '공식 출처 확인 그리고 인류의 모든 문제가 해결된다.', 'result.txt가 생성되고 G 검증을 통과한다. 후속 판단도 정확하다.']) {
    const proof = check(statement);
    assert.equal(proof.passed, false, statement);
    assert.equal(proof.status, 'unverified', statement);
    assert.ok(proof.reasons.includes('criterion-verifier-unavailable'), statement);
  }
  for (const statement of ['result.txt가 생성된다.', 'result.txt가 생성되고 G 검증을 통과한다.', 'result.txt exists.']) {
    assert.equal(check(statement).passed, true, statement);
  }
});

test('JSON values are independently reread, compared, and bound to a G artifact digest', async t => {
  const root = await fixture(t);
  const item = await artifact(root, 'outputs/result.json', '{"total":42,"items":["a","b"]}');
  const spec = { version: 1, kind: 'json.value', path: 'outputs/result.json', pointer: '/total', equals: 42 };
  assert.equal(verify(root, item.evidence, spec).status, 'passed');
  assert.equal(verify(root, item.evidence, { ...spec, equals: 999 }).status, 'failed');
  assert.equal(verify(root, item.evidence, { ...spec, pointer: '/absent' }).status, 'failed');
  await writeFile(item.path, '{"total":999}');
  const changed = verify(root, item.evidence, { ...spec, equals: 999 });
  assert.equal(changed.passed, false);
  assert.ok(changed.reasons.includes('criterion-artifact-changed'));
});

test('CSV row equality supports explicit numbers, quoted text, order and duplicate cardinality', async t => {
  const root = await fixture(t);
  const { evidence } = await artifact(root, 'outputs/result.csv', 'region,total\r\n"south, east",5\r\nnorth,37\r\n');
  const spec = { version: 1, kind: 'csv.rows', path: 'outputs/result.csv', numericColumns: ['total'], order: 'unordered',
    equals: [{ region: 'north', total: 37 }, { region: 'south, east', total: 5 }] };
  assert.equal(verify(root, evidence, spec).status, 'passed');
  assert.equal(verify(root, evidence, { ...spec, order: 'ordered' }).status, 'failed');
  assert.equal(verify(root, evidence, { ...spec, equals: [...spec.equals, spec.equals[0]] }).status, 'failed');
  assert.equal(verify(root, evidence, { ...spec, numericColumns: [] }).status, 'failed');
});

test('existing file without exact G identity or a digest stays unverified', async t => {
  const root = await fixture(t);
  const { evidence } = await artifact(root, 'outputs/result.json', '{"total":42}');
  const spec = { version: 1, kind: 'file.exists', path: 'outputs/result.json' };
  assert.equal(verify(root, evidence, spec).status, 'passed');
  assert.equal(verify(root, { ...evidence, verification: { status: 'failed' } }, spec).status, 'unverified');
  assert.equal(verify(root, { ...evidence, artifacts: [{ ...evidence.artifacts[0], pathHash: 'f'.repeat(64) }] }, spec).status, 'unverified');
  assert.equal(verify(root, { ...evidence, artifacts: [{ ...evidence.artifacts[0], contentSha256: null }] }, spec).status, 'unverified');
  assert.equal(verify(root, evidence, { ...spec, path: '../outside.json' }).status, 'failed');
});

test('a junction to a file outside the root cannot be a typed proof', async t => {
  const root = await fixture(t), other = await fixture(t);
  await writeFile(join(other, 'result.json'), '{"total":42}');
  await symlink(other, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const path = join(root, 'linked', 'result.json');
  const evidence = { actionId: 'verified-action', outcome: 'success', verification: { status: 'passed' },
    artifacts: [{ rootIndex: 0, relativePath: 'linked/result.json', pathHash: digest(path), contentSha256: digest('{"total":42}') }] };
  const result = verify(root, evidence, { version: 1, kind: 'file.exists', path: 'linked/result.json' });
  assert.equal(result.status, 'failed');
  assert.ok(result.reasons.includes('criterion-physical-path-outside-root'));
});

test('criterion metadata and verifier grammar validate instead of dropping unsupported fields', () => {
  const input = { requirementId: 'R-합계', sourceSpan: { start: 0, end: 4 }, artifactRole: 'output',
    verificationSpec: { version: 1, kind: 'json.value', path: 'result.json', pointer: '/total', equals: 42 } };
  assert.deepEqual(normalizeCriterionExtensions(input, { objectiveLength: 4 }), input);
  for (const changes of [{ sourceSpan: { start: 0, end: 5 } }, { artifactRole: 'somewhere' }, { requirementId: 'bad id' },
    { verificationSpec: { version: 1, kind: 'javascript', path: 'result.json' } }]) {
    assert.throws(() => normalizeCriterionExtensions({ ...input, ...changes }, { objectiveLength: 4 }), { code: 'A_MISSION_CRITERION_INVALID' });
  }
  for (const changes of [{ pointer: '/__proto__' }, { pointer: '/bad~2value' }, { equals: Infinity }, { code: 'run()' }]) {
    assert.throws(() => normalizeVerificationSpec({ ...input.verificationSpec, ...changes }), { code: 'A_MISSION_CRITERION_INVALID' });
  }
});

test('a matching workflow receipt alone cannot satisfy arbitrary criteria', () => {
  const context = { workspaceRoot: 'C:/jarvis-criterion-test', mission: {
    objective: "'input.json' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해",
    successCriteria: [{ criterionId: 'sum', statement: '합계는 999이다.' }]
  }, observations: [] };
  const initial = compileNaturalWorkflowMission(context), spec = initial.actions[0].arguments.spec;
  context.observations = [{ actionId: 'a', toolName: 'workflow.execute', outcome: 'success', verification: { status: 'passed' },
    data: { workflow: { workflowId: spec.workflowId, specSha256: digest(JSON.stringify(spec)), nodeCount: spec.nodes.length } } }];
  const result = compileNaturalWorkflowMission(context);
  assert.equal(result.decision, 'pause');
  assert.equal(result.pauseReason, 'verification-incomplete');
  assert.equal(result.criteriaAssessment[0].status, 'unsatisfied');
});

async function runtimeFixture(t) {
  const root = await fixture(t);
  await writeFile(join(root, 'input.json'), '[{"region":"north","total":37},{"region":"south","total":5}]');
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'typed-criterion-test', durationMinutes: 5 });
  return { root, runtime, authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
    grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } };
}
const objective = "'input.json' JSON을 '원본'으로 읽고; '원본'을 'outputs/result.json' JSON으로 저장하고; '원본'을 'outputs/result.csv' CSV로 저장해";

test('real Mission→workflow→G→typed JSON/CSV proof completes and preserves request metadata', async t => {
  const { root, runtime, authorization } = await runtimeFixture(t);
  const criteria = [
    { criterionId: 'json', requirementId: 'R1', sourceSpan: { start: 0, end: 12 }, artifactRole: 'output', statement: 'JSON 첫 지역 합계는 37이다.',
      verificationSpec: { version: 1, kind: 'json.value', path: 'outputs/result.json', pointer: '/0/total', equals: 37 } },
    { criterionId: 'csv', statement: 'CSV의 두 지역 합계가 정확하다.', verificationSpec: { version: 1, kind: 'csv.rows', path: 'outputs/result.csv',
      equals: [{ region: 'south', total: 5 }, { region: 'north', total: 37 }], numericColumns: ['total'], order: 'unordered' } }
  ];
  const created = runtime.missionRuntime.createMission({ objective, authorization, successCriteria: criteria });
  assert.deepEqual(created.successCriteria, criteria);
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.verificationSummary));
  assert.equal(result.verificationStatus, 'passed');
  assert.equal(result.uncertainEffectCount, 0);
  assert.equal(result.verificationSummary.verifiedCount, 2);
  assert.equal(result.completion.criteria[0].deterministicChecks.some(check => check.checkId === 'typed_json_value' && check.passed), true);
  assert.equal(result.completion.criteria[1].deterministicChecks.some(check => check.checkId === 'typed_csv_rows' && check.passed), true);
  assert.equal(JSON.parse(await readFile(join(root, 'outputs/result.json'), 'utf8'))[0].total, 37);
});

test('artifact consistency criteria reopen four G-bound JSON artifacts inside Mission completion', async t => {
  const root = await fixture(t, process.env.JARVIS_M09_MISSION_WORKSPACE_ROOT
    ? { workspaceRoot: process.env.JARVIS_M09_MISSION_WORKSPACE_ROOT, preserve: true } : {});
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const facts = { articleCount: 3, totalViews: 1200, averageScore: 4.5 };
  const source = { sourceId: 'research-v1', revision: 1,
    digest: digest(canonicalJson(facts)), facts };
  await mkdir(join(root, 'inputs'), { recursive: true });
  await writeFile(join(root, 'inputs/source.json'), `${JSON.stringify(source)}\n`, 'utf8');
  const artifactFor = kind => ({ artifactId: `${kind}-v1`, kind,
    sourceRef: { sourceId: source.sourceId, revision: source.revision, digest: source.digest }, facts });
  const sourceRef = pointer => ({ $ref: { nodeId: 'read', pointer: `/value/${pointer}` } });
  const fullSourceRef = { $ref: { nodeId: 'read', pointer: '/value' } };
  const artifactValue = kind => ({ artifactId: `${kind}-v1`, kind,
    sourceRef: { sourceId: sourceRef('sourceId'), revision: sourceRef('revision'), digest: sourceRef('digest') }, facts: sourceRef('facts') });
  const workflowSpec = { schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'm09-shared-source-projections',
    description: 'Read one source fact envelope and derive three typed artifact projections.',
    nodes: [
      { id: 'read', op: 'data.readJson', args: { path: 'inputs/source.json' } },
      ...[['source', fullSourceRef], ['report', artifactValue('report')], ['table', artifactValue('table')], ['card', artifactValue('card')]]
        .map(([name, data]) => ({ id: `write_${name}`, op: 'write.json', dependsOn: ['read'],
          args: { path: `outputs/${name}.json`, data } }))
    ],
    outputs: ['source', 'report', 'table', 'card'].map(name => ({ nodeId: `write_${name}`, path: `outputs/${name}.json`, mediaType: 'application/json' })) };
  const planner = { async planNextWave() {
    return { decision: 'continue', summary: '원본 JSON 하나에서 보고서·표·카드 facts를 파생합니다.',
      actions: [{ id: 'derive_artifact_projections', title: '원본 기반 산출물 생성',
        command: '검증된 로컬 facts workflow를 실행한다.', expectedToolName: 'workflow.execute',
        arguments: { spec: workflowSpec, workspaceRoot: root }, dependencies: [],
        successSignal: '원본·보고서·표·카드 네 파일이 동일 원자료 revision을 보존한다.' }], criteriaAssessment: [] };
  } };
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root,
    env, taskEnv: env, missionPlanner: planner, workerDaemonEnabled: false });
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'artifact-consistency-mission-test', durationMinutes: 5 });
  const verificationSpec = { version: 1, kind: 'artifact.consistency', sourcePath: 'outputs/source.json',
    reportPath: 'outputs/report.json', tablePath: 'outputs/table.json', cardPath: 'outputs/card.json' };
  const created = runtime.missionRuntime.createMission({ objective: '원본 사실을 바탕으로 보고서·표·카드 데이터를 만들고 네 산출물의 출처와 수치가 일치하는지 검증한다.',
    successCriteria: [{ criterionId: 'shared_facts', statement: '원본과 보고서·표·카드의 출처 revision 및 수치가 모두 일치한다.', verificationSpec }],
    budgets: { maxPlannerCalls: 1, maxWaves: 2, maxActions: 1 },
    authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
      grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
  assert.equal(created.success, true, JSON.stringify(created));
  const completed = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(completed.status, 'COMPLETED', JSON.stringify({ status: completed.status, stopReason: completed.stopReason,
    verificationSummary: completed.verificationSummary, observations: completed.observations,
    actions: runtime.missionRuntime.missions.get(created.missionId)?.waves?.flatMap(wave => wave.actions) }));
  assert.equal(completed.verificationSummary.verifiedCount, 1);
  const check = completed.completion.criteria[0].deterministicChecks.find(item => item.checkId === 'typed_artifact_consistency');
  assert.equal(check?.passed, true);
  assert.equal(check?.sourceId, 'research-v1');
  assert.equal(check?.revision, 1);
  assert.equal(check?.artifactCount, 3);
  assert.equal(completed.metrics.successfulActions, 1);
  assert.equal(completed.observations[0].toolName, 'workflow.execute');
  if (process.env.JARVIS_M09_MISSION_EVIDENCE_PATH && process.env.JARVIS_M09_MISSION_ORACLE_PATH) {
    const mission = runtime.missionRuntime.missions.get(created.missionId);
    await writeFile(process.env.JARVIS_M09_MISSION_EVIDENCE_PATH, `${JSON.stringify({ schemaVersion: 1, scenarioId: 'M09-MISSION',
      fixtureId: 'm09-mission-workflow-shared-source-v1', workspaceRoot: root, expectedFacts: facts,
      paths: Object.fromEntries(['source', 'report', 'table', 'card'].map(name => [name, `outputs/${name}.json`])),
      mission: { status: completed.status, verificationStatus: completed.verificationStatus, completion: completed.completion,
        successCriteria: mission.successCriteria, observations: mission.observations } }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const oracleOutput = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs',
      process.env.JARVIS_M09_MISSION_EVIDENCE_PATH, process.env.JARVIS_M09_MISSION_ORACLE_PATH], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const oracle = JSON.parse(oracleOutput.trim().split(/\r?\n/u).at(-1));
    assert.equal(oracle.status, 'passed', JSON.stringify(oracle));
  }
});

test('artifact consistency criterion rejects unbound, duplicated, and stale projections', async t => {
  const root = await fixture(t);
  const facts = { count: 4 };
  const source = { sourceId: 's', revision: 1, digest: digest(canonicalJson(facts)), facts };
  const values = { source, report: { artifactId: 'r', kind: 'report', sourceRef: { sourceId: 's', revision: 1, digest: source.digest }, facts },
    table: { artifactId: 't', kind: 'table', sourceRef: { sourceId: 's', revision: 1, digest: source.digest }, facts },
    card: { artifactId: 'c', kind: 'card', sourceRef: { sourceId: 's', revision: 1, digest: source.digest }, facts: { count: 3 } } };
  const evidence = [];
  for (const [name, value] of Object.entries(values)) {
    const observed = (await artifact(root, `outputs/${name}.json`, JSON.stringify(value))).evidence;
    observed.actionId = `verified-${name}`;
    evidence.push(observed);
  }
  const paths = Object.fromEntries(Object.keys(values).map(name => [name, `outputs/${name}.json`]));
  const spec = { version: 1, kind: 'artifact.consistency', sourcePath: paths.source, reportPath: paths.report,
    tablePath: paths.table, cardPath: paths.card };
  const boundIds = evidence.map(item => item.actionId);
  const verifyBound = (selected = boundIds, nextSpec = spec) => verifyTypedCriterion({ allowedRoots: [root], observations: evidence,
    evidenceActionIds: selected, criterion: { statement: '산출물 일관성', verificationSpec: nextSpec } });
  assert.equal(verifyBound().status, 'failed');
  assert.equal(verifyBound(boundIds.slice(0, 3)).status, 'unverified');
  assert.equal(verifyBound(boundIds, { ...spec, cardPath: spec.tablePath }).status, 'failed');
  assert.equal(normalizeVerificationSpec(spec).kind, 'artifact.consistency');
  assert.throws(() => normalizeVerificationSpec({ ...spec, unexpected: true }), { code: 'A_MISSION_CRITERION_INVALID' });
});

test('real workflow preserves its output and pauses on wrong or unverifiable semantics without replaying it', async t => {
  const { root, runtime, authorization } = await runtimeFixture(t);
  for (const criterion of [
    { statement: 'outputs/result.json의 합계는 999이다.', verificationSpec: { version: 1, kind: 'json.value', path: 'outputs/result.json', pointer: '/0/total', equals: 999 } },
    'outputs/result.json에 합계 999가 정확히 기록된다.'
  ]) {
    const created = runtime.missionRuntime.createMission({ objective, authorization, successCriteria: [criterion] });
    const result = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(result.status, 'PAUSED', JSON.stringify({ status: result.status, reason: result.stopReason }));
    assert.equal(result.stopReason, 'verification-incomplete');
    assert.equal(result.metrics.executedActions, 1);
    assert.notEqual(result.verificationStatus, 'passed');
    assert.equal(result.completion, null);
    assert.equal(JSON.parse(await readFile(join(root, 'outputs/result.json'), 'utf8'))[0].total, 37);
  }
});

test('createMission rejects invalid or duplicate criteria before any action executes', async t => {
  const { runtime, authorization } = await runtimeFixture(t);
  for (const successCriteria of [
    [{ statement: '검사', verificationSpec: { version: 1, kind: 'shell', path: 'result.json' } }],
    [{ criterionId: 'same', statement: '하나' }, { criterionId: 'same', statement: '둘' }],
    [{ statement: '검사', sourceSpan: { start: 0, end: 99999 } }], Array(21).fill('검사')
  ]) {
    const result = runtime.missionRuntime.createMission({ objective, authorization, successCriteria });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'A_MISSION_CRITERION_INVALID');
  }
  assert.equal(runtime.missionRuntime.status().missionCount, 0);
});

test('uncertain operation, effect or delivery observation prevents completion even after a late G success', async t => {
  const { runtime, authorization } = await runtimeFixture(t);
  const created = runtime.missionRuntime.createMission({ objective, authorization, successCriteria: [{ statement: '정확한 합계',
    verificationSpec: { version: 1, kind: 'json.value', path: 'outputs/result.json', pointer: '/0/total', equals: 37 } }] });
  const completed = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(completed.status, 'COMPLETED');
  const original = runtime.missionRuntime.missions.get(created.missionId);
  const actionId = original.waves[0].actions[0].actionId;
  const beforeExecutions = original.metrics.executedActions;
  let replayCalls = 0;
  runtime.orchestrationWorker.runTask = async () => { replayCalls += 1; throw new Error('unexpected-effect-replay'); };
  for (const kind of ['operation', 'effect', 'lost-receipt']) {
    const mission = structuredClone(original), action = mission.waves[0].actions[0];
    if (kind === 'operation') action.operation.state = 'uncertain';
    if (kind === 'effect') action.effect = { state: 'uncertain' };
    if (kind === 'lost-receipt') {
      mission.observations.push({ actionId, outcome: 'uncertain', createdAt: '2026-09-27T00:00:00Z' });
      mission.observations.push({ actionId, outcome: 'success', verification: { status: 'passed' }, createdAt: '2026-09-27T00:00:01Z' });
    }
    mission.status = 'RUNNING';
    mission.completion = null;
    assert.equal(runtime.missionRuntime.uncertainEffectCount(mission), 1, kind);
    const assessment = runtime.missionRuntime.validateCompletion(mission, [{ criterionId: mission.successCriteria[0].criterionId,
      status: 'satisfied', evidenceActionIds: [actionId] }]);
    assert.equal(assessment.valid, false, kind);
    assert.ok(assessment.reasons.includes('uncertain-effects'), kind);
    assert.equal(runtime.missionRuntime.tryCompleteFromDeterministicEvidence(mission), false, kind);
    assert.equal(mission.completion, null, kind);
    assert.equal(mission.metrics.executedActions, beforeExecutions, kind);
    runtime.missionRuntime.missions.set(created.missionId, mission);
    const resumed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(resumed.status, 'PAUSED', kind);
    assert.equal(resumed.stopReason, 'reconciliation-required', kind);
    assert.equal(resumed.uncertainEffectCount, 1, kind);
    assert.equal(resumed.completion, null, kind);
    assert.equal(resumed.metrics.executedActions, beforeExecutions, kind);
  }
  assert.equal(replayCalls, 0);
});
