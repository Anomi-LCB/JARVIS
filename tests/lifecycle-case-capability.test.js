import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalLifecycleCases} from '../packages/core/src/personal-operations/lifecycle-cases.js';
import {LIFECYCLE_CASE_READ_TOOL,readLifecycleCaseSnapshot} from '../apps/runtime-compose/src/lifecycle-case-capability-package.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
for(const mode of ['ready','remote-executor','no-binding','revoked-before-read','revoked-after-read','revoked-during-oracle','binding-revoked','wrong-case','revision-changed','store-changed','forged-provider-completion','missing-oracle'])test('real Core/E/B/G case read: '+mode,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-case-cap-')),store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),cases=new PersonalLifecycleCases(store);let runtime,current=true,reads=0;
 const memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 t.after(()=>{runtime?.coreFacade.cognition?.close();memory.close();store.close();rmSync(root,{recursive:true,force:true});});
 const c=cases.create({requestId:'synthetic',kind:'return',provider:'shopify',accountRef:'synthetic',providerRef:'receipt',title:'합성 반품',dueAt:null});
 const request={caseId:c.id,expectedStoreId:cases.storeId,expectedRevision:c.revision},binding={capabilityId:LIFECYCLE_CASE_READ_TOOL,providerId:'core-local-case',accountRef:c.id,deviceRef:null,scopes:['case.read:selected']};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 runtime=createAgRuntime({env,taskEnv:env,memoryStore:memory,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,...(mode==='remote-executor'?{pcAgentExecutor:{getHealth:()=>assert.fail('must use installed Core read'),receiveExecutionPacket:()=>assert.fail('must use installed Core read')}}:{}),lifecycleCaseAccess:{
  resolveBinding:()=>mode==='no-binding'?{required:true}: {required:true,binding,permissionRevision:'case-1'},
  authorizeRequest:r=>current&&r.caseId===c.id&&r.expectedStoreId===cases.storeId,
  authorizeVerification:r=>current&&r.caseId===c.id,
  readSnapshot:async r=>{reads++;if(mode==='revoked-after-read')current=false;
   if(mode==='binding-revoked')runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'case-1',observedAt:new Date().toISOString(),accountStatus:'revoked',observedAccountRef:c.id,deviceStatus:'not-required',grantedScopes:[],verificationLevel:'live-probe',evidenceRef:'synthetic-revoked'});
   const snapshot=readLifecycleCaseSnapshot(cases,r);return mode==='forged-provider-completion'?{...snapshot,completionVerified:true}:snapshot;},
  readCurrentSnapshot:r=>{if(mode==='revision-changed')cases.record(c.id,'cancel',{eventId:'changed',expectedRevision:1,reason:'합성'});if(mode==='store-changed')throw Error('CASE_READ_STORE_CHANGED');const snapshot=readLifecycleCaseSnapshot(cases,r);if(mode==='revoked-during-oracle')current=false;return snapshot;}
 }});
 assert.ok(runtime.lifecycleCaseActivation);
 if(mode!=='no-binding')runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'case-1',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:c.id,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'synthetic-core-local-record'});
 if(mode==='missing-oracle')runtime.verificationRuntime.capabilityPackageVerifier=null;
 if(mode==='revoked-before-read')current=false;
 const task=runtime.coreFacade.createMissionActionTask('선택한 반품의 로컬 기록과 마감을 확인해. 실제 환불이나 취소는 하지 마.',{expectedToolName:LIFECYCLE_CASE_READ_TOOL,preparedArguments:{...request,...(mode==='wrong-case'?{caseId:'11111111-1111-1111-1111-111111111111'}:{})},source:'trigger',sourceModule:'A_CORE',deviceId:'mission_executive'});
 assert.equal(task.plan.action.toolName,LIFECYCLE_CASE_READ_TOOL);assert.equal(task.plan.action.skillId,'lifecycle_case_read_skill');
 const run=await runtime.orchestrationWorker.runTask(task.taskId);const diagnostic=JSON.stringify({mode,status:run.status,error:run.error,readiness:run.capabilityReadiness,verification:run.executionVerification,execution:run.execution});
 if(['ready','remote-executor'].includes(mode)){assert.equal(run.success,true,diagnostic);assert.equal(run.executionVerification.status,'passed');assert.ok(run.executionVerification.checks.some(c=>c.checkId==='lifecycle_case_current_core_verified'&&c.status==='passed'));assert.equal(reads,1);assert.equal(cases.get(c.id).revision,1);assert.equal(cases.get(c.id).completionVerified,false);}
 else{assert.equal(run.success,false,diagnostic);if(['no-binding','revoked-before-read','wrong-case'].includes(mode))assert.equal(reads,0);}
});
test('disabled by default: no lifecycle access means no new tool activation',()=>{
 const runtime=createAgRuntime({env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'},workerDaemonEnabled:false});try{assert.equal(runtime.lifecycleCaseActivation,null);assert.equal(runtime.pcAgent.registry.contractFor(LIFECYCLE_CASE_READ_TOOL),null);}finally{runtime.coreFacade.cognition?.close();}
});
