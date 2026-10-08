import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../../packages/core/src/personal-operations/mandate-budget.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';

export async function observeMissionAtomicCrash(point) {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-atomic-crash-')), dbPath = join(root, 'operations.sqlite');
    let operations, child;
    try {
        operations = new PersonalOperationsStore({ dbPath });
        const store = new SqliteMissionStore({ operationsStore: operations }), budget = new PersonalMandateBudget(operations);
        const mandate = operations.createMandate({ action:'fixture.write', target:'fixture:local', currency:'KRW', maxAmountMinor:100,
            validFrom:'2020-01-01T00:00:00Z', expiresAt:'2099-01-01T00:00:00Z', scope:{ accountRef:'account:fixture',dataRefs:['data:fixture'],deniedDataRefs:[] } });
        budget.configure({ mandateId:mandate.id,totalMinor:100,maxCalls:1 });
        const request = { action:'fixture.write',target:'fixture:local',currency:'KRW',amountMinor:30,accountRef:'account:fixture',dataRefs:['data:fixture'],mandateRevision:mandate.revision };
        const effect = { effectId:'effect-atomic', operationId:'operation-atomic', missionId:'mission-atomic', providerIdempotencyKey:'operation-atomic',
            request, budget:{ mandateId:mandate.id,requestId:'budget-atomic',request } };
        const input = { missions:[{missionId:'mission-atomic',status:'READY',executionMandateId:mandate.id}], effect };
        const inputPath=join(root,'input.json'), markerPath=join(root,'marker.json');
        writeFileSync(inputPath,JSON.stringify(input));
        const journalMode=operations.db.prepare('PRAGMA journal_mode').get().journal_mode;
        operations.close(); operations=null;
        child=fork(new URL('./mission-atomic-crash-child.mjs',import.meta.url),[dbPath,inputPath,point,markerPath],{execArgv:[],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
        let stderr='';child.stderr.on('data',data=>stderr+=data);
        const timeout=setTimeout(()=>child.kill('SIGKILL'),20000);
        let exitCode,exitSignal;
        try { [exitCode,exitSignal]=await once(child,'exit'); } finally { clearTimeout(timeout); }
        const marker=JSON.parse(readFileSync(markerPath,'utf8'));
        assert.equal(marker.pid,child.pid);assert.equal(marker.point,point);
        operations=new PersonalOperationsStore({dbPath});
        const reopened=new SqliteMissionStore({operationsStore:operations}), recoveredBudget=new PersonalMandateBudget(operations);
        const counts=Object.fromEntries(['mission_effects','mission_dispatch_outbox','personal_budget_reservations'].map(table=>[table,operations.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
        const recoveredEffect=point==='committed'?reopened.getEffect(effect.effectId):null;
        if(point==='committed') {
            assert.equal(exitCode,0,stderr);assert.equal(marker.transactionOpen,false);
            assert.deepEqual(reopened.load(),input.missions);assert.equal(reopened.metadata().revision,1);
            assert.deepEqual(Object.values(counts),[1,1,1]);
            assert.equal(recoveredBudget.summary(mandate.id).usedOrHeldMinor,30);
            assert.equal(recoveredEffect.mandate_id,mandate.id);assert.match(recoveredEffect.mandate_revision,/^[a-f0-9]{64}$/u);
            assert.equal(recoveredEffect.provider_idempotency_key,'operation-atomic');
            assert.equal(recoveredEffect.intent.request.mandateRevision,mandate.revision);
            assert.equal(recoveredBudget.get(recoveredEffect.budget_reservation_id).state,'reserved');
            assert.equal(reopened.pendingEffects().length,1);
        } else {
            assert.notEqual(exitCode,0,stderr);assert.equal(marker.transactionOpen,true);
            assert.deepEqual(reopened.load(),[]);assert.equal(reopened.metadata().revision,0);
            assert.deepEqual(Object.values(counts),[0,0,0]);
            assert.throws(()=>reopened.getEffect(effect.effectId),{code:'A_DURABLE_EFFECT_MISSING'});
            assert.equal(recoveredBudget.summary(mandate.id).usedOrHeldMinor,0);
            assert.equal(recoveredBudget.summary(mandate.id).usedOrHeldCalls,0);
        }
        return {observedAt:new Date().toISOString(),platform:process.platform,point,childPid:marker.pid,exitCode,exitSignal,
            journalMode,transactionOpenAtCrash:marker.transactionOpen,reopenedRevision:reopened.metadata().revision,counts,
            heldMinor:recoveredBudget.summary(mandate.id).usedOrHeldMinor,actualSupplierCalled:false,syntheticBudget:true,partialCommit:false};
    } finally {
        if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
        operations?.close();
        assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-atomic-crash-'));
        rmSync(root,{recursive:true,force:true});
    }
}
