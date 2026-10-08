import {createPublicKey,verify,createHash} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {calculateUcpTotalArithmetic} from './ucp-total-arithmetic.js';
export const UCP_READ_VERSION='2026-08-25';
const checkoutCapability='dev.ucp.shopping.checkout',ap2Capability='dev.ucp.common.payment.ap2_mandate';
const fail=code=>{throw Object.assign(new Error(`A_UCP_${code}`),{code:`A_UCP_${code}`});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const hash=v=>createHash('sha256').update(v).digest('hex');

/** RFC 8785 JSON subset, rejecting values outside I-JSON and bounded depth. */
export function ucpCanonicalJson(value,depth=0) {
  if(depth>32)fail('JSON_DEPTH');
  if(typeof value==='string') {
    if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))fail('JSON_UNICODE');
    return JSON.stringify(value);
  }
  if(value===null||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number') {if(!Number.isFinite(value))fail('JSON_NUMBER');return JSON.stringify(value);}
  if(Array.isArray(value))return `[${value.map(v=>ucpCanonicalJson(v,depth+1)).join(',')}]`;
  if(object(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))
    return `{${Object.keys(value).sort().map(k=>`${ucpCanonicalJson(k,depth+1)}:${ucpCanonicalJson(value[k],depth+1)}`).join(',')}}`;
  fail('JSON_VALUE');
}

export function parseUcpJson(bytes) {
  if(bytes.byteLength>512*1024)fail('RESPONSE_TOO_LARGE');
  let text,value;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text);}catch{fail('RESPONSE_JSON');}
  // JSON.parse loses duplicate members. Reject them before signature checking,
  // including escaped aliases, instead of verifying a different projection.
  const frames=[];
  for(let i=0;i<text.length;i++) {
    if(text[i]==='{')frames.push(new Set());
    else if(text[i]==='[')frames.push(null);
    else if(text[i]==='}'||text[i]===']')frames.pop();
    else if(text[i]==='"') {
      const start=i;
      for(i++;i<text.length;i++){if(text[i]==='\\')i++;else if(text[i]==='"')break;}
      let next=i+1;while(/\s/u.test(text[next]??'')&&next<text.length)next++;
      if(text[next]===':'&&frames.at(-1)) {
        const key=JSON.parse(text.slice(start,i+1));
        if(frames.at(-1).has(key))fail('JSON_DUPLICATE_MEMBER');frames.at(-1).add(key);
      }
    }
  }
  ucpCanonicalJson(value);return value;
}

function capability(profile,name,{requireExtends=false}={}) {
  const entries=profile?.ucp?.capabilities?.[name];
  if(!Array.isArray(entries))return false;
  return entries.some(e=>e?.version===UCP_READ_VERSION&&(!requireExtends||e.extends===checkoutCapability));
}
export function inspectUcpProfile(profile,{baseUrl}={}) {
  if(!object(profile)||profile.ucp?.version!==UCP_READ_VERSION)fail('VERSION_UNSUPPORTED');
  const services=profile.ucp.services?.['dev.ucp.shopping'];
  if(!Array.isArray(services)||!services.some(s=>s.version===UCP_READ_VERSION&&s.transport==='rest'&&s.endpoint===baseUrl))fail('ENDPOINT_UNAPPROVED');
  const checkout=capability(profile,checkoutCapability),ap2=capability(profile,ap2Capability,{requireExtends:true});
  if(!checkout)fail('CHECKOUT_UNSUPPORTED');
  return {version:UCP_READ_VERSION,checkoutSupported:checkout,ap2Supported:ap2,
    securityLocked:ap2,orderAvailable:false,executionAuthority:false,
    nextAction:ap2?'서명된 견적을 조회할 수 있습니다. 주문 연결은 아직 준비되지 않았습니다.':'AP2 서명 위임을 지원하지 않습니다. 판매자의 공식 결제 화면을 이용하세요.'};
}

