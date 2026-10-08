import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname,basename} from 'node:path';import {randomBytes} from 'node:crypto';
import {RemoteOperationStore} from '../apps/pc-agent/src/remote-operation-store.js';
import {createBrowserGymEffectJournal} from '../scripts/benchmarks/browsergym-effect-journal.mjs';
for(const mode of ['valid','missing','wrong-receipt','wrong-episode','wrong-revision','wrong-task','wrong-auth','wrong-resource','changed-request','revoked-before','revoked-after','fence-denied','state-changed','missing-provider','expired-lease'])test('uncertain recovery: '+mode,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-bg-recovery-')),path=join(root,'effects.sqlite'),key=randomBytes(32);let now=Date.now(),store=new RemoteOperationStore({path,clock:()=>new Date(now)}),allowed=true,queries=0,dispatches=0;
 t.after(()=>{store.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('jarvis-bg-recovery-'));rmSync(root,{recursive:true,force:true});});
 const request={requestId:'one',episodeId:'11111111-1111-1111-1111-111111111111',expectedRevision:0,action:{kind:'fill',bid:'13',text:'public test'}},context={taskId:'task',authorizationHash:'a'.repeat(64),assertAccess:()=>{}};
 let journal=createBrowserGymEffectJournal({store,key,authorize:()=>true,runStep:async()=>{dispatches++;throw Error('RESPONSE_LOST');}});
 await assert.rejects(journal.execute(request,context),/RESPONSE_LOST/);store.close();store=new RemoteOperationStore({path,clock:()=>new Date(now)});
 const receipt={version:'browsergym-action-receipt-v1',request:structuredClone(request),postState:{episodeId:request.episodeId,revision:1}};
 const readProviderReceipt=async()=>{queries++;if(mode==='revoked-after')allowed=false;if(mode==='state-changed')store.db.exec("UPDATE remote_operations SET state='in_flight'");return mode==='missing'?{status:'unresolved'}:{status:'matched',receipt};};
 journal=createBrowserGymEffectJournal({store,key,authorize:()=>allowed,runStep:async()=>{dispatches++;assert.fail('must not redispatch');},...(mode==='missing-provider'?{}:{readProviderReceipt})});
 let actualRequest=request,actualContext=context;
 if(mode==='wrong-receipt')receipt.request.requestId='different';
 if(mode==='wrong-episode')receipt.postState.episodeId='22222222-2222-2222-2222-222222222222';
 if(mode==='wrong-revision')receipt.postState.revision=2;
 if(mode==='wrong-task')actualContext={...context,taskId:'other'};
 if(mode==='wrong-auth')actualContext={...context,authorizationHash:'b'.repeat(64)};
 if(mode==='wrong-resource')store.db.exec("UPDATE remote_operations SET resource_key='another'");
 if(mode==='changed-request')actualRequest={...request,action:{kind:'noop'}};
 if(mode==='revoked-before')allowed=false;
 if(mode==='fence-denied')actualContext={...context,assertAccess:()=>{throw Error('DENIED');}};
 if(mode==='expired-lease')now+=3600000;
 if(['valid','expired-lease'].includes(mode)){
  const r=await journal.reconcile(actualRequest,actualContext);assert.equal(r.status,'historical-matched');assert.equal(r.executionAuthority,false);assert.equal(r.currentStateVerified,false);assert.equal(store.row('bg_one').state,'succeeded');
  await assert.rejects(journal.execute(request,context),/EXISTING_EFFECT/);
 }else if(mode==='missing'){assert.equal((await journal.reconcile(actualRequest,actualContext)).status,'unresolved');assert.equal(store.row('bg_one').state,'uncertain');}
 else{await assert.rejects(journal.reconcile(actualRequest,actualContext));assert.equal(store.row('bg_one').state,mode==='state-changed'?'in_flight':'uncertain');}
 assert.equal(dispatches,1);
 if(['wrong-task','wrong-auth','wrong-resource','changed-request','revoked-before','fence-denied','missing-provider'].includes(mode))assert.equal(queries,0);else assert.equal(queries,1);
});
