import {createPublicKey,verify,createHash} from 'node:crypto';
import {parseUcpJson,ucpCanonicalJson,verifyUcpCheckout} from './ucp-checkout-read.js';
const fail=code=>{throw Object.assign(new Error(`A_UCP_AP2_${code}`),{code:`A_UCP_AP2_${code}`});};
const sha=value=>createHash('sha256').update(value).digest('hex');

/** Merchant-only binding check. A successful result does not authorize a user,
 * payment or execution; pair it with the pinned AP2 chain/receipt verifier. */
export function verifyUcpAp2CheckoutBinding({checkoutJwt,checkout,profile,clock=()=>new Date()}) {
  if(typeof checkoutJwt!=='string'||checkoutJwt.length>262144
    ||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/u.test(checkoutJwt))fail('JWT_INVALID');
  const [encoded,payload,signature]=checkoutJwt.split('.');
  const header=parseUcpJson(Buffer.from(encoded,'base64url'));
  if(!header||Array.isArray(header)||typeof header!=='object'||header.alg!=='ES256'||typeof header.kid!=='string'
    ||Object.keys(header).some(k=>!['alg','kid','typ'].includes(k)))fail('JWT_HEADER_INVALID');
  const keys=Array.isArray(profile?.keys)?profile.keys.filter(k=>k?.kid===header.kid):null;
  if(!Array.isArray(keys)||keys.length!==1)fail('MERCHANT_KEY_UNAVAILABLE');
  const key=keys[0];
  if(key.kty!=='EC'||key.crv!=='P-256'||key.d!==undefined||key.use&&key.use!=='sig'
    ||key.alg&&key.alg!=='ES256'||key.key_ops&&(!Array.isArray(key.key_ops)||!key.key_ops.includes('verify')))fail('MERCHANT_KEY_INVALID');
  let valid=false;
  try {valid=verify('sha256',Buffer.from(`${encoded}.${payload}`),
    {key:createPublicKey({key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'));}
  catch {fail('JWT_SIGNATURE_INVALID');}
  if(!valid)fail('JWT_SIGNATURE_INVALID');
  const embedded=parseUcpJson(Buffer.from(payload,'base64url'));
  // Do not project through the SDK's generated Checkout model: unknown terms,
  // fulfillment, extensions and the inner merchant authorization must survive.
  const result=verifyUcpCheckout(embedded,profile,{checkoutId:checkout?.id,clock});
  const approved=verifyUcpCheckout(checkout,profile,{checkoutId:checkout?.id,clock});
  if(ucpCanonicalJson(embedded)!==ucpCanonicalJson(checkout))fail('FULL_CHECKOUT_CHANGED');
  return {ucpFullNestingVerified:true,merchantSignatureVerified:true,
    checkoutSourceSha256:approved.sourceSha256,checkoutJwtSha256:sha(checkoutJwt),
    checkoutId:result.checkoutId,protocolVersion:result.protocolVersion,
    userMandateVerified:false,executionAuthority:false};
}
