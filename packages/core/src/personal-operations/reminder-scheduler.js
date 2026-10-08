import { randomUUID } from 'node:crypto';

/** Delivers durable, at-least-once reminder events; consumers deduplicate by eventId. */
export class PersonalOperationsReminderScheduler {
  constructor({ store, missionRuntime = null, onNotification = () => {}, horizonHours = 24, deliveryTimeoutMs = 10_000, ownerId = `personal-reminder-${randomUUID()}` } = {}) {
    if (!store || typeof store.tick !== 'function' || typeof store.acknowledgeReminder !== 'function') {
      throw new Error('A_PERSONAL_REMINDER_STORE_REQUIRED');
    }
    if (typeof onNotification !== 'function') throw new Error('A_PERSONAL_REMINDER_CALLBACK_INVALID');
    if(!Number.isInteger(deliveryTimeoutMs)||deliveryTimeoutMs<1||deliveryTimeoutMs>25_000)throw new Error('A_PERSONAL_REMINDER_TIMEOUT_INVALID');
    this.deliveryTimeoutMs=deliveryTimeoutMs;
    if (!Number.isInteger(horizonHours) || horizonHours < 0 || horizonHours > 24 * 30) throw new Error('A_PERSONAL_REMINDER_HORIZON_INVALID');
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 100) throw new Error('A_PERSONAL_REMINDER_OWNER_INVALID');
    this.store = store;
    this.missionRuntime = missionRuntime;
    this.onNotification = onNotification;
    this.horizonHours = horizonHours;
    this.ownerId = ownerId;
    this.lastTick = null;
    this.lastError = null;
    this.deliveredTotal = 0;
  }

  tick() {
    const cycle=this.deliveryCycle();let step=cycle.next();
    while(!step.done){
      if(step.value&&typeof step.value.then==='function'){
        // Consume rejection so a misconfigured synchronous caller cannot cause
        // an unhandled rejection, but never acknowledge an unfinished delivery.
        Promise.resolve(step.value).catch(()=>{});
        const error=new Error('Asynchronous delivery requires tickAsync');
        error.code='A_PERSONAL_REMINDER_ASYNC_REQUIRED';
        return cycle.throw(error).value;
      }
      step=cycle.next();
    }
    return step.value;
  }

  async tickAsync() {
    const cycle=this.deliveryCycle({asyncDelivery:true});let step=cycle.next();
    while(!step.done){
      try{await step.value;}
      catch(error){step=cycle.throw(error);continue;}
      step=cycle.next();
    }
    return step.value;
  }

  async deliverAsync(body,beforeDelivery){
    const controller=new AbortController();let timer;
    const timeout=new Promise((resolve,reject)=>{timer=setTimeout(()=>{
      const error=Object.assign(new Error('Reminder delivery timed out'),{code:'A_PERSONAL_REMINDER_DELIVERY_TIMEOUT'});
      controller.abort(error);reject(error);
    },this.deliveryTimeoutMs);});
    try{return await Promise.race([Promise.resolve().then(()=>{
      // Claim checks before this microtask do not fence cancellation, deadline
      // changes or lease replacement scheduled before the actual callback.
      if(!beforeDelivery())return;
      return this.onNotification(body,{signal:controller.signal});
    }),timeout]);}
    finally{clearTimeout(timer);}
  }

  *deliveryCycle({asyncDelivery=false}={}) {
    if (this.missionRuntime && !(this.missionRuntime.missions instanceof Map)) {
      throw new Error('A_PERSONAL_REMINDER_MISSION_SNAPSHOT_UNAVAILABLE');
    }
    const evaluated = this.store.tick({ horizonHours: this.horizonHours });
    let delivered = 0;
    let missionDelivered = 0;
    let missionAlertsCreatedDuringDelivery = 0;
    const claimed = this.store.claimPendingReminders({ ownerId: this.ownerId });
    for (const item of claimed) {
      // Event IDs are stable. If delivery succeeds but acknowledgement is lost,
      // consumers can safely ignore the replay after process restart.
      try {
        if (!this.store.reminderClaimCurrent(item.eventId, this.ownerId, item.attempts)) continue;
        yield asyncDelivery?this.deliverAsync(item.body,()=>this.store.reminderClaimCurrent(item.eventId,this.ownerId,item.attempts)):this.onNotification(item.body);
        const ack = this.store.acknowledgeReminder(item.eventId, this.ownerId, item.attempts);
        if (ack.acknowledged) delivered += 1;
      } catch (error) {
        this.store.releaseReminder(item.eventId, this.ownerId, item.attempts);
        this.lastError = { eventId: item.eventId, code: error?.code ?? 'A_PERSONAL_REMINDER_DELIVERY_FAILED',
          observedAt: new Date().toISOString() };
        throw error;
      }
    }
    const missions = this.missionRuntime?.missions instanceof Map ? [...this.missionRuntime.missions.values()] : [];
    const blockerObservation = this.missionRuntime ? this.store.observeMissionBlockers(missions, {completeSnapshot:true}) : null;
    const missionEvents = this.missionRuntime ? this.store.claimMissionProactiveEvents({ ownerId: this.ownerId }) : [];
    for (const item of missionEvents) {
      try {
        missionAlertsCreatedDuringDelivery += this.refreshMissionObservation(item.missionId).created;
        if (!this.store.missionProactiveClaimCurrent(item.eventId, this.ownerId, item.attempts)) continue;
        yield asyncDelivery?this.deliverAsync(item.body,()=>{
          missionAlertsCreatedDuringDelivery += this.refreshMissionObservation(item.missionId).created;
          return this.store.missionProactiveClaimCurrent(item.eventId,this.ownerId,item.attempts);
        }):this.onNotification(item.body);
        missionAlertsCreatedDuringDelivery += this.refreshMissionObservation(item.missionId).created;
        if (this.store.acknowledgeMissionProactiveEvent(item.eventId, this.ownerId, item.attempts).acknowledged) missionDelivered += 1;
      } catch (error) {
        this.store.releaseMissionProactiveEvent(item.eventId, this.ownerId, item.attempts);
        this.lastError = { eventId: item.eventId, code: error?.code ?? 'A_PERSONAL_REMINDER_DELIVERY_FAILED',
          observedAt: new Date().toISOString() };
        throw error;
      }
    }
    this.lastError = null;
    this.deliveredTotal += delivered;
    this.lastTick = { evaluatedAt: evaluated.evaluatedAt, created: evaluated.created, delivered,
      sourceSuppressed: evaluated.sourceSuppressed??0,
      pending: Math.max(0, (evaluated.pendingReminders?.length ?? 0) - delivered),
      missionStatesObserved: blockerObservation?.observed ?? 0,
      missionAlertsCreated: (blockerObservation?.created ?? 0) + missionAlertsCreatedDuringDelivery,
      missionAlertsCreatedDuringDelivery,
      missionAlertsDelivered: missionDelivered };
    this.deliveredTotal += missionDelivered;
    return { success: true, ...this.lastTick };
  }

  refreshMissionObservation(missionId) {
    if (!(this.missionRuntime?.missions instanceof Map)) throw new Error('A_PERSONAL_REMINDER_MISSION_SNAPSHOT_UNAVAILABLE');
    const mission = this.missionRuntime.missions.get(missionId);
    return this.store.observeMissionBlockers([mission ?? {missionId, status:'UNAVAILABLE'}]);
  }

  status() {
    return { schedulerVersion: 'personal-operations-reminder-v1', enabled: true, horizonHours: this.horizonHours,
      deliveryTimeoutMs:this.deliveryTimeoutMs,
      missionMonitoringEnabled: Boolean(this.missionRuntime), deliveredTotal: this.deliveredTotal, lastTick: this.lastTick, lastError: this.lastError };
  }
}
