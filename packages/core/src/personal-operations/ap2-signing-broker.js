import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ap2SdkDigest} from './ap2-transaction-verifier.js';
import {ucpCanonicalJson,parseUcpJson} from './ucp-checkout-read.js';
import {verifyUcpAp2CheckoutBinding} from './ucp-ap2-binding.js';
const fail=code=>{throw Object.assign(new Error(`A_AP2_SIGN_${code}`),{code:`A_AP2_SIGN_${code}`});};
const sha=value=>createHash('sha256').update(ucpCanonicalJson(value)).digest('hex');
export const AP2_SIGN_CONNECTOR='ap2-delegated-signer';
export function registerAp2SigningConnector(registry) {
 if(!registry.get(AP2_SIGN_CONNECTOR))registry.register({id:AP2_SIGN_CONNECTOR,displayName:'AP2 위임 서명',category:'commerce',authMethods:['os-broker'],
  scopes:['mandate.sign'],credentialFields:['ap2AgentKey','ap2OpenCheckoutMandate','ap2OpenPaymentMandate'],
  requiredCredentialFields:['ap2AgentKey','ap2OpenCheckoutMandate','ap2OpenPaymentMandate'],
  capabilities:[{id:'commerce.mandate.sign',riskTier:'financial',scopes:['mandate.sign']}]});
}

/** Broker-only: a valid user root delegates to the protected agent key. No
 * user/root key generation, HTTP signing API, or implicit UCP compatibility.
 */
