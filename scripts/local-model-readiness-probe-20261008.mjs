import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';
import {createModelPlanningRunner} from '../packages/core/src/mission/model-provider.js';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'jarvis-model-readiness-'));let runtime;
const attempts=[],tools=[];
try{
 await writeFile(join(root,'source.txt'),'합성 원문');await writeFile(join(root,'protected.txt'),'보존 자료');
 const runner=createModelPlanningRunner({provider:'ollama-local',model:'gemma3:latest',timeoutMs:2000});
 const observed=async(prompt,options)=>(await observed.runWithReceipt(prompt,options)).output;
 Object.assign(observed,{provider:runner.provider,model:runner.model,externalService:runner.externalService});
 observed.runWithReceipt=async(prompt,options)=>{try{return await runner.runWithReceipt(prompt,options);}catch(e){attempts.push({code:e.code,diagnostics:e.diagnostics,receipt:e.modelReceipt});throw e;}};
 const planner=new GoalExecutivePlanner({runner:observed,maxTransientRetries:0,timeoutMs:2000});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,workerDaemonEnabled:false,missionPlanner:{planNextWave:(context,options)=>planner.planNextWave(context,options)}});
 const execute=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
 runtime.orchestrationWorker.runTask=(id,...args)=>{tools.push(runtime.coreFacade.getTask(id)?.plan.action.toolName);return execute(id,...args);};
 const mission=runtime.missionRuntime.createMission({objective:"'source.txt'를 읽어; 'protected.txt'는 삭제하지 마",metadata:{longTermMemory:false},authorization:{grants:['read_only']},
  budgets:{maxPlannerCalls:2,maxActions:2,maxActiveRuntimeMs:60000},successCriteria:[{statement:'원본 보존',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'합성 원문'}},{statement:'보호 자료 보존',verificationSpec:{version:1,kind:'text.equals',path:'protected.txt',equals:'보존 자료'}}]});
 const start=performance.now(),result=await runtime.missionRuntime.runMission(mission.missionId);
 const sourcePreserved=await readFile(join(root,'source.txt'),'utf8')==='합성 원문',protectedPreserved=await readFile(join(root,'protected.txt'),'utf8')==='보존 자료';
 assert.equal(result.status,'BLOCKED');assert.equal(result.stopReason,'mission-local-model-unavailable');
 assert.equal(attempts.length,1);assert.equal(attempts[0].diagnostics.transportCode,'ECONNREFUSED');assert.deepEqual(tools,[]);assert.ok(sourcePreserved&&protectedPreserved);
 const output={observedAt:new Date().toISOString(),elapsedMs:performance.now()-start,status:result.status,stopReason:result.stopReason,metrics:result.metrics,attempts,tools,sourcePreserved,protectedPreserved,
  actualNativeCatalogRequest:true,actualGenerationRequests:0,actualGCompletion:false,realAccountCalls:false,privateDataProvided:false,costUsd:null,formalAcceptanceChanged:false};
 await writeFile('artifacts/local-model-readiness-20261008-probe.json',JSON.stringify(output,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(output));
}finally{runtime?.pcAgent?.remoteOperationStore?.close();runtime?.coreFacade.cognition?.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('jarvis-model-readiness-'))throw Error('CLEANUP_REJECTED');await rm(root,{recursive:true,force:true});}
