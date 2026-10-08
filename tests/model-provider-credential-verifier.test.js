import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelProviderCredentialVerifier } from '../packages/core/src/mission/model-provider-credential-verifier.js';

const definitions = [
  { provider: 'openai-agents', url: 'https://api.openai.com/v1/models', header: 'authorization', response: { data: [{ id: 'gpt-6-sol' }, { id: 'gpt-6-luna' }] } },
  { provider: 'xai', url: 'https://api.x.ai/v1/models', header: 'authorization', response: { data: [{ id: 'xai-model-a' }, { id: 'xai-model-b' }] } },
  { provider: 'meta', url: 'https://api.meta.ai/v1/models', header: 'authorization', response: { data: [{ id: 'meta-model-a' }] } },
  { provider: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', header: 'x-goog-api-key', response: { models: [{ name: 'models/gemini-model-a', baseModelId: 'gemini-model-a' }] } },
  { provider: 'gemini-interactions', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', header: 'x-goog-api-key', response: { models: [{ name: 'models/gemini-model-a', baseModelId: 'gemini-model-a' }] } }
];

function makeVault({ providers = ['openai-agents', 'xai', 'meta', 'gemini'] } = {}) {
  const records = providers.map((provider, index) => ({ connectionId: `connection-${index + 1}`,
    connectorId: provider === 'openai-agents' ? 'jarvis-openai-agents' : provider.startsWith('gemini') ? 'jarvis-model-gemini' : `jarvis-model-${provider}`, authMethod: 'api-key', status: 'credentials-stored-unverified',
    scopes: [provider === 'openai-agents' ? 'agents.provider.verify' : 'model.plan'], updatedAt: '2026-09-28T00:00:00.000Z', credentials: { apiKey: `synthetic-${provider}-key` } }));
  const verifications = [];
  return {
    records, verifications,
    list: () => records.map(({ credentials, ...metadata }) => metadata),
    withCredentials: (connectionId, callback) => {
      const record = records.find(item => item.connectionId === connectionId);
      return callback(record?.credentials ?? {}, { updatedAt: record?.updatedAt });
    },
    recordProviderVerification: (connectionId, result, { expectedUpdatedAt } = {}) => {
      const record = records.find(item => item.connectionId === connectionId);
      if (expectedUpdatedAt !== record?.updatedAt) throw Object.assign(new Error('A_MODEL_PROVIDER_VERIFICATION_STALE'), { code: 'A_MODEL_PROVIDER_VERIFICATION_STALE' });
      verifications.push({ connectionId, result });
      record.status = result.providerVerified ? 'credentials-stored-provider-verified' : 'credentials-stored-unverified';
      record.updatedAt = new Date(Date.parse(record.updatedAt) + 1).toISOString();
      return { connectionId };
    }
  };
}

test('verifies OpenAI Agents, xAI, Meta and Gemini through fixed read-only catalog endpoints and never returns credentials', async () => {
  for (const item of definitions) {
    const vault = makeVault({ providers: [item.provider] });
    const requests = [];
    const verifier = createModelProviderCredentialVerifier({ vault, clock: () => new Date('2026-09-28T00:00:00.000Z'),
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(item.response), { status: 200, headers: { 'content-type': 'application/json' } });
      } });
    const modelId = item.provider.startsWith('gemini') ? 'gemini-model-a' : item.provider === 'openai-agents' ? 'gpt-6-sol' : `${item.provider}-model-a`;
    const result = await verifier.verify({ provider: item.provider, modelId });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, item.url);
    assert.equal(requests[0].init.method, 'GET');
    assert.equal(requests[0].init.redirect, 'error');
    assert.equal(requests[0].init.cache, 'no-store');
    assert.equal(requests[0].init.body, undefined);
    if (item.header === 'authorization') assert.equal(requests[0].init.headers.Authorization, `Bearer synthetic-${item.provider}-key`);
    else assert.equal(requests[0].init.headers['x-goog-api-key'], `synthetic-${item.provider}-key`);
    assert.equal(result.providerVerified, true);
    assert.equal(result.status, 'verified');
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.requestedModelAvailable, true);
    assert.equal(JSON.stringify(result).includes('synthetic-'), false);
    assert.equal(vault.verifications.length, 1);
    assert.equal(vault.verifications[0].result.providerVerified, true);
  }
});

test('separates valid provider credentials from an unavailable pinned model', async () => {
  const vault = makeVault({ providers: ['xai'] });
  const verifier = createModelProviderCredentialVerifier({ vault,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'grok-readable' }] }), { status: 200 }) });
  const result = await verifier.verify({ provider: 'xai', modelId: 'grok-not-enabled' });
  assert.equal(result.providerVerified, true);
  assert.equal(result.status, 'model-unavailable');
  assert.equal(result.requestedModelAvailable, false);
  assert.equal(result.executionAuthorized, false);
});

