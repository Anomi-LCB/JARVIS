import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPcAgentInstallConfig } from '../apps/pc-agent/src/install/service-planner.js';
import { writeInstallerPackage } from '../apps/pc-agent/src/install/installer-packager.js';

test('PC Agent package regeneration preserves stable manifests and exposes stale release artifacts', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'jarvis-pc-package-lifecycle-'));
  try {
    const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
    const options = { daemonConfig, serviceManifest, cwd: process.cwd(), outputDir };
    const first = await writeInstallerPackage(options);
    const firstManifest = await readFile(join(outputDir, 'package-manifest.json'), 'utf8');

    await writeFile(join(outputDir, 'JarvisPcAgentTray.exe'), 'previous-runtime');
    await writeFile(join(outputDir, 'signature-report.json'), '{"status":"previous"}');

    const repeated = await writeInstallerPackage(options);
    const repeatedManifest = await readFile(join(outputDir, 'package-manifest.json'), 'utf8');
    assert.equal(repeated.sourcePackageChanged, false);
    assert.deepEqual(repeated.derivedArtifactsStale, []);
    assert.equal(repeatedManifest, firstManifest);
    assert.equal(repeated.manifest.generatedAt, first.manifest.generatedAt);

    const changed = await writeInstallerPackage({
      ...options,
      serviceManifest: {
        ...serviceManifest,
        displayName: `${serviceManifest.displayName} lifecycle-test`
      }
    });
    assert.equal(changed.sourcePackageChanged, true);
    assert.deepEqual(changed.derivedArtifactsStale.sort(), [
      'JarvisPcAgentTray.exe',
      'signature-report.json'
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('PC Agent staging output keeps final package paths out of the temporary location', async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), 'jarvis-pc-package-stage-'));
  const logicalDir = join(process.cwd(), 'dist', 'pc-agent-installer');
  try {
    const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
    const result = await writeInstallerPackage({
      daemonConfig,
      serviceManifest,
      cwd: process.cwd(),
      outputDir: logicalDir,
      writeOutputDir: stagingDir
    });
    const manifestText = await readFile(join(stagingDir, 'package-manifest.json'), 'utf8');
    const collectorText = await readFile(join(stagingDir, 'collect-logs.ps1'), 'utf8');
    assert.equal(result.outputDir, stagingDir);
    assert.equal(result.logicalOutputDir, logicalDir);
    assert.equal(manifestText.includes(logicalDir.replace(/\\/g, '\\\\')), true);
    assert.equal(manifestText.includes(stagingDir.replace(/\\/g, '\\\\')), false);
    assert.equal(collectorText.includes(logicalDir), true);
    assert.equal(collectorText.includes(stagingDir), false);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});
