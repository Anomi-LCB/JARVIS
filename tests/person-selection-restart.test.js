import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
const first={id:'fictional-education',이름:'김민수',소속:'교육팀'},second={id:'fictional-finance',이름:'김민수',소속:'재정팀'};
const run=(root,phase,id)=>{const r=spawnSync(process.execPath,['tests/fixtures/person-restart-child.mjs',root,phase,...(id?[id]:[])],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return JSON.parse(r.stdout.trim().split(/\r?\n/u).at(-1));};
for(const mode of ['durable-restart','missing-B-journal','changed-dispatch','forged-Core-proof','tampered-B-proof','unsigned-B-proof'])test('actual child process person selection '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-person-restart-')),workspace=join(root,'workspace');await mkdir(workspace);const bytes=JSON.stringify([first,second]);await writeFile(join(workspace,'people.json'),bytes);
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const initial=run(root,'initial');assert.equal(initial.status,'PAUSED');assert.equal(initial.proof,true);assert.equal(initial.workerCalls,1);await assert.rejects(readFile(join(workspace,'selected.json')),{code:'ENOENT'});
 const journal=join(root,'audit','packet-journal.jsonl');
 if(mode==='missing-B-journal'||mode==='forged-Core-proof')await writeFile(journal,'');
 if(mode==='tampered-B-proof'||mode==='unsigned-B-proof'){
  const records=(await readFile(journal,'utf8')).trim().split(/\r?\n/u).map(line=>JSON.parse(line));
  const terminal=records.findLast(row=>row.recordType==='packet_result'&&row.result?.executionResult?.evidence?.unpublishedPersonFailure);
  assert.ok(terminal);const proof=terminal.result.executionResult.evidence.unpublishedPersonFailure;assert.equal(typeof proof.signature,'string');
  if(mode==='tampered-B-proof')proof.argsSha256='0'.repeat(64);else delete proof.signature;
  await writeFile(journal,records.map(row=>JSON.stringify(row)).join('\n')+'\n');
 }
 if(mode==='changed-dispatch'||mode==='forged-Core-proof'){
  const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),missions=new SqliteMissionStore({operationsStore:store}),all=missions.load(),m=all.find(m=>m.missionId===initial.missionId),a=m.waves[0].actions[0];
  if(mode==='changed-dispatch')a.operation.dispatch.arguments.spec.nodes[1].args.where.value='이준호';
  else a.unpublishedFailureEvidence={...a.unpublishedFailureEvidence,noPublication:true,stageRemoved:true,executionAuthority:true};
  missions.save(all);store.close();
 }
 const resumed=run(root,'resume',initial.missionId);assert.notEqual(initial.pid,resumed.pid);assert.equal(resumed.copiedProof,false);
 if(mode==='durable-restart'){
  assert.equal(resumed.restoredProof,true);assert.equal(resumed.revisionStatus,'applied',JSON.stringify(resumed));assert.equal(resumed.status,'COMPLETED',JSON.stringify(resumed));assert.equal(resumed.workerCalls,1);assert.equal(resumed.revision,2);assert.equal(resumed.lastError,null);assert.equal(resumed.trust.keyProvider.protectedByOs,true);assert.equal(resumed.trust.keyProvider.persistent,true);assert.deepEqual(JSON.parse(await readFile(join(workspace,'selected.json'),'utf8')),[first]);
 }else{assert.equal(resumed.restoredProof,false);assert.equal(resumed.revisionStatus,'applied');assert.ok(resumed.conflicts.length>0);assert.equal(resumed.workerCalls,0);assert.notEqual(resumed.status,'COMPLETED');await assert.rejects(readFile(join(workspace,'selected.json')),{code:'ENOENT'});}
 assert.equal(await readFile(join(workspace,'people.json'),'utf8'),bytes);console.log(JSON.stringify({mode,initial,resumed,actualSeparateOSProcesses:true,actualSQL:true}));
});
