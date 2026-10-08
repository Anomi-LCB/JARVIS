import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const out=resolve(process.argv[2]);
if(!out.startsWith(resolve('artifacts')+sep))throw Error('ARTIFACT_SCOPE_REQUIRED');
await mkdir(out,{recursive:false});
const save=(name,value)=>writeFile(join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const sha=value=>createHash('sha256').update(value).digest('hex');
const paths=['packages/core/src/mission/mission-runtime.js','packages/core/src/mission/read-only-text-proof.js',
 'packages/core/src/mission/read-only-text-batch-plan.js','packages/core/src/mission/criteria-evidence.js',
 'packages/core/src/planning/task-planner.js','apps/pc-agent/src/pc-agent-runtime.js'];
const hashes=()=>Promise.all(paths.map(async path=>({path,sha256:sha(await readFile(path))})));
const before=await hashes();await save('sources-before.json',before);
const results=[];
for(const [name,source] of [['empty',''],['short','합성 원문 3건'],['paged','a'.repeat(55000)+'😀']]){
 const root=await mkdtemp(join(tmpdir(),'jarvis-typed-input-pilot-'));let runtime;
 try{
  const protectedContent='보존해야 할 합성 자료';
  await writeFile(join(root,'source.txt'),source);await writeFile(join(root,'protected.txt'),protectedContent);
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
  const calls=[];const run=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  runtime.orchestrationWorker.runTask=(id,...args)=>{calls.push(runtime.coreFacade.getTask(id)?.plan.action.toolName);return run(id,...args);};
  const created=runtime.missionRuntime.createMission({objective:"'source.txt'를 읽어; 'protected.txt'를 읽어; 'protected.txt'는 삭제하지 마",
    metadata:{longTermMemory:false},authorization:{grants:['read_only']},budgets:{maxPlannerCalls:8,maxActions:8},
    successCriteria:[['source.txt',source],['protected.txt',protectedContent]].map(([path,equals])=>({statement:`${path} 입력 보존`,artifactRole:'input',verificationSpec:{version:1,kind:'text.equals',path,equals}}))});
  if(!created.success)throw Error(JSON.stringify(created));
  const startedAt=new Date().toISOString(),start=performance.now();
  const mission=await runtime.missionRuntime.runMission(created.missionId);
  const elapsedMs=performance.now()-start;
  const sourcePreserved=(await readFile(join(root,'source.txt'),'utf8'))===source;
  const protectedPreserved=(await readFile(join(root,'protected.txt'),'utf8'))===protectedContent;
  const summary={name,startedAt,finishedAt:new Date().toISOString(),elapsedMs,status:mission.status,calls,
   sourcePreserved,protectedPreserved,modelCalls:mission.metrics.plannerAttempts,questions:mission.pendingGates.filter(g=>g.type==='clarification').length,
   allGPassed:mission.observations.every(o=>o.verification.status==='passed'),actualCoreEBG:true,scriptedPlanner:false,
   mode:'New explicit-input contract version 2; not the original model comparison contract.',cost:null,formalAcceptanceChanged:false};
  summary.passed=summary.status==='COMPLETED'&&summary.sourcePreserved&&summary.protectedPreserved&&summary.modelCalls===0&&summary.questions===0&&summary.allGPassed;
  results.push(summary);await save(`${name}.json`,{summary,mission});
 }finally{
  runtime?.pcAgent.remoteOperationStore?.close();runtime?.coreFacade.cognition.close();
  if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('jarvis-typed-input-pilot-'))throw Error('CLEANUP_REJECTED');
  await rm(root,{recursive:true,force:true});
 }
}
const after=await hashes();await save('sources-after.json',after);
const result={observedAt:new Date().toISOString(),results,sourcesStable:JSON.stringify(before)===JSON.stringify(after),
 actualExternalModelCalls:0,privateData:false,productionActivation:false,originalExperimentChanged:false};
await save('result.json',result);console.log(JSON.stringify(result));
if(results.some(r=>!r.passed)||!result.sourcesStable)process.exitCode=1;
