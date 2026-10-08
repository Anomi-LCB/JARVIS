import {createHash} from 'node:crypto';
import {normalizeMicrosoftCollection,microsoftCollectionMandateRef} from './microsoft-collection-request.js';
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const body=v=>JSON.stringify(canonical(v)),hash=v=>createHash('sha256').update(body(v)).digest('hex');
const fail=code=>{throw Error(code);};
/** Local SQL commit evidence, not a provider write receipt or Mission completion. */
export class MicrosoftCollectionEffects{
 constructor({store,inbox,signer,authority=null}){
  if(store?.db!==inbox?.store?.db||typeof signer?.sign!=='function'||typeof signer?.verify!=='function')fail('A_MICROSOFT_EFFECT_CONFIGURATION_REQUIRED');
  if(authority!==null&&authority.store?.db!==store.db)fail('A_MICROSOFT_EFFECT_AUTHORITY_REQUIRED');
  Object.assign(this,{db:store.db,inbox,signer,authority});
  this.db.exec("CREATE TABLE IF NOT EXISTS microsoft_collection_effects(operation_id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('in_flight','uncertain','committed')),receipt TEXT,signature TEXT,key_id TEXT)");
  this.db.exec('CREATE TABLE IF NOT EXISTS microsoft_collection_claims(operation_id TEXT PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL,key_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS microsoft_collection_abandoned(operation_id TEXT PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL,key_id TEXT NOT NULL)');
 }
 intent(binding,request){
  const keys=['operationId','missionId','actionId','taskId','goalRevision','authorizationRevision'];
  if(!binding||Object.keys(binding).length!==keys.length||keys.some(k=>!Object.hasOwn(binding,k)))fail('A_MICROSOFT_EFFECT_BINDING_INVALID');
  for(const k of keys.slice(0,4))if(typeof binding[k]!=='string'||!binding[k]||binding[k].length>300||/[\u0000-\u001f]/u.test(binding[k]))fail('A_MICROSOFT_EFFECT_BINDING_INVALID');
  for(const k of keys.slice(4))if(!Number.isSafeInteger(binding[k])||binding[k]<1)fail('A_MICROSOFT_EFFECT_BINDING_INVALID');
  return {version:'microsoft-collection-effect-v1',binding:{...binding},request:normalizeMicrosoftCollection(request)};
 }
 claim(binding,request){
  const intent=this.intent(binding,request),encoded=body(intent);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(this.db.prepare('SELECT 1 FROM microsoft_collection_abandoned WHERE operation_id=?').get(binding.operationId))fail('A_MICROSOFT_EFFECT_ALREADY_ABANDONED');
   const prior=this.db.prepare('SELECT * FROM microsoft_collection_effects WHERE operation_id=?').get(binding.operationId);
   if(prior&&prior.intent!==encoded)fail('A_MICROSOFT_EFFECT_REQUEST_CONFLICT');
   if(prior){this.db.exec('COMMIT');if(prior.state==='committed')return {replayed:true,receipt:this.recover(binding,request)};fail('A_MICROSOFT_EFFECT_RECONCILIATION_REQUIRED');}
   const resource=microsoftCollectionMandateRef(request);
   if(this.db.prepare("SELECT 1 FROM microsoft_collection_effects WHERE resource_id=? AND state IN ('in_flight','uncertain')").get(resource))fail('A_MICROSOFT_EFFECT_RECONCILIATION_REQUIRED');
   this.db.prepare("INSERT INTO microsoft_collection_effects(operation_id,resource_id,intent,state) VALUES(?,?,?,'in_flight')").run(binding.operationId,resource,encoded);
   if(this.authority){this.authority.assertActive();const proof=body({version:'microsoft-collection-claim-v1',intentSha256:hash(intent),resource,authorityToken:this.authority.lease.token,authorityOwner:this.authority.lease.ownerId});
    this.db.prepare('INSERT INTO microsoft_collection_claims VALUES(?,?,?,?)').run(binding.operationId,proof,this.signer.sign(proof),this.signer.keyId);}
   this.db.exec('COMMIT');return {replayed:false};
  }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
 }
 commit(binding,request,receipt){
  // This runs inside the SAME inbox transaction, immediately before COMMIT.
  if(this.db.isTransaction!==true)fail('A_MICROSOFT_EFFECT_ATOMIC_COMMIT_REQUIRED');
  this.authority?.assertActive();
  const intent=this.intent(binding,request),row=this.db.prepare('SELECT * FROM microsoft_collection_effects WHERE operation_id=?').get(binding.operationId);
  if(row?.state!=='in_flight'||row.intent!==body(intent)||hash(receipt.request)!==hash(intent.request))fail('A_MICROSOFT_EFFECT_COMMIT_BINDING_INVALID');
  const current=this.inbox.verifyPage(receipt.page);
  if(hash(current)!==hash(receipt.verification))fail('A_MICROSOFT_EFFECT_OUTCOME_INVALID');
  const encoded=body({version:'microsoft-collection-sql-commit-v1',intentSha256:hash(intent),receipt});
  const changed=this.db.prepare("UPDATE microsoft_collection_effects SET state='committed',receipt=?,signature=?,key_id=? WHERE operation_id=? AND state='in_flight'").run(encoded,this.signer.sign(encoded),this.signer.keyId,binding.operationId);
  if(changed.changes!==1)fail('A_MICROSOFT_EFFECT_COMMIT_CONFLICT');
  this.authority?.assertActive();
 }
 uncertain(binding){this.db.prepare("UPDATE microsoft_collection_effects SET state='uncertain' WHERE operation_id=? AND state='in_flight'").run(binding.operationId);}
 /** Recovery-only Core, fenced old writer, no signed local commit. Never success. */
 abandonUncommitted(operationId){
  if(typeof operationId!=='string'||!operationId||operationId.length>300||/[\u0000-\u001f]/u.test(operationId))fail('A_MICROSOFT_EFFECT_BINDING_INVALID');
  if(!this.authority||this.authority.recoveryOnly!==true)fail('A_MICROSOFT_EFFECT_RECOVERY_ONLY_REQUIRED');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.authority.assertActive({allowRecovery:true});
   const prior=this.db.prepare('SELECT * FROM microsoft_collection_abandoned WHERE operation_id=?').get(operationId);
   if(prior){if(this.db.prepare('SELECT 1 FROM microsoft_collection_effects WHERE operation_id=?').get(operationId)||prior.key_id!==this.signer.keyId||!this.signer.verify(prior.body,prior.signature))fail('A_MICROSOFT_EFFECT_PROOF_REQUIRED');
    const proof=JSON.parse(prior.body);if(proof.version!=='microsoft-collection-not-committed-v1'||proof.operationId!==operationId)fail('A_MICROSOFT_EFFECT_PROOF_REQUIRED');this.db.exec('COMMIT');return {status:'not-committed',operationId,replayed:true,completed:false};}
   const row=this.db.prepare('SELECT * FROM microsoft_collection_effects WHERE operation_id=?').get(operationId),claim=this.db.prepare('SELECT * FROM microsoft_collection_claims WHERE operation_id=?').get(operationId);
   if(!row||!['in_flight','uncertain'].includes(row.state)||row.receipt!==null||row.signature!==null||row.key_id!==null)fail('A_MICROSOFT_EFFECT_NOT_UNCOMMITTED');
   if(!claim||claim.key_id!==this.signer.keyId||!this.signer.verify(claim.body,claim.signature))fail('A_MICROSOFT_EFFECT_CLAIM_PROOF_REQUIRED');
   const intent=JSON.parse(row.intent),normalized=this.intent(intent.binding,intent.request),proof=JSON.parse(claim.body);
   if(row.intent!==body(normalized)||intent.binding.operationId!==operationId||row.resource_id!==microsoftCollectionMandateRef(intent.request)
    ||proof.version!=='microsoft-collection-claim-v1'||proof.intentSha256!==hash(normalized)||proof.resource!==row.resource_id
    ||!Number.isSafeInteger(proof.authorityToken)||proof.authorityToken<1||this.authority.lease.token<=proof.authorityToken
    ||this.authority.lease.ownerId===proof.authorityOwner)fail('A_MICROSOFT_EFFECT_RECOVERY_FENCE_REQUIRED');
   const encoded=body({version:'microsoft-collection-not-committed-v1',operationId,intent:normalized,originalState:row.state,claimSha256:hash(proof),recoveryToken:this.authority.lease.token,recoveryOwner:this.authority.lease.ownerId,completed:false});
   this.db.prepare('INSERT INTO microsoft_collection_abandoned VALUES(?,?,?,?)').run(operationId,encoded,this.signer.sign(encoded),this.signer.keyId);
   if(this.db.prepare("DELETE FROM microsoft_collection_effects WHERE operation_id=? AND state IN ('in_flight','uncertain') AND receipt IS NULL AND signature IS NULL AND key_id IS NULL").run(operationId).changes!==1)fail('A_MICROSOFT_EFFECT_RECOVERY_CONFLICT');
   this.authority.assertActive({allowRecovery:true});this.db.exec('COMMIT');return {status:'not-committed',operationId,replayed:false,completed:false};
  }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
 }
 recover(binding,request,{historical=false}={}){
  const intent=this.intent(binding,request),row=this.db.prepare('SELECT * FROM microsoft_collection_effects WHERE operation_id=?').get(binding.operationId);
  if(row?.state!=='committed'||row.intent!==body(intent)||row.key_id!==this.signer.keyId||!this.signer.verify(row.receipt,row.signature))fail('A_MICROSOFT_EFFECT_PROOF_REQUIRED');
  const proof=JSON.parse(row.receipt);
  if(proof.version!=='microsoft-collection-sql-commit-v1'||proof.intentSha256!==hash(intent)||hash(proof.receipt.request)!==hash(intent.request))fail('A_MICROSOFT_EFFECT_PROOF_REQUIRED');
  const current=historical?this.inbox.verifyStoredPage(proof.receipt.page):this.inbox.verifyPage(proof.receipt.page);
  if(historical){if(current.proof!=='current-sqlite-historical-page-and-items')fail('A_MICROSOFT_EFFECT_OUTCOME_INVALID');current.proof='current-sqlite-page-and-items';}
  if(hash(current)!==hash(proof.receipt.verification))fail('A_MICROSOFT_EFFECT_OUTCOME_INVALID');
  return proof.receipt;
 }
}
