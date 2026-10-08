// Runner metadata is mutable and has no request id. Only record values whose
// freshness we can observe; overlapping callers cannot safely share attribution.
const activeRunnerCalls = new WeakMap();
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens'];
const usageFields = [...tokenFields, 'cacheReadTokens', 'cacheCreationTokens', 'reasoningTokens'];
const metricFields = [...tokenFields, 'costUsd'];
const accountingVersion = 'a-planner-attempt-accounting-v1';

function finiteNonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function snapshotUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = Object.fromEntries(usageFields
    .map((field) => [field, finiteNonnegative(value[field])])
    .filter(([, count]) => count !== null));
  return Object.keys(usage).length > 0 ? usage : null;
}

function metadataSnapshot(runner) {
  return {
    usageReference: runner.lastUsage,
    usage: snapshotUsage(runner.lastUsage),
    costUsd: finiteNonnegative(runner.lastCostUsd),
    provider: runner.lastProvider,
    externalService: runner.lastExternalService,
    model: runner.lastModel
  };
}

export function observePlannerAttempt(runner, { attempt, timeoutMs, promptChars }) {
  const startedAtMs = Date.now();
  const startedAtMonotonic = performance.now();
  const state = { overlapped: false, settled: false, before: null, after: null, receipt: null };
  const observedRunner = async (prompt, options) => {
    const active = activeRunnerCalls.get(runner) ?? new Set();
    activeRunnerCalls.set(runner, active);
    if (active.size > 0) {
      state.overlapped = true;
      for (const other of active) other.overlapped = true;
    }
    active.add(state);
    state.before = metadataSnapshot(runner);
    try {
      if (typeof runner.runWithReceipt === 'function') {
        const receipt = await runner.runWithReceipt(prompt, options);
        state.receipt = receipt;
        return receipt.output;
      }
      return await runner(prompt, options);
    } catch (error) {
      if (typeof runner.runWithReceipt === 'function') state.receipt = error?.modelReceipt ?? null;
      throw error;
    } finally {
      state.after = metadataSnapshot(runner);
      state.settled = true;
      active.delete(state);
      if (active.size === 0) activeRunnerCalls.delete(runner);
    }
  };
  return {
    runner: observedRunner,
    finish({ status, errorCode = null, retryable = false }) {
      const { before, after } = state;
      const receipt = state.receipt && typeof state.receipt.requestId === 'string'
        && /^[a-f0-9-]{36}$/u.test(state.receipt.requestId) ? state.receipt : null;
      const attributable = state.settled && (receipt !== null || !state.overlapped);
      const changedUsage = after?.usage && (after.usageReference !== before?.usageReference
        || usageFields.some((field) => after.usage[field] !== before?.usage?.[field]));
      const changedCost = after?.costUsd !== null && after?.costUsd !== undefined
        && after.costUsd !== before?.costUsd;
      const usage = receipt ? snapshotUsage(receipt.usage) : attributable && changedUsage ? { ...after.usage } : null;
      const costUsd = receipt ? finiteNonnegative(receipt.costUsd) : attributable && changedCost ? after.costUsd : null;
      const reasons = [];
      if (!state.settled) reasons.push('runner-not-settled');
      if (state.overlapped && !receipt) reasons.push('shared-runner-overlap');
      if (!usage) reasons.push('usage-missing-or-freshness-unconfirmed');
      if (costUsd === null) reasons.push('cost-missing-or-freshness-unconfirmed');
      const freshMetadata = attributable && (changedUsage || changedCost);
      return {
        attempt, status, errorCode, retryable,
        ...(receipt ? { requestId: receipt.requestId, metadataSource: 'request-receipt' } : {}),
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        latencyMs: Math.max(0, performance.now() - startedAtMonotonic),
        timeoutMs, promptChars,
        provider: freshMetadata ? after.provider ?? runner.provider ?? null : runner.provider ?? null,
        externalService: freshMetadata ? after.externalService ?? runner.externalService ?? null : runner.externalService ?? null,
        model: freshMetadata ? after.model ?? runner.model ?? null : runner.model ?? null,
        usage, costUsd,
        measurement: {
          usage: usage ? 'observed' : 'unknown',
          cost: costUsd !== null ? 'observed' : 'unknown',
          reasons
        }
      };
    }
  };
}

