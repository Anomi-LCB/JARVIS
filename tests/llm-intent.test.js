import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType } from '../packages/shared/src/types.js';

// 결정화 캐시가 repo logs/를 오염시키거나 이전 실행의 캐시가 호출 횟수 단언을 깨지 않도록 격리한다.
process.env.JARVIS_INTENT_CACHE_PATH = join(tmpdir(), `jarvis-test-intent-cache-${process.pid}.jsonl`);
import {
  buildIntentPrompt,
  ClaudeCliSemanticIntentAdapter,
  createIntentParserFromEnv
} from '../packages/core/src/intent/claude-cli-intent-adapter.js';
import { createDefaultContractRegistry } from '../packages/core/src/contracts/default-contracts.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

function llmResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

test('claude cli intent adapter maps LLM output into a valid IntentCandidate', () => {
  const adapter = new ClaudeCliSemanticIntentAdapter({
    model: 'haiku',
    runner: () => llmResponse({
      actionType: ActionType.BROWSER_SEARCH,
      confidence: 0.88,
      reasons: ['사용자가 웹에서 정보를 요청함'],
      slots: { query: '이번 주 서울 날씨', topic: '날씨' }
    })
  });
  const intent = adapter.parse('이번 주 서울 날씨가 어떤지 궁금하네', { requestId: 'req_test_1' });
  assert.equal(intent.actionType, ActionType.BROWSER_SEARCH);
  assert.equal(intent.category, 'browser');
  assert.equal(intent.riskHint, 'read-only-web');
  assert.ok(intent.confidence > 0.5 && intent.confidence <= 0.93);
  assert.ok(intent.reasons.some((reason) => reason.startsWith('llm:')));
  assert.equal(intent.semantic.matched, true);
  assert.equal(intent.semantic.externalService, 'anthropic-claude-cli');
  assert.equal(intent.semantic.rawCommandSharedWithModel, true);
  const registry = createDefaultContractRegistry();
  registry.assert('IntentCandidate', intent);
});

test('claude cli intent adapter derives risk metadata from its own table, not from the model', () => {
  const adapter = new ClaudeCliSemanticIntentAdapter({
    runner: () => llmResponse({
      actionType: ActionType.DELETE_FILE,
      confidence: 0.99,
      // 모델이 위험도를 낮추려는 출력을 흉내낸다.
      riskHint: 'read-only-local',
      category: 'document',
      reasons: ['안전한 요청으로 보임']
    })
  });
  const intent = adapter.parse('임시 파일 지워줘', { requestId: 'req_test_2' });
  assert.equal(intent.actionType, ActionType.DELETE_FILE);
  assert.equal(intent.riskHint, 'destructive');
  assert.equal(intent.category, 'filesystem');
  assert.ok(intent.confidence <= 0.93, 'confidence is clamped below the local parser ceiling');
});

test('claude cli intent adapter fails safe on garbage output and cli errors', () => {
  const garbage = new ClaudeCliSemanticIntentAdapter({ runner: () => '분류할 수 없습니다. JSON이 아님.' });
  const failed = garbage.parse('엑셀 만들어', { requestId: 'req_test_3' });
  assert.equal(failed.actionType, null);
  assert.equal(failed.confidence, 0);
  assert.equal(failed.semantic.failed, true);

  const throwing = new ClaudeCliSemanticIntentAdapter({
    runner: () => {
      throw new Error('spawn claude ENOENT');
    }
  });
  const errored = throwing.parse('엑셀 만들어', { requestId: 'req_test_4' });
  assert.equal(errored.actionType, null);
  assert.match(errored.semantic.failureReason, /ENOENT/);

  const unknownAction = new ClaudeCliSemanticIntentAdapter({
    runner: () => llmResponse({ actionType: 'LAUNCH_MISSILE', confidence: 0.9 })
  });
  const rejected = unknownAction.parse('미사일 발사해', { requestId: 'req_test_5' });
  assert.equal(rejected.actionType, null);
  assert.equal(rejected.semantic.failureReason, 'unrecognized-action-type');
});

test('policy-gated parser skips the LLM when local confidence is high and falls back on LLM failure', () => {
  let llmCalls = 0;
  const parser = createIntentParserFromEnv({
    env: { JARVIS_LLM_INTENT: '1' },
    runner: () => {
      llmCalls += 1;
      throw new Error('unavailable');
    }
  });
  assert.ok(parser, 'parser is created when the env flag is on');

  const clear = parser.parse('보고서 엑셀 만들어줘', { requestId: 'req_test_6' });
  assert.equal(clear.actionType, ActionType.CREATE_FILE);
  assert.equal(llmCalls, 0, 'high-confidence local parse must not call the LLM');

  const vague = parser.parse('음 그거 있잖아 어제 그거 어떻게 됐는지 좀', { requestId: 'req_test_7' });
  assert.ok(vague.actionType, 'LLM failure still yields the local fallback candidate');
  assert.equal(llmCalls, 1, 'vague command consults the LLM once');

  assert.equal(createIntentParserFromEnv({ env: {} }), null, 'flag off returns null so CoreFacade keeps the rule parser');
});

test('vague command routes through the LLM adapter and completes task creation end to end', () => {
  const runner = () => llmResponse({
    actionType: ActionType.BROWSER_SEARCH,
    confidence: 0.86,
    reasons: ['최근 소식 조회 요청'],
    slots: { query: '로키드 맥스 신제품 소식' }
  });
  const runtime = createAgRuntime({
    intentParser: createIntentParserFromEnv({ env: { JARVIS_LLM_INTENT: '1' }, runner }),
    auditRoot: 'logs/test-llm-intent',
    workerQueueStorePath: null,
    workerLeaseStorePath: null
  });
  const created = runtime.coreFacade.createTask('로키드 맥스 신제품 소식 좀 궁금한데');
  const task = created.task ?? created;
  const intent = task.intent ?? created.intent;
  assert.ok(intent, 'created task exposes intent');
  assert.equal(intent.actionType, ActionType.BROWSER_SEARCH);
  assert.equal(intent.semantic?.policyGate?.usedExternal, true);
  assert.equal(intent.semantic?.externalCandidate?.actionType, ActionType.BROWSER_SEARCH);
});
