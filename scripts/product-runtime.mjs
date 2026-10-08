import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProductRuntimeSecrets } from '../packages/shared/src/product-runtime-secrets.js';
import { acquireProductRuntimeLock, defaultProductRuntimeLockPath } from '../packages/shared/src/product-runtime-lock.js';
import {createDuffelBrokerProcess} from './duffel-broker-process.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function productServiceDefinitions({
  env = process.env,
  cwd = repositoryRoot,
  nodePath = process.execPath,
  secrets = null
} = {}) {
  const runtimeSecrets = secrets ?? resolveProductRuntimeSecrets({ env });
  const host = env.JARVIS_PRODUCT_HOST ?? '127.0.0.1';
  const ports = {
    core: numberFromEnv(env.JARVIS_CORE_PORT, 4071),
    pc: numberFromEnv(env.JARVIS_PC_AGENT_PORT, 17776),
    bridge: numberFromEnv(env.JARVIS_BRIDGE_PORT, 17777),
    ui: numberFromEnv(env.JARVIS_UI_PORT, 41730)
  };
  const trustRoot = resolve(cwd, env.JARVIS_TRUST_ROOT ?? 'logs/trust');
  const userHome = env.USERPROFILE ?? env.HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? cwd;
  const defaultAllowedRoots = [resolve(cwd, 'workspace'), resolve(userHome, 'Desktop')].join(';');
  const sharedAllowedRoots = env.JARVIS_ALLOWED_ROOTS ?? defaultAllowedRoots;
  const coreAllowedRoots = env.JARVIS_CORE_ALLOWED_ROOTS ?? sharedAllowedRoots;
  const endpoint = (port, path = '') => 'http://' + host + ':' + port + path;
  return [
    serviceDefinition({
      id: 'core',
      label: 'Core Runtime',
      command: nodePath,
      args: ['scripts/core-service-runtime.mjs'],
      cwd,
      endpoint: endpoint(ports.core),
      healthUrl: endpoint(ports.core, '/health'),
      healthIdentity: {
        module: 'A_CORE',
        mobileGatewayEnabled: true,
        apiAuthKeyId: runtimeSecrets.coreAuthKeyId,
        growthReviewAuthorizationKeyId: runtimeSecrets.bridgeGrowthReviewTokenKeyId
      },
      environment: {
        PORT: String(ports.core),
        JARVIS_CORE_HOST: host,
        JARVIS_CORE_MOBILE_GATEWAY_ENABLED: '1',
        JARVIS_BRIDGE_STATE_DIR: resolve(cwd, env.JARVIS_BRIDGE_STATE_DIR ?? 'logs/bridge-state'),
        JARVIS_DEVICE_TOKEN_SECRET: runtimeSecrets.bridgeDeviceTokenSecret,
        JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_KEY_ID: runtimeSecrets.bridgeGrowthReviewTokenKeyId,
        JARVIS_BROWSER_DRIVER: env.JARVIS_BROWSER_DRIVER ?? '1',
        JARVIS_TRUST_ROOT: trustRoot,
        JARVIS_CORE_ALLOWED_ROOTS: coreAllowedRoots,
        JARVIS_CORE_ADMIN_TOKEN_SHA256: runtimeSecrets.coreTokenHash,
        JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_SHA256: runtimeSecrets.bridgeGrowthReviewTokenHash,
        JARVIS_PC_AGENT_API_URL: endpoint(ports.pc),
        JARVIS_PC_AGENT_EXECUTION_TOKEN: runtimeSecrets.pcAgentExecutionToken,
        JARVIS_CAPABILITY_TOKEN_SECRET: runtimeSecrets.capabilityTokenSecret
      },
      sensitiveEnvironmentAllowlist: [
        'JARVIS_DEVICE_TOKEN_SECRET',
        'JARVIS_GOOGLE_CLIENT_ID',
        'JARVIS_GOOGLE_CLIENT_SECRET',
        'JARVIS_GOOGLE_REFRESH_TOKEN',
        'ANTHROPIC_API_KEY',
        'JARVIS_ANTHROPIC_API_KEY',
        'JARVIS_OPENAI_API_KEY',
        'OPENAI_API_KEY',
        'JARVIS_PC_AGENT_EXECUTION_TOKEN',
        'JARVIS_CAPABILITY_TOKEN_SECRET'
      ],
      unsetEnvironment: [
        'JARVIS_CORE_ADMIN_TOKEN',
        'JARVIS_PC_AGENT_API_TOKEN',
        'JARVIS_PC_AGENT_API_TOKEN_SHA256'
      ]
    }),
    serviceDefinition({
      id: 'pc-agent',
      label: 'PC Agent',
      command: nodePath,
      args: ['apps/pc-agent/src/main.mjs'],
      cwd,
      endpoint: endpoint(ports.pc),
      healthUrl: endpoint(ports.pc, '/health'),
      healthIdentity: { module: 'B_PC_AGENT', apiAuthKeyId: runtimeSecrets.pcAgentAuthKeyId },
      environment: {
        PORT: String(ports.pc),
        JARVIS_TRUST_ROOT: trustRoot,
        JARVIS_ALLOWED_ROOTS: sharedAllowedRoots,
        JARVIS_BROWSER_DRIVER: env.JARVIS_BROWSER_DRIVER ?? '1',
        JARVIS_PC_AGENT_API_TOKEN_SHA256: runtimeSecrets.pcAgentTokenHash,
        JARVIS_PC_AGENT_EXECUTION_TOKEN_SHA256: runtimeSecrets.pcAgentExecutionTokenHash,
        JARVIS_CAPABILITY_TOKEN_SECRET: runtimeSecrets.capabilityTokenSecret,
        JARVIS_PC_AGENT_VAULT_KEY_PROVIDER: 'windows-dpapi'
      },
      sensitiveEnvironmentAllowlist: [
        'ANTHROPIC_API_KEY',
        'JARVIS_ANTHROPIC_API_KEY',
        'JARVIS_OPENAI_API_KEY',
        'OPENAI_API_KEY',
        'JARVIS_PC_AGENT_VAULT_KEY',
        'JARVIS_CAPABILITY_TOKEN_SECRET',
        'JARVIS_SMTP_PASS'
      ],
      unsetEnvironment: [
        'JARVIS_PC_AGENT_API_TOKEN',
        'JARVIS_CORE_ADMIN_TOKEN',
        'JARVIS_CORE_ADMIN_TOKEN_SHA256'
      ]
    }),
    serviceDefinition({
      id: 'bridge',
      label: 'Mobile Bridge',
      command: nodePath,
      args: ['apps/bridge/src/main.mjs'],
      cwd,
      endpoint: endpoint(ports.bridge),
      healthUrl: endpoint(ports.bridge, '/health'),
      healthIdentity: {
        module: 'D_BRIDGE',
        executionAuthorityMode: 'core-api',
        deviceTokenKeyId: runtimeSecrets.bridgeDeviceTokenKeyId,
        growthReviewAuthorizationKeyId: runtimeSecrets.bridgeGrowthReviewTokenKeyId
      },
      environment: {
        PORT: String(ports.bridge),
        JARVIS_BRIDGE_HOST: host,
        JARVIS_BRIDGE_PORT: String(ports.bridge),
        JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_KEY_ID: runtimeSecrets.bridgeGrowthReviewTokenKeyId,
        JARVIS_CORE_API_URL: endpoint(ports.core)
      },
      unsetEnvironment: [
        'JARVIS_DEVICE_TOKEN_SECRET',
        'JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN',
        'JARVIS_CORE_ADMIN_TOKEN',
        'JARVIS_CORE_ADMIN_TOKEN_SHA256',
        'JARVIS_PC_AGENT_API_TOKEN',
        'JARVIS_PC_AGENT_API_TOKEN_SHA256'
      ]
    }),
    serviceDefinition({
      id: 'ui',
      label: 'Control Center',
      command: nodePath,
      args: ['scripts/dev-server.mjs'],
      cwd,
      endpoint: endpoint(ports.ui),
      healthUrl: endpoint(ports.ui, '/health'),
      healthIdentity: { module: 'JARVIS_CONTROL_CENTER' },
      environment: {
        PORT: String(ports.ui),
        HOST: host,
        JARVIS_CORE_API_URL: endpoint(ports.core),
        JARVIS_PC_AGENT_API_URL: endpoint(ports.pc),
        JARVIS_BRIDGE_API_URL: endpoint(ports.bridge),
        JARVIS_CORE_ADMIN_TOKEN: runtimeSecrets.coreToken,
        JARVIS_PC_AGENT_API_TOKEN: runtimeSecrets.pcAgentToken
      },
      unsetEnvironment: [
        'JARVIS_CORE_ADMIN_TOKEN_SHA256',
        'JARVIS_PC_AGENT_API_TOKEN_SHA256'
      ]
    })
  ];
}

