import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
test('SQL scope prefilter retains normalized workspace variants and isolates workspace, owner and conversation',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-scoped-storage-'));const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const base={userId:'owner',workspaceRoot:root,conversationId:null};
 for(const [id,scope] of [['same',base],['normalized',{...base,workspaceRoot:root+'/.'}],['other-root',{...base,workspaceRoot:join(root,'other')}],['conversation',{...base,conversationId:'thread'}],['other-owner',{...base,userId:'other'}]])
  store.saveEvent({eventId:id,taskId:id,eventType:'task.created',createdAt:'2026-02-20T00:00:00.000Z',fingerprint:id,source:{module:'CORE',memoryScope:scope},payload:{rawText:'合成'},trustBoundary:{userProvided:true},learningFlags:{}});
 assert.deepEqual(store.allEvents({scope:base}).map(x=>x.eventId),['same','normalized']);
 assert.deepEqual(store.allEvents({scope:{...base,conversationId:'thread'}}).map(x=>x.eventId),['conversation']);
 assert.deepEqual(store.allEvents({scope:{...base,workspaceRoot:join(root,'other')}}).map(x=>x.eventId),['other-root']);
 assert.deepEqual(store.allEvents({scope:{...base,userId:'other'}}).map(x=>x.eventId),['other-owner']);
 assert.deepEqual(store.allEvents({scope:{userId:'owner'}}),[]);assert.equal(store.allEvents().length,5);
});
