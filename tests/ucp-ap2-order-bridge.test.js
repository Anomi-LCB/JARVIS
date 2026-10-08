import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:https';
import {createPrivateKey,sign,createHash} from 'node:crypto';
import {IntegrationConnectorRegistry,IntegrationCredentialVault} from '../packages/core/src/personal-operations/integration-security.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {CommerceOrderCoordinator} from '../packages/core/src/personal-operations/commerce-order-coordinator.js';
import {createAp2SigningBroker,AP2_SIGN_CONNECTOR} from '../packages/core/src/personal-operations/ap2-signing-broker.js';
import {createUcpAp2OrderBridge} from '../packages/core/src/personal-operations/ucp-ap2-order-bridge.js';
import {ap2SdkDigest,createAp2AuthorizationVerifier} from '../packages/core/src/personal-operations/ap2-transaction-verifier.js';
import {ucpCanonicalJson,UCP_READ_VERSION as version} from '../packages/core/src/personal-operations/ucp-checkout-read.js';
const python=resolve('artifacts/ap2-runtime-20261006/Scripts/python.exe'),sdk=resolve('artifacts/ap2-sdk-20261006/code/sdk/python');
const enabled=process.platform==='win32'&&existsSync(python)&&existsSync(sdk);
const bridgeTest=(name,fn)=>test(name,{skip:enabled?false:'Actual Windows DPAPI and pinned SDK required; no live-contract evidence'},fn);
const raw=enabled?spawnSync(python,['-I',resolve('tests/fixtures/ap2-transaction-evidence.py'),sdk,'ucp-integration'],
 {encoding:'utf8',windowsHide:true,maxBuffer:1048576}):null;
