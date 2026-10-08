import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {readSelectedSourceStream,selectedSourceMandateRef} from '../packages/core/src/personal-operations/selected-source-stream.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {SelectedSourceClient,selectedSourceDigest} from '../apps/pc-agent/src/adapters/selected-source-client.js';
import {captureSelectedSource} from '../packages/core/src/mission/selected-source-result.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const objective='선택한 연결의 저장 자료 전체를 조회해.';
async function setup(t,{provider='outlook',count=1,mode='ready'}={}){
 const root=mkdtempSync(join(tmpdir(),'jarvis-selected-result-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store);
 const all=Array.from({length:count},(_,i)=>({id:'record-'+i,title:'선택 자료 '+i}));
 const base={provider,account:'synthetic-selected',scope:'selected.metadata.read',observedAt:'2026-10-07T00:00:00Z'};let stream,cursor=null;
 for(let i=0;i<Math.max(1,Math.ceil(count/500));i++){const nextCursor=(i+1)*500<count?'page-'+i:null;stream=inbox.ingest({...base,cursor,nextCursor,items:all.slice(i*500,(i+1)*500)}).stream;cursor=nextCursor;}
 inbox.ingest({...base,account:'other-account',items:[{id:'other',title:'다른 계정 비공개 자료'}]});
 const selection={provider,streamRef:stream},budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:5,scope:{accountRef:null,dataRefs:[selectedSourceMandateRef(selection)],deniedDataRefs:[]}});
 const binding={capabilityId:'source.readSelectedInbox',providerId:'core-inbox',accountRef:stream,deviceRef:null,scopes:['selected.metadata.read']};
 let client,calls=0,current=true;const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({env,taskEnv:env,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
  missionPlanner:{async planNextWave(){assert.fail('bounded source reading must not invoke a model planner');}},
  capabilityBindingResolver:({toolName})=>toolName==='source.readSelectedInbox'?{required:true,binding,permissionRevision:'one'}:{required:false},
  selectedSourceAccess:{client:{read:(...args)=>client.read(...args)},authorizeRequest:r=>current&&r.provider===provider&&r.streamRef===stream,
   readCurrentSnapshot:r=>readSelectedSourceStream(inbox,r,{checkAuthorized:()=>current})}});
 runtime.missionRuntime.executionBudget=gate;
 runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'one',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:stream,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'test:local-core'});
 const server=createCoreServer(runtime.coreFacade,{adminToken:'test-owner',adminTokens:[{token:'test-diagnostics',scopes:['core:diagnostics:read']}],missionRuntime:runtime.missionRuntime,personalInbox:inbox});await listenOnFetchSafePort(server,{host:'127.0.0.1'});const url=`http://127.0.0.1:${server.address().port}`;
 client=new SelectedSourceClient({baseUrl:url,tokenProvider:async()=>{calls++;if(mode==='change-between-pages'&&calls===2)inbox.ingest({...base,cursor,nextCursor:null,observedAt:'2026-10-07T00:01:00Z',items:[{id:'record-0',title:'바뀐 자료'}]});return 'test-owner';}});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));runtime.coreFacade.cognition?.close();store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-selected-result-'));rmSync(root,{recursive:true,force:true});});
 const owner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'source-result-test'}),authorization={mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','high_impact']};
 const created=runtime.missionRuntime.createMission({objective,selectedSource:selection,executionMandateId:quota.mandate.id,authorization,
  budgets:{maxActions:mode==='budget'?2:10,maxWaves:10,maxPlannerCalls:10,maxActiveRuntimeMs:60000},metadata:{longTermMemory:false}});
 assert.ok(created.missionId,JSON.stringify(created));
 return {runtime,created,store,inbox,quota,gate,url,base,selection,authorization,calls:()=>calls,revokeHost:()=>{current=false;}};
}
for(const [provider,count] of [['outlook',1001],['teams-chat',2],['gmail',0],['google-calendar',1]])test('whole selected-source Mission and authenticated result HTTP: '+provider,async t=>{
 const f=await setup(t,{provider,count}),result=await f.runtime.missionRuntime.runMission(f.created.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,stopReason:result.stopReason,error:result.lastError,observations:result.observations?.map(o=>({outcome:o.outcome,error:o.error,summary:o.summary})),metrics:result.metrics,waves:result.waves?.map(w=>({status:w.status,actions:w.actions.map(a=>({status:a.status,error:a.error,args:a.arguments}))}))}));
 const response=await fetch(`${f.url}/missions/${result.missionId}/verified-selected-source`,{headers:{authorization:'Bearer test-owner'}});assert.equal(response.status,200);const delivered=await response.json();
 assert.equal(delivered.status,'verified',JSON.stringify(delivered));assert.equal(delivered.result.items.length,count);assert.equal(new Set(delivered.result.items.map(i=>i.id)).size,count);
 assert.equal(delivered.result.pageCount,Math.max(1,Math.ceil(count/500)));assert.equal(f.calls(),Math.max(1,Math.ceil(count/500)));
 assert.equal(delivered.humanReadConfirmed,false);assert.equal(delivered.result.providerObservationVerified,false);assert.equal(delivered.result.executionAuthority,false);
 assert.doesNotMatch(JSON.stringify(delivered),/다른 계정 비공개|test-owner|synthetic-selected/);
 assert.equal((await fetch(`${f.url}/missions/${result.missionId}/verified-selected-source`)).status,401);
 const historyPath=f.url+'/personal-inbox/selected-source-history',historyBody=JSON.stringify({...f.selection,limit:50});
 assert.equal((await fetch(historyPath,{method:'POST',headers:{'content-type':'application/json'},body:historyBody})).status,401);
 const history=await (await fetch(historyPath,{method:'POST',headers:{authorization:'Bearer test-owner','content-type':'application/json'},body:historyBody})).json();
 assert.equal(history.total,1);assert.equal(history.items[0].missionId,result.missionId);assert.equal(history.currentResultVerified,false);
 assert.doesNotMatch(JSON.stringify(history),/選択|선택 자료|다른 계정 비공개|synthetic-selected|test-owner/);
});
for(const mode of ['changed-after-completion','forged-receipt','missing-page','duplicate-page','foreign-action','mandate-revoked','host-revoked'])test('current selected-source result rejects '+mode,async t=>{
 const f=await setup(t,{count:501}),result=await f.runtime.missionRuntime.runMission(f.created.missionId);assert.equal(result.status,'COMPLETED');
 const mission=f.runtime.missionRuntime.missions.get(result.missionId),actions=mission.waves.flatMap(w=>w.actions);
 if(mode==='changed-after-completion')f.inbox.ingest({...f.base,observedAt:'2026-10-07T00:01:00Z',items:[{id:'record-0',title:'정정됨'}]});
 if(mode==='forged-receipt'){const receipt=f.runtime.coreFacade.getTask(actions[0].taskId).executionResult.evidence.adapterEvidence;receipt.snapshot.items[0].title='변조됨';receipt.resultSha256=selectedSourceDigest(receipt.snapshot);}
 if(mode==='missing-page')mission.waves[1].actions=[];
 if(mode==='duplicate-page')mission.waves.push(structuredClone(mission.waves[0]));
 if(mode==='foreign-action')mission.waves[0].actions.push({actionId:'unbound-send',command:objective,expectedToolName:'mail.send',status:'pending'});
 if(mode==='mandate-revoked')f.store.revokeMandate(f.quota.mandate.id);
 if(mode==='host-revoked')f.revokeHost();
 const value=f.runtime.missionRuntime.getVerifiedSelectedSourceResult(result.missionId);assert.equal(value.success,false,JSON.stringify(value));assert.equal(value.result,undefined);
});
test('renewed source-result read authorization is strict and cannot expand execution grants',async t=>{
 const f=await setup(t),result=await f.runtime.missionRuntime.runMission(f.created.missionId);assert.equal(result.status,'COMPLETED');
 const authorizationBefore=structuredClone(f.runtime.missionRuntime.missions.get(result.missionId).authorization);
 const url=`${f.url}/missions/${result.missionId}/verified-selected-source`,headers={authorization:'Bearer test-owner','content-type':'application/json'};
 for(const body of [{},{ownerSessionId:4},{ownerSessionId:f.authorization.ownerSessionId,grants:['high_impact']}]){
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(body)})).status,400);
 }
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ownerSessionId:f.authorization.ownerSessionId})})).status,401);
 const denied=await fetch(url,{method:'POST',headers,body:JSON.stringify({ownerSessionId:'unknown-session'})});assert.equal((await denied.json()).success,false);
 const allowed=await fetch(url,{method:'POST',headers,body:JSON.stringify({ownerSessionId:f.authorization.ownerSessionId})});assert.equal((await allowed.json()).success,true);
 assert.deepEqual(f.runtime.missionRuntime.missions.get(result.missionId).authorization,authorizationBefore);
});
test('history HTTP enforces admin, exact selection and revision-bound pagination',async t=>{
 const f=await setup(t),result=await f.runtime.missionRuntime.runMission(f.created.missionId);assert.equal(result.status,'COMPLETED');
 const url=f.url+'/personal-inbox/selected-source-history',headers={authorization:'Bearer test-owner','content-type':'application/json'};
 const post=(body,extra={})=>fetch(url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 assert.equal((await post(f.selection,{authorization:'Bearer test-diagnostics'})).status,403);
 assert.equal((await post({...f.selection,url:'http://evil'})).status,400);
 assert.equal((await post({...f.selection,provider:'gmail'})).status,404);
 assert.equal((await post({...f.selection,streamRef:'b'.repeat(64)})).status,404);
 const history=await (await post(f.selection)).json();
 f.runtime.missionRuntime.missions.get(result.missionId).updatedAt='2026-10-07T00:01:00Z';
 assert.equal((await post({...f.selection,offset:1,expectedRevision:history.revision})).status,409);
});
for(const mode of ['budget','change-between-pages'])test('whole selected-source Mission cannot complete '+mode,async t=>{
 const f=await setup(t,{count:1001,mode}),result=await f.runtime.missionRuntime.runMission(f.created.missionId);assert.notEqual(result.status,'COMPLETED');assert.equal(f.runtime.missionRuntime.getVerifiedSelectedSourceResult(result.missionId).success,false);
});
test('selection does not permit discarding an extra send/correction/time/unknown instruction',()=>{
 const selection={provider:'outlook',streamRef:'a'.repeat(64)};
 for(const text of [objective+' 그리고 다른 계정으로 보내줘.',objective+' 10분 안에.',objective+' 단, 첫 자료는 제외해.','선택한 연결의 자료를 요약하고 보내줘'])assert.throws(()=>captureSelectedSource(text,selection));
 assert.throws(()=>captureSelectedSource(objective,{...selection,url:'http://evil'}));
});
