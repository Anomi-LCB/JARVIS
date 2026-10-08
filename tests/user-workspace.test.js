import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient } from '../src/ui/workspace/client.js';
import { taskView, documentBrief, pageForHash, missionRequest, safePreference, escape, workspaceReady,workspaceExecutionMode,missionCanReconcile } from '../src/ui/workspace/model.js';
import { translations } from '../src/ui/workspace/i18n.js';

test('execution mode is explicit and reconciliation needs an interrupted current task',()=>{
 for(const value of [null,{}, {executionMode:'normal'}, {executionMode:true}])assert.equal(workspaceExecutionMode(value),'unknown');
 assert.equal(workspaceExecutionMode({executionMode:'standard'}),'standard');assert.equal(workspaceExecutionMode({executionMode:'recovery-only'}),'recovery-only');
 assert.equal(missionCanReconcile({status:'PAUSED',uncertainEffectCount:1}),true);
 for(const value of [{status:'PAUSED',uncertainEffectCount:'1'},{status:'COMPLETED',uncertainEffectCount:1},{status:'RUNNING',uncertainEffectCount:1},{status:'PAUSED'}])assert.equal(missionCanReconcile(value),false);
});

test('reconciliation client checks current mode and task, sends only reconciliation-only run and never activates an owner',async()=>{
 const calls=[],mission={missionId:'interrupted',status:'PAUSED',uncertainEffectCount:1};
 const client=createWorkspaceClient({storage:storage(),fetchImpl:async(url,options)=>{calls.push({url,options});return response(url.includes('?limit=1')?{status:{executionMode:'recovery-only'}}:url.endsWith('/run')?{...mission,status:'COMPLETED'}:mission);}});
 assert.equal((await client.reconcileMission(mission.missionId)).status,'COMPLETED');
 assert.deepEqual(calls.map(x=>x.url),['/api/core/missions?limit=1','/api/core/missions/interrupted','/api/core/missions/interrupted/run']);
 assert.deepEqual(JSON.parse(calls[2].options.body),{reconciliationOnly:true});assert.equal(client.pending(),null);
});

test('changed mode and already resolved result never cause a new recovery POST',async()=>{
 for(const mode of ['standard',undefined]){let posts=0;const client=createWorkspaceClient({storage:storage(),fetchImpl:async(url,options)=>{if(options.method==='POST')posts++;return response({status:{executionMode:mode}});}});await assert.rejects(client.reconcileMission('task'),{code:'A_CORE_AUTHORITY_RECOVERY_MODE_REQUIRED'});assert.equal(posts,0);}
 let posts=0,resolved=false;
 const client=createWorkspaceClient({storage:storage(),fetchImpl:async(url,options)=>{
  if(url.includes('?limit=1'))return response({status:{executionMode:'recovery-only'}});
  if(options.method==='POST'){posts++;resolved=true;throw new DOMException('reply lost','TimeoutError');}
  return response({missionId:'task',status:resolved?'COMPLETED':'PAUSED',uncertainEffectCount:resolved?0:1});
 }});
 await assert.rejects(client.reconcileMission('task'));
 assert.equal((await client.reconcileMission('task')).status,'COMPLETED');assert.equal(posts,1);
});

