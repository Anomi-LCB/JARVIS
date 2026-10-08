import {IntegrationConnectorRegistry} from './integration-security.js';

export const DUFFEL_CONNECTOR_ID='duffel-travel';
export const DUFFEL_READ_SCOPE='offers.read';
export const DUFFEL_READ_CAPABILITY='travel.quote.read';
const unavailable=new Set(['expired','revoked','removed','disconnected','reauth-required']);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const offerId=value=>typeof value==='string'&&/^off_[A-Za-z0-9_]{1,100}$/u.test(value);
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)
  && Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===(value.includes('.')?value:value.replace('Z','.000Z'));

export function registerDuffelReadConnector(registry) {
  if(!registry.get(DUFFEL_CONNECTOR_ID))registry.register({id:DUFFEL_CONNECTOR_ID,displayName:'Duffel 여행 견적',category:'travel',
    authMethods:['api-key'],credentialFields:['apiKey'],requiredCredentialFields:['apiKey'],scopes:[DUFFEL_READ_SCOPE],
    capabilities:[{id:DUFFEL_READ_CAPABILITY,riskTier:'read',scopes:[DUFFEL_READ_SCOPE]}]});
}

function totalMinor(amount,currency) {
  const scales={KRW:0,JPY:0,USD:2,EUR:2,GBP:2};
  if(!Object.hasOwn(scales,currency))fail('A_DUFFEL_CURRENCY_UNSUPPORTED');
  if(typeof amount!=='string'||amount.length>64||!/^\d+(?:\.\d+)?$/u.test(amount))fail('A_DUFFEL_AMOUNT_INVALID');
  const [whole,fraction='']=amount.split('.');
  const numerator=BigInt(whole+fraction)*10n**BigInt(scales[currency]);
  const denominator=10n**BigInt(fraction.length);
  if(numerator%denominator!==0n||numerator/denominator>BigInt(Number.MAX_SAFE_INTEGER))fail('A_DUFFEL_AMOUNT_INVALID');
  return Number(numerator/denominator);
}

export function normalizeDuffelTestOffer(body,{expectedOfferId,clock=()=>new Date()}={}) {
  const data=body?.data;
  if(!object(data)||!offerId(data.id)||data.id!==expectedOfferId||data.live_mode!==false||(data.partial!==undefined&&data.partial!==false)
    ||!instant(data.expires_at)||!instant(data.updated_at)||!object(data.conditions)
    ||!Array.isArray(data.passengers)||data.passengers.length<1||data.passengers.length>9
    ||data.passengers.some(p=>!object(p)||typeof p.id!=='string'||p.id.length>150)
    ||!Array.isArray(data.slices)||data.slices.length<1||data.slices.length>8
    ||!Array.isArray(data.available_services)||data.available_services.length>100)fail('A_DUFFEL_OFFER_INVALID');
  const now=clock().getTime();
  if(!Number.isFinite(now))fail('A_DUFFEL_CLOCK_INVALID');
  if(Date.parse(data.expires_at)<=now)fail('A_DUFFEL_OFFER_EXPIRED');
  if(Date.parse(data.updated_at)>now)fail('A_DUFFEL_OFFER_TIME_INVALID');
  const amount=totalMinor(data.total_amount,data.total_currency);
  // total_amount includes taxes but excludes ancillary services. Preserve the
  // unresolved price boundary rather than silently declaring an all-in cost.
  return {provider:'duffel',apiVersion:'v2',mode:'provider-test',offerId:data.id,currency:data.total_currency,
    offerTotalMinor:amount,offerTotalAmount:data.total_amount,expiresAt:data.expires_at,updatedAt:data.updated_at,
    checkedAt:new Date(now).toISOString(),passengerRefs:data.passengers.map(p=>p.id),
    sourceSlices:structuredClone(data.slices),conditions:structuredClone(data.conditions),
    availableServices:structuredClone(data.available_services),
    ancillarySelectionVerified:false,allInTotalVerified:false,executionAuthority:false,bookingAvailable:false};
}

