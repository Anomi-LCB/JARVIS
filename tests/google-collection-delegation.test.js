import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {GoogleCollectionDelegation} from '../packages/core/src/personal-operations/google-collection-delegation.js';
import {createManagedGoogleSync} from '../packages/core/src/personal-operations/google-sync-service.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-collection-scope-'));let now=new Date('2026-10-08T00:00:00Z'),revision='revision-1',reads=0,onRead=()=>{},email='isolated@example.test';
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>now}),budget=new PersonalMandateBudget(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const client={configured:()=>true,authorizationBinding:()=>({connectionId:'connection-1',revision}),account:async()=>{reads++;onRead();return email;}};
 const delegation=new GoogleCollectionDelegation({store,budget,currentBinding:()=>client.authorizationBinding(),readAccount:()=>client.account()});
 const input={requestId:'scope-request-1',provider:'gmail',scope:'gmail-all-message-metadata-v1',connectionId:'connection-1',revision:'revision-1',maxPages:10,validFrom:'2026-10-08T00:00:00Z',expiresAt:'2026-10-09T00:00:00Z',replaceMandateId:null};
 const job=id=>({provider:'gmail',scope:input.scope,account:'isolated@example.test',connectionId:'connection-1',revision:'revision-1',mandateId:id});
 return {root,store,budget,client,delegation,input,job,reads:()=>reads,setRevision:x=>revision=x,setClock:x=>now=new Date(x),onRead:fn=>onRead=fn,setAccount:x=>email=x};
}
test('collection policy cannot be satisfied by an existing bounded date mandate',async t=>{
 const f=fixture(t),old=f.store.createMandate({action:'google.inbox.read',target:'google:gmail',currency:'KRW',maxAmountMinor:0,validFrom:f.input.validFrom,expiresAt:f.input.expiresAt});
 assert.throws(()=>f.delegation.check(f.job(old.id)),/A_GOOGLE_COLLECTION_SCOPE_DENIED/);
 assert.equal(f.delegation.status()[0].status,'not-configured');assert.equal(f.reads(),0);
 const receipt=await f.delegation.configure(f.input);assert.equal(receipt.collectionStarted,false);assert.equal(receipt.executionAuthority,false);
 assert.equal(f.delegation.check(f.job(receipt.mandateId)).scopeVerified,true);assert.equal(f.delegation.status()[0].adapterVerified,false);
 assert.equal(f.budget.summary(receipt.mandateId).maxCalls,10);assert.equal(f.store.evaluateMandate(old.id,{action:'google.inbox.read',target:'google:gmail',currency:'KRW',amountMinor:0}).matches,true);
 assert.doesNotMatch(JSON.stringify(f.delegation.status()),/isolated@example|revision-1|connection-1/);
});
test('replay after revocation is a historical acknowledgement and never rearms the grant',async t=>{
 const f=fixture(t),r=await f.delegation.configure(f.input);f.delegation.revoke({provider:'gmail',expectedMandateId:r.mandateId});
 const calls=f.reads(),ack=await f.delegation.configure(f.input);assert.equal(ack.replayed,true);assert.equal(ack.currentScopeVerified,false);assert.equal(f.reads(),calls);
 assert.throws(()=>f.delegation.check(f.job(r.mandateId)),/DENIED/);assert.equal(f.delegation.status()[0].status,'blocked');
 await assert.rejects(f.delegation.configure({...f.input,maxPages:11}),/CONFLICT/);
});
test('scope replacement preserves old accounting and invalidates the old active binding',async t=>{
 const f=fixture(t),first=await f.delegation.configure(f.input),request=f.delegation.request('gmail');
 const reservation=f.budget.reserve({mandateId:first.mandateId,requestId:'previous-page',request});f.budget.begin(reservation.id);f.budget.uncertain(reservation.id);
 const next=await f.delegation.configure({...f.input,requestId:'scope-request-2',replaceMandateId:first.mandateId,maxPages:3});
 assert.throws(()=>f.delegation.check(f.job(first.mandateId)),/DENIED/);assert.equal(f.delegation.check(f.job(next.mandateId)).scopeVerified,true);
 assert.equal(f.budget.get(reservation.id).state,'uncertain');assert.equal(f.budget.summary(first.mandateId).usedOrHeldCalls,1);
 assert.throws(()=>f.delegation.revoke({provider:'gmail',expectedMandateId:first.mandateId}),/CONFLICT/);
});
for(const [name,change] of [
 ['unknown date filter',x=>({...x,timeMin:'2026-10-08T00:00:00Z'})],
 ['wrong provider scope',x=>({...x,scope:'primary-calendar-event-metadata-v1'})],
 ['missing explicit scope',x=>{const {scope,...rest}=x;return rest;}],
 ['invalid date',x=>({...x,expiresAt:'2026-02-30T00:00:00Z'})],
 ['zero page budget',x=>({...x,maxPages:0})],
 ['caller supplied account',x=>({...x,account:'different@example.test'})],
 ['unrecognized sync token',x=>({...x,syncToken:'hidden'})],
 ['unknown mode',x=>({...x,mode:'automatic'})]
])test(`invalid collection registration: ${name} does not read account or write scope`,async t=>{
 const f=fixture(t);await assert.rejects(f.delegation.configure(change(f.input)),/A_GOOGLE_COLLECTION_SCOPE_DENIED/);
 assert.equal(f.reads(),0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_scopes').get().n,0);
});
test('accessor fields are rejected without executing getter',async t=>{
 const f=fixture(t);let invoked=0;const input={...f.input};Object.defineProperty(input,'scope',{enumerable:true,get(){invoked++;return f.input.scope;}});
 await assert.rejects(f.delegation.configure(input));assert.equal(invoked,0);assert.equal(f.reads(),0);
});
for(const scenario of ['connection changes','caller revoked','expires during identity','invalid account'])test(`${scenario} during identity read cannot commit`,async t=>{
 const f=fixture(t);let authorized=true;
 f.onRead(()=>{if(scenario==='connection changes')f.setRevision('revision-2');if(scenario==='caller revoked')authorized=false;if(scenario==='expires during identity')f.setClock('2026-10-10T00:00:00Z');if(scenario==='invalid account')f.setAccount('invalid');});
 await assert.rejects(f.delegation.configure(f.input,{authorize:()=>authorized}));assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_requests').get().n,0);
});
test('scope rechecks account, connection revision, expiry, corruption and provider before a future dispatch',async t=>{
 const f=fixture(t),r=await f.delegation.configure(f.input),job=f.job(r.mandateId);
 for(const changed of [{...job,account:'other@example.test'},{...job,provider:'google-calendar'},{...job,revision:'other'},{...job,scope:'wrong'}])assert.throws(()=>f.delegation.check(changed));
 f.setRevision('new');assert.throws(()=>f.delegation.check(job));f.setRevision('revision-1');f.setClock('2026-10-09T00:00:00Z');assert.throws(()=>f.delegation.check(job));f.setClock('2026-10-08T00:00:00Z');
 f.store.db.prepare("UPDATE personal_google_collection_scopes SET body='{}'").run();assert.throws(()=>f.delegation.check(job));assert.equal(f.delegation.status()[0].status,'blocked');
});
test('failed scope archive insertion rolls back mandate, limit and active binding together',async t=>{
 const f=fixture(t);f.store.db.exec("CREATE TRIGGER scope_fail BEFORE INSERT ON personal_google_collection_requests BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 await assert.rejects(f.delegation.configure(f.input));for(const table of ['personal_mandates','personal_google_collection_scopes','personal_budget_limits','personal_google_collection_bindings'])assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
test('managed factory exposes separate authenticated collection setup without dispatching collection',async t=>{
 const f=fixture(t),sync=createManagedGoogleSync({store:f.store,client:f.client,requireMandates:true}),server=createCoreServer(undefined,{adminToken:'scope-admin',googleSync:sync});
 const a=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${a.port}/personal-google/collection-delegation`;t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(url)).status,401);const headers={authorization:'Bearer scope-admin','content-type':'application/json'};
 assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer scope-admin'},body:JSON.stringify(f.input)})).status,415);
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(f.input)});assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.collectionStarted,false);
 const statusResponse=await fetch(url,{headers});assert.equal(statusResponse.headers.get('cache-control'),'no-store');const status=await statusResponse.json();assert.equal(status.items[0].status,'scope-ready');assert.equal(status.adapterVerified,false);assert.equal(f.reads(),1);
 const revoke=await fetch(url+'/revoke',{method:'POST',headers,body:JSON.stringify({provider:'gmail',expectedMandateId:receipt.mandateId})});assert.equal(revoke.status,200);assert.equal((await revoke.json()).providerGrantRevoked,false);
});

test('independent process reads durable scope and rejects it after revocation without account calls',async t=>{
 const f=fixture(t),r=await f.delegation.configure(f.input),path=join(f.root,'probe.json');
 writeFileSync(path,JSON.stringify({dbPath:join(f.root,'ops.sqlite'),now:f.input.validFrom,binding:f.client.authorizationBinding(),job:f.job(r.mandateId)}));
 const run=()=>{const result=spawnSync(process.execPath,['tests/fixtures/google-collection-scope-probe.mjs',path],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 assert.deepEqual(run(),{status:'scope-checked',scopeVerified:true,executionAuthority:false,accountCalls:0});
 f.delegation.revoke({provider:'gmail',expectedMandateId:r.mandateId});assert.deepEqual(run(),{status:'denied',accountCalls:0,executionAuthority:false});
});

test('Calendar and Gmail collection scopes have independent grants and accounting',async t=>{
 const f=fixture(t),gmail=await f.delegation.configure(f.input),calendar=await f.delegation.configure({...f.input,provider:'google-calendar',scope:'primary-calendar-event-metadata-v1',requestId:'calendar-scope'});
 assert.notEqual(gmail.mandateId,calendar.mandateId);
 assert.equal(f.delegation.check({...f.job(calendar.mandateId),provider:'google-calendar',scope:'primary-calendar-event-metadata-v1'}).scopeVerified,true);
 f.delegation.revoke({provider:'gmail',expectedMandateId:gmail.mandateId});assert.equal(f.delegation.status()[1].status,'scope-ready');
});

test('two registrations with the same prior version cannot both replace it',async t=>{
 const f=fixture(t);const results=await Promise.allSettled([f.delegation.configure(f.input),f.delegation.configure({...f.input,requestId:'competing-request'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_requests').get().n,1);
});
