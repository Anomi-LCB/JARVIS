import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalOperationsReminderScheduler} from '../packages/core/src/personal-operations/reminder-scheduler.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-mission-notice-current-')),dbPath=join(root,'ops.sqlite'),stores=[];
 const open=()=>{const store=new PersonalOperationsStore({dbPath});stores.push(store);return store;};
 const store=open(),missions=new Map(['a','b'].map(missionId=>[missionId,{missionId,status:'PAUSED',stopReason:'action-recovery-required',gates:[],objective:'PRIVATE_SYNTHETIC_OBJECTIVE'}]));
 t.after(()=>{for(const store of stores)try{store.close();}catch{}assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 return {store,open,missions,missionRuntime:{missions}};
}

test('a callback resolving the next claimed Mission suppresses its stale blocker before dispatch',async t=>{
 const f=fixture(t),events=[];
 const scheduler=new PersonalOperationsReminderScheduler({...f,onNotification:async event=>{events.push(event);if(event.missionId==='a')f.missions.get('b').status='COMPLETED';}});
 await scheduler.tickAsync();await scheduler.tickAsync();
 assert.deepEqual(events.map(e=>e.missionId),['a']);
 assert.doesNotMatch(JSON.stringify(f.store.listNotifications()),/PRIVATE_SYNTHETIC_OBJECTIVE/);
});

test('Mission resolution during asynchronous delivery cannot acknowledge or replay the obsolete blocker',async t=>{
 const f=fixture(t);f.missions.delete('b');let finish;
 const scheduler=new PersonalOperationsReminderScheduler({...f,onNotification:()=>new Promise(resolve=>{finish=resolve;})});
 const running=scheduler.tickAsync();await new Promise(resolve=>setImmediate(resolve));f.missions.get('a').status='COMPLETED';finish();
 assert.equal((await running).missionAlertsDelivered,0);assert.deepEqual(f.store.listNotifications().items,[]);
 const recovered=new PersonalOperationsReminderScheduler({store:f.open(),missionRuntime:f.missionRuntime,onNotification:()=>assert.fail('obsolete or unseen recovery notice')});
 assert.equal((await recovered.tickAsync()).missionAlertsDelivered,0);
});

test('an unpublished blocker resolved before delivery does not create a meaningless recovery notification',t=>{
 const f=fixture(t);f.store.observeMissionBlockers([...f.missions.values()]);
 for(const mission of f.missions.values())mission.status='COMPLETED';
 assert.equal(f.store.observeMissionBlockers([...f.missions.values()]).created,0);
 assert.deepEqual(f.store.claimMissionProactiveEvents({ownerId:'new'}),[]);
 assert.deepEqual(f.store.listNotifications().items,[]);
});

test('Mission removal during a reserved batch withdraws its notice across restart',async t=>{
 const f=fixture(t),events=[];
 const scheduler=new PersonalOperationsReminderScheduler({...f,onNotification:async event=>{events.push(event);if(event.missionId==='a')f.missions.delete('b');}});
 await scheduler.tickAsync();
 const recovered=new PersonalOperationsReminderScheduler({store:f.open(),missionRuntime:f.missionRuntime,onNotification:async event=>events.push(event)});
 await recovered.tickAsync();assert.deepEqual(events.map(e=>e.missionId),['a']);
 assert.deepEqual(f.store.listNotifications().items.map(e=>e.missionId),['a']);
});

test('a complete current snapshot hides already published notices for removed Missions',t=>{
 const f=fixture(t),events=[];
 const scheduler=new PersonalOperationsReminderScheduler({...f,onNotification:event=>events.push(event)});
 scheduler.tick();assert.equal(f.store.listNotifications().unread,2);
 f.missions.delete('b');scheduler.tick();assert.equal(events.length,2);
 assert.deepEqual(f.store.listNotifications().items.map(e=>e.missionId),['a']);
 const removed=events.find(e=>e.missionId==='b');assert.equal(f.store.acknowledgeNotification(removed.eventId).recorded,false);
 const reopened=f.open();assert.deepEqual(reopened.listNotifications().items.map(e=>e.missionId),['a']);
 f.missions.set('b',{missionId:'b',status:'PAUSED',stopReason:'capability-unavailable',gates:[]});
 const peer=new PersonalOperationsReminderScheduler({store:reopened,missionRuntime:f.missionRuntime,onNotification:event=>events.push(event)});
 peer.tick();peer.tick();assert.equal(events.length,3);assert.notEqual(events[2].eventId,removed.eventId);
});

test('a changed blocker during delivery remains pending under a new ID without acknowledging stale state',async t=>{
 const f=fixture(t);f.missions.delete('b');const events=[];
 const scheduler=new PersonalOperationsReminderScheduler({...f,onNotification:async event=>{events.push(event);if(events.length===1)f.missions.get('a').stopReason='capability-unavailable';}});
 const first=await scheduler.tickAsync();assert.equal(first.missionAlertsDelivered,0);
 assert.equal(first.missionAlertsCreated,2);assert.equal(first.missionAlertsCreatedDuringDelivery,1);
 assert.equal((await scheduler.tickAsync()).missionAlertsDelivered,1);
 assert.equal((await scheduler.tickAsync()).missionAlertsDelivered,0);
 assert.equal(events.length,2);assert.notEqual(events[0].eventId,events[1].eventId);
 assert.equal(events[1].blockerCode,'capability-unavailable');
 assert.deepEqual(f.store.listNotifications().items.map(e=>e.eventId),[events[1].eventId]);
});

test('an unavailable runtime snapshot fails closed without inventing Mission removals',t=>{
 const f=fixture(t);f.store.observeMissionBlockers([...f.missions.values()]);
 const scheduler=new PersonalOperationsReminderScheduler({store:f.store,missionRuntime:{missions:null},onNotification:()=>assert.fail('unknown snapshot')});
 assert.throws(()=>scheduler.tick(),/MISSION_SNAPSHOT_UNAVAILABLE/);
 assert.equal(f.store.claimMissionProactiveEvents({ownerId:'known-owner'}).length,2);
});
