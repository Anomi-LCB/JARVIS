import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {CommerceOrderCoordinator} from '../packages/core/src/personal-operations/commerce-order-coordinator.js';
import {createAp2TransactionVerifier,ap2SdkDigest} from '../packages/core/src/personal-operations/ap2-transaction-verifier.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
const python=resolve('artifacts/ap2-runtime-20261006/Scripts/python.exe');
const sdk=resolve('artifacts/ap2-sdk-20261006/code/sdk/python');
const enabled=existsSync(python)&&existsSync(sdk);
const ap2Test=(name,fn)=>test(name,{skip:enabled?false:'Pinned isolated AP2 SDK/Python runtime not installed; no protocol evidence'},fn);
const run=enabled?spawnSync(python,['-I',resolve('tests/fixtures/ap2-transaction-evidence.py'),sdk],{encoding:'utf8',windowsHide:true,maxBuffer:1048576}):null;
if(run&&run.status!==0)throw new Error(`AP2_FIXTURE_FAILED: ${run.stderr}`);
const fixture=run?JSON.parse(run.stdout):{transaction:{},cases:Object.fromEntries(['valid','expired','missing-exp','wrong-amount','wrong-order','error-receipt','wrong-issuer','future-receipt','wrong-reference','wrong-vct'].map(k=>[k,null]))};
const sdkSha256=enabled?ap2SdkDigest(sdk):null;
function setup(change=()=>{}) {
 const transaction=structuredClone(fixture.transaction);change(transaction);
 return createAp2TransactionVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256,resolveTransaction:()=>transaction});
}
ap2Test('official SDK closed checkout/payment chains and both signed receipts match trusted transaction',async()=>{
 const result=await setup().verify(fixture.cases.valid);
 assert.equal(result.verified,true);assert.equal(result.totalMinor,10000);assert.equal(result.orderId,'order_contract');
 assert.equal(result.executionAuthority,false);assert.equal(result.fundsSettlementObserved,false);
 assert.equal(result.instructionAuthority,false);assert.equal(Object.keys(result.evidenceSha256).length,5);
 console.log(JSON.stringify({ap2TransactionEvidence:{observedAt:new Date().toISOString(),protocol:'official SDK pinned source',sdkSha256,
  orderId:result.orderId,totalMinor:result.totalMinor,mandateReferences:result.mandateReferences,
  syntheticAuthorization:true,externalWrites:0,settlementObserved:false,cost:'unmeasured'}}));
});
for(const variant of Object.keys(fixture.cases).filter(k=>k!=='valid'))
 ap2Test(`reject cryptographically signed but invalid transaction: ${variant}`,async()=>{
  await assert.rejects(setup().verify(fixture.cases[variant]),/A_AP2_TRANSACTION_EVIDENCE_INVALID/);
 });
