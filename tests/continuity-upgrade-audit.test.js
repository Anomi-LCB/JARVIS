import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CONTINUITY_AUDIT_CONTRACT_SHA256,
  continuityAuditContracts,
  executeContinuityMemoryCase,
  executeContinuityIntegrationCase,
  executeContinuityRecoveryCase,
  runContinuityUpgradeAudit,
  verifyContinuityAuditArtifacts
} from '../scripts/continuity-upgrade-audit.mjs';

test('independent continuity contracts retain the preimplementation expected outcomes', () => {
  assert.equal(CONTINUITY_AUDIT_CONTRACT_SHA256, 'f553ae4ee1e5fe044abd382a35493e3e6a2da43f8004138dace0d76a73ce6358');
  assert.equal(continuityAuditContracts.length, 18);
  assert.equal(new Set(continuityAuditContracts.map(item => item.id)).size, 18);
});

for (const contract of continuityAuditContracts) {
  test(`${contract.id}: ${contract.title}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `jarvis-continuity-${contract.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = contract.area === 'memory' ? executeContinuityMemoryCase
      : ['core', 'mission'].includes(contract.area) ? executeContinuityIntegrationCase
        : executeContinuityRecoveryCase;
    const result = await run(contract, root);
    assert.equal(result.passed, true, JSON.stringify({ checks: result.checks, error: result.error }));
    assert.ok(result.checks.length > 0);
  });
}

test('audit evidence detects a changed result and a deleted file without trusting PASS labels', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-continuity-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runContinuityUpgradeAudit({ root, caseIds: ['C01'] });
  assert.equal((await verifyContinuityAuditArtifacts(root)).passed, true);
  const resultPath = join(root, 'cases', 'C01', 'result.json');
  const original = await readFile(resultPath);
  const changed = JSON.parse(original);
  changed.passed = true;
  changed.observed.path = 'C:/different-conversation/report.txt';
  await writeFile(resultPath, JSON.stringify(changed));
  const tampered = await verifyContinuityAuditArtifacts(root);
  assert.equal(tampered.passed, false);
  assert.ok(tampered.failures.some(item => item.code === 'AUDIT_ARTIFACT_CHANGED'));
  await writeFile(resultPath, original);
  await rm(join(root, 'cases', 'C01', 'conversation-a', 'report.txt'));
  const missing = await verifyContinuityAuditArtifacts(root);
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.some(item => item.code === 'AUDIT_ARTIFACT_MISSING'));
});
