import {request} from 'node:https';
import {createHash,randomUUID} from 'node:crypto';
import {inspectUcpProfile,verifyUcpCheckout,parseUcpJson,ucpCanonicalJson,UCP_READ_VERSION} from './ucp-checkout-read.js';
import {IntegrationConnectorRegistry} from './integration-security.js';

export const UCP_ORDER_CONNECTOR='ucp-commerce';
const fail=code=>{throw Object.assign(new Error(`A_UCP_ORDER_${code}`),{code:`A_UCP_ORDER_${code}`});};
const sha=v=>createHash('sha256').update(v).digest('hex');
const unavailable=new Set(['expired','revoked','removed','disconnected','reauth-required']);
export function registerUcpOrderConnector(registry) {
  if(!registry.get(UCP_ORDER_CONNECTOR))registry.register({id:UCP_ORDER_CONNECTOR,displayName:'UCP 주문',category:'commerce',
    authMethods:['os-broker'],credentialFields:['apiKey','ap2CheckoutMandate','ap2PaymentMandate'],
    requiredCredentialFields:['ap2CheckoutMandate','ap2PaymentMandate'],scopes:['checkout.read','checkout.complete'],
    capabilities:[{id:'commerce.checkout.read',riskTier:'read',scopes:['checkout.read']},
      {id:'commerce.order',riskTier:'financial',scopes:['checkout.complete']}]});
}

/** Broker-side credentials only. resolveBinding, validateMandates and observeReceipt
 * are reviewed host services, not caller-supplied code. No signer or live supplier
 * is configured by this factory. A separate-process host is a deployment gate.
 */
