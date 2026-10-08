import test from 'node:test';import assert from 'node:assert/strict';
import {runTabularProcedure} from '../apps/growth-memory/src/skill-procedure-runtime.js';
const definition={kind:'tabular-group-sum-v1',reportTitle:'합계',groupAliases:['Team'],valueAliases:['Amount']};
for(const columns of [{Team:'A',team:'B',Amount:1},{Team:'A',Amount:1,amount:99},{Team:'A','Ａｍｏｕｎｔ':99,Amount:1},{'T-eam':'A',Team:'B',Amount:1}])test(`normalized physical headers cannot silently overwrite ${Object.keys(columns).join('/')}`,()=>{
 const result=runTabularProcedure(definition,[columns]);assert.equal(result.success,false);assert.equal(result.error,'column-resolution-failed');assert.equal('markdown' in result,false);assert.equal('resultRows' in result,false);
});
test('unrelated header collisions do not make selected unambiguous columns unusable',()=>{const result=runTabularProcedure(definition,[{Team:'A',Amount:3,Note:'one',note:'two'}]);assert.equal(result.success,true);assert.deepEqual(result.resultRows,[{group:'A',total:3,count:1}]);});
