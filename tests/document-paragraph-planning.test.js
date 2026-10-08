import test from 'node:test';
import assert from 'node:assert/strict';
import {GoalExecutivePlanner,buildMissionPlanningPrompt} from '../packages/core/src/mission/mission-planner.js';
const context=()=>({mission:{objective:'report.docx 확인해',waveCount:0,successCriteria:[{criterionId:'body',statement:'본문 순서를 확인한다.',verificationSpec:{version:1,kind:'document.paragraphs',path:'report.docx',equals:['제목','첫 문단','둘째 문단']}}]},observations:[],capabilities:[{toolName:'filesystem.readText',readOnly:true,executionStrategy:{rank:1,score:150,planningMode:'deterministic',modelRoundTrips:0}}]});
test('plain file bootstrap cannot replace ordered Word paragraph verification',()=>{
 assert.equal(new GoalExecutivePlanner({runner:async()=>''}).planDeterministicBootstrap(context()),null);
});
test('normal untyped file read retains the deterministic fast path',()=>{
 const c=context();c.mission.successCriteria=[];
 assert.equal(new GoalExecutivePlanner({runner:async()=>''}).planDeterministicBootstrap(c)?.actions[0].expectedToolName,'filesystem.readText');
});
test('normal planner receives original paragraph criterion without modifying caller data',()=>{
 const c=context(),original=structuredClone(c.mission.successCriteria);
 const prompt=buildMissionPlanningPrompt({...c,today:'2026-10-08'});
 for(const value of ['document.paragraphs','첫 문단','둘째 문단'])assert.ok(prompt.includes(value));
 assert.deepEqual(c.mission.successCriteria,original);
});
