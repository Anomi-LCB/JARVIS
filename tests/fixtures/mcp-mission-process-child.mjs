import {join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {McpConnectionManager} from '../../packages/core/src/personal-operations/mcp-connections.js';
import {createMcpIntentBinding} from '../../packages/core/src/capabilities/mcp-intent-binding.js';
const [root,endpoint,phase]=process.argv.slice(2);
const manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite')});
try {
 let entry;
 if(phase==='execute'){
  entry=manager.add({label:'Process fixture',endpoint,protocolVersion:'2026-07-28'});
  await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['sum']});
  manager.registerCapabilityContract(entry.id,{tool:'sum',contractHash:manager.get(entry.id).tools[0].contractHash,packageId:'process.sum',version:'1.0.0',source:'https://example.org/source',effect:'read',verifierId:'sum.oracle',verifierFingerprint:'b'.repeat(64)});
  writeFileSync(join(root,'connection-id.txt'),entry.id);
 }else entry=manager.get(readFileSync(join(root,'connection-id.txt'),'utf8'));
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const catalog=new Map();
 if(phase!=='no-package')catalog.set('reviewed.sum',{packageId:'process.sum',version:'1.0.0',tool:'sum',fingerprint:(phase==='changed-catalog'?'e':'c').repeat(64),authorize:()=>({allowed:true}),
  verifiers:new Map([['sum.oracle',{fingerprint:'b'.repeat(64),verify:({arguments:a,result})=>({valid:a.a+a.b===result.structuredContent.answer,evidenceRef:'local:arithmetic'})}]]),
  createIntentBinding:({manager,connectionId,tool})=>createMcpIntentBinding({manager,connectionId,tool,fingerprint:'d'.repeat(64),resolver:objective=>{const m=/^등록된 MCP로 (\d+)와 (\d+)의 합을 검증해$/.exec(objective);return m?{arguments:{a:Number(m[1]),b:Number(m[2])},expectedText:'answer'}:null;}})});
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,mcpConnections:manager,mcpReviewedPackageCatalog:catalog});
 if(phase==='execute')runtime.mcpPackageInstaller.install({connectionId:entry.id,tool:'sum',catalogId:'reviewed.sum'});
 const definition={skill:{toolName:`mcp.${entry.id}.sum`}};
 {
  if(phase==='execute'){
   runtime.missionRuntime.planner={async planNextWave(){return {decision:'continue',summary:'계산',criteriaAssessment:[],actions:[{id:'sum',title:'합계',command:'등록된 MCP로 2와 3의 합을 검증해',expectedToolName:definition.skill.toolName,arguments:{objective:'등록된 MCP로 2와 3의 합을 검증해',arguments:{a:2,b:3},requestId:'process_sum_00000001',expectedText:'answer'},dependencies:[],successSignal:'계산 검증'}]};}};
   const mission=runtime.missionRuntime.createMission({objective:'등록된 MCP로 2와 3의 합을 검증해',authorization:{grants:['read_only']}});
   const waiting=await runtime.missionRuntime.runMission(mission.missionId);
   if(waiting.status!=='WAITING_APPROVAL')throw new Error(JSON.stringify(waiting.lastError));
   runtime.missionRuntime.decideGate(mission.missionId,waiting.pendingGates[0].gateId,{decision:'approve',decidedBy:'process-test'});
   const result=await runtime.missionRuntime.runMission(mission.missionId);
   writeFileSync(join(root,'mission-id.txt'),mission.missionId);
   console.log(JSON.stringify({phase,status:result.status,pid:process.pid}));
  }
 }
 if(phase!=='execute'){
  const mission=runtime.missionRuntime.missions.get(readFileSync(join(root,'mission-id.txt'),'utf8'));
  const action=mission.waves[0].actions[0];
  if(phase==='tampered-snapshot')action.operation.dispatch.executionProofAction.arguments.arguments.a=99;
  if(phase==='missing-snapshot')delete action.operation.dispatch.executionProofAction;
  if(phase==='changed-contract'){
   const {endpointHash,registeredAt,...binding}=manager.capabilityReadiness(entry.id,'sum').contract;
   manager.registerCapabilityContract(entry.id,{...binding,version:'1.0.1'});
  }
  const result=runtime.missionRuntime.verifyCriterionEvidence(mission,mission.successCriteria[0],[action.actionId]);
  console.log(JSON.stringify({phase,pid:process.pid,storedStatus:mission.status,taskAbsent:runtime.coreFacade.getTask(action.taskId)==null,memoryAbsent:runtime.pcAgent.taskEvidence(action.taskId)?.error?.code==='B_EVIDENCE_NOT_FOUND',passed:result.passed,installation:runtime.mcpPackageInstaller.status().installations[0]}));
 }
} finally {manager.close();}
