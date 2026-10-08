import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedChoice,uniqueDeclaredChoice,acquireInformation} from '../scripts/lib/information-acquisition-adapter.mjs';
import {runInformationComparison} from '../scripts/information-acquisition-comparison.mjs';
test('closed identifiers and declared-source uniqueness reject injection, corruption and duplicate results',async()=>{
 assert.equal(boundedChoice('../../outside',['a','b']),null);
 assert.equal(boundedChoice({choice:'a'},['a','b']),null);
 assert.equal(uniqueDeclaredChoice([{id:'a',region:'북부'},{id:'b',region:'북부'}],'북부',['a','b']),null);
 assert.equal(uniqueDeclaredChoice([{id:'a',region:'북부'},{id:'a',region:'남부'}],'북부',['a','b']),null);
 assert.equal(uniqueDeclaredChoice({id:'a'},'북부',['a']),null);
 assert.equal(uniqueDeclaredChoice([{id:'a',region:'남부'},{id:'b',region:'북부'}],'북부',['a','b']),'b');
 for(const candidateIds of [[],['a','a'],['../../outside'],[null]])await assert.rejects(acquireInformation({mode:'none',request:{target:'북부',candidateIds}}),/INVALID_ACQUISITION_REQUEST/);
 for(const repeat of [0,1.5,6])await assert.rejects(runInformationComparison({repeat}),/Invalid repetitions/);
});
test('actual Core E B G comparison preserves wrong answers and missing-data outcomes without claiming task completion',async()=>{
 const report=await runInformationComparison({repeat:1});assert.equal(report.sourceUnchanged,true);assert.equal(report.runs.length,32);
 const pick=(id,mode)=>report.runs.find(r=>r.id===id&&r.mode===mode);
 assert.equal(pick('cache-stale','none').incorrectSelection,true);
 assert.equal(pick('hint-stale','lookup').incorrectSelection,true);
 assert.equal(pick('answer-wrong','question').incorrectSelection,true);
 assert.equal(pick('hint-missing','lookup').unresolvedExpectedChoice,true);
 assert.equal(pick('untrusted-hint','lookup').selected,null);
 assert.equal(pick('untrusted-hint','lookup').toolCalls,1);
 assert.equal(pick('duplicate-match','question').status,'WAITING_APPROVAL');
 assert.equal(pick('duplicate-match','execute').selected,null);
 assert.equal(pick('invalid-source','execute').selected,null);
 assert.notEqual(pick('invalid-source','execute').status,'COMPLETED');
 for(const row of report.runs){assert.equal(row.cost,null);assert.equal(row.approvals,0);assert.ok(row.totalMs>=row.acquisitionMs);}
 for(const row of report.runs.filter(r=>r.mode==='execute'&&r.id!=='invalid-source')){assert.equal(row.status,'COMPLETED');assert.equal(row.toolCalls,1);assert.equal(row.artifactReads,1);assert.equal(row.metrics.failedActions,0);}
 assert.deepEqual(report.summary.map(r=>r.correct),[1,3,7,8]);
});
