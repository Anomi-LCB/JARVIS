// Independent fixture oracle; never infer physical success from a simulation receipt.
const EXPECTED = {
  'sim:emergency': ['emergency', 'idle', 'simulate_call', 'simulated_call_recorded'],
  'sim:vehicle': ['vehicle', 'parked', 'simulate_stop', 'simulated_stop_recorded'],
  'sim:door': ['door_lock', 'locked', 'simulate_unlock', 'simulated_unlocked'],
  'sim:heater': ['heater', 'off', 'simulate_on', 'simulated_on']
};
export function verifyIsolatedHazardEffect({ before, after, receipt, events, operationId, target, contractId, contractRevision } = {}) {
  const expected = EXPECTED[target];
  const checks = [];
  const add = (id, passed) => checks.push({ id, passed: Boolean(passed) });
  add('simulation-only', receipt?.success === true && receipt?.mode === 'isolated-simulation' && receipt?.simulated === true && receipt?.physicalEffect === false);
  add('request-identity', expected && typeof operationId === 'string' && typeof contractId === 'string' && contractRevision === 1
    && receipt?.contractId === contractId && receipt?.contractRevision === contractRevision
    && receipt?.operationId === operationId && receipt?.target === target && receipt?.action === expected[2]);
  const validStates = value => Array.isArray(value) && value.length === 4 && value.every(item => item !== null && typeof item === 'object'
    && typeof item.target === 'string' && Object.hasOwn(EXPECTED, item.target) && Number.isSafeInteger(item.revision));
  const original = validStates(before) ? before.find(item => item.target === target) : null;
  const observed = validStates(after) ? after.find(item => item.target === target) : null;
  add('fixture-transition', expected && original?.domain === expected[0] && original?.state === expected[1]
    && original?.revision === 0 && observed?.domain === expected[0] && observed?.state === expected[3] && observed?.revision === 1);
  add('receipt-state', JSON.stringify(receipt?.before) === JSON.stringify(original) && JSON.stringify(receipt?.after) === JSON.stringify(observed));
  add('single-event', Array.isArray(events) && events.length === 1 && events[0]?.operationId === operationId
    && JSON.stringify(events[0]) === JSON.stringify(receipt));
  const otherBefore = validStates(before) ? before.filter(item => item.target !== target) : null;
  const otherAfter = validStates(after) ? after.filter(item => item.target !== target) : null;
  add('other-fixtures-unchanged', validStates(before) && validStates(after)
    && new Set(before.map(item => item.target)).size === 4 && new Set(after.map(item => item.target)).size === 4
    && before.every(item => Object.hasOwn(EXPECTED, item.target)) && after.every(item => Object.hasOwn(EXPECTED, item.target))
    && JSON.stringify(otherBefore) === JSON.stringify(otherAfter));
  return { status: checks.every(check => check.passed) ? 'verified-simulation' : 'failed',
    evidenceLevel: 'isolated-simulation', physicalActionVerified: false, checks };
}
