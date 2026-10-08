import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModelProvider, createModelPlanningRunner, createModelPlanningRunnerFromEnv, normalizeModelUsage, describeModelProviders } from '../packages/core/src/mission/model-provider.js';
import { createMissionPlannerFromEnv, GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';

const plan = { decision: 'continue', summary: '목록 확인', question: null, blockedReason: null, actions: [{ id: 'list', title: '목록',
  command: '작업 폴더 파일 목록을 보여줘', expectedToolName: 'filesystem.listFiles', arguments: { directory: '.' },
  dependencies: [], requirementIds: [], constraintRequirementIds: [], successSignal: '목록 반환' }], criteriaAssessment: [] };
const context = () => ({ mission: { objective: '현재 자료를 확인한다.', successCriteria: [], constraints: [],
  remainingBudget: { plannerCalls: 1, activeRuntimeMs: 60_000 } }, capabilities: [{ toolName: 'filesystem.listFiles' }], observations: [] });
const wire = (provider, text = JSON.stringify(plan), count = 10) => provider === 'gemini'
  ? { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: count, candidatesTokenCount: 2, totalTokenCount: count + 2 } }
  : provider === 'xai'
    ? { id: 'resp_fixture', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: count, output_tokens: 2, total_tokens: count + 2, cost_in_usd_ticks: 40_000_000 } }
  : { choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: count, completion_tokens: 2, total_tokens: count + 2 } };
const options = (provider, fetchImpl) => ({ provider, model: provider === 'meta' ? 'muse-spark-1.3' : 'fixture-model', apiKey: 'fixture-key', fetchImpl });

test('provider capability catalog does not imply Meta Chat Completions has a storage control', () => {
  const catalog = JSON.parse(readFileSync(new URL('../config/agent-platform-capabilities.json', import.meta.url), 'utf8'));
  const meta = catalog.providerContracts.find(item => item.provider === 'meta');
  assert.match(meta.dataConditions, /does not set store/i);
  assert.match(meta.dataConditions, /not a retention guarantee/i);
  assert.doesNotMatch(meta.dataConditions, /Requests set store:false/i);
});

