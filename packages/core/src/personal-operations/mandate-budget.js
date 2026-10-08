import { randomUUID } from 'node:crypto';
import { normalizeMandateRequestScope } from './mandate-scope.js';

function fields(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('A_BUDGET_FIELDS_INVALID');}
function integer(value){if(!Number.isSafeInteger(value)||value<0)throw new Error('A_BUDGET_AMOUNT_INVALID');return value;}
function identifier(value){if(typeof value!=='string'||!value.trim()||value.length>200||/[\u0000-\u001f]/.test(value))throw new Error('A_BUDGET_ID_INVALID');return value;}

/** Accounting reservations do not grant execution authority or prove a provider charge. */
export class PersonalMandateBudget {
  constructor(store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS personal_budget_limits(mandate_id TEXT PRIMARY KEY REFERENCES personal_mandates(id),total_minor INTEGER NOT NULL,max_calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_budget_reservations(id TEXT PRIMARY KEY,mandate_id TEXT NOT NULL REFERENCES personal_budget_limits(mandate_id),request_id TEXT NOT NULL,request_json TEXT NOT NULL,amount_minor INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','in_flight','uncertain','settled','released')),actual_minor INTEGER,receipt_ref TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(mandate_id,request_id));`);
  }
  transaction(action){const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{const result=action();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  configure(input){
    fields(input,['mandateId','totalMinor','maxCalls']);const {mandateId,totalMinor,maxCalls}=input;identifier(mandateId);integer(totalMinor);integer(maxCalls);if(maxCalls<1||maxCalls>100000)throw new Error('A_BUDGET_CALL_LIMIT_INVALID');
    return this.transaction(()=>{
      const db=this.store.db;if(!db.prepare('SELECT 1 FROM personal_mandates WHERE id=?').get(mandateId))throw new Error('A_BUDGET_MANDATE_MISSING');
      const old=db.prepare('SELECT * FROM personal_budget_limits WHERE mandate_id=?').get(mandateId);
      if(old&&(old.total_minor!==totalMinor||old.max_calls!==maxCalls))throw new Error('A_BUDGET_LIMIT_IMMUTABLE');
      db.prepare('INSERT OR IGNORE INTO personal_budget_limits VALUES(?,?,?)').run(mandateId,totalMinor,maxCalls);
      return this.summary(mandateId);
    });
  }
  summary(mandateId){
    identifier(mandateId);const db=this.store.db,limit=db.prepare('SELECT * FROM personal_budget_limits WHERE mandate_id=?').get(mandateId);if(!limit)throw new Error('A_BUDGET_NOT_CONFIGURED');
    const used=db.prepare("SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_minor ELSE amount_minor END),0) AS amount,COUNT(*) AS calls FROM personal_budget_reservations WHERE mandate_id=? AND state!='released'").get(mandateId);
    return {mandateId,totalMinor:limit.total_minor,maxCalls:limit.max_calls,usedOrHeldMinor:used.amount,usedOrHeldCalls:used.calls,remainingMinor:limit.total_minor-used.amount,remainingCalls:limit.max_calls-used.calls,executionAuthority:false};
  }
  get(id){const row=this.store.db.prepare('SELECT * FROM personal_budget_reservations WHERE id=?').get(identifier(id));if(!row)throw new Error('A_BUDGET_RESERVATION_MISSING');return {...row,executionAuthority:false,providerChargeVerified:false};}
  reserve(input){
    fields(input,['mandateId','requestId','request','intentFingerprint']);const {mandateId,requestId,request,intentFingerprint}=input;identifier(mandateId);identifier(requestId);
    if(intentFingerprint!==undefined&&(typeof intentFingerprint!=='string'||!/^[a-f0-9]{64}$/u.test(intentFingerprint)))throw new Error('A_BUDGET_INTENT_FINGERPRINT_INVALID');
    return this.transaction(()=>{
      const evaluation=this.store.evaluateMandate(mandateId,request);
      const canonical=JSON.stringify({action:request.action,target:request.target,currency:request.currency,amountMinor:request.amountMinor,
        ...normalizeMandateRequestScope(request),
        ...(intentFingerprint===undefined?{}:{intentFingerprint})});
      const prior=this.store.db.prepare('SELECT * FROM personal_budget_reservations WHERE mandate_id=? AND request_id=?').get(mandateId,requestId);
      if(prior){if(prior.request_json!==canonical)throw new Error('A_BUDGET_REQUEST_CONFLICT');return {...this.get(prior.id),replayed:true,eligibleNow:evaluation.matches};}
      if(!evaluation.matches)throw new Error('A_BUDGET_MANDATE_DENIED');
      const available=this.summary(mandateId);if(request.amountMinor>available.remainingMinor||available.remainingCalls<1)throw new Error('A_BUDGET_LIMIT_EXCEEDED');
      const id=randomUUID(),now=this.store.now();
      this.store.db.prepare("INSERT INTO personal_budget_reservations(id,mandate_id,request_id,request_json,amount_minor,state,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?)").run(id,mandateId,requestId,canonical,request.amountMinor,now,now);
      return this.get(id);
    });
  }
  begin(id){return this.transaction(()=>{
    const row=this.get(id);
    if(row.state!=='reserved')throw new Error('A_BUDGET_ALREADY_DISPATCHED_OR_CLOSED');
    const {intentFingerprint,...request}=JSON.parse(row.request_json);
    if(!this.store.evaluateMandate(row.mandate_id,request).matches)throw new Error('A_BUDGET_MANDATE_DENIED');
    this.store.db.prepare("UPDATE personal_budget_reservations SET state='in_flight',updated_at=? WHERE id=?").run(this.store.now(),id);return this.get(id);
  });}
  release(id){return this.transaction(()=>{
    const row=this.get(id);if(row.state==='released')return row;
    if(row.state!=='reserved')throw new Error('A_BUDGET_CANNOT_RELEASE_DISPATCHED');
    this.store.db.prepare("UPDATE personal_budget_reservations SET state='released',updated_at=? WHERE id=?").run(this.store.now(),id);return this.get(id);
  });}
  uncertain(id){return this.transaction(()=>{
    const row=this.get(id);if(row.state==='uncertain')return row;if(row.state!=='in_flight')throw new Error('A_BUDGET_NOT_IN_FLIGHT');
    this.store.db.prepare("UPDATE personal_budget_reservations SET state='uncertain',updated_at=? WHERE id=?").run(this.store.now(),id);return this.get(id);
  });}
  settle(input){
    fields(input,['id','actualMinor','receiptRef']);const {id,actualMinor,receiptRef}=input;identifier(id);integer(actualMinor);identifier(receiptRef);
    return this.transaction(()=>{
      const row=this.get(id);if(row.state==='settled'){if(row.actual_minor!==actualMinor||row.receipt_ref!==receiptRef)throw new Error('A_BUDGET_SETTLEMENT_CONFLICT');return row;}
      if(!['in_flight','uncertain'].includes(row.state))throw new Error('A_BUDGET_NOT_IN_FLIGHT');
      if(actualMinor>row.amount_minor)throw new Error('A_BUDGET_SETTLEMENT_EXCEEDS_RESERVATION');
      // Record an already-dispatched outcome even after expiry/revocation; never authorize a new dispatch.
      this.store.db.prepare("UPDATE personal_budget_reservations SET state='settled',actual_minor=?,receipt_ref=?,updated_at=? WHERE id=?").run(actualMinor,receiptRef,this.store.now(),id);return this.get(id);
    });
  }
}
