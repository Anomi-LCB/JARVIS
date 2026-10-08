import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import { createPersonalContextProvider } from '../packages/core/src/personal-operations/personal-profile.js';
import { normalizePersonalContext, personalContextFingerprint } from '../packages/core/src/planning/personal-context.js';
import { ActionType, ApprovalDecision, createApprovalDecision, createTaskRequest, ModuleId } from '../packages/shared/src/types.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';

function fakeProfile(revision = 'fictional-revision-1') {
  return { revision, storedAt:'2026-09-14T01:01:00.000Z', profile: { ownerUserId: 'local_user', source:{kind:'direct-user-statement',receivedAt:'2026-09-14T01:00:00.000Z'},
    identity: { name: 'FICTIONAL_PRIVATE_IDENTITY' }, sourceDocument: 'FICTIONAL_PRIVATE_SOURCE',
    sections: [
      { id: 'general', scope: 'general', items: ['FICTIONAL_GENERAL_STYLE'] },
      { id: 'theology', scope: 'theology', items: ['FICTIONAL_THEOLOGY_RULE'] },
      { id: 'development', scope: 'development', items: ['FICTIONAL_DEVELOPMENT_RULE'] }
    ], goals: [], projects: [] } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-profile-integration-'));
  t.after(async () => {
    assert.ok(relative(tmpdir(), root).startsWith('jarvis-profile-integration-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function plannerIn(root, runner, options = {}) {
  const paths = { JARVIS_CONTENT_CACHE_PATH: join(root, 'content.jsonl'),
    JARVIS_SHELL_CACHE_PATH: join(root, 'shell.jsonl'), JARVIS_PLAN_CACHE_PATH: join(root, 'plan.jsonl') };
  const previous = Object.fromEntries(Object.keys(paths).map(key => [key, process.env[key]]));
  Object.assign(process.env, paths);
  try { return new ClaudeCliTaskPlanner({ runner, clarifyEnabled: false, workspaceRoot: root, ...options }); }
  finally {
    for (const key of Object.keys(paths)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

function runtimeIn(root, options = {}) {
  return createAgRuntime({ env: { JARVIS_TEST_MODE: '1' }, allowedRoots: [root], auditRoot: join(root, 'audit'),
    workerDaemonEnabled: false, ...options });
}

async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path)); else files.push(path);
  }
  return files;
}

test('private profile reaches Core draft and replan by domain without entering task records, caches or authority', async t => {
  const root = await fixture(t), prompts = [];
  const store = { load: () => fakeProfile() };
  const planner = plannerIn(root, prompt => { prompts.push(prompt); return JSON.stringify({ kind: 'txt', content: '검사 산출물' }); },
    { contentEnabled: true, contentSmartSkip: false });
  const runtime = runtimeIn(root, { taskPlanner: planner, personalProfileStore: store });
  t.after(() => runtime.coreFacade.cognition.close());
  const task = runtime.coreFacade.createTask('설교 연구 보고서.txt 텍스트 파일을 만들어줘');
  assert.ok(prompts.some(value => value.includes('FICTIONAL_THEOLOGY_RULE')));
  assert.ok(prompts.some(value=>value.includes('2026-09-14T01:00:00.000Z')&&value.includes('current-revision-reference')));
  assert.ok(prompts.every(value => !value.includes('FICTIONAL_DEVELOPMENT_RULE') && !value.includes('FICTIONAL_PRIVATE')));
  assert.match(prompts[0], /현재 사용자 요청과 실행 정책보다 우선하지 않습니다/);
  assert.equal(task.personalContext, undefined);
  assert.equal(JSON.stringify(task).includes('FICTIONAL_'), false);
  const policyBefore = { decision: task.policy.decision, risk: task.approvalCard.riskTier };

  const result = runtime.coreFacade.submitApprovalDecision(createApprovalDecision({
    approvalId: task.approvalCard.approvalId, taskId: task.taskId, decision: ApprovalDecision.EDIT,
    deviceId: 'profile-test', sourceModule: ModuleId.CORE,
    editRequest: { rawText: '개발 연구 보고서.txt 텍스트 파일을 만들어줘' }
  }));
  assert.equal(result.success, true);
  assert.ok(prompts.at(-1).includes('FICTIONAL_DEVELOPMENT_RULE'));
  assert.equal(prompts.at(-1).includes('FICTIONAL_THEOLOGY_RULE'), false);
  assert.equal(JSON.stringify(runtime.coreFacade.getTask(task.taskId)).includes('FICTIONAL_'), false);
  assert.equal(task.policy.decision, policyBefore.decision);
  assert.equal(task.approvalCard.riskTier, policyBefore.risk);

  const beforeOther = prompts.length;
  runtime.coreFacade.createTask('설교 연구 다른 보고서.txt 텍스트 파일을 만들어줘', { userId: 'other_user' });
  assert.ok(prompts.length > beforeOther);
  assert.equal(prompts.at(-1).includes('FICTIONAL_'), false);
  for (const path of await filesBelow(root)) {
    if (/\.(?:json|jsonl)$/u.test(path)) assert.equal((await readFile(path, 'utf8')).includes('FICTIONAL_'), false, path);
  }
});

test('actual Mission planner runner receives current owner projection and keeps it out of persisted missions', async t => {
  const root = await fixture(t), prompts = [];
  let current = fakeProfile();
  const missionPlanner = new GoalExecutivePlanner({ runner: async prompt => {
    prompts.push(prompt);
    return JSON.stringify({ decision: 'ask_user', summary: '검사 질문', question: '연구할 본문은 무엇인가요?',
      actions: [], criteriaAssessment: [] });
  }, dataClassifier: { classify: () => ({ dataClass: 'D0', ministryDataClass: 'M0', matchedRules: [] }) } });
  const runtime = runtimeIn(root, { personalProfileStore: { load: () => current }, missionPlanner });
  t.after(() => runtime.coreFacade.cognition.close());
  const created = runtime.missionRuntime.createMission({ objective: '설교 연구 전략을 비교해줘' });
  const mission = runtime.missionRuntime.missions.get(created.missionId);
  await missionPlanner.planNextWave(runtime.missionRuntime.plannerContext(mission, Date.now()));
  assert.ok(prompts.at(-1).includes('FICTIONAL_THEOLOGY_RULE'));
  assert.equal(prompts.at(-1).includes('FICTIONAL_PRIVATE'), false);
  current = null;
  await missionPlanner.planNextWave(runtime.missionRuntime.plannerContext(mission, Date.now()));
  assert.equal(prompts.at(-1).includes('FICTIONAL_'), false);
  current = fakeProfile();
  mission.metadata.userId = 'other_user';
  await missionPlanner.planNextWave(runtime.missionRuntime.plannerContext(mission, Date.now()));
  assert.equal(prompts.at(-1).includes('FICTIONAL_'), false);
  assert.equal(JSON.stringify(runtime.missionRuntime.store.load()).includes('FICTIONAL_'), false);
});

test('content, decomposition and shell caches are separated by profile changes and contain only hashed keys', async t => {
  const root = await fixture(t), calls = { content: 0, shell: 0, plan: 0 };
  const planner = plannerIn(root, prompt => {
    if (prompt.includes('작업 계획 분해기')) { calls.plan++; return JSON.stringify({ summary: '검사 계획', parts: [
      { actionType: ActionType.LIST_FILES, text: '파일 목록 보여줘', slots: {} }
    ] }); }
    if (prompt.includes('PowerShell')) { calls.shell++; return JSON.stringify({ command: 'Get-Date', verify: '' }); }
    calls.content++; return JSON.stringify({ kind: 'txt', content: '검사 결과' });
  });
  const provider = createPersonalContextProvider({ env: { JARVIS_TEST_MODE: '1' }, store: { load: () => fakeProfile() } });
  const first = provider({ rawText: '설교 연구', userId: 'local_user' });
  const second = createPersonalContextProvider({env:{JARVIS_TEST_MODE:'1'},store:{load:()=>fakeProfile('fictional-revision-2')}})({rawText:'설교 연구',userId:'local_user'});
  const exercise = () => {
    planner.draftContentFor({ text: '검사 문서', outputFormat: 'txt', locale: 'ko-KR' });
    planner.draftShellCommandFor({ text: '날짜 확인', locale: 'ko-KR' });
    planner.decomposeWithLlm('목록을 보여주고 다른 목록도 보여줘', { complexity: { needsPlanDecomposition: true } });
  };
  planner.pendingPersonalContext = first;
  exercise(); exercise();
  assert.deepEqual(calls, { content: 1, shell: 1, plan: 1 });
  planner.pendingPersonalContext = second;
  exercise();
  assert.deepEqual(calls, { content: 2, shell: 2, plan: 2 });
  planner.pendingPersonalContext = null;
  exercise();
  assert.deepEqual(calls, { content: 3, shell: 3, plan: 3 });
  for (const name of ['content.jsonl', 'shell.jsonl', 'plan.jsonl']) {
    const content = await readFile(join(root, name), 'utf8');
    assert.equal(content.includes('FICTIONAL_'), false);
    for (const row of content.trim().split('\n').map(JSON.parse)) assert.match(row.key, /^[a-f0-9]{64}$/u);
  }
});

test('planner clears private projection after a model failure and later requests do not inherit it', async t => {
  const root = await fixture(t), prompts = [];
  const planner = plannerIn(root, prompt => { prompts.push(prompt); throw new Error('synthetic provider failure'); });
  const request = createTaskRequest({ rawText: '문서를 작성하고 뉴스도 검색해줘' });
  const intent = new IntentParser().parse(request.command.rawText, { requestId: request.requestId });
  const personalContext = createPersonalContextProvider({ env: {}, store: { load: () => fakeProfile() } })({ rawText: '개발', userId: 'local_user' });
  planner.createPlan(request, intent, { personalContext });
  assert.equal(planner.pendingPersonalContext, null);
  assert.ok(prompts.some(prompt => prompt.includes('FICTIONAL_DEVELOPMENT_RULE')));
  prompts.length = 0;
  planner.createPlan(request, intent, {});
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every(prompt => !prompt.includes('FICTIONAL_')));
});

test('test-mode runtime never implicitly reads a real owner profile', async t => {
  const root = await fixture(t);
  const runtime = runtimeIn(root);
  t.after(() => runtime.coreFacade.cognition.close());
  assert.equal(runtime.coreFacade.personalContextFor('설교 연구', 'local_user'), null);
});

test('admin diagnostics report loaded revision without profile text and update after removal', async t => {
  const root = await fixture(t);
  let current = fakeProfile();
  const runtime = runtimeIn(root, { personalProfileStore: { load: () => current } });
  t.after(() => runtime.coreFacade.cognition.close());
  const status = runtime.coreFacade.adminDiagnostics().personalProfile;
  assert.deepEqual(status, { available: true, profileRevision: current.revision,
    generalSectionCount: 1, identityIncluded: false });
  assert.equal(JSON.stringify(status).includes('FICTIONAL_'), false);
  current = null;
  assert.deepEqual(runtime.coreFacade.adminDiagnostics().personalProfile,
    { available: false, profileRevision: null, generalSectionCount: 0, identityIncluded: false });
});

test('prompt projection drops identity and arbitrary fields without losing valid selected preferences', () => {
  const projected = createPersonalContextProvider({ env: {}, store: { load: () => fakeProfile() } })({ rawText: '개발', userId: 'local_user' });
  const withExtra = { ...projected, identity: { name: 'PRIVATE_NAME' }, sourceDocument: 'PRIVATE_SOURCE',
    preferences: projected.preferences.map(value => ({ ...value, owner: 'PRIVATE_OWNER' })) };
  assert.deepEqual(normalizePersonalContext(withExtra), projected);
  assert.equal(personalContextFingerprint(withExtra), personalContextFingerprint(projected));
  assert.equal(normalizePersonalContext({ ...withExtra, authority: 'unrestricted' }), null);
});
