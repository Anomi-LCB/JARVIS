import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalSourceInbox,normalizeConnectorPage } from '../packages/core/src/personal-operations/source-inbox.js';
import { PersonalImportWorker } from '../packages/core/src/personal-operations/import-worker.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-import-'));const store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')});const inbox=new PersonalSourceInbox(store);const worker=new PersonalImportWorker({inbox,directory:root});t.after(async()=>{await worker.stop();store.close();rmSync(root,{recursive:true,force:true});});return {root,store,inbox,worker};}
const page={provider:'gmail',account:'test',scope:'fixed-window',observedAt:'2026-09-13T00:00:00Z',result:{emails:[{id:'1',subject:'업무'}],next_page_token:'next'}};
test('local worker imports once across restarts, serializes overlap and isolates malformed files',async t=>{
  const f=fixture(t);writeFileSync(join(f.root,'page.json'),JSON.stringify(page));writeFileSync(join(f.root,'bad.json'),'{bad');
  const [a,b]=await Promise.all([f.worker.run(),f.worker.run()]);assert.equal(a.processedFiles,1);assert.equal(b.processedFiles,1);assert.equal(a.failedFiles,1);
  const restarted=new PersonalImportWorker({inbox:f.inbox,directory:f.root});assert.equal((await restarted.run()).processedFiles,0);assert.equal(f.inbox.list().length,1);
  assert.equal(f.store.summary().commitments.length,0);
});
test('replaying older successful pages after cursor advancement does not rewind or duplicate',t=>{
  const {inbox}=fixture(t);const first=normalizeConnectorPage(page);inbox.ingest(first);
  inbox.ingest({...first,cursor:'next',nextCursor:null,items:[{id:'2',title:'두 번째'}]});
  assert.equal(inbox.ingest(first).replayed,true);assert.equal(inbox.list().length,2);
  assert.equal(inbox.ingest({...first,cursor:null,nextCursor:null,items:[]}).imported,0);
});
test('inbox HTTP requires auth and persists explicit acceptance exactly once',async t=>{
  const f=fixture(t);f.inbox.ingest(normalizeConnectorPage(page));
  const server=createCoreServer(undefined,{adminToken:'inbox-test',personalInbox:f.inbox,personalImportWorker:f.worker});
  const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${address.port}/personal-inbox`;
  assert.equal((await fetch(url)).status,401);
  const headers={authorization:'Bearer inbox-test','content-type':'application/json'};
  const data=await fetch(url,{headers}).then(r=>r.json());assert.equal(data.worker.remoteSyncEnabled,false);
  const body=JSON.stringify({id:data.items[0].id,dueAt:'2026-09-14T00:00:00+09:00'});
  for(let i=0;i<2;i++)assert.equal((await fetch(url+'/accept',{method:'POST',headers,body})).status,200);
  assert.equal(f.store.summary().commitments.length,1);
});
