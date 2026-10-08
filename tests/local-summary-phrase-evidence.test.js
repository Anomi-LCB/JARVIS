import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLocalSummary,generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
import {runLocalSummaryMission} from '../scripts/local-summary-mission-pilot.mjs';

const input={source:'처음 장소는 본관이었다. 최종 장소는 별관이다.',
  questions:{location:'최종 장소 원문 단어만'},valueFormats:{location:'source-phrase'}};
const wrong={facts:{location:'본관'},evidence:{location:'최종 장소는 별관이다.'}};
const correct={facts:{location:'별관'},evidence:{location:'최종 장소는 별관이다.'}};
const generated=output=>({output,latencyMs:1,providerCalls:1,usage:null});

test('source phrase from another sentence cannot borrow the final sentence as evidence',()=>{
  assert.deepEqual(inspectLocalSummary(input,wrong).errors,['location:phrase-evidence-mismatch']);
  assert.equal(inspectLocalSummary(input,correct).valid,true);
  // Literal support does not prove question relevance: the old statement is
  // still a real quote and must be judged by a separate semantic oracle.
  const irrelevant=inspectLocalSummary(input,{facts:wrong.facts,evidence:{location:'처음 장소는 본관이었다.'}});
  assert.equal(irrelevant.valid,true);
  assert.equal(irrelevant.semanticAccuracyVerified,false);
});

test('bounded repair exposes mismatched phrase and keeps authority unverified',async()=>{
  const prompts=[];
  const result=await generateLocalSourceSummary(input,{provider:{async generateStructured({prompt}){
    prompts.push(prompt);return generated(prompts.length===1?wrong:correct);
  }}});
  assert.equal(prompts.length,2);
  assert.ok(prompts[1].includes('location:phrase-evidence-mismatch'));
  assert.deepEqual(result.output,correct);
  assert.equal(result.executionAuthorized,false);
  assert.equal(result.semanticAccuracyVerified,false);
});

test('real isolated Mission blocks persistently mismatched phrases before any save effect',async()=>{
  let calls=0;
  const report=await runLocalSummaryMission({item:{id:'phrase-binding',...input,expected:correct.facts},
    provider:{async generateStructured(){calls++;return generated(wrong);}}});
  assert.equal(calls,2);
  assert.equal(report.status,'BLOCKED',JSON.stringify(report));
  assert.equal(report.output,null);
  assert.equal(report.actions.length,2);
  assert.equal(report.modelFailure.code,'A_SOURCE_SUMMARY_OUTPUT_REJECTED');
});

test('real isolated Mission completes repaired phrase with independent expected content',async()=>{
  let calls=0;
  const report=await runLocalSummaryMission({item:{id:'phrase-repair',...input,expected:correct.facts},
    provider:{async generateStructured(){calls++;return generated(calls===1?wrong:correct);}}});
  assert.equal(calls,2);
  assert.equal(report.status,'COMPLETED',JSON.stringify(report));
  assert.equal(report.outputMatchesIndependentOracle,true);
  assert.equal(report.actions.filter(action=>action.status==='succeeded').length,5);
  assert.equal(report.arbitraryProseQualityVerified,false);
});
