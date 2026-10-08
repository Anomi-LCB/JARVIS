import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createGoalContract } from '../packages/core/src/mission/goal-contract.js';
import { assessMissionGoalCompletionCoverage } from '../packages/core/src/mission/mission-requirement-coverage.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-summary-adversarial-'));
  const source = '회의 시간은 10시이며 장소는 본당이다. 인쇄물은 12부를 준비한다.';
  const summary = '본당 10시 회의에 인쇄물 12부 준비.';
  writeFileSync(join(root, 'source.txt'), source);
  writeFileSync(join(root, 'summary.txt'), summary);
  const objective = "'source.txt'를 읽고 핵심을 요약해 'summary.txt'로 저장해줘";
  const contract = createGoalContract({ objective });
  const actions = ['read', 'write'].map((kind, index) => ({
    actionId: kind, taskId: `task-${kind}`, observationId: `observation-${kind}`, status: 'succeeded',
    requirementIds: [contract.requirements[0].requirementId], dependencies: index ? ['read'] : [],
    actualToolName: index ? 'filesystem.createTextFile' : 'filesystem.readText',
    operation: { dispatch: { taskId: `task-${kind}`, toolName: index ? 'filesystem.createTextFile' : 'filesystem.readText',
      arguments: { path: join(root, index ? 'summary.txt' : 'source.txt'), ...(index ? { content: summary } : { offset: 0, maxChars: 12000 }) },
      dispatchedAt: `2026-09-27T10:00:0${index * 2}.000Z` } }
  }));
  const file = (name, text) => ({ rootIndex: 0, relativePath: name, outsideAllowedRoots: false, contentSha256: sha(text) });
  const observations = actions.map((action, index) => ({ observationId: action.observationId, actionId: action.actionId,
    taskId: action.taskId, toolName: action.actualToolName, outcome: 'success', evidenceId: `evidence-${action.actionId}`,
    verification: { status: 'passed', verificationId: `verification-${action.actionId}`, failedCheckIds: [] },
    createdAt: `2026-09-27T10:00:0${index * 2 + 1}.000Z`,
    data: index ? {} : { fileEvidence: file('source.txt', source), stdoutPreview: source,
      readExtent: { offset: 0, returnedChars: source.length, truncated: false, bytes: Buffer.byteLength(source), encoding: 'utf8' } },
    artifacts: index ? [file('summary.txt', summary)] : []
  }));
  const mission = { goalContract: contract, workspaceRoot: root, constraints: [], waves: [{ actions }], observations,
    successCriteria: [{ criterionId: 'summary', statement: '요약 내용 일치', requirementId: contract.requirements[0].requirementId,
      verificationSpec: { version: 1, kind: 'text.equals', path: 'summary.txt', equals: summary } }] };
  t.after(() => { const path = resolve(root); assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes('jarvis-summary-adversarial-')); rmSync(path, { recursive: true, force: true }); });
  return { root, source, summary, mission, actions, observations,
    assess: () => assessMissionGoalCompletionCoverage({ mission, allowedRoots: [root] }) };
}

test('independent full completion helper preserves the valid summary sequence', t => {
  const f = fixture(t), result = f.assess();
  assert.equal(result.allowed, true);
  assert.equal(result.semanticAccuracyVerified, false);
  assert.equal(result.resultCriteriaVerificationRequired, true);
  assert.deepEqual(result.coveredRequirementIds, [f.mission.goalContract.requirements[0].requirementId]);
});

test('full-file digest cannot turn a partial read into complete source coverage', t => {
  const f = fixture(t);
  f.actions[0].operation.dispatch.arguments.offset = f.source.length - 1;
  f.actions[0].operation.dispatch.arguments.maxChars = 1;
  f.observations[0].data.stdoutPreview = f.source.slice(-1);
  f.observations[0].data.readExtent = { offset: f.source.length - 1, returnedChars: 1,
    truncated: false, bytes: Buffer.byteLength(f.source), encoding: 'utf8' };
  assert.equal(f.assess().allowed, false, 'a suffix-only read has the same full-file SHA in the real PC adapter');
});

