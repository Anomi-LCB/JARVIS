import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileNaturalWorkflowObjective } from '../packages/core/src/mission/natural-workflow-compiler.js';
import { verifySafetySimulationResult } from '../packages/core/src/mission/mission-safety-simulation-result.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { runIsolatedHazardSuite } from '../apps/pc-agent/src/adapters/smart-home/isolated-hazard-suite.js';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { MissionBudgetGate } from '../packages/core/src/personal-operations/mission-budget-gate.js';
import { localMandateFileRef } from '../packages/core/src/personal-operations/local-mandate-observation.js';
const objective = "긴급전화·차량·도어락·전열기 안전 절차를 격리 모의 시험하고 'safety.json'에 저장한 뒤 다시 읽어 검증해줘";
test('natural simulation grammar preserves all requirements and refuses real actions and suffixes', () => {
  const compiled = compileNaturalWorkflowObjective(objective, { workspaceRoot: tmpdir() });
  assert.equal(compiled.status, 'compiled', JSON.stringify(compiled));
  assert.deepEqual(compiled.spec.nodes.map(node => node.op), ['safety.simulation', 'write.json', 'data.readJson']);
  assert.equal(compiled.goalContract.requirements[0].nodeIds.length, 3);
  for (const text of [objective + ' 그리고 119에 실제 전화해', objective.replace('격리 모의 시험', '실제 실행'),
    objective.replace('safety.json', '../safety.json'), objective.replace('safety.json', 'safety.txt')]) {
    assert.notEqual(compileNaturalWorkflowObjective(text, { workspaceRoot: tmpdir() }).status, 'compiled');
  }
  for (const args of [{ mode: 'real' }, { mode: 'isolated-simulation', endpoint: 'real' }, { mode: 'isolated-simulation', phone: '119' }, {}]) {
    assert.throws(() => runIsolatedHazardSuite(args, new Date()), /Only isolated/);
  }
});
test('actual Core/E/B/G/F simulation Mission writes, re-reads, verifies and recovers without external actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-hazard-mission-')); let runtime;
  try {
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0',
      JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
    const options = { allowedRoots: [root], auditRoot: join(root, 'audit'), missionStorePath: join(root, 'missions.json'), env, taskEnv: env,
      workerDaemonEnabled: false, missionRunner: async () => { throw Error('Model must not run'); } };
    runtime = createAgRuntime(options);
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'synthetic-simulation-test', durationMinutes: 5 });
    const statement = `${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`;
    const mission = runtime.missionRuntime.createMission({ objective, successCriteria: [{ criterionId: 'simulation', statement }],
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] } });
    const result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 3 });
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
    assert.equal(result.gates.length, 0);
    assert.deepEqual(result.observations.filter(item => item.outcome === 'success').map(item => item.toolName), ['workflow.execute']);
    const bytes = await readFile(join(root, 'safety.json'), 'utf8'), output = JSON.parse(bytes);
    assert.equal(output.physicalActionVerified, false); assert.equal(output.observations.length, 4);
    const input = { objective, statement, observations: result.observations, allowedRoots: [root] };
    assert.equal(verifySafetySimulationResult(input).passed, true);
    const checkpoint = await readFile(join(root, 'missions.json'), 'utf8');
    runtime.coreFacade.cognition.close(); runtime = createAgRuntime(options);
    const restored = runtime.missionRuntime.getMission(mission.missionId);
    assert.equal(restored.status, 'COMPLETED');
    assert.equal(verifySafetySimulationResult({ ...input, observations: restored.observations }).passed, true);
    assert.equal(await readFile(join(root, 'missions.json'), 'utf8'), checkpoint);
    for (const alter of [value => { value.physicalActionVerified = true; }, value => { value.observations[0].after[0].state = 'real-call'; },
      value => { value.observations.pop(); }, value => { value.observations[0].events.push(value.observations[0].events[0]); }]) {
      const changed = structuredClone(output); alter(changed);
      await writeFile(join(root, 'safety.json'), JSON.stringify(changed));
      assert.equal(verifySafetySimulationResult(input).passed, false);
    }
    await writeFile(join(root, 'safety.json'), bytes);
    const missing = structuredClone(input); missing.observations.find(item => item.toolName === 'workflow.execute').data.workflow.receipts.pop();
    assert.equal(verifySafetySimulationResult(missing).passed, false);
    const wrong = structuredClone(input); wrong.observations.find(item => item.toolName === 'workflow.execute').data.workflow.receipts[0].resultSha256 = '0'.repeat(64);
    assert.equal(verifySafetySimulationResult(wrong).passed, false);
  } finally { runtime?.coreFacade.cognition.close(); await rm(root, { recursive: true, force: true }); }
});

