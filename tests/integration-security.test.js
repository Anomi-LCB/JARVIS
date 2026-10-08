import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrationCredentialPath, IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';

test('integration credential vault honors service-data environment paths without leaving placeholders', () => {
  const path = integrationCredentialPath({
    JARVIS_CORE_INTEGRATION_VAULT: '%ProgramData%\\JARVIS\\CoreRuntime\\CoreTest\\integrations\\credentials.dpapi.json',
    ProgramData: 'C:\\ProgramData'
  });
  assert.equal(path, 'C:\\ProgramData\\JARVIS\\CoreRuntime\\CoreTest\\integrations\\credentials.dpapi.json');
  assert.equal(path.includes('%ProgramData%'), false);
  assert.throws(
    () => integrationCredentialPath({ JARVIS_CORE_INTEGRATION_VAULT: '%UNKNOWN_ROOT%\\vault.dpapi.json' }),
    { code: 'A_INTEGRATION_VAULT_PATH_ENV_UNRESOLVED' }
  );
});

test('integration credential vault status identifies its configured service-data location', () => {
  const vault = new IntegrationCredentialVault({
    path: 'C:\\ProgramData\\JARVIS\\CoreRuntime\\CoreTest\\integrations\\credentials.dpapi.json',
    storageLocation: 'configured-service-data-directory',
    platform: 'win32'
  });
  assert.equal(vault.status().storageLocation, 'configured-service-data-directory');
  assert.equal(vault.status().state, 'empty');
  assert.equal(vault.status().verificationState, 'not-probed');
  assert.equal(vault.status().storesPlaintextCredentials, false);
});

test('stored integration credentials never imply a verified provider connection or return secrets in listings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-integration-vault-'));
  const path = join(dir, 'credentials.dpapi.json');
  const protect = value => Buffer.from(`sealed:${value}`).toString('base64');
  const unprotect = value => {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded.startsWith('sealed:')) throw new Error('invalid test envelope');
    return decoded.slice('sealed:'.length);
  };
  const vault = new IntegrationCredentialVault({
    path,
    platform: 'win32',
    protect,
    unprotect,
    harden: () => {},
    clock: () => new Date('2026-09-28T00:00:00.000Z')
  });
  try {
    const stored = vault.save({
      connectorId: 'google-mail',
      providerAccountId: 'research@example.test',
      label: 'Research account',
      authMethod: 'oauth2',
      scopes: ['mail.read'],
      grants: ['mail.read'],
      credentials: { clientId: 'client-id', clientSecret: 'secret-client-value', refreshToken: 'secret-refresh-value' }
    });
    assert.equal(stored.status, 'credentials-stored-unverified');
    assert.equal(stored.verificationState, 'unverified');
    assert.doesNotMatch(JSON.stringify(stored), /secret-client-value|secret-refresh-value|research@example\.test/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /secret-client-value|secret-refresh-value|research@example\.test/);
    assert.equal(vault.status().state, 'present-not-probed');
    assert.equal(vault.status().configured, true);
    assert.equal(vault.list()[0].status, 'credentials-stored-unverified');
    const inScope = await vault.withCredentials(stored.connectionId, async (credentials, metadata) => ({ credentials, metadata }));
    assert.equal(inScope.credentials.refreshToken, 'secret-refresh-value');
    assert.equal(inScope.metadata.connectorId, 'google-mail');
    assert.equal(Object.hasOwn(inScope.metadata, 'providerAccountId'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration credential expiry is distinct from provider verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-integration-expiry-'));
  const path = join(dir, 'credentials.dpapi.json');
  const protect = value => Buffer.from(value).toString('base64');
  const unprotect = value => Buffer.from(value, 'base64').toString('utf8');
  const vault = new IntegrationCredentialVault({ path, platform: 'win32', protect, unprotect, harden: () => {},
    clock: () => new Date('2026-09-28T00:00:00.000Z') });
  try {
    const stored = vault.save({ connectorId: 'travel-provider', providerAccountId: 'account-1', authMethod: 'api-key',
      credentials: { apiKey: 'provider-key' }, expiresAt: '2026-09-27T23:59:59.000Z' });
    assert.equal(stored.status, 'expired');
    assert.equal(stored.verificationState, 'expired');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider verification metadata persists safely without credentials or execution grants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-provider-verification-vault-'));
  const path = join(dir, 'credentials.dpapi.json');
  const protect = value => Buffer.from(`sealed:${value}`).toString('base64');
  const unprotect = value => Buffer.from(value, 'base64').toString('utf8').slice('sealed:'.length);
  const options = { path, platform: 'win32', protect, unprotect, harden: () => {},
    clock: () => new Date('2026-09-28T00:00:00.000Z') };
  try {
    const vault = new IntegrationCredentialVault(options);
    const saved = vault.save({ connectorId: 'jarvis-model-xai', providerAccountId: 'primary', authMethod: 'api-key',
      scopes: ['model.plan'], grants: [], credentials: { apiKey: 'synthetic-provider-secret' } });
    const checked = vault.recordProviderVerification(saved.connectionId, { status: 'verified', providerVerified: true,
      checkedAt: '2026-09-28T00:00:00.000Z', modelCount: 3, modelId: 'grok-planning', requestedModelAvailable: true });
    assert.equal(checked.providerVerification.providerVerified, true);
    assert.equal(checked.status, 'credentials-stored-provider-verified', 'provider authentication is tracked separately from JARVIS grants');
    assert.equal(checked.verificationState, 'provider-verified');
    assert.deepEqual(checked.grants, []);
    assert.doesNotMatch(JSON.stringify(checked), /synthetic-provider-secret|primary/u);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /synthetic-provider-secret|primary/u);
    const reopened = new IntegrationCredentialVault(options);
    const afterRestart = reopened.list()[0];
    assert.deepEqual(afterRestart.providerVerification, checked.providerVerification);
    assert.equal((await reopened.withCredentials(afterRestart.connectionId, value => value.apiKey)), 'synthetic-provider-secret');
    assert.equal(afterRestart.grants.length, 0);
    const denied = reopened.recordProviderVerification(afterRestart.connectionId, { status: 'authorization-rejected', providerVerified: false,
      checkedAt: '2026-09-28T00:01:00.000Z', modelCount: 0, errorCode: 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED' });
    assert.equal(denied.providerVerification.status, 'authorization-rejected');
    assert.equal(denied.providerVerification.errorCode, 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED');
    assert.equal(denied.grants.length, 0, 'provider 403 must never add JARVIS execution grants');
    assert.doesNotMatch(JSON.stringify(denied), /synthetic-provider-secret|must not be retained/u);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /synthetic-provider-secret|must not be retained/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
