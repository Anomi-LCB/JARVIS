import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {sumDecimalValues} from '../apps/pc-agent/src/adapters/workflow/decimal-sum.js';
import {LocalWorkflowToolAdapter} from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

test('source decimal sums survive grouped and pivot output without binary accumulation noise', () => {
  const adapter = new LocalWorkflowToolAdapter({allowedRoots:[process.cwd()]});
  const items = ['0.1','0.2','-0.05'].map(amount => ({region:'서울',kind:'paid',amount}));
  assert.deepEqual(adapter.opGroupAggregate({items,groupBy:'region',field:'amount',operation:'sum',as:'total',includeValueAlias:false}).items,[{region:'서울',total:0.25}]);
  assert.deepEqual(adapter.opPivot({items,row:'region',column:'kind',value:'amount'}).items,[{region:'서울',paid:0.25}]);
  assert.equal(sumDecimalValues(['9007199254740992','-9007199254740992','0.1','0.2']),0.3);
  assert.equal(sumDecimalValues(['1e-3','2E-3']),0.003);
  assert.equal(Object.is(sumDecimalValues(['-0','0']),-0),false);
});

test('ambiguous numbers and non-preservable JSON results fail rather than publish rounded totals', () => {
  for (const value of [null,true,false,'',' ','0x10','Infinity',NaN,Infinity,{},9007199254740992,'1e401','1'.repeat(401)]) {
    assert.throws(()=>sumDecimalValues([value]),{code:'WORKFLOW_NUMBER_INVALID'});
  }
  for (const values of [['9007199254740991','1'],['0.1234567890123456789'],['1e-400']]) {
    assert.throws(()=>sumDecimalValues(values),{code:'WORKFLOW_SUM_UNREPRESENTABLE'});
  }
});

test('200 signed decimal source sets match an independent Python Decimal oracle', () => {
  const cases = Array.from({length:200},(_,index)=>Array.from({length:19},(_,item)=>
    `${(index*7919+item*1237)%2 ? '-' : ''}${(index*137+item*53)%999}.${String((index*271+item*37)%10000).padStart(4,'0')}`));
  const result = spawnSync(process.env.JARVIS_PYTHON ?? 'C:/Users/user/AppData/Local/Programs/Python/Python313/python.exe',
    ['-c','import json,sys\nfrom decimal import Decimal\ncases=json.load(sys.stdin)\nprint(json.dumps([format(sum(map(Decimal, case), Decimal(0)).normalize(), "f") for case in cases]))'],
    {input:JSON.stringify(cases),encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const expected = JSON.parse(result.stdout);
  cases.forEach((values,index)=>assert.equal(String(sumDecimalValues(values)),expected[index]));
});
