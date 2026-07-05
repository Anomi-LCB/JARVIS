import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createAndroidSetupPlan } from './mobile-android-setup.mjs';
import { stabilizeAndroidGradle } from './mobile-android-stabilize-gradle.mjs';
import { resolveAdbCommand } from './mobile-device-smoke.mjs';

const execFileAsync = promisify(execFile);
const packageName = 'local.eureka.jarvis';
const defaultAppDir = 'apps/mobile';
const defaultVariant = 'release';
const defaultGradleTimeoutMs = 10 * 60 * 1000;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function sdkRoot(env = process.env) {
  return env.ANDROID_HOME
    ?? env.ANDROID_SDK_ROOT
    ?? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : null);
}

function gradleDistributionCommand(env = process.env) {
  const home = env.USERPROFILE ?? env.HOME;
  if (!home) return null;
  return join(home, '.gradle', 'wrapper', 'dists', 'gradle-8.13-bin', '5xuhj0ry160q40clulazy9h7d', 'gradle-8.13', 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
}

function preferredJavaHome(env = process.env) {
  if (env.JARVIS_ANDROID_JAVA_HOME) return env.JARVIS_ANDROID_JAVA_HOME;
  if (process.platform === 'win32') return 'C:\\Program Files\\Microsoft\\jdk-17.0.18.8-hotspot';
  return env.JAVA_HOME;
}

async function apkInfo(apkPath) {
  if (!await exists(apkPath)) return { exists: false, path: apkPath, bytes: 0, modifiedAt: null };
  const item = await stat(apkPath);
  return { exists: true, path: apkPath, bytes: item.size, modifiedAt: item.mtime.toISOString() };
}

async function listDevices(adbResolution) {
  try {
    const { stdout } = await execFileAsync(adbResolution.command, ['devices', '-l'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    const devices = stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...details] = line.split(/\s+/);
        return { serial, state, details: details.join(' ') };
      });
    return { available: true, devices, error: null };
  } catch (error) {
    return { available: false, devices: [], error: error.code ?? error.message };
  }
}

async function packageStatus(adbResolution, serial) {
  if (!serial) return { installed: false, installedPath: null, error: 'no-ready-device' };
  try {
    const { stdout } = await execFileAsync(adbResolution.command, ['-s', serial, 'shell', 'pm', 'path', packageName], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    return { installed: stdout.includes(packageName), installedPath: stdout.trim() || null, error: null };
  } catch (error) {
    return { installed: false, installedPath: null, error: error.code ?? error.message };
  }
}

function normalizeVariant(variant = defaultVariant) {
  const normalized = String(variant || defaultVariant).toLowerCase();
  if (!['debug', 'release'].includes(normalized)) {
    throw new Error(`Unsupported Android variant: ${variant}`);
  }
  return normalized;
}

function variantLabel(variant) {
  return normalizeVariant(variant);
}

function variantTaskName(variant) {
  const label = variantLabel(variant);
  return `app:assemble${label[0].toUpperCase()}${label.slice(1)}`;
}

function apkPathForVariant(androidDir, variant) {
  const label = variantLabel(variant);
  return join(androidDir, 'app', 'build', 'outputs', 'apk', label, `app-${label}.apk`);
}

function createInstallPlan({ appDir = defaultAppDir, selectedDevice = 'emulator-5554', variant = defaultVariant } = {}) {
  const label = variantLabel(variant);
  return {
    appDir,
    packageName,
    selectedDevice,
    variant: label,
    commands: [
      {
        id: 'install-dependencies',
        command: 'corepack pnpm install --filter @jarvis/mobile...',
        expected: 'Expo, React Native, and native module dependencies are available.'
      },
      {
        id: 'prebuild-android',
        command: 'corepack pnpm --filter @jarvis/mobile exec expo prebuild --platform android --no-install',
        expected: 'Native Android project exists under apps/mobile/android.'
      },
      {
        id: 'start-emulator',
        command: 'npm run mobile:emulator -- --start --wait --avd Medium_Phone_API_36.1',
        expected: 'ADB sees a ready emulator/device.'
      },
      {
        id: `build-${label}-apk`,
        command: `npm run mobile:android-install -- --build --variant ${label}`,
        expected: `Gradle produces app-${label}.apk.`
      },
      {
        id: `install-${label}-apk`,
        command: `npm run mobile:android-install -- --install --variant ${label} --device ${selectedDevice}`,
        expected: `${packageName} is installed on the selected Android device.`
      },
      {
        id: 'capture-device-smoke',
        command: 'npm run mobile:device',
        expected: 'Launch, screenshot, UI XML, and native runtime probe evidence are captured.'
      }
    ]
  };
}

function createBuildSummary({ exitCode, timedOut, output, errorOutput }) {
  const combined = `${output}\n${errorOutput}`;
  const timeoutDetected = /TimeoutException|timed out|GRADLE_TIMEOUT/i.test(combined) || timedOut;
  return {
    attempted: true,
    exitCode,
    timedOut,
    timeoutDetected,
    kotlinDslTimeoutDetected: /ProjectAccessorsClassPathGenerator|GenerateProjectAccessors|DefaultAsyncIOScopeFactory|Kotlin DSL/i.test(combined)
      && /TimeoutException|timed out/i.test(combined),
    lastOutputLines: output.split(/\r?\n/).filter(Boolean).slice(-40),
    lastErrorLines: errorOutput.split(/\r?\n/).filter(Boolean).slice(-40)
  };
}

async function killProcessTree(pid) {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // process already exited
    }
    return;
  }
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024
  }).catch(() => {});
}

