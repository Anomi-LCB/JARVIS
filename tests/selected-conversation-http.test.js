import test from 'node:test';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

async function fixture(t, persistent = true) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-archive-http-'));
  const store = persistent ? new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') }) : null;
  const growth = store ? new GrowthRuntime({ memoryStore: store, auditRoot: root }) : null;
  const core = new CoreFacade({ memoryStore: growth, workspaceRoot: root });
  const server = createCoreServer(core, { adminToken: 'synthetic-admin', adminTokens: [{ token: 'synthetic-reader', scopes: ['read_diagnostics'] }] });
  await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store?.close(); rmSync(root, { recursive: true, force: true }); });
  const post = (op, body, token = 'synthetic-admin', headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/memory/selected-conversations/${op}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  const document = { format: 'jarvis-selected-conversations-v1', provider: 'chatgpt', conversations: [{ id: 'picked', messages: [
    { id: 'm1', speaker: 'user', text: '자료 원문을 대조한다.', spokenAt: '2026-09-30T00:00:00Z' }
  ] }] };
  const input = { userId: 'synthetic-owner', document, selectedConversationIds: ['picked'], sourceRef: 'selected-file:fixture.json' };
  return { post, input, root, growth };
}

test('authenticated HTTP pages cover every match without duplicates and reject changed state or cursor misuse',async t=>{
 const f=await fixture(t);
 f.input.document.conversations[0].messages=Array.from({length:47},(_,i)=>({id:`m${i}`,speaker:'user',text:'자료 원문 대조',spokenAt:i%2?'2026-10-03T09:00:00+09:00':'2026-10-03T00:00:00Z'}));
 const preview=await(await f.post('preview',f.input)).json();
 assert.equal((await f.post('commit',{...f.input,expectedDocumentHash:preview.documentHash})).status,200);
 const body={userId:f.input.userId,query:'오늘 자료 정리해줘',pageSize:20};
 let page=await(await f.post('page',body)).json();const first=page,all=[...page.items];
 assert.equal(page.items.length,20);assert.equal(page.hasMore,true);
 while(page.hasMore){page=await(await f.post('page',{...body,cursor:page.nextCursor})).json();all.push(...page.items);}
 assert.equal(all.length,47);assert.equal(new Set(all.map(x=>x.memoryId)).size,47);
 assert.deepEqual(all.map(x=>x.sourceMessageId).sort(),f.input.document.conversations[0].messages.map(x=>x.id).sort());
 assert.deepEqual(all.map(x=>x.memoryId),all.map(x=>x.memoryId).sort());
 assert.equal(page.nextCursor,null);assert.equal(page.items.length,7);
 for(const changed of [{userId:'other'},{query:'원문'},{pageSize:10},{cursor:first.nextCursor+'x'}]){
  const response=await f.post('page',{...body,cursor:first.nextCursor,...changed});assert.equal(response.status,400);
  assert.equal((await response.json()).error.code,'F_CONVERSATION_CURSOR_INVALID');
 }
 assert.equal((await f.post('page',body,'synthetic-reader')).status,403);
 assert.equal((await f.post('page',{...body,workspaceRoot:'forged'})).status,400);
 for(const pageSize of [0,51,1.5,'20'])assert.equal((await f.post('page',{...body,pageSize})).status,400);
 assert.equal((await f.post('withdraw',{userId:f.input.userId,id:all[25].memoryId})).status,200);
 const changed=await f.post('page',{...body,cursor:first.nextCursor});assert.equal(changed.status,409);
 assert.equal((await changed.json()).error.code,'F_CONVERSATION_PAGE_CHANGED');
 page=await(await f.post('page',body)).json();const fresh=[...page.items];
 while(page.hasMore){page=await(await f.post('page',{...body,cursor:page.nextCursor})).json();fresh.push(...page.items);}
 assert.equal(fresh.length,46);assert.ok(!fresh.some(x=>x.memoryId===all[25].memoryId));
 assert.deepEqual((await(await f.post('page',{...body,query:'없는내용'})).json()).items,[]);
});

