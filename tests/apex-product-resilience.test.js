import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskStatus } from '../packages/shared/src/types.js';
import { TaskStateMachine } from '../packages/core/src/runtime/state-machine.js';
import { FileWorkerQueueStore } from '../packages/core/src/runtime/worker-queue-store.js';
import { VerificationReportStore } from '../apps/verification/src/reports/report-store.js';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';
import { routeParams, sendJson } from '../packages/shared/src/http.js';

test('TaskStateMachine invalid retry leaves the retry budget unchanged', () => {
  const machine = new TaskStateMachine(TaskStatus.CREATED, { maxRetries: 2 });
  assert.throws(() => machine.retry(), /Invalid task transition/u);
  assert.equal(machine.retryCount, 0);
  assert.equal(machine.status, TaskStatus.CREATED);
});

test('TaskStateMachine rejects an invalid retry budget at construction', () => {
  assert.throws(
    () => new TaskStateMachine(TaskStatus.CREATED, { maxRetries: -1 }),
    (error) => error instanceof RangeError && error.code === 'A_TASK_RETRY_BUDGET_INVALID'
  );
});

test('FileWorkerQueueStore owns its version and persisted timestamp metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-queue-metadata-'));
  try {
    const filePath = join(root, 'queue.json');
    const store = new FileWorkerQueueStore({ filePath, clock: () => new Date('2035-01-02T03:04:05.000Z') });
    const saved = store.save({
      storeVersion: 'attacker-controlled-version',
      persistedAt: '1900-01-01T00:00:00.000Z',
      queue: [],
      runs: []
    });
    assert.equal(saved.storeVersion, 'a-worker-queue-store-v1');
    assert.equal(saved.persistedAt, '2035-01-02T03:04:05.000Z');
    assert.equal(store.load().storeVersion, 'a-worker-queue-store-v1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileWorkerQueueStore rejects malformed queue and run collections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-queue-shape-'));
  try {
    const filePath = join(root, 'queue.json');
    await writeFile(filePath, JSON.stringify({
      storeVersion: 'a-worker-queue-store-v1',
      persistedAt: '2035-01-02T03:04:05.000Z',
      queue: {},
      runs: []
    }), 'utf8');
    const store = new FileWorkerQueueStore({ filePath });
    assert.throws(
      () => store.load(),
      (error) => error.code === 'A_WORKER_QUEUE_STORE_CORRUPT'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore confines report identifiers to its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-path-'));
  try {
    const reportDir = join(root, 'reports');
    const store = new VerificationReportStore({ reportDir });
    for (const verificationId of ['../escaped', '..\\escaped', 'line\nbreak', 'nul\u0000byte']) {
      assert.throws(
        () => store.save({ verificationId, status: 'passed', score: 100, checks: [], evidence: {} }),
        (error) => error.code === 'G_REPORT_ID_INVALID'
      );
      assert.equal(store.read(verificationId), null);
    }
    assert.equal(existsSync(join(root, 'escaped.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore preserves Unicode logical IDs while mapping physical artifacts deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-unicode-'));
  try {
    const reportDir = join(root, 'reports');
    const wormDir = join(root, 'worm');
    const verificationId = 'ver_plan_task-파일-목록-보여줘_mtmv0u93_mtmv0uag';
    const expectedStorageKey = `report-id-v1-${createHash('sha256').update(verificationId, 'utf8').digest('hex')}`;
    const store = new VerificationReportStore({ reportDir, immutableArtifactRoot: wormDir });
    const paths = store.save({
      verificationId,
      taskId: 'task_unicode_report',
      status: 'passed',
      score: 100,
      checks: [],
      evidence: {},
      createdAt: '2035-01-02T03:04:05.000Z'
    });

    assert.equal(paths.jsonPath, join(reportDir, `${expectedStorageKey}.json`));
    assert.equal(paths.htmlPath, join(reportDir, `${expectedStorageKey}.html`));
    assert.match(basename(paths.jsonPath), /^report-id-v1-[a-f0-9]{64}\.json$/u);
    assert.equal(existsSync(paths.jsonPath), true);
    assert.equal(existsSync(join(reportDir, `${verificationId}.json`)), false);
    assert.equal(store.read(verificationId).verificationId, verificationId);
    assert.deepEqual(store.index().items.map((item) => ({ reportId: item.reportId, storageKey: item.storageKey })), [{
      reportId: verificationId,
      storageKey: expectedStorageKey
    }]);

    const reopened = new VerificationReportStore({ reportDir, immutableArtifactRoot: wormDir });
    assert.equal(reopened.read(verificationId).verificationId, verificationId);
    const sync = reopened.syncImmutableArtifacts({ targetDir: wormDir, keepLast: 1, dryRun: false });
    assert.equal(sync.status, 'synced');
    assert.equal(sync.artifacts.length, 2);
    assert.equal(sync.artifacts.every((item) => item.reportId === verificationId), true);
    assert.equal(sync.artifacts.every((item) => basename(item.destinationPath).startsWith(expectedStorageKey)), true);

    const cleanup = reopened.cleanup({ keepLast: 0, dryRun: false });
    assert.deepEqual(new Set(cleanup.removed), new Set([paths.jsonPath, paths.htmlPath]));
    assert.equal(reopened.read(verificationId), null);
    assert.equal(reopened.index().items.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore reserves its mapped filename namespace against logical ID collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-storage-key-'));
  try {
    const reportDir = join(root, 'reports');
    const unicodeId = 'ver_exec_task-복합-명령_mtmv0uag';
    const collidingLogicalId = `report-id-v1-${createHash('sha256').update(unicodeId, 'utf8').digest('hex')}`;
    const store = new VerificationReportStore({ reportDir });
    const report = (verificationId) => ({
      verificationId,
      status: 'passed',
      score: 100,
      checks: [],
      evidence: {},
      createdAt: '2035-01-02T03:04:05.000Z'
    });

    const unicodePaths = store.save(report(unicodeId));
    const namespacePaths = store.save(report(collidingLogicalId));
    assert.notEqual(unicodePaths.jsonPath, namespacePaths.jsonPath);
    assert.equal(store.read(unicodeId).verificationId, unicodeId);
    assert.equal(store.read(collidingLogicalId).verificationId, collidingLogicalId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore gives Windows-case variants distinct physical artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-casefold-'));
  try {
    const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
    const report = (verificationId, score) => ({
      verificationId,
      status: 'passed',
      score,
      checks: [],
      evidence: {},
      createdAt: `2035-01-0${score}T03:04:05.000Z`
    });

    const upper = store.save(report('CaseID', 1));
    const lower = store.save(report('caseid', 2));

    assert.notEqual(upper.jsonPath.toLowerCase(), lower.jsonPath.toLowerCase());
    assert.equal(store.read('CaseID').score, 1);
    assert.equal(store.read('caseid').score, 2);
    assert.deepEqual(new Set(store.index().items.map((item) => item.reportId)), new Set(['CaseID', 'caseid']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore rejects lone UTF-16 surrogates before hashing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-surrogate-'));
  try {
    const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
    for (const verificationId of ['bad-high-\uD800', 'bad-low-\uDC00']) {
      assert.throws(
        () => store.save({ verificationId, status: 'passed', score: 100, checks: [], evidence: {} }),
        (error) => error.code === 'G_REPORT_ID_INVALID'
      );
    }
    assert.equal(store.index().items.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore reads safe legacy Unicode files and ignores injected index paths during cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-index-path-'));
  try {
    const reportDir = join(root, 'reports');
    const legacyId = 'ver_plan_task-기존-보고서_mtmv0uag';
    const poisonedId = 'ver_poisoned_index';
    const legacyJsonPath = join(reportDir, `${legacyId}.json`);
    const legacyHtmlPath = join(reportDir, `${legacyId}.html`);
    const outsideJsonPath = join(root, 'outside.json');
    const outsideHtmlPath = join(root, 'outside.html');
    await mkdir(reportDir, { recursive: true });
    await writeFile(outsideJsonPath, 'outside-json-sentinel', 'utf8');
    await writeFile(outsideHtmlPath, 'outside-html-sentinel', 'utf8');
    await writeFile(legacyJsonPath, JSON.stringify({ verificationId: legacyId, checks: [] }), 'utf8');
    await writeFile(legacyHtmlPath, '<p>legacy</p>', 'utf8');
    await writeFile(join(reportDir, 'report-index.json'), JSON.stringify({
      indexVersion: 'g-report-index-v1',
      items: [
        {
          reportId: legacyId,
          storageKey: `report-id-v1-${createHash('sha256').update(legacyId, 'utf8').digest('hex')}`,
          status: 'passed',
          score: 100,
          createdAt: '2035-01-02T03:04:05.000Z',
          jsonPath: legacyJsonPath,
          htmlPath: legacyHtmlPath
        },
        {
          reportId: poisonedId,
          status: 'failed',
          score: 0,
          createdAt: '2035-01-01T03:04:05.000Z',
          jsonPath: outsideJsonPath,
          htmlPath: outsideHtmlPath
        },
        {
          reportId: '../outside',
          status: 'failed',
          score: 0,
          createdAt: '2035-01-01T03:04:05.000Z',
          jsonPath: outsideJsonPath,
          htmlPath: outsideHtmlPath
        }
      ]
    }), 'utf8');

    const wormDir = join(root, 'worm');
    const store = new VerificationReportStore({ reportDir, immutableArtifactRoot: wormDir });
    assert.equal(store.read(legacyId).verificationId, legacyId);
    assert.deepEqual(store.index().items.map((item) => item.reportId), [legacyId, poisonedId]);
    assert.equal(store.index().items.find((item) => item.reportId === legacyId).storageKeyVersion, 'legacy-direct-v0');
    const poisonedEntry = store.index().items.find((item) => item.reportId === poisonedId);
    const poisonedStorageKey = `report-id-v1-${createHash('sha256').update(poisonedId, 'utf8').digest('hex')}`;
    assert.equal(poisonedEntry.jsonPath, join(reportDir, `${poisonedStorageKey}.json`));
    assert.equal(poisonedEntry.htmlPath, join(reportDir, `${poisonedStorageKey}.html`));

    const mappedPaths = store.save({
      verificationId: legacyId,
      status: 'passed',
      score: 99,
      checks: [],
      evidence: {},
      createdAt: '2035-01-03T03:04:05.000Z'
    });
    assert.notEqual(mappedPaths.jsonPath, legacyJsonPath);
    assert.equal(store.read(legacyId).score, 99);
    assert.equal(existsSync(legacyJsonPath), true);
    assert.equal(existsSync(mappedPaths.jsonPath), true);

    const sync = store.syncImmutableArtifacts({ targetDir: wormDir, keepLast: 5, dryRun: false });
    assert.equal(sync.artifacts.some((item) => item.reportId === poisonedId), false);
    assert.equal(sync.artifacts.filter((item) => item.reportId === legacyId).length, 2);
    const cleanup = store.cleanup({ keepLast: 0, dryRun: false });
    assert.equal(cleanup.removed.includes(legacyJsonPath), true);
    assert.equal(cleanup.removed.includes(mappedPaths.jsonPath), true);
    assert.equal(store.read(legacyId), null);
    assert.equal(await readFile(outsideJsonPath, 'utf8'), 'outside-json-sentinel');
    assert.equal(await readFile(outsideHtmlPath, 'utf8'), 'outside-html-sentinel');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore restores safe legacy IDs containing spaces emoji and combining marks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-legacy-wide-'));
  try {
    const reportDir = join(root, 'reports');
    const wormDir = join(root, 'worm');
    const legacyId = 'ver legacy 🧪 e\u0301';
    const legacyJsonPath = join(reportDir, `${legacyId}.json`);
    const legacyHtmlPath = join(reportDir, `${legacyId}.html`);
    await mkdir(reportDir, { recursive: true });
    await writeFile(legacyJsonPath, JSON.stringify({
      verificationId: legacyId,
      status: 'passed',
      score: 88,
      checks: [],
      createdAt: '2035-01-02T03:04:05.000Z'
    }), 'utf8');
    await writeFile(legacyHtmlPath, '<p>legacy wide filename</p>', 'utf8');
    await writeFile(join(reportDir, 'report-index.json'), JSON.stringify({
      indexVersion: 'g-report-index-v1',
      items: [{
        reportId: legacyId,
        status: 'passed',
        score: 88,
        createdAt: '2035-01-02T03:04:05.000Z',
        jsonPath: legacyJsonPath,
        htmlPath: legacyHtmlPath
      }]
    }), 'utf8');

    const store = new VerificationReportStore({ reportDir, immutableArtifactRoot: wormDir });
    assert.equal(store.read(legacyId).score, 88);
    assert.equal(store.index().items[0].storageKeyVersion, 'legacy-direct-v0');
    const sync = store.syncImmutableArtifacts({ targetDir: wormDir, keepLast: 1, dryRun: false });
    assert.equal(sync.status, 'synced');
    assert.equal(sync.artifacts.filter((item) => item.reportId === legacyId).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore resolves JSON and HTML legacy migration independently and blocks incomplete cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-partial-migration-'));
  try {
    const reportDir = join(root, 'reports');
    const wormDir = join(root, 'worm');
    const reportId = 'ver-partial-마이그레이션';
    const storageKey = `report-id-v1-${createHash('sha256').update(reportId, 'utf8').digest('hex')}`;
    const currentJsonPath = join(reportDir, `${storageKey}.json`);
    const legacyJsonPath = join(reportDir, `${reportId}.json`);
    const legacyHtmlPath = join(reportDir, `${reportId}.html`);
    await mkdir(reportDir, { recursive: true });
    await writeFile(currentJsonPath, JSON.stringify({
      verificationId: reportId,
      status: 'passed',
      score: 91,
      checks: [],
      createdAt: '2035-01-02T03:04:05.000Z'
    }), 'utf8');
    await writeFile(legacyJsonPath, JSON.stringify({ verificationId: reportId, score: 80, checks: [] }), 'utf8');
    await writeFile(legacyHtmlPath, '<p>legacy html survives partial migration</p>', 'utf8');
    await writeFile(join(reportDir, 'report-index.json'), JSON.stringify({
      indexVersion: 'g-report-index-v1',
      items: [{ reportId, status: 'passed', score: 91, createdAt: '2035-01-02T03:04:05.000Z' }]
    }), 'utf8');

    const store = new VerificationReportStore({ reportDir, immutableArtifactRoot: wormDir });
    const normalized = store.index().items[0];
    assert.equal(normalized.jsonPath, currentJsonPath);
    assert.equal(normalized.htmlPath, legacyHtmlPath);
    const synced = store.syncImmutableArtifacts({ targetDir: wormDir, keepLast: 1, dryRun: false });
    assert.equal(synced.status, 'synced');
    assert.deepEqual(
      new Set(synced.artifacts.map((item) => item.sourcePath)),
      new Set([currentJsonPath, legacyHtmlPath])
    );
    assert.equal(synced.artifacts.every((item) => existsSync(item.destinationPath)), true);

    const incompleteId = 'ver incomplete 🧪';
    const incompleteJsonPath = join(reportDir, `${incompleteId}.json`);
    await writeFile(incompleteJsonPath, JSON.stringify({
      verificationId: incompleteId,
      status: 'passed',
      score: 50,
      checks: [],
      createdAt: '2035-01-03T03:04:05.000Z'
    }), 'utf8');
    await writeFile(join(reportDir, 'report-index.json'), JSON.stringify({
      indexVersion: 'g-report-index-v1',
      items: [
        ...store.index().items,
        { reportId: incompleteId, status: 'passed', score: 50, createdAt: '2035-01-03T03:04:05.000Z' }
      ]
    }), 'utf8');
    const reopened = new VerificationReportStore({ reportDir, immutableArtifactRoot: wormDir });
    const incompleteSync = reopened.syncImmutableArtifacts({ targetDir: wormDir, keepLast: 2, dryRun: false });
    assert.equal(incompleteSync.status, 'incomplete');
    assert.equal(incompleteSync.missingArtifactCount, 1);
    const blockedCleanup = reopened.cleanup({ keepLast: 0, dryRun: false });
    assert.equal(blockedCleanup.status, 'blocked_incomplete_artifacts');
    assert.equal(blockedCleanup.removed.length, 0);
    assert.equal(existsSync(incompleteJsonPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore confines WORM targets and appends immutable manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-worm-boundary-'));
  try {
    const reportDir = join(root, 'reports');
    const wormDir = join(root, 'worm');
    const outsideDir = join(root, 'outside');
    const sentinelManifest = join(outsideDir, 'report-worm-manifest.json');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(sentinelManifest, 'outside-sentinel', 'utf8');
    const store = new VerificationReportStore({ reportDir, immutableArtifactRoot: wormDir });
    store.save({
      verificationId: 'ver_worm_boundary',
      status: 'passed',
      score: 100,
      checks: [],
      evidence: {},
      createdAt: '2035-01-02T03:04:05.000Z'
    });

    assert.throws(
      () => store.syncImmutableArtifacts({ targetDir: outsideDir, keepLast: 1, dryRun: false }),
      (error) => error.code === 'G_REPORT_WORM_TARGET_OUTSIDE_ROOT'
    );
    assert.equal(await readFile(sentinelManifest, 'utf8'), 'outside-sentinel');

    const first = store.syncImmutableArtifacts({ targetDir: wormDir, keepLast: 1, dryRun: false });
    const firstManifest = await readFile(first.manifestPath, 'utf8');
    assert.equal(createHash('sha256').update(firstManifest).digest('hex'), first.manifestSha256);
    const second = store.syncImmutableArtifacts({ targetDir: wormDir, keepLast: 1, dryRun: false });
    assert.notEqual(first.manifestPath, second.manifestPath);
    assert.equal(await readFile(first.manifestPath, 'utf8'), firstManifest);
    assert.equal(second.status, 'synced');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore binds cleanup approval to one exact immutable scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-cleanup-approval-'));
  try {
    const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
    const report = (verificationId, createdAt) => ({
      verificationId,
      status: 'passed',
      score: 100,
      checks: [],
      evidence: {},
      createdAt
    });
    store.save(report('approval-a', '2035-01-01T00:00:00.000Z'));
    store.save(report('approval-b', '2035-01-02T00:00:00.000Z'));
    const requested = store.cleanupApprovalWorkflow({
      keepLast: 1,
      requestedBy: 'cleanup_requester',
      reason: 'Remove the oldest report.'
    });

    const substituted = store.cleanupApprovalWorkflow({
      keepLast: 0,
      approvalId: requested.approval.approvalId,
      approvedBy: 'cleanup_reviewer',
      execute: true,
      dryRun: false
    });
    assert.equal(substituted.status, 'blocked_approval_scope_mismatch');
    assert.equal(store.index().items.length, 2);

    const selfApproved = store.cleanupApprovalWorkflow({
      approvalId: requested.approval.approvalId,
      approvedBy: 'cleanup_requester',
      execute: true,
      dryRun: false
    });
    assert.equal(selfApproved.status, 'blocked_invalid_approver');

    const executed = store.cleanupApprovalWorkflow({
      approvalId: requested.approval.approvalId,
      approvedBy: 'cleanup_reviewer',
      execute: true,
      dryRun: false
    });
    assert.equal(executed.status, 'executed');
    assert.deepEqual(executed.execution.removable.map((item) => item.reportId), ['approval-a']);
    assert.equal(store.index().items.length, 1);

    const replayed = store.cleanupApprovalWorkflow({
      approvalId: requested.approval.approvalId,
      approvedBy: 'cleanup_reviewer',
      execute: true,
      dryRun: false
    });
    assert.equal(replayed.status, 'blocked_approval_not_pending');

    store.save(report('approval-c', '2035-01-03T00:00:00.000Z'));
    const staleRequest = store.cleanupApprovalWorkflow({
      keepLast: 1,
      requestedBy: 'cleanup_requester',
      reason: 'Approve the current oldest report only.'
    });
    store.save(report('approval-d', '2035-01-04T00:00:00.000Z'));
    const stale = store.cleanupApprovalWorkflow({
      approvalId: staleRequest.approval.approvalId,
      approvedBy: 'cleanup_reviewer',
      execute: true,
      dryRun: false
    });
    assert.equal(stale.status, 'blocked_stale_approval');
    assert.equal(store.index().items.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore protects reserved index and artifact identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-reserved-'));
  try {
    const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
    for (const verificationId of ['report-index', 'report-worm-manifest', '.', '..', '']) {
      assert.throws(
        () => store.save({ verificationId, status: 'passed', score: 100, checks: [], evidence: {} }),
        (error) => error.code === 'G_REPORT_ID_INVALID'
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VerificationReportStore redacts sensitive keys and bearer credentials recursively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-redaction-'));
  try {
    const store = new VerificationReportStore({ reportDir: join(root, 'reports') });
    const sanitized = store.sanitize({
      token: 'token-value-123',
      nested: {
        authorization: 'Bearer header.secret.value',
        apiKey: 'api-key-value',
        note: 'Authorization: Bearer free.form.secret'
      }
    });
    const serialized = JSON.stringify(sanitized);
    for (const secret of ['token-value-123', 'header.secret.value', 'api-key-value', 'free.form.secret']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(sanitized.token, '[masked]');
    assert.equal(sanitized.nested.authorization, '[masked]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sendJson callers cannot weaken mandatory response safety headers', () => {
  let observed = null;
  const response = {
    writeHead(statusCode, headers) { observed = { statusCode, headers }; },
    end() {}
  };
  sendJson(response, 200, { ok: true }, {
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'off',
    'content-type': 'text/html',
    'x-apex-probe': 'preserved'
  });
  assert.equal(observed.statusCode, 200);
  assert.equal(observed.headers['cache-control'], 'no-store');
  assert.equal(observed.headers['x-content-type-options'], 'nosniff');
  assert.equal(observed.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(observed.headers['x-apex-probe'], 'preserved');
});

test('routeParams rejects encoded path separators inside one parameter', () => {
  assert.equal(routeParams('/reports/:reportId', '/reports/..%2foutside'), null);
  assert.equal(routeParams('/reports/:reportId', '/reports/a%5cb'), null);
  assert.deepEqual(routeParams('/reports/:reportId', '/reports/ver_report_1'), { reportId: 'ver_report_1' });
});

test('large multi-stage file integrity commands route to the mission lane', () => {
  const result = classifyCommandLane('폴더의 10000개 파일을 읽어 SHA-256을 계산하고 중복을 제거한 뒤 ZIP으로 압축하고 manifest를 재검증해');
  assert.equal(result.lane, 'mission');
  assert.equal(result.stageIds.includes('bulk-file'), true);
  assert.equal(result.reasonCodes.includes('bulk-file-workflow'), true);
});
