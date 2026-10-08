import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalCredentialHandoffAvailable, storeModelProviderApiKey } from '../src/ui/model-provider-credential-setup.js';

test('provider key handoff accepts only the actual loopback Core target, including hosted local proxy mode', () => {
  assert.equal(isLocalCredentialHandoffAvailable({ coreBaseUrl: '/api/core', origin: 'http://127.0.0.1:41730' }), true);
  assert.equal(isLocalCredentialHandoffAvailable({ coreBaseUrl: 'http://localhost:7080', origin: 'https://jarvis.example' }), true);
  assert.equal(isLocalCredentialHandoffAvailable({ coreBaseUrl: 'https://remote.example/api/core', origin: 'http://127.0.0.1:41730' }), false);
  assert.equal(isLocalCredentialHandoffAvailable({ hosted: true, localApiBaseUrl: 'http://127.0.0.1:41730', coreBaseUrl: 'http://127.0.0.1:41730/api/core' }), true);
  assert.equal(isLocalCredentialHandoffAvailable({ hosted: true, localApiBaseUrl: 'http://127.0.0.1:41730', coreBaseUrl: 'https://remote.example/api/core' }), false);
  assert.equal(isLocalCredentialHandoffAvailable({ hosted: true, localApiBaseUrl: 'http://127.0.0.1:41730', coreBaseUrl: '/api/core' }), false);
});

test('provider key setup uses a one-use connector-and-scope ticket and returns only unverified status', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options: { ...options, body: options.body === undefined ? undefined : structuredClone(options.body) } });
    if (path === '/integrations/handoffs') return { handoffId: 'handoff-1', ticket: 'one-use-ticket' };
    return { connection: { connectionId: 'connection-1', connectorId: 'jarvis-model-meta', status: 'credentials-stored-unverified' }, providerVerified: false, executionAuthorized: false };
  };
  const result = await storeModelProviderApiKey({ provider: 'meta', apiKey: 'meta-secret', adminToken: 'admin-token', request });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/integrations/handoffs');
  assert.equal(calls[0].options.token, 'admin-token');
  assert.deepEqual(calls[0].options.body, { connectorId: 'jarvis-model-meta', authMethod: 'api-key', scopes: ['model.plan'], ttlMs: 60_000 });
  assert.equal(calls[1].path, '/integrations/handoffs/handoff-1/complete');
  assert.equal(calls[1].options.token, 'one-use-ticket');
  assert.deepEqual(calls[1].options.body, { providerAccountId: 'jarvis-local-primary', label: 'JARVIS 로컬 기본 키', credentials: { apiKey: 'meta-secret' } });
  assert.deepEqual(result, { connection: { connectionId: 'connection-1', connectorId: 'jarvis-model-meta', status: 'credentials-stored-unverified' }, providerVerified: false, executionAuthorized: false });
});

test('OpenAI Agents credential handoff grants only provider catalog verification, never session or message scopes', async () => {
  const calls = [];
  await storeModelProviderApiKey({ provider: 'openai-agents', apiKey: 'openai-key', adminToken: 'admin-token', request: async (path, options) => {
    calls.push({ path, options: { ...options, body: options.body === undefined ? undefined : structuredClone(options.body) } });
    return path === '/integrations/handoffs' ? { handoffId: 'h', ticket: 't' }
      : { connection: { connectionId: 'c' }, providerVerified: false, executionAuthorized: false };
  } });
  assert.deepEqual(calls[0].options.body.scopes, ['agents.provider.verify']);
  assert.doesNotMatch(JSON.stringify(calls[0].options.body.scopes), /session|message|tool-result/);
});

test('provider key setup cancels an incomplete ticket and marks a lost completion response as uncertain without exposing key or body', async () => {
  const calls = [];
  await assert.rejects(storeModelProviderApiKey({ provider: 'xai', apiKey: 'private-xai-key', adminToken: 'admin-token', request: async (path, options) => {
    calls.push({ path, options: { ...options, body: options.body === undefined ? undefined : structuredClone(options.body) } });
    if (path === '/integrations/handoffs') return { handoffId: 'h', ticket: 'ticket' };
    if (path.endsWith('/complete')) throw new Error('private-xai-key HTTP body includes secret');
    return { cancelled: true };
  } }), error => {
    assert.equal(error.setupCode, 'save-outcome-unknown');
    assert.doesNotMatch(error.message, /private-xai-key|HTTP body/);
    return true;
  });
  assert.equal(calls.at(-1).path, '/integrations/handoffs/h');
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(calls.at(-1).options.token, 'admin-token');
});

test('invalid, unsupported or unconfigured setup is rejected before network use', async () => {
  let calls = 0;
  const request = async () => { calls += 1; };
  for (const input of [
    { provider: 'unknown', apiKey: 'key', adminToken: 'admin-token' },
    { provider: 'xai', apiKey: ' ', adminToken: 'admin-token' },
    { provider: 'xai', apiKey: ' key', adminToken: 'admin-token' },
    { provider: 'xai', apiKey: 'key', adminToken: '' }
  ]) {
    await assert.rejects(storeModelProviderApiKey({ ...input, request }));
  }
  assert.equal(calls, 0);
});
