import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { reverifyApexWorkflowAudit } from '../scripts/apex-workflow-50-reverify.mjs';

const execFileAsync = promisify(execFile);

test('apex reverification authenticates clean evidence and detects result trace tampering', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jarvis-apex-reverify-'));
  const root = join(temp, 'audit');
  try {
    await execFileAsync(process.execPath, [
      resolve('scripts/apex-workflow-50-audit.mjs'),
      '--root', root,
      '--cases', 'A01,A11'
    ], { cwd: resolve('.'), windowsHide: true, timeout: 90_000 });

    const clean = await reverifyApexWorkflowAudit(root);
    assert.equal(clean.status, 'passed');
    assert.equal(clean.resultCount, 2);
    assert.equal(clean.retainedArtifactVerifications, 2);
    assert.equal(clean.failed, 0);

    const resultPath = join(root, 'cycle-01', 'A01', 'result.json');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    result.scriptedTraceSupplements.events.push('synthetic:tamper');
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const tampered = await reverifyApexWorkflowAudit(root);
    assert.equal(tampered.status, 'failed');
    assert.equal(tampered.checks.some((item) => item.name === 'result 1 byte hash' && !item.pass), true);
    assert.equal(tampered.checks.some((item) => item.name === 'result 1 trace purity without synthetic supplementation' && !item.pass), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('apex reverification validates hash-chain-bound compacted artifact manifests', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jarvis-apex-reverify-compact-'));
  const root = join(temp, 'audit');
  try {
    await execFileAsync(process.execPath, [
      resolve('scripts/apex-workflow-50-audit.mjs'),
      '--root', root,
      '--cases', 'A01',
      '--cycles', '2',
      '--compact',
      '--keep-workspaces-through-cycle', '1'
    ], { cwd: resolve('.'), windowsHide: true, timeout: 90_000 });

    const clean = await reverifyApexWorkflowAudit(root);
    assert.equal(clean.status, 'passed');
    assert.equal(clean.compactedArtifactVerifications, 1);

    const sealPath = join(root, 'cycle-02', 'A01', 'compaction-seal.json');
    const seal = JSON.parse(await readFile(sealPath, 'utf8'));
    seal.workspaceManifest[0].sha256 = '0'.repeat(64);
    await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`, 'utf8');
    const tampered = await reverifyApexWorkflowAudit(root);
    assert.equal(tampered.status, 'failed');
    assert.equal(tampered.checks.some((item) => item.name === 'result 2 compacted artifact seal verification' && !item.pass), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('apex clock profiles preserve exact digest within a profile and behavioral digest across profiles', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jarvis-apex-reverify-profiles-'));
  const root = join(temp, 'audit');
  try {
    await execFileAsync(process.execPath, [
      resolve('scripts/apex-workflow-50-audit.mjs'),
      '--root', root,
      '--cases', 'A36',
      '--cycles', '6'
    ], { cwd: resolve('.'), windowsHide: true, timeout: 90_000 });

    const summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'));
    assert.equal(summary.contractPass, 6);
    assert.equal(summary.failed, 0);
    assert.equal(summary.exactSemanticDigestGroups.length, 5);
    assert.equal(summary.exactSemanticDigestGroups.filter((item) => item.executions === 2).length, 1);
    assert.equal(summary.exactSemanticDigestGroups.every((item) => item.digestStable), true);
    assert.equal(summary.behavioralDigestGroups.length, 1);
    assert.equal(summary.behavioralDigestGroups[0].executions, 6);
    assert.equal(summary.behavioralDigestGroups[0].digestStable, true);

    const first = JSON.parse(await readFile(join(root, 'cycle-01', 'A36', 'result.json'), 'utf8'));
    const second = JSON.parse(await readFile(join(root, 'cycle-02', 'A36', 'result.json'), 'utf8'));
    const repeated = JSON.parse(await readFile(join(root, 'cycle-06', 'A36', 'result.json'), 'utf8'));
    assert.equal(first.auditExecution.virtualClockStart, repeated.auditExecution.virtualClockStart);
    assert.equal(first.semanticDigest, repeated.semanticDigest);
    assert.notEqual(first.semanticDigest, second.semanticDigest);
    assert.equal(first.behavioralDigest, second.behavioralDigest);
    assert.equal(first.behavioralDigest, repeated.behavioralDigest);

    const report = await reverifyApexWorkflowAudit(root);
    assert.equal(report.status, 'passed');
    assert.equal(report.exactSemanticDigestGroups.length, 5);
    assert.equal(report.behavioralDigestGroups[0].digestStable, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