for(const [label,change] of [
 ['wrong audience',t=>t.expected.checkoutAudience='other.example'],
 ['wrong nonce',t=>t.expected.paymentNonce='other-challenge'],
 ['different item',t=>t.expected.lineItems[0].itemId='sku_other'],
 ['different quantity',t=>t.expected.lineItems[0].quantity=2],
 ['different unit price',t=>t.expected.lineItems[0].unitPriceMinor=7999],
 ['different currency',t=>t.expected.currency='USD']
])ap2Test(label,async()=>assert.rejects(setup(change).verify(fixture.cases.valid),/A_AP2_TRANSACTION_EVIDENCE_INVALID/));
ap2Test('request cannot override trusted consent, private keys are forbidden, and SDK pin is mandatory',async()=>{
 await assert.rejects(setup().verify({...fixture.cases.valid,expected:fixture.transaction.expected}),/REQUEST_INVALID/);
 await assert.rejects(setup(t=>t.keys.merchant.d='private').verify(fixture.cases.valid),/TRUST_KEYS_INVALID/);
 await assert.rejects(setup(t=>t.active=false).verify(fixture.cases.valid),/TRUSTED_TRANSACTION_REQUIRED/);
 assert.throws(()=>createAp2TransactionVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256:'0'.repeat(64)}),/SDK_PIN_MISMATCH/);
 assert.throws(()=>createAp2TransactionVerifier({pythonPath:python+'.missing',sdkRoot:sdk,sdkSha256}),/RUNTIME_UNAVAILABLE/);
});
ap2Test('transaction revision or revocation during SDK verification prevents result acceptance',async()=>{
 let lookups=0;
 const verifier=createAp2TransactionVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256,resolveTransaction:()=>{
  const value=structuredClone(fixture.transaction);if(++lookups>1)value.revision='changed';return value;
 }});
 await assert.rejects(verifier.verify(fixture.cases.valid),/TRUSTED_TRANSACTION_CHANGED/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(setup().verify(fixture.cases.valid,{signal:controller.signal}),e=>e.name==='AbortError');
});
ap2Test('result acceptance rechecks expiry and backwards clock after the isolated verifier returns',async()=>{
 for(const [delta,reason] of [[3600000,'EVIDENCE_EXPIRED'],[-3600000,'CLOCK_CHANGED']]) {
  let reads=0;const now=Date.now();
  const verifier=createAp2TransactionVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256,
    resolveTransaction:()=>fixture.transaction,clock:()=>new Date(now+(reads++?delta:0))});
  await assert.rejects(verifier.verify(fixture.cases.valid),new RegExp(reason));
 }
});
ap2Test('wrong public trust root and changed receipt bytes are rejected',async()=>{
 await assert.rejects(setup(t=>t.keys.psp=t.keys.merchant).verify(fixture.cases.valid),/TRANSACTION_EVIDENCE_INVALID/);
 const input=structuredClone(fixture.cases.valid),parts=input.paymentReceipt.split('.');
 parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);input.paymentReceipt=parts.join('.');
 await assert.rejects(setup().verify(input),/TRANSACTION_EVIDENCE_INVALID/);
});
ap2Test('actual Core API verifies SDK evidence and admin boundary',async t=>{
 const admin='synthetic-ap2-admin';const core=createCoreServer(undefined,{adminToken:admin,ap2TransactionVerifier:setup()});
 await new Promise(r=>core.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>core.close(r)));
 const call=(input,token=admin)=>fetch(`http://127.0.0.1:${core.address().port}/commerce/ap2/verify`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
 assert.equal((await call(fixture.cases.valid,'wrong')).status,401);
 const result=await call(fixture.cases.valid);assert.equal(result.status,200);assert.equal((await result.json()).verified,true);
 const bad=await call(fixture.cases['error-receipt']);assert.equal(bad.status,409);assert.equal((await bad.json()).error.code,'A_AP2_TRANSACTION_EVIDENCE_INVALID');
});
test('actual Core API leaves absent AP2 runtime unconfigured instead of authorizing a transaction',async t=>{
 const admin='synthetic-ap2-unconfigured';const core=createCoreServer(undefined,{adminToken:admin});
 await new Promise(r=>core.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>core.close(r)));
 const base=`http://127.0.0.1:${core.address().port}/commerce/ap2`;
 const status=await fetch(base+'/status',{headers:{authorization:`Bearer ${admin}`}});
 assert.equal(status.status,200);assert.equal((await status.json()).configured,false);
 const verify=await fetch(base+'/verify',{method:'POST',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},body:'{}'});
 assert.equal(verify.status,503);assert.equal((await verify.json()).error.code,'A_AP2_VERIFIER_NOT_CONFIGURED');
});

ap2Test('durable order response loss reconciles with real SDK signatures instead of supplier success claims',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-ap2-order-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const expected=fixture.transaction.expected;
 const order={active:true,revision:'1',providerId:'synthetic',binding:{endpoint:'isolated:ap2',version:'1'},
   checkoutId:expected.checkoutId,expiresAt:new Date(Date.now()+60000).toISOString(),quoteEvidenceSha256:'c'.repeat(64),
   request:{action:'commerce.order',target:'provider:synthetic',currency:expected.currency,amountMinor:expected.totalMinor},
   expected:{orderId:expected.orderId,currency:expected.currency,totalMinor:expected.totalMinor}};
 const mandate=store.createMandate({action:'commerce.order',target:'provider:synthetic',currency:expected.currency,maxAmountMinor:expected.totalMinor,
   validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
 let calls=0,receipt=fixture.cases['error-receipt'];const verifier=setup();
 const coordinator=new CommerceOrderCoordinator(store,{resolveOrder:()=>order,authorize:()=>true,
   adapter:{providerId:order.providerId,binding:order.binding,complete:async()=>{calls++;throw Error('response lost');},lookup:async()=>receipt},
   verifyReceipt:async input=>{const result=await verifier.verify(input);return {...result,receiptRef:`ap2:${result.evidenceSha256.checkoutReceipt}`,
     evidenceSha256:createHash('sha256').update(JSON.stringify(result.evidenceSha256)).digest('hex')};}});
 coordinator.budget.configure({mandateId:mandate.id,totalMinor:expected.totalMinor,maxCalls:1});
 const prepared=await coordinator.prepare({mandateId:mandate.id,requestId:'sdk-recovery',checkoutId:expected.checkoutId});
 await assert.rejects(coordinator.dispatch(prepared.reservationId),/UNCERTAIN/);
 await assert.rejects(coordinator.reconcile(prepared.reservationId),/TRANSACTION_EVIDENCE_INVALID/);
 assert.equal(coordinator.get(prepared.reservationId).receiptVerified,false);
 receipt=fixture.cases.valid;store.revokeMandate(mandate.id);
 assert.equal((await coordinator.reconcile(prepared.reservationId)).receiptVerified,true);
 await assert.rejects(coordinator.dispatch(prepared.reservationId),/NO_REDISPATCH/);assert.equal(calls,1);
});