test('authenticated HTTP preview, commit, scoped query, withdrawal and replay use actual persistent archive', async t => {
  const f = await fixture(t);
  let response = await f.post('preview', f.input); assert.equal(response.status, 200);
  const preview = await response.json(); assert.equal(preview.selectedMessages, 1);
  assert.deepEqual((await (await f.post('query', { userId: f.input.userId, query: '자료' })).json()).items, []);
  const commit = { ...f.input, expectedDocumentHash: preview.documentHash };
  response = await f.post('commit', commit); assert.equal(response.status, 200); assert.equal((await response.json()).imported, 1);
  const items = (await (await f.post('query', { userId: f.input.userId, query: '자료' })).json()).items;
  assert.equal(items.length, 1); assert.equal(items[0].executionAuthority, false);
  const naturalItems=(await (await f.post('query',{userId:f.input.userId,query:'오늘 자료를 정리해줘'})).json()).items;
  assert.equal(naturalItems[0]?.memoryId,items[0].memoryId);
  assert.equal(naturalItems[0].sourceTextStart,0);
  assert.equal(naturalItems[0].text,f.input.document.conversations[0].messages[0].text.slice(naturalItems[0].sourceTextStart,naturalItems[0].sourceTextEnd));
  for (const body of [{ userId: 'other-owner', query: '자료' }, { userId: f.input.userId, conversationId: 'other-conversation', query: '자료' }])
    assert.deepEqual((await (await f.post('query', body)).json()).items, []);
  assert.equal((await (await f.post('withdraw', { userId: 'other-owner', id: items[0].memoryId })).json()).withdrawn, false);
  assert.equal((await (await f.post('withdraw', { userId: f.input.userId, id: items[0].memoryId })).json()).withdrawn, true);
  assert.deepEqual((await (await f.post('query', { userId: f.input.userId, query: '자료' })).json()).items, []);
  assert.equal((await (await f.post('commit', commit)).json()).withdrawn, 1);
  assert.equal(f.growth.ingestor.all().length, 0);
});

test('HTTP fails closed on unauthorized access, forged workspace, content types, missing hashes and changed documents', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('preview', f.input, 'wrong')).status, 401);
  assert.equal((await f.post('preview', f.input, 'synthetic-reader')).status, 403);
  assert.equal((await f.post('preview', { ...f.input, workspaceRoot: 'forged' })).status, 400);
  assert.equal((await f.post('preview', f.input, 'synthetic-admin', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.post('commit', f.input)).status, 400);
  assert.equal((await f.post('preview', { userId: f.input.userId })).status, 400);
  const preview = await (await f.post('preview', f.input)).json();
  const changed = structuredClone(f.input); changed.document.conversations[0].messages[0].text = '변경된 비공개 자료';
  const response = await f.post('commit', { ...changed, expectedDocumentHash: preview.documentHash });
  assert.equal(response.status, 409); assert.doesNotMatch(JSON.stringify(await response.json()), /비공개/);
  assert.equal((await f.post('preview', { ...f.input, padding: 'x'.repeat(4 * 1024 * 1024) })).status, 413);
  assert.equal((await f.post('unknown', f.input)).status, 404);
  assert.deepEqual(f.growth.selectedConversationImports.query('자료', { scope: { userId: f.input.userId, workspaceRoot: f.root, conversationId: null } }), []);
});

test('HTTP does not silently create volatile memory when persistent storage is unavailable', async t => {
  const f = await fixture(t, false);
  const response = await f.post('preview', f.input); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'F_CONVERSATION_STORAGE_REQUIRED');
});

test('direct JARVIS notes remain scoped untrusted references and never become execution authority',async t=>{
 const f=await fixture(t);f.input.document.provider='jarvis';f.input.sourceRef='user-note:synthetic';
 const preview=await (await f.post('preview',f.input)).json();assert.equal(preview.selectedMessages,1);
 assert.equal((await (await f.post('commit',{...f.input,expectedDocumentHash:preview.documentHash})).json()).imported,1);
 const items=(await (await f.post('query',{userId:f.input.userId,query:'자료'})).json()).items;
 assert.equal(items.length,1);assert.equal(items[0].executionAuthority,false);assert.equal(f.growth.ingestor.all().length,0);
});
