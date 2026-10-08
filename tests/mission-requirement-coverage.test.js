import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createGoalContract } from '../packages/core/src/mission/goal-contract.js';
import { assessMissionRequirementCoverage, normalizeActionRequirementLinks } from '../packages/core/src/mission/mission-requirement-coverage.js';
import { MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';

const external = { toolName: 'email.send', externalTransfer: true, externalNetwork: true, readOnly: false, executionClass: 'external_commit' };
const read = { toolName: 'filesystem.readText', externalTransfer: false, externalNetwork: false, readOnly: true, contractReadOnly: true, executionClass: 'read_only' };
const hash = 'a'.repeat(64);
const attachment = { attachmentRef: { rootIndex: 0, relativePath: 'draft.txt' }, attachmentSha256: hash };

function graph(objective = "'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 내 이메일로 보내", timeZone = 'Asia/Seoul') {
  const goalContract = createGoalContract({ objective, timeZone });
  const actions = goalContract.requirements.map((requirement, index) => ({ actionId: `a${index}`, taskId: `t${index}`,
    expectedToolName: ['filesystem.readText', 'filesystem.createTextFile', 'email.send'][index] ?? 'email.send',
    actualToolName: ['filesystem.readText', 'filesystem.createTextFile', 'email.send'][index] ?? 'email.send',
    requirementIds: [requirement.requirementId], constraintRequirementIds: [], dependencies: index ? [`a${index - 1}`] : [], status: 'planned',
    arguments: index === 0 ? { path: 'source.txt' } : index === 1 ? { path: 'draft.txt' } : { attachments: [attachment] } }));
  const wave = { actions };
  const mission = { objective, goalContract, waves: [wave], observations: [], constraints: [], workspaceRoot: process.cwd() };
  return { mission, wave, actions };
}
function verify(f, index) {
  const action = f.actions[index];
  action.status = 'succeeded'; action.observationId = `obs:${index}`;
  action.operation = { dispatch: { taskId: action.taskId, toolName: action.actualToolName, arguments: structuredClone(action.arguments) } };
  const file = { rootIndex: 0, relativePath: action.arguments.path, contentSha256: hash, outsideAllowedRoots: false };
  f.mission.observations.push({ observationId: action.observationId, actionId: action.actionId, taskId: action.taskId,
    toolName: action.actualToolName, outcome: 'success', evidenceId: `synthetic-evidence:${index}`,
    verification: { status: 'passed', verificationId: `synthetic-g:${index}` },
    data: { fileEvidence: file }, artifacts: [file] });
}
const assess = (f, phase = 'dispatch') => assessMissionRequirementCoverage({ mission: f.mission, wave: f.wave, action: f.actions.at(-1), profile: external, phase });

test('an omitted recipient cannot be silently interpreted as self',()=>{
 for(const args of [{},{to:'self',recipientMode:'self'},{to:'',recipientMode:'self'}]){
  const f=graph("'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 보내");verify(f,0);verify(f,1);Object.assign(f.actions.at(-1).arguments,args);
  const result=assess(f);assert.equal(result.allowed,false,JSON.stringify(args));
  assert.ok(result.reasons.some(r=>r.code==='external-recipient-source-binding-unresolved'));
  assert.match(result.nextAction,/이메일 주소/);
 }
});

test('email destinations are reparsed from the exact source, not trusted planner metadata', () => {
  const objective="'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 Intended@example.test 보내";
  for(const [to,mode,expected] of [
    ['Intended@example.test','explicit',true],['Intended@EXAMPLE.TEST','explicit',true],
    ['intended@example.test','explicit',false],['other@example.test','explicit',false],
    ['','self',false],[['Intended@example.test'],'explicit',false],['Intended@example.test','self',false]
  ]) {
    const f=graph(objective);verify(f,0);verify(f,1);
    Object.assign(f.actions.at(-1).arguments,{to,recipientMode:mode});
    assert.equal(assess(f).allowed,expected,JSON.stringify({to,mode}));
    delete f.mission.goalContract.requirements.at(-1).interpretation.emailRecipient;
    assert.equal(assess(f).allowed,expected,'older saved contracts must use the original clause');
  }
  const f=graph(objective);verify(f,0);verify(f,1);
  Object.assign(f.actions.at(-1).arguments,{to:'other@example.test',recipientMode:'explicit'});
  f.mission.goalContract.requirements.at(-1).interpretation.emailRecipient={mode:'address',address:'other@example.test'};
  assert.equal(assess(f).allowed,false);
  f.mission.goalContract.requirements.at(-1).text="'draft.txt'를 other@example.test 보내";
  assert.equal(assess(f).allowed,false,'stored text must match its original source span');
});

test('self destination cannot be replaced with a planner supplied address', () => {
  for(const [to,mode,expected] of [['','self',true],['self','self',true],
    ['other@example.test','self',false],['other@example.test','explicit',false],['','explicit',false]]) {
    const f=graph("'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 내 구글 이메일로 보내");
    verify(f,0);verify(f,1);Object.assign(f.actions.at(-1).arguments,{to,recipientMode:mode});
    assert.equal(assess(f).allowed,expected,JSON.stringify({to,mode}));
  }
});

test('planning keeps predecessor links but dispatch requires their independent recorded G observations', () => {
  const f = graph();
  assert.equal(assess(f, 'planning').allowed, true);
  assert.equal(assess(f).allowed, false);
  verify(f, 0); verify(f, 1);
  const result = assess(f);
  assert.equal(result.allowed, true);
  assert.equal(result.semanticAccuracyVerified, false);
  assert.equal(result.executionAuthority, false);
  f.mission.observations[0].taskId = 'unrelated-task';
  assert.equal(assess(f).allowed, false);
});

test('a completed status or a pasted verification flag without the action-bound G observation does not count', () => {
  const f = graph();
  f.actions[0].status = 'succeeded'; f.actions[1].status = 'succeeded';
  f.actions[0].verification = { status: 'passed' };
  assert.equal(assess(f).allowed, false);
  verify(f, 0); verify(f, 1);
  f.mission.observations[1].evidenceId = null;
  assert.equal(assess(f).allowed, false);
});

test('omitted requirements and attaching every ID to one email do not bypass coverage', () => {
  const f = graph();
  f.actions.at(-1).dependencies = [];
  assert.equal(assess(f, 'planning').allowed, false);
  f.actions.at(-1).requirementIds = f.mission.goalContract.requirements.map(item => item.requirementId);
  assert.equal(assess(f).allowed, false);
  assert.ok(assess(f).reasons.some(reason => reason.code === 'external-action-requirement-not-independently-bound'));
});

test('read-only work can continue while an unknown compound or correction keeps external effects blocked', () => {
  const f = graph('자료를 읽고 요약해서 검토해; 초안을 저장해; 아니, 다른 사람에게 보내');
  assert.equal(assessMissionRequirementCoverage({ ...f, action: f.actions[0], profile: read }).allowed, true);
  verify(f, 0); verify(f, 1);
  assert.equal(assess(f).allowed, false);
  const compound = graph('원본을 읽고 요약한 뒤 검토해; 초안을 저장해; 초안을 보내');
  verify(compound, 0); verify(compound, 1);
  assert.equal(assess(compound).allowed, false, 'a read G receipt must not prove the hidden summarize and review demands');
  assert.ok(assess(compound).reasons.some(reason => reason.code === 'requirement-meaning-unresolved'));
});

test('ambiguous relative or DST wall times block external dispatch even when the attachment otherwise matches', () => {
  for (const [objective, timeZone] of [
    ["'source.txt'를 읽어; 'draft.txt'를 저장해; 다음 화요일에 'draft.txt'를 보내", 'Asia/Seoul'],
    ["'source.txt'를 읽어; 'draft.txt'를 저장해; 2026-03-08 오전 2시에 'draft.txt'를 보내", 'America/New_York'],
    ["'source.txt'를 읽어; 'draft.txt'를 저장해; 2026-10-04 오전 2시 15분에 'draft.txt'를 보내", 'Australia/Lord_Howe'],
    ["'source.txt'를 읽어; 'draft.txt'를 저장해; 5영업일 이내 'draft.txt'를 보내", 'Asia/Seoul'],
    ["'source.txt'를 읽어; 'draft.txt'를 저장해; 조만간 'draft.txt'를 보내", 'Asia/Seoul']
  ]) {
    const f = graph(objective, timeZone);
    verify(f, 0); verify(f, 1);
    const result = assess(f);
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.some(reason => reason.code === 'goal-time-unresolved'));
  }
});

