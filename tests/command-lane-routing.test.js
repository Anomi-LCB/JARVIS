import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';
import { generateCorpus } from '../scripts/universal-control-extreme-corpus.mjs';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { TaskPlanner } from '../packages/core/src/planning/task-planner.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { coreTaskRuntimeEnvFromEnv } from '../scripts/core-service-runtime.mjs';
import { readFileSync } from 'node:fs';

const weatherDocumentEmailCommand = '너는 한글프로그램으로 이번주 날씨 통계를 가장 깔끔하게 시각적인 표로 작성해서 바탕화면에 저장하고 내 구글 메일로 보내놔.';

test('complex weather document email request is routed to the asynchronous mission lane', () => {
  const routing = classifyCommandLane(weatherDocumentEmailCommand);

  assert.equal(routing.lane, 'mission');
  assert.deepEqual(routing.stageIds, ['live-data', 'analysis', 'document', 'external-transfer']);
  assert.ok(routing.reasonCodes.includes('long-running-or-privileged-stage'));
  assert.ok(routing.reasonCodes.includes('multi-capability-workflow'));
});

test('simple deterministic local commands remain in the quick task lane', () => {
  assert.equal(classifyCommandLane('메모 파일 하나 만들어줘').lane, 'task');
  assert.equal(classifyCommandLane('작업 폴더 파일 목록 보여줘').lane, 'task');
});

test('explicit unsafe shortcuts and fabricated approval are routed to the mission safety gate', async () => {
  const corpus = await generateCorpus();
  const boundaries = corpus.cases.filter((item) => item.class === 'safety-boundary');
  assert.equal(boundaries.length, 13);
  for (const item of boundaries) {
    const routing = classifyCommandLane(item.command);
    assert.equal(routing.lane, 'mission', `${item.id}: ${routing.lane}`);
    assert.ok(routing.stageIds.includes('safety-sensitive'), item.id);
    assert.ok(routing.reasonCodes.includes('safety-sensitive-action'), item.id);
  }
});

test('fixed routing acceptance cases keep account, transaction, health and device commands out of quick tasks', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/command-routing-cases.json', import.meta.url), 'utf8'));
  const failed = cases.filter((item) => classifyCommandLane(item.text).lane !== item.expected);
  assert.deepEqual(failed.map(({ id }) => id), []);
});

test('Core rejects a mission-class command before synchronous task planning can run', async () => {
  const coreFacade = new CoreFacade();
  let createTaskCalls = 0;
  coreFacade.createTask = () => {
    createTaskCalls += 1;
    throw new Error('synchronous task planning must not run');
  };
  const server = createCoreServer(coreFacade);
  const address = await listenOnFetchSafePort(server);
  const startedAt = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText: weatherDocumentEmailCommand })
    });
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'A_COMMAND_REQUIRES_MISSION');
    assert.equal(payload.recommendedEndpoint, '/missions');
    assert.equal(payload.routing.lane, 'mission');
    assert.equal(createTaskCalls, 0);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('product Core keeps synchronous LLM adapters out of the HTTP quick-task lane by default', () => {
  const source = {
    JARVIS_LLM_INTENT: '1',
    JARVIS_LLM_PLANNER: '1',
    JARVIS_LLM_CONTENT: '1',
    JARVIS_MISSION_EXECUTIVE: '1'
  };
  const isolated = coreTaskRuntimeEnvFromEnv(source);

  assert.equal(isolated.JARVIS_LLM_INTENT, '0');
  assert.equal(isolated.JARVIS_LLM_PLANNER, '0');
  assert.equal(isolated.JARVIS_LLM_CONTENT, '0');
  assert.equal(isolated.JARVIS_MISSION_EXECUTIVE, '1');
  assert.equal(source.JARVIS_LLM_INTENT, '1');
  assert.equal(coreTaskRuntimeEnvFromEnv({ ...source, JARVIS_CORE_SYNC_TASK_LLM_ENABLED: '1' }).JARVIS_LLM_PLANNER, '1');
});

test('local document planning preserves a requested Desktop destination for the native HWP adapter', () => {
  const command = '한글 문서로 주간 보고서를 작성해서 바탕화면에 저장해줘';
  const parser = new IntentParser();
  const intent = parser.parse(command, { requestId: 'desktop_document' });
  const planner = new TaskPlanner({ workspaceRoot: 'C:/Jarvis/workspace' });
  const args = planner.argumentsFor(intent, { command: { rawText: command } }, null);

  assert.equal(intent.slots.targetDirectoryHint, 'desktop');
  assert.equal(args.targetDirectoryHint, 'desktop');
  assert.equal('path' in args, false);
  assert.equal(args.outputFormat, 'hwp');
});
