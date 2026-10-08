import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyBrowserGymControls} from '../scripts/external-benchmark-evidence.mjs';
function fixture(){return {schemaVersion:'external-benchmark-controls-v1',benchmark:'BrowserGym/MiniWoB',
 taskCommit:'7fd85d71a4b60325c6585396ec4f48377d049838',versions:{'browsergym-core':'0.14.3','browsergym-miniwob':'0.14.3',playwright:'1.44.0'},python:'3.11.13',os:'synthetic-unit-fixture',
 chromeSha256:'a'.repeat(64),runnerSha256:'b'.repeat(64),plannedSlots:18,jarvisPerformance:null,officialLeaderboardScore:null,realLifeCompletionRate:null,
 rows:['click-test','click-button','enter-text'].flatMap(taskId=>[17,43,89].flatMap(seed=>['scripted-positive-control','scripted-negative-control'].map(driver=>({taskId,seed,driver,
 status:driver==='scripted-positive-control'?'completed':'failed',reward:driver==='scripted-positive-control'?1:0,terminated:driver==='scripted-positive-control',truncated:false,actions:['noop()'],elapsedMs:10,error:null,actualCost:null,jarvisAgentExecuted:false}))))};}
test('positive and negative controls qualify only environment; unknown costs remain null',()=>{
 const r=qualifyBrowserGymControls(fixture());assert.equal(r.environmentControlsPassed,true);assert.equal(r.jarvisPerformance,null);assert.equal(r.cost,null);
});
test('blocked slots stay in the original denominator and cannot pass control readiness',()=>{
 const f=fixture();f.rows[0].status='blocked';f.rows[0].reward=null;f.rows[0].error={type:'Unavailable'};
 const r=qualifyBrowserGymControls(f);assert.equal(r.counts['scripted-positive-control'].planned,9);assert.equal(r.counts['scripted-positive-control'].blocked,1);assert.equal(r.environmentControlsPassed,false);
});
for(const [name,mutate] of [
 ['drop failed slot',f=>f.rows.pop()],['repeat a different slot',f=>f.rows[1]=structuredClone(f.rows[0])],
 ['wrong task release',f=>f.taskCommit='c'.repeat(40)],['different evaluator',f=>f.versions['browsergym-core']='0.14.2'],
 ['claim product score',f=>f.jarvisPerformance=1],['claim real life score',f=>f.realLifeCompletionRate=1],
 ['claim autonomous driver',f=>f.rows[0].jarvisAgentExecuted=true],['fake completed reward',f=>f.rows[0].reward=0],
 ['nonterminal completion',f=>f.rows[0].terminated=false],['truncated completion',f=>f.rows[0].truncated=true],
 ['completion with error',f=>f.rows[0].error={type:'Error'}],['completion without actions',f=>f.rows[0].actions=[]],
 ['negative duration',f=>f.rows[0].elapsedMs=-1],['invent zero cost string',f=>f.rows[0].actualCost='0'],
 ['wrong seed',f=>f.rows[0].seed=2],['unknown driver',f=>f.rows[0].driver='jarvis'],
 ['missing binary fingerprint',f=>delete f.chromeSha256]
])test(`reject ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>qualifyBrowserGymControls(f));});
