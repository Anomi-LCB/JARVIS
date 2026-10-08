import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { writeWearableHudFieldKit } from '../scripts/wearable-hud-field-kit.mjs';

test('generated wearable field server boots without repository-relative imports', { timeout: 30_000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'jarvis-field-kit-'));
  let server;
  try {
    const manifest = await writeWearableHudFieldKit({ outputDir });
    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.files.includes('jarvis-http.mjs'), true);

    const serverPath = join(outputDir, 'field-server.mjs');
    const serverSource = await readFile(serverPath, 'utf8');
    const adbHarness = await readFile(join(outputDir, 'connect-wearable-adb.ps1'), 'utf8');
    assert.match(serverSource, /from '\.\/jarvis-http\.mjs'/);
    assert.doesNotMatch(serverSource, /packages\/shared\/src\/http\.js/);
    assert.match(adbHarness, /wearable-field-runner\.apk/);
    assert.match(adbHarness, /install -r \$RunnerApkPath/);
    assert.match(adbHarness, /launchMode = 'dedicated-runner'/);
    assert.doesNotMatch(adbHarness, /\$RunnerApkPath = \(Join-Path \$PSScriptRoot/);
    assert.match(adbHarness, /if \(-not \$RunnerApkPath\) \{ \$RunnerApkPath = Join-Path \$PSScriptRoot/);
    if (manifest.runnerArtifact.included) {
      assert.equal((await stat(join(outputDir, 'wearable-field-runner.apk'))).size, manifest.runnerArtifact.bytes);
      assert.equal(manifest.files.includes('wearable-field-runner.apk'), true);
    }

    const moduleUrl = `${pathToFileURL(serverPath).href}?test=${Date.now()}`;
    const fieldServer = await import(moduleUrl);
    server = await fieldServer.startWearableFieldServer({
      host: '127.0.0.1',
      port: 0,
      root: outputDir
    });

    const address = server.address();
    assert.equal(typeof address, 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/field-calibration.html`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-jarvis-server'), 'wearable-hud-field-server');
    assert.match(await response.text(), /jarvis-wearable-field-lab/);
  } finally {
    if (server?.listening) {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
    await rm(outputDir, { recursive: true, force: true });
  }
});
