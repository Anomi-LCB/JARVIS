import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalOperationsReminderScheduler } from '../packages/core/src/personal-operations/reminder-scheduler.js';
import { CoreWorkerDaemon } from '../packages/core/src/runtime/core-worker-daemon.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-personal-reminder-'));
  const path = join(dir, 'operations.sqlite');
  const now = { value: new Date('2026-09-29T00:00:00.000Z') };
  const stores = [];
  const open = () => {
    const store = new PersonalOperationsStore({ dbPath: path, clock: () => new Date(now.value) });
    stores.push(store);
    return store;
  };
  t.after(() => { for (const store of stores) try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { open, now };
}

test('async reminder failure is not acknowledged and reopens as the same event',async t=>{
 const f=fixture(t),store=f.open();store.createCommitment({title:'synthetic async delivery',dueAt:'2026-09-29T01:00:00Z',sourceRef:'fixture:async'});
 let rejectDelivery;const scheduler=new PersonalOperationsReminderScheduler({store,onNotification:()=>new Promise((resolve,reject)=>{rejectDelivery=reject;})});
 const running=scheduler.tickAsync();await new Promise(resolve=>setImmediate(resolve));assert.equal(scheduler.deliveredTotal,0);
 rejectDelivery(new Error('synthetic async delivery failed'));await assert.rejects(running,/synthetic async delivery failed/);
 assert.equal(scheduler.deliveredTotal,0);store.close();
 const reopened=f.open(),events=[];const recovered=new PersonalOperationsReminderScheduler({store:reopened,onNotification:async event=>{events.push(event);}});
 assert.equal((await recovered.tickAsync()).delivered,1);assert.equal((await recovered.tickAsync()).delivered,0);assert.equal(events.length,1);
});

test('sync reminder path refuses to acknowledge a promise and worker awaits async delivery',async t=>{
 const f=fixture(t),store=f.open();store.createCommitment({title:'synthetic async worker',dueAt:'2026-09-29T01:00:00Z',sourceRef:'fixture:worker'});
 const wrong=new PersonalOperationsReminderScheduler({store,onNotification:async()=>{throw Error('synthetic failure');}});
 assert.throws(()=>wrong.tick(),{code:'A_PERSONAL_REMINDER_ASYNC_REQUIRED'});assert.equal(wrong.deliveredTotal,0);
 let resolveDelivery;const scheduler=new PersonalOperationsReminderScheduler({store,onNotification:()=>new Promise(resolve=>{resolveDelivery=resolve;})});
 const daemon=new CoreWorkerDaemon({worker:{queueStatus:()=>({total:0}),drain:async()=>({processed:0})},personalOperationsScheduler:scheduler,clock:()=>new Date(f.now.value)});
 const running=daemon.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(scheduler.deliveredTotal,0);resolveDelivery();
 const result=await running;assert.equal(result.success,true);assert.equal(scheduler.deliveredTotal,1);
});

test('async mission alert failure retains its event for a second scheduler',async t=>{
 const f=fixture(t),store=f.open(),mission={missionId:'synthetic-async-mission',status:'PAUSED',stopReason:'action-recovery-required',gates:[]};
 const missionRuntime={missions:new Map([[mission.missionId,mission]])},events=[];
 const failing=new PersonalOperationsReminderScheduler({store,missionRuntime,onNotification:async event=>{events.push(event);throw Error('synthetic mission delivery failure');}});
 await assert.rejects(failing.tickAsync(),/synthetic mission delivery failure/);assert.equal(failing.deliveredTotal,0);
 const recovered=new PersonalOperationsReminderScheduler({store,missionRuntime,onNotification:async event=>{events.push(event);}});
 assert.equal((await recovered.tickAsync()).missionAlertsDelivered,1);assert.equal((await recovered.tickAsync()).missionAlertsDelivered,0);
 assert.equal(events.length,2);assert.equal(events[0].eventId,events[1].eventId);
});

test('hung delivery times out, signals cancellation, and stays retryable after late success',async t=>{
 const f=fixture(t),store=f.open();store.createCommitment({title:'synthetic hung reminder',dueAt:'2026-09-29T01:00:00Z',sourceRef:'fixture:timeout'});
 let signal,finish;const scheduler=new PersonalOperationsReminderScheduler({store,deliveryTimeoutMs:15,onNotification:(body,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});}});
 await assert.rejects(scheduler.tickAsync(),{code:'A_PERSONAL_REMINDER_DELIVERY_TIMEOUT'});assert.equal(signal.aborted,true);assert.equal(scheduler.deliveredTotal,0);finish();await new Promise(resolve=>setImmediate(resolve));
 const events=[],peer=new PersonalOperationsReminderScheduler({store,onNotification:async event=>events.push(event)});
 assert.equal((await peer.tickAsync()).delivered,1);assert.equal((await peer.tickAsync()).delivered,0);assert.equal(events.length,1);
 assert.equal(scheduler.status().lastError.code,'A_PERSONAL_REMINDER_DELIVERY_TIMEOUT');
 for(const deliveryTimeoutMs of [0,25001,NaN,1.5])assert.throws(()=>new PersonalOperationsReminderScheduler({store,deliveryTimeoutMs}),/TIMEOUT_INVALID/);
});

