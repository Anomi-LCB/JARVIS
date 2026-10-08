import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalLifecycleCases} from '../packages/core/src/personal-operations/lifecycle-cases.js';
import {createLifecycleCaseClient} from '../src/ui/workspace/lifecycle-case-client.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const input=i=>({requestId:'page-'+i,kind:'shipment',provider:'dhl',accountRef:'synthetic',providerRef:'ref-'+i,title:'합성 배송 '+i,dueAt:null});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-case-page-'));const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,cases:new PersonalLifecycleCases(store)};}
test('membership pagination covers every original record once and excludes new inserts',t=>{
 const {cases}=fixture(t);const expected=Array.from({length:105},(_,i)=>cases.create(input(i)).id).reverse();
 let page=cases.listPage({limit:20}),actual=page.items.map(c=>c.id);assert.equal(page.items[0].eventsIncluded,false);
 cases.create(input(106));while(page.hasMore){page=cases.listPage({limit:20,cursor:page.nextCursor});actual.push(...page.items.map(c=>c.id));}
 assert.deepEqual(actual,expected);assert.equal(new Set(actual).size,105);assert.equal(page.nextCursor,null);
 assert.equal(cases.listPage({limit:1}).items[0].providerRef,'ref-106');
});
test('invalid limits and malformed cursors cannot silently truncate',t=>{
 const {cases}=fixture(t);cases.create(input(1));
 for(const limit of [0,101,1.5,'20',NaN])assert.throws(()=>cases.listPage({limit}),/PAGE_LIMIT/);
 for(const cursor of ['x','a!','a'.repeat(301),Buffer.from(JSON.stringify({version:1,snapshot:999,before:1})).toString('base64url')])assert.throws(()=>cases.listPage({cursor}),/CURSOR/);
});
test('lost create response replays exact SQL request without duplicate case',async t=>{
 const {cases}=fixture(t);let lost=true;const bodies=[];const client=createLifecycleCaseClient({uuid:()=> 'retained-request',request:async(path,{body})=>{bodies.push(body);const c=cases.create(body);if(lost){lost=false;throw Error('response lost');}return c;}});
 await assert.rejects(client.create(input(1)),/response lost/);assert.equal(client.pending(),true);
 await assert.rejects(client.create(input(2)),/RESULT_UNKNOWN/);const replay=await client.retry();assert.equal(client.pending(),false);assert.deepEqual(bodies[0],bodies[1]);assert.equal(cases.listPage().items.length,1);assert.equal(replay.providerVerified,false);
});
test('observation pins source and revision; lost event replay retains original target',async t=>{
 const {cases}=fixture(t),c=cases.create(input(1)),id=c.id;let lost=true;const client=createLifecycleCaseClient({uuid:()=> 'retained-event',request:async(path,{body})=>{assert.ok(path.includes(id));const result=cases.record(id,'observation',body);if(lost){lost=false;throw Error('lost');}return result;}});
 await assert.rejects(client.record(c,'observation',{provider:'forged',accountRef:'forged',providerRef:'forged',expectedRevision:999,status:'delivered',observedAt:new Date(Date.now()-60000).toISOString(),receiptRef:'synthetic-proof'}),/lost/);
 c.id='different';const result=await client.retry();assert.equal(result.replayed,true);assert.equal(result.events.length,1);assert.equal(result.completionVerified,false);
});
test('duplicate clicks cannot run concurrent retries; HTTP rejection clears pending',async()=>{
 let finish;const client=createLifecycleCaseClient({uuid:()=> 'request',request:()=>new Promise(r=>finish=r)});const first=client.create(input(1));await assert.rejects(client.retry(),/BUSY/);await assert.rejects(client.create(input(2)),/RESULT_UNKNOWN/);finish({id:'case'});await first;assert.equal(client.pending(),false);
 const rejected=createLifecycleCaseClient({uuid:()=> 'request',request:async()=>{throw Object.assign(Error('denied'),{status:409});}});await assert.rejects(rejected.create(input(1)));assert.equal(rejected.pending(),false);
});
test('actual HTTP page route preserves ADMIN auth, rejects ambiguous queries and legacy shape',async t=>{
 const {store,cases}=fixture(t);cases.create(input(1));const server=createCoreServer(undefined,{adminToken:'synthetic',personalOperations:{store}});await listenOnFetchSafePort(server);t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}/personal-operations/cases`;
 assert.equal((await fetch(base+'?limit=20')).status,401);const headers={authorization:'Bearer synthetic'};
 assert.equal((await fetch(base+'/context')).status,401);const context=await (await fetch(base+'/context',{headers})).json();assert.equal(context.storeId,cases.storeId);assert.equal(context.executionAuthority,false);
 const denied=await fetch(base,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({...input(2),expectedStoreId:'changed'})});assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'A_CASE_STORE_CHANGED');assert.equal(cases.listPage().items.length,1);
 const page=await fetch(base+'?limit=20',{headers});assert.equal(page.status,200);assert.equal((await page.json()).version,'lifecycle-case-page-v1');
 assert.equal(Array.isArray(await (await fetch(base,{headers})).json()),true);
 for(const query of ['?limit=0','?limit=101','?limit=2&limit=3','?unknown=1','?cursor=invalid'])assert.equal((await fetch(base+query,{headers})).status,400);
});
