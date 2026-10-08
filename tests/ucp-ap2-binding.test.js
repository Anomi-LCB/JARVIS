import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {createAp2TransactionVerifier,ap2SdkDigest} from '../packages/core/src/personal-operations/ap2-transaction-verifier.js';
import {verifyUcpAp2CheckoutBinding} from '../packages/core/src/personal-operations/ucp-ap2-binding.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
const python=resolve('artifacts/ap2-runtime-20261006/Scripts/python.exe');
const sdk=resolve('artifacts/ap2-sdk-20261006/code/sdk/python');
const enabled=existsSync(python)&&existsSync(sdk);
const run=enabled?spawnSync(python,['-I',resolve('tests/fixtures/ap2-transaction-evidence.py'),sdk,'ucp'],{encoding:'utf8',windowsHide:true,maxBuffer:1048576}):null;
if(run&&run.status!==0)throw Error('UCP_AP2_FIXTURE_FAILED');
const fixture=run?JSON.parse(run.stdout):null;
const sdkSha256=enabled?ap2SdkDigest(sdk):null;
const ap2Test=(name,fn)=>test(name,{skip:enabled?false:'Pinned isolated AP2 runtime absent; not protocol evidence'},fn);
const verifier=(change=()=>{})=>{const transaction=structuredClone(fixture.transaction);change(transaction);
 return createAp2TransactionVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256,resolveTransaction:()=>transaction});};
ap2Test('full UCP response including inner merchant signature binds to actual AP2 chains and both receipts',async()=>{
 const result=await verifier().verify(fixture.cases.valid);
 assert.equal(result.ucpFullNestingVerified,true);assert.equal(result.cryptographicEvidenceVerified,true);
 assert.equal(result.checkoutSourceSha256.length,64);assert.equal(result.executionAuthority,false);
 assert.equal(result.fundsSettlementObserved,false);
 const merchantOnly=verifyUcpAp2CheckoutBinding({checkoutJwt:fixture.cases.valid.checkoutJwt,...fixture.transaction.ucp});
 assert.equal(merchantOnly.userMandateVerified,false);
});
for(const variant of ['ucp-missing-authorization','ucp-tampered-terms','ucp-missing-extension','ucp-changed-terms'])
 ap2Test(`native SDK accepts valid outer signatures but full UCP binding rejects ${variant}`,async()=>{
  const native=await verifier(t=>{delete t.profile;delete t.ucp;}).verify(fixture.cases[variant]);
  assert.equal(native.verified,true);assert.equal(native.ucpFullNestingVerified,false);
  await assert.rejects(verifier().verify(fixture.cases[variant]),/A_UCP_(?:AP2_FULL_CHECKOUT_CHANGED|MERCHANT_SIGNATURE_)/);
 });
for(const variant of ['wrong-amount','wrong-order','error-receipt','wrong-reference','expired'])
 ap2Test(`valid UCP nesting still rejects AP2 transaction ${variant}`,async()=>{
  await assert.rejects(verifier().verify(fixture.cases[variant]),/TRANSACTION_EVIDENCE_INVALID/);
 });
ap2Test('host profile and approved complete checkout cannot be nominated by request',async()=>{
 await assert.rejects(verifier(t=>delete t.ucp).verify(fixture.cases.valid),/UCP_BINDING_REQUIRED/);
 await assert.rejects(verifier(t=>t.profile='claimed-standard').verify(fixture.cases.valid),/PROFILE_UNSUPPORTED/);
 await assert.rejects(verifier().verify({...fixture.cases.valid,ucp:fixture.transaction.ucp}),/REQUEST_INVALID/);
 await assert.rejects(verifier(t=>t.ucp.profile.keys=[]).verify(fixture.cases.valid),/KEY_UNAVAILABLE/);
});
ap2Test('merchant/profile revision changes while SDK executes invalidate nesting result',async()=>{
 let calls=0;
 const v=createAp2TransactionVerifier({pythonPath:python,sdkRoot:sdk,sdkSha256,resolveTransaction:()=>{
  const t=structuredClone(fixture.transaction);if(++calls>1)t.ucp.profile.keys=[];return t;
 }});
 await assert.rejects(v.verify(fixture.cases.valid),/TRUSTED_TRANSACTION_CHANGED/);
});
ap2Test('outer JWT tampering is rejected before any inner-content interpretation',()=>{
 const parts=fixture.cases.valid.checkoutJwt.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
 assert.throws(()=>verifyUcpAp2CheckoutBinding({checkoutJwt:parts.join('.'),...fixture.transaction.ucp}),/JWT_SIGNATURE_INVALID/);
});
ap2Test('independent community codec cross-checks our actual SDK chains and its immutable published nested vectors',()=>{
 const external=resolve('artifacts/ucp-conformance-20261007');
 assert.equal(existsSync(external),true,'Independent source unavailable; do not count as evidence');
 const commit=spawnSync('git',['-C',external,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});
 assert.equal(commit.stdout.trim(),'05f0693ccc82ad25abe85087d07cda3c94ce1bde');
 const source=spawnSync('git',['-C',external,'diff','--exit-code','HEAD','--','conformance'],{encoding:'utf8',windowsHide:true});
 assert.equal(source.status,0,'Do not replace oracle code with our implementation');
 const independent=spawnSync(python,['-I',resolve('tests/fixtures/ucp-ap2-independent.py'),external],
  {input:JSON.stringify(fixture),encoding:'utf8',windowsHide:true,maxBuffer:65536});
 assert.equal(independent.status,0,'Independent oracle failed');
 const result=JSON.parse(independent.stdout);
 assert.equal(result.officialConformance,false);assert.equal(result.userTrustVerified,false);
 for(const [name,expected] of Object.entries({valid:true,'ucp-missing-authorization':false,
   'ucp-tampered-terms':false,'ucp-missing-extension':false,'ucp-changed-terms':true})) {
  assert.equal(result.fixtureResults[name].frozen,true,name);
  assert.equal(result.fixtureResults[name].nested,expected,name);
 }
 for(const [name,value] of Object.entries(result.communityGoldenResults)) {
  assert.equal(value.frozen,true,name);assert.equal(value.nested,name==='valid',name);
 }
});
ap2Test('authenticated actual Core route returns full-nesting evidence and rejects stripped authorization',async t=>{
 const admin='synthetic-ucp-ap2-admin',core=createCoreServer(undefined,{adminToken:admin,ap2TransactionVerifier:verifier()});
 await new Promise(r=>core.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>core.close(r)));
 const call=(body,token=admin)=>fetch(`http://127.0.0.1:${core.address().port}/commerce/ap2/verify`,
  {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await call(fixture.cases.valid,'wrong')).status,401);
 const valid=await call(fixture.cases.valid);assert.equal(valid.status,200);
 const proof=await valid.json();assert.equal(proof.ucpFullNestingVerified,true);assert.equal(proof.executionAuthority,false);
 const bad=await call(fixture.cases['ucp-missing-authorization']);assert.equal(bad.status,409);
 // Core deliberately does not expose unknown underlying verifier exceptions.
 assert.equal((await bad.json()).error.code,'A_AP2_VERIFICATION_FAILED');
});
