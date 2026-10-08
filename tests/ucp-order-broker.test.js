import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {IntegrationConnectorRegistry,IntegrationCredentialVault} from '../packages/core/src/personal-operations/integration-security.js';
import {createUcpOrderBroker,registerUcpOrderConnector,UCP_ORDER_CONNECTOR} from '../packages/core/src/personal-operations/ucp-order-broker.js';
import {ucpCanonicalJson,verifyUcpCheckout,UCP_READ_VERSION as version} from '../packages/core/src/personal-operations/ucp-checkout-read.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {CommerceOrderCoordinator} from '../packages/core/src/personal-operations/commerce-order-coordinator.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {MissionExecutionAuthority} from '../packages/core/src/mission/mission-execution-authority.js';
import {MissionCommerceSourceGate} from '../packages/core/src/mission/mission-commerce-source-gate.js';
const caps={'dev.ucp.shopping.checkout':[{version}],'dev.ucp.common.payment.ap2_mandate':[{version,extends:'dev.ucp.shopping.checkout'}]};
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwk={...publicKey.export({format:'jwk'}),kid:'merchant',alg:'ES256'};
function signed(status='ready_for_complete',extra={}) {
 const value={ucp:{version,capabilities:caps},id:'checkout',status,currency:'KRW',line_items:[{id:'line',item:{id:'sku',price:100},quantity:1}],
  totals:[{type:'subtotal',amount:100},{type:'total',amount:100}],...(status==='completed'?{order:{id:'order'}}:{}),...extra};
 const header=Buffer.from(JSON.stringify({alg:'ES256',kid:'merchant'})).toString('base64url');
 const bytes=Buffer.from(`${header}.${Buffer.from(ucpCanonicalJson(value)).toString('base64url')}`);
 return {...value,ap2:{merchant_authorization:`${header}..${sign('sha256',bytes,{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}`}};
}
async function fixture(t,quoteOverrides={}) {
 const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
 const state={mode:'valid',posts:0,reads:0,secretReads:0,quote:signed('ready_for_complete',quoteOverrides),current:null,headers:null,body:null,policy:true,mandates:true,receipt:true,observerCalls:0};
 const secrets={apiKey:'synthetic-api-secret-value',ap2CheckoutMandate:'synthetic-checkout-mandate',ap2PaymentMandate:'synthetic-payment-mandate'};
 const row={connectionId:'fixture',connectorId:UCP_ORDER_CONNECTOR,authMethod:'os-broker',updatedAt:'revision',
  scopes:['checkout.read','checkout.complete'],grants:['commerce.checkout.read','commerce.order'],status:'credentials-stored-unverified'};
 let baseUrl;
 const profile=()=>({ucp:{version,capabilities:caps,services:{'dev.ucp.shopping':[{version,transport:'rest',endpoint:baseUrl}]}},keys:[jwk]});
 const server=createServer({key:pem('server-key'),cert:pem('server'),minVersion:'TLSv1.3'},async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/.well-known/ucp')return res.end(JSON.stringify(profile()));
  assert.equal(req.socket.getProtocol(),'TLSv1.3');
  assert.ok(req.headers['request-id']);assert.ok(req.headers['idempotency-key']);
  assert.equal(req.headers['x-api-key'],secrets.apiKey);
  if(req.method==='GET') {state.reads++;return res.end(JSON.stringify(state.current??state.quote));}
  state.posts++;state.headers=req.headers;
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);state.body=JSON.parse(bytes);
  assert.equal(req.headers['content-digest'],`sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
  state.current=signed('completed');
  if(state.mode==='lost'){req.socket.destroy();return;}
  if(state.mode==='redirect'){res.statusCode=302;res.setHeader('location','https://attacker.example');return res.end('{}');}
  if(state.mode==='pending')state.current=signed('complete_in_progress');
  if(state.mode==='wrong-total')state.current=signed('completed',{totals:[{type:'total',amount:101}]});
  if(state.mode==='echo')state.current=signed('completed',{echo:secrets.ap2PaymentMandate});
  res.end(JSON.stringify(state.current));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 baseUrl=`https://127.0.0.1:${server.address().port}/ucp/v1`;
 const vault={list:()=>row.status==='removed'?[]:[structuredClone(row)],withCredentials:async(id,callback)=>{
  state.secretReads++;return callback({...secrets},structuredClone(row));}};
 const proof={verified:true,checkoutId:'checkout',orderId:'order',currency:'KRW',totalMinor:100,receiptRef:'receipt',evidenceSha256:'a'.repeat(64)};
 const ref={connectionId:'fixture',expectedRevision:'revision',instrument:{id:'instrument',handler_id:'handler',type:'card'}};
 const broker=createUcpOrderBroker({registry:new IntegrationConnectorRegistry(),vault,providerId:'test',baseUrl,
  platformProfileUrl:'https://platform.example/.well-known/ucp',ca:pem('ca'),resolveBinding:()=>ref,authorize:async()=>{await state.onPolicy?.();return state.policy;},
  validateMandates:async({checkoutMandate,paymentMandate,checkout})=>{
   assert.equal(checkoutMandate,secrets.ap2CheckoutMandate);assert.equal(paymentMandate,secrets.ap2PaymentMandate);assert.equal(checkout.id,'checkout');return state.mandates;},
  observeReceipt:()=>{state.observerCalls++;return state.receipt?proof:null;}});
 const root=mkdtempSync(join(tmpdir(),'jarvis-ucp-order-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const quote=verifyUcpCheckout(state.quote,profile(),{checkoutId:'checkout'});
 const order={active:true,revision:'1',providerId:'test',binding:broker.adapter.binding,checkoutId:'checkout',expiresAt:'2099-01-01T00:00:00Z',quoteEvidenceSha256:quote.sourceSha256,
  request:{action:'commerce.order',target:'provider:test',currency:'KRW',amountMinor:100},expected:{orderId:'order',currency:'KRW',totalMinor:100}};
 const mandate=store.createMandate({action:'commerce.order',target:'provider:test',currency:'KRW',maxAmountMinor:100,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
 const c=new CommerceOrderCoordinator(store,{adapter:broker.adapter,resolveOrder:()=>order,authorize:()=>true,verifyReceipt:broker.verifyReceipt});
 c.budget.configure({mandateId:mandate.id,totalMinor:100,maxCalls:1});
 const prepared=await c.prepare({mandateId:mandate.id,requestId:'request',checkoutId:'checkout'});
 return {state,secrets,row,broker,store,root,c,order,id:prepared.reservationId};
}
test('signed quote with inconsistent fee/tax total never posts an order',async t=>{
 const f=await fixture(t,{totals:[{type:'subtotal',amount:100},{type:'tax',amount:10},{type:'total',amount:100}]});
 await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);assert.equal(f.state.posts,0);
 assert.equal(f.c.get(f.id).state,'uncertain');assert.equal(f.state.observerCalls,0);
});

test('real TLS1.3 complete sends separated mandates; coordinator stores only receipt hashes',async t=>{
 const f=await fixture(t),result=await f.c.dispatch(f.id);
 assert.equal(result.receiptVerified,true);assert.equal(f.state.posts,1);
 assert.equal(f.state.body.ap2.checkout_mandate,f.secrets.ap2CheckoutMandate);
 assert.equal(f.state.body.payment.instruments[0].credential.token,f.secrets.ap2PaymentMandate);
 assert.equal(f.state.headers['ucp-agent'],'profile="https://platform.example/.well-known/ucp"');
 const stored=JSON.stringify(f.store.db.prepare('SELECT * FROM personal_commerce_orders').all())+JSON.stringify(result);
 for(const token of Object.values(f.secrets))assert.equal(stored.includes(token),false);
 assert.equal(result.fundsSettlementObserved,false);assert.equal(f.broker.withCredentials,undefined);
});
test('socket loss after supplier commits reconciles via GET without a second POST',async t=>{
 const f=await fixture(t);f.state.mode='lost';await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);
 assert.equal(f.c.get(f.id).state,'uncertain');assert.equal(f.state.posts,1);
 assert.equal((await f.c.reconcile(f.id)).receiptVerified,true);await assert.rejects(f.c.dispatch(f.id),/NO_REDISPATCH/);
 assert.equal(f.state.posts,1);
});
for(const mode of ['redirect','pending','wrong-total','echo'])test(`invalid completion stays uncertain: ${mode}`,async t=>{
 const f=await fixture(t);f.state.mode=mode;await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);
 assert.equal(f.c.get(f.id).receiptVerified,false);assert.equal(f.c.budget.summary(f.store.db.prepare('SELECT id FROM personal_mandates').get().id).usedOrHeldMinor,100);
 assert.equal(f.state.posts,1);if(mode==='echo')assert.equal(f.state.observerCalls,0);
});
for(const condition of ['policy','mandates','revocation','changed-quote'])test(`no POST for unavailable prerequisite: ${condition}`,async t=>{
 const f=await fixture(t);
 if(condition==='policy')f.state.policy=false;
 if(condition==='mandates')f.state.mandates=false;
 if(condition==='revocation')f.row.status='removed';
 if(condition==='changed-quote')f.state.quote=signed('ready_for_complete',{unexpected:'new'});
 await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);assert.equal(f.state.posts,0);
});
test('unsigned receipt claim and forged opaque proof cannot finish the order',async t=>{
 const f=await fixture(t);f.state.receipt=false;
 await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);assert.equal(f.c.get(f.id).receiptVerified,false);
 assert.throws(()=>f.broker.verifyReceipt({schemaVersion:'ucp-broker-proof-v1'},f.order),/PROOF_UNTRUSTED/);
});
test('actual Windows DPAPI protects the two mandate fields and list never discloses them',{skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-ap2-vault-')),path=join(root,'vault.dpapi.json');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const registry=new IntegrationConnectorRegistry();registerUcpOrderConnector(registry);
 const vault=new IntegrationCredentialVault({path});
 const credentials={ap2CheckoutMandate:'synthetic-checkout-mandate-secret',ap2PaymentMandate:'synthetic-payment-mandate-secret'};
 const saved=vault.save({connectorId:UCP_ORDER_CONNECTOR,providerAccountId:'synthetic-account',authMethod:'os-broker',
  scopes:['checkout.complete'],grants:['commerce.order'],credentials});
 const disk=readFileSync(path,'utf8'),listing=JSON.stringify(vault.list());
 for(const token of Object.values(credentials)){assert.equal(disk.includes(token),false);assert.equal(listing.includes(token),false);}
 await vault.withCredentials(saved.connectionId,actual=>assert.deepEqual(actual,credentials));
 assert.equal(registry.get(UCP_ORDER_CONNECTOR).capabilities[1].riskTier,'financial');
});