export async function probeProductServices({
  definitions = productServiceDefinitions(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 1_500
} = {}) {
  const services = await Promise.all(definitions.map(async (definition) => {
    const probe = await probeEndpointStatus(definition.healthUrl, {
      fetchImpl,
      timeoutMs,
      expectedIdentity: definition.healthIdentity
    });
    return {
      id: definition.id,
      label: definition.label,
      endpoint: definition.endpoint,
      healthy: probe.healthy,
      reachable: probe.reachable,
      statusCode: probe.statusCode,
      failureReason: probe.failureReason ?? null,
      mismatchedIdentityFields: probe.mismatchedIdentityFields ?? [],
      nextAction: probe.healthy ? null : !probe.reachable ? 'start-service-after-port-and-owner-check'
        : probe.identityMismatch ? 'verify-existing-process-owner-and-original-credentials'
          : 'inspect-existing-service-health-before-restart',
      identityVerified: probe.identityVerified,
      trust: probe.identityVerified && probe.payload?.trust
        ? {
            mode: probe.payload.trust.mode ?? 'unavailable',
            operational: probe.payload.trust.operational === true,
            mutatingExecutionAllowed: probe.payload.trust.mutatingExecutionAllowed === true,
            riskScore: probe.payload.trust.riskScore ?? null,
            activeIncident: probe.payload.trust.activeIncident ?? null
          }
        : null
    };
  }));
  const healthy = services.every((service) => service.healthy);
  const restricted = services.some((service) => service.trust?.mode === 'lockdown');
  const guarded = services.some((service) => service.trust?.mode === 'guarded');
  return {
    reportVersion: 'jarvis-product-runtime-status-v1',
    status: !healthy ? 'degraded' : restricted ? 'restricted' : guarded ? 'guarded' : 'ready',
    operational: healthy && !restricted,
    mutatingExecutionAllowed: healthy && !restricted
      && services.filter((service) => service.trust).every((service) => service.trust.mutatingExecutionAllowed),
    checkedAt: new Date().toISOString(),
    uiUrl: definitions.find((definition) => definition.id === 'ui')?.endpoint ?? null,
    services
  };
}

// The CLI and integration tests share this exact startup/shutdown boundary.
export async function startConnectedProductRuntime({env=process.env,...options}={}){
  let duffel,runtime;
  try{
    const gatewayOnly=options.definitions?.length===1&&options.definitions[0].id==='bridge';
    if(env.JARVIS_DUFFEL_CONNECTION_PROFILE&&!gatewayOnly){
      duffel=createDuffelBrokerProcess({env});await duffel.start();
      (options.logger??console).log('JARVIS Duffel broker transport ready (provider unverified).');
    }
    runtime=await startProductRuntime(options);
  }catch(error){await duffel?.stop();throw error;}
  let stopping;
  return {...runtime,connections:()=>duffel?{duffel:duffel.snapshot()}:{},
    stop:()=>stopping??=(async()=>{try{await runtime.stop();}finally{await duffel?.stop();}})()};
}

export async function startProductRuntime({
  definitions = productServiceDefinitions(),
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  startupTimeoutMs = 30_000,
  probeIntervalMs = 250,
  monitorIntervalMs = 5_000,
  maxRestarts = 3,
  recoveryGraceMs = 3_000,
  restartWindowMs = 60_000,
  restartBackoffBaseMs = 250,
  restartStopTimeoutMs = 4_000,
  processTreeKillImpl = terminateWindowsProcessTree,
  logger = console
} = {}) {
  const supervisors = definitions.map((definition) => new ProductServiceSupervisor(definition, {
    fetchImpl,
    spawnImpl,
    startupTimeoutMs,
    probeIntervalMs,
    monitorIntervalMs,
    maxRestarts,
    recoveryGraceMs,
    restartWindowMs,
    restartBackoffBaseMs,
    restartStopTimeoutMs,
    processTreeKillImpl,
    logger
  }));
  try {
    await Promise.all(supervisors.map((supervisor) => supervisor.start()));
  } catch (error) {
    await Promise.allSettled(supervisors.map((supervisor) => supervisor.stop()));
    throw error;
  }
  const runtime = {
    runtimeVersion: 'jarvis-product-runtime-supervisor-v1',
    uiUrl: definitions.find((definition) => definition.id === 'ui')?.endpoint ?? null,
    services: () => supervisors.map((supervisor) => supervisor.snapshot()),
    stop: async () => {
      await Promise.allSettled(supervisors.map((supervisor) => supervisor.stop()));
    }
  };
  logger.log('');
  logger.log('JARVIS product runtime ready: ' + (runtime.uiUrl ?? definitions[0]?.endpoint ?? 'ready'));
  for (const service of runtime.services()) {
    logger.log('- ' + service.label + ': ' + service.status + ' (' + service.endpoint + ')');
  }
  return runtime;
}

class ProductServiceSupervisor {
  constructor(definition, options) {
    this.definition = definition;
    this.fetchImpl = options.fetchImpl;
    this.spawnImpl = options.spawnImpl;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.probeIntervalMs = options.probeIntervalMs;
    this.monitorIntervalMs = options.monitorIntervalMs;
    this.maxRestarts = options.maxRestarts;
    this.recoveryGraceMs = options.recoveryGraceMs;
    this.restartWindowMs = options.restartWindowMs;
    this.restartBackoffBaseMs = options.restartBackoffBaseMs;
    this.restartStopTimeoutMs = options.restartStopTimeoutMs;
    this.processTreeKillImpl = options.processTreeKillImpl;
    this.logger = options.logger;
    this.child = null;
    this.owned = false;
    this.stopping = false;
    this.restartCount = 0;
    this.restartAttempts = [];
    this.nextRecoveryAt = 0;
    this.recoveryStopChild = null;
    this.status = 'pending';
    this.monitorTimer = null;
    this.recoveryPromise = null;
  }

  async start() {
    const probe = await this.probe();
    if (probe.healthy) {
      this.status = 'reused';
      this.startMonitor();
      return this.snapshot();
    }
    if (probe.reachable) {
      this.status = probe.identityMismatch ? 'identity-mismatch' : 'endpoint-unhealthy';
      throw probe.identityMismatch
        ? serviceIdentityMismatchError(this.definition, probe)
        : serviceEndpointOccupiedError(this.definition, probe);
    }
    await this.spawnAndWait('startup');
    this.startMonitor();
    return this.snapshot();
  }

  async spawnAndWait(reason) {
    if (this.child && this.child.exitCode === null) {
      const error = new Error(this.definition.label + ' already has a live supervised process.');
      error.code = 'JARVIS_PRODUCT_DUPLICATE_SPAWN_BLOCKED';
      throw error;
    }
    this.status = reason === 'startup' ? 'starting' : 'recovering';
    this.owned = true;
    const child = this.spawnImpl(this.definition.command, this.definition.args, {
      cwd: this.definition.cwd,
      env: createServiceEnvironment(this.definition),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    pipeWithPrefix(child.stdout, '[' + this.definition.id + '] ', this.logger.log.bind(this.logger));
    pipeWithPrefix(child.stderr, '[' + this.definition.id + ':error] ', this.logger.error.bind(this.logger));
    child.once('exit', (code, signal) => this.handleExit(child, code, signal));
    await this.waitUntilHealthy(child);
    this.status = reason === 'startup' ? 'started' : 'recovered';
  }

  async waitUntilHealthy(child) {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(this.definition.label + ' exited before becoming healthy (code ' + child.exitCode + ').');
      }
      const probe = await this.probe();
      if (probe.healthy) return;
      if (probe.identityMismatch) throw serviceIdentityMismatchError(this.definition, probe);
      await delay(this.probeIntervalMs);
    }
    throw new Error(this.definition.label + ' did not become healthy within ' + this.startupTimeoutMs + 'ms.');
  }

  async healthy() {
    return (await this.probe()).healthy;
  }

  async probe() {
    return probeEndpointStatus(this.definition.healthUrl, {
      fetchImpl: this.fetchImpl,
      timeoutMs: Math.min(1_500, this.probeIntervalMs * 4),
      expectedIdentity: this.definition.healthIdentity
    });
  }

  startMonitor() {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      void this.monitor();
    }, this.monitorIntervalMs);
    this.monitorTimer.unref?.();
  }

  async monitor() {
    if (this.stopping || this.recoveryPromise) return;
    const probe = await this.probe();
    if (probe.healthy) {
      if (this.status === 'unhealthy' || this.status === 'failed' || this.status === 'cooldown') {
        this.status = this.child && this.child.exitCode === null ? 'recovered' : 'reused';
      }
      return;
    }
    if (probe.identityMismatch) {
      if (this.status !== 'identity-mismatch') {
        this.logger.error('[' + this.definition.id + '] endpoint identity mismatch; automatic reuse and restart are blocked.');
      }
      this.status = 'identity-mismatch';
      return;
    }
    if (probe.reachable && !this.liveChild()) {
      this.markEndpointUnhealthy(probe);
      return;
    }
    this.status = 'unhealthy';
    this.recoveryPromise = this.recover('health-check-failed').finally(() => {
      this.recoveryPromise = null;
    });
    await this.recoveryPromise;
  }

  handleExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.owned = false;
    if (this.recoveryStopChild === child) {
      this.recoveryStopChild = null;
      return;
    }
    if (this.stopping) return;
    this.status = 'stopped';
    this.logger.error('[' + this.definition.id + '] exited (code=' + (code ?? 'null') + ', signal=' + (signal ?? 'none') + ').');
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.recover('process-exited').finally(() => {
        this.recoveryPromise = null;
      });
    }
  }

  async recover(reason) {
    if (this.stopping) {
      this.status = 'stopping';
      return;
    }
    let probe = await this.probe();
    if (probe.healthy) {
      this.status = this.liveChild() ? 'recovered' : 'reused';
      return;
    }
    if (probe.identityMismatch) {
      this.status = 'identity-mismatch';
      this.logger.error('[' + this.definition.id + '] recovery blocked because another service owns the endpoint.');
      return;
    }

    let child = this.liveChild();
    if (probe.reachable && !child) {
      this.markEndpointUnhealthy(probe);
      return;
    }

    if (child) {
      probe = await this.waitForHealthyGrace(child);
      if (probe.healthy) {
        this.status = 'recovered';
        return;
      }
      if (probe.identityMismatch) {
        this.status = 'identity-mismatch';
        this.logger.error('[' + this.definition.id + '] recovery blocked because endpoint identity changed during the recovery grace period.');
        return;
      }
      child = this.liveChild();
    }

    const restartAttempt = this.reserveRestartAttempt();
    if (!restartAttempt) return;

    if (child) {
      try {
        await this.stopChildForRecovery(child);
      } catch (error) {
        this.status = 'failed';
        this.logger.error('[' + this.definition.id + '] could not stop the unhealthy process: ' + error.message);
        return;
      }
    }

    await delay(Math.min(4_000, this.restartBackoffBaseMs * (2 ** (restartAttempt.windowAttempt - 1))));
    probe = await this.probe();
    if (probe.healthy) {
      this.status = 'reused';
      this.owned = false;
      return;
    }
    if (probe.identityMismatch) {
      this.status = 'identity-mismatch';
      this.logger.error('[' + this.definition.id + '] recovery blocked because another service acquired the endpoint.');
      return;
    }
    if (probe.reachable) {
      this.markEndpointUnhealthy(probe);
      return;
    }

    try {
      await this.spawnAndWait(reason);
      this.logger.log('[' + this.definition.id + '] recovered after restart attempt ' + this.restartCount + '.');
    } catch (error) {
      this.status = 'failed';
      this.logger.error('[' + this.definition.id + '] recovery failed: ' + error.message);
    }
  }

  liveChild() {
    return this.child && this.child.exitCode === null ? this.child : null;
  }

  async waitForHealthyGrace(child) {
    const deadline = Date.now() + this.recoveryGraceMs;
    let probe = { healthy: false, reachable: false, identityMismatch: false };
    while (Date.now() < deadline && this.child === child && child.exitCode === null) {
      await delay(Math.min(this.probeIntervalMs, Math.max(1, deadline - Date.now())));
      probe = await this.probe();
      if (probe.healthy || probe.identityMismatch) return probe;
    }
    return probe;
  }

  reserveRestartAttempt() {
    const now = Date.now();
    this.restartAttempts = this.restartAttempts.filter((attemptedAt) => now - attemptedAt < this.restartWindowMs);
    if (this.restartAttempts.length >= this.maxRestarts) {
      const nextRecoveryAt = this.restartAttempts[0] + this.restartWindowMs;
      if (this.nextRecoveryAt !== nextRecoveryAt) {
        this.logger.error(
          '[' + this.definition.id + '] restart rate limit reached; automatic recovery resumes at '
          + new Date(nextRecoveryAt).toISOString() + '.'
        );
      }
      this.nextRecoveryAt = nextRecoveryAt;
      this.status = 'cooldown';
      return null;
    }
    this.restartAttempts.push(now);
    this.nextRecoveryAt = 0;
    this.restartCount += 1;
    return {
      totalAttempt: this.restartCount,
      windowAttempt: this.restartAttempts.length
    };
  }

  async stopChildForRecovery(child) {
    if (this.child !== child || child.exitCode !== null) return;
    this.recoveryStopChild = child;
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit').catch(() => []),
      delay(this.restartStopTimeoutMs)
    ]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        once(child, 'exit').catch(() => []),
        delay(Math.min(1_000, this.restartStopTimeoutMs))
      ]);
    }
    let processTreeStopped = false;
    if (child.exitCode === null && Number.isInteger(Number(child.pid))) {
      processTreeStopped = await this.processTreeKillImpl(child, {
        timeoutMs: this.restartStopTimeoutMs
      });
      if (processTreeStopped) {
        await Promise.race([
          once(child, 'exit').catch(() => []),
          delay(Math.min(1_000, this.restartStopTimeoutMs))
        ]);
      }
    }
    if (child.exitCode === null && !processTreeStopped) {
      this.recoveryStopChild = null;
      const error = new Error(this.definition.label + ' did not exit after termination signals.');
      error.code = 'JARVIS_PRODUCT_SERVICE_STOP_TIMEOUT';
      throw error;
    }
    if (this.child === child) this.child = null;
    this.owned = false;
    this.recoveryStopChild = null;
  }

  markEndpointUnhealthy(probe) {
    if (this.status !== 'endpoint-unhealthy') {
      this.logger.error(
        '[' + this.definition.id + '] endpoint is reachable but unhealthy (HTTP '
        + (probe.statusCode ?? 'unknown') + '); duplicate startup is blocked.'
      );
    }
    this.status = 'endpoint-unhealthy';
  }

  async stop() {
    this.stopping = true;
    this.status = 'stopping';
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    const child = this.child;
    if (!this.owned || !child || child.exitCode !== null) {
      this.status = this.owned ? 'stopped' : 'reused';
      return;
    }
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(4_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    this.owned = false;
    this.status = 'stopped';
  }

  snapshot() {
    return {
      id: this.definition.id,
      label: this.definition.label,
      endpoint: this.definition.endpoint,
      status: this.status,
      owned: this.owned,
      restartCount: this.restartCount,
      restartBudgetUsed: this.restartAttempts.length,
      nextRecoveryAt: this.nextRecoveryAt > 0 ? new Date(this.nextRecoveryAt).toISOString() : null
    };
  }
}

