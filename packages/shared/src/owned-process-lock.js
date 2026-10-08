import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VERSION = 'jarvis-owned-process-lock-v1';

function lockError(code) {
  return Object.assign(new Error(code), { code });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  // Access denied and unknown errors cannot prove a process has exited.
  catch (error) { return error.code !== 'ESRCH'; }
}

function readRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record?.version !== VERSION || !Number.isInteger(record.pid) || record.pid < 1 ||
        typeof record.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(record.nonce) ||
        typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null;
    return record;
  } catch (error) {
    return error.code === 'ENOENT' ? undefined : null;
  }
}

function ownsRecord(path, record) {
  const current = readRecord(path);
  return current?.pid === record.pid && current?.nonce === record.nonce;
}

function acquiredLock(path, record) {
  let released = false;
  return {
    record,
    assertOwned() {
      if (released || !ownsRecord(path, record)) throw lockError('OWNED_PROCESS_LOCK_LOST');
    },
    release() {
      if (released) return false;
      released = true;
      if (!ownsRecord(path, record)) return false;
      try { unlinkSync(path); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
  };
}

function acquire(path, now, depth) {
  if (depth > 16) throw lockError('OWNED_PROCESS_LOCK_RECOVERY_LIMIT');
  const record = Object.freeze({ version: VERSION, pid: process.pid, nonce: randomUUID(), createdAt: now() });
  const candidatePath = `${path}.${record.nonce}.candidate`;
  // Hard-link publication is exclusive and atomic, with a fully written JSON record.
  // A crash before publication can leave an unused candidate, never an empty lock.
  writeFileSync(candidatePath, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(candidatePath, path);
        return acquiredLock(path, record);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const existing = readRecord(path);
      if (existing === undefined) continue;
      if (!existing) throw lockError('OWNED_PROCESS_LOCK_INVALID');
      if (processAlive(existing.pid)) throw lockError('OWNED_PROCESS_LOCK_BUSY');

      // Only one reclaimer may inspect/remove/publish at a time. If a reclaimer
      // itself was killed, its recovery lock follows the same ownership protocol.
      const recovery = acquire(`${path}.recovery`, now, depth + 1);
      try {
        const current = readRecord(path);
        if (current === null) throw lockError('OWNED_PROCESS_LOCK_INVALID');
        if (current && processAlive(current.pid)) throw lockError('OWNED_PROCESS_LOCK_BUSY');
        if (current) {
          try { unlinkSync(path); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        try {
          linkSync(candidatePath, path);
          return acquiredLock(path, record);
        } catch (error) {
          // An ordinary first acquirer may win while the stale path is absent.
          // Its new lock is never removed without a new liveness check.
          if (error.code !== 'EEXIST') throw error;
        }
      } finally {
        recovery.release();
      }
    }
    throw lockError('OWNED_PROCESS_LOCK_BUSY');
  } finally {
    unlinkSync(candidatePath);
  }
}

export function acquireOwnedProcessLock({ lockPath, now = () => new Date().toISOString() } = {}) {
  if (typeof lockPath !== 'string' || !lockPath) throw lockError('OWNED_PROCESS_LOCK_PATH_REQUIRED');
  const path = resolve(lockPath);
  mkdirSync(dirname(path), { recursive: true });
  return acquire(path, now, 0);
}
