import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const query = { offerId: 'gemini-spark-custom-apps', region: 'KR', language: 'ko-KR', accountType: 'personal',
  direction: 'jarvis-calls-provider', requirements: { age18OrOlder: true, sparkAccess: true,
    keepActivityEnabled: true, mcpServerUrlAvailable: true } };

test('S10 Core capability catalog distinguishes region limits, API direction, and a partial local alternative', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-s10-capability-catalog-'));
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'),
    env: { JARVIS_TEST_MODE: '1', JARVIS_MISSION_PLANNER: 'rule' } });
  const server = createCoreServer(runtime.coreFacade, { adminToken: 's10-read-only-test', capabilityPackageRegistry: runtime.capabilityPackageRegistry });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    runtime.coreFacade.cognition?.close?.();
    rmSync(root, { recursive: true, force: true });
  });
  const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${address.port}/capabilities/external/evaluate`;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer s10-read-only-test' };
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) })).status, 401);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(query) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.providerAvailability, 'unavailable');
  assert.deepEqual(result.unsupportedReasons, ['region-not-supported', 'language-not-supported']);
  assert.equal(result.offer.direction, 'provider-calls-jarvis');
  assert.equal(result.offer.directionMismatch, true);
  assert.equal(result.alternativeReadiness, 'local-code-registered');
  assert.equal(result.alternatives[0]?.toolName, 'workflow.execute');
  assert.equal(result.alternatives[0]?.relation, 'partial-assistance');
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.requiresPolicyCheck, true);
  assert.equal(result.externalCallPerformed, false);
  const evidencePath = process.env.JARVIS_S10_ORACLE_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify({ schemaVersion: 1, scenarioId: 'S10', query, result }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});
