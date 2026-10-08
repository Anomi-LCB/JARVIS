import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runLocalSummaryMission} from './local-summary-mission-pilot.mjs';
const bytes=await readFile('tests/fixtures/gepa-summary-20261007.json');
const corpus=JSON.parse(bytes),sha=createHash('sha256').update(bytes).digest('hex');
assert.equal(sha,'e12d6a80623cffa582890ef5ed9121af5d2c8c2e0a540eb0915c2535912aa8c4');
const root='artifacts/source-fast-20261007-pilot';await mkdir(root,{recursive:true});const rows=[];
for(let repeat=0;repeat<3;repeat++)for(const id of ['D1','D2','V1','H1','H3']){
 const item=corpus.cases.find(c=>c.id===id);let calls=0;
 const report=await runLocalSummaryMission({item,preferSourceDeclarations:true,outputRoot:`${root}/${id}-${repeat}`,
  provider:{async generateStructured(){calls++;assert.fail('These deployment-visible questions and declarations need no model');}}});
 assert.equal(calls,0);assert.equal(report.status,'COMPLETED',JSON.stringify(report));
 assert.equal(report.outputMatchesIndependentOracle,true);assert.equal(report.model.providerCalls,0);
 rows.push({id,repeat,report});
}
const previous=JSON.parse(await readFile('artifacts/source-question-20261007-live/comparison.json'));
const paired=previous.rows.map(row=>({id:row.id,baseline:{status:row.report.status,totalMs:row.report.totalMs,
  providerCalls:row.report.model?.providerCalls??row.report.modelFailure?.providerCalls},
 candidate:rows.filter(r=>r.id===row.id).map(r=>({status:r.report.status,totalMs:r.report.totalMs,providerCalls:r.report.model.providerCalls}))}));
await writeFile(`${root}/comparison.json`,JSON.stringify({observedAt:new Date().toISOString(),corpusSha256:sha,rows,paired,
 actualModelCalls:0,paidApiCalls:0,totalCost:null,costMeasurement:'unmeasured',scope:'development-exposed-conditional-deterministic-source-path-not-general-semantic-holdout'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({completed:rows.length,falseCompletion:0,modelCalls:0,paired}));
