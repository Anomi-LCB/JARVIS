import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcAgentApiGuardFromEnv } from '../apps/pc-agent/src/main.mjs';

test('PC Agent API guard uses the supplied runtime environment instead of process globals', () => {
  const guard = createPcAgentApiGuardFromEnv({
    JARVIS_TEST_MODE: '1',
    JARVIS_PC_AGENT_API_TOKEN: 'isolated-smoke-token',
    JARVIS_PC_AGENT_API_TOKEN_SHA256: '',
    JARVIS_PC_AGENT_API_TOKEN_STORE: ''
  });

  assert.equal(guard.tokenStore.verify('isolated-smoke-token'), true);
  assert.equal(guard.tokenStore.verify('local-pc-agent-api'), false);
  assert.equal(guard.status().tokenStore.hashConfigured, true);
});

test('PC Agent API guard keeps production auth disabled when an explicit environment has no token', () => {
  const guard = createPcAgentApiGuardFromEnv({ JARVIS_TEST_MODE: '0' });

  assert.equal(guard.status().tokenStore.hashConfigured, false);
  assert.equal(guard.tokenStore.verify('local-pc-agent-api'), false);
});
