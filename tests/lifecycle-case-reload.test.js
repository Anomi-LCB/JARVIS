import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalLifecycleCases} from '../packages/core/src/personal-operations/lifecycle-cases.js';
import {createLifecycleCaseClient} from '../src/ui/workspace/lifecycle-case-client.js';
const input={kind:'shipment',provider:'dhl',accountRef:'synthetic',providerRef:'ref',title:'합성',dueAt:null};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-case-reload-')),store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),cases=new PersonalLifecycleCases(store);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const map=new Map();return {store,cases,storage:{getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)},map};}
test('persist before dispatch; restart client and DB connection; recover exact request once',async t=>{
 const {cases,store,storage,map}=fixture(t);let lost=true,posts=0;const request=async(path,options)=>{if(!options)return cases.context();assert.ok(map.size);posts++;const result=cases.create(options.body);if(lost){lost=false;throw Error('lost');}return result;};
 const first=createLifecycleCaseClient({request,storage,uuid:()=> 'request'});await assert.rejects(first.create(input),/lost/);assert.ok(first.pending());
 assert.equal(new PersonalLifecycleCases(store).context().storeId,cases.context().storeId);
 const restored=createLifecycleCaseClient({request,storage});assert.ok(restored.pending());await assert.rejects(restored.create(input),/UNKNOWN/);const result=await restored.retry();assert.ok(result.replayed);assert.equal(posts,2);assert.equal(cases.listPage().items.length,1);assert.equal(map.size,0);assert.equal(restored.pending(),false);
});
test('event lost response survives reload and replays original target/revision',async t=>{
 const {cases,storage}=fixture(t),c=cases.create({...input,requestId:'create'});let lost=true;
 const request=async(path,options)=>{if(!options)return cases.context();assert.ok(path.includes(c.id));const result=cases.record(c.id,'cancel',options.body);if(lost){lost=false;throw Error('lost');}return result;};
 await assert.rejects(createLifecycleCaseClient({request,storage,uuid:()=> 'event'}).record(c,'cancel',{reason:'synthetic'}),/lost/);
 const result=await createLifecycleCaseClient({request,storage}).retry();assert.equal(result.events.length,1);assert.equal(result.revision,2);assert.equal(result.cancellation.externalRequestSent,false);
});
test('changed ledger blocks restored request before any POST and retains it',async t=>{
 const {cases,storage,map}=fixture(t);await assert.rejects(createLifecycleCaseClient({storage,uuid:()=> 'request',request:async(path,options)=>{if(!options)return cases.context();cases.create(options.body);throw Error('lost');}}).create(input));
 let posts=0;const restored=createLifecycleCaseClient({storage,request:async(path,options)=>{if(options)posts++;return {...cases.context(),storeId:'11111111-1111-1111-1111-111111111111'};}});await assert.rejects(restored.retry(),/STORE_CHANGED/);assert.equal(posts,0);assert.equal(map.size,1);assert.ok(restored.pending());
 assert.throws(()=>cases.create({...input,requestId:'new',expectedStoreId:'wrong'}),/STORE_CHANGED/);assert.equal(cases.listPage().items.length,1);
});
test('storage quota failure prevents sending; no corrupted journal route executes',async t=>{
 const {cases}=fixture(t);let posts=0;const request=async(path,options)=>{if(options)posts++;return cases.context();};
 const storage={getItem:()=>null,setItem:()=>{throw Error('quota');},removeItem:()=>{}};
 await assert.rejects(createLifecycleCaseClient({request,storage,uuid:()=> 'request'}).create(input),/JOURNAL_UNAVAILABLE/);assert.equal(posts,0);
 for(const saved of ['not json',JSON.stringify({version:1,path:'/missions/anything/run',body:{eventId:'id',expectedStoreId:cases.storeId}})]){const client=createLifecycleCaseClient({request,storage:{getItem:()=>saved,setItem:()=>{},removeItem:()=>{}}});assert.ok(client.pending());await assert.rejects(client.retry(),/JOURNAL_INVALID/);await assert.rejects(client.create(input),/RESULT_UNKNOWN/);}
 assert.equal(posts,0);
});
test('ledger change after context check cannot create a write',async t=>{
 const {cases,storage}=fixture(t);let gets=0;const client=createLifecycleCaseClient({storage,uuid:()=> 'request',request:async(path,options)=>{
  if(!options){gets++;return cases.context();}assert.equal(gets,1);try{cases.create({...options.body,expectedStoreId:'other'});}catch(error){throw Object.assign(error,{payload:{error:{code:error.code}}});}
 }});await assert.rejects(client.create(input),/STORE_CHANGED/);assert.ok(client.pending());assert.equal(cases.listPage().items.length,0);
});
