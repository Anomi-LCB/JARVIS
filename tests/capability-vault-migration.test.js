import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CapabilityTokenVault,
  StaticVaultKeyProvider,
  WindowsDpapiVaultKeyProvider
} from '../apps/pc-agent/src/pc-agent-runtime.js';

function protectedProvider(secret = 'os-protected-test-key') {
  return {
    resolveKey() {
      return {
        keyMaterial: Buffer.from(secret),
        provider: 'windows-dpapi',
        protectedByOs: true,
        scope: 'CurrentUser',
        fallback: false
      };
    }
  };
}

test('capability vault atomically migrates legacy encrypted records to the active OS-protected key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-vault-migration-'));
  const vaultPath = join(root, 'capability-vault.jsonl');
  const legacyProvider = new StaticVaultKeyProvider({ secret: 'legacy-key', provider: 'static-dev-secret' });
  try {
    const legacy = new CapabilityTokenVault({ vaultPath, keyProvider: legacyProvider });
    legacy.sealCapabilityToken({ tokenId: 'cap_legacy_one', scope: ['one'] }, { taskId: 'task-one' });
    legacy.sealCapabilityToken({ tokenId: 'cap_legacy_two', scope: ['two'] }, { taskId: 'task-two' });
    const before = await readFile(vaultPath, 'utf8');

    const migrated = new CapabilityTokenVault({
      vaultPath,
      keyProvider: protectedProvider(),
      legacyKeyProviders: [legacyProvider],
      clock: () => new Date('2026-08-30T00:00:00.000Z')
    });
    const status = migrated.status();
    const after = await readFile(vaultPath, 'utf8');

    assert.equal(status.migration.status, 'migrated');
    assert.equal(status.migration.examinedCount, 2);
    assert.equal(status.migration.migratedCount, 2);
    assert.equal(status.keyProvider.provider, 'windows-dpapi');
    assert.equal(status.keyProvider.protectedByOs, true);
    assert.equal(migrated.records.every((record) => record.keyProvider === 'windows-dpapi'), true);
    assert.equal(migrated.records.every((record) => record.keyProtectedByOs === true), true);
    assert.deepEqual(migrated.records.map((record) => migrated.open(record).tokenId).sort(), ['cap_legacy_one', 'cap_legacy_two']);
    assert.notEqual(after, before);
    assert.equal(after.includes('cap_legacy_one'), false);
    assert.equal(after.includes('cap_legacy_two'), false);
    assert.equal((await readdir(root)).some((name) => name.includes('.migration-')), false);

    const reopened = new CapabilityTokenVault({ vaultPath, keyProvider: protectedProvider() });
    assert.equal(reopened.status().migration.status, 'current');
    assert.equal(reopened.status().migration.migratedCount, 0);
    assert.deepEqual(reopened.records.map((record) => reopened.open(record).tokenId).sort(), ['cap_legacy_one', 'cap_legacy_two']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability vault migration fails closed and preserves the original journal when no legacy key can decrypt it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-vault-migration-fail-'));
  const vaultPath = join(root, 'capability-vault.jsonl');
  try {
    const legacy = new CapabilityTokenVault({
      vaultPath,
      keyProvider: new StaticVaultKeyProvider({ secret: 'correct-legacy-key', provider: 'static-dev-secret' })
    });
    legacy.sealCapabilityToken({ tokenId: 'cap_must_survive' }, { taskId: 'task-survive' });
    const before = await readFile(vaultPath, 'utf8');

    assert.throws(() => new CapabilityTokenVault({
      vaultPath,
      keyProvider: protectedProvider(),
      legacyKeyProviders: [new StaticVaultKeyProvider({ secret: 'wrong-key', provider: 'static-dev-secret' })]
    }), { code: 'B_CAPABILITY_VAULT_MIGRATION_DECRYPT_FAILED' });
    assert.equal(await readFile(vaultPath, 'utf8'), before);
    assert.equal((await readdir(root)).some((name) => name.includes('.migration-')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit DPAPI provider fails closed unless an insecure test fallback is deliberately enabled', () => {
  const strict = new WindowsDpapiVaultKeyProvider({ cachePath: 'unused-dpapi-test-key' });
  strict.protect = () => {
    throw new Error('simulated DPAPI outage');
  };
  assert.throws(() => strict.resolveKey(), { code: 'B_CAPABILITY_VAULT_DPAPI_UNAVAILABLE' });

  const fallback = new WindowsDpapiVaultKeyProvider({
    cachePath: 'unused-dpapi-test-key',
    fallbackSecret: 'test-only-fallback',
    allowInsecureFallback: true
  });
  fallback.protect = () => {
    throw new Error('simulated DPAPI outage');
  };
  const result = fallback.resolveKey();
  assert.equal(result.provider, 'static-dev-fallback');
  assert.equal(result.protectedByOs, false);
  assert.equal(result.fallback, true);
});
