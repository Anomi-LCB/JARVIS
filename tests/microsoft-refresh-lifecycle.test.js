import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationConnectorRegistry, IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';
import { createMicrosoftSourceReader } from '../packages/core/src/personal-operations/microsoft-source-reader.js';

function fixture(t, realDpapi = false) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-refresh-lifecycle-')), path = join(root, 'vault.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { path, platform: 'win32', clock: () => new Date('2026-10-07T00:00:00Z'),
    ...(!realDpapi ? { protect: v => Buffer.from(`sealed:${v}`).toString('base64'),
      unprotect: v => Buffer.from(v, 'base64').toString().slice(7), harden: () => {} } : {}) };
  const vault = new IntegrationCredentialVault(options), registry = new IntegrationConnectorRegistry();
  const credentials = { tenantId: 'common', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-old-refresh' };
  const saved = vault.save({ connectorId: 'jarvis-outlook-read', providerAccountId: 'synthetic-account', authMethod: 'oauth2', scopes: ['Mail.ReadBasic'], grants: [], credentials });
  const job = { provider: 'outlook', connectionId: saved.connectionId }, calls = [];
  let replacement = 'synthetic-new-refresh', accessToken = 'opaque+/token==', onToken = null, pageStatus = 200, releaseToken = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://login.microsoftonline.com/')) {
      if (releaseToken) await releaseToken;
      onToken?.();
      return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'Mail.ReadBasic', refresh_token: replacement });
    }
    assert.equal(await vault.withCredentials(job.connectionId, c => c.refreshToken), replacement);
    return Response.json({ value: [{ id: 'one', subject: '합성 목록' }] }, { status: pageStatus });
  };
  return { vault, options, path, credentials, saved, job, calls,
    reader: createMicrosoftSourceReader({ registry, vault, fetchImpl }),
    replacement: v => replacement = v, accessToken: v => accessToken = v, onToken: v => onToken = v,
    pageStatus: v => pageStatus = v, hold: v => releaseToken = v };
}

test('new refresh token is protected before Graph and survives vault reopening without widening grants', async t => {
  const f = fixture(t); const page = await f.reader.page(f.job);
  assert.equal(page.items.length, 1); assert.equal(f.calls[1].options.headers.authorization, 'Bearer opaque+/token==');
  const reopened = new IntegrationCredentialVault(f.options);
  assert.equal(await reopened.withCredentials(f.job.connectionId, c => c.refreshToken), 'synthetic-new-refresh');
  assert.deepEqual(reopened.list()[0].scopes, ['Mail.ReadBasic']); assert.deepEqual(reopened.list()[0].grants, []);
  assert.equal(reopened.list()[0].status, 'credentials-stored-unverified');
  assert.doesNotMatch(readFileSync(f.path, 'utf8') + JSON.stringify(page), /synthetic-new-refresh|synthetic-old-refresh|synthetic-secret|opaque\+/u);
  await f.reader.page(f.job);
  assert.equal(f.calls[2].options.body.get('refresh_token'), 'synthetic-new-refresh');
});

test('refresh persists even when Graph fails, and does not automatically retry the read', async t => {
  const f = fixture(t); f.pageStatus(500);
  await assert.rejects(f.reader.page(f.job), /PAGE_UNAVAILABLE/u);
  assert.equal(f.calls.length, 2);
  assert.equal(await f.vault.withCredentials(f.job.connectionId, c => c.refreshToken), 'synthetic-new-refresh');
  f.pageStatus(200); await f.reader.page(f.job);
  assert.equal(f.calls[2].options.body.get('refresh_token'), 'synthetic-new-refresh');
});

test('same connection concurrent refresh is rejected before a second provider call and lock is released', async t => {
  const f = fixture(t); let release; f.hold(new Promise(resolve => release = resolve));
  const first = f.reader.page(f.job);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.reader.page(f.job), /CONNECTION_BUSY/u); assert.equal(f.calls.length, 1);
  release(); await first; f.hold(null); await f.reader.page(f.job); assert.equal(f.calls.length, 4);
});

