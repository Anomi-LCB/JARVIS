import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createServiceEnvironment,
  probeEndpoint,
  probeProductServices,
  productServiceDefinitions,
  startProductRuntime,
  terminateWindowsProcessTree
} from '../scripts/product-runtime.mjs';

const moduleByPort = new Map([
  ['14071', 'A_CORE'],
  ['14072', 'B_PC_AGENT'],
  ['14073', 'D_BRIDGE'],
  ['14074', 'JARVIS_CONTROL_CENTER'],
  ['4071', 'A_CORE'],
  ['17776', 'B_PC_AGENT'],
  ['17777', 'D_BRIDGE'],
  ['41730', 'JARVIS_CONTROL_CENTER']
]);

function healthyResponse(url, overrides = {}) {
  const port = new URL(String(url)).port;
  return {
    ok: true,
    json: async () => ({ module: moduleByPort.get(port), ...overrides })
  };
}

function healthyProductResponse(definitions, url, overrides = {}) {
  const definition = definitions.find((service) => service.healthUrl === String(url));
  return healthyResponse(url, { ...(definition?.healthIdentity ?? {}), ...overrides });
}

function createFakeChild({ onExit } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killSignals = [];
  const finish = (code, signal) => {
    if (child.exitCode !== null) return false;
    child.exitCode = code;
    child.killSignals.push(signal);
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      onExit?.(child);
      child.emit('exit', code, signal);
    });
    return true;
  };
  child.kill = (signal = 'SIGTERM') => finish(signal === 'SIGKILL' ? 137 : 0, signal);
  child.crash = (code = 1) => finish(code, null);
  return child;
}

