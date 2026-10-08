import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConfiguredCoreServiceRuntime, coreServiceRuntimeOptionsFromEnv } from '../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { createCoreOpenApiSpec } from '../packages/core/src/main.mjs';
import { MissionEgressDecisionKeyStore } from '../packages/core/src/security/mission-egress-decision-key-store.js';

test('OpenAPI describes protected read-only egress status and local key provisioning routes', () => {
  const spec = createCoreOpenApiSpec();
  assert.equal(spec.paths['/security/managed-agent-egress'].get.operationId, 'getManagedAgentEgressStatus');
  assert.deepEqual(spec.paths['/security/managed-agent-egress'].get.security, [{ bearerAuth: [] }]);
  assert.equal(spec.paths['/security/managed-agent-egress/key/initialize'].post.operationId, 'initializeManagedAgentEgressKey');
  assert.ok(spec.paths['/security/managed-agent-egress/key/initialize'].post.responses[201]);
  assert.equal(spec.paths['/security/managed-agent-egress/key/rotate'].post.operationId, 'rotateManagedAgentEgressKey');
  assert.equal(spec.paths['/security/managed-agent-egress/key/recover'].post.operationId, 'recoverUnreadableManagedAgentEgressKey');
});

const environment = root => ({ JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root, JARVIS_CORE_ROOT: root,
  JARVIS_CORE_ALLOWED_ROOTS: join(root, 'workspace'), JARVIS_CORE_ADMIN_TOKEN: 'egress-config-test-admin',
  JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
  JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0',
  JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH: join(root, 'security', 'egress-key.json') });

function inspectWindowsFileAcl(path) {
  const command = [
    '$acl=[System.IO.File]::GetAccessControl($env:JARVIS_TEST_SECRET_PATH);',
    '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;',
    '$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;',
    '$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType;inherited=$_.IsInherited} });',
    '[pscustomobject]@{currentSid=$sid;ownerSid=$owner;daclProtected=$acl.AreAccessRulesProtected;rules=$rules} | ConvertTo-Json -Depth 4 -Compress'
  ].join(' ');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 8_000,
    env: { ...process.env, JARVIS_TEST_SECRET_PATH: path }
  }));
}

function observeEgressKeyStore(keyStore, observations) {
  const methods = new Set(['status', 'initialize', 'rotate', 'recoverUnreadable']);
  return new Proxy(keyStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!methods.has(property) || typeof value !== 'function') return value;
      return (...args) => {
        const startedAt = Date.now();
        try {
          const result = value.apply(target, args);
          observations.push({ operation: property, status: 'passed', durationMs: Date.now() - startedAt });
          return result;
        } catch (error) {
          const cause = error?.cause;
          const diagnostic = {
            operation: property,
            status: 'failed',
            errorCode: /^A_MISSION_EGRESS_[A-Z0-9_]{1,64}$/u.test(error?.code ?? '') ? error.code : 'UNKNOWN_EGRESS_ERROR',
            operationStage: ['dpapi-protect', 'write-temporary-file', 'acl-harden', 'atomic-rename', 'post-write-readback'].includes(error?.operationStage)
              ? error.operationStage : null,
            causeCode: ['ETIMEDOUT', 'EPERM', 'EACCES', 'EEXIST', 'ENOENT', 'EBUSY', 'EPIPE'].includes(cause?.code) ? cause.code : null,
            causeName: ['Error', 'TypeError', 'RangeError', 'TimeoutError'].includes(cause?.name) ? cause.name : null,
            syscall: ['spawnSync', 'rename', 'open', 'read', 'write', 'unlink'].includes(cause?.syscall) ? cause.syscall : null,
            durationMs: Date.now() - startedAt
          };
          observations.push(diagnostic);
          throw error;
        }
      };
    }
  });
}

