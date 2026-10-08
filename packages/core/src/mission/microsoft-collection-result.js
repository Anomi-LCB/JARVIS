import {createHash} from 'node:crypto';
import {normalizeMicrosoftCollection} from '../personal-operations/microsoft-collection-request.js';
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const tool='source.collectMicrosoftMetadata';
const objectiveValid=s=>typeof s==='string'&&/^선택한\s*(?:Microsoft|마이크로소프트)\s*연결(?:의|에서)?\s*메타데이터(?:를)?\s*한\s*페이지\s*수집(?:해|해줘)(?:\s*[.!。])?$/u.test(s.trim());
const allObjectiveValid=s=>typeof s==='string'&&/^선택한\s*(?:Microsoft|마이크로소프트)\s*연결(?:의|에서)?\s*메타데이터(?:를)?\s*전체\s*페이지\s*수집(?:해|해줘)(?:\s*[.!。])?$/u.test(s.trim());
export function captureMicrosoftCollection(objective,selection){
 if(allObjectiveValid(objective)){
  if(!selection||![Object.prototype,null].includes(Object.getPrototypeOf(selection)))throw Error('A_MICROSOFT_COLLECTION_GOAL_INVALID');
  const copy=Object.create(null);let maxPages=20;
  for(const key of Reflect.ownKeys(selection)){const d=Object.getOwnPropertyDescriptor(selection,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw Error('A_MICROSOFT_COLLECTION_GOAL_INVALID');if(key==='maxPages')maxPages=d.value;else copy[key]=d.value;}
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100)throw Error('A_MICROSOFT_COLLECTION_GOAL_INVALID');
  const request=normalizeMicrosoftCollection(copy);if(request.cursor!=null)throw Error('A_MICROSOFT_COLLECTION_GOAL_INVALID');
  return {version:'microsoft-collection-pages-goal-v1',request,maxPages,goalDigest:digest({objective,request,maxPages})};
 }
 if(!objectiveValid(objective))throw Error('A_MICROSOFT_COLLECTION_GOAL_INVALID');
 const request=normalizeMicrosoftCollection(selection);
 return {version:'microsoft-collection-goal-v1',request,goalDigest:digest({objective,request})};
}
export function microsoftCollectionGoalBound(m){const c=m.microsoftCollection;return (c?.version==='microsoft-collection-goal-v1'&&objectiveValid(m.objective)&&c.goalDigest===digest({objective:m.objective,request:c.request})
 ||c?.version==='microsoft-collection-pages-goal-v1'&&allObjectiveValid(m.objective)&&Number.isSafeInteger(c.maxPages)&&c.maxPages>=1&&c.maxPages<=100&&c.request.cursor==null&&c.goalDigest===digest({objective:m.objective,request:c.request,maxPages:c.maxPages}))&&m.goalContract?.objective===m.objective
 &&!m.constraints?.length&&!m.goalContract?.contradictions?.length&&!m.goalContract?.revisionChange?.effectConflicts?.length&&!m.goalContract?.revisionChange?.invalidatedCriterionIds?.length
 &&!(m.successCriteria??[]).some(c=>c.statement!==m.objective||c.verificationSpec);}
