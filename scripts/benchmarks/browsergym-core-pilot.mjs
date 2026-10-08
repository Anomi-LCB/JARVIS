import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {parseArgs} from 'node:util';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {registerMissionArgumentSchema} from '../../packages/core/src/planning/mission-action-arguments.js';
import {createApprovalDecision} from '../../packages/shared/src/types.js';
import {createBrowserGymClient} from './browsergym-client.mjs';
import {createBrowserGymCapability,toolName} from './browsergym-capability.mjs';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {RemoteOperationStore} from '../../apps/pc-agent/src/remote-operation-store.js';
import {createBrowserGymEffectJournal} from './browsergym-effect-journal.mjs';
import {digest} from './browsergym-capability.mjs';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const {values:a}=parseArgs({options:{python:{type:'string'},miniwob:{type:'string'},chrome:{type:'string'},browsers:{type:'string'},output:{type:'string'},full:{type:'boolean',default:false},'drop-first-reply':{type:'boolean',default:false}}});
for(const key of ['python','miniwob','chrome','browsers','output'])if(!a[key])throw Error('REQUIRED:'+key);
const root=await mkdtemp(join(tmpdir(),'jarvis-browsergym-core-')),rows=[];
const client=createBrowserGymClient({python:resolve(a.python),worker:resolve(a['drop-first-reply']?'tests/fixtures/browsergym-drop-reply.py':'scripts/benchmarks/browsergym-worker.py'),miniwob:resolve(a.miniwob),chrome:resolve(a.chrome),stateFile:join(root,'worker-state.json'),browsersPath:resolve(a.browsers)});
let runtime,memory,effects,historyInspection=null,activeEpisode=null,authorized=true,campaignError=null,firstStep=true;
const reconciliations=[];
const runStep=async request=>{
 const inject=a['drop-first-reply']&&firstStep;firstStep=false;
 try{return await client.call('step',{request},inject?{timeoutMs:50}:{});}
 catch(error){
  if(error.message!=='BENCHMARK_RESPONSE_UNCERTAIN')throw error;
  const result=await client.reconcileStep(request);
  reconciliations.push({requestId:request.requestId,status:result.status,resendCount:0});
  if(result.status!=='matched')throw Error('BENCHMARK_EFFECT_UNRESOLVED');
  return result.receipt;
 }
};
const binding={capabilityId:toolName,providerId:'isolated-browsergym',accountRef:null,deviceRef:'owned-local-benchmark-worker',scopes:['benchmark.dom:isolated']};
try{
 const env={JARVIS_TEST_MODE:'0',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 runtime=createAgRuntime({env,taskEnv:env,memoryStore:memory,cognitionStorePath:join(root,'cognition.sqlite'),allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,workerDaemonEnabled:false,
  capabilityBindingResolver:()=>({required:true,binding,permissionRevision:'isolated-campaign-v1'})});
 const effectPath=join(root,'effects.sqlite'),keyPath=join(root,'archive-key'),key=randomBytes(32),authorizationHash=digest(binding);
 await writeFile(keyPath,key,{flag:'wx',mode:0o600});
 effects=new RemoteOperationStore({path:effectPath});
 const journal=createBrowserGymEffectJournal({store:effects,key,authorize:(_,r)=>authorized&&r.episodeId===activeEpisode,runStep});
 const definition=createBrowserGymCapability({runStep:(request,context)=>journal.execute(request,{...context,authorizationHash}),readState:client.readState,readTrustedTask:id=>runtime.coreFacade.getTask(id),authorize:r=>authorized&&r.episodeId===activeEpisode});
 runtime.capabilityPackageRegistry.activate(definition,{skillRouter:runtime.coreFacade.skillRouter,adapterRegistry:runtime.pcAgent.registry,evidenceSchemaRegistry:runtime.pcAgent.evidenceCollector.schemaRegistry,registerArgumentSchema:registerMissionArgumentSchema});
 for(const taskId of ['click-test','click-button','enter-text'])for(const seed of a.full?[17,43,89]:[17])for(const negative of [false,true]){
  let observation=await client.call('reset',{task:taskId,seed});activeEpisode=observation.episodeId;
  runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'isolated-campaign-v1',observedAt:new Date().toISOString(),accountStatus:'not-required',deviceStatus:'online',observedDeviceRef:binding.deviceRef,grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'actual-isolated-worker-reset:'+activeEpisode});
  const steps=[];let oracle=null,error=null;const start=Date.now();
  try{
   const actions=[];
   if(taskId==='enter-text'){
    const text=negative?'deliberately incorrect':/^Enter "(.+)" into the text field and press Submit[.]$/.exec(observation.goal)?.[1];
    if(!text)throw Error('CONTROL_GOAL_UNRECOGNIZED');
    actions.push({kind:'fill',bid:observation.elements.find(e=>e.role==='textbox').bid,text});
    actions.push({kind:'click',bid:observation.elements.find(e=>e.role==='button'&&e.name==='Submit').bid});
   }else if(negative)actions.push({kind:'noop'});
   else {const label=taskId==='click-test'?'Click Me!':/^Click on the "(.+)" button[.]$/.exec(observation.goal)?.[1];const element=observation.elements.find(e=>e.role==='button'&&e.name===label);if(!element)throw Error('CONTROL_TARGET_UNRECOGNIZED');actions.push({kind:'click',bid:element.bid});}
   for(const action of actions){
    const request={requestId:`episode_${activeEpisode}_${observation.revision}`,episodeId:activeEpisode,expectedRevision:observation.revision,action};
    const task=runtime.coreFacade.createMissionActionTask('격리 벤치마크 동작',{expectedToolName:toolName,preparedArguments:request,source:'trigger',sourceModule:'A_CORE',deviceId:'mission_executive',metadata:{longTermMemory:false}});
    if(task.plan?.action?.toolName!==toolName)throw Error('CORE_TOOL_ROUTING_FAILED:'+JSON.stringify({status:task.status,tool:task.plan?.action?.toolName}));
    let approvals=0;
    if(task.status==='WAITING_APPROVAL'){const decision=runtime.coreFacade.submitApprovalDecision(createApprovalDecision({approvalId:task.approvalCard.approvalId,taskId:task.taskId,decision:'approve',deviceId:'explicit-scripted-benchmark-approval'}));if(!decision.success)throw Error('APPROVAL_FAILED');approvals++;}
    const result=await runtime.orchestrationWorker.runTask(task.taskId);
    steps.push({taskId:task.taskId,request,success:result.success,verificationStatus:result.executionVerification?.status??null,approvals,error:result.error??null,failedChecks:result.executionVerification?.checks?.filter(c=>c.status==='failed').map(c=>c.checkId)??[]});
    if(!result.success||result.executionVerification?.status!=='passed')throw Error('CORE_EBG_FAILED:'+JSON.stringify({arguments:task.plan.action.arguments,execution:result.execution?.blockedReason,verification:result.executionVerification?.checks?.filter(c=>c.status==='failed')}));
    oracle=client.readState().receipt;observation=oracle.postState;
    // Repeat only the same worker operation key, never a new Core effect.
    const repeated=await client.call('step',{request});
    if(JSON.stringify(repeated)!==JSON.stringify(oracle)||client.readState().public.revision!==observation.revision)throw Error('DUPLICATE_EFFECT');
    steps.at(-1).duplicateReceiptVerified=true;
   }
  }catch(e){error=e.message;}
  rows.push({taskId,seed,policy:negative?'scripted-negative-control':'scripted-positive-control',coreEBG:!error,actualModelInvoked:false,wholeMissionEvaluated:false,steps,error,elapsedMs:Date.now()-start,oracle:oracle?{reward:oracle.reward,terminated:oracle.terminated,truncated:oracle.truncated}:null,taskCompleted:!error&&oracle?.reward===1&&oracle.terminated===true&&oracle.truncated===false,actualCost:null});
 }
 await client.close();effects.close();effects=null;
 const indexPath=join(root,'history-index.json');
 await writeFile(indexPath,JSON.stringify(rows.flatMap(r=>r.steps).map(s=>({taskId:s.taskId,request:s.request,authorizationHash}))),{flag:'wx'});
 const inspection=await promisify(execFile)(process.execPath,[resolve('scripts/benchmarks/browsergym-history-inspect.mjs'),effectPath,keyPath,indexPath],{windowsHide:true,timeout:10000});
 historyInspection=JSON.parse(inspection.stdout);
 if(historyInspection.pid===process.pid||historyInspection.results.length!==rows.flatMap(r=>r.steps).length)throw Error('HISTORY_INSPECTION_INVALID');
}catch(e){campaignError=e.message;
}finally{
 await client.close();effects?.close();runtime?.pcAgent.remoteOperationStore?.close();runtime?.coreFacade.cognition?.close();memory?.close();
 if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('jarvis-browsergym-core-'))throw Error('CLEANUP_BOUNDARY');
 await rm(root,{recursive:true,force:true});
}
const report={schemaVersion:'browsergym-core-scripted-pilot-v1',observedAt:new Date().toISOString(),rows,campaignError,expectedEpisodes:a.full?18:6,reconciliations,historyInspection,
 actualModelInvoked:false,wholeMissionEvaluated:false,jarvisAutonomousPerformance:null,officialLeaderboardScore:null,
 limitation:'Scripted policies through actual Core/E/B/G. Current worker snapshot verification does not prove general UI semantics or whole-Mission completion.'};
await writeFile(a.output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({episodes:rows.length,coreErrors:rows.filter(r=>r.error).map(r=>({task:r.taskId,error:r.error})),positiveCompleted:rows.filter(r=>r.policy==='scripted-positive-control'&&r.taskCompleted).length,negativeCompleted:rows.filter(r=>r.policy==='scripted-negative-control'&&r.taskCompleted).length,actualModelInvoked:false}));
if(campaignError||rows.length!==(a.full?18:6)||a['drop-first-reply']&&reconciliations.length!==1||rows.some(r=>r.error||r.taskCompleted!==(r.policy==='scripted-positive-control')))process.exitCode=1;
