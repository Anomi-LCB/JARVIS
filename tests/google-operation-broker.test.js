import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleInboxSync } from '../packages/core/src/personal-operations/google-sync.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalSourceInbox } from '../packages/core/src/personal-operations/source-inbox.js';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../packages/core/src/personal-operations/google-vault-client.js';
import { createGoogleOperationBroker, createGoogleBrokerReadClient } from '../packages/core/src/personal-operations/google-operation-broker.js';

const job = { provider: 'gmail', timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z' };
const request = { connectionId: 'test-google', expectedRevision: 'revision-one', operation: 'page', job };
function fixture() {
  const row = { connectionId: request.connectionId, connectorId: GOOGLE_CONNECTOR_ID, authMethod: 'oauth2',
    scopes: [...GOOGLE_READ_SCOPES], status: 'credentials-stored-unverified', updatedAt: request.expectedRevision };
  const credentials = { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret', refreshToken: 'synthetic-refresh-token' };
  const calls = [];
  const state = { rows: [row], reads: 0, responseHook: null, providerError: null, title: '회의 준비', nextCursor: 'page-two', account: 'fixture@example.test' };
  const vault = {
    list: () => structuredClone(state.rows),
    withCredentials: async (id, operation) => {
      state.reads++;
      if (state.providerError) throw state.providerError;
      return operation(credentials, { ...row });
    }
  };
  const broker = createGoogleOperationBroker({ registry: new IntegrationConnectorRegistry(), vault,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(options.redirect, 'error');
      let body;
      if (String(url).endsWith('/token')) body = { access_token: 'synthetic-access-token', expires_in: 3600 };
      else if (String(url).endsWith('/profile')) body = { emailAddress: state.account };
      else if (String(url).includes('/messages/message-one')) body = { payload: { headers: [{ name: 'Subject', value: state.title }] } };
      else if (String(url).includes('/messages?')) body = { messages: [{ id: 'message-one' }], nextPageToken: state.nextCursor };
      else body = { items: [{ id: 'event-one', summary: state.title, start: { dateTime: job.timeMin } }] };
      if (state.responseHook) state.responseHook();
      return { ok: true, status: 200, json: async () => body };
    }
  });
  const client = createGoogleBrokerReadClient({ connectionMetadata: vault.list, execute: input => broker.execute(input) });
  return { row, credentials, calls, state, broker, client };
}

test('existing Google page/account contract works through an operation-only facade with no secret accessor', async () => {
  const f = fixture();
  assert.equal(await f.client.account(), 'fixture@example.test');
  assert.deepEqual(await f.client.page(job), { items: [{ id: 'message-one', title: '회의 준비' }], nextCursor: 'page-two' });
  assert.equal((await f.client.page({ ...job, provider: 'google-calendar' })).items[0].id, 'event-one');
  assert.equal(f.client.withCredentials, undefined);
  assert.equal(f.broker.withCredentials, undefined);
  assert.doesNotMatch(JSON.stringify(f.client), /synthetic-/u);
  assert.ok(f.calls.filter(call => !call.url.endsWith('/token')).every(call => call.options.headers.authorization === 'Bearer synthetic-access-token'));
});

test('broker page binds the requested inbox account before reading Gmail or Calendar contents', async () => {
  for (const provider of ['gmail', 'google-calendar']) {
    const f = fixture();
    await assert.rejects(f.client.page({ ...job, provider, account: 'another@example.test' }), /A_GOOGLE_ACCOUNT_MISMATCH/u);
    assert.equal(f.calls.filter(call => !call.url.endsWith('/token') && !call.url.endsWith('/profile')).length, 0);
    assert.ok(f.calls.some(call => call.url.endsWith('/profile')));
    assert.equal((await f.client.page({ ...job, provider, account: 'fixture@example.test' })).items.length, 1);
  }
});

test('account switch between sync identity and page cannot misattribute items or advance cursors', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-google-account-switch-'));
  const store = new PersonalOperationsStore({ dbPath: join(root, 'test.sqlite') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const f = fixture(); f.state.nextCursor = undefined;
  const inbox = new PersonalSourceInbox(store);
  const account = f.client.account;
  const switchingClient = { ...f.client, async account() { const original = await account(); f.state.account = 'new@example.test'; return original; } };
  const sync = new GoogleInboxSync({ inbox, client: switchingClient, clock: () => new Date('2026-10-02T00:00:00Z') });
  const result = await sync.run(); assert.equal(result.status, 'degraded');
  for (const provider of ['gmail', 'google-calendar']) {
    assert.equal(result.providers[provider].code, 'A_GOOGLE_ACCOUNT_MISMATCH');
    assert.match(result.providers[provider].nextAction, /계정 연결을 확인/u);
  }
  assert.equal(inbox.list().length, 0);
  assert.ok(store.db.prepare('SELECT body FROM personal_google_jobs').all().every(row => { const job = JSON.parse(row.body); return job.cursor === null && job.complete === false; }));
  assert.equal(f.calls.filter(call => !call.url.endsWith('/token') && !call.url.endsWith('/profile')).length, 0);
  f.state.account = 'fixture@example.test';
  assert.equal((await new GoogleInboxSync({ inbox, client: f.client, clock: () => new Date('2026-10-02T00:00:00Z') }).run()).status, 'ready');
  assert.equal(inbox.list().length, 2);
});

test('account switch during content response is rejected before page delivery', async () => {
  for (const provider of ['gmail', 'google-calendar']) {
    const f = fixture(); f.state.responseHook = () => {
      const url = f.calls.at(-1).url;
      if (!url.endsWith('/profile') && !url.endsWith('/token')) f.state.account = 'new@example.test';
    };
    await assert.rejects(f.client.page({ ...job, provider, account: 'fixture@example.test' }), /A_GOOGLE_ACCOUNT_MISMATCH/u);
    assert.ok(f.calls.filter(call => call.url.endsWith('/profile')).length >= 2);
  }
});

test('arbitrary URLs, headers, writes, scopes, invalid dates and oversized cursors are denied before secret access', async () => {
  const f = fixture();
  for (const input of [
    { ...request, operation: 'send' }, { ...request, url: 'https://evil.example' }, { ...request, credentials: {} },
    { ...request, job: { ...job, headers: {} } }, { ...request, job: { ...job, provider: 'bank' } },
    { ...request, job: { ...job, timeMin: 'yesterday' } }, { ...request, job: { ...job, timeMax: job.timeMin } },
    { ...request, job: { ...job, timeMin: '2026-02-30T00:00:00Z' } },
    { ...request, job: { ...job, timeMax: '2027-01-01T00:00:00Z' } },
    { ...request, job: { ...job, cursor: 'x'.repeat(2049) } },
    { ...request, operation: 'account' }, Object.assign(Object.create({}), request)
  ]) await assert.rejects(() => f.broker.execute(input), { message: 'A_GOOGLE_BROKER_REQUEST_INVALID' });
  assert.equal(f.state.reads, 0);
  assert.equal(f.calls.length, 0);
});

test('broker facade preserves existing persisted sync jobs, 104-day calendar window and deduplicated inbox results', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-google-broker-'));
  const store = new PersonalOperationsStore({ dbPath: join(root, 'test.sqlite') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const f = fixture(); f.state.nextCursor = undefined;
  const inbox = new PersonalSourceInbox(store);
  const sync = new GoogleInboxSync({ inbox, client: f.client, clock: () => new Date('2026-10-02T00:00:00Z') });
  assert.equal((await sync.run()).status, 'ready');
  assert.equal(inbox.list().length, 2);
  assert.equal((await sync.run()).status, 'ready');
  assert.equal(inbox.list().length, 2);
  assert.doesNotMatch(JSON.stringify(inbox.list()), /synthetic-(?:client|refresh|access)/u);
});

test('revoked, absent, stale-revision and insufficient-scope requests cannot reuse cached credentials', async () => {
  for (const mutation of [f => { f.state.rows = []; }, f => { f.row.status = 'revoked'; },
    f => { f.row.scopes = []; }, f => { f.row.updatedAt = 'revision-two'; }]) {
    const f = fixture();
    await f.broker.execute(request);
    const count = f.calls.length;
    mutation(f);
    await assert.rejects(() => f.broker.execute(request), /A_GOOGLE_BROKER_(CONNECTION_REQUIRED|REVISION_CONFLICT)/u);
    assert.equal(f.calls.length, count);
  }
});

test('revocation while upstream responds suppresses data delivery', async () => {
  const f = fixture();
  f.state.responseHook = () => { f.row.status = 'revoked'; };
  await assert.rejects(() => f.broker.execute(request), { message: 'A_GOOGLE_BROKER_CONNECTION_REQUIRED' });
});

test('backend failures and credential echoes are never returned as raw error/result text', async () => {
  const f = fixture();
  f.state.providerError = new Error('vault failure synthetic-client-secret');
  await assert.rejects(() => f.broker.execute(request), { message: 'A_GOOGLE_BROKER_OPERATION_FAILED' });
  f.state.providerError = null;
  f.state.title = f.credentials.refreshToken;
  await assert.rejects(() => f.broker.execute(request), { message: 'A_GOOGLE_BROKER_RESPONSE_DENIED' });
});

test('asynchronous callers cannot change the selected operation or date range after validation', async () => {
  const f = fixture();
  const input = structuredClone(request);
  const pending = f.broker.execute(input);
  input.job.provider = 'google-calendar'; input.job.timeMin = '2025-01-01T00:00:00Z';
  await pending;
  assert.equal(f.calls.some(call => call.url.includes('/calendar/')), false);
  assert.ok(f.calls.some(call => call.url.includes('after%3A1790812800')));
});
