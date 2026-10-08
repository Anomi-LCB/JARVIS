import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MobileAppRuntime} from '../apps/mobile/src/mobile-runtime.js';

async function setup(t,{observed=false,real=false}={}){
 const root=await mkdtemp(join(tmpdir(),'jarvis-bridge-readiness-'));let now=Date.now();
 const binding={capabilityId:'workflow.execute',providerId:'isolated-bridge-provider',accountRef:'synthetic-account',deviceRef:null,scopes:['synthetic.read']};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),outputPath:join(root,'legacy-output.txt'),env,taskEnv:env,
  workerDaemonEnabled:false,bridgeRealExecution:real,clock:()=>new Date(now),
  capabilityBindingResolver:({toolName})=>['filesystem.listFiles','filesystem.createTextFile'].includes(toolName)?{required:true,binding,permissionRevision:'bridge-1'}:{required:false}});
 t.after(async()=>{runtime.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});});
 const observe=changes=>runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
  permissionRevision:'bridge-1',observedAt:new Date(++now).toISOString(),accountStatus:'connected',observedAccountRef:binding.accountRef,
  deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'isolated-bridge-probe',...changes});
 if(observed)observe();
 const mobile=new MobileAppRuntime({bridgeRuntime:runtime.bridgeRuntime}),pairing=runtime.bridgeRuntime.pairing.start();
 assert.notEqual(mobile.pair({pairingCode:pairing.pairingCode,bridgeUrl:pairing.bridgeUrl}).success,false);
 const sent=mobile.sendCommand('파일 목록 보여줘');
 const approval=mobile.approvalQueue().items.find(x=>x.taskId===sent.taskId);assert.ok(approval);
 const approved=await mobile.decideApproval({approvalId:approval.approvalId,decision:'approve'});assert.ok(approved.handoffId);
 let packets=0;const receive=runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
 runtime.pcAgent.receiveExecutionPacket=(...args)=>{packets++;return receive(...args);};
 return {root,runtime,mobile,approved,observe,packets:()=>packets};
}
for(const real of [false,true])test(`paired Bridge handoff blocks missing provider observation; real=${real}`,async t=>{
 const f=await setup(t,{real});const result=await f.mobile.confirmExecution(f.approved.handoffId);
 assert.equal(result.success,false);assert.equal(result.error.code,'D_HANDOFF_CAPABILITY_UNAVAILABLE');assert.equal(f.packets(),0);
 assert.ok(result.nextAction);assert.equal(f.runtime.bridgeRuntime.handoffs.get(f.approved.handoffId).status,'awaiting_user_confirmation');
 await assert.rejects(readFile(join(f.root,'legacy-output.txt')),{code:'ENOENT'});
});
test('paired legacy single-packet handoff with exact observation keeps its explicit fixture behavior',async t=>{
 const f=await setup(t,{observed:true});const result=await f.mobile.confirmExecution(f.approved.handoffId);
 assert.equal(result.status,'COMPLETED');assert.equal(f.packets(),1);
 assert.equal(await readFile(join(f.root,'legacy-output.txt'),'utf8'),'파일 목록 보여줘');
 // This legacy fixture saves command text; it is not successful file-list fulfillment.
});
test('paired real worker handoff preserves actual E/B/G execution with a ready binding',async t=>{
 const f=await setup(t,{observed:true,real:true});const result=await f.mobile.confirmExecution(f.approved.handoffId);
 assert.equal(result.status,'COMPLETED');assert.equal(result.verificationStatus,'passed');assert.equal(f.packets(),1);
 await assert.rejects(readFile(join(f.root,'legacy-output.txt')),{code:'ENOENT'});
});
test('legacy Bridge rechecks revocation between initial readiness and packet handoff',async t=>{
 const f=await setup(t,{observed:true}),worker=f.runtime.orchestrationWorker,check=worker.assertTaskCapabilityAvailability.bind(worker);
 let planned=0;worker.assertTaskCapabilityAvailability=async(...args)=>{await check(...args);if(args[1]==='planning'&&++planned===2)f.observe({accountStatus:'revoked'});};
 const result=await f.mobile.confirmExecution(f.approved.handoffId);
 assert.equal(result.error.code,'D_HANDOFF_CAPABILITY_UNAVAILABLE');assert.equal(f.packets(),0);
 assert.ok(result.capabilityReadiness.reasons.some(x=>x.code==='account-revoked'));
 assert.equal(f.runtime.bridgeRuntime.results.size,0);
});
test('concurrent confirmation cannot dispatch the same legacy handoff twice',async t=>{
 const f=await setup(t,{observed:true}),worker=f.runtime.orchestrationWorker,check=worker.assertTaskCapabilityAvailability.bind(worker);
 let release;const barrier=new Promise(resolve=>{release=resolve;});let entered=0;
 worker.assertTaskCapabilityAvailability=async(...args)=>{if(args[1]==='planning'&&++entered<=2)await barrier;return check(...args);};
 const a=f.mobile.confirmExecution(f.approved.handoffId),b=f.mobile.confirmExecution(f.approved.handoffId);
 release();const results=await Promise.all([a,b]);
 assert.equal(f.packets(),1);assert.equal(results.filter(x=>x.status==='COMPLETED').length,1);
 assert.equal(results.filter(x=>x.error?.code==='D_HANDOFF_ALREADY_USED').length,1);
});
test('worker readiness denial during preflight releases only a proven undispatched handoff',async t=>{
 const f=await setup(t,{observed:true,real:true}),worker=f.runtime.orchestrationWorker,batch=worker.runVerificationIndexBatch.bind(worker);
 worker.runVerificationIndexBatch=async(operation,callback)=>{const value=await batch(operation,callback);if(operation==='worker.preflight.index')f.observe({accountStatus:'revoked'});return value;};
 const result=await f.mobile.confirmExecution(f.approved.handoffId);
 assert.equal(result.error.code,'D_HANDOFF_CAPABILITY_UNAVAILABLE');assert.equal(f.packets(),0);
 assert.equal(f.runtime.bridgeRuntime.handoffs.get(f.approved.handoffId).status,'awaiting_user_confirmation');
 assert.equal(f.runtime.bridgeRuntime.results.size,0);
});
test('actual legacy effect followed by response loss is not retried by a second confirmation',async t=>{
 const f=await setup(t,{observed:true}),receive=f.runtime.pcAgent.receiveExecutionPacket.bind(f.runtime.pcAgent);
 f.runtime.pcAgent.receiveExecutionPacket=async(...args)=>{await receive(...args);throw new Error('synthetic response loss');};
 await assert.rejects(f.mobile.confirmExecution(f.approved.handoffId),/synthetic response loss/);
 assert.equal(await readFile(join(f.root,'legacy-output.txt'),'utf8'),'파일 목록 보여줘');
 assert.equal(f.runtime.bridgeRuntime.handoffs.get(f.approved.handoffId).status,'execution_uncertain');
 const repeat=await f.mobile.confirmExecution(f.approved.handoffId);
 assert.equal(repeat.error.code,'D_HANDOFF_EXECUTION_UNCERTAIN');assert.ok(repeat.nextAction);assert.equal(f.packets(),1);
 assert.equal(f.runtime.bridgeRuntime.results.size,0);
});
test('legacy Bridge file mutation is fenced when account is revoked inside adapter shadow',async t=>{
 const f=await setup(t,{observed:true});
 const adapter=f.runtime.pcAgent.registry.get('filesystem.createTextFile'),shadow=adapter.shadow.bind(adapter);let shadows=0;
 adapter.shadow=async(...args)=>{const value=await shadow(...args);if(++shadows===2)f.observe({accountStatus:'revoked'});return value;};
 const result=await f.mobile.confirmExecution(f.approved.handoffId);
 assert.equal(shadows,2);assert.equal(result.error.code,'D_HANDOFF_CAPABILITY_UNAVAILABLE');assert.equal(f.packets(),1);
 await assert.rejects(readFile(join(f.root,'legacy-output.txt')),{code:'ENOENT'});
 assert.equal(f.runtime.bridgeRuntime.results.size,0);
 assert.equal(f.runtime.bridgeRuntime.handoffs.get(f.approved.handoffId).status,'execution_uncertain');
});
