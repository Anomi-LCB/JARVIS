import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteArtifactBinding,createRemoteArtifactIntent,validateRemoteArtifactIntent } from '../packages/core/src/mission/remote-artifact-contract.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';

const binding=(extra={})=>createRemoteArtifactBinding({deviceId:'pc',deviceGeneration:1,certificateFingerprint:'A'.repeat(64),pathPlatform:'win32',allowedRoots:['C:\\Work'],...extra});
const taskId='task_한글',operationId=`mission_op_${'a'.repeat(32)}`;
const action=path=>({toolName:'filesystem.createTextFile',arguments:{path,content:'원문'}});
const contract=(scope,path='Result.txt',op=operationId)=>createRemoteArtifactIntent({binding:scope,taskId,operationId:op,action:action(path)});
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'jarvis-remote-contract-'));let operations,store;
  const open=()=>{operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});store=new SqliteMissionStore({operationsStore:operations});};open();
  t.after(()=>{operations.close();rmSync(root,{recursive:true,force:true});});
  return {get store(){return store;},get operations(){return operations;},restart(){operations.close();open();store.load();}};
}
function effect(scope,path='Result.txt',op=operationId){
  const remoteArtifactIntent=contract(scope,path,op);
  return {effectId:op,missionId:'m',operationId:op,resourceKey:remoteArtifactIntent.resourceKey,providerIdempotencyKey:op,
    request:{taskId,action:action(path),remoteArtifactIntent}};
}
test('Windows paths are interpreted with explicit Windows semantics on any host',()=>{
  const c=contract(binding(),'c:/WORK/Sub/../Result.txt');
  assert.equal(c.target,'c:\\work\\result.txt');
  assert.equal(c.resourceKey,contract(binding(),'C:\\work\\RESULT.TXT').resourceKey);
  assert.equal(contract(binding({pathPlatform:'posix',allowedRoots:['/selected']}),'a.txt').target,'/selected/a.txt');
});
test('drive-relative, network/device paths, ADS, DOS aliases and root escape are rejected',()=>{
  for(const path of ['C:','C:private','\\secret','\\\\server\\share\\x','\\\\?\\C:\\Work\\x','x.txt:secret','NUL.txt','sub/CON','COM¹.txt','LPT²','COM³','x.','x ','*.txt'])
    assert.throws(()=>contract(binding(),path),{code:'A_REMOTE_ARTIFACT_PATH_INVALID'},path);
  for(const path of ['../private.txt','D:\\private.txt','C:\\Work2\\private.txt'])assert.throws(()=>contract(binding(),path),{code:'A_REMOTE_ARTIFACT_OUTSIDE_ROOT'},path);
});
test('identity/scope changes cannot validate an old intent, but generation rotation retains the file lock',()=>{
  const original=binding(),intent=contract(original);
  for(const changed of [binding({deviceId:'other'}),binding({deviceGeneration:2}),binding({certificateFingerprint:'B'.repeat(64)}),binding({allowedRoots:['C:\\Other']})])
    assert.throws(()=>validateRemoteArtifactIntent(intent,{binding:changed,taskId,operationId,action:action('Result.txt')}),{code:'A_REMOTE_ARTIFACT_INTENT_MISMATCH'});
  assert.equal(intent.resourceKey,contract(binding({deviceGeneration:2,certificateFingerprint:'B'.repeat(64)})).resourceKey);
});
test('SQL intent survives reopen and rejects changed approved binding or persisted request',t=>{
  const f=fixture(t),scope=binding(),e=effect(scope);
  f.store.save([{missionId:'m'}],{effects:[e]});f.restart();
  assert.deepEqual(f.store.getRemoteArtifactIntent(e.effectId,scope),e.request.remoteArtifactIntent);
  assert.throws(()=>f.store.getRemoteArtifactIntent(e.effectId,binding({deviceGeneration:2})),{code:'A_REMOTE_ARTIFACT_INTENT_MISMATCH'});
  const row=f.store.getEffect(e.effectId),intent=row.intent;intent.request.action.arguments.content='forged';
  f.operations.db.prepare('UPDATE mission_effects SET intent_json=? WHERE effect_id=?').run(JSON.stringify(intent),e.effectId);
  assert.throws(()=>f.store.getRemoteArtifactIntent(e.effectId,scope),/HASH_MISMATCH|REQUEST_MISMATCH/u);
});
test('SQL refuses a forged resource or target atomically without a new revision',t=>{
  const f=fixture(t);
  for(const field of ['resource','target','action']){
    const e=effect(binding());
    if(field==='resource')e.resourceKey='other';else if(field==='target')e.request.remoteArtifactIntent.target='c:\\outside';else e.request.action.arguments.content='other';
    assert.throws(()=>f.store.save([{missionId:'m'}],{effects:[e]}),/A_REMOTE_ARTIFACT_/u);
    assert.equal(f.store.metadata().revision,0);assert.throws(()=>f.store.getEffect(e.effectId),{code:'A_DURABLE_EFFECT_MISSING'});
  }
});
test('different generation and case aliases cannot obtain two live SQL resource leases',t=>{
  const f=fixture(t),one=effect(binding()),two=effect(binding({deviceGeneration:2}),'RESULT.TXT',`mission_op_${'b'.repeat(32)}`);
  f.store.save([{missionId:'m'}],{effects:[one,two]});
  assert.ok(f.store.claimEffect({effectId:one.effectId,ownerId:'core-one'}));
  assert.equal(f.store.claimEffect({effectId:two.effectId,ownerId:'core-two'}),null);
});
test('SQL row identity/resource substitution cannot rebind an otherwise intact intent',t=>{
  for(const column of ['mission_id','resource_key','request_sha256','intent_sha256']){
    const f=fixture(t),scope=binding(),e=effect(scope);f.store.save([{missionId:'m'}],{effects:[e]});
    f.operations.db.prepare(`UPDATE mission_effects SET ${column}=? WHERE effect_id=?`).run('changed',e.effectId);
    assert.throws(()=>f.store.getRemoteArtifactIntent(e.effectId,scope),{code:'A_REMOTE_ARTIFACT_REQUEST_MISMATCH'});
  }
});
