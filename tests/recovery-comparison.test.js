import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { assertComparisonOutputPath, checkComparisonSourceStability } from '../scripts/recovery-comparison.mjs';
import { assessRecoverySample, comparisonChildEnvironment, loadRecoverySuite,
  runRecoveryComparison, runRecoverySample, validateRecoverySuite } from '../packages/shared/src/recovery-comparison.js';

const suite = { version: 'jarvis-recovery-cases-v1', cases: [
  { id: 'completed', split: 'development', scenario: 'completed-core', expect: { status: 'recovered' }, rationale: 'Fresh proof exists.' },
  { id: 'missing', split: 'development', scenario: 'missing-receipt', expect: { status: 'blocked' }, rationale: 'Effect is uncertain.' },
  { id: 'remote', split: 'holdout', scenario: 'durable-remote', expect: { status: 'recovered' }, rationale: 'Remote proof exists.' },
  { id: 'changed', split: 'holdout', scenario: 'changed-artifact', expect: { status: 'blocked' }, rationale: 'Current file differs.' }
] };
const good = status => ({ state: 'completed', status, errorCode: null, duplicateExecutionCount: 0,
  elapsedMs: 2, wallMs: 10, metrics: { externalModelCalls: 0, inputTokens: 0, outputTokens: 0,
    costUsd: 0, costBasis: 'local-no-model' } });
const expected = scenario => suite.cases.find(item => item.scenario === scenario).expect.status;
const bufferSuite = loadRecoverySuite('tests/fixtures/recovery-comparison-buffer-v1.json');
const bufferCase = scenario => bufferSuite.suite.cases.find(item => item.scenario === scenario);
const goodHash = (item, arm = 'reference-64k') => {
  const configuredChunkBytes = arm === 'buffered-read' ? 1024 * 1024 : 64 * 1024;
  const bytesRead = item.expect.fileBytesRead ?? 4 * 1024 * 1024 + 1;
  const readCalls = item.scenario === 'hash-over-budget' ? 0 : Math.ceil(bytesRead / configuredChunkBytes) + 1;
  return { ...good(item.expect.status), arm, recoveryElapsedMs: 1,
    ioMetrics: { readCalls, bytesRead, configuredChunkBytes, maxRequestedBytes: readCalls ? configuredChunkBytes : 0 } };
};

test('frozen independent suite has 18 unique scenarios, separate splits and positive controls in both', () => {
  const loaded = loadRecoverySuite('tests/fixtures/recovery-comparison-v1.json');
  assert.equal(loaded.sha256, '38399715d1b31315cf5599fc39d02a0952c403b519661387449c3668416ee5db');
  assert.equal(loaded.suite.cases.length, 18);
  assert.equal(loaded.suite.cases.filter(item => item.split === 'holdout').length, 12);
  const duplicate = structuredClone(suite); duplicate.cases[3].scenario = duplicate.cases[0].scenario;
  assert.throws(() => validateRecoverySuite(duplicate), /INVALID_CASE/u);
  const unbalanced = structuredClone(suite); unbalanced.cases[2].expect.status = 'blocked';
  assert.throws(() => validateRecoverySuite(unbalanced), /UNBALANCED_SPLIT/u);
});

test('duplicate execution, unknown costs, missing timing and nonlocal usage never pass', () => {
  assert.equal(assessRecoverySample(suite.cases[0], good('recovered')).outcome, 'pass');
  const variants = [
    { ...good('recovered'), duplicateExecutionCount: 1 },
    { ...good('recovered'), duplicateExecutionCount: undefined },
    { ...good('recovered'), metrics: null },
    { ...good('recovered'), elapsedMs: NaN },
    { ...good('recovered'), metrics: { ...good('').metrics, costUsd: null } },
    { ...good('recovered'), metrics: { ...good('').metrics, externalModelCalls: 1 } }
  ];
  for (const result of variants) assert.equal(assessRecoverySample(suite.cases[0], result).outcome, 'fail');
  assert.equal(assessRecoverySample(suite.cases[0], variants[2]).usage, null);
});

test('malformed process RSS evidence cannot pass when a worker claims to have measured memory', () => {
  const item = suite.cases[0];
  const sample = { ...good('recovered'), processMemory: { baselineRssBytes: 100, sampledPeakRssBytes: 90,
    sampledPeakDeltaBytes: 0, sampleCount: 1, intervalMs: 2, scope: 'isolated-worker-process-rss-sampled-lower-bound' } };
  const assessed = assessRecoverySample(item, sample);
  assert.equal(assessed.outcome, 'fail');
  assert.equal(assessed.checks.memoryMeasurementValid, false);
  assert.ok(assessed.reasonCodes.includes('A_COMPARISON_MEMORY_MEASUREMENT_INVALID'));
});

