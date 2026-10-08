import test from 'node:test';import assert from 'node:assert/strict';
import {createLifecycleCaseMissionClient,lifecycleCaseObjective} from '../src/ui/workspace/lifecycle-case-mission-client.js';
const id='11111111-1111-4111-8111-111111111111',storeId='22222222-2222-4222-8222-222222222222';
function fixture({lose=null,revoked=false,quota=false}={}){
 const data=new Map(),calls=[];let mission=null;
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>{if(quota)throw Error('quota');data.set(k,v);},removeItem:k=>data.delete(k)};
 const request=async(path,options={})=>{calls.push({path,...options});
  if(path.endsWith('/cases/context'))return {version:'lifecycle-context-v1',storeId,missionConfigured:true};
  if(path.endsWith('/cases/'+id))return {id,revision:1};
  if(path==='/owner-session')return {active:!revoked,session:revoked?null:{sessionId:'owner',expiresAt:'2099-01-01T00:00:00Z',grants:['read_only']},recentAudit:revoked?[{eventType:'owner_session.revoked'}]:[]};
  if(path==='/missions'){assert.equal(options.body.authorization.grants.join(','),'read_only');assert.equal(options.body.metadata.longTermMemory,false);mission={missionId:'mission_test',objective:options.body.objective,lifecycleCase:{request:structuredClone(options.body.lifecycleCase)},status:'CREATED',waves:[]};if(lose==='create')throw Error('lost');return structuredClone(mission);}
  if(path.startsWith('/missions?'))return {items:mission?[structuredClone(mission)]:[]};
  if(path.endsWith('/run')){mission.status='COMPLETED';if(lose==='run')throw Error('lost');return structuredClone(mission);}
  if(path.endsWith('/verified-lifecycle-case'))return mission?.status==='COMPLETED'?{status:'verified',result:{caseId:id}}:{status:'unverified'};
  if(path==='/missions/mission_test')return structuredClone(mission);
  throw Error('unexpected '+path);
 };
 return {calls,data,storage,request,client:()=>createLifecycleCaseMissionClient({request,storage,uuid:()=> 'unique'}),mission:()=>mission};
}
test('selected client sends bounded readonly Mission and no provider effects',async()=>{const f=fixture(),client=f.client();const result=await client.submit({id,revision:1});assert.equal(result.mission.status,'COMPLETED');assert.equal(client.pending(),false);assert.equal(f.data.size,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,2);});
for(const lose of ['create','run'])test('lost '+lose+' response survives reload and reconciles without redispatch',async()=>{
 const f=fixture({lose}),first=f.client();await assert.rejects(first.submit({id,revision:1}),/lost/);const recovered=f.client();assert.equal(recovered.pending(),true);await assert.rejects(recovered.submit({id,revision:1}),/UNKNOWN/);
 const posts=f.calls.filter(c=>c.method==='POST').length,result=await recovered.reconcile();assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
 if(lose==='run'){assert.equal(result.result.status,'verified');assert.equal(recovered.pending(),false);}else{assert.equal(result.mission.status,'CREATED');assert.equal(recovered.pending(),true);f.mission().status='FAILED';await assert.rejects(recovered.continueCreated(),/NOT_UNSTARTED/);}
});
test('unstarted lost-create may continue only on explicit action',async()=>{const f=fixture({lose:'create'}),client=f.client();await assert.rejects(client.submit({id,revision:1}));await client.reconcile();assert.equal((await client.continueCreated()).mission.status,'COMPLETED');assert.equal(f.calls.filter(c=>c.path==='/missions').length,1);});
for(const options of [{revoked:true},{quota:true}])test('revocation or unavailable durable journal prevents Mission creation '+JSON.stringify(options),async()=>{const f=fixture(options);await assert.rejects(f.client().submit({id,revision:1}));assert.equal(f.calls.filter(c=>c.path==='/missions').length,0);assert.equal(f.calls.some(c=>c.path==='/owner-session/activate'),false);});
test('changed selection and unsupported tails do not create partial Mission',async()=>{const f=fixture(),client=f.client();await assert.rejects(client.submit({id,revision:2}),/SELECTION_CHANGED/);await assert.rejects(client.submit({id,revision:1},lifecycleCaseObjective+' 메일로 보내.'),/UNSUPPORTED/);assert.equal(f.calls.some(c=>c.path==='/missions'),false);});
test('malformed persisted journal cannot choose endpoint or re-dispatch',async()=>{const f=fixture();f.data.set('jarvis.lifecycle.mission.pending.v1',JSON.stringify({version:1,path:'/mail/send'}));const client=f.client();assert.equal(client.pending(),true);await assert.rejects(client.reconcile(),/JOURNAL_INVALID/);assert.equal(f.calls.length,0);});
test('reconcile binds persisted selection and rejects other Mission',async()=>{const f=fixture({lose:'create'}),client=f.client();await assert.rejects(client.submit({id,revision:1}));f.mission().lifecycleCase.request.expectedRevision=2;await assert.rejects(client.reconcile(),/BINDING_CHANGED/);assert.equal(client.pending(),true);});
test('Korean Mission ID remains valid after reload and cannot become an endpoint',async()=>{const f=fixture();f.data.set('jarvis.lifecycle.mission.pending.v1',JSON.stringify({version:1,key:'case_mission_unique',missionId:'mission_선택한-생활-업무_1',selection:{caseId:id,expectedStoreId:storeId,expectedRevision:1}}));const client=f.client();await assert.rejects(client.reconcile(),/unexpected/);assert.equal(f.calls[0].path,'/missions/'+encodeURIComponent('mission_선택한-생활-업무_1'));assert.equal(client.pending(),true);});
test('unconfigured host blocks before owner activation or Mission creation',async()=>{const f=fixture(),request=(path,o)=>path.endsWith('/cases/context')?Promise.resolve({version:'lifecycle-context-v1',storeId,missionConfigured:false}):f.request(path,o);const client=createLifecycleCaseMissionClient({request,storage:f.storage});await assert.rejects(client.submit({id,revision:1}),/NOT_CONFIGURED/);assert.equal(f.calls.length,0);});
test('fresh read uses POST revalidation without rerunning or rewriting Mission',async()=>{const f=fixture(),initial=f.client();await initial.submit({id,revision:1});const posts=f.calls.filter(c=>c.path.endsWith('/run')).length;let readBody;
 const request=(path,o={})=>path.endsWith('/verified-lifecycle-case')?(o.method==='POST'?(readBody=o.body,Promise.resolve({status:'verified'})):Promise.resolve({status:'unverified'})):f.request(path,o);
 const client=createLifecycleCaseMissionClient({request,storage:f.storage});const result=await client.refresh('mission_test');assert.equal(result.result.status,'verified');assert.deepEqual(readBody,{ownerSessionId:'owner'});assert.equal(f.calls.filter(c=>c.path.endsWith('/run')).length,posts);
});
test('explicit revoke is not reversed by current-result refresh',async()=>{const f=fixture(),initial=f.client();await initial.submit({id,revision:1});let readPosts=0,activations=0;
 const request=(path,o={})=>{if(path==='/owner-session')return Promise.resolve({active:false,session:null,recentAudit:[{eventType:'owner_session.revoked'}]});if(path==='/owner-session/activate'){activations++;throw Error();}if(path.endsWith('/verified-lifecycle-case')){if(o.method==='POST')readPosts++;return Promise.resolve({status:'unverified'});}return f.request(path,o);};
 const client=createLifecycleCaseMissionClient({request,storage:f.storage});assert.equal((await client.refresh('mission_test')).result.status,'unverified');assert.equal(activations,0);assert.equal(readPosts,0);
});
