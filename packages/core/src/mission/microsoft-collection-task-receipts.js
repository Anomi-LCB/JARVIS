import {createHash} from 'node:crypto';
import {normalizeMicrosoftCollection} from '../personal-operations/microsoft-collection-request.js';
import {collectMicrosoftCollectionResult,microsoftCollectionGoalBound} from './microsoft-collection-result.js';
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const version='core-microsoft-collection-task-receipt-v1';
const goalBinding=m=>digest([m.missionId,m.objective,m.constraints,m.goalContract,m.microsoftCollection,m.authorizationRevision,m.authorization,m.executionMandateId]);
const binding=(m,a)=>({goalSha256:goalBinding(m),
 missionId:m.missionId,actionId:a.actionId,taskId:a.taskId,dispatchSha256:digest(a.operation?.dispatch),goalRevision:a.goalRevision,authorizationRevision:a.authorizationRevision,observationId:a.observationId});
/** Historical G proof contains hashes/IDs only; current result comes from SQL. */
export class MicrosoftCollectionTaskReceipts{
 constructor({store,signer,readOperationReceipt,authorizeArchive,readTrustedTask=null,verifyCollectionPages=null}){
  if(!store?.db||typeof signer?.sign!=='function'||typeof signer?.verify!=='function'||typeof readOperationReceipt!=='function'||typeof authorizeArchive!=='function')throw Error('A_MICROSOFT_TASK_RECEIPT_CONFIGURATION_REQUIRED');
  Object.assign(this,{db:store.db,signer,readOperationReceipt,authorizeArchive,readTrustedTask,verifyCollectionPages});
  this.db.exec('CREATE TABLE IF NOT EXISTS microsoft_collection_task_receipts(task_id TEXT PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL)');
 }
 effectiveLimit(m){
  let limit=m.microsoftCollection.maxPages,previous=null;
  for(const [index,row] of (m.microsoftCollectionLimitExtensions??[]).entries()){
   if(!row||typeof row.body!=='string'||Buffer.byteLength(row.body)>8192||!this.signer.verify(row.body,row.signature))throw Error('A_MICROSOFT_LIMIT_PROOF_INVALID');
   const d=JSON.parse(row.body);
   if(d.version!=='microsoft-page-limit-extension-v1'||d.keyId!==this.signer.keyId||d.goalSha256!==goalBinding(m)
    ||d.index!==index||d.previous!==previous||d.expectedMaxPages!==limit||!Number.isSafeInteger(d.maxPages)||d.maxPages<=limit||d.maxPages>50
    ||typeof d.extensionId!=='string'||!/^ms_limit_[a-zA-Z0-9-]{1,100}$/u.test(d.extensionId))throw Error('A_MICROSOFT_LIMIT_PROOF_INVALID');
   previous=digest(row);limit=d.maxPages;
  }
  return limit;
 }
 signLimitExtension(m,{extensionId,expectedMaxPages,maxPages,observedAt}){
  if(this.effectiveLimit(m)!==expectedMaxPages)throw Error('A_MICROSOFT_LIMIT_CONFLICT');
  const rows=m.microsoftCollectionLimitExtensions??[];
  const data={version:'microsoft-page-limit-extension-v1',keyId:this.signer.keyId,goalSha256:goalBinding(m),
   index:rows.length,previous:rows.length?digest(rows.at(-1)):null,extensionId,expectedMaxPages,maxPages,observedAt};
  const body=JSON.stringify(data);return {body,signature:this.signer.sign(body)};
 }
 record(m,a,t){
  const proof=collectMicrosoftCollectionResult(m,{readTask:id=>id===t?.taskId?t:this.readTrustedTask?.(id),readCommittedReceipt:this.readOperationReceipt,
   verifyCollectionPages:this.verifyCollectionPages,resolvePageLimit:m=>this.effectiveLimit(m),
   beforeRead:(action,task)=>{if(this.authorizeArchive(m,action,task)!==true)throw Error('A_MICROSOFT_TASK_RECEIPT_ARCHIVE_DENIED');}},{allowPartial:true});
  if(!proof.passed||proof.evidenceActionIds.at(-1)!==a.actionId)return false;
  const o=m.observations.find(o=>o.observationId===a.observationId),data={version,keyId:this.signer.keyId,binding:binding(m,a),request:normalizeMicrosoftCollection(t.plan.action.arguments),
   receiptSha256:digest(proof.actionReceipts.at(-1)),evidenceId:o.evidenceId,verificationId:t.executionVerification.verificationId};
  const body=JSON.stringify(data),signature=this.signer.sign(body),prior=this.db.prepare('SELECT body,signature FROM microsoft_collection_task_receipts WHERE task_id=?').get(t.taskId);
  if(prior){if(prior.body!==body||!this.signer.verify(prior.body,prior.signature))throw Error('A_MICROSOFT_TASK_RECEIPT_CONFLICT');return true;}
  this.db.prepare('INSERT INTO microsoft_collection_task_receipts VALUES(?,?,?)').run(t.taskId,body,signature);return true;
 }
 recover(m,a){try{
  if(!microsoftCollectionGoalBound(m)||a.status!=='succeeded')return null;
  const row=this.db.prepare('SELECT body,signature FROM microsoft_collection_task_receipts WHERE task_id=?').get(a.taskId);
  if(!row||Buffer.byteLength(row.body)>16384||!this.signer.verify(row.body,row.signature))return null;
  const d=JSON.parse(row.body),o=m.observations.find(o=>o.observationId===a.observationId);
  if(d.version!==version||d.keyId!==this.signer.keyId||digest(d.binding)!==digest(binding(m,a))||o?.taskId!==a.taskId||o.actionId!==a.actionId||o.outcome!=='success'
   ||o.toolName!=='source.collectMicrosoftMetadata'||o.evidenceId!==d.evidenceId||o.verification?.status!=='passed'||o.verification.verificationId!==d.verificationId||o.verification.failedCheckIds?.length
   ||digest(d.request)!==digest(normalizeMicrosoftCollection(a.operation.dispatch.arguments)))return null;
  const receipt=this.readOperationReceipt(a.taskId,d.request,{historical:m.microsoftCollection.version==='microsoft-collection-pages-goal-v1'});if(digest(receipt)!==d.receiptSha256)return null;
  return {taskId:a.taskId,status:'COMPLETED',recoveredMicrosoftCollectionReceipt:true,plan:{action:{toolName:'source.collectMicrosoftMetadata',arguments:d.request}},
   executionVerification:{taskId:a.taskId,status:'passed',verificationId:d.verificationId,checks:[{checkId:'microsoft_collection_current_sql_verified',status:'passed'}],historicalAuthenticatedProof:true},
   executionResult:{evidence:{adapterEvidence:receipt}}};
 }catch{return null;}}
}
