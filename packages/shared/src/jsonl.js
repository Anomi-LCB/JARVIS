import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const transientFileLockCodes = new Set(['EBUSY', 'EPERM', 'EACCES']);

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
