import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCENARIOS = new Set(['completed-core', 'durable-remote', 'never-dispatched', 'missing-receipt',
  'receipt-unavailable', 'changed-artifact', 'deleted-artifact', 'wrong-task', 'dry-run', 'verification-failed',
  'verification-unavailable', 'external-transfer', 'multi-action', 'changed-roots', 'changed-command',
  'missing-file-evidence', 'duplicate-file-evidence', 'read-input-changed',
  'hash-empty', 'hash-small', 'hash-boundary', 'hash-large', 'hash-tail-mismatch',
  'hash-over-budget', 'hash-input-evidence', 'hash-mutation-during-read']);
const STATUSES = new Set(['recovered', 'blocked', 'not_dispatched']);
const ARMS = new Set(['current', 'reference-64k', 'buffered-read', 'negative-control']);
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function validateRecoverySuite(suite) {
  if (suite?.version !== 'jarvis-recovery-cases-v1' || !Array.isArray(suite.cases)
    || suite.cases.length < 2 || suite.cases.length > 200) fail('A_COMPARISON_INVALID_SUITE');
  const ids = new Set();
  const scenarios = new Set();
  for (const item of suite.cases) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/u.test(item.id ?? '') || ids.has(item.id)
      || !SCENARIOS.has(item.scenario) || scenarios.has(item.scenario)
      || !['development', 'holdout'].includes(item.split) || !STATUSES.has(item.expect?.status)
      || (item.expect.fileBytesRead !== undefined && (!Number.isSafeInteger(item.expect.fileBytesRead) || item.expect.fileBytesRead < 0))
      || typeof item.rationale !== 'string' || !item.rationale.trim()) fail('A_COMPARISON_INVALID_CASE');
    ids.add(item.id); scenarios.add(item.scenario);
  }
  for (const split of ['development', 'holdout']) {
    const cases = suite.cases.filter(item => item.split === split);
    // A reject-everything strategy must not pass either split.
    if (!cases.some(item => item.expect.status === 'recovered')
      || !cases.some(item => item.expect.status === 'blocked')) fail('A_COMPARISON_UNBALANCED_SPLIT');
  }
  return structuredClone(suite);
}

export function loadRecoverySuite(path) {
  const body = readFileSync(path);
  if (body.byteLength > 256 * 1024) fail('A_COMPARISON_SUITE_TOO_LARGE');
  return { suite: validateRecoverySuite(JSON.parse(body.toString('utf8').replace(/^\uFEFF/u, ''))), sha256: sha(body) };
}

export function comparisonChildEnvironment(env = process.env) {
  // Allowlist system requirements; do not pass account keys, user profile config,
  // proxy credentials or real runtime journal locations to the evaluation child.
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir',
    'pathext', 'lang', 'lc_all']);
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase()))),
    JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0',
    JARVIS_EXTERNAL_DEVICE_PROBES: '0', JARVIS_PERSONAL_PROFILE_ENABLED: '0' };
}

