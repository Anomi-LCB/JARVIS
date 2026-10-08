import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ApprovalDecision, createApprovalDecision, InputSource, ModuleId } from '../packages/shared/src/types.js';
import { normalizeMissionRoleAssignment, validateMissionRoleTool } from '../packages/core/src/mission/mission-role-scope.js';

test('role assignments require a known role and bounded collaboration group', () => {
  assert.deepEqual(normalizeMissionRoleAssignment({}), { valid: true, assignment: null });
  assert.equal(normalizeMissionRoleAssignment({ workerRole: 'researcher', collaborationGroupId: 'news-report' }).valid, true);
  assert.equal(normalizeMissionRoleAssignment({ workerRole: 'admin', collaborationGroupId: 'news-report' }).valid, false);
  assert.equal(normalizeMissionRoleAssignment({ workerRole: 'editor', collaborationGroupId: 'bad group' }).valid, false);
});

test('researcher can retrieve public sources but cannot claim a write or external transfer', () => {
  assert.equal(validateMissionRoleTool({ roleId: 'researcher', toolName: 'news.fetchArticle',
    contract: { readOnly: true, externalNetwork: true } }).allowed, true);
  assert.equal(validateMissionRoleTool({ roleId: 'researcher', toolName: 'word.create',
    contract: { readOnly: false, writesLocalFiles: true } }).allowed, false);
  assert.equal(validateMissionRoleTool({ roleId: 'researcher', toolName: 'browser.search',
    contract: { readOnly: true, externalNetwork: true, externalTransfer: true } }).allowed, false);
  assert.equal(validateMissionRoleTool({ roleId: 'researcher', toolName: 'news.publish',
    contract: { readOnly: true } }).allowed, false);
});

test('editor is limited to local artifact writes and verifier is read-only/local', () => {
  assert.equal(validateMissionRoleTool({ roleId: 'editor', toolName: 'word.create',
    contract: { writesLocalFiles: true } }).allowed, true);
  assert.equal(validateMissionRoleTool({ roleId: 'editor', toolName: 'email.send',
    contract: { externalTransfer: true } }).allowed, false);
  assert.equal(validateMissionRoleTool({ roleId: 'editor', toolName: 'macro.save',
    contract: { writesLocalFiles: true } }).allowed, false);
  assert.equal(validateMissionRoleTool({ roleId: 'editor', toolName: 'filesystem.moveFiles',
    contract: { writesLocalFiles: true } }).allowed, false);
  assert.equal(validateMissionRoleTool({ roleId: 'verifier', toolName: 'filesystem.readText',
    contract: { readOnly: true } }).allowed, true);
  assert.equal(validateMissionRoleTool({ roleId: 'verifier', toolName: 'browser.search',
    contract: { readOnly: true, externalNetwork: true } }).allowed, false);
  assert.equal(validateMissionRoleTool({ roleId: 'verifier', toolName: 'shell.read',
    contract: { readOnly: true } }).allowed, false);
});

test('role-assigned mission actions do not receive cross-task, work-reference, macro, cognitive, or personal memory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-role-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = { query: 0, preferences: 0, cognition: 0, personal: 0, macro: 0, workReference: 0 };
  const runtime = createAgRuntime({ env: {}, allowedRoots: [root], auditRoot: join(root, 'audit'), workerDaemonEnabled: false,
    personalContextProvider: () => { calls.personal++; return { goals: ['private-profile-secret'] }; } });
  const facade = runtime.coreFacade;
  facade.memoryStore.query = () => { calls.query++; return [{ text: 'private-memory-secret' }]; };
  facade.memoryStore.planningPreferenceContext = () => { calls.preferences++; return { secret: 'private-preference-secret' }; };
  facade.cognition.planningContext = () => { calls.cognition++; return { cognition: { secret: 'private-cognition-secret' }, planningGuardrails: [] }; };
  const expand = facade.expandMacro.bind(facade), resolve = facade.resolveWorkReference.bind(facade);
  facade.expandMacro = value => { calls.macro++; return expand(value); };
  facade.resolveWorkReference = (...args) => { calls.workReference++; return resolve(...args); };
  let rolePlanOptions = null;
  const originalCreatePlan = facade.taskPlanner.createPlan.bind(facade.taskPlanner);
  facade.taskPlanner.createPlan = (request, intent, options) => {
    if (!rolePlanOptions) rolePlanOptions = options;
    return originalCreatePlan(request, intent, options);
  };
  const roleTask = facade.createMissionActionTask('role-output.txt 파일을 만들어줘', {
    expectedToolName: 'filesystem.createTextFile', preparedArguments: { path: join(root, 'role-output.txt'), content: 'safe task input' },
    workerRole: 'editor', collaborationGroupId: 'memory-boundary', source: InputSource.TRIGGER,
    sourceModule: ModuleId.CORE, deviceId: 'mission_executive'
  });
  assert.ok(roleTask.plan);
  assert.deepEqual(calls, { query: 0, preferences: 0, cognition: 0, personal: 0, macro: 0, workReference: 0 });
  assert.equal(rolePlanOptions.personalContext, null);
  assert.equal(rolePlanOptions.planningContext, null);
  assert.deepEqual(rolePlanOptions.contextSnapshot.userPreferences, []);
});

