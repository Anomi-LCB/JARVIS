import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createOpenAiApiRunner,
  createAsyncOpenAiApiRunner,
  createAsyncClaudeCliRunner,
  createClaudeCliRunner,
  createIntentParserFromEnv
} from '../packages/core/src/intent/claude-cli-intent-adapter.js';

const complete = (text = '{"ok":true}', extra = {}) => ({
  id: 'resp-local-test', object: 'response', status: 'completed', model: 'gpt-test-snapshot',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
  ...extra
});

function captureRunner(mode, responses, overrides = {}) {
  const requests = [];
  const next = () => responses[Math.min(requests.length - 1, responses.length - 1)];
  const options = {
    apiKey: 'sk-local-fake-only', openAiModel: 'gpt-test', openAiApi: 'responses', ...overrides
  };
  const runner = mode === 'sync' ? createOpenAiApiRunner({
    ...options,
    execFileSyncImpl: (file, args, config) => {
      const line = config.input.split('\n').find((value) => value.startsWith('data = '));
      const payload = JSON.parse(JSON.parse(line.slice(7)));
      requests.push({ file, args, config, payload });
      return JSON.stringify(next()) + (options.openAiApi === 'responses' ? '\nJARVIS_HTTP_STATUS:200' : '');
    }
  }) : createAsyncOpenAiApiRunner({
    ...options,
    fetchImpl: async (url, config) => {
      requests.push({ url, config, payload: JSON.parse(config.body) });
      return { status: 200, text: async () => JSON.stringify(next()) };
    }
  });
  return { runner, requests };
}

