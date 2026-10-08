import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEvidenceBoundRepairFactory} from '../packages/core/src/capabilities/evidence-bound-repair-factory.js';
const url='https://unicode.org/reports/tr35/tr35-numbers.html';
const recipe={toolName:'workflow.execute',failureCode:'WORKFLOW_NUMBER_INVALID',executionCodeVersion:'a'.repeat(64),
 sourceUrls:[url],reproducerEvidenceSha256:'b'.repeat(64),buildCandidate:()=>({skill:{toolName:'workflow.execute'},artifactSha256:'c'.repeat(64)})};
const input={toolName:recipe.toolName,failureCode:recipe.failureCode,executionCodeVersion:recipe.executionCodeVersion,failureObservationVersion:2,failureCount:2,
 sources:[{url,content:'official source fixture',contentSha256:createHash('sha256').update('official source fixture').digest('hex'),observedAt:new Date().toISOString(),instructionAuthority:false,trustBoundary:'externalContent'}]};
test('host recipe links exact observed code/version/source/reproducer to candidate without claiming improvement',async()=>{
 const factory=createEvidenceBoundRepairFactory([recipe]),definition=await factory(input),proof=factory.diagnosisFor(definition);
 assert.equal(proof.baselinePackageDigest,recipe.executionCodeVersion);assert.equal(proof.independentlyImproved,false);
 assert.equal(factory.diagnosisFor({...definition}),null);
});
for(const [key,value] of [['failureCode','OTHER'],['executionCodeVersion','e'.repeat(64)],['failureObservationVersion',1],['failureCount',1]])
 test(`unidentified causal input is refused: ${key}`,async()=>assert.rejects(createEvidenceBoundRepairFactory([recipe])({...input,[key]:value}),/REPAIR_NOT_IDENTIFIED/));
test('external instruction authority, missing source and cancellation cannot generate a repair',async()=>{
 const factory=createEvidenceBoundRepairFactory([recipe]);
 await assert.rejects(factory({...input,sources:[]}),/SOURCE_MISSING/);
 await assert.rejects(factory({...input,sources:[{...input.sources[0],instructionAuthority:true}]}),/SOURCE_MISSING/);
 const signal=AbortSignal.abort();await assert.rejects(factory(input,{signal}),e=>e.name==='AbortError');
 await assert.rejects(factory({...input,failureCount:NaN}),/REPAIR_NOT_IDENTIFIED/);
 await assert.rejects(factory({...input,sources:[{...input.sources[0],content:'changed'}]}),/SOURCE_MISSING/);
});