export function microsoftCollectionPageLimit(m,resolvePageLimit){
 const n=m.microsoftCollection?.maxPages;
 if(!m.microsoftCollectionLimitExtensions?.length)return n;
 if(typeof resolvePageLimit!=='function')throw Error('A_MICROSOFT_LIMIT_PROOF_REQUIRED');
 return resolvePageLimit(m);
}
export function collectMicrosoftCollectionResult(m,{readTask,readCommittedReceipt,beforeRead,verifyCollectionPages,resolvePageLimit}={}, {allowPartial=false,historicalTail=false}={}){
 try{
  if(!microsoftCollectionGoalBound(m)||typeof readTask!=='function'||typeof readCommittedReceipt!=='function'||typeof beforeRead!=='function')throw Error();
  const actions=m.waves.flatMap(w=>w.actions);if(!actions.length)return {passed:false,reasons:['microsoft-collection-incomplete'],checks:[]};
  const multiple=m.microsoftCollection.version==='microsoft-collection-pages-goal-v1';
  const maxPages=multiple?microsoftCollectionPageLimit(m,resolvePageLimit):1;
  if(actions.length>maxPages)throw Error();
  const receipts=[],ids=new Set(),cursors=new Set();let cursor=m.microsoftCollection.request.cursor??null;
  for(const [index,a] of actions.entries()){
  const task=readTask(a.taskId),d=a.operation?.dispatch,r=task?.executionResult?.evidence?.adapterEvidence,o=m.observations.find(o=>o.observationId===a.observationId);
  if(a.status!=='succeeded'||a.expectedToolName!==tool||a.actualToolName!==tool||a.command!==m.objective||a.goalRevision!==m.goalContract.revision||a.authorizationRevision!==m.authorizationRevision
   ||task?.status!=='COMPLETED'||task.plan?.action?.toolName!==tool||d?.toolName!==tool||d.taskId!==a.taskId||r?.version!=='microsoft-collection-receipt-v1'
   ||o?.taskId!==a.taskId||o.actionId!==a.actionId||o.toolName!==tool||o.outcome!=='success'||o.verification?.status!=='passed'||o.verification.failedCheckIds?.length||!o.evidenceId
   ||task.executionVerification?.status!=='passed'||task.executionVerification.taskId!==task.taskId||!task.executionVerification.verificationId||task.executionVerification.verificationId!==o.verification.verificationId
   ||task.executionVerification.checks?.some(c=>c.status==='failed')||!task.executionVerification.checks?.some(c=>c.checkId==='microsoft_collection_current_sql_verified'&&c.status==='passed'))throw Error();
  const request=normalizeMicrosoftCollection(d.arguments);
  const expected={...m.microsoftCollection.request,...(multiple?{cursor}: {})};
  if(multiple&&(cursors.has(cursor)||index>0&&cursor===null))throw Error();cursors.add(cursor);
  if([expected,normalizeMicrosoftCollection(task.plan.action.arguments),r.request].some(v=>digest(v)!==digest(request)))throw Error();
  beforeRead(a,task);const current=readCommittedReceipt(task.taskId,request,{historical:multiple&&(index<actions.length-1||historicalTail)});if(digest(current)!==digest(r))throw Error();beforeRead(a,readTask(a.taskId));
  if(multiple){if(current.page.cursor!==cursor||current.page.items.some(item=>ids.has(item.id))||current.page.nextCursor!==null&&cursors.has(current.page.nextCursor))throw Error();for(const item of current.page.items)ids.add(item.id);cursor=current.page.nextCursor;}
  receipts.push(current);
  }
  if(multiple){
   if(typeof verifyCollectionPages!=='function')throw Error();
   for(const a of actions)beforeRead(a,readTask(a.taskId));
   const verification=verifyCollectionPages(receipts.map(r=>r.page));
   for(const a of actions)beforeRead(a,readTask(a.taskId));
   if(verification.status!=='passed')throw Error();
   const complete=cursor===null;
   return {passed:complete||allowPartial,complete,reasons:complete?[]:[actions.length>=maxPages?'microsoft-collection-page-limit':'microsoft-collection-incomplete'],
    nextCursor:cursor,actionReceipts:receipts,evidenceActionIds:actions.map(a=>a.actionId),
    receipt:{version:'microsoft-collection-pages-receipt-v1',request:m.microsoftCollection.request,pages:receipts,verification,snapshotVerified:false,maxPages},
    checks:[{checkId:'microsoft_collection_mission_current_commit',passed:complete,evidence:{metadataOnly:true,pageCount:receipts.length,allPages:complete,snapshotVerified:false}}]};
  }
  return {passed:true,reasons:[],receipt:receipts[0],actionReceipts:receipts,evidenceActionIds:[actions[0].actionId],checks:[{checkId:'microsoft_collection_mission_current_commit',passed:true,evidence:{metadataOnly:true,pageCount:1,allPages:false}}]};
 }catch{return {passed:false,reasons:['microsoft-collection-current-result-unavailable'],checks:[]};}
}
export function planMicrosoftCollection(m,deps){
 if(!m.microsoftCollection)return null;const proof=collectMicrosoftCollectionResult(m,deps);
 if(proof.passed)return {decision:'complete',actions:[],criteriaAssessment:m.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:proof.evidenceActionIds})),planning:{provider:'local-microsoft-collection',modelRoundTrips:0}};
 if(proof.reasons[0]!=='microsoft-collection-incomplete')return {decision:'pause',pauseReason:proof.reasons[0],actions:[],planning:{provider:'local-microsoft-collection',retryable:false}};
 return {decision:'continue',actions:[{id:'microsoft-page',command:m.objective,expectedToolName:tool,arguments:m.microsoftCollection.version==='microsoft-collection-pages-goal-v1'?{...m.microsoftCollection.request,cursor:proof.nextCursor??null}:m.microsoftCollection.request,dependencies:[],requirementIds:m.goalContract.requirements.map(r=>r.requirementId)}],planning:{provider:'local-microsoft-collection',modelRoundTrips:0}};
}