for (const mode of ['sync', 'async']) {
  test(`Responses ${mode}: request contract, typed output and usage are preserved`, async () => {
    const { runner, requests } = captureRunner(mode, [complete('', {
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'not output JSON' }] },
        { type: 'message', role: 'assistant', status: 'completed', content: [
          { type: 'output_text', text: '{"ok":' }, { type: 'output_text', text: 'true}' }
        ] }
      ],
      usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 } }
    })], { maxTokens: 321, timeoutMs: 4321 });
    assert.equal(await runner('한글 JSON 요청'), '{"ok":true}');
    assert.deepEqual(requests[0].payload, {
      model: 'gpt-test', input: [{ role: 'user', content: '한글 JSON 요청' }],
      max_output_tokens: 321, store: false, text: { format: { type: 'json_object' } }, reasoning: { effort: 'none' }
    });
    if (mode === 'sync') {
      assert.deepEqual(requests[0].args, ['--config', '-']);
      assert.doesNotMatch(JSON.stringify(requests[0].args), /sk-local/);
      assert.equal(requests[0].config.timeout, 4321);
      assert.match(requests[0].config.input, /https:\/\/api.openai.com\/v1\/responses/);
    } else assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(runner.api, 'responses');
    assert.equal(runner.lastApi, 'responses');
    assert.equal(runner.lastModel, 'gpt-test-snapshot');
    assert.deepEqual(runner.lastUsage, {
      inputTokens: 20, outputTokens: 7, totalTokens: 27, cacheReadTokens: 5, cacheCreationTokens: 3, reasoningTokens: 2
    });
  });

  test(`Responses ${mode}: unsupported reasoning retries once without weakening JSON or storage`, async () => {
    const { runner, requests } = captureRunner(mode, [
      { error: { code: 'unsupported_value', param: 'reasoning.effort', message: "Unsupported value: reasoning.effort 'none'" } },
      complete()
    ]);
    assert.equal(await runner('JSON'), '{"ok":true}');
    assert.equal(requests.length, 2);
    assert.equal('reasoning' in requests[1].payload, false);
    assert.deepEqual(requests[1].payload.text, { format: { type: 'json_object' } });
    assert.equal(requests[1].payload.store, false);
  });

  for (const detail of [
    { param: 'text.format', message: 'Unsupported parameter: text.format' },
    { param: 'store', message: 'Unsupported parameter: store' },
    { param: 'max_output_tokens', message: 'Unsupported parameter: max_output_tokens for this reasoning model' },
    { message: 'Unknown parameter in request' }
  ]) {
    test(`Responses ${mode}: does not weaken request for ${detail.param ?? 'unknown'} errors`, async () => {
      const { runner, requests } = captureRunner(mode, [{ error: detail }, complete()]);
      await assert.rejects(async () => runner('JSON'), /openai:/);
      assert.equal(requests.length, 1);
    });
  }

  test(`Responses ${mode}: preserves configured model access fallback`, async () => {
    const { runner, requests } = captureRunner(mode, [
      { error: { code: 'model_not_found', message: 'The model is not available' } }, complete()
    ], { openAiModel: null, model: 'sonnet' });
    assert.equal(await runner('JSON'), '{"ok":true}');
    assert.deepEqual(requests.map((request) => request.payload.model), ['gpt-5.6-terra', 'gpt-5.4']);
    assert.equal(runner.lastModel, 'gpt-test-snapshot');
  });

  test(`Responses ${mode}: rejects nonfinal, refused and tool outputs even when text exists`, async () => {
    const cases = [
      ...['incomplete', 'in_progress', 'queued', 'failed', 'cancelled', undefined].map((status) => complete('{"ok":true}', { status })),
      complete('{"ok":true}', { error: { code: 'server_error', message: 'provider failed' } }),
      complete('', { output_text: '{"ok":true}', output: [] }),
      complete('', { output: [{ type: 'function_call', name: 'send_email', arguments: '{}' }] }),
      complete('', { output: [complete().output[0], { type: 'mcp_approval_request', id: 'approval' }] }),
      complete('', { output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }),
      complete('', { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: '{"ok":true}' }, { type: 'refusal', refusal: 'Refused' }
      ] }] })
    ];
    for (const response of cases) {
      const { runner, requests } = captureRunner(mode, [response]);
      await assert.rejects(async () => runner('JSON'), /openai/);
      assert.equal(requests.length, 1);
      assert.equal(runner.lastUsage, null);
    }
  });

  test(`OpenAI ${mode}: explicit legacy API preserves the existing payload`, async () => {
    const { runner, requests } = captureRunner(mode, [{ choices: [{ message: { content: '{"ok":true}' } }] }], { openAiApi: 'chat-completions' });
    assert.equal(await runner('JSON'), '{"ok":true}');
    assert.equal(requests[0].payload.messages[0].content, 'JSON');
    assert.deepEqual(requests[0].payload.response_format, { type: 'json_object' });
    assert.equal('input' in requests[0].payload, false);
    assert.equal(runner.api, 'chat-completions');
  });
}

test('API selection honors task env over ambient env and rejects unsupported values', () => {
  const original = process.env.JARVIS_OPENAI_API;
  process.env.JARVIS_OPENAI_API = 'responses';
  try {
    const parser = createIntentParserFromEnv({ env: { JARVIS_LLM_INTENT: '1', JARVIS_OPENAI_API_KEY: 'fake-key' } });
    assert.equal(parser.externalAdapter.runner.api, 'chat-completions');
    const selected = createIntentParserFromEnv({ env: { JARVIS_LLM_INTENT: '1', JARVIS_OPENAI_API_KEY: 'fake-key', JARVIS_OPENAI_API: 'responses' } });
    assert.equal(selected.externalAdapter.runner.api, 'responses');
    assert.equal(createOpenAiApiRunner({ apiKey: 'fake-key' }).api, 'responses');
    for (const factory of [createOpenAiApiRunner, createAsyncOpenAiApiRunner, createClaudeCliRunner, createAsyncClaudeCliRunner]) {
      assert.throws(() => factory({ apiKey: '', openAiApiKey: '', openAiApi: 'typo' }), /unsupported API mode/);
    }
    delete process.env.JARVIS_OPENAI_API;
    assert.equal(createOpenAiApiRunner({ apiKey: 'fake-key' }).api, 'chat-completions');
  } finally {
    if (original === undefined) delete process.env.JARVIS_OPENAI_API;
    else process.env.JARVIS_OPENAI_API = original;
  }
});

