import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve } from 'node:path';
import { ActionType, createTaskRequest, InputSource, ModuleId } from '../packages/shared/src/types.js';

// 결정화 캐시가 repo logs/를 오염시키거나 이전 실행의 캐시가 호출 횟수 단언을 깨지 않도록 격리한다.
process.env.JARVIS_SHELL_CACHE_PATH = joinPath(tmpdir(), `jarvis-test-shell-cache-${process.pid}.jsonl`);
process.env.JARVIS_CONTENT_CACHE_PATH = joinPath(tmpdir(), `jarvis-test-content-cache-${process.pid}.jsonl`);
process.env.JARVIS_INTENT_CACHE_PATH = joinPath(tmpdir(), `jarvis-test-intent-cache-${process.pid}.jsonl`);
process.env.JARVIS_PLAN_CACHE_PATH = joinPath(tmpdir(), `jarvis-test-plan-cache-${process.pid}.jsonl`);
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import {
  ClaudeCliTaskPlanner,
  commandHasDraftableContent,
  createTaskPlannerFromEnv
} from '../packages/core/src/planning/claude-cli-task-planner.js';
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

test('content drafting ignores digits that only belong to a file name', () => {
  assert.equal(commandHasDraftableContent('frontier-ui-proof-1787113166703.txt 파일을 만들어줘'), false);
  assert.equal(commandHasDraftableContent('"2026 08 회의록.txt" 파일을 만들어줘'), false);
  assert.equal(commandHasDraftableContent('2026년 매출 10% 증가 보고서를 만들어줘'), true);
});

test('a named empty file skips every model round trip even when content drafting is enabled', () => {
  let modelCalls = 0;
  const planner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: () => {
      modelCalls += 1;
      throw new Error('model must not run for a filename-only create command');
    }
  });
  const command = 'frontier-ui-proof-1787113166703.txt 파일을 만들어줘';
  const taskRequest = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: taskRequest.requestId });

  const plan = planner.createPlan(taskRequest, intent, {});

  assert.equal(plan.action.actionType, ActionType.CREATE_FILE);
  assert.equal(plan.action.arguments.fileName, 'frontier-ui-proof-1787113166703.txt');
  assert.equal(plan.action.arguments.contentDraft, undefined);
  assert.equal(modelCalls, 0);
});

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
  assert.equal(actionNodes[1].arguments.query, '로키드 신제품');
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

