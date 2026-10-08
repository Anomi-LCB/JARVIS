import test from 'node:test';
import assert from 'node:assert/strict';
import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
import {MissionRuntime} from '../packages/core/src/mission/mission-runtime.js';
import {taskView} from '../src/ui/workspace/model.js';
const input=source=>({source,questions:{value:'업체가 주장한 처리 속도 개선율'},valueFormats:{value:'digits'},sourceFields:{value:{label:'처리 속도 개선율',kind:'attributed-integer',actor:'업체',unit:'%'}}});
test('attributed numeric claim is extracted without promotion to an independently verified fact',async()=>{
 const result=await generateLocalSourceSummary(input('업체 주장: 처리 속도 개선율은 30%이다. 시험팀 주장: 처리 속도 개선율은 0%이다.'),{});
 assert.equal(result.output.facts.value,'30');assert.equal(result.fieldProvenance.value.claimedBy,'업체');
 assert.equal(result.fieldProvenance.value.basis,'source-claim');assert.equal(result.fieldProvenance.value.independentlyVerified,false);
 assert.equal(result.semanticAccuracyVerified,false);assert.equal(result.executionAuthorized,false);assert.equal(result.providerCalls,0);
});
test('claim attribution rejects quotes, conditions, wrong actors, duplicate or unsupported claims',async()=>{
 for(const source of ['"업체 주장: 처리 속도 개선율은 30%이다."','만약 업체 주장: 처리 속도 개선율은 30%이다.','다른 업체 주장: 처리 속도 개선율은 30%이다.','업체 주장: 처리 속도 개선율은 30%이다. 업체 주장: 처리 속도 개선율은 40%이다.','업체 주장: 처리 속도 개선율은 미정이다.','업체 주장: 처리 속도 개선율은 30%가 아니다.'])await assert.rejects(generateLocalSourceSummary(input(source),{}));
});
test('plain source declarations also remain independently unverified',async()=>{
 const result=await generateLocalSourceSummary({source:'기존 평균시간은 8초이다.',questions:{value:'기존 평균시간'},valueFormats:{value:'digits'},sourceFields:{value:{label:'기존 평균시간',kind:'integer',unit:'초'}}},{});
 assert.equal(result.fieldProvenance.value.basis,'source-declaration');assert.equal(result.fieldProvenance.value.independentlyVerified,false);
});
test('Mission projection never accepts an independently verified flag from a source receipt',()=>{
 const receipt={nodeId:'claim',op:'text.extractFields',status:'success',fieldProvenance:{value:{basis:'source-claim',sourceLabel:'개선율',claimedBy:'업체',independentlyVerified:true},bad:{basis:'verified-fact',sourceLabel:'허위',independentlyVerified:true}}};
 const observation=MissionRuntime.prototype.successObservation.call({}, {actualToolName:'workflow.execute'}, {}, {execution:{executionResult:{evidence:{workflow:{receipts:[receipt]}}}},executionVerification:{status:'passed'}});
 assert.equal(observation.data.workflow.receipts[0].fieldProvenance.value.independentlyVerified,false);
 assert.equal(Object.hasOwn(observation.data.workflow.receipts[0].fieldProvenance,'bad'),false);
 assert.deepEqual(taskView({observations:[observation]}).sourceClaims,[{claimedBy:'업체',sourceLabel:'개선율'}]);
 assert.deepEqual(taskView({observations:[{...observation,verification:{status:'failed'}}]}).sourceClaims,[]);
});
