import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runImpossibleWorkflow30Audit } from '../scripts/impossible-workflow-30-audit.mjs';

test('final audit binds Mission/G evidence and rejects contaminated resume state', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-impossible-final-'));
  try {
    const first = await runImpossibleWorkflow30Audit(['--phase', 'final', '--root', root, '--cases', 'IW10']);
    assert.equal(first.report.status, 'PASSED');
    assert.equal(first.results[0].productPass, true);
    assert.equal(first.results[0].productPathEvidencePass, true);
    assert.deepEqual(first.results[0].actualToolNames, ['workflow.execute']);
    assert.match(first.results[0].missionResultSha256, /^[a-f0-9]{64}$/u);
    assert.match(first.results[0].evidenceManifestSha256, /^[a-f0-9]{64}$/u);

    const resumed = await runImpossibleWorkflow30Audit(['--phase', 'final', '--root', root, '--cases', 'IW10', '--resume']);
    assert.equal(resumed.report.status, 'PASSED');
    await assert.rejects(
      runImpossibleWorkflow30Audit(['--phase', 'baseline', '--root', root, '--cases', 'IW10', '--resume']),
      /RESUME_CAMPAIGN_IDENTITY_MISMATCH/u
    );

    const resultPath = join(root, 'cases', 'IW10', 'result.json');
    const ledgerPath = join(root, 'cases', 'IW10', 'ledger-entry.json');
    const originalResultBytes = await readFile(resultPath);
    const originalLedgerBytes = await readFile(ledgerPath);
    const forgedResult = { ...JSON.parse(originalResultBytes), actionEvidence: [], observationEvidence: [] };
    const forgedResultBytes = Buffer.from(`${JSON.stringify(forgedResult, null, 2)}\n`, 'utf8');
    const originalLedger = JSON.parse(originalLedgerBytes);
    const unsigned = { ...originalLedger, resultSha256: sha256(forgedResultBytes) };
    delete unsigned.hash;
    const forgedLedger = { ...unsigned, hash: canonicalHash(unsigned) };
    await writeFile(resultPath, forgedResultBytes);
    await writeFile(ledgerPath, `${JSON.stringify(forgedLedger, null, 2)}\n`, 'utf8');
    await assert.rejects(
      runImpossibleWorkflow30Audit(['--phase', 'final', '--root', root, '--cases', 'IW10', '--resume']),
      /RESUME_PRODUCT_EVIDENCE_MISMATCH/u
    );

    await writeFile(resultPath, originalResultBytes);
    await writeFile(ledgerPath, originalLedgerBytes);
    const missionPath = join(root, 'cases', 'IW10', 'mission-result.json');
    const missionBytes = await readFile(missionPath);
    await rm(missionPath);
    await assert.rejects(
      runImpossibleWorkflow30Audit(['--phase', 'final', '--root', root, '--cases', 'IW10', '--resume'])
    );
    await writeFile(missionPath, missionBytes);

    await rm(ledgerPath);
    const recovered = await runImpossibleWorkflow30Audit(['--phase', 'final', '--root', root, '--cases', 'IW10', '--resume']);
    assert.equal(recovered.report.status, 'PASSED');
    assert.equal(recovered.results[0].productPass, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function canonicalHash(value) {
  return sha256(Buffer.from(stableStringify(value), 'utf8'));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
