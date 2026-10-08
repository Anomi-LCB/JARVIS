import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';

test('prepared Mission read uses the exact workspace-relative file and retains absolute and escaping targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-mission-relative-read-'));let runtime;
 try{
  const source=join(root,'source.txt');await writeFile(source,'synthetic preserved input');
  const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,workerDaemonEnabled:false});
  const sourceOptions={source:'trigger',sourceModule:'A_CORE',deviceId:'mission_executive'};
  const args={path:'source.txt'};
  const task=runtime.coreFacade.createMissionActionTask('source.txt 파일을 읽어줘',{...sourceOptions,expectedToolName:'filesystem.readText',preparedArguments:args});
  assert.equal(task.plan.action.arguments.path,source);assert.equal(args.path,'source.txt');
  const result=await runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(result.success,true,JSON.stringify(result));
  for(const path of [resolve('/workspace/source.txt'),'../outside.txt']){
   const blocked=runtime.coreFacade.createMissionActionTask('source.txt 파일을 읽어줘',{...sourceOptions,expectedToolName:'filesystem.readText',preparedArguments:{path}});
   assert.equal(blocked.plan.action.arguments.path,resolve(root,path));
   const outcome=await runtime.orchestrationWorker.runTask(blocked.taskId);
   assert.equal(outcome.success,false);
   assert.equal(JSON.stringify(outcome).includes('text-path-outside-allowed-roots'),true);
  }
 }finally{runtime?.pcAgent?.remoteOperationStore?.close();runtime?.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});}
});
