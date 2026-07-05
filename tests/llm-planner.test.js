import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionType, createTaskRequest, InputSource, ModuleId } from '../packages/shared/src/types.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { ClaudeCliTaskPlanner, createTaskPlannerFromEnv } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { TaskPlanner } from '../packages/core/src/planning/task-planner.js';
import { createDefaultContractRegistry } from '../packages/core/src/contracts/default-contracts.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

const intentParser = new IntentParser();

function makeTaskRequest(rawText) {
  return createTaskRequest({
    rawText,
    deviceId: 'mobile_lcb_001',
    inputMode: 'text',
    source: InputSource.MOBILE,
    sourceModule: ModuleId.MOBILE,
    userId: 'local_user',
    locale: 'ko-KR',
    createdAt: new Date().toISOString()
  });
}

function plannerResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

const compositeCommand = '주간 보고서 엑셀 만들고 그리고 로키드 신제품 뉴스 검색해줘';

const heterogeneousResponse = plannerResponse({
  summary: '주간 보고서 엑셀 생성 후 로키드 신제품 뉴스를 조사합니다.',
  parts: [
    {
      actionType: ActionType.CREATE_FILE,
      text: '주간 보고서 엑셀 만들고',
      description: '주간 보고서 엑셀 파일 생성',
      slots: { fileName: '주간-보고서.xlsx', outputFormat: 'xlsx' }
    },
    {
      actionType: ActionType.BROWSER_SEARCH,
      text: '로키드 신제품 뉴스 검색해줘',
      description: '로키드 신제품 뉴스 검색',
      slots: { query: '로키드 신제품 뉴스' }
    }
  ]
});

test('llm planner decomposes a composite command into heterogeneous action nodes', () => {
  const planner = new ClaudeCliTaskPlanner({ runner: () => heterogeneousResponse });
  const taskRequest = makeTaskRequest(compositeCommand);
  const intent = intentParser.parse(compositeCommand, { requestId: taskRequest.requestId });
  const plan = planner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_test_1', currentDirectory: './workspace' }
  });

  const actionNodes = plan.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_'));
  assert.equal(actionNodes.length, 2);
  assert.equal(actionNodes[0].actionType, ActionType.CREATE_FILE);
  assert.equal(actionNodes[1].actionType, ActionType.BROWSER_SEARCH);
  assert.notEqual(actionNodes[0].toolName, actionNodes[1].toolName, 'each node routes to its own tool');
  assert.equal(actionNodes[0].arguments.fileName, '주간-보고서.xlsx');
  assert.equal(actionNodes[1].arguments.query, '로키드 신제품 뉴스');
  assert.equal(actionNodes[1].arguments.readOnly, true);
  assert.equal(plan.planGraph.strategy, 'multi_action_dag');
  assert.equal(plan.llmPlanning.heterogeneous, true);
  assert.match(plan.interpretedIntent, /2단계/);

  const registry = createDefaultContractRegistry();
  registry.assert('TaskPlan', plan);
});

test('llm planner escalates the primary action to the riskiest part so E policy sees worst case', () => {
  const withUpload = plannerResponse({
    summary: '문서를 만들고 메일로 보냅니다.',
    parts: [
      { actionType: ActionType.CREATE_FILE, text: '안내문 만들고', description: '안내문 작성', slots: {} },
      { actionType: ActionType.UPLOAD_FILE, text: '메일로 보내줘', description: '메일 전송', slots: { destination: 'email' } }
    ]
  });
  const planner = new ClaudeCliTaskPlanner({ runner: () => withUpload });
  const command = '안내문 만들고 그리고 메일로 보내줘';
  const taskRequest = makeTaskRequest(command);
  const intent = { ...intentParser.parse(command, { requestId: taskRequest.requestId }), actionType: ActionType.CREATE_FILE };
  const plan = planner.createPlan(taskRequest, intent, {});
  assert.equal(plan.action.actionType, ActionType.UPLOAD_FILE, 'primary action escalates to the riskiest part');
  assert.equal(plan.llmPlanning.riskEscalated, true);
  assert.ok(plan.riskNotes.some((note) => note.includes('대표 위험도를 승격')));
});

