import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { MissionExecutionAuthority } from '../packages/core/src/mission/mission-execution-authority.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'jarvis-core-authority-')),connections=[],guards=[],disposers=[];
  let time=Date.parse('2026-10-02T00:00:00Z');
  const open=()=>{const operations=new PersonalOperationsStore({dbPath:join(root,'isolated.sqlite'),clock:()=>new Date(time)});connections.push(operations);return new SqliteMissionStore({operationsStore:operations});};
  const store=open();
  const guard=(s=store,id='first-core')=>{const g=new MissionExecutionAuthority({store:s,ownerId:id,ttlMs:100});guards.push(g);return g;};
  t.after(async()=>{for(const dispose of disposers)await dispose();guards.forEach(g=>g.stopHeartbeat());connections.forEach(c=>c.close());rmSync(root,{recursive:true,force:true});});
  return {store,open,guard,root,onDispose:fn=>disposers.push(fn),advance:ms=>{time+=ms;}};
}

test('explicit SQL authority admits one Core and fences stale owners even after clock rollback',t=>{
  const f=fixture(t),first=f.guard(),lease=first.activate({expectedToken:0,heartbeat:false});
  const second=f.guard(f.open(),'second-core');
  assert.throws(()=>second.activate({expectedToken:lease.token,heartbeat:false}),/ANOTHER_CORE_ACTIVE/);
  assert.throws(()=>second.activate({expectedToken:0,heartbeat:false}),/REVISION_CONFLICT/);
  f.advance(101);assert.throws(()=>first.renew(),/STALE_FENCE/);
  f.advance(-80);assert.throws(()=>first.assertActive(),/STALE_FENCE/);
  const newer=second.activate({expectedToken:lease.token,heartbeat:false});
  assert.ok(newer.token>lease.token);second.assertActive();
  assert.throws(()=>first.assertActive(),/STALE_FENCE/);
  assert.throws(()=>f.store.releaseCoreAuthority(lease),/STALE_FENCE/);
  second.release();assert.equal(f.store.coreAuthorityStatus().ownerId,null);
});

test('active Mission or uncertain effect blocks authority handoff instead of automatic takeover',t=>{
  const f=fixture(t),first=f.guard(),lease=first.activate({expectedToken:0,heartbeat:false});
  f.store.save([{missionId:'synthetic-mission',status:'RUNNING'}]);
  assert.throws(()=>first.release(),/MISSIONS_ACTIVE/);first.assertActive();
  f.advance(101);
  assert.throws(()=>f.guard(f.open(),'standby').activate({expectedToken:lease.token,heartbeat:false}),/MISSIONS_ACTIVE/);
  f.store.load();f.store.save([{missionId:'synthetic-mission',status:'PAUSED'}],{effects:[{effectId:'test-effect',operationId:'test-operation',missionId:'synthetic-mission',resourceKey:'synthetic-resource',request:{action:'synthetic'}}]});
  const claim=f.store.claimEffect({effectId:'test-effect',ownerId:'synthetic-worker',ttlMs:1000});
  f.store.markUncertain({effectId:'test-effect',lease:claim.lease});
  assert.throws(()=>f.guard(f.open(),'recovery-core').activate({expectedToken:lease.token,heartbeat:false}),/EFFECT_RECONCILIATION_REQUIRED/);
});

test('runtime rejects an inactive authority before loading or rewriting Mission snapshots',t=>{
  const f=fixture(t),inactive=f.guard(),before=f.store.metadata().revision;
  assert.throws(()=>createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'audit'),env:{},missionStore:f.store,missionExecutionAuthority:inactive,workerDaemonEnabled:false}),/NOT_ACTIVE/);
  assert.equal(f.store.metadata().revision,before);
});

test('explicit expired-owner recovery authority permits reconciliation but never ordinary execution or implicit promotion',t=>{
 const f=fixture(t),first=f.guard(),lease=first.activate({expectedToken:0,heartbeat:false});
 f.store.save([{missionId:'interrupted',status:'RUNNING'}]);
 const recovery=f.guard(f.open(),'recovery-reader');
 assert.throws(()=>recovery.activate({expectedToken:lease.token,heartbeat:false,recoveryOnly:true}),/ANOTHER_CORE_ACTIVE/);
 f.advance(101);
 assert.throws(()=>recovery.activate({expectedToken:0,heartbeat:false,recoveryOnly:true}),/REVISION_CONFLICT/);
 recovery.activate({expectedToken:lease.token,heartbeat:false,recoveryOnly:true});
 assert.equal(recovery.recoveryOnly,true);recovery.assertActive({allowRecovery:true});recovery.renew();
 assert.throws(()=>recovery.assertActive(),/RECOVERY_ONLY/);
 assert.throws(()=>recovery.release(),/MISSIONS_ACTIVE/);
 f.store.save([{missionId:'interrupted',status:'PAUSED'}]);
 assert.throws(()=>recovery.assertActive(),/RECOVERY_ONLY/,'resolved records do not silently grant execution');
 recovery.release();
 const normal=f.guard(f.open(),'explicit-normal');normal.activate({expectedToken:2,heartbeat:false});normal.assertActive();
});

test('two real Core processes race for one authority and transfer only after explicit release',async t=>{
  const f=fixture(t),children=[];
  f.onDispose(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const done=once(c,'exit');c.kill('SIGKILL');await done;}});
  const wait=c=>new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('authority child timeout')),15000);c.once('message',m=>{clearTimeout(timer);done(m);});});
  const launch=async()=>{const c=fork(new URL('./fixtures/core-authority-child.mjs',import.meta.url),[join(f.root,'isolated.sqlite')],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(c);assert.equal((await wait(c)).type,'ready');return c;};
  const a=await launch(),b=await launch();assert.notEqual(a.pid,b.pid);
  const answers=[wait(a),wait(b)];a.send({type:'claim',expectedToken:0});b.send({type:'claim',expectedToken:0});
  const result=await Promise.all(answers);assert.equal(result.filter(r=>r.type==='claimed').length,1);assert.equal(result.filter(r=>r.type==='denied').length,1);
  const winner=result[0].type==='claimed'?a:b,loser=winner===a?b:a;
  const releasing=wait(winner);winner.send({type:'release'});assert.equal((await releasing).type,'released');
  const claiming=wait(loser);loser.send({type:'claim',expectedToken:1});assert.equal((await claiming).lease.token,2);
  const releasingNew=wait(loser);loser.send({type:'release'});assert.equal((await releasingNew).type,'released');
  // Close children before fixture cleanup closes the parent connection/removes its directory.
  for(const child of children){const ended=once(child,'exit');child.send({type:'close'});await ended;}
});
