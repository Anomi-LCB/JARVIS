import {createHmac,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {digest,normalizeBenchmarkAction} from './browsergym-capability.mjs';
const descriptor=(taskId,request,authorizationHash)=>({operationId:'bg_'+request.requestId,taskId,fingerprint:digest(request),authorizationHash,resourceKey:'browsergym:'+request.episodeId});
const mac=(key,body)=>createHmac('sha256',key).update(JSON.stringify(body)).digest('hex');
const matches=(a,b)=>typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
export function createBrowserGymEffectJournal({store,key,authorize,runStep,readProviderReceipt}){
 if(!store||!Buffer.isBuffer(key)||key.length!==32||typeof authorize!=='function'||typeof runStep!=='function')throw Error('BENCHMARK_JOURNAL_CONFIGURATION');
 return {async execute(value,{taskId,authorizationHash,assertAccess}){
  const request=normalizeBenchmarkAction(value),d=descriptor(taskId,request,authorizationHash);
  const check=()=>{assertAccess();if(authorize(d,request)!==true)throw Error('BENCHMARK_JOURNAL_REVOKED');};
  check();const prior=store.bound(d);
  if(prior){store.assertAuthorization(d);throw Error('BENCHMARK_JOURNAL_EXISTING_EFFECT_REVIEW_REQUIRED');}
  const prepared=store.prepare(d,{ttlMs:30000}),claim=store.claim(d,prepared.ticket,prepared.generation);
  try{
   store.assertFence(claim);check();
   const receipt=await runStep(request);check();store.assertFence(claim);
   if(receipt?.version!=='browsergym-action-receipt-v1'||digest(receipt.request)!==digest(request)||receipt.postState?.episodeId!==request.episodeId||receipt.postState?.revision!==request.expectedRevision+1)throw Error('BENCHMARK_JOURNAL_RECEIPT_INVALID');
   const body={version:'browsergym-historical-effect-v1',binding:d,request,receipt,currentStateVerified:false,executionAuthority:false};
   store.complete(d,{body,signature:mac(key,body)});return receipt;
  }catch(error){store.uncertain(d.operationId);throw error;}
 },async reconcile(value,{taskId,authorizationHash,assertAccess}){
  const request=normalizeBenchmarkAction(value),d=descriptor(taskId,request,authorizationHash);
  const check=()=>{assertAccess();if(authorize(d,request)!==true)throw Error('BENCHMARK_JOURNAL_REVOKED');store.assertAuthorization(d);
   const row=store.bound(d);if(row.resource_key!==d.resourceKey||row.resource_keys_json!==JSON.stringify([d.resourceKey]))throw Error('BENCHMARK_JOURNAL_RESOURCE_CHANGED');};
  check();
  if(store.bound(d)?.state!=='uncertain'||typeof readProviderReceipt!=='function')throw Error('BENCHMARK_JOURNAL_RECOVERY_UNAVAILABLE');
  const result=await readProviderReceipt(request);check();
  if(result?.status!=='matched')return {status:'unresolved',executionAuthority:false};
  const receipt=result.receipt;
  if(receipt?.version!=='browsergym-action-receipt-v1'||digest(receipt.request)!==digest(request)||receipt.postState?.episodeId!==request.episodeId||receipt.postState?.revision!==request.expectedRevision+1)throw Error('BENCHMARK_JOURNAL_RECEIPT_INVALID');
  if(store.bound(d)?.state!=='uncertain')throw Error('BENCHMARK_JOURNAL_RECOVERY_STATE_CHANGED');
  const body={version:'browsergym-historical-effect-v1',binding:d,request,receipt,currentStateVerified:false,executionAuthority:false};
  store.complete(d,{body,signature:mac(key,body)});
  return {status:'historical-matched',receipt,currentStateVerified:false,executionAuthority:false,wholeMissionCompleted:false};
 }};
}
/** Historical lookup is read-only: no recovery writes, table creation or new execution. */
export function inspectBrowserGymEffect({path,key,taskId,request:value,authorizationHash,authorize}){
 let db;
 try{
  const request=normalizeBenchmarkAction(value),d=descriptor(taskId,request,authorizationHash);
  if(!Buffer.isBuffer(key)||key.length!==32||typeof authorize!=='function'||authorize(d,request)!==true)throw Error('ACCESS');
  db=new DatabaseSync(path,{readOnly:true});
  const row=db.prepare('SELECT task_id,fingerprint,authorization_hash,resource_key,resource_keys_json,state,receipt_json FROM remote_operations WHERE operation_id=?').get(d.operationId);
  if(!row||row.task_id!==taskId||row.fingerprint!==d.fingerprint||row.authorization_hash!==authorizationHash||row.resource_key!==d.resourceKey||row.resource_keys_json!==JSON.stringify([d.resourceKey])||row.state!=='succeeded'||!row.receipt_json||Buffer.byteLength(row.receipt_json)>262144)throw Error('BINDING');
  const {body,signature}=JSON.parse(row.receipt_json);
  if(!matches(signature,mac(key,body))||body.version!=='browsergym-historical-effect-v1'||digest(body.binding)!==digest(d)||digest(body.request)!==digest(request)||body.receipt?.version!=='browsergym-action-receipt-v1'||digest(body.receipt?.request)!==digest(request)||body.receipt?.postState?.episodeId!==request.episodeId||body.receipt?.postState?.revision!==request.expectedRevision+1||authorize(d,request)!==true)throw Error('RECEIPT');
  return {status:'historical-matched',receipt:body.receipt,currentStateVerified:false,executionAuthority:false,wholeMissionCompleted:false};
 }catch{return {status:'unresolved',currentStateVerified:false,executionAuthority:false,wholeMissionCompleted:false};}
 finally{db?.close();}
}
