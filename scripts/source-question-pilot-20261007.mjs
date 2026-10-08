import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runLocalSummaryMission} from './local-summary-mission-pilot.mjs';
const corpusPath='tests/fixtures/gepa-summary-20261007.json';
const bytes=await readFile(corpusPath),corpus=JSON.parse(bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'),'e12d6a80623cffa582890ef5ed9121af5d2c8c2e0a540eb0915c2535912aa8c4');
const root='artifacts/source-question-20261007-pilot';await mkdir(root,{recursive:true});
const rows=[];
for(const id of ['H1','H3','H4']){
 const item=corpus.cases.find(c=>c.id===id);
 const path=`artifacts/gepa-local-20261007/${id}-baseline/mission.json`;
 const previous=JSON.parse(await readFile(path));
 assert.equal(previous.outputMatchesIndependentOracle,false);
 let calls=0;
 const report=await runLocalSummaryMission({item,outputRoot:`${root}/${id}-recorded-output`,provider:{async generateStructured(){
  calls++;return {output:previous.model.output,providerCalls:0,latencyMs:0,usage:null,model:'recorded-output-replay-not-new-inference'};
 }}});
 assert.equal(calls,2);assert.equal(report.status,'BLOCKED');assert.equal(report.output,null);
 assert.equal(report.actions.some(a=>a.toolName==='filesystem.createTextFile'),false);
 rows.push({id,mode:'recorded-actual-model-output-replay',previousEvidence:path,previousStatus:previous.status,previousArtifact:previous.output,report});
}
for(const id of ['D1','D2','V1','H1','H2','H3','H4']){
 const item=corpus.cases.find(c=>c.id===id);let calls=0;
 const report=await runLocalSummaryMission({item,outputRoot:`${root}/${id}-positive-control`,provider:{async generateStructured(){
  calls++;return {output:{facts:item.expected,evidence:Object.fromEntries(Object.keys(item.expected).map(k=>[k,item.source]))},
   providerCalls:0,latencyMs:0,usage:null,model:'synthetic-positive-control-not-model-quality'};
 }}});
 assert.equal(calls,1);assert.equal(report.status,'COMPLETED',JSON.stringify(report));
 assert.equal(report.outputMatchesIndependentOracle,true);
 rows.push({id,mode:'synthetic-known-correct-positive-control',report});
}
await writeFile(`${root}/comparison.json`,JSON.stringify({observedAt:new Date().toISOString(),corpusSha256:createHash('sha256').update(bytes).digest('hex'),
 rows,actualNewModelInferences:0,falseFiles:0,scope:'real-isolated-Core-E-B-G-filesystem-Missions-with-replayed-or-synthetic-provider'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({replayedWrongBlocked:3,positiveCompleted:7,falseFiles:0}));