test('Responses async supports caller cancellation and bounded timeout without CLI fallback', async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls += 1;
    return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const runner = createAsyncClaudeCliRunner({
    apiKey: '', openAiApiKey: 'fake-key', openAiModel: 'gpt-test', openAiApi: 'responses', timeoutMs: 1000,
    fetchImpl, spawnImpl: () => { throw new Error('must not run fallback on abort'); }
  });
  const before = new AbortController(); before.abort();
  await assert.rejects(runner('JSON', { signal: before.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = runner('JSON', { signal: during.signal }); during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(runner('JSON', { timeoutMs: 20 }), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('Responses async rejects HTTP failure even when its body resembles a completion', async () => {
  const runner = createAsyncOpenAiApiRunner({
    apiKey: 'fake-key', openAiApi: 'responses',
    fetchImpl: async () => ({ status: 503, text: async () => JSON.stringify(complete()) })
  });
  await assert.rejects(runner('JSON'), /HTTP 503/);
});

test('Responses sync checks HTTP status without hiding structured model errors', () => {
  const base = { apiKey: 'fake-key', openAiApi: 'responses', openAiModel: 'gpt-test' };
  const unavailable = createOpenAiApiRunner({
    ...base, execFileSyncImpl: () => `${JSON.stringify(complete())}\nJARVIS_HTTP_STATUS:503`
  });
  assert.throws(() => unavailable('JSON'), /HTTP 503/);
  let calls = 0;
  const fallback = createOpenAiApiRunner({
    ...base, fallbackModels: ['gpt-fallback'], execFileSyncImpl: () => ++calls === 1
      ? `${JSON.stringify({ error: { code: 'model_not_found', message: 'Model not available' } })}\nJARVIS_HTTP_STATUS:404`
      : `${JSON.stringify(complete())}\nJARVIS_HTTP_STATUS:200`
  });
  assert.equal(fallback('JSON'), '{"ok":true}');
  assert.equal(calls, 2);
});

test('Responses sync and async perform equivalent actual local HTTP requests', async () => {
  // A separate local process is required because synchronous curl blocks this
  // test process. No production credentials or external network are involved.
  const stub = `
    import { createServer } from 'node:http';
    let count = 0;
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = { method: req.method, url: req.url, authorization: req.headers.authorization, payload: JSON.parse(body) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', model: 'gpt-local', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(request) }] }] }));
      if (++count === 2) server.close();
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
  `;
  const server = spawn(process.execPath, ['--input-type=module', '-e', stub], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const exit = once(server, 'exit');
  try {
    const [chunk] = await once(server.stdout, 'data');
    const port = Number(String(chunk));
    assert.ok(port > 0);
    const options = { apiKey: 'sk-local-only', openAiApi: 'responses', openAiModel: 'gpt-test', timeoutMs: 5000, endpoint: `http://127.0.0.1:${port}/v1/responses` };
    const prompt = '한글 JSON "따옴표"\n두 번째 줄';
    const sync = JSON.parse(createOpenAiApiRunner(options)(prompt));
    const asyncResult = JSON.parse(await createAsyncOpenAiApiRunner(options)(prompt));
    assert.deepEqual(sync, asyncResult);
    assert.equal(sync.url, '/v1/responses');
    assert.equal(sync.method, 'POST');
    assert.equal(sync.authorization, 'Bearer sk-local-only');
    assert.equal(sync.payload.input[0].content, prompt);
    assert.equal(sync.payload.store, false);
    assert.equal((await exit)[0], 0);
  } finally {
    if (server.exitCode === null) server.kill();
  }
});
