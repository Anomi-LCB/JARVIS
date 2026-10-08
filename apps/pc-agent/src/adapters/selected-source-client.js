import {createHash} from 'node:crypto';
import {normalizeSelectedSourceRequest} from '../../../../packages/core/src/personal-operations/selected-source-stream.js';
import {normalizeStrictIsoInstant} from '../../../../packages/shared/src/strict-iso-instant.js';

const fail=code=>{throw new Error(code);};
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const selectedSourceDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** TaskPlanner preserves rawText as context; it is never sent to the Core API. */
export function normalizeSelectedSourceToolRequest(args){
 if(!args||typeof args!=='object'||Array.isArray(args))fail('A_SOURCE_STREAM_REQUEST_INVALID');
 const {rawText,...request}=args;
 if(rawText!==undefined&&(typeof rawText!=='string'||rawText.length>1000000))fail('A_SOURCE_STREAM_REQUEST_INVALID');
 return normalizeSelectedSourceRequest(request);
}

function validateSnapshot(value,request){
 const keys=['version','provider','streamRef','revision','offset','limit','total','items','nextOffset','readOnly','containsUntrustedText','providerObservationVerified','executionAuthority'];
 if(!exact(value,keys)||value.version!=='selected-source-stream-v1'||value.provider!==request.provider||value.streamRef!==request.streamRef||!hex(value.revision)
  ||value.offset!==request.offset||value.limit!==request.limit||!Number.isSafeInteger(value.total)||value.total<0||!Array.isArray(value.items)
  ||value.items.length!==Math.min(request.limit,Math.max(0,value.total-request.offset))||value.readOnly!==true||value.containsUntrustedText!==true
  ||value.providerObservationVerified!==false||value.executionAuthority!==false||request.expectedRevision!==undefined&&value.revision!==request.expectedRevision)fail('A_SOURCE_CLIENT_RESULT_INVALID');
 const next=request.offset+value.items.length<value.total?request.offset+value.items.length:null;
 if(value.nextOffset!==next||new Set(value.items.map(i=>i?.id)).size!==value.items.length)fail('A_SOURCE_CLIENT_RESULT_INVALID');
 for(const item of value.items){
  if(!exact(item,['id','provider','title','start','timeInterpretation','observedAt','withdrawn','executionAuthority'])||!hex(item.id)||item.provider!==request.provider
   ||typeof item.title!=='string'||item.title.length>2000||(item.start!==null&&typeof item.start!=='string')
   ||!['as-provided','unresolved-local-or-all-day'].includes(item.timeInterpretation)||normalizeStrictIsoInstant(item.observedAt,{requireSeconds:false})===null
   ||typeof item.withdrawn!=='boolean'||item.executionAuthority!==false)fail('A_SOURCE_CLIENT_RESULT_INVALID');
 }
 return value;
}

