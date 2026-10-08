import {createHash} from 'node:crypto';
import {ActionType,ModuleId,TrustBoundary} from '../../../packages/shared/src/types.js';
import {normalizeMicrosoftCollection} from '../../../packages/core/src/personal-operations/microsoft-collection-request.js';
export {normalizeMicrosoftCollection};
export const MICROSOFT_COLLECTION_TOOL='source.collectMicrosoftMetadata';
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const collectionDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
class MicrosoftCollectionAdapter{
 constructor(access){if(typeof access?.collect!=='function'||typeof access?.authorizeRequest!=='function')throw Error('B_MICROSOFT_COLLECTION_CONFIGURATION_REQUIRED');this.access=access;this.contract={toolName:MICROSOFT_COLLECTION_TOOL,readOnly:false,mutatesSystem:true,preview:true,execute:true,rollback:false,modes:['shadow','execute'],requiresAvailabilityBinding:true,evidence:['version','request','page','verification']};}
 check(request,packet,assertAccess){if(typeof assertAccess!=='function')throw Error('B_REQUIRED_CAPABILITY_FENCE_MISSING');assertAccess();if(this.access.authorizeRequest(request,packet)!==true)throw Error('B_MICROSOFT_COLLECTION_DENIED');}
 async shadow(args,packet,{assertAccess}={}){const request=normalizeMicrosoftCollection(args);this.check(request,packet,assertAccess);return {mode:'shadow',expectedChangesCount:1,warnings:['선택한 연결의 메타데이터가 로컬 수집 원장에 저장됩니다. 본문·첨부·발송은 포함하지 않습니다.'],readOnly:false};}
 async execute(args,packet,{assertAccess}={}){const request=normalizeMicrosoftCollection(args),check=()=>{this.check(request,packet,assertAccess);return true;};check();const receipt=await this.access.collect(request,{checkCurrent:check,taskId:packet.taskId});check();
  const current=this.access.verifyCollectedPage(receipt);check();
  if(current?.status!=='passed'||collectionDigest(current)!==collectionDigest(receipt.verification))throw Error('B_MICROSOFT_COLLECTION_OUTCOME_UNVERIFIED');
  return {status:'success',summary:'선택한 Microsoft 연결의 한 페이지 메타데이터를 수집·저장했습니다.',readOnly:false,outputPaths:[],changedItems:[{kind:'source-inbox',stream:receipt.verification?.streamRef}],rollbackAvailable:false,verification:{passed:true,proof:'current-sqlite-private-page',result:current},evidence:receipt};}
}
export function createMicrosoftCollectionCapabilityPackage({readTrustedTask,verifyCollectedPage,authorizeVerification}={}){
 for(const hook of [readTrustedTask,verifyCollectedPage,authorizeVerification])if(typeof hook!=='function')throw Error('A_MICROSOFT_COLLECTION_ORACLE_REQUIRED');
 const fingerprint=collectionDigest('microsoft-collection-v1:trusted-task:exact-job:private-provider-proof:current-sql:current-permission');
 const verifyEvidence=evidence=>{let phase='task';try{
  const task=readTrustedTask(evidence.taskId),receipt=evidence.adapterEvidence,active=t=>['APPROVED','EXECUTING','VERIFYING'].includes(t?.status);
  if(!active(task)||task.plan?.action?.toolName!==MICROSOFT_COLLECTION_TOOL||receipt?.version!=='microsoft-collection-receipt-v1')throw Error('task');
  phase='binding';const request=normalizeMicrosoftCollection(task.plan.action.arguments);
  if(collectionDigest(request)!==collectionDigest(receipt.request)||authorizeVerification(request,task)!==true)throw Error('binding');
  phase='oracle';const current=verifyCollectedPage(receipt);
  if(current?.status!=='passed'||collectionDigest(current)!==collectionDigest(receipt.verification))throw Error('outcome');
  phase='final';const latest=readTrustedTask(evidence.taskId);
  if(!active(latest)||latest.plan?.action?.toolName!==MICROSOFT_COLLECTION_TOOL||collectionDigest(normalizeMicrosoftCollection(latest.plan.action.arguments))!==collectionDigest(request)||authorizeVerification(request,latest)!==true)throw Error('final');
  return {valid:true,reasons:[],proof:'trusted-task-private-provider-page-current-sql',metadataOnly:true,realAccountVerified:false};
 }catch{return {valid:false,reasons:['microsoft-collection-not-current-or-unbound:'+phase]};}};
 Object.defineProperty(verifyEvidence,'verifierFingerprint',{value:fingerprint});
 return {packageId:'jarvis.microsoft-metadata-collection',version:'1.0.0',skill:{skillId:'microsoft_metadata_collection_skill',version:'1.0.0',label:'Microsoft 자료 수집',module:ModuleId.PC_AGENT,category:'personal-source',actionType:ActionType.CAPABILITY_QUERY,toolName:MICROSOFT_COLLECTION_TOOL,
  match:{workflows:['microsoft-metadata-collection'],keywords:['Microsoft 메타데이터 수집'],outputFormats:['json']},
  capability:{readsLocalFiles:false,writesLocalFiles:true,externalNetwork:true,externalTransfer:false,reversible:false,requiresApproval:true,maxRiskTier:4,allowedModes:['shadow','execute']},
  safety:{trustBoundary:TrustBoundary.EMAIL_CONTENT,dataClasses:['selected-source-metadata'],blockedWhen:['connectionUnauthorized=true','bindingMissing=true']},
  adapterContract:{preview:true,execute:true,rollback:false,evidence:['version','request','page','verification']}},
  argumentSchema:{type:'object',fields:['provider','connectionId','chatId','cursor','rawText']},
  evidenceSchema:{required:['adapterEvidence.version','adapterEvidence.request','adapterEvidence.page','adapterEvidence.verification'],adapterEvidence:['version','request','page','verification']},
  verifierId:'g-microsoft-collection-current-sql-v1',verifierFingerprint:fingerprint,verifyEvidence,createAdapter:access=>new MicrosoftCollectionAdapter(access)};
}
