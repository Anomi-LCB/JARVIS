import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { FileMissionStore } from '../packages/core/src/mission/mission-store.js';
import { MissionStatus } from '../packages/core/src/mission/mission-runtime.js';

function context(plannerCalls = 2) {
  return {
    mission: {
      objective: '작업 폴더의 파일 목록을 확인한다.',
      successCriteria: [],
      constraints: [],
      remainingBudget: { plannerCalls, activeRuntimeMs: 60_000 }
    },
    capabilities: [{ toolName: 'filesystem.listFiles', readOnly: true }],
    observations: []
  };
}

function response() {
  return JSON.stringify({ decision: 'continue', summary: '목록 확인', actions: [{
    id: 'list', title: '목록', command: '작업 폴더 파일 목록을 보여줘',
    expectedToolName: 'filesystem.listFiles', arguments: { directory: '.' },
    dependencies: [], successSignal: '목록 반환'
  }], criteriaAssessment: [] });
}

function plannerFor(runner, options = {}) {
  return new GoalExecutivePlanner({ runner, timeoutMs: 15_000, retryTimeoutMs: 5_000, ...options });
}

function measured(runner, inputTokens, outputTokens, costUsd) {
  runner.lastUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  runner.lastCostUsd = costUsd;
}

test('planner preserves both billed schema-repair attempts and their total while keeping final-attempt fields', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    measured(runner, calls * 10, calls, calls / 100);
    return calls === 1 ? 'invalid response' : response();
  };
  const plan = await plannerFor(runner).planNextWave(context());
  assert.equal(plan.decision, 'continue');
  assert.deepEqual(plan.planning.attempts.map(({ status }) => status), ['invalid-response', 'succeeded']);
  assert.deepEqual(plan.planning.usageTotals.total, { inputTokens: 30, outputTokens: 3, totalTokens: 33, costUsd: 0.03 });
  assert.deepEqual(plan.planning.usage, { inputTokens: 20, outputTokens: 2, totalTokens: 22 });
  assert.equal(plan.planning.costUsd, 0.02);
  for (const attempt of plan.planning.attempts) {
    assert.ok(Number.isFinite(Date.parse(attempt.startedAt)));
    assert.ok(Number.isFinite(Date.parse(attempt.finishedAt)));
    assert.ok(attempt.latencyMs >= 0);
    assert.ok(attempt.promptChars > 0);
  }
  measured(runner, 999, 999, 999);
  assert.equal(plan.planning.attempts[0].usage.inputTokens, 10);
});

test('an unmetered failed attempt makes complete totals unknown without losing observed retry usage', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('transient timeout'), { code: 'ETIMEDOUT', retryable: true });
    measured(runner, 20, 5, 0.02);
    return response();
  };
  const plan = await plannerFor(runner).planNextWave(context());
  assert.equal(plan.planning.attempts[0].status, 'timed-out');
  assert.deepEqual(plan.planning.usageTotals.known, { inputTokens: 20, outputTokens: 5, totalTokens: 25, costUsd: 0.02 });
  assert.deepEqual(plan.planning.usageTotals.total, { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
  assert.equal(plan.planning.usageTotals.unknownAttempts.costUsd, 1);
});

test('unchanged mutable runner properties are never counted again after an earlier success', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    if (calls === 1) measured(runner, 8, 2, 0.01);
    return calls === 1 ? 'invalid response' : response();
  };
  const plan = await plannerFor(runner).planNextWave(context());
  assert.equal(plan.planning.attempts[1].usage, null);
  assert.equal(plan.planning.attempts[1].costUsd, null);
  assert.equal(plan.planning.usage, null);
  assert.equal(plan.planning.costUsd, null);
  assert.equal(plan.planning.usageTotals.known.totalTokens, 10);
  assert.equal(plan.planning.usageTotals.total.totalTokens, null);
});

test('null, empty strings and malformed usage stay unknown while explicitly reported zero remains zero', async () => {
  const runner = async () => {
    runner.lastUsage = { inputTokens: 0, outputTokens: null, totalTokens: '' };
    runner.lastCostUsd = null;
    return response();
  };
  const plan = await plannerFor(runner).planNextWave(context(1));
  assert.deepEqual(plan.planning.usageTotals.total, { inputTokens: 0, outputTokens: null, totalTokens: null, costUsd: null });
  assert.equal(plan.planning.usageTotals.complete, false);
});