test('allows a later explicit check to refresh a previously provider-verified key status', async () => {
  const vault = makeVault({ providers: ['xai'] });
  let calls = 0;
  const verifier = createModelProviderCredentialVerifier({ vault,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'xai-model-a' }] }), { status: 200 }); } });
  assert.equal((await verifier.verify({ provider: 'xai' })).providerVerified, true);
  assert.equal((await verifier.verify({ provider: 'xai' })).providerVerified, true);
  assert.equal(calls, 2);
  assert.equal(vault.verifications.length, 2);
});

test('fails closed and stores only safe classifications for auth, rate, provider and response failures', async t => {
  const cases = [
    { name: 'auth-rejected', response: new Response('{}', { status: 401 }), status: 'authentication-rejected', verified: false },
    { name: 'authorization-rejected', response: new Response('{"detail":"must not be retained"}', { status: 403 }), status: 'authorization-rejected', verified: false },
    { name: 'rate-limited', response: new Response('{}', { status: 429 }), status: 'rate-limited', verified: false },
    { name: 'provider-unavailable', response: new Response('{}', { status: 503 }), status: 'provider-unavailable', verified: false },
    { name: 'invalid-json', response: new Response('not-json', { status: 200 }), status: 'invalid-response', verified: false },
    { name: 'wrong-shape', response: new Response('{"unexpected":[]}', { status: 200 }), status: 'invalid-response', verified: false },
    { name: 'network-error', response: new Error('fixture network error'), status: 'provider-unavailable', verified: false }
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const vault = makeVault({ providers: ['meta'] });
    const verifier = createModelProviderCredentialVerifier({ vault,
      fetchImpl: async () => { if (item.response instanceof Error) throw item.response; return item.response; } });
    const result = await verifier.verify({ provider: 'meta' });
    assert.equal(result.status, item.status);
    assert.equal(result.providerVerified, item.verified);
    assert.equal(result.executionAuthorized, false);
    assert.equal(JSON.stringify(result).includes('synthetic-'), false);
    assert.equal(vault.verifications.length, 1);
  });
});

test('does not call providers for unsupported, missing, ambiguous or invalid model selections', async () => {
  let calls = 0;
  const missing = createModelProviderCredentialVerifier({ vault: makeVault({ providers: [] }), fetchImpl: async () => { calls++; } });
  const absent = await missing.verify({ provider: 'xai' });
  assert.equal(absent.errorCode, 'A_MODEL_CREDENTIAL_REQUIRED');
  const unsupported = await missing.verify({ provider: 'arbitrary' });
  assert.equal(unsupported.providerVerified, false);
  const ambiguous = createModelProviderCredentialVerifier({ vault: makeVault({ providers: ['xai', 'xai'] }), fetchImpl: async () => { calls++; } });
  assert.equal((await ambiguous.verify({ provider: 'xai' })).errorCode, 'A_MODEL_PROVIDER_CREDENTIAL_AMBIGUOUS');
  const invalidModel = createModelProviderCredentialVerifier({ vault: makeVault({ providers: ['xai'] }), fetchImpl: async () => { calls++; } });
  assert.equal((await invalidModel.verify({ provider: 'xai', modelId: 'bad\nmodel' })).errorCode, 'A_MODEL_ID_INVALID');
  assert.equal(calls, 0);
});

test('rejects catalog responses larger than the bounded byte limit', async () => {
  const vault = makeVault({ providers: ['gemini'] });
  const tooLarge = new Response(JSON.stringify({ models: [{ name: `models/${'x'.repeat(1_048_600)}` }] }), { status: 200 });
  const verifier = createModelProviderCredentialVerifier({ vault, fetchImpl: async () => tooLarge });
  const result = await verifier.verify({ provider: 'gemini' });
  assert.equal(result.status, 'invalid-response');
  assert.equal(result.errorCode, 'A_MODEL_PROVIDER_RESPONSE_TOO_LARGE');
  assert.equal(result.providerVerified, false);
});

test('does not mark a rotated credential verified from an older in-flight check', async () => {
  const vault = makeVault({ providers: ['xai'] });
  let finishFetch;
  const verifier = createModelProviderCredentialVerifier({ vault, fetchImpl: () => new Promise(resolve => { finishFetch = resolve; }) });
  const pending = verifier.verify({ provider: 'xai' });
  while (!finishFetch) await new Promise(resolve => setImmediate(resolve));
  vault.records[0].updatedAt = '2026-09-28T00:01:00.000Z';
  finishFetch(new Response(JSON.stringify({ data: [{ id: 'xai-model-a' }] }), { status: 200 }));
  await assert.rejects(pending, { code: 'A_MODEL_PROVIDER_VERIFICATION_STALE' });
  assert.equal(vault.verifications.length, 0);
});
