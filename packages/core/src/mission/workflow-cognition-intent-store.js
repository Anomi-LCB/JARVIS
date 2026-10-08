import {createHash} from 'node:crypto';
import {SqliteMissionStore} from './sqlite-mission-store.js';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const fail=()=>{throw Object.assign(new Error('Workflow cognition intent mismatch'),{code:'A_WORKFLOW_COGNITION_INTENT_INVALID'});};
/** Core-owned context only. Never an execution permission or a replay request. */
export class WorkflowCognitionIntentStore {
 #db; #executorBinding;
 constructor(store,{executorBinding=()=>({kind:'pc-local'})}={}){
  if(!(store instanceof SqliteMissionStore))fail();this.#db=store.db;
  if(typeof executorBinding!=='function')fail();this.#executorBinding=executorBinding;
  this.#db.exec('CREATE TABLE IF NOT EXISTS workflow_cognition_intents(operation_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,body TEXT NOT NULL,body_sha256 TEXT NOT NULL)');
 }
 record(mission,action,task){
  const op=action.operation,d=op?.dispatch;
  if(!d || d.toolName!=='workflow.execute'||d.actionNodeCount!==1||d.profile?.externalTransfer===true
   ||task.taskId!==d.taskId||hash(task.plan.action)!==d.actionSha256||!task.request?.userId||!task.request.requestId||!task.plan.planId||!task.approvalCard?.approvalId)fail();
  const metadata=task.request.metadata??{};
  const executorBinding=this.#binding();
  const body={operationId:op.operationId,missionId:mission.missionId,actionSha256:d.actionSha256,
   executorBinding,
   plannedRequestSha256:op.requestSha256,allowedRootsSha256:op.allowedRootsSha256,resolvedAllowedRootsSha256:op.resolvedAllowedRootsSha256,
   request:{taskId:task.taskId,toolName:d.toolName,cognitionPlanId:task.plan.planId,cognitionApprovalId:task.approvalCard.approvalId,
    taskRequest:{requestId:task.request.requestId,userId:task.request.userId,metadata:{conversationId:metadata.conversationId??null,
     doNotRemember:metadata.doNotRemember===true,learningFlags:{doNotRemember:metadata.learningFlags?.doNotRemember===true}}}}};
  const json=JSON.stringify(body),digest=hash(body),prior=this.#db.prepare('SELECT * FROM workflow_cognition_intents WHERE operation_id=?').get(op.operationId);
  if(prior){if(prior.body_sha256!==digest||hash(JSON.parse(prior.body))!==digest)fail();return;}
  this.#db.prepare('INSERT INTO workflow_cognition_intents VALUES(?,?,?,?)').run(op.operationId,mission.missionId,json,digest);
 }
 load(missionId,action){
  const op=action.operation,d=op?.dispatch,row=op&&this.#db.prepare('SELECT * FROM workflow_cognition_intents WHERE operation_id=?').get(op.operationId);
  if(!row)return null;
  const b=JSON.parse(row.body);
  if(row.mission_id!==missionId||hash(b)!==row.body_sha256||b.missionId!==missionId||b.operationId!==op.operationId
   ||hash(b.executorBinding??{kind:'pc-local'})!==hash(this.#binding())
   ||b.actionSha256!==d?.actionSha256||b.plannedRequestSha256!==op.requestSha256||b.allowedRootsSha256!==op.allowedRootsSha256
   ||b.resolvedAllowedRootsSha256!==op.resolvedAllowedRootsSha256||b.request.taskId!==d.taskId||b.request.toolName!=='workflow.execute')fail();
  return {request:b.request,requestSha256:hash(b.request)};
 }
 #binding(){
  const value=this.#executorBinding();
  if(value?.kind==='pc-local'&&Object.keys(value).length===1)return{kind:'pc-local'};
  if(value?.kind==='pc-http-loopback'&&/^[a-f0-9]{64}$/.test(value.endpointHash??'')&&Object.keys(value).length===2)return{kind:value.kind,endpointHash:value.endpointHash};
  fail();
 }
}