export async function runRecoverySample({ scenario, arm, timeoutMs, env = process.env,
  spawnImpl = spawn, terminationGraceMs = 500 } = {}) {
  if (!SCENARIOS.has(scenario) || !ARMS.has(arm)) fail('A_COMPARISON_UNKNOWN_ADAPTER');
  const sampleStart = performance.now();
  const sampleRoot = await mkdtemp(join(tmpdir(), 'jarvis-recovery-sample-'));
  let cleanupDeferred = false;
  let sample;
  try { sample = await new Promise(resolveResult => {
    const start = performance.now();
    let child, timer, terminateTimer, settleTimer, finished = false, outputBytes = 0, forcedError = null;
    const stdoutChunks = [];
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(terminateTimer); clearTimeout(settleTimer);
      resolveResult({ ...result, wallMs: performance.now() - start });
    };
    const abort = code => {
      if (forcedError || finished) return;
      forcedError = code;
      try { child.kill(); } catch {}
      terminateTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, terminationGraceMs);
      settleTimer = setTimeout(() => {
        let alive = Boolean(child.pid);
        if (child.pid) { try { process.kill(child.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; } }
        cleanupDeferred = alive;
        child.stdout.destroy(); child.stderr.destroy();
        child.unref?.();
        finish({ state: code === 'A_COMPARISON_TIMEOUT' ? 'timeout' : 'error', errorCode: code,
          terminationConfirmed: !alive, cleanupDeferred,
          ...(alive ? { retainedTemporaryDirectory: sampleRoot } : {}) });
      }, terminationGraceMs * 2);
    };
    try {
      child = spawnImpl(process.execPath, ['scripts/lib/recovery-comparison-worker.mjs', arm, scenario],
        { cwd: ROOT, env: { ...comparisonChildEnvironment(env), TEMP: sampleRoot, TMP: sampleRoot, TMPDIR: sampleRoot },
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { finish({ state: 'error', errorCode: 'A_COMPARISON_SPAWN_FAILED' }); return; }
    const count = chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) abort('A_COMPARISON_OUTPUT_LIMIT');
    };
    // Decode only after the bounded byte stream is complete. Pipe chunks may
    // split a Korean character; invalid UTF-8 must not alter evidence silently.
    child.stdout.on('data', chunk => { count(chunk); if (!forcedError) stdoutChunks.push(Buffer.from(chunk)); });
    child.stderr.on('data', count);
    child.once('error', () => finish({ state: 'error', errorCode: 'A_COMPARISON_SPAWN_FAILED' }));
    child.once('close', code => {
      if (forcedError) { finish({ state: forcedError === 'A_COMPARISON_TIMEOUT' ? 'timeout' : 'error', errorCode: forcedError }); return; }
      try {
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdoutChunks)));
        if (code !== 0 || payload.ok !== true) fail('A_COMPARISON_WORKER_FAILED');
        finish({ ...payload.sample, state: 'completed' });
      } catch { finish({ state: 'error', errorCode: 'A_COMPARISON_WORKER_FAILED' }); }
    });
    timer = setTimeout(() => abort('A_COMPARISON_TIMEOUT'), timeoutMs);
  }); } finally {
    const owned = relative(resolve(tmpdir()), resolve(sampleRoot));
    if (isAbsolute(owned) || !owned.startsWith('jarvis-recovery-sample-') || owned.includes('..')) fail('A_COMPARISON_TEMP_ROOT_INVALID');
    if (!cleanupDeferred) await rm(resolve(sampleRoot), { recursive: true, force: true, maxRetries: 3 });
  }
  return { ...sample, wallMs: performance.now() - sampleStart };
}

function validMetrics(metrics) {
  return metrics && ['externalModelCalls', 'inputTokens', 'outputTokens'].every(key =>
    Number.isSafeInteger(metrics[key]) && metrics[key] >= 0)
    && Number.isFinite(metrics.costUsd) && metrics.costUsd >= 0
    && typeof metrics.costBasis === 'string' && metrics.costBasis.length > 0;
}

function validIoMeasurement(metrics, arm) {
  if (!metrics || !['readCalls', 'bytesRead', 'maxRequestedBytes', 'configuredChunkBytes'].every(key =>
    Number.isSafeInteger(metrics[key]) && metrics[key] >= 0)) return false;
  const { readCalls, bytesRead, maxRequestedBytes, configuredChunkBytes } = metrics;
  if (!ARMS.has(arm) || configuredChunkBytes < 64 * 1024 || configuredChunkBytes > 1024 * 1024
    || (arm === 'reference-64k' && configuredChunkBytes !== 64 * 1024)
    || (arm === 'buffered-read' && configuredChunkBytes !== 1024 * 1024)
    || maxRequestedBytes > configuredChunkBytes) return false;
  // Current and its negative control follow the product default, within the
  // supported factory bounds. The two explicit experiment arms remain fixed.
  if (readCalls === 0) return bytesRead === 0 && maxRequestedBytes === 0;
  return maxRequestedBytes > 0 && BigInt(bytesRead) <= BigInt(readCalls) * BigInt(maxRequestedBytes);
}

