import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-memory-generation-'));
 const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=new GrowthRuntime({memoryStore:store,auditRoot:root});
 const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
 const ingest=(id,text)=>runtime.ingestor.ingest({eventId:id,taskId:id,eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:{rawText:text},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
 ingest('base-event','기준 자료');const backup=store.backup({backupId:'baseline'});
 ingest('post-event','STALE_GENERATION_MARKER_472');
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,runtime,scope,backup};
}
test('durable restore generation is monotonic and an existing runtime refreshes before recall',t=>{
 const f=fixture(t),old=f.runtime.ingestor;
 assert.equal(f.store.restoreGeneration(),0);
 assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);assert.equal(f.store.restoreGeneration(),1);
 assert.equal(f.runtime.query('STALE_GENERATION_MARKER_472',{scope:f.scope}).length,0);
 assert.equal(f.runtime.memoryGeneration,1);assert.equal(old.all().some(item=>item.eventId==='post-event'),false);
 assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);assert.equal(f.store.restoreGeneration(),2);
 assert.equal(f.runtime.query('STALE_GENERATION_MARKER_472',{scope:f.scope}).length,0);assert.equal(f.runtime.memoryGeneration,2);
 assert.equal(f.store.restore({backupPath:'missing'}).success,false);assert.equal(f.store.restoreGeneration(),2);
});
test('held ingestor reference delegates new ingestion to refreshed active state',t=>{
 const f=fixture(t),old=f.runtime.ingestor;
 assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);
 const result=old.ingest({eventId:'new-event',taskId:'new-task',eventType:'task.created',source:{module:'CORE',memoryScope:f.scope},payload:{rawText:'새 자료'},trustBoundary:{userProvided:true}});
 assert.equal(result.success,true);assert.notEqual(f.runtime.ingestor,old);
 assert.equal(f.runtime.ingestor.events.has('post-event'),false);assert.equal(f.runtime.ingestor.events.has('new-event'),true);
 assert.equal(f.store.allEvents().some(item=>item.eventId==='new-event'),true);
});
for(const action of ['query','ingest'])test(`separate cached runtime detects another process restore before ${action}`,async t=>{
 const f=fixture(t);
 const child=fork(new URL('./fixtures/memory-generation-peer.mjs',import.meta.url),[f.root],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:['ignore','ignore','ignore','ipc']});
 let nextId=0;const pending=new Map();const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.ready)resolve(m);else pending.get(m.id)?.(m);});child.once('error',reject);});
 const request=action=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>reject(new Error('peer timeout')),5000);pending.set(id,m=>{clearTimeout(timer);pending.delete(id);resolve(m);});child.send({id,action});});
 try{
   assert.equal((await ready).cachedPostEvent,true);
   assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);
   const result=await request(action);
   if(action==='query'){assert.equal(result.matches,0);assert.equal(result.eventCount,1);assert.equal(result.generation,1);}
   else{assert.equal(result.success,true);assert.equal(result.oldEventPresent,false);assert.equal(result.newEventPresent,true);}
 }finally{await new Promise(resolve=>{child.once('exit',resolve);child.send({action:'close'});});}
});

test('restore during cache construction fails closed instead of labeling mixed state current',t=>{
 const f=fixture(t),read=f.store.allEvents.bind(f.store);let once=true;
 f.store.allEvents=()=>{const events=read();if(once){once=false;assert.equal(f.store.restore({backupPath:f.backup.filePath}).success,true);}return events;};
 const result=f.runtime.reloadRestoredMemoryState();
 assert.equal(result.success,false);assert.equal(f.runtime.memoryRecoveryState.status,'restart_required');
 assert.equal(f.runtime.ingestor.events.size,0);assert.deepEqual(f.runtime.query('STALE_GENERATION_MARKER_472',{scope:f.scope}),[]);
 f.store.allEvents=read;
 assert.equal(f.runtime.restoreStorage({backupPath:f.backup.filePath}).success,true);
 assert.equal(f.runtime.ingestor.events.has('post-event'),false);
});