test('llm planner keeps title and risk evidence consistent when it corrects an action', () => {
  const command = '최근 수정한 파일을 보여줘 조회 맥락 교정';
  const planner = new ClaudeCliTaskPlanner({
    runner: () => plannerResponse({
      summary: '최근 수정 파일 목록을 조회합니다.',
      parts: [{
        actionType: ActionType.LIST_FILES,
        text: command,
        description: '최근 수정 파일 목록 조회',
        slots: { directoryHint: 'workspace' },
        arguments: { directory: '.' }
      }]
    })
  });
  const taskRequest = makeTaskRequest(command);
  const parsed = intentParser.parse('이 파일 수정하고 보여줘', { requestId: taskRequest.requestId });
  const mismatchedIntent = {
    ...parsed,
    actionType: ActionType.EDIT_DOCUMENT,
    title: '문서 내용 편집',
    label: '문서 내용 편집',
    complexity: { ...parsed.complexity, needsPlanDecomposition: true }
  };

  const plan = planner.createPlan(taskRequest, mismatchedIntent, {});

  assert.equal(plan.action.actionType, ActionType.LIST_FILES);
  assert.equal(plan.title, '파일 목록 조회');
  assert.equal(plan.llmPlanning.actionRerouted, true);
  assert.equal(plan.llmPlanning.riskEscalated, false);
  assert.ok(plan.riskNotes.some((note) => note.includes('대표 작업을 파일 목록 조회')));
  assert.equal(plan.riskNotes.some((note) => note.includes('대표 위험도를 승격')), false);
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

  const fallbackCompositeCommand = `${compositeCommand} 고유 폴백 검증`;
  const composite = makeTaskRequest(fallbackCompositeCommand);
  const compositeIntent = intentParser.parse(fallbackCompositeCommand, { requestId: composite.requestId });
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

test('task planner env selects the OpenAI API runner for planning and content drafting', () => {
  const planner = createTaskPlannerFromEnv({
    env: {
      JARVIS_LLM_PLANNER: '1',
      JARVIS_LLM_CONTENT: '1',
      JARVIS_OPENAI_API_KEY: 'sk-test',
      JARVIS_OPENAI_MODEL: 'gpt-test-fast'
    }
  });
  assert.equal(planner.runnerProvider, 'openai-api');
  assert.equal(planner.runnerExternalService, 'openai-api');
  assert.equal(planner.runnerModel, 'gpt-test-fast');
  assert.equal(planner.contentRunnerProvider, 'openai-api');
  assert.equal(planner.contentRunnerExternalService, 'openai-api');
  assert.equal(planner.contentRunnerModel, 'gpt-test-fast');
});

test('content drafting fills CREATE_FILE arguments with LLM-drafted xlsx content', () => {
  let draftCalls = 0;
  const planner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: (prompt) => {
      if (prompt.includes('프로 수준')) {
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

test('confirmed F preferences flow into LLM draft prompts and plan evidence', () => {
  const prompts = [];
  const planner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: (prompt) => {
      prompts.push(prompt);
      return plannerResponse({
        kind: 'xlsx',
        sheetName: '정산',
        columns: ['항목', '금액', '비고'],
        rows: [['합계', 0, '']]
      });
    }
  });
  const command = '정산표 엑셀 만들어줘';
  const taskRequest = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: taskRequest.requestId });
  const planningContext = {
    confirmedPreferenceHints: [
      { preferenceId: 'pref_1', statement: '표에는 항상 비고 열을 포함한다', confidence: 0.9, planningWeight: 1.8 },
      { preferenceId: 'pref_2', statement: '금액은 원 단위 숫자로만 적는다', confidence: 0.8, planningWeight: 1.6 }
    ]
  };
  const plan = planner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_pref_1', currentDirectory: './workspace' },
    planningContext
  });
  assert.ok(prompts[0].includes('사용자가 확정한 선호'), 'draft prompt contains the preference section');
  assert.ok(prompts[0].includes('표에는 항상 비고 열을 포함한다'));
  assert.ok(prompts[0].includes('금액은 원 단위 숫자로만 적는다'));
  assert.deepEqual(plan.action.arguments.contentDraft.appliedPreferences, ['pref_1', 'pref_2']);
  assert.equal(plan.llmPlanning.preferenceHintsApplied, 2);

  const noPrefPlan = planner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_pref_2', currentDirectory: './workspace' }
  });
  assert.ok(!prompts.at(-1).includes('사용자가 확정한 선호'), 'no preference section without hints');
  assert.deepEqual(noPrefPlan.action.arguments.contentDraft.appliedPreferences, []);
});

test('preferences also reach the decomposition prompt for composite commands', () => {
  const prompts = [];
  const planner = new ClaudeCliTaskPlanner({
    runner: (prompt) => {
      prompts.push(prompt);
      return heterogeneousResponse;
    }
  });
  const taskRequest = makeTaskRequest(compositeCommand);
  const intent = intentParser.parse(compositeCommand, { requestId: taskRequest.requestId });
  planner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_pref_3', currentDirectory: './workspace' },
    planningContext: {
      confirmedPreferenceHints: [
        { preferenceId: 'pref_3', statement: '보고서 파일명에는 날짜를 붙인다', confidence: 0.85, planningWeight: 1.7 }
      ]
    }
  });
  assert.ok(prompts[0].includes('작업 계획 분해기'));
  assert.ok(prompts[0].includes('보고서 파일명에는 날짜를 붙인다'), 'decomposition prompt carries preferences');
});

test('plan carries a human explanation and asks clarifying questions when ambiguous', () => {
  const planner = new ClaudeCliTaskPlanner({
    clarifyEnabled: true,
    runner: (prompt) => {
      if (prompt.includes('요구사항을 확인하는')) {
        return plannerResponse({ questions: ['어떤 형식으로 만들까요? (엑셀/메모)', '언제까지 필요하세요?'] });
      }
      throw new Error('unexpected prompt');
    }
  });
  const command = '그거 좀 정리해줘';
  const taskRequest = makeTaskRequest(command);
  // 모호한 의도(신뢰도 낮음)를 강제한다.
  const intent = { ...intentParser.parse(command, { requestId: taskRequest.requestId }), confidence: 0.4, unknown: true };
  const plan = planner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_clar_1', currentDirectory: './workspace' }
  });
  assert.ok(plan.planExplanation && plan.planExplanation.length > 0, 'plan explains how it was formed');
  assert.equal(plan.clarification.ambiguous, true);
  assert.equal(plan.clarification.questions.length, 2);
  assert.match(plan.clarification.questions[0], /형식/);
});