for (const provider of ['xai', 'meta', 'gemini']) {
  test(`${provider}: actual env-selected planner preserves plan and reports only evidenced usage and cost`, async () => {
    let request;
    const planner = createMissionPlannerFromEnv({ env: { JARVIS_MISSION_PROVIDER: provider, JARVIS_MISSION_MODEL: 'fixture-model',
      [`JARVIS_${provider.toUpperCase()}_API_KEY`]: 'fixture-key', JARVIS_MISSION_MAX_TRANSIENT_RETRIES: '0' },
      fetchImpl: async (url, init) => { request = { url, ...init }; return Response.json(wire(provider)); },
      dataClassifier: { classify: () => ({ dataClass: 'D0' }) } });
    const result = await planner.planNextWave(context());
    assert.equal(result.decision, 'continue');
    assert.equal(result.actions[0].expectedToolName, 'filesystem.listFiles');
    assert.equal(result.planning.provider, provider);
    assert.equal(result.planning.attempts[0].metadataSource, 'request-receipt');
    assert.equal(result.planning.usageTotals.total.totalTokens, 12);
    assert.equal(result.planning.usageTotals.total.costUsd, provider === 'xai' ? 0.004 : null);
    assert.equal(request.redirect, 'error');
    assert.equal(request.url.includes('fixture-key'), false);
    assert.equal(Object.hasOwn(JSON.parse(request.body), 'tools'), false);
    if (provider === 'meta') {
      const format = JSON.parse(request.body).response_format;
      assert.equal(format.type, 'json_schema');
      assert.equal(format.json_schema.name, 'jarvis_mission_plan');
      assert.equal(format.json_schema.strict, false);
      assert.deepEqual(format.json_schema.schema.required,
        ['decision', 'summary', 'question', 'blockedReason', 'actions', 'criteriaAssessment']);
      assert.equal(format.json_schema.schema.additionalProperties, false);
      assert.equal(format.json_schema.schema.properties.actions.items.properties.arguments.additionalProperties, true);
      assert.equal(Object.hasOwn(JSON.parse(request.body), 'store'), false,
        'Meta Chat Completions contract does not document the Responses API store option');
    }
    if (provider === 'xai') {
      assert.equal(request.url, 'https://api.x.ai/v1/responses');
      assert.equal(JSON.parse(request.body).store, false);
      const format = JSON.parse(request.body).text.format;
      assert.equal(format.type, 'json_schema');
      assert.equal(format.name, 'jarvis_mission_plan');
      assert.equal(format.strict, false);
      assert.deepEqual(format.schema.required,
        ['decision', 'summary', 'question', 'blockedReason', 'actions', 'criteriaAssessment']);
    }
    if (provider === 'gemini') {
      const config = JSON.parse(request.body).generationConfig;
      assert.equal(config.responseMimeType, 'application/json');
      assert.equal(config.candidateCount, 1);
      assert.deepEqual(config.responseJsonSchema.required,
        ['decision', 'summary', 'question', 'blockedReason', 'actions', 'criteriaAssessment']);
      assert.equal(config.responseJsonSchema.properties.actions.items.properties.arguments.additionalProperties, true);
    }
  });

  test(`${provider}: SSE split inside UTF-8 and event delimiters returns one complete response`, async () => {
    const events = provider === 'gemini'
      ? [{ candidates: [{ content: { parts: [{ text: '한글' }] } }] }, wire(provider, '완료')]
      : provider === 'xai'
        ? [{ type: 'response.output_text.delta', delta: '한글' }, { type: 'response.output_text.delta', delta: '완료' },
          { type: 'response.completed', response: wire(provider, '한글완료') }]
      : [{ choices: [{ delta: { content: '한글' }, finish_reason: null }] },
        { choices: [{ delta: { content: '완료' }, finish_reason: 'stop' }] },
        ...(provider === 'meta' ? [] : [{ choices: [], usage: wire(provider).usage }])];
    const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (provider === 'meta' ? 'data: [DONE]\r\n\r\n' : ''));
    const previews = [];
    let requestBody;
    const adapter = createModelProvider(options(provider, async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close();
      } }));
    }));
    const result = await adapter.generate({ prompt: 'fixture', stream: true, onText: event => previews.push(event) });
    assert.equal(result.output, '한글완료');
    if (provider === 'meta') {
      assert.equal(requestBody.stream, true);
      assert.equal(Object.hasOwn(requestBody, 'stream_options'), false,
        'Meta Chat Completions does not document stream_options.include_usage');
      assert.equal(result.usage, null, 'unreported streamed usage stays unknown');
    } else assert.equal(result.usage.totalTokens, 12);
    if (provider === 'xai') assert.equal(result.costUsd, 0.004);
    assert.ok(previews.every(event => event.provisional && event.requestId === result.requestId));
  });

  test(`${provider}: truncated response never becomes an executable partial plan`, async () => {
    const payload = wire(provider);
    if (provider === 'gemini') payload.candidates[0].finishReason = 'MAX_TOKENS';
    else if (provider === 'xai') payload.status = 'incomplete';
    else payload.choices[0].finish_reason = 'length';
    await assert.rejects(createModelProvider(options(provider, async () => Response.json(payload))).generate({ prompt: 'fixture' }),
      error => error.code === 'A_MODEL_RESPONSE_INCOMPLETE' && error.modelReceipt.usage.totalTokens === 12);
  });

  test(`${provider}: unsolicited native tool calls cannot bypass Mission policy`, async () => {
    const payload = wire(provider);
    if (provider === 'gemini') payload.candidates[0].content.parts.push({ functionCall: { name: 'email.send', args: {} } });
    else if (provider === 'xai') payload.output.push({ type: 'function_call', name: 'email.send', arguments: '{}' });
    else payload.choices[0].message.tool_calls = [{ id: 'call', function: { name: 'email.send', arguments: '{}' } }];
    await assert.rejects(createModelProvider(options(provider, async () => Response.json(payload))).generate({ prompt: 'fixture' }),
      { code: 'A_MODEL_UNEXPECTED_TOOL_CALL' });
  });
}