test('missing, prefix-only and coerced read extent cannot prove a complete source read', t => {
  for (const mutate of [
    f => { delete f.observations[0].data.readExtent; },
    f => { f.observations[0].data.readExtent.offset = '0'; },
    f => { f.observations[0].data.readExtent.returnedChars = String(f.source.length); },
    f => { f.observations[0].data.readExtent.truncated = 'false'; },
    f => { f.observations[0].data.readExtent.encoding = 'utf16le'; },
    f => { f.observations[0].data.readExtent.bytes = 1; },
    f => { f.actions[0].operation.dispatch.arguments.maxChars = 1; f.observations[0].data.stdoutPreview = f.source[0];
      Object.assign(f.observations[0].data.readExtent, { returnedChars: 1, truncated: true }); }
  ]) { const f = fixture(t); mutate(f); assert.equal(f.assess().allowed, false); }
});

test('read completion cannot predate its own dispatch and still prove sequencing', t => {
  const f = fixture(t);
  f.actions[0].operation.dispatch.dispatchedAt = '2026-09-27T10:00:04.000Z';
  assert.equal(f.assess().allowed, false, 'read observation at 01 cannot prove read dispatched at 04 preceded write at 02');
});

test('G action/task/tool binding and evidence availability are mandatory', t => {
  const mutations = [
    f => { f.observations[0].taskId = 'other-task'; },
    f => { f.observations[1].actionId = 'other-action'; },
    f => { f.observations[0].toolName = 'filesystem.listFiles'; },
    f => { f.observations[1].verification.failedCheckIds = ['failure']; },
    f => { f.observations[0].verification.verificationId = ''; },
    f => { f.observations[0].data.fileEvidence.outsideAllowedRoots = true; },
    f => { f.observations[1].artifacts[0].rootIndex = '0'; }
  ];
  for (const mutate of mutations) { const f = fixture(t); mutate(f); assert.equal(f.assess().allowed, false); }
});

test('typed oracle rejects coercion and conflicting exact expected values', t => {
  const mutations = [
    f => { f.mission.successCriteria[0].verificationSpec.equals = { toString: () => f.summary }; },
    f => { f.mission.successCriteria[0].verificationSpec.version = '1'; },
    f => { f.mission.successCriteria[0].verificationSpec.path = ['summary.txt']; },
    f => { f.mission.successCriteria.push({ criterionId: 'contradiction', verificationSpec: { version: 1, kind: 'text.equals', path: 'summary.txt', equals: '다른 요약' } }); }
  ];
  for (const mutate of mutations) { const f = fixture(t); mutate(f); assert.equal(f.assess().allowed, false); }
});

test('additional source demands and supplemental constraints cannot hide behind exact output', t => {
  for (const suffix of [' 그리고 이메일도 보내줘', '; 원본을 삭제하지 마', ' 단 개인정보는 빼줘']) {
    const f = fixture(t);
    f.mission.goalContract = createGoalContract({ objective: f.mission.goalContract.objective + suffix });
    assert.equal(f.assess().allowed, false);
  }
  const f = fixture(t); f.mission.constraints = ['민감정보는 제외한다'];
  assert.equal(f.assess().allowed, false);
});

test('current file changes and an output junction escaping allowed roots cannot pass', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'summary.txt'), '실행 이후 변조');
  assert.equal(f.assess().allowed, false);
  const g = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'jarvis-summary-adversarial-outside-'));
  t.after(() => { const path = resolve(outside); assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes('jarvis-summary-adversarial-outside-')); rmSync(path, { recursive: true, force: true }); });
  writeFileSync(join(outside, 'summary.txt'), g.summary);
  symlinkSync(outside, join(g.root, 'redirect'), 'junction');
  const output = join(g.root, 'redirect', 'summary.txt');
  g.mission.goalContract = createGoalContract({ objective: "'source.txt'를 읽고 핵심을 요약해 'redirect/summary.txt'로 저장해줘" });
  g.mission.successCriteria[0].verificationSpec.path = 'redirect/summary.txt';
  g.actions[1].operation.dispatch.arguments.path = output;
  g.observations[1].artifacts[0].relativePath = 'redirect/summary.txt';
  assert.equal(g.assess().allowed, false);
});