export function assessRecoverySample(item, result, { arm = result?.arm } = {}) {
  const completed = result?.state === 'completed';
  const statusMatches = completed && result.status === item.expect.status;
  const noDuplicateExecution = completed && result.duplicateExecutionCount === 0;
  const metricsKnown = completed && validMetrics(result.metrics);
  const measurementValid = completed && Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0
    && Number.isFinite(result.wallMs) && result.wallMs >= 0;
  const localOnly = metricsKnown && result.metrics.externalModelCalls === 0
    && result.metrics.inputTokens === 0 && result.metrics.outputTokens === 0
    && result.metrics.costUsd === 0 && result.metrics.costBasis === 'local-no-model';
  const ioKnown = result?.ioMetrics && ['readCalls', 'bytesRead', 'maxRequestedBytes', 'configuredChunkBytes'].every(key =>
    Number.isSafeInteger(result.ioMetrics[key]) && result.ioMetrics[key] >= 0);
  const memoryKnown = result?.processMemory && ['baselineRssBytes', 'sampledPeakRssBytes', 'sampledPeakDeltaBytes', 'sampleCount', 'intervalMs'].every(key =>
    Number.isSafeInteger(result.processMemory[key]) && result.processMemory[key] >= 0)
    && result.processMemory.sampledPeakRssBytes >= result.processMemory.baselineRssBytes
    && result.processMemory.sampledPeakDeltaBytes === result.processMemory.sampledPeakRssBytes - result.processMemory.baselineRssBytes
    && result.processMemory.sampleCount >= 1 && result.processMemory.intervalMs >= 1
    && result.processMemory.scope === 'isolated-worker-process-rss-sampled-lower-bound';
  const memoryProvided = result?.processMemory !== undefined;
  const recoveryTimeKnown = Number.isFinite(result?.recoveryElapsedMs) && result.recoveryElapsedMs >= 0;
  const ioRequired = item.scenario.startsWith('hash-');
  const ioProvided = result?.ioMetrics !== undefined;
  const ioValid = Boolean(ioKnown && validIoMeasurement(result.ioMetrics, arm) && result.arm === arm);
  const checks = { statusMatches, noDuplicateExecution, metricsKnown, measurementValid, localOnly,
    ioMeasurementValid: !(ioRequired || ioProvided) || Boolean(ioValid && recoveryTimeKnown),
    requiredBytesRead: item.expect.fileBytesRead === undefined || Boolean(ioKnown && result.ioMetrics.bytesRead === item.expect.fileBytesRead),
    memoryMeasurementValid: !memoryProvided || Boolean(memoryKnown) };
  const reasonCodes = [];
  if (!completed) reasonCodes.push(result?.errorCode ?? 'A_COMPARISON_SAMPLE_MISSING');
  if (completed && !statusMatches) reasonCodes.push('A_COMPARISON_WRONG_RECOVERY_DECISION');
  if (completed && !noDuplicateExecution) reasonCodes.push('A_COMPARISON_DUPLICATE_EXECUTION');
  if (completed && !metricsKnown) reasonCodes.push('A_COMPARISON_USAGE_UNKNOWN');
  if (completed && !measurementValid) reasonCodes.push('A_COMPARISON_MEASUREMENT_INVALID');
  if (metricsKnown && !localOnly) reasonCodes.push('A_COMPARISON_NONLOCAL_USAGE');
  if ((ioRequired || ioProvided) && (!ioKnown || !recoveryTimeKnown)) reasonCodes.push('A_COMPARISON_IO_MEASUREMENT_MISSING');
  else if ((ioRequired || ioProvided) && !ioValid) reasonCodes.push('A_COMPARISON_IO_MEASUREMENT_INVALID');
  if (!checks.requiredBytesRead) reasonCodes.push('A_COMPARISON_REQUIRED_FILE_READS_MISSING');
  if (memoryProvided && !memoryKnown) reasonCodes.push('A_COMPARISON_MEMORY_MEASUREMENT_INVALID');
  return { outcome: completed ? Object.values(checks).every(Boolean) ? 'pass' : 'fail'
    : result?.state === 'timeout' ? 'timeout' : 'error', checks, reasonCodes,
    expectedStatus: item.expect.status, observedStatus: completed && STATUSES.has(result.status) ? result.status : null,
    recoveryErrorCode: typeof result?.errorCode === 'string' ? result.errorCode.slice(0, 150) : null,
    cleanupDeferred: result?.cleanupDeferred === true,
    retainedTemporaryDirectory: result?.cleanupDeferred === true ? result.retainedTemporaryDirectory ?? null : null,
    duplicateExecutionCount: Number.isSafeInteger(result?.duplicateExecutionCount) ? result.duplicateExecutionCount : null,
    evidence: completed ? { realFixtureFiles: result.evidence?.realFixtureFiles === true,
      persistedCheckpointRead: result.evidence?.persistedCheckpointRead === true,
      fixtureReceipts: result.evidence?.fixtureReceipts === true,
      verificationCalls: Number.isSafeInteger(result.evidence?.verificationCalls) ? result.evidence.verificationCalls : null,
      verificationImplementation: result.evidence?.verification?.implementation === 'ExecutionResultVerifier' ? 'ExecutionResultVerifier' : null,
      verificationCheckCount: Number.isSafeInteger(result.evidence?.verification?.checkCount) ? result.evidence.verification.checkCount : null,
      ...(item.scenario === 'hash-mutation-during-read' ? { duringReadMutation: {
        applied: result.evidence?.duringReadMutation?.applied === true,
        originalTailBytesWritten: result.evidence?.duringReadMutation?.originalTailBytesWritten ?? null,
        appendedBytes: result.evidence?.duringReadMutation?.appendedBytes ?? null
      } } : {}),
      negativeControl: result.negativeControl === true, controlMutationApplied: result.controlMutationApplied === true } : null,
    elapsedMs: measurementValid ? result.elapsedMs : null,
    recoveryElapsedMs: recoveryTimeKnown ? result.recoveryElapsedMs : null,
    ioMetrics: ioKnown ? Object.fromEntries(['readCalls', 'bytesRead', 'maxRequestedBytes', 'configuredChunkBytes']
      .map(key => [key, result.ioMetrics[key]])) : null,
    processMemory: memoryKnown ? Object.fromEntries(['baselineRssBytes', 'sampledPeakRssBytes', 'sampledPeakDeltaBytes', 'sampleCount', 'intervalMs', 'scope']
      .map(key => [key, result.processMemory[key]])) : null,
    wallMs: Number.isFinite(result?.wallMs) ? result.wallMs : null,
    usage: metricsKnown ? { externalModelCalls: result.metrics.externalModelCalls,
      inputTokens: result.metrics.inputTokens, outputTokens: result.metrics.outputTokens,
      costUsd: result.metrics.costUsd, costBasis: result.metrics.costBasis } : null };
}

