import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { MissionBudgetGate } from '../packages/core/src/personal-operations/mission-budget-gate.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { withMissionMandateFence } from '../packages/core/src/personal-operations/mission-mandate-fence.js';

for (const revokeAt of [null, 'shadow', 'publication', 'legacy-publication']) test(`actual workflow mandate fence: revocation ${revokeAt}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mandate-final-'));
  const operations = new PersonalOperationsStore({ dbPath: join(root, 'ops.sqlite') });
  const budget = new PersonalMandateBudget(operations), gate = new MissionBudgetGate({ store: operations, budget });
  const quota = gate.createQuota({ validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', maxCalls: 2 });
  await writeFile(join(root, 'input.json'), '[{"total":42}]');
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const runtime = createAgRuntime({ memoryStore, allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env,
    workerDaemonEnabled: false, missionStore: new SqliteMissionStore({ operationsStore: operations }) });
  runtime.missionRuntime.executionBudget = gate;
  t.after(async () => { runtime.close?.(); runtime.coreFacade.cognition?.close(); operations.close(); memoryStore.close(); await rm(root, { recursive: true, force: true }); });
  const adapter = runtime.pcAgent.registry.get('workflow.execute'), shadow = adapter.shadow.bind(adapter);
  let shadows = 0, staged = 0, publicationRevocations=0;
  adapter.shadow = async (...args) => {
    const result = await shadow(...args);
    if (++shadows === 1 && revokeAt === 'shadow') operations.revokeMandate(quota.mandate.id);
    return result;
  };
  const publish = runtime.pcAgent.claimWorkflowPublication.bind(runtime.pcAgent);
  runtime.pcAgent.claimWorkflowPublication = async (...args) => {
    const result = await publish(...args);
    if (revokeAt?.endsWith('publication')) {operations.revokeMandate(quota.mandate.id);publicationRevocations++;}
    return result;
  };
  const stage = runtime.missionRuntime.effectCoordinator.stage.bind(runtime.missionRuntime.effectCoordinator);
  runtime.missionRuntime.effectCoordinator.stage = async (...args) => {
    const hooks = await stage(...args); staged++;
    assert.equal(typeof hooks?.beforeExecute, 'function', 'durable workflow preparation must retain its final publication guard');
    // Reproduce an absent staging hook before the runtime composes the
    // independent mandate fence, rather than deleting that fence afterwards.
    return revokeAt==='legacy-publication'?null:hooks;
  };
  const owner = runtime.personalOwnerSession.activate({ durationMinutes: 5, requestedBy: 'synthetic-fence-test' });
  const created = runtime.missionRuntime.createMission({
    objective: "'input.json' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해",
    authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
    executionMandateId: quota.mandate.id,
    successCriteria: [{ statement: '합계 확인', verificationSpec: { version: 1, kind: 'json.value', path: 'output.json', pointer: '/0/total', equals: 42 } }]
  });
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(staged, 1);
  if (revokeAt === null) {
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.lastError));
    assert.equal(JSON.parse(await readFile(join(root, 'output.json'), 'utf8'))[0].total, 42);
    assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls, 1);
    assert.equal(result.gates.filter(g => g.type === 'action_approval').length, 0);
  } else {
    assert.notEqual(result.status, 'COMPLETED');
    await assert.rejects(readFile(join(root, 'output.json')), { code: 'ENOENT' });
    if(revokeAt==='legacy-publication'){
      assert.equal(result.observations.find(o=>o.outcome==='failed')?.error?.code,'A_MANDATE_EXECUTION_DENIED');
    }else{
      assert.equal(result.lastError.causeCode,'A_MANDATE_EXECUTION_DENIED');
      assert.equal(result.lastError.code,'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN');
    }
    if(revokeAt.endsWith('publication'))assert.equal(publicationRevocations,1,'the revocation injection must actually run');
  }
  console.log(JSON.stringify({ actualWorkflow: true, revokeAt, shadows,publicationRevocations, outputPublished: revokeAt === null, userApprovalGates: result.gates.length }));
});

test('mandate fence composes async guards, final revocation and remote cancellation without granting authority', async () => {
  let live = true, originalCalls = 0, cancellation = null;
  const hooks = withMissionMandateFence({ mission: { executionMandateId: 'synthetic' },
    gate: { beforeAction() { if (!live) throw new Error('revoked'); } }, executor: {},
    hooks: { idempotencyKey: 'retained', async beforeExecute() {
      const fence = () => originalCalls++;
      fence.onRemoteCancellation = value => { cancellation = value; }; return fence;
    } } });
  assert.equal(hooks.idempotencyKey, 'retained');
  const fence = await hooks.beforeExecute({}); fence(); fence.onRemoteCancellation('receipt');
  assert.equal(originalCalls, 2); assert.equal(cancellation, 'receipt');
  live = false; assert.throws(fence, /revoked/); assert.equal(originalCalls, 2);
});

test('a remote executor without an existing durable final-fence protocol cannot dispatch a mandated effect', async () => {
  const hooks = withMissionMandateFence({ mission: { executionMandateId: 'synthetic' }, gate: { beforeAction() {} }, executor: {}, hooks: null });
  await assert.rejects(hooks.beforeExecute({}), /A_MANDATE_EXECUTOR_FENCE_UNSUPPORTED/);
  const unchanged = {}; assert.equal(withMissionMandateFence({ mission: {}, hooks: unchanged }), unchanged);
});

for (const revoked of [false, true]) test(`actual worker graph forwards mandate fence to each node: revoked=${revoked}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mandate-graph-'));
  const operations = new PersonalOperationsStore({ dbPath: join(root, 'ops.sqlite') });
  const budget = new PersonalMandateBudget(operations), gate = new MissionBudgetGate({ store: operations, budget });
  const quota = gate.createQuota({ validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', maxCalls: 2 });
  const mission = { missionId: 'synthetic-graph', executionMandateId: quota.mandate.id };
  gate.beforeRun(mission);
  const env = { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const runtime = createAgRuntime({ memoryStore, allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
  t.after(async () => { runtime.close?.(); runtime.coreFacade.cognition?.close(); operations.close(); memoryStore.close(); await rm(root, { recursive: true, force: true }); });
  const task = runtime.coreFacade.createTask('파일 목록 보여줘 그리고 파일 목록 보여줘');
  assert.equal(task.plan.planGraph.nodes.filter(n => n.nodeId.startsWith('action_')).length, 2);
  const adapter = runtime.pcAgent.registry.get('filesystem.listFiles');
  const shadow = adapter.shadow.bind(adapter), execute = adapter.execute.bind(adapter); let executions = 0;
  adapter.shadow = async (...args) => { const value = await shadow(...args); if (revoked) operations.revokeMandate(quota.mandate.id); return value; };
  adapter.execute = (...args) => { executions++; return execute(...args); };
  const hooks = withMissionMandateFence({ mission, gate, executor: runtime.pcAgent, hooks: null });
  const result = await runtime.orchestrationWorker.runTask(task.taskId, { beforePlanNodeExecute: hooks.beforeExecute });
  assert.equal(result.success, !revoked, JSON.stringify(result.error));
  assert.equal(executions, revoked ? 0 : 2);
});
