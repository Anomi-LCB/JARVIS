import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommercialReleaseSeal, writeCommercialReleaseSeal } from '../scripts/commercial-release-seal.mjs';

test('commercial release seal refuses to issue a release id without every external proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-commercial-seal-'));
  try {
    await mkdir(join(root, 'dist', 'commercial-closure'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"jarvis-test","version":"1.0.0"}', 'utf8');
    await writeFile(join(root, 'dist', 'commercial-readiness-audit.json'), '{"status":"internal-beta","score":54,"commercialReady":false}', 'utf8');
    await writeFile(join(root, 'dist', 'commercial-closure', 'commercial-closure.json'), '{"status":"closure-in-progress","summary":{"remainingPoints":46}}', 'utf8');
    const report = await createCommercialReleaseSeal({ workspaceRoot: root, clock: () => new Date('2026-08-30T00:00:00.000Z') });
    assert.equal(report.status, 'blocked-not-sealed');
    assert.equal(report.releaseId, null);
    assert.equal(report.blockers.includes('commercial-audit-100'), true);
    assert.equal(report.privacy.rawCredentialsStored, false);
    const artifacts = await writeCommercialReleaseSeal(report, { outputDir: join(root, 'dist', 'commercial-release') });
    assert.match(await readFile(artifacts.rollbackPath, 'utf8'), /자동 실행되지 않으며/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