test('failure and local fallback retain freshly observed usage without declaring a total for hidden provider calls', async () => {
  const runner = async () => {
    measured(runner, 12, 4, 0.03);
    throw Object.assign(new Error('permanent failure'), { code: 'EAUTH' });
  };
  const plan = await plannerFor(runner).planNextWave(context());
  assert.equal(plan.planning.attemptCount, 1);
  assert.equal(plan.planning.attempts[0].status, 'failed');
  assert.equal(plan.planning.attempts[0].errorCode, 'EAUTH');
  assert.equal(plan.planning.usageTotals.known.totalTokens, 16);
  assert.equal(plan.planning.usageTotals.scope, 'planner-runner-attempts');
  assert.equal(plan.planning.usageTotals.providerInternalAttemptsIncluded, false);
  assert.equal(plan.planning.usageTotals.billingTotalVerified, false);
});

test('all-invalid exhaustion keeps attempt accounting in the resumable pause', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    measured(runner, calls, 1, calls / 1000);
    return 'invalid response';
  };
  const plan = await plannerFor(runner).planNextWave(context());
  assert.equal(plan.decision, 'pause');
  assert.equal(plan.planning.attempts.length, 2);
  assert.equal(plan.planning.usageTotals.total.totalTokens, 5);
});

test('simultaneous planners sharing a runner do not attribute mutable usage to either call', async () => {
  const pending = [];
  const runner = () => new Promise((resolve) => pending.push(resolve));
  const first = plannerFor(runner).planNextWave(context(1));
  const second = plannerFor(runner).planNextWave(context(1));
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);
  measured(runner, 10, 1, 0.01);
  pending[0](response());
  const firstPlan = await first;
  measured(runner, 20, 2, 0.02);
  pending[1](response());
  const secondPlan = await second;
  for (const plan of [firstPlan, secondPlan]) {
    assert.equal(plan.planning.usage, null);
    assert.equal(plan.planning.costUsd, null);
    assert.ok(plan.planning.attempts[0].measurement.reasons.includes('shared-runner-overlap'));
  }
});

test('operator abort preserves the original error and attaches attempt evidence without retrying', async () => {
  const controller = new AbortController();
  const abortReason = new Error('operator cancelled');
  const runner = async () => {
    measured(runner, 3, 1, 0.001);
    controller.abort(abortReason);
    return 'invalid response';
  };
  await assert.rejects(plannerFor(runner).planNextWave(context(), { signal: controller.signal }), (error) => {
    assert.equal(error, abortReason);
    assert.equal(error.plannerAccounting.attempts.length, 1);
    assert.equal(error.plannerAccounting.attempts[0].status, 'aborted');
    assert.equal(error.plannerAccounting.usageTotals.known.totalTokens, 4);
    return true;
  });
});

test('a timed-out runner that ignores abort cannot donate late usage to the retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  const runner = () => new Promise((resolve) => pending.push(resolve));
  const planner = plannerFor(runner, { timeoutMs: 5_000, retryTimeoutMs: 5_000 });
  const planned = planner.planNextWave(context());
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  t.mock.timers.tick(5_000);
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);

  measured(runner, 100, 10, 1);
  pending[0](response());
  await new Promise(setImmediate);
  measured(runner, 20, 2, 0.02);
  pending[1](response());
  const plan = await planned;
  assert.deepEqual(plan.planning.attempts.map(({ status }) => status), ['timed-out', 'succeeded']);
  assert.ok(plan.planning.attempts[0].measurement.reasons.includes('runner-not-settled'));
  assert.ok(plan.planning.attempts[1].measurement.reasons.includes('shared-runner-overlap'));
  assert.equal(plan.planning.usageTotals.known.totalTokens, 0);
  assert.equal(plan.planning.usageTotals.total.totalTokens, null);

  const later = planner.planNextWave(context(1));
  await new Promise(setImmediate);
  measured(runner, 3, 1, 0.001);
  pending[2](response());
  const laterPlan = await later;
  assert.equal(laterPlan.planning.usageTotals.total.totalTokens, 4);
  assert.equal(plan.planning.attempts[0].usage, null);
});

test('equal repeated cost remains unknown unless the runner contract exposes new attribution', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    measured(runner, 10, 1, 0.01);
    return calls === 1 ? 'invalid' : response();
  };
  const plan = await plannerFor(runner).planNextWave(context());
  assert.equal(plan.planning.usageTotals.total.totalTokens, 22);
  assert.equal(plan.planning.usageTotals.total.costUsd, null);
  assert.equal(plan.planning.usageTotals.known.costUsd, 0.01);
  assert.equal(plan.planning.usageTotals.unknownAttempts.costUsd, 1);
});