async function runGradleBuild({ appDir, gradleCommand, variant = defaultVariant, timeoutMs = defaultGradleTimeoutMs, logPath, errorLogPath, env = process.env }) {
  await mkdir(dirname(logPath), { recursive: true });
  const outputChunks = [];
  const errorChunks = [];
  const args = [
    variantTaskName(variant),
    '-x',
    'lint',
    '-x',
    'test',
    '--console=plain',
    '--stacktrace',
    '--build-cache',
    '--no-watch-fs',
    // 실기기(arm64) + 에뮬레이터(x86_64)를 모두 포함한다. x86_64 단독 하드코딩은
    // 실폰에서 libexpo-modules-core.so 누락 즉시 크래시를 만들었던 원인이다.
    `-PreactNativeArchitectures=${env.JARVIS_ANDROID_ARCHS ?? 'armeabi-v7a,arm64-v8a,x86,x86_64'}`,
    '-PnewArchEnabled=false'
  ];
  const javaHome = preferredJavaHome(env);
  const javaPathEnv = javaHome
    ? process.platform === 'win32'
      ? { Path: `${join(javaHome, 'bin')};${env.Path ?? env.PATH ?? ''}` }
      : { PATH: `${join(javaHome, 'bin')}:${env.PATH ?? env.Path ?? ''}` }
    : {};
  const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : gradleCommand;
  const spawnArgs = process.platform === 'win32'
    ? ['/d', '/c', gradleCommand, ...args]
    : args;
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd: resolve(appDir, 'android'),
        env: {
          ...env,
          NODE_ENV: env.NODE_ENV ?? 'production',
          ...(javaHome ? { JAVA_HOME: javaHome, ...javaPathEnv } : {}),
          ANDROID_HOME: sdkRoot(env) ?? env.ANDROID_HOME,
          ANDROID_SDK_ROOT: sdkRoot(env) ?? env.ANDROID_SDK_ROOT
        },
        windowsHide: true
      });
    } catch (error) {
      resolvePromise(createBuildSummary({
        exitCode: error.code ?? 1,
        timedOut: false,
        output: '',
        errorOutput: error.message
      }));
      return;
    }
    let finished = false;
    const timer = setTimeout(async () => {
      if (finished) return;
      finished = true;
      await killProcessTree(child.pid);
      const output = Buffer.concat(outputChunks).toString('utf8');
      const errorOutput = Buffer.concat(errorChunks).toString('utf8');
      await writeFile(logPath, output, 'utf8');
      await writeFile(errorLogPath, errorOutput, 'utf8');
      resolvePromise(createBuildSummary({ exitCode: null, timedOut: true, output, errorOutput }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => outputChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errorChunks.push(Buffer.from(chunk)));
    child.on('error', async (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const output = Buffer.concat(outputChunks).toString('utf8');
      const errorOutput = `${Buffer.concat(errorChunks).toString('utf8')}\n${error.message}`;
      await writeFile(logPath, output, 'utf8');
      await writeFile(errorLogPath, errorOutput, 'utf8');
      resolvePromise(createBuildSummary({ exitCode: error.code ?? 1, timedOut: false, output, errorOutput }));
    });
    child.on('exit', async (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const output = Buffer.concat(outputChunks).toString('utf8');
      const errorOutput = Buffer.concat(errorChunks).toString('utf8');
      await writeFile(logPath, output, 'utf8');
      await writeFile(errorLogPath, errorOutput, 'utf8');
      resolvePromise(createBuildSummary({ exitCode, timedOut: false, output, errorOutput }));
    });
  });
}

