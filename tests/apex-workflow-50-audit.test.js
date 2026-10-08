import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  APEX_WORKFLOW_LEDGER_VERSION,
  deriveApexCycleVariation
} from '../scripts/apex-workflow-50-audit.mjs';
import { APEX_WORKFLOW_SEED, apexCases } from '../scripts/apex-workflow-50-cases.mjs';

const execFileAsync = promisify(execFile);

test('apex audit runs fresh children sequentially, records variations, compacts, and resumes without duplication', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jarvis-apex-audit-'));
  const root = join(temp, 'audit');
  const script = resolve('scripts/apex-workflow-50-audit.mjs');
  try {
    await execFileAsync(process.execPath, [
      script,
      '--root', root,
      '--cases', 'A01,A11',
      '--cycles', '2',
      '--compact',
      '--keep-workspaces-through-cycle', '1'
    ], { cwd: resolve('.'), windowsHide: true, timeout: 90_000 });

    const campaign = await readJson(join(root, 'campaign.json'));
    const summary = await readJson(join(root, 'summary.json'));
    const ledgerBytes = await readFile(join(root, 'sequence-ledger.jsonl'));
    const ledger = ledgerBytes.toString('utf8').trim().split(/\r?\n/u).map(JSON.parse);

    assert.equal(summary.totalExecutions, 4);
    assert.equal(summary.contractPass, 4);
    assert.equal(summary.failed, 0);
    assert.equal(summary.freshChildProcessExecutions, 4);
    assert.equal(summary.declaredFaultCount, summary.consumedFaultCount);
    assert.deepEqual(summary.scriptedTraceSupplements, { callKinds: 0, callUnits: 0, faults: 0, events: 0 });
    assert.equal(summary.compactedExecutions, 2);
    assert.equal(campaign.implementationManifest.files.length, 8);
    assert.equal(campaign.implementationManifest.files.every((item) => !item.path.includes('\\') && /^[a-f0-9]{64}$/u.test(item.sha256)), true);
    assert.equal(ledger.length, 4);
    assert.equal(new Set(ledger.map((item) => item.workerLaunchId)).size, 4);

    const selected = ['A01', 'A11'].map((id) => apexCases.find((item) => item.id === id));
    assert.deepEqual(campaign.cycleVariations, [
      deriveApexCycleVariation(selected, 1, APEX_WORKFLOW_SEED),
      deriveApexCycleVariation(selected, 2, APEX_WORKFLOW_SEED)
    ]);
    let previousHash = 'GENESIS';
    for (const [index, record] of ledger.entries()) {
      const unsigned = { ...record };
      delete unsigned.hash;
      assert.equal(record.ledgerVersion, APEX_WORKFLOW_LEDGER_VERSION);
      assert.equal(record.sequence, index + 1);
      assert.equal(record.previousHash, previousHash);
      assert.equal(record.hash, digestJson(unsigned));
      previousHash = record.hash;
    }

    await stat(join(root, 'cycle-01', 'A01', 'workspace'));
    await assert.rejects(stat(join(root, 'cycle-02', 'A01', 'workspace')), { code: 'ENOENT' });
    await stat(join(root, 'cycle-02', 'A01', 'compaction-seal.json'));

    const firstLedgerBytes = await readFile(join(root, 'sequence-ledger.jsonl'));
    const firstResultBytes = await readFile(join(root, 'cycle-01', 'A01', 'result.json'));
    await execFileAsync(process.execPath, [
      script,
      '--root', root,
      '--resume'
    ], { cwd: resolve('.'), windowsHide: true, timeout: 90_000 });
    assert.deepEqual(await readFile(join(root, 'sequence-ledger.jsonl')), firstLedgerBytes);
    assert.deepEqual(await readFile(join(root, 'cycle-01', 'A01', 'result.json')), firstResultBytes);
    assert.equal((await readFile(join(root, 'sequence-ledger.jsonl'), 'utf8')).trim().split(/\r?\n/u).length, 4);

    const tamperedCampaign = await readJson(join(root, 'campaign.json'));
    tamperedCampaign.implementationManifest.files[0].sha256 = '0'.repeat(64);
    const campaignPayload = { ...tamperedCampaign };
    delete campaignPayload.campaignSha256;
    delete campaignPayload.generatedAt;
    tamperedCampaign.campaignSha256 = digestJson(campaignPayload);
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(join(root, 'campaign.json'), `${JSON.stringify(tamperedCampaign, null, 2)}\n`, 'utf8'));
    await assert.rejects(
      execFileAsync(process.execPath, [script, '--root', root, '--resume'], {
        cwd: resolve('.'), windowsHide: true, timeout: 90_000
      }),
      (error) => /does not match the current APEX contract/u.test(String(error.stderr))
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function digestJson(value) {
  return createHash('sha256').update(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8')).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}
