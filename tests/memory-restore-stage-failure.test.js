import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
test('failure to merge current withdrawal leaves the current database intact', t => {
  const root=mkdtempSync(join(tmpdir(),'jarvis-restore-stage-'));
  const store=new SqliteMemoryStore({dbPath:join(root,'db.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  store.saveReview({reviewId:'old-review',generatedAt:'2026-10-03T00:00:00Z',period:'test',summary:'SYNTHETIC_RETAINED_FILE_CONTENT'});
  const backup=store.backup({backupId:'before-withdrawal'});
  const decision={decisionId:'withdraw-1',targetType:'memory_event',targetId:'event-1',action:'delete',decidedAt:'2026-10-03T00:01:00Z'};
  store.saveHygieneDecision(decision);
  assert.equal(store.latestReview().contentWithheld,true);
  const exportedBeforeFailedRestore=readFileSync(join(root,'reviews','old-review.json'));
  assert.equal(exportedBeforeFailedRestore.toString('utf8').includes('SYNTHETIC_RETAINED_FILE_CONTENT'),false,'withdrawn export contains only a withheld notice');
  const save=SqliteMemoryStore.prototype.saveHygieneDecision;
  SqliteMemoryStore.prototype.saveHygieneDecision=function(item){if(this!==store)throw new Error('synthetic staged persistence failure');return save.call(this,item);};
  try{assert.equal(store.restore({backupPath:backup.filePath}).success,false);}finally{SqliteMemoryStore.prototype.saveHygieneDecision=save;}
  assert.equal(store.hasSourceRetraction('event-1'),true);
  assert.equal(store.integrityCheck().status,'ok');
  assert.equal(store.latestReview().contentWithheld,true);
  assert.deepEqual(readFileSync(join(root,'reviews','old-review.json')),exportedBeforeFailedRestore,'staged validation cannot rewrite live export files');
  const emptyPath=join(root,'valid-but-empty.sqlite');const empty=new DatabaseSync(emptyPath);empty.exec('CREATE TABLE unrelated (id INTEGER);');empty.close();
  assert.equal(store.restore({backupPath:emptyPath}).success,false);
  assert.equal(store.hasSourceRetraction('event-1'),true);
});
