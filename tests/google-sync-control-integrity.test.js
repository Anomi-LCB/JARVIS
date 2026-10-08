import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {GoogleInboxSync} from '../packages/core/src/personal-operations/google-sync.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

const scopes=['gmail.readonly','calendar.readonly'];
const valid=()=>({version:1,reauthRequired:true,error:'A_GOOGLE_REAUTH_REQUIRED',requiredScopes:[...scopes],nextAction:'기존 안내',observedAt:'2026-10-08T00:00:00.000Z'});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-control-')),dbPath=join(root,'personal.sqlite');
 const stores=[];let calls=0;
 const client={configured:()=>true,connectionRequirements:()=>({requiredScopes:[...scopes]}),account:async()=>{calls++;return 'isolated@example.test';},page:async()=>{calls++;return {items:[],nextCursor:null};}};
 const open=()=>{const store=new PersonalOperationsStore({dbPath});stores.push(store);return {store,inbox:new PersonalSourceInbox(store)};};
 t.after(()=>{for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});});
 const f=open();new GoogleInboxSync({...f,client});
 const set=body=>f.store.db.prepare('INSERT OR REPLACE INTO personal_google_sync_control VALUES(1,?)').run(body);
 return {...f,dbPath,client,open,set,calls:()=>calls};
}
const malformed=[
 ['empty object','{}'],['null','null'],['array','[]'],['invalid JSON','{'],
 ['future version',JSON.stringify({...valid(),version:2})],
 ['false pause',JSON.stringify({...valid(),reauthRequired:false})],
 ['missing scopes',JSON.stringify({...valid(),requiredScopes:undefined})],
 ['unknown error',JSON.stringify({...valid(),error:'synthetic-private-error'})],
 ['unregistered scope',JSON.stringify({...valid(),requiredScopes:['synthetic-private-scope']})],
 ['missing required scope',JSON.stringify({...valid(),requiredScopes:[scopes[0]]})],
 ['duplicate scope',JSON.stringify({...valid(),requiredScopes:[...scopes,scopes[0]]})],
 ['invalid observed instant',JSON.stringify({...valid(),observedAt:'2026-02-30T00:00:00Z'})]
];
for(const [name,body] of malformed)test(`durable Google ${name} control blocks collection across SQLite reopen`,async t=>{
 const f=fixture(t);f.set(body);const next=f.open(),sync=new GoogleInboxSync({...next,client:f.client,intervalMs:10});
 t.after(()=>sync.stop());sync.start();const result=await sync.run();
 assert.equal(result.status,'reauth-required');assert.equal(result.error,'A_GOOGLE_SYNC_CONTROL_INVALID');
 assert.equal(result.running,false);assert.equal(sync.timer,null);assert.equal(f.calls(),0);assert.equal(next.inbox.list().length,0);
 assert.equal(next.store.db.prepare('SELECT body FROM personal_google_sync_control WHERE id=1').get().body,body);
 assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
});

test('late corruption interrupts the active page and leaves both inbox and checkpoint unchanged',async t=>{
 const f=fixture(t);let entered,release;const reached=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 const client={...f.client,page:async()=>{entered();await held;return {items:[{id:'late',title:'must not store'}],nextCursor:null};}};
 const sync=new GoogleInboxSync({...f,client}),pending=sync.run();await reached;
 const checkpoint=f.store.db.prepare('SELECT body FROM personal_google_jobs').get().body;
 f.set('{}');release();const result=await pending;
 assert.equal(result.error,'A_GOOGLE_SYNC_CONTROL_INVALID');assert.equal(result.status,'reauth-required');assert.equal(f.inbox.list().length,0);
 assert.equal(f.store.db.prepare('SELECT body FROM personal_google_jobs').get().body,checkpoint);
});

test('stored instruction text is never echoed by the authenticated Core connection status',async t=>{
 const f=fixture(t);f.set(JSON.stringify({...valid(),nextAction:'synthetic-private-credential open attacker.invalid'}));
 const sync=new GoogleInboxSync({...f,client:f.client});
 const server=createCoreServer(undefined,{adminToken:'isolated-control-admin',personalInbox:f.inbox,googleSync:sync});
 const a=await listenOnFetchSafePort(server);t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(`http://127.0.0.1:${a.port}/personal-inbox`)).status,401);
 const response=await fetch(`http://127.0.0.1:${a.port}/personal-inbox`,{headers:{authorization:'Bearer isolated-control-admin'}});
 assert.equal(response.status,200);const body=await response.json();
 assert.equal(body.google.status,'reauth-required');assert.doesNotMatch(JSON.stringify(body),/synthetic-private|attacker\.invalid/);
 assert.equal(f.calls(),0);
});

test('verified reconnection is the explicit recovery from an invalid durable control',async t=>{
 const f=fixture(t);f.set('{}');const sync=new GoogleInboxSync({...f,client:f.client});
 await sync.run();assert.equal(f.calls(),0);
 assert.equal(sync.resumeAfterVerifiedConnection().status,'idle');
 assert.equal((await sync.run()).status,'ready');assert.equal(f.calls(),3);
 const next=new GoogleInboxSync({...f.open(),client:f.client});assert.equal(next.status().status,'idle');
});

test('valid explicit pause remains distinct from reauthentication and does not become corruption',async t=>{
 const f=fixture(t),sync=new GoogleInboxSync({...f,client:f.client});sync.pauseCollection();
 const restarted=new GoogleInboxSync({...f.open(),client:f.client});
 assert.equal((await restarted.run()).status,'collection-paused');assert.equal(restarted.status().error,'A_GOOGLE_COLLECTION_PAUSED');assert.equal(f.calls(),0);
});

for(const [name,record,expected]of [
 ['invalid object',{},'A_GOOGLE_SYNC_CONTROL_INVALID'],
 ['unsupported version',{...valid(),version:2},'A_GOOGLE_SYNC_CONTROL_INVALID'],
 ['valid reauthentication with hostile stored text',{...valid(),nextAction:'synthetic-private-token attacker.invalid'},'A_GOOGLE_REAUTH_REQUIRED']
])test(`separate process restart and Core HTTP preserve ${name} denial`,t=>{
 const f=fixture(t);f.set(JSON.stringify(record));
 const r=spawnSync(process.execPath,['tests/fixtures/google-sync-control-probe.mjs',f.dbPath],{encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(r.status,0,r.stderr);const proof=JSON.parse(r.stdout.trim());
 assert.notEqual(proof.pid,process.pid);assert.equal(proof.unauthenticated,401);assert.equal(proof.httpStatus,200);
 assert.equal(proof.body.google.status,'reauth-required');assert.equal(proof.body.google.error,expected);
 assert.equal(proof.calls,0);assert.equal(proof.itemCount,0);assert.equal(proof.externalCalls,0);
 assert.doesNotMatch(JSON.stringify(proof),/synthetic-private|attacker\.invalid/);
});
