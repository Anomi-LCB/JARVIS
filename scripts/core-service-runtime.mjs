import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';

function envBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function envList(value, fallback = []) {
  if (!value) return fallback;
  return String(value).split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

async function listen(server, { host, port }) {
  return await new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export function coreServiceRuntimeOptionsFromEnv({ env = process.env, cwd = process.cwd() } = {}) {
  const root = resolve(env.JARVIS_CORE_ROOT ?? cwd);
  const host = env.JARVIS_CORE_HOST ?? '127.0.0.1';
  const port = envNumber(env.PORT ?? env.JARVIS_CORE_PORT, 4071);
  const adminTokenHash = envSha256(env.JARVIS_CORE_ADMIN_TOKEN_SHA256);
  const auditRoot = resolve(root, env.JARVIS_CORE_AUDIT_ROOT ?? env.JARVIS_AUDIT_ROOT ?? 'logs');
  const allowedRoots = envList(env.JARVIS_CORE_ALLOWED_ROOTS ?? env.JARVIS_ALLOWED_ROOTS, [resolve(root, 'workspace')])
    .map((item) => resolve(root, item));
  const coreEventLogPath = resolve(root, env.JARVIS_CORE_EVENT_LOG ?? `${auditRoot}/core-events.jsonl`);
  const coreOrchestrationJournalPath = resolve(root, env.JARVIS_CORE_ORCHESTRATION_JOURNAL ?? `${auditRoot}/core-orchestration.jsonl`);
  const workerLeaseStorePath = resolve(root, env.JARVIS_CORE_WORKER_LEASE_STORE ?? `${auditRoot}/core-worker-leases.json`);
  const workerQueueStorePath = resolve(root, env.JARVIS_CORE_WORKER_QUEUE_STORE ?? `${auditRoot}/core-worker-queue.json`);
  return {
    serviceRuntimeVersion: 'a-core-service-runtime-entry-v1',
    root,
    host,
    port,
    endpoint: `http://${host}:${port}`,
    adminToken: env.JARVIS_CORE_ADMIN_TOKEN ?? (adminTokenHash ? null : 'local-core-admin'),
    adminTokenHash,
    allowedRoots,
    auditRoot,
    coreEventLogPath,
    coreOrchestrationJournalPath,
    workerLeaseStorePath,
    workerQueueStorePath,
    workerDaemonEnabled: envBoolean(env.JARVIS_CORE_WORKER_DAEMON_ENABLED, true),
    workerDaemonAutostart: envBoolean(env.JARVIS_CORE_WORKER_DAEMON_AUTOSTART, true),
    workerDaemonIntervalMs: envNumber(env.JARVIS_CORE_WORKER_DAEMON_INTERVAL_MS, 1_000),
    workerDaemonDrainLimit: envNumber(env.JARVIS_CORE_WORKER_DAEMON_DRAIN_LIMIT, 5),
    workerDaemonMaxConsecutiveFailures: envNumber(env.JARVIS_CORE_WORKER_DAEMON_MAX_FAILURES, 3)
  };
}

function envSha256(value) {
  const normalized = String(value ?? '').replace(/^sha256:/, '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export async function createConfiguredCoreServiceRuntime({ env = process.env, clock } = {}) {
  const options = coreServiceRuntimeOptionsFromEnv({ env });
  await mkdir(options.auditRoot, { recursive: true });
  await mkdir(dirname(options.coreEventLogPath), { recursive: true });
  await mkdir(dirname(options.coreOrchestrationJournalPath), { recursive: true });
  await mkdir(dirname(options.workerLeaseStorePath), { recursive: true });
  await mkdir(dirname(options.workerQueueStorePath), { recursive: true });
  for (const root of options.allowedRoots) {
    await mkdir(root, { recursive: true });
  }
  const runtime = createAgRuntime({
    allowedRoots: options.allowedRoots,
    auditRoot: options.auditRoot,
    cwd: () => options.allowedRoots[0],
    coreEventLogPath: options.coreEventLogPath,
    coreOrchestrationJournalPath: options.coreOrchestrationJournalPath,
    workerLeaseStorePath: options.workerLeaseStorePath,
    workerQueueStorePath: options.workerQueueStorePath,
    workerDaemonEnabled: options.workerDaemonEnabled,
    workerDaemonIntervalMs: options.workerDaemonIntervalMs,
    workerDaemonDrainLimit: options.workerDaemonDrainLimit,
    workerDaemonMaxConsecutiveFailures: options.workerDaemonMaxConsecutiveFailures,
    clock
  });
  const server = createCoreServer(runtime.coreFacade, {
    adminToken: options.adminToken,
    adminTokenHash: options.adminTokenHash,
    orchestrationWorker: runtime.orchestrationWorker,
    workerDaemon: runtime.workerDaemon
  });
  return { ...runtime, server, options };
}

export async function startCoreServiceRuntime({ env = process.env, clock } = {}) {
  const runtime = await createConfiguredCoreServiceRuntime({ env, clock });
  const address = await listen(runtime.server, {
    host: runtime.options.host,
    port: runtime.options.port
  });
  const actualPort = address.port;
  const baseUrl = `http://${runtime.options.host}:${actualPort}`;
  const daemonStart = runtime.options.workerDaemonAutostart
    ? runtime.workerDaemon.start({ reason: 'core-service-runtime-start' })
    : { success: true, status: 'autostart-disabled', daemon: runtime.workerDaemon.status() };
  console.log(`JARVIS-A Core service runtime listening at ${baseUrl}`);
  console.log(`JARVIS-A worker daemon: ${daemonStart.status}`);
  return {
    ...runtime,
    host: runtime.options.host,
    port: actualPort,
    baseUrl,
    daemonStart
  };
}

function shutdownRuntime(runtime) {
  runtime.workerDaemon?.stop?.({ reason: 'core-service-runtime-shutdown' });
  runtime.server.close(() => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCoreServiceRuntime().then((runtime) => {
    process.once('SIGINT', () => shutdownRuntime(runtime));
    process.once('SIGTERM', () => shutdownRuntime(runtime));
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
