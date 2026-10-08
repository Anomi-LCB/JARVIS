import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationPlanSource} from '../packages/core/src/mission/mission-allocation-plan.js';
for(const [people,copies] of [['3명','2부씩'],['세 명','두 부씩'],['2~4명','2~3부씩']])test('allocation source targets/units '+people+' '+copies,()=>{
 const objective=`'A', 'B', 'C' ${people}에게 ${copies} 배부할 계획을 'allocation.json'에 JSON으로 저장해`;
 const source=allocationPlanSource({objective});assert.equal(source.sourceValid,true);
 assert.deepEqual(source.labels,['A','B','C']);assert.equal(source.path,'allocation.json');
 assert.deepEqual(source.contract.quantities.map(q=>q.text),[people,copies]);
});
for(const objective of [
 "'A', 'B' 2명에게 500mg씩 배부할 계획을 'allocation.json'에 JSON으로 저장해",
 "'A', 'A' 2명에게 2부씩 배부할 계획을 'allocation.json'에 JSON으로 저장해",
 "'A', ' B' 2명에게 2부씩 배부할 계획을 'allocation.json'에 JSON으로 저장해"
])test('allocation unsupported labels/units remain explicit '+objective,()=>assert.equal(allocationPlanSource({objective}).sourceValid,false));
for(const objective of [
 "'A', 'B' 2명에게 2부씩 실제로 보내줘",
 "'A', 'B' 2명에게 2부씩 배부할 계획을 'allocation.json'에 JSON으로 저장해; 이메일로 보내",
 "'A', 'B' 2명에게 2부씩 배부할 계획을 'allocation.json'에 JSON으로 저장해 그리고 배부해"
])test('plan oracle does not absorb delivery or extra requirements '+objective,()=>assert.equal(allocationPlanSource({objective}),null));
