import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

const CRITICAL_PACKAGES = [
  'com.krokid.hud',
  'com.example.vibeoscorehub',
  'com.rokid.os.sprite.launcher',
  'com.rokid.sysconfig',
  'com.rokid.glass.ota',
  'com.rokid.cxrservice',
  'com.rokid.os.sprite.live',
  'com.rokid.os.sprite.snapflow',
  'com.rokid.os.sprite.assistserver',
  'com.rokid.os.master.screenstream'
];

const SNAPSHOT_COMMANDS = {
  'getprop.txt': ['getprop'],
  'packages-with-paths.txt': ['pm', 'list', 'packages', '-f'],
  'packages-third-party.txt': ['pm', 'list', 'packages', '-3'],
  'features.txt': ['pm', 'list', 'features'],
  'settings-system.txt': ['settings', 'list', 'system'],
  'settings-secure.txt': ['settings', 'list', 'secure'],
  'settings-global.txt': ['settings', 'list', 'global'],
  'battery.txt': ['dumpsys', 'battery'],
  'display.txt': ['dumpsys', 'display'],
  'window.txt': ['dumpsys', 'window'],
  'input.txt': ['dumpsys', 'input'],
  'sensorservice.txt': ['dumpsys', 'sensorservice'],
  'wifi.txt': ['dumpsys', 'wifi'],
  'bluetooth-manager.txt': ['dumpsys', 'bluetooth_manager'],
  'usb.txt': ['dumpsys', 'usb'],
  'mounts.txt': ['mount'],
  'storage.txt': ['df', '-h'],
  'ota-package.txt': ['dumpsys', 'package', 'com.rokid.glass.ota'],
  'launcher-package.txt': ['dumpsys', 'package', 'com.rokid.os.sprite.launcher'],
  'hud-package.txt': ['dumpsys', 'package', 'com.krokid.hud'],
  'corehub-package.txt': ['dumpsys', 'package', 'com.example.vibeoscorehub']
};

export class BackupService {
  constructor({ adb, deviceService, audit, backupRoot, now = () => new Date() }) {
    this.adb = adb;
    this.deviceService = deviceService;
    this.audit = audit;
    this.backupRoot = resolve(backupRoot);
    this.now = now;
  }

