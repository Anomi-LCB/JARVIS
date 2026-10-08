import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';
import { assessMissionRequirementCoverage } from '../packages/core/src/mission/mission-requirement-coverage.js';
import { classifyMissionEffectScope } from '../packages/core/src/mission/mission-effect-scope.js';

function harness() {
  const tasks = new Map(), handoffs = [], policyChecks = [];
  const facade = { getTask: id => tasks.get(id), createMissionActionTask: (_command, options) => {
    const taskId = options.reservedTaskId ?? `opaque-test-${tasks.size}`;
    const task = { taskId, status: 'PLANNED', plan: { action: { toolName: options.expectedToolName,
      arguments: structuredClone(options.preparedArguments), capability: { writesLocalFiles: false, externalNetwork: false, externalTransfer: false } } },
      policy: { risk: { tier: 4 } } };
    tasks.set(taskId, task); return task;
  } };
  const worker = { async runTask(taskId) {
    const task = tasks.get(taskId); handoffs.push(task.plan.action.toolName); task.status = 'COMPLETED';
    return { success: true, execution: { status: 'COMPLETED', evidence: { evidenceId: `${taskId}-evidence` }, executionResult: {} },
      executionVerification: { status: 'passed', verificationId: `${taskId}-g`, checks: [] } };
  } };
  const runtime = new MissionRuntime({ coreFacade: facade, orchestrationWorker: worker,
    planner: { async planNextWave() { throw new Error('unused'); } },
    pcAgent: { registry: { contractFor: tool => ({ readOnly: ['filesystem.readText', 'camera.capture'].includes(tool) }) } } });
  runtime.capabilityAvailabilityGuard.assess = async () => ({ required: false });
  runtime.actionAuthorized = (mission, action, profile) => {
    policyChecks.push(profile.toolName);
    action.authorizationRevision = mission.authorizationRevision ?? 1;
    action.authorizationCheckRevision = mission.authorizationRevision ?? 1;
    return true;
  };
  const created = runtime.createMission({ objective: "'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 보내" });
  return { runtime, mission: runtime.missions.get(created.missionId), handoffs, policyChecks, worker, tasks };
}
const step = (id, tool, args) => ({ id, title: id, command: '모의 경로 검사', expectedToolName: tool, arguments: args, dependencies: [] });

for (const [tool, args] of [['shell.execute', { command: 'MOCK_EXTERNAL_SEND' }],
  ['desktop.control', { target: { processName: 'mock-mail' }, operations: [{ op: 'invoke', selector: { automationId: 'send' } }] }]]) {
  test(`partial Mission cannot bypass source coverage via opaque ${tool} even with an E grant`, async () => {
    const f = harness();
    const wave = f.runtime.createWave(f.mission, { actions: [step('independent-read', 'filesystem.readText', { path: 'source.txt' }), step('opaque', tool, args)] });
    await f.runtime.executeWave(f.mission, wave);
    assert.deepEqual(f.handoffs, ['filesystem.readText']);
    assert.deepEqual(f.policyChecks, ['filesystem.readText']);
    assert.equal(wave.actions[1].attempts, 0);
    assert.equal(f.mission.status, 'PAUSED');
    assert.equal(wave.actions[1].requirementCoverage.reasons.some(item => item.code === 'opaque-effect-scope-unverified'), true);
  });
}

test('unknown API, agent, Android, payment and messaging actions cannot inherit a partial Mission grant',async()=>{
  for(const tool of ['api.post','agent.delegate','android.control','payment.purchase','sms.send','plugin.invoke']){
    const f=harness(),wave=f.runtime.createWave(f.mission,{actions:[step('unknown-external',tool,{destination:'synthetic-only',readOnly:true})]});
    await f.runtime.executeWave(f.mission,wave);
    assert.equal(f.handoffs.length,0,tool);assert.equal(f.policyChecks.length,0,tool);
    assert.equal(f.mission.status,'PAUSED');assert.equal(wave.actions[0].attempts,0);
    assert.equal(wave.actions[0].requirementCoverage.effectScope.scope,'opaque');
  }
});

