import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { listAndroidDevices, resolveAdbCommand } from './mobile-device-smoke.mjs';

const execFileAsync = promisify(execFile);
const runnerPackage = 'local.eureka.jarvis.wearablefield';
const runnerComponent = `${runnerPackage}/.FieldLabActivity`;
const defaultFieldUrl = 'http://127.0.0.1:4176/field-calibration.html';
const defaultProjectDir = 'apps/wearable-field-runner';
const defaultApkPath = `${defaultProjectDir}/app/build/outputs/apk/debug/app-debug.apk`;

export async function runWearableFieldRunner({
  workspaceRoot = process.cwd(),
  serial = process.env.JARVIS_WEARABLE_DEVICE_SERIAL ?? '',
  fieldUrl = defaultFieldUrl,
  build = true,
  install = true,
  launch = true,
  jsonPath = 'dist/wearable-field-runner-report.json',
  markdownPath = 'dist/wearable-field-runner-report.md',
  env = process.env,
  timeoutMs = 600_000
} = {}) {
  if (!isAllowedFieldUrl(fieldUrl)) throw new Error('wearable-field-url-not-loopback');
  const root = resolve(workspaceRoot);
  const projectDir = resolve(root, defaultProjectDir);
  const apkPath = resolve(root, defaultApkPath);
  const reportPath = resolve(root, jsonPath);
  const report = {
    reportVersion: 'c-d-wearable-field-runner-report-v1',
    generatedAt: new Date().toISOString(),
    status: 'running',
    runner: {
      packageName: runnerPackage,
      component: runnerComponent,
      securityProfile: 'loopback-webview-native-audio-v2'
    },
    device: null,
    fieldServer: { ready: false, secureContext: true, url: publicFieldUrl(fieldUrl) },
    build: { requested: build, passed: !build },
    install: { requested: install, passed: !install },
    reverse: { hud: false, bridge: false },
    launch: { requested: launch, passed: !launch },
    privacy: {
      rawDeviceSerialStored: false,
      rawBridgeTokenStored: false,
      rawTranscriptStored: false,
      rawAudioStored: false
    }
  };

  try {
    const fieldResponse = await fetch(fieldUrl, { signal: AbortSignal.timeout(5_000) });
    const fieldHtml = await fieldResponse.text();
    report.fieldServer = {
      ...report.fieldServer,
      ready: fieldResponse.ok && fieldHtml.includes('jarvis-wearable-field-lab'),
      httpStatus: fieldResponse.status
    };
    if (!report.fieldServer.ready) throw new Error('wearable-field-server-not-ready');

    const probe = await listAndroidDevices();
    const device = selectWearableDevice({ devices: probe.devices, requestedSerial: serial });
    const adb = await resolveAdbCommand();
    const model = await adbShell(adb.command, device.serial, ['getprop', 'ro.product.model']);
    const sdk = await adbShell(adb.command, device.serial, ['getprop', 'ro.build.version.sdk']);
    const display = await adbShell(adb.command, device.serial, ['wm', 'size']);
    report.device = {
      fingerprint: shortHash(device.serial),
      state: device.state,
      model: cleanDeviceLabel(model),
      sdk: Number.parseInt(sdk, 10) || null,
      display: cleanDeviceLabel(display),
      physicalDevice: !/emulator|sdk_gphone/i.test(`${model} ${device.serial}`)
    };

    if (build) {
      const sdkRoot = await resolveAndroidSdk({ root, env });
      const invocation = createGradleBuildInvocation({ root, projectDir, env });
      const result = await execFileAsync(invocation.command, invocation.args, {
        cwd: root,
        env: { ...env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      });
      report.build = {
        requested: true,
        passed: await fileExists(apkPath),
        gradleExit: 'completed',
        outputFingerprint: shortHash(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
      };
    }
    if (!(await fileExists(apkPath))) throw new Error('wearable-field-runner-apk-missing');
    const apk = await readFile(apkPath);
    const apkInfo = await stat(apkPath);
    report.artifact = {
      apkSha256: createHash('sha256').update(apk).digest('hex'),
      apkBytes: apkInfo.size,
      packageName: runnerPackage
    };

    if (install) {
      const installed = await adbExec(adb.command, ['-s', device.serial, 'install', '-r', apkPath], 120_000);
      report.install = {
        requested: true,
        passed: /success/i.test(installed.stdout),
        status: /success/i.test(installed.stdout) ? 'installed' : 'failed'
      };
      if (!report.install.passed) throw new Error('wearable-field-runner-install-failed');
    }

    await adbExec(adb.command, ['-s', device.serial, 'reverse', 'tcp:4176', 'tcp:4176'], 15_000);
    await adbExec(adb.command, ['-s', device.serial, 'reverse', 'tcp:17777', 'tcp:17777'], 15_000);
    const reverseList = await adbExec(adb.command, ['-s', device.serial, 'reverse', '--list'], 15_000);
    report.reverse = {
      hud: reverseList.stdout.includes('tcp:4176 tcp:4176'),
      bridge: reverseList.stdout.includes('tcp:17777 tcp:17777')
    };
    if (!report.reverse.hud || !report.reverse.bridge) throw new Error('wearable-field-runner-reverse-failed');

    await adbExec(adb.command, ['-s', device.serial, 'shell', 'pm', 'grant', runnerPackage, 'android.permission.RECORD_AUDIO'], 15_000)
      .catch(() => null);
    if (launch) {
      const launched = await adbExec(adb.command, [
        '-s', device.serial,
        'shell', 'am', 'start', '-W',
        '-n', runnerComponent,
        '--es', 'url', fieldUrl
      ], 45_000);
      await delay(1_500);
      const focus = await adbShell(adb.command, device.serial, ['dumpsys', 'window']);
      const packagePath = await adbShell(adb.command, device.serial, ['pm', 'path', runnerPackage]);
      const focused = focus.includes(runnerPackage);
      report.launch = {
        requested: true,
        passed: focused && packagePath.includes(runnerPackage),
        activityStatus: /status:\s*ok/i.test(launched.stdout) ? 'ok' : 'completed',
        focused,
        packageInstalled: packagePath.includes(runnerPackage)
      };
      if (!report.launch.passed) throw new Error('wearable-field-runner-launch-failed');
    }

    report.status = report.fieldServer.ready
      && report.build.passed
      && report.install.passed
      && report.reverse.hud
      && report.reverse.bridge
      && report.launch.passed ? 'passed' : 'blocked';
    report.nextAction = report.status === 'passed'
      ? 'Run objective display, microphone, voice, and bridge measurements on the glasses; confirm subjective scenarios physically.'
      : 'Inspect the blocked runner stage and retry deployment.';
  } catch (error) {
    report.status = 'blocked';
    report.failure = classifyFailure(error);
    report.nextAction = nextActionForFailure(report.failure.code);
  }

  await writeReport(report, { reportPath, markdownPath: resolve(root, markdownPath) });
  return report;
}

export function createGradleBuildInvocation({
  root,
  projectDir,
  env = process.env,
  platform = process.platform
}) {
  const gradleArgs = ['-p', projectDir, ':app:assembleDebug', '--no-daemon'];
  if (platform === 'win32') {
    return {
      command: env.ComSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', resolve(root, 'apps/mobile/android/gradlew.bat'), ...gradleArgs]
    };
  }
  return {
    command: resolve(root, 'apps/mobile/android/gradlew'),
    args: gradleArgs
  };
}

export function selectWearableDevice({ devices = [], requestedSerial = '' } = {}) {
  const ready = devices.filter((device) => device.state === 'device');
  const requested = String(requestedSerial ?? '').trim();
  if (requested) {
    const match = ready.find((device) => device.serial === requested);
    if (!match) throw new Error('requested-wearable-device-not-ready');
    return match;
  }
  if (ready.length === 0) throw new Error('no-ready-wearable-device');
  if (ready.length > 1) throw new Error('multiple-ready-devices-require-serial');
  return ready[0];
}

export function isAllowedFieldUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase())
      && Number(url.port || 80) === 4176
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function parseWearableFieldRunnerArgs(argv = [], { env = process.env } = {}) {
  const options = { serial: env.JARVIS_WEARABLE_DEVICE_SERIAL ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--serial' && argv[index + 1]) options.serial = argv[++index];
    else if (value === '--url' && argv[index + 1]) options.fieldUrl = argv[++index];
    else if (value === '--skip-build') options.build = false;
    else if (value === '--skip-install') options.install = false;
    else if (value === '--skip-launch') options.launch = false;
    else if ((value === '--json' || value === '--output') && argv[index + 1]) options.jsonPath = argv[++index];
    else if (value === '--markdown' && argv[index + 1]) options.markdownPath = argv[++index];
  }
  return options;
}

async function resolveAndroidSdk({ root, env }) {
  for (const candidate of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (candidate && await fileExists(candidate)) return resolve(candidate);
  }
  const localProperties = await readFile(resolve(root, 'apps/mobile/android/local.properties'), 'utf8').catch(() => '');
  const match = localProperties.match(/^sdk\.dir=(.+)$/m);
  if (match) {
    const value = match[1].trim().replace(/\\\\/g, '\\');
    if (await fileExists(value)) return resolve(value);
  }
  throw new Error('android-sdk-not-found');
}

async function adbExec(adb, args, timeout = 30_000) {
  return await execFileAsync(adb, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
}

async function adbShell(adb, serial, command) {
  const result = await adbExec(adb, ['-s', serial, 'shell', ...command], 30_000);
  return String(result.stdout ?? '').trim();
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeReport(report, { reportPath, markdownPath }) {
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
}

function renderMarkdown(report) {
  return [
    '# JARVIS Wearable Field Runner',
    '',
    `- Status: **${report.status}**`,
    `- Device: **${report.device?.model ?? 'unavailable'}**`,
    `- Field server: **${report.fieldServer?.ready === true ? 'ready' : 'blocked'}**`,
    `- APK build: **${report.build?.passed === true ? 'passed' : 'blocked'}**`,
    `- APK install: **${report.install?.passed === true ? 'passed' : 'blocked'}**`,
    `- HUD reverse: **${report.reverse?.hud === true ? 'passed' : 'blocked'}**`,
    `- Bridge reverse: **${report.reverse?.bridge === true ? 'passed' : 'blocked'}**`,
    `- Launch: **${report.launch?.passed === true ? 'passed' : 'blocked'}**`,
    '',
    `Next: ${report.nextAction}`,
    '',
    'The report stores a short device fingerprint, never the raw ADB serial.',
    ''
  ].join('\n');
}

function classifyFailure(error) {
  const code = String(error?.message ?? error ?? 'wearable-field-runner-failed')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .slice(0, 120) || 'wearable-field-runner-failed';
  return {
    code,
    fingerprint: shortHash(String(error?.stack ?? error?.message ?? error)),
    rawErrorStored: false
  };
}

function nextActionForFailure(code) {
  if (code.includes('field-server')) return 'Start the wearable field server on port 4176, then retry.';
  if (code.includes('multiple-ready')) return 'Pass --serial for the target glasses.';
  if (code.includes('android-sdk')) return 'Configure ANDROID_HOME or apps/mobile/android/local.properties.';
  if (code.includes('install')) return 'Check device storage and Android package installation policy.';
  return 'Inspect local build and ADB readiness, then retry the runner.';
}

function publicFieldUrl(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}:${url.port}${url.pathname}`;
}

function cleanDeviceLabel(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || null;
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runWearableFieldRunner(parseWearableFieldRunnerArgs(process.argv.slice(2)));
  console.log('# JARVIS Wearable Field Runner');
  console.log(`Status: ${report.status}`);
  console.log(`Device: ${report.device?.model ?? 'unavailable'}`);
  console.log(`Field server: ${report.fieldServer.ready}`);
  console.log(`Build: ${report.build.passed}`);
  console.log(`Install: ${report.install.passed}`);
  console.log(`Launch: ${report.launch.passed}`);
  console.log('Reports: dist/wearable-field-runner-report.json, dist/wearable-field-runner-report.md');
  if (report.status !== 'passed') process.exitCode = 1;
}