test('expired reminder and mission claims cannot acknowledge delivery before a new owner reconciles',t=>{
 const f=fixture(t),store=f.open();store.createCommitment({title:'synthetic expired claim',dueAt:'2026-09-29T01:00:00Z',sourceRef:'fixture:lease'});store.tick();
 store.observeMissionBlockers([{missionId:'synthetic-expired-mission',status:'PAUSED',stopReason:'action-recovery-required',gates:[]}]);
 const reminder=store.claimPendingReminders({ownerId:'old',leaseMs:1000})[0],mission=store.claimMissionProactiveEvents({ownerId:'old',leaseMs:1000})[0];
 f.now.value=new Date(f.now.value.getTime()+1000);
 assert.equal(store.acknowledgeReminder(reminder.eventId,'old',reminder.attempts).acknowledged,false);
 assert.equal(store.acknowledgeMissionProactiveEvent(mission.eventId,'old',mission.attempts).acknowledged,false);
 assert.equal(store.claimPendingReminders({ownerId:'new'})[0].eventId,reminder.eventId);
 assert.equal(store.claimMissionProactiveEvents({ownerId:'new'})[0].eventId,mission.eventId);
 assert.equal(store.acknowledgeReminder(reminder.eventId,'new',reminder.attempts+1).acknowledged,true);
 assert.equal(store.acknowledgeMissionProactiveEvent(mission.eventId,'new',mission.attempts+1).acknowledged,true);
});

test('same owner reacquisition fences stale checks, acknowledgements and releases for both outboxes',t=>{
 const f=fixture(t),store=f.open();store.createCommitment({title:'synthetic owner reuse',dueAt:'2026-09-29T01:00:00Z',sourceRef:'fixture:fence'});store.tick();
 store.observeMissionBlockers([{missionId:'synthetic-fenced-mission',status:'PAUSED',stopReason:'action-recovery-required',gates:[]}]);
 const methods=[['claimPendingReminders','reminderClaimCurrent','acknowledgeReminder','releaseReminder'],['claimMissionProactiveEvents','missionProactiveClaimCurrent','acknowledgeMissionProactiveEvent','releaseMissionProactiveEvent']];
 for(const [claim,current,ack,release] of methods){
  const old=store[claim]({ownerId:'reused',leaseMs:1000})[0];f.now.value=new Date(f.now.value.getTime()+1000);
  const fresh=store[claim]({ownerId:'reused',leaseMs:1000})[0];assert.equal(fresh.eventId,old.eventId);assert.equal(fresh.attempts,old.attempts+1);
  assert.equal(store[current](old.eventId,'reused',old.attempts),false);
  assert.equal(store[ack](old.eventId,'reused',old.attempts).acknowledged,false);
  assert.equal(store[release](old.eventId,'reused',old.attempts).released,false);
  assert.equal(store[current](fresh.eventId,'reused',fresh.attempts),true);
  assert.throws(()=>store[ack](fresh.eventId,'reused'),/claim attempt/);
  assert.equal(store[ack](fresh.eventId,'reused',fresh.attempts).acknowledged,true);
 }
});

