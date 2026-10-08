import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { VerificationReportStore } from '../apps/verification/src/reports/report-store.js';
import { TaskStateMachine } from '../packages/core/src/runtime/state-machine.js';
import { FileWorkerQueueStore } from '../packages/core/src/runtime/worker-queue-store.js';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';
import { routeParams, sendJson } from '../packages/shared/src/http.js';
import { TaskStatus } from '../packages/shared/src/types.js';

const probes = [];

await runProbe('TASK_RETRY_TRANSITION_ATOMIC', async () => {
  const machine = new TaskStateMachine(TaskStatus.CREATED, { maxRetries: 2 });
  let error = null;
  try { machine.retry(); } catch (caught) { error = caught; }
  return {
    passed: Boolean(error) && machine.retryCount === 0 && machine.status === TaskStatus.CREATED,
    observed: { error: error?.message ?? null, retryCount: machine.retryCount, status: machine.status }
  };
});

await runProbe('TASK_RETRY_BUDGET_VALIDATED', async () => {
  let error = null;
  try { new TaskStateMachine(TaskStatus.CREATED, { maxRetries: -1 }); } catch (caught) { error = caught; }
  return {
    passed: error instanceof RangeError && error.code === 'A_TASK_RETRY_BUDGET_INVALID',
    observed: { errorName: error?.name ?? null, errorCode: error?.code ?? null }
  };
});

await runProbe('QUEUE_RESERVED_METADATA_OWNED', async () => withTempRoot('queue-metadata', async (root) => {
  const store = new FileWorkerQueueStore({ filePath: join(root, 'queue.json'), clock: () => new Date('2035-01-02T03:04:05.000Z') });
  let loaded = null;
  let error = null;
  try {
    store.save({ storeVersion: 'overridden', persistedAt: '1900-01-01T00:00:00.000Z', queue: [], runs: [] });
    loaded = store.load();
  } catch (caught) { error = caught; }
  return {
    passed: loaded?.storeVersion === 'a-worker-queue-store-v1' && loaded?.persistedAt === '2035-01-02T03:04:05.000Z',
    observed: { storeVersion: loaded?.storeVersion ?? null, persistedAt: loaded?.persistedAt ?? null, errorCode: error?.code ?? null }
  };
}));

await runProbe('QUEUE_COLLECTION_SHAPE_FAILS_CLOSED', async () => withTempRoot('queue-shape', async (root) => {
  const filePath = join(root, 'queue.json');
  await writeFile(filePath, JSON.stringify({ storeVersion: 'a-worker-queue-store-v1', persistedAt: '2035-01-02T03:04:05.000Z', queue: {}, runs: [] }), 'utf8');
  let error = null;
  try { new FileWorkerQueueStore({ filePath }).load(); } catch (caught) { error = caught; }
  return {
    passed: error?.code === 'A_WORKER_QUEUE_STORE_CORRUPT',
    observed: { errorCode: error?.code ?? null, errorMessage: error?.message ?? null }
  };
}));

await runProbe('REPORT_ID_PATH_CONFINED', async () => withTempRoot('report-path', async (root) => {
  const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
  let error = null;
  try { store.save(reportFixture('../escaped')); } catch (caught) { error = caught; }
  const escapedExists = existsSync(join(root, 'escaped.json')) || existsSync(join(root, 'escaped.html'));
  const readValue = store.read('../escaped');
  return {
    passed: error?.code === 'G_REPORT_ID_INVALID' && !escapedExists && readValue === null,
    observed: { errorCode: error?.code ?? null, escapedExists, readReturnedValue: readValue !== null }
  };
}));

await runProbe('REPORT_RESERVED_ID_PROTECTED', async () => withTempRoot('report-reserved', async (root) => {
  const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
  const failures = [];
  for (const id of ['report-index', 'report-worm-manifest', '.', '..', '']) {
    try { store.save(reportFixture(id)); failures.push({ id, blocked: false }); }
    catch (error) { failures.push({ id, blocked: error?.code === 'G_REPORT_ID_INVALID', errorCode: error?.code ?? null }); }
  }
  return { passed: failures.every((item) => item.blocked), observed: failures };
}));