test('Gemini Interactions uses the current stateless structured-output contract and rejects provider tool calls', async () => {
  let request;
  const response = {
    id: 'interaction_fixture', status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(plan) }] }],
    usage: { total_input_tokens: 17, total_output_tokens: 6, total_thought_tokens: 3, total_tokens: 26 }
  };
  const adapter = createModelProvider(options('gemini-interactions', async (url, init) => {
    request = { url, ...init };
    return Response.json(response);
  }));
  const result = await adapter.generate({ prompt: 'fixture' });
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1/interactions');
  assert.equal(request.headers['x-goog-api-key'], 'fixture-key');
  assert.equal(request.redirect, 'error');
  assert.equal(JSON.parse(request.body).store, false);
  assert.equal(JSON.parse(request.body).model, 'fixture-model');
  assert.equal(JSON.parse(request.body).response_format.mime_type, 'application/json');
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 6, totalTokens: 26, reasoningTokens: 3 });
  assert.equal(result.output, JSON.stringify(plan));
  assert.equal(result.costUsd, null);
  await assert.rejects(adapter.generate({ prompt: 'fixture', stream: true }), { code: 'A_MODEL_STREAM_UNSUPPORTED' });

  const toolPayload = { ...response, status: 'requires_action', steps: [{
    type: 'function_call', name: 'email.send', arguments: { to: 'user@example.com' }
  }] };
  await assert.rejects(createModelProvider(options('gemini-interactions', async () => Response.json(toolPayload))).generate({ prompt: 'fixture' }),
    { code: 'A_MODEL_UNEXPECTED_TOOL_CALL' });
});

test('Gemini Interactions is selectable from Mission environment configuration', async () => {
  let targetUrl;
  const runner = createModelPlanningRunnerFromEnv({
    env: {
      JARVIS_MISSION_PROVIDER: 'gemini-interactions',
      JARVIS_MISSION_MODEL: 'fixture-model',
      JARVIS_GEMINI_API_KEY: 'fixture-key'
    },
    fetchImpl: async url => {
      targetUrl = String(url);
      return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(plan) }] }] });
    }
  });
  const result = await runner.runWithReceipt('public fixture');
  assert.equal(runner.provider, 'gemini-interactions');
  assert.equal(targetUrl, 'https://generativelanguage.googleapis.com/v1/interactions');
  assert.equal(JSON.parse(result.output).actions[0].expectedToolName, 'filesystem.listFiles');
});

test('concurrent requests on one provider runner keep per-request token accounting', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let count = 0;
  const runner = createModelPlanningRunner(options('meta', async () => {
    const current = ++count;
    if (current === 1) await gate; else release();
    return Response.json(wire('meta', JSON.stringify(plan), current * 10));
  }));
  const planner = new GoalExecutivePlanner({ runner, dataClassifier: { classify: () => ({ dataClass: 'D0' }) } });
  const results = await Promise.all([planner.planNextWave(context()), planner.planNextWave(context())]);
  assert.deepEqual(results.map(result => result.planning.usageTotals.total.inputTokens), [10, 20]);
  assert.notEqual(results[0].planning.attempts[0].requestId, results[1].planning.attempts[0].requestId);
});

