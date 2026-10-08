import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {runLocalSummaryMission} from './local-summary-mission-pilot.mjs';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const corpus=JSON.parse(await readFile('tests/fixtures/gepa-summary-20261007.json'));
const root='artifacts/source-fast-20261007-authority';await mkdir(root,{recursive:true});const rows=[];
for(const id of ['H1','H3']){
 const item=corpus.cases.find(c=>c.id===id);
 const report=await runLocalSummaryMission({item,preferSourceDeclarations:true,executionGrants:[MissionGrant.READ_ONLY],
  outputRoot:`${root}/${id}`,provider:{async generateStructured(){assert.fail('No model needed');}}});
 assert.notEqual(report.status,'COMPLETED');assert.equal(report.output,null);
 assert.equal(report.actions.some(a=>a.toolName==='filesystem.createTextFile'&&a.status==='succeeded'),false);
 rows.push(report);
}
await writeFile(`${root}/comparison.json`,JSON.stringify({observedAt:new Date().toISOString(),rows,scope:'actual-Core-permission-gate-before-write-despite-correct-deterministic-facts'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(rows.map(r=>({caseId:r.caseId,status:r.status,stopReason:r.stopReason,actions:r.actions}))));