await runProbe('REPORT_SECRET_REDACTION_COMPLETE', async () => withTempRoot('report-redaction', async (root) => {
  const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
  const values = ['token-value-123', 'header.secret.value', 'api-key-value', 'free.form.secret'];
  const sanitized = store.sanitize({
    token: values[0],
    nested: { authorization: `Bearer ${values[1]}`, apiKey: values[2], note: `Authorization: Bearer ${values[3]}` }
  });
  const serialized = JSON.stringify(sanitized);
  return {
    passed: values.every((value) => !serialized.includes(value)) && sanitized.token === '[masked]' && sanitized.nested.authorization === '[masked]',
    observed: { leakedValueCount: values.filter((value) => serialized.includes(value)).length, sanitized }
  };
}));

await runProbe('JSON_RESPONSE_HEADERS_NON_WEAKENABLE', async () => {
  let observed = null;
  const response = { writeHead(statusCode, headers) { observed = { statusCode, headers }; }, end() {} };
  sendJson(response, 200, { ok: true }, {
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'off',
    'content-type': 'text/html',
    'x-apex-probe': 'preserved'
  });
  return {
    passed: observed?.headers?.['cache-control'] === 'no-store'
      && observed?.headers?.['x-content-type-options'] === 'nosniff'
      && observed?.headers?.['content-type'] === 'application/json; charset=utf-8'
      && observed?.headers?.['x-apex-probe'] === 'preserved',
    observed
  };
});

await runProbe('ROUTE_PARAM_ENCODED_SEPARATOR_REJECTED', async () => {
  const slash = routeParams('/reports/:reportId', '/reports/..%2foutside');
  const backslash = routeParams('/reports/:reportId', '/reports/a%5cb');
  const valid = routeParams('/reports/:reportId', '/reports/ver_report_1');
  return {
    passed: slash === null && backslash === null && valid?.reportId === 'ver_report_1',
    observed: { slash, backslash, valid }
  };
});

await runProbe('BULK_FILE_COMMAND_ROUTES_AS_MISSION', async () => {
  const classification = classifyCommandLane('폴더의 10000개 파일을 읽어 SHA-256을 계산하고 중복을 제거한 뒤 ZIP으로 압축하고 manifest를 재검증해');
  return {
    passed: classification.lane === 'mission'
      && classification.stageIds.includes('bulk-file')
      && classification.reasonCodes.includes('bulk-file-workflow'),
    observed: classification
  };
});

const report = {
  probeVersion: 'jarvis-apex-product-resilience-probe-v1',
  generatedAt: new Date().toISOString(),
  total: probes.length,
  passed: probes.filter((item) => item.passed).length,
  failed: probes.filter((item) => !item.passed).length,
  probes
};
report.reportSha256 = sha256Json({ ...report, generatedAt: undefined, reportSha256: undefined });

const outputIndex = process.argv.indexOf('--output');
const outputPath = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : join('artifacts', 'apex-workflow-50-audit', 'product-probe.json'));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, total: report.total, passed: report.passed, failed: report.failed, reportSha256: report.reportSha256 }));
if (report.failed > 0) process.exitCode = 1;

async function runProbe(id, callback) {
  try {
    const result = await callback();
    probes.push({ id, passed: result?.passed === true, observed: result?.observed ?? null });
  } catch (error) {
    probes.push({ id, passed: false, observed: { unexpectedError: normalizeError(error) } });
  }
}

async function withTempRoot(label, callback) {
  const root = await mkdtemp(join(tmpdir(), `jarvis-apex-${label}-`));
  try { return await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function reportFixture(verificationId) {
  return { verificationId, taskId: 'apex-probe', status: 'passed', score: 100, createdAt: '2035-01-02T03:04:05.000Z', checks: [], evidence: {} };
}

function normalizeError(error) {
  return { name: error?.name ?? 'Error', code: error?.code ?? null, message: error?.message ?? String(error) };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function sha256Json(value) {
  return createHash('sha256').update(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8')).digest('hex');
}
