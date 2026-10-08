import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GoogleReadClient} from '../packages/core/src/personal-operations/google-client.js';
import {IntegrationConnectorRegistry,IntegrationCredentialVault} from '../packages/core/src/personal-operations/integration-security.js';
import {createGoogleVaultReadClient,GOOGLE_CONNECTOR_ID,GOOGLE_READ_SCOPES} from '../packages/core/src/personal-operations/google-vault-client.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {createManagedGoogleSync} from '../packages/core/src/personal-operations/google-sync-service.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {unprotectWithWindowsDpapi} from '../packages/shared/src/product-runtime-secrets.js';
async function fixture(t,{maxPages=10,provider='google-calendar'}={}){
 const root=mkdtempSync(join(tmpdir(),'jarvis-collection-sync-'));let now=new Date('2026-10-08T00:00:00Z'),responses=[],pageCalls=0,allCalls=0,hook=null;
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>now});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const client=new GoogleReadClient({credentials:{clientId:'synthetic',clientSecret:'synthetic',refreshToken:'synthetic'},fetchImpl:async(input)=>{
  allCalls++;const url=new URL(input);if(url.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'synthetic-access',expires_in:3600});
  if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'isolated@example.test',historyId:'100'});
  pageCalls++;if(hook)await hook(url);const reply=responses.shift();if(!reply)throw Error('No synthetic response prepared');return reply instanceof Response?reply:Response.json(reply);
 }});client.authorizationBinding=()=>({connectionId:'collection-connection',revision:'revision-1'});
 const sync=createManagedGoogleSync({store,client,clock:()=>now,requireMandates:true});
 const receipt=await sync.collectionDelegation.configure({requestId:'collection-grant',provider,scope:provider==='gmail'?'gmail-all-message-metadata-v1':'primary-calendar-event-metadata-v1',connectionId:'collection-connection',revision:'revision-1',maxPages,validFrom:'2026-10-08T00:00:00Z',expiresAt:'2026-10-09T00:00:00Z',replaceMandateId:null});
 now=new Date('2026-10-08T00:00:01Z');
 return {root,store,client,sync,receipt,setResponses:x=>responses=x,setHook:x=>hook=x,advance:()=>now=new Date(now.getTime()+1000),pageCalls:()=>pageCalls,allCalls:()=>allCalls,run:()=>sync.collectionSync.run(provider,{authorize:()=>true}),next:()=>createManagedGoogleSync({store,client,clock:()=>now,requireMandates:true})};
}
test('Calendar pages, final token, actual SQLite verification and budget commit together across a new runner',async t=>{
 const f=await fixture(t);f.setResponses([{items:[{id:'e1',summary:'첫 일정'}],nextPageToken:'page-2'}]);
 const first=await f.run();assert.equal(first.status,'partial');assert.equal(first.verification.status,'passed');
 let job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(job.syncToken,null);assert.equal(job.cursor,'page-2');
 f.advance();f.setResponses([{items:[{id:'e2',summary:'둘째 일정'}],nextSyncToken:'baseline-token'}]);
 const next=f.next();const second=await next.collectionSync.run('google-calendar',{authorize:()=>true});assert.equal(second.status,'window-complete');
 job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(job.syncToken,'baseline-token');assert.equal(f.sync.inbox.list().length,2);
 f.advance();f.setHook(url=>assert.equal(url.searchParams.get('syncToken'),'baseline-token'));f.setResponses([{items:[{id:'e1',status:'cancelled'}],nextSyncToken:'next-token'}]);
 await f.run();assert.equal(f.sync.inbox.list().find(x=>x.title==='(제목 없음)').withdrawn,true);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_receipts').get().n,3);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM personal_budget_reservations WHERE state='settled'").get().n,3);
 assert.doesNotMatch(JSON.stringify(second),/baseline-token|page-2|isolated@example/);
});
test('Gmail initial watermark and history deletion commit through the same durable path',async t=>{
 const f=await fixture(t,{provider:'gmail'});f.setResponses([{messages:[{id:'mail'}]},{id:'mail',payload:{headers:[{name:'Subject',value:'중요 메일'}]}}]);
 await f.run();let job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(job.syncToken,'100');
 f.advance();f.setResponses([{historyId:'102',history:[{id:'101',messagesDeleted:[{message:{id:'mail'}}]}]},new Response('',{status:404})]);
 const result=await f.run();assert.equal(result.status,'window-complete');assert.equal(f.sync.inbox.list()[0].withdrawn,true);assert.equal(f.sync.inbox.list().length,1);
 job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(job.syncToken,'102');
});
test('receipt write failure rolls back items, next token, verification and accounting; retry keeps one reservation',async t=>{
 const f=await fixture(t);f.store.db.exec("CREATE TRIGGER receipt_fail BEFORE INSERT ON personal_google_collection_receipts BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 f.setResponses([{items:[{id:'event',summary:'일정'}],nextSyncToken:'token'}]);await assert.rejects(f.run());
 assert.equal(f.sync.inbox.list().length,0);assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body).syncToken,null);
 assert.equal(f.store.db.prepare('SELECT state FROM personal_budget_reservations').get().state,'uncertain');
 f.store.db.exec('DROP TRIGGER receipt_fail');f.advance();f.setResponses([{items:[{id:'event',summary:'일정'}],nextSyncToken:'token'}]);await f.run();
 assert.equal(f.sync.inbox.list().length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_budget_reservations').get().n,1);
});
for(const scenario of ['pause','revoke','generation','caller'])test(`${scenario} during response prevents storing a late page`,async t=>{
 const f=await fixture(t);let caller=true;f.setHook(()=>{if(scenario==='pause')f.sync.pauseCollection();if(scenario==='revoke')f.sync.collectionDelegation.revoke({provider:'google-calendar',expectedMandateId:f.receipt.mandateId});if(scenario==='generation')f.sync.resumeAfterVerifiedConnection();if(scenario==='caller')caller=false;});
 f.setResponses([{items:[{id:'event'}],nextSyncToken:'token'}]);await assert.rejects(f.sync.collectionSync.run('google-calendar',{authorize:()=>caller}));
 assert.equal(f.sync.inbox.list().length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_receipts').get().n,0);
});
test('expired token is retained as reset-required and never silently restarts full collection',async t=>{
 const f=await fixture(t);f.setResponses([{items:[{id:'retained'}],nextSyncToken:'expired-token'}]);await f.run();f.advance();f.setResponses([new Response('',{status:410})]);
 await assert.rejects(f.run(),/RESET_REQUIRED/);const calls=f.pageCalls();await assert.rejects(f.run(),/RESET_REQUIRED/);assert.equal(f.pageCalls(),calls);
 const job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(job.syncToken,'expired-token');assert.equal(job.status,'reset-required');assert.equal(f.sync.inbox.list().length,1);
});
test('page quota exhaustion prevents provider access and retains last token',async t=>{
 const f=await fixture(t,{maxPages:1});f.setResponses([{items:[],nextSyncToken:'retained-token'}]);await f.run();f.advance();const calls=f.pageCalls();
 await assert.rejects(f.run(),/BUDGET_LIMIT_EXCEEDED/);assert.equal(f.pageCalls(),calls);assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body).syncToken,'retained-token');
});
test('two workers cannot read the same collection page concurrently',async t=>{
 const f=await fixture(t);let entered,release;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);f.setHook(async()=>{entered();await wait;});f.setResponses([{items:[],nextSyncToken:'token'}]);
 const first=f.run();await ready;const second=f.next();await assert.rejects(second.collectionSync.run('google-calendar',{authorize:()=>true}),/BUSY/);release();await first;assert.equal(f.pageCalls(),1);
});
test('Core explicit page endpoint requires ADMIN and commits one page with a separate grant',async t=>{
 const f=await fixture(t),server=createCoreServer(undefined,{adminToken:'collection-admin',googleSync:f.sync});const a=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${a.port}/personal-google/collection-sync`;t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(url,{method:'POST'})).status,401);const headers={authorization:'Bearer collection-admin','content-type':'application/json'};
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({provider:'google-calendar',syncToken:'injected'})})).status,409);assert.equal(f.pageCalls(),0);
 f.setResponses([{items:[{id:'event',summary:'실제 로컬 저장'}],nextSyncToken:'token'}]);const r=await fetch(url,{method:'POST',headers,body:JSON.stringify({provider:'google-calendar'})});assert.equal(r.status,200);assert.equal((await r.json()).verification.status,'passed');assert.equal(f.sync.inbox.list().length,1);
});

test('incremental pagination keeps the original token until the final page',async t=>{
 const f=await fixture(t);f.setResponses([{items:[],nextSyncToken:'first-token'}]);await f.run();f.advance();
 f.setResponses([{items:[{id:'change-1'}],nextPageToken:'history-page-2'}]);await f.run();let job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(job.syncToken,'first-token');assert.equal(job.cursor,'history-page-2');
 f.advance();f.setHook(url=>{assert.equal(url.searchParams.get('syncToken'),'first-token');assert.equal(url.searchParams.get('pageToken'),'history-page-2');});f.setResponses([{items:[{id:'change-2'}],nextSyncToken:'second-token'}]);await f.run();job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);assert.equal(job.syncToken,'second-token');
});
for(const kind of ['token','receipt','stream'])test(`corrupt ${kind} cannot silently resume from an unverified checkpoint`,async t=>{
 const f=await fixture(t);f.setResponses([{items:[],nextSyncToken:'original-token'}]);await f.run();f.advance();const calls=f.pageCalls();
 if(kind==='token'){const job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body);job.syncToken='injected-token';f.store.db.prepare('UPDATE personal_google_collection_jobs SET body=?').run(JSON.stringify(job));}
 if(kind==='receipt')f.store.db.prepare('DELETE FROM personal_google_collection_receipts').run();
 if(kind==='stream')f.store.db.prepare("UPDATE personal_source_streams SET last_hash='wrong'").run();
 await assert.rejects(f.run(),/CHECKPOINT_UNVERIFIED/);assert.equal(f.pageCalls(),calls);
});
test('independent SQLite verification failure rolls back both item and sync token',async t=>{
 const f=await fixture(t);f.sync.collectionSync.inbox.verifyPage=()=>{throw Error('Synthetic independent verification failure');};f.setResponses([{items:[{id:'event'}],nextSyncToken:'token'}]);
 await assert.rejects(f.run());assert.equal(f.sync.inbox.list().length,0);assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body).syncToken,null);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_collection_receipts').get().n,0);
});
test('expired worker cannot commit after another worker takes over its lease',async t=>{
 const f=await fixture(t);let entered,release;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);let count=0;
 f.setHook(async()=>{if(++count===1){entered();await wait;}});f.setResponses([{items:[{id:'new-worker'}],nextSyncToken:'new-token'},{items:[{id:'expired-worker'}],nextSyncToken:'expired-token'}]);
 const first=f.run(),firstResult=first.catch(e=>e);await ready;f.store.db.prepare('UPDATE personal_google_collection_leases SET expires=0').run();
 const second=f.next();await second.collectionSync.run('google-calendar',{authorize:()=>true});release();assert.match((await firstResult).message,/LEASE_LOST/);
 assert.equal(f.sync.inbox.list().length,1);assert.equal(f.sync.inbox.list()[0].title,'(제목 없음)');assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body).syncToken,'new-token');
});
test('real Windows DPAPI vault, managed factory and provider wire fixture collect under explicit metadata delegation',async t=>{
 if(process.platform!=='win32'){t.skip('Windows DPAPI required');return;}
 let unprotectCalls=0;const unprotect=input=>{unprotectCalls++;const started=performance.now();try{return unprotectWithWindowsDpapi(input);}catch(error){t.diagnostic(JSON.stringify({operation:'DPAPI-Unprotect',durationMs:Math.round(performance.now()-started),code:error.code??null,status:error.status??null,signal:error.signal??null}));throw error;}};
 t.after(()=>t.diagnostic(JSON.stringify({operation:'DPAPI-Unprotect',calls:unprotectCalls,scope:'whole-isolated-test',provider:'synthetic'})));
 const root=mkdtempSync(join(tmpdir(),'jarvis-collection-vault-')),now=new Date('2026-10-08T00:00:00Z'),vault=new IntegrationCredentialVault({path:join(root,'vault.json'),clock:()=>now,unprotect}),store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>now});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 vault.save({connectorId:GOOGLE_CONNECTOR_ID,authMethod:'oauth2',providerAccountId:'isolated@example.test',scopes:[...GOOGLE_READ_SCOPES],credentials:{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'}});
 const client=createGoogleVaultReadClient({vault,registry:new IntegrationConnectorRegistry(),clock:()=>now,fetchImpl:async input=>{
  const url=new URL(input);if(url.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'synthetic-access',expires_in:3600});
  if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'isolated@example.test'});return Response.json({items:[{id:'stored-event',summary:'암호 보관소 연결 검증'}],nextSyncToken:'vault-token'});
 }});
 assert.throws(()=>client.authorizationBinding(),/CONNECTION_REQUIRED/);await client.verifyConnection();const binding=client.authorizationBinding(),sync=createManagedGoogleSync({store,client,clock:()=>now,requireMandates:true});
 await sync.collectionDelegation.configure({requestId:'vault-scope',provider:'google-calendar',scope:'primary-calendar-event-metadata-v1',...binding,maxPages:2,validFrom:now.toISOString(),expiresAt:'2026-10-09T00:00:00Z',replaceMandateId:null});
 const result=await sync.collectionSync.run('google-calendar',{authorize:()=>true});assert.equal(result.verification.status,'passed');assert.equal(sync.inbox.list().length,1);
 assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|synthetic-refresh|synthetic-access|vault-token/);client.close();
});

test('new Node process resumes the exact persisted Calendar page and commits the final token',async t=>{
 const f=await fixture(t);f.setResponses([{items:[{id:'before-restart'}],nextPageToken:'page-2'}]);await f.run();
 const path=join(f.root,'resume.json');writeFileSync(path,JSON.stringify({dbPath:join(f.root,'ops.sqlite')}));
 const child=spawnSync(process.execPath,['tests/fixtures/google-collection-resume-probe.mjs',path],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const result=JSON.parse(child.stdout);assert.equal(result.status,'window-complete');assert.equal(result.verification,'passed');assert.equal(result.items,2);assert.deepEqual(result.queries,[{path:'/calendar/v3/calendars/primary/events',pageToken:'page-2',syncToken:null}]);
 assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_collection_jobs').get().body).syncToken,'after-restart-token');
});