test('independent buffer suite remains frozen with byte coverage and balanced development/holdout cases', () => {
  assert.equal(bufferSuite.sha256, '29dce8b69d03dee8815bebcee8c0a18d6485d578cf75b80501417362d0b953df');
  assert.equal(bufferSuite.suite.cases.length, 8);
  assert.equal(bufferSuite.suite.cases.filter(item => item.split === 'holdout').length, 6);
  assert.equal(bufferCase('hash-input-evidence').expect.fileBytesRead, 4 * 1024 * 1024);
  const invalid = structuredClone(bufferSuite.suite);
  invalid.cases[0].expect.fileBytesRead = -1;
  assert.throws(() => validateRecoverySuite(invalid), /INVALID_CASE/u);
});

test('hash evaluations require measured IO and both independent input hash passes', () => {
  const item = bufferCase('hash-input-evidence');
  const sample = goodHash(item);
  assert.equal(assessRecoverySample(item, sample).outcome, 'pass');
  for (const missing of [{ ...sample, ioMetrics: undefined }, { ...sample, recoveryElapsedMs: undefined }]) {
    const assessed = assessRecoverySample(item, missing);
    assert.equal(assessed.outcome, 'fail');
    assert.ok(assessed.reasonCodes.includes('A_COMPARISON_IO_MEASUREMENT_MISSING'));
  }
  const skippedPass = assessRecoverySample(item, { ...sample,
    ioMetrics: { ...sample.ioMetrics, bytesRead: 2 * 1024 * 1024 } });
  assert.equal(skippedPass.outcome, 'fail');
  assert.ok(skippedPass.reasonCodes.includes('A_COMPARISON_REQUIRED_FILE_READS_MISSING'));
});

test('impossible IO counters and chunk settings cannot pass even when status and expected bytes match', () => {
  const item = bufferCase('hash-small');
  const sample = goodHash(item);
  const variants = [
    { readCalls: 1, bytesRead: 4096, maxRequestedBytes: 2 * 1024 * 1024, configuredChunkBytes: 2 * 1024 * 1024 },
    { readCalls: 0, bytesRead: 4096, maxRequestedBytes: 0, configuredChunkBytes: 0 },
    { ...sample.ioMetrics, readCalls: 0 },
    { ...sample.ioMetrics, readCalls: 1, maxRequestedBytes: 4095 },
    { ...sample.ioMetrics, maxRequestedBytes: 0 },
    { ...sample.ioMetrics, maxRequestedBytes: 65537 },
    { ...sample.ioMetrics, configuredChunkBytes: 65535 },
    { ...sample.ioMetrics, configuredChunkBytes: 1024 * 1024 },
    { ...sample.ioMetrics, readCalls: 0.5 }
  ];
  for (const ioMetrics of variants) {
    const assessed = assessRecoverySample(item, { ...sample, ioMetrics });
    assert.equal(assessed.outcome, 'fail', JSON.stringify(ioMetrics));
    assert.equal(assessed.checks.ioMeasurementValid, false);
  }
  const noReads = goodHash(bufferCase('hash-over-budget'));
  assert.equal(assessRecoverySample(bufferCase('hash-over-budget'), noReads).outcome, 'pass');
  assert.equal(assessRecoverySample(bufferCase('hash-over-budget'), { ...noReads,
    ioMetrics: { ...noReads.ioMetrics, maxRequestedBytes: 65536 } }).outcome, 'fail');
  assert.equal(assessRecoverySample(bufferCase('hash-empty'), goodHash(bufferCase('hash-empty'))).outcome, 'pass');
});

