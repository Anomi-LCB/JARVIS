import test from 'node:test';import assert from 'node:assert/strict';
import {sourceQuoteCatalog,localSummarySchema,inspectLocalSummary} from '../packages/core/src/mission/local-source-summary.js';
test('model evidence choices are verbatim source substrings; facts still need independent verification',()=>{
 const source='업체는 99명이 참석했다고 주장했다. 확인된 참석자는 12명이다.';
 const input={source,questions:{claim:'업체가 주장한 인원'},valueFormats:{claim:'digits'}};
 const choices=localSummarySchema(input).properties.evidence.properties.claim.enum;
 assert.ok(choices.length>=2);assert.ok(choices.every(quote=>source.includes(quote)));
 assert.equal(choices.includes('업체의 참석자는 99명이다.'),false);
 assert.equal(inspectLocalSummary(input,{facts:{claim:'99'},evidence:{claim:'업체의 참석자는 99명이다.'}}).valid,false);
 assert.equal(inspectLocalSummary(input,{facts:{claim:'12'},evidence:{claim:'확인된 참석자는 12명이다.'}}).semanticAccuracyVerified,false);
 assert.deepEqual(sourceQuoteCatalog(''),[]);assert.deepEqual(sourceQuoteCatalog('x'.repeat(20001)),[]);
 assert.equal('enum' in localSummarySchema({...input,source:'x'.repeat(500)}).properties.evidence.properties.claim,false);
});
