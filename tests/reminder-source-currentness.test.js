import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {PersonalOperationsReminderScheduler} from '../packages/core/src/personal-operations/reminder-scheduler.js';
import {CoreFacade} from '../packages/core/src/core-facade.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-reminder-source-'));const path=join(root,'ops.sqlite'),stores=[];
 const open=()=>{const store=new PersonalOperationsStore({dbPath:path,clock:()=>new Date('2026-10-06T00:00:00Z')});stores.push(store);return store;};
 const store=open(),inbox=new PersonalSourceInbox(store);
 const page={provider:'google-calendar',account:'synthetic',scope:'calendar.read',observedAt:'2026-10-04T00:00:00Z',items:[{id:'event',title:'합성 일정',start:'2026-10-06T01:00:00Z'}]};
 inbox.ingest(page);const source=inbox.list()[0];const commitment=inbox.accept({id:source.id,dueAt:page.items[0].start});
 t.after(()=>{for(const s of stores)try{s.close();}catch{}assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 const change=(patch={})=>inbox.ingest({...page,observedAt:'2026-10-05T00:00:00Z',items:[{...page.items[0],...patch}]});
 return {root,store,inbox,source,commitment,page,change,open};
}
for(const patch of [{withdrawn:true},{start:'2026-10-07T01:00:00Z'}])test(`changed accepted source suppresses undelivered reminder ${JSON.stringify(patch)}`,t=>{
 const f=fixture(t);f.store.tick();f.change(patch);const events=[];
 const scheduler=new PersonalOperationsReminderScheduler({store:f.store,onNotification:e=>events.push(e)});
 scheduler.tick();assert.equal(events.length,0);assert.equal(scheduler.deliveredTotal,0);
 assert.equal(f.store.notificationDetail(`personal-reminder:followup:${f.commitment.id}`),null);
});
test('source changes after claim and during async callback cannot be acknowledged',async t=>{
 const f=fixture(t);let finish;const scheduler=new PersonalOperationsReminderScheduler({store:f.store,onNotification:()=>new Promise(resolve=>{finish=resolve;})});
 const running=scheduler.tickAsync();await new Promise(resolve=>setImmediate(resolve));f.change({withdrawn:true});finish();
 const result=await running;assert.equal(result.delivered,0);assert.equal(scheduler.deliveredTotal,0);
 const peer=new PersonalOperationsReminderScheduler({store:f.open(),onNotification:()=>assert.fail('must not replay stale event')});peer.tick();
});
test('missing source and legacy missing baseline never yield reminders',t=>{
 const f=fixture(t);f.store.db.prepare('UPDATE personal_source_items SET accepted_source_hash=NULL').run();
 const scheduler=new PersonalOperationsReminderScheduler({store:f.store,onNotification:()=>assert.fail('unknown baseline')});scheduler.tick();
 f.store.db.prepare('DELETE FROM personal_source_items').run();scheduler.tick();
});
test('unchanged source, replayed empty page and ordinary commitment remain positive controls',t=>{
 const f=fixture(t);f.inbox.ingest({...f.page,observedAt:'2026-10-05T00:00:00Z',items:[]});
 f.store.createCommitment({title:'일반 로컬 약속',dueAt:'2026-10-06T02:00:00Z',sourceRef:'fixture:local'});
 const seen=new Set(),scheduler=new PersonalOperationsReminderScheduler({store:f.store,onNotification:event=>seen.add(event.eventId)});
 assert.equal(scheduler.tick().delivered,2);assert.equal(scheduler.tick().delivered,0);assert.equal(seen.size,2);
});
test('already published stale alert disappears from detail, pagination, unread and read receipts without waiting for next tick',t=>{
 const f=fixture(t),events=[];const scheduler=new PersonalOperationsReminderScheduler({store:f.store,onNotification:e=>events.push(e)});
 scheduler.tick();assert.equal(f.store.listNotifications().unread,1);f.change({withdrawn:true});
 const reopened=f.open();assert.deepEqual(reopened.listNotifications().items,[]);assert.equal(reopened.listNotifications().unread,0);
 assert.equal(reopened.notificationDetail(events[0].eventId),null);assert.equal(reopened.acknowledgeNotification(events[0].eventId).recorded,false);
 scheduler.tick();assert.equal(scheduler.lastTick.sourceSuppressed,1);
 const archived=f.store.db.prepare('SELECT record FROM personal_reminder_archive WHERE event_id=?').get(events[0].eventId);
 assert.equal(JSON.parse(archived.record).suppressionReason,'source-withdrawn');
 assert.equal(f.store.db.prepare('SELECT state FROM personal_commitments WHERE id=?').get(f.commitment.id).state,'open');
});
test('source change between a reserved batch and callback is checked for each item',t=>{
 const f=fixture(t);f.store.tick();const claim=f.store.claimPendingReminders({ownerId:'owned-worker'})[0];
 assert.equal(f.store.reminderClaimCurrent(claim.eventId,'owned-worker',claim.attempts),true);f.change({withdrawn:true});
 assert.equal(f.store.reminderClaimCurrent(claim.eventId,'owned-worker',claim.attempts),false);
 assert.equal(f.store.acknowledgeReminder(claim.eventId,'owned-worker',claim.attempts).acknowledged,false);
});
test('authenticated Core API sees source withdrawal immediately and rejects stale seen/dismiss actions',async t=>{
 const f=fixture(t),core=new CoreFacade({workspaceRoot:f.root}),events=[];
 const scheduler=new PersonalOperationsReminderScheduler({store:f.store,onNotification:e=>events.push(e)});scheduler.tick();
 const server=createCoreServer(core,{personalOperations:{store:f.store},adminToken:'owned-source-test'});
 await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));core.cognition?.close();});
 const base=`http://127.0.0.1:${server.address().port}/personal-operations/notifications`,headers={authorization:'Bearer owned-source-test','content-type':'application/json'};
 assert.equal((await fetch(base,{headers})).status,200);assert.equal((await(await fetch(base,{headers})).json()).unread,1);
 f.change({withdrawn:true});assert.equal((await(await fetch(base,{headers})).json()).unread,0);
 const detail=base+'/'+encodeURIComponent(events[0].eventId);assert.equal((await fetch(detail,{headers})).status,404);
 for(const action of ['seen','dismiss'])assert.equal((await fetch(detail+'/'+action,{method:'POST',headers,body:'{}'})).status,404);
 assert.equal(f.store.db.prepare('SELECT state FROM personal_followups WHERE commitment_id=?').get(f.commitment.id).state,'pending');
});
