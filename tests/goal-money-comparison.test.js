import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {sourceBinding,sourceMoney} from '../packages/core/src/mission/mission-money-dependency.js';
import {compareGoalAmount} from '../packages/core/src/mission/goal-money-expression.js';

function compare(objective,currency,amountMinor,change){
 const mission={objective,goalContract:createGoalContract({objective})};
 const body={sourceBinding:sourceBinding(mission),request:{currency,amountMinor}};
 change?.(mission,body);
 return sourceMoney(mission,body);
}
for(const [expression,currency,bound] of [['100원','KRW',100],['USD 1.00','USD',100],['EUR 1.00','EUR',100],
 ['GBP 1.00','GBP',100],['JPY 100','JPY',100],['KWD 0.100','KWD',100]]){
 for(const [word,comparator,expected] of [['이하','lte',[true,true,false]],['미만','lt',[true,false,false]],
  ['이상','gte',[false,true,true]],['초과','gt',[false,false,true]]]){
  test(`current source ${currency} ${comparator} compares independent below/equal/above boundary`,()=>{
   for(const [index,value] of [bound-1,bound,bound+1].entries()){
    const result=compare(`총액 ${expression} ${word}로 준비해`,currency,value);
    assert.equal(result.passed,expected[index],JSON.stringify(result));
    assert.equal(result.comparator,comparator);assert.equal(result.executionAuthority,false);
    assert.equal(result.providerChargeVerified,false);
   }
  });
 }
}
test('invalid or unknown declared measurement never passes source comparison',()=>{
 for(const amount of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1,'100',undefined])
  assert.equal(compare('총액 100원 이하로 준비해','KRW',amount).passed,false);
 assert.equal(compare('총액 100원 이하로 준비해','KRW',null).passed,false);
 assert.equal(compare('총액 100원 이상으로 준비해','USD',100).passed,false);
});
test('changed original goal/revision, ambiguous total, multiple amounts stay unverified',()=>{
 for(const change of [(m)=>{m.objective='총액 200원 이상으로 준비해';},m=>m.goalContract.revision++])
  assert.equal(compare('총액 100원 이상으로 준비해','KRW',100,change).passed,false);
 for(const objective of ['건당 총액 100원 이상으로 준비해','총액 100원 이상; 누적 200원 이하','총액 $100 이상으로 준비해'])
  assert.equal(compare(objective,'KRW',100).passed,false);
});
test('direct comparator rejects absent, unknown or guessed currency and unparsed fact',()=>{
 for(const currency of [null,undefined,'CHF','usd','UNKNOWN']){
  const result=compareGoalAmount({status:'parsed',minorUnits:100,comparator:'lte',currency},{currency,minorUnits:50});
  assert.equal(result.passed,false);assert.equal(result.reason,'source-amount-unresolved');
 }
 assert.equal(compareGoalAmount({status:'unresolved',minorUnits:100,comparator:'lte',currency:'USD'},{currency:'USD',minorUnits:50}).passed,false);
});
