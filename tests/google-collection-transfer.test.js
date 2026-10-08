import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {createManagedGoogleSync} from '../packages/core/src/personal-operations/google-sync-service.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
async function fixture(t,{partial=false}={}){
 const root=mkdtempSync(join(tmpdir(),'jarvis-collection-transfer-'));let now=new Date('2026-10-08T00:00:00Z'),calls=0,revision='credential-1',account='isolated@example.test';
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>now});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const client={configured:()=>true,authorizationBinding:()=>({connectionId:'connection',revision}),account:async()=>{calls++;return account;},collectionPage:async(job,{authorize})=>{assert.equal(authorize(),true);calls++;return partial&&job.cursor===null?{items:[{id:'one',title:'첫 자료'}],nextCursor:'page2',nextSyncToken:null,initialToken:null}:{items:[{id:'two',title:'다음 자료'}],nextCursor:null,nextSyncToken:'token',initialToken:null};}};
 const sync=createManagedGoogleSync({store,client,clock:()=>now,requireMandates:true});
 const configure=replace=>sync.collectionDelegation.configure({requestId:replace?'renewal':'initial',provider:'google-calendar',scope:'primary-calendar-event-metadata-v1',connectionId:'connection',revision,maxPages:10,validFrom:now.toISOString(),expiresAt:'2026-10-09T00:00:00Z',replaceMandateId:replace});
 const first=await configure(null);now=new Date('2026-10-08T00:00:01Z');await sync.collectionSync.run('google-calendar',{authorize:()=>true});
 const input={requestId:'transfer',provider:'google-calendar',expectedMandateId:first.mandateId,expectedRevision:2};
 return {store,sync,client,first,input,configure,calls:()=>calls,advance:()=>now=new Date(now.getTime()+1000),setRevision:x=>revision=x,setAccount:x=>account=x,transfer:()=>sync.collectionSync.transfer(input,{authorize:()=>true})};
}
test('renewed grant explicitly transfers partial checkpoint without network, data or old usage loss',async t=>{
 const f=await fixture(t,{partial:true}),oldJob=f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body;
 const renewed=await f.configure(f.first.mandateId),calls=f.calls();await assert.rejects(f.sync.collectionSync.run('google-calendar',{authorize:()=>true}),/BINDING_CHANGED/);
 const result=f.transfer();assert.equal(result.status,'partial');assert.equal(result.collectionStarted,false);assert.equal(f.calls(),calls);
 const next=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(next.cursor,'page2');assert.equal(next.binding.mandateId,renewed.mandateId);
 assert.equal(f.store.db.prepare('SELECT body FROM personal_google_collection_job_history').get().body,oldJob);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_budget_reservations WHERE mandate_id=?').get(f.first.mandateId).n,1);
 f.advance();await f.sync.collectionSync.run('google-calendar',{authorize:()=>true});assert.equal(f.sync.inbox.list().length,2);
});
test('historical transfer replay after revocation never reactivates collection',async t=>{
 const f=await fixture(t),renewed=await f.configure(f.first.mandateId);f.transfer();f.sync.collectionDelegation.revoke({provider:'google-calendar',expectedMandateId:renewed.mandateId});const calls=f.calls();
 assert.equal(f.transfer().replayed,true);assert.equal(f.transfer().currentScopeVerified,false);await assert.rejects(f.sync.collectionSync.run('google-calendar',{authorize:()=>true}),/SCOPE_DENIED/);assert.equal(f.calls(),calls);
 assert.throws(()=>f.sync.collectionSync.transfer({...f.input,expectedRevision:3},{authorize:()=>true}),/CONFLICT/);
});
for(const kind of ['revision','scope','checkpoint','busy','uncertain','caller'])test(`${kind} blocks transfer with original job and accounting preserved`,async t=>{
 const f=await fixture(t);if(kind==='scope')f.setRevision('credential-2');await f.configure(f.first.mandateId);
 if(kind==='checkpoint')f.store.db.prepare('DELETE FROM personal_google_collection_receipts').run();
 if(kind==='busy')f.store.db.prepare('INSERT INTO personal_google_collection_leases SELECT id,?,? FROM personal_google_collection_jobs').run('other-worker',Date.now()+60000);
 if(kind==='uncertain')f.store.db.prepare("UPDATE personal_budget_reservations SET state='uncertain'").run();
 const original=f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body,calls=f.calls();
 const input=kind==='revision'?{...f.input,expectedRevision:1}:f.input;
 assert.throws(()=>f.sync.collectionSync.transfer(input,{authorize:()=>kind!=='caller'}));assert.equal(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body,original);assert.equal(f.calls(),calls);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_job_history').get().n,0);
});
test('transfer insertion failure rolls back archive, receipt and checkpoint together',async t=>{
 const f=await fixture(t);await f.configure(f.first.mandateId);const original=f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body;
 f.store.db.exec("CREATE TRIGGER transfer_fail BEFORE INSERT ON personal_google_collection_transfers BEGIN SELECT RAISE(ABORT,'synthetic'); END");assert.throws(f.transfer);assert.equal(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body,original);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_job_history').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_receipts').get().n,1);
});
test('reset-required remains blocked after a mandate transfer',async t=>{
 const f=await fixture(t);f.store.db.prepare('UPDATE personal_google_collection_jobs SET body=json_set(body,\'$.status\',\'reset-required\')').run();await f.configure(f.first.mandateId);assert.equal(f.transfer().status,'reset-required');await assert.rejects(f.sync.collectionSync.run('google-calendar',{authorize:()=>true}),/RESET_REQUIRED/);
});
test('Core transfer requires ADMIN and performs no implicit provider read',async t=>{
 const f=await fixture(t);await f.configure(f.first.mandateId);const server=createCoreServer(undefined,{adminToken:'isolated-admin',googleSync:f.sync}),a=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${a.port}/personal-google/collection-transfer`;t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(url,{method:'POST'})).status,401);const headers={authorization:'Bearer isolated-admin','content-type':'application/json'},calls=f.calls();
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...f.input,syncToken:'injected'})})).status,409);
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(f.input)});assert.equal(response.status,200);assert.equal((await response.json()).collectionStarted,false);assert.equal(f.calls(),calls);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('changed account cannot adopt another account checkpoint',async t=>{
 const f=await fixture(t);f.setAccount('different@example.test');await f.configure(f.first.mandateId);assert.throws(f.transfer,/STATE_MISSING/);assert.equal(f.sync.inbox.list().length,1);
});
test('caller revoked inside the transaction cannot transfer a verified checkpoint',async t=>{
 const f=await fixture(t);await f.configure(f.first.mandateId);let checks=0;const original=f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body;
 assert.throws(()=>f.sync.collectionSync.transfer(f.input,{authorize:()=>++checks<3}),/CALLER_DENIED/);assert.equal(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body,original);
});
test('getter payload is rejected without invoking external code or credentials',async t=>{
 const f=await fixture(t);let invoked=false;const input={...f.input};Object.defineProperty(input,'requestId',{enumerable:true,get(){invoked=true;throw Error('must not run');}});const calls=f.calls();
 assert.throws(()=>f.sync.collectionSync.transfer(input,{authorize:()=>true}),/INPUT_INVALID/);assert.equal(invoked,false);assert.equal(f.calls(),calls);
});
test('same active mandate cannot be used to create fake transfer revisions',async t=>{
 const f=await fixture(t);assert.throws(f.transfer,/BINDING_CHANGED/);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_transfers').get().n,0);
});
test('collection state exposes safe renewal versions without account or pagination tokens and is ADMIN-only',async t=>{
 const f=await fixture(t,{partial:true});await f.configure(f.first.mandateId);const state=f.sync.collectionSync.status();assert.equal(state.providers[1].status,'renewal-required');assert.deepEqual(state.providers[1].transfer,{expectedMandateId:f.first.mandateId,expectedRevision:2});assert.doesNotMatch(JSON.stringify(state),/isolated@example|page2|syncToken|initialToken/);
 const server=createCoreServer(undefined,{adminToken:'isolated-admin',googleSync:f.sync}),a=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${a.port}/personal-google/collection-state`;t.after(()=>new Promise(r=>server.close(r)));assert.equal((await fetch(url)).status,401);const response=await fetch(url,{headers:{authorization:'Bearer isolated-admin'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).providerObservationVerified,false);
});