test('actual truncated PC read reaches Mission as partial evidence and cannot complete despite a correct output oracle', async t => {
  const f = fixture(t);
  rmSync(join(f.root, 'summary.txt'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0',
    JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  const missionRunner = async prompt => {
    const line = prompt.split('\n').find(item => item.startsWith('실행 관찰: '));
    const observations = line ? JSON.parse(line.slice('실행 관찰: '.length)) : [];
    const read = observations.find(item => item.toolName === 'filesystem.readText');
    const write = observations.find(item => item.toolName === 'filesystem.createTextFile');
    if (write) return JSON.stringify({ decision: 'complete', summary: '출력 파일 내용은 일치합니다.', actions: [],
      criteriaAssessment: [{ criterionId: 'summary', status: 'satisfied', evidenceActionIds: [write.actionId], reason: '파일 내용 일치' }], question: null, blockedReason: null });
    const action = read ? { id: 'write', title: '요약 저장', command: 'summary.txt 텍스트 파일을 만들어줘',
      expectedToolName: 'filesystem.createTextFile', arguments: { path: join(f.root, 'summary.txt'), content: f.summary, allowOverwrite: false } }
      : { id: 'read', title: '원문 한 글자만 읽기', command: 'source.txt 내용을 읽어줘', expectedToolName: 'filesystem.readText',
        arguments: { path: join(f.root, 'source.txt'), offset: 0, maxChars: 1 } };
    return JSON.stringify({ decision: 'continue', summary: action.title, actions: [{ ...action, dependencies: [], successSignal: 'G 결과 확인' }],
      criteriaAssessment: [{ criterionId: 'summary', status: 'unsatisfied', evidenceActionIds: [], reason: '실행 중' }], question: null, blockedReason: null });
  };
  const runtime = createAgRuntime({ allowedRoots: [f.root], auditRoot: join(f.root, 'runtime'), env, taskEnv: env, missionRunner, workerDaemonEnabled: false });
  try {
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'summary-adversarial-test', durationMinutes: 5 });
    const created = runtime.missionRuntime.createMission({ objective: f.mission.goalContract.objective,
      successCriteria: f.mission.successCriteria.map(({ requirementId, ...criterion }) => criterion),
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] } });
    const result = await runtime.missionRuntime.runMission(created.missionId, { maxWaves: 4 });
    const read = result.observations.find(item => item.toolName === 'filesystem.readText');
    const write = result.observations.find(item => item.toolName === 'filesystem.createTextFile');
    assert.ok(read, JSON.stringify({ status: result.status, reason: result.stopReason }));
    assert.equal(read.verification.status, 'passed');
    assert.equal(read.data.fileEvidence.contentSha256, sha(f.source));
    assert.deepEqual(read.data.readExtent, { offset: 0, returnedChars: 1, bytes: Buffer.byteLength(f.source), truncated: true, encoding: 'utf8' });
    assert.equal(write?.verification.status, 'passed', 'the real write must succeed so the blocker is read coverage');
    assert.notEqual(result.status, 'COMPLETED');
    assert.equal(result.goalCompletionCoverage.allowed, false);
    assert.ok(result.goalCompletionCoverage.reasons.some(item => item.code === 'summary-read-before-write-unverified'));
  } finally { runtime.coreFacade.cognition.close(); }
});