export function createUcpOrderBroker({registry,vault,providerId,baseUrl,platformProfileUrl,ca,
  resolveBinding=()=>null,authorize=()=>false,validateMandates=()=>false,observeReceipt=()=>null,clock=()=>new Date()}={}) {
  if(!(registry instanceof IntegrationConnectorRegistry)||!vault?.withCredentials||!vault?.list)fail('VAULT_REQUIRED');
  registerUcpOrderConnector(registry);
  const base=new URL(baseUrl),platform=new URL(platformProfileUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname.endsWith('/')
    ||platform.protocol!=='https:'||platform.username||platform.password||platform.search||platform.hash
    ||platform.pathname!=='/.well-known/ucp'||!/^[A-Za-z0-9_-]{1,100}$/u.test(providerId??''))fail('CONFIG_INVALID');
  const binding=Object.freeze({endpoint:base.href,version:UCP_READ_VERSION}),proofs=new WeakMap();
  function connection(ref,write) {
    const row=vault.list().find(r=>r.connectionId===ref?.connectionId);
    if(!row||row.connectorId!==UCP_ORDER_CONNECTOR||row.authMethod!=='os-broker'||unavailable.has(row.status)
      ||row.updatedAt!==ref.expectedRevision||!row.scopes?.includes(write?'checkout.complete':'checkout.read')
      ||!row.grants?.includes(write?'commerce.order':'commerce.checkout.read'))fail('CONNECTION_UNAVAILABLE_OR_CHANGED');
    return row;
  }
  async function http(path,{method='GET',body=null,apiKey=null,idempotencyKey=randomUUID()}={}) {
    const bytes=body===null?null:Buffer.from(ucpCanonicalJson(body));
    if(bytes?.length>512*1024)fail('REQUEST_TOO_LARGE');
    const headers={accept:'application/json','UCP-Agent':`profile="${platform.href}"`,'Request-Id':randomUUID(),'Idempotency-Key':idempotencyKey};
    if(apiKey){if(typeof apiKey!=='string'||apiKey.length>4096||/[\r\n]/u.test(apiKey))fail('CREDENTIAL_INVALID');headers['X-API-Key']=apiKey;}
    if(bytes){headers['content-type']='application/json';headers['content-length']=bytes.length;
      headers['Content-Digest']=`sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;}
    try{return await new Promise((resolve,reject)=>{
      const req=request(new URL(path,base),{method,headers,ca,minVersion:'TLSv1.3'},res=>{
        if(res.statusCode!==200||!/^application\/json(?:;|$)/iu.test(res.headers['content-type']??'')){res.resume();return reject(Error('response'));}
        let size=0;const chunks=[];
        res.on('data',chunk=>{size+=chunk.length;if(size>512*1024)req.destroy(Error('size'));else chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try{resolve(parseUcpJson(Buffer.concat(chunks)));}catch(e){reject(e);}});
      });
      const timer=setTimeout(()=>req.destroy(Error('timeout')),10000);
      req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(bytes);
    });}catch{fail('TRANSPORT_UNCERTAIN');}
  }
  async function quote(order,apiKey) {
    const profile=await http('/.well-known/ucp');
    if(!inspectUcpProfile(profile,{baseUrl:base.href}).ap2Supported)fail('AP2_REQUIRED');
    const body=await http(`${base.pathname}/checkout-sessions/${order.checkoutId}`,{apiKey});
    const latest=await http('/.well-known/ucp');
    if(!inspectUcpProfile(latest,{baseUrl:base.href}).ap2Supported)fail('AP2_REQUIRED');
    const verified=verifyUcpCheckout(body,latest,{checkoutId:order.checkoutId,clock});
    if(verified.totalArithmetic?.verified!==true)fail('DECLARED_TOTAL_UNVERIFIED');
    if(verified.currency!==order.expected.currency||verified.totalMinor!==order.expected.totalMinor)fail('QUOTE_MISMATCH');
    return verified;
  }
  function assertOrder(order) {
    if(!order||order.providerId!==providerId||ucpCanonicalJson(order.binding)!==ucpCanonicalJson(binding)
      ||!/^[A-Za-z0-9_-]{1,128}$/u.test(order.checkoutId??''))fail('ORDER_INVALID');
  }
  async function evidence(observed,order,secrets=[]) {
    if(observed.status!=='completed')return null;
    if(observed.totalArithmetic?.verified!==true)fail('DECLARED_TOTAL_UNVERIFIED');
    if(observed.signedCheckout.order?.id!==order.expected.orderId||observed.currency!==order.expected.currency||observed.totalMinor!==order.expected.totalMinor)fail('ORDER_MISMATCH');
    if(secrets.some(secret=>secret&&ucpCanonicalJson(observed.signedCheckout).includes(secret)))fail('SECRET_ECHO');
    const proof=await observeReceipt({order:structuredClone(order),checkout:observed.signedCheckout});
    if(!proof||proof.verified!==true||proof.checkoutId!==order.checkoutId||proof.orderId!==order.expected.orderId
      ||proof.currency!==order.expected.currency||proof.totalMinor!==order.expected.totalMinor
      ||!/^[a-f0-9]{64}$/u.test(proof.evidenceSha256??'')||typeof proof.receiptRef!=='string')fail('INDEPENDENT_RECEIPT_REQUIRED');
    if(secrets.some(secret=>secret&&ucpCanonicalJson(proof).includes(secret)))fail('SECRET_ECHO');
    const result=Object.freeze({schemaVersion:'ucp-broker-proof-v1'});
    proofs.set(result,{proof:structuredClone(proof),orderHash:sha(ucpCanonicalJson(order))});return result;
  }
  const adapter=Object.freeze({providerId,binding,supportsBeforeCommit:true,
    async complete({order,idempotencyKey,beforeCommit=null}) {
      assertOrder(order);if(!/^[a-f0-9]{64}$/u.test(idempotencyKey??''))fail('KEY_INVALID');
      const ref=await resolveBinding(structuredClone(order));connection(ref,true);
      try{return await vault.withCredentials(ref.connectionId,async(credentials,metadata)=>{
        if(metadata.connectionId!==ref.connectionId||metadata.updatedAt!==ref.expectedRevision||metadata.connectorId!==UCP_ORDER_CONNECTOR)fail('CONNECTION_UNAVAILABLE_OR_CHANGED');
        const checkoutMandate=credentials.ap2CheckoutMandate,paymentMandate=credentials.ap2PaymentMandate;
        if([checkoutMandate,paymentMandate].some(v=>typeof v!=='string'||v.length<8||v.length>16384))fail('MANDATES_REQUIRED');
        const observed=await quote(order,credentials.apiKey);
        if(observed.status!=='ready_for_complete'||observed.sourceSha256!==order.quoteEvidenceSha256)fail('QUOTE_CHANGED');
        if(await validateMandates({checkoutMandate,paymentMandate,checkout:observed.signedCheckout,order:structuredClone(order)})!==true)fail('MANDATES_INVALID');
        if(!ref.instrument||['id','handler_id','type'].some(k=>typeof ref.instrument[k]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(ref.instrument[k])))fail('INSTRUMENT_INVALID');
        if(await authorize(structuredClone(order))!==true)fail('POLICY_DENIED');
        connection(ref,true);
        if(Date.parse(order.expiresAt)<=clock().getTime())fail('QUOTE_EXPIRED');
        const body={ap2:{checkout_mandate:checkoutMandate},payment:{instruments:[{id:ref.instrument.id,handler_id:ref.instrument.handler_id,type:ref.instrument.type,
          selected:true,credential:{type:'PAYMENT_GATEWAY',token:paymentMandate}}]}};
        // No retry, redirect, caller URL/header, or automatic cancellation.
        if(beforeCommit!==null&&(typeof beforeCommit!=='function'||await beforeCommit()!==true))fail('COMMIT_FENCE_DENIED');
        connection(ref,true);
        if(Date.parse(order.expiresAt)<=clock().getTime())fail('QUOTE_EXPIRED');
        const response=await http(`${base.pathname}/checkout-sessions/${order.checkoutId}/complete`,{method:'POST',body,apiKey:credentials.apiKey,idempotencyKey});
        if([checkoutMandate,paymentMandate,credentials.apiKey].some(s=>s&&ucpCanonicalJson(response).includes(s)))fail('SECRET_ECHO');
        const profile=await http('/.well-known/ucp');
        if(!inspectUcpProfile(profile,{baseUrl:base.href}).ap2Supported)fail('AP2_REQUIRED');
        const completed=verifyUcpCheckout(response,profile,{checkoutId:order.checkoutId,clock});
        return evidence(completed,order,[checkoutMandate,paymentMandate,credentials.apiKey]);
      });}catch{fail('COMPLETE_UNCERTAIN');}
    },
    async lookup({order}) {
      assertOrder(order);const ref=await resolveBinding(structuredClone(order));connection(ref,false);
      try{return await vault.withCredentials(ref.connectionId,async(credentials,metadata)=>{
        if(metadata.connectionId!==ref.connectionId||metadata.updatedAt!==ref.expectedRevision||metadata.connectorId!==UCP_ORDER_CONNECTOR)fail('CONNECTION_UNAVAILABLE_OR_CHANGED');
        const observed=await quote(order,credentials.apiKey);connection(ref,false);
        return evidence(observed,order,[credentials.ap2CheckoutMandate,credentials.ap2PaymentMandate,credentials.apiKey]);
      });}catch{fail('LOOKUP_UNAVAILABLE');}
    }});
  return Object.freeze({adapter,verifyReceipt(receipt,order){const value=proofs.get(receipt);if(!value||value.orderHash!==sha(ucpCanonicalJson(order)))fail('PROOF_UNTRUSTED');return structuredClone(value.proof);},
    status:()=>({configured:true,credentialsExposedToCore:false,liveSupplierVerified:false,executionAuthority:false})});
}