/** Host configuration only. No endpoint or credential is accepted in task arguments. */
export class SelectedSourceClient {
 #endpoint;#tokenProvider;#timeoutMs;
 constructor({baseUrl,tokenProvider,timeoutMs=5000}={}){
  let url;try{url=new URL(baseUrl);}catch{fail('A_SOURCE_CLIENT_CONFIG_INVALID');}
  if(!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
   ||url.username||url.password||url.pathname!=='/'||url.search||url.hash||typeof tokenProvider!=='function'
   ||!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>30000)fail('A_SOURCE_CLIENT_CONFIG_INVALID');
  this.#endpoint=new URL('/personal-inbox/selected-source',url);this.#tokenProvider=tokenProvider;this.#timeoutMs=timeoutMs;
 }
 async read(rawRequest,{checkCurrent,signal}={}){
  const request=normalizeSelectedSourceRequest(rawRequest);
  const check=()=>{if(signal?.aborted||typeof checkCurrent!=='function'||checkCurrent()!==true)fail('A_SOURCE_CLIENT_AUTHORITY_DENIED');};
  const timeout=AbortSignal.timeout(this.#timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  check();let token,onAbort;
  try{token=await Promise.race([Promise.resolve().then(()=>this.#tokenProvider({...request})),new Promise((_,reject)=>{
   onAbort=()=>reject(new Error('cancelled'));if(combined.aborted)onAbort();else combined.addEventListener('abort',onAbort,{once:true});
  })]);}catch{check();fail('A_SOURCE_CLIENT_CREDENTIAL_UNAVAILABLE');}finally{if(onAbort)combined.removeEventListener('abort',onAbort);}check();
  if(typeof token!=='string'||!token||token.length>8192||/[\r\n]/u.test(token))fail('A_SOURCE_CLIENT_CREDENTIAL_UNAVAILABLE');
  let response;
  try{response=await fetch(this.#endpoint,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(request),redirect:'manual',signal:combined});}
  catch{check();fail('A_SOURCE_CLIENT_UNAVAILABLE');}finally{token=undefined;}
  check();
  if(response.status!==200){await response.body?.cancel();fail('A_SOURCE_CLIENT_HTTP_'+response.status);}
  if(!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')){await response.body?.cancel();fail('A_SOURCE_CLIENT_RESULT_INVALID');}
  let bytes=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
  try{for await(const chunk of response.body){check();bytes+=chunk.byteLength;if(bytes>2*1024*1024)fail('A_SOURCE_CLIENT_RESPONSE_TOO_LARGE');text+=decoder.decode(chunk,{stream:true});}text+=decoder.decode();}
  catch(error){check();if(error.message==='A_SOURCE_CLIENT_RESPONSE_TOO_LARGE')throw error;fail('A_SOURCE_CLIENT_UNAVAILABLE');}
  check();let snapshot;try{snapshot=JSON.parse(text);}catch{fail('A_SOURCE_CLIENT_RESULT_INVALID');}
  validateSnapshot(snapshot,request);check();
  return {version:'selected-source-receipt-v1',request,snapshot,resultSha256:selectedSourceDigest(snapshot)};
 }
}

/** Independent synchronous Core-owned oracle, not an adapter self-evaluation. */
export function createSelectedSourceVerifier({readTrustedTask,readCurrentSnapshot}={}){
 if(typeof readTrustedTask!=='function'||typeof readCurrentSnapshot!=='function')fail('G_SOURCE_VERIFIER_UNAVAILABLE');
 return evidence=>{
  try{
   const task=readTrustedTask(evidence?.taskId),action=task?.plan?.action,receipt=evidence?.adapterEvidence;
   const active=t=>['APPROVED','EXECUTING','VERIFYING'].includes(t?.status);
   if(!active(task)||action?.toolName!=='source.readSelectedInbox'||!exact(receipt,['version','request','snapshot','resultSha256'])||receipt.version!=='selected-source-receipt-v1')fail('G_SOURCE_TASK_BINDING_INVALID');
   const request=normalizeSelectedSourceToolRequest(action.arguments);
   if(selectedSourceDigest(request)!==selectedSourceDigest(receipt.request))fail('G_SOURCE_TASK_BINDING_INVALID');
   validateSnapshot(receipt.snapshot,request);
   if(receipt.resultSha256!==selectedSourceDigest(receipt.snapshot))fail('G_SOURCE_RESULT_HASH_INVALID');
   const current=readCurrentSnapshot(request);validateSnapshot(current,request);
   if(selectedSourceDigest(current)!==receipt.resultSha256)fail('G_SOURCE_CURRENT_RESULT_MISMATCH');
   const latest=readTrustedTask(evidence.taskId);
   if(!active(latest)||latest.plan?.action?.toolName!=='source.readSelectedInbox'||selectedSourceDigest(normalizeSelectedSourceToolRequest(latest.plan.action.arguments))!==selectedSourceDigest(request))fail('G_SOURCE_TASK_BINDING_INVALID');
   return {valid:true,reasons:[],proof:'trusted-task-and-independent-core-snapshot',providerObservationVerified:false};
  }catch{return {valid:false,reasons:['selected-source-proof-invalid-or-no-longer-current']};}
 };
}