export function plannerAttemptAccounting(attempts) {
  const known = Object.fromEntries(metricFields.map((field) => [field, 0]));
  const unknownAttempts = { ...known };
  for (const attempt of attempts) {
    for (const field of metricFields) {
      const value = field === 'costUsd' ? attempt.costUsd : attempt.usage?.[field];
      if (finiteNonnegative(value) === null) unknownAttempts[field] += 1;
      else known[field] += value;
    }
  }
  return {
    accountingVersion,
    attempts,
    usageTotals: {
      scope: 'planner-runner-attempts',
      attemptCount: attempts.length,
      known,
      total: Object.fromEntries(metricFields.map((field) => [field, unknownAttempts[field] === 0 ? known[field] : null])),
      unknownAttempts,
      complete: metricFields.every((field) => unknownAttempts[field] === 0),
      providerInternalAttemptsIncluded: false,
      billingTotalVerified: false,
      limitations: [
        'Provider-internal HTTP retries and fallback usage are not exposed by the runner contract.',
        'Unchanged mutable values have unconfirmed freshness, including repeated equal costs.',
        'Overlap detection covers calls made through this planner observer; other runner consumers are not instrumented.'
      ]
    }
  };
}

// Exception objects may contain provider responses or arbitrary metadata. The
// persisted interruption record accepts only fixed labels, timestamps and numbers.
export function sanitizePlannerExceptionAccounting(value) {
  if (value?.accountingVersion !== accountingVersion || !Array.isArray(value.attempts)
    || value.attempts.length === 0 || value.attempts.length > 3) return null;
  const statuses = new Set(['succeeded', 'invalid-response', 'failed', 'timed-out', 'aborted']);
  const errorCodes = new Set(['ABORT_ERR', 'ETIMEDOUT', 'A_MISSION_PLANNER_INVALID_RESPONSE']);
  const reasons = new Set([
    'runner-not-settled', 'shared-runner-overlap',
    'usage-missing-or-freshness-unconfirmed', 'cost-missing-or-freshness-unconfirmed'
  ]);
  const stamp = (input) => typeof input === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input)
    && Number.isFinite(Date.parse(input)) ? input : null;
  if (value.attempts.some((attempt) => !attempt || !statuses.has(attempt.status))) return null;
  const attempts = value.attempts.map((attempt, index) => {
    const usage = snapshotUsage(attempt.usage);
    const costUsd = finiteNonnegative(attempt.costUsd);
    return {
      attempt: index + 1,
      status: attempt.status,
      errorCode: attempt.errorCode === null ? null
        : errorCodes.has(attempt.errorCode) ? attempt.errorCode : 'A_MISSION_PLANNER_EXECUTION_FAILED',
      retryable: attempt.retryable === true,
      startedAt: stamp(attempt.startedAt),
      finishedAt: stamp(attempt.finishedAt),
      latencyMs: finiteNonnegative(attempt.latencyMs),
      timeoutMs: finiteNonnegative(attempt.timeoutMs),
      promptChars: finiteNonnegative(attempt.promptChars),
      usage, costUsd,
      measurement: {
        usage: usage ? 'observed' : 'unknown',
        cost: costUsd !== null ? 'observed' : 'unknown',
        reasons: (Array.isArray(attempt.measurement?.reasons) ? attempt.measurement.reasons : [])
          .filter((reason) => reasons.has(reason)).slice(0, reasons.size)
      }
    };
  });
  return plannerAttemptAccounting(attempts);
}

export function withPlannerAttemptAccounting(plan, attempts) {
  const last = attempts.at(-1);
  return {
    ...plan,
    planning: {
      ...plan.planning,
      ...plannerAttemptAccounting(attempts),
      attemptCount: attempts.length,
      retryCount: Math.max(0, attempts.length - 1),
      attemptTimeoutsMs: attempts.map((attempt) => attempt.timeoutMs),
      rawObjectiveSharedWithModel: attempts.length > 0,
      // Preserve the existing final-attempt meaning of these fields. Totals are
      // separate so existing consumers never silently switch to a different unit.
      usage: last?.usage ?? null,
      costUsd: last?.costUsd ?? null
    }
  };
}
