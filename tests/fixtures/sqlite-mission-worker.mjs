import { appendFileSync } from 'node:fs';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';

const [dbPath, mode, now, owner = 'child', effectId = 'effect-1', providerLog = ''] = process.argv.slice(2);
const operationsStore = new PersonalOperationsStore({ dbPath, clock: () => new Date(Number(now)) });
const store = new SqliteMissionStore({ operationsStore });
const keepAlive = setInterval(() => {}, 1_000);
let guardedClaim;
process.on('message', message => {
  if (message === 'close') { clearInterval(keepAlive); operationsStore.close(); process.exit(0); }
  if (message === 'dispatch' && mode === 'claim-then-guard') {
    try {
      store.assertEffectDispatch({effectId,lease:guardedClaim.lease,requestSha256:guardedClaim.effect.request_sha256});
      appendFileSync(providerLog,'guarded-local-effect\n');process.send({type:'guarded-dispatched'});
    }catch(error){process.send({type:'guarded-denied',code:error.code});}
    return;
  }
  if (message !== 'run') return;
  try {
    if (mode === 'save') {
      store.load(); store.save([{ missionId: 'mission-1', status: 'RUNNING' }]);
      process.send({ type: 'committed' });
    } else if (mode === 'uncommitted') {
      operationsStore.db.exec('BEGIN IMMEDIATE');
      operationsStore.db.prepare("UPDATE mission_sqlite_snapshot SET body=?,revision=revision+1 WHERE id=1").run(JSON.stringify([{ missionId: 'mission-1', status: 'UNCOMMITTED' }]));
      process.send({ type: 'uncommitted' });
    } else {
      const claim = store.claimEffect({ effectId, ownerId: owner, ttlMs: mode==='claim-then-guard'?30000:100 });
      if(mode==='claim-then-guard'){guardedClaim=claim;process.send({type:'claimed',claim});return;}
      if (mode === 'claim') { process.send({ type: 'claimed', claim }); return; }
      if (!claim) throw new Error('CHILD_EFFECT_NOT_CLAIMED');
      // A local synthetic provider effect, not a real account or external delivery.
      appendFileSync(providerLog, `${JSON.stringify({ operationId: claim.effect.operation_id })}\n`);
      if (mode === 'dispatch') { process.send({ type: 'dispatched', claim }); return; }
      const completed = store.completeEffect({ effectId, lease: claim.lease, receipt: { receiptRef: 'synthetic-provider:1' }, actualMinor: 20 });
      process.send({ type: 'receipt-committed', completed });
    }
  } catch (error) { process.send({ type: 'error', code: error.code, message: error.message }); }
});
process.send({ type: 'ready' });
