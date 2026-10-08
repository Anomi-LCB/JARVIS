import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('wearable local STT validates input before loading the model and redacts file paths', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jarvis-stt-test-'));
  const missingName = `missing-${Date.now()}.webm`;
  try {
    const result = spawnSync('python', [
      'scripts/wearable-local-stt.py',
      '--input', join(cacheDir, missingName),
      '--cache-dir', cacheDir,
      '--model', 'small'
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /wearable_stt_failed:FileNotFoundError/);
    assert.doesNotMatch(result.stderr, new RegExp(missingName));
    assert.equal(result.stdout, '');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('wearable local STT and server launchers keep audio local and process-scoped', async () => {
  const runner = await readFile('scripts/wearable-local-stt.py', 'utf8');
  const setup = await readFile('scripts/setup-wearable-local-stt.ps1', 'utf8');
  const launcher = await readFile('scripts/start-wearable-field-server.ps1', 'utf8');

  assert.match(runner, /HF_HUB_DISABLE_TELEMETRY/);
  assert.match(runner, /compute_type="int8"/);
  assert.match(runner, /MAXIMUM_AUDIO_BYTES/);
  assert.match(setup, /cloudAudioTransfer = \$false/);
  assert.match(launcher, /\$env:JARVIS_WEARABLE_STT_COMMAND = \$python/);
  assert.match(launcher, /\$env:JARVIS_WEARABLE_STT_MODE = 'daemon'/);
  assert.doesNotMatch(launcher, /SetEnvironmentVariable/);
});
