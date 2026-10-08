import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAiAgentsSessionProvider } from '../packages/core/src/mission/openai-agents-api-provider.js';

const key = 'test-secret-never-transmit';

test('creates an authorized empty hosted session with only application-handled function tools', async () => {
  let call;
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async (url, options) => {
    call = { url, options };
    return Response.json({ id: 'session-created-1', status: 'requires_action', required_actions: [] }, { status: 201 });
  } });
  const session = await provider.createSession({
    model: 'gpt-6-sol',
    instructions: 'JARVIS가 제공한 함수만 요청하고, 자체 권한으로 행동하지 않는다.',
    tools: [{ name: 'read_local_item', description: 'Read one allowed local item.', parameters: {
      type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'], additionalProperties: false
    } }],
    metadata: { workerRole: 'researcher' }
  }, { authorizeSessionCreate: async request => request.operation === 'create-agent-session'
    && request.provider === 'openai-agents' && request.model === 'gpt-6-sol'
    && request.environment.type === 'openai_hosted'
    && request.functionToolNames[0] === 'read_local_item' });
  assert.equal(session.id, 'session-created-1');
  assert.equal(call.url, 'https://api.openai.com/v1/agents/sessions');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, `Bearer ${key}`);
  const body = JSON.parse(call.options.body);
  assert.deepEqual(body.environment, { type: 'openai_hosted' });
  assert.equal('input' in body, false, 'empty provisioning cannot start a remote task before Mission binding');
  assert.equal(body.stream, false);
  assert.deepEqual(body.agent.tools, [{ type: 'function', name: 'read_local_item',
    description: 'Read one allowed local item.', parameters: {
      type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'], additionalProperties: false
    } }]);
  assert.equal(body.agent.multi_agent, undefined);
  assert.equal(JSON.stringify(body).includes(key), false);
});

test('session creation rejects caller-supplied environment, initial task input, built-in tools, and malformed config before network use', async () => {
  let calls = 0;
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async () => {
    calls++;
    return Response.json({ id: 'session-created-2', status: 'idle' }, { status: 201 });
  } });
  const config = { model: 'gpt-6-sol', instructions: 'Use supplied functions only.' };
  assert.throws(() => provider.createSession({ ...config, environment: { type: 'openai_hosted' } }),
    { code: 'A_OPENAI_AGENTS_SESSION_CONFIG_INVALID' });
  assert.throws(() => provider.createSession({ ...config, input: 'Start reading now.' }),
    { code: 'A_OPENAI_AGENTS_SESSION_CONFIG_INVALID' });
  assert.throws(() => provider.createSession({ ...config, tools: [{ type: 'web_search' }] }),
    { code: 'A_OPENAI_AGENTS_SESSION_TOOL_INVALID' });
  assert.throws(() => provider.createSession({ ...config, stream: true }),
    { code: 'A_OPENAI_AGENTS_SESSION_CONFIG_INVALID' });
  assert.throws(() => provider.createSession({ ...config, tools: [{ name: 'read', description: 'Read', parameters: { type: 'array' } }] }),
    { code: 'A_OPENAI_AGENTS_SESSION_TOOL_INVALID' });
  assert.equal(calls, 0);
});

test('session creation requires a positive resource authorization decision before provisioning a remote environment', async () => {
  let calls = 0;
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async () => {
    calls++;
    return Response.json({ id: 'session-created-3', status: 'idle' }, { status: 201 });
  } });
  const config = { model: 'gpt-6-sol', instructions: 'Use supplied functions only.' };
  assert.throws(() => provider.createSession(config), { code: 'A_OPENAI_AGENTS_SESSION_CREATE_AUTHORIZER_REQUIRED' });
  await assert.rejects(provider.createSession(config, { authorizeSessionCreate: async request => {
    assert.equal('input' in request, false);
    assert.equal(request.environment.type, 'openai_hosted');
    return false;
  } }), { code: 'A_OPENAI_AGENTS_SESSION_CREATE_UNAUTHORIZED' });
  await assert.rejects(provider.createSession(config, { authorizeSessionCreate: async () => { throw new Error(key); } }),
    { code: 'A_OPENAI_AGENTS_SESSION_CREATE_UNAUTHORIZED' });
  assert.equal(calls, 0);
});

test('session creation rejects incomplete provider responses instead of creating an unusable binding', async () => {
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async () => Response.json({ id: 'missing-status' }) });
  await assert.rejects(provider.createSession({ model: 'gpt-6-sol', instructions: 'Only use supplied functions.' }, {
    authorizeSessionCreate: async () => true
  }), { code: 'A_OPENAI_AGENTS_SESSION_RESPONSE_INVALID' });
});

test('Agents provider retrieves session using the official beta route and does not send a request on construction', async () => {
  const calls = [];
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: 'sess/1', required_actions: [], status: 'idle' });
  } });
  assert.equal(calls.length, 0);
  const session = await provider.retrieveSession('sess/1');
  assert.equal(session.id, 'sess/1');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/agents/sessions/sess%2F1');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  assert.equal(calls[0].options.headers['OpenAI-Beta'], 'agents=v1');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.stringify(calls[0]).includes('input'), false);
});

test('session listing uses bounded ID pagination and validates its response shape', async () => {
  let call;
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async (url, options) => {
    call = { url, options };
    return Response.json({ data: [{ id: 'sess-2', status: 'idle', metadata: { jarvisProvisioningId: 'opaque-id' } }], has_more: true });
  } });
  const page = await provider.listSessions({ after: 'sess 1', agentId: 'agent-1', limit: 10, order: 'asc' });
  const url = new URL(call.url);
  assert.equal(url.pathname, '/v1/agents/sessions');
  assert.equal(url.searchParams.get('after'), 'sess 1');
  assert.equal(url.searchParams.get('agent_id'), 'agent-1');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('order'), 'asc');
  assert.equal(page.data[0].metadata.jarvisProvisioningId, 'opaque-id');
  assert.equal(page.has_more, true);
  assert.equal(call.options.method, 'GET');
});