test('clear commands skip clarifying questions', () => {
  let clarifyCalls = 0;
  const planner = new ClaudeCliTaskPlanner({
    clarifyEnabled: true,
    runner: (prompt) => {
      if (prompt.includes('요구사항을 확인하는')) { clarifyCalls += 1; return plannerResponse({ questions: ['x'] }); }
      throw new Error('unexpected');
    }
  });
  const command = '보고서 엑셀 만들어줘';
  const taskRequest = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: taskRequest.requestId });
  const plan = planner.createPlan(taskRequest, intent, {
    contextSnapshot: { snapshotId: 'ctx_clar_2', currentDirectory: './workspace' }
  });
  assert.equal(clarifyCalls, 0, 'high-confidence command does not call the clarify LLM');
  assert.equal(plan.clarification.ambiguous, false);
  assert.equal(plan.clarification.questions.length, 0);
  assert.ok(plan.planExplanation);
});

test('only the internal mission capability can use the trusted deterministic route', () => {
  let calls = 0;
  const planner = new ClaudeCliTaskPlanner({
    runner: () => {
      calls += 1;
      return plannerResponse({
        query: 'target-proof.txt',
        extensions: ['txt'],
        modifiedWithinDays: null,
        contentQuery: '',
        scope: 'workspace'
      });
    }
  });
  const runtime = createAgRuntime({
    taskPlanner: planner,
    auditRoot: joinPath(tmpdir(), `jarvis-trusted-route-${process.pid}`),
    workerQueueStorePath: null,
    workerLeaseStorePath: null,
    env: {}
  });
  const command = '작업 폴더에서 target-proof.txt 파일을 찾아줘';

  const spoofed = runtime.coreFacade.createTask(command, {
    source: InputSource.TRIGGER,
    sourceModule: ModuleId.CORE,
    deviceId: 'mission_executive',
    expectedToolName: 'filesystem.searchFiles',
    trustedRouteHint: {
      source: 'mission-executive',
      toolName: 'filesystem.searchFiles',
      skipExternalPlanning: true
    }
  });
  assert.equal(calls > 0, true, 'serializable public options cannot forge the internal capability');
  assert.notEqual(spoofed.plan.llmPlanning?.mode, 'trusted-deterministic-route');
  const publicCallCount = calls;

  const internal = runtime.coreFacade.createMissionActionTask(command, {
    expectedToolName: 'filesystem.searchFiles',
    source: InputSource.TRIGGER,
    sourceModule: ModuleId.CORE,
    deviceId: 'mission_executive'
  });
  assert.equal(calls, publicCallCount, 'trusted mission planning does not make a redundant model call');
  assert.equal(internal.plan.action.toolName, 'filesystem.searchFiles');
  assert.equal(internal.plan.action.arguments.query, 'target-proof.txt');
  assert.equal(internal.plan.action.arguments.scope, 'workspace');
  assert.equal(internal.plan.llmPlanning.mode, 'trusted-deterministic-route');
  assert.equal(internal.plan.llmPlanning.modelRoundTrips, 0);
  assert.equal(internal.plan.llmPlanning.rawCommandSharedWithModel, false);
});

