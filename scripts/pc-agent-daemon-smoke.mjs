import net from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPcAgentServiceRuntime } from '../apps/pc-agent/src/main.mjs';

async function findOpenPort(host = '127.0.0.1') {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function getJson(url, token = null) {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  return {
    statusCode: response.status,
    body: await response.json()
  };
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
  return {
    statusCode: response.status,
    body: await response.json()
  };
}

export async function runPcAgentDaemonSmoke({
  reportPath = 'dist/pc-agent-daemon-smoke-report.json',
  host = '127.0.0.1',
  port = null,
  apiToken = 'local-pc-agent-api'
} = {}) {
  const smokeRoot = await mkdtemp(join(tmpdir(), 'jarvis-pc-daemon-smoke-'));
  const selectedPort = port ?? await findOpenPort(host);
  const env = {
    ...process.env,
    PORT: String(selectedPort),
    JARVIS_LOCAL_ONLY: 'true',
    JARVIS_SERVICE_DAEMON: 'true',
    JARVIS_QUEUE_DRAIN_ENABLED: 'true',
    JARVIS_AUDIT_ROOT: join(smokeRoot, 'logs'),
    JARVIS_UNDO_JOURNAL: join(smokeRoot, 'logs', 'undo-journal.jsonl'),
    JARVIS_ROLLBACK_TRANSACTIONS: join(smokeRoot, 'logs', 'rollback-transactions.jsonl'),
    JARVIS_PACKET_JOURNAL: join(smokeRoot, 'logs', 'packet-journal.jsonl'),
    JARVIS_PACKET_QUEUE: join(smokeRoot, 'logs', 'packet-queue.jsonl'),
    JARVIS_TOKEN_VAULT: join(smokeRoot, 'logs', 'capability-vault.jsonl'),
    JARVIS_ALLOWED_ROOTS: join(smokeRoot, 'workspace')
  };
  await mkdir(env.JARVIS_ALLOWED_ROOTS, { recursive: true });

  let runtime = null;
  const checks = [];
  const add = (id, pass, detail = {}) => {
    checks.push({ id, status: pass ? 'pass' : 'fail', detail });
  };

  try {
    runtime = await startPcAgentServiceRuntime({ env });
    const baseUrl = `http://${host}:${selectedPort}`;
    const health = await getJson(`${baseUrl}/health`);
    const serviceRuntime = await getJson(`${baseUrl}/service/runtime`);
    const queue = await getJson(`${baseUrl}/execution-packets/queue`, apiToken);
    const drain = await postJson(`${baseUrl}/execution-packets/queue/drain`, { limit: 1 }, apiToken);
    const tray = await getJson(`${baseUrl}/tray/state`);
    const openApi = await getJson(`${baseUrl}/openapi.json`);
    const evidenceQuery = await getJson(`${baseUrl}/evidence/query?limit=1`, apiToken);
    const evidenceSchema = await getJson(`${baseUrl}/evidence/schema-snapshot`, apiToken);
    const evidencePrivacy = await getJson(`${baseUrl}/evidence/privacy-fixtures`, apiToken);
    const evidenceRetention = await getJson(`${baseUrl}/evidence/retention?keepLast=100`, apiToken);
    const evidenceProductGate = await postJson(`${baseUrl}/evidence/product-gate`, { keepLast: 100 }, apiToken);

    add('daemon-listening', health.statusCode === 200 && health.body.status === 'ok', {
      statusCode: health.statusCode,
      module: health.body.module,
      localOnly: health.body.localOnly
    });
    add('queue-drain-supervisor-running', serviceRuntime.body.status === 'running' && serviceRuntime.body.watchdog?.status === 'healthy', {
      status: serviceRuntime.body.status,
      watchdog: serviceRuntime.body.watchdog?.status,
      intervalMs: serviceRuntime.body.intervalMs
    });
    add('execution-queue-readable', queue.statusCode === 200 && typeof queue.body.queued === 'number', {
      statusCode: queue.statusCode,
      queued: queue.body.queued
    });
    add('manual-drain-call-safe', drain.statusCode === 200 && drain.body.processed === 0, {
      statusCode: drain.statusCode,
      processed: drain.body.processed,
      status: drain.body.status
    });
    add('tray-state-readable', tray.statusCode === 200 && tray.body.appId === 'jarvis-pc-agent-tray', {
      statusCode: tray.statusCode,
      appId: tray.body.appId,
      menuCount: tray.body.menu?.length ?? 0
    });
    add('openapi-readable', openApi.statusCode === 200 && openApi.body.openapi === '3.1.0', {
      statusCode: openApi.statusCode,
      openapi: openApi.body.openapi
    });
    add('evidence-query-ready', evidenceQuery.statusCode === 200 && evidenceQuery.body.queryVersion === 'b-execution-evidence-query-v1', {
      statusCode: evidenceQuery.statusCode,
      total: evidenceQuery.body.pageInfo?.total
    });
    add('evidence-schema-snapshot-ready', evidenceSchema.statusCode === 200 && evidenceSchema.body.snapshotVersion === 'b-execution-evidence-schema-snapshot-v1', {
      statusCode: evidenceSchema.statusCode,
      schemaCount: evidenceSchema.body.schemaCount
    });
    add('evidence-privacy-fixtures-pass', evidencePrivacy.statusCode === 200 && evidencePrivacy.body.status === 'passed', {
      statusCode: evidencePrivacy.statusCode,
      caseCount: evidencePrivacy.body.caseCount
    });
    add('evidence-retention-ready', evidenceRetention.statusCode === 200 && evidenceRetention.body.reportVersion === 'b-execution-evidence-retention-report-v1', {
      statusCode: evidenceRetention.statusCode,
      removableCount: evidenceRetention.body.removableCount
    });
    add('evidence-product-gate-passed', evidenceProductGate.statusCode === 200 && evidenceProductGate.body.productGateVersion === 'b-execution-evidence-product-gate-v1' && evidenceProductGate.body.status === 'passed', {
      statusCode: evidenceProductGate.statusCode,
      evidenceCount: evidenceProductGate.body.evidenceCount,
      status: evidenceProductGate.body.status
    });

    const failed = checks.filter((check) => check.status === 'fail');
    const report = {
      reportId: 'b-pc-agent-daemon-smoke-v1',
      status: failed.length ? 'failed' : 'passed',
      generatedAt: new Date().toISOString(),
      mode: 'user-process-daemon-smoke',
      serviceInstalled: false,
      host,
      port: selectedPort,
      baseUrl,
      smokeRoot,
      checks,
      health: health.body,
      serviceRuntime: serviceRuntime.body,
      queue: queue.body,
      drain: drain.body,
      tray: tray.body,
      evidence: {
        query: evidenceQuery.body,
        schema: evidenceSchema.body,
        privacy: evidencePrivacy.body,
        retention: evidenceRetention.body,
        productGate: evidenceProductGate.body
      }
    };
    await mkdir(dirname(resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    if (runtime) {
      runtime.serviceSupervisor.stop();
      await new Promise((resolveClose) => runtime.server.close(resolveClose));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf('--output');
  const reportPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : 'dist/pc-agent-daemon-smoke-report.json';
  const report = await runPcAgentDaemonSmoke({ reportPath });
  console.log(`# PC Agent daemon smoke: ${report.status}`);
  console.log(`Report: ${resolve(reportPath)}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