test('external planner minimization still removes classified private material', async () => {
  let sent;
  const runner = createModelPlanningRunner(options('xai', async (_url, init) => { sent = init.body; return Response.json(wire('xai')); }));
  const planner = new GoalExecutivePlanner({ runner, dataClassifier: { classify: text => ({ dataClass: text.includes('PRIVATE_MARKER') ? 'D4' : 'D0' }) } });
  const input = context(); input.mission.objective = 'PRIVATE_MARKER 자료 검토';
  await planner.planNextWave(input);
  assert.equal(sent.includes('PRIVATE_MARKER'), false);
});

test('explicit missing credentials or unsupported provider never silently falls back', () => {
  assert.throws(() => createMissionPlannerFromEnv({ env: { JARVIS_MISSION_PROVIDER: 'meta', JARVIS_MISSION_MODEL: 'muse-spark-1.3' } }), { code: 'A_MODEL_CREDENTIAL_REQUIRED' });
  assert.throws(() => createMissionPlannerFromEnv({ env: { JARVIS_MISSION_PROVIDER: 'unknown' } }), { code: 'A_MODEL_PROVIDER_UNSUPPORTED' });
  assert.throws(() => createMissionPlannerFromEnv({ env: { JARVIS_MISSION_PROVIDER: 'constructor' } }), { code: 'A_MODEL_PROVIDER_UNSUPPORTED' });
  assert.throws(() => createModelProvider({ ...options('meta', fetch), model: 'muse-spark-1.3-contributor' }), { code: 'A_MODEL_TRAINING_TIER_DISABLED' });
});