async function waitForCondition(predicate, { timeoutMs = 1_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  assert.fail('Timed out waiting for the expected supervisor state.');
}

test('product runtime defines the complete local product without exposing inherited secrets', () => {
  const definitions = productServiceDefinitions({
    env: {
      JARVIS_CORE_PORT: '14071',
      JARVIS_PC_AGENT_PORT: '14072',
      JARVIS_BRIDGE_PORT: '14073',
      JARVIS_UI_PORT: '14074',
      USERPROFILE: 'C:\\Users\\Test',
      JARVIS_OPENAI_API_KEY: 'must-not-be-copied'
    },
    cwd: 'C:\\Jarvis',
    nodePath: 'node-test'
  });

  assert.deepEqual(definitions.map((service) => service.id), ['core', 'pc-agent', 'bridge', 'ui']);
  assert.deepEqual(definitions.map((service) => service.endpoint), [
    'http://127.0.0.1:14071',
    'http://127.0.0.1:14072',
    'http://127.0.0.1:14073',
    'http://127.0.0.1:14074'
  ]);
  assert.deepEqual(definitions.map((service) => service.healthIdentity.module), [
    'A_CORE',
    'B_PC_AGENT',
    'D_BRIDGE',
    'JARVIS_CONTROL_CENTER'
  ]);
  assert.equal(definitions[3].environment.JARVIS_CORE_API_URL, 'http://127.0.0.1:14071');
  assert.equal(definitions.some((service) => 'JARVIS_OPENAI_API_KEY' in service.environment), false);
  assert.equal(definitions[1].environment.JARVIS_PC_AGENT_VAULT_KEY_PROVIDER, 'windows-dpapi');
  assert.equal(definitions[0].environment.JARVIS_CORE_ALLOWED_ROOTS, 'C:\\Jarvis\\workspace;C:\\Users\\Test\\Desktop');
  assert.equal(definitions[1].environment.JARVIS_ALLOWED_ROOTS, 'C:\\Jarvis\\workspace;C:\\Users\\Test\\Desktop');
  assert.match(definitions[0].environment.JARVIS_DEVICE_TOKEN_SECRET, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(definitions[0].environment.JARVIS_CORE_MOBILE_GATEWAY_ENABLED,'1');
  assert.equal(definitions[2].environment.JARVIS_DEVICE_TOKEN_SECRET,undefined);
  assert.equal(definitions[2].healthIdentity.executionAuthorityMode,'core-api');
  assert.equal(definitions[2].environment.JARVIS_CORE_API_URL,'http://127.0.0.1:14071');
  assert.match(definitions[2].healthIdentity.deviceTokenKeyId, /^sha256:[a-f0-9]{12}$/);
});

test('product runtime strips unrelated process secrets and grants each service only required credentials', () => {
  const definitions = productServiceDefinitions({
    env: { JARVIS_TEST_MODE: '1' },
    cwd: 'C:\\Jarvis',
    nodePath: 'node-test'
  });
  const inherited = {
    PATH: 'C:\\Windows',
    OPENAI_API_KEY: 'openai-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    JARVIS_SMTP_PASS: 'smtp-secret',
    JARVIS_PC_AGENT_VAULT_KEY: 'legacy-vault-secret',
    GITHUB_TOKEN: 'github-secret',
    DATABASE_URL: 'postgres://secret'
    ,JARVIS_DEVICE_TOKEN_SECRET:'inherited-untrusted-device-secret'
  };
  const [core, pcAgent, bridge, ui] = definitions.map((definition) => createServiceEnvironment(definition, inherited));

  assert.equal(core.OPENAI_API_KEY, 'openai-secret');
  assert.equal(core.ANTHROPIC_API_KEY, 'anthropic-secret');
  assert.equal('JARVIS_SMTP_PASS' in core, false);
  assert.equal('GITHUB_TOKEN' in core, false);
  assert.equal(pcAgent.JARVIS_SMTP_PASS, 'smtp-secret');
  assert.equal(pcAgent.JARVIS_PC_AGENT_VAULT_KEY, 'legacy-vault-secret');
  assert.equal(pcAgent.JARVIS_PC_AGENT_VAULT_KEY_PROVIDER, 'windows-dpapi');
  assert.equal('DATABASE_URL' in pcAgent, false);
  assert.equal('OPENAI_API_KEY' in bridge, false);
  assert.equal('JARVIS_SMTP_PASS' in bridge, false);
  assert.match(core.JARVIS_DEVICE_TOKEN_SECRET, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(core.JARVIS_DEVICE_TOKEN_SECRET,inherited.JARVIS_DEVICE_TOKEN_SECRET);
  assert.equal('JARVIS_DEVICE_TOKEN_SECRET' in bridge,false);
  assert.equal('JARVIS_DEVICE_TOKEN_SECRET' in ui,false);
  assert.equal(bridge.JARVIS_CORE_API_URL,'http://127.0.0.1:4071');
  assert.equal('OPENAI_API_KEY' in ui, false);
  assert.equal(typeof ui.JARVIS_CORE_ADMIN_TOKEN, 'string');
  assert.equal(typeof ui.JARVIS_PC_AGENT_API_TOKEN, 'string');
});

test('product status probes every service and reports a single readiness result', async () => {
  const definitions = productServiceDefinitions({ env: {}, cwd: '.', nodePath: 'node' });
  const report = await probeProductServices({
    definitions,
    fetchImpl: async (url) => String(url).includes(':17777')
      ? { ok: false }
      : healthyProductResponse(definitions, url)
  });

  assert.equal(report.status, 'degraded');
  assert.equal(report.services.length, 4);
  assert.equal(report.services.find((service) => service.id === 'bridge').healthy, false);
  assert.equal(report.services.filter((service) => service.healthy).length, 3);
  assert.equal(report.services.filter((service) => service.identityVerified).length, 3);
});

test('product status rejects an unrelated site that returns HTTP 200 on the UI port', async () => {
  const definitions = productServiceDefinitions({ env: {}, cwd: '.', nodePath: 'node' });
  const report = await probeProductServices({
    definitions,
    fetchImpl: async (url) => String(url).includes(':41730')
      ? healthyProductResponse(definitions, url, { module: 'AXIS_EXECUTION_OS' })
      : healthyProductResponse(definitions, url)
  });

  assert.equal(report.status, 'degraded');
  assert.equal(report.services.find((service) => service.id === 'ui').healthy, false);
  assert.equal(report.services.find((service) => service.id === 'ui').identityVerified, false);
});

test('product status remains reachable but reports restricted when the trust kernel is locked down', async () => {
  const definitions = productServiceDefinitions({ env: {}, cwd: '.', nodePath: 'node' });
  const report = await probeProductServices({
    definitions,
    fetchImpl: async (url) => String(url).includes(':4071')
      ? healthyProductResponse(definitions, url, {
          trust: {
            mode: 'lockdown',
            operational: false,
            mutatingExecutionAllowed: false,
            riskScore: 100,
            activeIncident: { incidentId: 'trust_incident_test' }
          }
        })
      : healthyProductResponse(definitions, url)
  });

  assert.equal(report.services.every((service) => service.healthy), true);
  assert.equal(report.status, 'restricted');
  assert.equal(report.operational, false);
  assert.equal(report.mutatingExecutionAllowed, false);
  assert.equal(report.services.find((service) => service.id === 'core').trust.mode, 'lockdown');
});

test('product supervisor reuses healthy services without spawning or owning them', async () => {
  const definitions = productServiceDefinitions({ env: {}, cwd: '.', nodePath: 'node' });
  const lines = [];
  const runtime = await startProductRuntime({
    definitions,
    fetchImpl: async (url) => healthyProductResponse(definitions, url),
    spawnImpl: () => {
      throw new Error('healthy services must not be spawned');
    },
    monitorIntervalMs: 60_000,
    logger: {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line)
    }
  });

  assert.equal(runtime.uiUrl, 'http://127.0.0.1:41730');
  assert.equal(runtime.services().every((service) => service.status === 'reused' && service.owned === false), true);
  assert.equal(lines.some((line) => String(line).includes('product runtime ready')), true);
  await runtime.stop();
});

test('product supervisor absorbs a transient health outage without spawning over a live child', async () => {
  const definitions = productServiceDefinitions({
    env: { JARVIS_CORE_PORT: '14071' },
    cwd: '.',
    nodePath: 'node'
  }).slice(0, 1);
  let activeChild = null;
  let spawnCount = 0;
  let duplicateSpawnAttempts = 0;
  let transientFailures = 0;
  const fetchImpl = async (url) => {
    if (!activeChild || activeChild.exitCode !== null) throw new Error('offline');
    if (transientFailures > 0) {
      transientFailures -= 1;
      throw new Error('transient health timeout');
    }
    return healthyProductResponse(definitions, url);
  };
  const spawnImpl = () => {
    if (activeChild?.exitCode === null) {
      duplicateSpawnAttempts += 1;
      throw Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
    }
    spawnCount += 1;
    const child = createFakeChild({
      onExit: (exitedChild) => {
        if (activeChild === exitedChild) activeChild = null;
      }
    });
    activeChild = child;
    return child;
  };
  const runtime = await startProductRuntime({
    definitions,
    fetchImpl,
    spawnImpl,
    startupTimeoutMs: 200,
    probeIntervalMs: 1,
    monitorIntervalMs: 5,
    recoveryGraceMs: 30,
    restartBackoffBaseMs: 1,
    restartStopTimeoutMs: 20,
    logger: { log() {}, error() {} }
  });
  try {
    transientFailures = 2;
    await delay(70);
    assert.equal(spawnCount, 1);
    assert.equal(duplicateSpawnAttempts, 0);
    assert.deepEqual(activeChild.killSignals, []);
    assert.notEqual(runtime.services()[0].status, 'failed');
  } finally {
    await runtime.stop();
  }
});

test('product supervisor stops an unhealthy owned child before starting its replacement', async () => {
  const definitions = productServiceDefinitions({
    env: { JARVIS_CORE_PORT: '14071' },
    cwd: '.',
    nodePath: 'node'
  }).slice(0, 1);
  const events = [];
  let activeChild = null;
  let forceUnhealthy = false;
  let spawnCount = 0;
  let duplicateSpawnAttempts = 0;
  const fetchImpl = async (url) => {
    if (!activeChild || activeChild.exitCode !== null || forceUnhealthy) throw new Error('offline');
    return healthyProductResponse(definitions, url);
  };
  const spawnImpl = () => {
    if (activeChild?.exitCode === null) {
      duplicateSpawnAttempts += 1;
      throw Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
    }
    spawnCount += 1;
    const sequence = spawnCount;
    const child = createFakeChild({
      onExit: (exitedChild) => {
        events.push('exit-' + sequence);
        if (activeChild === exitedChild) activeChild = null;
      }
    });
    const originalKill = child.kill;
    child.kill = (signal) => {
      events.push('kill-' + sequence + '-' + signal);
      return originalKill(signal);
    };
    activeChild = child;
    events.push('spawn-' + sequence);
    if (sequence > 1) forceUnhealthy = false;
    return child;
  };
  const runtime = await startProductRuntime({
    definitions,
    fetchImpl,
    spawnImpl,
    startupTimeoutMs: 200,
    probeIntervalMs: 1,
    monitorIntervalMs: 5,
    recoveryGraceMs: 10,
    restartBackoffBaseMs: 1,
    restartStopTimeoutMs: 20,
    logger: { log() {}, error() {} }
  });
  try {
    forceUnhealthy = true;
    await waitForCondition(() => spawnCount === 2);
    assert.equal(duplicateSpawnAttempts, 0);
    assert.deepEqual(events.slice(0, 4), ['spawn-1', 'kill-1-SIGTERM', 'exit-1', 'spawn-2']);
    assert.equal(runtime.services()[0].status, 'recovered');
  } finally {
    await runtime.stop();
  }
});

test('product supervisor restart budget recovers after its rolling time window', async () => {
  const definitions = productServiceDefinitions({
    env: { JARVIS_CORE_PORT: '14071' },
    cwd: '.',
    nodePath: 'node'
  }).slice(0, 1);
  let activeChild = null;
  let spawnCount = 0;
  const fetchImpl = async (url) => {
    if (!activeChild || activeChild.exitCode !== null) throw new Error('offline');
    return healthyProductResponse(definitions, url);
  };
  const spawnImpl = () => {
    spawnCount += 1;
    const child = createFakeChild({
      onExit: (exitedChild) => {
        if (activeChild === exitedChild) activeChild = null;
      }
    });
    activeChild = child;
    return child;
  };
  const runtime = await startProductRuntime({
    definitions,
    fetchImpl,
    spawnImpl,
    startupTimeoutMs: 200,
    probeIntervalMs: 1,
    monitorIntervalMs: 100,
    maxRestarts: 1,
    recoveryGraceMs: 1,
    restartWindowMs: 30,
    restartBackoffBaseMs: 1,
    restartStopTimeoutMs: 20,
    logger: { log() {}, error() {} }
  });
  try {
    activeChild.crash();
    await waitForCondition(() => spawnCount === 2);
    await delay(40);
    activeChild.crash();
    await waitForCondition(() => spawnCount === 3);
    assert.equal(runtime.services()[0].restartCount, 2);
    assert.notEqual(runtime.services()[0].status, 'cooldown');
  } finally {
    await runtime.stop();
  }
});

test('product supervisor does not spawn into a reachable HTTP 503 endpoint', async () => {
  const definitions = productServiceDefinitions({
    env: { JARVIS_CORE_PORT: '14071' },
    cwd: '.',
    nodePath: 'node'
  }).slice(0, 1);
  let spawnCount = 0;
  await assert.rejects(startProductRuntime({
    definitions,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    spawnImpl: () => {
      spawnCount += 1;
      throw new Error('spawn must not be called');
    },
    logger: { log() {}, error() {} }
  }), { code: 'JARVIS_PRODUCT_SERVICE_ENDPOINT_OCCUPIED' });
  assert.equal(spawnCount, 0);
});

test('endpoint probe fails closed on network errors', async () => {
  assert.equal(await probeEndpoint('http://127.0.0.1:1', {
    fetchImpl: async () => {
      throw new Error('offline');
    }
  }), false);
});

test('endpoint probe fails closed when the service identity does not match', async () => {
  assert.equal(await probeEndpoint('http://127.0.0.1:41730/health', {
    fetchImpl: async () => healthyResponse('http://127.0.0.1:41730/health', { module: 'AXIS_EXECUTION_OS' }),
    expectedIdentity: { module: 'JARVIS_CONTROL_CENTER' }
  }), false);
});

test('Windows recovery can terminate a blocked child process tree without a shell', async () => {
  let invocation = null;
  const child = { pid: 43210, exitCode: null };
  const stopped = await terminateWindowsProcessTree(child, {
    platform: 'win32',
    processAlive: () => false,
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit('exit', 0, null));
      return killer;
    }
  });

  assert.equal(stopped, true);
  assert.equal(invocation.command, 'taskkill.exe');
  assert.deepEqual(invocation.args, ['/PID', '43210', '/T', '/F']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
});