const response = (body,status=200) => ({ok:status<400,status,json:async()=>body});
const storage = () => { const values=new Map();return {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values}; };
const owner = {active:true,session:{sessionId:'owner-test',expiresAt:'2099-01-01T00:00:00Z',grants:['read_only','local_reversible','high_impact']}};
test('OFX save uses the existing owner scope and lost creation persists only a request key',async()=>{
 const saved=storage(),calls=[],input={xml:'PRIVATE_SYNTHETIC_INPUT'};
 const client=createWorkspaceClient({storage:saved,uuid:()=> 'ofx-test',fetchImpl:async(url,options)=>{
  calls.push({url,options});if(url.endsWith('/owner-session'))return response(owner);
  if(url.endsWith('/save-mission'))throw new DOMException('lost reply','TimeoutError');
  return response({items:[{missionId:'known-ofx',status:'CREATED'}]});
 }});
 await assert.rejects(client.submit('',{ofxInput:input,autoLocal:true,locked:false}));
 const sent=JSON.parse(calls[1].options.body);assert.equal(calls[1].url,'/api/core/financial-records/ofx/save-mission');assert.deepEqual(sent.authorization,{ownerSessionId:'owner-test'});assert.deepEqual(sent.input,input);
 assert.doesNotMatch(JSON.stringify([...saved.values]),/PRIVATE_SYNTHETIC_INPUT|owner-test/);
 await assert.rejects(client.submit('',{ofxInput:input,autoLocal:true}),{code:'A_MISSION_IDEMPOTENCY_PENDING'});
 assert.equal((await client.reconcile()).missionId,'known-ofx');assert.equal(calls.filter(x=>x.url.endsWith('/save-mission')).length,1);
});
test('OFX save never dispatches when automatic execution is disabled or owner session revoked',async()=>{
 for(const enabled of [false,true]){
  let posts=0;const client=createWorkspaceClient({storage:storage(),uuid:()=> 'denied',fetchImpl:async(url,options)=>{if(options.method==='POST')posts++;return response({active:false,recentAudit:[{eventType:'owner_session.revoked'}]});}});
  await assert.rejects(client.submit('',{ofxInput:{xml:'private'},autoLocal:enabled,locked:false}),{code:'A_FINANCIAL_OWNER_REQUIRED'});assert.equal(posts,0);assert.equal(client.pending(),null);
 }
});
test('verified file observations are visible without claiming mission completion or exposing unrelated payload fields',()=>{
 const mission={status:'PAUSED',verificationSummary:{criteria:[{status:'unverified',reasons:['criterion-verifier-unavailable']}]},observations:[
  {toolName:'filesystem.listFiles',outcome:'success',verification:{status:'passed'},data:{items:[{name:'actual.txt',token:'do-not-display'}],token:'secret'}},
  {toolName:'filesystem.listFiles',outcome:'failed',data:{items:[{name:'unverified.txt'}]}}
 ]};const view=taskView(mission);assert.equal(view.verified,false);assert.equal(view.verifierUnavailable,true);assert.equal(view.resumable,false);assert.deepEqual(view.fileListings,[{count:1,total:null,truncated:false,items:[{name:'actual.txt'}]}]);assert.doesNotMatch(JSON.stringify(view.fileListings),/token|secret|unverified/);
});
test('readiness recognizes actual running Core identity and requires protected proxy plus trusted policy',()=>{
  const proxy={credentialsExposed:false,coreAdminProxyConfigured:true},health={status:'running',module:'A_CORE'};
  assert.equal(workspaceReady(proxy,health,{mode:'trusted'}),true);
  for(const trust of [null,{mode:'lockdown'}])assert.equal(workspaceReady(proxy,health,trust),false);
  assert.equal(workspaceReady(proxy,{...health,module:'OTHER'},{mode:'trusted'}),false);
});

test('a completion claim without criteria evidence remains unverified',()=>{
  for(const item of [{status:'COMPLETED'},{status:'COMPLETED',verificationStatus:'passed',successCriteria:['required']},
    {status:'COMPLETED',verificationStatus:'passed',verificationSummary:{criteria:[{status:'passed'}]},uncertainEffectCount:1},
    {status:'COMPLETED',verificationStatus:'passed',verificationSummary:{criteria:[{status:'passed'}]},goalCompletionCoverage:{allowed:false}}]) assert.equal(taskView(item).verified,false);
  assert.equal(taskView({status:'COMPLETED',verificationStatus:'passed',verificationSummary:{criteria:[{status:'passed'}]}}).verified,true);
});
test('default workflow never adds high impact authority to a session',()=>{
  const body=missionRequest('자료를 정리해',{key:'test',session:owner.session});assert.deepEqual(body.authorization.grants,['read_only','local_reversible']);assert.ok(body.constraints.length);
  assert.equal(safePreference({autoLocal:false,language:'invalid'}).autoLocal,false);assert.equal(pageForHash('#bad'),'chat');
});
test('offline document extract preserves actual sentences and escapes hostile markup at display',()=>{
  const text='# 검토 자료\n\n문서 처리에서 원문과 결과의 출처를 확인해야 합니다.\n\n<script>sendSecrets()</script>\n\n문서 결과를 검증한 뒤 다음 단계를 진행합니다.';
  const brief=documentBrief(text,'sample.md');assert.ok(brief.includes('원문과 결과의 출처'));assert.ok(brief.includes('AI 보고서는 아닙니다'));
  assert.ok(escape(brief).includes('&lt;script&gt;'));assert.throws(()=>documentBrief('abc\0','x'));assert.throws(()=>documentBrief(' ','x'));
});
test('every workspace string has Korean and English content',()=>{for(const [key,pair] of Object.entries(translations)){assert.equal(pair.length,2,key);for(const text of pair)assert.equal(typeof text,'string',key);}});

