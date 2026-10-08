import {createHash} from 'node:crypto';
import {ActionType,ModuleId,TrustBoundary} from '../../packages/shared/src/types.js';

export const toolName='benchmark.browserDomAction';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const deny=code=>{throw Error(code);};
const keys=(v,expected)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
export function normalizeBenchmarkAction(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>d.get||d.set))deny('BENCHMARK_REQUEST_INVALID');
 // Core attaches the original command as provenance, never as executable code.
 if(value && Object.hasOwn(value,'rawText')){
  const descriptor=Object.getOwnPropertyDescriptor(value,'rawText');
  if(descriptor.get||descriptor.set||typeof descriptor.value!=='string'||descriptor.value.length>80000)deny('BENCHMARK_REQUEST_INVALID');
  const {rawText,...request}=value;value=request;
 }
 if(!keys(value,['requestId','episodeId','expectedRevision','action']))deny('BENCHMARK_REQUEST_INVALID');
 const {requestId,episodeId,expectedRevision,action}=value;
 if(typeof requestId!=='string'||! /^[A-Za-z0-9_-]{1,120}$/.test(requestId)
  ||typeof episodeId!=='string'||! /^[a-f0-9-]{36}$/.test(episodeId)
  ||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>100
  ||!action||Object.values(Object.getOwnPropertyDescriptors(action)).some(d=>d.get||d.set))deny('BENCHMARK_REQUEST_INVALID');
 if(action.kind==='noop'){if(!keys(action,['kind']))deny('BENCHMARK_ACTION_INVALID');}
 else if(['click','fill'].includes(action.kind)){
  if(!keys(action,action.kind==='click'?['kind','bid']:['kind','bid','text'])||typeof action.bid!=='string'||! /^[A-Za-z0-9_-]{1,64}$/.test(action.bid)
   ||action.kind==='fill'&&(typeof action.text!=='string'||action.text.length>1024||!action.text.isWellFormed()))deny('BENCHMARK_ACTION_INVALID');
 }else deny('BENCHMARK_ACTION_UNSUPPORTED');
 return structuredClone(value);
}
export function createBrowserGymCapability({runStep,readState,readTrustedTask,authorize}={}){
 if([runStep,readState,readTrustedTask,authorize].some(f=>typeof f!=='function'))deny('BENCHMARK_CONFIGURATION_REQUIRED');
 const verifyEvidence=e=>{try{
  const task=readTrustedTask(e.taskId),receipt=e.adapterEvidence;
  if(!['APPROVED','EXECUTING','VERIFYING'].includes(task?.status)||task.plan?.action?.toolName!==toolName)deny('TASK');
  const request=normalizeBenchmarkAction(task.plan.action.arguments);
  if(authorize(request)!==true||receipt?.version!=='browsergym-action-receipt-v1'||digest(request)!==digest(receipt.request))deny('BINDING');
  const state=readState();
  if(state?.version!=='browsergym-worker-state-v1'||digest(state.receipt)!==digest(receipt)||digest(state.public)!==digest(receipt.postState)
   ||receipt.postState?.episodeId!==request.episodeId||receipt.postState.revision!==request.expectedRevision+1||authorize(request)!==true)deny('SNAPSHOT');
  return {valid:true,reasons:[],proof:'trusted-task-current-isolated-worker-snapshot',taskCompletionVerified:false};
 }catch{return {valid:false,reasons:['benchmark-action-receipt-unbound-or-stale']};}};
 const fingerprint=digest('browsergym-isolated-action-v1:trusted-task:episode:revision:typed-dom:current-worker-snapshot');
 Object.defineProperty(verifyEvidence,'verifierFingerprint',{value:fingerprint});
 const check=(request,assertAccess)=>{if(typeof assertAccess!=='function')deny('BENCHMARK_FENCE_REQUIRED');assertAccess();if(authorize(request)!==true)deny('BENCHMARK_ACCESS_REVOKED');};
 return {packageId:'jarvis.research-browsergym-dom',version:'1.0.0',skill:{skillId:'research_browsergym_dom',version:'1.0.0',label:'격리 벤치마크 DOM 동작',module:ModuleId.PC_AGENT,actionType:ActionType.DESKTOP_CONTROL,toolName,
  match:{workflows:['research-browsergym'],keywords:['격리 벤치마크 동작'],outputFormats:['json']},
  capability:{readsLocalFiles:false,writesLocalFiles:false,externalNetwork:false,externalTransfer:false,reversible:false,requiresApproval:true,maxRiskTier:4,allowedModes:['shadow','execute']},
  safety:{trustBoundary:TrustBoundary.USER_COMMAND,dataClasses:['public-benchmark-only']},adapterContract:{preview:true,execute:true,rollback:false,evidence:['version','request','postState']}},
  argumentSchema:{type:'object',fields:['requestId','episodeId','expectedRevision','action']},evidenceSchema:{required:['adapterEvidence.version','adapterEvidence.request','adapterEvidence.postState'],adapterEvidence:['version','request','postState']},
  verifierId:'g-isolated-browsergym-current-snapshot-v1',verifierFingerprint:fingerprint,verifyEvidence,
  createAdapter:()=>({contract:{toolName,readOnly:false,mutatesSystem:true,preview:true,execute:true,rollback:false,modes:['shadow','execute'],requiresAvailabilityBinding:true,evidence:['version','request','postState']},
   async shadow(args,packet,{assertAccess}={}){const request=normalizeBenchmarkAction(args);check(request,assertAccess);return {mode:'shadow',expectedChangesCount:1,warnings:['isolated-benchmark-dom-only'],rollbackAvailable:false};},
   async execute(args,packet,{assertAccess}={}){const request=normalizeBenchmarkAction(args);check(request,assertAccess);const receipt=await runStep(request,{taskId:packet.taskId,assertAccess});check(request,assertAccess);
    const state=readState();
    if(state?.version!=='browsergym-worker-state-v1'||digest(state.receipt)!==digest(receipt)||digest(state.public)!==digest(receipt.postState)
     ||digest(receipt.request)!==digest(request)||receipt.postState?.revision!==request.expectedRevision+1||receipt.postState?.episodeId!==request.episodeId)deny('BENCHMARK_POSTCONDITION_UNVERIFIED');
    check(request,assertAccess);
    return {status:'success',summary:'격리 벤치마크 DOM 동작을 실행했습니다. 과제 완료 여부는 별도 공식 평가로 판단합니다.',outputPaths:[],changedItems:[{kind:'isolated-benchmark-dom',episodeId:request.episodeId}],rollbackAvailable:false,readOnly:false,evidence:receipt,
     verification:{passed:true,scope:'isolated-worker-action-accepted-and-current-snapshot',taskCompletionVerified:false}};}
  })};
}
