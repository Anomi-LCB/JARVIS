import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {FailureImprovementPipeline} from '../packages/core/src/capabilities/failure-improvement-pipeline.js';
import {sourceTestManager} from './fixtures/improvement-policy-fixture.mjs';
const url='https://nodejs.org/api/fs.html',content='same public bytes',sha=createHash('sha256').update(content).digest('hex');
const time='2026-10-06T12:00:00.000Z';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-source-provenance-')),store=new PersonalOperationsStore({dbPath:join(root,'sources.sqlite')});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return{root,store};}
function pipeline(store,clock=()=>new Date(time)){
 return new FailureImprovementPipeline({store,promotionManager:sourceTestManager(),sourcesForTool:new Map([['workflow.execute',[url]]]),clock,
  fetchSource:async()=>new Response(content),createCandidate:()=>{throw Object.assign(Error('fixture stops before candidate admission'),{code:'FIXTURE_STOP'});}});
}
const observation=(id,observedAt=time)=>({version:1,taskId:id,status:'FAILED',observedAt,toolName:'workflow.execute',nativeRecovery:null});
test('legacy source migration is idempotent and leaves historical storage intact',t=>{
 const {store}=fixture(t);store.db.exec('CREATE TABLE failure_improvement_sources(sha256 TEXT PRIMARY KEY,url TEXT NOT NULL,content TEXT NOT NULL,observed_at TEXT NOT NULL)');
 store.db.prepare('INSERT INTO failure_improvement_sources VALUES(?,?,?,?)').run(sha,url,content,time);
 const first=pipeline(store);assert.equal(first.sourceSnapshot(sha,url,time).content,content);
 pipeline(store);assert.equal(store.db.prepare('SELECT count(*) AS n FROM failure_improvement_source_observations').get().n,1);
 assert.deepEqual({...store.db.prepare('SELECT * FROM failure_improvement_sources').get()},{sha256:sha,url,content,observed_at:time});
});
test('same URL and bytes retain distinct observation times across new failure cycles',async t=>{
 const {store}=fixture(t);let current=time;const p=pipeline(store,()=>new Date(current));
 const [one]=p.enqueue([observation('one'),observation('two')]);await assert.rejects(p.process(one.id),{code:'FIXTURE_STOP'});
 current='2026-10-06T12:01:00.000Z';const two=p.enqueue([observation('three',current),observation('four',current)]).find(v=>v.state==='queued');await assert.rejects(p.process(two.id),{code:'FIXTURE_STOP'});
 assert.equal(p.sourceSnapshot(sha,url,time).observedAt,time);assert.equal(p.sourceSnapshot(sha,url,current).observedAt,current);
 assert.equal(p.sourceSnapshot(sha).observedAt,current);
 assert.throws(()=>p.sourceSnapshot(sha,url,'2026-10-06T12:00:01.000Z'),{code:'A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID'});
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM failure_improvement_source_observations').get().n,2);
});
test('damaged source bytes and mismatched URL cannot be returned as pinned evidence',t=>{
 const {store}=fixture(t),p=pipeline(store);
 store.db.prepare('INSERT INTO failure_improvement_source_observations VALUES(?,?,?,?)').run(url,sha,time,'changed source bytes');
 for(const args of [[sha,url,time],[sha,'https://nodejs.org/api/worker_threads.html',time],['bad',url,time],[sha,undefined,time]])assert.throws(()=>p.sourceSnapshot(...args),{code:'A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID'});
});
test('two actual OS processes retain URL and time provenance without issuing any candidate or execution calls',t=>{
 const {root}=fixture(t),script=join(import.meta.dirname,'fixtures/source-provenance-process.mjs');
 const invoke=mode=>JSON.parse(execFileSync(process.execPath,[script,mode,join(root,'process.sqlite')],{encoding:'utf8',timeout:15000}));
 const written=invoke('write'),read=invoke('read');assert.notEqual(written.pid,read.pid);
 assert.deepEqual(read.sources,written.sources);assert.equal(read.sources.length,2);assert.equal(read.snapshots[0].url,read.sources[0].url);assert.equal(read.snapshots[1].url,read.sources[1].url);
 assert.equal(read.executionCalls,0);assert.equal(read.candidateCalls,0);assert.equal(read.ambiguous,true);
 t.diagnostic(JSON.stringify({writerPid:written.pid,readerPid:read.pid,sources:read.sources,executionCalls:0,scope:'Source evidence persistence only; no stage restoration or evaluation execution'}));
});
