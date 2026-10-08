import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {withMissionMandateFence} from '../packages/core/src/personal-operations/mission-mandate-fence.js';
import {localMandateFileRef} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

const dates={validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:3};
function setup(t,kind,mode,{workspaceOnly=false}={}){
 const root=mkdtempSync(join(tmpdir(),'jarvis-read-scope-'));mkdirSync(join(root,'a'));mkdirSync(join(root,'b'));
 const marker='SYNTHETIC_PRIVATE_CONTENT_2937';writeFileSync(join(root,'a','public.txt'),'approved content');writeFileSync(join(root,'b',marker+'.txt'),marker);writeFileSync(join(root,'b','public.txt'),marker);
 symlinkSync(join(root,'a'),join(root,'alias'),'junction');
 const store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 const actual=join(root,workspaceOnly?'a':'alias',...(kind==='read'?['public.txt']:[]));
 const allowed=mode==='outside'?join(root,'b',...(kind==='read'?['public.txt']:[])):actual;
 const quota=gate.createQuota({...dates,scope:{accountRef:null,dataRefs:[localMandateFileRef(allowed,root)],deniedDataRefs:[]}}),mission={missionId:'synthetic-read',executionMandateId:quota.mandate.id};gate.beforeRun(mission);
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[workspaceOnly?join(root,'a'):root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
 t.after(()=>{runtime.close?.();runtime.coreFacade.cognition?.close();store.close();rmSync(root,{recursive:true,force:true});});
 const task=runtime.coreFacade.createTask(kind==='read'?'public.txt 내용을 읽어줘':'파일 목록 보여줘');
 assert.equal(task.plan.action.toolName,kind==='read'?'filesystem.readText':'filesystem.listFiles');
 task.plan.action.arguments=kind==='read'?{path:actual,maxChars:100}:{directory:actual,maxItems:100};
 const adapter=runtime.pcAgent.registry.get(task.plan.action.toolName),shadow=adapter.shadow.bind(adapter);let shadows=0;
 adapter.shadow=async(...args)=>{
  const result=await shadow(...args);
  if(++shadows===1&&mode==='shadow-revoke')store.revokeMandate(quota.mandate.id);
  return result;
 };
 if(kind==='read'){
  const normalize=adapter.normalize.bind(adapter);let n=0;
  adapter.normalize=async(...args)=>{
   const result=await normalize(...args);
   if(++n===2){
    if(mode==='late-revoke')store.revokeMandate(quota.mandate.id);
    if(mode==='alias-change'){renameSync(join(root,'alias'),join(root,'old-alias'));symlinkSync(join(root,'b'),join(root,'alias'),'junction');}
   }return result;
  };
 }else{
  adapter.shadow=async(...args)=>{
   const result=await shadow(...args);shadows++;
   if(shadows===(mode==='shadow-revoke'?1:2)){
    if(mode==='shadow-revoke'||mode==='late-revoke')store.revokeMandate(quota.mandate.id);
    if(mode==='alias-change'){renameSync(join(root,'alias'),join(root,'old-alias'));symlinkSync(join(root,'b'),join(root,'alias'),'junction');}
   }return result;
  };
 }
 const hooks=withMissionMandateFence({mission,gate,executor:runtime.pcAgent,hooks:null,workspaceRoot:root});
 return {runtime,task,hooks,marker,gate,quota,root,shadows:()=>shadows};
}

for(const kind of ['read','list'])for(const mode of ['ready','outside','shadow-revoke','late-revoke','alias-change'])test(`actual scoped ${kind}: ${mode}`,async t=>{
 const f=setup(t,kind,mode),result=await f.runtime.orchestrationWorker.runTask(f.task.taskId,{localEffectHooks:f.hooks});
 assert.equal(result.success,mode==='ready',JSON.stringify({error:result.error,reason:result.execution?.blockedReason}));
 assert.equal(JSON.stringify(result).includes(f.marker),false);
 if(mode==='ready'){
  assert.equal(result.executionVerification.status,'passed');
  if(kind==='read')assert.equal(result.execution.executionResult.stdoutPreview,'approved content');
  else assert.equal(result.execution.executionResult.listedItems[0].name,'public.txt');
 }else if(mode==='outside')assert.equal(f.shadows(),0);
});

for(const [kind,mode] of [['read','ready'],['read','outside'],['list','ready']])test(`actual scoped readonly Mission: ${kind}/${mode}`,async t=>{
 const f=setup(t,kind,mode,{workspaceOnly:kind==='list'}),rt=f.runtime.missionRuntime;
 rt.executionBudget=f.gate;
 rt.planner={async planNextWave(c){
  if(c.observations.some(o=>o.outcome==='success'))return {decision:'complete',actions:[],criteriaAssessment:c.mission.successCriteria.map(x=>({criterionId:x.criterionId,status:'satisfied',evidenceActionIds:c.observations.map(o=>o.actionId)}))};
  return {decision:'continue',actions:[{id:'read',command:kind==='read'?'public.txt 내용을 읽어줘':'파일 목록 보여줘',expectedToolName:f.task.plan.action.toolName,arguments:f.task.plan.action.arguments,dependencies:[],requirementIds:c.mission.goalContract.requirements.map(r=>r.requirementId)}]};
 }};
 const owner=f.runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'scoped-read-test'});
 const objective=kind==='read'?"'public.txt' 내용을 읽어줘":'작업 폴더의 파일 목록을 보여줘. 파일을 생성하거나 수정하지 마.';
 const created=rt.createMission({objective,executionMandateId:f.quota.mandate.id,
  authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY]},
  successCriteria:kind==='list'?[`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`]
   :[{statement:'새 파일로 저장한 결과',verificationSpec:{version:1,kind:'text.equals',path:'a/public.txt',equals:'approved content'}}]});
 const result=await rt.runMission(created.missionId);
 const diagnostic=JSON.stringify({status:result.status,lastError:result.lastError,observations:result.observations.map(o=>o.error)});
 if(kind==='read'&&mode==='ready'){
  // A read is not evidence of creating an artifact. Preserve the final G
  // denial instead of changing that contract to make this fixture green.
  assert.equal(result.status,'PAUSED',diagnostic);
  assert.equal(result.observations[0].outcome,'success');
  assert.equal(result.observations[0].data.textRead.content,'approved content');
  assert.ok(result.observations.some(o=>o.error?.code==='A_MISSION_COMPLETION_EVIDENCE_INSUFFICIENT'));
 }else assert.equal(result.status==='COMPLETED',mode==='ready',diagnostic);
 assert.equal(JSON.stringify(result).includes(f.marker),false);
 if(mode==='ready')assert.equal(result.gates.length,0);
 else assert.equal(f.shadows(),0);
});
