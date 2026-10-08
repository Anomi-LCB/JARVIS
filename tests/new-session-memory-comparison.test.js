import test from 'node:test';
import assert from 'node:assert/strict';
import {runNewSessionMemoryComparison,chooseDeclaredMemory} from '../scripts/new-session-memory-comparison.mjs';
test('consumer never receives oracle and explicit request overrides every remembered value',()=>{
 const row={memoryType:'personal_knowledge',subject:'주제',predicate:'선택',status:'active',value:'a'};
 assert.equal(chooseDeclaredMemory({subject:'주제',explicitChoice:'b'},[row]),'b');
 assert.equal(chooseDeclaredMemory({subject:'주제'},[row,{...row,value:'b'}]),null);
 assert.equal(chooseDeclaredMemory({subject:'주제'},[{...row,requiresUserResolution:true}]),null);
 assert.equal(chooseDeclaredMemory({subject:'주제'},[{...row,value:'../../outside'}]),null);
 assert.equal(chooseDeclaredMemory({subject:'주제'},[{...row,status:'expired'}]),null);
});
test('real reopened F SQLite and Core on/off compare correction, scope, expiry and wrong assertions',async()=>{
 const report=await runNewSessionMemoryComparison({repeat:1});assert.equal(report.sourceUnchanged,true);assert.equal(report.rows.length,24);
 assert.deepEqual(report.summary.map(r=>r.correct),[3,6,3,1]);
 const pick=(id,mode)=>report.rows.find(r=>r.caseId===id&&r.mode===mode);
 for(const row of report.rows){assert.equal(row.authorityGrantedByMemory,false);assert.equal(row.cost,null);assert.equal(row.userPreferences,0);assert.equal(row.toolCalls,0);}
 for(const row of report.rows.filter(r=>r.mode==='off')){assert.equal(row.recallCalls,0);assert.equal(row.memoryEvidence,0);}
 for(const row of report.rows.filter(r=>r.mode==='stale'))assert.equal(row.memoryEvidence,0);
 assert.deepEqual(pick('corrected','on').contextSourceIds,['current']);
 assert.equal(pick('conflict','on').selected,null);assert.ok(pick('conflict','on').memoryTypes.every(t=>t==='personal_knowledge_issue'));
 assert.equal(pick('owner-isolation','on').memoryEvidence,0);
 assert.equal(pick('recall-a','wrong').incorrectSelection,true);
 assert.equal(pick('explicit-overrides','wrong').selected,'b');
 for(const repeat of [0,1.2,6])await assert.rejects(runNewSessionMemoryComparison({repeat}),/Invalid repetitions/);
});
