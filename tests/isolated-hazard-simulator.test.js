import test from 'node:test';
import assert from 'node:assert/strict';
import { IsolatedHazardSimulator } from '../apps/pc-agent/src/adapters/smart-home/isolated-hazard-simulator.js';
import { verifyIsolatedHazardEffect } from '../apps/verification/src/isolated-hazard-verifier.js';

const cases = [
  ['sim:emergency', 'simulate_call', 'simulated_call_recorded'],
  ['sim:vehicle', 'simulate_stop', 'simulated_stop_recorded'],
  ['sim:door', 'simulate_unlock', 'simulated_unlocked'],
  ['sim:heater', 'simulate_on', 'simulated_on']
];
const contract = () => ({ id: 'hazard-test', revision: 1, mode: 'isolated-simulation',
  targets: cases.map(([target]) => target), expiresAt: '2099-01-01T00:00:00.000Z' });
const request = (target, action) => ({ mode: 'isolated-simulation', contractId: 'hazard-test', contractRevision: 1,
  operationId: 'operation-one', target, action, expectedRevision: 0, loseResponse: false });
const create = () => new IsolatedHazardSimulator({ contract: contract(), clock: () => Date.parse('2026-10-06T00:00:00.000Z') });

for (const [target, action, state] of cases) {
  test(`${target}: isolated transition, lost response reconciliation, duplicate and independent oracle`, () => {
    const simulator = create(), before = simulator.snapshot(), req = request(target, action);
    const uncertain = simulator.execute({ ...req, loseResponse: true });
    assert.equal(uncertain.uncertain, true);
    assert.equal(uncertain.physicalEffect, false);
    const receipt = simulator.receipt(req.operationId);
    assert.equal(receipt.after.state, state);
    const after = simulator.snapshot();
    assert.equal(verifyIsolatedHazardEffect({ before, after, receipt, events: simulator.events(), operationId: req.operationId, target,
      contractId: req.contractId, contractRevision: req.contractRevision }).status, 'verified-simulation');
    assert.equal(simulator.execute(req).duplicate, true);
    assert.equal(simulator.events().length, 1);
    receipt.after.state = 'forged'; after[0].state = 'forged'; simulator.events()[0].physicalEffect = true;
    assert.equal(simulator.receipt(req.operationId).after.state, state);
    assert.equal(simulator.events()[0].physicalEffect, false);
  });
  test(`${target}: real mode, arbitrary payload and wrong action cannot alter any fixture`, () => {
    const simulator = create(), before = simulator.snapshot(), req = request(target, action);
    for (const bad of [{ ...req, mode: 'real' }, { ...req, target: 'real-device' },
      { ...req, endpoint: 'https://invalid.test' }, { ...req, phone: '119' }, { ...req, action: 'execute' },
      { ...req, expectedRevision: 1 }, { ...req, contractRevision: 2 }]) assert.equal(simulator.execute(bad).success, false);
    assert.deepEqual(simulator.snapshot(), before); assert.deepEqual(simulator.events(), []);
  });
  test(`${target}: expired, revoked and out-of-scope contracts block execution and duplicate access`, () => {
    const req = request(target, action), simulator = create();
    simulator.execute(req); simulator.revoke();
    assert.equal(simulator.execute(req).code, 'simulation-contract-revoked');
    assert.equal(simulator.events().length, 1);
    const expired = new IsolatedHazardSimulator({ contract: contract(), clock: () => Date.parse(contract().expiresAt) });
    assert.equal(expired.execute(req).code, 'simulation-contract-expired');
    const other = cases.find(([item]) => item !== target)[0];
    const limited = new IsolatedHazardSimulator({ contract: { ...contract(), targets: [other] } });
    assert.equal(limited.execute(req).code, 'simulation-contract-scope-denied');
    assert.deepEqual(expired.events(), []); assert.deepEqual(limited.events(), []);
  });
}
test('simulation operation identity and state revision conflicts do not create extra effects', () => {
  const simulator = create(), req = request('sim:door', 'simulate_unlock');
  simulator.execute(req);
  assert.equal(simulator.execute({ ...req, target: 'sim:heater', action: 'simulate_on' }).code, 'simulation-operation-conflict');
  assert.equal(simulator.execute({ ...req, operationId: 'new' }).code, 'simulation-state-conflict');
  assert.equal(simulator.events().length, 1);
});
test('simulation constructor rejects live endpoints, malformed expiry and caller-mutated scope', () => {
  for (const bad of [{ ...contract(), endpoint: 'live' }, { ...contract(), mode: 'real' },
    { ...contract(), targets: ['sim:unknown'] }, { ...contract(), expiresAt: '2099-02-30T00:00:00.000Z' }]) {
    assert.throws(() => new IsolatedHazardSimulator({ contract: bad }), /contract-invalid/);
  }
  const scope = contract(), simulator = new IsolatedHazardSimulator({ contract: scope });
  scope.targets.length = 0;
  assert.equal(simulator.execute(request('sim:door', 'simulate_unlock')).success, true);
});
test('independent oracle rejects false physical claims, wrong state, duplicate event and collateral change', () => {
  const simulator = create(), before = simulator.snapshot(), req = request('sim:heater', 'simulate_on');
  const receipt = simulator.execute(req);
  const proof = { before, after: simulator.snapshot(), receipt, events: simulator.events(), operationId: req.operationId, target: req.target,
    contractId: req.contractId, contractRevision: req.contractRevision };
  for (const alter of [value => { value.receipt.physicalEffect = true; }, value => { value.after[3].state = 'off'; },
    value => { value.events.push(value.events[0]); }, value => { value.after[0].state = 'changed'; },
    value => { value.operationId = 'wrong'; }, value => { value.contractId = 'wrong'; },
    value => { value.before[0] = null; }, value => { value.receipt.success = false; }]) {
    const bad = structuredClone(proof); alter(bad);
    assert.equal(verifyIsolatedHazardEffect(bad).status, 'failed');
  }
  assert.equal(verifyIsolatedHazardEffect({}).status, 'failed');
});
