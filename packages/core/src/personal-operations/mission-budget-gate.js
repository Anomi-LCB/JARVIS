import { observeLocalMandateDataRefs,localMandateFileRef,localMandateTreeRef } from './local-mandate-observation.js';
/** Counts a Mission once. Money/LLM billing is deliberately not inferred from completion. */
export class MissionBudgetGate {
  constructor({store,budget}){this.store=store;this.budget=budget;}
  mandate(mandateId){const row=this.store.db.prepare('SELECT body FROM personal_mandates WHERE id=?').get(mandateId);return row?JSON.parse(row.body):null;}
  requiresScopedPacket(mission){return Boolean(this.mandate(mission.executionMandateId)?.scope);}
  request(mandateId,{dataRefs=[]}={}){const m=mandateId?this.mandate(mandateId):null;return {action:'mission.run',target:'jarvis:missions',currency:'KRW',amountMinor:0,
    ...(m?.scope?{accountRef:null,dataRefs,mandateRevision:m.revision}:{})};}
  validate(mandateId){
    if(!this.store.evaluateMandate(mandateId,this.request(mandateId)).matches)throw Object.assign(new Error('A_MANDATE_EXECUTION_DENIED'),{code:'A_MANDATE_EXECUTION_DENIED'});
    const mandate=JSON.parse(this.store.db.prepare('SELECT body FROM personal_mandates WHERE id=?').get(mandateId).body);
    if(mandate.maxAmountMinor!==0||this.budget.summary(mandateId).totalMinor!==0)throw new Error('A_MANDATE_COUNT_QUOTA_REQUIRED');
  }
  createQuota({validFrom,expiresAt,maxCalls,scope}){
    if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>100000)throw new Error('A_BUDGET_CALL_LIMIT_INVALID');
    return this.budget.transaction(()=>{
      const mandate=this.store.createMandate({action:'mission.run',target:'jarvis:missions',currency:'KRW',maxAmountMinor:0,validFrom,expiresAt,...(scope===undefined?{}:{scope})});
      this.store.db.prepare('INSERT INTO personal_budget_limits VALUES(?,?,?)').run(mandate.id,0,maxCalls);return {mandate,...this.budget.summary(mandate.id)};
    });
  }
  reservation(mission){return this.store.db.prepare('SELECT id FROM personal_budget_reservations WHERE mandate_id=? AND request_id=?').get(mission.executionMandateId,`mission:${mission.missionId}`);}
  inspect(mission){
    if(!mission.executionMandateId)return {status:'not-required',reasons:[],executionAuthority:false};
    const evaluation=this.store.evaluateMandate(mission.executionMandateId,this.request(mission.executionMandateId));
    const summary=this.budget.summary(mission.executionMandateId),row=this.reservation(mission);
    const reservation=row?this.budget.get(row.id):null,reasons=[...evaluation.reasons];
    const mandateRow=this.store.db.prepare('SELECT body FROM personal_mandates WHERE id=?').get(mission.executionMandateId);
    if(!mandateRow||JSON.parse(mandateRow.body).maxAmountMinor!==0||summary.totalMinor!==0)reasons.push('count-quota-required');
    if(!reservation&&summary.remainingCalls<1)reasons.push('call-budget-exhausted');
    if(reservation&&['released','settled'].includes(reservation.state))reasons.push('reservation-closed');
    if(reservation?.state==='uncertain')reasons.push('reservation-reconciliation-required');
    return {status:reasons.length?'requires-review':'current',reasons,mandateId:mission.executionMandateId,
      remainingCalls:summary.remainingCalls,usedOrHeldCalls:summary.usedOrHeldCalls,
      reservationState:reservation?.state??null,costMeaning:'mission-count-only-not-provider-spend',executionAuthority:false};
  }
  beforeRun(mission,{missionStore=null,missions=null}={}){
    if(!mission.executionMandateId)return;
    if(typeof missionStore?.saveWithMissionQuota==='function'){
      if(missionStore.db!==this.store.db)throw new Error('A_MISSION_QUOTA_STORE_MISMATCH');
      return missionStore.saveWithMissionQuota(missions,{missionId:mission.missionId,phase:'begin'});
    }
    this.validate(mission.executionMandateId);
    const reservation=this.budget.reserve({mandateId:mission.executionMandateId,requestId:`mission:${mission.missionId}`,request:this.request(mission.executionMandateId)});
    if(reservation.state==='reserved')this.budget.begin(reservation.id);
    else if(!['in_flight','uncertain'].includes(reservation.state))throw new Error('A_MANDATE_RESERVATION_CLOSED');
  }
  beforeAction(mission,{packet=null,workspaceRoot=null}={}){
    if(!mission.executionMandateId)return;this.validate(mission.executionMandateId);
    const row=this.reservation(mission);if(!row||!['in_flight','uncertain'].includes(this.budget.get(row.id).state))throw new Error('A_MANDATE_RESERVATION_REQUIRED');
    if(packet&&this.requiresScopedPacket(mission)){
      const dataRefs=observeLocalMandateDataRefs(packet.action,workspaceRoot);
      const result=this.store.evaluateMandate(mission.executionMandateId,this.request(mission.executionMandateId,{dataRefs}));
      if(!result.matches)throw Object.assign(new Error('A_MANDATE_DATA_SCOPE_DENIED'),{code:'A_MANDATE_DATA_SCOPE_DENIED',reasons:result.reasons,notDispatched:true});
      return dataRefs;
    }
  }
  afterRun(mission,{missionStore=null,missions=null}={}){
    if(!mission.executionMandateId)return;const row=this.reservation(mission);if(!row)return;
    const reservation=this.budget.get(row.id);
    if(reservation.state==='settled'&&(typeof missionStore?.saveWithMissionQuota!=='function'||missionStore.missionQuotaBinding(mission.missionId)))return;
    if(typeof missionStore?.saveWithMissionQuota==='function'){
      if(missionStore.db!==this.store.db)throw new Error('A_MISSION_QUOTA_STORE_MISMATCH');
      return missionStore.saveWithMissionQuota(missions,{missionId:mission.missionId,phase:'finish'});
    }
    if(mission.status==='COMPLETED'&&mission.completion?.status==='verified'){
      this.budget.settle({id:row.id,actualMinor:0,receiptRef:`mission:${mission.missionId}`});
    }else if(['FAILED','CANCELLED','BLOCKED'].includes(mission.status)&&reservation.state==='in_flight')this.budget.uncertain(row.id);
  }
  beforeWorkflowDataAccess(mission,{packet,workspaceRoot,path,kind}){
    const refs=this.beforeAction(mission,{packet,workspaceRoot});
    if(!this.requiresScopedPacket(mission))return null;
    if(packet?.action?.toolName!=='workflow.execute'||!['read','write','inventory'].includes(kind))throw new Error('A_MANDATE_WORKFLOW_ACCESS_INVALID');
    const ref=kind==='inventory'?localMandateTreeRef(path,workspaceRoot):localMandateFileRef(path,workspaceRoot);
    const result=this.store.evaluateMandate(mission.executionMandateId,this.request(mission.executionMandateId,{dataRefs:[...new Set([...refs,ref])]}));
    if(!result.matches)throw Object.assign(new Error('A_MANDATE_DATA_SCOPE_DENIED'),{code:'A_MANDATE_DATA_SCOPE_DENIED',reasons:result.reasons,notDispatched:true});
    return ref;
  }
  beforeResultRead(mission,{workspaceRoot,path,kind='read'}){
    if(!['read','inventory'].includes(kind))throw new Error('A_MANDATE_RESULT_ACCESS_INVALID');
    if(mission.executionMandateId)this.validate(mission.executionMandateId);
    const ref=kind==='inventory'?localMandateTreeRef(path,workspaceRoot):localMandateFileRef(path,workspaceRoot);
    if(!mission.executionMandateId)return ref;
    // A result preview is read-only: a settled count reservation is not a new
    // execution call. The original scope, expiry and revocation still apply.
    const result=this.store.evaluateMandate(mission.executionMandateId,this.request(mission.executionMandateId,{dataRefs:[ref]}));
    if(!result.matches)throw Object.assign(new Error('A_MANDATE_DATA_SCOPE_DENIED'),{code:'A_MANDATE_DATA_SCOPE_DENIED'});
    return ref;
  }
  beforeSourceResultRead(mission,{action,workspaceRoot}){
    if(!['source.readSelectedInbox','case.readLocalRecord','source.collectMicrosoftMetadata'].includes(action?.toolName))throw new Error('A_MANDATE_RESULT_ACCESS_INVALID');
    const dataRefs=observeLocalMandateDataRefs(action,workspaceRoot);
    if(!mission.executionMandateId)return dataRefs;
    this.validate(mission.executionMandateId);
    const result=this.store.evaluateMandate(mission.executionMandateId,this.request(mission.executionMandateId,{dataRefs}));
    if(!result.matches)throw new Error('A_MANDATE_DATA_SCOPE_DENIED');
    return dataRefs;
  }
  list(){return this.store.db.prepare('SELECT * FROM personal_mandates ORDER BY id').all().map(row=>({id:row.id,...JSON.parse(row.body),revoked:!!row.revoked,budget:this.store.db.prepare('SELECT 1 FROM personal_budget_limits WHERE mandate_id=?').get(row.id)?this.budget.summary(row.id):null}));}
}
