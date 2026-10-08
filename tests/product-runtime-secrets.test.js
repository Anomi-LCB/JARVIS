import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { createCoreAdminAuthProvider } from '../packages/core/src/security/core-admin-auth.js';
import { resolveProductRuntimeSecrets } from '../packages/shared/src/product-runtime-secrets.js';
import { acquireProductRuntimeLock } from '../packages/shared/src/product-runtime-lock.js';
import {
  probeEndpointStatus,
  productServiceDefinitions,
  startProductRuntime
} from '../scripts/product-runtime.mjs';

function reversibleProtect(inputBase64) {
  return Buffer.from(Buffer.from(inputBase64, 'utf8').reverse()).toString('base64');
}

function reversibleUnprotect(protectedPayload) {
  return Buffer.from(Buffer.from(protectedPayload, 'base64').reverse()).toString('utf8');
}

test('product runtime secrets persist as an OS-protected payload and are least-privilege scoped per service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-product-secrets-'));
  const storePath = join(root, 'product-runtime-secrets.json');
  let sequence = 0;
  const randomBytesImpl = (size) => Buffer.alloc(size, (sequence += 1));
  try {
    const first = resolveProductRuntimeSecrets({
      env: {},
      platform: 'win32',
      storePath,
      randomBytesImpl,
      protect: reversibleProtect,
      unprotect: reversibleUnprotect,
      hardenStore: () => {},
      clock: () => new Date('2026-08-30T00:00:00.000Z')
    });
    assert.equal(first.status.provider, 'windows-dpapi-current-user');
    assert.equal(first.status.protectedByOs, true);
    assert.equal(first.status.source, 'created');
    assert.match(first.coreAuthKeyId, /^sha256:[a-f0-9]{12}$/);
    assert.match(first.pcAgentAuthKeyId, /^sha256:[a-f0-9]{12}$/);
    assert.match(first.bridgeDeviceTokenSecret, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(first.bridgeDeviceTokenKeyId, /^sha256:[a-f0-9]{12}$/);
    assert.match(first.bridgeGrowthReviewToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(first.bridgeGrowthReviewTokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(first.bridgeGrowthReviewToken, first.coreToken);
    assert.notEqual(first.bridgeGrowthReviewToken, first.pcAgentToken);
    assert.equal(first.bridgeDeviceTokenSecret === first.coreToken, false);
    assert.equal(first.bridgeDeviceTokenSecret === first.pcAgentToken, false);

    const stored = await readFile(storePath, 'utf8');
    assert.equal(stored.includes(first.coreToken), false);
    assert.equal(stored.includes(first.pcAgentToken), false);
    assert.equal(JSON.parse(stored).plaintextSecretsStored, false);

    const second = resolveProductRuntimeSecrets({
      env: {},
      platform: 'win32',
      storePath,
      randomBytesImpl,
      protect: reversibleProtect,
      unprotect: reversibleUnprotect,
      hardenStore: () => {}
    });
    assert.equal(second.coreToken, first.coreToken);
    assert.equal(second.pcAgentToken, first.pcAgentToken);
    assert.equal(second.bridgeDeviceTokenSecret, first.bridgeDeviceTokenSecret);
    assert.equal(second.bridgeGrowthReviewToken, first.bridgeGrowthReviewToken);
    assert.equal(second.status.source, 'loaded');

    const definitions = productServiceDefinitions({
      env: { JARVIS_TEST_MODE: '1' },
      cwd: root,
      nodePath: 'node',
      secrets: second
    });
    const core = definitions.find((service) => service.id === 'core');
    const pcAgent = definitions.find((service) => service.id === 'pc-agent');
    const bridge = definitions.find((service) => service.id === 'bridge');
    const ui = definitions.find((service) => service.id === 'ui');

    assert.equal(core.environment.JARVIS_CORE_ADMIN_TOKEN_SHA256, first.coreTokenHash);
    assert.equal(core.environment.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_SHA256, first.bridgeGrowthReviewTokenHash);
    assert.equal('JARVIS_CORE_ADMIN_TOKEN' in core.environment, false);
    assert.equal(core.unsetEnvironment.includes('JARVIS_CORE_ADMIN_TOKEN'), true);
    assert.equal(core.healthIdentity.apiAuthKeyId, first.coreAuthKeyId);
    assert.equal(core.healthIdentity.growthReviewAuthorizationKeyId, first.bridgeGrowthReviewTokenKeyId);
    assert.equal(pcAgent.environment.JARVIS_PC_AGENT_API_TOKEN_SHA256, first.pcAgentTokenHash);
    assert.equal('JARVIS_PC_AGENT_API_TOKEN' in pcAgent.environment, false);
    assert.equal(pcAgent.healthIdentity.apiAuthKeyId, first.pcAgentAuthKeyId);
    assert.equal(bridge.unsetEnvironment.includes('JARVIS_CORE_ADMIN_TOKEN'), true);
    assert.equal(bridge.unsetEnvironment.includes('JARVIS_PC_AGENT_API_TOKEN'), true);
    assert.equal(core.environment.JARVIS_DEVICE_TOKEN_SECRET, first.bridgeDeviceTokenSecret);
    assert.equal(core.environment.JARVIS_CORE_MOBILE_GATEWAY_ENABLED, '1');
    assert.equal(core.healthIdentity.mobileGatewayEnabled, true);
    assert.equal(bridge.healthIdentity.executionAuthorityMode, 'core-api');
    assert.equal('JARVIS_DEVICE_TOKEN_SECRET' in bridge.environment, false);
    assert.equal('JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN' in bridge.environment, false);
    assert.equal(bridge.unsetEnvironment.includes('JARVIS_DEVICE_TOKEN_SECRET'), true);
    assert.equal(bridge.unsetEnvironment.includes('JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN'), true);
    assert.equal(bridge.environment.JARVIS_CORE_API_URL, 'http://127.0.0.1:4071');
    assert.equal('JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN' in core.environment, false);
    assert.equal(bridge.healthIdentity.deviceTokenKeyId, first.bridgeDeviceTokenKeyId);
    assert.equal(bridge.healthIdentity.growthReviewAuthorizationKeyId, first.bridgeGrowthReviewTokenKeyId);
    assert.equal(bridge.environment.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_KEY_ID, first.bridgeGrowthReviewTokenKeyId);
    assert.equal(ui.environment.JARVIS_CORE_ADMIN_TOKEN, first.coreToken);
    assert.equal(ui.environment.JARVIS_PC_AGENT_API_TOKEN, first.pcAgentToken);
    assert.equal('JARVIS_CORE_ADMIN_TOKEN_SHA256' in ui.environment, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('product runtime rejects mismatched configured token hashes', () => {
  assert.throws(() => resolveProductRuntimeSecrets({
    env: {
      JARVIS_TEST_MODE: '1',
      JARVIS_CORE_ADMIN_TOKEN_SHA256: 'a'.repeat(64)
    }
  }), { code: 'JARVIS_PRODUCT_TOKEN_HASH_MISMATCH' });
});

test('Core and PC Agent admin APIs fail closed when no product credential is configured', () => {
  const keys = [
    'JARVIS_TEST_MODE',
    'JARVIS_CORE_ADMIN_TOKEN',
    'JARVIS_CORE_ADMIN_TOKEN_SHA256',
    'JARVIS_PC_AGENT_API_TOKEN',
    'JARVIS_PC_AGENT_API_TOKEN_SHA256'
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const coreAuth = createCoreAdminAuthProvider();
    const pcGuard = new PcAgentApiGuard();
    assert.equal(coreAuth.status().configuredTokenCount, 0);
    assert.equal(coreAuth.verifyBearer('local-core-admin').allowed, false);
    assert.equal(pcGuard.status().tokenStore.hashConfigured, false);
    assert.equal(pcGuard.tokenStore.verify('local-pc-agent-api'), false);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('product supervisor refuses to reuse or restart across an endpoint identity mismatch', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ module: 'UNRELATED_LOCAL_APP', apiAuthKeyId: null })
  });
  const probe = await probeEndpointStatus('http://127.0.0.1:49999/health', {
    fetchImpl,
    expectedIdentity: { module: 'A_CORE', apiAuthKeyId: 'sha256:expected123' }
  });
  assert.equal(probe.reachable, true);
  assert.equal(probe.healthy, false);
  assert.equal(probe.identityVerified, false);

  let spawnCount = 0;
  await assert.rejects(startProductRuntime({
    definitions: [{
      id: 'core',
      label: 'Core Runtime',
      command: 'node',
      args: [],
      cwd: process.cwd(),
      endpoint: 'http://127.0.0.1:49999',
      healthUrl: 'http://127.0.0.1:49999/health',
      healthIdentity: { module: 'A_CORE', apiAuthKeyId: 'sha256:expected123' },
      environment: {},
      unsetEnvironment: []
    }],
    fetchImpl,
    spawnImpl: () => {
      spawnCount += 1;
      throw new Error('spawn must not be called');
    },
    logger: { log() {}, error() {} }
  }), { code: 'JARVIS_PRODUCT_SERVICE_IDENTITY_MISMATCH' });
  assert.equal(spawnCount, 0);
});

test('product runtime lock blocks duplicate supervisors and recovers only a dead owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-product-lock-'));
  const lockPath = join(root, 'product-runtime.lock.json');
  const randomBytesImpl = (size) => Buffer.alloc(size, 7);
  try {
    const first = acquireProductRuntimeLock({
      lockPath,
      workspaceRoot: root,
      pid: 111,
      randomBytesImpl,
      isProcessAlive: (pid) => pid === 111,
      getProcessStartTime: () => new Date('2026-01-01T00:00:00.000Z')
    });
    assert.equal(first.acquired, true);

    const duplicate = acquireProductRuntimeLock({
      lockPath,
      workspaceRoot: root,
      pid: 222,
      randomBytesImpl,
      isProcessAlive: (pid) => pid === 111,
      getProcessStartTime: () => new Date('2026-01-01T00:00:00.000Z')
    });
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.pid, 111);
    assert.equal(duplicate.release(), false);

    const recovered = acquireProductRuntimeLock({
      lockPath,
      workspaceRoot: root,
      pid: 333,
      randomBytesImpl: (size) => Buffer.alloc(size, 8),
      isProcessAlive: () => false
    });
    assert.equal(recovered.acquired, true);
    assert.equal(recovered.pid, 333);
    assert.equal(first.release(), false);
    assert.equal(recovered.release(), true);

    await writeFile(lockPath, '{"tampered":true}\n', 'utf8');
    assert.throws(() => acquireProductRuntimeLock({
      lockPath,
      workspaceRoot: root,
      pid: 444,
      randomBytesImpl,
      isProcessAlive: () => false
    }), { code: 'JARVIS_PRODUCT_RUNTIME_LOCK_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('product runtime lock recovers an alive PID that belongs to a process created after the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-product-lock-pid-reuse-'));
  const lockPath = join(root, 'product-runtime.lock.json');
  try {
    const stale = acquireProductRuntimeLock({
      lockPath,
      workspaceRoot: root,
      pid: 111,
      clock: () => new Date('2026-09-01T00:00:00.000Z'),
      randomBytesImpl: (size) => Buffer.alloc(size, 1),
      isProcessAlive: () => true,
      getProcessStartTime: () => new Date('2026-01-01T00:00:00.000Z')
    });
    const replacement = acquireProductRuntimeLock({
      lockPath,
      workspaceRoot: root,
      pid: 222,
      clock: () => new Date('2026-09-03T00:00:00.000Z'),
      randomBytesImpl: (size) => Buffer.alloc(size, 2),
      isProcessAlive: () => true,
      getProcessStartTime: () => new Date('2026-09-02T00:00:00.000Z')
    });
    assert.equal(replacement.acquired, true);
    assert.equal(replacement.pid, 222);
    assert.equal(stale.release(), false);
    assert.equal(replacement.release(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
