import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { mkdirSync, appendFileSync, statSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const transientFileLockCodes = new Set(['EBUSY', 'EPERM', 'EACCES']);
let activeSyncBatch = null;
let syncBatchSequence = 0;

// 로그 파일 크기 상한. 초과 시 D:\Jarvis_LogArchive로 통째로 이동(무손실)하고 새로 시작한다.
// EventBus replay는 활성 파일의 마지막 16MB만 읽으므로 로테이션해도 복구 동작에 영향 없음.
// D 사용 불가 시 폴백: 같은 볼륨에서 <file>.1로 밀어냄(.1 한 세대만 유지).
const defaultJsonlMaxBytes = 64 * 1024 * 1024;
const jsonlArchiveDir = 'D:\\Jarvis_LogArchive';

function rotateIfOversized(filePath, maxBytes = defaultJsonlMaxBytes) {
  try {
    if (statSync(filePath).size < maxBytes) return;
  } catch {
    return; // 파일 없음 → 로테이션 불필요
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    mkdirSync(jsonlArchiveDir, { recursive: true });
    copyFileSync(filePath, join(jsonlArchiveDir, `${basename(filePath)}.${stamp}`));
    rmSync(filePath, { force: true });
    return;
  } catch {
    // D 미장착/잠금 등 — 아래 .1 폴백
  }
  try {
    rmSync(`${filePath}.1`, { force: true });
    renameSync(filePath, `${filePath}.1`);
  } catch {
    // 다른 프로세스가 잠근 경우 등 — 이번 append는 그대로 진행하고 다음 기회에 로테이션
  }
}

export function isTransientJsonlWriteError(error) {
  return transientFileLockCodes.has(error?.code);
}

function retryDelayMs(attempt) {
  return 25 * (attempt + 1);
}

function sleepSync(ms) {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, ms);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function appendJsonl(filePath, event) {
  await mkdir(dirname(filePath), { recursive: true });
  rotateIfOversized(filePath);
  const line = `${JSON.stringify(event)}\n`;
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await appendFile(filePath, line, 'utf8');
      return;
    } catch (error) {
      if (!isTransientJsonlWriteError(error)) throw error;
      lastError = error;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}

export function appendJsonlSync(filePath, event) {
  const line = `${JSON.stringify(event)}\n`;
  if (activeSyncBatch) {
    queueSyncBatchLine(activeSyncBatch, filePath, line);
    return;
  }
  appendSerializedJsonlSync(filePath, line);
}

// Hash-chained journals must reach disk while their file lock is held. They cannot
// wait for an unrelated operation batch to commit without exposing a stale head.
export function appendJsonlImmediateSync(filePath, event) {
  appendSerializedJsonlSync(filePath, `${JSON.stringify(event)}\n`);
}

export function appendJsonlBatchSync(filePath, events = []) {
  if (!Array.isArray(events) || events.length === 0) return;
  const lines = events.map((event) => `${JSON.stringify(event)}\n`);
  if (activeSyncBatch) {
    for (const line of lines) queueSyncBatchLine(activeSyncBatch, filePath, line);
    return;
  }
  appendSerializedJsonlSync(filePath, lines.join(''));
}

export function beginJsonlBatchSync({ operation = 'jsonl-batch' } = {}) {
  const batch = {
    batchId: `jsonl_batch_${++syncBatchSequence}`,
    operation,
    parent: activeSyncBatch,
    recordsByPath: new Map(),
    logicalRecordCount: 0,
    startedAtNs: process.hrtime.bigint(),
    state: 'active'
  };
  activeSyncBatch = batch;
  return batch;
}

export function commitJsonlBatchSync(batch) {
  assertActiveSyncBatch(batch);
  activeSyncBatch = batch.parent;
  batch.state = 'committing';

  if (batch.parent) {
    for (const [filePath, lines] of batch.recordsByPath) {
      for (const line of lines) queueSyncBatchLine(batch.parent, filePath, line);
    }
    batch.state = 'committed';
    return batchSummary(batch, { nested: true, physicalWriteCount: 0 });
  }

  let physicalWriteCount = 0;
  try {
    for (const [filePath, lines] of batch.recordsByPath) {
      appendSerializedJsonlSync(filePath, lines.join(''));
      physicalWriteCount += 1;
    }
    batch.state = 'committed';
    return batchSummary(batch, { nested: false, physicalWriteCount });
  } catch (error) {
    batch.state = 'failed';
    error.jsonlBatch = batchSummary(batch, { nested: false, physicalWriteCount });
    throw error;
  }
}

export function discardJsonlBatchSync(batch) {
  assertActiveSyncBatch(batch);
  activeSyncBatch = batch.parent;
  batch.state = 'discarded';
  return batchSummary(batch, { nested: Boolean(batch.parent), physicalWriteCount: 0 });
}

function appendSerializedJsonlSync(filePath, body) {
  if (!body) return;
  mkdirSync(dirname(filePath), { recursive: true });
  rotateIfOversized(filePath);
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      appendFileSync(filePath, body, 'utf8');
      return;
    } catch (error) {
      if (!isTransientJsonlWriteError(error)) throw error;
      lastError = error;
      sleepSync(retryDelayMs(attempt));
    }
  }
  throw lastError;
}

function queueSyncBatchLine(batch, filePath, line) {
  const lines = batch.recordsByPath.get(filePath) ?? [];
  lines.push(line);
  batch.recordsByPath.set(filePath, lines);
  batch.logicalRecordCount += 1;
}

function assertActiveSyncBatch(batch) {
  if (!batch || batch.state !== 'active' || activeSyncBatch !== batch) {
    throw new Error('JSONL sync batches must be completed in last-in-first-out order.');
  }
}

function batchSummary(batch, { nested, physicalWriteCount }) {
  const durationMs = Number(process.hrtime.bigint() - batch.startedAtNs) / 1_000_000;
  return {
    batchId: batch.batchId,
    operation: batch.operation,
    state: batch.state,
    nested,
    logicalRecordCount: batch.logicalRecordCount,
    physicalWriteCount,
    fileCount: batch.recordsByPath.size,
    writeReductionRatio: batch.logicalRecordCount > 0
      ? 1 - physicalWriteCount / batch.logicalRecordCount
      : 0,
    durationMs
  };
}

export async function readJsonl(filePath) {
  try {
    const body = await readFile(filePath, 'utf8');
    return body
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
