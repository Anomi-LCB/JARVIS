import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {IntegrationConnectorRegistry,IntegrationCredentialVault} from '../packages/core/src/personal-operations/integration-security.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {createAp2SigningBroker,AP2_SIGN_CONNECTOR} from '../packages/core/src/personal-operations/ap2-signing-broker.js';
import {ap2SdkDigest} from '../packages/core/src/personal-operations/ap2-transaction-verifier.js';
const python=resolve('artifacts/ap2-runtime-20261006/Scripts/python.exe'),sdk=resolve('artifacts/ap2-sdk-20261006/code/sdk/python');
const enabled=existsSync(python)&&existsSync(sdk);
const signingTest=(name,fn)=>test(name,{skip:enabled?false:'Pinned AP2 runtime absent; delegated signing unobserved'},fn);
const raw=enabled?spawnSync(python,['-I',resolve('tests/fixtures/ap2-transaction-evidence.py'),sdk,'signing'],
 {encoding:'utf8',windowsHide:true,maxBuffer:1048576}):null;
if(raw&&raw.status!==0)throw Error('SIGNING_FIXTURE_FAILED');
const data=raw?JSON.parse(raw.stdout):null;
function fixture(t,source=data) {
 const root=mkdtempSync(join(tmpdir(),'jarvis-ap2-sign-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const mandate=store.createMandate({action:'commerce.order',target:'provider:synthetic',currency:'KRW',maxAmountMinor:20000,
  validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
 const budget=new PersonalMandateBudget(store);budget.configure({mandateId:mandate.id,totalMinor:20000,maxCalls:1});
 const reservation=budget.reserve({mandateId:mandate.id,requestId:'sign',request:{action:'commerce.order',target:'provider:synthetic',currency:'KRW',amountMinor:10000}});
 budget.begin(reservation.id);
 const transaction={...structuredClone(source.transaction),profile:source.transaction.profile??'ap2-native-v1',providerId:'synthetic',reservationId:reservation.id};
 transaction.checkoutJwtSha256=createHash('sha256').update(source.cases.valid.checkoutJwt).digest('hex');
 transaction.expected.instrumentId='synthetic-instrument';transaction.expected.instrumentType='credit';
 const material=structuredClone(source.signingMaterial);
 const row={connectionId:'fixture',connectorId:AP2_SIGN_CONNECTOR,authMethod:'os-broker',updatedAt:'revision',
  scopes:['mandate.sign'],grants:['commerce.mandate.sign'],status:'credentials-stored-unverified'};
 let reads=0,lookups=0,hook=null;
 const vault={list:()=>row.status==='removed'?[]:[structuredClone(row)],withCredentials:async(id,callback)=>{
  reads++;return callback({ap2AgentKey:JSON.stringify(material.agentKey),ap2OpenCheckoutMandate:material.openCheckoutMandate,
   ap2OpenPaymentMandate:material.openPaymentMandate},structuredClone(row));}};
 const options={registry:new IntegrationConnectorRegistry(),vault,budget,pythonPath:python,sdkRoot:sdk,sdkSha256:ap2SdkDigest(sdk),
  resolveTransaction:()=>{lookups++;if(hook)hook(lookups);return transaction;},resolveConnection:()=>({connectionId:'fixture',expectedRevision:'revision'})};
 const signer=createAp2SigningBroker(options);
 return {store,mandate,budget,transaction,material,row,options,signer,reads:()=>reads,setHook:value=>{hook=value;},
  input:{checkoutId:transaction.expected.checkoutId,reservationId:reservation.id,checkoutJwt:source.cases.valid.checkoutJwt}};
}
signingTest('official SDK signs two distinct closed mandates only inside a live delegated financial reservation',async t=>{
 const f=fixture(t);let consumed=0;
 const result=await f.signer.withMandates(f.input,tokens=>{
  consumed++;assert.ok(tokens.checkoutMandate.includes('~~'));assert.ok(tokens.paymentMandate.includes('~~'));
  assert.notEqual(tokens.checkoutMandate,tokens.paymentMandate);assert.equal(tokens.ucpFullNestingVerified,false);
  return {consumed:true,profile:tokens.profile};
 });
 assert.deepEqual(result,{consumed:true,profile:'ap2-native-v1'});assert.equal(consumed,1);assert.equal(f.reads(),1);
 assert.equal(f.signer.status().executionAuthority,false);
 const rows=JSON.stringify(f.store.db.prepare('SELECT * FROM personal_budget_reservations').all());
 assert.equal(rows.includes(f.material.agentKey.d),false);assert.equal(rows.includes(f.material.openCheckoutMandate),false);
 const log=resolve(sdk,'../.logs/mandate_operations.log');assert.equal(existsSync(log),false);
});
function ucpFixture() {
 const result=spawnSync(python,['-I',resolve('tests/fixtures/ap2-transaction-evidence.py'),sdk,'ucp-signing'],
  {encoding:'utf8',windowsHide:true,maxBuffer:1048576});
 assert.equal(result.status,0,'UCP signing fixture failed');return JSON.parse(result.stdout);
}
signingTest('protected signer binds full UCP conditions and independent codec verifies generated nesting',async t=>{
 const source=ucpFixture(),f=fixture(t,source);
 const result=await f.signer.withMandates(f.input,tokens=>{
  assert.equal(tokens.ucpFullNestingVerified,true);assert.equal(tokens.profile,'ucp-full-v1');
  const observed=structuredClone(source);observed.cases.valid.checkoutMandate=tokens.checkoutMandate;
  const independent=spawnSync(python,['-I',resolve('tests/fixtures/ucp-ap2-independent.py'),resolve('artifacts/ucp-conformance-20261007')],
   {input:JSON.stringify(observed),encoding:'utf8',windowsHide:true,maxBuffer:65536});
  assert.equal(independent.status,0);const evidence=JSON.parse(independent.stdout);
  assert.equal(evidence.fixtureResults.valid.nested,true);assert.equal(evidence.fixtureResults.valid.frozen,true);
  return {ucpNestingObserved:true};
 });
 assert.deepEqual(result,{ucpNestingObserved:true});assert.equal(f.reads(),1);
});
signingTest('UCP missing or changed conditions never reach the signing key even with an approved raw JWT hash',async t=>{
 const source=ucpFixture();
 for(const variant of ['ucp-missing-authorization','ucp-tampered-terms','ucp-changed-terms']) {
  const f=fixture(t,source);f.input.checkoutJwt=source.cases[variant].checkoutJwt;
  f.transaction.checkoutJwtSha256=createHash('sha256').update(f.input.checkoutJwt).digest('hex');
  let used=0;await assert.rejects(f.signer.withMandates(f.input,()=>{used++;return {};}));
  assert.equal(f.reads(),0);assert.equal(used,0);
 }
});
signingTest('merchant key removal after SDK signing blocks UCP token consumption',async t=>{
 const f=fixture(t,ucpFixture());f.setHook(count=>{if(count>1)f.transaction.ucp.profile.keys=[];});
 let used=0;await assert.rejects(f.signer.withMandates(f.input,()=>{used++;return {};}),/TRANSACTION_CHANGED/);
 assert.equal(used,0);
});
for(const condition of ['revoked','unstarted','settled','wrong-provider','wrong-currency','wrong-amount','ucp-profile','removed-connection'])
 signingTest(`no private key access without current scoped consent: ${condition}`,async t=>{
  const f=fixture(t);
  if(condition==='revoked')f.store.revokeMandate(f.mandate.id);
  if(condition==='unstarted')f.store.db.prepare("UPDATE personal_budget_reservations SET state='reserved'").run();
  if(condition==='settled')f.budget.settle({id:f.input.reservationId,actualMinor:10000,receiptRef:'synthetic'});
  if(condition==='wrong-provider')f.transaction.providerId='other';
  if(condition==='wrong-currency')f.transaction.expected.currency='USD';
  if(condition==='wrong-amount')f.transaction.expected.totalMinor=9999;
  if(condition==='ucp-profile')f.transaction.profile='ucp-full-checkout';
  if(condition==='removed-connection')f.row.status='removed';
  let consumed=0;await assert.rejects(f.signer.withMandates(f.input,()=>{consumed++;return {}; }));
  assert.equal(f.reads(),0);assert.equal(consumed,0);
 });
for(const condition of ['wrong-agent','wrong-root-key','tampered-checkout','root-budget','root-payee'])
 signingTest(`SDK rejects invalid signer/merchant/root constraints: ${condition}`,async t=>{
  const f=fixture(t);
  if(condition==='wrong-agent')f.material.agentKey.d='A'.repeat(43);
  if(condition==='wrong-root-key')f.transaction.keys.checkoutIssuer=f.transaction.keys.merchant;
  if(condition==='tampered-checkout')f.input.checkoutJwt=f.input.checkoutJwt.slice(0,-8)+'ABCDEFGH';
  if(condition==='root-budget'){
   f.transaction.expected.totalMinor=13000;
   f.store.db.prepare("UPDATE personal_budget_reservations SET request_json=?,amount_minor=13000").run(JSON.stringify({action:'commerce.order',target:'provider:synthetic',currency:'KRW',amountMinor:13000}));
  }
  if(condition==='root-payee')f.transaction.expected.merchantId='unapproved-merchant';
  let consumed=0;await assert.rejects(f.signer.withMandates(f.input,()=>{consumed++;return {};}));assert.equal(consumed,0);
 });
signingTest('transaction revision or consent revocation after signing stops token consumption',async t=>{
 for(const mode of ['revision','revocation']) {
  const f=fixture(t);f.setHook(lookups=>{if(lookups>1){if(mode==='revision')f.transaction.revision='changed';else f.store.revokeMandate(f.mandate.id);}});
  let consumed=0;await assert.rejects(f.signer.withMandates(f.input,()=>{consumed++;return {};}));assert.equal(consumed,0);
 }
});
signingTest('consumer cannot return private key or generated mandates as a public result',async t=>{
 const f=fixture(t);
 await assert.rejects(f.signer.withMandates(f.input,tokens=>({token:tokens.paymentMandate})),/SECRET_RESULT_DENIED/);
 const g=fixture(t);
 await assert.rejects(g.signer.withMandates(g.input,()=>({key:g.material.agentKey.d})),/SECRET_RESULT_DENIED/);
});
signingTest('two signing workers cannot issue twice for one financial reservation',async t=>{
 const f=fixture(t),other=createAp2SigningBroker(f.options);let consumed=0;
 const results=await Promise.allSettled([f.signer,other].map(s=>s.withMandates(f.input,()=>{consumed++;return {};})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(consumed,1);assert.equal(f.reads(),1);
});
signingTest('failed or lost token consumption remains durable and prevents resigning after broker reconstruction',async t=>{
 const f=fixture(t);await assert.rejects(f.signer.withMandates(f.input,()=>{throw Error('lost');}));
 const other=createAp2SigningBroker(f.options),reads=f.reads();
 await assert.rejects(other.withMandates(f.input,()=>({})),/RECONCILIATION_REQUIRED/);assert.equal(f.reads(),reads);
 assert.equal(f.store.db.prepare('SELECT state FROM personal_ap2_signing_attempts').get().state,'uncertain');
});
signingTest('Windows DPAPI protected agent key and user roots sign in the isolated SDK child without plaintext storage',async t=>{
 const f=fixture(t),path=join(tmpdir(),`jarvis-ap2-protected-${f.input.reservationId}.json`);
 t.after(()=>rmSync(path,{force:true}));
 const vault=new IntegrationCredentialVault({path});
 const saved=vault.save({connectorId:AP2_SIGN_CONNECTOR,providerAccountId:'synthetic-agent',authMethod:'os-broker',
  scopes:['mandate.sign'],grants:['commerce.mandate.sign'],credentials:{ap2AgentKey:JSON.stringify(f.material.agentKey),
   ap2OpenCheckoutMandate:f.material.openCheckoutMandate,ap2OpenPaymentMandate:f.material.openPaymentMandate}});
 const signer=createAp2SigningBroker({...f.options,vault,resolveConnection:()=>({connectionId:saved.connectionId,expectedRevision:saved.updatedAt})});
 const disk=readFileSync(path,'utf8'),listing=JSON.stringify(vault.list());
 for(const secret of [f.material.agentKey.d,f.material.openCheckoutMandate,f.material.openPaymentMandate]) {
  assert.equal(disk.includes(secret),false);assert.equal(listing.includes(secret),false);
 }
 assert.deepEqual(await signer.withMandates(f.input,()=>({verified:true})),{verified:true});
 assert.equal(existsSync(resolve(sdk,'../.logs/mandate_operations.log')),false);
});