export async function terminateWindowsProcessTree(child, {
  timeoutMs = 4_000,
  spawnImpl = spawn,
  platform = process.platform,
  processAlive = defaultProcessAlive
} = {}) {
  const pid = Number(child?.pid);
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    const killer = spawnImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    });
    const completed = await Promise.race([
      once(killer, 'exit').then(([code]) => code === 0).catch(() => false),
      delay(timeoutMs).then(() => false)
    ]);
    if (!completed) return false;
    return child.exitCode !== null || !processAlive(pid);
  } catch {
    return false;
  }
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function probeEndpoint(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 1_500,
  expectedIdentity = null
} = {}) {
  return (await probeEndpointStatus(url, { fetchImpl, timeoutMs, expectedIdentity })).healthy;
}

export async function probeEndpointStatus(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 1_500,
  expectedIdentity = null
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { healthy: false, reachable: false, identityVerified: false, identityMismatch: false, payload: null, statusCode: null, failureReason: 'fetch-unavailable' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) {
      return { healthy: false, reachable: true, identityVerified: false, identityMismatch: false, payload: null, statusCode: response.status ?? null, failureReason: 'http-error' };
    }
    const identityEntries = Object.entries(expectedIdentity ?? {});
    if (identityEntries.length === 0) {
      return { healthy: true, reachable: true, identityVerified: false, identityMismatch: false, payload: null, statusCode: response.status ?? 200 };
    }
    if (typeof response.json !== 'function') {
      return { healthy: false, reachable: true, identityVerified: false, identityMismatch: true, payload: null, statusCode: response.status ?? 200, failureReason: 'identity-response-unreadable' };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { healthy: false, reachable: true, identityVerified: false, identityMismatch: true, payload: null, statusCode: response.status ?? 200, failureReason: 'identity-response-unreadable' };
    }
    const identityVerified = payload !== null
      && typeof payload === 'object'
      && identityEntries.every(([key, value]) => payload[key] === value);
    return {
      healthy: identityVerified,
      reachable: true,
      identityVerified,
      identityMismatch: !identityVerified,
      failureReason: identityVerified ? null : 'identity-mismatch',
      mismatchedIdentityFields: identityEntries.filter(([key, value]) => payload === null
        || typeof payload !== 'object' || payload[key] !== value).map(([key]) => key),
      payload,
      statusCode: response.status ?? 200
    };
  } catch {
    return { healthy: false, reachable: false, identityVerified: false, identityMismatch: false, payload: null, statusCode: null,
      failureReason: controller.signal.aborted ? 'probe-timeout' : 'network-error' };
  } finally {
    clearTimeout(timeout);
  }
}

