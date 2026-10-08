import {mkdir,writeFile,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';
import {createModelPlanningRunner} from '../packages/core/src/mission/model-provider.js';
const output=resolve(process.argv[2]??'artifacts/local-model-clarification-20261008');
if(!output.startsWith(resolve('artifacts')+sep))throw Error('ARTIFACT_ROOT_REQUIRED');
await mkdir(output,{recursive:false});
const write=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const startedAt=new Date().toISOString(),model='gemma3:latest';
const sourcePaths=['packages/core/src/mission/mission-planner.js','packages/core/src/mission/model-provider.js','packages/core/src/mission/ollama-local-model-provider.js','packages/core/src/mission/ollama-loopback-transport.js','packages/core/src/mission/local-model-observation.js'];
await write('sources-before.json',await Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))));
const catalog=await (await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(3000)})).json();
const installed=catalog.models?.find(m=>m.name===model);
if(!installed||installed.remote_model||installed.remote_host||installed.size<1000000)throw Error('INSTALLED_LOCAL_MODEL_REQUIRED');
await write('contract.json',{startedAt,model,installed,objective:"'source.txt'를 읽어; 'protected.txt'는 삭제하지 마",plannedCases:1,
 expected:{fileRead:true,sourcePreserved:true,protectedPreserved:true,unnecessaryQuestions:0},
 mode:'Forced real model planner, real Core/E/PC/G; deterministic shortcut intentionally disabled only in this isolated probe.',
 actualCost:null,independentMeaningEvaluation:false,privateDataProvided:false,externalAccountCalls:false});
const root=await mkdtemp(join(tmpdir(),'jarvis-real-model-question-'));let runtime;
const calls=[],plans=[],requests=[];
try{
 await writeFile(join(root,'source.txt'),'합성 원문 3건');await writeFile(join(root,'protected.txt'),'보존해야 할 합성 자료');
 const runner=createModelPlanningRunner({provider:'ollama-local',model,timeoutMs:600000});
 const observed=async(prompt,options)=>(await observed.runWithReceipt(prompt,options)).output;
 Object.assign(observed,{provider:runner.provider,externalService:runner.externalService,model:runner.model});
 observed.runWithReceipt=async(prompt,options)=>{
  const index=requests.length;requests.push({index,startedAt:new Date().toISOString()});await write(`request-${index}.json`,{prompt,timeoutMs:options?.timeoutMs});
  try{const receipt=await runner.runWithReceipt(prompt,options);await write(`receipt-${index}.json`,receipt);return receipt;}
  catch(error){await write(`failure-${index}.json`,{observedAt:new Date().toISOString(),code:error.code,message:error.message,receipt:error.modelReceipt??null,diagnostics:error.diagnostics??null});throw error;}
 };
 const planner=new GoalExecutivePlanner({runner:observed,maxActionsPerWave:1,timeoutMs:600000,maxTransientRetries:0});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,workerDaemonEnabled:false,
  missionPlanner:{async planNextWave(context,options){const plan=await planner.planNextWave(context,options);plans.push(plan);await write(`plan-${plans.length-1}.json`,plan);console.log(JSON.stringify({stage:'plan',decision:plan.decision,questions:plan.questions??plan.question,reason:plan.planning?.reason}));return plan;}}});
 const execute=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
 runtime.orchestrationWorker.runTask=(id,...args)=>{calls.push(runtime.coreFacade.getTask(id)?.plan.action.toolName);return execute(id,...args);};
 const mission=runtime.missionRuntime.createMission({objective:"'source.txt'를 읽어; 'protected.txt'는 삭제하지 마",metadata:{longTermMemory:false},
  authorization:{grants:['read_only']},budgets:{maxPlannerCalls:2,maxActions:2,maxActiveRuntimeMs:1250000},
  successCriteria:[{statement:'원본 보존',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'합성 원문 3건'}},
   {statement:'삭제 금지 자료 보존',verificationSpec:{version:1,kind:'text.equals',path:'protected.txt',equals:'보존해야 할 합성 자료'}}]});
 const began=performance.now(),result=await runtime.missionRuntime.runMission(mission.missionId);
 const sourcePreserved=(await readFile(join(root,'source.txt'),'utf8'))==='합성 원문 3건';
 const protectedPreserved=(await readFile(join(root,'protected.txt'),'utf8'))==='보존해야 할 합성 자료';
 const summary={startedAt,finishedAt:new Date().toISOString(),elapsedMs:performance.now()-began,status:result.status,stopReason:result.stopReason,
 calls,sourcePreserved,protectedPreserved,questions:result.pendingGates.filter(g=>g.type==='clarification').flatMap(g=>g.questions??[g.question]),
 metrics:result.metrics,actualCost:null,actualModelCalls:requests.length,actualCoreEBG:true,scriptedPlans:false,formalAcceptanceChanged:false,
 outcome:result.status==='COMPLETED'&&calls.includes('filesystem.readText')&&sourcePreserved&&protectedPreserved?'passed':'failed'};
 await write('result.json',{summary,mission:result});console.log(JSON.stringify(summary));
 await write('sources.json',await Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))));
}finally{
 runtime?.pcAgent?.remoteOperationStore?.close();runtime?.coreFacade.cognition?.close();
 if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('jarvis-real-model-question-'))throw Error('CLEANUP_REJECTED');
 await rm(root,{recursive:true,force:true});
 // Reused Ollama belongs to the user: do not stop its process or unload its model.
}
