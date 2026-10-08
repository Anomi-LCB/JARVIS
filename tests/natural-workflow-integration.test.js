import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileNaturalWorkflowMission } from '../packages/core/src/mission/natural-workflow-mission-plan.js';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

const objective = "'inputs/source.json' JSON을 '원본'으로 읽고; '원본'의 개수가 2인지 검증하고; '원본'을 'outputs/result.json' JSON으로 저장해";
const contextFor = (root) => ({ workspaceRoot: root, mission: { objective, successCriteria: [{ criterionId: 'file_created' }] }, observations: [] });
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-natural-integration-'));
  try {
    await mkdir(join(root, 'inputs'));
    await writeFile(join(root, 'inputs/source.json'), '[{"value":3},{"value":7}]');
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('natural mission completion requires G and the exact original plan digest', async () => fixture(async (root) => {
  const context = contextFor(root);
  const initial = compileNaturalWorkflowMission(context);
  assert.equal(initial.decision, 'continue');
  assert.equal(initial.actions[0].arguments.specPath, undefined);
  const spec = initial.actions[0].arguments.spec;
  const observation = { actionId: 'executed', toolName: 'workflow.execute', outcome: 'success', verification: { status: 'passed' }, data: { workflow: {
    workflowId: spec.workflowId, specSha256: createHash('sha256').update(JSON.stringify(spec)).digest('hex'), nodeCount: spec.nodes.length
  } } };
  const receiptOnly = compileNaturalWorkflowMission({ ...context, observations: [observation] });
  assert.equal(receiptOnly.decision, 'pause');
  assert.equal(receiptOnly.pauseReason, 'verification-incomplete');
  assert.equal(compileNaturalWorkflowMission({ ...context, observations: [observation], criterionEvidence: [
    { criterionId: 'file_created', status: 'passed', passed: true, evidenceActionIds: ['executed'] }
  ] }).decision, 'complete');
  for (const mutated of [
    { ...observation, actionId: null },
    { ...observation, verification: { status: 'failed' } },
    { ...observation, data: {} },
    { ...observation, data: { workflow: { ...observation.data.workflow, specSha256: 'f'.repeat(64) } } },
    { ...observation, data: { workflow: { ...observation.data.workflow, nodeCount: 1 } } }
  ]) assert.equal(compileNaturalWorkflowMission({ ...context, observations: [mutated] }).decision, 'blocked');
}));

test('inline adapter input preserves all file effects until assertions pass and rejects conflicting sources', async () => fixture(async (root) => {
  const spec = compileNaturalWorkflowMission(contextFor(root)).actions[0].arguments.spec;
  const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
  const contradictory = await adapter.execute({ spec, specPath: 'anything.workflow.json', workspaceRoot: root });
  assert.equal(contradictory.status, 'failed');
  assert.equal(contradictory.error.code, 'WORKFLOW_SPEC_SOURCE_AMBIGUOUS');
  const escaped = await adapter.execute({ spec, workspaceRoot: join(root, '..') });
  assert.equal(escaped.status, 'blocked');
  assert.equal(escaped.error.code, 'WORKFLOW_PATH_OUTSIDE_ALLOWED_ROOT');
  const result = await adapter.execute({ spec, workspaceRoot: root });
  assert.equal(result.status, 'success', JSON.stringify(result.error));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'outputs/result.json'), 'utf8')), [{ value: 3 }, { value: 7 }]);
  assert.equal(result.evidence.workflow.specSource, 'inline');
  assert.equal(result.evidence.workflow.specSha256, createHash('sha256').update(JSON.stringify(spec)).digest('hex'));
  const repeated = await adapter.execute({ spec, workspaceRoot: root });
  assert.equal(repeated.status, 'success');
  await writeFile(join(root, 'inputs/source.json'), '[{"value":4},{"value":8}]');
  const existing = await adapter.execute({ spec, workspaceRoot: root });
  assert.equal(existing.status, 'failed');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'outputs/result.json'), 'utf8')), [{ value: 3 }, { value: 7 }]);
}));

test('a failed natural assertion publishes no output', async () => fixture(async (root) => {
  const context = contextFor(root);
  context.mission.objective = objective.replace('개수가 2', '개수가 3');
  const args = compileNaturalWorkflowMission(context).actions[0].arguments;
  const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute(args);
  assert.equal(result.status, 'failed');
  await assert.rejects(readFile(join(root, 'outputs/result.json')), { code: 'ENOENT' });
}));

test('default A-G mission path executes inline prose without a custom planner', async () => fixture(async (root) => {
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'natural-integration-test', durationMinutes: 5 });
  const created = runtime.missionRuntime.createMission({ objective,
    successCriteria: ['outputs/result.json 파일을 생성한다.'],
    authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
      grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] }
  });
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(result.status, 'COMPLETED', JSON.stringify({ status: result.status, reason: result.stopReason, observations: result.observations }));
  assert.equal(result.observations.at(-1).toolName, 'workflow.execute');
  assert.match(result.observations.at(-1).data.workflow.specSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'outputs/result.json'), 'utf8')), [{ value: 3 }, { value: 7 }]);
}));

