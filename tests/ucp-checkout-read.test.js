import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {createUcpReadClient,inspectUcpProfile,verifyUcpCheckout,parseUcpJson,ucpCanonicalJson,UCP_READ_VERSION as version} from '../packages/core/src/personal-operations/ucp-checkout-read.js';
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwk={...publicKey.export({format:'jwk'}),kid:'merchant-key',alg:'ES256',use:'sig'};
const caps={
 'dev.ucp.shopping.checkout':[{version}],
 'dev.ucp.common.payment.ap2_mandate':[{version,extends:'dev.ucp.shopping.checkout'}]
};
const profile=baseUrl=>({ucp:{version,capabilities:structuredClone(caps),services:{'dev.ucp.shopping':[{version,transport:'rest',endpoint:baseUrl}]}},keys:[structuredClone(jwk)]});
function checkout(mutate=()=>{}) {
 const data={ucp:{version,capabilities:structuredClone(caps)},id:'chk_contract',status:'ready_for_complete',currency:'KRW',
  line_items:[{id:'line_1',item:{id:'item_1',title:'계약 시험 제품',price:4000},quantity:2,totals:[{type:'total',amount:8000}]}],
  totals:[{type:'subtotal',amount:8000},{type:'tax',amount:800},{type:'fulfillment',amount:1200},{type:'total',amount:10000}],
  links:[{type:'terms_of_service',url:'https://merchant.example/terms'}],custom_field:'서명에 포함되어야 함'};
 mutate(data);
 const encoded=Buffer.from(JSON.stringify({alg:'ES256',kid:'merchant-key'})).toString('base64url');
 const sig=sign('sha256',Buffer.from(`${encoded}.${Buffer.from(ucpCanonicalJson(data)).toString('base64url')}`),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return {...data,ap2:{merchant_authorization:`${encoded}..${sig}`}};
}
test('AP2 quote signature covers complete checkout including unknown fields, exact total and source fingerprint',()=>{
 const data=checkout(),result=verifyUcpCheckout(data,profile('https://merchant.example/ucp/v1'),{checkoutId:data.id});
 assert.equal(result.totalMinor,10000);assert.equal(result.merchantSignatureVerified,true);
 assert.equal(result.orderAvailable,false);assert.equal(result.userMandateVerified,false);
 assert.equal(result.allInTotalVerified,false);assert.equal(result.sourceSha256.length,64);
 assert.equal(result.sourceAuthority,'merchant-claims');assert.equal(result.instructionAuthority,false);
 assert.deepEqual(result.signedCheckout,data);
 const reordered=JSON.parse(JSON.stringify(data,(key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value));
 assert.equal(verifyUcpCheckout(reordered,profile('https://merchant.example/ucp/v1'),{checkoutId:data.id}).sourceSha256,result.sourceSha256);
});
for(const [title,change,code] of [
 ['price tampering',d=>d.totals.at(-1).amount=1,'SIGNATURE_INVALID'],
 ['unknown member stripped',d=>delete d.custom_field,'SIGNATURE_INVALID'],
 ['protocol field stripped',d=>delete d.ucp.version,'SECURITY_DOWNGRADE'],
 ['signature removed',d=>delete d.ap2,'SIGNATURE_MISSING'],
 ['AP2 downgraded',d=>delete d.ucp.capabilities['dev.ucp.common.payment.ap2_mandate'],'SECURITY_DOWNGRADE'],
 ['different checkout',d=>d.id='chk_other','SECURITY_DOWNGRADE']
])test(title,()=>{const data=checkout();change(data);assert.throws(()=>verifyUcpCheckout(data,profile('https://merchant.example/ucp/v1'),{checkoutId:'chk_contract'}),new RegExp(code));});
for(const [title,change] of [
 ['removed key',p=>p.keys=[]],['duplicate key ID',p=>p.keys.push({...jwk})],
 ['encryption key',p=>p.keys[0].use='enc'],['private key in profile',p=>p.keys[0].d='should-never-arrive'],
 ['wrong key operations',p=>p.keys[0].key_ops=['encrypt']],['wrong algorithm',p=>p.keys[0].alg='EdDSA']
])test(title,()=>{const p=profile('https://merchant.example/ucp/v1');change(p);assert.throws(()=>verifyUcpCheckout(checkout(),p,{checkoutId:'chk_contract'}),/KEY_/u);});
for(const [title,change] of [
 ['fractional minor units',d=>d.totals.at(-1).amount=0.5],
 ['multiple total rows',d=>d.totals.push({type:'total',amount:10000})],
 ['negative quantity',d=>d.line_items[0].quantity=-1],
 ['unsafe total',d=>d.totals.at(-1).amount=Number.MAX_SAFE_INTEGER+1]
])test(title,()=>assert.throws(()=>verifyUcpCheckout(checkout(change),profile('https://merchant.example/ucp/v1'),{checkoutId:'chk_contract'}),/CONTENT_INVALID|TOTAL_UNRESOLVED/u));
test('I-JSON duplicate/unicode/numeric/depth and UTF-16 canonicalization contract',()=>{
 for(const text of ['{"id":1,"id":2}','{"id":1,"\\u0069d":2}','{"array":[{"x":1,"x":2}]}','{"number":1e400}','{"text":"\\ud800"}'])
  assert.throws(()=>parseUcpJson(Buffer.from(text)),/A_UCP_JSON/u);
 assert.deepEqual(parseUcpJson(Buffer.from('{"text":"key: value { \\\"id\\\" }","array":[1,2]}')).array,[1,2]);
 assert.throws(()=>ucpCanonicalJson(JSON.parse('['.repeat(40)+'0'+']'.repeat(40))),/DEPTH/u);
 assert.equal(ucpCanonicalJson({b:1,a:'가'}),'{"a":"가","b":1}');
});
test('profile version, endpoint and AP2 support are negotiated without following discovered URLs',()=>{
 const baseUrl='https://merchant.example/ucp/v1',p=profile(baseUrl);
 assert.equal(inspectUcpProfile(p,{baseUrl}).securityLocked,true);
 delete p.ucp.capabilities['dev.ucp.common.payment.ap2_mandate'];
 assert.equal(inspectUcpProfile(p,{baseUrl}).ap2Supported,false);
 assert.throws(()=>inspectUcpProfile(p,{baseUrl:'https://attacker.example'}),/ENDPOINT/u);
 p.ucp.version='2026-01-11';assert.throws(()=>inspectUcpProfile(p,{baseUrl}),/VERSION/u);
});

test('actual TLS1.3 merchant→Core HTTP quote read; revocation, key removal, downgrade, redirects and admin authorization',async t=>{
 const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
 let baseUrl,permission=true,body=checkout(),mode='normal',calls=[];
 const merchant=createServer({key:pem('server-key'),cert:pem('server'),minVersion:'TLSv1.3'},(req,res)=>{
  calls.push({method:req.method,path:req.url,tls:req.socket.getProtocol()});
  res.setHeader('content-type','application/json');
  if(mode==='redirect'){res.statusCode=302;res.setHeader('location','https://attacker.example');return res.end('{}');}
  if(req.url==='/.well-known/ucp'){
   const p=profile(baseUrl);
   if(mode==='removed-key')p.keys=[];
   if(mode==='no-ap2')delete p.ucp.capabilities['dev.ucp.common.payment.ap2_mandate'];
   return res.end(JSON.stringify(p));
  }
  if(mode==='revoked')permission=false;
  if(mode==='late-remove')mode='removed-key';
  res.end(JSON.stringify(body));
 });
 await new Promise(r=>merchant.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>merchant.close(r)));
 baseUrl=`https://127.0.0.1:${merchant.address().port}/ucp/v1`;
 const client=createUcpReadClient({baseUrl,platformProfileUrl:'https://platform.example/.well-known/ucp',ca:pem('ca'),authorizeRead:()=>permission});
 const admin='synthetic-ucp-admin';const core=createCoreServer(undefined,{adminToken:admin,ucpReadClient:client});
 await new Promise(r=>core.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>core.close(r)));
 const call=async(path,body,token=admin)=>fetch(`http://127.0.0.1:${core.address().port}/commerce/ucp/${path}`,{
  method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const start=calls.length;assert.equal((await call('checkout',{checkoutId:'chk_contract'},'wrong')).status,401);assert.equal(calls.length,start);
 assert.equal((await call('checkout',{checkoutId:'../../private'})).status,409);assert.equal(calls.length,start);
 assert.equal((await call('discover',{})).status,200);
 const good=await call('checkout',{checkoutId:'chk_contract'});assert.equal(good.status,200);assert.equal((await good.json()).totalMinor,10000);
 for(const [state,reason] of [['removed-key','KEY_UNAVAILABLE'],['late-remove','KEY_UNAVAILABLE'],['no-ap2','AP2_REQUIRED'],['redirect','RESPONSE_INVALID'],['revoked','READ_PERMISSION_REVOKED']]){
  permission=true;mode=state;const reply=await call('checkout',{checkoutId:'chk_contract'});
  assert.equal(reply.status,409,state);assert.match((await reply.json()).error.code,new RegExp(reason));
 }
 permission=false;const before=calls.length;assert.equal((await call('checkout',{checkoutId:'chk_contract'})).status,409);assert.equal(calls.length,before);
 assert.ok(calls.every(c=>c.method==='GET'&&c.tls==='TLSv1.3'));
 console.log(JSON.stringify({ucpReadEvidence:{observedAt:new Date().toISOString(),core:'actual-http',merchant:'actual-TLS1.3-synthetic',totalMinor:10000,methods:[...new Set(calls.map(c=>c.method))],requests:calls.length,externalWrites:0,mandateVerified:false,paymentVerified:false,cost:'unmeasured'}}));
});