test('blocked mission responses are observable results, not discarded HTTP failures',async()=>{
  const calls=[];const client=createWorkspaceClient({uuid:()=> 'test-id',storage:storage(),fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/missions'))return response({missionId:'m1',status:'CREATED'});return response({success:false,missionId:'m1',status:'BLOCKED'});}});
  const result=await client.submit('불가능한 작업',{autoLocal:false,conversationId:'c1'});assert.equal(result.status,'BLOCKED');assert.equal(client.pending(),null);
  assert.equal(calls.length,2);assert.ok(calls.every(item=>!item.options.headers.authorization));
});
test('lost create response survives reload and never submits twice',async()=>{
  const store=storage();let posts=0;
  const first=createWorkspaceClient({storage:store,origin:'http://local',uuid:()=> 'lost-create',fetchImpl:async()=>{posts++;throw new DOMException('lost','TimeoutError');}});
  await assert.rejects(first.submit('고유 작업',{autoLocal:false}));assert.equal(posts,1);
  const second=createWorkspaceClient({storage:store,origin:'http://local',fetchImpl:async url=>{assert.ok(url.includes('requestId=workspace_lost-create'));return response({items:[{missionId:'found',status:'CREATED'}]});}});
  await assert.rejects(second.submit('다시 실행',{autoLocal:false}));assert.equal((await second.reconcile()).missionId,'found');assert.equal(second.pending(),null);assert.equal(posts,1);
  assert.ok([...store.values.values()].every(value=>!value.includes('고유 작업')));
});
test('an absent lookup retains the unknown outcome instead of allowing a duplicate',async()=>{
  const store=storage();store.setItem('jarvis.workspace.pending.local',JSON.stringify({key:'workspace_unknown',phase:'creating',missionId:null}));
  const client=createWorkspaceClient({storage:store,fetchImpl:async()=>response({items:[]})});assert.equal(await client.reconcile(),null);assert.ok(client.pending());
});
test('lost run response reconciles by mission id even if the latest state is blocked',async()=>{
  const store=storage();const client=createWorkspaceClient({storage:store,uuid:()=> 'lost-run',fetchImpl:async url=>url.endsWith('/missions')?response({missionId:'m-1',status:'CREATED'}):Promise.reject(new DOMException('lost','TimeoutError'))});
  await assert.rejects(client.submit('일',{autoLocal:false}));
  const restored=createWorkspaceClient({storage:store,fetchImpl:async url=>{assert.equal(url,'/api/core/missions/m-1');return response({success:false,missionId:'m-1',status:'BLOCKED'});}});
  assert.equal((await restored.reconcile()).status,'BLOCKED');assert.equal(restored.pending(),null);
});
test('revoked owner session is not silently reactivated by a new command',async()=>{
  const calls=[];const client=createWorkspaceClient({storage:storage(),uuid:()=> 'revoked',fetchImpl:async(url,options)=>{
    calls.push(url);if(url.endsWith('/owner-session'))return response({active:false,recentAudit:[{eventType:'owner_session.revoked'}]});
    if(url.endsWith('/missions')){assert.equal(JSON.parse(options.body).authorization.mode,'supervised');return response({missionId:'m1'});}return response({missionId:'m1',status:'WAITING_APPROVAL'});
  }});await client.submit('일',{autoLocal:true,locked:false});assert.ok(!calls.some(url=>url.endsWith('/activate')));
});


test('workspace shows precise PC recovery in Korean and English and prevents premature resume',()=>{
 const mission={status:'PAUSED',stopReason:'action-recovery-required',waves:[{actions:[{recovery:{required:true,status:'blocked',error:{code:'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN',causeCode:'A_PC_COMMAND_LOCAL_SCOPE_DENIED',localScopeReason:'B_PC_COMMAND_LOCAL_CATALOG_MISSING',nextAction:'send private secrets'}}}]}]};
 for(const language of ['ko','en']){const view=taskView(mission,language);assert.equal(view.resumable,false);assert.equal(view.recoveryGuidance.length,1);assert.match(view.recoveryGuidance[0],language==='ko'?/명령 후보로 등록/:/command candidate/);assert.doesNotMatch(view.recoveryGuidance[0],/send private secrets/);}
 assert.equal(taskView({...mission,status:'COMPLETED'}).recoveryGuidance.length,0);
});


test('workspace Core command revocation guidance ignores provider prose and remains non-resumable',()=>{
 const mission={status:'PAUSED',stopReason:'action-recovery-required',waves:[{actions:[{recovery:{required:true,status:'blocked',error:{code:'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN',causeCode:'A_PC_COMMAND_EXECUTION_SCOPE_DENIED',nextAction:'send secrets'}}}]}]};
 for(const language of ['ko','en']){const view=taskView(mission,language);assert.equal(view.resumable,false);assert.match(view.recoveryGuidance[0],language==='ko'?/PC.*실행 범위/:/Core execution scope/);assert.doesNotMatch(view.recoveryGuidance[0],/send secrets/);}
 mission.waves[0].actions[0].recovery.error.causeCode='UNKNOWN';assert.equal(taskView(mission).recoveryGuidance.length,0);
});