test('Core worker emits one durable near-deadline reminder and suppresses unchanged repeated ticks', async t => {
  const f = fixture(t), store = f.open(), events = [];
  const commitment = store.createCommitment({ title: 'synthetic phase deadline', dueAt: '2026-09-29T12:00:00Z', sourceRef: 'fixture:M05' });
  const scheduler = new PersonalOperationsReminderScheduler({ store, onNotification: event => events.push(event) });
  const daemon = new CoreWorkerDaemon({ worker: { queueStatus: () => ({ total: 0 }), drain: async () => ({ processed: 0 }) },
    personalOperationsScheduler: scheduler, clock: () => new Date(f.now.value) });

  const first = await daemon.tick();
  const second = await daemon.tick();
  assert.equal(first.success, true);
  assert.equal(first.daemon.lastDrain.personalOperations.created, 1);
  assert.equal(second.success, true);
  assert.equal(second.daemon.lastDrain.personalOperations.created, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'commitment-due-soon');
  assert.equal(events[0].commitmentId, commitment.id);
  assert.equal(events[0].dueAt, '2026-09-29T12:00:00.000Z');
  assert.equal(events[0].eventId, `personal-reminder:followup:${commitment.id}`);
  assert.equal('title' in events[0], false, 'event payload excludes personal commitment text');
  assert.equal(store.summary().followUps[0].state, 'pending');
  assert.equal(scheduler.status().deliveredTotal, 1);
  const peerEvents = [];
  const peer = new PersonalOperationsReminderScheduler({ store, onNotification: event => peerEvents.push(event) });
  assert.equal(peer.tick().delivered, 0, 'a second scheduler must not redeliver the acknowledged event');
  assert.equal(peerEvents.length, 0);
});

test('failed notification delivery remains in the durable outbox and reuses its id after reopen', t => {
  const f = fixture(t), store = f.open();
  const commitment = store.createCommitment({ title: 'synthetic recoverable reminder', dueAt: '2026-09-29T01:00:00Z', sourceRef: 'fixture:M05' });
  const failing = new PersonalOperationsReminderScheduler({ store, onNotification: () => { throw new Error('synthetic event bus unavailable'); } });
  assert.throws(() => failing.tick(), /synthetic event bus unavailable/u);
  store.close();

  const recoveredStore = f.open(), recoveredEvents = [];
  const recovered = new PersonalOperationsReminderScheduler({ store: recoveredStore, onNotification: event => recoveredEvents.push(event) });
  const result = recovered.tick();
  assert.equal(result.success, true);
  assert.equal(result.delivered, 1);
  assert.equal(recoveredEvents.length, 1);
  assert.equal(recoveredEvents[0].commitmentId, commitment.id);
  assert.equal(recoveredEvents[0].eventId, `personal-reminder:followup:${commitment.id}`);
  assert.equal(recovered.tick().delivered, 0);
  assert.equal(recoveredEvents.length, 1);
});

test('another service cannot claim an event while its delivery lease is live', t => {
  const f = fixture(t), store = f.open(), events = [];
  const commitment = store.createCommitment({ title: 'synthetic cross-service reminder', dueAt: '2026-09-29T01:00:00Z', sourceRef: 'fixture:M05' });
  store.tick();
  const ownerA = store.claimPendingReminders({ ownerId: 'service-a' });
  assert.equal(ownerA.length, 1);
  assert.equal(ownerA[0].body.commitmentId, commitment.id);
  const serviceB = new PersonalOperationsReminderScheduler({ store, ownerId: 'service-b', onNotification: event => events.push(event) });
  assert.equal(serviceB.tick().delivered, 0);
  assert.equal(events.length, 0);
  assert.equal(store.reminderClaimCurrent(ownerA[0].eventId, 'service-a', ownerA[0].attempts), true);
  assert.equal(store.acknowledgeReminder(ownerA[0].eventId, 'service-a', ownerA[0].attempts).acknowledged, true);
  assert.equal(serviceB.tick().delivered, 0);
});

