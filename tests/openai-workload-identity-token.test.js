import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiWorkloadIdentityTokenSource, openAiWorkloadIdentityConstants } from '../packages/core/src/mission/openai-workload-identity-token.js';
import { createOpenAiAgentsSessionProvider } from '../packages/core/src/mission/openai-agents-api-provider.js';

const identityProviderId = 'wip_local_test';
const serviceAccountId = 'svcacct_local_test';

function tokenResponse(token, nowMs, expiresIn = 3600) {
  return Response.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn,
    expires_at: Math.floor(nowMs / 1000) + expiresIn, scope: 'api.model.request' });
}

test('exchanges a trusted subject token at the fixed endpoint and returns only a short-lived bearer token', async () => {
  const nowMs = 1_800_000_000_000;
  const subjectToken = 'external-oidc-subject-token';
  let request;
  const source = createOpenAiWorkloadIdentityTokenSource({ identityProviderId, serviceAccountId,
    getSubjectToken: async () => subjectToken, now: () => nowMs,
    fetchImpl: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return tokenResponse('short-lived-openai-token', nowMs, 300); } });

  assert.equal(await source.getAccessToken(), 'short-lived-openai-token');
  assert.equal(request.url, openAiWorkloadIdentityConstants.tokenEndpoint);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(request.body, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token_type: openAiWorkloadIdentityConstants.jwtSubjectTokenType,
    subject_token: subjectToken, identity_provider_id: identityProviderId, service_account_id: serviceAccountId
  });
  assert.deepEqual(source.status(), { configured: true, tokenCached: true, expiresAt: nowMs + 300_000 });
  assert.equal(JSON.stringify(source.status()).includes('short-lived-openai-token'), false);
});

test('caches only in memory until the conservative refresh boundary and exchanges again after expiry skew', async () => {
  let nowMs = 1_800_000_000_000;
  let exchangeCount = 0;
  const source = createOpenAiWorkloadIdentityTokenSource({ identityProviderId, serviceAccountId,
    getSubjectToken: async () => 'external-token', now: () => nowMs,
    fetchImpl: async () => tokenResponse(`access-${++exchangeCount}`, nowMs, 300) });

  assert.equal(await source.getAccessToken(), 'access-1');
  assert.equal(await source.getAccessToken(), 'access-1');
  assert.equal(exchangeCount, 1);
  nowMs += 241_000;
  assert.equal(await source.getAccessToken(), 'access-2');
  assert.equal(exchangeCount, 2);
});

test('concurrent token requests share one exchange and clearing cache invalidates an in-flight exchange', async () => {
  let nowMs = 1_800_000_000_000;
  let exchangeCount = 0;
  let finishExchange;
  const source = createOpenAiWorkloadIdentityTokenSource({ identityProviderId, serviceAccountId,
    getSubjectToken: async () => 'external-token', now: () => nowMs,
    fetchImpl: async () => { exchangeCount++; return new Promise(resolve => { finishExchange = () => resolve(tokenResponse('revoked-token', nowMs)); }); } });
  const first = source.getAccessToken();
  const second = source.getAccessToken();
  assert.equal(exchangeCount, 0, 'the exchange starts asynchronously after entering the shared flight');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exchangeCount, 1);
  source.clearMemoryCache();
  finishExchange();
  await assert.rejects(first, { code: 'A_OPENAI_WIF_CREDENTIAL_REVOKED' });
  await assert.rejects(second, { code: 'A_OPENAI_WIF_CREDENTIAL_REVOKED' });
  assert.deepEqual(source.status(), { configured: true, tokenCached: false, expiresAt: null });
});

test('rejects malformed identities, invalid expirations and provider errors without echoing either token', async () => {
  assert.throws(() => createOpenAiWorkloadIdentityTokenSource({ identityProviderId: '../bad', serviceAccountId,
    getSubjectToken: async () => 'x' }), { code: 'A_OPENAI_WIF_CONFIGURATION_INVALID' });
  const nowMs = 1_800_000_000_000;
  const expired = createOpenAiWorkloadIdentityTokenSource({ identityProviderId, serviceAccountId,
    getSubjectToken: async () => 'do-not-echo-subject', now: () => nowMs,
    fetchImpl: async () => Response.json({ access_token: 'do-not-echo-access', token_type: 'Bearer', expires_in: 1, expires_at: nowMs / 1000 - 1 }) });
  await assert.rejects(expired.getAccessToken(), error => error.code === 'A_OPENAI_WIF_TOKEN_EXPIRED'
    && !error.message.includes('do-not-echo-subject') && !error.message.includes('do-not-echo-access'));
  const rejected = createOpenAiWorkloadIdentityTokenSource({ identityProviderId, serviceAccountId,
    getSubjectToken: async () => 'do-not-echo-subject', fetchImpl: async () => new Response('do-not-echo-subject', { status: 403 }) });
  await assert.rejects(rejected.getAccessToken(), error => error.code === 'A_OPENAI_WIF_EXCHANGE_REJECTED'
    && !error.message.includes('do-not-echo-subject'));
});

test('bounds the trusted identity-token supplier with the exchange timeout', async () => {
  const source = createOpenAiWorkloadIdentityTokenSource({ identityProviderId, serviceAccountId, timeoutMs: 100,
    getSubjectToken: () => new Promise(() => {}), fetchImpl: async () => { throw new Error('must not reach the exchange'); } });
  await assert.rejects(source.getAccessToken(), { code: 'A_OPENAI_WIF_EXCHANGE_TIMEOUT' });
});

test('a short-lived federated token can authorize a JARVIS Agents request without an API key', async () => {
  const nowMs = 1_800_000_000_000;
  let authHeader = null;
  const source = createOpenAiWorkloadIdentityTokenSource({ identityProviderId, serviceAccountId,
    getSubjectToken: async () => 'trusted-subject-token', now: () => nowMs,
    fetchImpl: async () => tokenResponse('federated-bearer-token', nowMs) });
  const provider = createOpenAiAgentsSessionProvider({ resolveAccessToken: () => source.getAccessToken(),
    fetchImpl: async (url, options) => { authHeader = options.headers.Authorization; return Response.json({ id: 'session_federated', status: 'idle' }); } });
  await provider.createSession({ model: 'gpt-test', instructions: 'read only', tools: [] }, { authorizeSessionCreate: async () => true });
  assert.equal(authHeader, 'Bearer federated-bearer-token');
});

test('requires exactly one credential source for the managed Agents provider', () => {
  assert.throws(() => createOpenAiAgentsSessionProvider({}), { code: 'A_OPENAI_AGENTS_API_KEY_REQUIRED' });
  assert.throws(() => createOpenAiAgentsSessionProvider({ apiKey: 'k', resolveAccessToken: async () => 't' }), { code: 'A_OPENAI_AGENTS_API_KEY_REQUIRED' });
});