test('discovered summary requires bound source search, output search, and a later full reread', t => {
  const make = () => {
    const f = fixture(t);
    f.mission.goalContract = createGoalContract({ objective: "'source.txt' 파일을 찾아 내용을 읽고 핵심 사실을 요약해 'summary.txt'로 저장한 다음, 저장된 요약 파일을 다시 찾아 읽고 확인해" });
    const requirementId = f.mission.goalContract.requirements[0].requirementId;
    const sourceRef = { rootIndex: 0, relativePath: 'source.txt', outsideAllowedRoots: false };
    const summaryRef = { rootIndex: 0, relativePath: 'summary.txt', outsideAllowedRoots: false };
    const definitions = [
      ['source-search', 'filesystem.searchFiles', { query: 'source.txt', scope: 'workspace' }, 0,
        { matches: [{ name: 'source.txt', artifact: sourceRef }] }, []],
      ['source-read', 'filesystem.readText', { path: join(f.root, 'source.txt'), offset: 0, maxChars: 12000 }, 2,
        { fileEvidence: { ...sourceRef, contentSha256: sha(f.source) }, readExtent: { offset: 0, returnedChars: f.source.length, bytes: Buffer.byteLength(f.source), truncated: false, encoding: 'utf8' } }, []],
      ['summary-write', 'filesystem.createTextFile', { path: join(f.root, 'summary.txt'), content: f.summary }, 4,
        {}, [{ ...summaryRef, contentSha256: sha(f.summary) }]],
      ['summary-search', 'filesystem.searchFiles', { query: 'summary.txt', scope: 'workspace' }, 6,
        { matches: [{ name: 'summary.txt', artifact: summaryRef }] }, []],
      ['summary-read', 'filesystem.readText', { path: join(f.root, 'summary.txt'), offset: 0, maxChars: 12000 }, 8,
        { fileEvidence: { ...summaryRef, contentSha256: sha(f.summary) }, readExtent: { offset: 0, returnedChars: f.summary.length, bytes: Buffer.byteLength(f.summary), truncated: false, encoding: 'utf8' } }, []]
    ];
    const actions = definitions.map(([id, tool, args], index) => ({ actionId: id, taskId: `task-${id}`, observationId: `observation-${id}`,
      status: 'succeeded', requirementIds: [requirementId], dependencies: index ? [definitions[index - 1][0]] : [], actualToolName: tool,
      operation: { dispatch: { taskId: `task-${id}`, toolName: tool, arguments: args,
        dispatchedAt: `2026-09-27T10:00:${String(index * 2).padStart(2, '0')}.000Z` } } }));
    const observations = definitions.map(([id, tool, , , data, artifacts], index) => ({ observationId: `observation-${id}`, actionId: id,
      taskId: `task-${id}`, toolName: tool, outcome: 'success', evidenceId: `evidence-${id}`,
      verification: { status: 'passed', verificationId: `verification-${id}`, failedCheckIds: [] },
      createdAt: `2026-09-27T10:00:${String(index * 2 + 1).padStart(2, '0')}.000Z`, data, artifacts }));
    f.mission.waves = [{ actions }]; f.mission.observations = observations;
    return { ...f, actions, observations, assess: () => assessMissionGoalCompletionCoverage({ mission: f.mission, allowedRoots: [f.root] }) };
  };
  const valid = make(), result = valid.assess();
  assert.equal(result.allowed, true, JSON.stringify(result));
  assert.deepEqual(new Set(result.evidenceActionIds), new Set(valid.actions.map(action => action.actionId)));
  for (const item of [
    f => { f.actions.splice(0, 1); f.observations.splice(0, 1); },
    f => { f.actions.splice(3, 1); f.observations.splice(3, 1); },
    f => { f.actions[3].operation.dispatch.arguments.query = 'other.txt'; },
    f => { f.observations[3].data.matches[0].artifact.outsideAllowedRoots = true; },
    f => { f.observations[3].data.matches[0].artifact.rootIndex = -1; },
    f => { f.observations[3].data.matches[0].artifact.rootIndex = 1; },
    f => { f.observations[3].data.matches[0].artifact.rootIndex = 0.5; },
    f => { f.observations[3].data.matches[0].artifact.relativePath = join(f.root, 'summary.txt'); },
    f => { f.observations[3].data.matches[0].artifact.relativePath = '../summary.txt'; },
    f => { f.actions[4].operation.dispatch.dispatchedAt = '2026-09-27T10:00:05.000Z'; },
    f => { f.observations[4].data.readExtent.returnedChars--; },
    f => { f.actions[4].operation.dispatch.arguments.path = join(f.root, 'source.txt'); }
  ].entries()) { const [index, mutate] = item; const f = make(); mutate(f); const assessed = f.assess(); assert.equal(assessed.allowed, false, `mutation ${index}: ${JSON.stringify(assessed)}`); }
});
