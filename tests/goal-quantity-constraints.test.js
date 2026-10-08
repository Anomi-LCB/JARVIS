import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoalContract,checkGoalPlanCoverage,reviseGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {evaluateGoalQuantityConstraints} from '../packages/core/src/mission/goal-quantity-expression.js';

test('commas separating quoted labels are not swallowed into the following count',()=>{
 const objective="'A', 'B', 'C' 3명에게 2부씩 배부할 계획을 'allocation.json'에 JSON으로 저장해";
 const c=createGoalContract({objective});
 assert.deepEqual(c.quantities.map(q=>[q.text,q.baseUnits,q.status]),[['3명',3,'parsed'],['2부씩',2,'parsed']]);
 assert.equal(objective.slice(c.quantities[0].sourceSpan.start,c.quantities[0].sourceSpan.end),'3명');
 for(const malformed of ['1,00명','1, 00명'])assert.equal(createGoalContract({objective:malformed+'에게 배부해'}).quantities[0].status,'unresolved');
});

for(const [expression,baseUnit,baseUnits,comparator] of [
 ['3명','명',3,'eq'],['두 부','부',2,'eq'],['한 개','개',1,'eq'],['세권','권',3,'eq'],['최대 1,000개','개',1000,'lte'],
 ['최소 2천5백장','장',2500,'gte'],['정확히 0건','건',0,'eq'],['1.25kg 이하','microgram',1250000000,'lte'],
 ['500mg 미만','microgram',500000,'lt'],['0.5g 이상','microgram',500000,'gte'],['1μg 초과','microgram',1,'gt'],
 ['0.125L','microliter',125000,'eq'],['2.5mL','microliter',2500,'eq'],['0.001mm','micrometer',1,'eq'],
 ['1.25미터','micrometer',1250000,'eq'],['12쪽','페이지',12,'eq']
])test(`source quantity exact unit/comparison: ${expression}`,()=>{
 const objective=`${expression} 'draft.txt'를 보내`,contract=createGoalContract({objective}),q=contract.quantities[0];
 assert.equal(contract.quantities.length,1);assert.deepEqual([q.status,q.baseUnit,q.baseUnits,q.comparator],['parsed',baseUnit,baseUnits,comparator]);
 assert.equal(q.text,expression);assert.equal(objective.slice(q.sourceSpan.start,q.sourceSpan.end),expression);
});

for(const expression of ['0.5개','-3명','−2개','1e3개','1,00장','1.2.3개','9007199254740992개','0.0000001g','5~3명','최대 3명 이상','최소 3~5명','1/2개','2×3개','2*3개','2^3개','3%병','3~5~7명'])
test(`unsupported quantity retained whole: ${expression}`,()=>{
 const contract=createGoalContract({objective:`${expression} 'draft.txt'를 보내`});assert.equal(contract.quantities.length,1);
 assert.equal(contract.quantities[0].text,expression);assert.equal(contract.quantities[0].status,'unresolved');assert.equal(contract.quantities[0].baseUnits,null);
 const check=checkGoalPlanCoverage(contract,contract.requirements.map(r=>({requirementIds:[r.requirementId]})));
 assert.equal(check.unresolvedQuantityExpressions.length,1);assert.equal(check.canDispatchExternalEffects,false);
});

test('quantity ranges, distribution and quotes stay distinct and exact after revision',()=>{
 const c=createGoalContract({objective:"'🙂3명 2부 500mg'을 읽어; 3~5명에게 2부씩 보내"});
 assert.equal(c.quantities.length,2);assert.deepEqual(c.quantities[0].range,{minBaseUnits:3,maxBaseUnits:5});
 assert.equal(c.quantities[1].distribution,'per-item');assert.equal(c.quantities[1].baseUnits,2);
 assert.equal(c.objective.slice(c.quantities[1].sourceSpan.start,c.quantities[1].sourceSpan.end),'2부씩');
 const revised=reviseGoalContract(c,{objective:"'🙂3명 2부 500mg'을 읽어; 4명에게 1부씩 보내"});
 assert.deepEqual(revised.quantities.map(q=>q.baseUnits),[4,1]);assert.notEqual(revised.quantities[1].quantityId,c.quantities[1].quantityId);
 assert.equal(createGoalContract({objective:'1인당 2개씩 준비해'}).quantities[0].distribution,'per-unit');
});

test('comparison uses observed exact base units and never accepts a claimed verified flag or another dimension',()=>{
 const c=createGoalContract({objective:'500mg 이하; 3~5명'}),[mass,count]=c.quantities;
 const measurements=[{quantityId:mass.quantityId,baseUnit:'microgram',baseUnits:500000},{quantityId:count.quantityId,baseUnit:'명',baseUnits:4}];
 assert.equal(evaluateGoalQuantityConstraints(c,measurements).passed,true);
 assert.equal(evaluateGoalQuantityConstraints(c,[]).passed,false);
 assert.equal(evaluateGoalQuantityConstraints(c,measurements.map(m=>({...m,baseUnits:m.baseUnits+100}))).passed,false);
 assert.equal(evaluateGoalQuantityConstraints(c,[{...measurements[0],baseUnit:'microliter'},measurements[1]]).checks[0].reason,'quantity-unit-mismatch');
 for(const bad of [[...measurements,measurements[0]],[{...measurements[0],verified:true}],[{...measurements[0],baseUnits:0.5}],[{...measurements[0],quantityId:'invented'}]])
  assert.throws(()=>evaluateGoalQuantityConstraints(c,bad),/MEASUREMENTS_INVALID/);
 assert.equal(evaluateGoalQuantityConstraints(createGoalContract({objective:'3명에게 2부씩 보내'}),[]).checks[1].reason,'quantity-distribution-binding-required');
 assert.equal(evaluateGoalQuantityConstraints(c,measurements).measurementProvenanceVerified,false);
});

test('strict comparator boundaries and unresolved source cannot be replaced by observed values',()=>{
 for(const [expression,observed,passed] of [['3개 미만',3,false],['3개 이하',3,true],['3개 초과',3,false],['3개 이상',3,true],['0.5개',1,false]]){
  const c=createGoalContract({objective:expression}),q=c.quantities[0];assert.equal(evaluateGoalQuantityConstraints(c,[{quantityId:q.quantityId,baseUnit:'개',baseUnits:observed}]).passed,passed);
 }
 const absent=evaluateGoalQuantityConstraints(createGoalContract({objective:"'draft.txt'를 읽어"}),[]);
 assert.equal(absent.applicable,false);assert.equal(absent.passed,null);
});

test('non-quantity words and long numeric candidates are not guessed or scanned quadratically',{timeout:2000},()=>{
 for(const objective of ['일부 자료를 읽어','페이지명과 명단을 확인해','이번 달 초에 확인해','10개월 뒤','세대별 데이터','12명단','12mgDose'])assert.deepEqual(createGoalContract({objective}).quantities,[],objective);
 assert.deepEqual(createGoalContract({objective:`${'1'.repeat(30000)}를 읽어`}).quantities,[]);
 assert.deepEqual(createGoalContract({objective:`${'1 '.repeat(15000)}를 읽어`}).quantities,[]);
 assert.equal(createGoalContract({objective:`${'1 '.repeat(15000)}개`}).quantities[0].status,'unresolved');
});
