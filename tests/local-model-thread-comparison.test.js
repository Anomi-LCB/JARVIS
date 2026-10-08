import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeThreadComparison,threadComparisonSchedule} from '../scripts/local-model-thread-comparison.mjs';
const good=()=>({status:'COMPLETED',outputMatchesIndependentOracle:true,totalMs:10,actions:Array.from({length:5},()=>({status:'succeeded'})),observations:Array.from({length:5},()=>({outcome:'success',verificationStatus:'passed'}))});
test('comparison retains failed and blocked runs in denominator and unknown cost',()=>{
  const runs=threadComparisonSchedule.map(slot=>({...slot,report:good()}));
  runs[1].report.status='BLOCKED';runs[2].report.outputMatchesIndependentOracle=false; runs[4].report.observations[0].verificationStatus='failed';
  const result=summarizeThreadComparison(runs);
  assert.equal(result.total,6);assert.equal(result.passed,3);assert.equal(result.profiles.reduce((n,p)=>n+p.failed,0),3);
  assert.equal(result.allScheduledRunsPresent,true);assert.equal(result.performancePromotionAllowed,false);
  assert.equal(result.profiles[0].samples[0].costUsd,null);
});
test('provider completion and correct file cannot conceal a failed action',()=>{
  const runs=threadComparisonSchedule.map(slot=>({...slot,report:good()}));
  runs[0].report.actions[2].status='failed';
  assert.equal(summarizeThreadComparison(runs).passed,5);
});
test('missing or reordered slots cannot claim complete campaign',()=>{
  const runs=threadComparisonSchedule.map(slot=>({...slot,report:good()}));
  assert.equal(summarizeThreadComparison(runs.slice(1)).allScheduledRunsPresent,false);
  [runs[0],runs[1]]=[runs[1],runs[0]];
  assert.equal(summarizeThreadComparison(runs).allScheduledRunsPresent,false);
});