async function installApk({ adbResolution, serial, apkPath }) {
  if (!serial) return { attempted: false, success: false, error: 'no-ready-device' };
  if (!await exists(apkPath)) return { attempted: false, success: false, error: 'apk-not-found' };
  try {
    const { stdout, stderr } = await execFileAsync(adbResolution.command, ['-s', serial, 'install', '-r', apkPath], {
      windowsHide: true,
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    });
    return { attempted: true, success: /Success/i.test(stdout) || /Success/i.test(stderr), stdout, stderr, error: null };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      error: error.code ?? error.message,
      message: error.message
    };
  }
}

function statusFor({ build, apk, install, packageProbe, readyDevices, nativeProject }) {
  if (build.attempted && (build.exitCode !== 0 || build.timedOut || build.kotlinDslTimeoutDetected)) return 'build-blocked';
  if (install.attempted && install.success === false) return 'install-blocked';
  if (packageProbe.installed) return 'installed';
  if (apk.exists) return readyDevices.length > 0 ? 'apk-ready' : 'apk-ready-no-device';
  if (nativeProject.exists && readyDevices.length > 0) return 'ready-to-build';
  if (nativeProject.exists) return 'ready-to-build-no-device';
  return 'blocked';
}

function nextActions(report) {
  if (report.status === 'installed') {
    return ['Run npm run mobile:device to capture launch, screenshot, UI XML, and native runtime probe evidence.'];
  }
  if (report.status === 'build-blocked') {
    const actions = ['Review dist/mobile-android-gradle-build.out.log and dist/mobile-android-gradle-build.err.log.'];
    if (report.gradle.build.kotlinDslTimeoutDetected) {
      actions.push('The current evidence points to Gradle Kotlin DSL/project accessor timeout during first Android build.');
      actions.push(`Retry npm run mobile:android-install -- --build --variant ${report.variant} after Gradle caches settle, or build from Android Studio once to warm caches.`);
    } else if (report.gradle.build.timedOut) {
      actions.push('The Gradle build exceeded the configured timeout; retry with a larger --timeout-ms after checking the log tail.');
    } else {
      actions.push(`Fix the Gradle error tail above, then rerun npm run mobile:android-install -- --build --variant ${report.variant}.`);
    }
    return actions;
  }
  if (report.status === 'apk-ready' || report.status === 'install-blocked') {
    return [`Run npm run mobile:android-install -- --install --variant ${report.variant} --device ${report.selectedDevice}.`];
  }
  if (report.status === 'ready-to-build') {
    return [`Run npm run mobile:android-install -- --build --variant ${report.variant}, then npm run mobile:android-install -- --install --variant ${report.variant}.`];
  }
  return [
    'Run corepack pnpm install --filter @jarvis/mobile...',
    'Run corepack pnpm --filter @jarvis/mobile exec expo prebuild --platform android --no-install.',
    'Run npm run mobile:emulator -- --start --wait, then npm run mobile:android-install -- --build --install.'
  ];
}

