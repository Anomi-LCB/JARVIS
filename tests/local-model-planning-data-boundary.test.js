import test from 'node:test';
import assert from 'node:assert/strict';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';

async function delivered(service){
 let prompt;
 const runner=async value=>{prompt=value;return JSON.stringify({decision:'blocked',summary:'test only',blockedReason:'test-only',actions:[],criteriaAssessment:[]});};
 runner.provider=service==='loopback-ollama'?'ollama-local':'test';runner.externalService=service;runner.model='boundary-fixture';
 const planner=new GoalExecutivePlanner({runner,maxTransientRetries:0,timeoutMs:1000});
 await planner.planNextWave({mission:{objective:"'source.txt'를 읽어; 'protected.txt'는 삭제하지 마",successCriteria:[{criterionId:'c1',statement:'보호 자료 유지'}],constraints:[],remainingBudget:{waves:2,actions:2,plannerCalls:1,activeRuntimeMs:10000}},capabilities:[],observations:[]});
 assert.equal(typeof prompt,'string');return prompt;
}
test('pinned local Ollama preserves the user objective and criteria without an external classifier',async()=>{
 const prompt=await delivered('loopback-ollama');
 assert.ok(prompt.includes("'source.txt'를 읽어; 'protected.txt'는 삭제하지 마"));
 assert.ok(prompt.includes('보호 자료 유지'));assert.equal(prompt.includes('USER_TEXT_WITHHELD:CLASSIFICATION_UNAVAILABLE'),false);
});
for(const service of ['openai','unknown','loopback-ollama-remote','loopback-http']){
 test(`nonlocal or ambiguous service remains fail closed: ${service}`,async()=>{
  const prompt=await delivered(service);
  assert.equal(prompt.includes("'source.txt'를 읽어; 'protected.txt'는 삭제하지 마"),false);
  assert.equal(prompt.includes('보호 자료 유지'),false);
  assert.ok(prompt.includes('USER_TEXT_WITHHELD:CLASSIFICATION_UNAVAILABLE'));
 });
}
