import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';
import { createGoogleVaultReadClient, GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../packages/core/src/personal-operations/google-vault-client.js';

function fixture() {
  const record = { connectionId: 'synthetic-google', connectorId: GOOGLE_CONNECTOR_ID, authMethod: 'oauth2',
    status: 'credentials-stored-unverified', scopes: [...GOOGLE_READ_SCOPES], updatedAt: '2026-10-07T00:00:00Z' };
  const credentials = { clientId: 'synthetic-id', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-old' };
  const calls = [], verification = []; let onToken = null, onProfileBody = null, onVault = null;
  const vault = { list: () => [{ ...record, scopes: [...record.scopes] }],
    async withCredentials(id, operation) { onVault?.(); return operation({ ...credentials }, { ...record, scopes: [...record.scopes] }); },
    recordProviderVerification(id, result) { verification.push({ id, result }); } };
  const client = createGoogleVaultReadClient({ registry: new IntegrationConnectorRegistry(), vault,
    clock: () => new Date('2026-10-07T00:00:00Z'), fetchImpl: async (url, options) => {
      const target = String(url); calls.push({ target, options });
      if (target === 'https://oauth2.googleapis.com/token') { onToken?.(); return Response.json({ access_token: 'synthetic-access', expires_in: 3600 }); }
      if (target.endsWith('/profile')) return { ok: true, status: 200, async json() { onProfileBody?.(); return { emailAddress: 'synthetic@example.test' }; } };
      if (target.includes('/messages')) return Response.json({ messages: [] });
      if (target.includes('/calendar/')) return Response.json({ items: [] });
      throw new Error('TEST_UNEXPECTED_TARGET');
    } });
  return { client, record, credentials, calls, verification, token: fn => onToken = fn, profileBody: fn => onProfileBody = fn, vault: fn => onVault = fn };
}

test('same-timestamp Google credential replacement invalidates cached token before next request', async () => {
  const f = fixture(); await f.client.account();
  f.credentials.refreshToken = 'synthetic-new'; await f.client.account();
  const tokens = f.calls.filter(call => call.target.endsWith('/token'));
  assert.equal(tokens.length, 2); assert.equal(tokens[1].options.body.get('refresh_token'), 'synthetic-new');
});

for (const change of ['revoke', 'scope', 'credentials', 'close', 'invalidate']) test(`Google ${change} during token response blocks profile request`, async () => {
  const f = fixture(); f.token(() => {
    if (change === 'revoke') f.record.status = 'revoked';
    if (change === 'scope') f.record.scopes = [];
    if (change === 'credentials') f.credentials.refreshToken = 'synthetic-new';
    if (change === 'close') f.client.close();
    if (change === 'invalidate') f.client.invalidate();
  });
  await assert.rejects(f.client.account(), /A_GOOGLE_CONNECTION_(REQUIRED|CHANGED|CLOSED)/u);
  assert.equal(f.calls.length, 1);
});

test('credential invalidation clears cached access without reopening a permanently closed client',async()=>{
 const f=fixture();await f.client.account();f.client.invalidate();await f.client.account();
 assert.equal(f.calls.filter(x=>x.target.endsWith('/token')).length,2);
 f.client.close();f.client.invalidate();assert.equal(f.client.configured(),false);
 await assert.rejects(f.client.account(),/A_GOOGLE_CONNECTION_CLOSED/);
 assert.equal(f.calls.filter(x=>x.target.endsWith('/token')).length,2);
});

test('an invalidated operation cannot publish a response after an identical connection is restored',async()=>{
 const f=fixture();let started;
 const reached=new Promise(resolve=>started=resolve);
 // Invalidate while a provider body is being read, then restore the same metadata and secret.
 f.profileBody(()=>{f.client.invalidate();started();});
 const old=f.client.account();await reached;await assert.rejects(old,/A_GOOGLE_CONNECTION_CHANGED/);
 f.profileBody(null);assert.equal(await f.client.account(),'synthetic@example.test');
 assert.equal(f.calls.filter(x=>x.target.endsWith('/token')).length,2);
});

test('Google revocation while parsing profile prevents stale account verification', async () => {
  const f = fixture(); f.profileBody(() => { f.record.status = 'revoked'; });
  await assert.rejects(f.client.verifyConnection(), /A_GOOGLE_CONNECTION_(REQUIRED|CHANGED)/u);
  assert.equal(f.verification.length, 0);
});

test('Google request provider and query remain pinned during asynchronous vault resolution', async () => {
  const f = fixture(), job = { provider: 'gmail', timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-07T00:00:00Z', cursor: null };
  f.vault(() => { job.provider = 'google-calendar'; job.timeMin = '2000-01-01T00:00:00Z'; });
  const page = await f.client.page(job); assert.deepEqual(page.items, []);
  const api = f.calls.find(call => !call.target.endsWith('/token'));
  assert.ok(api.target.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?'));
  assert.ok(new URL(api.target).searchParams.get('q').includes(`after:${Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000)}`));
});
