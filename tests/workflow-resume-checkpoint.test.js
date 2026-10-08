import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowResumeCheckpoint,readWorkflowResumeCheckpoint} from '../packages/core/src/mission/workflow-resume-checkpoint.js';
const input={packet:{z:1,a:{y:2,b:3}},plan:{z:4,a:5},goalRevision:1,authorizationRevision:1};
test('original workflow approval serialization survives recursively reordered SQL snapshot keys',()=>{
 const saved=createWorkflowResumeCheckpoint(input);
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,reorder(value[k])])):value;
 saved.resumeAuthorization=reorder(saved.resumeAuthorization);
 assert.equal(JSON.stringify(readWorkflowResumeCheckpoint(saved)),JSON.stringify(input));
});
test('changed checkpoint source, hash or snapshot cannot become a resume permission',()=>{
 for(const mutate of [x=>{x.resumeAuthorization.packet.z=2;},x=>{x.resumeAuthorizationSource+=' ';},x=>{x.resumeAuthorizationSha256='0'.repeat(64);},x=>{x.resumeAuthorizationSource='null';}]){
  const saved=createWorkflowResumeCheckpoint(input);mutate(saved);assert.throws(()=>readWorkflowResumeCheckpoint(saved),/checkpoint invalid/);
 }
});
test('legacy checkpoint is accepted only if its original serialization hash still matches',()=>{
 const saved=createWorkflowResumeCheckpoint(input);delete saved.resumeAuthorizationSource;assert.deepEqual(readWorkflowResumeCheckpoint(saved),input);
 saved.resumeAuthorization={authorizationRevision:1,goalRevision:1,packet:input.packet,plan:input.plan};assert.throws(()=>readWorkflowResumeCheckpoint(saved),/checkpoint invalid/);
});
