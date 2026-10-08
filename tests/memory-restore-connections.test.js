import { fork } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'jarvis-restore-connection-'));
  const options={dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')};
  const store=new SqliteMemoryStore(options), observer=new SqliteMemoryStore(options);
  t.after(()=>{observer.close();store.close();rmSync(root,{recursive:true,force:true});});
  store.saveReview({reviewId:'baseline',generatedAt:'2026-10-03T00:00:00Z',period:'synthetic',summary:'baseline'});
  const backup=store.backup({backupId:'baseline'});
  observer.saveReview({reviewId:'post-backup',generatedAt:'2026-10-03T00:01:00Z',period:'synthetic',summary:'post-backup'});
  return {store,observer,backup,root,options};
}
const withdrawal = id => ({decisionId:`delete-${id}`,targetType:'memory_event',targetId:id,action:'delete',decidedAt:'2026-10-03T00:02:00Z'});
test('other open connection sees restored rows on the same DB and late withdrawal is preserved',t=>{
  const f=fixture(t), identity=statSync(f.options.dbPath).ino;
  const materialize=f.store.materializeBackupForRead.bind(f.store);
  f.store.materializeBackupForRead=options=>{const result=materialize(options);f.observer.saveHygieneDecision(withdrawal('late-source'));return result;};
  const result=f.store.restore({backupPath:f.backup.filePath});
  assert.equal(result.success,true);assert.equal(result.restoreMode,'transactional_rows_preserve_database_identity');
  assert.equal(statSync(f.options.dbPath).ino,identity);
  assert.equal(f.observer.db.prepare("SELECT count(*) AS n FROM growth_reviews WHERE review_id='post-backup'").get().n,0);
  assert.equal(f.observer.hasSourceRetraction('late-source'),true);
  assert.equal(f.store.hasSourceRetraction('late-source'),true);
  f.observer.saveHygieneDecision(withdrawal('after-restore'));
  assert.equal(f.store.hasSourceRetraction('after-restore'),true);
});
test('merge failure after row replacement rolls back the entire restore for both connections',t=>{
  const f=fixture(t);f.observer.saveHygieneDecision(withdrawal('protected-source'));
  const save=f.store.saveHygieneDecision.bind(f.store);
  f.store.saveHygieneDecision=()=>{throw new Error('synthetic current merge failure');};
  const result=f.store.restore({backupPath:f.backup.filePath});assert.equal(result.success,false);
  f.store.saveHygieneDecision=save;
  for(const store of [f.store,f.observer]){
    assert.equal(store.hasSourceRetraction('protected-source'),true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM growth_reviews WHERE review_id='post-backup'").get().n,1);
    assert.equal(store.integrityCheck().status,'ok');
  }
});
test('competing writer prevents restore and leaves transaction state usable after lock release',t=>{
  const f=fixture(t);f.store.db.exec('PRAGMA busy_timeout=0;');f.observer.db.exec('BEGIN IMMEDIATE;');
  try{assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,false);assert.equal(f.store.inTransaction,false);}
  finally{f.observer.db.exec('ROLLBACK;');}
  f.store.saveHygieneDecision(withdrawal('after-lock'));
  assert.equal(f.observer.hasSourceRetraction('after-lock'),true);
  assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);
  assert.equal(f.observer.hasSourceRetraction('after-lock'),true);
});

test('separate process writer is blocked during restore conflict and sees committed restore afterwards', async t=>{
  const f=fixture(t);f.store.db.exec('PRAGMA busy_timeout=0;');
  const child=fork(new URL('./fixtures/memory-restore-peer.mjs',import.meta.url),[f.root],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:['ignore','ignore','ignore','ipc']});
  let nextId=0;const pending=new Map();
  const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.ready)resolve();else pending.get(m.id)?.(m);});child.once('error',reject);});
  const request=action=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('peer response timeout'));},5000);pending.set(id,m=>{clearTimeout(timer);pending.delete(id);resolve(m);});child.send({id,action});});
  try{
    await ready;
    assert.equal((await request('lock')).locked,true);
    assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,false);
    assert.equal(f.store.inTransaction,false);
    await request('release');
    f.store.saveHygieneDecision(withdrawal('cross-process-source'));
    assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);
    const observed=await request('inspect');assert.equal(observed.postBackupCount,0);assert.equal(observed.withdrawn,true);
  }finally{
    await new Promise(resolve=>{child.once('exit',resolve);child.send({action:'close'});});
  }
});
