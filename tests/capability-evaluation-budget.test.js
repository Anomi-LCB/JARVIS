import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createContainerCapabilityPackageEvaluator } from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
const artifactSource = 'export function createAdapter(){return {execute(){return 42}}}';
const input = { artifactSource, artifactSha256: createHash('sha256').update(artifactSource).digest('hex'),
  packageDigest: 'a'.repeat(64), toolName: 'synthetic.execute', manifest: { packageId: 'test.budget', version: '1.0.0' } };
const suite = () => ({ suiteId: 'budget-fixed', cases: [{ id: 'one', method: 'execute', args: {}, packet: {}, expected: 42 }] });
const receipt = () => ({ status: 'completed', actualContainerExecution: true, enforcementVerified: true,
  stdout: 'JARVIS_PACKAGE_RESULT:[{"id":"one","actual":42}]', durationMs: 1, restrictions: {}, limitations: ['Contract fixture only.'] });

test('host call budget is reserved atomically before concurrent oracle lookups', async () => {
  const resolvers = []; let dispatches = 0;
  const evaluate = createContainerCapabilityPackageEvaluator({ maxEvaluations: 1,
    casesForPackage: () => new Promise(resolve => { resolvers.push(resolve); }),
    executeContainer: async () => { dispatches++; return receipt(); } });
  const first = evaluate(input);
  const second = evaluate({ ...input, maxEvaluations: 999, budget: { unlimited: true } });
  const outcome = await Promise.race([second.then(() => 'completed', error => error.code), new Promise(resolve => setTimeout(() => resolve('missing-budget'), 100))]);
  for (const resolve of resolvers) resolve(suite());
  await second.catch(() => {});
  assert.equal((await first).status, 'passed');
  assert.equal(outcome, 'A_CAPABILITY_PACKAGE_EVALUATION_BUDGET_EXHAUSTED');
  assert.equal(dispatches, 1);
});

test('expired oracle lookup cannot later dispatch an isolated candidate', async () => {
  let resolveOracle, dispatches = 0, signal;
  const evaluate = createContainerCapabilityPackageEvaluator({ timeoutMs: 100, casesForPackage: (input, options) => new Promise(resolve => { resolveOracle = resolve; signal = options.signal; }),
    executeContainer: async () => { dispatches++; return receipt(); } });
  const pending = evaluate(input);
  const outcome = await Promise.race([pending.then(() => 'completed', error => error.code), new Promise(resolve => setTimeout(() => resolve('missing-deadline'), 250))]);
  resolveOracle(suite()); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(outcome, 'A_CAPABILITY_PACKAGE_EVALUATION_DEADLINE'); assert.equal(dispatches, 0);
  assert.equal(signal.aborted, true);
});

test('failed admitted attempts remain charged and budget status cannot change the host cap', async () => {
  const settings = { maxEvaluations: 1, casesForPackage: async () => { throw Error('oracle unavailable'); }, executeContainer: async () => receipt() };
  const evaluate = createContainerCapabilityPackageEvaluator(settings); settings.maxEvaluations = 999;
  await assert.rejects(evaluate(input), /oracle unavailable/);
  assert.deepEqual(evaluate.budgetStatus(), { configured: true, maxEvaluations: 1, attempts: 1, remaining: 0, scope: 'evaluator-instance', actualCost: null });
  assert.throws(() => { evaluate.budgetStatus().remaining = 100; }, TypeError);
  assert.throws(() => { evaluate.budgetStatus = () => ({ remaining: 999 }); }, TypeError);
  await assert.rejects(evaluate(input), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_BUDGET_EXHAUSTED' });
});

test('invalid host limits are rejected and unset cost/call limit is not reported as zero cost', () => {
  for (const options of [{ maxEvaluations: 0 }, { maxEvaluations: Infinity }, { timeoutMs: 99 }, { timeoutMs: 120001 }]) {
    assert.throws(() => createContainerCapabilityPackageEvaluator({ ...options, casesForPackage: async () => suite() }), RangeError);
  }
  assert.equal(createContainerCapabilityPackageEvaluator({ casesForPackage: async () => suite() }).budgetStatus().configured, false);
});

test('oracle lookup consumes the same evaluation deadline as candidate execution', async () => {
  let receivedTimeout;
  const evaluate = createContainerCapabilityPackageEvaluator({ timeoutMs: 250,
    casesForPackage: async () => { await new Promise(resolve => setTimeout(resolve, 50)); return suite(); },
    executeContainer: async request => { receivedTimeout = request.timeoutMs; return receipt(); } });
  assert.equal((await evaluate(input)).status, 'passed');
  assert.ok(receivedTimeout <= 210 && receivedTimeout >= 100, String(receivedTimeout));
});

test('late container response cannot be accepted as a passing evaluation', async () => {
  let dispatches = 0;
  const evaluate = createContainerCapabilityPackageEvaluator({ timeoutMs: 250, casesForPackage: async () => suite(),
    executeContainer: async () => { dispatches++; await new Promise(resolve => setTimeout(resolve, 300)); return receipt(); } });
  await assert.rejects(evaluate(input), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_DEADLINE' });
  assert.equal(dispatches, 1);
});
