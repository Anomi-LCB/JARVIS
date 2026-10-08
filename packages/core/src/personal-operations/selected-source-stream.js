import {createHash} from 'node:crypto';
import {normalizeStrictIsoInstant} from '../../../shared/src/strict-iso-instant.js';
const version='selected-source-stream-v1';
const fail=code=>{throw new Error(code);};
/** A bounded Core-owned SQL snapshot. Execution nodes never open the ledger file. */
export function normalizeSelectedSourceRequest(request){
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['provider','streamRef','offset','limit','expectedRevision'].includes(k))
  ||!['gmail','google-calendar','outlook','teams-chat'].includes(request.provider)||typeof request.streamRef!=='string'||! /^[a-f0-9]{64}$/u.test(request.streamRef))fail('A_SOURCE_STREAM_REQUEST_INVALID');
 const offset=request.offset??0,limit=request.limit??100;
 if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>500)fail('A_SOURCE_STREAM_REQUEST_INVALID');
 if(request.expectedRevision!==undefined&&(typeof request.expectedRevision!=='string'||! /^[a-f0-9]{64}$/u.test(request.expectedRevision)))fail('A_SOURCE_STREAM_REQUEST_INVALID');
 if(offset>0&&request.expectedRevision===undefined)fail('A_SOURCE_STREAM_REVISION_REQUIRED');
 return {provider:request.provider,streamRef:request.streamRef,offset,limit,...(request.expectedRevision===undefined?{}:{expectedRevision:request.expectedRevision})};
}
/** An observed resource identity, never a model-supplied permission assertion. */
export function selectedSourceMandateRef(args){
 if(!args||typeof args!=='object'||Array.isArray(args))fail('A_SOURCE_STREAM_REQUEST_INVALID');
 const {rawText,...request}=args;
 if(rawText!==undefined&&(typeof rawText!=='string'||rawText.length>1000000))fail('A_SOURCE_STREAM_REQUEST_INVALID');
 const selected=normalizeSelectedSourceRequest(request);
 return `source-inbox:${selected.provider}:${selected.streamRef}`;
}
export function readSelectedSourceStream(inbox,request,{checkAuthorized}={}){
 request=normalizeSelectedSourceRequest(request);const {offset,limit}=request;
 const authorize=()=>{if(typeof checkAuthorized!=='function'||checkAuthorized()!==true)fail('A_SOURCE_STREAM_AUTHORITY_DENIED');};
 authorize();const db=inbox.store.db;db.exec('BEGIN');
 try{
  const stream=db.prepare('SELECT cursor,last_hash,provider FROM personal_source_streams WHERE id=?').get(request.streamRef);
  if(!stream)fail('A_SOURCE_STREAM_NOT_FOUND');
  if(stream.provider===null)fail('A_SOURCE_STREAM_PROVENANCE_REQUIRED');
  if(stream.provider!==request.provider)fail('A_SOURCE_STREAM_PROVIDER_MISMATCH');
  const digest=createHash('sha256').update(JSON.stringify([version,request.streamRef,stream]));
  const items=[];let total=0;
  for(const row of db.prepare('SELECT id,provider_id,body,observed_at,withdrawn FROM personal_source_items WHERE stream_id=? ORDER BY id').iterate(request.streamRef)){
   let body;try{body=JSON.parse(row.body);}catch{fail('A_SOURCE_STREAM_RESULT_INVALID');}
   if(!body||Object.keys(body).length!==4||body.provider!==request.provider||typeof body.title!=='string'||body.title.length>2000
    ||(body.start!==null&&typeof body.start!=='string')||!['as-provided','unresolved-local-or-all-day'].includes(body.timeInterpretation)
    ||normalizeStrictIsoInstant(row.observed_at,{requireSeconds:false})===null||![0,1].includes(row.withdrawn))fail('A_SOURCE_STREAM_RESULT_INVALID');
   digest.update('\n'+JSON.stringify(row));
   if(total>=offset&&items.length<limit)items.push({id:row.id,...body,observedAt:row.observed_at,withdrawn:row.withdrawn===1,executionAuthority:false});
   total++;
  }
  const revision=digest.digest('hex');
  if(request.expectedRevision!==undefined&&request.expectedRevision!==revision)fail('A_SOURCE_STREAM_REVISION_CONFLICT');
  authorize();db.exec('COMMIT');
  return {version,provider:request.provider,streamRef:request.streamRef,revision,offset,limit,total,items,
   nextOffset:offset+items.length<total?offset+items.length:null,readOnly:true,containsUntrustedText:true,
   providerObservationVerified:false,executionAuthority:false};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
