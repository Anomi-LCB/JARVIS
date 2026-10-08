import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isTransientJsonlWriteError } from '../../../shared/src/jsonl.js';

const storeVersion = 'a-mission-store-v1';
let temporaryFileSequence = 0;

export class FileMissionStore {
  constructor({ filePath, clock = () => new Date() } = {}) {
    if (!filePath) throw new Error('FileMissionStore requires filePath.');
    this.filePath = filePath;
    this.clock = clock;
  }

  load() {
    if (!existsSync(this.filePath)) return [];
    try {
      const snapshot = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (snapshot?.storeVersion !== storeVersion || !Array.isArray(snapshot.missions)) {
        const error = new Error('Unsupported or invalid mission store snapshot.');
        error.code = 'A_MISSION_STORE_VERSION_UNSUPPORTED';
        throw error;
      }
      return snapshot.missions;
    } catch (error) {
      if (!error.code) error.code = 'A_MISSION_STORE_CORRUPT';
      throw error;
    }
  }

  save(missions, { reason = 'snapshot' } = {}) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = {
      storeVersion,
      persistedAt: this.clock().toISOString(),
      reason,
      missions: [...missions]
    };
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${++temporaryFileSequence}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8');
    try {
      replaceFileWithRetry(temporaryPath, this.filePath);
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original replacement error.
      }
      throw error;
    }
    return payload;
  }

  metadata() {
    return { storeVersion, filePath: this.filePath };
  }
}

export function replaceFileWithRetry(sourcePath, targetPath, {
  rename = renameSync,
  sleep = sleepSync,
  maxAttempts = 8
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!isTransientJsonlWriteError(error)) throw error;
      lastError = error;
      sleep(25 * (attempt + 1));
    }
  }
  throw lastError;
}

function sleepSync(milliseconds) {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, milliseconds);
}

export class MemoryMissionStore {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.missions = [];
    this.persistedAt = null;
  }

  load() {
    return structuredClone(this.missions);
  }

  save(missions, { reason = 'snapshot' } = {}) {
    this.missions = structuredClone([...missions]);
    this.persistedAt = this.clock().toISOString();
    return {
      storeVersion: 'a-mission-memory-store-v1',
      persistedAt: this.persistedAt,
      reason,
      missions: structuredClone(this.missions)
    };
  }

  metadata() {
    return {
      storeVersion: 'a-mission-memory-store-v1',
      persistedAt: this.persistedAt,
      inMemory: true
    };
  }
}
