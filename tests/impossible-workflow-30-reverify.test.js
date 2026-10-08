import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { canonicalHash, verifyCaseEvidenceManifest, verifyLedgerEntry } from '../scripts/impossible-workflow-30-reverify.mjs';

test('reverifier canonical hash is key-order stable', () => {
  assert.equal(canonicalHash({ b: 2, a: { d: 4, c: 3 } }), canonicalHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('reverifier ledger validation detects result and chain tampering', () => {
  const resultBytes = Buffer.from('{"outcome":"SUCCESS"}\n', 'utf8');
  const unsigned = {
    sequence: 1,
    phase: 'final',
    caseId: 'IW01',
    outcome: 'SUCCESS',
    productPass: true,
    resultSha256: createHash('sha256').update(resultBytes).digest('hex'),
    previousHash: 'GENESIS'
  };
  const ledger = { ...unsigned, hash: canonicalHash(unsigned) };
  assert.equal(verifyLedgerEntry(ledger, resultBytes, 'GENESIS'), true);
  assert.equal(verifyLedgerEntry(ledger, Buffer.from('{"outcome":"FAILED"}\n'), 'GENESIS'), false);
  assert.equal(verifyLedgerEntry(ledger, resultBytes, 'wrong-previous'), false);
  assert.equal(verifyLedgerEntry({ ...ledger, outcome: 'FAILED' }, resultBytes, 'GENESIS'), false);
});

test('reverifier rejects attacker-selected empty required evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-reverify-required-'));
  try {
    const payload = { required: [], entries: [] };
    const manifest = { manifestVersion: 'jarvis-impossible-workflow-case-evidence-v2', ...payload, manifestSha256: canonicalHash(payload) };
    await assert.rejects(verifyCaseEvidenceManifest(root, manifest, manifest.manifestSha256), /EVIDENCE_MANIFEST_DUPLICATE_PATH|EVIDENCE_REQUIRED_SET/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reverifier rejects evidence manifest path escape even when rehashed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-reverify-escape-'));
  const outside = join(dirname(root), `${root.split(/[\\/]/u).at(-1)}-outside.txt`);
  try {
    const required = [
      'command.txt', 'mission-result.json', 'oracle-result.json', 'audit/executions.jsonl',
      'audit/evidence.jsonl', 'audit/verification.jsonl', 'audit/packet-journal.jsonl',
      'audit/missions.json', 'audit/mission-events.jsonl', 'audit/core-orchestration.jsonl'
    ];
    const entries = [];
    for (const path of required) {
      const bytes = Buffer.from('{}\n', 'utf8');
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
      entries.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const outsideBytes = Buffer.from('escape\n', 'utf8');
    await writeFile(outside, outsideBytes);
    entries.push({ path: `../${outside.split(/[\\/]/u).at(-1)}`, size: outsideBytes.length, sha256: createHash('sha256').update(outsideBytes).digest('hex') });
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const payload = { required, entries };
    const manifest = { manifestVersion: 'jarvis-impossible-workflow-case-evidence-v2', ...payload, manifestSha256: canonicalHash(payload) };
    await assert.rejects(verifyCaseEvidenceManifest(root, manifest, manifest.manifestSha256), /PATH_ESCAPE/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