test('fixed arms enforce their configured chunk and cannot trust a mismatching worker arm', () => {
  const item = bufferCase('hash-small');
  assert.equal(assessRecoverySample(item, goodHash(item, 'buffered-read'), { arm: 'buffered-read' }).outcome, 'pass');
  assert.equal(assessRecoverySample(item, goodHash(item), { arm: 'buffered-read' }).outcome, 'fail');
  const wrongChunk = { ...goodHash(item), arm: 'buffered-read' };
  assert.equal(assessRecoverySample(item, wrongChunk, { arm: 'buffered-read' }).outcome, 'fail');
  assert.equal(assessRecoverySample(item, goodHash(item), { arm: 'unknown' }).outcome, 'fail');
  // Current may follow a later product default, but only within factory bounds.
  const current = { ...goodHash(item, 'buffered-read'), arm: 'current' };
  assert.equal(assessRecoverySample(item, current, { arm: 'current' }).outcome, 'pass');
  assert.equal(assessRecoverySample(item, { ...current,
    ioMetrics: { ...current.ioMetrics, configuredChunkBytes: 2 * 1024 * 1024 } }, { arm: 'current' }).outcome, 'fail');
});

test('explicit baseline reaches every sample and valid IO aggregates across cases and repetitions', async () => {
  const calls = [];
  const report = await runRecoveryComparison({ suite: bufferSuite.suite, baseline: 'reference-64k', candidate: 'buffered-read', repetitions: 2,
    sampleRunner: async input => { calls.push(input); return goodHash(bufferCase(input.scenario), input.arm); } });
  assert.deepEqual(calls.slice(0, 4).map(item => item.arm), ['reference-64k', 'buffered-read', 'buffered-read', 'reference-64k']);
  assert.equal(calls.filter(item => item.arm === 'reference-64k').length, 16);
  assert.equal(report.protocol.baseline, 'reference-64k');
  assert.equal(report.comparison.decision, 'requires-independent-review');
  assert.equal(report.summary.baseline.all.passed, 16);
  assert.equal(report.summary.candidate.all.passed, 16);
  for (const [label, arm] of [['baseline', 'reference-64k'], ['candidate', 'buffered-read']]) {
    const io = bufferSuite.suite.cases.map(item => goodHash(item, arm).ioMetrics);
    assert.deepEqual(report.summary[label].all.io, { measuredSamples: 16,
      readCalls: io.reduce((sum, metrics) => sum + metrics.readCalls, 0) * 2,
      bytesRead: io.reduce((sum, metrics) => sum + metrics.bytesRead, 0) * 2,
      maxRequestedBytes: arm === 'buffered-read' ? 1024 * 1024 : 64 * 1024 });
    const inputCase = report.caseResults.find(item => item.scenario === 'hash-input-evidence');
    assert.equal(inputCase[label].io.bytesRead, 8 * 1024 * 1024);
    assert.equal(inputCase[label].recoveryElapsedMs.count, 2);
  }
});

test('bounded concurrency runs pairs in parallel, preserves order within pairs and stable report ordering', async () => {
  let active = 0, peak = 0;
  const callsByPair = new Map();
  const report = await runRecoveryComparison({ suite, baseline: 'current', candidate: 'negative-control', repetitions: 2, concurrency: 2,
    sampleRunner: async ({ scenario, arm }) => {
      active++; peak = Math.max(peak, active);
      const pairKey = `${scenario}`;
      callsByPair.set(pairKey, (callsByPair.get(pairKey) ?? 0) + 1);
      await new Promise(resolve => setTimeout(resolve, 3));
      active--;
      return good(arm === 'negative-control' ? 'recovered' : expected(scenario));
    } });
  assert.equal(peak, 2);
  assert.equal(report.protocol.concurrency, 2);
  assert.equal(report.samples.length, 16);
  assert.deepEqual(report.samples.slice(0, 4).map(row => row.arm), ['baseline', 'candidate', 'candidate', 'baseline']);
  assert.ok(report.samples.every(row => Date.parse(row.sampleFinishedAt) >= Date.parse(row.sampleStartedAt)));
  assert.ok([...callsByPair.values()].every(count => count === 4));
});

test('concurrency limits are validated before any sample is dispatched', async () => {
  let dispatched = 0;
  for (const concurrency of [0, 1.5, 9, -1]) {
    await assert.rejects(runRecoveryComparison({ suite, concurrency, sampleRunner: async () => { dispatched++; return good('recovered'); } }), /INVALID_OPTIONS/u);
  }
  assert.equal(dispatched, 0);
});

