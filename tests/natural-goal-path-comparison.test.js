import test from 'node:test';
import assert from 'node:assert/strict';
import { runNaturalGoalPathComparison } from '../scripts/natural-goal-path-comparison.mjs';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

test('comparison preserves the original oracle and supports typed summaries while refusing wrong content and extra demands', async () => {
  const report = await runNaturalGoalPathComparison({ repetitions: 1 });
  assert.equal(report.passed, true);
  assert.deepEqual(report.failedIds, []);
  assert.equal(report.completed, 2);
  assert.equal(report.expectedNonCompletion, 4);
  for (const result of report.results) {
    assert.equal(result.localCompiler.status, result.id.startsWith('typed-') ? 'blocked' : 'absent');
    assert.equal(result.oracle.objectivePreserved, true);
    assert.equal(result.oracle.sourceObserved, true);
    assert.equal(result.oracle.noFalseCompletion, true);
    assert.equal(result.writeCount, 1);
  }
  assert.equal(report.modelCalls, 0);
  assert.equal(report.actualCost, null);
  const counterexample = report.results.find(value => value.id === 'typed-unsegmented-summary');
  assert.equal(counterexample.oracle.outputMatches, true);
  assert.equal(counterexample.missionStatus, 'COMPLETED');
  const extra = report.results.find(value => value.id === 'typed-unparsed-extra-demand');
  assert.notEqual(extra.missionStatus,'COMPLETED');
});

test('runtime failure remains in the denominator and later real execution cases still run', async () => {
  let calls = 0;
  const report = await runNaturalGoalPathComparison({ repetitions: 1, runtimeFactory: options => {
    calls++;
    if (calls === 1) throw new Error('private provider message must not appear');
    const runtime = createAgRuntime(options);
    if (calls === 2) runtime.missionRuntime.runMission = async () => {
      throw Object.assign(new Error('sensitive account information'), { code: 'INJECTED_RUNTIME_FAILURE' });
    };
    return runtime;
  } });
  assert.equal(calls, 6);
  assert.equal(report.runs, report.scheduledRuns);
  assert.equal(report.runs, 6);
  assert.equal(report.errorRuns, 2);
  assert.equal(report.passed, false);
  assert.equal(report.expectedNonCompletion, 3);
  assert.equal(report.completed, 1);
  assert.equal(report.results[0].errorCode, 'COMPARISON_SAMPLE_ERROR');
  assert.equal(report.results[1].errorCode, 'INJECTED_RUNTIME_FAILURE');
  assert.equal(report.results[1].missionStatus, 'ERROR');
  assert.equal(report.results[4].passed, true);
  assert.equal(report.actualCost, null);
  assert.doesNotMatch(JSON.stringify(report), /sensitive account|private provider/);
  for (const sample of report.results) {
    assert.ok(Number.isFinite(sample.latencyMs));
    assert.ok(Date.parse(sample.sampleFinishedAt) >= Date.parse(sample.sampleStartedAt));
  }
});
