import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runMobileEasProductionBuild,
  verifyMobileEasBuildEvidence
} from '../scripts/mobile-eas-build-gate.mjs';

async function createFixture(root) {
  const appDir = join(root, 'apps', 'mobile');
  await mkdir(join(appDir, 'android', 'app'), { recursive: true });
  await Promise.all([
    writeFile(join(appDir, 'app.json'), '{}', 'utf8'),
    writeFile(join(appDir, 'eas.json'), '{}', 'utf8'),
    writeFile(join(appDir, 'package.json'), '{}', 'utf8'),
    writeFile(join(appDir, 'android', 'app', 'build.gradle'), 'android {}', 'utf8'),
    writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf8')
  ]);
  return appDir;
}

test('EAS build gate requires explicit execution', async () => {
  await assert.rejects(runMobileEasProductionBuild({ execute: false }), /explicit-execute-required/);
});

test('EAS build evidence is bound to project, source, freshness, and privacy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-eas-evidence-'));
  const projectId = '00000000-0000-4000-8000-000000000000';
  try {
    const appDir = await createFixture(root);
    const outputPath = join(root, 'dist', 'mobile-eas-production-build.json');
    const report = await runMobileEasProductionBuild({
      appDir,
      outputPath,
      execute: true,
      env: { ...process.env, EXPO_TOKEN: 'test-token-not-real', JARVIS_EAS_PROJECT_ID: projectId },
      clock: () => new Date('2026-08-30T00:00:00.000Z'),
      runner: async () => ({ stdout: JSON.stringify([{ id: 'build-123', platform: 'android', status: 'FINISHED', appVersion: '1.0.0' }]), stderr: '' })
    });
    assert.equal(report.status, 'passed');
    assert.equal(JSON.stringify(report).includes('test-token-not-real'), false);
    assert.equal(JSON.stringify(report).includes(projectId), false);
    const verified = await verifyMobileEasBuildEvidence({
      appDir,
      evidencePath: outputPath,
      env: { JARVIS_EAS_PROJECT_ID: projectId },
      now: new Date('2026-08-30T01:00:00.000Z')
    });
    assert.equal(verified.status, 'passed');
    await writeFile(join(appDir, 'app.json'), '{"changed":true}', 'utf8');
    const staleSource = await verifyMobileEasBuildEvidence({
      appDir,
      evidencePath: outputPath,
      env: { JARVIS_EAS_PROJECT_ID: projectId },
      now: new Date('2026-08-30T01:00:00.000Z')
    });
    assert.equal(staleSource.checks.sourceMatches, false);
    assert.equal(staleSource.passed, false);
    assert.equal((await readFile(outputPath, 'utf8')).includes('buildUrl'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