export async function runAndroidInstallVerification({
  appDir = defaultAppDir,
  variant = defaultVariant,
  build = false,
  install = false,
  device,
  timeoutMs = defaultGradleTimeoutMs,
  env = process.env,
  jsonPath = 'dist/mobile-android-install-report.json',
  markdownPath = 'dist/mobile-android-install-report.md',
  htmlPath = 'dist/mobile-android-install-report.html'
} = {}) {
  const selectedVariant = normalizeVariant(variant);
  const setupPlan = createAndroidSetupPlan({ env });
  const resolutionEnv = { ...env, JARVIS_ANDROID_TOOLS_HOME: setupPlan.toolsHome };
  const adbResolution = await resolveAdbCommand({ env: resolutionEnv });
  const devices = await listDevices(adbResolution);
  const readyDevices = devices.devices.filter((item) => item.state === 'device');
  const selectedDevice = device ?? readyDevices[0]?.serial ?? 'emulator-5554';
  const androidDir = join(appDir, 'android');
  const nativeProject = {
    exists: await exists(androidDir),
    gradlew: await exists(join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')),
    appBuildGradle: await exists(join(androidDir, 'app', 'build.gradle'))
  };
  const apkPath = apkPathForVariant(androidDir, selectedVariant);
  const gradleWrapper = resolve(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const gradleCommand = await exists(gradleWrapper) ? gradleWrapper : gradleDistributionCommand(env);
  let stabilization = {
    attempted: false,
    status: 'not-requested'
  };
  let buildResult = {
    attempted: false,
    exitCode: null,
    timedOut: false,
    timeoutDetected: false,
    kotlinDslTimeoutDetected: false,
    lastOutputLines: [],
    lastErrorLines: []
  };
  if (build) {
    try {
      stabilization = {
        attempted: true,
        ...await stabilizeAndroidGradle({ appDir })
      };
    } catch (error) {
      stabilization = {
        attempted: true,
        status: 'failed',
        error: error.code ?? error.message
      };
    }
    buildResult = await runGradleBuild({
      appDir,
      gradleCommand,
      variant: selectedVariant,
      timeoutMs,
      env,
      logPath: 'dist/mobile-android-gradle-build.out.log',
      errorLogPath: 'dist/mobile-android-gradle-build.err.log'
    });
  }
  const apk = await apkInfo(apkPath);
  const installResult = install
    ? await installApk({ adbResolution, serial: selectedDevice, apkPath })
    : { attempted: false, success: false, error: null };
  const packageProbe = await packageStatus(adbResolution, selectedDevice);
  const reportDraft = {
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    appDir,
    packageName,
    variant: selectedVariant,
    selectedDevice,
    plan: createInstallPlan({ appDir, selectedDevice, variant: selectedVariant }),
    sdkRoot: sdkRoot(env),
    adb: {
      command: adbResolution.command,
      source: adbResolution.source,
      devices
    },
    nativeProject,
    gradle: {
      command: gradleCommand,
      javaHome: preferredJavaHome(env),
      timeoutMs,
      stabilization,
      build: buildResult
    },
    apk,
    install: installResult,
    packageProbe,
    nextActions: []
  };
  const report = {
    ...reportDraft,
    status: statusFor({ build: buildResult, apk, install: installResult, packageProbe, readyDevices, nativeProject })
  };
  report.nextActions = nextActions(report);
  report.artifacts = await writeAndroidInstallArtifacts(report, { jsonPath, markdownPath, htmlPath });
  return report;
}

export function renderAndroidInstallMarkdown(report) {
  const lines = [
    '# JARVIS Android Install Verification',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Package: ${report.packageName}`,
    `Variant: ${report.variant}`,
    `Selected device: ${report.selectedDevice}`,
    `Native project: ${report.nativeProject.exists}`,
    `APK exists: ${report.apk.exists}`,
    `Package installed: ${report.packageProbe.installed}`,
    '',
    '## Commands'
  ];
  for (const command of report.plan.commands) {
    lines.push(`- ${command.id}: \`${command.command}\` -> ${command.expected}`);
  }
  lines.push('', '## Gradle');
  lines.push(`- Command: ${report.gradle.command}`);
  lines.push(`- Variant: ${report.variant}`);
  lines.push(`- Java home: ${report.gradle.javaHome ?? 'default'}`);
  lines.push(`- Stabilization: ${report.gradle.stabilization.status}`);
  lines.push(`- Build attempted: ${report.gradle.build.attempted}`);
  lines.push(`- Exit code: ${report.gradle.build.exitCode ?? 'none'}`);
  lines.push(`- Timed out: ${report.gradle.build.timedOut}`);
  lines.push(`- Kotlin DSL timeout: ${report.gradle.build.kotlinDslTimeoutDetected}`);
  if (report.gradle.build.lastErrorLines.length) {
    lines.push('', '## Gradle Error Tail');
    for (const line of report.gradle.build.lastErrorLines.slice(-20)) lines.push(`- ${line}`);
  }
  lines.push('', '## Devices');
  if (report.adb.devices.devices.length === 0) {
    lines.push('- none');
  } else {
    for (const item of report.adb.devices.devices) lines.push(`- ${item.serial}: ${item.state} ${item.details}`);
  }
  lines.push('', '## Next Actions');
  for (const action of report.nextActions) lines.push(`- ${action}`);
  return `${lines.join('\n')}\n`;
}

export function renderAndroidInstallHtml(report) {
  const commands = report.plan.commands.map((item) => `<li>${htmlEscape(item.id)}: <code>${htmlEscape(item.command)}</code> - ${htmlEscape(item.expected)}</li>`).join('');
  const actions = report.nextActions.map((item) => `<li>${htmlEscape(item)}</li>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS Android Install Verification</title></head>
<body>
  <h1>JARVIS Android Install Verification</h1>
  <p>Status: ${htmlEscape(report.status)}</p>
  <p>Variant: ${htmlEscape(report.variant)}</p>
  <p>Package installed: ${htmlEscape(report.packageProbe.installed)}</p>
  <h2>Commands</h2>
  <ul>${commands}</ul>
  <h2>Report</h2>
  <p>Gradle stabilization: ${htmlEscape(report.gradle.stabilization.status)}</p>
  <pre>${htmlEscape(JSON.stringify(report, null, 2))}</pre>
  <h2>Next Actions</h2>
  <ul>${actions}</ul>
</body>
</html>
`;
}

export async function writeAndroidInstallArtifacts(report, {
  jsonPath = 'dist/mobile-android-install-report.json',
  markdownPath = 'dist/mobile-android-install-report.md',
  htmlPath = 'dist/mobile-android-install-report.html'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderAndroidInstallMarkdown(report), 'utf8');
  await writeFile(htmlPath, renderAndroidInstallHtml(report), 'utf8');
  return { jsonPath, markdownPath, htmlPath };
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build') options.build = true;
    if (arg === '--install') options.install = true;
    if (arg === '--variant') options.variant = argv[index + 1];
    if (arg === '--debug') options.variant = 'debug';
    if (arg === '--release') options.variant = 'release';
    if (arg === '--device') options.device = argv[index + 1];
    if (arg === '--timeout-ms') options.timeoutMs = Number(argv[index + 1]);
    if (arg === '--json') options.jsonPath = argv[index + 1];
    if (arg === '--md') options.markdownPath = argv[index + 1];
    if (arg === '--html') options.htmlPath = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runAndroidInstallVerification(cliOptions(process.argv.slice(2)));
  console.log('# JARVIS Android Install Verification');
  console.log(`Status: ${report.status}`);
  console.log(`Variant: ${report.variant}`);
  console.log(`Selected device: ${report.selectedDevice}`);
  console.log(`APK exists: ${report.apk.exists}`);
  console.log(`Package installed: ${report.packageProbe.installed}`);
  console.log(`Reports: ${report.artifacts.jsonPath}, ${report.artifacts.markdownPath}, ${report.artifacts.htmlPath}`);
  if (['blocked', 'build-blocked', 'install-blocked'].includes(report.status)) process.exitCode = 1;
}
