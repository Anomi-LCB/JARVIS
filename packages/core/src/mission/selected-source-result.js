import {createHash} from 'node:crypto';
import {normalizeSelectedSourceRequest} from '../personal-operations/selected-source-stream.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>hash(canonical(value));
const tool='source.readSelectedInbox';
const fail=code=>{throw new Error(code);};
export function isSelectedSourceObjective(text){
 return typeof text==='string'&&/^선택한\s*(?:연결|계정|메일|대화)(?:의|에서)?\s*(?:저장된?\s*)?자료(?:의)?\s*(?:전체|전부|모두)(?:를|의)?\s*(?:조회(?:해|해줘)|읽어(?:줘)?|목록(?:을)?\s*(?:조회해|보여줘))(?:\s*[.!。])?$/u.test(text.trim());
}
export function captureSelectedSource(objective,selection){
 if(!isSelectedSourceObjective(objective)||!selection||Object.keys(selection).length!==2)fail('A_SELECTED_SOURCE_SELECTION_INVALID');
 const {provider,streamRef}=normalizeSelectedSourceRequest(selection);
 return {version:'selected-source-goal-v1',provider,streamRef,sourceBindingSha256:hash([objective,provider,streamRef])};
}
export function selectedSourceGoalBound(mission){
 const selected=mission.selectedSource;
 return selected?.version==='selected-source-goal-v1'&&isSelectedSourceObjective(mission.objective)
  &&selected.sourceBindingSha256===hash([mission.objective,selected.provider,selected.streamRef])
  &&mission.goalContract?.objective===mission.objective&&!mission.constraints?.length&&!mission.goalContract?.contradictions?.length
  &&!(mission.successCriteria??[]).some(c=>c.statement!==mission.objective)
  &&!mission.goalContract?.revisionChange?.effectConflicts?.length&&!mission.goalContract?.revisionChange?.invalidatedCriterionIds?.length;
}
/** Reconcile every B/G receipt against current independent Core SQL, not previews. */
export function collectSelectedSourceResult(mission,{readTask,readCurrentSnapshot,beforeRead}={}){
 try{
  if(!selectedSourceGoalBound(mission)||typeof readTask!=='function'||typeof readCurrentSnapshot!=='function'||typeof beforeRead!=='function')fail('source-goal-unbound');
  const actions=(mission.waves??[]).flatMap(w=>w.actions??[]);
  if(actions.length>100)fail('source-page-bound-exceeded');
  if(actions.some(a=>a.expectedToolName!==tool||(a.actualToolName&&a.actualToolName!==tool)||a.command!==mission.objective))fail('source-action-outside-goal');
  const pages=[];
  for(const action of actions){
   if(action.status!=='succeeded')continue;
   const dispatch=action.operation?.dispatch,task=readTask(action.taskId),observation=mission.observations.find(o=>o.observationId===action.observationId);
   const receipt=task?.executionResult?.evidence?.adapterEvidence;
   if(action.actualToolName!==tool||dispatch?.toolName!==tool||dispatch.taskId!==action.taskId||task?.status!=='COMPLETED'
    ||task.plan.action.toolName!==tool||observation?.taskId!==task.taskId||observation.actionId!==action.actionId||observation.toolName!==tool
    ||observation.outcome!=='success'||observation.verification?.status!=='passed'||observation.verification.failedCheckIds?.length
    ||!observation.evidenceId||!observation.verification.verificationId||!task.executionVerification?.checks?.some(c=>c.checkId==='selected_source_current_core_verified'&&c.status==='passed')
    ||action.goalRevision!==mission.goalContract.revision||action.authorizationRevision!==mission.authorizationRevision||receipt?.version!=='selected-source-receipt-v1')fail('source-receipt-unbound');
   const normalize=args=>{const {rawText,...rest}=args;return normalizeSelectedSourceRequest(rest);};
   const request=normalize(dispatch.arguments);
   if(request.provider!==mission.selectedSource.provider||request.streamRef!==mission.selectedSource.streamRef
    ||digest(request)!==digest(normalize(task.plan.action.arguments))||digest(request)!==digest(receipt.request)
    ||digest(receipt.snapshot)!==receipt.resultSha256)fail('source-dispatch-mismatch');
   beforeRead(action,task);
   const current=readCurrentSnapshot({...request,expectedRevision:receipt.snapshot.revision});
   if(digest(current)!==receipt.resultSha256)fail('source-current-result-mismatch');
   beforeRead(action,task);pages.push({action,request,snapshot:current});
  }
  pages.sort((a,b)=>a.request.offset-b.request.offset);
  let offset=0,revision,total;const items=[],ids=new Set();
  for(const page of pages){
   const snapshot=page.snapshot;
   revision??=snapshot.revision;total??=snapshot.total;
   if(page.request.offset!==offset||snapshot.revision!==revision||snapshot.total!==total
    ||page.request.offset>0&&page.request.expectedRevision!==revision)fail('source-page-gap-or-revision-mismatch');
   for(const item of snapshot.items){if(ids.has(item.id))fail('source-duplicate-item');ids.add(item.id);items.push(item);}
   offset+=snapshot.items.length;
  }
  const complete=pages.length>0&&offset===total&&pages.at(-1).snapshot.nextOffset===null;
  if(pages.length){const last=pages.at(-1);beforeRead(last.action,readTask(last.action.taskId));readCurrentSnapshot({provider:mission.selectedSource.provider,streamRef:mission.selectedSource.streamRef,limit:1,expectedRevision:revision});beforeRead(last.action,readTask(last.action.taskId));}
  return {passed:complete,status:complete?'passed':'unverified',reasons:complete?[]:['selected-source-pages-incomplete'],
   pages,offset,revision,total,items,evidenceActionIds:pages.map(p=>p.action.actionId),
   checks:complete?[{checkId:'selected_source_entire_snapshot_available',passed:true,evidence:{total,revision,pageCount:pages.length,providerObservationVerified:false}}]:[]};
 }catch{return {passed:false,status:'unverified',reasons:['selected-source-current-result-unavailable'],checks:[],pages:[]};}
}
export function planSelectedSourcePages(mission,dependencies){
 if(!mission.selectedSource)return null;
 const proof=collectSelectedSourceResult(mission,dependencies);
 if(proof.passed)return {decision:'complete',actions:[],criteriaAssessment:mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:proof.evidenceActionIds})),planning:{provider:'local-selected-source',modelRoundTrips:0}};
 if(proof.reasons[0]!=='selected-source-pages-incomplete')return {decision:'pause',reason:proof.reasons[0],actions:[]};
 return {decision:'continue',actions:[{id:'selected-'+proof.offset,command:mission.objective,expectedToolName:tool,
  arguments:{provider:mission.selectedSource.provider,streamRef:mission.selectedSource.streamRef,offset:proof.offset,limit:500,...(proof.revision?{expectedRevision:proof.revision}:{})},
  dependencies:[],requirementIds:mission.goalContract.requirements.map(r=>r.requirementId)}],planning:{provider:'local-selected-source',modelRoundTrips:0}};
}
