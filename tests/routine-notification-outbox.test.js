import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteDurableRoutineStore} from '../packages/core/src/runtime/durable-routine-store.js';
import {DurableRoutineScheduler} from '../packages/core/src/runtime/durable-routine-scheduler.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-routine-notice-')),dbPath=join(root,'ops.sqlite'),connections=[];let ms=Date.parse('2026-10-06T00:00:00Z');
 const clock=()=>new Date(ms),open=()=>{const ops=new PersonalOperationsStore({dbPath,clock});connections.push(ops);return new SqliteDurableRoutineStore({operationsStore:ops});};
 t.after(()=>{connections.forEach(c=>c.close());assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 let runs=0;const missionRuntime={createMission:()=>({missionId:'synthetic-mission'}),runMission:async()=>{runs++;return {status:'COMPLETED'};}};
 const scheduler=(store,callback,owner='worker',options={})=>new DurableRoutineScheduler({store,clock,ownerId:owner,missionRuntime,onNotification:callback,...options});
 return {root,open,clock,scheduler,missionRuntime,runs:()=>runs,advance:n=>ms+=n};
}
const schedule=s=>s.schedule({routineId:'notice',scheduledAt:'2026-10-06T00:00:00.000Z',missionRequest:{objective:'합성 예약 작업'}});
test('async notification failure stays pending; restart retries same ID without repeating work',async t=>{
 const f=fixture(t),store=f.open(),events=[];
 const s=f.scheduler(store,async e=>{events.push(e);throw Error('PRIVATE_DELIVERY_DETAIL');});schedule(s);await s.tick();
 assert.equal(store.get('notice').status,'completed');assert.equal(s.status().notifications.pending,1);assert.equal(f.runs(),1);
 assert.equal(JSON.stringify(s.status()).includes('PRIVATE_DELIVERY_DETAIL'),false);
 const reopened=f.open(),next=f.scheduler(reopened,async e=>events.push(e),'new-worker');await next.startupReconcile();await next.tick();
 assert.equal(f.runs(),1);assert.equal(events.length,2);assert.equal(events[0].eventId,events[1].eventId);assert.equal(next.status().notifications.pending,0);assert.equal(next.status().notifications.published,1);
});
test('response loss after consumer publication is deduplicated by stable event ID',async t=>{
 const f=fixture(t),seen=new Set();let calls=0;
 const callback=async event=>{calls++;seen.add(event.eventId);if(calls===1)throw Error('response-lost');};
 const s=f.scheduler(f.open(),callback);schedule(s);await s.tick();await s.tick();await s.tick();
 assert.equal(calls,2);assert.equal(seen.size,1);assert.equal(f.runs(),1);assert.equal(s.status().notifications.published,1);
});
test('hung callback times out with cancellation and cannot acknowledge after late success',async t=>{
 const f=fixture(t);let finish,signal;
 const s=f.scheduler(f.open(),(e,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});},'slow',{notificationTimeoutMs:15});
 schedule(s);await s.tick();assert.equal(signal.aborted,true);assert.equal(s.status().notifications.pending,1);finish();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.status().notifications.pending,1);const peer=f.scheduler(f.open(),()=>{},'peer');await peer.tick();assert.equal(peer.status().notifications.published,1);
});
test('two SQLite workers claim one delivery and stale callback cannot acknowledge a reclaimed lease',async t=>{
 const f=fixture(t),store=f.open();const seed=f.scheduler(store,()=>{});schedule(seed);
 const claimed=store.claim('notice',{nowIso:f.clock().toISOString(),ownerId:'seed'});
 store.completeOccurrence('notice',{expectedOwnerId:'seed',expectedAttempts:claimed.attempts,nowIso:f.clock().toISOString(),missionId:'synthetic-mission',missionStatus:'COMPLETED',notification:{kind:'routine-completed',missionId:'synthetic-mission',missionStatus:'COMPLETED'}});
 let finish,calls=0;const old=f.scheduler(store,()=>{calls++;return new Promise(resolve=>{finish=resolve;});},'old');const running=old.notificationOutbox.flush();await new Promise(resolve=>setImmediate(resolve));
 const peer=f.scheduler(f.open(),()=>{calls++;},'peer');await peer.notificationOutbox.flush();assert.equal(calls,1);
 f.advance(31000);await peer.notificationOutbox.flush();assert.equal(calls,2);finish();await running;
 assert.equal(old.status().notifications.published,1);assert.equal(old.notificationOutbox.delivered,0);
});
test('cancel and missed states reconstructed after crash produce one notice each without executing',async t=>{
 const f=fixture(t),events=[],s=f.scheduler(f.open(),e=>events.push(e));schedule(s);s.cancel('notice');
 const next=f.scheduler(f.open(),e=>events.push(e),'restart');await next.startupReconcile();await next.tick();
 assert.equal(events.length,1);assert.equal(events[0].kind,'routine-cancelled');assert.equal(f.runs(),0);
 next.schedule({routineId:'missed',scheduledAt:'2026-10-05T00:00:00.000Z',missionRequest:{objective:'합성 놓친 예약'}});await next.startupReconcile();await next.startupReconcile();
 assert.equal(events.filter(e=>e.kind==='routine-missed').length,1);assert.equal(f.runs(),0);
});
test('actual Core E B G scheduled read remains complete when notice fails and is retried after reopening SQLite',async t=>{
 const f=fixture(t),store=f.open(),env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'};
 const runtime=createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'ag'),cwd:()=>f.root,env,taskEnv:env,clock:f.clock,workerDaemonEnabled:false});
 t.after(()=>runtime.coreFacade.cognition?.close());let calls=0;const notices=[];
 const original=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=(...args)=>{calls++;return original(...args);};
 const s=new DurableRoutineScheduler({store,clock:f.clock,ownerId:'actual',missionRuntime:runtime.missionRuntime,onNotification:async event=>{notices.push(event);throw Error('isolated delivery failure');}});
 s.schedule({routineId:'actual-read',scheduledAt:f.clock().toISOString(),missionRequest:{objective:'작업 폴더 파일 목록 보여줘',successCriteria:['파일 목록을 검증한다'],authorization:{grants:['read_only']}}});
 await s.tick();assert.equal(calls,1);assert.equal(store.get('actual-read').status,'completed');assert.equal(s.status().notifications.pending,1);
 const mission=runtime.missionRuntime.getMission(store.get('actual-read').missionId);assert.equal(mission.status,'COMPLETED');assert.equal(mission.metrics.successfulActions,1);
 const reopened=new DurableRoutineScheduler({store:f.open(),clock:f.clock,ownerId:'actual-new',missionRuntime:runtime.missionRuntime,onNotification:event=>notices.push(event)});
 await reopened.startupReconcile();await reopened.tick();assert.equal(calls,1);assert.equal(notices.length,2);assert.equal(notices[0].eventId,notices[1].eventId);assert.equal(reopened.status().notifications.published,1);
});
test('unconfigured consumer preserves pending notices rather than claiming delivery',async t=>{
 const f=fixture(t),store=f.open();const s=new DurableRoutineScheduler({store,clock:f.clock,missionRuntime:f.missionRuntime});schedule(s);await s.tick();
 assert.equal(s.status().notifications.consumerConfigured,false);assert.equal(s.status().notifications.pending,1);assert.equal(s.status().notifications.published,0);
 const events=[],peer=f.scheduler(f.open(),e=>events.push(e),'connected');await peer.startupReconcile();assert.equal(events.length,1);assert.equal(peer.status().notifications.published,1);
});

