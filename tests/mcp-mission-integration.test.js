import {createMcpIntentBinding} from '../packages/core/src/capabilities/mcp-intent-binding.js';
import {projectMcpRuntimeReadiness} from '../packages/core/src/personal-operations/mcp-runtime-readiness.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {McpConnectionManager} from '../packages/core/src/personal-operations/mcp-connections.js';
import {createMcpCapabilityPackage} from '../packages/core/src/capabilities/mcp-capability-package.js';
import {registerMissionArgumentSchema} from '../packages/core/src/planning/mission-action-arguments.js';

async function runFixture(t,withIntent=false){
 const root=mkdtempSync(join(tmpdir(),'jarvis-mcp-mission-'));t.after(()=>{manager.close();rmSync(root,{recursive:true,force:true});});
 let calls=0,failDiscovery=false,onDiscovery=null;
 const tool={name:'sum',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}};
 const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const rpc=JSON.parse(raw);if(rpc.id==='dispatch-tools-list')onDiscovery?.();if(failDiscovery&&rpc.method==='tools/list'){res.writeHead(503);res.end('fixture unavailable');return;}const result=rpc.method==='tools/list'?{tools:[tool]}:(calls++,{content:[{type:'text',text:'answer'}],structuredContent:{answer:withIntent==='wrong-result'?99:5}});res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});
 const address=await listenOnFetchSafePort(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite')});t.after(()=>manager.close());
 const entry=manager.add({label:'Mission fixture',endpoint:`http://127.0.0.1:${address.port}/mcp`,protocolVersion:'2026-07-28'});
 await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['sum']});
 manager.registerCapabilityContract(entry.id,{tool:'sum',contractHash:manager.get(entry.id).tools[0].contractHash,packageId:'fixture.sum',version:'1.0.0',source:'https://example.org/source',effect:withIntent==='unsupported-write'?'external-effect':'read',verifierId:'sum.oracle',verifierFingerprint:'b'.repeat(64)});
 const verifiers=new Map([['sum.oracle',{fingerprint:'b'.repeat(64),verify:({arguments:args,result})=>({valid:args.a+args.b===result.structuredContent.answer,evidenceRef:'local:arithmetic'})}]]);
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 let runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,
  ...(withIntent==='resolver-denial'?{capabilityBindingResolver:()=>({required:false})}:{})});
 t.after(()=>runtime.coreFacade.cognition?.close());
 const intentBinding=withIntent?createMcpIntentBinding({manager,connectionId:entry.id,tool:'sum',fingerprint:'d'.repeat(64),resolver:objective=>{const m=/^등록된 MCP로 (\d+)와 (\d+)의 합을 검증해$/.exec(objective);return m?{arguments:{a:Number(m[1]),b:Number(m[2])},expectedText:'answer'}:null;}}):null;
 if(withIntent==='unsupported-write'){
  assert.throws(()=>createMcpCapabilityPackage({manager,connectionId:entry.id,tool:'sum',authorize:()=>({allowed:true}),verifiers,intentBinding}),{code:'A_MCP_CAPABILITY_EFFECT_NOT_SUPPORTED'});
  assert.equal(calls,0);runtime.coreFacade.cognition.close();return;
 }
 const definition=createMcpCapabilityPackage({manager,connectionId:entry.id,tool:'sum',authorize:()=>({allowed:true}),verifiers,intentBinding});
 runtime.capabilityPackageRegistry.activate(definition,{skillRouter:runtime.coreFacade.skillRouter,adapterRegistry:runtime.pcAgent.registry,evidenceSchemaRegistry:runtime.pcAgent.evidenceCollector.schemaRegistry,registerArgumentSchema:registerMissionArgumentSchema});
 const readiness=()=>projectMcpRuntimeReadiness(manager.list(),{packageRegistry:runtime.capabilityPackageRegistry,adapterRegistry:runtime.pcAgent.registry})[0].capabilityReadiness[0];
 assert.equal(readiness().packageInstalled,true);
 assert.equal(readiness().intentBindingInstalled,Boolean(withIntent));
 assert.equal(readiness().autonomousExecutionAuthorized,false);
 assert.equal(projectMcpRuntimeReadiness(manager.list())[0].capabilityReadiness[0].packageInstalled,false);

 let planned=false;
 runtime.missionRuntime.planner={async planNextWave(){if(planned)return {decision:'complete',summary:'계산 검사 완료',actions:[],criteriaAssessment:[]};planned=true;return {decision:'continue',summary:'등록된 MCP 계산',criteriaAssessment:[],actions:[{id:'sum',title:'합계 확인',command:'등록된 MCP로 2와 3의 합을 검증해',expectedToolName:definition.skill.toolName,arguments:{...(withIntent?{objective:'등록된 MCP로 2와 3의 합을 검증해'}:{}),arguments:{a:withIntent==='mismatch'?3:2,b:withIntent==='mismatch'?2:3},requestId:'mission_sum_00000001',expectedText:'answer'},dependencies:[],successSignal:'독립 계산 검증 영수증'}]};}};
 const created=runtime.missionRuntime.createMission({objective:'등록된 MCP로 2와 3의 합을 검증해',authorization:{grants:['read_only']}});
 if(withIntent==='no-grant')manager.setAllowedTools(entry.id,{tools:[]});
 const waiting=await runtime.missionRuntime.runMission(created.missionId);
 if(withIntent==='no-grant'||withIntent==='resolver-denial'){
  assert.equal(waiting.status,'PAUSED');assert.equal(waiting.stopReason,'capability-unavailable');assert.equal(calls,0);
  assert.equal(waiting.pendingGates.length,0);assert.ok(waiting.lastError.reasons.some(r=>r.code==='binding-required'));return;
 }
 if(withIntent==='mismatch'){assert.equal(waiting.status,'PAUSED');assert.equal(calls,0);assert.equal(waiting.stopReason,'external-action-requirements-unverified');return;}
 if(withIntent){
  assert.equal(waiting.status,'WAITING_APPROVAL',JSON.stringify({status:waiting.status,error:waiting.lastError,wave:waiting.waves[0]}));
  assert.equal(calls,0);
  const plannedAction=runtime.missionRuntime.missions.get(created.missionId).waves[0].actions[0];
  assert.equal(plannedAction.availabilityBindingSnapshot.resolvedPermissionRevision,manager.get(entry.id).permissionRevision);
  assert.equal(plannedAction.availability.available,true);assert.equal(plannedAction.availability.executionAuthorized,false);
  const regrant=()=>{const peer=new McpConnectionManager({storePath:manager.storePath});try{peer.setAllowedTools(entry.id,{tools:[]});peer.setAllowedTools(entry.id,{tools:['sum']});}finally{peer.close();}};
  if(withIntent==='approval-regrant')regrant();
  if(['restart-regrant','restart-ready','restart-attempted','restart-rejected','restart-binding-tamper'].includes(withIntent)){
   const protectedRestore=['restart-attempted','restart-rejected','restart-binding-tamper'].includes(withIntent);
   if(withIntent==='restart-attempted')plannedAction.attempts=1;
   if(withIntent==='restart-binding-tamper')runtime.missionRuntime.missions.get(created.missionId).gates.find(g=>g.gateId===plannedAction.gateId).commandHash='0'.repeat(64);
   if(withIntent==='restart-rejected')runtime.missionRuntime.decideGate(created.missionId,waiting.pendingGates[0].gateId,{decision:'reject',decidedBy:'isolated-test'});
   runtime.missionRuntime.touch(runtime.missionRuntime.missions.get(created.missionId),'isolated-restoration-boundary');
   if(withIntent==='restart-regrant')regrant();runtime.coreFacade.cognition.close();
   runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
   runtime.capabilityPackageRegistry.activate(definition,{skillRouter:runtime.coreFacade.skillRouter,adapterRegistry:runtime.pcAgent.registry,evidenceSchemaRegistry:runtime.pcAgent.evidenceCollector.schemaRegistry,registerArgumentSchema:registerMissionArgumentSchema});
   assert.deepEqual(runtime.missionRuntime.missions.get(created.missionId).waves[0].actions[0].availabilityBindingSnapshot,plannedAction.availabilityBindingSnapshot);
   if(protectedRestore){
    const restored=runtime.missionRuntime.missions.get(created.missionId),action=restored.waves[0].actions[0];
    assert.equal(action.approvalRestoration,undefined);assert.equal(action.gateId,waiting.pendingGates[0].gateId);assert.equal(calls,0);
    if(withIntent==='restart-rejected')assert.equal(restored.gates.find(g=>g.gateId===action.gateId).status,'rejected');
    else{assert.equal(restored.gates.find(g=>g.gateId===action.gateId).status,'pending');const result=await runtime.missionRuntime.runMission(created.missionId);assert.equal(result.status,'WAITING_APPROVAL');assert.equal(calls,0);}
    console.log(JSON.stringify({scenario:withIntent,calls,approvalRestoration:'protected-original-state-preserved',observedAt:new Date().toISOString()}));return;
   }
   const approval=runtime.missionRuntime.decideGate(created.missionId,waiting.pendingGates[0].gateId,{decision:'approve',decidedBy:'isolated-test'});
   assert.equal(approval.success,false);assert.equal(approval.code??approval.error?.code,'A_MISSION_GATE_ALREADY_DECIDED');
   const restored=runtime.missionRuntime.missions.get(created.missionId),wave=restored.waves[0];
   assert.equal(restored.status,'PAUSED');assert.equal(wave.actions[0].approvalRestoration.previousGateId,waiting.pendingGates[0].gateId);
   const resumed=await runtime.missionRuntime.runMission(created.missionId);
   if(withIntent==='restart-regrant'){
    assert.equal(resumed.status,'PAUSED');assert.equal(calls,0);assert.ok(resumed.lastError.reasons.some(r=>r.code==='permission-revision-changed'));
   }else{
    assert.equal(resumed.status,'WAITING_APPROVAL');assert.equal(calls,0);assert.equal(resumed.pendingGates.length,1);
    assert.notEqual(resumed.pendingGates[0].gateId,waiting.pendingGates[0].gateId);
    const decision=runtime.missionRuntime.decideGate(created.missionId,resumed.pendingGates[0].gateId,{decision:'approve',decidedBy:'isolated-test'});assert.equal(decision.success,true);
    const done=await runtime.missionRuntime.runMission(created.missionId);assert.equal(done.status,'COMPLETED');assert.equal(done.verificationStatus,'passed');assert.equal(calls,1);
   }
   console.log(JSON.stringify({scenario:withIntent,status:runtime.missionRuntime.missions.get(created.missionId).status,calls,approvalRestoration:'old-gate-cancelled-current-policy-rebuilt',observedAt:new Date().toISOString()}));return;
  }
  if(withIntent==='discovery-loss')failDiscovery=true;
  if(withIntent==='cancel-discovery')onDiscovery=()=>runtime.missionRuntime.cancelMission(created.missionId,{reason:'isolated-user-cancel'});
  if(withIntent==='preflight-regrant'){
   const worker=runtime.orchestrationWorker,batch=worker.runVerificationIndexBatch.bind(worker);let changed=false;
   worker.runVerificationIndexBatch=async(operation,callback)=>{const result=await batch(operation,callback);if(!changed&&operation==='worker.preflight.index'){changed=true;regrant();}return result;};
  }
  if(withIntent==='shadow-regrant'){
   const adapter=runtime.pcAgent.registry.get(definition.skill.toolName),shadow=adapter.shadow.bind(adapter);let shadows=0;
   adapter.shadow=async(...args)=>{const result=await shadow(...args);if(++shadows===1)regrant();return result;};
  }
  runtime.missionRuntime.decideGate(created.missionId,waiting.pendingGates[0].gateId,{decision:'approve',decidedBy:'isolated-test'});
  const result=await runtime.missionRuntime.runMission(created.missionId);
  if(withIntent==='cancel-discovery'){
   assert.equal(result.status,'CANCELLED');assert.equal(calls,0);
   assert.equal(manager.verificationReceipt(entry.id,'mission_sum_00000001'),null);
   console.log(JSON.stringify({scenario:withIntent,status:result.status,calls,observedAt:new Date().toISOString()}));return;
  }
  if(['approval-regrant','restart-regrant','preflight-regrant','shadow-regrant','discovery-loss'].includes(withIntent)){
   assert.equal(result.status,'PAUSED');assert.equal(calls,0);assert.equal(manager.verificationReceipt(entry.id,'mission_sum_00000001'),null);
   if(withIntent==='approval-regrant')assert.ok(result.lastError.reasons.some(r=>r.code==='permission-revision-changed'));
   console.log(JSON.stringify({scenario:withIntent,status:result.status,calls,reason:result.stopReason,observedAt:new Date().toISOString()}));return;
  }
  if(withIntent==='wrong-result'){
   assert.equal(result.status,'PAUSED');assert.equal(calls,1);
   assert.equal(manager.verificationReceipt(entry.id,'mission_sum_00000001'),null);
   assert.equal(result.waves[0].actions[0].status,'failed');return;
  }
  assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,error:result.lastError}));
  assert.equal(result.verificationStatus,'passed');
  assert.equal(result.waves[0].actions[0].status,'succeeded');
  const observed=result.observations.find(observation=>observation.outcome==='success');
  assert.equal(observed.verification.status,'passed');
  assert.equal(result.goalCompletionCoverage.allowed,true);
  console.log(JSON.stringify({status:result.status,calls,executionVerification:observed.verification.status,sourceCoverage:result.goalCompletionCoverage.status,criterion:result.completion.criteria[0].verificationStatus}));
  assert.equal(calls,1);
  assert.equal(manager.verificationReceipt(entry.id,'mission_sum_00000001')?.status,'verified');
  const internal=runtime.missionRuntime.missions.get(created.missionId),action=internal.waves[0].actions[0],criterion=internal.successCriteria[0];
  assert.equal(runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,[action.actionId]).passed,true);
  if(withIntent==='permission-regrant'){
   const peer=new McpConnectionManager({storePath:manager.storePath});
   try{peer.setAllowedTools(entry.id,{tools:[]});peer.setAllowedTools(entry.id,{tools:['sum']});}finally{peer.close();}
   assert.equal(runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,[action.actionId]).passed,false);
   assert.equal(calls,1,'revocation must not dispatch again');return;
  }
  const evidence=runtime.pcAgent.taskEvidence(action.taskId),originalRequest=evidence.adapterEvidence.mcp.requestId;
  evidence.adapterEvidence.mcp.requestId='forged_request_00000001';
  assert.equal(runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,[action.actionId]).passed,false);
  evidence.adapterEvidence.mcp.requestId=originalRequest;
  // Reload the actual disk journal and discard the volatile evidence map.
  const journal=runtime.pcAgent.packetJournal;
  runtime.pcAgent.packetJournal=new journal.constructor({journalPath:journal.journalPath});
  runtime.pcAgent.evidenceCollector.items.clear();
  assert.equal(runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,[action.actionId]).passed,true);
  assert.equal(calls,1,'proof recovery must not call the provider again');
  const originalHash=action.operation.dispatch.actionSha256;
  action.operation.dispatch.actionSha256='0'.repeat(64);
  assert.equal(runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,[action.actionId]).passed,false);
  action.operation.dispatch.actionSha256=originalHash;
  const reloaded=runtime.pcAgent.packetJournal;
  runtime.pcAgent.packetJournal={receiptForOperation:()=>null,records:[]};
  assert.equal(runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,[action.actionId]).passed,false);
  runtime.pcAgent.packetJournal=reloaded;
  const {endpointHash,registeredAt,...binding}=manager.capabilityReadiness(entry.id,'sum').contract;
  manager.registerCapabilityContract(entry.id,{...binding,version:'1.0.1'});
  assert.equal(readiness().packageInstalled,false,'old package must not match a new contract');
  assert.equal(runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,[action.actionId]).passed,false);

  return;
 }
 assert.equal(waiting.status,'PAUSED');
 assert.equal(waiting.stopReason,'external-action-requirements-unverified');
 assert.equal(calls,0);assert.equal(waiting.pendingGates.length,0);
 assert.equal(waiting.lastError.resolution.toolName,definition.skill.toolName);
 assert.deepEqual(waiting.lastError.resolution.unresolvedRequirementIds,waiting.goalContract.unresolvedRequirementIds);
 assert.equal(waiting.lastError.resolution.executionAuthorized,false);
 assert.equal(waiting.waves[0].actions[0].requirementCoverage.effectScope.scope,'external');
 assert.ok(waiting.lastError.resolution.reasonCodes.includes('requirement-meaning-unresolved'));
 assert.equal(waiting.lastError.resolution.reasonCodes.includes('opaque-effect-scope-unverified'),false);
 assert.equal(waiting.lastError.resolution.resolutionStatus,'not-resolved');
 assert.equal(manager.verificationReceipt(entry.id,'mission_sum_00000001'),null);
 assert.ok(waiting.goalContract.unresolvedRequirementIds.length>0);
 console.log(JSON.stringify({missionStatus:waiting.status,stopReason:waiting.stopReason,calls,unresolvedRequirements:waiting.goalContract.unresolvedRequirementIds.length}));
}
test('MCP Mission refuses unresolved natural-language requirements before external execution',t=>runFixture(t));
test('reviewed MCP binding cannot activate an unsupported external write contract',t=>runFixture(t,'unsupported-write'));
test('installed whole-request binding reaches E and real MCP execution',t=>runFixture(t,true));
test('whole-request binding rejects changed operands before E or HTTP',t=>runFixture(t,'mismatch'));
test('wrong provider result cannot satisfy the MCP Mission criterion',t=>runFixture(t,'wrong-result'));
test('MCP Mission G rejects a receipt from a revoked and regranted permission generation',t=>runFixture(t,'permission-regrant'));
for(const mode of ['no-grant','resolver-denial','approval-regrant','restart-regrant','restart-ready','restart-attempted','restart-rejected','restart-binding-tamper','preflight-regrant','shadow-regrant','discovery-loss','cancel-discovery'])test(`MCP planned availability handles ${mode} at the provider boundary`,t=>runFixture(t,mode));