test('structured reads and inspect-only desktop operations still reach the separate E decision', async () => {
  const f = harness();
  const wave = f.runtime.createWave(f.mission, { actions: [step('read', 'filesystem.readText', { path: 'source.txt' }),
    step('capture', 'camera.capture', { deviceId: 'synthetic-camera' }),
    step('inspect', 'desktop.control', { target: { processName: 'synthetic-window' }, operations: [{ op: 'wait', timeoutMs: 1 }, { op: 'inspect' }],
      verification: [{ type: 'windowExists' }] })] });
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual([...f.handoffs].sort(), ['camera.capture', 'desktop.control', 'filesystem.readText']);
  assert.deepEqual([...f.policyChecks].sort(), [...f.handoffs].sort());
});

test('safe-looking shell text, pasted read-only flags and hidden UI operations do not provide an effect contract', () => {
  const cases = [
    ['shell.execute', { command: 'Get-FileHash source.txt' }],
    ['plugin.execute', { readOnly: true, command: 'MOCK' }],
    ['desktop.control', { operations: [{ op: 'inspect' }, { op: 'invoke', selector: { name: 'send' } }] }],
    ['desktop.control', { operations: [{ op: 'inspect', script: 'MOCK' }] }],
    ['desktop.control', { operations: [{ op: 'inspect' }], command: 'MOCK' }],
    ['desktop.control', { operations: [{ op: 'inspect' }], verification: [{ type: 'runScript' }] }],
    ['desktop.control', { operations: [...Array(16).fill({ op: 'inspect' }), { op: 'invoke' }] }]
  ];
  for (const [toolName, args] of cases) {
    const result = assessMissionRequirementCoverage({ mission: { goalContract: { requirements: [] } }, wave: {},
      action: { actualToolName: toolName, arguments: args }, profile: { toolName, readOnly: true, externalTransfer: false, externalNetwork: false } });
    assert.equal(result.allowed, false, toolName);
    assert.equal(result.effectScope.scope, 'opaque');
    assert.match(result.nextAction, /구조화/);
  }
});

test('inline bounded workflows stay local, while process nodes and unseen spec files remain opaque', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-effect-spec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = (args, allowedRoots = []) => classifyMissionEffectScope({ action: { actualToolName: 'workflow.execute' },
    profile: { toolName: 'workflow.execute', readOnly: false }, arguments: args, allowedRoots });
  const local = { schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'local', nodes: [
    { id: 'write', op: 'write.text', args: { path: 'output.txt', text: 'local' }, dependsOn: [] }
  ], outputs: [] };
  assert.equal(scope({ spec: local }).scope, 'structured-local');
  const processSpec = structuredClone(local);
  processSpec.nodes.push({ id: 'indirect', op: 'process.run', args: { command: 'MOCK_EXTERNAL_SEND' }, dependsOn: [] });
  assert.equal(scope({ spec: processSpec }).scope, 'opaque');
  assert.equal(scope({ path: 'unseen.workflow.json' }).scope, 'opaque');
  const path = join(root, 'trusted.workflow.json'), bytes = Buffer.from(JSON.stringify(local));
  await writeFile(path, bytes);
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(scope({ specPath: path, expectedSha256 }, [root]).scope, 'structured-local');
  assert.equal(scope({ specPath: path, expectedSha256: '0'.repeat(64) }, [root]).scope, 'opaque');
  const external = structuredClone(local); external.nodes[0].op = 'process.run';
  const externalBytes = Buffer.from(JSON.stringify(external)); await writeFile(path, externalBytes);
  assert.equal(scope({ specPath: path, expectedSha256: createHash('sha256').update(externalBytes).digest('hex') }, [root]).scope, 'opaque');
  const unknown = structuredClone(local); unknown.nodes[0].op = 'new.operation';
  assert.equal(scope({ spec: unknown }).scope, 'opaque');
});

