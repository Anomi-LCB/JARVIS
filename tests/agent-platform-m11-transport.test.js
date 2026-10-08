import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMissionPlannerFromEnv } from '../packages/core/src/mission/mission-planner.js';

const validPlan = { decision: 'ask_user', summary: 'fixture response', question: 'fixture question', blockedReason: null,
  actions: [], criteriaAssessment: [] };

test('M11 retries one 429 within configured attempts and preserves unknown usage and cost as null', async () => {
  const requestTimes = []; let calls = 0;
  const env = { JARVIS_MISSION_PROVIDER: 'meta', JARVIS_MISSION_MODEL: 'muse-spark-1.3', JARVIS_META_API_KEY: 'fixture-key',
    JARVIS_MISSION_MAX_TRANSIENT_RETRIES: '1', JARVIS_MISSION_TIMEOUT_MS: '2000', JARVIS_MISSION_RETRY_TIMEOUT_MS: '1000',
    JARVIS_MISSION_RUNTIME_RESERVE_MS: '1000' };
  const planner = createMissionPlannerFromEnv({ env, dataClassifier: { classify: () => ({ dataClass: 'D0' }) },
    fetchImpl: async () => {
      requestTimes.push(Date.now()); calls++;
      if (calls === 1) return Response.json({ error: { message: 'fixture rate limited' } }, { status: 429, headers: { 'retry-after': '0' } });
      return Response.json({ choices: [{ message: { content: JSON.stringify(validPlan) }, finish_reason: 'stop' }] });
    } });
  const startedAt = Date.now();
  const result = await planner.planNextWave({ mission: { objective: 'fixture', successCriteria: [], constraints: [],
    remainingBudget: { plannerCalls: 2, activeRuntimeMs: 20_000 } }, capabilities: [], observations: [] });
  const durationMs = Date.now() - startedAt;
  const planning = result.planning;
  const evidence = { schemaVersion: 2, scenarioId: 'M11', fixtureId: 'm11-meta-429-missing-usage-v1',
    configuredMaxTransientRetries: 1, requestCount: calls, requestTimes, durationMs,
    decision: result.decision, provider: planning?.provider, attemptCount: planning?.attemptCount, retryCount: planning?.retryCount,
    attempts: planning?.attempts?.map(item => ({ status: item.status, errorCode: item.errorCode ?? null,
      usage: item.usage ?? null, costUsd: item.costUsd ?? null })),
    usage: planning?.usage ?? null, costUsd: planning?.costUsd ?? null,
    usageTotals: planning?.usageTotals?.total ?? null, providerInternalRetriesIncluded: false };
  assert.equal(result.decision, 'ask_user', JSON.stringify(result));
  assert.equal(calls, 2);
  assert.equal(planning.attemptCount, 2);
  assert.equal(planning.retryCount, 1);
  assert.deepEqual(planning.attempts.map(item => item.status), ['failed', 'succeeded']);
  assert.equal(planning.attempts[0].errorCode, 'A_MODEL_HTTP_ERROR');
  assert.equal(planning.attempts[1].usage, null);
  assert.equal(planning.attempts[1].costUsd, null);
  assert.equal(planning.usage, null);
  assert.equal(planning.costUsd, null);
  assert.equal(planning.usageTotals.total.totalTokens, null);
  assert.equal(planning.usageTotals.total.costUsd, null);
  const evidencePath = process.env.JARVIS_M11_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});
