import {selectedSourceDigest,normalizeSelectedSourceToolRequest} from '../../../../apps/pc-agent/src/adapters/selected-source-client.js';
import {selectedSourceGoalBound} from './selected-source-result.js';
const version='core-selected-source-task-receipt-v1';
const goal=m=>selectedSourceDigest([m.missionId,m.objective,m.constraints,m.goalContract,m.selectedSource,m.authorizationRevision,m.authorization,m.executionMandateId]);
const binding=(m,a)=>({goalSha256:goal(m),missionId:m.missionId,actionId:a.actionId,taskId:a.taskId,
 dispatchSha256:selectedSourceDigest(a.operation?.dispatch),goalRevision:a.goalRevision,authorizationRevision:a.authorizationRevision,
 observationId:a.observationId});

/** Authenticated historical G proof, without storing source text or credentials. */
export class SelectedSourceTaskReceipts {
 constructor({store,signer,readCurrentSnapshot}){
  if(!store?.db||typeof signer?.sign!=='function'||typeof signer?.verify!=='function'||typeof readCurrentSnapshot!=='function')throw new Error('A_SOURCE_RECEIPT_CONFIGURATION_REQUIRED');
  this.db=store.db;this.signer=signer;this.readCurrentSnapshot=readCurrentSnapshot;
  this.db.exec('CREATE TABLE IF NOT EXISTS selected_source_task_receipts(task_id TEXT PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL)');
 }
 record(mission,action,task){
  if(!selectedSourceGoalBound(mission)||action.status!=='succeeded'||task?.status!=='COMPLETED'||task.plan?.action?.toolName!=='source.readSelectedInbox'
   ||action.taskId!==task.taskId||action.actualToolName!=='source.readSelectedInbox'||action.operation?.dispatch?.taskId!==task.taskId
   ||task.executionVerification?.status!=='passed'||!task.executionVerification.checks?.some(c=>c.checkId==='selected_source_current_core_verified'&&c.status==='passed'))return false;
  const receipt=task.executionResult?.evidence?.adapterEvidence,observation=mission.observations.find(o=>o.observationId===action.observationId);
  if(receipt?.version!=='selected-source-receipt-v1'||receipt.resultSha256!==selectedSourceDigest(receipt.snapshot)
   ||observation?.taskId!==task.taskId||observation.actionId!==action.actionId||observation.verification?.status!=='passed'||observation.outcome!=='success'
   ||observation.verification.failedCheckIds?.length||!observation.evidenceId||!observation.verification.verificationId||!task.executionVerification.verificationId)return false;
  const request=normalizeSelectedSourceToolRequest(task.plan.action.arguments);
  if(selectedSourceDigest(request)!==selectedSourceDigest(receipt.request)||selectedSourceDigest(request)!==selectedSourceDigest(normalizeSelectedSourceToolRequest(action.operation.dispatch.arguments)))return false;
  const data={version,keyId:this.signer.keyId,binding:binding(mission,action),request,resultSha256:receipt.resultSha256,sourceRevision:receipt.snapshot.revision,
   evidenceId:observation.evidenceId,verificationId:observation.verification.verificationId,taskVerificationId:task.executionVerification.verificationId};
  const body=JSON.stringify(data),signature=this.signer.sign(body);
  const prior=this.db.prepare('SELECT body,signature FROM selected_source_task_receipts WHERE task_id=?').get(task.taskId);
  if(prior){if(prior.body!==body||!this.signer.verify(prior.body,prior.signature))throw new Error('A_SOURCE_RECEIPT_CONFLICT');return true;}
  this.db.prepare('INSERT INTO selected_source_task_receipts VALUES(?,?,?)').run(task.taskId,body,signature);return true;
 }
 recover(mission,action){
  try{
   if(!selectedSourceGoalBound(mission)||action.status!=='succeeded')return null;
   const row=this.db.prepare('SELECT body,signature FROM selected_source_task_receipts WHERE task_id=?').get(action.taskId);
   if(!row||Buffer.byteLength(row.body)>16384||!this.signer.verify(row.body,row.signature))return null;
   const data=JSON.parse(row.body),observation=mission.observations.find(o=>o.observationId===action.observationId);
   if(data.version!==version||data.keyId!==this.signer.keyId||selectedSourceDigest(data.binding)!==selectedSourceDigest(binding(mission,action))
    ||observation?.evidenceId!==data.evidenceId||observation.verification?.verificationId!==data.verificationId||observation.verification?.status!=='passed'
    ||selectedSourceDigest(data.request)!==selectedSourceDigest(normalizeSelectedSourceToolRequest(action.operation.dispatch.arguments)))return null;
   const snapshot=this.readCurrentSnapshot({...data.request,expectedRevision:data.sourceRevision});
   if(selectedSourceDigest(snapshot)!==data.resultSha256)return null;
   return {taskId:action.taskId,status:'COMPLETED',recoveredSelectedSourceReceipt:true,
    plan:{action:{toolName:'source.readSelectedInbox',arguments:data.request}},
    executionVerification:{status:'passed',verificationId:data.taskVerificationId,checks:[{checkId:'selected_source_current_core_verified',status:'passed'}],historicalAuthenticatedProof:true},
    executionResult:{evidence:{adapterEvidence:{version:'selected-source-receipt-v1',request:data.request,snapshot,resultSha256:data.resultSha256}}}};
  }catch{return null;}
 }
}