function stats(values) {
  if (!values.length) return { count: 0, mean: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

function summarize(rows) {
  const knownUsage = rows.filter(row => row.usage);
  const complete = knownUsage.length === rows.length;
  const measuredIo = rows.filter(row => row.ioMetrics && row.checks.ioMeasurementValid);
  const completeIo = rows.length > 0 && measuredIo.length === rows.length;
  const measuredMemory = rows.filter(row => row.processMemory && row.checks.memoryMeasurementValid);
  const completeMemory = rows.length > 0 && measuredMemory.length === rows.length;
  return { total: rows.length, passed: rows.filter(row => row.outcome === 'pass').length,
    failed: rows.filter(row => row.outcome === 'fail').length,
    errors: rows.filter(row => row.outcome === 'error').length,
    timeouts: rows.filter(row => row.outcome === 'timeout').length,
    correctRecoveries: rows.filter(row => row.outcome === 'pass' && row.expectedStatus === 'recovered').length,
    correctBlocks: rows.filter(row => row.outcome === 'pass' && row.expectedStatus === 'blocked').length,
    correctNotDispatched: rows.filter(row => row.outcome === 'pass' && row.expectedStatus === 'not_dispatched').length,
    falseRecoveries: rows.filter(row => row.observedStatus === 'recovered' && row.expectedStatus !== 'recovered').length,
    falseBlocks: rows.filter(row => row.observedStatus === 'blocked' && row.expectedStatus !== 'blocked').length,
    elapsedMs: stats(rows.map(row => row.elapsedMs).filter(value => value !== null)),
    recoveryElapsedMs: stats(rows.map(row => row.recoveryElapsedMs).filter(value => value !== null)),
    io: { measuredSamples: measuredIo.length,
      readCalls: completeIo ? measuredIo.reduce((sum, row) => sum + row.ioMetrics.readCalls, 0) : null,
      bytesRead: completeIo ? measuredIo.reduce((sum, row) => sum + row.ioMetrics.bytesRead, 0) : null,
      maxRequestedBytes: completeIo ? Math.max(...measuredIo.map(row => row.ioMetrics.maxRequestedBytes)) : null },
    processMemory: { measuredSamples: measuredMemory.length,
      baselineRssBytes: completeMemory ? stats(measuredMemory.map(row => row.processMemory.baselineRssBytes)) : null,
      sampledPeakRssBytes: completeMemory ? stats(measuredMemory.map(row => row.processMemory.sampledPeakRssBytes)) : null,
      sampledPeakDeltaBytes: completeMemory ? stats(measuredMemory.map(row => row.processMemory.sampledPeakDeltaBytes)) : null,
      samplesTaken: completeMemory ? measuredMemory.reduce((sum, row) => sum + row.processMemory.sampleCount, 0) : null,
      intervalMs: completeMemory ? Math.min(...measuredMemory.map(row => row.processMemory.intervalMs)) : null,
      meaning: completeMemory ? 'sampled lower-bound RSS of each isolated worker process; not a precise peak or product-wide memory measurement' : 'not measured' },
    wallMs: stats(rows.map(row => row.wallMs).filter(value => value !== null)),
    usageKnown: complete,
    externalModelCalls: complete ? knownUsage.reduce((n, row) => n + row.usage.externalModelCalls, 0) : null,
    externalModelCostUsd: complete ? knownUsage.reduce((n, row) => n + row.usage.costUsd, 0) : null,
    localComputeCostUsd: null };
}

export async function runRecoveryComparison({ suite: input, suiteSha256 = null, candidate = 'current', baseline = 'current', repetitions = 3,
  timeoutMs = 5000, concurrency = 1, sampleRunner = runRecoverySample } = {}) {
  const suite = validateRecoverySuite(input);
  if (!ARMS.has(candidate) || !['current', 'reference-64k'].includes(baseline) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('A_COMPARISON_INVALID_OPTIONS');
  const startedAt = new Date().toISOString();
  const jobs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (let index = 0; index < suite.cases.length; index++) {
      const item = suite.cases[index];
      // Alternate first position within each pair instead of timing all baselines first.
      const order = (index + repetition) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      jobs.push({ item, repetition, order });
    }
  }
  const pairedResults = new Array(jobs.length);
  let nextJob = 0;
  const runPair = async () => {
    while (true) {
      const jobIndex = nextJob++;
      if (jobIndex >= jobs.length) return;
      const { item, repetition, order } = jobs[jobIndex];
      const pair = [];
      for (const arm of order) {
        let result;
        const requestedArm = arm === 'baseline' ? baseline : candidate;
        const sampleStartedAt = new Date().toISOString();
        try { result = await sampleRunner({ scenario: item.scenario, arm: requestedArm, timeoutMs }); }
        catch { result = { state: 'error', errorCode: 'A_COMPARISON_RUNNER_FAILED' }; }
        const sampleFinishedAt = new Date().toISOString();
        pair.push({ caseId: item.id, split: item.split, arm, repetition, sampleStartedAt, sampleFinishedAt,
          ...assessRecoverySample(item, result, { arm: requestedArm }) });
      }
      pairedResults[jobIndex] = pair;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, runPair));
  const samples = pairedResults.flat();
  const summary = Object.fromEntries(['baseline', 'candidate'].map(arm => [arm,
    Object.fromEntries(['development', 'holdout', 'all'].map(split => [split,
      summarize(samples.filter(row => row.arm === arm && (split === 'all' || row.split === split)))]))]));
  const regressions = samples.filter(row => row.arm === 'candidate' && row.outcome !== 'pass' && samples.some(base =>
    base.arm === 'baseline' && base.caseId === row.caseId && base.repetition === row.repetition && base.outcome === 'pass'));
  const candidateFailures = summary.candidate.all.total - summary.candidate.all.passed;
  const baselineFailures = summary.baseline.all.total - summary.baseline.all.passed;
  const reasonCodes = [];
  if (baselineFailures) reasonCodes.push('BASELINE_DOES_NOT_MEET_FIXED_CONTRACT');
  if (candidateFailures) reasonCodes.push('CANDIDATE_DOES_NOT_MEET_FIXED_CONTRACT');
  if (regressions.length) reasonCodes.push('PAIRED_REGRESSIONS');
  if (candidate === baseline) reasonCodes.push('SAME_IMPLEMENTATION_CALIBRATION_ONLY');
  if (candidate === 'negative-control') reasonCodes.push('NEGATIVE_CONTROL_IS_NOT_AN_OPTIMIZATION');
  const decision = baselineFailures ? 'inconclusive' : candidateFailures ? 'reject'
    : candidate === baseline ? 'calibration-passed' : 'requires-independent-review';
  return { version: 'jarvis-recovery-comparison-v1', startedAt, finishedAt: new Date().toISOString(),
    suite: { version: suite.version, sha256: suiteSha256 ?? sha(JSON.stringify(suite)), caseCount: suite.cases.length,
      splitCounts: Object.fromEntries(['development', 'holdout'].map(split => [split, suite.cases.filter(item => item.split === split).length])) },
    protocol: { repetitions, timeoutMs, concurrency, baseline, candidate,
      executionOrder: 'alternating-paired; pairs-run-with-bounded-concurrency', isolation: 'separate-process-per-sample-with-system-env-allowlist',
      caseAnswersSentToAdapter: false, holdout: 'fixed-independently-authored-regression-set-not-secret',
      timingScope: 'adapter-including-fixture-setup-and-cleanup; wallMs-includes-process-startup',
      recoveryTimingScope: 'recoverMissionAction-only; excludes fixture setup, cleanup and process startup',
      ioScope: 'actual recovery FileHandle.read return values including EOF; excludes fixture preparation; maxRequestedBytes is per-read buffer, not process RSS',
      memoryScope: 'isolated worker process RSS baseline and 2ms sampled values during fixture setup, recovery and cleanup; sampled peak is a lower bound and sampling overhead applies equally to both arms' },
    caseResults: suite.cases.map(item => ({ id: item.id, scenario: item.scenario, split: item.split,
      baseline: summarize(samples.filter(row => row.caseId === item.id && row.arm === 'baseline')),
      candidate: summarize(samples.filter(row => row.caseId === item.id && row.arm === 'candidate')) })),
    summary, comparison: { decision, reasonCodes, regressionCaseIds: [...new Set(regressions.map(row => row.caseId))],
      automaticallyAdopted: false, claimedImprovement: false }, samples,
    boundaries: { productionActivation: false, actualExternalModelEvaluation: false, actualDeviceEvaluation: false,
      realUserDataUsed: false, localComputeCostMeasured: false,
      syntheticReceipts: true, actualRecoveryFunction: true, actualGExecutionResultVerifier: true,
      actualRemoteTransportOrCrash: false, fullCorePolicyExecutionMemoryCycle: false,
      purpose: 'local-recovery-contract-evaluation; not whole-task or general agent success rate' } };
}
