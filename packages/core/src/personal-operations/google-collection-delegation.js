import {createHash} from 'node:crypto';
import {normalizeStrictIsoInstant} from '../../../shared/src/strict-iso-instant.js';
const deny=()=>{throw Error('A_GOOGLE_COLLECTION_SCOPE_DENIED');};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function exact(value,keys){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)deny();
 for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))deny();}
 return Object.freeze(Object.fromEntries(keys.map(key=>[key,value[key]])));
}
function identifier(value,max=128){if(typeof value!=='string'||!value.length||value.length>max||/[\u0000-\u0020\u007f]/u.test(value))deny();return value;}
function binding(value){const out=exact(value,['connectionId','revision']);identifier(out.connectionId);identifier(out.revision);return out;}
function provider(value){if(!['gmail','google-calendar'].includes(value))deny();return value;}
function account(value){if(typeof value!=='string'||value.length>200||!/^[^\s@]+@[^\s@]+$/u.test(value))deny();return value;}
function scope(value,p){if(value!==(p==='gmail'?'gmail-all-message-metadata-v1':'primary-calendar-event-metadata-v1'))deny();return value;}
/** Separate explicit collection consent. Bounded date mandates never satisfy this contract.
 * This policy ledger does not activate an adapter, issue OAuth grants, or prove provider completion.
 */
