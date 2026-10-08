import {PersonalLifecycleCases} from '../../../packages/core/src/personal-operations/lifecycle-cases.js';
import {normalizeLifecycleCaseRead,lifecycleCaseDigest as digest,readLifecycleCaseSnapshot} from '../../../packages/core/src/personal-operations/lifecycle-case-read.js';
import {LifecycleCaseTaskReceipts} from '../../../packages/core/src/mission/lifecycle-case-task-receipts.js';

/** Core-owned local record access; tasks cannot select SQL paths or credentials. */
export function createLifecycleCaseServiceAccess({store,getRuntime,clock=()=>new Date()}={}){
 const cases=new PersonalLifecycleCases(store),permissionRevision='core-local-case-read-v1';let closed=false,receiptStore;
 const active=()=>{if(closed)return false;try{getRuntime()?.missionRuntime?.executionAuthority?.assertActive();return true;}catch{return false;}};
 const bindingFor=r=>({capabilityId:'case.readLocalRecord',providerId:'core-local-case',accountRef:r.caseId,deviceRef:null,scopes:['case.read:selected']});
 const known=r=>{try{const request=normalizeLifecycleCaseRead(r);return active()&&request.expectedStoreId===cases.storeId&&cases.get(request.caseId,{includeEvents:false}).revision===request.expectedRevision;}catch{return false;}};
 const readCurrentSnapshot=r=>{if(!known(r))throw Error('A_CASE_SERVICE_SELECTION_DENIED');const snapshot=readLifecycleCaseSnapshot(cases,r);if(!known(r))throw Error('A_CASE_SERVICE_SELECTION_DENIED');return snapshot;};
 const receipts=()=>{if(receiptStore)return receiptStore;try{return receiptStore=new LifecycleCaseTaskReceipts({store,readCurrentSnapshot,
  signer:getRuntime().trustKernel.createPurposeBoundSigner({purpose:'core-lifecycle-case-task-receipt-v1'}),
  authorizeArchive:(m,a,t)=>{try{getRuntime().missionRuntime.lifecycleCaseDependencies(m).beforeRead(a,t);return active();}catch{return false;}}});}catch{return null;}};
 const access={readCurrentSnapshot,readSnapshot:readCurrentSnapshot,
  archiveCompletedAction:(m,a,t)=>receipts()?.record(m,a,t)??false,
  readRecoveredTask:(m,a)=>receipts()?.recover(m,a)??null,
  revalidateReadBinding:r=>access.resolveBinding({action:{arguments:r}}),
  authorizeRequest(r,packet){
   if(!known(r))return false;
   const runtime=getRuntime(),availability=runtime?.capabilityPackageRegistry.availabilityFor(bindingFor(r));
   if(!availability?.codeReady||availability.accountStatus!=='connected'||availability.permissionRevision!==permissionRevision||availability.reasons.some(reason=>reason.code!=='observation-stale'))return false;
   let task=runtime.coreFacade.getTask(packet?.taskId);
   if(!task)for(const mission of runtime.missionRuntime.missions.values()){
    const actions=mission.waves.flatMap(w=>w.actions).filter(a=>a.taskId===packet?.taskId);
    if(actions.length===1){task=access.readRecoveredTask(mission,actions[0]);if(task)break;}
   }
   if(!task||!['APPROVED','EXECUTING','VERIFYING','COMPLETED'].includes(task.status)||task.plan?.action?.toolName!=='case.readLocalRecord')return false;
   try{return digest(normalizeLifecycleCaseRead(task.plan.action.arguments))===digest(normalizeLifecycleCaseRead(r));}catch{return false;}
  },
  authorizeVerification:(r,t)=>access.authorizeRequest(r,{taskId:t?.taskId}),
  resolveBinding({action,task}){
   let r;try{r=normalizeLifecycleCaseRead(action?.arguments??task?.plan?.action?.arguments);}catch{return {required:true};}
   if(!known(r))return {required:true};readCurrentSnapshot(r);
   const runtime=getRuntime(),binding=bindingFor(r),prior=runtime.capabilityPackageRegistry.availabilityFor(binding);
   if(prior.observedAt&&(prior.accountStatus!=='connected'||prior.permissionRevision!==permissionRevision||prior.reasons.some(reason=>reason.code!=='observation-stale')))return {required:true,binding,permissionRevision:prior.permissionRevision};
   runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:prior.codeVersion,permissionRevision,observedAt:clock().toISOString(),accountStatus:'connected',observedAccountRef:r.caseId,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'core-owned-local-case-record'});
   return {required:true,binding,permissionRevision};
  }
 };
 return {access,close(){closed=true;}};
}
