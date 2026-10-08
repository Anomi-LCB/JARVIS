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

test('runtime retries same event identity and time after generation conflict',t=>{
 const f=fixture(t),save=f.store.saveEvent.bind(f.store),seen=[];let once=true;
 f.store.saveEvent=(event,options)=>{seen.push([event.eventId,event.createdAt]);if(once){once=false;f.store.restore({backupPath:f.backup.filePath});}return save(event,options);};
 const result=f.runtime.ingest(f.event('retry-event'));assert.equal(result.stored,true);assert.equal(result.ingestAttempts,2);
 assert.deepEqual(seen[0],seen[1]);assert.equal(f.store.allEvents().filter(e=>e.eventId==='retry-event').length,1);
});
test('repeated restore conflicts terminate after three attempts and remain explicit failure',t=>{
 const f=fixture(t),save=f.store.saveEvent.bind(f.store);let count=0;
 f.store.saveEvent=(event,options)=>{count++;f.store.restore({backupPath:f.backup.filePath});return save(event,options);};
 const result=f.runtime.ingest(f.event('blocked-event'));assert.equal(result.success,false);assert.equal(result.ingestAttempts,3);assert.equal(result.retryable,true);assert.equal(count,3);
 assert.equal(f.store.hasEvent('blocked-event'),false);assert.equal(f.runtime.ingestor.events.has('blocked-event'),false);
});
test('actual F event HTTP endpoint retries restore conflict through runtime wrapper',async t=>{
 const f=fixture(t),save=f.store.saveEvent.bind(f.store);let once=true;
 f.store.saveEvent=(event,options)=>{if(once){once=false;f.store.restore({backupPath:f.backup.filePath});}return save(event,options);};
 const server=createGrowthMemoryServer(f.runtime);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.event('http-event'))});
 const result=await response.json();assert.equal(result.stored,true);assert.equal(result.ingestAttempts,2);assert.equal(f.store.hasEvent('http-event'),true);
});
test('Core does not verify unpersisted raw event as successful learning and G uses runtime ingestion',()=>{
 let checks=0;
 const core={coreFacade:{workspaceRoot:'synthetic-root'},growthRuntime:{ingest:()=>({success:false,error:{code:'F_MEMORY_GENERATION_CONFLICT'}})},verificationRuntime:{verifyLearning:()=>{checks++;return {status:'passed'};}}};
 const result=CoreOrchestrationWorker.prototype.ingestAndVerifyLearning.call(core,{taskId:'t',request:{userId:'u',metadata:{}}},{memoryEvent:{eventId:'synthetic-event'}});
 assert.equal(result.memoryEvent,null);assert.equal(result.verification.status,'failed');assert.equal(checks,0);
 let routed=0;
 const g={growthRuntime:{ingest:()=>{routed++;return {success:true};},ingestor:{ingest:()=>{throw new Error('must route through wrapper');}}}};
 assert.equal(VerificationRuntime.prototype.emitLearningSignal.call(g,{verificationId:'synthetic-verdict',status:'passed',score:100,checks:[]}).success,true);
 assert.equal(routed,1);
});
