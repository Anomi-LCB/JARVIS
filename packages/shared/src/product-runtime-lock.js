import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const lockVersion = 'jarvis-product-runtime-lock-v1';

export function acquireProductRuntimeLock({
  env = process.env,
  lockPath = defaultProductRuntimeLockPath(env),
  workspaceRoot = process.cwd(),
  pid = process.pid,
  clock = () => new Date(),
  randomBytesImpl = randomBytes,
  isProcessAlive = defaultIsProcessAlive,
  getProcessStartTime = defaultGetProcessStartTime
} = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lockId = randomBytesImpl(18).toString('base64url');
    const record = {
      lockVersion,
      lockId,
      pid,
      workspaceRoot: resolve(workspaceRoot),
      createdAt: clock().toISOString()
    };
    try {
      writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      return createAcquiredLock({ lockPath, record });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const existing = readLockRecord(lockPath);
    if (!existing) {
      const error = new Error('Product runtime lock is unreadable or invalid.');
      error.code = 'JARVIS_PRODUCT_RUNTIME_LOCK_INVALID';
      throw error;
    }
    const alive = isProcessAlive(existing.pid);
    const processStartedAt = alive ? getProcessStartTime(existing.pid) : null;
    const pidWasReused = processStartedAt instanceof Date
      && Number.isFinite(processStartedAt.getTime())
      && processStartedAt.getTime() > Date.parse(existing.createdAt);
    if (alive && !pidWasReused) {
      return {
        acquired: false,
        active: true,
        lockVersion,
        pid: existing.pid,
        workspaceRoot: existing.workspaceRoot,
        createdAt: existing.createdAt,
        release: () => false
      };
    }
    try {
      const current = readLockRecord(lockPath);
      if (current?.lockId !== existing.lockId || current?.pid !== existing.pid) continue;
      unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
    }
  }
  const error = new Error('Product runtime lock could not be acquired after stale-lock recovery.');
  error.code = 'JARVIS_PRODUCT_RUNTIME_LOCK_BUSY';
  throw error;
}

export function defaultProductRuntimeLockPath(env = process.env) {
  if (env.JARVIS_PRODUCT_RUNTIME_LOCK) return resolve(env.JARVIS_PRODUCT_RUNTIME_LOCK);
  const userDataRoot = env.LOCALAPPDATA || env.APPDATA || join(homedir(), '.jarvis');
  return resolve(userDataRoot, 'JARVIS', 'runtime', 'product-runtime.lock.json');
}

function createAcquiredLock({ lockPath, record }) {
  let released = false;
  return {
    acquired: true,
    active: true,
    lockVersion,
    pid: record.pid,
    workspaceRoot: record.workspaceRoot,
    createdAt: record.createdAt,
    release() {
      if (released) return false;
      const current = readLockRecord(lockPath);
      if (!current || current.lockId !== record.lockId || current.pid !== record.pid) return false;
      try {
        unlinkSync(lockPath);
        released = true;
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') released = true;
        return false;
      }
    }
  };
}

function readLockRecord(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (
      record.lockVersion !== lockVersion
      || typeof record.lockId !== 'string'
      || record.lockId.length < 16
      || !Number.isInteger(record.pid)
      || record.pid < 1
      || typeof record.workspaceRoot !== 'string'
      || !Number.isFinite(Date.parse(record.createdAt))
    ) return null;
    return record;
  } catch {
    return null;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function defaultGetProcessStartTime(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid < 1) return null;
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `[Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o'))`
    ], { encoding: 'utf8', timeout: 1_500, windowsHide: true, maxBuffer: 256 });
    const startTime = new Date(output.trim());
    return Number.isFinite(startTime.getTime()) ? startTime : null;
  } catch {
    return null;
  }
}
