const API_ROOT = 'https://api.openai.com/v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireIdempotencyKey = key => {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/iu.test(key)) fail('A_OPENAI_AGENTS_IDEMPOTENCY_KEY_REQUIRED');
  return key;
};
const isPlainObject = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function validateCreateSession(input) {
  if (!isPlainObject(input) || Object.keys(input).some(key => !['model', 'instructions', 'tools', 'metadata'].includes(key))) {
    fail('A_OPENAI_AGENTS_SESSION_CONFIG_INVALID');
  }
  const { model, instructions, tools = [], metadata = {} } = input;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(model)
    || typeof instructions !== 'string' || !instructions.trim() || instructions.length > 32_000
    || !Array.isArray(tools) || tools.length > 16 || !isPlainObject(metadata)) {
    fail('A_OPENAI_AGENTS_SESSION_CONFIG_INVALID');
  }
  if (Object.keys(metadata).length > 16 || Object.entries(metadata).some(([key, value]) =>
    !key || key.length > 64 || /[\u0000-\u001f]/u.test(key) || typeof value !== 'string' || value.length > 512)) {
    fail('A_OPENAI_AGENTS_SESSION_CONFIG_INVALID');
  }
  const toolNames = new Set();
  const safeTools = tools.map(tool => {
    if (!isPlainObject(tool) || Object.keys(tool).some(key => !['name', 'description', 'parameters'].includes(key))
      || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(tool.name)
      || typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1_000
      || !isPlainObject(tool.parameters) || tool.parameters.type !== 'object'
      || Buffer.byteLength(JSON.stringify(tool.parameters)) > 32_000) {
      fail('A_OPENAI_AGENTS_SESSION_TOOL_INVALID');
    }
    if (toolNames.has(tool.name)) fail('A_OPENAI_AGENTS_SESSION_TOOL_INVALID');
    toolNames.add(tool.name);
    return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters };
  });
  const body = {
    agent: { model, instructions, tools: safeTools },
    environment: { type: 'openai_hosted' },
    stream: false,
    metadata: { ...metadata }
  };
  return body;
}

