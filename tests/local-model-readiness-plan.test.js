import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelPlanningRunner} from '../packages/core/src/mission/model-provider.js';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';
const context=()=>({mission:{objective:"'source.txt'를 읽어; 'protected.txt'는 삭제하지 마",successCriteria:[{criterionId:'preserve',statement:'원본 보존'}],constraints:[],remainingBudget:{plannerCalls:2,activeRuntimeMs:60000}},capabilities:[{toolName:'filesystem.readText'}],observations:[]});
for(const mode of ['catalog-refused','generation-reset','missing-model','remote-model']){
 test(`${mode}: unavailable local planner stops before speculative fallback actions`,async()=>{
  let calls=0;
  const runner=createModelPlanningRunner({provider:'ollama-local',model:'synthetic:local',fetchImpl:async()=>{
   calls++;
   if(mode==='catalog-refused')throw Object.assign(new Error('PRIVATE_PROVIDER_MESSAGE'),{code:'ECONNREFUSED'});
   if(mode==='missing-model')return Response.json({models:[]});
   if(mode==='remote-model')return Response.json({models:[{name:'synthetic:local',size:0,remote_host:'https://example.com'}]});
   if(calls===1)return Response.json({models:[{name:'synthetic:local',size:1000}]});
   throw Object.assign(new Error('PRIVATE_PROVIDER_MESSAGE'),{code:'ECONNRESET'});
  }});
  const result=await new GoalExecutivePlanner({runner,maxTransientRetries:0}).planNextWave(context());
  assert.equal(result.decision,'blocked');assert.deepEqual(result.actions,[]);
  assert.equal(result.blockedReason,'mission-local-model-unavailable');
  assert.equal(result.planning.nextAction,'restore-local-runtime-and-verify-installed-local-model');
  assert.equal(result.planning.attempts.length,1);assert.equal(calls,mode==='generation-reset'?2:1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_MESSAGE'),false);
 });
}
test('valid local provider plan still reaches registered tool validation',async()=>{
 let calls=0;const runner=createModelPlanningRunner({provider:'ollama-local',model:'synthetic:local',fetchImpl:async()=>{
  if(++calls===1)return Response.json({models:[{name:'synthetic:local',size:1000}]});
  return Response.json({model:'synthetic:local',done:true,done_reason:'stop',response:JSON.stringify({decision:'continue',summary:'합성 읽기',actions:[{id:'read',command:'source.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:'source.txt'},dependencies:[],successSignal:'내용 조회'}],criteriaAssessment:[]})});
 }});
 const result=await new GoalExecutivePlanner({runner,maxTransientRetries:0}).planNextWave(context());
 assert.equal(result.decision,'continue');assert.equal(result.actions[0].expectedToolName,'filesystem.readText');assert.equal(calls,2);
});
