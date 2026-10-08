import { execFile, spawn } from 'node:child_process';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { listAndroidDevices, resolveAdbCommand } from './mobile-device-smoke.mjs';

const execFileAsync = promisify(execFile);
const packageName = 'local.eureka.jarvis.e2e';
const androidRoot = resolve('apps/mobile/android');
const gradleCommand = process.platform === 'win32'
  ? join(androidRoot, 'gradlew.bat')
  : join(androidRoot, 'gradlew');
const defaultApkPath = join(androidRoot, 'app/build/outputs/apk/debug/app-debug.apk');
const defaultBuildTimeoutMs = 25 * 60 * 1000;
const supportedAndroidAbis = Object.freeze(['arm64-v8a', 'x86_64', 'armeabi-v7a', 'x86']);

function resolveBuildTimeoutMs() {
  const requested = Number.parseInt(process.env.JARVIS_MOBILE_E2E_BUILD_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(requested)) return defaultBuildTimeoutMs;
  return Math.min(Math.max(requested, 5 * 60 * 1000), 60 * 60 * 1000);
}

function appendBounded(current, chunk, maxLength = 4 * 1024 * 1024) {
  const next = `${current}${String(chunk)}`;
  return next.length <= maxLength ? next : next.slice(-maxLength);
}

async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  await new Promise((resolveTermination) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.once('error', resolveTermination);
    killer.once('close', resolveTermination);
  });
}