test('known prohibitions, supplemental constraints and contradictory requirements stop external dispatch', () => {
  const prohibited = graph('원본을 읽어; 초안을 저장해; 초안을 보내지 마');
  verify(prohibited, 0); verify(prohibited, 1);
  prohibited.actions.at(-1).requirementIds = [];
  prohibited.actions.at(-1).constraintRequirementIds = [prohibited.mission.goalContract.requirements.at(-1).requirementId];
  assert.equal(assess(prohibited).allowed, false);
  const f = graph(); verify(f, 0); verify(f, 1);
  f.mission.constraints = ['수신자가 분명하지 않으면 보내지 마'];
  assert.equal(assess(f).allowed, false);
  assert.ok(assess(f).reasons.some(reason => reason.code === 'supplemental-constraints-unverified'));
});

test('a local prohibition blocks only the matching structured operation, preserving unrelated reversible work', () => {
  const goalContract = createGoalContract({ objective: "'report.txt'를 삭제하지 마" });
  const action = { actionId: 'save-safe-note', expectedToolName: 'filesystem.createTextFile', actualToolName: 'filesystem.createTextFile',
    arguments: { path: resolve('safe-note.txt'), content: 'ok' }, requirementIds: [], constraintRequirementIds: [], dependencies: [] };
  const mission = { goalContract, waves: [{ actions: [action] }], observations: [], constraints: [], workspaceRoot: process.cwd() };
  const result = assessMissionRequirementCoverage({ mission, wave: mission.waves[0], action,
    profile: { toolName: 'filesystem.createTextFile', externalTransfer: false, externalNetwork: false,
      readOnly: false, mutatesSystem: true, executionClass: 'local_reversible' } });
  assert.equal(result.allowed, true);
  assert.equal(result.required, false);
});