export class GoogleCollectionDelegation {
 constructor({store,budget,currentBinding,readAccount}){
  this.store=store;this.budget=budget;this.currentBinding=()=>binding(currentBinding());this.readAccount=readAccount;
  store.db.exec(`CREATE TABLE IF NOT EXISTS personal_google_collection_bindings(provider TEXT PRIMARY KEY,mandate_id TEXT NOT NULL REFERENCES personal_mandates(id));
   CREATE TABLE IF NOT EXISTS personal_google_collection_scopes(mandate_id TEXT PRIMARY KEY REFERENCES personal_mandates(id),body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS personal_google_collection_requests(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,mandate_id TEXT NOT NULL REFERENCES personal_mandates(id));`);
 }
 request(p){return {action:'google.collection.metadata.read',target:`google-collection:${provider(p)}`,currency:'KRW',amountMinor:0};}
 async configure(raw,{authorize=()=>true}={}){
  const assertCaller=()=>{if(authorize()!==true)throw Error('A_GOOGLE_COLLECTION_CALLER_DENIED');};assertCaller();
  const input=exact(raw,['requestId','provider','scope','connectionId','revision','maxPages','validFrom','expiresAt','replaceMandateId']);
  identifier(input.requestId);provider(input.provider);scope(input.scope,input.provider);const expected=binding({connectionId:input.connectionId,revision:input.revision});
  if(!Number.isSafeInteger(input.maxPages)||input.maxPages<1||input.maxPages>100000)deny();
  if(input.replaceMandateId!==null)identifier(input.replaceMandateId);
  const validFrom=normalizeStrictIsoInstant(input.validFrom),expiresAt=normalizeStrictIsoInstant(input.expiresAt);
  if(!validFrom||!expiresAt||validFrom>=expiresAt||expiresAt<=this.store.now())deny();
  const hash=digest(input),db=this.store.db;
  const replay=()=>{const old=db.prepare('SELECT request_hash,mandate_id FROM personal_google_collection_requests WHERE request_id=?').get(input.requestId);if(!old)return null;if(old.request_hash!==hash)throw Error('A_GOOGLE_COLLECTION_CONFLICT');return {mandateId:old.mandate_id,replayed:true,currentScopeVerified:false,collectionStarted:false,executionAuthority:false};};
  const prior=replay();if(prior)return prior;
  const assertBinding=()=>{if(digest(this.currentBinding())!==digest(expected))throw Error('A_GOOGLE_CONNECTION_CHANGED');};
  assertBinding();const observedAccount=account(await this.readAccount());assertBinding();assertCaller();
  return this.budget.transaction(()=>{
   const repeated=replay();if(repeated)return repeated;assertBinding();assertCaller();
   if(expiresAt<=this.store.now())deny();
   const old=db.prepare('SELECT mandate_id FROM personal_google_collection_bindings WHERE provider=?').get(input.provider);
   if((old?.mandate_id??null)!==input.replaceMandateId)throw Error('A_GOOGLE_COLLECTION_CONFLICT');
   const {action,target,currency}=this.request(input.provider);
   const mandate=this.store.createMandate({action,target,currency,maxAmountMinor:0,validFrom,expiresAt});
   const saved={version:1,provider:input.provider,scope:input.scope,account:observedAccount,...expected};
   db.prepare('INSERT INTO personal_google_collection_scopes VALUES(?,?)').run(mandate.id,JSON.stringify(saved));
   db.prepare('INSERT INTO personal_budget_limits VALUES(?,?,?)').run(mandate.id,0,input.maxPages);
   db.prepare('INSERT INTO personal_google_collection_bindings VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET mandate_id=excluded.mandate_id').run(input.provider,mandate.id);
   db.prepare('INSERT INTO personal_google_collection_requests VALUES(?,?,?)').run(input.requestId,hash,mandate.id);
   // Old grants and accounting remain as history, but only the active binding can authorize a page.
   return {mandateId:mandate.id,replayed:false,currentScopeVerified:true,collectionStarted:false,executionAuthority:false};
  });
 }
 check(raw){
  const job=exact(raw,['provider','scope','account','connectionId','revision','mandateId']);
  provider(job.provider);scope(job.scope,job.provider);account(job.account);identifier(job.mandateId);const current=this.currentBinding();
  const db=this.store.db,active=db.prepare('SELECT mandate_id FROM personal_google_collection_bindings WHERE provider=?').get(job.provider);
  if(active?.mandate_id!==job.mandateId||!this.store.evaluateMandate(job.mandateId,this.request(job.provider)).matches)deny();
  const row=db.prepare('SELECT body FROM personal_google_collection_scopes WHERE mandate_id=?').get(job.mandateId);
  let stored;try{stored=exact(JSON.parse(row?.body),['version','provider','scope','account','connectionId','revision']);}catch{deny();}
  if(stored.version!==1||stored.provider!==job.provider||stored.scope!==job.scope||stored.account!==job.account
   ||stored.connectionId!==job.connectionId||stored.revision!==job.revision||current.connectionId!==job.connectionId||current.revision!==job.revision)deny();
  return {scopeVerified:true,executionAuthority:false};
 }
 revoke(raw){
  const input=exact(raw,['provider','expectedMandateId']);provider(input.provider);identifier(input.expectedMandateId);
  return this.budget.transaction(()=>{
   const active=this.store.db.prepare('SELECT mandate_id FROM personal_google_collection_bindings WHERE provider=?').get(input.provider);
   if(active?.mandate_id!==input.expectedMandateId)throw Error('A_GOOGLE_COLLECTION_CONFLICT');
   this.store.revokeMandate(input.expectedMandateId);
   return {mandateId:input.expectedMandateId,revoked:true,providerGrantRevoked:false,credentialsDeleted:false,executionAuthority:false};
  });
 }
 active(p){
  provider(p);const db=this.store.db,active=db.prepare('SELECT mandate_id FROM personal_google_collection_bindings WHERE provider=?').get(p);if(!active)deny();
  const saved=JSON.parse(db.prepare('SELECT body FROM personal_google_collection_scopes WHERE mandate_id=?').get(active.mandate_id)?.body);
  const {version,...scope}=saved;const job={...scope,mandateId:active.mandate_id};this.check(job);return Object.freeze(job);
 }
 status(){
  return ['gmail','google-calendar'].map(p=>{
   const db=this.store.db,active=db.prepare('SELECT mandate_id FROM personal_google_collection_bindings WHERE provider=?').get(p);
   if(!active)return {provider:p,status:'not-configured',collectionStarted:false,executionAuthority:false};
   try{
    const saved=JSON.parse(db.prepare('SELECT body FROM personal_google_collection_scopes WHERE mandate_id=?').get(active.mandate_id).body);
    const {version,...job}=saved;this.check({...job,mandateId:active.mandate_id});
    return {provider:p,status:'scope-ready',mandateId:active.mandate_id,scope:saved.scope,budget:this.budget.summary(active.mandate_id),
     adapterVerified:false,collectionStarted:false,executionAuthority:false};
   }catch{return {provider:p,status:'blocked',mandateId:active.mandate_id,adapterVerified:false,collectionStarted:false,executionAuthority:false};}
  });
 }
}
