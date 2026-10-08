import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {createUcpOrderBroker,UCP_ORDER_CONNECTOR} from '../packages/core/src/personal-operations/ucp-order-broker.js';
import {ucpCanonicalJson,verifyUcpCheckout,UCP_READ_VERSION as version} from '../packages/core/src/personal-operations/ucp-checkout-read.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {CommerceOrderCoordinator} from '../packages/core/src/personal-operations/commerce-order-coordinator.js';

test('TLS signed full-cost quotes reserve cumulative SQL budget; lost response stays held across reopen without a second POST',async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-ucp-total-budget-'));
 let store,server;
 try{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),keys=[{...publicKey.export({format:'jwk'}),kid:'cost-merchant',alg:'ES256',use:'sig'}];
  const caps={'dev.ucp.shopping.checkout':[{version}],'dev.ucp.common.payment.ap2_mandate':[{version,extends:'dev.ucp.shopping.checkout'}]};
  const completed=new Set(),posts=[],orders=new Map(),signedCache=new Map();let baseUrl;
  const profile=()=>({ucp:{version,capabilities:caps,services:{'dev.ucp.shopping':[{version,transport:'rest',endpoint:baseUrl}]}},keys});
  const signed=checkoutId=>{
   const cacheKey=`${checkoutId}:${completed.has(checkoutId)}`;
   if(signedCache.has(cacheKey))return structuredClone(signedCache.get(cacheKey));
   const data={ucp:{version,capabilities:caps},id:checkoutId,status:completed.has(checkoutId)?'completed':'ready_for_complete',currency:'KRW',
    line_items:[{id:'line',item:{id:'sku',price:8000},quantity:1}],
    totals:[{type:'subtotal',amount:8000},{type:'tax',amount:800},{type:'fulfillment',amount:1200},{type:'total',amount:10000}],
    ...(completed.has(checkoutId)?{order:{id:`order-${checkoutId}`}}:{})};
   const header=Buffer.from(JSON.stringify({alg:'ES256',kid:'cost-merchant'})).toString('base64url');
   const signature=sign('sha256',Buffer.from(`${header}.${Buffer.from(ucpCanonicalJson(data)).toString('base64url')}`),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
   const result={...data,ap2:{merchant_authorization:`${header}..${signature}`}};signedCache.set(cacheKey,result);return structuredClone(result);
  };
  const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
  server=createServer({key:pem('server-key'),cert:pem('server'),minVersion:'TLSv1.3'},async(req,res)=>{
   res.setHeader('content-type','application/json');assert.equal(req.socket.getProtocol(),'TLSv1.3');
   if(req.url==='/.well-known/ucp')return res.end(JSON.stringify(profile()));
   const match=/^\/ucp\/v1\/checkout-sessions\/(cost-[1-4])(?:\/complete)?$/u.exec(req.url);assert.ok(match);
   if(req.method==='POST'){
    for await(const _ of req){}posts.push({checkoutId:match[1],key:req.headers['idempotency-key']});completed.add(match[1]);
    if(match[1]==='cost-1'){req.socket.destroy();return;}
   }
   res.end(JSON.stringify(signed(match[1])));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));baseUrl=`https://127.0.0.1:${server.address().port}/ucp/v1`;
  const record={connectionId:'synthetic-cost',connectorId:UCP_ORDER_CONNECTOR,authMethod:'os-broker',updatedAt:'1',status:'credentials-stored-unverified',
   scopes:['checkout.read','checkout.complete'],grants:['commerce.checkout.read','commerce.order']};
  const vault={list:()=>[structuredClone(record)],withCredentials:async(_id,fn)=>{
   try{return await fn({ap2CheckoutMandate:'synthetic-checkout-mandate',ap2PaymentMandate:'synthetic-payment-mandate'},structuredClone(record));}
   catch(error){console.log(JSON.stringify({syntheticVaultCallbackError:error.code??'unclassified',posts:posts.length}));throw error;}
  }};
  const broker=createUcpOrderBroker({registry:new IntegrationConnectorRegistry(),vault,providerId:'synthetic-cost',baseUrl,platformProfileUrl:'https://platform.example/.well-known/ucp',ca:pem('ca'),
   resolveBinding:()=>({connectionId:record.connectionId,expectedRevision:record.updatedAt,instrument:{id:'instrument',handler_id:'handler',type:'card'}}),
   authorize:()=>true,validateMandates:()=>true,
   observeReceipt:({order})=>completed.has(order.checkoutId)?{verified:true,checkoutId:order.checkoutId,orderId:order.expected.orderId,currency:'KRW',totalMinor:10000,
    receiptRef:`synthetic-receipt:${order.checkoutId}`,evidenceSha256:createHash('sha256').update(order.checkoutId).digest('hex')}:null});
  for(let n=1;n<=4;n++){
   const checkoutId=`cost-${n}`,quote=verifyUcpCheckout(signed(checkoutId),profile(),{checkoutId});assert.equal(quote.totalArithmetic.verified,true);
   orders.set(checkoutId,{active:true,revision:'1',providerId:'synthetic-cost',binding:broker.adapter.binding,checkoutId,expiresAt:'2099-01-01T00:00:00Z',quoteEvidenceSha256:quote.sourceSha256,
    request:{action:'commerce.order',target:'provider:synthetic-cost',currency:'KRW',amountMinor:quote.totalMinor},expected:{orderId:`order-${checkoutId}`,currency:'KRW',totalMinor:quote.totalMinor}});
  }
  const database=join(root,'operations.sqlite');store=new PersonalOperationsStore({dbPath:database});
  const make=()=>new CommerceOrderCoordinator(store,{adapter:broker.adapter,resolveOrder:id=>structuredClone(orders.get(id)),authorize:()=>true,verifyReceipt:broker.verifyReceipt});
  let coordinator=make();
  const mandate=store.createMandate({action:'commerce.order',target:'provider:synthetic-cost',currency:'KRW',maxAmountMinor:10000,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
  coordinator.budget.configure({mandateId:mandate.id,totalMinor:30000,maxCalls:10});
  const prepare=n=>coordinator.prepare({mandateId:mandate.id,requestId:`request-${n}`,checkoutId:`cost-${n}`});
  const attempts=await Promise.allSettled([1,2,3,4].map(prepare));
  assert.deepEqual(attempts.map(x=>x.status),['fulfilled','fulfilled','fulfilled','rejected']);assert.match(attempts[3].reason.message,/BUDGET_LIMIT_EXCEEDED/);
  const [first,second,third]=attempts.slice(0,3).map(x=>x.value.reservationId);assert.equal(posts.length,0);
  await assert.rejects(coordinator.dispatch(first),/UNCERTAIN/);
  assert.equal(coordinator.get(first).state,'uncertain');assert.equal(coordinator.budget.summary(mandate.id).usedOrHeldMinor,30000);
  assert.equal((await coordinator.dispatch(second)).receiptVerified,true);assert.equal((await coordinator.dispatch(third)).receiptVerified,true);
  assert.equal(coordinator.budget.summary(mandate.id).usedOrHeldMinor,30000);await assert.rejects(prepare(4),/BUDGET_LIMIT_EXCEEDED/);
  store.close();store=new PersonalOperationsStore({dbPath:database});coordinator=make();
  assert.equal(coordinator.get(first).state,'uncertain');assert.equal((await prepare(1)).reservationId,first);
  await assert.rejects(coordinator.dispatch(first),/NO_REDISPATCH/);assert.equal(posts.length,3);
  assert.equal((await coordinator.reconcile(first)).receiptVerified,true);assert.equal(coordinator.budget.summary(mandate.id).usedOrHeldMinor,30000);
  assert.equal(new Set(posts.map(p=>p.key)).size,3);assert.equal(posts.filter(p=>p.checkoutId==='cost-1').length,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM personal_budget_reservations').get().count,3);
  console.log(JSON.stringify({ucpTotalBudgetEvidence:{actualTLS13:true,actualSQL:true,supplier:'synthetic',protectedMandates:'synthetic',trustedReceiptObserver:'synthetic',perQuoteMinor:10000,cumulativeMinor:30000,successfulReservations:3,deniedFourth:true,posts:3,lostResponsePosts:1,sqlReopen:true,fundsSettlementObserved:false,cost:'미측정'}}));
 }finally{
  store?.close();if(server)await new Promise(r=>server.close(r));
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-ucp-total-budget-'));rmSync(root,{recursive:true,force:true});
 }
});