test('a zero-call budget never invokes the runner and reports zero planner attempt consumption', async () => {
  let calls = 0;
  const plan = await plannerFor(async () => { calls += 1; return response(); }).planNextWave(context(0));
  assert.equal(calls, 0);
  assert.equal(plan.decision, 'pause');
  assert.deepEqual(plan.planning.attempts, []);
  assert.deepEqual(plan.planning.usageTotals.total, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
});

test('a valid response arriving after operator cancellation cannot become a successful attempt', async () => {
  const controller = new AbortController();
  const abortReason = new Error('operator cancelled valid response');
  const runner = async () => {
    measured(runner, 1, 1, 0);
    controller.abort(abortReason);
    return response();
  };
  await assert.rejects(plannerFor(runner).planNextWave(context(), { signal: controller.signal }), (error) => {
    assert.equal(error, abortReason);
    assert.equal(error.plannerAccounting.attempts[0].status, 'aborted');
    assert.equal(error.plannerAccounting.usageTotals.total.costUsd, 0);
    return true;
  });
});

test('cache and reasoning token details survive the final usage without being added to totalTokens again', async () => {
  const runner = async () => {
    measured(runner, 20, 10, 0.03);
    Object.assign(runner.lastUsage, { cacheReadTokens: 8, cacheCreationTokens: 4, reasoningTokens: 6 });
    return response();
  };
  const plan = await plannerFor(runner).planNextWave(context(1));
  assert.deepEqual(plan.planning.usage, {
    inputTokens: 20, outputTokens: 10, totalTokens: 30,
    cacheReadTokens: 8, cacheCreationTokens: 4, reasoningTokens: 6
  });
  assert.deepEqual(plan.planning.attempts[0].usage, plan.planning.usage);
  assert.equal(plan.planning.usageTotals.total.totalTokens, 30);
});

for (const cancellationMode of ['reject', 'respond-after-abort']) {
test(`cancelling a real Mission run persists typed accounting for file-store reload (${cancellationMode})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-planner-usage-persist-'));
  try {
    const secretMarker = 'TEST_RAW_METADATA_MUST_NOT_PERSIST';
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    const runner = async (_prompt, { signal }) => {
      enter();
      return await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          measured(runner, 17, 4, 0.004);
          runner.lastUsage.cacheReadTokens = 3;
          runner.lastUsage.rawResponse = secretMarker;
          runner.lastModel = secretMarker;
          if (cancellationMode === 'respond-after-abort') {
            resolve(response());
            return;
          }
          const error = new Error(secretMarker);
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    };
    const storePath = join(root, 'audit', 'missions.json');
    const runtime = createAgRuntime({
      allowedRoots: [root], auditRoot: join(root, 'audit'), missionStorePath: storePath,
      cwd: () => root, env: {}, missionPlanner: plannerFor(runner), workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({ objective: '계획 중 취소하고 기록 보존 여부를 확인한다.' });
    const running = runtime.missionRuntime.runMission(created.missionId);
    await entered;
    runtime.missionRuntime.cancelMission(created.missionId, { reason: 'test-cancel-accounting' });
    const finished = await running;
    assert.equal(finished.status, MissionStatus.CANCELLED);
    assert.equal(finished.metrics.plannerCalls, 1);
    assert.equal(finished.metrics.plannerAttempts, 1);
    assert.equal(finished.metrics.plannerRetries, 0);
    assert.equal(finished.planHistory.length, 1);
    assert.equal(finished.planHistory[0].decision, 'aborted');
    assert.equal(finished.planHistory[0].planning.attempts[0].status, 'aborted');
    assert.equal(finished.planHistory[0].planning.usageTotals.total.totalTokens, 21);
    assert.equal(finished.planHistory[0].planning.usageTotals.total.costUsd, 0.004);
    assert.equal(finished.planHistory[0].planning.attempts[0].usage.cacheReadTokens, 3);

    const reloaded = new FileMissionStore({ filePath: storePath }).load().find((mission) => mission.missionId === created.missionId);
    assert.equal(reloaded.status, MissionStatus.CANCELLED);
    assert.deepEqual(reloaded.planHistory, finished.planHistory);
    assert.equal(reloaded.metrics.plannerAttempts, 1);
    assert.doesNotMatch(await readFile(storePath, 'utf8'), new RegExp(secretMarker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
}