test('role memory boundary survives approval replan and keeps the trusted role assignment private', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-role-replan-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = { query: 0, preferences: 0, cognition: 0, personal: 0, workReference: 0 };
  const runtime = createAgRuntime({ env: {}, allowedRoots: [root], auditRoot: join(root, 'audit'), workerDaemonEnabled: false,
    personalContextProvider: () => { calls.personal++; return { goals: ['private-profile-secret'] }; } });
  t.after(() => runtime.coreFacade.cognition.close());
  const facade = runtime.coreFacade;
  facade.memoryStore.query = () => { calls.query++; return [{ text: 'private-memory-secret' }]; };
  facade.memoryStore.planningPreferenceContext = () => { calls.preferences++; return { secret: 'private-preference-secret' }; };
  facade.cognition.planningContext = () => { calls.cognition++; return { cognition: { secret: 'private-cognition-secret' }, planningGuardrails: [] }; };
  const resolve = facade.resolveWorkReference.bind(facade);
  facade.resolveWorkReference = (...args) => { calls.workReference++; return resolve(...args); };

  const roleTask = facade.createMissionActionTask('보고서.txt 파일을 만들어줘', {
    expectedToolName: 'filesystem.createTextFile', preparedArguments: { path: join(root, 'report.txt'), content: 'safe input' },
    workerRole: 'editor', collaborationGroupId: 'replan-memory', source: InputSource.TRIGGER,
    sourceModule: ModuleId.CORE, deviceId: 'mission_executive'
  });
  assert.deepEqual(calls, { query: 0, preferences: 0, cognition: 0, personal: 0, workReference: 0 });
  const decision = createApprovalDecision({ approvalId: roleTask.approvalCard.approvalId, taskId: roleTask.taskId,
    decision: ApprovalDecision.EDIT, deviceId: 'role-replan-test', sourceModule: ModuleId.CORE,
    editRequest: { rawText: '수정된 보고서.txt 파일을 만들어줘' } });
  const result = facade.submitApprovalDecision(decision);
  assert.equal(result.success, true);
  assert.deepEqual(calls, { query: 0, preferences: 0, cognition: 0, personal: 0, workReference: 0 });
  assert.deepEqual(roleTask.memoryContext, []);
  assert.equal(roleTask.planningContext, null);
  assert.equal(JSON.stringify(roleTask).includes('private-'), false);

  // Caller-controlled metadata cannot create trusted scope; ordinary replans retain normal context.
  const ordinary = facade.createTask('일반 파일 작업', { metadata: {
    missionRoleAssignment: { workerRole: 'editor', collaborationGroupId: 'replan-memory' }
  } });
  const ordinaryDecision = createApprovalDecision({ approvalId: ordinary.approvalCard.approvalId, taskId: ordinary.taskId,
    decision: ApprovalDecision.EDIT, deviceId: 'ordinary-replan-test', sourceModule: ModuleId.CORE,
    editRequest: { rawText: '일반 파일 작업을 수정해줘' } });
  const ordinaryResult = facade.submitApprovalDecision(ordinaryDecision);
  assert.equal(ordinaryResult.success, true);
  assert.ok(calls.query > 0);
  assert.ok(calls.preferences > 0);
  assert.ok(calls.cognition > 0);
  assert.ok(calls.personal > 0);
  assert.ok(calls.workReference > 0);
});
