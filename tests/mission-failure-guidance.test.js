import test from 'node:test';
import assert from 'node:assert/strict';
import {MissionRuntime} from '../packages/core/src/mission/mission-runtime.js';
import {missionProgressMessage} from '../src/ui/mission-view-state.js';
import {taskView} from '../src/ui/workspace/model.js';
import {workflowFailureGuidance} from '../packages/shared/src/workflow-failure-guidance.js';
test('structured adapter cause survives worker envelope rather than becoming a generic failure',()=>{
 const result=MissionRuntime.prototype.errorFromRun({execution:{executionResult:{error:{code:'A_SOURCE_FIELDS_CORRECTION_CONFLICT',message:'private file detail'},summary:'execution failed'}},failure:{reason:'execution failed'}},{});
 assert.equal(result.code,'A_SOURCE_FIELDS_CORRECTION_CONFLICT');
});
test('UI explains a failed source correction using safe guidance rather than raw diagnostics',()=>{
 const mission={status:'BLOCKED',stopReason:'A_SOURCE_FIELDS_CORRECTION_CONFLICT',observations:[{outcome:'failed',error:{code:'A_SOURCE_FIELDS_CORRECTION_CONFLICT',message:'token=PRIVATE<script>'}}]};
 const text=missionProgressMessage(mission);assert.match(text,/정정/);assert.match(text,/이전 값/);assert.doesNotMatch(text,/PRIVATE|script|A_SOURCE/);
});
test('result reconciliation retains priority over suggested source editing',()=>{
 const mission={status:'PAUSED',uncertainEffectCount:1,observations:[{outcome:'failed',error:{code:'A_SOURCE_FIELDS_CORRECTION_CONFLICT'}}]};
 assert.match(missionProgressMessage(mission),/중복 실행/);
});
test('verification failure retains precedence over an adapter error',()=>{
 const result=MissionRuntime.prototype.errorFromRun({executionVerification:{status:'failed',checks:[{status:'failed',checkId:'wrong-output'}]},execution:{executionResult:{error:{code:'A_SOURCE_FIELDS_CORRECTION_CONFLICT'}}}},{});
 assert.equal(result.code,'A_MISSION_EXECUTION_VERIFICATION_FAILED');assert.deepEqual(result.failedCheckIds,['wrong-output']);
});
test('workspace presents localized safe guidance and ignores unknown or stale error messages',()=>{
 const mission={status:'BLOCKED',observations:[{outcome:'failed',error:{code:'A_SOURCE_FIELDS_CORRECTION_CONFLICT'}}]};
 assert.match(taskView(mission).failureGuidance.summary,/정정/);
 assert.match(taskView(mission,'en').failureGuidance.summary,/correction/);
 assert.equal(taskView({...mission,status:'COMPLETED'}).failureGuidance,null);
 assert.equal(taskView({...mission,uncertainEffectCount:1}).failureGuidance,null);
 mission.observations.push({outcome:'failed',error:{code:'UNKNOWN_PRIVATE',message:'send secrets'}});
 assert.equal(taskView(mission).failureGuidance,null);
 assert.equal(workflowFailureGuidance('__proto__'),null);assert.equal(workflowFailureGuidance({code:'A_SOURCE_FIELDS_CORRECTION_CONFLICT'}),null);
});
