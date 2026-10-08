import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  verifyAndroidReleaseKeystore,
  verifyMobileReleaseCredentials
} from '../scripts/mobile-release-credentials.mjs';

const execFileAsync = promisify(execFile);

test('mobile credential verifier does not invoke tools when credentials are absent', async () => {
  let invoked = false;
  const report = await verifyAndroidReleaseKeystore({
    env: {},
    runner: async () => {
      invoked = true;
      throw new Error('must-not-run');
    }
  });
  assert.equal(report.status, 'not-configured');
  assert.equal(invoked, false);
  assert.equal(report.secretValuesStored, false);
});

test('Android keystore verifier opens the store and retrieves the configured private key', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows JDK fixture');
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-keystore-'));
  const keystorePath = join(dir, 'release-test.p12');
  const password = 'jarvis-test-only-123';
  const alias = 'jarvis-release-test';
  try {
    await execFileAsync('keytool.exe', [
      '-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', keystorePath,
      '-storepass', password, '-keypass', password, '-alias', alias,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650',
      '-dname', 'CN=JARVIS Test, OU=Test, O=Local, L=Seoul, C=KR'
    ], { windowsHide: true });
    const report = await verifyAndroidReleaseKeystore({
      env: {
        ...process.env,
        JARVIS_ANDROID_KEYSTORE_PATH: keystorePath,
        JARVIS_ANDROID_KEYSTORE_PASSWORD: password,
        JARVIS_ANDROID_KEY_ALIAS: alias,
        JARVIS_ANDROID_KEY_PASSWORD: password
      }
    });
    assert.equal(report.status, 'passed');
    assert.equal(report.privateKeyPresent, true);
    assert.equal(report.certificateValid, true);
    assert.equal(report.keyStrengthAccepted, true);
    assert.equal(report.secretValuesStored, false);
    assert.equal(JSON.stringify(report).includes(password), false);
    assert.equal(JSON.stringify(report).includes(keystorePath), false);
    assert.equal(JSON.stringify(report).includes(alias), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined mobile verifier requires cryptographic and live account verification', async () => {
  const report = await verifyMobileReleaseCredentials({
    env: {},
    appDir: 'apps/mobile',
    projectId: '00000000-0000-4000-8000-000000000000',
    androidVerifier: async () => ({ status: 'passed', secretValuesStored: false }),
    easVerifier: async () => ({ status: 'passed', secretValuesStored: false })
  });
  assert.equal(report.status, 'passed');
  assert.equal(Object.values(report.privacy).every((value) => value === false), true);
});
