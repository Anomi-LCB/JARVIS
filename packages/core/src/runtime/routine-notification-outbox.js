import {createHash} from 'node:crypto';

function events(routine){
 const result=[];
 const add=(notice,occurrence)=>{if(!notice)return;
  const kind=notice.kind==='routine-dispatch-not-created'?(routine.status==='failed'?'routine-failed':'routine-blocked')
   :notice.kind==='routine-execution-failed'?'routine-failed':notice.kind;
  const body={kind,routineId:routine.routineId,occurrence,
   missionId:Object.hasOwn(notice,'missionId')?notice.missionId:(routine.missionId??null),missionStatus:Object.hasOwn(notice,'missionStatus')?notice.missionStatus:(routine.missionStatus??null)};
  if(notice.code)body.code=/^A_[A-Z0-9_]+$/.test(notice.code)?notice.code:'A_ROUTINE_NOTIFICATION_REVIEW_REQUIRED';
  result.push(body);
 };
 if(routine.lastOccurrence)add(routine.lastOccurrence.notification,routine.lastOccurrence.scheduledAt);
 if(routine.notification&&routine.notification.kind!=='routine-cancelled-by-user'
   &&(!routine.recurrence||routine.status!=='scheduled'||!routine.lastOccurrence))add(routine.notification,routine.scheduledAt);
 if(routine.notification?.kind==='routine-cancelled-by-user')add({kind:'routine-cancelled'},routine.cancelledAt);
 if(routine.missedAt)add({kind:'routine-missed',missionId:null,missionStatus:null},routine.missedOccurrenceAt??routine.scheduledAt);
 return result;
}

export function initializeRoutineNotifications(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS durable_routine_notifications(event_id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',owner TEXT,lease_until TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,error_code TEXT);`);
}

/** Called inside the routine mutation transaction; insertion errors must roll back both records. */
export function journalRoutineNotifications(db,routine,now) {
 const add=db.prepare('INSERT OR IGNORE INTO durable_routine_notifications(event_id,body,created_at) VALUES(?,?,?)');
 for(const body of events(routine)){
  const eventId='routine-notification:'+createHash('sha256').update(JSON.stringify(body)).digest('hex');
  add.run(eventId,JSON.stringify({...body,eventId,deliveryMeaning:'local-notification-published',userReadVerified:false}),now);
 }
}

/** Durable at-least-once local notification delivery; consumers must deduplicate eventId. */
export class RoutineNotificationOutbox {
 constructor({store,onNotification,clock,ownerId,timeoutMs=10000}){
  if(!store?.db||(onNotification!==null&&typeof onNotification!=='function')||typeof clock!=='function'||typeof ownerId!=='string'||!ownerId||ownerId.length>200||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000)throw new Error('A_ROUTINE_NOTIFICATION_CONFIG_INVALID');
  Object.assign(this,{store,db:store.db,onNotification,clock,ownerId,timeoutMs,running:false,lastError:null,delivered:0});
  initializeRoutineNotifications(this.db);
 }
 synchronize(){
  const now=this.clock().toISOString();
  for(const routine of this.store.list())journalRoutineNotifications(this.db,routine,now);
 }
 claim(){
  const now=this.clock().toISOString(),until=new Date(Date.parse(now)+30000).toISOString();
  this.db.exec('BEGIN IMMEDIATE');try{
   const rows=this.db.prepare(`UPDATE durable_routine_notifications SET owner=?,lease_until=?,attempts=attempts+1 WHERE event_id IN(SELECT event_id FROM durable_routine_notifications WHERE state='pending' AND(owner IS NULL OR lease_until<=?) ORDER BY created_at,event_id LIMIT 50) RETURNING *`).all(this.ownerId,until,now);
   this.db.exec('COMMIT');return rows;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async deliver(body){
  const controller=new AbortController();let timer;
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('Routine notification timeout'),{code:'A_ROUTINE_NOTIFICATION_TIMEOUT'}));},this.timeoutMs);});
  try{return await Promise.race([Promise.resolve().then(()=>this.onNotification(body,{signal:controller.signal})),expired]);}
  finally{clearTimeout(timer);}
 }
 async flush(){
  if(this.running)return {skipped:true};this.running=true;
  try{
   this.synchronize();if(!this.onNotification)return {delivered:0,failed:0,reason:'A_ROUTINE_NOTIFICATION_CONSUMER_NOT_CONFIGURED',...this.status()};let delivered=0,failed=0;
   for(const item of this.claim()){
    const current=()=>this.db.prepare("SELECT 1 FROM durable_routine_notifications WHERE event_id=? AND state='pending' AND owner=? AND attempts=? AND lease_until>?").get(item.event_id,this.ownerId,item.attempts,this.clock().toISOString());
    if(!current())continue;
    try{
     await this.deliver(JSON.parse(item.body));
     const ack=this.db.prepare("UPDATE durable_routine_notifications SET state='delivered',owner=NULL,lease_until=NULL,error_code=NULL WHERE event_id=? AND state='pending' AND owner=? AND attempts=? AND lease_until>?").run(item.event_id,this.ownerId,item.attempts,this.clock().toISOString());
     if(ack.changes)delivered++;
    }catch(error){
     const code=/^A_[A-Z0-9_]+$/.test(error?.code)?error.code:'A_ROUTINE_NOTIFICATION_DELIVERY_FAILED';
     this.db.prepare("UPDATE durable_routine_notifications SET owner=NULL,lease_until=NULL,error_code=? WHERE event_id=? AND state='pending' AND owner=? AND attempts=?").run(code,item.event_id,this.ownerId,item.attempts);
     this.lastError={eventId:item.event_id,code};failed++;
    }
   }
   this.delivered+=delivered;if(!failed)this.lastError=null;return {delivered,failed,...this.status()};
  }finally{this.running=false;}
 }
 status(){const row=this.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(state='pending'),0) AS pending,COALESCE(SUM(state='delivered'),0) AS published FROM durable_routine_notifications").get();return {version:'routine-notification-outbox-v1',...row,consumerConfigured:Boolean(this.onNotification),lastError:this.lastError,deliveryGuarantee:'at-least-once-event-id-dedup-required',userReadVerified:false};}
}