test('weekly results are journaled before another occurrence overwrites the latest state',async t=>{
 const f=fixture(t),store=f.open(),s=f.scheduler(store,null);
 s.schedule({routineId:'weekly-journal',scheduledAt:f.clock().toISOString(),recurrence:{frequency:'weekly',weekday:2,hour:9,minute:0},timeZone:'Asia/Seoul',missionRequest:{objective:'합성 주간 점검'}});
 for(let i=0;i<3;i++){
  const item=store.get('weekly-journal');f.advance(Date.parse(item.scheduledAt)-f.clock().getTime());
  const claim=store.claim(item.routineId,{nowIso:f.clock().toISOString(),ownerId:'worker'});
  store.completeOccurrence(item.routineId,{expectedOwnerId:'worker',expectedAttempts:claim.attempts,nowIso:f.clock().toISOString(),missionId:'weekly-'+i,missionStatus:'COMPLETED',notification:{kind:'routine-completed',missionId:'weekly-'+i,missionStatus:'COMPLETED'}});
 }
 const events=[],peer=f.scheduler(f.open(),e=>events.push(e),'restart');await peer.notificationOutbox.flush();
 assert.equal(events.length,3);assert.equal(new Set(events.map(e=>e.occurrence)).size,3);assert.deepEqual(events.map(e=>e.missionId).sort(),['weekly-0','weekly-1','weekly-2']);
 await peer.notificationOutbox.flush();assert.equal(events.length,3);assert.equal(f.runs(),0);
});
test('outbox insert failure rolls back the routine result; retry commits both records',t=>{
 const f=fixture(t),store=f.open(),s=f.scheduler(store,null);schedule(s);
 const claim=store.claim('notice',{nowIso:f.clock().toISOString(),ownerId:'worker'});
 store.db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON durable_routine_notifications BEGIN SELECT RAISE(ABORT,'injected-notice-storage-failure'); END");
 const complete=()=>store.completeOccurrence('notice',{expectedOwnerId:'worker',expectedAttempts:claim.attempts,nowIso:f.clock().toISOString(),missionId:'atomic-mission',missionStatus:'COMPLETED',notification:{kind:'routine-completed'}});
 assert.throws(complete,/injected-notice-storage-failure/);assert.equal(store.get('notice').status,'dispatching');assert.equal(s.status().notifications.total,0);
 store.db.exec('DROP TRIGGER reject_notice');complete();assert.equal(store.get('notice').status,'completed');assert.equal(s.status().notifications.pending,1);
});

