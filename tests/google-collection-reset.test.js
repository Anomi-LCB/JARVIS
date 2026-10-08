import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {createManagedGoogleSync} from '../packages/core/src/personal-operations/google-sync-service.js';
import {createCoreServer} from '../packages/core/src/main.mjs';import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-reset-'));let now=new Date('2026-10-08T00:00:00Z'),fail=false,calls=0;
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>now});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const client={configured:()=>true,authorizationBinding:()=>({connectionId:'isolated',revision:'1'}),account:async()=> 'isolated@example.test',collectionPage:async(job,{authorize})=>{assert.equal(authorize(),true);calls++;if(fail)throw Error('A_GOOGLE_COLLECTION_RESET_REQUIRED');return {items:[{id:job.mode==='initial'?'new':'delta',title:'격리 자료'}],nextCursor:null,nextSyncToken:'token',initialToken:null};}};
 const sync=createManagedGoogleSync({store,client,clock:()=>now,requireMandates:true});
 const grant=await sync.collectionDelegation.configure({requestId:'grant',provider:'google-calendar',scope:'primary-calendar-event-metadata-v1',connectionId:'isolated',revision:'1',maxPages:10,validFrom:now.toISOString(),expiresAt:'2026-10-09T00:00:00Z',replaceMandateId:null});
 const run=()=>{now=new Date(now.getTime()+1000);return sync.collectionSync.run('google-calendar',{authorize:()=>true});};await run();fail=true;await assert.rejects(run(),/RESET_REQUIRED/);
 const job=()=>JSON.parse(store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body),input={requestId:'reset',provider:'google-calendar',expectedMandateId:grant.mandateId,expectedRevision:job().revision};
 return {store,sync,job,input,run,calls:()=>calls,allow:()=>fail=false,reset:()=>sync.collectionSync.reset(input,{authorize:()=>true})};
}
test('expired response is durable failure accounting, never ingestion success or refunded call',async t=>{
 const f=await fixture(t);assert.equal(f.job().status,'reset-required');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_failures').get().n,1);
 assert.equal(f.sync.inbox.list().length,1);const usage=f.sync.collectionSync.budget.summary(f.input.expectedMandateId);assert.equal(usage.usedOrHeldCalls,2);
 const failed=f.store.db.prepare("SELECT receipt_ref FROM personal_budget_reservations WHERE receipt_ref LIKE 'google-collection-failure:%'").get();assert.ok(failed);
});
test('reset archives observations and clears active cache atomically without provider calls, then full sync succeeds',async t=>{
 const f=await fixture(t),calls=f.calls(),original=f.job(),result=f.reset();assert.equal(result.status,'recollection-required');assert.equal(result.collectionStarted,false);assert.equal(f.calls(),calls);assert.equal(f.sync.inbox.list().length,0);
 const archive=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_reset_archives').get().body);assert.equal(archive.items.length,1);assert.equal(archive.job.syncToken,original.syncToken);assert.equal(f.job().mode,'initial');assert.equal(f.job().syncToken,null);
 f.allow();await f.run();assert.equal(f.job().status,'complete');assert.equal(f.sync.inbox.list().length,1);assert.equal(f.sync.collectionSync.budget.summary(f.input.expectedMandateId).usedOrHeldCalls,3);
});
for(const condition of ['revision','busy','uncertain','checkpoint','caller','expiration'])test(`${condition} blocks reset and preserves original observation cache`,async t=>{
 const f=await fixture(t);if(condition==='busy')f.store.db.prepare('INSERT INTO personal_google_collection_leases SELECT id,?,? FROM personal_google_collection_jobs').run('other',Date.now()+10000);
 if(condition==='uncertain')f.store.db.prepare("UPDATE personal_budget_reservations SET state='uncertain' WHERE receipt_ref LIKE 'google-collection-failure:%'").run();
 if(condition==='checkpoint')f.store.db.prepare('DELETE FROM personal_google_collection_receipts').run();
 if(condition==='expiration')f.store.db.prepare('DELETE FROM personal_google_collection_failures').run();
 const original=f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body;
 assert.throws(()=>f.sync.collectionSync.reset({...f.input,...(condition==='revision'?{expectedRevision:1}:{})},{authorize:()=>condition!=='caller'}));assert.equal(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body,original);assert.equal(f.sync.inbox.list().length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_reset_archives').get().n,0);
});
test('reset acknowledgement replay cannot clear newly collected data or reactivate revoked scope',async t=>{
 const f=await fixture(t);f.reset();f.allow();await f.run();const original=f.job();f.sync.collectionDelegation.revoke({provider:'google-calendar',expectedMandateId:f.input.expectedMandateId});assert.equal(f.reset().replayed,true);assert.deepEqual(f.job(),original);assert.equal(f.sync.inbox.list().length,1);
});
test('reset archive and active cache roll back when acknowledgement persistence fails',async t=>{
 const f=await fixture(t);f.store.db.exec("CREATE TRIGGER reset_failure BEFORE INSERT ON personal_google_collection_resets BEGIN SELECT RAISE(ABORT,'synthetic'); END");assert.throws(f.reset);assert.equal(f.job().status,'reset-required');assert.equal(f.sync.inbox.list().length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_reset_archives').get().n,0);
});
test('accepted commitments survive reset while old source observations remain only in the archive',async t=>{
 const f=await fixture(t),item=f.sync.inbox.list()[0],commitment=f.sync.inbox.accept({id:item.id,dueAt:'2026-10-08T10:00:00Z'});
 const before=f.store.db.prepare('SELECT * FROM personal_commitments WHERE id=?').get(commitment.id);f.reset();assert.deepEqual(f.store.db.prepare('SELECT * FROM personal_commitments WHERE id=?').get(commitment.id),before);assert.equal(f.sync.inbox.list().length,0);
 const archive=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_reset_archives').get().body);assert.equal(archive.items[0].commitment_id,commitment.id);assert.ok(archive.items[0].accepted_source_hash);
 assert.equal(f.sync.collectionSync.status().providers[1].status,'not-started');
});
test('Core reset requires admin, verifies expected revision, never dispatches collection and returns no-store',async t=>{
 const f=await fixture(t),server=createCoreServer(undefined,{adminToken:'isolated-admin',googleSync:f.sync}),address=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${address.port}/personal-google/collection-reset`;t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(url,{method:'POST'})).status,401);const headers={authorization:'Bearer isolated-admin','content-type':'application/json'},calls=f.calls();
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...f.input,expectedRevision:1})})).status,409);
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(f.input)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).status,'recollection-required');assert.equal(f.calls(),calls);
});
