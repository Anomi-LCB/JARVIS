import {createHash} from 'node:crypto';
import {createUcpOrderBroker,UCP_ORDER_CONNECTOR} from './ucp-order-broker.js';
import {createAp2AuthorizationVerifier,createAp2TransactionVerifier} from './ap2-transaction-verifier.js';
import {ucpCanonicalJson} from './ucp-checkout-read.js';
const hash=v=>createHash('sha256').update(ucpCanonicalJson(v)).digest('hex');
const fail=code=>{throw Object.assign(new Error(`A_UCP_BRIDGE_${code}`),{code:`A_UCP_BRIDGE_${code}`});};

/** Host-only composition. Cache contains encrypted mandates in the existing vault;
 * SQL contains references/hashes only. Never exposes a new signing HTTP route. */
export function createUcpAp2OrderBridge({store,signer,vault,registry,providerId,baseUrl,platformProfileUrl,ca,
 pythonPath,sdkRoot,sdkSha256,resolveTransaction=()=>null,resolveInstrument=()=>null,
 resolveReceipts=()=>null,authorize=()=>false,clock=()=>new Date()}={}) {
 if(!store?.db||!signer?.withMandates||!vault?.save||!vault?.withCredentials)fail('HOST_REQUIRED');
 store.db.exec(`CREATE TABLE IF NOT EXISTS personal_ucp_mandate_cache(
  reservation_id TEXT PRIMARY KEY REFERENCES personal_budget_reservations(id),order_hash TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL,connection_revision TEXT NOT NULL,transaction_hash TEXT NOT NULL,
  checkout_token_hash TEXT NOT NULL,payment_token_hash TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const current=async checkoutId=>{
  const tx=structuredClone(await resolveTransaction(checkoutId));
  if(!tx||tx.active!==true||tx.profile!=='ucp-full-v1'||tx.providerId!==providerId)fail('TRANSACTION_REQUIRED');
  return tx;
 };
 const options={pythonPath,sdkRoot,sdkSha256,resolveTransaction:current,clock};
 const preorder=createAp2AuthorizationVerifier(options),receiptVerifier=createAp2TransactionVerifier(options);
 const cache=order=>{
  const row=store.db.prepare('SELECT * FROM personal_ucp_mandate_cache WHERE order_hash=?').get(hash(order));
  if(!row)fail('PROTECTED_CACHE_REQUIRED');return row;
 };
 const credentialsMatch=(row,credentials)=>{
  if(hash(credentials.ap2CheckoutMandate)!==row.checkout_token_hash||hash(credentials.ap2PaymentMandate)!==row.payment_token_hash)fail('PROTECTED_CACHE_CHANGED');
 };
 const boundTransaction=async(order,row)=>{
  const tx=await current(order.checkoutId);
  if(hash(tx)!==row.transaction_hash||tx.reservationId!==row.reservation_id)fail('TRANSACTION_CHANGED');
  return tx;
 };
 const broker=createUcpOrderBroker({registry,vault,providerId,baseUrl,platformProfileUrl,ca,authorize,clock,
  resolveBinding:async order=>{
   const row=cache(order);const instrument=await resolveInstrument(structuredClone(order));
   const tx=await boundTransaction(order,row);
   if(!instrument||ucpCanonicalJson(instrument)!==ucpCanonicalJson(tx.ucp.instrument)
    ||instrument.id!==tx.expected.instrumentId||instrument.type!=='card'
    ||!['credit','debit'].includes(tx.expected.instrumentType))fail('INSTRUMENT_BINDING_REQUIRED');
   return {connectionId:row.connection_id,expectedRevision:row.connection_revision,instrument};
  },
  validateMandates:async({checkoutMandate,paymentMandate,checkout,order})=>{
   const row=cache(order),tx=await boundTransaction(order,row);
   if(ucpCanonicalJson(checkout)!==ucpCanonicalJson(tx.ucp.checkout))fail('QUOTE_CHANGED');
   credentialsMatch(row,{ap2CheckoutMandate:checkoutMandate,ap2PaymentMandate:paymentMandate});
   const proof=await preorder.verify({checkoutId:order.checkoutId,checkoutJwt:tx.checkoutJwt,checkoutMandate,paymentMandate});
   return proof.verified===true&&proof.ucpFullNestingVerified===true;
  },
  observeReceipt:async({checkout,order})=>{
   const row=cache(order),tx=await boundTransaction(order,row),receipts=await resolveReceipts({checkout,order:structuredClone(order)});
   if(!receipts||Object.keys(receipts).length!==2||['checkoutReceipt','paymentReceipt'].some(k=>typeof receipts[k]!=='string'))fail('RECEIPTS_REQUIRED');
   return vault.withCredentials(row.connection_id,async(credentials,metadata)=>{
    if(metadata.updatedAt!==row.connection_revision||metadata.connectorId!==UCP_ORDER_CONNECTOR)fail('PROTECTED_CACHE_CHANGED');
    credentialsMatch(row,credentials);
    const proof=await receiptVerifier.verify({checkoutId:order.checkoutId,checkoutJwt:tx.checkoutJwt,
     checkoutMandate:credentials.ap2CheckoutMandate,paymentMandate:credentials.ap2PaymentMandate,...receipts});
    return {...proof,receiptRef:`ap2:${proof.evidenceSha256.checkoutReceipt}`,evidenceSha256:hash(proof.evidenceSha256)};
   });
  }});
 const adapter=Object.freeze({providerId,binding:broker.adapter.binding,supportsBeforeCommit:true,
  async complete({order,idempotencyKey,beforeCommit=null}) {
   const dispatch=store.db.prepare('SELECT * FROM personal_commerce_orders WHERE idempotency_key=?').get(idempotencyKey);
   if(!dispatch||dispatch.order_json!==ucpCanonicalJson(order))fail('DISPATCH_BINDING_REQUIRED');
   const tx=await current(order.checkoutId);
   if(tx.reservationId!==dispatch.reservation_id||tx.expected.checkoutId!==order.checkoutId
    ||tx.expected.currency!==order.expected.currency||tx.expected.totalMinor!==order.expected.totalMinor
    ||tx.expected.orderId!==order.expected.orderId||hash(tx.ucp.checkout)!==order.quoteEvidenceSha256)fail('APPROVED_ORDER_CHANGED');
   return signer.withMandates({checkoutId:order.checkoutId,reservationId:dispatch.reservation_id,checkoutJwt:tx.checkoutJwt},async tokens=>{
    if(tokens.profile!=='ucp-full-v1'||tokens.ucpFullNestingVerified!==true)fail('FULL_MANDATE_REQUIRED');
    // Persist before any POST. A crash leaves held budget/cache; the coordinator
    // permits only lookup, never automatic signing or dispatch again.
    const saved=vault.save({connectorId:UCP_ORDER_CONNECTOR,providerAccountId:`ucp-reservation:${dispatch.reservation_id}`,
     authMethod:'os-broker',scopes:['checkout.read','checkout.complete'],grants:['commerce.checkout.read','commerce.order'],
     credentials:{ap2CheckoutMandate:tokens.checkoutMandate,ap2PaymentMandate:tokens.paymentMandate}});
    store.db.prepare('INSERT INTO personal_ucp_mandate_cache VALUES(?,?,?,?,?,?,?,?)').run(dispatch.reservation_id,hash(order),
     saved.connectionId,saved.updatedAt,hash(tx),hash(tokens.checkoutMandate),hash(tokens.paymentMandate),store.now());
    if(hash(await current(order.checkoutId))!==hash(tx))fail('TRANSACTION_CHANGED');
    return broker.adapter.complete({order,idempotencyKey,beforeCommit});
   });
  },
  lookup:args=>broker.adapter.lookup(args)});
 return Object.freeze({adapter,verifyReceipt:broker.verifyReceipt,
  status:()=>({configured:true,protectedMandateCache:true,liveSupplierVerified:false,executionAuthority:false})});
}