/** Minimal REST transport for the Agents session operations used by the broker. */
export function createOpenAiAgentsSessionProvider({ apiKey = null, resolveApiKey = null, resolveAccessToken = null,
  fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const credentialSources = Number(apiKey !== null) + Number(typeof resolveApiKey === 'function') + Number(typeof resolveAccessToken === 'function');
  if (credentialSources !== 1
    || apiKey !== null && (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/u.test(apiKey))) fail('A_OPENAI_AGENTS_API_KEY_REQUIRED');
  if (typeof fetchImpl !== 'function') fail('A_OPENAI_AGENTS_FETCH_UNAVAILABLE');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) fail('A_OPENAI_AGENTS_TIMEOUT_INVALID');

  async function request(path, { method = 'GET', body = null, idempotencyKey = null, signal = undefined,
    credentialOperation = 'session.read' } = {}) {
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !/^[a-f0-9]{64}$/iu.test(idempotencyKey))) {
      fail('A_OPENAI_AGENTS_IDEMPOTENCY_KEY_INVALID');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'A_OPENAI_AGENTS_TIMEOUT' })), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const headers = {
      'OpenAI-Beta': 'agents=v1',
      Accept: 'application/json'
    };
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;
    try {
      const bearerToken = apiKey ?? await (resolveAccessToken ?? resolveApiKey)(credentialOperation);
      if (typeof bearerToken !== 'string' || !bearerToken.trim() || /[\r\n]/u.test(bearerToken)) fail('A_OPENAI_AGENTS_API_KEY_REQUIRED');
      headers.Authorization = `Bearer ${bearerToken.trim()}`;
      const response = await fetchImpl(`${API_ROOT}${path}`, {
        method, headers, ...(body === null ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error'
      });
      if (method === 'POST' && response.status === 202) return { accepted: true, status: 202 };
      if (!response.ok) throw Object.assign(new Error('OpenAI Agents API request failed.'), {
        code: 'A_OPENAI_AGENTS_HTTP_ERROR', status: response.status
      });
      try { return await response.json(); }
      catch { fail('A_OPENAI_AGENTS_RESPONSE_INVALID'); }
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('OpenAI Agents API request was interrupted.'), {
        code: signal?.aborted ? 'A_OPENAI_AGENTS_ABORTED' : 'A_OPENAI_AGENTS_TIMEOUT'
      });
      if (error?.code) throw error;
      throw Object.assign(new Error('OpenAI Agents API transport failed.'), { code: 'A_OPENAI_AGENTS_TRANSPORT_ERROR' });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({
    createSession(sessionConfig, { signal, authorizeSessionCreate } = {}) {
      const body = validateCreateSession(sessionConfig);
      if (typeof authorizeSessionCreate !== 'function') fail('A_OPENAI_AGENTS_SESSION_CREATE_AUTHORIZER_REQUIRED');
      return Promise.resolve().then(() => authorizeSessionCreate({
        operation: 'create-agent-session',
        provider: 'openai-agents',
        model: body.agent.model,
        environment: body.environment,
        functionToolNames: body.agent.tools.map(tool => tool.name),
        metadata: body.metadata
      })).catch(() => false).then(authorized => {
        if (authorized !== true) fail('A_OPENAI_AGENTS_SESSION_CREATE_UNAUTHORIZED');
        return request('/agents/sessions', { method: 'POST', body, signal, credentialOperation: 'session.create' });
      }).then(session => {
        if (!isPlainObject(session) || typeof session.id !== 'string' || !session.id.trim()
          || !['idle', 'in_progress', 'requires_action', 'failed'].includes(session.status)) {
          fail('A_OPENAI_AGENTS_SESSION_RESPONSE_INVALID');
        }
        return session;
      });
    },
    retrieveSession(sessionId, { signal } = {}) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) fail('A_OPENAI_AGENTS_SESSION_ID_INVALID');
      return request(`/agents/sessions/${encodeURIComponent(sessionId)}`, { signal, credentialOperation: 'session.read' });
    },
    listSessions({ after = null, agentId = null, limit = 100, order = 'desc', signal } = {}) {
      if (after !== null && (typeof after !== 'string' || !after.trim() || after.length > 1_048_576)
        || agentId !== null && (typeof agentId !== 'string' || !agentId.trim() || agentId.length > 1_048_576)
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['asc', 'desc'].includes(order)) {
        fail('A_OPENAI_AGENTS_SESSION_LIST_QUERY_INVALID');
      }
      const query = new URLSearchParams({ limit: String(limit), order });
      if (after !== null) query.set('after', after);
      if (agentId !== null) query.set('agent_id', agentId);
      return request(`/agents/sessions?${query}`, { signal, credentialOperation: 'session.read' }).then(page => {
        if (!isPlainObject(page) || !Array.isArray(page.data) || typeof page.has_more !== 'boolean'
          || page.data.some(session => !isPlainObject(session) || typeof session.id !== 'string' || !session.id.trim()
            || !['idle', 'in_progress', 'requires_action', 'failed'].includes(session.status)
            || !isPlainObject(session.metadata ?? {}))) {
          fail('A_OPENAI_AGENTS_SESSION_LIST_RESPONSE_INVALID');
        }
        return page;
      });
    },
    submitToolResult(sessionId, event, { idempotencyKey, signal } = {}) {
      requireIdempotencyKey(idempotencyKey);
      if (typeof sessionId !== 'string' || !sessionId.trim()) fail('A_OPENAI_AGENTS_SESSION_ID_INVALID');
      if (!event || Object.keys(event).some(key => !['type', 'turn_id', 'call_id', 'success', 'output', 'error'].includes(key))
        || event.type !== 'agent.session.input.tool_result' || typeof event.turn_id !== 'string' || !event.turn_id.trim()
        || typeof event.call_id !== 'string' || !event.call_id.trim() || typeof event.success !== 'boolean'
        || (event.success && (typeof event.output !== 'string' || event.output.length > 64_000))
        || (!event.success && (typeof event.error !== 'string' || !event.error.trim() || event.error.length > 4_000))
        || !idempotencyKey) {
        fail('A_OPENAI_AGENTS_TOOL_RESULT_INVALID');
      }
      return request(`/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST', body: { events: [event] }, idempotencyKey, signal, credentialOperation: 'session.tool-result'
      });
    },
    submitMessage(sessionId, text, { idempotencyKey, signal } = {}) {
      requireIdempotencyKey(idempotencyKey);
      if (typeof sessionId !== 'string' || !sessionId.trim()) fail('A_OPENAI_AGENTS_SESSION_ID_INVALID');
      if (typeof text !== 'string' || !text.trim() || text.length > 32_000) fail('A_OPENAI_AGENTS_MESSAGE_INVALID');
      return request(`/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        body: { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] },
        idempotencyKey, signal, credentialOperation: 'session.message'
      });
    },
    cancelTurn(sessionId, { idempotencyKey, signal } = {}) {
      requireIdempotencyKey(idempotencyKey);
      if (typeof sessionId !== 'string' || !sessionId.trim()) fail('A_OPENAI_AGENTS_SESSION_ID_INVALID');
      return request(`/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST', body: { events: [{ type: 'agent.session.input.cancel' }] }, idempotencyKey, signal,
        credentialOperation: 'session.cancel'
      });
    }
  });
}