test('Meta reasoning effort is optional, bounded to documented supported levels, and included only when configured', async () => {
  let body;
  const make = reasoningEffort => createModelPlanningRunner({ ...options('meta', async (_url, init) => {
    body = JSON.parse(init.body); return Response.json(wire('meta'));
  }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
  await make().runWithReceipt('fixture');
  assert.equal(Object.hasOwn(body, 'reasoning_effort'), false, 'default preserves provider-selected effort');
  await make('minimal').runWithReceipt('fixture');
  assert.equal(body.reasoning_effort, 'minimal', 'documented minimal effort is selectable');
  await make('high').runWithReceipt('fixture');
  assert.equal(body.reasoning_effort, 'high');
  await assert.rejects(Promise.resolve().then(() => make('none')), { code: 'A_MODEL_REASONING_EFFORT_INVALID' });
  await assert.rejects(Promise.resolve().then(() => createModelProvider({ ...options('xai', fetch), reasoningEffort: 'high' })),
    { code: 'A_MODEL_REASONING_EFFORT_INVALID' });
});

test('Meta Mission configuration rejects unsupported reasoning effort without falling back', () => {
  assert.throws(() => createModelPlanningRunnerFromEnv({ env: { JARVIS_MISSION_PROVIDER: 'meta', JARVIS_MISSION_MODEL: 'muse-spark-1.3',
    JARVIS_META_API_KEY: 'fixture-key', JARVIS_META_REASONING_EFFORT: 'none' } }), { code: 'A_MODEL_REASONING_EFFORT_INVALID' });
});

test('HTTP failures redact secrets and provider body; retryable status remains available', async () => {
  const adapter = createModelProvider(options('xai', async () => new Response('RAW_SECRET_BODY', { status: 429 })));
  await assert.rejects(adapter.generate({ prompt: 'PRIVATE_PROMPT' }), error => {
    assert.equal(error.code, 'A_MODEL_HTTP_ERROR'); assert.equal(error.status, 429); assert.equal(error.retryable, true);
    assert.doesNotMatch(JSON.stringify(error), /RAW_SECRET_BODY|fixture-key|PRIVATE_PROMPT/); return true;
  });
});

test('cancellation is propagated and no request starts for an already aborted signal', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const adapter = createModelProvider(options('meta', async () => { calls++; }));
  await assert.rejects(adapter.generate({ prompt: 'fixture', signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(calls, 0);
});

test('timeout aborts transport without provider or credential disclosure', async () => {
  const adapter = createModelProvider(options('gemini', async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('PRIVATE_TRANSPORT_ERROR')), { once: true });
  })));
  await assert.rejects(adapter.generate({ prompt: 'fixture', timeoutMs: 100 }), error => error.code === 'ETIMEDOUT' && !JSON.stringify(error).includes('PRIVATE'));
});

test('unknown token usage stays unknown and explicit zero is preserved', () => {
  assert.equal(normalizeModelUsage('meta', { prompt_tokens: null, completion_tokens: '' }), null);
  assert.deepEqual(normalizeModelUsage('gemini', { promptTokenCount: 0 }), { inputTokens: 0 });
});

test('setup diagnostics validate configuration without exposing keys or claiming a connection', () => {
  const env = { JARVIS_MISSION_PROVIDER: 'meta', JARVIS_MISSION_MODEL: 'muse-spark-1.3', JARVIS_META_API_KEY: 'private-fixture' };
  const good = describeModelProviders(env).find(row => row.selected);
  assert.equal(good.stage, 'configured-unverified');
  assert.equal(good.connectionStatus, 'unverified');
  assert.equal(good.executionAuthorized, false);
  for (const patch of [{ JARVIS_MISSION_MODEL: '../invalid' }, { JARVIS_MISSION_MODEL: 'spark-contributor' },
    { JARVIS_META_API_KEY: 'private\nfixture' }, { JARVIS_MISSION_TIMEOUT_MS: '0' }]) {
    const bad = describeModelProviders({ ...env, ...patch }).find(row => row.selected);
    assert.equal(bad.stage, 'setup-required');
    assert.ok(bad.configurationError);
    assert.doesNotMatch(JSON.stringify(bad), /private-fixture|private\\nfixture|\.\.\/invalid/);
  }
  assert.doesNotMatch(JSON.stringify(good), /private-fixture/);
});

test('DPAPI-backed credential resolver is called per request and its secret never enters receipts', async () => {
  let resolutions = 0;
  let authorization;
  const secret = 'vault-only-fixture-secret';
  const runner = createModelPlanningRunner({ provider: 'meta', model: 'muse-spark-1.3',
    resolveApiKey: async () => { resolutions++; return secret; },
    fetchImpl: async (_url, init) => { authorization = init.headers.Authorization; return Response.json(wire('meta')); } });
  const result = await runner.runWithReceipt('fixture prompt');
  assert.equal(resolutions, 1);
  assert.equal(authorization, `Bearer ${secret}`);
  assert.equal(result.provider, 'meta');
  assert.doesNotMatch(JSON.stringify(result), /vault-only-fixture-secret/);
});

test('credential resolver errors are reduced to safe provider errors without starting a request', async () => {
  let calls = 0;
  const runner = createModelPlanningRunner({ provider: 'xai', model: 'fixture-model', resolveApiKey: async () => {
    throw Object.assign(new Error('vault path and private key'), { code: 'A_INTEGRATION_VAULT_UNREADABLE' });
  }, fetchImpl: async () => { calls++; } });
  await assert.rejects(runner.runWithReceipt('fixture prompt'), error => {
    assert.equal(error.code, 'A_MODEL_TRANSPORT_ERROR');
    assert.doesNotMatch(JSON.stringify(error), /vault path|private key/);
    return true;
  });
  assert.equal(calls, 0);
});

test('invalid explicit environment credentials do not silently fall through to the vault resolver', () => {
  let resolved = false;
  assert.throws(() => createModelProvider({ provider: 'meta', model: 'muse-spark-1.3', apiKey: 'bad\nkey',
    resolveApiKey: async () => { resolved = true; return 'vault-secret'; }, fetchImpl: fetch }), { code: 'A_MODEL_CREDENTIAL_REQUIRED' });
  assert.equal(resolved, false);
});

test('truncated SSE without terminal marker and events after terminal marker are rejected', async () => {
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'text' }, finish_reason: 'stop' }] })}\n\n`;
  for (const [body, code] of [[event, 'A_MODEL_RESPONSE_INCOMPLETE'],
    [event + 'data: [DONE]\n\n' + event, 'A_MODEL_STREAM_INVALID']]) {
    const adapter = createModelProvider(options('xai', async () => new Response(body)));
    await assert.rejects(adapter.generate({ prompt: 'fixture', stream: true }), { code });
  }
});

test('untrusted transport exceptions cannot forge a safe error code to expose credentials', async () => {
  const adapter = createModelProvider(options('meta', async () => {
    throw Object.assign(new Error('fixture-key'), { code: 'A_MODEL_HTTP_ERROR', detail: 'private-body' });
  }));
  await assert.rejects(adapter.generate({ prompt: 'fixture' }), error => {
    assert.equal(error.code, 'A_MODEL_TRANSPORT_ERROR');
    assert.doesNotMatch(JSON.stringify(error), /fixture-key|private-body/);
    return true;
  });
});

test('malformed and oversized responses never return an executable plan', async () => {
  for (const [body, code] of [['not-json', 'A_MODEL_RESPONSE_INVALID'],
    ['x'.repeat(4 * 1024 * 1024 + 1), 'A_MODEL_RESPONSE_TOO_LARGE']]) {
    await assert.rejects(createModelProvider(options('gemini', async () => new Response(body))).generate({ prompt: 'fixture' }), { code });
  }
});

test('local Ollama is selectable through the common Mission runner without a credential or cloud fallback', async () => {
  const calls = [];
  const runner = createModelPlanningRunnerFromEnv({ env: { JARVIS_MISSION_PROVIDER: 'ollama-local',
    JARVIS_MISSION_MODEL: 'gemma3:latest', JARVIS_MISSION_TIMEOUT_MS: '120000' },
    credentialResolver: async () => { throw new Error('local runner must not request credentials'); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? Response.json({ models: [{ name: 'gemma3:latest', digest: 'local-digest', size: 1000 }] })
        : Response.json({ model: 'gemma3:latest', response: JSON.stringify(plan), done: true,
          prompt_eval_count: 50, eval_count: 30, total_duration: 1_000_000 });
    } });
  assert.equal(runner.provider, 'ollama-local');
  const receipt = await runner.runWithReceipt('Plan a read-only local file listing.');
  assert.deepEqual(JSON.parse(receipt.output), plan);
  assert.equal(receipt.externalService, 'loopback-ollama');
  assert.equal(receipt.executionAuthorized, false);
  assert.equal(receipt.costUsd, null);
  assert.equal(receipt.usage.totalTokens, 80);
  assert.deepEqual(calls.map(item => item.url), ['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/generate']);
  const providerRequest = JSON.parse(calls[1].init.body);
  assert.equal(providerRequest.stream, false);
  assert.equal(Object.hasOwn(providerRequest, 'tools'), false);
  assert.equal(calls[1].init.credentials, 'omit');
});

test('local provider diagnostics show unverified readiness without inventing account credentials', () => {
  const row = describeModelProviders({ JARVIS_MISSION_PROVIDER: 'ollama-local', JARVIS_MISSION_MODEL: 'gemma3:latest' })
    .find(item => item.provider === 'ollama-local');
  assert.equal(row.selected, true);
  assert.equal(row.model, 'gemma3:latest');
  assert.equal(row.credentialPresent, false);
  assert.equal(row.connectionStatus, 'unverified');
  assert.equal(row.stage, 'configured-unverified');
  assert.equal(row.nextAction, 'verify-local-model-catalog');
});

test('failed local generation keeps observed calls and tokens in the common receipt',async()=>{
 for(const response of [{response:'{"partial":',done_reason:'length'}, {response:'not-json',done_reason:'stop'}]){
  let calls=0;
  const runner=createModelPlanningRunner({provider:'ollama-local',model:'gemma3:latest',fetchImpl:async()=>{
   calls++;return calls===1?Response.json({models:[{name:'gemma3:latest',size:1000}]}):Response.json({model:'gemma3:latest',done:true,
    prompt_eval_count:250,eval_count:384,...response});
  }});
  await assert.rejects(runner.runWithReceipt('Synthetic probe only.'),error=>{
   assert.deepEqual(error.modelReceipt.usage,{inputTokens:250,outputTokens:384,totalTokens:634});
   assert.equal(error.modelReceipt.providerCalls,2);assert.equal(error.modelReceipt.costUsd,null);
   assert.equal(error.modelReceipt.executionAuthorized,false);assert.equal(Object.hasOwn(error.modelReceipt,'response'),false);
   return true;
  });
 }
});

test('actual planner accounting includes rejected local output without treating the plan as successful',async()=>{
 let calls=0;
 const runner=createModelPlanningRunner({provider:'ollama-local',model:'gemma3:latest',fetchImpl:async()=>{
  calls++;return calls===1?Response.json({models:[{name:'gemma3:latest',size:1000}]}):Response.json({model:'gemma3:latest',done:true,
   response:'{"unfinished":',done_reason:'length',prompt_eval_count:100,eval_count:384});
 }});
 const planner=new GoalExecutivePlanner({runner,maxTransientRetries:0});
 const result=await planner.planNextWave(context());
 assert.equal(result.planning.attempts.length,1);
 assert.notEqual(result.planning.attempts[0].status,'succeeded');
 assert.deepEqual(result.planning.attempts[0].usage,{inputTokens:100,outputTokens:384,totalTokens:484});
 assert.equal(result.planning.costUsd??null,null);
});

test('local failure meters distinguish unknown tokens from zero and never copy provider prose or prices',async()=>{
 const missing=createModelPlanningRunner({provider:'ollama-local',model:'gemma3:latest',fetchImpl:async()=>Response.json({models:[]})});
 await assert.rejects(missing.runWithReceipt('Synthetic probe.'),error=>{
  assert.equal(error.modelReceipt.providerCalls,1);assert.equal(error.modelReceipt.usage,null);
  assert.equal(error.modelReceipt.costUsd,null);return true;
 });
 let calls=0;
 const invalid=createModelPlanningRunner({provider:'ollama-local',model:'gemma3:latest',fetchImpl:async()=>{
  calls++;return calls===1?Response.json({models:[{name:'gemma3:latest',size:1000}]}):Response.json({model:'gemma3:latest',done:true,done_reason:'length',
   response:'PRIVATE_PROVIDER_TEXT',prompt_eval_count:100,eval_count:-1,costUsd:999,credentials:'PRIVATE_PROVIDER_SECRET'});
 }});
 await assert.rejects(invalid.runWithReceipt('Synthetic probe.'),error=>{
  assert.deepEqual(error.modelReceipt.usage,{inputTokens:100});assert.equal(error.modelReceipt.providerCalls,2);
  assert.equal(error.modelReceipt.costUsd,null);assert.equal(JSON.stringify(error.modelReceipt).includes('PRIVATE_PROVIDER'),false);return true;
 });
});

test('lost local generation response still records two observed HTTP calls without inventing tokens',async()=>{
 let calls=0;
 const runner=createModelPlanningRunner({provider:'ollama-local',model:'gemma3:latest',fetchImpl:async()=>{
  calls++;if(calls===1)return Response.json({models:[{name:'gemma3:latest',size:1000}]});
  throw new Error('synthetic connection loss');
 }});
 await assert.rejects(runner.runWithReceipt('Synthetic transport probe.'),error=>{
  assert.equal(error.code,'A_LOCAL_MODEL_TRANSPORT_ERROR');assert.equal(error.modelReceipt.providerCalls,2);
  assert.equal(error.modelReceipt.usage,null);assert.equal(error.modelReceipt.costUsd,null);return true;
 });
});