test('a recognized sentence-level prohibition blocks a matching document edit under reversible grant', () => {
  const objective = '현재 작업 폴더의 파일 이름 목록을 보여줘. 파일은 수정하지 마.';
  const goalContract = createGoalContract({ objective });
  const wave = { actions: [] };
  const action = { actionId: 'edit-prohibited-file', expectedToolName: 'document.edit', actualToolName: 'document.edit',
    arguments: { path: resolve('report.xlsx'), edits: [] }, requirementIds: [],
    constraintRequirementIds: [], dependencies: [] };
  wave.actions.push(action);
  const mission = { goalContract, waves: [wave], observations: [], constraints: [], workspaceRoot: process.cwd() };
  const result = assessMissionRequirementCoverage({ mission, wave, action,
    profile: { toolName: 'document.edit', externalTransfer: false, externalNetwork: false,
      readOnly: false, mutatesSystem: true, executionClass: 'local_reversible' } });
  assert.equal(result.required, true);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some(reason => reason.code === 'external-action-conflicts-with-prohibition'));
});

test('Mission withdraws an undispatched approval card for a model-proposed action that violates an explicit prohibition', async () => {
  const tasks = new Map(), cancellations = [], dispatched = [], events = [];
  const coreFacade = {
    getTask: id => tasks.get(id),
    createMissionActionTask: (command, options) => {
      const task = { taskId: options.reservedTaskId, status: 'WAITING_APPROVAL',
        approvalCard: { approvalId: 'approval-prohibited-edit' },
        plan: { action: { toolName: options.expectedToolName, arguments: options.preparedArguments,
          capability: { writesLocalFiles: true } } },
        policy: { risk: { tier: 2 } } };
      tasks.set(task.taskId, task);
      return task;
    },
    cancelTask: (id, details) => {
      cancellations.push({ id, details });
      const task = tasks.get(id);
      task.status = 'CANCELLED';
      return { success: true, status: task.status };
    }
  };
  const runtime = new MissionRuntime({ coreFacade,
    orchestrationWorker: { async runTask(id) { dispatched.push(id); throw new Error('must not dispatch'); } },
    pcAgent: { registry: { contractFor: () => ({ readOnly: false, writesLocalFiles: true }) } },
    planner: { async planNextWave() { throw new Error('unused'); } }, allowedRoots: [process.cwd()] });
  coreFacade.eventBus = { publish: eventType => events.push(eventType) };
  runtime.capabilityAvailabilityGuard.assess = async () => ({ required: false });
  const created = runtime.createMission({ objective: '현재 작업 폴더의 파일 이름을 보여줘. 파일은 수정하지 마.' });
  const mission = runtime.missions.get(created.missionId);
  const wave = runtime.createWave(mission, { actions: [{ id: 'bad-edit', title: '불필요한 파일 수정',
    command: 'report.txt를 수정해줘', expectedToolName: 'document.edit', dependencies: [],
    arguments: { path: resolve('report.txt'), edits: [] } }] });

  await runtime.executeWave(mission, wave);

  assert.equal(mission.status, 'PAUSED');
  assert.equal(mission.stopReason, 'external-action-requirements-unverified');
  assert.equal(tasks.get(wave.actions[0].reservedTaskId).status, 'CANCELLED');
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].details.reason, 'mission-requirement-coverage-rejected');
  assert.deepEqual(dispatched, []);
  assert.equal(wave.actions[0].attempts, 0);
  assert.ok(events.includes('mission.action.prohibited-approval-withdrawn'));
});