test('llm planner skips the LLM for simple commands and falls back on failure', () => {
  let calls = 0;
  const planner = new ClaudeCliTaskPlanner({
    runner: () => {
      calls += 1;
      throw new Error('unavailable');
    }
  });
  const simple = makeTaskRequest('보고서 엑셀 만들어줘');
  const simpleIntent = intentParser.parse('보고서 엑셀 만들어줘', { requestId: simple.requestId });
  const simplePlan = planner.createPlan(simple, simpleIntent, {});
  assert.equal(calls, 0, 'simple commands never pay the LLM round trip');
  assert.equal(simplePlan.llmPlanning, undefined);

  const composite = makeTaskRequest(compositeCommand);
  const compositeIntent = intentParser.parse(compositeCommand, { requestId: composite.requestId });
  const fallbackPlan = planner.createPlan(composite, compositeIntent, {});
  assert.equal(calls, 1, 'composite command consults the LLM once');
  const basePlan = new TaskPlanner().createPlan(composite, compositeIntent, {});
  assert.equal(
    fallbackPlan.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_')).length,
    basePlan.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_')).length,
    'LLM failure falls back to base planner decomposition'
  );
  assert.equal(createTaskPlannerFromEnv({ env: {} }), null, 'flag off returns null so CoreFacade keeps the base planner');
});

test('content drafting fills CREATE_FILE arguments with LLM-drafted xlsx content', () => {
  let draftCalls = 0;
  const planner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: (prompt) => {
      if (prompt.includes('문서 초안 작성기')) {
        draftCalls += 1;
        return plannerResponse({
          kind: 'xlsx',
          sheetName: '주간정산',
          columns: ['항목', '금액', '비고'],
          rows: [['헌금', 0, '사용자 입력'], ['운영비', 0, '사용자 입력']]
        });
      }
      throw new Error('unexpected prompt');
    }
  });
  const command = '주간 정산표 엑셀 만들어줘';
  const taskRequest = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: taskRequest.requestId });
  const plan = planner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_draft_1', currentDirectory: './workspace' }
  });
  assert.equal(draftCalls, 1, 'simple command drafts content without a decomposition round trip');
  assert.deepEqual(plan.action.arguments.columns, ['항목', '금액', '비고']);
  assert.equal(plan.action.arguments.rows.length, 2);
  assert.equal(plan.action.arguments.sheetName, '주간정산');
  assert.equal(plan.action.arguments.contentDraft.draftedByLlm, true);
});

test('content drafting is off by default, sanitizes bad drafts, and falls back safely', () => {
  const defaultPlanner = new ClaudeCliTaskPlanner({
    runner: () => {
      throw new Error('must not be called');
    }
  });
  const command = '메모 파일 만들어줘';
  const taskRequest = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: taskRequest.requestId });
  const plainPlan = defaultPlanner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_draft_2', currentDirectory: './workspace' }
  });
  assert.equal(plainPlan.action.arguments.contentDraft, undefined, 'contentEnabled=false keeps base arguments');

  const badDraftPlanner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: () => plannerResponse({ kind: 'xlsx', columns: [], rows: [] })
  });
  const badPlan = badDraftPlanner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_draft_3', currentDirectory: './workspace' }
  });
  assert.equal(badPlan.action.arguments.contentDraft, undefined, 'empty draft falls back to base arguments');
  assert.equal(badPlan.action.arguments.rawText, command, 'base arguments remain intact');
});

test('worker node packets carry per-node actionType and toolName for heterogeneous plans', () => {
  const runtime = createAgRuntime({
    taskPlanner: new ClaudeCliTaskPlanner({ runner: () => heterogeneousResponse }),
    auditRoot: 'logs/test-llm-planner',
    workerQueueStorePath: null,
    workerLeaseStorePath: null
  });
  const created = runtime.coreFacade.createTask(compositeCommand);
  const task = created.task ?? created;
  const plan = task.plan ?? created.plan;
  assert.ok(plan.llmPlanning, 'plan came from the LLM planner');

  const actionNodes = plan.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_'));
  const basePacket = {
    packetId: 'packet_base',
    taskId: plan.taskId,
    action: { ...plan.action, arguments: plan.action.arguments }
  };
  const packets = actionNodes.map((node) => runtime.orchestrationWorker.createNodeExecutionPacket({
    basePacket,
    node,
    capabilityToken: { tokenId: 'cap_test' }
  }));
  assert.equal(packets[0].action.actionType, ActionType.CREATE_FILE);
  assert.equal(packets[1].action.actionType, ActionType.BROWSER_SEARCH);
  assert.notEqual(packets[0].action.toolName, packets[1].action.toolName);
  assert.equal(packets[1].action.arguments.query, '로키드 신제품 뉴스');
});
