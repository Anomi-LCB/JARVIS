import {createHash,randomUUID} from 'node:crypto';
import {snapshotGoogleCollectionPage} from './google-collection-page.js';
import {normalizeStrictIsoInstant} from '../../../shared/src/strict-iso-instant.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const checkpoint=job=>hash([job.binding,job.syncToken,job.cursor,job.initialToken,job.lastObservedAt,job.revision]);
/** One provider page per explicit run. No implicit reset, schedule, grant creation or external write. */
export class GoogleCollectionSync {
 constructor({inbox,client,delegation,budget,control,clock=()=>new Date()}){
  this.inbox=inbox;this.client=client;this.delegation=delegation;this.budget=budget;this.control=control;this.clock=clock;this.owner=randomUUID();
  inbox.store.db.exec(`CREATE TABLE IF NOT EXISTS personal_google_collection_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS personal_google_collection_leases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS personal_google_collection_receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL);`);
  inbox.store.db.exec(`CREATE TABLE IF NOT EXISTS personal_google_collection_transfers(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS personal_google_collection_job_history(id TEXT PRIMARY KEY,body TEXT NOT NULL);`);
  inbox.store.db.exec(`CREATE TABLE IF NOT EXISTS personal_google_collection_resets(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS personal_google_collection_reset_archives(id TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS personal_google_collection_failures(id TEXT PRIMARY KEY,body TEXT NOT NULL);`);
 }
 /** Archive the old observation cache before an explicit full resync. Never call the provider here. */
 reset(raw,{authorize=()=>false}={}){
  const keys=['requestId','provider','expectedMandateId','expectedRevision'];
  if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).length!==keys.length)throw Error('A_GOOGLE_COLLECTION_INPUT_INVALID');
  for(const k of Reflect.ownKeys(raw)){const d=Object.getOwnPropertyDescriptor(raw,k);if(!keys.includes(k)||!d.enumerable||!Object.hasOwn(d,'value'))throw Error('A_GOOGLE_COLLECTION_INPUT_INVALID');}
  const input=Object.freeze(Object.fromEntries(keys.map(k=>[k,raw[k]]))),caller=()=>{if(authorize()!==true)throw Error('A_GOOGLE_COLLECTION_CALLER_DENIED');};
  if(!['gmail','google-calendar'].includes(input.provider)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||[input.requestId,input.expectedMandateId].some(x=>typeof x!=='string'||!x||x.length>128||/[\u0000-\u0020\u007f]/u.test(x)))throw Error('A_GOOGLE_COLLECTION_INPUT_INVALID');
  caller();const db=this.inbox.store.db,requestHash=hash(input);
  return this.budget.transaction(()=>{
   caller();const old=db.prepare('SELECT request_hash,body FROM personal_google_collection_resets WHERE request_id=?').get(input.requestId);
   if(old){if(old.request_hash!==requestHash)throw Error('A_GOOGLE_COLLECTION_CONFLICT');return {...JSON.parse(old.body),replayed:true,currentScopeVerified:false};}
   const binding=this.delegation.active(input.provider),generation=this.control(),id=hash([input.provider,binding.account]);
   if(db.prepare('SELECT 1 FROM personal_google_collection_leases WHERE id=? AND expires>?').get(id,Date.now()))throw Error('A_GOOGLE_COLLECTION_BUSY');
   const row=db.prepare('SELECT body FROM personal_google_collection_jobs WHERE id=?').get(id);if(!row)throw Error('A_GOOGLE_COLLECTION_STATE_MISSING');
   const job=JSON.parse(row.body);
   if(hash(job.binding)!==hash(binding)||job.binding.mandateId!==input.expectedMandateId||job.revision!==input.expectedRevision)throw Error('A_GOOGLE_COLLECTION_CONFLICT');
   if(job.status!=='reset-required'||!job.lastReceiptId||job.revision>=Number.MAX_SAFE_INTEGER)throw Error('A_GOOGLE_COLLECTION_STATE_INVALID');
   const receipt=this.verifyCheckpoint(job),streamRef=receipt.verification.streamRef;
   const expiration=db.prepare("SELECT f.body FROM personal_google_collection_failures f JOIN personal_budget_reservations r ON r.receipt_ref='google-collection-failure:'||f.id WHERE r.state='settled'").all().some(row=>{try{const f=JSON.parse(row.body);return f.jobId===id&&f.code==='A_GOOGLE_COLLECTION_RESET_REQUIRED'&&f.expiredPageHash===hash([job.cycleId,job.syncToken,job.cursor,job.initialToken]);}catch{return false;}});
   if(!expiration)throw Error('A_GOOGLE_COLLECTION_EXPIRATION_UNVERIFIED');
   if(db.prepare("SELECT 1 FROM personal_budget_reservations WHERE mandate_id=? AND state IN ('reserved','in_flight','uncertain')").get(binding.mandateId))throw Error('A_GOOGLE_COLLECTION_UNRESOLVED_PAGE');
   const operationId=hash(['collection-reset',input]),archive={job,stream:db.prepare('SELECT * FROM personal_source_streams WHERE id=?').get(streamRef),pages:db.prepare('SELECT * FROM personal_source_pages WHERE stream_id=?').all(streamRef),items:db.prepare('SELECT * FROM personal_source_items WHERE stream_id=?').all(streamRef)};
   caller();if(this.control()!==generation)throw Error('A_GOOGLE_SYNC_CONTROL_CHANGED');this.delegation.check(binding);
   db.prepare('INSERT INTO personal_google_collection_reset_archives VALUES(?,?)').run(operationId,JSON.stringify(archive));
   const next={...job,cycleId:randomUUID(),mode:'initial',syncToken:null,cursor:null,initialToken:null,lastObservedAt:null,status:'partial',revision:job.revision+1,lastReceiptId:operationId};
   db.prepare('DELETE FROM personal_source_items WHERE stream_id=?').run(streamRef);
   db.prepare('DELETE FROM personal_source_pages WHERE stream_id=?').run(streamRef);
   db.prepare('UPDATE personal_source_streams SET cursor=NULL,last_hash=NULL WHERE id=?').run(streamRef);
   db.prepare('INSERT INTO personal_google_collection_job_history VALUES(?,?)').run(operationId,row.body);
   db.prepare('INSERT INTO personal_google_collection_receipts VALUES(?,?)').run(operationId,JSON.stringify({operationId,checkpointHash:checkpoint(next),verification:{streamRef,batchRef:null},proof:'local-sqlite-collection-reset',providerObservationVerified:false,executionAuthority:false}));
   db.prepare('UPDATE personal_google_collection_jobs SET body=? WHERE id=?').run(JSON.stringify(next),id);
   const result={provider:input.provider,status:'recollection-required',archivedItems:archive.items.length,operationId,revision:next.revision,replayed:false,currentScopeVerified:true,collectionStarted:false,executionAuthority:false};
   db.prepare('INSERT INTO personal_google_collection_resets VALUES(?,?,?)').run(input.requestId,requestHash,JSON.stringify(result));return result;
  });
 }
 verifyCheckpoint(job){
  const db=this.inbox.store.db,saved=db.prepare('SELECT body FROM personal_google_collection_receipts WHERE id=?').get(job.lastReceiptId);let receipt;try{receipt=JSON.parse(saved?.body);}catch{}
  const stream=receipt?.verification?.streamRef?db.prepare('SELECT cursor,last_hash FROM personal_source_streams WHERE id=?').get(receipt.verification.streamRef):null;
  if(!receipt||receipt.operationId!==job.lastReceiptId||receipt.checkpointHash!==checkpoint(job)||!stream||stream.cursor!==job.cursor||stream.last_hash!==receipt.verification.batchRef)throw Error('A_GOOGLE_COLLECTION_CHECKPOINT_UNVERIFIED');
  return receipt;
 }
 status(){
  const db=this.inbox.store.db;let connectionBinding=null;try{connectionBinding=this.delegation.currentBinding();}catch{}
  const providers=this.delegation.status().map(scope=>{
   let validity=null;try{const row=db.prepare('SELECT body FROM personal_mandates WHERE id=?').get(scope.mandateId);const m=JSON.parse(row?.body);validity={validFrom:m.validFrom,expiresAt:m.expiresAt};}catch{}
   const result={...scope,validity,collectionStarted:false,status:scope.status==='scope-ready'?'not-started':scope.status};
   try{
    const binding=this.delegation.active(scope.provider),row=db.prepare('SELECT body FROM personal_google_collection_jobs WHERE id=?').get(hash([scope.provider,binding.account]));if(!row)return result;
    const job=JSON.parse(row.body);if(!Number.isSafeInteger(job.revision)||job.revision<1)throw Error('invalid');
    if(job.lastReceiptId!==null)this.verifyCheckpoint(job);
    else if(job.revision!==1||job.mode!=='initial'||job.syncToken!==null||job.cursor!==null||job.initialToken!==null||job.lastObservedAt!==null)throw Error('invalid');
    const changed=hash(job.binding)!==hash(binding),compatible=['provider','scope','account','connectionId','revision'].every(k=>job.binding[k]===binding[k]);
    return {...result,collectionStarted:job.lastObservedAt!==null,status:changed?'renewal-required':job.status==='partial'&&job.lastObservedAt===null?'not-started':job.status,lastObservedAt:job.lastObservedAt,
     transfer:changed&&compatible&&job.lastReceiptId?{expectedMandateId:job.binding.mandateId,expectedRevision:job.revision}:null,
     reset:!changed&&job.status==='reset-required'&&job.lastReceiptId?{expectedMandateId:job.binding.mandateId,expectedRevision:job.revision}:null};
   }catch{return {...result,status:scope.status==='scope-ready'?'checkpoint-unavailable':result.status};}
  });
  let paused=false;try{this.control();}catch{paused=true;}
  return {adapterAvailable:true,connectionBinding,paused,providers,providerObservationVerified:false,executionAuthority:false};
 }
 /** Explicit same-account/same-credential renewal; never resets tokens or runs a provider read. */
 transfer(raw,{authorize=()=>false}={}){
  const keys=['requestId','provider','expectedMandateId','expectedRevision'];
  if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).length!==keys.length)throw Error('A_GOOGLE_COLLECTION_INPUT_INVALID');
  for(const key of Reflect.ownKeys(raw)){const d=Object.getOwnPropertyDescriptor(raw,key);if(!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))throw Error('A_GOOGLE_COLLECTION_INPUT_INVALID');}
  const input=Object.freeze(Object.fromEntries(keys.map(k=>[k,raw[k]])));
  if(!['gmail','google-calendar'].includes(input.provider)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1
   ||[input.requestId,input.expectedMandateId].some(x=>typeof x!=='string'||!x||x.length>128||/[\u0000-\u0020\u007f]/u.test(x)))throw Error('A_GOOGLE_COLLECTION_INPUT_INVALID');
  const db=this.inbox.store.db,requestHash=hash(input),caller=()=>{if(authorize()!==true)throw Error('A_GOOGLE_COLLECTION_CALLER_DENIED');};caller();
  return this.budget.transaction(()=>{
   caller();const prior=db.prepare('SELECT request_hash,body FROM personal_google_collection_transfers WHERE request_id=?').get(input.requestId);
   if(prior){if(prior.request_hash!==requestHash)throw Error('A_GOOGLE_COLLECTION_CONFLICT');return {...JSON.parse(prior.body),replayed:true,currentScopeVerified:false};}
   const binding=this.delegation.active(input.provider),generation=this.control(),id=hash([input.provider,binding.account]);
   if(db.prepare('SELECT 1 FROM personal_google_collection_leases WHERE id=? AND expires>?').get(id,Date.now()))throw Error('A_GOOGLE_COLLECTION_BUSY');
   const row=db.prepare('SELECT body FROM personal_google_collection_jobs WHERE id=?').get(id);if(!row)throw Error('A_GOOGLE_COLLECTION_STATE_MISSING');
   const job=JSON.parse(row.body);
   if(job.binding?.mandateId!==input.expectedMandateId||job.revision!==input.expectedRevision)throw Error('A_GOOGLE_COLLECTION_CONFLICT');
   if(job.binding.mandateId===binding.mandateId||['provider','scope','account','connectionId','revision'].some(k=>job.binding[k]!==binding[k]))throw Error('A_GOOGLE_COLLECTION_BINDING_CHANGED');
   if(!Number.isSafeInteger(job.revision)||job.revision>=Number.MAX_SAFE_INTEGER||!['partial','complete','reset-required'].includes(job.status)||!job.lastReceiptId)throw Error('A_GOOGLE_COLLECTION_STATE_INVALID');
   const receipt=this.verifyCheckpoint(job);
   if(db.prepare("SELECT 1 FROM personal_budget_reservations WHERE mandate_id=? AND state IN ('reserved','in_flight','uncertain')").get(job.binding.mandateId))throw Error('A_GOOGLE_COLLECTION_UNRESOLVED_PAGE');
   caller();if(this.control()!==generation)throw Error('A_GOOGLE_SYNC_CONTROL_CHANGED');this.delegation.check(binding);
   const operationId=hash(['collection-transfer',input]),next={...job,binding,revision:job.revision+1,lastReceiptId:operationId};
   const result={provider:input.provider,operationId,revision:next.revision,status:job.status,replayed:false,currentScopeVerified:true,collectionStarted:false,executionAuthority:false};
   db.prepare('INSERT INTO personal_google_collection_job_history VALUES(?,?)').run(operationId,row.body);
   db.prepare('INSERT INTO personal_google_collection_receipts VALUES(?,?)').run(operationId,JSON.stringify({...receipt,operationId,checkpointHash:checkpoint(next),proof:'local-sqlite-collection-transfer',previousReceiptId:job.lastReceiptId}));
   db.prepare('UPDATE personal_google_collection_jobs SET body=? WHERE id=?').run(JSON.stringify(next),id);
   db.prepare('DELETE FROM personal_google_collection_leases WHERE id=?').run(id);
   db.prepare('INSERT INTO personal_google_collection_transfers VALUES(?,?,?)').run(input.requestId,requestHash,JSON.stringify(result));
   return result;
  });
 }
 async run(provider,{authorize=()=>false}={}){
  if(authorize()!==true)throw Error('A_GOOGLE_COLLECTION_CALLER_DENIED');
  const binding=this.delegation.active(provider),db=this.inbox.store.db,generation=this.control(),id=hash([provider,binding.account]);
  const assertCurrent=()=>{
   if(authorize()!==true)throw Error('A_GOOGLE_COLLECTION_CALLER_DENIED');
   if(this.control()!==generation)throw Error('A_GOOGLE_SYNC_CONTROL_CHANGED');this.delegation.check(binding);
   if(!db.prepare('SELECT 1 FROM personal_google_collection_leases WHERE id=? AND owner=? AND expires>?').get(id,this.owner,Date.now()))throw Error('A_GOOGLE_LEASE_LOST');
  };
  const locked=db.prepare('INSERT INTO personal_google_collection_leases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE personal_google_collection_leases.expires<?').run(id,this.owner,Date.now()+900000,Date.now());
  if(!locked.changes)throw Error('A_GOOGLE_COLLECTION_BUSY');
  let reservation;
  try{
   assertCurrent();const prior=db.prepare('SELECT body FROM personal_google_collection_jobs WHERE id=?').get(id);let job;
   if(prior){job=JSON.parse(prior.body);if(hash(job.binding)!==hash(binding))throw Error('A_GOOGLE_COLLECTION_BINDING_CHANGED');
    if(job.lastReceiptId!==null){
     this.verifyCheckpoint(job);
    }else if(job.revision!==1||job.mode!=='initial'||job.syncToken!==null||job.cursor!==null||job.initialToken!==null||job.lastObservedAt!==null)throw Error('A_GOOGLE_COLLECTION_CHECKPOINT_UNVERIFIED');
    if(job.status==='reset-required')throw Error('A_GOOGLE_COLLECTION_RESET_REQUIRED');
    if(job.status==='complete')job={...job,cycleId:randomUUID(),mode:'incremental',cursor:null,initialToken:null,status:'partial'};
   }else job={binding,cycleId:randomUUID(),mode:'initial',syncToken:null,cursor:null,initialToken:null,lastObservedAt:null,status:'partial',revision:1,lastReceiptId:null};
   if(!Number.isSafeInteger(job.revision)||job.revision<1||typeof job.cycleId!=='string'||!['partial','complete'].includes(job.status))throw Error('A_GOOGLE_COLLECTION_STATE_INVALID');
   const pageJob=snapshotGoogleCollectionPage({provider,account:binding.account,mode:job.mode,syncToken:job.syncToken,cursor:job.cursor,initialToken:job.initialToken});
   const observedAt=normalizeStrictIsoInstant(this.clock().toISOString());
   if(!observedAt||job.lastObservedAt!==null&&(normalizeStrictIsoInstant(job.lastObservedAt)===null||observedAt<=job.lastObservedAt))throw Error('A_GOOGLE_COLLECTION_CLOCK_NOT_ADVANCED');
   // Persist a stable cycle before dispatch so a lost response retries the same bounded page reservation.
   const body=JSON.stringify(job);db.prepare('INSERT INTO personal_google_collection_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,body);
   const operationId=hash([id,job.cycleId,pageJob]),request=this.delegation.request(provider);
   reservation=this.budget.reserve({mandateId:binding.mandateId,requestId:`google-collection:${operationId}`,request});
   assertCurrent();if(reservation.state==='reserved')reservation=this.budget.begin(reservation.id);
   if(!['in_flight','uncertain'].includes(reservation.state))throw Error('A_GOOGLE_COLLECTION_PAGE_CLOSED');
   const guard=()=>{assertCurrent();if(!['in_flight','uncertain'].includes(this.budget.get(reservation.id).state))throw Error('A_GOOGLE_COLLECTION_PAGE_CLOSED');return true;};
   const result=await this.client.collectionPage(pageJob,{authorize:guard});guard();
   if(!result||Object.getPrototypeOf(result)!==Object.prototype||Object.keys(result).sort().join(',')!=='initialToken,items,nextCursor,nextSyncToken'
    ||result.nextCursor!==null&&result.nextSyncToken!==null||result.nextCursor===null&&result.initialToken!==null)throw Error('A_GOOGLE_COLLECTION_PAGE_INVALID');
   // Result is validated by the provider adapter and again by the next request contract.
   const complete=result.nextCursor===null;
   const next={...job,lastReceiptId:operationId,cursor:result.nextCursor,initialToken:result.initialToken,lastObservedAt:observedAt,status:complete?'complete':'partial',revision:job.revision+1,
    syncToken:complete?result.nextSyncToken:job.syncToken};
   snapshotGoogleCollectionPage({provider,account:binding.account,mode:complete?'incremental':next.mode,syncToken:next.syncToken,cursor:next.cursor,initialToken:next.initialToken});
   const page={provider,account:binding.account,scope:'google-collection-metadata:v1',observedAt,cursor:job.cursor,nextCursor:result.nextCursor,items:result.items};let verification;
   this.inbox.ingest(page,{onCommit:()=>{
    guard();if(db.prepare('SELECT body FROM personal_google_collection_jobs WHERE id=?').get(id)?.body!==body)throw Error('A_GOOGLE_COLLECTION_STATE_CHANGED');
    verification=this.inbox.verifyPage(page);
    const receipt={provider,operationId,observedAt,verification,checkpointHash:checkpoint(next),nextTokenHash:complete?hash(result.nextSyncToken):null,proof:'local-sqlite-collection-page',providerObservationVerified:false,executionAuthority:false};
    db.prepare('INSERT INTO personal_google_collection_receipts VALUES(?,?)').run(operationId,JSON.stringify(receipt));
    if(!db.prepare("UPDATE personal_budget_reservations SET state='settled',actual_minor=0,receipt_ref=?,updated_at=? WHERE id=? AND state IN ('in_flight','uncertain')").run(`google-collection:${operationId}`,this.inbox.store.now(),reservation.id).changes)throw Error('A_GOOGLE_RECEIPT_CONFLICT');
    db.prepare('UPDATE personal_google_collection_jobs SET body=? WHERE id=?').run(JSON.stringify(next),id);
   }});
   return {provider,status:complete?'window-complete':'partial',operationId,observedAt,imported:result.items.length,verification,proof:'local-sqlite-collection-page',providerObservationVerified:false,executionAuthority:false};
  }catch(error){
   if(reservation&&this.budget.get(reservation.id).state==='in_flight')this.budget.uncertain(reservation.id);
   if(error.message==='A_GOOGLE_COLLECTION_RESET_REQUIRED'){
    try{assertCurrent();this.budget.transaction(()=>{
     assertCurrent();const row=db.prepare('SELECT body FROM personal_google_collection_jobs WHERE id=?').get(id);if(!row)throw Error('A_GOOGLE_COLLECTION_STATE_MISSING');
     const job=JSON.parse(row.body);job.status='reset-required';
     if(reservation){const failureId=hash(['collection-expired',reservation.id]);
      db.prepare('INSERT OR IGNORE INTO personal_google_collection_failures VALUES(?,?)').run(failureId,JSON.stringify({reservationId:reservation.id,jobId:id,expiredPageHash:hash([job.cycleId,job.syncToken,job.cursor,job.initialToken]),code:'A_GOOGLE_COLLECTION_RESET_REQUIRED',proof:'trusted-adapter-expired-response',providerChargeVerified:false,ingestionVerified:false}));
      if(!db.prepare("UPDATE personal_budget_reservations SET state='settled',actual_minor=0,receipt_ref=?,updated_at=? WHERE id=? AND state='uncertain'").run(`google-collection-failure:${failureId}`,this.inbox.store.now(),reservation.id).changes)throw Error('A_GOOGLE_RECEIPT_CONFLICT');
     }
     db.prepare('UPDATE personal_google_collection_jobs SET body=? WHERE id=?').run(JSON.stringify(job),id);
    });}catch{}
   }
   throw error;
  }finally{db.prepare('DELETE FROM personal_google_collection_leases WHERE id=? AND owner=?').run(id,this.owner);}
 }
}