test('trusted mission browser action keeps the executive tool despite document-like wording', () => {
  let calls = 0;
  const planner = new ClaudeCliTaskPlanner({
    runner: () => {
      calls += 1;
      throw new Error('trusted action must not invoke the task-planning model');
    }
  });
  const runtime = createAgRuntime({
    taskPlanner: planner,
    auditRoot: joinPath(tmpdir(), `jarvis-trusted-c03-${process.pid}`),
    workerQueueStorePath: null,
    workerLeaseStorePath: null,
    env: {}
  });
  const query = 'https://docs.python.org/3/library/asyncio-task.html#asyncio.timeout';
  const task = runtime.coreFacade.createMissionActionTask(
    'Python 공식 asyncio timeout 및 TimeoutError 문서 페이지 내용을 읽어줘',
    {
      expectedToolName: 'browser.search',
      preparedArguments: { query, maxResults: 5 },
      source: InputSource.TRIGGER,
      sourceModule: ModuleId.CORE,
      deviceId: 'mission_executive'
    }
  );

  assert.equal(calls, 0);
  assert.equal(task.plan.action.actionType, ActionType.BROWSER_SEARCH);
  assert.equal(task.plan.action.toolName, 'browser.search');
  assert.equal(task.plan.action.arguments.query, query);
  assert.equal(task.plan.llmPlanning.mode, 'trusted-deterministic-route');
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
  assert.equal(packets[1].action.arguments.query, '로키드 신제품');
});

test('compound planner prepares executable arguments in one model round trip and reuses the plan cache', () => {
  let calls = 0;
  const command = '작업 폴더 파일을 확인하고 그리고 확인 결과 메모 파일을 만들어줘';
  const response = plannerResponse({
    summary: '작업 폴더를 확인한 뒤 결과 메모를 만듭니다.',
    parts: [
      {
        actionType: ActionType.LIST_FILES,
        text: '작업 폴더 파일을 확인하고',
        description: '작업 폴더 파일 확인',
        slots: { directoryHint: 'workspace' },
        arguments: { directory: './workspace' }
      },
      {
        actionType: ActionType.CREATE_FILE,
        text: '확인 결과 메모 파일을 만들어줘',
        description: '확인 결과 메모 작성',
        slots: { fileName: 'voice-result.txt', outputFormat: 'txt' },
        arguments: {
          fileName: 'voice-result.txt',
          outputFormat: 'txt',
          path: './workspace/voice-result.txt',
          contentDraft: { kind: 'txt', content: '작업 폴더 확인 결과를 기록했습니다.' }
        }
      }
    ]
  });
  const planner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: () => {
      calls += 1;
      return response;
    }
  });
  const firstRequest = makeTaskRequest(command);
  const firstIntent = intentParser.parse(command, { requestId: firstRequest.requestId });
  const first = planner.createPlan(firstRequest, firstIntent, {});
  const firstNodes = first.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_'));

  assert.equal(calls, 1, 'decomposition and per-action arguments share one call');
  assert.equal(firstNodes[0].arguments.directory, resolve('./workspace'));
  assert.equal(firstNodes[1].arguments.content, '작업 폴더 확인 결과를 기록했습니다.');
  assert.equal(firstNodes[1].argumentsPreparedInDecomposition, true);
  assert.equal(first.llmPlanning.modelRoundTrips, 1);
  assert.equal(first.llmPlanning.preparedArgumentCount, 2);
  assert.equal(first.llmPlanning.avoidedFollowupModelCalls, 2);

  const secondRequest = makeTaskRequest(command);
  const secondIntent = intentParser.parse(command, { requestId: secondRequest.requestId });
  const second = planner.createPlan(secondRequest, secondIntent, {});
  assert.equal(calls, 1, 'repeated compound command does not call the model again');
  assert.equal(second.llmPlanning.fromCache, true);
  assert.equal(second.llmPlanning.modelRoundTrips, 0);
  assert.equal(second.llmPlanning.rawCommandSharedWithModel, false);
});