test('missing and invalid source links cannot be silently sanitized away', () => {
  const contract = createGoalContract({ objective: '원본을 읽어; 원본은 삭제하지 마' });
  assert.throws(() => normalizeActionRequirementLinks({ requirementIds: ['made-up'] }, contract), { code: 'A_MISSION_REQUIREMENT_LINK_INVALID' });
  assert.throws(() => normalizeActionRequirementLinks({ requirementIds: [contract.requirements[1].requirementId] }, contract), { code: 'A_MISSION_REQUIREMENT_LINK_INVALID' });
  assert.throws(() => normalizeActionRequirementLinks({ requirementIds: [contract.requirements[0].requirementId, contract.requirements[0].requirementId] }, contract), { code: 'A_MISSION_REQUIREMENT_LINK_INVALID' });
  assert.deepEqual(normalizeActionRequirementLinks({}, contract), { requirementIds: [], constraintRequirementIds: [] });
});

test('the real planner sanitizer preserves source IDs and rejects unknown or malformed ID lists', () => {
  const planner = new GoalExecutivePlanner({ runner: async () => '{}' });
  const goalContract = createGoalContract({ objective: '원본을 읽어; 초안을 보내' });
  const context = { capabilities: [{ toolName: 'filesystem.readText' }], observations: [],
    mission: { objective: goalContract.objective, goalContract, successCriteria: [] } };
  const action = { id: 'read', title: '원본 읽기', command: '원본 내용을 읽어줘', expectedToolName: 'filesystem.readText',
    arguments: { path: resolve('fixture.txt'), maxChars: 2000 }, dependencies: [], requirementIds: [goalContract.requirements[0].requirementId] };
  const payload = { decision: 'continue', actions: [action], criteriaAssessment: [] };
  assert.deepEqual(planner.sanitizePlan(payload, context).actions[0].requirementIds, action.requirementIds);
  assert.equal(planner.sanitizePlan({ ...payload, actions: [{ ...action, requirementIds: ['invented'] }] }, context), null);
  assert.equal(planner.sanitizePlan({ ...payload, actions: [{ ...action, requirementIds: action.requirementIds[0] }] }, context), null);
});

