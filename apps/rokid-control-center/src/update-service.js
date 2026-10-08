import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class UpdateService {
  constructor({ adb, deviceService, audit, dataRoot, execute = executeFileText, openFolder = openFolderInExplorer, now = () => new Date() }) {
    this.adb = adb;
    this.deviceService = deviceService;
    this.audit = audit;
    this.updateRoot = resolve(dataRoot, 'updates');
    this.inboxRoot = resolve(this.updateRoot, 'inbox');
    this.manifestRoot = resolve(this.updateRoot, 'manifests');
    this.execute = execute;
    this.openFolder = openFolder;
    this.now = now;
  }

  async status(serial = '') {
    await this.ensureDirectories();
    const device = await this.deviceService.selectRokid(serial);
    const [checkUrl, checkApi, otaPackage, globalSettings, packages] = await Promise.all([
      this.safeShell(device.serial, ['getprop', 'ro.rokid.ota.check_url']),
      this.safeShell(device.serial, ['getprop', 'ro.rokid.ota.check_api']),
      this.safeShell(device.serial, ['dumpsys', 'package', 'com.rokid.glass.ota']),
      this.safeShell(device.serial, ['settings', 'list', 'global']),
      this.scanPackages()
    ]);
    return {
      protocolVersion: 'rokid-ota-observed-v1',
      serial: device.serial,
      vendor: {
        checkEndpoint: `${checkUrl}${checkApi}`,
        checkMethod: 'POST',
        responseFields: ['code', 'imageUrl', 'version', 'checksum', 'changelog', 'isForceUpdate'],
        packageVersion: otaPackage.match(/versionName=([^\s]+)/)?.[1] ?? '',
        packageVersionCode: otaPackage.match(/versionCode=(\d+)/)?.[1] ?? '',
        systemUid: /sharedUserId=android\.uid\.system|userId=1000/.test(otaPackage),
        persistent: true
      },
      deviceState: parseOtaSettings(globalSettings),
      localVault: {
        inboxRoot: this.inboxRoot,
        manifestRoot: this.manifestRoot,
        packages
      },
      deployment: {
        enabled: false,
        reason: '원시 boot/init_boot/vendor_boot/vbmeta 복구 이미지와 실제 복구 훈련이 완료될 때까지 잠겨 있습니다.',
        discoveredApplyPath: '/sdcard/update.zip → Android A/B UpdateEngine.applyPayload()',
        requiredPackageEntries: ['payload.bin', 'payload_properties.txt'],
        integrityObserved: '서버 checksum 및 다운로드 파일 MD5, 이후 UpdateEngine 내부 payload 서명 검증'
      }
    };
  }

  async openInbox() {
    await this.ensureDirectories();
    await this.openFolder(this.inboxRoot);
    await this.audit.append({ type: 'update.inbox.opened', path: this.inboxRoot, status: 'succeeded' });
    return { status: 'opened', path: this.inboxRoot };
  }

  async importPackage(filename, input, { maximumBytes = 4 * 1024 ** 3 } = {}) {
    await this.ensureDirectories();
    const safeName = assertUpdateFilename(filename);
    const targetPath = resolve(this.inboxRoot, safeName);
    const temporaryPath = resolve(this.inboxRoot, `.${safeName}.uploading-${process.pid}-${Date.now()}`);
    assertWithin(this.inboxRoot, targetPath);
    assertWithin(this.inboxRoot, temporaryPath);
    try {
      await access(targetPath);
      throw new UpdateError(409, '같은 이름의 업데이트 파일이 이미 있습니다. 기존 파일을 정리하거나 이름을 바꿔주세요.');
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maximumBytes) callback(new UpdateError(413, '업데이트 파일이 허용 크기보다 큽니다.'));
        else callback(null, chunk);
      }
    });
    try {
      await pipeline(input, limiter, createWriteStream(temporaryPath, { flags: 'wx' }));
      if (receivedBytes === 0) throw new UpdateError(400, '비어 있는 업데이트 파일은 저장할 수 없습니다.');
      await rename(temporaryPath, targetPath);
      await this.audit.append({ type: 'update.package.imported', filename: safeName, size: receivedBytes, status: 'succeeded' });
      return { status: 'imported', filename: safeName, size: receivedBytes };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async prepare(filename) {
    await this.ensureDirectories();
    const safeName = assertUpdateFilename(filename);
    const packages = await this.scanPackages();
    const selected = packages.find((item) => item.filename === safeName);
    if (!selected) throw new UpdateError(404, '업데이트 보관함에서 파일을 찾을 수 없습니다.');
    if (!selected.hasPayload || !selected.hasPayloadProperties) {
      throw new UpdateError(422, 'Android A/B 업데이트에 필요한 payload.bin 또는 payload_properties.txt가 없습니다.');
    }
    const preparedAt = this.now().toISOString();
    const manifest = {
      manifestVersion: 'rokid-local-update-manifest-v1',
      preparedAt,
      package: selected,
      delivery: {
        status: 'staged-only',
        served: false,
        deviceApplyAllowed: false,
        targetPath: '/sdcard/update.zip'
      },
      gates: {
        logicalBackupRequired: true,
        rawPartitionRecoveryRequired: true,
        payloadSignatureCompatibilityRequired: true,
        batteryMinimumPercent: 30,
        rollbackDrillRequired: true
      }
    };
    const manifestName = `${safeName.replace(/\.zip$/i, '')}-${selected.sha256.slice(0, 12)}.json`;
    const manifestPath = resolve(this.manifestRoot, manifestName);
    assertWithin(this.manifestRoot, manifestPath);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await this.audit.append({ type: 'update.package.prepared', filename: safeName, sha256: selected.sha256, manifestPath, status: 'succeeded' });
    return { status: 'prepared', manifestPath, manifest };
  }

  async scanPackages() {
    await this.ensureDirectories();
    const entries = await readdir(this.inboxRoot, { withFileTypes: true });
    const zipFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'));
    const output = [];
    for (const entry of zipFiles) {
      const path = resolve(this.inboxRoot, entry.name);
      assertWithin(this.inboxRoot, path);
      const [info, hashes, archive] = await Promise.all([
        stat(path),
        hashFile(path),
        this.inspectArchive(path)
      ]);
      output.push({
        filename: entry.name,
        size: info.size,
        sha256: hashes.sha256,
        md5: hashes.md5,
        hasPayload: archive.entries.includes('payload.bin'),
        hasPayloadProperties: archive.entries.includes('payload_properties.txt'),
        hasCareMap: archive.entries.includes('care_map.pb'),
        entryCount: archive.entries.length,
        inspectionError: archive.error
      });
    }
    return output.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  async inspectArchive(path) {
    try {
      const { stdout } = await this.execute('tar.exe', ['-tf', path], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      const entries = String(stdout).split(/\r?\n/).map((item) => item.replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean);
      if (entries.some((entry) => entry.startsWith('../') || entry.includes('/../') || entry.startsWith('/'))) {
        return { entries: [], error: 'archive_path_traversal_detected' };
      }
      return { entries, error: null };
    } catch (error) {
      return { entries: [], error: String(error.message).slice(0, 220) };
    }
  }

  async safeShell(serial, args) {
    try {
      return await this.adb.shell(serial, args);
    } catch {
      return '';
    }
  }

  async ensureDirectories() {
    await Promise.all([
      mkdir(this.inboxRoot, { recursive: true }),
      mkdir(this.manifestRoot, { recursive: true })
    ]);
  }
}

export class UpdateError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseOtaSettings(output) {
  const entries = Object.fromEntries(String(output).split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : null;
  }).filter(Boolean));
  return {
    check: entries.ota_check_state_key ?? 'unknown',
    upgrade: entries.ota_upgrade_state_key ?? 'unknown',
    reboot: entries.ota_reboot_state_key ?? 'unknown',
    wifi: entries.ota_wifi_connect_state_key ?? 'unknown'
  };
}

function assertUpdateFilename(value) {
  const name = basename(String(value ?? ''));
  if (name !== value || !/^[a-zA-Z0-9가-힣._ -]{1,180}\.zip$/i.test(name)) throw new UpdateError(400, '올바른 ZIP 파일 이름이 아닙니다.');
  return name;
}

function assertWithin(root, candidate) {
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new UpdateError(403, '업데이트 경로가 보관함을 벗어났습니다.');
}

function hashFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    const input = createReadStream(path);
    input.on('data', (chunk) => { sha256.update(chunk); md5.update(chunk); });
    input.on('error', rejectHash);
    input.on('end', () => resolveHash({ sha256: sha256.digest('hex'), md5: md5.digest('hex') }));
  });
}

function executeFileText(file, args, options) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(file, args, { windowsHide: true, shell: false, encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; rejectExec(error); return; }
      resolveExec({ stdout, stderr });
    });
  });
}

function openFolderInExplorer(path) {
  return new Promise((resolveOpen, rejectOpen) => {
    const child = spawn('explorer.exe', [path], { detached: true, windowsHide: false, shell: false, stdio: 'ignore' });
    child.once('error', rejectOpen);
    child.once('spawn', () => { child.unref(); resolveOpen(); });
  });
}
