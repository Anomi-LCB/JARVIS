import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCoreServiceRuntime } from './core-service-runtime.mjs';
import { ModuleId, TaskStatus } from '../packages/shared/src/types.js';

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function getJson(url, token = null) {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  return { statusCode: response.status, body: await response.json() };
}

async function postJson(url, body = {}, token = null) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { statusCode: response.status, body: await response.json() };
}

async function maybeReadText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function addCheck(checks, id, pass, detail = {}) {
  const check = { id, status: pass ? 'pass' : 'fail', detail };
  checks.push(check);
  return check;
}

export async function runCoreServiceSmoke({
  reportPath = 'dist/core-service-smoke-report.json',
  smokeRoot = null,
  host = '127.0.0.1',
  port = null,
  adminToken = 'local-core-service-smoke-admin',
  command = '파일 목록 보여줘',
  clock
} = {}) {
  const root = smokeRoot ? resolve(smokeRoot) : await mkdtemp(join(tmpdir(), 'jarvis-core-service-smoke-'));
  const workspaceRoot = join(root, 'workspace');
  const auditRoot = join(root, 'logs');
  const runtimeRoot = join(root, 'runtime');
  const eventLogPath = join(auditRoot, 'core-events.jsonl');
  const workerLeaseStorePath = join(runtimeRoot, 'core-worker-leases.json');
  const workerQueueStorePath = join(runtimeRoot, 'core-worker-queue.json');
  const visibleFixturePath = join(workspaceRoot, 'core-service-visible-note.txt');

  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(auditRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(visibleFixturePath, 'core service smoke fixture\n', 'utf8');

  const serviceEnv = {
    ...process.env,
    PORT: String(port ?? 0),
    JARVIS_CORE_HOST: host,
    JARVIS_CORE_ADMIN_TOKEN: adminToken,
    JARVIS_CORE_ALLOWED_ROOTS: workspaceRoot,
    JARVIS_CORE_AUDIT_ROOT: auditRoot,
    JARVIS_CORE_EVENT_LOG: eventLogPath,
    JARVIS_CORE_ORCHESTRATION_JOURNAL: join(auditRoot, 'core-orchestration.jsonl'),
    JARVIS_CORE_WORKER_LEASE_STORE: workerLeaseStorePath,
    JARVIS_CORE_WORKER_QUEUE_STORE: workerQueueStorePath,
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: 'false',
    JARVIS_CORE_WORKER_DAEMON_INTERVAL_MS: '50',
    JARVIS_CORE_WORKER_DAEMON_DRAIN_LIMIT: '1'
  };
  const checks = [];
  let service = null;

  try {
    service = await startCoreServiceRuntime({ env: serviceEnv, clock });
    const baseUrl = service.baseUrl;

    const health = await getJson(`${baseUrl}/health`);
    addCheck(checks, 'core-api-listening', health.statusCode === 200 && health.body.module === ModuleId.CORE && health.body.initialized === true, {
      statusCode: health.statusCode,
      module: health.body.module,
      initialized: health.body.initialized
    });

    const openApi = await getJson(`${baseUrl}/openapi.json`);
    addCheck(checks, 'core-openapi-contract-readable', openApi.statusCode === 200 && openApi.body.openapi === '3.1.0' && openApi.body.paths?.['/worker/daemon/tick']?.post, {
      statusCode: openApi.statusCode,
      openapi: openApi.body.openapi,
      hasDaemonTick: Boolean(openApi.body.paths?.['/worker/daemon/tick']?.post)
    });

    const rejectedDiagnostics = await getJson(`${baseUrl}/admin/diagnostics`);
    addCheck(checks, 'admin-auth-rejects-missing-token', rejectedDiagnostics.statusCode === 401 && rejectedDiagnostics.body.error?.code === 'A_ADMIN_TOKEN_REQUIRED', {
      statusCode: rejectedDiagnostics.statusCode,
      code: rejectedDiagnostics.body.error?.code
    });

    const diagnostics = await getJson(`${baseUrl}/admin/diagnostics`, adminToken);
    addCheck(checks, 'admin-diagnostics-authorized', diagnostics.statusCode === 200 && diagnostics.body.adminAuth?.authVersion === 'a-core-admin-auth-v1' && diagnostics.body.workerDaemon?.daemonVersion === 'a-core-worker-daemon-v1', {
      statusCode: diagnostics.statusCode,
      authVersion: diagnostics.body.adminAuth?.authVersion,
      daemonVersion: diagnostics.body.workerDaemon?.daemonVersion,
      taskCount: diagnostics.body.core?.taskCount
    });

    const servicePlan = await postJson(`${baseUrl}/runtime/service-plan`, {
      action: 'install',
      osPlatform: 'win32',
      isAdministrator: true,
      logs: {
        adminTokenHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        workerLeaseStorePath,
        workerQueueStorePath,
        eventLogPath
      }
    }, adminToken);
    addCheck(checks, 'service-lifecycle-plan-api', servicePlan.statusCode === 200 && servicePlan.body.reportVersion === 'a-core-service-lifecycle-report-v1' && servicePlan.body.plan?.planVersion === 'a-core-service-lifecycle-plan-v1', {
      statusCode: servicePlan.statusCode,
      reportVersion: servicePlan.body.reportVersion,
      readiness: servicePlan.body.readiness?.status,
      commandCount: servicePlan.body.plan?.commands?.length ?? 0
    });

    const created = await postJson(`${baseUrl}/tasks`, { rawText: command });
    addCheck(checks, 'task-created-for-worker-queue', created.statusCode === 201 && created.body.status === TaskStatus.WAITING_APPROVAL && created.body.taskId, {
      statusCode: created.statusCode,
      taskId: created.body.taskId,
      status: created.body.status,
      toolName: created.body.plan?.action?.toolName
    });

    const queued = await postJson(`${baseUrl}/tasks/${created.body.taskId}/queue`, {
      options: {
        userConfirmation: { confirmed: true },
        baseBackoffMs: 0,
        timeoutMs: 10_000
      }
    });
    addCheck(checks, 'worker-queue-accepts-task', queued.statusCode === 202 && queued.body.status === 'queued', {
      statusCode: queued.statusCode,
      queueId: queued.body.queueId,
      status: queued.body.status
    });

    const queueBefore = await getJson(`${baseUrl}/worker/queue`);
    addCheck(checks, 'worker-queue-persistence-visible', queueBefore.statusCode === 200 && queueBefore.body.persistence?.enabled === true && queueBefore.body.leases?.persistence?.enabled === true, {
      statusCode: queueBefore.statusCode,
      total: queueBefore.body.total,
      queueStoreVersion: queueBefore.body.persistence?.storeVersion,
      leaseStoreVersion: queueBefore.body.leases?.persistence?.storeVersion
    });

    const rejectedDaemonTick = await postJson(`${baseUrl}/worker/daemon/tick`, { reason: 'core-service-smoke-rejected', drainLimit: 1 });
    addCheck(checks, 'daemon-control-requires-admin-token', rejectedDaemonTick.statusCode === 401 && rejectedDaemonTick.body.error?.code === 'A_ADMIN_TOKEN_REQUIRED', {
      statusCode: rejectedDaemonTick.statusCode,
      code: rejectedDaemonTick.body.error?.code
    });

    const daemonTick = await postJson(`${baseUrl}/worker/daemon/tick`, {
      reason: 'core-service-smoke',
      drainLimit: 1,
      recoverLeases: true
    }, adminToken);
    addCheck(checks, 'daemon-tick-drains-queued-task', daemonTick.statusCode === 200 && daemonTick.body.success === true && daemonTick.body.drain?.processed === 1 && daemonTick.body.drain?.results?.[0]?.item?.status === 'succeeded', {
      statusCode: daemonTick.statusCode,
      processed: daemonTick.body.drain?.processed,
      itemStatus: daemonTick.body.drain?.results?.[0]?.item?.status,
      watchdogStatus: daemonTick.body.watchdog?.status
    });

    const taskDetail = await getJson(`${baseUrl}/tasks/${created.body.taskId}`);
    addCheck(checks, 'task-completes-through-a-e-b-g-f-loop', taskDetail.statusCode === 200 && taskDetail.body.status === TaskStatus.COMPLETED && taskDetail.body.executionVerification?.status === 'passed' && taskDetail.body.learningResult?.ingest?.success === true, {
      statusCode: taskDetail.statusCode,
      taskId: taskDetail.body.taskId,
      status: taskDetail.body.status,
      executionVerification: taskDetail.body.executionVerification?.status,
      learningStored: taskDetail.body.learningResult?.ingest?.success
    });

    const eventLogText = await maybeReadText(eventLogPath);
    const queueStoreText = await maybeReadText(workerQueueStorePath);
    const leaseStoreText = await maybeReadText(workerLeaseStorePath);
    addCheck(checks, 'durable-runtime-artifacts-written', Boolean(eventLogText?.includes('core.worker.daemon.tick.succeeded')) && Boolean(queueStoreText?.includes('a-worker-queue-store-v1')) && Boolean(leaseStoreText?.includes('a-worker-lease-store-v1')), {
      eventLogPath,
      workerQueueStorePath,
      workerLeaseStorePath,
      eventLogHasDaemonTick: Boolean(eventLogText?.includes('core.worker.daemon.tick.succeeded')),
      queueStoreWritten: Boolean(queueStoreText),
      leaseStoreWritten: Boolean(leaseStoreText)
    });

    const failed = checks.filter((check) => check.status === 'fail');
    const report = {
      reportVersion: 'a-core-service-smoke-report-v1',
      status: failed.length ? 'failed' : 'passed',
      generatedAt: new Date().toISOString(),
      mode: 'user-process-core-service-smoke',
      serviceInstalled: false,
      host,
      port: service.port,
      baseUrl,
      command,
      serviceRuntime: {
        runtimeVersion: service.options.serviceRuntimeVersion,
        daemonAutostart: service.options.workerDaemonAutostart,
        daemonStart: service.daemonStart.status,
        entryMode: 'scripts/core-service-runtime.mjs'
      },
      task: {
        taskId: created.body.taskId,
        queueId: queued.body.queueId,
        status: taskDetail.body.status,
        executionVerification: taskDetail.body.executionVerification?.status,
        learningStored: taskDetail.body.learningResult?.ingest?.success === true
      },
      artifacts: {
        reportPath: resolve(reportPath),
        smokeRoot: root,
        workspaceRoot,
        auditRoot,
        visibleFixturePath,
        eventLogPath,
        workerLeaseStorePath,
        workerQueueStorePath
      },
      checks,
      health: health.body,
      diagnostics: {
        adminAuth: diagnostics.body.adminAuth,
        workerDaemon: diagnostics.body.workerDaemon,
        supervisor: diagnostics.body.supervisor
      },
      servicePlan: servicePlan.body,
      queueBefore: queueBefore.body,
      daemonTick: daemonTick.body,
      taskDetail: taskDetail.body
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    service?.workerDaemon?.stop?.({ reason: 'core-service-smoke-finished' });
    if (service?.server) await closeServer(service.server);
  }
}

function parseCliArgs(args) {
  const readFlag = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const portValue = readFlag('--port');
  return {
    reportPath: readFlag('--output') ?? readFlag('--report') ?? 'dist/core-service-smoke-report.json',
    smokeRoot: readFlag('--smoke-root'),
    host: readFlag('--host') ?? '127.0.0.1',
    port: portValue ? Number(portValue) : null,
    adminToken: readFlag('--admin-token') ?? 'local-core-service-smoke-admin',
    command: readFlag('--command') ?? '파일 목록 보여줘'
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runCoreServiceSmoke(parseCliArgs(process.argv.slice(2)));
  console.log(`# Core service smoke: ${report.status}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Base URL: ${report.baseUrl}`);
  console.log(`Task: ${report.task.taskId} -> ${report.task.status}`);
  console.log(`Report: ${report.artifacts.reportPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
