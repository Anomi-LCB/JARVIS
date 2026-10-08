import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoalContract, checkGoalPlanCoverage} from '../packages/core/src/mission/goal-contract.js';

const cases = [
  ['10,000원 이하', 10000, 'lte'], ['1.25만원 미만', 12500, 'lt'],
  ['1억 2,500만원 이하', 125000000, 'lte'], ['2천5백원 이상', 2500, 'gte'],
  ['1억2천3백45만원 초과', 123450000, 'gt'], ['3만 2천 100원', 32100, null],
  ['1.25000만원', 12500, null], ['0원 이하', 0, 'lte'], ['9007199254740991원', Number.MAX_SAFE_INTEGER, null]
];
for (const [expression, value, comparator] of cases) test(`KRW full expression: ${expression}`, () => {
  const objective = `${expression} 'draft.txt'를 보내`;
  const contract = createGoalContract({objective});
  assert.equal(contract.amounts.length, 1);
  const amount = contract.amounts[0];
  assert.equal(amount.text.trim(), expression);
  assert.equal(amount.minorUnits, value);
  assert.equal(amount.comparator, comparator);
  assert.equal(amount.status, 'parsed');
  assert.equal(objective.slice(amount.sourceSpan.start, amount.sourceSpan.end), amount.text);
});

for (const expression of ['0.5원 이하', '9007199254740992원', '-100원', '−100원',
  '1,00원', '1.2.3원', '1e3원', '1e-3원', '삼만원', '1만2억원', '1.23456만원', '1 000원']) {
  test(`invalid or unsupported KRW is preserved, not silently shortened: ${expression}`, () => {
    const objective = `${expression} 'draft.txt'를 보내`;
    const contract = createGoalContract({objective});
    assert.equal(contract.amounts.length, 1);
    assert.equal(contract.amounts[0].text.trim(), expression);
    assert.equal(contract.amounts[0].status, 'unresolved');
    assert.equal(contract.amounts[0].minorUnits, null);
    const coverage = checkGoalPlanCoverage(contract, contract.requirements.map(r => ({requirementIds: [r.requirementId]})));
    assert.equal(coverage.canDispatchExternalEffects, false);
    assert.equal(coverage.unresolvedAmountExpressions.length, 1);
  });
}

test('quoted amounts remain data and separated amounts retain their own original spans', () => {
  const contract = createGoalContract({objective: "'가격 1억2천만원'을 읽어; 10,000원 이하; 2만원 미만"});
  assert.deepEqual(contract.amounts.map(a => [a.minorUnits, a.comparator]), [[10000,'lte'],[20000,'lt']]);
  assert.equal(createGoalContract({objective: "'0.5원'을 읽어"}).amounts.length, 0);
  const quoted = createGoalContract({objective: "'🙂100원' 1만원 이하 'draft.txt'를 보내"});
  assert.equal(quoted.amounts[0].text, '1만원 이하');
  assert.equal(quoted.amounts[0].sourceSpan.start, quoted.objective.indexOf('1만원'));
});

test('long numeric non-money input terminates without partial money matches', {timeout:2000}, () => {
  const objective = `${'1'.repeat(30000)}를 읽어`;
  assert.equal(createGoalContract({objective}).amounts.length,0);
  assert.equal(createGoalContract({objective:`${'1 '.repeat(15000)}를 읽어`}).amounts.length,0);
});

for (const [expression,currency,value] of [
  ['USD 12.34 이하','USD',1234], ['12.34 미국 달러 이하','USD',1234],
  ['US$12.34 이하','USD',1234], ['12.34EUR 이하','EUR',1234],
  ['€12.34 이하','EUR',1234], ['12.34유로 이하','EUR',1234],
  ['GBP 12.34 이하','GBP',1234], ['120엔 이하','JPY',120],
  ['JPY 120 이하','JPY',120], ['KWD 1.234 이하','KWD',1234]
]) test(`foreign money preserves exact currency and minor units: ${expression}`,()=>{
  const objective=`${expression} 'draft.txt'를 보내`;
  const contract=createGoalContract({objective});
  assert.equal(contract.amounts.length,1);
  const amount=contract.amounts[0];
  assert.deepEqual([amount.currency,amount.minorUnits,amount.status,amount.comparator],[currency,value,'parsed','lte']);
  assert.equal(amount.text,expression);
  assert.equal(objective.slice(amount.sourceSpan.start,amount.sourceSpan.end),expression);
});

for(const expression of ['$12.34 이하','12달러 이하','¥120 이하','£12 이하',
  'AUD 12.34 이하','ZZZ 12 이하','JPY 0.5 이하','USD 0.001 이하',
  'USD -12 이하','1e3USD 이하','1,00EUR 이하','삼십유로 이하',
  'EUR 12 USD 이하','USD 1 000 이하','USD 90071992547409.92 이하'])
  test(`ambiguous/unsupported foreign money remains unresolved: ${expression}`,()=>{
    const contract=createGoalContract({objective:`${expression} 'draft.txt'를 보내`});
    assert.equal(contract.amounts.length,1);
    assert.equal(contract.amounts[0].text,expression);
    assert.equal(contract.amounts[0].minorUnits,null);
    assert.equal(contract.amounts[0].status,'unresolved');
    assert.equal(checkGoalPlanCoverage(contract,contract.requirements.map(r=>({requirementIds:[r.requirementId]}))).canDispatchExternalEffects,false);
  });

test('mixed currencies retain order without conversion and quoted prices are data',()=>{
  const contract=createGoalContract({objective:"'USD 12.34'를 읽어; 100원 이하; USD 1.25 이하; 2유로 이하"});
  assert.deepEqual(contract.amounts.map(a=>[a.currency,a.minorUnits]),[['KRW',100],['USD',125],['EUR',200]]);
});

test('foreign amount scanner is bounded for long unsupported inputs',{timeout:2000},()=>{
  assert.equal(createGoalContract({objective:`USD ${'1'.repeat(30000)} 이하`}).amounts[0].status,'unresolved');
  assert.equal(createGoalContract({objective:`${'1 '.repeat(15000)}USD 이하`}).amounts[0].status,'unresolved');
  assert.equal(createGoalContract({objective:'PDF 12페이지를 읽어; frontend 엔진을 확인해'}).amounts.length,0);
});
