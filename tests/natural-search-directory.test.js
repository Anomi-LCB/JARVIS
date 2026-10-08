import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';

test('ordinary Korean command preserves its explicit search folder through Core E B G F',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-natural-search-'));let runtime;
 try{
  const first=join(root,'first'),second=join(root,'다른 연구 자료.txt'),outside=join(root,'unregistered');
  await Promise.all([first,second,outside].map(p=>mkdir(p)));
  await writeFile(join(first,'report.txt'),'wrong folder');await writeFile(join(second,'report.txt'),'selected folder');
  const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  runtime=createAgRuntime({allowedRoots:[first,second],auditRoot:join(root,'audit'),cwd:()=>first,env,taskEnv:env,workerDaemonEnabled:false});
  for(const [open,close] of [["'","'"],['“','”'],['"','"'],['‘','’']]){
   const task=runtime.coreFacade.createTask(`${open}${second}${close} 폴더에서 report.txt 파일을 찾아줘`);
   assert.equal(task.plan.action.arguments.directory,second);
   assert.equal(task.plan.action.arguments.scope,'workspace');
   assert.equal(task.plan.action.arguments.query,'report.txt');
   const run=await runtime.orchestrationWorker.runTask(task.taskId,{deviceId:'isolated-search',userConfirmation:{confirmed:true}});
   assert.equal(run.success,true,JSON.stringify(run));
   assert.deepEqual(run.execution.executionResult.matches.map(m=>m.path),[join(second,'report.txt')]);
   assert.equal(run.executionVerification.status,'passed');
   assert.equal(run.learning.ingest.success,true);
  }
  const task=runtime.coreFacade.createTask(`'${outside}' 폴더에서 report.txt 파일을 찾아줘`);
  assert.equal(task.plan.action.arguments.directory,outside);
  const run=await runtime.orchestrationWorker.runTask(task.taskId,{userConfirmation:{confirmed:true}});
  assert.notEqual(run.success,true);
  const readTask=runtime.coreFacade.createTask(`'${second}' 폴더에서 report.txt 내용을 읽어줘`);
  assert.equal(readTask.plan.action.arguments.path,join(second,'report.txt'));
  const readRun=await runtime.orchestrationWorker.runTask(readTask.taskId,{userConfirmation:{confirmed:true}});
  assert.equal(readRun.success,true,JSON.stringify(readRun));
  assert.equal(readRun.execution.executionResult.stdoutPreview,'selected folder');
  const conflict=runtime.coreFacade.createTask(`'${second}' 폴더에서 '${join(first,'report.txt')}' 내용을 읽어줘`);
  assert.equal(conflict.plan.action.arguments.path,null);
  assert.notEqual((await runtime.orchestrationWorker.runTask(conflict.taskId,{userConfirmation:{confirmed:true}})).success,true);
  const combined=runtime.coreFacade.createTask(`'${first}' 폴더와 '${second}' 폴더에서 report.txt 파일을 찾아줘`);
  assert.deepEqual(combined.plan.action.arguments.directories,[first,second]);
  const combinedRun=await runtime.orchestrationWorker.runTask(combined.taskId,{userConfirmation:{confirmed:true}});
  assert.equal(combinedRun.success,true,JSON.stringify(combinedRun));
  assert.deepEqual(new Set(combinedRun.execution.executionResult.matches.map(m=>m.path)),new Set([join(first,'report.txt'),join(second,'report.txt')]));
  assert.equal(combinedRun.execution.executionResult.searchCompleteness.complete,true);
 }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
