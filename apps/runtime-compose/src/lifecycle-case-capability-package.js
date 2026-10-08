import {ActionType,ModuleId,TrustBoundary} from '../../../packages/shared/src/types.js';
import {normalizeLifecycleCaseRead,readLifecycleCaseSnapshot,lifecycleCaseDigest as digest,validateLifecycleCaseSnapshot as validate} from '../../../packages/core/src/personal-operations/lifecycle-case-read.js';
export {normalizeLifecycleCaseRead,readLifecycleCaseSnapshot};
export const LIFECYCLE_CASE_READ_TOOL='case.readLocalRecord';
const fail=code=>{throw Error(code);};
class LifecycleCaseReadAdapter{
 constructor({readSnapshot,authorizeRequest}={}){if(typeof readSnapshot!=='function'||typeof authorizeRequest!=='function')fail('CASE_READ_CONFIGURATION_REQUIRED');this.readSnapshot=readSnapshot;this.authorizeRequest=authorizeRequest;this.contract={toolName:LIFECYCLE_CASE_READ_TOOL,readOnly:true,mutatesSystem:false,preview:true,execute:true,rollback:false,modes:['shadow','execute'],requiresAvailabilityBinding:true,evidence:['version','request','snapshot','resultSha256']};}
 check(request,packet,assertAccess){if(typeof assertAccess!=='function')fail('B_REQUIRED_CAPABILITY_FENCE_MISSING');assertAccess();if(this.authorizeRequest(request,packet)!==true)fail('CASE_READ_SELECTION_DENIED');}
 async shadow(args,packet,{assertAccess}={}){const request=normalizeLifecycleCaseRead(args);this.check(request,packet,assertAccess);return {mode:'shadow',readOnly:true,expectedChangesCount:0,warnings:[]};}
 async execute(args,packet,{assertAccess}={}){
  const request=normalizeLifecycleCaseRead(args);this.check(request,packet,assertAccess);const snapshot=await this.readSnapshot(request);this.check(request,packet,assertAccess);validate(snapshot,request);
  return {status:'success',summary:'선택한 로컬 업무 기록을 읽었습니다. 공급자 상태·취소·환불 완료는 검증하지 않았습니다.',outputPaths:[],changedItems:[],rollbackAvailable:false,readOnly:true,stdoutPreview:JSON.stringify(snapshot),evidence:{version:'lifecycle-case-read-receipt-v1',request,snapshot,resultSha256:digest(snapshot)}};
 }
}
export function createLifecycleCaseCapabilityPackage({readTrustedTask,readCurrentSnapshot,authorizeVerification}={}){
 if(typeof readTrustedTask!=='function'||typeof readCurrentSnapshot!=='function'||typeof authorizeVerification!=='function')fail('CASE_READ_ORACLE_REQUIRED');
 const fingerprint=digest('lifecycle-case-read-v1:trusted-active-task:store:revision:current-core:authorization:no-provider-completion');
 const verifyEvidence=evidence=>{try{
  const task=readTrustedTask(evidence?.taskId),action=task?.plan?.action,receipt=evidence?.adapterEvidence;
  const active=t=>['APPROVED','EXECUTING','VERIFYING'].includes(t?.status);
  if(!active(task)||action?.toolName!==LIFECYCLE_CASE_READ_TOOL||receipt?.version!=='lifecycle-case-read-receipt-v1')fail('CASE_READ_TASK_INVALID');
  const request=normalizeLifecycleCaseRead(action.arguments);if(digest(request)!==digest(receipt.request)||receipt.resultSha256!==digest(receipt.snapshot))fail('CASE_READ_RECEIPT_INVALID');
  validate(receipt.snapshot,request);if(authorizeVerification(request,task)!==true)fail('CASE_READ_ORACLE_DENIED');
  const current=readCurrentSnapshot(request);validate(current,request);if(digest(current)!==receipt.resultSha256)fail('CASE_READ_CURRENT_MISMATCH');
  const latest=readTrustedTask(evidence.taskId);if(!active(latest)||latest.plan?.action?.toolName!==LIFECYCLE_CASE_READ_TOOL||digest(normalizeLifecycleCaseRead(latest.plan.action.arguments))!==digest(request)||authorizeVerification(request,latest)!==true)fail('CASE_READ_TASK_INVALID');
  return {valid:true,reasons:[],proof:'trusted-task-independent-current-core-record',providerVerified:false,completionVerified:false};
 }catch{return {valid:false,reasons:['lifecycle-case-proof-invalid-or-not-current']};}};
 Object.defineProperty(verifyEvidence,'verifierFingerprint',{value:fingerprint});
 return {packageId:'jarvis.lifecycle-case-read',version:'1.0.0',skill:{skillId:'lifecycle_case_read_skill',version:'1.0.0',label:'로컬 생활 업무 기록 읽기',module:ModuleId.PC_AGENT,category:'personal-source',actionType:ActionType.CAPABILITY_QUERY,toolName:LIFECYCLE_CASE_READ_TOOL,
  match:{workflows:['lifecycle-case-read'],keywords:['로컬 생활 업무 기록'],outputFormats:['json']},capability:{readsLocalFiles:false,writesLocalFiles:false,externalNetwork:false,externalTransfer:false,reversible:false,requiresApproval:true,maxRiskTier:4,allowedModes:['shadow','execute']},
  safety:{trustBoundary:TrustBoundary.EMAIL_CONTENT,dataClasses:['lifecycle-case-record'],blockedWhen:['selectionUnauthorized=true','bindingMissing=true','revisionChanged=true']},adapterContract:{preview:true,execute:true,rollback:false,evidence:['version','request','snapshot','resultSha256']}},
  argumentSchema:{type:'object',fields:['caseId','expectedStoreId','expectedRevision','rawText']},evidenceSchema:{required:['adapterEvidence.version','adapterEvidence.request','adapterEvidence.snapshot','adapterEvidence.resultSha256'],adapterEvidence:['version','request','snapshot','resultSha256']},verifierId:'g-lifecycle-case-current-core-v1',verifierFingerprint:fingerprint,verifyEvidence,createAdapter:context=>new LifecycleCaseReadAdapter(context)};
}
