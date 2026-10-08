import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaLocalModelProvider } from '../packages/core/src/mission/ollama-local-model-provider.js';

const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const catalog = models => Response.json({ models });
const local = { name: 'gemma3:latest', digest: 'sha256:local', size: 1000 };

test('Ollama adapter uses only fixed loopback, verifies local model, and returns structured output with unmeasured cost', async () => {
  const calls = [];
  const provider = createOllamaLocalModelProvider({ model: 'gemma3:latest', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? catalog([local]) : Response.json({ model: 'gemma3:latest', response: '{"summary":"핵심 요약"}', done: true,
      prompt_eval_count: 40, eval_count: 12, total_duration: 1_000_000 });
  } });
  const result = await provider.generateStructured({ prompt: 'public source as data', schema, validate: value => value.summary === '핵심 요약' });
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/generate']);
  assert.ok(calls.every(call => call.init.redirect === 'error'));
  assert.ok(calls.every(call => call.init.credentials === 'omit' && call.init.cache === 'no-store'));
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.stream, false);
  assert.deepEqual(body.format, schema);
  assert.equal(Object.hasOwn(body, 'tools'), false);
  assert.equal(result.output.summary, '핵심 요약');
  assert.equal(result.runtimeTiming.totalMs,1);assert.equal(result.runtimeTiming.loadMs,null);assert.equal(result.runtimeTiming.outputTokensPerSecond,null);
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 12, totalTokens: 52 });
  assert.equal(result.costUsd, null);
  assert.equal(result.costMeasurement, 'unmeasured');
  assert.equal(result.executionAuthorized, false);
});

test('Ollama adapter rejects cloud-backed tags and does not generate', async () => {
  let calls = 0;
  const provider = createOllamaLocalModelProvider({ model: 'kimi-k2.6:cloud', fetchImpl: async () => {
    calls += 1; return catalog([{ name: 'kimi-k2.6:cloud', remote_model: 'kimi-k2.6', remote_host: 'https://ollama.com', size: 384 }]);
  } });
  await assert.rejects(provider.generateStructured({ prompt: 'private text', schema }), { code: 'A_LOCAL_MODEL_REMOTE_REJECTED' });
  assert.equal(calls, 1);
});

test('Ollama adapter rejects missing model, untrusted endpoint overrides, and invalid structured output', async () => {
  assert.throws(() => createOllamaLocalModelProvider({ model: 'https://example.com' }), { code: 'A_LOCAL_MODEL_ID_REQUIRED' });
  const missing = createOllamaLocalModelProvider({ model: 'absent:latest', fetchImpl: async () => catalog([]) });
  await assert.rejects(missing.generateStructured({ prompt: 'x', schema }), { code: 'A_LOCAL_MODEL_NOT_INSTALLED' });
  let calls = 0;
  const invalid = createOllamaLocalModelProvider({ model: 'gemma3:latest', fetchImpl: async () => {
    calls += 1; return calls === 1 ? catalog([local]) : Response.json({ model: 'gemma3:latest', response: 'not json', done: true });
  } });
  await assert.rejects(invalid.generateStructured({ prompt: 'x', schema }), { code: 'A_LOCAL_MODEL_OUTPUT_INVALID' });
});

test('Ollama adapter rejects schema validator failures and unexpected model identity', async () => {
  let calls = 0;
  const bad = createOllamaLocalModelProvider({ model: 'gemma3:latest', fetchImpl: async () => {
    calls += 1; return calls === 1 ? catalog([local]) : Response.json({ model: 'another:latest', response: '{"summary":"x"}', done: true });
  } });
  await assert.rejects(bad.generateStructured({ prompt: 'x', schema }), { code: 'A_LOCAL_MODEL_RESPONSE_INCOMPLETE' });
});

test('Ollama adapter rejects a model response cut off by its generation limit', async () => {
  let calls = 0;
  const limited = createOllamaLocalModelProvider({ model: 'gemma3:latest', fetchImpl: async () => {
    calls += 1; return calls === 1 ? catalog([local]) : Response.json({ model: 'gemma3:latest', response: '{"summary":"partial', done: true, done_reason: 'length' });
  } });
  await assert.rejects(limited.generateStructured({ prompt: 'x', schema }), { code: 'A_LOCAL_MODEL_RESPONSE_INCOMPLETE' });
});