test('Core service exposes authenticated local key provisioning while keeping external transfer disabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-egress-product-config-'));
  let provisioned = false, initializedBy = null, rotatedBy = null, keyId = 'sha256:test-key-id';
  const keyStatus = () => ({ configured: provisioned, provider: 'test-protected-store', protectedByOs: provisioned,
    signingEnabled: provisioned, algorithm: provisioned ? 'Ed25519' : null, keyId: provisioned ? keyId : null,
    initializedBy, rotatedBy, privateKeyExported: false });
  const keyStore = { status: keyStatus, initialize(options) { provisioned = true; initializedBy = options.initializedBy; return keyStatus(); },
    rotate(options) { const previousKeyId = keyId; keyId = 'sha256:rotated-key-id'; rotatedBy = options.rotatedBy; return { previousKeyId,
      activeKeyId: keyId, previousKeyRevoked: true, existingGrantsRemainValid: false }; },
    recoverUnreadable(options) { const previousEnvelopeSha256 = 'a'.repeat(64); keyId = 'sha256:recovered-key-id'; rotatedBy = options.recoveredBy;
      return { recovered: true, activeKeyId: keyId, recoveredBy: rotatedBy, previousEnvelopeSha256, previousKeyRevoked: true, existingGrantsRemainValid: false }; },
    signDecision() { throw new Error('No grants are expected in this setup test.'); }, verifyDecision() { return false; } };
  let runtime;
  try {
    const env = environment(root);
    const options = coreServiceRuntimeOptionsFromEnv({ env });
    assert.equal(options.managedAgentEgressKeyPath, env.JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH);
    assert.equal(coreServiceRuntimeOptionsFromEnv({ env: { ...env, JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH: 'workspace/security/key.json' } }).managedAgentEgressKeyPath,
      join(root, 'workspace', 'security', 'key.json'));
    runtime = await createConfiguredCoreServiceRuntime({ env, managedAgentEgressKeyStore: keyStore });
    const address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${address.port}/security/managed-agent-egress`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: 'Bearer egress-config-test-admin' };
    const beforeResponse = await fetch(url, { headers });
    assert.equal(beforeResponse.status, 200);
    const before = await beforeResponse.json();
    assert.equal(before.signer.signingEnabled, false);
    assert.equal(before.managedSessionConfigured, false);
    assert.equal(before.externalTransferEnabled, false);

    const provision = await fetch(`${url}/key/initialize`, { method: 'POST', headers });
    assert.equal(provision.status, 201);
    const provisionResult = await provision.json();
    assert.equal(provisionResult.key.keyId, 'sha256:test-key-id');
    assert.equal(provisionResult.key.initializedBy, 'core-admin:local-core-admin');
    assert.equal(provisionResult.externalTransferEnabled, false);
    assert.doesNotMatch(JSON.stringify(provisionResult), /privateKeyDer|protectedPayload|BEGIN PRIVATE KEY|secretValue/i);

    const afterResponse = await fetch(url, { headers });
    const after = await afterResponse.json();
    assert.equal(after.signer.signingEnabled, true);
    assert.equal(after.managedSessionConfigured, false);
    assert.equal(after.externalTransferEnabled, false);
    assert.equal(runtime.managedAgentEgressPolicy.status().externalTransferEnabled, false);
    const rotate = await fetch(`${url}/key/rotate`, { method: 'POST' });
    assert.equal(rotate.status, 401);
    const rotateResponse = await fetch(`${url}/key/rotate`, { method: 'POST', headers });
    assert.equal(rotateResponse.status, 200);
    const rotation = await rotateResponse.json();
    assert.equal(rotation.rotation.previousKeyRevoked, true);
    assert.equal(rotation.key.keyId, 'sha256:rotated-key-id');
    assert.equal(rotation.key.rotatedBy, 'core-admin:local-core-admin');
    assert.equal(rotation.externalTransferEnabled, false);
    const recoverUnauthorized = await fetch(`${url}/key/recover`, { method: 'POST' });
    assert.equal(recoverUnauthorized.status, 401);
    const recover = await fetch(`${url}/key/recover`, { method: 'POST', headers });
    assert.equal(recover.status, 200);
    const recovery = await recover.json();
    assert.equal(recovery.recovery.recoveredBy, 'core-admin:local-core-admin');
    assert.equal(recovery.key.keyId, 'sha256:recovered-key-id');
    assert.equal(recovery.externalTransferEnabled, false);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows product Core persists a CurrentUser DPAPI key across restart without enabling external transfer', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-egress-dpapi-product-'));
  const env = { ...environment(root), JARVIS_CORE_ADMIN_TOKEN: 'dpapi-product-smoke-admin' };
  const keyStoreObservations = [];
  const egressKeyStore = observeEgressKeyStore(new MissionEgressDecisionKeyStore({ path: env.JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH }), keyStoreObservations);
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env, managedAgentEgressKeyStore: egressKeyStore });
    let address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
    let url = `http://127.0.0.1:${address.port}/security/managed-agent-egress`;
    const headers = { authorization: 'Bearer dpapi-product-smoke-admin' };
    assert.equal((await fetch(url)).status, 401);
    const initial = await (await fetch(url, { headers })).json();
    assert.equal(initial.signer.signingEnabled, false);
    assert.equal(initial.externalTransferEnabled, false);
    const provision = await fetch(`${url}/key/initialize`, { method: 'POST', headers });
    assert.equal(provision.status, 201, `${await provision.clone().text()} diagnostics=${JSON.stringify(keyStoreObservations)}`);
    const provisioned = await provision.json();
    assert.equal(provisioned.key.provider, 'windows-dpapi-current-user');
    assert.equal(provisioned.key.protectedByOs, true);
    assert.equal(provisioned.key.initializedBy, 'core-admin:local-core-admin');
    assert.equal(provisioned.externalTransferEnabled, false);
    const acl = inspectWindowsFileAcl(env.JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH);
    assert.equal(acl.daclProtected, true);
    assert.equal(acl.ownerSid, acl.currentSid);
    assert.equal(acl.rules.length, 1);
    assert.equal(acl.rules[0].sid, acl.currentSid);
    assert.equal(acl.rules[0].type, 'Allow');
    assert.equal(acl.rules[0].inherited, false);
    assert.match(acl.rules[0].rights, /FullControl/u);
    const firstKeyId = provisioned.key.keyId;
    const rotate = await fetch(`${url}/key/rotate`, { method: 'POST', headers });
    assert.equal(rotate.status, 200, `${await rotate.clone().text()} diagnostics=${JSON.stringify(keyStoreObservations)}`);
    const rotation = await rotate.json();
    assert.equal(rotation.rotation.previousKeyId, firstKeyId);
    assert.equal(rotation.rotation.previousKeyRevoked, true);
    assert.equal(rotation.rotation.existingGrantsRemainValid, false);
    assert.equal(rotation.key.rotatedBy, 'core-admin:local-core-admin');
    assert.equal(rotation.externalTransferEnabled, false);
    const damagedKeyPath = env.JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH;
    await writeFile(damagedKeyPath, '{intentionally-corrupt-test-envelope');
    const broken = await (await fetch(url, { headers })).json();
    assert.equal(broken.signer.signingEnabled, false);
    assert.equal(broken.signer.reason, 'key-store-unreadable');
    const recover = await fetch(`${url}/key/recover`, { method: 'POST', headers });
    assert.equal(recover.status, 200, `${await recover.clone().text()} diagnostics=${JSON.stringify(keyStoreObservations)}`);
    const recovery = await recover.json();
    assert.equal(recovery.recovery.recovered, true);
    assert.equal(recovery.recovery.previousKeyRevoked, true);
    assert.equal(recovery.recovery.existingGrantsRemainValid, false);
    assert.equal(recovery.recovery.recoveredBy, 'core-admin:local-core-admin');
    assert.match(recovery.recovery.previousEnvelopeSha256, /^[a-f0-9]{64}$/u);
    assert.equal(recovery.externalTransferEnabled, false);
    const keyId = recovery.key.keyId;
    await runtime.close(); runtime = null;

    runtime = await createConfiguredCoreServiceRuntime({ env, managedAgentEgressKeyStore: egressKeyStore });
    address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${address.port}/security/managed-agent-egress`;
    const recovered = await (await fetch(url, { headers })).json();
    assert.equal(recovered.signer.keyId, keyId);
    assert.equal(recovered.signer.privateKeyExported, false);
    assert.equal(recovered.managedSessionConfigured, false);
    assert.equal(recovered.externalTransferEnabled, false);
    assert.equal(recovered.signer.recoveredBy, 'core-admin:local-core-admin');
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
