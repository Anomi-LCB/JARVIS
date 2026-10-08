import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FileWorkerQueueStore} from '../packages/core/src/runtime/worker-queue-store.js';
import {renderDirectTasks} from '../src/ui/workspace/direct-task-panel.js';
import {CoreOrchestrationWorker} from '../packages/core/src/orchestration/core-orchestration-worker.js';
const exec=promisify(execFile);
test('failed receipt survives a new OS process as authenticated read-only history, never executable authority',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-failure-restart-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const invoke=async(...args)=>JSON.parse((await exec(process.execPath,['tests/fixtures/task-failure-restart.mjs',...args],{env:{...process.env,JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}})).stdout.trim());
 const written=await invoke('write',root);assert.equal(written.status,'FAILED');assert.equal(written.success,false);
 const stored=JSON.parse(await readFile(join(root,'queue.json'),'utf8'));
 assert.equal(stored.failureObservations.length,1);assert.doesNotMatch(JSON.stringify(stored.failureObservations),/excluded-secret|rawText|capabilityToken|inputPath|ownerAuthorization/);
 const observed=await invoke('read',root,written.taskId);
 assert.equal(observed.status,200);assert.equal(observed.unauthorized,401);assert.equal(observed.detail.status,'FAILED');assert.equal(observed.detail.archivedObservation,true);
 assert.equal(observed.detail.executionVerification,null);assert.equal(observed.detail.executionResult.executionResult.nativeRecovery.autoRetryAllowed,false);
 assert.equal(observed.list.items.length,1);assert.equal(observed.runStatus,404);assert.equal(observed.executions,0);assert.equal(observed.processed,0);assert.equal(observed.liveTaskCount,0);
 assert.match(renderDirectTasks({active:observed.detail}),/자동 재시도 중지/);
 assert.match(renderDirectTasks({active:observed.detail}),/재시작 전 관측된 작업 기록/);
 console.log(JSON.stringify({realProcessRestart:true,authenticatedRead:true,runRejected:true,executions:observed.executions,archivedObservation:true}));
});
test('a later successful run removes an obsolete failure observation rather than reviving it on restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-latest-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const task={taskId:'same-task',status:'FAILED',plan:{action:{toolName:'excel.exportPdf'}}};
 const coreFacade={getTask:()=>task};const queueStore=new FileWorkerQueueStore({filePath:join(root,'queue.json')});
 const worker=new CoreOrchestrationWorker({coreFacade,queueStore});worker.storeRun({taskId:task.taskId,status:'failed'});assert.ok(worker.archivedTask(task.taskId));
 task.status='COMPLETED';worker.storeRun({taskId:task.taskId,status:'completed'});
 const restarted=new CoreOrchestrationWorker({coreFacade:{getTask:()=>null},queueStore});assert.equal(restarted.archivedTask(task.taskId),null);
});
test('observed workflow code version and safe error survive a real process restart without regaining execution authority',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-version-restart-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const invoke=async(...args)=>JSON.parse((await exec(process.execPath,['tests/fixtures/task-failure-restart.mjs',...args],{env:{...process.env,JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}})).stdout.trim());
 const original=await invoke('write-workflow',root),stored=JSON.parse(await readFile(join(root,'queue.json'),'utf8'));
 assert.equal(stored.failureObservations[0].version,2);assert.equal(stored.failureObservations[0].executionCodeVersion,original.executionCodeVersion);assert.equal(stored.failureObservations[0].failureCode,'WORKFLOW_NUMBER_INVALID');
 assert.doesNotMatch(JSON.stringify(stored.failureObservations),/PRIVATE_WORKFLOW_FAILURE/);
 const read=await invoke('read',root,original.taskId);assert.notEqual(read.pid,original.pid);assert.equal(read.status,200);
 assert.equal(read.detail.executionResult.executionResult.executionCodeVersion,original.executionCodeVersion);
 assert.equal(read.detail.executionResult.executionResult.error.code,'WORKFLOW_NUMBER_INVALID');
 assert.equal(read.detail.archivedObservation,true);assert.equal(read.executions,0);assert.equal(read.runStatus,404);
 t.diagnostic(JSON.stringify({oldPid:original.pid,newPid:read.pid,executionCodeVersion:original.executionCodeVersion,executions:read.executions,archivedObservation:true}));
});
test('legacy snapshots remain readable, malformed or executable archival claims are rejected before overwrite',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-observation-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'queue.json');const store=new FileWorkerQueueStore({filePath:path});
 const legacy={storeVersion:'a-worker-queue-store-v1',queue:[],runs:[]};await writeFile(path,JSON.stringify(legacy));assert.equal(store.load().failureObservations,undefined);
 const observation={version:1,taskId:'t',status:'FAILED',observedAt:'2026-10-03T00:00:00.000Z',toolName:null,nativeRecovery:null};
 for(const bad of [{...observation,status:'COMPLETED'},{...observation,ownerAuthorization:{}},{...observation,observedAt:'invalid'}]){
  assert.throws(()=>store.save({queue:[],runs:[],failureObservations:[bad]}),{code:'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'});assert.deepEqual(JSON.parse(await readFile(path,'utf8')),legacy);
 }
 await writeFile(path,JSON.stringify({...legacy,failureObservations:[{...observation,executionAuthority:true}]}));assert.throws(()=>store.load(),{code:'A_WORKER_QUEUE_STORE_CORRUPT'});
});