async function sourceBoundFixture(t){
 const f=await fixture(t),store=new SqliteMissionStore({operationsStore:f.store}),authority=new MissionExecutionAuthority({store});
 authority.activate({expectedToken:store.coreAuthorityStatus().token,heartbeat:false});
 const runtime=createAgRuntime({missionStore:store,missionExecutionAuthority:authority,allowedRoots:[f.root],auditRoot:join(f.root,'audit'),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}}).missionRuntime;
 t.after(()=>{authority.stopHeartbeat();runtime.coreFacade.cognition.close();});
 const m=runtime.createMission({objective:'총액 100원 이하로 주문을 준비해',successCriteria:['결과 확인']});
 f.c.budget.release(f.id);
 const mandate=f.store.db.prepare('SELECT id FROM personal_mandates').get().id;
 const c=new CommerceOrderCoordinator(f.store,{adapter:f.broker.adapter,resolveOrder:()=>f.order,authorize:()=>true,verifyReceipt:f.broker.verifyReceipt,
  missionSourceGate:new MissionCommerceSourceGate({runtime,operationsStore:f.store})});
 const prepared=await c.prepare({mandateId:mandate,requestId:'bound-source',checkoutId:'checkout',missionId:m.missionId});
 return {...f,c,id:prepared.reservationId,runtime,mission:runtime.missions.get(m.missionId)};
}