test('unsegmented read-summarize-save request reaches the general planner and verifies the real output', async () => fixture(async (root) => {
  await mkdir(join(root, 'outputs'));
  const sourcePath = join(root, 'inputs', 'meeting.txt');
  const outputPath = join(root, 'outputs', 'meeting-summary.txt');
  const source = '회의는 10월 3일 오전 10시에 시작합니다. 준비물은 인쇄물 12부입니다. 장소는 본당입니다.';
  await writeFile(sourcePath, source, 'utf8');

  let plannerCalls = 0;
  let readEvidenceReachedPlanner = false;
  const missionRunner = async (prompt) => {
    plannerCalls += 1;
    const observedLine = prompt.split('\n').find((line) => line.startsWith('실행 관찰: '));
    const observations = observedLine ? JSON.parse(observedLine.slice('실행 관찰: '.length)) : [];
    const readObservation = observations.find((item) => item.toolName === 'filesystem.readText');
    const writtenObservation = observations.find((item) => item.toolName === 'filesystem.createTextFile');
    let result;

    if (!readObservation) {
      result = {
        decision: 'continue', summary: '원본을 먼저 읽습니다.', question: null, blockedReason: null,
        actions: [{
          id: 'read_meeting_source', title: '회의 원본 읽기',
          command: 'meeting.txt 내용을 읽어줘', expectedToolName: 'filesystem.readText',
          arguments: { path: sourcePath, maxChars: 12000 }, dependencies: [], successSignal: '원본 텍스트와 해시가 확인됨'
        }],
        criteriaAssessment: [{ criterionId: 'summary_saved', status: 'unsatisfied', evidenceActionIds: [], reason: '아직 실행 전' }]
      };
    } else if (!writtenObservation) {
      const preview = String(readObservation.evidenceFacts?.stdoutPreview ?? '');
      assert.equal(preview.includes(source), true, 'the planner must receive the real, non-sensitive local source text');
      readEvidenceReachedPlanner = true;
      result = {
        decision: 'continue', summary: '확인된 원문을 요약 파일로 저장합니다.', question: null, blockedReason: null,
        actions: [{
          id: 'write_meeting_summary', title: '회의 요약 저장',
          command: 'meeting-summary.txt 텍스트 파일을 만들어줘', expectedToolName: 'filesystem.createTextFile',
          arguments: { path: outputPath, content: '회의는 10월 3일 오전 10시에 본당에서 열리며, 준비물은 인쇄물 12부입니다.', allowOverwrite: false },
          dependencies: [], successSignal: '새 요약 파일이 생성되고 내용 해시가 검증됨'
        }],
        criteriaAssessment: [{ criterionId: 'summary_saved', status: 'unsatisfied', evidenceActionIds: [], reason: '아직 출력 검증 전' }]
      };
    } else {
      result = {
        decision: 'complete', summary: '원본을 읽고 핵심을 요약해 새 파일로 저장했으며 결과 검증이 통과했습니다.',
        question: null, blockedReason: null, actions: [],
        criteriaAssessment: [{ criterionId: 'summary_saved', status: 'satisfied', evidenceActionIds: [writtenObservation.actionId], reason: '읽기와 출력 생성의 실제 G 증거가 확인됨' }]
      };
    }
    return JSON.stringify({ result: JSON.stringify(result) });
  };

  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtime = createAgRuntime({
    allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env,
    missionRunner, workerDaemonEnabled: false
  });
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'natural-workflow-end-to-end-test', durationMinutes: 5 });
  const created = runtime.missionRuntime.createMission({
    objective: "'inputs/meeting.txt'를 읽고 핵심을 요약해 'outputs/meeting-summary.txt'로 저장해줘",
    successCriteria: [{ criterionId: 'summary_saved', statement: '원본의 날짜·시간·장소·준비물 정보를 보존한 요약 파일이 생성된다.',
      verificationSpec: { version: 1, kind: 'text.equals', path: 'outputs/meeting-summary.txt',
        equals: '회의는 10월 3일 오전 10시에 본당에서 열리며, 준비물은 인쇄물 12부입니다.' } }],
    authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
      grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] }
  });

  const result = await runtime.missionRuntime.runMission(created.missionId, { maxWaves: 4 });

  assert.equal(result.status, 'COMPLETED', JSON.stringify({ status: result.status, reason: result.stopReason, observations: result.observations, waves: result.waves, plans: result.planHistory }));
  assert.equal(readEvidenceReachedPlanner, true);
  assert.equal(plannerCalls, 2, 'Core independently reads and checks the final contents after the write without an additional completion model call');
  assert.equal(result.observations.filter((item) => item.toolName === 'filesystem.readText').length, 1);
  assert.equal(result.observations.filter((item) => item.toolName === 'filesystem.createTextFile').length, 1);
  assert.equal(result.observations.every((item) => item.verification?.status === 'passed'), true);
  const summary = await readFile(outputPath, 'utf8');
  assert.equal(summary, '회의는 10월 3일 오전 10시에 본당에서 열리며, 준비물은 인쇄물 12부입니다.');
  assert.equal(source.includes('10월 3일 오전 10시'), true);
  assert.equal(summary.includes('10월 3일 오전 10시'), true);
  assert.equal(summary.includes('인쇄물 12부'), true);
}));
