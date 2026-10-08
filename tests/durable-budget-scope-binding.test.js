import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-budget-scope-'));
 const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});
 const store=new SqliteMissionStore({operationsStore:operations}),budget=new PersonalMandateBudget(operations);
 t.after(()=>{operations.close();rmSync(root,{recursive:true,force:true});});
 const mandate=operations.createMandate({action:'fixture.read',target:'fixture:provider',currency:'KRW',maxAmountMinor:100,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',scope:{accountRef:'account:one',dataRefs:['data:a','data:b'],deniedDataRefs:[]}});
 budget.configure({mandateId:mandate.id,totalMinor:100,maxCalls:2});
 const request={action:'fixture.read',target:'fixture:provider',currency:'KRW',amountMinor:30,accountRef:'account:one',dataRefs:['data:a','data:b'],mandateRevision:mandate.revision};
 const effect={effectId:'effect-one',operationId:'operation-one',missionId:'mission-one',request:structuredClone(request),budget:{mandateId:mandate.id,requestId:'budget-one',request:structuredClone(request)}};
 return {operations,store,budget,mandate,effect,missions:[{missionId:'mission-one',status:'READY'}]};
}
for(const mode of ['account-changed','account-omitted','data-changed','data-omitted','revision-changed','revision-omitted','scope-added'])test(`durable monetary intent cannot diverge from reserved scope ${mode}`,t=>{
 const f=fixture(t),effect=structuredClone(f.effect);
 if(mode==='account-changed')effect.request.accountRef='account:other';
 if(mode==='account-omitted')delete effect.request.accountRef;
 if(mode==='data-changed')effect.request.dataRefs=['data:other'];
 if(mode==='data-omitted')delete effect.request.dataRefs;
 if(mode==='revision-changed')effect.request.mandateRevision++;
 if(mode==='revision-omitted')delete effect.request.mandateRevision;
 if(mode==='scope-added'){delete effect.budget.request.accountRef;delete effect.budget.request.dataRefs;delete effect.budget.request.mandateRevision;}
 assert.throws(()=>f.store.save(f.missions,{effects:[effect]}),{code:'A_DURABLE_BUDGET_REQUEST_MISMATCH'});
 assert.equal(f.store.metadata().revision,0);assert.deepEqual(f.store.load(),[]);assert.equal(f.store.pendingEffects().length,0);
 assert.equal(f.budget.summary(f.mandate.id).usedOrHeldCalls,0);assert.equal(f.budget.summary(f.mandate.id).usedOrHeldMinor,0);
});
test('same account/data/revision accepts reordered refs, settles and replays only the identical original intent',t=>{
 const f=fixture(t),effect=structuredClone(f.effect);effect.request.dataRefs.reverse();
 f.store.save(f.missions,{effects:[effect]});
 const stored=f.store.getEffect(effect.effectId);assert.equal(stored.intent.request.accountRef,'account:one');
 assert.deepEqual(stored.intent.request.dataRefs,['data:b','data:a']);assert.equal(f.budget.summary(f.mandate.id).usedOrHeldMinor,30);
 const claim=f.store.claimEffect({effectId:effect.effectId,ownerId:'fixture-worker'});assert.ok(claim);
 f.store.assertEffectDispatch({effectId:effect.effectId,lease:claim.lease,requestSha256:stored.request_sha256});
 f.store.completeEffect({effectId:effect.effectId,lease:claim.lease,receipt:{receiptRef:'fixture:provider-receipt'},actualMinor:20});
 assert.equal(f.budget.summary(f.mandate.id).usedOrHeldMinor,20);
 f.store.save(f.missions,{effects:[effect]});assert.equal(f.budget.summary(f.mandate.id).usedOrHeldCalls,1);
 assert.throws(()=>f.store.save(f.missions,{effects:[{...effect,request:{...effect.request,accountRef:'account:other'}}]}),{code:'A_DURABLE_EFFECT_CONFLICT'});
});
