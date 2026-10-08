import { readFileSync } from 'node:fs';
import { describeModelProviders } from '../packages/core/src/mission/model-provider.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPublicScenarioRunHistory } from './agent-platform-evaluation-preflight.mjs';

export function countCurrentScenarioStatuses(evaluation, executionHistory = []) {
  const latestRuns = new Map();
  for (const run of executionHistory) {
    if (!run || typeof run.scenarioId !== 'string' || !['completed', 'failed', 'blocked'].includes(run.outcome)
      || !Number.isFinite(Date.parse(run.observedAt))) continue;
    const current = latestRuns.get(run.scenarioId);
    if (!current || Date.parse(run.observedAt) > Date.parse(current.observedAt)) latestRuns.set(run.scenarioId, run);
  }
  return Object.fromEntries(['completed', 'failed', 'blocked', 'unimplemented', 'not-run'].map(status => [status,
    evaluation.scenarios.filter(scenario => (latestRuns.get(scenario.id)?.outcome ?? 'not-run') === status).length]));
}

export function countDeclaredScenarioStatuses(evaluation) {
  return Object.fromEntries(evaluation.measurementContract.statuses.map(status => [status,
    evaluation.scenarios.filter(scenario => scenario.status === status).length]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(readFileSync(new URL('../config/agent-platform-capabilities.json', import.meta.url), 'utf8'));
  const acceptance = JSON.parse(readFileSync(new URL('../docs/universal-control-v3-acceptance.json', import.meta.url), 'utf8'));
  const evaluation = JSON.parse(readFileSync(new URL('../config/agent-platform-evaluation.json', import.meta.url), 'utf8'));
  const gates = acceptance.stages.flatMap(stage => stage.gates);
  const executionHistory = loadPublicScenarioRunHistory();
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), mode: 'local-read-only',
    providers: describeModelProviders(), acceptance: { verified: gates.filter(gate => gate.status === 'verified').length, total: gates.length },
    evaluation: { publicScenarios: evaluation.scenarios.length, repetitionsPerConfiguration: evaluation.repetitionsPerConfiguration,
      statusCounts: countCurrentScenarioStatuses(evaluation, executionHistory),
      declaredStatusCounts: countDeclaredScenarioStatuses(evaluation),
      recordedScenarioRuns: executionHistory.length,
      holdout: evaluation.holdout },
    features: catalog.features.map(({ id, title, stage, liveVerified, nextAction }) => ({ id, title, stage, liveVerified, nextAction })),
    networkRequests: 0, costsUsd: null, productParityMeasured: false }, null, 2));
}
