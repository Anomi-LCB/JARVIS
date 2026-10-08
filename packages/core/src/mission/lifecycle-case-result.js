import {normalizeLifecycleCaseRead,lifecycleCaseDigest as digest,validateLifecycleCaseSnapshot} from '../personal-operations/lifecycle-case-read.js';
const tool='case.readLocalRecord';
const objectiveValid=text=>typeof text==='string'&&/^선택한\s*(?:생활\s*)?업무(?:의)?\s*로컬\s*기록(?:과\s*마감)?(?:을)?\s*(?:조회해(?:줘)?|읽어줘|확인해(?:줘)?)[.!。]?$/u.test(text.trim());
export function captureLifecycleCase(objective,selection){
 if(!objectiveValid(objective)||!selection||Object.keys(selection).length!==3)throw Error('A_LIFECYCLE_CASE_SELECTION_INVALID');
 const request=normalizeLifecycleCaseRead(selection);return {version:'lifecycle-case-goal-v1',request,goalDigest:digest({objective,request})};
}
export function lifecycleCaseGoalBound(mission){const selected=mission.lifecycleCase;return selected?.version==='lifecycle-case-goal-v1'&&objectiveValid(mission.objective)
 &&selected.goalDigest===digest({objective:mission.objective,request:selected.request})&&mission.goalContract?.objective===mission.objective
 &&!mission.constraints?.length&&!mission.goalContract?.contradictions?.length&&!mission.goalContract?.revisionChange?.effectConflicts?.length&&!mission.goalContract?.revisionChange?.invalidatedCriterionIds?.length
 &&!(mission.successCriteria??[]).some(c=>c.statement!==mission.objective||c.verificationSpec);}
export function collectLifecycleCaseResult(mission,{readTask,readCurrentSnapshot,beforeRead}={}){
 try{
  if(!lifecycleCaseGoalBound(mission)||typeof readTask!=='function'||typeof readCurrentSnapshot!=='function'||typeof beforeRead!=='function')throw Error('case-goal-unbound');
  const actions=mission.waves.flatMap(w=>w.actions);if(!actions.length)return {passed:false,status:'unverified',reasons:['lifecycle-case-read-incomplete'],checks:[]};
  if(actions.length!==1)throw Error('case-action-count');const action=actions[0];
  if(action.status!=='succeeded'||action.expectedToolName!==tool||action.actualToolName!==tool||action.command!==mission.objective||action.goalRevision!==mission.goalContract.revision||action.authorizationRevision!==mission.authorizationRevision)throw Error('case-action-binding');
  const task=readTask(action.taskId),dispatch=action.operation?.dispatch,receipt=task?.executionResult?.evidence?.adapterEvidence,observation=mission.observations.find(o=>o.observationId===action.observationId);
  if(task?.status!=='COMPLETED'||task.plan?.action?.toolName!==tool||dispatch?.toolName!==tool||dispatch.taskId!==action.taskId||receipt?.version!=='lifecycle-case-read-receipt-v1'
    ||observation?.taskId!==task.taskId||observation.actionId!==action.actionId||observation.toolName!==tool||observation.outcome!=='success'||observation.verification?.status!=='passed'||observation.verification.failedCheckIds?.length||!observation.evidenceId||!observation.verification.verificationId
    ||task.executionVerification?.status!=='passed'||task.executionVerification.taskId!==task.taskId
    ||task.executionVerification.verificationId!==observation.verification.verificationId
    ||task.executionVerification.checks?.some(c=>c.status==='failed')
    ||!task.executionVerification?.checks?.some(c=>c.checkId==='lifecycle_case_current_core_verified'&&c.status==='passed'))throw Error('case-receipt-binding');
  const request=normalizeLifecycleCaseRead(dispatch.arguments);if([mission.lifecycleCase.request,normalizeLifecycleCaseRead(task.plan.action.arguments),receipt.request].some(r=>digest(r)!==digest(request))||receipt.resultSha256!==digest(receipt.snapshot))throw Error('case-request-binding');
  validateLifecycleCaseSnapshot(receipt.snapshot,request);beforeRead(action,task);const current=readCurrentSnapshot(request);validateLifecycleCaseSnapshot(current,request);
  if(digest(current)!==receipt.resultSha256)throw Error('case-current-result-mismatch');beforeRead(action,readTask(action.taskId));
  return {passed:true,status:'passed',reasons:[],snapshot:current,evidenceActionIds:[action.actionId],checks:[{checkId:'lifecycle_case_mission_current_record',passed:true,evidence:{caseId:request.caseId,revision:request.expectedRevision,providerVerified:false}}]};
 }catch{return {passed:false,status:'unverified',reasons:['lifecycle-case-current-result-unavailable'],checks:[]};}
}
export function planLifecycleCaseRead(mission,dependencies){
 if(!mission.lifecycleCase)return null;const proof=collectLifecycleCaseResult(mission,dependencies);
 if(proof.passed)return {decision:'complete',actions:[],criteriaAssessment:mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:proof.evidenceActionIds})),planning:{provider:'local-lifecycle-case',modelRoundTrips:0}};
 if(proof.reasons[0]!=='lifecycle-case-read-incomplete')return {decision:'pause',reason:proof.reasons[0],actions:[]};
 return {decision:'continue',actions:[{id:'lifecycle-case-read',command:mission.objective,expectedToolName:tool,arguments:mission.lifecycleCase.request,dependencies:[],requirementIds:mission.goalContract.requirements.map(r=>r.requirementId)}],planning:{provider:'local-lifecycle-case',modelRoundTrips:0}};
}
