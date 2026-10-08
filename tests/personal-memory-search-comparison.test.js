import test from 'node:test';import assert from 'node:assert/strict';
import {runPersonalMemorySearchComparison} from '../scripts/personal-memory-search-comparison.mjs';
import {spawnSync} from 'node:child_process';import {readFileSync,unlinkSync} from 'node:fs';import {resolve} from 'node:path';

test('frozen matched comparison executes existing F baseline and retains missing semantic provider in denominator',async()=>{
 const report=await runPersonalMemorySearchComparison({repeat:1});
 assert.equal(report.observations.length,60);assert.equal(report.sourceUnchanged,true);
 assert.equal(report.summary.baseline.total,12);assert.equal(report.summary.semantic.blocked,11);
 assert.equal(report.summary.semantic.failed,1);assert.equal(report.summary.semantic.requiredItemsPreserved,0);
 for(const row of report.observations){assert.deepEqual(row.outsideScopeOrWindow,[]);assert.equal(row.cost.amount,null);}
 assert.equal(report.summary.relationship.requiredItemsPreserved,11);
 assert.equal(report.summary.time.requiredItemsPreserved>0,true);
 assert.equal(report.observations.find(row=>row.caseId==='time-october'&&row.mode==='time').ids.join(','),'r08,r07,r05');
 assert.equal(report.observations.some(row=>row.ids.includes('expired')||row.ids.includes('other-owner')),false);
});

test('real comparison CLI saves immutable evidence and rejects source overwrite',()=>{
 const output=resolve('artifacts/personal-memory-search-cli-test-'+process.pid+'.json');
 try{
  const run=spawnSync(process.execPath,['scripts/personal-memory-search-comparison.mjs','--repeat','1','--output',output],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(readFileSync(output)).observations.length,60);
  const again=spawnSync(process.execPath,['scripts/personal-memory-search-comparison.mjs','--repeat','1','--output',output],{encoding:'utf8'});
  assert.notEqual(again.status,0);assert.match(again.stderr,/EEXIST/);
  const deny=spawnSync(process.execPath,['scripts/personal-memory-search-comparison.mjs','--output','tests/fixtures/personal-memory-search-v1.json'],{encoding:'utf8'});
  assert.notEqual(deny.status,0);
 }finally{try{unlinkSync(output);}catch{}}
});