  async create({ mode = 'logical', serial = '', onProgress = () => {} } = {}) {
    if (!['logical', 'full'].includes(mode)) throw new BackupError(400, '지원하지 않는 백업 모드입니다.');
    const device = await this.deviceService.selectRokid(serial);
    const timestamp = this.now().toISOString().replaceAll(':', '-');
    const backupDir = resolve(this.backupRoot, `${timestamp}-${sanitize(device.serial)}`);
    assertWithin(this.backupRoot, backupDir);
    await mkdir(this.backupRoot, { recursive: true });
    await mkdir(backupDir, { recursive: false });
    const manifest = {
      backupVersion: 'rokid-logical-backup-v1',
      createdAt: this.now().toISOString(),
      completedAt: null,
      mode,
      serial: device.serial,
      device,
      scope: {
        configurationSnapshot: true,
        criticalApks: true,
        debuggableAppData: true,
        allAccessibleApks: mode === 'full',
        sharedStorage: mode === 'full',
        rawPartitions: false
      },
      limitations: [
        'ADB shell 권한으로 접근할 수 없는 앱의 개인 데이터는 포함되지 않습니다.',
        'boot/vendor/system 원시 파티션은 루트 또는 복구 환경 확보 전까지 포함되지 않습니다.',
        '복원 전에는 패키지 서명·버전·기기 슬롯을 다시 확인해야 합니다.'
      ],
      files: [],
      warnings: []
    };
    await this.audit.append({ type: 'backup.started', serial: device.serial, mode, backupDir });
    try {
      onProgress({ percent: 4, stage: '기기 개요 저장' });
      const overview = await this.deviceService.overview(device.serial);
      await writeJson(join(backupDir, 'device-overview.json'), overview);

      onProgress({ percent: 10, stage: '설정과 하드웨어 상태 수집' });
      const snapshotDir = join(backupDir, 'snapshot');
      await mkdir(snapshotDir, { recursive: true });
      for (const [fileName, args] of Object.entries(SNAPSHOT_COMMANDS)) {
        try {
          const output = await this.adb.shell(device.serial, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
          await writeFile(join(snapshotDir, fileName), `${output}\n`, 'utf8');
        } catch (error) {
          manifest.warnings.push(`${fileName}: ${String(error.message).slice(0, 180)}`);
        }
      }

      const packages = await this.deviceService.packages(device.serial);
      await writeJson(join(backupDir, 'packages.json'), packages);
      const selectedPackages = mode === 'full'
        ? packages
        : packages.filter((item) => CRITICAL_PACKAGES.includes(item.name));
      const apkDir = join(backupDir, 'apks');
      await mkdir(apkDir, { recursive: true });
      const totalPackages = Math.max(selectedPackages.length, 1);
      for (let index = 0; index < selectedPackages.length; index += 1) {
        const item = selectedPackages[index];
        onProgress({
          percent: 18 + Math.round((index / totalPackages) * (mode === 'full' ? 52 : 42)),
          stage: `APK 백업 · ${item.name}`
        });
        try {
          const target = join(apkDir, `${sanitize(item.name)}-${basename(item.path)}`);
          await this.adb.pull(device.serial, item.path, target);
        } catch (error) {
          manifest.warnings.push(`${item.name} APK: ${String(error.message).slice(0, 180)}`);
        }
      }

      onProgress({ percent: mode === 'full' ? 72 : 68, stage: '디버그 앱 데이터 보존' });
      const dataDir = join(backupDir, 'debuggable-app-data');
      await mkdir(dataDir, { recursive: true });
      for (const item of packages.filter((entry) => entry.debuggable)) {
        try {
          const archive = await this.adb.execOut(device.serial, ['run-as', item.name, 'tar', '-cf', '-', '.'], { timeout: 120_000 });
          if (archive.length) await writeFile(join(dataDir, `${sanitize(item.name)}.tar`), archive);
        } catch (error) {
          manifest.warnings.push(`${item.name} data: ${String(error.message).slice(0, 180)}`);
        }
      }

      if (mode === 'full') {
        onProgress({ percent: 78, stage: '공유 저장공간 백업' });
        try {
          const sharedDir = join(backupDir, 'shared-storage');
          await mkdir(sharedDir, { recursive: true });
          await this.adb.pull(device.serial, '/sdcard/.', sharedDir, { timeout: 60 * 60_000 });
        } catch (error) {
          manifest.warnings.push(`shared storage: ${String(error.message).slice(0, 180)}`);
        }
      }

      onProgress({ percent: 90, stage: '파일 해시와 복원 목록 작성' });
      manifest.files = await hashTree(backupDir, backupDir, new Set(['manifest.json']));
      manifest.completedAt = this.now().toISOString();
      manifest.integrity = {
        algorithm: 'sha256',
        fileCount: manifest.files.length,
        manifestPayloadSha256: sha256(JSON.stringify({ ...manifest, files: manifest.files }))
      };
      await writeJson(join(backupDir, 'manifest.json'), manifest);
      await writeJson(join(this.backupRoot, 'latest.json'), {
        backupDir,
        createdAt: manifest.createdAt,
        completedAt: manifest.completedAt,
        mode,
        serial: device.serial,
        warnings: manifest.warnings.length,
        fileCount: manifest.files.length
      });
      onProgress({ percent: 100, stage: '백업 완료' });
      await this.audit.append({ type: 'backup.completed', serial: device.serial, mode, backupDir, fileCount: manifest.files.length, warnings: manifest.warnings.length });
      return { status: 'completed', backupDir, manifest };
    } catch (error) {
      manifest.warnings.push(`fatal: ${String(error.message).slice(0, 300)}`);
      await writeJson(join(backupDir, 'manifest.incomplete.json'), manifest).catch(() => {});
      await this.audit.append({ type: 'backup.failed', serial: device.serial, mode, backupDir, error: String(error.message).slice(0, 300) });
      throw error;
    }
  }

  async latest() {
    try {
      return JSON.parse(await readFile(join(this.backupRoot, 'latest.json'), 'utf8'));
    } catch {
      return null;
    }
  }
}

export class BackupError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function hashTree(root, directory, ignored) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const rel = relative(root, path).replaceAll('\\', '/');
    if (ignored.has(rel)) continue;
    if (entry.isDirectory()) output.push(...await hashTree(root, path, ignored));
    else if (entry.isFile()) {
      const info = await stat(path);
      output.push({ path: rel, size: info.size, sha256: sha256(await readFile(path)) });
    }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function assertWithin(root, candidate) {
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new Error('백업 경로가 허용된 루트를 벗어났습니다.');
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