test('actual TLS signed quote and receipt remain bound to the original SQL Mission ceiling',async t=>{
 const f=await sourceBoundFixture(t),result=await f.c.dispatch(f.id);
 assert.equal(result.missionSourceBound,true);assert.equal(result.receiptVerified,true);assert.equal(f.state.posts,1);
 assert.notEqual(f.mission.status,'COMPLETED');assert.equal(result.fundsSettlementObserved,false);
});

test('SQL Mission correction inside UCP policy await is caught by final fence before actual TLS POST',async t=>{
 const f=await sourceBoundFixture(t);f.state.onPolicy=async()=>{await Promise.resolve();f.mission.goalContract.revision++;f.runtime.persist('synthetic-source-correction');};
 await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);
 assert.equal(f.state.posts,0);assert.equal(f.state.reads,1);assert.equal(f.state.observerCalls,0);
 assert.equal(f.c.get(f.id).state,'uncertain');assert.equal(f.c.get(f.id).receiptVerified,false);
});

test('TLS response loss preserves bound receipt observation after Mission cancellation without a second POST',async t=>{
 const f=await sourceBoundFixture(t);f.state.mode='lost';await assert.rejects(f.c.dispatch(f.id),/UNCERTAIN/);
 f.mission.status='CANCELLED';f.runtime.persist('synthetic-source-cancel');
 const reopened=new CommerceOrderCoordinator(f.store,{adapter:f.broker.adapter,verifyReceipt:f.broker.verifyReceipt});
 assert.equal((await reopened.reconcile(f.id)).receiptVerified,true);await assert.rejects(reopened.dispatch(f.id),/NO_REDISPATCH/);
 assert.equal(f.state.posts,1);assert.equal(f.mission.status,'CANCELLED');
});
