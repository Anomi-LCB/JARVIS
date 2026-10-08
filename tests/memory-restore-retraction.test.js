import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-restore-withdrawal-'));
  const options = { dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') };
  const store = new SqliteMemoryStore(options), runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  const scope = { userId: 'synthetic-owner', workspaceRoot: root, conversationId: null };
  for(let i=1;i<=3;i++) runtime.ingestor.ingest({ eventId:`event-${i}`, taskId:`task-${i}`, eventType:'approval.edited', source:{module:'CORE', memoryScope:scope}, payload:{editRequest:'합성 회의자료를 표로 정리해줘'}, learningFlags:{canBeUsedForPreference:true,canBeUsedForWorkflow:true}, trustBoundary:{userProvided:true} });
  const candidate=runtime.query('회의자료',{scope}).find(item=>item.hypothesisId);
  const result=runtime.decidePreference({hypothesisId:candidate.hypothesisId});assert.equal(result.success,true);
  const id=result.item.preferenceId;
  runtime.updatePreference(id,{expectedRevision:1,patch:{statement:'PRIVATE_SYNTHETIC_BACKUP_MARKER_921'}});
  const review=runtime.latestReview();
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,runtime,scope,id,review};
}
for(const encrypted of [false,true]) test(`restoring ${encrypted?'encrypted':'plain'} pre-deletion backup retains withdrawals and withholds stale reports`,t=>{
  const f=fixture(t);
  const backup=encrypted?f.store.encryptedBackup({backupId:'synthetic-before-delete'}):f.store.backup({backupId:'synthetic-before-delete'});
  const before=readFileSync(backup.filePath);
  assert.ok(JSON.stringify(f.store.latestReview()).includes('PRIVATE_SYNTHETIC_BACKUP_MARKER_921'));
  f.runtime.decideHygiene({targetId:'event-1',action:'delete'});
  const retraction=f.store.allSourceRetractions()[0];assert.ok(retraction);
  assert.equal(JSON.stringify(f.store.latestReview()).includes('PRIVATE_SYNTHETIC_BACKUP_MARKER_921'),false);
  const restored=f.store.restore({backupPath:backup.filePath});assert.equal(restored.success,true);
  assert.equal(restored.retainedSourceRetractionCount,1);
  assert.equal(f.store.hasSourceRetraction('event-1'),true);
  assert.deepEqual(readFileSync(backup.filePath),before,'retained historical backup not mutated');
  assert.equal(f.store.latestReview().contentWithheld,true);
  assert.equal(JSON.stringify(f.store.latestReview()).includes('PRIVATE_SYNTHETIC_BACKUP_MARKER_921'),false);
  const reopened=new GrowthRuntime({memoryStore:f.store,auditRoot:f.root});
  assert.equal(reopened.confirmedPreferenceRegistry.all().length,0);
  assert.equal(JSON.stringify(reopened.latestReview()).includes('PRIVATE_SYNTHETIC_BACKUP_MARKER_921'),false);
  assert.equal(f.store.latestReview().contentWithheld,undefined,'new safely generated report can be returned');
});
test('invalid restore preserves current data and withdrawal evidence without closing the usable store',t=>{
  const f=fixture(t);f.runtime.decideHygiene({targetId:'event-1',action:'redact'});
  const bad=join(f.root,'invalid.sqlite');writeFileSync(bad,'not a SQLite database');
  const result=f.store.restore({backupPath:bad});assert.equal(result.success,false);assert.equal(result.error.code,'F_STORAGE_RESTORE_FAILED');
  assert.equal(f.store.hasSourceRetraction('event-1'),true);assert.equal(f.store.integrityCheck().status,'ok');
  assert.equal(f.store.getConfirmedPreference(f.id).preferenceId,f.id);
});
