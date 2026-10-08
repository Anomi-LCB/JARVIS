import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {runLongTermMemoryComparison} from '../scripts/long-term-memory-comparison.mjs';

test('fixed paired corpus exercises actual execution, corrected and withdrawn recall, and owner/session isolation',async()=>{
 const report=await runLongTermMemoryComparison({repetitions:1});
 assert.equal(report.passed,true,JSON.stringify(report.runs.filter(v=>v.status!=='passed')));
 assert.equal(report.sourcesUnchanged,true);
 assert.equal(report.runs.length,16);
 assert.ok(report.paired.every(v=>v.policyEqual&&v.oraclePassed));
 assert.ok(report.runs.every(v=>v.oracle.actualExecutionVerified&&v.oracle.sourceUnchanged));
 assert.ok(report.runs.every(v=>v.cost.amount===null));
});

test('recall opt-out bypasses F, cognition planning and personal profile on initial plan and approval edit; default still recalls',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-recall-switch-'));
 let runtime;
 try{
  const calls={query:0,preference:0,cognition:0,profile:0};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'},
   personalContextProvider:()=>{calls.profile++;return null;}});
  const facade=runtime.coreFacade;
  facade.memoryStore={query:()=>{calls.query++;return [];},planningPreferenceContext:()=>{calls.preference++;return null;}};
  const original=facade.cognition.planningContext.bind(facade.cognition);
  facade.cognition.planningContext=(...args)=>{calls.cognition++;return original(...args);};
  const off=facade.createTask('파일 목록 보여줘',{userId:'local_user',metadata:{longTermMemory:false,doNotRemember:true}});
  assert.deepEqual(calls,{query:0,preference:0,cognition:0,profile:0});
  const revised=facade.replanTaskFromApprovalDecision(off,{decision:'edit',editRequest:{rawText:'파일 목록 보여줘'},decidedAt:new Date().toISOString()});
  assert.deepEqual(calls,{query:0,preference:0,cognition:0,profile:0});
  assert.equal(off.request.metadata.longTermMemory,false);
  assert.deepEqual(off.memoryContext,[]);
  assert.equal(off.planningContext,null);
  assert.equal(off.plan.cognitiveContext,undefined);
  assert.ok(revised);
  facade.createTask('파일 목록 보여줘',{userId:'local_user',metadata:{doNotRemember:true}});
  assert.ok(Object.values(calls).every(v=>v>0),JSON.stringify(calls));
 }finally{runtime?.coreFacade.cognition?.close();rmSync(root,{recursive:true,force:true});}
});
