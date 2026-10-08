import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime, MemoryEventIngestor } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-memory-write-fence-'));
 const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=new GrowthRuntime({memoryStore:store,auditRoot:root});
 const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
 const event=id=>({eventId:id,taskId:id,eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:{rawText:`합성 ${id}`},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
 runtime.ingestor.ingest(event('baseline'));const backup=store.backup({backupId:'baseline'});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,runtime,event,backup,root};
}
test('restore after runtime refresh but immediately before SQL write rejects stale event and preserves retry',t=>{
 const f=fixture(t),save=f.store.saveEvent.bind(f.store),old=f.runtime.ingestor;let once=true;
 f.store.saveEvent=(event,options)=>{if(once){once=false;assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);}return save(event,options);};
 const result=old.ingest(f.event('raced-event'));
 assert.equal(result.success,false);assert.equal(result.error.code,'F_MEMORY_GENERATION_CONFLICT');assert.equal(result.retryAfterRefresh,true);
 assert.equal(f.store.hasEvent('raced-event'),false);assert.equal(old.events.has('raced-event'),false);
 assert.equal(old.ingest(f.event('raced-event')).stored,true);assert.equal(f.store.hasEvent('raced-event'),true);
 assert.equal(f.runtime.memoryGeneration,1);
});
test('duplicate decision based on pre-restore cache must not report successful suppression',t=>{
 const f=fixture(t),old=f.runtime.ingestor;old.ingest(f.event('post-event'));
 const minimize=old.sensitiveMinimizer.minimize.bind(old.sensitiveMinimizer);let once=true;
 old.sensitiveMinimizer.minimize=event=>{const result=minimize(event);if(once){once=false;assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);}return result;};
 const result=old.ingest(f.event('post-event'));assert.equal(result.success,false);assert.equal(result.error.code,'F_MEMORY_GENERATION_CONFLICT');
 assert.equal(f.store.hasEvent('post-event'),false);
 assert.equal(old.ingest(f.event('post-event')).stored,true);assert.equal(f.store.hasEvent('post-event'),true);
});
test('standalone ingestor receives generation conflict instead of writing into restored state',t=>{
 const f=fixture(t),ingestor=new MemoryEventIngestor({store:f.store,auditLog:f.runtime.auditLog});
 assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);
 assert.equal(ingestor.ingest(f.event('stale-event')).error.code,'F_MEMORY_GENERATION_CONFLICT');
 assert.equal(f.store.hasEvent('stale-event'),false);
});
