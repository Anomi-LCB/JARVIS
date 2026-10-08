import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';

async function setup(t,{observed=true,requiredTool='filesystem.listFiles'}={}){
 const root=await mkdtemp(join(tmpdir(),'jarvis-direct-readiness-'));let now=Date.now();
 await writeFile(join(root,'material.txt'),'synthetic material');
 const binding={capabilityId:'workflow.execute',providerId:'isolated-direct-provider',accountRef:'synthetic-account',deviceRef:null,scopes:['synthetic.read']};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,clock:()=>new Date(now),
  capabilityBindingResolver:({toolName})=>toolName===requiredTool?{required:true,binding,permissionRevision:'direct-1'}:{required:false}});
 t.after(async()=>{runtime.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});});
 const observe=changes=>runtime.capabilityPackageRegistry.recordAvailability({...binding,
  codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'direct-1',
  observedAt:new Date(++now).toISOString(),accountStatus:'connected',observedAccountRef:binding.accountRef,
  deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'isolated-direct-readiness',...changes});
 if(observed)observe();
 const task=runtime.coreFacade.createTask('파일 목록 보여줘');let packets=0;
 const receive=runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
 runtime.pcAgent.receiveExecutionPacket=(...args)=>{packets++;return receive(...args);};
 return {runtime,task,observe,root,packets:()=>packets};
}
test('direct worker missing provider observation blocks before PC dispatch',async t=>{
 const f=await setup(t,{observed:false});const run=await f.runtime.orchestrationWorker.runTask(f.task.taskId);
 assert.equal(run.success,false);assert.equal(run.error.code,'A_WORKER_CAPABILITY_UNAVAILABLE');assert.equal(f.packets(),0);
});
test('direct worker rechecks revocation after async preflight even without a Mission callback',async t=>{
 const f=await setup(t),worker=f.runtime.orchestrationWorker,batch=worker.runVerificationIndexBatch.bind(worker);
 worker.runVerificationIndexBatch=async(operation,callback)=>{const value=await batch(operation,callback);if(operation==='worker.preflight.index')f.observe({accountStatus:'revoked'});return value;};
 const run=await worker.runTask(f.task.taskId);
 assert.equal(run.success,false);assert.equal(run.error.code,'A_WORKER_CAPABILITY_UNAVAILABLE');assert.equal(f.packets(),0);
 assert.ok(run.capabilityReadiness.reasons.some(x=>x.code==='account-revoked'));
});
test('direct worker exact ready binding retains actual local execution and G verification',async t=>{
 const f=await setup(t);const run=await f.runtime.orchestrationWorker.runTask(f.task.taskId);
 assert.equal(run.success,true);assert.equal(run.executionVerification.status,'passed');assert.equal(f.packets(),1);
});
test('direct graph inspects a required later tool before dispatching any earlier action',async t=>{
 const f=await setup(t,{observed:false,requiredTool:'filesystem.readText'});
 const task=f.runtime.coreFacade.createTask('파일 목록 보여줘 그리고 파일 목록 보여줘');
 const nodes=task.plan.planGraph.nodes.filter(x=>x.nodeId.startsWith('action_'));
 assert.equal(nodes.length,2);
 nodes[1].toolName='filesystem.readText';nodes[1].actionType='READ_TEXT';nodes[1].arguments={path:join(f.root,'material.txt')};
 const run=await f.runtime.orchestrationWorker.runTask(task.taskId);
 assert.equal(run.success,false);assert.equal(run.error.code,'A_WORKER_CAPABILITY_UNAVAILABLE');
 assert.equal(run.capabilityReadiness.phase,'planning');assert.equal(f.packets(),0);
});
test('queued direct request cannot bypass missing provider readiness or dispatch on retry',async t=>{
 const f=await setup(t,{observed:false}),worker=f.runtime.orchestrationWorker;
 worker.enqueueTask(f.task.taskId,{maxAttempts:2});
 await worker.drain({limit:1});
 assert.equal(f.packets(),0);assert.equal(worker.queue[0].status,'failed');
 assert.equal(worker.queue[0].lastError,'A_WORKER_CAPABILITY_UNAVAILABLE');
});
for(const revokeAt of [null,1,2])test(`direct worker file fence protects adapter shadow boundary; revokeAt=${revokeAt}`,async t=>{
 const f=await setup(t,{requiredTool:'filesystem.createTextFile'});
 const task=f.runtime.coreFacade.createTask('guard-result 텍스트 파일을 만들어줘'),target=join(f.root,'guard-result.txt');
 assert.equal(task.plan.action.toolName,'filesystem.createTextFile');
 task.plan.action.arguments={path:target,content:'synthetic guarded result'};
 const adapter=f.runtime.pcAgent.registry.get('filesystem.createTextFile'),shadow=adapter.shadow.bind(adapter);let shadows=0;
 adapter.shadow=async(...args)=>{const value=await shadow(...args);if(++shadows===revokeAt)f.observe({accountStatus:'revoked'});return value;};
 const run=await f.runtime.orchestrationWorker.runTask(task.taskId);
 if(revokeAt===null){
  assert.equal(shadows,2);assert.equal(run.success,true);assert.equal(run.executionVerification.status,'passed');
  assert.equal(await readFile(target,'utf8'),'synthetic guarded result');
 }else{
  assert.equal(shadows,revokeAt);assert.equal(run.success,false);
  assert.equal(run.execution.blockedReason,revokeAt===1?'A_WORKER_CAPABILITY_UNAVAILABLE':'A_WORKER_CAPABILITY_REVOKED');
  await assert.rejects(readFile(target),{code:'ENOENT'});
 }
});
test('a bound executor without the trusted final-fence channel blocks without leaving an executing task',async t=>{
 const f=await setup(t);f.runtime.pcAgent.supportsTrustedLocalMissionEffects=()=>false;
 const run=await f.runtime.orchestrationWorker.runTask(f.task.taskId);
 assert.equal(run.error.code,'A_WORKER_CAPABILITY_UNAVAILABLE');assert.equal(f.packets(),0);
 assert.equal(run.capabilityReadiness.reasons[0].code,'executor-availability-fence-unsupported');
 assert.notEqual(f.task.status,'EXECUTING');assert.ok(run.error.message);
});