test('Mission blocker notifications fire only on state changes and report recovery without leaking objectives', t => {
  const f = fixture(t), store = f.open(), events = [];
  const mission = { missionId: 'synthetic-mission-1', objective: 'private objective must stay local', status: 'PAUSED',
    stopReason: 'action-recovery-required', gates: [] };
  const scheduler = new PersonalOperationsReminderScheduler({ store,
    missionRuntime: { missions: new Map([[mission.missionId, mission]]) }, onNotification: event => events.push(event) });
  const first = scheduler.tick();
  const repeated = scheduler.tick();
  assert.equal(first.missionAlertsCreated, 1);
  assert.equal(first.missionAlertsDelivered, 1);
  assert.equal(repeated.missionAlertsCreated, 0);
  assert.equal(repeated.missionAlertsDelivered, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'mission-blocked');
  assert.equal(events[0].blockerCode, 'action-recovery-required');
  assert.equal('objective' in events[0], false);

  mission.stopReason = 'capability-unavailable';
  mission.gates = [{ status: 'pending' }];
  assert.equal(scheduler.tick().missionAlertsCreated, 1);
  assert.equal(events.at(-1).kind, 'mission-blocker-changed');
  assert.equal(events.at(-1).blockerCode, 'capability-unavailable');
  assert.equal(events.at(-1).pendingGateCount, 1);

  mission.status = 'COMPLETED';
  mission.stopReason = null;
  mission.gates = [];
  assert.equal(scheduler.tick().missionAlertsCreated, 1);
  assert.equal(events.at(-1).kind, 'mission-blocker-cleared');
  assert.equal(new Set(events.map(event => event.eventId)).size, 3);
  assert.equal(scheduler.status().missionMonitoringEnabled, true);
});

test('resolving a commitment before delivery withdraws its stale reminder event', t => {
  const f = fixture(t), store = f.open(), events = [];
  const commitment = store.createCommitment({ title: 'synthetic resolved deadline', dueAt: '2026-09-29T01:00:00Z', sourceRef: 'fixture:M05' });
  const generated = store.tick();
  assert.equal(generated.pendingReminders.length, 1);
  store.resolveCommitment(commitment.id, 'done');
  const scheduler = new PersonalOperationsReminderScheduler({ store, onNotification: event => events.push(event) });
  assert.equal(scheduler.tick().delivered, 0);
  assert.equal(events.length, 0);
  assert.equal(store.summary().followUps[0].state, 'dismissed');
});

test('authenticated Personal Operations status exposes the active reminder scheduler readiness', async t => {
  const f = fixture(t), store = f.open();
  const scheduler = new PersonalOperationsReminderScheduler({ store });
  const token = 'm05-reminder-status-test-token';
  const server = createCoreServer(new CoreFacade(), { adminToken: token, personalOperations: { store }, personalOperationsScheduler: scheduler });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/personal-operations`,
    { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reminderScheduler.schedulerVersion, 'personal-operations-reminder-v1');
  assert.equal(body.reminderScheduler.enabled, true);
  assert.equal(body.reminderScheduler.horizonHours, 24);
  const anonymous = await fetch(`http://127.0.0.1:${server.address().port}/personal-operations`);
  assert.equal(anonymous.status, 401);
});