export function verifyUcpCheckout(checkout,profile,{checkoutId,clock=()=>new Date()}={}) {
  if(!object(checkout)||checkout.id!==checkoutId||!identifier(checkoutId)
    ||checkout.ucp?.version!==UCP_READ_VERSION||!capability(checkout,checkoutCapability)||!capability(checkout,ap2Capability))fail('SESSION_SECURITY_DOWNGRADE');
  const detached=checkout.ap2?.merchant_authorization;
  if(typeof detached!=='string'||detached.length>2048||!/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/u.test(detached))fail('MERCHANT_SIGNATURE_MISSING');
  const [encoded,,signature]=detached.split('.');
  const header=parseUcpJson(Buffer.from(encoded,'base64url'));
  if(header.alg!=='ES256'||!identifier(header.kid)||Object.keys(header).some(k=>!['alg','kid','typ'].includes(k)))fail('SIGNATURE_HEADER_INVALID');
  const keys=profile.keys;
  if(!Array.isArray(keys)||keys.length>100)fail('MERCHANT_KEY_UNAVAILABLE');
  const matching=keys.filter(k=>k?.kid===header.kid);
  if(!matching.length)fail('MERCHANT_KEY_UNAVAILABLE');
  const key=matching[0];
  if(matching.length!==1||key.kty!=='EC'||key.crv!=='P-256'||key.d!==undefined
    ||(key.alg!==undefined&&key.alg!=='ES256')||(key.use!==undefined&&key.use!=='sig')
    ||(key.key_ops!==undefined&&(!Array.isArray(key.key_ops)||!key.key_ops.includes('verify'))))fail('MERCHANT_KEY_INVALID');
  const {ap2,...payload}=checkout;
  const canonical=ucpCanonicalJson(payload);
  let verified=false;
  try{verified=verify('sha256',Buffer.from(`${encoded}.${Buffer.from(canonical).toString('base64url')}`),
    {key:createPublicKey({key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'));}catch{fail('MERCHANT_SIGNATURE_INVALID');}
  if(!verified)fail('MERCHANT_SIGNATURE_INVALID');
  if(!/^[A-Z]{3}$/u.test(checkout.currency??'')||!['incomplete','requires_escalation','ready_for_complete','complete_in_progress','completed','canceled'].includes(checkout.status)
    ||!Array.isArray(checkout.line_items)||checkout.line_items.length<1||checkout.line_items.length>100
    ||checkout.line_items.some(l=>!identifier(l.id)||!identifier(l.item?.id)||!Number.isSafeInteger(l.quantity)||l.quantity<1||!integer(l.item?.price))
    ||new Set(checkout.line_items.map(l=>l.id)).size!==checkout.line_items.length
    ||!Array.isArray(checkout.totals)||checkout.totals.length>100)fail('CHECKOUT_CONTENT_INVALID');
  const totalArithmetic=calculateUcpTotalArithmetic(checkout.totals);
  const totals=checkout.totals.filter(t=>t.type==='total');
  if(totals.length!==1)fail('TOTAL_UNRESOLVED');
  const checkedAt=clock().toISOString();
  return {provider:'ucp',protocolVersion:UCP_READ_VERSION,checkoutId:checkout.id,status:checkout.status,
    currency:checkout.currency,totalMinor:totals[0].amount,totalArithmetic,checkedAt,merchantSignatureVerified:true,
    sourceSha256:hash(ucpCanonicalJson(checkout)),signedCheckout:structuredClone(checkout),
    sourceAuthority:'merchant-claims',instructionAuthority:false,
    priceExpiryVerified:false,allInTotalVerified:false,userMandateVerified:false,paymentReceiptVerified:false,
    orderAvailable:false,executionAuthority:false};
}

/** Public GET transport only; no credentials, redirects or write operation. */
export function createUcpReadClient({baseUrl,platformProfileUrl,authorizeRead=()=>false,ca,clock=()=>new Date()}={}) {
  const base=new URL(baseUrl),platform=new URL(platformProfileUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname.endsWith('/')
    ||platform.protocol!=='https:'||platform.username||platform.password||platform.search||platform.hash)fail('CONFIG_INVALID');
  const read=async(url,checkoutId=null)=>{
    if(await authorizeRead({action:'commerce.checkout.read',origin:base.origin,checkoutId})!==true)fail('READ_PERMISSION_REQUIRED');
    const body=await new Promise((resolve,reject)=>{
      const req=httpsRequest(url,{method:'GET',minVersion:'TLSv1.3',ca,
        headers:{accept:'application/json','UCP-Agent':`profile="${platform.href}"`}},res=>{
        if(res.statusCode!==200||!/^application\/json(?:;|$)/iu.test(res.headers['content-type']??'')) {
          res.resume();return reject(Object.assign(new Error('A_UCP_RESPONSE_INVALID'),{code:'A_UCP_RESPONSE_INVALID'}));
        }
        let size=0;const chunks=[];
        res.on('data',bytes=>{size+=bytes.length;if(size>512*1024){req.destroy(Object.assign(new Error('A_UCP_RESPONSE_TOO_LARGE'),{code:'A_UCP_RESPONSE_TOO_LARGE'}));}else chunks.push(bytes);});
        res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
      });
      const timeout=setTimeout(()=>req.destroy(Object.assign(new Error('A_UCP_RESPONSE_TIMEOUT'),{code:'A_UCP_RESPONSE_TIMEOUT'})),10000);
      req.on('close',()=>clearTimeout(timeout));req.on('error',reject);req.end();
    });
    if(await authorizeRead({action:'commerce.checkout.read',origin:base.origin,checkoutId})!==true)fail('READ_PERMISSION_REVOKED');
    return parseUcpJson(body);
  };
  const profile=()=>read(new URL('/.well-known/ucp',base));
  return Object.freeze({status:()=>({configured:true,orderAvailable:false,executionAuthority:false,providerVerified:false}),
    async discover(){return inspectUcpProfile(await profile(),{baseUrl:base.href});},
    async checkout(checkoutId){
      if(!identifier(checkoutId))fail('CHECKOUT_ID_INVALID');
      const current=await profile(),negotiation=inspectUcpProfile(current,{baseUrl:base.href});
      if(!negotiation.ap2Supported)fail('AP2_REQUIRED');
      const result=await read(`${base.href}/checkout-sessions/${checkoutId}`,checkoutId);
      // Fresh key discovery makes rotation/removal take effect even mid-read.
      const latest=await profile();
      if(!inspectUcpProfile(latest,{baseUrl:base.href}).ap2Supported)fail('SESSION_SECURITY_DOWNGRADE');
      return verifyUcpCheckout(result,latest,{checkoutId,clock});
    }});
}