export function createAp2SigningBroker({registry,vault,budget,pythonPath,sdkRoot,sdkSha256,
 resolveTransaction=()=>null,resolveConnection=()=>null,clock=()=>new Date()}={}) {
 if(!registry?.get||!vault?.list||!vault?.withCredentials||!budget?.get||!budget?.store)fail('CONFIG_REQUIRED');
 registerAp2SigningConnector(registry);
 const python=resolve(pythonPath),sdk=resolve(sdkRoot),script=fileURLToPath(new URL('./ap2-sdk-verifier.py',import.meta.url));
 budget.store.db.exec(`CREATE TABLE IF NOT EXISTS personal_ap2_signing_attempts(
  reservation_id TEXT PRIMARY KEY REFERENCES personal_budget_reservations(id),
  request_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','consumed','uncertain')),
  updated_at TEXT NOT NULL);`);
 const pin=()=>{if(ap2SdkDigest(sdk)!==sdkSha256)fail('SDK_CHANGED');};pin();
 const connection=ref=>{
  const row=vault.list().find(r=>r.connectionId===ref?.connectionId);
  if(!row||row.connectorId!==AP2_SIGN_CONNECTOR||row.authMethod!=='os-broker'||row.updatedAt!==ref.expectedRevision
    ||!row.scopes?.includes('mandate.sign')||!row.grants?.includes('commerce.mandate.sign')
    ||['expired','revoked','removed','disconnected','reauth-required'].includes(row.status))fail('CONNECTION_REQUIRED');
 };
 const consent=(transaction,input)=>{
  if(!transaction||transaction.active!==true||!['ap2-native-v1','ucp-full-v1'].includes(transaction.profile)||!transaction.revision
    ||transaction.reservationId!==input.reservationId||transaction.expected?.checkoutId!==input.checkoutId
    ||transaction.checkoutJwtSha256!==createHash('sha256').update(input.checkoutJwt).digest('hex'))fail('REVIEWED_TRANSACTION_REQUIRED');
  if(transaction.profile==='ucp-full-v1') {
   if(!transaction.ucp?.checkout||!transaction.ucp?.profile)fail('UCP_BINDING_REQUIRED');
   verifyUcpAp2CheckoutBinding({checkoutJwt:input.checkoutJwt,...transaction.ucp,clock});
  }
  const row=budget.get(input.reservationId),{intentFingerprint,...request}=JSON.parse(row.request_json),e=transaction.expected;
  if(row.state!=='in_flight'||request.action!=='commerce.order'||request.target!==`provider:${transaction.providerId}`
    ||request.currency!==e.currency||request.amountMinor!==e.totalMinor||!budget.store.evaluateMandate(row.mandate_id,request).matches)fail('CONSENT_REQUIRED');
 };
 return Object.freeze({status:()=>({configured:true,profile:'ap2-native-v1',supportedProfiles:['ap2-native-v1','ucp-full-v1'],ucpFullNestingVerified:false,executionAuthority:false}),
  async withMandates(input,consume) {
   if(!input||Object.keys(input).length!==3||Object.keys(input).some(k=>!['checkoutId','reservationId','checkoutJwt'].includes(k))
     ||typeof input.checkoutId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(input.checkoutId)
     ||typeof input.reservationId!=='string'||typeof input.checkoutJwt!=='string'||input.checkoutJwt.length>262144||typeof consume!=='function')fail('REQUEST_INVALID');
   const request=structuredClone(input),transaction=structuredClone(await resolveTransaction(request.checkoutId));consent(transaction,request);
   const identity=sha(transaction),ref=structuredClone(await resolveConnection(transaction));connection(ref);
   const claimed=budget.store.db.prepare("INSERT OR IGNORE INTO personal_ap2_signing_attempts VALUES(?,?,'claimed',?)")
    .run(request.reservationId,sha({request,transaction}),budget.store.now());
   if(claimed.changes!==1)fail('ALREADY_ATTEMPTED_RECONCILIATION_REQUIRED');
   try{return await vault.withCredentials(ref.connectionId,async(credentials,metadata)=>{
    if(metadata.connectionId!==ref.connectionId||metadata.connectorId!==AP2_SIGN_CONNECTOR||metadata.updatedAt!==ref.expectedRevision)fail('CONNECTION_CHANGED');
    const material={agentKey:parseUcpJson(Buffer.from(credentials.ap2AgentKey??'')),openCheckoutMandate:credentials.ap2OpenCheckoutMandate,openPaymentMandate:credentials.ap2OpenPaymentMandate};
    pin();connection(ref);consent(transaction,request);
    const now=Math.floor(clock().getTime()/1000);
    const bytes=Buffer.from(JSON.stringify({mode:'sign',expected:{...transaction.expected,now},keys:transaction.keys,checkoutJwt:request.checkoutJwt,material}));
    if(bytes.length>1048576)fail('REQUEST_TOO_LARGE');
    const output=await new Promise((resolveResult,reject)=>{
     const child=spawn(python,['-I',script,sdk],{windowsHide:true,stdio:['pipe','pipe','ignore'],
      env:Object.fromEntries(['SystemRoot','PATH','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))});
     let size=0;const chunks=[];
     const timer=setTimeout(()=>child.kill(),10000);child.on('error',()=>reject(Error('child')));
     child.stdout.on('data',chunk=>{size+=chunk.length;if(size>512*1024)child.kill();else chunks.push(chunk);});
     child.stdin.on('error',()=>{});child.stdin.end(bytes,()=>bytes.fill(0));
     child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('verification'));
      try{resolveResult(parseUcpJson(Buffer.concat(chunks)));}catch{reject(Error('output'));}});
    });
    pin();connection(ref);
    const current=await resolveTransaction(request.checkoutId);if(sha(current)!==identity)fail('TRANSACTION_CHANGED');consent(current,request);
    const acceptedAt=Math.floor(clock().getTime()/1000);
    if(output.schemaVersion!=='a-ap2-delegated-signing-v1'||output.verified!==true||output.checkoutId!==request.checkoutId
      ||output.ucpFullNestingVerified!==false||output.executionAuthority!==false||acceptedAt<now
      ||!Number.isSafeInteger(output.evaluatedAtUnix)||output.evaluatedAtUnix<now||output.evaluatedAtUnix>acceptedAt||output.evaluatedAtUnix>now+10||output.validUntilUnix<=acceptedAt
      ||['checkoutMandate','paymentMandate'].some(k=>typeof output[k]!=='string'||!output[k]||output[k].length>262144))fail('RESULT_INVALID');
    const result=await consume(Object.freeze({checkoutMandate:output.checkoutMandate,paymentMandate:output.paymentMandate,
      profile:transaction.profile,ucpFullNestingVerified:transaction.profile==='ucp-full-v1',validUntilUnix:output.validUntilUnix}));
    const serialized=ucpCanonicalJson(result);
    if([material.agentKey.d,material.openCheckoutMandate,material.openPaymentMandate,output.checkoutMandate,output.paymentMandate].some(secret=>secret&&serialized.includes(secret)))fail('SECRET_RESULT_DENIED');
    budget.store.db.prepare("UPDATE personal_ap2_signing_attempts SET state='consumed',updated_at=? WHERE reservation_id=?")
     .run(budget.store.now(),request.reservationId);
    return result;
   });}catch(error){budget.store.db.prepare("UPDATE personal_ap2_signing_attempts SET state='uncertain',updated_at=? WHERE reservation_id=?")
     .run(budget.store.now(),request.reservationId);
    if(/^A_AP2_SIGN_[A-Z_]+$/u.test(error?.code??''))throw error;fail('OPERATION_FAILED');}
  }});
}