for (const args of [{ mode: 'real' }, { mode: 'isolated-simulation', phone: '119' }, { mode: 'isolated-simulation', endpoint: 'device' }]) {
  test('actual workflow adapter refuses unsafe simulation arguments ' + JSON.stringify(args), async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-hazard-negative-'));
    try {
      const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
      const spec = { schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'unsafe-hazard', nodes: [
        { id: 'simulation', op: 'safety.simulation', args },
        { id: 'save', op: 'write.json', dependsOn: ['simulation'], args: { path: 'unsafe.json', value: { $ref: { nodeId: 'simulation' } } } }
      ], outputs: [{ nodeId: 'save', path: 'unsafe.json', mediaType: 'application/json' }] };
      const result = await adapter.execute({ spec, workspaceRoot: root });
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.match(JSON.stringify(result), /WORKFLOW_SAFETY_SIMULATION_ONLY/);
      await assert.rejects(readFile(join(root, 'unsafe.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
for (const objectiveVariant of [objective + ' 그리고 119에 실제 전화해', objective.replace('격리 모의 시험', '실제 실행')]) {
  test('actual Mission cannot silently execute simulation subset for real-action request ' + objectiveVariant, async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-hazard-real-request-')); let runtime;
    try {
      const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
      runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false,
        missionRunner: async () => { throw Error('No model or physical provider in isolated test'); } });
      const owner = runtime.personalOwnerSession.activate({ requestedBy: 'synthetic-negative', durationMinutes: 5 });
      const mission = runtime.missionRuntime.createMission({ objective: objectiveVariant,
        successCriteria: [{ statement: `${objectiveVariant} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.` }],
        authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
          grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] } });
      const result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 3 });
      assert.notEqual(result.status, 'COMPLETED');
      assert.equal(result.observations.filter(item => item.outcome === 'success').length, 0);
      await assert.rejects(readFile(join(root, 'safety.json')), { code: 'ENOENT' });
    } finally { runtime?.coreFacade.cognition.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const permitted of [true, false]) test('scoped simulation Mission respects actual output permission ' + permitted, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-hazard-scoped-')); let runtime;
  const store = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite') });
  try {
    const budget = new PersonalMandateBudget(store), gate = new MissionBudgetGate({ store, budget });
    const quota = gate.createQuota({ validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', maxCalls: 1,
      scope: { accountRef: null, dataRefs: [localMandateFileRef(permitted ? 'safety.json' : 'other.json', root)], deniedDataRefs: [] } });
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
    runtime.missionRuntime.executionBudget = gate;
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'synthetic-scope', durationMinutes: 5 });
    const mission = runtime.missionRuntime.createMission({ objective, executionMandateId: quota.mandate.id,
      successCriteria: [{ statement: `${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.` }],
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: ['read_only', 'local_reversible', 'high_impact'] } });
    const result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 3 });
    assert.equal(result.status === 'COMPLETED', permitted, JSON.stringify(result));
    if (permitted) {
      assert.equal(result.gates.length, 0);
      assert.equal(JSON.parse(await readFile(join(root, 'safety.json'), 'utf8')).physicalActionVerified, false);
      assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls, 1);
    } else await assert.rejects(readFile(join(root, 'safety.json')), { code: 'ENOENT' });
  } finally { runtime?.coreFacade.cognition.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