test('configured Core service wires due reminders into its real worker and event bus', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-m05-core-service-'));
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env: { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root,
      JARVIS_CORE_ALLOWED_ROOTS: root, JARVIS_CORE_ADMIN_TOKEN: 'm05-core-service-test',
      JARVIS_CORE_WORKER_DAEMON_ENABLED: '1', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
      JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' } });
    assert.equal(runtime.workerDaemon.personalOperationsScheduler, runtime.personalOperationsScheduler);
    const notifications = [];
    const unsubscribe = runtime.coreFacade.eventBus.subscribe('core.personal-operations.notification', event => notifications.push(event.payload));
    t.after(unsubscribe);
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const commitment = runtime.personalOperations.store.createCommitment({ title: 'synthetic Core service reminder', dueAt, sourceRef: 'fixture:M05' });
    const result = await runtime.workerDaemon.tick({ reason: 'm05-product-integration-test' });
    assert.equal(result.success, true);
    assert.equal(result.daemon.lastDrain.personalOperations.created, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].commitmentId, commitment.id);
    assert.equal(notifications[0].kind, 'commitment-due-soon');
  } finally {
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('changed deadline waits for its new horizon, republishes a distinct event after restart and preserves dismissal',async t=>{
 const f=fixture(t),store=f.open(),events=[];
 const c=store.createCommitment({title:'synthetic revised deadline',dueAt:'2026-09-29T01:00:00Z',sourceRef:'fixture:revision-horizon'});
 const first=new PersonalOperationsReminderScheduler({store,onNotification:event=>events.push(event)});first.tick();
 const original=events[0];assert.equal(store.listNotifications().unread,1);store.acknowledgeNotification(original.eventId);
 store.changeDeadline(c.id,{dueAt:'2026-10-02T01:00:00Z',expectedRevision:1,changeId:'deadline-horizon-1'});
 assert.equal(store.listNotifications().items.length,0);store.close();
 const reopened=f.open(),second=new PersonalOperationsReminderScheduler({store:reopened,onNotification:event=>events.push(event)});
 assert.equal(second.tick().delivered,0);f.now.value=new Date('2026-10-01T01:00:00Z');
 const other=f.open(),third=new PersonalOperationsReminderScheduler({store:other,onNotification:event=>events.push(event)});
 const outcomes=await Promise.all([second.tickAsync(),third.tickAsync()]);assert.equal(outcomes.reduce((n,r)=>n+r.delivered,0),1);assert.equal(outcomes.reduce((n,r)=>n+r.created,0),1);
 assert.equal(events.length,2);assert.notEqual(events[1].eventId,original.eventId);assert.equal(events[1].dueAt,'2026-10-02T01:00:00.000Z');assert.equal(events[1].commitmentRevision,2);
 assert.equal(reopened.listNotifications().unread,1);assert.equal(reopened.listNotifications().items[0].seenAt,null);
 assert.equal(second.tick().delivered,0);assert.equal(third.tick().delivered,0);
 reopened.dismissNotification(events[1].eventId);
 reopened.changeDeadline(c.id,{dueAt:'2026-10-01T02:00:00Z',expectedRevision:2,changeId:'deadline-horizon-2'});
 assert.equal(second.tick().delivered,0);assert.equal(reopened.summary().commitments[0].state,'open');
});

test('deadline change during in-flight delivery cannot acknowledge or display the superseded event',async t=>{
 const f=fixture(t),store=f.open();const c=store.createCommitment({title:'synthetic in-flight revision',dueAt:'2026-09-29T01:00:00Z',sourceRef:'fixture:inflight'});
 let finish,event;const scheduler=new PersonalOperationsReminderScheduler({store,onNotification:body=>{event=body;return new Promise(resolve=>{finish=resolve;});}});
 const running=scheduler.tickAsync();await new Promise(resolve=>setImmediate(resolve));
 store.changeDeadline(c.id,{dueAt:'2026-10-05T01:00:00Z',expectedRevision:1,changeId:'deadline-inflight'});finish();
 assert.equal((await running).delivered,0);assert.equal(store.listNotifications().items.length,0);assert.equal(store.notificationDetail(event.eventId),null);
 assert.equal(store.deadlineChangeReceipt('deadline-inflight').revision,2);
});
