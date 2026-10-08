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

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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

function countOccurrences(text, needle) {
  if (!text) return 0;
  return text.split(needle).length - 1;
}

export async function runCoreServiceSoak({
  reportPath = 'dist/core-service-soak-report.json',
  soakRoot = null,
  host = '127.0.0.1',
  port = null,
  adminToken = 'local-core-service-soak-admin',
  command = '파일 목록 보여줘',
  taskCount = 4,
  intervalMs = 25,
  drainLimit = 1,
  durationMs = 250,
  timeoutMs = 10_000,
  clock
} = {}) {
  const root = soakRoot ? resolve(soakRoot) : await mkdtemp(join(tmpdir(), 'jarvis-core-service-soak-'));
  const workspaceRoot = join(root, 'workspace');
  const auditRoot = join(root, 'logs');
  const runtimeRoot = join(root, 'runtime');
  const eventLogPath = join(auditRoot, 'core-events.jsonl');
  const workerLeaseStorePath = join(runtimeRoot, 'core-worker-leases.json');
  const workerQueueStorePath = join(runtimeRoot, 'core-worker-queue.json');
  const visibleFixturePath = join(workspaceRoot, 'core-service-soak-visible-note.txt');

  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(auditRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(visibleFixturePath, 'core service soak fixture\n', 'utf8');

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
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: 'true',
    JARVIS_CORE_WORKER_DAEMON_INTERVAL_MS: String(intervalMs),
    JARVIS_CORE_WORKER_DAEMON_DRAIN_LIMIT: String(drainLimit)
  };
  const checks = [];
  const taskRecords = [];
  const watchdogSamples = [];
  const queueSamples = [];
  let stopResult = null;
  let service = null;

  try {
    service = await startCoreServiceRuntime({ env: serviceEnv, clock });
    const baseUrl = service.baseUrl;

    const health = await getJson(`${baseUrl}/health`);
    addCheck(checks, 'core-api-listening', health.statusCode === 200 && health.body.module === ModuleId.CORE, {
      statusCode: health.statusCode,
      module: health.body.module,
      initialized: health.body.initialized
    });

    for (let index = 0; index < taskCount; index += 1) {
      const created = await postJson(`${baseUrl}/tasks`, { rawText: command });
      const queued = await postJson(`${baseUrl}/tasks/${created.body.taskId}/queue`, {
        options: {
          userConfirmation: { confirmed: true },
          baseBackoffMs: 0,
          timeoutMs
        }
      });
      taskRecords.push({
        index,
        taskId: created.body.taskId,
        queueId: queued.body.queueId,
        createdStatusCode: created.statusCode,
        queuedStatusCode: queued.statusCode,
        initialStatus: created.body.status,
        queuedStatus: queued.body.status
      });
    }
    addCheck(checks, 'tasks-enqueued-for-soak', taskRecords.length === taskCount && taskRecords.every((item) => item.createdStatusCode === 201 && item.queuedStatusCode === 202), {
      taskCount,
      enqueued: taskRecords.length,
      queueIds: taskRecords.map((item) => item.queueId)
    });

    const start = await postJson(`${baseUrl}/worker/daemon/start`, { reason: 'core-service-soak' }, adminToken);
    addCheck(checks, 'daemon-starts-through-admin-api', start.statusCode === 200 && start.body.success === true && ['started', 'already-running'].includes(start.body.status), {
      statusCode: start.statusCode,
      status: start.body.status,
      running: start.body.daemon?.running
    });

    const startedAt = Date.now();
    const perTaskBudgetMs = Math.max(intervalMs * 8, 750);
    const deadline = startedAt + Math.max(durationMs, taskCount * perTaskBudgetMs, 1500);
    let completedCount = 0;
    while (Date.now() <= deadline) {
      const daemon = await getJson(`${baseUrl}/worker/daemon`, adminToken);
      const queue = await getJson(`${baseUrl}/worker/queue`);
      watchdogSamples.push({
        at: new Date().toISOString(),
        statusCode: daemon.statusCode,
        status: daemon.body.status,
        tickCount: daemon.body.tickCount,
        processedTotal: daemon.body.processedTotal,
        watchdogStatus: daemon.body.watchdog?.status,
        consecutiveFailures: daemon.body.consecutiveFailures
      });
      queueSamples.push({
        at: new Date().toISOString(),
        total: queue.body.total,
        counts: queue.body.counts,
        persistence: queue.body.persistence,
        leases: {
          activeLeaseCount: queue.body.leases?.activeLeaseCount,
          recoveredCount: queue.body.leases?.recoveredCount,
          persistence: queue.body.leases?.persistence
        }
      });

      const details = [];
      for (const task of taskRecords) {
        const detail = await getJson(`${baseUrl}/tasks/${task.taskId}`, adminToken);
        details.push(detail.body);
      }
      completedCount = details.filter((task) => task.status === TaskStatus.COMPLETED).length;
      for (const task of taskRecords) {
        const detail = details.find((candidate) => candidate.taskId === task.taskId);
        task.finalStatus = detail?.status;
        task.executionVerification = detail?.executionVerification?.status;
        task.learningStored = detail?.learningResult?.ingest?.success === true;
      }
      if (completedCount === taskCount) break;
      await delay(Math.max(10, Math.min(intervalMs, 50)));
    }

    await delay(Math.max(0, durationMs - (Date.now() - startedAt)));
    const finalDaemon = await getJson(`${baseUrl}/worker/daemon`, adminToken);
    const finalQueue = await getJson(`${baseUrl}/worker/queue`);
    const finalDetails = [];
    for (const task of taskRecords) {
      const detail = await getJson(`${baseUrl}/tasks/${task.taskId}`, adminToken);
      finalDetails.push(detail.body);
    }
    for (const task of taskRecords) {
      const detail = finalDetails.find((candidate) => candidate.taskId === task.taskId);
      task.finalStatus = detail?.status;
      task.executionVerification = detail?.executionVerification?.status;
      task.learningStored = detail?.learningResult?.ingest?.success === true;
    }
    stopResult = await postJson(`${baseUrl}/worker/daemon/stop`, { reason: 'core-service-soak-finished' }, adminToken);

    const completed = taskRecords.filter((item) => item.finalStatus === TaskStatus.COMPLETED);
    const verified = taskRecords.filter((item) => item.executionVerification === 'passed');
    const learned = taskRecords.filter((item) => item.learningStored === true);
    addCheck(checks, 'all-soak-tasks-completed', completed.length === taskCount, {
      taskCount,
      completed: completed.length,
      statuses: taskRecords.map((item) => ({ taskId: item.taskId, status: item.finalStatus }))
    });
    addCheck(checks, 'all-soak-tasks-verified-and-learned', verified.length === taskCount && learned.length === taskCount, {
      verified: verified.length,
      learned: learned.length
    });
    addCheck(checks, 'daemon-watchdog-remains-healthy', watchdogSamples.length > 0 && watchdogSamples.every((sample) => ['running', 'stopped'].includes(sample.status) || sample.watchdogStatus === 'healthy') && finalDaemon.body.consecutiveFailures === 0, {
      sampleCount: watchdogSamples.length,
      finalStatus: finalDaemon.body.status,
      finalWatchdog: finalDaemon.body.watchdog?.status,
      consecutiveFailures: finalDaemon.body.consecutiveFailures
    });
    addCheck(checks, 'daemon-processes-work-across-multiple-ticks', finalDaemon.body.tickCount >= taskCount && finalDaemon.body.processedTotal >= taskCount, {
      tickCount: finalDaemon.body.tickCount,
      processedTotal: finalDaemon.body.processedTotal,
      taskCount
    });
    addCheck(checks, 'persistent-stores-stay-enabled-during-soak', finalQueue.body.persistence?.enabled === true && finalQueue.body.leases?.persistence?.enabled === true, {
      queueStoreVersion: finalQueue.body.persistence?.storeVersion,
      leaseStoreVersion: finalQueue.body.leases?.persistence?.storeVersion,
      total: finalQueue.body.total,
      counts: finalQueue.body.counts
    });
    addCheck(checks, 'daemon-stops-cleanly', stopResult.statusCode === 200 && stopResult.body.success === true && stopResult.body.daemon?.running === false, {
      statusCode: stopResult.statusCode,
      status: stopResult.body.status,
      running: stopResult.body.daemon?.running
    });

    const eventLogText = await maybeReadText(eventLogPath);
    const queueStoreText = await maybeReadText(workerQueueStorePath);
    const leaseStoreText = await maybeReadText(workerLeaseStorePath);
    const watchdogEventCount = countOccurrences(eventLogText, 'core.worker.daemon.watchdog');
    const tickEventCount = countOccurrences(eventLogText, 'core.worker.daemon.tick.succeeded');
    addCheck(checks, 'soak-runtime-artifacts-written', watchdogEventCount >= taskCount && tickEventCount >= taskCount && Boolean(queueStoreText?.includes('a-worker-queue-store-v1')) && Boolean(leaseStoreText?.includes('a-worker-lease-store-v1')), {
      eventLogPath,
      workerQueueStorePath,
      workerLeaseStorePath,
      watchdogEventCount,
      tickEventCount,
      queueStoreWritten: Boolean(queueStoreText),
      leaseStoreWritten: Boolean(leaseStoreText)
    });

    const failed = checks.filter((check) => check.status === 'fail');
    const report = {
      reportVersion: 'a-core-service-soak-report-v1',
      status: failed.length ? 'failed' : 'passed',
      generatedAt: new Date().toISOString(),
      mode: 'user-process-core-service-soak',
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
      taskCount,
      completedCount: completed.length,
      verifiedCount: verified.length,
      learnedCount: learned.length,
      intervalMs,
      drainLimit,
      durationMs,
      daemon: {
        tickCount: finalDaemon.body.tickCount,
        processedTotal: finalDaemon.body.processedTotal,
        recoveredLeaseTotal: finalDaemon.body.recoveredLeaseTotal,
        consecutiveFailures: finalDaemon.body.consecutiveFailures,
        finalStatus: stopResult.body.daemon?.status ?? finalDaemon.body.status,
        finalWatchdogStatus: finalDaemon.body.watchdog?.status
      },
      artifacts: {
        reportPath: resolve(reportPath),
        soakRoot: root,
        workspaceRoot,
        auditRoot,
        visibleFixturePath,
        eventLogPath,
        workerLeaseStorePath,
        workerQueueStorePath
      },
      checks,
      tasks: taskRecords,
      watchdogSamples,
      queueSamples,
      finalQueue: finalQueue.body,
      stopResult: stopResult.body,
      artifactSummary: {
        watchdogEventCount,
        tickEventCount,
        queueStoreWritten: Boolean(queueStoreText),
        leaseStoreWritten: Boolean(leaseStoreText)
      }
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    service?.workerDaemon?.stop?.({ reason: 'core-service-soak-finalizer' });
    if (service?.server) await closeServer(service.server);
  }
}

function parseCliArgs(args) {
  const readFlag = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const numberFlag = (flag, fallback) => {
    const value = readFlag(flag);
    return value === null ? fallback : Number(value);
  };
  const portValue = readFlag('--port');
  return {
    reportPath: readFlag('--output') ?? readFlag('--report') ?? 'dist/core-service-soak-report.json',
    soakRoot: readFlag('--soak-root'),
    host: readFlag('--host') ?? '127.0.0.1',
    port: portValue ? Number(portValue) : null,
    adminToken: readFlag('--admin-token') ?? 'local-core-service-soak-admin',
    command: readFlag('--command') ?? '파일 목록 보여줘',
    taskCount: numberFlag('--task-count', 4),
    intervalMs: numberFlag('--interval-ms', 25),
    drainLimit: numberFlag('--drain-limit', 1),
    durationMs: numberFlag('--duration-ms', 250),
    timeoutMs: numberFlag('--timeout-ms', 10_000)
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runCoreServiceSoak(parseCliArgs(process.argv.slice(2)));
  console.log(`# Core service soak: ${report.status}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Base URL: ${report.baseUrl}`);
  console.log(`Tasks: ${report.completedCount}/${report.taskCount} completed`);
  console.log(`Daemon: ${report.daemon.tickCount} ticks / ${report.daemon.processedTotal} processed`);
  console.log(`Report: ${report.artifacts.reportPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