function runBuildProcess(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => { spawnError = error; });
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child);
    }, timeoutMs);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (spawnError) {
        Object.assign(spawnError, { stdout, stderr });
        rejectBuild(spawnError);
        return;
      }
      if (timedOut) {
        rejectBuild(Object.assign(new Error(`Android E2E build timed out after ${timeoutMs}ms`), {
          code: 'ETIMEDOUT',
          stdout,
          stderr
        }));
        return;
      }
      if (exitCode !== 0) {
        rejectBuild(Object.assign(new Error(`Android E2E build exited with code ${exitCode}${signal ? ` (${signal})` : ''}`), {
          code: exitCode,
          stdout,
          stderr
        }));
        return;
      }
      resolveBuild({ stdout, stderr, exitCode });
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeArchitectures(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

export function selectMobileE2ETargetArchitectures({
  deviceAbis = [],
  requestedArchitectures = []
} = {}) {
  const normalizedDeviceAbis = normalizeArchitectures(deviceAbis);
  const normalizedRequested = normalizeArchitectures(requestedArchitectures);
  const unsupportedRequested = normalizedRequested.filter((abi) => !supportedAndroidAbis.includes(abi));
  if (unsupportedRequested.length > 0) {
    throw new Error(`unsupported-mobile-e2e-abi:${unsupportedRequested.join(',')}`);
  }

  const deviceSupported = normalizedDeviceAbis.filter((abi) => supportedAndroidAbis.includes(abi));
  if (deviceSupported.length === 0) {
    throw new Error(`no-supported-device-abi:${normalizedDeviceAbis.join(',') || 'unknown'}`);
  }

  if (normalizedRequested.length > 0) {
    const compatible = normalizedRequested.filter((abi) => deviceSupported.includes(abi));
    if (compatible.length === 0) {
      throw new Error(`requested-mobile-e2e-abi-incompatible:${normalizedRequested.join(',')}:${deviceSupported.join(',')}`);
    }
    return compatible;
  }

  return [deviceSupported[0]];
}

export function selectMobileE2EDevice({ devices = [], requestedSerial = '' } = {}) {
  const normalizedSerial = String(requestedSerial ?? '').trim();
  if (normalizedSerial) {
    const requested = devices.find((item) => item.serial === normalizedSerial);
    if (!requested) throw new Error(`requested-android-device-not-found:${normalizedSerial}`);
    if (requested.state !== 'device') {
      throw new Error(`requested-android-device-not-ready:${normalizedSerial}:${requested.state ?? 'unknown'}`);
    }
    return requested;
  }

  const readyDevices = devices.filter((item) => item.state === 'device');
  if (readyDevices.length === 0) throw new Error('no-ready-android-device');
  if (readyDevices.length > 1) {
    throw new Error(`multiple-ready-android-devices:${readyDevices.map((item) => item.serial).join(',')}`);
  }
  return readyDevices[0];
}

async function readDeviceAbis(adbCommand, serial) {
  const readProperty = async (property) => {
    const { stdout } = await execFileAsync(adbCommand, ['-s', serial, 'shell', 'getprop', property], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    return String(stdout ?? '').trim();
  };
  const abiList = await readProperty('ro.product.cpu.abilist').catch(() => '');
  const primaryAbi = abiList || await readProperty('ro.product.cpu.abi').catch(() => '');
  return normalizeArchitectures(primaryAbi);
}

async function readDeviceStorage(adbCommand, serial) {
  try {
    const { stdout } = await execFileAsync(adbCommand, ['-s', serial, 'shell', 'df', '-k', '/data'], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    const lines = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
    const columns = lines.at(-1)?.trim().split(/\s+/) ?? [];
    const availableKilobytes = Number.parseInt(columns[3] ?? '', 10);
    return {
      availableBytes: Number.isFinite(availableKilobytes) ? availableKilobytes * 1024 : null,
      availableMegabytes: Number.isFinite(availableKilobytes)
        ? Math.round((availableKilobytes / 1024) * 100) / 100
        : null
    };
  } catch (error) {
    return { availableBytes: null, availableMegabytes: null, probeError: error.code ?? error.message };
  }
}

function isInsufficientStorageError(error) {
  return /not enough space|insufficient storage/i.test([
    error?.message,
    error?.stdout,
    error?.stderr
  ].filter(Boolean).join('\n'));
}

async function installIsolatedApk({ adbCommand, serial, path }) {
  const install = () => execFileAsync(adbCommand, ['-s', serial, 'install', '-r', path], {
    windowsHide: true,
    timeout: 3 * 60 * 1000,
    maxBuffer: 12 * 1024 * 1024,
    encoding: 'utf8'
  });
  try {
    const result = await install();
    return { result, recovery: { attempted: false, isolatedPackageRemoved: false } };
  } catch (error) {
    if (!isInsufficientStorageError(error)) throw error;
    const removal = await execFileAsync(adbCommand, ['-s', serial, 'uninstall', packageName], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    }).catch(() => null);
    const result = await install();
    return {
      result,
      recovery: {
        attempted: true,
        reason: 'insufficient-storage',
        isolatedPackageRemoved: String(removal?.stdout ?? '').includes('Success'),
        primaryPackageTouched: false
      }
    };
  }
}

export function createMobileE2EInstallPlan({
  targetArchitectures = ['arm64-v8a'],
  deviceAbis = [],
  architectureSource = 'physical-device-default',
  artifactPath = defaultApkPath
} = {}) {
  const buildTimeoutMs = resolveBuildTimeoutMs();
  const normalizedArchitectures = normalizeArchitectures(targetArchitectures);
  const architectureProperty = normalizedArchitectures.join(',');
  return {
    planVersion: 'c-mobile-isolated-e2e-install-plan-v3',
    packageName,
    gradleCommand,
    gradleArguments: [
      'assembleDebug',
      '-Pjarvis.e2e=true',
      `-PreactNativeArchitectures=${architectureProperty}`,
      `-Pjarvis.targetAbis=${architectureProperty}`,
      '-PnewArchEnabled=false',
      '--no-daemon'
    ],
    buildTimeoutMs,
    apkPath: artifactPath,
    isolation: {
      applicationIdSuffix: '.e2e',
      primaryPackageUntouched: true,
      separateSecureStoreNamespace: true
    },
    buildProfile: {
      targetArchitectures: normalizedArchitectures,
      deviceAbis: normalizeArchitectures(deviceAbis),
      architectureSource,
      newArchitecture: false,
      purpose: 'device-adaptive-isolated-e2e'
    }
  };
}

export async function runMobileE2EInstall({
  build = true,
  install = true,
  serial = process.env.JARVIS_MOBILE_DEVICE_SERIAL ?? '',
  artifactPath = process.env.JARVIS_MOBILE_E2E_APK ?? defaultApkPath,
  jsonPath = 'dist/mobile-e2e-install-report.json',
  markdownPath = 'dist/mobile-e2e-install-report.md'
} = {}) {
  let plan = createMobileE2EInstallPlan({ artifactPath });
  const report = {
    reportVersion: 'c-mobile-isolated-e2e-install-report-v1',
    generatedAt: new Date().toISOString(),
    status: 'running',
    plan,
    build: { requested: build, passed: false },
    install: { requested: install, passed: false },
    device: null,
    privacy: {
      primaryPackageDataCleared: false,
      rawDeviceTokenStored: false,
      rawSigningCredentialStored: false
    }
  };

  try {
    const probe = await listAndroidDevices();
    if (!probe.available) throw new Error('adb-not-available');
    const device = selectMobileE2EDevice({ devices: probe.devices, requestedSerial: serial });
    const adb = await resolveAdbCommand();
    const deviceAbis = await readDeviceAbis(adb.command, device.serial);
    const requestedArchitectures = normalizeArchitectures(process.env.JARVIS_MOBILE_E2E_ARCHS);
    const targetArchitectures = selectMobileE2ETargetArchitectures({ deviceAbis, requestedArchitectures });
    plan = createMobileE2EInstallPlan({
      targetArchitectures,
      deviceAbis,
      architectureSource: requestedArchitectures.length > 0 ? 'environment-compatible-selection' : 'connected-device-primary-abi',
      artifactPath
    });
    report.plan = plan;
    report.device = {
      serial: device.serial,
      state: device.state,
      abis: deviceAbis,
      targetArchitectures
    };
    report.storage = { beforeBuild: await readDeviceStorage(adb.command, device.serial) };

    if (build) {
      const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : gradleCommand;
      const args = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'gradlew.bat', ...plan.gradleArguments]
        : plan.gradleArguments;
      const result = await runBuildProcess(executable, args, {
        cwd: androidRoot,
        timeoutMs: plan.buildTimeoutMs,
        env: {
          ...process.env,
          NODE_ENV: process.env.NODE_ENV ?? 'production'
        }
      });
      report.build = {
        requested: true,
        passed: await exists(artifactPath),
        exitCode: 0,
        apkBytes: await stat(artifactPath).then((value) => value.size).catch(() => null),
        targetArchitectures,
        outputTail: String(result.stdout ?? '').split(/\r?\n/).slice(-12)
      };
    } else {
      report.build = {
        requested: false,
        passed: await exists(artifactPath),
        reusedExistingApk: true,
        apkBytes: await stat(artifactPath).then((value) => value.size).catch(() => null),
        targetArchitectures
      };
    }
    if (!report.build.passed) throw new Error('isolated E2E APK was not produced');

    if (install) {
      const installation = await installIsolatedApk({ adbCommand: adb.command, serial: device.serial, path: artifactPath });
      const packageProbe = await execFileAsync(adb.command, ['-s', device.serial, 'shell', 'pm', 'path', packageName], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8'
      });
      report.install = {
        requested: true,
        passed: String(installation.result.stdout ?? '').includes('Success') && String(packageProbe.stdout ?? '').includes(packageName),
        installerStatus: String(installation.result.stdout ?? '').trim(),
        packagePathPresent: String(packageProbe.stdout ?? '').includes(packageName),
        recovery: installation.recovery
      };
    } else {
      report.install = { requested: false, passed: true, skipped: true };
    }
    report.storage.afterInstall = await readDeviceStorage(adb.command, device.serial);
    report.status = report.build.passed && report.install.passed ? 'passed' : 'blocked';
  } catch (error) {
    report.status = 'blocked';
    report.error = {
      code: error.code ?? null,
      message: error.message ?? String(error),
      stdoutTail: String(error.stdout ?? '').split(/\r?\n/).slice(-20),
      stderrTail: String(error.stderr ?? '').split(/\r?\n/).slice(-20)
    };
  }

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, [
    '# JARVIS Mobile Isolated E2E Install',
    '',
    `Status: ${report.status}`,
    `Package: ${packageName}`,
    `Build: ${report.build.passed}`,
    `Install: ${report.install.passed}`,
    `Primary package data cleared: ${report.privacy.primaryPackageDataCleared}`,
    ''
  ].join('\n'), 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skipBuild = process.argv.includes('--skip-build');
  const serialIndex = process.argv.indexOf('--serial');
  const serial = serialIndex >= 0 ? process.argv[serialIndex + 1] : process.env.JARVIS_MOBILE_DEVICE_SERIAL;
  const apkIndex = process.argv.indexOf('--apk');
  const artifactPath = apkIndex >= 0 ? resolve(process.argv[apkIndex + 1]) : process.env.JARVIS_MOBILE_E2E_APK;
  const report = await runMobileE2EInstall({ build: !skipBuild && !artifactPath, serial, artifactPath });
  console.log('# JARVIS Mobile Isolated E2E Install');
  console.log(`Status: ${report.status}`);
  console.log(`Package: ${packageName}`);
  console.log(`Build: ${report.build.passed}`);
  console.log(`Install: ${report.install.passed}`);
  console.log('Reports: dist/mobile-e2e-install-report.json, dist/mobile-e2e-install-report.md');
  if (report.status !== 'passed') process.exitCode = 1;
}
