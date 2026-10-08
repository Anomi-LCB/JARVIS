import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {GoogleSyncEvidence} from '../packages/core/src/personal-operations/google-sync-evidence.js';
import {GoogleInboxSync} from '../packages/core/src/personal-operations/google-sync.js';
const validity={validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'};
function setup(t){const root=mkdtempSync(join(tmpdir(),'jarvis-google-evidence-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store),budget=new PersonalMandateBudget(store),evidence=new GoogleSyncEvidence({store,budget});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,inbox,budget,evidence};}
function client(page){return {configured:()=>true,account:async()=> 'private@example.test',page};}
const empty={items:[],nextCursor:null};
test('page quota stops next Gmail page, independent calendar commits, evidence omits source contents',async t=>{
 const f=setup(t);f.evidence.configure({...validity,provider:'gmail',maxPages:1});let reads=0;const c=client(async j=>{if(j.provider==='google-calendar')return empty;reads++;return {items:[{id:'private-id',title:'private title'}],nextCursor:'page-2'};});
 const state=await new GoogleInboxSync({...f,client:c}).run();assert.equal(state.status,'degraded');assert.equal(reads,1);assert.equal(state.providers.gmail.code,'A_BUDGET_LIMIT_EXCEEDED');assert.equal(state.providers['google-calendar'].status,'window-complete');assert.equal(f.evidence.status()[0].committedPages,1);assert.equal(f.inbox.list().length,1);
 assert.doesNotMatch(JSON.stringify(f.evidence.status()),/private|page-2/);
});
test('retry after provider failure keeps page identity and counts attempts across runner reload',async t=>{
 const f=setup(t),q=f.evidence.configure({...validity,provider:'gmail',maxPages:1});let fail=true;
 const c=client(async j=>{if(j.provider==='gmail'&&fail)throw Error('A_GOOGLE_API_HTTP_429');return empty;});
 await new GoogleInboxSync({...f,client:c}).run();assert.equal(f.evidence.status()[0].latest.state,'failed');fail=false;await new GoogleInboxSync({...f,evidence:new GoogleSyncEvidence(f),client:c}).run();
 const status=f.evidence.status()[0];assert.equal(status.pages,1);assert.equal(status.attempts,2);assert.equal(status.committedPages,1);assert.equal(f.budget.summary(q.mandate.id).usedOrHeldCalls,1);
});
test('receipt failure rolls back source rows, cursor checkpoint and settlement together',async t=>{
 const f=setup(t),q=f.evidence.configure({...validity,provider:'gmail',maxPages:1}),commit=f.evidence.commit.bind(f.evidence);let fail=true;
 f.evidence.commit=(ctx,count)=>{commit(ctx,count);if(fail)throw Error('A_TEST_DISK_FAILURE');};
 const c=client(async j=>j.provider==='gmail'?{items:[{id:'one',title:'One'}],nextCursor:null}:empty);
 await new GoogleInboxSync({...f,client:c}).run();assert.equal(f.inbox.list().length,0);assert.equal(f.evidence.status()[0].committedPages,0);
 const row=f.store.db.prepare('SELECT state FROM personal_budget_reservations WHERE mandate_id=?').get(q.mandate.id);assert.equal(row.state,'uncertain');fail=false;
 await new GoogleInboxSync({...f,client:c}).run();assert.equal(f.inbox.list().length,1);assert.equal(f.evidence.status()[0].committedPages,1);assert.equal(f.budget.summary(q.mandate.id).usedOrHeldCalls,1);
});
test('revocation during read records received page but stops subsequent dispatch',async t=>{
 const f=setup(t),q=f.evidence.configure({...validity,provider:'gmail',maxPages:3});let reads=0;
 const c=client(async j=>{if(j.provider!=='gmail')return empty;reads++;f.store.revokeMandate(q.mandate.id);return {items:[],nextCursor:'next'};});
 const result=await new GoogleInboxSync({...f,client:c}).run();assert.equal(reads,1);assert.equal(result.providers.gmail.code,'A_GOOGLE_MANDATE_DENIED');assert.equal(f.evidence.status()[0].committedPages,1);
});
test('explicit replacement requires exact current binding and invalid inputs roll back',t=>{
 const f=setup(t),q=f.evidence.configure({...validity,provider:'gmail',maxPages:1});assert.throws(()=>f.evidence.configure({...validity,provider:'gmail',maxPages:2}),/BINDING_CONFLICT/);
 assert.throws(()=>f.evidence.configure({...validity,provider:'gmail',maxPages:2,replaceMandateId:q.mandate.id,expiresAt:validity.validFrom}));assert.equal(f.evidence.status()[0].mandateId,q.mandate.id);
 const replacement=f.evidence.configure({...validity,provider:'gmail',maxPages:2,replaceMandateId:q.mandate.id});assert.equal(f.evidence.status()[0].mandateId,replacement.mandate.id);assert.throws(()=>f.evidence.configure({...validity,provider:'unknown',maxPages:1}));
});
test('no OAuth produces no provider requests or fictional evidence',async t=>{
 const f=setup(t);const c={configured:()=>false,account:async()=>{throw Error('must not run');}};const result=await new GoogleInboxSync({...f,client:c}).run();assert.equal(result.status,'connection-required');assert.equal(result.evidence.every(x=>x.pages===0),true);
});

test('service mandate HTTP endpoint authenticates, binds and rejects silent replacement',async t=>{
 const f=setup(t);const {createCoreServer}=await import('../packages/core/src/main.mjs');const {listenOnFetchSafePort}=await import('../packages/shared/src/http.js');
 const sync=new GoogleInboxSync({...f,client:{configured:()=>false}}),server=createCoreServer(undefined,{adminToken:'evidence-test',googleSync:sync});const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${address.port}/personal-google/mandate`,body=JSON.stringify({...validity,provider:'gmail',maxPages:2}),headers={authorization:'Bearer evidence-test','content-type':'application/json'};
 assert.equal((await fetch(url,{method:'POST',body})).status,401);assert.equal((await fetch(url,{method:'POST',body,headers})).status,200);assert.equal((await fetch(url,{method:'POST',body,headers})).status,409);assert.equal(f.evidence.status()[0].budget.maxCalls,2);
});

test('retry under explicit replacement links proof to the current reservation and retains old hold',t=>{
 const f=setup(t),a=f.evidence.configure({...validity,provider:'gmail',maxPages:1}),job={provider:'gmail',account:'test',observedAt:'2026-09-13T00:00:00Z',cursor:null};const first=f.evidence.before(job);f.evidence.failed(first,'A_GOOGLE_API_HTTP_429');
 const b=f.evidence.configure({...validity,provider:'gmail',maxPages:1,replaceMandateId:a.mandate.id}),second=f.evidence.before(job);f.inbox.ingest({...job,scope:'test',items:[],nextCursor:null},{onCommit:()=>f.evidence.commit(second,0)});
 const row=f.store.db.prepare('SELECT reservation_id FROM personal_google_evidence WHERE id=?').get(second.id);assert.equal(row.reservation_id,second.reservationId);assert.notEqual(first.reservationId,second.reservationId);assert.equal(f.budget.summary(a.mandate.id).usedOrHeldCalls,1);assert.equal(f.budget.summary(b.mandate.id).usedOrHeldCalls,1);
});

test('shared Core/CLI factory enforces persisted mandate and writes durable evidence',async t=>{
 const {createManagedGoogleSync}=await import('../packages/core/src/personal-operations/google-sync-service.js');const f=setup(t);const quota=f.evidence.configure({...validity,provider:'gmail',maxPages:1});let calls=0;
 const c=client(async job=>{if(job.provider==='gmail'){calls++;return {items:[{id:'one',title:'One'}],nextCursor:'next'};}return empty;});
 const first=await createManagedGoogleSync({store:f.store,client:c}).run();assert.equal(first.providers.gmail.code,'A_BUDGET_LIMIT_EXCEEDED');assert.equal(calls,1);assert.equal(f.evidence.status()[0].committedPages,1);
 f.store.revokeMandate(quota.mandate.id);const retry=await createManagedGoogleSync({store:f.store,client:c}).run();assert.equal(retry.providers.gmail.code,'A_GOOGLE_MANDATE_DENIED');assert.equal(calls,1);
});
