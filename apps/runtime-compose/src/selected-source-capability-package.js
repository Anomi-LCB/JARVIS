import {createHash} from 'node:crypto';
import {ActionType,ModuleId,TrustBoundary} from '../../../packages/shared/src/types.js';
import {createSelectedSourceVerifier,normalizeSelectedSourceToolRequest} from '../../pc-agent/src/adapters/selected-source-client.js';

export const SELECTED_SOURCE_TOOL='source.readSelectedInbox';
const fingerprint=createHash('sha256').update('selected-source-v1:trusted-active-task:exact-request:current-core-snapshot:bounded-read:final-authority').digest('hex');

export class SelectedSourceToolAdapter {
 constructor({client,authorizeRequest}={}){
  if(typeof client?.read!=='function'||typeof authorizeRequest!=='function')throw new Error('B_SOURCE_CONFIGURATION_REQUIRED');
  this.client=client;this.authorizeRequest=authorizeRequest;
  this.contract={toolName:SELECTED_SOURCE_TOOL,readOnly:true,mutatesSystem:false,preview:true,execute:true,rollback:false,
   modes:['shadow','execute'],requiresAvailabilityBinding:true,evidence:['version','request','snapshot','resultSha256']};
 }
 async shadow(args,packet,{assertAccess}={}){
  assertAccess?.();const request=normalizeSelectedSourceToolRequest(args);
  if(this.authorizeRequest(request,packet)!==true)throw new Error('B_SOURCE_SELECTION_DENIED');
  assertAccess?.();return {mode:'shadow',expectedChangesCount:0,warnings:[],readOnly:true};
 }
 async execute(args,packet,{assertAccess}={}){
  if(typeof assertAccess!=='function')throw new Error('B_REQUIRED_CAPABILITY_FENCE_MISSING');
  const request=normalizeSelectedSourceToolRequest(args);
  const checkCurrent=()=>{assertAccess();if(this.authorizeRequest(request,packet)!==true)throw new Error('B_SOURCE_SELECTION_DENIED');return true;};
  const receipt=await this.client.read(request,{checkCurrent});checkCurrent();
  return {status:'success',summary:'선택한 연결의 저장 자료를 읽었습니다. 실제 공급자의 최신 상태 확인은 별도입니다.',
   outputPaths:[],changedItems:[],rollbackAvailable:false,readOnly:true,stdoutPreview:JSON.stringify(receipt.snapshot),evidence:receipt};
 }
}

export function createSelectedSourceCapabilityPackage({readTrustedTask,readCurrentSnapshot}={}){
 const verifyEvidence=createSelectedSourceVerifier({readTrustedTask,readCurrentSnapshot});
 Object.defineProperty(verifyEvidence,'verifierFingerprint',{value:fingerprint});
 return {packageId:'jarvis.selected-source-read',version:'1.0.0',
  skill:{skillId:'selected_source_read_skill',version:'1.0.0',label:'선택 연결 자료 읽기',module:ModuleId.PC_AGENT,category:'personal-source',
   actionType:ActionType.CAPABILITY_QUERY,toolName:SELECTED_SOURCE_TOOL,
   match:{workflows:['selected-source-read'],keywords:['선택 연결 자료'],outputFormats:['json']},
   capability:{readsLocalFiles:false,writesLocalFiles:false,externalNetwork:true,externalTransfer:false,reversible:false,
    requiresApproval:true,maxRiskTier:4,allowedModes:['shadow','execute']},
   safety:{trustBoundary:TrustBoundary.EMAIL_CONTENT,dataClasses:['selected-source-metadata'],blockedWhen:['selectionUnauthorized=true','bindingMissing=true','revisionChanged=true']},
   adapterContract:{preview:true,execute:true,rollback:false,evidence:['version','request','snapshot','resultSha256']}},
  argumentSchema:{type:'object',fields:['provider','streamRef','offset','limit','expectedRevision','rawText']},
  evidenceSchema:{required:['adapterEvidence.version','adapterEvidence.request','adapterEvidence.snapshot','adapterEvidence.resultSha256'],adapterEvidence:['version','request','snapshot','resultSha256']},
  verifierId:'g-selected-source-current-core-v1',verifierFingerprint:fingerprint,verifyEvidence,
  createAdapter:context=>new SelectedSourceToolAdapter(context)};
}
