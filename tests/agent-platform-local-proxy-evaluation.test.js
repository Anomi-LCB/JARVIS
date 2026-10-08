import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

test('local recovery proxy report records repeated, schema-shaped measurements without passing public scenarios', () => {
  const latestReportPath = new URL('../artifacts/agent-platform-20260929/local-proxy-evaluation.json', import.meta.url);
  const previous = existsSync(latestReportPath) ? JSON.parse(readFileSync(latestReportPath, 'utf8')) : null;
  const previousImmutable = previous?.evidence?.runReport
    ? new URL(`../${previous.evidence.runReport}`, import.meta.url) : null;
  const previousImmutableBefore = previousImmutable && existsSync(previousImmutable)
    ? readFileSync(previousImmutable) : null;
  const childEnv = {
    ...process.env,
    JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0',
    JARVIS_ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY: '', JARVIS_OPENAI_API_KEY: '', OPENAI_API_KEY: '',
    JARVIS_XAI_API_KEY: '', JARVIS_META_API_KEY: '', JARVIS_GEMINI_API_KEY: '',
    JARVIS_EXTERNAL_DEVICE_PROBES: '0', JARVIS_TEST_MODE: '1'
  };
  delete childEnv.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['scripts/agent-platform-local-proxy-evaluation.mjs'], {
    cwd: new URL('..', import.meta.url),
    windowsHide: true,
    timeout: 90_000,
    env: childEnv
  });

  const report = JSON.parse(readFileSync(latestReportPath, 'utf8'));
  assert.equal(report.repetitionsPerConfiguration, 3);
  assert.equal(report.publicScenariosExecuted, 0);
  assert.equal(report.publicScenarioStatus, 'not-run');
  assert.match(report.oracleIndependence, /S10, G08, G09, G10, G10B, G03, G12, G01, G02, and G02X/u);
  assert.equal(report.counts.independentOracleRuns, 30);
  assert.match(report.runId, /^\d{8}T\d{9}Z-[0-9a-f-]{36}$/u);
  const immutableReport = new URL(`../${report.evidence.runReport}`, import.meta.url);
  const immutableLog = new URL(`../${report.evidence.testLog}`, import.meta.url);
  assert.ok(existsSync(immutableReport));
  assert.ok(existsSync(immutableLog));
  assert.deepEqual(JSON.parse(readFileSync(immutableReport, 'utf8')), report);
  assert.equal(report.measurements.length, 30);
  assert.deepEqual(report.measurements.map(item => `${item.scenarioId}:${item.repetition}`), [
    'G08:1', 'G08:2', 'G08:3',
    'G09:1', 'G09:2', 'G09:3',
    'G10:1', 'G10:2', 'G10:3',
    'G10B:1', 'G10B:2', 'G10B:3',
    'G03:1', 'G03:2', 'G03:3',
    'G12:1', 'G12:2', 'G12:3', 'G01:1', 'G01:2', 'G01:3',
    'G02X:1', 'G02X:2', 'G02X:3', 'S10:1', 'S10:2', 'S10:3', 'G02:1', 'G02:2', 'G02:3'
  ]);
  for (const item of report.measurements) {
    assert.equal(item.measurementKind, 'local-runtime-with-independent-programmatic-oracle');
    assert.equal(item.scenarioExecutionStatus, 'not-run');
    assert.ok(['completed', 'failed'].includes(item.status));
    assert.ok(item.requirementResults.length > 0);
    assert.ok(item.requirementResults.every(result => result.verification === 'separate-process-programmatic-oracle'));
    assert.ok(item.evidencePaths.length > 0);
    assert.ok(Number.isFinite(item.latencyMs) && item.latencyMs >= 0);
    assert.equal(item.providerCalls, 0);
    assert.equal(item.retries, 0);
    assert.equal(item.questions, null);
    assert.equal(item.approvals, null);
    assert.equal(item.costUsd, null);
    assert.equal(item.costMeasurement, 'unmeasured');
  }
  for (const item of report.measurements) {
    assert.equal(item.oracle.status, 'passed');
    assert.equal(item.oracle.independence,
      'separate-process-separate-predicate-implementation; same project, not independent human authoring');
    const oraclePath = new URL(`../${item.oracle.resultPath}`, import.meta.url);
    assert.ok(existsSync(oraclePath));
    const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
    assert.equal(oracle.scenarioId, item.scenarioId);
    assert.equal(oracle.checks.length, item.scenarioId === 'S10' ? 6 : ['G03', 'G08'].includes(item.scenarioId) ? 7 : item.scenarioId === 'G09' ? 8 : item.scenarioId === 'G10' ? 8 : item.scenarioId === 'G10B' ? 6 : item.scenarioId === 'G01' ? 10 : item.scenarioId === 'G02' ? 7 : item.scenarioId === 'G02X' ? 8 : 9);
    assert.ok(oracle.checks.every(check => check.status === 'passed'));
  }
  assert.equal(report.counts.failed, 0);
  assert.ok(report.latencyMs.p50 > 0);
  assert.ok(report.latencyMs.p95 >= report.latencyMs.p50);
  if (previousImmutableBefore) assert.deepEqual(readFileSync(previousImmutable), previousImmutableBefore);
});


