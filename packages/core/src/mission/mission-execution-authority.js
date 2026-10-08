import { SqliteMissionStore } from './sqlite-mission-store.js';
import { randomUUID } from 'node:crypto';

/** Local Core process authority. Remote device authentication remains a separate boundary. */
export class MissionExecutionAuthority {
  constructor({store,ownerId=`core:${randomUUID()}`,ttlMs=30_000}={}) {
    if (!(store instanceof SqliteMissionStore)) throw new Error('A_CORE_AUTHORITY_SQLITE_REQUIRED');
    if (!Number.isSafeInteger(ttlMs)||ttlMs<30||ttlMs>3_600_000) throw new Error('A_CORE_AUTHORITY_TTL_INVALID');
    this.store=store;this.ownerId=ownerId;this.ttlMs=ttlMs;this.lease=null;this.timer=null;this.recoveryOnly=false;
  }
  activate({expectedToken,heartbeat=true,recoveryOnly=false,serviceId=null}={}) {
    if(this.lease)throw new Error('A_CORE_AUTHORITY_ALREADY_ACTIVATED');
    const lease=this.store.acquireCoreAuthority({ownerId:this.ownerId,expectedToken,ttlMs:this.ttlMs,recoveryOnly,serviceId});
    if(!lease)throw new Error('A_CORE_AUTHORITY_ANOTHER_CORE_ACTIVE');
    this.lease=lease;this.recoveryOnly=recoveryOnly;
    if(heartbeat) {
      this.timer=setInterval(()=>{try{this.renew();}catch{this.stopHeartbeat();}},Math.floor(this.ttlMs/3));
      this.timer.unref?.();
    }
    return {...lease};
  }
  assertActive({allowRecovery=false}={}) {
    if(!this.lease)throw new Error('A_CORE_AUTHORITY_NOT_ACTIVE');
    const active=this.store.assertCoreAuthority(this.lease);
    if(this.recoveryOnly&&allowRecovery!==true)throw new Error('A_CORE_AUTHORITY_RECOVERY_ONLY');
    return active;
  }
  renew() {
    this.assertActive({allowRecovery:true});
    this.lease=this.store.heartbeatLease(this.lease,this.ttlMs);
    return {...this.lease};
  }
  stopHeartbeat(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  release() {
    this.assertActive({allowRecovery:true});this.store.releaseCoreAuthority(this.lease);
    this.stopHeartbeat();this.lease=null;return {released:true};
  }
}