if(raw&&raw.status!==0)throw Error('MERCHANT_FIXTURE_FAILED');
const source=raw?JSON.parse(raw.stdout):null;
const sha=v=>createHash('sha256').update(ucpCanonicalJson(v)).digest('hex');
bridgeTest('preorder verification requires matching signed payment instrument and nonce without claiming an order receipt',async()=>{
 const {checkoutId,checkoutJwt,checkoutMandate,paymentMandate}=source.cases.valid;
 const transaction=structuredClone(source.transaction);
 transaction.expected.instrumentId='synthetic-instrument';transaction.expected.instrumentType='credit';
 const v=createAp2AuthorizationVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256:ap2SdkDigest(sdk),resolveTransaction:()=>transaction});
 const proof=await v.verify({checkoutId,checkoutJwt,checkoutMandate,paymentMandate});
 assert.equal(proof.ucpFullNestingVerified,true);assert.equal(proof.orderId,undefined);assert.equal(proof.executionAuthority,false);
 transaction.expected.instrumentId='different-instrument';
 await assert.rejects(v.verify({checkoutId,checkoutJwt,checkoutMandate,paymentMandate}),/EVIDENCE_INVALID/);
 transaction.expected.instrumentId='synthetic-instrument';transaction.expected.paymentNonce='wrong-nonce';
 await assert.rejects(v.verify({checkoutId,checkoutJwt,checkoutMandate,paymentMandate}),/EVIDENCE_INVALID/);
});
function merchantSigned(value) {
 const {ap2,...body}=value;
 const header=Buffer.from(JSON.stringify({alg:'ES256',kid:'merchant'})).toString('base64url');
 const signature=sign('sha256',Buffer.from(`${header}.${Buffer.from(ucpCanonicalJson(body)).toString('base64url')}`),
  {key:createPrivateKey({key:source.merchantTestKeys.merchant,format:'jwk'}),dsaEncoding:'ieee-p1363'}).toString('base64url');
 return {...body,ap2:{merchant_authorization:`${header}..${signature}`}};
}
async function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'jarvis-ucp-sdk-')),dbPath=join(root,'db.sqlite'),vaultPath=join(root,'vault.dpapi.json');
 const stores=[];t.after(()=>{for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});});
 const store=new PersonalOperationsStore({dbPath});stores.push(store);
 const registry=new IntegrationConnectorRegistry(),vault=new IntegrationCredentialVault({path:vaultPath});
 const signerConnection=vault.save({connectorId:AP2_SIGN_CONNECTOR,providerAccountId:'synthetic-agent',authMethod:'os-broker',
  scopes:['mandate.sign'],grants:['commerce.mandate.sign'],credentials:{ap2AgentKey:JSON.stringify(source.signingMaterial.agentKey),
   ap2OpenCheckoutMandate:source.signingMaterial.openCheckoutMandate,ap2OpenPaymentMandate:source.signingMaterial.openPaymentMandate}});
 const state={posts:0,mode:'valid',completed:null,receipts:null,postTokens:null,quote:structuredClone(source.transaction.ucp.checkout)};
 let transaction=null,baseUrl;
 const tls=name=>readFileSync(resolve(`tests/fixtures/google-broker-tls/${name}.pem`));
 const profile=()=>({ucp:{version,capabilities:source.transaction.ucp.checkout.ucp.capabilities,
  services:{'dev.ucp.shopping':[{version,transport:'rest',endpoint:baseUrl}]}},keys:[source.transaction.keys.merchant]});
 const server=createServer({key:tls('server-key'),cert:tls('server'),minVersion:'TLSv1.3'},async(req,res)=>{
  try {
   res.setHeader('content-type','application/json');
   if(req.url==='/.well-known/ucp')return res.end(JSON.stringify(profile()));
   assert.equal(req.socket.getProtocol(),'TLSv1.3');
   if(req.method==='GET')return res.end(JSON.stringify(state.completed??state.quote));
   state.posts++;const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const bytes=Buffer.concat(chunks),body=JSON.parse(bytes);
   assert.equal(req.headers['content-digest'],`sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
   const checkoutMandate=body.ap2.checkout_mandate,paymentMandate=body.payment.instruments[0].credential.token;
   state.postTokens={checkoutMandate,paymentMandate};
   const verified=await createAp2AuthorizationVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256:ap2SdkDigest(sdk),resolveTransaction:()=>transaction})
    .verify({checkoutId:transaction.expected.checkoutId,checkoutJwt:transaction.checkoutJwt,checkoutMandate,paymentMandate});
   assert.equal(verified.ucpFullNestingVerified,true);
   const run=spawnSync(python,['-I',resolve('tests/fixtures/ap2-merchant-receipts.py'),sdk,resolve('packages/core/src/personal-operations/ap2-sdk-verifier.py')],
    {input:JSON.stringify({keys:transaction.keys,expected:transaction.expected,testKeys:source.merchantTestKeys,
      evidence:{checkoutJwt:transaction.checkoutJwt,checkoutMandate,paymentMandate},outcome:state.mode==='error-receipt'?'error':'valid'}),
     encoding:'utf8',windowsHide:true,maxBuffer:65536});
   assert.equal(run.status,0,'Merchant receipt issuance failed');state.receipts=JSON.parse(run.stdout);
   state.completed=merchantSigned({...state.quote,status:'completed',order:{id:'order_contract'},'dev.example.receipts':state.receipts});
   if(state.mode==='lost'){req.socket.destroy();return;}
   res.end(JSON.stringify(state.completed));
  } catch {res.statusCode=409;res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 baseUrl=`https://127.0.0.1:${server.address().port}/ucp/v1`;
 const signerOptions={registry,vault,pythonPath:python,sdkRoot:sdk,sdkSha256:ap2SdkDigest(sdk),
  resolveTransaction:()=>transaction,resolveConnection:()=>({connectionId:signerConnection.connectionId,expectedRevision:signerConnection.updatedAt})};
 const bridgeOptions={vault,registry,providerId:'test',baseUrl,platformProfileUrl:'https://platform.example/.well-known/ucp',ca:tls('ca'),
  pythonPath:python,sdkRoot:sdk,sdkSha256:ap2SdkDigest(sdk),resolveTransaction:()=>transaction,
  resolveInstrument:()=>({id:'synthetic-instrument',handler_id:'handler',type:'card'}),authorize:()=>true,
  resolveReceipts:({checkout})=>checkout['dev.example.receipts']};
 const rebuild=(s)=>{
  const temporary=new CommerceOrderCoordinator(s);
  const signer=createAp2SigningBroker({...signerOptions,budget:temporary.budget});
  const bridge=createUcpAp2OrderBridge({...bridgeOptions,store:s,signer});
  return {bridge,c:new CommerceOrderCoordinator(s,{adapter:bridge.adapter,resolveOrder:()=>order,authorize:()=>true,verifyReceipt:bridge.verifyReceipt})};
 };
 const initial=new CommerceOrderCoordinator(store),signer=createAp2SigningBroker({...signerOptions,budget:initial.budget});
 const bridge=createUcpAp2OrderBridge({...bridgeOptions,store,signer});
 const order={active:true,revision:'1',providerId:'test',binding:bridge.adapter.binding,checkoutId:'chk_contract',expiresAt:'2099-01-01T00:00:00Z',
  quoteEvidenceSha256:sha(state.quote),request:{action:'commerce.order',target:'provider:test',currency:'KRW',amountMinor:10000},
  expected:{orderId:'order_contract',currency:'KRW',totalMinor:10000}};
 const c=new CommerceOrderCoordinator(store,{adapter:bridge.adapter,resolveOrder:()=>order,authorize:()=>true,verifyReceipt:bridge.verifyReceipt});
 const mandate=store.createMandate({action:'commerce.order',target:'provider:test',currency:'KRW',maxAmountMinor:10000,
  validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
 c.budget.configure({mandateId:mandate.id,totalMinor:10000,maxCalls:1});
 const prepared=await c.prepare({mandateId:mandate.id,requestId:'integrated',checkoutId:order.checkoutId});
 transaction={...structuredClone(source.transaction),providerId:'test',reservationId:prepared.reservationId,
  checkoutJwt:source.cases.valid.checkoutJwt,checkoutJwtSha256:createHash('sha256').update(source.cases.valid.checkoutJwt).digest('hex')};
 transaction.expected.instrumentId='synthetic-instrument';transaction.expected.instrumentType='credit';
 transaction.ucp.instrument={id:'synthetic-instrument',handler_id:'handler',type:'card'};
 return {state,store,vault,vaultPath,c,bridge,id:prepared.reservationId,mandate,transaction,
  reopen:()=>{const s=new PersonalOperationsStore({dbPath});stores.push(s);return rebuild(s);}};
}
bridgeTest('DPAPI root -> SDK signing -> full preorder verification -> actual TLS POST -> two real signed receipts -> durable success',async t=>{
 const f=await fixture(t),result=await f.c.dispatch(f.id);
 assert.equal(result.receiptVerified,true);assert.equal(f.state.posts,1);assert.equal(result.fundsSettlementObserved,false);
 const stored=JSON.stringify(f.store.db.prepare('SELECT * FROM personal_ucp_mandate_cache').all())+JSON.stringify(result)+readFileSync(f.vaultPath,'utf8');
 for(const secret of [source.signingMaterial.agentKey.d,source.signingMaterial.openPaymentMandate,...Object.values(f.state.postTokens)])
  assert.equal(stored.includes(secret),false);
 assert.equal(f.store.db.prepare('SELECT state FROM personal_ap2_signing_attempts').get().state,'consumed');
 assert.equal(f.bridge.status().executionAuthority,false);
});
bridgeTest('committed POST response loss reopens SQLite/DPAPI/brokers and verifies SDK receipts without signing or posting twice',async t=>{
 const f=await fixture(t);f.state.mode='lost';await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);
 assert.equal(f.state.posts,1);assert.equal(f.store.db.prepare('SELECT state FROM personal_ap2_signing_attempts').get().state,'uncertain');
 f.store.revokeMandate(f.mandate.id);
 const next=f.reopen();assert.equal((await next.c.reconcile(f.id)).receiptVerified,true);
 await assert.rejects(next.c.dispatch(f.id),/NO_REDISPATCH/);assert.equal(f.state.posts,1);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_ap2_signing_attempts').get().n,1);
});
bridgeTest('validly signed payment Error never counts as completed order',async t=>{
 const f=await fixture(t);f.state.mode='error-receipt';await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);
 assert.equal(f.state.posts,1);assert.equal(f.c.get(f.id).receiptVerified,false);
 await assert.rejects(f.c.reconcile(f.id));assert.equal(f.c.get(f.id).state,'uncertain');
});
bridgeTest('different current quote is refused before POST and protected-cache tampering cannot be reconciled',async t=>{
 const f=await fixture(t);f.state.quote=merchantSigned({...f.state.quote,'dev.example.terms':{return_window_days:0}});
 await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);assert.equal(f.state.posts,0);
 const g=await fixture(t);g.state.mode='lost';await assert.rejects(g.c.dispatch(g.id));
 const row=g.store.db.prepare('SELECT connection_id FROM personal_ucp_mandate_cache').get();
 g.vault.remove(row.connection_id);
 await assert.rejects(g.c.reconcile(g.id));assert.equal(g.state.posts,1);assert.equal(g.c.get(g.id).receiptVerified,false);
});
bridgeTest('AP2 bridge preserves the caller final commit fence through signing and TLS broker',async t=>{
 const f=await fixture(t);f.c.budget.begin(f.id);let fences=0;
 const row=f.store.db.prepare('SELECT idempotency_key FROM personal_commerce_orders WHERE reservation_id=?').get(f.id);
 await assert.rejects(f.bridge.adapter.complete({order:JSON.parse(f.store.db.prepare('SELECT order_json FROM personal_commerce_orders WHERE reservation_id=?').get(f.id).order_json),
  idempotencyKey:row.idempotency_key,beforeCommit:async()=>{fences++;return false;}}));
 assert.equal(fences,1);assert.equal(f.state.posts,0);
});