test('same-timestamp credential and scope replacement cannot be overwritten by stale refresh', async t => {
  const f = fixture(t);
  const initial = f.vault.list()[0];
  f.vault.save({ connectorId: 'jarvis-outlook-read', providerAccountId: 'synthetic-account', authMethod: 'oauth2', scopes: ['Mail.ReadBasic'], grants: [], credentials: { ...f.credentials, clientSecret: 'changed-secret' } });
  assert.throws(() => f.vault.rotateOAuthRefreshToken(f.job.connectionId, { expectedConnection: initial, expectedCredentials: f.credentials, refreshToken: 'stale-new-token' }), /REFRESH_STALE/u);
  const currentCredentials = await f.vault.withCredentials(f.job.connectionId, c => ({ ...c }));
  f.vault.save({ connectorId: 'jarvis-outlook-read', providerAccountId: 'synthetic-account', authMethod: 'oauth2', scopes: ['Mail.ReadBasic', 'Mail.Send'], grants: [], credentials: currentCredentials });
  assert.throws(() => f.vault.rotateOAuthRefreshToken(f.job.connectionId, { expectedConnection: initial, expectedCredentials: currentCredentials, refreshToken: 'stale-new-token' }), /REFRESH_STALE/u);
  assert.equal(await f.vault.withCredentials(f.job.connectionId, c => c.refreshToken), 'synthetic-old-refresh');
});

test('failed protected write preserves old vault and prevents Graph call, then retry can succeed', async t => {
  const f = fixture(t), before = readFileSync(f.path), protect = f.vault.protect;
  f.vault.protect = () => { throw new Error('synthetic-private-error'); };
  await assert.rejects(f.reader.page(f.job), { message: 'A_MICROSOFT_REFRESH_STORAGE_UNAVAILABLE' });
  assert.equal(f.calls.length, 1); assert.deepEqual(readFileSync(f.path), before);
  f.vault.protect = protect; await f.reader.page(f.job); assert.equal(f.calls.length, 3);
});

test('removal during refresh never recreates credentials or contacts Graph', async t => {
  const f = fixture(t); f.onToken(() => f.vault.remove(f.job.connectionId));
  await assert.rejects(f.reader.page(f.job), /CONNECTION_REQUIRED/u); assert.equal(f.calls.length, 1); assert.equal(f.vault.list().length, 0);
});

test('invalid new refresh or injected bearer header cannot rotate stored credentials', async t => {
  for (const value of ['', 'x\r\n', 'x'.repeat(16385)]) {
    const f = fixture(t); f.replacement(value); await assert.rejects(f.reader.page(f.job), /TOKEN_INVALID/u);
    assert.equal(f.calls.length, 1); assert.equal(await f.vault.withCredentials(f.job.connectionId, c => c.refreshToken), 'synthetic-old-refresh');
  }
  const f = fixture(t); f.accessToken('x\r\nInjected: value');
  await assert.rejects(f.reader.page(f.job), /TOKEN_INVALID/u); assert.equal(f.calls.length, 1);
});

test('actual Windows DPAPI protects refreshed credential in isolated file across reopening', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t, true); await f.reader.page(f.job);
  const reopened = new IntegrationCredentialVault(f.options);
  assert.equal(await reopened.withCredentials(f.job.connectionId, c => c.refreshToken), 'synthetic-new-refresh');
  assert.doesNotMatch(readFileSync(f.path, 'utf8'), /synthetic-new-refresh|synthetic-secret|synthetic-old-refresh/u);
});

test('actual DPAPI same-timestamp credential replacement invalidates a returned page', {skip:process.platform!=='win32'},async t=>{
 const f=fixture(t,true);f.replacement('synthetic-old-refresh');
 const page=await f.reader.page(f.job),before=f.vault.list()[0],revision=f.vault.credentialRevision(f.job.connectionId);
 f.vault.save({connectorId:'jarvis-outlook-read',providerAccountId:'synthetic-account',authMethod:'oauth2',scopes:['Mail.ReadBasic'],grants:[],credentials:{...f.credentials,clientSecret:'synthetic-replaced-secret'}});
 assert.deepEqual(f.vault.list()[0],before);
 assert.notEqual(f.vault.credentialRevision(f.job.connectionId),revision);
 let writes=0;
 assert.throws(()=>f.reader.commitPage(page,{ingest(){writes++;}}),/A_MICROSOFT_CONNECTION_CHANGED/);
 assert.equal(writes,0);
 const reopened=new IntegrationCredentialVault(f.options);
 assert.equal(reopened.credentialRevision(f.job.connectionId),f.vault.credentialRevision(f.job.connectionId));
 assert.doesNotMatch(readFileSync(f.path,'utf8')+JSON.stringify(page),/synthetic-replaced-secret|synthetic-old-refresh/);
});