test('multiple missed weekly occurrences survive without delivery and do not inherit later Mission IDs',async t=>{
 const f=fixture(t),store=f.open(),s=f.scheduler(store,null);
 s.schedule({routineId:'missed-weekly',scheduledAt:f.clock().toISOString(),recurrence:{frequency:'weekly',weekday:2,hour:9,minute:0},timeZone:'Asia/Seoul',missionRequest:{objective:'합성 주간 점검'}});
 for(let i=0;i<2;i++){
  f.advance(8*86400000);store.markOverdueMissed(f.clock().toISOString(),f.clock().toISOString());
 }
 const item=store.get('missed-weekly');f.advance(Date.parse(item.scheduledAt)-f.clock().getTime());
 const claim=store.claim(item.routineId,{nowIso:f.clock().toISOString(),ownerId:'worker'});
 store.transitionDispatch(item.routineId,{expectedOwnerId:'worker',expectedAttempts:claim.attempts,status:'dispatching',patch:{missionId:'later-mission',missionStatus:'RUNNING'}});
 const events=[],peer=f.scheduler(f.open(),e=>events.push(e),'consumer');await peer.notificationOutbox.flush();
 assert.equal(events.length,2);assert.ok(events.every(e=>e.kind==='routine-missed'&&e.missionId===null));assert.equal(new Set(events.map(e=>e.occurrence)).size,2);
});
test('cancel and missed mutations roll back if notification persistence fails',t=>{
 const f=fixture(t),store=f.open(),s=f.scheduler(store,null);schedule(s);
 store.db.exec("CREATE TRIGGER reject_atomic_notice BEFORE INSERT ON durable_routine_notifications BEGIN SELECT RAISE(ABORT,'injected-atomic-error'); END");
 assert.throws(()=>s.cancel('notice'),/injected-atomic-error/);assert.equal(store.get('notice').status,'scheduled');
 f.advance(86400000);assert.throws(()=>store.markOverdueMissed(f.clock().toISOString(),f.clock().toISOString()),/injected-atomic-error/);assert.equal(store.get('notice').status,'scheduled');assert.equal(s.status().notifications.total,0);
 store.db.exec('DROP TRIGGER reject_atomic_notice');assert.equal(s.cancel('notice').cancelled,true);assert.equal(s.status().notifications.pending,1);
});
