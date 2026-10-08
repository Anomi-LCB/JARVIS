import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
const exec=promisify(execFile);
function fixture(t,{maxCalls=3}={}){const root=mkdtempSync(join(tmpdir(),'jarvis-budget-')),path=join(root,'db.sqlite');let now='2026-09-13T00:00:00Z';const store=new PersonalOperationsStore({dbPath:path,clock:()=>new Date(now)}),budget=new PersonalMandateBudget(store);
  const mandate=store.createMandate({action:'travel.quote',target:'provider:test',validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',currency:'KRW',maxAmountMinor:100});
  budget.configure({mandateId:mandate.id,totalMinor:100,maxCalls});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,path,store,budget,mandateId:mandate.id,advance:()=>{now='2100-01-01T00:00:00Z';}};
}
const request={action:'travel.quote',target:'provider:test',currency:'KRW',amountMinor:30};
const reserve=(f,id='request',patch={})=>f.budget.reserve({mandateId:f.mandateId,requestId:id,request:{...request,...patch}});
test('idempotent reservations reject changed intent and immutable limit expansion',t=>{
  const f=fixture(t),a=reserve(f);assert.equal(reserve(f).id,a.id);assert.equal(f.budget.summary(f.mandateId).usedOrHeldMinor,30);
  assert.throws(()=>reserve(f,'request',{amountMinor:31}),/CONFLICT/);assert.throws(()=>f.budget.configure({mandateId:f.mandateId,totalMinor:200,maxCalls:3}),/IMMUTABLE/);
  assert.equal(a.executionAuthority,false);assert.equal(a.providerChargeVerified,false);
});
test('10 actual CLI processes cannot oversubscribe a shared SQLite budget',async t=>{
  const f=fixture(t,{maxCalls:10});const results=await Promise.all(Array.from({length:10},async(_,i)=>{
    const input=join(f.root,`request-${i}.json`);writeFileSync(input,JSON.stringify({mandateId:f.mandateId,requestId:`parallel-${i}`,request}));
    try {const result=await exec(process.execPath,['scripts/personal-budget.mjs','reserve',input],{env:{...process.env,JARVIS_PERSONAL_OPERATIONS_DB:f.path},windowsHide:true});return {ok:true,data:JSON.parse(result.stdout)};}
    catch(error){return {ok:false,error:error.stderr};}
  }));
  assert.equal(results.filter(x=>x.ok).length,3,JSON.stringify(results));for(const failed of results.filter(x=>!x.ok))assert.match(failed.error,/A_BUDGET_LIMIT_EXCEEDED/);
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldMinor,90);assert.equal(f.budget.summary(f.mandateId).remainingCalls,7);
});
test('free requests still consume the independent call limit',t=>{
  const f=fixture(t);for(let i=0;i<3;i++)reserve(f,`free-${i}`,{amountMinor:0});
  assert.throws(()=>reserve(f,'free-4',{amountMinor:0}),/LIMIT_EXCEEDED/);assert.equal(f.budget.summary(f.mandateId).remainingMinor,100);
});
test('revocation and expiry stop dispatch after a reservation',t=>{
  const f=fixture(t),a=reserve(f);f.store.revokeMandate(f.mandateId);assert.throws(()=>f.budget.begin(a.id),/DENIED/);assert.equal(reserve(f).eligibleNow,false);f.budget.release(a.id);
  const g=fixture(t),b=reserve(g);g.advance();assert.throws(()=>g.budget.begin(b.id),/DENIED/);assert.throws(()=>reserve(g,'new'),/DENIED/);
});
test('uncertain execution retains budget across reopening and cannot be released or dispatched twice',t=>{
  const f=fixture(t),a=reserve(f);f.budget.begin(a.id);f.budget.uncertain(a.id);
  const reopened=new PersonalMandateBudget(f.store);assert.equal(reopened.get(a.id).state,'uncertain');assert.equal(reopened.summary(f.mandateId).usedOrHeldMinor,30);
  assert.throws(()=>reopened.release(a.id),/CANNOT_RELEASE/);assert.throws(()=>reopened.begin(a.id),/ALREADY_DISPATCHED/);
});
test('settlement is idempotent, bounded and recordable after revocation without authorizing another action',t=>{
  const f=fixture(t),a=reserve(f);f.budget.begin(a.id);f.store.revokeMandate(f.mandateId);
  assert.throws(()=>f.budget.settle({id:a.id,actualMinor:31,receiptRef:'receipt:test'}),/EXCEEDS/);
  const input={id:a.id,actualMinor:20,receiptRef:'receipt:test'};assert.equal(f.budget.settle(input).state,'settled');assert.equal(f.budget.settle(input).actual_minor,20);
  assert.equal(f.budget.summary(f.mandateId).remainingMinor,80);assert.throws(()=>f.budget.settle({...input,actualMinor:19}),/CONFLICT/);
});
test('unstarted cancellation releases capacity, but the same request key never opens a new reservation',t=>{
  const f=fixture(t),a=reserve(f);f.budget.release(a.id);assert.equal(reserve(f).state,'released');assert.equal(f.budget.summary(f.mandateId).remainingMinor,100);
  for(const amountMinor of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>reserve(f,'bad',{amountMinor}));
  assert.throws(()=>reserve(f,'wrong',{currency:'USD'}),/DENIED/);
});
test('HTTP budget access is authenticated and follows the real reservation ledger',async t=>{
  const f=fixture(t),server=createCoreServer(undefined,{adminToken:'budget-test',personalBudget:f.budget});const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${address.port}/personal-budgets/reserve`,body=JSON.stringify({mandateId:f.mandateId,requestId:'http',request});
  assert.equal((await fetch(url,{method:'POST',body})).status,401);
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer budget-test','content-type':'application/json'},body});assert.equal(response.status,200);assert.equal((await response.json()).executionAuthority,false);assert.equal(f.budget.summary(f.mandateId).usedOrHeldCalls,1);
});
