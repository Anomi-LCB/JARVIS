import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentPlatformScenarioRunners } from '../scripts/agent-platform-scenario-runners.mjs';
import { buildPreflight } from '../scripts/agent-platform-evaluation-preflight.mjs';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('every preflight-eligible public scenario has exactly one callable local runner', async () => {
  const [evaluation, bindings, adapterCatalog] = await Promise.all([
    readJson('../config/agent-platform-evaluation.json'),
    readJson('../config/agent-platform-evaluation-bindings.json'),
    readJson('../config/agent-platform-adapters.json')
  ]);
  const runners = createAgentPlatformScenarioRunners();
  const preflight = buildPreflight(evaluation, bindings);
  const eligibleIds = preflight.scenarios.filter(item => item.scenarioExecutionEligible).map(item => item.id);
  const catalogIds = adapterCatalog.adapters.filter(item => item.state === 'implemented')
    .flatMap(item => item.scenarioIds);

  assert.deepEqual([...runners.keys()].sort(), [...new Set(catalogIds)].sort());
  assert.deepEqual([...runners.keys()].sort(), [...eligibleIds].sort());
  for (const [scenarioId, runner] of runners) {
    assert.equal(typeof runner, 'function', `${scenarioId} runner must be callable`);
  }
  assert.equal(runners.has('G05'), true);
  assert.equal(runners.has('M01'), true);
});
