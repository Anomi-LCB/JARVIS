import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createAsyncClaudeCliRunner, createOpenAiApiRunner, createAsyncOpenAiApiRunner
} from '../packages/core/src/intent/claude-cli-intent-adapter.js';

const cases = [
  ['missing', undefined, null], ['null', null, null], ['empty', '', null], ['whitespace', ' ', null],
  ['false', false, null], ['true', true, null], ['array', [], null], ['object', {}, null],
  ['nonnumeric', 'unknown', null], ['infinite', 'Infinity', null], ['negative', -1, null],
  ['explicit zero', 0, 0], ['positive number', 12, 12], ['numeric string', '12', 12]
];

function usage(raw) {
  return {
    input_tokens: raw, prompt_tokens: raw, output_tokens: raw, completion_tokens: raw,
    total_tokens: raw, cache_read_input_tokens: raw, cache_creation_input_tokens: raw,
    input_tokens_details: { cached_tokens: raw, cache_write_tokens: raw },
    output_tokens_details: { reasoning_tokens: raw }
  };
}

function cliRunner(raw) {
  return createAsyncClaudeCliRunner({
    apiKey: '', openAiApiKey: '', model: 'fixture-only', shell: false,
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = { end() {
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify({ result: '{"ok":true}', usage: usage(raw), total_cost_usd: raw }));
          child.emit('close', 0);
        });
      } };
      return child;
    }
  });
}

function apiRunner(mode, raw) {
  const body = JSON.stringify({ usage: usage(raw), choices: [{ message: { content: '{"ok":true}' } }] });
  const options = { apiKey: 'synthetic-test-key', openAiModel: 'fixture-only', openAiApi: 'chat-completions' };
  return mode === 'sync'
    ? createOpenAiApiRunner({ ...options, execFileSyncImpl: () => body })
    : createAsyncOpenAiApiRunner({ ...options, fetchImpl: async () => ({ status: 200, text: async () => body }) });
}

for (const mode of ['cli-async', 'api-sync', 'api-async']) {
  for (const [label, raw, expected] of cases) {
    test(`provider usage ${mode}: ${label} remains ${expected === null ? 'unknown' : expected}`, async () => {
      const runner = mode === 'cli-async' ? cliRunner(raw) : apiRunner(mode.slice(4), raw);
      await runner('synthetic usage normalization fixture');
      if (mode === 'cli-async') assert.equal(runner.lastCostUsd, expected);
      assert.deepEqual(runner.lastUsage, expected === null ? null : {
        inputTokens: expected, outputTokens: expected, totalTokens: expected,
        cacheReadTokens: expected, cacheCreationTokens: expected, reasoningTokens: expected
      });
    });
  }
}
