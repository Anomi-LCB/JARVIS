import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceChangeView,checkedSourceChangeView} from '../packages/shared/src/source-change-view.js';
import {compareSourceChange} from '../apps/pc-agent/src/adapters/workflow/change-comparison.js';
import {MissionRuntime} from '../packages/core/src/mission/mission-runtime.js';
import {buildMissionPlanningPrompt} from '../packages/core/src/mission/mission-planner.js';
import {taskView} from '../src/ui/workspace/model.js';
const record=(value,claim=false)=>({facts:{value},evidence:{value:'합성 시험 수치'},sourceSha256:'a'.repeat(64),fieldProvenance:{value:{basis:claim?'source-claim':'source-declaration',unit:claim?'%':'초',sourceLabel:'개선율',...(claim?{claimedBy:'업체'}:{}),independentlyVerified:false}}});
const result=()=>compareSourceChange({before:record('8'),after:record('9'),claim:record('30',true),metric:'decrease-percent',tolerancePercentPoints:'0'});
test('inverse view always retains an unverified equal-workload assumption',()=>{
 const value=compareSourceChange({before:record('100'),after:record('80'),claim:record('25',true),metric:'inverse-increase-percent'});
 const view=sourceChangeView(value);
 assert.deepEqual(view.assumptions,['equal-workload']);
 assert.equal(checkedSourceChangeView({...view,equalWorkloadVerified:true}).equalWorkloadVerified,false);
});
test('comparison survives Core projection, UI and planning without truth or currentness promotion',()=>{
 const value=result();value.inputsIndependentlyVerified=true;value.executionAuthority=true;
 const observation=MissionRuntime.prototype.successObservation.call({}, {actualToolName:'workflow.execute'}, {}, {execution:{executionResult:{evidence:{workflow:{receipts:[{nodeId:'compare',op:'compute.compareChange',status:'success',changeComparison:value}]}}}},executionVerification:{status:'passed'}});
 const view=taskView({observations:[observation]}).sourceComparisons;
 assert.equal(view.length,1);assert.equal(view[0].calculatedPercent,'-12.5');assert.equal(view[0].claimConsistentWithInputs,false);
 assert.equal(view[0].inputsIndependentlyVerified,false);assert.equal(view[0].currentSourceVerified,false);assert.equal(view[0].executionAuthority,false);
 const prompt=buildMissionPlanningPrompt({mission:{objective:'자료 값의 대조 결과를 확인한다.',successCriteria:[],constraints:[]},capabilities:[],observations:[observation]});
 const compact=JSON.parse(prompt.split('\n').find(l=>l.startsWith('실행 관찰: ')).slice('실행 관찰: '.length));
 assert.deepEqual(compact[0].evidenceFacts.sourceChangeComparisons,view);
 assert.deepEqual(taskView({observations:[{...observation,verification:{status:'failed'}}]}).sourceComparisons,[]);
});
test('bounded projection excludes invalid records, unknown fields and large display strings',()=>{
 const input=result(),view=sourceChangeView(input);assert.ok(view);assert.equal(checkedSourceChangeView({...view,executionAuthority:true,private:'secret'}).executionAuthority,false);
 assert.equal(Object.hasOwn(checkedSourceChangeView({...view,private:'secret'}),'private'),false);
 for(const value of [{...input,metric:'unknown'},{...input,claimConsistentWithInputs:'true'},{...input,calculatedPercent:{approximate:'9'.repeat(121)}}])assert.equal(sourceChangeView(value),null);
 assert.equal(checkedSourceChangeView({...view,sourceSha256s:[]}),null);
 assert.equal(checkedSourceChangeView({...view,claimedBy:'x'.repeat(81)}),null);
});
test('valid decimal ratios exceeding 100 display characters retain their result view',()=>{
 const value=compareSourceChange({before:record('0.000000000000000001'),after:record('9'.repeat(80)),claim:record('1',true),metric:'increase-percent'});
 assert.ok(value.claimDifferencePercentPoints.approximate.length>100);assert.ok(sourceChangeView(value));
 assert.equal(sourceChangeView(value).claimConsistentWithInputs,false);
});