test('an asynchronous preparation-to-dispatch change from inspect to invoke stops before worker handoff', async () => {
  const f = harness();
  const wave = f.runtime.createWave(f.mission, { actions: [step('inspect', 'desktop.control', {
    target: { processName: 'synthetic-window' }, operations: [{ op: 'inspect' }]
  })] });
  const check = f.runtime.checkActionAvailability.bind(f.runtime);
  f.runtime.checkActionAvailability = async (...args) => {
    const result = await check(...args);
    if (args[4] === 'dispatch') args[3].plan.action.arguments.operations.push({ op: 'invoke', selector: { name: 'send' } });
    return result;
  };
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.policyChecks, ['desktop.control']);
  assert.deepEqual(f.handoffs, []);
  assert.equal(wave.actions[0].requirementCoverage.effectScope.scope, 'opaque');
});

test('effect-scope observation does not authorize a structured read when E refuses it', async () => {
  const f = harness();
  const wave = f.runtime.createWave(f.mission, { actions: [step('read', 'filesystem.readText', { path: 'source.txt' })] });
  f.runtime.actionAuthorized = () => false;
  f.runtime.createActionGate = () => {};
  await f.runtime.prepareAction(f.mission, wave, wave.actions[0]);
  assert.deepEqual(f.handoffs, []);
  assert.equal(wave.actions[0].status, 'waiting_approval');
});

test('changing the actual tool after preparation cannot reuse the old read-only contract', async () => {
  const f = harness();
  const wave = f.runtime.createWave(f.mission, { actions: [step('read', 'filesystem.readText', { path: 'source.txt' })] });
  const check = f.runtime.checkActionAvailability.bind(f.runtime);
  f.runtime.checkActionAvailability = async (...args) => {
    const result = await check(...args);
    if (args[4] === 'dispatch') {
      args[3].plan.action.toolName = 'shell.execute';
      args[3].plan.action.arguments = { command: 'MOCK_EXTERNAL_SEND' };
    }
    return result;
  };
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.policyChecks, ['filesystem.readText']);
  assert.deepEqual(f.handoffs, []);
  assert.equal(wave.actions[0].requirementCoverage.effectScope.reason, 'tool-profile-mismatch');
});

test('inferred capability readOnly does not replace a registered adapter contract', async () => {
  const f = harness();
  // The mock task planner labels all tasks writesLocalFiles:false. An unknown
  // adapter still has no authoritative read contract, even without a .run suffix.
  const wave = f.runtime.createWave(f.mission, { actions: [step('unknown', 'plugin.transfer', { readOnly: true })] });
  await f.runtime.executeWave(f.mission, wave);
  assert.deepEqual(f.policyChecks, []);
  assert.deepEqual(f.handoffs, []);
  assert.equal(wave.actions[0].requirementCoverage.effectScope.reason, 'effect-contract-unavailable');
  const result = classifyMissionEffectScope({ action: { actualToolName: 'camera.capture' },
    profile: { toolName: 'camera.capture', readOnly: true, contractReadOnly: true }, arguments: {} });
  assert.equal(result.scope, 'structured-read');
});


test('MCP external scope comes from installed contract, never planner read-only hints',()=>{
 const toolName='mcp.12345678-1234-1234-1234-123456789abc.sum';
 const base={action:{expectedToolName:toolName},profile:{toolName,readOnly:true,externalTransfer:true},arguments:{}};
 assert.equal(classifyMissionEffectScope(base).scope,'opaque');
 const installed=classifyMissionEffectScope({...base,profile:{...base.profile,contractEffectScope:'external'}});
 assert.equal(installed.scope,'external');
 assert.equal(installed.reason,'registered-mcp-external-contract');
 assert.equal(classifyMissionEffectScope({...base,profile:{...base.profile,effectScope:'opaque',contractEffectScope:'external'}}).scope,'opaque');
});