async function jsonResponse(response) {
  const max=512*1024;
  const type=response.headers?.get('content-type')??'';
  if(!/^(?:application\/json|application\/[\w.-]+\+json)(?:;|$)/iu.test(type)
    ||!response.body||Number(response.headers.get('content-length'))>max)fail('A_DUFFEL_RESPONSE_INVALID');
  const chunks=[];let size=0;
  for await(const chunk of response.body) {
    size+=chunk.byteLength;
    if(size>max)fail('A_DUFFEL_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
  catch{fail('A_DUFFEL_RESPONSE_INVALID');}
}

/** Broker-side only: inject the existing secure vault, never expose it to Core.
 * Test tokens and a single fixed GET endpoint only. No orders/search/payment.
 * Separate authenticated broker process deployment remains a distinct gate. */
export function createDuffelQuoteBroker({registry,vault,fetchImpl=globalThis.fetch,clock=()=>new Date()}={}) {
  if(!(registry instanceof IntegrationConnectorRegistry)||!vault?.list||!vault?.withCredentials)throw new TypeError('Trusted registry and vault required');
  registerDuffelReadConnector(registry);
  const connection=request=>{
    const row=vault.list().find(r=>r.connectionId===request.connectionId);
    if(!row||row.connectorId!==DUFFEL_CONNECTOR_ID||row.authMethod!=='api-key'||unavailable.has(row.status)
      ||!row.scopes?.includes(DUFFEL_READ_SCOPE)||!row.grants?.includes(DUFFEL_READ_CAPABILITY))fail('A_DUFFEL_CONNECTION_REQUIRED');
    if(row.updatedAt!==request.expectedRevision)fail('A_DUFFEL_REVISION_CONFLICT');
    return row;
  };
  return Object.freeze({async execute(input,{signal=null}={}) {
    if(!object(input)||Object.keys(input).some(k=>!['connectionId','expectedRevision','offerId'].includes(k))
      ||typeof input.connectionId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/u.test(input.connectionId)
      ||typeof input.expectedRevision!=='string'||!input.expectedRevision||input.expectedRevision.length>100
      ||!offerId(input.offerId))fail('A_DUFFEL_REQUEST_INVALID');
    const request=structuredClone(input);
    signal?.throwIfAborted();connection(request);
    try {
      const result=await vault.withCredentials(request.connectionId,async(credentials,metadata)=>{
        signal?.throwIfAborted();
        if(metadata.connectionId!==request.connectionId||metadata.updatedAt!==request.expectedRevision
          ||metadata.connectorId!==DUFFEL_CONNECTOR_ID||metadata.authMethod!=='api-key'
          ||unavailable.has(metadata.status)||!metadata.scopes?.includes(DUFFEL_READ_SCOPE)||!metadata.grants?.includes(DUFFEL_READ_CAPABILITY))fail('A_DUFFEL_REVISION_CONFLICT');
        const token=credentials?.apiKey;
        if(typeof token!=='string'||!/^duffel_test_[A-Za-z0-9_-]{8,512}$/u.test(token))fail('A_DUFFEL_TEST_TOKEN_REQUIRED');
        connection(request);
        let response;
        try {response=await fetchImpl(`https://api.duffel.com/air/offers/${request.offerId}?return_available_services=true`,{
          method:'GET',redirect:'error',headers:{accept:'application/json','Duffel-Version':'v2',authorization:`Bearer ${token}`},
          signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}
        catch{fail('A_DUFFEL_NETWORK');}
        if(!response.ok)fail(/^\d{3}$/u.test(String(response.status))?`A_DUFFEL_HTTP_${response.status}`:'A_DUFFEL_RESPONSE_INVALID');
        const body=await jsonResponse(response);
        if(JSON.stringify(body).includes(token))fail('A_DUFFEL_RESPONSE_DENIED');
        signal?.throwIfAborted();
        return normalizeDuffelTestOffer(body,{expectedOfferId:request.offerId,clock});
      });
      signal?.throwIfAborted();connection(request);
      // Recheck expiry after asynchronous secret-store release/transport work.
      const returnedAt=clock().getTime();
      if(!Number.isFinite(returnedAt))fail('A_DUFFEL_CLOCK_INVALID');
      if(Date.parse(result.expiresAt)<=returnedAt)fail('A_DUFFEL_OFFER_EXPIRED');
      return result;
    }catch(error){
      if(/^A_DUFFEL_(?:CURRENCY_UNSUPPORTED|AMOUNT_INVALID|OFFER_INVALID|CLOCK_INVALID|OFFER_EXPIRED|OFFER_TIME_INVALID|CONNECTION_REQUIRED|REVISION_CONFLICT|TEST_TOKEN_REQUIRED|NETWORK|RESPONSE_INVALID|RESPONSE_TOO_LARGE|RESPONSE_DENIED|HTTP_\d{3})$/u.test(error?.message??''))throw new Error(error.message);
      fail('A_DUFFEL_OPERATION_FAILED');
    }
  }});
}

/** Core-side facade owns no credential accessor, URL or caller-supplied headers. */
export function createDuffelBrokerQuoteClient({connectionMetadata,execute}={}) {
  if(typeof connectionMetadata!=='function'||typeof execute!=='function')throw new TypeError('Metadata and broker transport required');
  const rows=()=>connectionMetadata().filter(row=>row.connectorId===DUFFEL_CONNECTOR_ID&&row.authMethod==='api-key'
    &&!unavailable.has(row.status)&&row.scopes?.includes(DUFFEL_READ_SCOPE)&&row.grants?.includes(DUFFEL_READ_CAPABILITY));
  return Object.freeze({configured:()=>rows().length===1,
    readiness(){const matches=rows();return {ready:false,credentialsConfigured:matches.length===1,
      reason:matches.length===0?'connection-required':matches.length>1?'account-selection-required':'provider-call-unverified',
      connectorId:DUFFEL_CONNECTOR_ID,mode:'test',providerVerified:false,bookingAvailable:false};},
    async offer(id){
      if(!offerId(id))fail('A_DUFFEL_REQUEST_INVALID');
      const matches=rows();if(matches.length!==1)fail(matches.length?'A_DUFFEL_CONNECTION_AMBIGUOUS':'A_DUFFEL_CONNECTION_REQUIRED');
      return execute({connectionId:matches[0].connectionId,expectedRevision:matches[0].updatedAt,offerId:id});
    }
  });
}
