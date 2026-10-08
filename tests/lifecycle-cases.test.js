import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalLifecycleCases,lifecycleCaseOpenApiPaths} from '../packages/core/src/personal-operations/lifecycle-cases.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const now='2026-10-07T00:00:00.000Z';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-lifecycle-')),store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date(now)});t.after(()=>{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});return {store,cases:new PersonalLifecycleCases(store),root};}
const create=kind=>({requestId:'synthetic-'+kind,kind,provider:{shipment:'dhl',return:'shopify',administration:'government24'}[kind],accountRef:'synthetic-account',providerRef:'synthetic-ref',title:'합성 업무',dueAt:'2026-10-06T00:00:00Z'});
const observation=(c,patch={})=>({eventId:'synthetic-observation',expectedRevision:c.revision,provider:c.provider,accountRef:c.accountRef,providerRef:c.providerRef,observedAt:'2026-10-06T23:59:00Z',status:{shipment:'delivered',return:'refunded',administration:'approved'}[c.kind],receiptRef:'synthetic-receipt',...patch});
for(const kind of ['shipment','return','administration'])test('local case lifecycle never converts supplied terminal state to verified completion: '+kind,t=>{
 const {store,cases}=fixture(t),input=create(kind),c=cases.create(input);
 assert.equal(c.deadlineState,'elapsed');assert.equal(cases.create(input).id,c.id);assert.equal(store.summary().commitments.length,1);
 assert.throws(()=>cases.create({...input,accountRef:'other'}),/REQUEST_CONFLICT/);
 const recorded=cases.record(c.id,'observation',observation(c));assert.equal(recorded.providerVerified,false);assert.equal(recorded.completionVerified,false);
 assert.equal(recorded.observation.status,observation(c).status);assert.equal(cases.record(c.id,'observation',observation(c)).replayed,true);
 assert.equal(store.summary().commitments[0].state,'open');
 const cancel=cases.record(c.id,'cancel',{eventId:'cancel',expectedRevision:recorded.revision,reason:'사용자 요청'});
 assert.equal(cancel.cancellation.externalRequestSent,false);assert.equal(cancel.cancellation.state,'request-recorded');
 const handoff=cases.record(c.id,'handoff',{eventId:'handoff',expectedRevision:cancel.revision,reason:'공식 연결 미준비'});
 assert.match(handoff.handoff.url,/^https:/);assert.equal(handoff.handoff.externalRequestSent,false);
 assert.equal(new PersonalLifecycleCases(store).get(c.id).events.length,3);assert.equal(handoff.executionAuthority,false);
 assert.match(handoff.nextAction,/아직 인계하거나 접수하지 않았습니다/);
});
test('published lifecycle contracts preserve auth and reject authority or destination injection',()=>{
 const paths=lifecycleCaseOpenApiPaths();assert.equal(Object.keys(paths).length,6);
 for(const methods of Object.values(paths))for(const op of Object.values(methods)){
  assert.deepEqual(op.security,[{bearerAuth:[]}]);
  if(op.requestBody)assert.equal(op.requestBody.content['application/json'].schema.additionalProperties,false);
 }
 const handoff=paths['/personal-operations/cases/{caseId}/handoff'].post;
 assert.equal(Object.hasOwn(handoff.requestBody.content['application/json'].schema.properties,'url'),false);
 assert.match(handoff.description,/No automatic browser action/);
 assert.match(paths['/personal-operations/cases/{caseId}/observation'].post.description,/User-supplied observation only/);
});
for(const [patch,error] of [[{accountRef:'other'},'SOURCE_MISMATCH'],[{providerRef:'other'},'SOURCE_MISMATCH'],[{provider:'other'},'SOURCE_MISMATCH'],[{status:'complete-everything'},'STATUS_INVALID'],[{observedAt:'2026-10-08T00:00:00Z'},'OBSERVATION_FUTURE'],[{observedAt:'2026-02-30T00:00:00Z'},'TIME_INVALID'],[{expectedRevision:9},'REVISION_CONFLICT'],[{providerVerified:true},'FIELDS_INVALID']])test('case observation rejects invalid source or authority: '+error+JSON.stringify(patch),t=>{
 const {cases}=fixture(t),c=cases.create(create('shipment'));assert.throws(()=>cases.record(c.id,'observation',observation(c,patch)),new RegExp(error));assert.equal(cases.get(c.id).revision,1);assert.equal(cases.get(c.id).events.length,0);
});
test('out-of-order, same-time conflict and changed replay do not alter current status',t=>{
 const {cases}=fixture(t),c=cases.create(create('return'));cases.record(c.id,'observation',observation(c));
 for(const observedAt of ['2026-10-06T23:58:00Z','2026-10-06T23:59:00Z'])assert.throws(()=>cases.record(c.id,'observation',observation(c,{eventId:observedAt,expectedRevision:2,observedAt,status:'requested'})),/STALE_OR_CONFLICTING/);
 assert.throws(()=>cases.record(c.id,'observation',observation(c,{status:'requested'})),/EVENT_CONFLICT/);assert.equal(cases.get(c.id).observation.status,'refunded');
});
test('invalid kind, unknown event type and false authority cannot create work',t=>{
 const {store,cases}=fixture(t);
 for(const kind of ['__proto__','constructor','toString','unknown'])assert.throws(()=>cases.create({...create('shipment'),kind,provider:undefined}),/PROVIDER_INVALID/);
 assert.throws(()=>cases.create({...create('shipment'),completionVerified:true}),/FIELDS_INVALID/);
 assert.equal(store.summary().commitments.length,0);
 const c=cases.create(create('shipment'));assert.throws(()=>cases.record(c.id,'delete',{eventId:'invalid',expectedRevision:1,reason:'no'}),/EVENT_TYPE_INVALID/);
 assert.equal(cases.get(c.id).revision,1);
});
test('separate SQLite connection sees persisted revisions and rejects stale cancellation',t=>{
 const {cases,root}=fixture(t),c=cases.create(create('return')),otherStore=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date(now)});
 try{const other=new PersonalLifecycleCases(otherStore);assert.equal(other.get(c.id).commitmentId,c.commitmentId);
  other.record(c.id,'cancel',{eventId:'other-cancel',expectedRevision:1,reason:'user request'});
  assert.equal(cases.get(c.id).revision,2);
  assert.throws(()=>cases.record(c.id,'handoff',{eventId:'stale',expectedRevision:1,reason:'stale'}),/REVISION_CONFLICT/);
  assert.equal(other.get(c.id).events.length,1);
 }finally{otherStore.close();}
});
test('actual Core HTTP auth, SQL persistence and explicit handoff',async t=>{
 const {store}=fixture(t),server=createCoreServer(undefined,{adminToken:'synthetic-admin',personalOperations:{store}});await listenOnFetchSafePort(server);t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}/personal-operations/cases`;
 assert.equal((await fetch(url)).status,401);
 const post=async(path,body)=>fetch(url+path,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify(body)});
 const result=await post('',create('administration'));assert.equal(result.status,200);const c=await result.json();
 assert.equal((await post('/'+c.id+'/observation',observation(c))).status,200);
 assert.equal((await post('/'+c.id+'/cancel',{eventId:'cancel',expectedRevision:2,reason:'임시 테스트'})).status,200);
 assert.equal((await post('/'+c.id+'/handoff',{eventId:'handoff',expectedRevision:3,reason:'공식 창구 확인'})).status,200);
 const get=await fetch(url+'/'+c.id,{headers:{authorization:'Bearer synthetic-admin'}}),saved=await get.json();assert.equal(saved.events.length,3);assert.equal(saved.completionVerified,false);assert.equal(saved.handoff.url,'https://www.gov.kr/');
 assert.equal((await post('/'+c.id+'/cancel',{eventId:'bad',expectedRevision:1,reason:'stale'})).status,409);
 assert.equal((await post('/'+c.id+'/handoff',{eventId:'bad-url',expectedRevision:4,reason:'unsafe',url:'https://attacker.invalid'})).status,400);
});