function serviceIdentityMismatchError(definition, probe) {
  const error = new Error(
    definition.label + ' endpoint is already occupied by a process with a different product identity.'
  );
  error.code = 'JARVIS_PRODUCT_SERVICE_IDENTITY_MISMATCH';
  error.serviceId = definition.id;
  error.statusCode = probe.statusCode;
  return error;
}

function serviceEndpointOccupiedError(definition, probe) {
  const error = new Error(
    definition.label + ' endpoint is reachable but did not report a healthy product identity.'
  );
  error.code = 'JARVIS_PRODUCT_SERVICE_ENDPOINT_OCCUPIED';
  error.serviceId = definition.id;
  error.statusCode = probe.statusCode;
  return error;
}

function serviceDefinition(definition) {
  return Object.freeze({
    ...definition,
    args: Object.freeze([...definition.args]),
    healthIdentity: Object.freeze({ ...definition.healthIdentity }),
    environment: Object.freeze({ ...definition.environment }),
    unsetEnvironment: Object.freeze([...(definition.unsetEnvironment ?? [])]),
    sensitiveEnvironmentAllowlist: Object.freeze([...(definition.sensitiveEnvironmentAllowlist ?? [])])
  });
}

export function createServiceEnvironment(definition, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  const sensitiveAllowlist = new Set(definition.sensitiveEnvironmentAllowlist ?? []);
  for (const key of Object.keys(environment)) {
    if (isSensitiveEnvironmentName(key) && !sensitiveAllowlist.has(key)) delete environment[key];
  }
  for (const key of definition.unsetEnvironment ?? []) delete environment[key];
  return { ...environment, ...definition.environment };
}

