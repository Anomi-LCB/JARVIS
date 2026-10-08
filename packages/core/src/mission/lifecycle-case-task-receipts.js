import {lifecycleCaseDigest as digest,normalizeLifecycleCaseRead} from '../personal-operations/lifecycle-case-read.js';
import {lifecycleCaseGoalBound,collectLifecycleCaseResult} from './lifecycle-case-result.js';
const version='core-lifecycle-case-task-receipt-v1';
const binding=(m,a)=>({goalSha256:digest([m.missionId,m.objective,m.constraints,m.goalContract,m.lifecycleCase,m.authorizationRevision,m.authorization,m.executionMandateId]),missionId:m.missionId,actionId:a.actionId,taskId:a.taskId,dispatchSha256:digest(a.operation?.dispatch),goalRevision:a.goalRevision,authorizationRevision:a.authorizationRevision,observationId:a.observationId});
/** Signed historical proof stores hashes and IDs, never the record's contents. */
export class LifecycleCaseTaskReceipts{
 constructor({store,signer,readCurrentSnapshot,authorizeArchive}){
  if(!store?.db||typeof signer?.sign!=='function'||typeof signer?.verify!=='function'||typeof readCurrentSnapshot!=='function'||typeof authorizeArchive!=='function')throw Error('A_CASE_RECEIPT_CONFIGURATION_REQUIRED');
  Object.assign(this,{db:store.db,signer,readCurrentSnapshot,authorizeArchive});this.db.exec('CREATE TABLE IF NOT EXISTS lifecycle_case_task_receipts(task_id TEXT PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL)');
 }
 record(mission,action,task){
  const proof=collectLifecycleCaseResult(mission,{readTask:id=>id===task?.taskId?task:null,readCurrentSnapshot:this.readCurrentSnapshot,beforeRead:()=>{if(this.authorizeArchive(mission,action,task)!==true)throw Error('A_CASE_RECEIPT_ARCHIVE_DENIED');}});
  if(!proof.passed||proof.evidenceActionIds[0]!==action.actionId)return false;
  const observation=mission.observations.find(o=>o.observationId===action.observationId),request=normalizeLifecycleCaseRead(task.plan.action.arguments);
  const data={version,keyId:this.signer.keyId,binding:binding(mission,action),request,resultSha256:digest(proof.snapshot),evidenceId:observation.evidenceId,verificationId:task.executionVerification.verificationId};
  const body=JSON.stringify(data),signature=this.signer.sign(body),prior=this.db.prepare('SELECT body,signature FROM lifecycle_case_task_receipts WHERE task_id=?').get(task.taskId);
  if(prior){if(prior.body!==body||!this.signer.verify(prior.body,prior.signature))throw Error('A_CASE_RECEIPT_CONFLICT');return true;}
  this.db.prepare('INSERT INTO lifecycle_case_task_receipts VALUES(?,?,?)').run(task.taskId,body,signature);return true;
 }
 recover(mission,action){try{
  if(!lifecycleCaseGoalBound(mission)||action.status!=='succeeded')return null;
  const row=this.db.prepare('SELECT body,signature FROM lifecycle_case_task_receipts WHERE task_id=?').get(action.taskId);
  if(!row||Buffer.byteLength(row.body)>16384||!this.signer.verify(row.body,row.signature))return null;
  const data=JSON.parse(row.body),observation=mission.observations.find(o=>o.observationId===action.observationId);
  if(data.version!==version||data.keyId!==this.signer.keyId||digest(data.binding)!==digest(binding(mission,action))||observation?.taskId!==action.taskId||observation.actionId!==action.actionId
   ||observation.evidenceId!==data.evidenceId||observation.verification?.status!=='passed'||observation.verification.verificationId!==data.verificationId||observation.verification.failedCheckIds?.length
   ||digest(data.request)!==digest(normalizeLifecycleCaseRead(action.operation.dispatch.arguments)))return null;
  const snapshot=this.readCurrentSnapshot(data.request);if(digest(snapshot)!==data.resultSha256)return null;
  return {taskId:action.taskId,status:'COMPLETED',recoveredLifecycleCaseReceipt:true,plan:{action:{toolName:'case.readLocalRecord',arguments:data.request}},
   executionVerification:{taskId:action.taskId,status:'passed',verificationId:data.verificationId,checks:[{checkId:'lifecycle_case_current_core_verified',status:'passed'}],historicalAuthenticatedProof:true},
   executionResult:{evidence:{adapterEvidence:{version:'lifecycle-case-read-receipt-v1',request:data.request,snapshot,resultSha256:data.resultSha256}}}};
 }catch{return null;}}
}
