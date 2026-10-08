import { readFileSync, writeFileSync } from 'node:fs';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
const [dbPath,inputPath,point,markerPath,providerUrl]=process.argv.slice(2);
const operations=new PersonalOperationsStore({dbPath}),store=new SqliteMissionStore({operationsStore:operations});
const input=JSON.parse(readFileSync(inputPath,'utf8'));
const claim=store.claimEffect({effectId:input.effect.effectId,ownerId:'result-observer',ttlMs:30000});
if(!claim)throw new Error('Expected a claim');
store.assertEffectDispatch({effectId:input.effect.effectId,lease:claim.lease,requestSha256:claim.effect.request_sha256});
if(operations.db.isTransaction)throw new Error('Provider called inside transaction');
const response=await fetch(providerUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({operationId:claim.effect.operation_id,idempotencyKey:claim.effect.provider_idempotency_key,requestSha256:claim.effect.request_sha256})});
const result=await response.json();if(!response.ok)throw new Error('Fixture provider failed');
const points={snapshot:['UPDATE','mission_sqlite_snapshot'],settlement:['UPDATE','personal_budget_reservations'],
    effect:['UPDATE','mission_effects'],outbox:['DELETE','mission_dispatch_outbox'],followup:['INSERT','mission_followup_outbox'],lease:['UPDATE','mission_resource_leases']};
if(point!=='committed'){
    if(!points[point])throw new Error('Unknown result crash point');
    operations.db.function('terminate_result_worker',()=>{
        writeFileSync(markerPath,JSON.stringify({pid:process.pid,point,transactionOpen:operations.db.isTransaction,providerFinished:true})+'\n');
        process.kill(process.pid,'SIGKILL');process.exit(97);
    });
    const [operation,table]=points[point];
    operations.db.exec(`CREATE TEMP TRIGGER result_crash AFTER ${operation} ON ${table} BEGIN SELECT terminate_result_worker(); END;`);
}
store.completeEffect({effectId:input.effect.effectId,lease:claim.lease,receipt:result.receipt,actualMinor:result.actualMinor,
    followup:{type:'verify-and-remember',operationId:input.effect.operationId},snapshot:{missions:input.missions.map(m=>({...m,status:'COMPLETED'})),expectedRevision:1}});
writeFileSync(markerPath,JSON.stringify({pid:process.pid,point,transactionOpen:operations.db.isTransaction,providerFinished:true})+'\n');
operations.close();