test('invalid sample IO makes aggregate totals unknown and preserves the failing sample counters', async () => {
  const report = await runRecoveryComparison({ suite: bufferSuite.suite, baseline: 'reference-64k', candidate: 'buffered-read', repetitions: 1,
    sampleRunner: async ({ scenario, arm }) => {
      const sample = goodHash(bufferCase(scenario), arm);
      if (arm === 'buffered-read' && scenario === 'hash-small') sample.ioMetrics.readCalls = 0;
      return sample;
    } });
  assert.equal(report.comparison.decision, 'reject');
  assert.equal(report.summary.candidate.all.failed, 1);
  assert.deepEqual(report.summary.candidate.all.io, { measuredSamples: 7, readCalls: null, bytesRead: null, maxRequestedBytes: null });
  const failed = report.samples.find(item => item.arm === 'candidate' && item.caseId === bufferCase('hash-small').id);
  assert.equal(failed.ioMetrics.bytesRead, 4096);
  assert.equal(failed.ioMetrics.readCalls, 0);
  assert.ok(failed.reasonCodes.includes('A_COMPARISON_IO_MEASUREMENT_INVALID'));
});

test('runner validates returned arm against requested arm and rejects invalid baselines before dispatch', async () => {
  const report = await runRecoveryComparison({ suite: bufferSuite.suite, baseline: 'reference-64k', candidate: 'buffered-read', repetitions: 1,
    sampleRunner: async ({ scenario }) => goodHash(bufferCase(scenario), 'reference-64k') });
  assert.equal(report.summary.baseline.all.passed, 8);
  assert.equal(report.summary.candidate.all.failed, 8);
  assert.equal(report.comparison.decision, 'reject');
  let dispatched = 0;
  for (const baseline of ['buffered-read', 'negative-control', '../production.js', null]) {
    await assert.rejects(runRecoveryComparison({ suite, baseline, sampleRunner: async () => { dispatched++; return good('recovered'); } }), /INVALID_OPTIONS/u);
  }
  assert.equal(dispatched, 0);
});

test('negative control is rejected by independent status and paired regressions, with every repetition counted', async () => {
  const calls = [];
  const report = await runRecoveryComparison({ suite, candidate: 'negative-control', repetitions: 2,
    sampleRunner: async input => {
      assert.deepEqual(Object.keys(input).sort(), ['arm', 'scenario', 'timeoutMs']);
      calls.push(input);
      return good(input.arm === 'negative-control' ? 'recovered' : expected(input.scenario));
    } });
  assert.equal(report.samples.length, 16);
  assert.equal(report.summary.baseline.all.passed, 8);
  assert.equal(report.summary.candidate.all.failed, 4);
  assert.equal(report.summary.candidate.holdout.failed, 2);
  assert.deepEqual(report.comparison.regressionCaseIds.sort(), ['changed', 'missing']);
  assert.equal(report.comparison.decision, 'reject');
  assert.deepEqual(calls.slice(0, 4).map(item => item.arm), ['current', 'negative-control', 'negative-control', 'current']);
  assert.equal(report.comparison.automaticallyAdopted, false);
});

test('identical baseline and candidate are calibration, never claimed improvement', async () => {
  const report = await runRecoveryComparison({ suite, repetitions: 1,
    sampleRunner: async ({ scenario }) => good(expected(scenario)) });
  assert.equal(report.comparison.decision, 'calibration-passed');
  assert.equal(report.comparison.claimedImprovement, false);
  assert.equal(report.summary.candidate.all.externalModelCostUsd, 0);
  assert.equal(report.summary.candidate.all.localComputeCostUsd, null);
});

test('timeouts and exceptions remain in denominators; incomplete cost totals are unknown', async () => {
  const report = await runRecoveryComparison({ suite, candidate: 'negative-control', repetitions: 1,
    sampleRunner: async ({ scenario, arm }) => {
      if (arm === 'negative-control' && scenario === 'completed-core') return { state: 'timeout', wallMs: 100, errorCode: 'A_COMPARISON_TIMEOUT' };
      if (arm === 'negative-control' && scenario === 'missing-receipt') throw new Error('synthetic failure');
      return good(expected(scenario));
    } });
  assert.equal(report.summary.candidate.all.total, 4);
  assert.equal(report.summary.candidate.all.timeouts, 1);
  assert.equal(report.summary.candidate.all.errors, 1);
  assert.equal(report.summary.candidate.all.passed, 2);
  assert.equal(report.summary.candidate.all.externalModelCostUsd, null);
  assert.equal(report.comparison.decision, 'reject');
});

test('baseline failures prevent a positive conclusion and invalid options are refused before dispatch', async () => {
  const report = await runRecoveryComparison({ suite, repetitions: 1,
    sampleRunner: async () => good('blocked') });
  assert.equal(report.comparison.decision, 'inconclusive');
  await assert.rejects(runRecoveryComparison({ suite, repetitions: 0 }), /INVALID_OPTIONS/u);
  await assert.rejects(runRecoveryComparison({ suite, candidate: '../production.js' }), /INVALID_OPTIONS/u);
});

