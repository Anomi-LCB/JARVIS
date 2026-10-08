import test from 'node:test';
import assert from 'node:assert/strict';
import {runArtifactComparison} from '../scripts/new-session-artifact-comparison.mjs';
test('new-session comparison executes actual Mission E/B/G and independently rereads every generated artifact',async()=>{
 const report=await runArtifactComparison({repeat:1});assert.equal(report.rows.length,24);assert.equal(report.sourceUnchanged,true);
 assert.deepEqual(report.summary.map(r=>r.correct),[3,6,3,1]);
 assert.deepEqual(report.summary.map(r=>r.artifactMissionsCompleted),[1,4,1,6]);
 assert.deepEqual(report.summary.map(r=>r.incorrectArtifacts),[0,0,0,5]);
 for(const row of report.rows){
  assert.equal(row.execution.semanticTruthVerified,false);assert.equal(row.authorityGrantedByMemory,false);
  if(row.execution.fileExists){assert.equal(row.execution.artifactReads,1);assert.equal(row.toolCalls,1);assert.equal(row.execution.verifiedActions,1);assert.equal(row.execution.missionStatus,'COMPLETED');}
  else{assert.equal(row.selected,null);assert.equal(row.toolCalls,0);assert.equal(row.execution.missionStatus,'BLOCKED');}
 }
 const corrected=report.rows.find(r=>r.caseId==='corrected'&&r.mode==='on');assert.deepEqual(corrected.execution.contextSourceIds,['current']);
 for(const mode of ['off','stale'])assert.equal(report.rows.find(r=>r.caseId==='recall-a'&&r.mode===mode).unresolvedExpectedChoice,true);
});
