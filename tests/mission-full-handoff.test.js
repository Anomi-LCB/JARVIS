import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import { compileNaturalWorkflowObjective } from '../packages/core/src/mission/natural-workflow-compiler.js';

const objective = "'input.csv' CSV를 '원본'으로 읽고; 중요한 논점을 반대 해석과 비교하고; '원본'을 'output.json' JSON으로 저장해";
const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0',
  JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };

test('an unsupported middle clause reaches the real Mission planner with the complete source and executes no partial compiler prefix', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-full-handoff-'));
  let calls = 0;
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env,
    workerDaemonEnabled: false, missionRunner: async prompt => {
      calls++;
      assert.ok(prompt.includes(objective));
      const contractLine = prompt.split('\n').find(line => line.startsWith('원문 요구사항 계약: '));
      assert.ok(contractLine, 'the complete source contract reaches the planner');
      const contract = JSON.parse(contractLine.slice('원문 요구사항 계약: '.length));
      assert.equal(contract.requirements.length, 3);
      assert.ok(contract.requirements[1].text.includes('반대 해석'));
      return JSON.stringify({ decision: 'ask_user', summary: '논점 비교에 필요한 자료를 확인합니다.', question: '비교할 논점 자료는 어느 파일인가요?',
        actions: [], criteriaAssessment: [], blockedReason: null });
    } });
  t.after(async () => { await runtime.close?.(); await rm(root, { recursive: true, force: true }); });
  const created = runtime.missionRuntime.createMission({ objective, successCriteria: ['output.json 생성'] });
  const compiled = compileNaturalWorkflowObjective(objective, { workspaceRoot: root });
  assert.equal(compiled.code, 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED');
  assert.equal(compiled.spec, undefined);
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(calls, 1);
  assert.equal(result.status, 'WAITING_APPROVAL');
  assert.equal(result.pendingGates[0].type, 'clarification');
  assert.equal(result.metrics.executedActions, 0);
  assert.equal(result.observations.filter(item => item.category === 'execution').length, 0);
  assert.equal(result.goalContract.objective, objective);
});

test('without a general runner unsupported whole goals remain blocked with no partial actions', () => {
  const context = { mission: { objective, waveCount: 0, successCriteria: [] }, workspaceRoot: tmpdir(), observations: [] };
  const planner = new GoalExecutivePlanner();
  const result = planner.planDeterministicWorkflow(context);
  assert.equal(result.decision, 'blocked');
  assert.equal(result.blockedReason, 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED');
  assert.deepEqual(result.actions, []);
});

test('path escapes and grammar size limits cannot turn into a model handoff', () => {
  const root = join(tmpdir(), 'jarvis-handoff-root');
  const planner = new GoalExecutivePlanner({ runner: async () => { throw new Error('must not call'); } });
  for (const command of [
    "'../outside.csv' CSV를 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해",
    Array.from({ length: 65 }, () => "'input.csv' CSV를 '원본'으로 읽고").join('; ')
  ]) {
    const result = planner.planDeterministicWorkflow({ mission: { objective: command, successCriteria: [] }, workspaceRoot: root });
    assert.equal(result.decision, 'blocked');
    assert.notEqual(result.blockedReason, 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED');
    assert.deepEqual(result.actions, []);
  }
});
