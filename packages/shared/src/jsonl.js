import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { mkdirSync, appendFileSync, statSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const transientFileLockCodes = new Set(['EBUSY', 'EPERM', 'EACCES']);

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
  mkdirSync(dirname(filePath), { recursive: true });
  rotateIfOversized(filePath);
  const line = `${JSON.stringify(event)}\n`;
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      appendFileSync(filePath, line, 'utf8');
      return;
    } catch (error) {
      if (!isTransientJsonlWriteError(error)) throw error;
      lastError = error;
      sleepSync(retryDelayMs(attempt));
    }
  }
  throw lastError;
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
