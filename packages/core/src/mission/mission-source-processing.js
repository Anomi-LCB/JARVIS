import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {currentTextFileSnapshot} from './mission-text-summary-coverage.js';
import {verifiedMissionAction} from './mission-requirement-coverage.js';
const version='a-mission-source-processing-v1';
const deliveries=new WeakMap();
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const fail=code=>{throw Object.assign(new Error(code),{code:'A_SOURCE_CHECKPOINT_'+code});};
const goalRevision=mission=>mission.goalContract?.revision??1;
const scope=(mission,roots)=>hash({missionId:mission.missionId,userId:mission.metadata?.userId??'local_user',conversationId:mission.metadata?.conversationId??null,roots});
const key=(ref,sha,owner,revision)=>hash({ref:{rootIndex:ref.rootIndex,relativePath:ref.relativePath},sha,owner,revision});
const pathFor=(ref,roots)=>{
 if(!Number.isInteger(ref?.rootIndex)||ref.rootIndex<0||ref.rootIndex>=roots.length||typeof ref.relativePath!=='string'||isAbsolute(ref.relativePath)||ref.outsideAllowedRoots!==false)return null;
 const path=resolve(roots[ref.rootIndex],ref.relativePath),suffix=relative(roots[ref.rootIndex],path);
 return suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix)?null:path;
};
export function normalizeSourceNotes(value){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>4)return null;
 const fields=['noteKey','sourceObservationId','expectedRevision','throughOffset','draft'];
 if(value.some(n=>!n||typeof n!=='object'||Array.isArray(n)||Object.keys(n).length!==fields.length||Object.keys(n).some(k=>!fields.includes(k))
  ||typeof n.noteKey!=='string'||!/^[A-Za-z0-9_:.-]{1,120}$/u.test(n.noteKey)
  ||typeof n.sourceObservationId!=='string'||!n.sourceObservationId.length||n.sourceObservationId.length>160
  ||!integer(n.expectedRevision)||!integer(n.throughOffset)||typeof n.draft!=='string'||!n.draft.length||n.draft.length>4000))return null;
 if(new Set(value.map(n=>n.noteKey)).size!==value.length)return null;
 return structuredClone(value);
}
export function bindSourcePlanningDelivery(plan,mission,observations){
 const receipts=observations.flatMap(o=>{
  const d=o.evidenceFacts?.textRead;
  if(!d||!['complete','partial'].includes(d.deliveryStatus)||!integer(d.offset)||!integer(d.deliveredChars)
   ||typeof d.content!=='string'||d.content.length!==d.deliveredChars||!/^[a-f0-9]{64}$/u.test(d.sourceSha256??''))return [];
  return [{observationId:o.observationId,sourceSha256:d.sourceSha256,offset:d.offset,throughOffset:d.offset+d.deliveredChars,contentSha256:hash(d.content)}];
 });
 deliveries.set(plan,{missionId:mission.missionId,goalRevision:mission.goalContract?.revision??1,receipts});
}
function checkedBinding(mission,receipt,roots,snapshots=new Map()){
 if(!integer(receipt?.offset)||!integer(receipt?.throughOffset)||receipt.throughOffset<receipt.offset)fail('SOURCE_BINDING_INVALID');
 const observation=(mission.observations??[]).find(o=>o.observationId===receipt.observationId);
 const action=(mission.waves??[]).flatMap(w=>w.actions??[]).find(a=>a.observationId===receipt.observationId);
 if(!action||!verifiedMissionAction(mission,action)||action.actualToolName!=='filesystem.readText'
  ||(action.goalRevision??1)!==goalRevision(mission))fail('READ_EVIDENCE_INVALID');
 const dispatch=action.operation?.dispatch,ref=observation.data?.fileEvidence,capture=observation.data?.textRead;
 const path=pathFor(ref,roots);
 if(!path||dispatch?.taskId!==action.taskId||dispatch.toolName!=='filesystem.readText'||typeof dispatch.arguments?.path!=='string'
  ||resolve(dispatch.arguments.path)!==path||ref.contentSha256!==receipt.sourceSha256
  ||capture?.sourceSha256!==receipt.sourceSha256||capture.offset!==receipt.offset||receipt.throughOffset>capture.nextOffset
  ||hash(capture.content?.slice(0,receipt.throughOffset-receipt.offset)??'')!==receipt.contentSha256)fail('SOURCE_BINDING_INVALID');
 if(!snapshots.has(path))snapshots.set(path,currentTextFileSnapshot(path,roots));
 const current=snapshots.get(path);
 if(!current||current.sha256!==receipt.sourceSha256||current.text.length!==capture.sourceChars||current.bytes!==capture.sourceBytes
  ||hash(current.text.slice(receipt.offset,receipt.throughOffset))!==receipt.contentSha256)fail('SOURCE_CHANGED');
 return {ref:{rootIndex:ref.rootIndex,relativePath:ref.relativePath,outsideAllowedRoots:false},current};
}
function stateFor(mission){
 const state=mission.sourceProcessing??{version,records:{},applied:{}};
 if(state.version!==version||!state.records||typeof state.records!=='object'||Array.isArray(state.records)
  ||!state.applied||typeof state.applied!=='object'||Array.isArray(state.applied)||Object.keys(state.records).length>200||Object.keys(state.applied).length>1000)fail('STATE_INVALID');
 return state;
}
export function prepareSourceNotes({mission,plan,roots,now}){
 const notes=normalizeSourceNotes(plan.sourceNotes);
 if(notes===null)fail('INPUT_INVALID');
 if(!notes.length)return null;
 const delivered=deliveries.get(plan);
 if(delivered?.missionId!==mission.missionId||delivered.goalRevision!==goalRevision(mission))fail('DELIVERY_RECEIPT_MISSING');
 const owner=scope(mission,roots),revision=goalRevision(mission),state=structuredClone(stateFor(mission));
 let changed=false;const snapshots=new Map();
 for(const note of notes){
  const receipt=delivered.receipts.find(r=>r.observationId===note.sourceObservationId&&r.throughOffset===note.throughOffset);
  if(!receipt)fail('RANGE_NOT_DELIVERED');
  const {ref,current}=checkedBinding(mission,receipt,roots,snapshots);
  const id=key(ref,receipt.sourceSha256,owner,revision),requestKey=hash({owner,revision,noteKey:note.noteKey}),requestHash=hash({id,note});
  if(state.applied[requestKey]){if(state.applied[requestKey]!==requestHash)fail('IDEMPOTENCY_CONFLICT');continue;}
  const previous=state.records[id];
  if(note.expectedRevision!==(previous?.revision??0))fail('REVISION_CONFLICT');
  if(receipt.offset>(previous?.deliveredThrough??0)||note.throughOffset<(previous?.deliveredThrough??0))fail('RANGE_GAP');
  if(previous&& (previous.ownerScope!==owner||previous.goalRevision!==revision||previous.sourceSha256!==receipt.sourceSha256))fail('SCOPE_CHANGED');
  const receipts=[...(previous?.receipts??[]),receipt];
  state.records[id]={sourceKey:id,ownerScope:owner,goalRevision:revision,sourceRef:ref,sourceSha256:receipt.sourceSha256,
   sourceChars:current.text.length,sourceBytes:current.bytes,revision:note.expectedRevision+1,deliveredThrough:note.throughOffset,
   draft:note.draft,draftSha256:hash(note.draft),receipts,updatedAt:now,semanticAccuracyVerified:false,executionAuthority:false};
  state.applied[requestKey]=requestHash;changed=true;
 }
 if(Object.keys(state.records).length>200||Object.keys(state.applied).length>1000)fail('STORAGE_BUDGET');
 return changed?state:null;
}
export function sourceProcessingView(mission,roots){
 let state;
 try{state=stateFor(mission);}catch{return {version,records:[],unavailableReason:'invalid-state',semanticAccuracyVerified:false,executionAuthority:false};}
 const owner=scope(mission,roots),revision=goalRevision(mission);
 const all=Object.values(state.records).sort((a,b)=>String(b?.updatedAt??'').localeCompare(String(a?.updatedAt??'')));
 const snapshots=new Map();
 const records=all.slice(0,8).map(record=>{
  if(!record||record.ownerScope!==owner||record.goalRevision!==revision)return {status:'scope-or-goal-changed',sourceKey:/^[a-f0-9]{64}$/u.test(record?.sourceKey??'')?record.sourceKey:null};
  const base={sourceKey:record.sourceKey,sourceRef:record.sourceRef,sourceSha256:record.sourceSha256,revision:record.revision,
   deliveredThrough:record.deliveredThrough,sourceChars:record.sourceChars,updatedAt:record.updatedAt,semanticAccuracyVerified:false,executionAuthority:false};
  try{
   if(!integer(record.revision)||!integer(record.deliveredThrough)||typeof record.draft!=='string'||record.draft.length>4000
    ||hash(record.draft)!==record.draftSha256||!Array.isArray(record.receipts)||!record.receipts.length||record.receipts.length>1000
    ||record.sourceKey!==key(record.sourceRef,record.sourceSha256,owner,revision))fail('STATE_INVALID');
   let through=0;
   for(const receipt of record.receipts){checkedBinding(mission,receipt,roots,snapshots);if(receipt.offset>through||receipt.throughOffset<through)fail('RANGE_GAP');through=receipt.throughOffset;}
   if(through!==record.deliveredThrough)fail('STATE_INVALID');
   return {...base,status:'current-draft',draft:record.draft};
  }catch(error){return {...base,status:'unavailable',reason:error.code??'A_SOURCE_CHECKPOINT_STATE_INVALID'};}
 });
 return {version,totalRecords:all.length,shownRecords:records.length,omittedRecords:Math.max(0,all.length-records.length),records,semanticAccuracyVerified:false,executionAuthority:false};
}