function isSensitiveEnvironmentName(name) {
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|SESSION|CONNECTION_STRING|DATABASE_URL|DSN)(?:$|_)/i.test(String(name));
}

function numberFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65_535 ? number : fallback;
}

function pipeWithPrefix(stream, prefix, writer) {
  if (!stream?.on) return;
  let buffered = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line) writer(prefix + line);
    }
  });
  stream.on('end', () => {
    if (buffered) writer(prefix + buffered);
  });
}

export function selectProductRuntimeCliServices({definitions,argv=process.argv,env=process.env}={}) {
  const connectionsOnly=argv.includes('--connections-only'),gatewayOnly=argv.includes('--gateway-only');
  if(connectionsOnly&&gatewayOnly)throw Object.assign(new Error('Choose one product runtime scope.'),{code:'JARVIS_PRODUCT_RUNTIME_SCOPE_CONFLICT'});
  if(!Array.isArray(definitions))throw new TypeError('Product service definitions are required.');
  const selected=definitions.filter(definition=>gatewayOnly?definition.id==='bridge':!connectionsOnly||['core','pc-agent','ui'].includes(definition.id));
  if(!selected.length)throw Object.assign(new Error('The requested runtime scope has no services.'),{code:'JARVIS_PRODUCT_RUNTIME_SCOPE_EMPTY'});
  // The gateway is a stateless proxy, never another execution Core. Keep its
  // supervisor lock separate so repairing it does not stop a healthy PC/Core.
  const lockPath=defaultProductRuntimeLockPath(env)+(gatewayOnly?'.bridge-gateway':'');
  return {definitions:selected,lockPath,scope:gatewayOnly?'gateway-only':connectionsOnly?'connections-only':'full'};
}

