import {createHash} from 'node:crypto';
import {GoogleReadDelegation} from './google-read-delegation.js';
const providers=['gmail','google-calendar'];
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Limits logical source pages, not HTTP requests or money. OAuth remains independent. */
export class GoogleSyncEvidence {
  constructor({store,budget,requireMandates=false,connectionBinding}){
    this.store=store;this.budget=budget;
    this.requireMandates=requireMandates;
    this.readScope=requireMandates?new GoogleReadDelegation({store,binding:connectionBinding}):null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS personal_google_bindings(provider TEXT PRIMARY KEY,mandate_id TEXT NOT NULL REFERENCES personal_mandates(id));
      CREATE TABLE IF NOT EXISTS personal_google_evidence(id TEXT PRIMARY KEY,provider TEXT NOT NULL,reservation_id TEXT,attempts INTEGER NOT NULL,state TEXT NOT NULL,item_count INTEGER,error_code TEXT,updated_at TEXT NOT NULL);`);
  }
  request(provider){if(!providers.includes(provider))throw Error('A_GOOGLE_PROVIDER_INVALID');return {action:'google.inbox.read',target:`google:${provider}`,currency:'KRW',amountMinor:0};}
  configure({provider,maxPages,validFrom,expiresAt,replaceMandateId=null,readFrom,readUntil}){
    const request=this.request(provider);if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100000)throw Error('A_BUDGET_CALL_LIMIT_INVALID');
    const scope=this.readScope?.define({provider,readFrom,readUntil});
    return this.budget.transaction(()=>{
      const prior=this.store.db.prepare('SELECT mandate_id FROM personal_google_bindings WHERE provider=?').get(provider);
      if((prior?.mandate_id??null)!==replaceMandateId)throw Error('A_GOOGLE_BINDING_CONFLICT');
      const mandate=this.store.createMandate({action:request.action,target:request.target,currency:request.currency,maxAmountMinor:0,validFrom,expiresAt});
      if(scope)this.readScope.save(mandate.id,scope);
      this.store.db.prepare('INSERT INTO personal_budget_limits VALUES(?,?,?)').run(mandate.id,0,maxPages);
      this.store.db.prepare('INSERT INTO personal_google_bindings VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET mandate_id=excluded.mandate_id').run(provider,mandate.id);return {mandate,...this.budget.summary(mandate.id)};
    });
  }
  before(job){
    const db=this.store.db,id=digest([job.account,job.provider,job.windowId??job.observedAt,job.cursor]),request=this.request(job.provider);
    const binding=db.prepare('SELECT mandate_id FROM personal_google_bindings WHERE provider=?').get(job.provider);let reservation=null;
    if(this.requireMandates&&!binding)throw Error('A_GOOGLE_MANDATE_REQUIRED');
    if(this.readScope)this.readScope.check(binding.mandate_id,job);
    if(binding){
      if(!this.store.evaluateMandate(binding.mandate_id,request).matches)throw Error('A_GOOGLE_MANDATE_DENIED');
      reservation=this.budget.reserve({mandateId:binding.mandate_id,requestId:`google:${id}`,request});
      if(reservation.state==='reserved')reservation=this.budget.begin(reservation.id);
      if(!['in_flight','uncertain'].includes(reservation.state))throw Error('A_GOOGLE_PAGE_ALREADY_CLOSED');
    }
    db.prepare(`INSERT INTO personal_google_evidence VALUES(?,?,?,1,'reading',NULL,NULL,?) ON CONFLICT(id) DO UPDATE SET reservation_id=excluded.reservation_id,attempts=attempts+1,state='reading',error_code=NULL,updated_at=excluded.updated_at`).run(id,job.provider,reservation?.id??null,this.store.now());
    return {id,reservationId:reservation?.id??null,mandateId:binding?.mandate_id??null,job:{...job}};
  }
  window(provider,range){
    if(!this.readScope)return range;
    const binding=this.store.db.prepare('SELECT mandate_id FROM personal_google_bindings WHERE provider=?').get(provider);
    if(!binding)throw Error('A_GOOGLE_MANDATE_REQUIRED');
    if(!this.store.evaluateMandate(binding.mandate_id,this.request(provider)).matches)throw Error('A_GOOGLE_MANDATE_DENIED');
    return this.readScope.window(binding.mandate_id,{provider,...range});
  }
  authorize(job,context){
    if(!this.requireMandates)return;
    const binding=this.store.db.prepare('SELECT mandate_id FROM personal_google_bindings WHERE provider=?').get(job.provider);
    if(!binding||!context?.reservationId||binding.mandate_id!==context.mandateId)throw Error('A_GOOGLE_MANDATE_DENIED');
    if(context.id!==digest([job.account,job.provider,job.windowId??job.observedAt,job.cursor]))throw Error('A_GOOGLE_MANDATE_DENIED');
    if(!this.store.evaluateMandate(binding.mandate_id,this.request(job.provider)).matches)throw Error('A_GOOGLE_MANDATE_DENIED');
    this.readScope.check(binding.mandate_id,job);
    const reservation=this.budget.get(context.reservationId);
    if(reservation.mandate_id!==binding.mandate_id||reservation.request_id!==`google:${context.id}`||!['in_flight','uncertain'].includes(reservation.state))throw Error('A_GOOGLE_MANDATE_DENIED');
  }
  /** Called inside source-inbox's transaction: receipt, cursor, items and accounting commit together. */
  commit(context,count){
    this.authorize(context.job,context);
    const db=this.store.db,now=this.store.now();
    if(context.reservationId){
      const changed=db.prepare("UPDATE personal_budget_reservations SET state='settled',actual_minor=0,receipt_ref=?,updated_at=? WHERE id=? AND state IN ('in_flight','uncertain')").run(`google:${context.id}`,now,context.reservationId);
      if(!changed.changes)throw Error('A_GOOGLE_RECEIPT_CONFLICT');
    }
    if(!db.prepare("UPDATE personal_google_evidence SET state='committed',item_count=?,error_code=NULL,updated_at=? WHERE id=?").run(count,now,context.id).changes)throw Error('A_GOOGLE_RECEIPT_MISSING');
  }
  failed(context,code){
    if(!context)return;this.store.db.prepare("UPDATE personal_google_evidence SET state='failed',error_code=?,updated_at=? WHERE id=?").run(/^A_[A-Z0-9_]+$/.test(code)?code:'A_GOOGLE_SYNC_FAILED',this.store.now(),context.id);
    if(context.reservationId&&this.budget.get(context.reservationId).state==='in_flight')this.budget.uncertain(context.reservationId);
  }
  status(){return providers.map(provider=>{
    const db=this.store.db,binding=db.prepare('SELECT mandate_id FROM personal_google_bindings WHERE provider=?').get(provider);
    const summary=db.prepare("SELECT COUNT(*) AS pages,COALESCE(SUM(attempts),0) AS attempts,COALESCE(SUM(state='committed'),0) AS committedPages FROM personal_google_evidence WHERE provider=?").get(provider);
    const latest=db.prepare('SELECT id,state,item_count AS itemCount,error_code AS errorCode,updated_at AS updatedAt FROM personal_google_evidence WHERE provider=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(provider)??null;
    let readScope=null,mandateValidity=null;try{if(this.readScope&&binding)readScope=this.readScope.get(binding.mandate_id);if(binding){const row=db.prepare('SELECT body,revoked FROM personal_mandates WHERE id=?').get(binding.mandate_id);const mandate=JSON.parse(row.body);mandateValidity={validFrom:mandate.validFrom,expiresAt:mandate.expiresAt,revoked:Boolean(row.revoked)};}}catch{}
    return {provider,mandateId:binding?.mandate_id??null,budget:binding?this.budget.summary(binding.mandate_id):null,readScope,mandateValidity,scopeRequired:this.requireMandates,...summary,latest,proof:'local-ingest-commit',externalWriteAuthority:false};
  });}
}