function runtimeFixture(objective) {
  const tasks = new Map(), dispatches = [], approvals = [];
  const coreFacade = {
    getTask: id => tasks.get(id),
    createMissionActionTask: (command, options) => {
      const taskId = options.reservedTaskId;
      assert.match(taskId,/^mission_task_[a-f0-9]{32}$/u);
      const toolName = options.expectedToolName;
      const task = { taskId, status: 'PLANNED', plan: { action: { toolName, arguments: options.preparedArguments,
        capability: { writesLocalFiles: false, externalTransfer: toolName === 'email.send', externalNetwork: toolName === 'email.send' } } }, policy: { risk: { tier: 4 } } };
      tasks.set(taskId, task); return task;
    }
  };
  const worker = { async runTask(taskId) {
    const task = tasks.get(taskId); dispatches.push(task.plan.action.toolName); task.status = 'COMPLETED';
    return { success: true, execution: { status: 'COMPLETED', evidence: { evidenceId: `synthetic-evidence:${taskId}` },
      executionResult: { contentSha256: hash, outputPaths: task.plan.action.toolName === 'filesystem.createTextFile' ? [resolve(task.plan.action.arguments.path)] : [] } },
      executionVerification: { verificationId: `synthetic-g:${taskId}`, status: 'passed', checks: [] } };
  } };
  const runtime = new MissionRuntime({ coreFacade, orchestrationWorker: worker,
    pcAgent: { registry: { contractFor: tool => ({ readOnly: tool !== 'email.send' }) } },
    planner: { async planNextWave() { throw new Error('unused'); } }, allowedRoots: [process.cwd()] });
  // Isolate the requirement guard using explicit synthetic availability and E decisions.
  // No provider, account, network or actual email action is called by this harness.
  runtime.capabilityAvailabilityGuard.assess = async () => ({ required: false });
  runtime.actionAuthorized = (mission, action, profile) => {
    approvals.push(profile.toolName);
    action.authorizationRevision = mission.authorizationRevision ?? 1;
    action.authorizationCheckRevision = mission.authorizationRevision ?? 1;
    return true;
  };
  const created = runtime.createMission({ objective });
  return { runtime, mission: runtime.missions.get(created.missionId), dispatches, approvals };
}
function planned(id, tool, requirementIds, dependencies = []) {
  return { id, title: id, command: `${id} 합성 작업`, expectedToolName: tool, requirementIds, dependencies,
    arguments: tool === 'email.send' ? { recipientMode: 'self', attachments: [attachment] } : { path: resolve('draft.txt') } };
}

for(const clause of ["'draft.txt'를 보내","'draft.txt'를 김민수에게 보내","'draft.txt'를 회계팀 김민수에게 보내","아니, 'draft.txt'를 그 사람에게 보내","'draft.txt'를 나 말고 김민수에게 보내"])
test('runtime preserves an independent read but never invents a recipient: '+clause,async()=>{
 const f=runtimeFixture("'draft.txt'를 읽어; "+clause),ids=f.mission.goalContract.requirements.map(r=>r.requirementId);
 const wave=f.runtime.createWave(f.mission,{actions:[planned('read','filesystem.readText',[ids[0]]),planned('send','email.send',[ids[1]],['read'])]});
 await f.runtime.executeWave(f.mission,wave);
 assert.deepEqual(f.dispatches,['filesystem.readText']);assert.deepEqual(f.approvals,['filesystem.readText']);
 assert.equal(wave.actions[1].attempts,0);assert.equal(f.mission.status,'PAUSED');
 assert.equal(f.mission.goalContract.requirements[1].text,clause);
});

test('actual wave flow executes an independent read while a partial email plan is stopped before E prompt and worker handoff', async () => {
  const f = runtimeFixture('원본을 읽어; 초안을 저장해; 초안을 보내');
  const ids = f.mission.goalContract.requirements.map(item => item.requirementId);
  const wave = f.runtime.createWave(f.mission, { actions: [planned('read', 'filesystem.readText', [ids[0]]), planned('send', 'email.send', [ids[2]])] });
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.dispatches, ['filesystem.readText']);
  assert.deepEqual(f.approvals, ['filesystem.readText']);
  assert.equal(f.mission.status, 'PAUSED');
  assert.equal(f.mission.stopReason, 'external-action-requirements-unverified');
  assert.equal(wave.actions[0].status, 'succeeded');
  assert.equal(wave.actions[1].attempts, 0);
  assert.deepEqual(f.runtime.getMission(f.mission.missionId).waves[0].actions[1].requirementIds, [ids[2]]);
});