async function runCli() {
  // Connection management does not need to take ownership of an existing mobile bridge.
  const {definitions,lockPath,scope}=selectProductRuntimeCliServices({definitions:productServiceDefinitions()});
  if (process.argv.includes('--status')) {
    const status = await probeProductServices({ definitions });
    console.log(JSON.stringify({...status,scope,fullProductAssessed:scope==='full'}, null, 2));
    process.exitCode = status.status === 'ready' ? 0 : 1;
    return;
  }
  const runtimeLock = acquireProductRuntimeLock({ workspaceRoot: repositoryRoot,lockPath });
  if (!runtimeLock.acquired) {
    const status = await probeProductServices({ definitions });
    if (status.operational) {
      console.log('JARVIS product runtime is already supervised by process ' + runtimeLock.pid + '.');
      console.log(status.uiUrl?'JARVIS Control Center: '+status.uiUrl:'JARVIS gateway: '+definitions[0].endpoint);
      return;
    }
    const error = new Error('Another JARVIS product supervisor is active, but the product is not healthy.');
    error.code = 'JARVIS_PRODUCT_RUNTIME_ALREADY_ACTIVE';
    throw error;
  }
  let runtime;
  try {
    runtime = await startConnectedProductRuntime({ definitions,
      ...(process.argv.includes('--connections-only') ? { startupTimeoutMs: 60_000 } : {}) });
  } catch (error) {
    runtimeLock.release();
    throw error;
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.stop();
    runtimeLock.release();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', () => runtimeLock.release());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error('JARVIS product runtime failed: ' + error.message);
    process.exit(1);
  });
}
