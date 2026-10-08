import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
let time = 1790899200000;
const operations = new PersonalOperationsStore({ dbPath: process.argv[2], clock: () => new Date(time) });
const store = new SqliteMissionStore({ operationsStore: operations });
const leases = new Map();
process.send({ type: 'ready', pid: process.pid });
process.on('message', message => {
  try {
    let result;
    if (message.kind === 'clock') { time = message.time; result = time; }
    if (message.kind === 'claim') { result = store.claimEffect({ effectId: message.effectId, ownerId: `worker:${process.pid}`, ttlMs: 1000 }); if (result) leases.set(message.effectId, result.lease); }
    if (message.kind === 'complete') result = store.completeEffect({ effectId: message.effectId, lease: leases.get(message.effectId), receipt: message.receipt });
    if (message.kind === 'uncertain') result = store.markUncertain({ effectId: message.effectId, lease: leases.get(message.effectId) });
    if (message.kind === 'dispatch') result = store.assertEffectDispatch({ effectId: message.effectId, lease: leases.get(message.effectId), requestSha256: store.getEffect(message.effectId).request_sha256 });
    if (message.kind === 'recover') result = store.recoverExpiredEffects();
    if (message.kind === 'ack') result = store.acknowledgeFollowup(message.eventId, message.options);
    if (message.kind === 'close') { operations.close(); process.send({ type: 'closed' }); process.disconnect(); return; }
    process.send({ type: 'result', result });
  } catch (error) { process.send({ type: 'rejected', code: error.code ?? error.message }); }
});