test('actual Mission runs verified local predecessors but withholds email dispatch when its relative time is unresolved', async () => {
  const f = runtimeFixture("'draft.txt'를 읽어; 'draft.txt'를 저장해; 5영업일 이내 'draft.txt'를 보내");
  const ids = f.mission.goalContract.requirements.map(item => item.requirementId);
  const wave = f.runtime.createWave(f.mission, { actions: [
    planned('read', 'filesystem.readText', [ids[0]]),
    planned('save', 'filesystem.createTextFile', [ids[1]], ['read']),
    planned('send', 'email.send', [ids[2]], ['save'])
  ] });
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.dispatches, ['filesystem.readText', 'filesystem.createTextFile']);
  assert.equal(f.mission.status, 'PAUSED');
  assert.equal(f.mission.stopReason, 'external-action-requirements-unverified');
  assert.equal(wave.actions[0].status, 'succeeded');
  assert.equal(wave.actions[1].status, 'succeeded');
  assert.equal(wave.actions[2].attempts, 0);
  assert.ok(wave.actions[2].requirementCoverage.reasons.some(item => item.code === 'goal-time-unresolved'));
});

test('actual Mission withholds email dispatch until an event-relative condition is resolved', async () => {
  const f = runtimeFixture("'draft.txt'를 읽어; 'draft.txt'를 저장해; 아이 도착하면 'draft.txt'를 보내");
  const ids = f.mission.goalContract.requirements.map(item => item.requirementId);
  const wave = f.runtime.createWave(f.mission, { actions: [
    planned('read', 'filesystem.readText', [ids[0]]),
    planned('save', 'filesystem.createTextFile', [ids[1]], ['read']),
    planned('send', 'email.send', [ids[2]], ['save'])
  ] });
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.dispatches, ['filesystem.readText', 'filesystem.createTextFile']);
  assert.equal(f.mission.status, 'PAUSED');
  assert.equal(f.mission.stopReason, 'external-action-requirements-unverified');
  assert.equal(wave.actions[0].status, 'succeeded');
  assert.equal(wave.actions[1].status, 'succeeded');
  assert.equal(wave.actions[2].attempts, 0);
  assert.ok(wave.actions[2].requirementCoverage.reasons.some(item => item.code === 'goal-time-unresolved'));
});

for (const [amount, code] of [['0.5원 이하', 'goal-amount-unresolved'], ['10,000원 이하', 'goal-amount-effect-unverified']]) {
  test(`actual Mission keeps independent local work but does not drop a monetary condition: ${amount}`, async () => {
    const f = runtimeFixture(`'draft.txt'를 읽어; 'draft.txt'를 저장해; ${amount} 'draft.txt'를 보내`);
    const ids = f.mission.goalContract.requirements.map(r => r.requirementId);
    const wave = f.runtime.createWave(f.mission, {actions: [
      planned('read', 'filesystem.readText', [ids[0]]),
      planned('save', 'filesystem.createTextFile', [ids[1]], ['read']),
      planned('send', 'email.send', [ids[2]], ['save'])
    ]});
    await f.runtime.executeWave(f.mission, wave);
    assert.deepEqual(f.dispatches, ['filesystem.readText', 'filesystem.createTextFile']);
    assert.deepEqual(f.approvals, ['filesystem.readText', 'filesystem.createTextFile']);
    assert.equal(f.mission.status, 'PAUSED');
    assert.equal(wave.actions[2].attempts, 0);
    assert.ok(wave.actions[2].requirementCoverage.reasons.some(r => r.code === code));
  });
}

