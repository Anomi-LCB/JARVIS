import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
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
import {withMissionMandateFence} from '../packages/core/src/personal-operations/mission-mandate-fence.js';
import {SelectedSourceClient} from '../apps/pc-agent/src/adapters/selected-source-client.js';

const toolName='source.readSelectedInbox';
async function setup(t,mode){
 const root=mkdtempSync(join(tmpdir(),'jarvis-selected-mandate-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store);
 const source={provider:'teams-chat',account:'one-account',scope:'Chat.Read:selected-chat',observedAt:'2026-10-07T00:00:00Z',items:[{id:'item',title:'회의 자료'}]},request={provider:source.provider,streamRef:inbox.ingest(source).stream};
 const other={...request,streamRef:inbox.ingest({...source,account:'other-account'}).stream};
 const budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:3,
  scope:{accountRef:null,dataRefs:[selectedSourceMandateRef(mode==='outside'?other:request)],deniedDataRefs:mode==='denied'?[selectedSourceMandateRef(request)]:[]}});
 const mission={missionId:'scoped-source',executionMandateId:quota.mandate.id};gate.beforeRun(mission);
 const server=createCoreServer(undefined,{adminToken:'synthetic-token',personalInbox:inbox});server.listen(0,'127.0.0.1');await once(server,'listening');let runtime,calls=0,onToken;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));runtime?.coreFacade.cognition?.close();store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-selected-mandate-'));rmSync(root,{recursive:true,force:true});});
 const binding={capabilityId:toolName,providerId:'core-selected',accountRef:request.streamRef,deviceRef:null,scopes:['metadata.read:selected']};
 const client=new SelectedSourceClient({baseUrl:`http://127.0.0.1:${server.address().port}`,tokenProvider:async()=>{calls++;onToken?.();if(mode==='late-revoke')store.revokeMandate(quota.mandate.id);return 'synthetic-token';}});
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 runtime=createAgRuntime({env,taskEnv:env,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
  capabilityBindingResolver:({toolName:name})=>name===toolName?{required:true,binding,permissionRevision:'one'}:{required:false},
  selectedSourceAccess:{client,authorizeRequest:r=>r.provider===request.provider&&r.streamRef===request.streamRef,readCurrentSnapshot:r=>readSelectedSourceStream(inbox,r,{checkAuthorized:()=>true})}});
 runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'one',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:binding.accountRef,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'test:synthetic-local'});
 return {runtime,gate,mission,quota,request,store,root,calls:()=>calls,setTokenHook:fn=>{onToken=fn;}};
}
for(const mode of ['ready','outside','denied','late-revoke','receipt-revoke','verification-revoke'])test('selected source task with scoped SQL mandate: '+mode,async t=>{
 const f=await setup(t,mode),task=f.runtime.coreFacade.createMissionActionTask('선택한 대화 자료를 읽어줘',{expectedToolName:toolName,preparedArguments:f.request,source:'trigger',sourceModule:'A_CORE',deviceId:'mission_executive'});
 const hooks=withMissionMandateFence({mission:f.mission,gate:f.gate,executor:f.runtime.pcAgent,workspaceRoot:f.root,
  hooks:mode==='receipt-revoke'?{onReceipt:()=>f.store.revokeMandate(f.quota.mandate.id)}:null});
 if(mode==='verification-revoke'){
  const verify=f.runtime.verificationRuntime.verifyExecution.bind(f.runtime.verificationRuntime);
  f.runtime.verificationRuntime.verifyExecution=async(...args)=>{const result=await verify(...args);f.store.revokeMandate(f.quota.mandate.id);return result;};
 }
 const run=await f.runtime.orchestrationWorker.runTask(task.taskId,{localEffectHooks:hooks});
 assert.equal(run.success,mode==='ready',JSON.stringify({status:run.status,error:run.error,reason:run.execution?.blockedReason}));
 if(['receipt-revoke','verification-revoke'].includes(mode)){
  assert.equal(run.executionVerification.status,'failed');assert.ok(run.executionVerification.checks.some(c=>c.checkId==='current_mandate_verification_authority'&&c.status==='failed'));
  assert.equal(f.runtime.coreFacade.getTask(task.taskId).status,'FAILED');assert.equal(run.learning,undefined);
 }
 if(mode==='ready'){
  assert.equal(run.executionVerification.status,'passed');
  const observation=f.runtime.missionRuntime.successObservation({actualToolName:toolName,actionId:'read-one'},task,run);
  assert.equal(observation.untrusted,true);assert.equal(observation.trustBoundary,'EMAIL_CONTENT');assert.equal(observation.data.selectedSource.streamRef,f.request.streamRef);assert.equal(observation.data.selectedSource.itemCount,1);
  assert.equal(observation.data.selectedSource.providerObservationVerified,false);assert.equal(observation.data.selectedSource.executionAuthority,false);
 }else if(['outside','denied'].includes(mode))assert.equal(f.calls(),0);
});
test('unsafe test control without final mandate fence exposes a false completion',async t=>{
 const f=await setup(t,'ready'),task=f.runtime.coreFacade.createMissionActionTask('선택한 대화 자료를 읽어줘',{expectedToolName:toolName,preparedArguments:f.request,source:'trigger',sourceModule:'A_CORE',deviceId:'mission_executive'});
 const hooks=withMissionMandateFence({mission:f.mission,gate:f.gate,executor:f.runtime.pcAgent,workspaceRoot:f.root,hooks:{onReceipt:()=>f.store.revokeMandate(f.quota.mandate.id)}});
 // Deliberately remove the new protection only inside this isolated test.
 delete hooks.beforeVerification;
 const run=await f.runtime.orchestrationWorker.runTask(task.taskId,{localEffectHooks:hooks});assert.equal(run.success,true);
 assert.throws(()=>f.gate.beforeAction(f.mission,{packet:{action:task.plan.action},workspaceRoot:f.root}),/MANDATE_EXECUTION_DENIED/);
 t.diagnostic(JSON.stringify({unsafeControl:true,sourceAlreadyRead:true,mandateRevoked:true,completionWithoutFinalFence:true,productPathUsesFinalFence:true}));
});
for(const mode of ['ready','outside','late-revoke','cancel'])test('actual Mission preserves selected-source scope and honest unsupported completion: '+mode,async t=>{
 const f=await setup(t,mode),rt=f.runtime.missionRuntime;rt.executionBudget=f.gate;
 rt.planner={async planNextWave(c){
  if(c.observations.some(o=>o.outcome==='success'))return {decision:'complete',actions:[],criteriaAssessment:c.mission.successCriteria.map(x=>({criterionId:x.criterionId,status:'satisfied',evidenceActionIds:c.observations.map(o=>o.actionId)}))};
  return {decision:'continue',actions:[{id:'selected',command:'선택한 대화 자료를 읽어줘',expectedToolName:toolName,arguments:f.request,dependencies:[],requirementIds:c.mission.goalContract.requirements.map(r=>r.requirementId)}]};
 }};
 const owner=f.runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'selected-mandate-test'});
 const mission=rt.createMission({objective:'선택한 대화 자료를 읽어줘',executionMandateId:f.quota.mandate.id,
  authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','high_impact']},
  successCriteria:[{statement:'선택한 대화 자료를 읽고 그 내용을 전부 사용자에게 표시했다.'}]});
 if(mode==='cancel')f.setTokenHook(()=>rt.cancelMission(mission.missionId));
 const result=await rt.runMission(mission.missionId),observed=result.observations.find(o=>o.toolName===toolName&&o.outcome==='success');
 assert.notEqual(result.status,'COMPLETED','a provider read or planner assertion must not prove the unsupported delivery criterion');
 if(mode==='ready'){assert.ok(observed,JSON.stringify({status:result.status,lastError:result.lastError,observations:result.observations}));assert.equal(observed.untrusted,true);assert.equal(observed.data.selectedSource.itemCount,1);}
 else assert.equal(observed,undefined);
});
test('source resource identity cannot accept claimed refs or arbitrary endpoint',()=>{
 const request={provider:'outlook',streamRef:'a'.repeat(64)};assert.equal(selectedSourceMandateRef({...request,rawText:'읽어줘'}),'source-inbox:outlook:'+request.streamRef);
 for(const patch of [{provider:'unknown'},{streamRef:'wrong'},{dataRefs:['*']},{baseUrl:'http://evil'},{rawText:{trusted:true}}])assert.throws(()=>selectedSourceMandateRef({...request,...patch}),/REQUEST_INVALID/);
});
