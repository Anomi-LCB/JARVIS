import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname,resolve,basename} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalOperationsReminderScheduler} from '../packages/core/src/personal-operations/reminder-scheduler.js';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-reminder-microtask-')),clock={value:'2026-10-06T00:00:00Z'};
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date(clock.value)});
 t.after(()=>{store.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-reminder-microtask-'));rmSync(root,{recursive:true,force:true});});
 return {store,clock};
}
for(const change of ['cancel','deadline','lease-expired','claim-replaced'])test('does not deliver obsolete reminder at the async scheduling boundary: '+change,async t=>{
 const {store,clock}=fixture(t);const commitment=store.createCommitment({title:'synthetic deadline',dueAt:'2026-10-06T01:00:00Z',sourceRef:'fixture:local'});const deliveries=[];
 const scheduler=new PersonalOperationsReminderScheduler({store,ownerId:'same-owner',onNotification:async body=>{deliveries.push(body);}});
 const pending=scheduler.tickAsync();
 // tickAsync has claimed the event but its Promise callback has not run yet.
 if(change==='cancel')store.resolveCommitment(commitment.id,'cancelled');
 if(change==='deadline')store.changeDeadline(commitment.id,{dueAt:'2026-10-07T02:00:00Z',expectedRevision:1,changeId:'synthetic-change'});
 if(change==='lease-expired'||change==='claim-replaced')clock.value='2026-10-06T00:00:30Z';
 if(change==='claim-replaced')assert.equal(store.claimPendingReminders({ownerId:'same-owner'})[0].attempts,2);
 const result=await pending;assert.equal(deliveries.length,0);assert.equal(result.delivered,0);
});
for(const change of ['resolved','removed','different-blocker'])test('does not deliver obsolete mission blocker at the async scheduling boundary: '+change,async t=>{
 const {store}=fixture(t),mission={missionId:'synthetic-mission',status:'PAUSED',stopReason:'action-recovery-required',gates:[]};
 const missionRuntime={missions:new Map([[mission.missionId,mission]])},deliveries=[];
 const scheduler=new PersonalOperationsReminderScheduler({store,missionRuntime,onNotification:async body=>{deliveries.push(body);}});
 const pending=scheduler.tickAsync();
 if(change==='resolved')mission.status='COMPLETED';if(change==='removed')missionRuntime.missions.delete(mission.missionId);if(change==='different-blocker')mission.stopReason='budget-exhausted';
 const result=await pending;assert.equal(deliveries.length,0);assert.equal(result.missionAlertsDelivered,0);
 if(change==='different-blocker'){
  assert.equal((await scheduler.tickAsync()).missionAlertsDelivered,1);assert.equal(deliveries[0].blockerCode,'budget-exhausted');
  assert.equal((await scheduler.tickAsync()).missionAlertsDelivered,0);
 }
});
test('configured Core event bus and authenticated inbox suppress the obsolete event and persist one current reminder',async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-reminder-microtask-core-'));let runtime,unsubscribe;
 const env={PORT:'0',JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_ALLOWED_ROOTS:root,JARVIS_CORE_ADMIN_TOKEN:'synthetic-microtask-core',JARVIS_CORE_WORKER_DAEMON_ENABLED:'1',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 try{
  runtime=await createConfiguredCoreServiceRuntime({env});await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});
  const base=`http://127.0.0.1:${runtime.server.address().port}`,headers={authorization:'Bearer synthetic-microtask-core'};
  const deliveries=[];unsubscribe=runtime.coreFacade.eventBus.subscribe('core.personal-operations.notification',event=>deliveries.push(event.payload));
  const store=runtime.personalOperations.store,scheduler=runtime.personalOperationsScheduler,dueAt=new Date(Date.now()+3600000).toISOString();
  const cancelled=store.createCommitment({title:'synthetic cancelled reminder',dueAt,sourceRef:'fixture:local'});
  const pending=scheduler.tickAsync();store.resolveCommitment(cancelled.id,'cancelled');assert.equal((await pending).delivered,0);assert.equal(deliveries.length,0);
  let response=await fetch(base+'/personal-operations/notifications',{headers});assert.equal(response.status,200);assert.equal((await response.json()).unread,0);
  const current=store.createCommitment({title:'synthetic current reminder',dueAt,sourceRef:'fixture:local'});assert.equal((await scheduler.tickAsync()).delivered,1);assert.equal((await scheduler.tickAsync()).delivered,0);
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].commitmentId,current.id);
  response=await fetch(base+'/personal-operations/notifications',{headers});const inbox=await response.json();assert.equal(inbox.unread,1);assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].eventId,deliveries[0].eventId);
  const eventId=deliveries[0].eventId;unsubscribe();unsubscribe=null;await runtime.close();runtime=null;
  runtime=await createConfiguredCoreServiceRuntime({env});const restarted=[];unsubscribe=runtime.coreFacade.eventBus.subscribe('core.personal-operations.notification',event=>restarted.push(event.payload));
  assert.equal((await runtime.personalOperationsScheduler.tickAsync()).delivered,0);assert.equal(restarted.length,0);assert.equal(runtime.personalOperations.store.listNotifications().items[0].eventId,eventId);
  console.log(JSON.stringify({configuredCore:true,eventBusDeliveries:1,obsoleteDelivery:0,authenticatedInbox:true,reopenNoReplay:true,externalDelivery:false}));
 }finally{unsubscribe?.();await runtime?.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-reminder-microtask-core-'));rmSync(root,{recursive:true,force:true});}
});
test('unchanged async reminders and mission blockers deliver exactly once',async t=>{
 const {store}=fixture(t);store.createCommitment({title:'synthetic good',dueAt:'2026-10-06T01:00:00Z',sourceRef:'fixture:local'});
 const mission={missionId:'synthetic-good',status:'PAUSED',stopReason:'requires-review',gates:[]},deliveries=[];
 const scheduler=new PersonalOperationsReminderScheduler({store,missionRuntime:{missions:new Map([[mission.missionId,mission]])},onNotification:async body=>deliveries.push(body)});
 const first=await scheduler.tickAsync();assert.equal(first.delivered,1);assert.equal(first.missionAlertsDelivered,1);
 const second=await scheduler.tickAsync();assert.equal(second.delivered+second.missionAlertsDelivered,0);assert.equal(new Set(deliveries.map(x=>x.eventId)).size,2);
});