test('the dispatch recheck detects lost predecessor evidence even after preparation and synthetic E permission', async () => {
  const f = runtimeFixture("'draft.txt'를 읽어; 'draft.txt'를 내 이메일로 보내");
  const ids = f.mission.goalContract.requirements.map(item => item.requirementId);
  const wave = f.runtime.createWave(f.mission, { actions: [planned('read', 'filesystem.readText', [ids[0]]), planned('send', 'email.send', [ids[1]], ['read'])] });
  const originalCheck = f.runtime.checkActionAvailability.bind(f.runtime);
  f.runtime.checkActionAvailability = async (...args) => {
    const result = await originalCheck(...args);
    if (args[4] === 'dispatch' && args[2].expectedToolName === 'email.send') f.mission.observations = [];
    return result;
  };
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.dispatches, ['filesystem.readText']);
  assert.ok(f.approvals.includes('email.send'));
  assert.equal(f.mission.stopReason, 'external-action-requirements-unverified');
});

test('complete bound predecessor evidence passes the source guard but still calls separate E authorization', async () => {
  const f = runtimeFixture("'draft.txt'를 읽어; 'draft.txt'를 내 이메일로 보내");
  const ids = f.mission.goalContract.requirements.map(item => item.requirementId);
  const wave = f.runtime.createWave(f.mission, { actions: [planned('read', 'filesystem.readText', [ids[0]]), planned('send', 'email.send', [ids[1]], ['read'])] });
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.dispatches, ['filesystem.readText', 'email.send']);
  assert.deepEqual(f.approvals, ['filesystem.readText', 'email.send']);
  assert.equal(wave.actions[1].requirementCoverage.semanticAccuracyVerified, false);
  assert.equal(wave.actions[1].requirementCoverage.executionAuthority, false);
});

test('aliases, wrong predecessor paths, extra attachments and stale attachment hashes cannot stand in for the requested file', () => {
  const changeCases = [
    f => { f.actions[0].operation.dispatch.arguments.path = 'other.txt'; },
    f => { f.actions[1].operation.dispatch.arguments.path = 'other.txt'; },
    f => { f.mission.observations[1].artifacts[0].relativePath = 'other.txt'; },
    f => { f.actions[2].arguments.attachments = [{ ...attachment, attachmentSha256: 'b'.repeat(64) }]; },
    f => { f.actions[2].arguments.attachments = [attachment, { ...attachment, attachmentRef: { rootIndex: 0, relativePath: 'other.txt' } }]; },
    f => { f.actions[2].arguments.attachmentQuery = 'secret'; },
    f => { delete f.actions[0].operation.dispatch; }
  ];
  for (const mutate of changeCases) {
    const f = graph(); verify(f, 0); verify(f, 1); mutate(f);
    assert.equal(assess(f).allowed, false);
  }
  const f = graph('원본을 읽어; 초안을 저장해; 초안을 보내'); verify(f, 0); verify(f, 1);
  assert.equal(assess(f).allowed, false, 'unresolved aliases require a trusted target resolver');
});

test('the runtime rechecks actual task attachment arguments after the final asynchronous availability call', async () => {
  const f = runtimeFixture("'draft.txt'를 읽어; 'draft.txt'를 내 이메일로 보내");
  const ids = f.mission.goalContract.requirements.map(item => item.requirementId);
  const wave = f.runtime.createWave(f.mission, { actions: [planned('read', 'filesystem.readText', [ids[0]]), planned('send', 'email.send', [ids[1]], ['read'])] });
  const originalCheck = f.runtime.checkActionAvailability.bind(f.runtime);
  f.runtime.checkActionAvailability = async (...args) => {
    const result = await originalCheck(...args);
    if (args[4] === 'dispatch' && args[2].expectedToolName === 'email.send') args[3].plan.action.arguments.attachments = [{
      attachmentRef: { rootIndex: 0, relativePath: 'other.txt' }, attachmentSha256: hash
    }];
    return result;
  };
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.dispatches, ['filesystem.readText']);
  assert.ok(f.approvals.includes('email.send'));
  assert.equal(f.mission.stopReason, 'external-action-requirements-unverified');
});
