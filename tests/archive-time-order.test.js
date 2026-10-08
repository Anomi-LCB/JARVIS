import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {selectedConversationDocumentHash} from '../apps/growth-memory/src/selected-conversation-archive.js';
import { DatabaseSync } from 'node:sqlite';

test('archive page revision tracks SQL-only legacy writes, rolls back atomically, and isolates unrelated scopes',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-archive-revision-'));
 const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const legacy=new DatabaseSync(store.dbPath);
 try {
  const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});let archive=growth.selectedConversationImports;
  const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
  const document={format:'jarvis-selected-conversations-v1',provider:'jarvis',conversations:[{id:'chosen',messages:[1,2,3].map(i=>({id:`m${i}`,speaker:'user',text:'자료 원문',spokenAt:`2026-10-03T0${i}:00:00Z`}))}]};
  const input=scope=>({document,scope,selectedConversationIds:['chosen'],sourceRef:'synthetic-revision',expectedDocumentHash:selectedConversationDocumentHash(document)});
  growth.importSelectedConversations(input(scope),{commit:true});
  // Simulate an existing archive from before the revision table existed.
  store.db.exec('DROP TRIGGER selected_conversation_revision_insert; DROP TRIGGER selected_conversation_revision_update; DROP TRIGGER selected_conversation_revision_delete; DROP TABLE selected_conversation_scope_revisions;');
  archive=new GrowthRuntime({memoryStore:store,auditRoot:root}).selectedConversationImports;
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM selected_conversation_scope_revisions').get().count,0);
  assert.equal(archive.query('자료',{scope}).length,3);
  const first=archive.queryPage('자료',{scope,pageSize:1}),last=archive.query('자료',{scope}).at(-1);
  growth.importSelectedConversations(input({...scope,userId:'other'}),{commit:true});
  assert.equal(archive.queryPage('자료',{scope,pageSize:1,cursor:first.nextCursor}).items.length,1);
  const revision=()=>store.db.prepare('SELECT revision FROM selected_conversation_scope_revisions').all().reduce((sum,x)=>sum+x.revision,0);
  const originalRevision=revision();
  legacy.exec('BEGIN');legacy.prepare('UPDATE selected_conversation_messages SET withdrawn=1 WHERE id=?').run(last.memoryId);legacy.exec('ROLLBACK');
  assert.equal(revision(),originalRevision);
  assert.equal(archive.queryPage('자료',{scope,pageSize:1,cursor:first.nextCursor}).items.length,1);
  legacy.prepare('DELETE FROM selected_conversation_messages WHERE id=?').run(last.memoryId);
  assert.equal(revision(),originalRevision+1);
  assert.throws(()=>archive.queryPage('자료',{scope,pageSize:1,cursor:first.nextCursor}),{code:'F_CONVERSATION_PAGE_CHANGED'});
  const current=archive.queryPage('자료',{scope,pageSize:1});
  legacy.prepare('UPDATE selected_conversation_messages SET source_ref=? WHERE id=?').run('synthetic-revised-source',current.items[0].memoryId);
  assert.throws(()=>archive.queryPage('자료',{scope,pageSize:1,cursor:current.nextCursor}),{code:'F_CONVERSATION_PAGE_CHANGED'});
  const beforeSwap=archive.queryPage('자료',{scope,pageSize:1});
  archive.store={db:legacy};
  assert.throws(()=>archive.queryPage('자료',{scope,pageSize:1,cursor:beforeSwap.nextCursor}),{code:'F_CONVERSATION_CURSOR_INVALID'});
 } finally {legacy.close();store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});}
});

test('paged archive detects imports and another SQLite connection withdrawal; restart requires fresh cursor',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-archive-pages-')),stores=[];
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});stores.push(store);return new GrowthRuntime({memoryStore:store,auditRoot:root});};
 try {
  const growth=open(),archive=growth.selectedConversationImports,scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
  const document={format:'jarvis-selected-conversations-v1',provider:'jarvis',conversations:[{id:'chosen',messages:[1,2,3].map(i=>({id:`m${i}`,speaker:'user',text:'자료 원문',spokenAt:`2026-10-03T0${i}:00:00Z`}))}]};
  const input=()=>({document,scope,selectedConversationIds:['chosen'],sourceRef:'synthetic-pages',expectedDocumentHash:selectedConversationDocumentHash(document)});
  growth.importSelectedConversations(input(),{commit:true});
  let page=archive.queryPage('자료',{scope,pageSize:1});
  const other=open().selectedConversationImports;
  assert.throws(()=>other.queryPage('자료',{scope,pageSize:1,cursor:page.nextCursor}),{code:'F_CONVERSATION_CURSOR_INVALID'});
  const oldest=other.query('자료',{scope}).at(-1);
  other.withdraw({scope,id:oldest.memoryId});
  assert.throws(()=>archive.queryPage('자료',{scope,pageSize:1,cursor:page.nextCursor}),{code:'F_CONVERSATION_PAGE_CHANGED'});
  page=archive.queryPage('자료',{scope,pageSize:1});
  document.conversations[0].messages.push({id:'new',speaker:'user',text:'자료 새 기록',spokenAt:'2026-10-03T04:00:00Z'});
  growth.importSelectedConversations(input(),{commit:true});
  assert.throws(()=>archive.queryPage('자료',{scope,pageSize:1,cursor:page.nextCursor}),{code:'F_CONVERSATION_PAGE_CHANGED'});
  assert.equal(archive.queryPage('자료',{scope,pageSize:50}).items.length,3);
 } finally { for(const store of stores)store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true}); }
});

test('archive orders absolute instants across offsets while retaining declared time/hash and retraction on reopen',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-archive-time-')),stores=[];
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});stores.push(store);return new GrowthRuntime({memoryStore:store,auditRoot:root});};
 try{
  const growth=open(),scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
  const times=[['old-korea','2026-10-03T08:00:00+09:00'],['middle-utc','2026-10-03T00:00:00Z'],['new-america','2026-10-02T21:00:00-04:00'],['equal-korea','2026-10-03T09:00:00+09:00']];
  const document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[{id:'chosen',messages:times.map(([id,spokenAt])=>({id,speaker:'user',text:'자료 원문 대조',spokenAt}))}]};
  const input={document,scope,selectedConversationIds:['chosen'],sourceRef:'synthetic-time-snapshot',expectedDocumentHash:selectedConversationDocumentHash(document)};
  growth.importSelectedConversations(input,{commit:true});
  const results=growth.selectedConversationImports.query('자료',{scope});
  assert.equal(results[0].sourceMessageId,'new-america');assert.equal(results.at(-1).sourceMessageId,'old-korea');
  assert.ok(results.every(item=>item.observedAt===times.find(([id])=>id===item.sourceMessageId)[1]));
  assert.deepEqual(results.slice(1,3).map(x=>x.memoryId),results.slice(1,3).map(x=>x.memoryId).sort());
  const withdrawn=results[0];growth.withdrawImportedConversationMessage({id:withdrawn.memoryId,scope});
  const reopened=open().selectedConversationImports;
  assert.deepEqual(reopened.query('자료',{scope:{...scope,userId:'other'}}),[]);
  const active=reopened.query('자료',{scope});
  assert.equal(active.length,3);assert.ok(!active.some(x=>x.memoryId===withdrawn.memoryId));
  for(const item of active)assert.equal(item.provenance.sourceContentHash,results.find(x=>x.memoryId===item.memoryId).provenance.sourceContentHash);
  assert.equal(growth.importSelectedConversations(input,{commit:true}).withdrawn,1);
 }finally{for(const store of stores)store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});}
});
