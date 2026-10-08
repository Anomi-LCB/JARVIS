import test from 'node:test';
import assert from 'node:assert/strict';
import {observeFailedTask,validateFailureObservations,archivedFailureTask} from '../packages/core/src/runtime/task-failure-observation.js';
const at='2026-10-06T00:00:00.000Z';
test('failure v2 preserves finite approved code and observed version without private messages or arbitrary codes',()=>{
 const task={taskId:'safe-failure',status:'FAILED',plan:{action:{toolName:'workflow.execute'}},executionResult:{executionResult:{error:{code:'WORKFLOW_NUMBER_INVALID',message:'PRIVATE_PASSWORD_123'},executionCodeVersion:'a'.repeat(64)}}};
 const observation=observeFailedTask(task,at);assert.equal(observation.version,2);assert.equal(observation.failureCode,'WORKFLOW_NUMBER_INVALID');assert.equal(observation.executionCodeVersion,'a'.repeat(64));
 assert.doesNotMatch(JSON.stringify(observation),/PRIVATE_PASSWORD|message/);validateFailureObservations([observation]);
 const archived=archivedFailureTask(observation);assert.equal(archived.executionResult.executionResult.error.code,'WORKFLOW_NUMBER_INVALID');assert.equal(archived.archivedObservation,true);
 task.executionResult.executionResult.error.code='PRIVATE_PASSWORD_123';task.executionResult.executionResult.executionCodeVersion='PRIVATE_VERSION';
 const unknown=observeFailedTask(task,at);assert.equal(unknown.failureCode,null);assert.equal(unknown.executionCodeVersion,null);assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE/);
 for(const patch of [{failureCode:'PRIVATE'},{executionCodeVersion:'bad'},{version:1},{executionAuthority:true}])assert.throws(()=>validateFailureObservations([{...observation,...patch}]));
 validateFailureObservations([{version:1,taskId:'legacy',status:'FAILED',observedAt:at,toolName:null,nativeRecovery:null}]);
});