test('session listing rejects invalid pagination and malformed provider pages', async () => {
  let calls = 0;
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async () => {
    calls++;
    return Response.json({ data: [{ id: 'missing-status' }], has_more: false });
  } });
  assert.throws(() => provider.listSessions({ limit: 101 }), { code: 'A_OPENAI_AGENTS_SESSION_LIST_QUERY_INVALID' });
  await assert.rejects(provider.listSessions(), { code: 'A_OPENAI_AGENTS_SESSION_LIST_RESPONSE_INVALID' });
  assert.equal(calls, 1);
});

test('tool-result uses required event schema, one stable idempotency header, and treats 202 as acceptance only', async () => {
  let call;
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async (url, options) => {
    call = { url, options };
    return new Response(null, { status: 202 });
  } });
  const idempotencyKey = 'a'.repeat(64);
  const result = await provider.submitToolResult('sess-2', {
    type: 'agent.session.input.tool_result', turn_id: 'turn-2', call_id: 'call-2', success: true, output: '{"ok":true}'
  }, { idempotencyKey });
  assert.deepEqual(result, { accepted: true, status: 202 });
  assert.equal(call.url, 'https://api.openai.com/v1/agents/sessions/sess-2/events');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Idempotency-Key'], idempotencyKey);
  assert.deepEqual(JSON.parse(call.options.body), { events: [{
    type: 'agent.session.input.tool_result', turn_id: 'turn-2', call_id: 'call-2', success: true, output: '{"ok":true}'
  }] });
});

test('provider supports idempotent session message and turn-cancel input events', async () => {
  const calls = [];
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(null, { status: 202 });
  } });
  const messageKey = 'c'.repeat(64), cancelKey = 'd'.repeat(64);
  const message = await provider.submitMessage('sess-3', '이번 턴은 읽기만 하고 파일은 수정하지 마.', { idempotencyKey: messageKey });
  const cancel = await provider.cancelTurn('sess-3', { idempotencyKey: cancelKey });
  assert.deepEqual(message, { accepted: true, status: 202 });
  assert.deepEqual(cancel, { accepted: true, status: 202 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['Idempotency-Key'], messageKey);
  assert.deepEqual(JSON.parse(calls[0].options.body), { events: [{
    type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: '이번 턴은 읽기만 하고 파일은 수정하지 마.' }] }]
  }] });
  assert.equal(calls[1].options.headers['Idempotency-Key'], cancelKey);
  assert.deepEqual(JSON.parse(calls[1].options.body), { events: [{ type: 'agent.session.input.cancel' }] });
});

test('provider resolves a narrowly scoped vault credential immediately before each API request', async () => {
  const resolved = [], headers = [];
  const provider = createOpenAiAgentsSessionProvider({ resolveApiKey: async operation => {
    resolved.push(operation);
    return `scoped-key-${operation}`;
  }, fetchImpl: async (_url, options) => {
    headers.push(options.headers.Authorization);
    if (options.method === 'POST' && options.body?.includes('"agent"')) {
      return Response.json({ id: 'session-scoped-key', status: 'idle' }, { status: 201 });
    }
    return Response.json({ id: 'session-scoped-key', status: 'idle' });
  } });
  assert.deepEqual(resolved, [], 'provider construction must not retrieve credentials');
  await provider.createSession({ model: 'gpt-6-sol', instructions: 'Use only supplied functions.' }, {
    authorizeSessionCreate: async () => true
  });
  await provider.retrieveSession('session-scoped-key');
  assert.deepEqual(resolved, ['session.create', 'session.read']);
  assert.deepEqual(headers, ['Bearer scoped-key-session.create', 'Bearer scoped-key-session.read']);
});

test('provider rejects malformed credentials and tool events before network use', async () => {
  assert.throws(() => createOpenAiAgentsSessionProvider({ apiKey: 'bad\nheader' }), { code: 'A_OPENAI_AGENTS_API_KEY_REQUIRED' });
  let calls = 0;
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async () => { calls++; return Response.json({}); } });
  assert.throws(() => provider.cancelTurn('sess'), { code: 'A_OPENAI_AGENTS_IDEMPOTENCY_KEY_REQUIRED' });
  assert.throws(() => provider.submitToolResult('sess', { type: 'agent.session.input.tool_result', turn_id: 't', call_id: 'c', success: true,
    output: 'x', authorization: key }, { idempotencyKey: 'b'.repeat(64) }), { code: 'A_OPENAI_AGENTS_TOOL_RESULT_INVALID' });
  assert.equal(calls, 0);
});

test('provider surfaces HTTP status without exposing API key or remote response body', async () => {
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, fetchImpl: async () => new Response(`echo ${key}`, { status: 403 }) });
  await assert.rejects(provider.retrieveSession('sess'), error => {
    assert.equal(error.code, 'A_OPENAI_AGENTS_HTTP_ERROR');
    assert.equal(error.status, 403);
    assert.equal(error.message.includes(key), false);
    return true;
  });
});

test('provider timeout cancels the transport and exposes only a stable safe error code', async () => {
  const provider = createOpenAiAgentsSessionProvider({ apiKey: key, timeoutMs: 100, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(provider.retrieveSession('sess'), { code: 'A_OPENAI_AGENTS_TIMEOUT' });
});
