import { fork } from 'node:child_process';
import { CoreOrchestrationWorker } from '../packages/core/src/orchestration/core-orchestration-worker.js';
import { VerificationRuntime } from '../apps/verification/src/verification-runtime.js';
import { createGrowthMemoryServer } from '../apps/growth-memory/src/main.mjs';
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


function enqueue(f,id,privateText='합성 사건'){
 const save=f.store.saveEvent.bind(f.store);
 f.store.saveEvent=(event,options)=>{f.store.restore({backupPath:f.backup.filePath});return save(event,options);};
 const event=f.event(id);event.payload.rawText=privateText;
 const result=f.runtime.ingest(event);f.store.saveEvent=save;assert.equal(result.queued,true);assert.equal(result.success,false);return event;
}
test('pending event survives reopen, is replayed once and remains queued when replay fails',t=>{
 const f=fixture(t);enqueue(f,'pending-event');assert.equal(f.store.pendingMemoryStatus().pendingCount,1);
 const reopened=new GrowthRuntime({memoryStore:f.store,auditRoot:f.root});
 const save=f.store.saveEvent.bind(f.store);f.store.saveEvent=()=>{throw new Error('synthetic persistence failure');};
 assert.equal(reopened.drainPendingMemory().failed,1);assert.equal(f.store.pendingMemoryStatus().pendingCount,1);
 f.store.saveEvent=save;
 assert.equal(reopened.drainPendingMemory().stored,1);assert.equal(f.store.pendingMemoryStatus().pendingCount,0);
 assert.equal(reopened.drainPendingMemory().stored,0);assert.equal(f.store.allEvents().filter(e=>e.eventId==='pending-event').length,1);
});
test('pending payload is minimized and revoked event is suppressed before replay',t=>{
 const f=fixture(t);enqueue(f,'sensitive-event','password=SYNTHETIC_NEVER_STORE_484');
 const row=f.store.db.prepare('SELECT event_json FROM pending_memory_events').get();assert.equal(row.event_json.includes('SYNTHETIC_NEVER_STORE_484'),false);
 f.store.saveHygieneDecision({decisionId:'revoke-pending',targetType:'memory_event',targetId:'sensitive-event',action:'delete',decidedAt:'2026-10-03T00:00:00Z'});
 assert.equal(f.runtime.drainPendingMemory().suppressed,1);assert.equal(f.store.hasEvent('sensitive-event'),false);
});
test('F server automatically replays retained queue after restart and publishes counts only',async t=>{
 const f=fixture(t);enqueue(f,'automatic-event');
 const server=createGrowthMemoryServer(new GrowthRuntime({memoryStore:f.store,auditRoot:f.root}),{pendingReplayIntervalMs:100});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=`http://127.0.0.1:${server.address().port}`;let status;
 for(let i=0;i<20;i++){status=await (await fetch(`${base}/events/pending`)).json();if(status.pendingCount===0)break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(status.pendingCount,0);assert.equal(JSON.stringify(status).includes('automatic-event'),false);assert.equal(f.store.hasEvent('automatic-event'),true);
});

test('new process drains durable queue with no duplicate stored event',async t=>{
 const f=fixture(t);enqueue(f,'process-retry-event');
 const child=fork(new URL('./fixtures/memory-generation-peer.mjs',import.meta.url),[f.root],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:['ignore','ignore','ignore','ipc']});
 const ready=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});
 try{await ready;const result=await new Promise(resolve=>{child.once('message',resolve);child.send({id:1,action:'drain'});});assert.equal(result.stored,1);assert.equal(f.store.pendingMemoryStatus().pendingCount,0);assert.equal(f.store.allEvents().filter(e=>e.eventId==='process-retry-event').length,1);}
 finally{await new Promise(resolve=>{child.once('exit',resolve);child.send({action:'close'});});}
});
test('queued do-not-remember event omits raw content and retracts earlier scoped task events on replay',t=>{
 const f=fixture(t),save=f.store.saveEvent.bind(f.store);
 f.store.saveEvent=(event,options)=>{f.store.restore({backupPath:f.backup.filePath});return save(event,options);};
 const event=f.event('privacy-pending');event.taskId='baseline';event.eventType='feedback.do_not_remember';event.payload.rawText='SYNTHETIC_FORBIDDEN_RAW_328';event.learningFlags.doNotRemember=true;
 assert.equal(f.runtime.ingest(event).queued,true);f.store.saveEvent=save;
 assert.equal(f.store.db.prepare('SELECT event_json FROM pending_memory_events').get().event_json.includes('SYNTHETIC_FORBIDDEN_RAW_328'),false);
 assert.equal(f.runtime.drainPendingMemory().stored,1);assert.equal(f.store.hasSourceRetraction('baseline'),true);
 assert.equal(f.runtime.ingestor.events.get('baseline').learningFlags.doNotRemember,true);
});
