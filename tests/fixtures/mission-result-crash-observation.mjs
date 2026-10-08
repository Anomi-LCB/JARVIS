import assert from 'node:assert/strict';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,dirname,join,resolve } from 'node:path';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../../packages/core/src/personal-operations/mandate-budget.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
export async function observeMissionResultCrash(point){
 const root=mkdtempSync(join(tmpdir(),'jarvis-result-crash-')),dbPath=join(root,'operations.sqlite');let operations,child,server;
 const calls=[];
 try{
  operations=new PersonalOperationsStore({dbPath});let store=new SqliteMissionStore({operationsStore:operations});const budget=new PersonalMandateBudget(operations);
  const mandate=operations.createMandate({action:'fixture.write',target:'fixture:local',currency:'KRW',maxAmountMinor:100,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
  budget.configure({mandateId:mandate.id,totalMinor:100,maxCalls:1});const request={action:'fixture.write',target:'fixture:local',currency:'KRW',amountMinor:30};
  const input={missions:[{missionId:'mission-result',status:'READY'}],effect:{effectId:'effect-result',operationId:'operation-result',missionId:'mission-result',providerIdempotencyKey:'operation-result',request,budget:{mandateId:mandate.id,requestId:'budget-result',request}}};
  store.save(input.missions,{effects:[input.effect]});
  const inputPath=join(root,'input.json'),markerPath=join(root,'marker.json');writeFileSync(inputPath,JSON.stringify(input));
  server=http.createServer((req,res)=>{
   let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    try{
     assert.equal(req.method,'POST');const value=JSON.parse(body);assert.equal(value.operationId,'operation-result');assert.equal(value.idempotencyKey,'operation-result');
     // A second process's write transaction would block if the calling Core held one over HTTP I/O.
     operations.db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS fixture_provider_probe(value INTEGER); INSERT INTO fixture_provider_probe VALUES(1); COMMIT;');
     calls.push({...value,independentWriterCommitted:true});res.setHeader('content-type','application/json');res.end(JSON.stringify({actualMinor:20,receipt:{receiptRef:'fixture:http-receipt',operationId:value.operationId}}));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
   });
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  child=fork(new URL('./mission-result-crash-child.mjs',import.meta.url),[dbPath,inputPath,point,markerPath,`http://127.0.0.1:${server.address().port}/effect`],{execArgv:[],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let stderr='';child.stderr.on('data',data=>stderr+=data);const timeout=setTimeout(()=>child.kill('SIGKILL'),20000);let exitCode,exitSignal;
  try{[exitCode,exitSignal]=await once(child,'exit');}finally{clearTimeout(timeout);}
  const marker=JSON.parse(readFileSync(markerPath,'utf8'));assert.equal(marker.pid,child.pid);assert.equal(marker.providerFinished,true);assert.equal(calls.length,1);
  operations.close();operations=new PersonalOperationsStore({dbPath});store=new SqliteMissionStore({operationsStore:operations});
  const effect=store.getEffect('effect-result'),reservation=new PersonalMandateBudget(operations).get(effect.budget_reservation_id);
  const dispatch=operations.db.prepare('SELECT count(*) AS n FROM mission_dispatch_outbox').get().n;
  const followups=store.pendingFollowups();const committed=point==='committed';
  assert.equal(marker.transactionOpen,!committed);if(committed)assert.equal(exitCode,0,stderr);else assert.notEqual(exitCode,0,stderr);
  assert.equal(effect.state,committed?'succeeded':'in_flight');assert.equal(reservation.state,committed?'settled':'in_flight');
  assert.equal(reservation.actual_minor,committed?20:null);assert.equal(effect.receipt?.receiptRef,committed?'fixture:http-receipt':undefined);
  assert.equal(dispatch,committed?0:1);assert.equal(followups.length,committed?1:0);assert.equal(store.metadata().revision,committed?2:1);
  assert.equal(store.load()[0].status,committed?'COMPLETED':'READY');
  if(!committed){
   const recovery=new SqliteMissionStore({operationsStore:operations,clock:()=>new Date(Date.now()+60000)});recovery.recoverExpiredEffects();
   assert.equal(recovery.getEffect('effect-result').state,'uncertain');assert.equal(recovery.claimEffect({effectId:'effect-result',ownerId:'new-worker'}),null);
   assert.equal(new PersonalMandateBudget(operations).summary(mandate.id).usedOrHeldMinor,30);assert.equal(calls.length,1);
  }
  return {observedAt:new Date().toISOString(),platform:process.platform,point,pid:marker.pid,exitCode,exitSignal,actualHttpRequests:calls.length,
   independentWriterCommitted:calls[0].independentWriterCommitted,transactionOpenAtCrash:marker.transactionOpen,effectState:effect.state,reservationState:reservation.state,
   actualMinor:reservation.actual_minor,dispatchRows:dispatch,followupRows:followups.length,reopenedRevision:store.metadata().revision,
   recoveryState:committed?'succeeded':'uncertain',replayedProviderRequests:0,partialCommit:false,realAccount:false,syntheticProvider:true};
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
  if(server){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}operations?.close();
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-result-crash-'));rmSync(root,{recursive:true,force:true});
 }
}