test('child environment excludes credentials, personal paths, proxy and node preload injection', () => {
  const original = { Path: 'C:/system', SystemRoot: 'C:/Windows', TEMP: 'C:/temp',
    OPENAI_API_KEY: 'fake-private-key', JARVIS_PERSONAL_PROFILE_PATH: 'C:/private',
    NODE_OPTIONS: '--require malicious.js', HTTPS_PROXY: 'https://secret@example.invalid', CUSTOM_SECRET: 'secret' };
  const env = comparisonChildEnvironment(original);
  assert.equal(env.Path, original.Path);
  for (const key of ['OPENAI_API_KEY', 'JARVIS_PERSONAL_PROFILE_PATH', 'NODE_OPTIONS', 'HTTPS_PROXY', 'CUSTOM_SECRET']) assert.equal(env[key], undefined);
  assert.equal(env.JARVIS_TEST_MODE, '1');
  assert.equal(env.JARVIS_PERSONAL_PROFILE_ENABLED, '0');
  assert.equal(original.OPENAI_API_KEY, 'fake-private-key');
});

test('child deadline is enforced and its owned temporary directory is removed', async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('jarvis-recovery-sample-')));
  const result = await runRecoverySample({ scenario: 'completed-core', arm: 'current', timeoutMs: 1 });
  assert.equal(result.state, 'timeout');
  assert.ok(result.wallMs >= 1);
  const after = (await readdir(tmpdir())).filter(name => name.startsWith('jarvis-recovery-sample-') && !before.has(name));
  assert.deepEqual(after, []);
});

test('failed child termination is bounded, disclosed and leaves its active directory intact', async () => {
  const calls = [];
  const fake = new EventEmitter();
  Object.assign(fake, { pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: signal => { calls.push(signal ?? 'SIGTERM'); return false; }, unref: () => calls.push('unref') });
  const result = await runRecoverySample({ scenario: 'completed-core', arm: 'current', timeoutMs: 1,
    spawnImpl: () => fake, terminationGraceMs: 5 });
  assert.equal(result.state, 'timeout');
  assert.equal(result.cleanupDeferred, true);
  assert.equal(result.terminationConfirmed, false);
  assert.ok(result.wallMs < 1000);
  assert.ok(calls.includes('SIGKILL') && calls.includes('unref'));
  const owned = resolve(result.retainedTemporaryDirectory);
  assert.equal(dirname(owned), resolve(tmpdir()));
  assert.ok(basename(owned).startsWith('jarvis-recovery-sample-'));
  // No real process owns this directory: the termination failure above is an emitter fixture.
  await rm(owned, { recursive: true, force: true });
});

test('post-run source deletion and invalid suite JSON are inconclusive without discarding results', () => {
  const before = [{ path: 'synthetic-source.js', sha256: 'abc' }];
  const base = { before, readSources: () => before, expectedSuiteSha256: 'suite', readSuiteSha256: () => 'suite' };
  assert.deepEqual(checkComparisonSourceStability(base), { stable: true, reason: null });
  assert.equal(checkComparisonSourceStability({ ...base, readSources: () => { throw new Error('ENOENT'); } }).reason, 'SOURCE_OR_SUITE_UNREADABLE_AFTER_RUN');
  assert.equal(checkComparisonSourceStability({ ...base, readSuiteSha256: () => JSON.parse('{') }).stable, false);
  assert.equal(checkComparisonSourceStability({ ...base, readSuiteSha256: () => 'changed' }).reason, 'SOURCE_OR_SUITE_CHANGED_DURING_RUN');
});

test('output cannot replace evaluation inputs or sources', () => {
  const suitePath = resolve('tests/fixtures/recovery-comparison-v1.json');
  const sourcePaths = [resolve('packages/shared/src/recovery-comparison.js')];
  assert.throws(() => assertComparisonOutputPath(suitePath, { suitePath, sourcePaths }), /OUTPUT_CONFLICT/u);
  assert.throws(() => assertComparisonOutputPath(sourcePaths[0], { suitePath, sourcePaths }), /OUTPUT_CONFLICT/u);
  assert.doesNotThrow(() => assertComparisonOutputPath(resolve('artifacts/recovery-comparison/safe.json'), { suitePath, sourcePaths }));
});
