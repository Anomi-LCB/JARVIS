import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {fork} from 'node:child_process';
import {once} from 'node:events';

for(const mode of ['valid','revoked','expired','expired-clock-rollback','already-settled'])test(`claimed monetary effect rechecks before actual local dispatch ${mode}`,t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-budget-current-')),start=Date.parse('2026-10-07T00:00:00Z');let now=start;
 const options={dbPath:join(root,'operations.sqlite'),clock:()=>new Date(now)},operations=new PersonalOperationsStore(options);
 const store=new SqliteMissionStore({operationsStore:operations,clock:options.clock}),budget=new PersonalMandateBudget(operations);
 t.after(()=>{operations.close();rmSync(root,{recursive:true,force:true});});
 const mandate=operations.createMandate({action:'fixture.write',target:'fixture:local',currency:'KRW',maxAmountMinor:100,validFrom:'2020-01-01T00:00:00Z',expiresAt:new Date(start+100).toISOString()});
 budget.configure({mandateId:mandate.id,totalMinor:100,maxCalls:1});
 const request={action:'fixture.write',target:'fixture:local',currency:'KRW',amountMinor:30};
 const effect={effectId:'effect-one',operationId:'operation-one',missionId:'mission-one',request,budget:{mandateId:mandate.id,requestId:'budget-one',request}};
 store.save([{missionId:'mission-one',status:'READY'}],{effects:[effect]});
 const claim=store.claimEffect({effectId:effect.effectId,ownerId:'fixture-worker'}),saved=store.getEffect(effect.effectId);assert.ok(claim);
 const output=join(root,'effect.txt'),dispatch=()=>{store.assertEffectDispatch({effectId:effect.effectId,lease:claim.lease,requestSha256:saved.request_sha256});writeFileSync(output,'dispatched-once');};
 if(mode==='revoked')operations.revokeMandate(mandate.id);
 if(mode.startsWith('expired'))now=start+101;
 if(mode==='already-settled')budget.settle({id:saved.budget_reservation_id,actualMinor:20,receiptRef:'fixture:early-settlement'});
 if(mode==='valid'){
  dispatch();assert.equal(readFileSync(output,'utf8'),'dispatched-once');
  operations.revokeMandate(mandate.id);
  store.completeEffect({effectId:effect.effectId,lease:claim.lease,receipt:{receiptRef:'fixture:observed-after-dispatch'},actualMinor:20});
  assert.equal(store.getEffect(effect.effectId).state,'succeeded');assert.equal(budget.summary(mandate.id).usedOrHeldMinor,20);
 }else{
  assert.throws(dispatch,/A_DURABLE_(MANDATE|BUDGET)/);assert.equal(existsSync(output),false);
  if(mode==='expired-clock-rollback'){
   now=start+50;
   const other=new PersonalOperationsStore(options);try{
    const reopened=new SqliteMissionStore({operationsStore:other,clock:options.clock});
    assert.throws(()=>reopened.assertEffectDispatch({effectId:effect.effectId,lease:claim.lease,requestSha256:saved.request_sha256}),/A_DURABLE_MANDATE/);
   }finally{other.close();}
  }
  assert.equal(store.getEffect(effect.effectId).state,'in_flight');
  assert.equal(budget.summary(mandate.id).usedOrHeldCalls,1);assert.equal(budget.summary(mandate.id).usedOrHeldMinor,mode==='already-settled'?20:30);
 }
});

for(const revoked of [false,true])test(`separate OS worker observes monetary mandate revocation after claim: ${revoked}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-budget-worker-')),dbPath=join(root,'operations.sqlite'),start=Date.parse('2026-10-07T00:00:00Z');
 const operations=new PersonalOperationsStore({dbPath,clock:()=>new Date(start)}),store=new SqliteMissionStore({operationsStore:operations}),budget=new PersonalMandateBudget(operations);
 let child;
 try{
  const mandate=operations.createMandate({action:'fixture.write',target:'fixture:local',currency:'KRW',maxAmountMinor:100,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
  budget.configure({mandateId:mandate.id,totalMinor:100,maxCalls:1});
  const request={action:'fixture.write',target:'fixture:local',currency:'KRW',amountMinor:30};
  store.save([{missionId:'mission-one',status:'READY'}],{effects:[{effectId:'effect-one',operationId:'operation-one',missionId:'mission-one',request,budget:{mandateId:mandate.id,requestId:'budget-one',request}}]});
  const output=join(root,'effect.txt');
  child=fork(new URL('./fixtures/sqlite-mission-worker.mjs',import.meta.url),[dbPath,'claim-then-guard',String(start),'separate-worker','effect-one',output],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const next=()=>once(child,'message',{signal:AbortSignal.timeout(10000)}).then(([message])=>message);
  assert.equal((await next()).type,'ready');const claimed=next();child.send('run');assert.ok((await claimed).claim);
  if(revoked)operations.revokeMandate(mandate.id);
  const result=next();child.send('dispatch');const response=await result;
  assert.equal(response.type,revoked?'guarded-denied':'guarded-dispatched');assert.equal(existsSync(output),!revoked);
  if(revoked)assert.equal(response.code,'A_DURABLE_MANDATE_CHANGED');
  else assert.equal(readFileSync(output,'utf8'),'guarded-local-effect\n');
  assert.equal(budget.summary(mandate.id).usedOrHeldMinor,30);
 }finally{
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  operations.close();rmSync(root,{recursive:true,force:true});
 }
});
