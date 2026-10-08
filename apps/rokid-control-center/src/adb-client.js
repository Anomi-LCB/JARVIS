import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const WINDOWS_ADB = 'adb.exe';

export async function resolveAdbPath({ portableRoot = '', env = process.env } = {}) {
  const candidates = [
    env.ROKID_ADB_PATH,
    portableRoot && join(portableRoot, 'tools', 'adb', WINDOWS_ADB),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Jarvis', 'Android', 'platform-tools', WINDOWS_ADB),
    env.ANDROID_HOME && join(env.ANDROID_HOME, 'platform-tools', WINDOWS_ADB),
    env.ANDROID_SDK_ROOT && join(env.ANDROID_SDK_ROOT, 'platform-tools', WINDOWS_ADB)
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through deterministic local candidates.
    }
  }
  const pathEntries = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, process.platform === 'win32' ? WINDOWS_ADB : 'adb');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error('ADB를 찾을 수 없습니다. ROKID_ADB_PATH를 설정하거나 Android Platform Tools를 설치하세요.');
}

export function parseDeviceList(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...parts] = line.split(/\s+/);
      const attributes = Object.fromEntries(parts
        .map((part) => part.split(':'))
        .filter((entry) => entry.length === 2));
      return { serial, state, ...attributes };
    });
}

export class AdbClient {
  constructor({ adbPath, execute = executeFileBuffer } = {}) {
    if (!adbPath) throw new Error('adbPath is required');
    this.adbPath = adbPath;
    this.execute = execute;
  }

  async run(args, { timeout = 30_000, encoding = 'utf8', maxBuffer = 16 * 1024 * 1024 } = {}) {
    const result = await this.execute(this.adbPath, args.map(String), { timeout, encoding, maxBuffer });
    return result;
  }

  async text(args, options = {}) {
    const { stdout } = await this.run(args, { ...options, encoding: 'utf8' });
    return String(stdout ?? '').trim();
  }

  async listDevices() {
    return parseDeviceList(await this.text(['devices', '-l']));
  }

  async shell(serial, args, options = {}) {
    return this.text(['-s', serial, 'shell', ...args], options);
  }

  async execOut(serial, args, options = {}) {
    const { stdout } = await this.run(['-s', serial, 'exec-out', ...args], {
      ...options,
      encoding: null,
      maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
  }

  async pull(serial, remotePath, localPath, options = {}) {
    return this.text(['-s', serial, 'pull', remotePath, localPath], {
      timeout: options.timeout ?? 10 * 60_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024
    });
  }
}

function executeFileBuffer(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      shell: false,
      timeout: options.timeout,
      encoding: options.encoding,
      maxBuffer: options.maxBuffer
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