test('compound planner preserves safe create paths and canonical move arguments for executable recovery', () => {
  const workspaceRoot = resolve('dist/verification/planner-move-workspace');
  const stagingPath = joinPath(workspaceRoot, 'staging', 'result.txt');
  const deliveredPath = joinPath(workspaceRoot, 'delivered', 'result.txt');
  const command = '결과 파일을 만들고 그리고 완료 폴더로 옮겨줘';
  const planner = new ClaudeCliTaskPlanner({
    workspaceRoot,
    contentEnabled: true,
    runner: () => plannerResponse({
      summary: '결과 파일을 만들고 완료 폴더로 이동합니다.',
      parts: [
        {
          actionType: ActionType.CREATE_FILE,
          text: '결과 파일을 만들고',
          description: '결과 파일 생성',
          slots: { fileName: 'result.txt', outputFormat: 'txt' },
          arguments: {
            path: stagingPath,
            contentDraft: { kind: 'txt', content: '완료' }
          }
        },
        {
          actionType: ActionType.MOVE_FILE,
          text: '완료 폴더로 옮겨줘',
          description: '결과 파일 이동',
          arguments: { sourcePath: stagingPath, targetPath: deliveredPath }
        }
      ]
    })
  });
  const request = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: request.requestId });
  const plan = planner.createPlan(request, intent, {});
  const nodes = plan.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_'));

  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].arguments.path, stagingPath);
  assert.equal(nodes[0].arguments.content, '완료');
  assert.deepEqual(nodes[1].arguments.moves, [{ from: stagingPath, to: deliveredPath }]);
  assert.equal(nodes[1].argumentsPreparedInDecomposition, true);
  assert.deepEqual(nodes[1].affectedItems[0], {
    type: 'planned_move',
    path: stagingPath,
    from: stagingPath,
    to: deliveredPath
  });
  const compensation = plan.compensationPlan.compensatingActions;
  assert.equal(compensation.find((item) => item.targetNodeId === 'action_1').action, 'delete_created_output');
  assert.equal(compensation.find((item) => item.targetNodeId === 'action_2').action, 'reverse_move');
});

test('compound planner confines missing or generic model paths to the configured workspace root', () => {
  const workspaceRoot = resolve('dist/verification/planner-workspace-root');
  const hallucinatedHostDirectory = resolve('dist/verification/untrusted-model-path/Jarvis');
  const command = '작업 폴더의 파일 목록을 확인하고 그리고 live-result.txt 파일을 만들어 완료라고 써줘';
  const planner = new ClaudeCliTaskPlanner({
    workspaceRoot,
    contentEnabled: true,
    runner: () => plannerResponse({
      summary: '목록을 확인한 뒤 결과 파일을 만듭니다.',
      parts: [
        {
          actionType: ActionType.LIST_FILES,
          text: '작업 폴더의 파일 목록을 확인하고',
          description: '작업 폴더 확인',
          slots: { directoryHint: '작업 폴더' },
          arguments: { directory: hallucinatedHostDirectory }
        },
        {
          actionType: ActionType.CREATE_FILE,
          text: 'live-result.txt 파일을 만들어 완료라고 써줘',
          description: '결과 파일 생성',
          slots: { fileName: 'live-result.txt', outputFormat: 'txt' },
          arguments: {
            path: './workspace/live-result.txt',
            contentDraft: { kind: 'txt', content: '완료' }
          }
        }
      ]
    })
  });
  const request = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: request.requestId });
  const plan = planner.createPlan(request, intent, {});
  const actionNodes = plan.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_'));

  assert.equal(actionNodes[0].arguments.directory, workspaceRoot);
  assert.equal(actionNodes[1].arguments.path, joinPath(workspaceRoot, 'live-result.txt'));
  assert.equal(actionNodes[1].arguments.content, '완료');
});

test('content draft sanitizer preserves bounded Word and PowerPoint structures', () => {
  const planner = new ClaudeCliTaskPlanner({ runner: () => { throw new Error('not-used'); } });
  const document = planner.sanitizeContentDraft({
    kind: 'doc',
    title: '운영 보고서',
    blocks: [
      { type: 'heading', level: 9, text: '요약' },
      { type: 'paragraph', text: '핵심 운영 결과입니다.' },
      { type: 'bullets', items: ['완료', '검토'] },
      { type: 'table', columns: ['항목', '상태'], rows: [['음성', '통과']] },
      { type: 'script', text: 'blocked' }
    ]
  });
  assert.equal(document.kind, 'doc');
  assert.equal(document.blocks.length, 4);
  assert.equal(document.blocks[0].level, 3);
  assert.equal(document.blocks.some((block) => block.type === 'script'), false);

  const slides = planner.sanitizeContentDraft({
    kind: 'slides',
    title: 'JARVIS 운영 브리핑',
    slides: [
      { title: '목표', bullets: ['음성 기반 작업 완수', '실패 자동 복구'], notes: '운영자 설명' },
      { title: '', bullets: [] }
    ]
  });
  assert.equal(slides.kind, 'slides');
  assert.equal(slides.slides.length, 1);
  assert.deepEqual(slides.slides[0].bullets, ['음성 기반 작업 완수', '실패 자동 복구']);
});
