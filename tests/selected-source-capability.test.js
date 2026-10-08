import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {readSelectedSourceStream} from '../packages/core/src/personal-operations/selected-source-stream.js';
import {SelectedSourceClient} from '../apps/pc-agent/src/adapters/selected-source-client.js';
import {SELECTED_SOURCE_TOOL,SelectedSourceToolAdapter} from '../apps/runtime-compose/src/selected-source-capability-package.js';

for(const mode of ['ready','missing-binding','revoked-during-token','revoked-binding','wrong-stream','changed-before-verification','missing-final-fence','missing-verifier'])test('actual Core E/B/G selected metadata: '+mode,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-selected-capability-'));let current=true,runtime;
 const store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store);
 const page={provider:'outlook',account:'selected-account',scope:'Mail.ReadBasic',observedAt:'2026-10-07T00:00:00Z',items:[{id:'one',title:'회의 일정 확인'}]};
 const stream=inbox.ingest(page).stream,request={provider:'outlook',streamRef:stream};
 const server=createCoreServer(undefined,{adminToken:'synthetic-token',personalInbox:inbox});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));runtime?.coreFacade.cognition?.close();store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-selected-capability-'));rmSync(root,{recursive:true,force:true});});
 const binding={capabilityId:SELECTED_SOURCE_TOOL,providerId:'core-selected-inbox',accountRef:stream,deviceRef:null,scopes:['metadata.read:selected']};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 let calls=0;
 const client=new SelectedSourceClient({baseUrl:`http://127.0.0.1:${server.address().port}`,tokenProvider:async()=>{calls++;if(mode==='revoked-during-token')current=false;
  if(mode==='revoked-binding')runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
   permissionRevision:'source-1',observedAt:new Date().toISOString(),accountStatus:'revoked',observedAccountRef:stream,deviceStatus:'not-required',grantedScopes:[],verificationLevel:'live-probe',evidenceRef:'test:revoked'});
  return 'synthetic-token';}});
 runtime=createAgRuntime({env,taskEnv:env,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
  capabilityBindingResolver:({toolName})=>toolName===SELECTED_SOURCE_TOOL&&mode!=='missing-binding'?{required:true,binding,permissionRevision:'source-1'}:{required:false},
  selectedSourceAccess:{client,authorizeRequest:r=>current&&r.provider===request.provider&&r.streamRef===stream,
   readCurrentSnapshot:r=>{if(mode==='changed-before-verification')inbox.ingest({...page,observedAt:'2026-10-07T00:01:00Z',items:[{id:'one',title:'정정된 일정'}]});return readSelectedSourceStream(inbox,r,{checkAuthorized:()=>current});}}});
 assert.ok(runtime.selectedSourceActivation);
 if(mode!=='missing-binding')runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
  permissionRevision:'source-1',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:stream,deviceStatus:'not-required',grantedScopes:binding.scopes,
  verificationLevel:'live-probe',evidenceRef:'test:local-core-not-real-provider'});
 if(mode==='missing-final-fence'){const receive=runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);runtime.pcAgent.receiveExecutionPacket=p=>receive(p);}
 if(mode==='missing-verifier')runtime.verificationRuntime.capabilityPackageVerifier=null;
 const task=runtime.coreFacade.createMissionActionTask('선택 연결 자료를 읽어줘. 외부 발송이나 원본 수정은 하지 마.',{
  expectedToolName:SELECTED_SOURCE_TOOL,preparedArguments:{...request,...(mode==='wrong-stream'?{streamRef:'f'.repeat(64)}:{})},
  source:'trigger',sourceModule:'A_CORE',deviceId:'mission_executive'});
 assert.equal(task.plan.action.toolName,SELECTED_SOURCE_TOOL);assert.equal(task.plan.action.skillId,'selected_source_read_skill');
 assert.equal(task.plan.trustedMissionRoute.selected,true);
 t.diagnostic(JSON.stringify({mode,preparedArguments:task.plan.action.arguments}));
 const run=await runtime.orchestrationWorker.runTask(task.taskId),diagnostic=JSON.stringify({success:run.success,status:run.status,error:run.error,blockedReason:run.execution?.blockedReason,verification:run.executionVerification,readiness:run.capabilityReadiness});
 if(mode==='ready'){assert.equal(run.success,true,diagnostic);assert.equal(run.executionVerification.status,'passed',diagnostic);assert.equal(calls,1);assert.equal(store.summary().commitments.length,0);}
 else{assert.equal(run.success,false,diagnostic);if(['wrong-stream','missing-binding','missing-final-fence'].includes(mode))assert.equal(calls,0,diagnostic);}
});
test('adapter cannot execute without trusted runtime access channel',async()=>{
 const adapter=new SelectedSourceToolAdapter({client:{read:()=>assert.fail('must not read')},authorizeRequest:()=>true});
 await assert.rejects(()=>adapter.execute({provider:'outlook',streamRef:'a'.repeat(64)},{}),/FENCE_MISSING/);
});
