import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const androidPackageName = 'local.eureka.jarvis';
const adbBinaryName = process.platform === 'win32' ? 'adb.exe' : 'adb';
const defaultLaunchWaitMs = 3000;

function localAndroidToolsHome(env = process.env) {
  if (env.JARVIS_ANDROID_TOOLS_HOME) return env.JARVIS_ANDROID_TOOLS_HOME;
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'Jarvis', 'Android');
  if (env.USERPROFILE) return join(env.USERPROFILE, 'AppData', 'Local', 'Jarvis', 'Android');
  return null;
}

function sanitizeSerial(serial) {
  return String(serial).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function adbCandidatePaths(env = process.env) {
  const jarvisToolsHome = localAndroidToolsHome(env);
  const candidates = [
    { command: env.JARVIS_ADB_PATH, source: 'JARVIS_ADB_PATH' },
    { command: env.ADB, source: 'ADB' },
    { command: jarvisToolsHome ? join(jarvisToolsHome, 'platform-tools', adbBinaryName) : null, source: 'JARVIS_ANDROID_TOOLS_HOME/platform-tools' },
    { command: jarvisToolsHome ? join(jarvisToolsHome, adbBinaryName) : null, source: 'JARVIS_ANDROID_TOOLS_HOME' },
    { command: env.ANDROID_HOME ? join(env.ANDROID_HOME, 'platform-tools', adbBinaryName) : null, source: 'ANDROID_HOME' },
    { command: env.ANDROID_SDK_ROOT ? join(env.ANDROID_SDK_ROOT, 'platform-tools', adbBinaryName) : null, source: 'ANDROID_SDK_ROOT' },
    { command: 'adb', source: 'PATH' }
  ].filter((item) => item.command);
  const seen = new Set();
  return candidates.filter((item) => {
    const key = item.command.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveAdbCommand({ env = process.env } = {}) {
  const candidates = adbCandidatePaths(env);
  const checked = [];
  for (const candidate of candidates) {
    if (candidate.command === 'adb') {
      checked.push({ ...candidate, exists: null, executable: 'deferred-to-PATH' });
      continue;
    }
    const candidateExists = await exists(candidate.command);
    checked.push({ ...candidate, exists: candidateExists, executable: candidateExists });
    if (candidateExists) {
      return {
        command: candidate.command,
        source: candidate.source,
        checked
      };
    }
  }
  return {
    command: 'adb',
    source: 'PATH',
    checked
  };
}

async function adb(args, options = {}) {
  const adbResolution = options.adbResolution ?? await resolveAdbCommand();
  return execFileAsync(adbResolution.command, args, {
    windowsHide: true,
    timeout: options.timeout ?? 7000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8'
  });
}

export async function listAndroidDevices() {
  const adbResolution = await resolveAdbCommand();
  try {
    const { stdout } = await adb(['devices'], { adbResolution });
    const devices = stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state] = line.split(/\s+/);
        return { serial, state };
      });
    return { tool: 'adb', available: true, adb: adbResolution, devices };
  } catch (error) {
    return { tool: 'adb', available: false, adb: adbResolution, devices: [], error: error.code ?? error.message };
  }
}

async function shell(serial, command, options = {}) {
  const { stdout } = await adb(['-s', serial, 'shell', command], options);
  return stdout.trim();
}

async function collapseSystemOverlays(serial) {
  await shell(serial, 'cmd statusbar collapse', { timeout: 5000 }).catch(() => '');
  await shell(serial, 'input keyevent KEYCODE_ESCAPE', { timeout: 5000 }).catch(() => '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchApp(serial, { packageName, launchWaitMs = defaultLaunchWaitMs } = {}) {
  await shell(serial, `am force-stop ${packageName}`).catch(() => '');
  await collapseSystemOverlays(serial);
  const explicitComponent = `${packageName}/.MainActivity`;
  try {
    const output = await shell(serial, `am start -W -n ${explicitComponent}`, { timeout: 45000 });
    await delay(launchWaitMs);
    await collapseSystemOverlays(serial);
    const focused = await shell(serial, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', { timeout: 10000 }).catch(() => '');
    return {
      attempted: true,
      method: 'am-start-explicit',
      success: (/Status:\s*ok|Complete/i.test(output) && !/Error:/i.test(output)) || String(focused).includes(packageName),
      output,
      focused
    };
  } catch (error) {
    const explicitError = error.code ?? error.message;
    try {
      const output = await shell(serial, `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 });
      await delay(launchWaitMs);
      await collapseSystemOverlays(serial);
      const focused = await shell(serial, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', { timeout: 10000 }).catch(() => '');
      return {
        attempted: true,
        method: 'monkey-launcher-fallback',
        success: output.includes('Events injected: 1') || String(focused).includes(packageName),
        output,
        explicitError,
        focused
      };
    } catch (fallbackError) {
      const focused = await shell(serial, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', { timeout: 10000 }).catch(() => '');
      return {
        attempted: true,
        method: 'launch-failed',
        success: String(focused).includes(packageName),
        explicitError,
        error: fallbackError.code ?? fallbackError.message,
        focused
      };
    }
  }
}

async function captureScreenshot(serial, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const { stdout } = await adb(
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', timeout: 10000, maxBuffer: 15 * 1024 * 1024 }
  );
  const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const hasPngHeader = png.length > 8
    && png[0] === 0x89
    && png[1] === 0x50
    && png[2] === 0x4e
    && png[3] === 0x47;
  if (hasPngHeader) await writeFile(outputPath, png);
  return { outputPath, bytes: png.length, hasPngHeader };
}

async function readUiXml(serial, { attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await shell(serial, 'uiautomator dump /sdcard/jarvis-window.xml', { timeout: 15000 });
      const { stdout } = await adb(['-s', serial, 'exec-out', 'cat', '/sdcard/jarvis-window.xml'], { timeout: 15000 });
      return stdout;
    } catch (error) {
      lastError = error;
      await delay(450 * attempt);
    }
  }
  throw lastError;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNodeBounds(xml, resourceId) {
  const nodeMatch = xml.match(new RegExp(`<node\\b(?=[^>]*resource-id="${escapeRegExp(resourceId)}")[^>]*>`));
  if (!nodeMatch) return null;
  const boundsMatch = nodeMatch[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!boundsMatch) return null;
  const [, left, top, right, bottom] = boundsMatch.map(Number);
  return {
    left,
    top,
    right,
    bottom,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2)
  };
}

async function tapAt(serial, bounds) {
  try {
    await shell(serial, `input touchscreen tap ${bounds.centerX} ${bounds.centerY}`);
  } catch {
    await shell(serial, `input tap ${bounds.centerX} ${bounds.centerY}`);
  }
}

async function openDeepLink(serial, packageName, url) {
  const output = await shell(
    serial,
    `am start -W -a android.intent.action.VIEW -d "${url}" ${packageName}`,
    { timeout: 45000 }
  );
  return {
    url,
    output,
    success: /Status:\s*ok|Complete|Warning: Activity not started/i.test(output) && !/Error:/i.test(output)
  };
}

async function dumpUi(serial, outputPath) {
  try {
    const stdout = await readUiXml(serial);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, stdout, 'utf8');
    return {
      available: true,
      outputPath,
      containsJarvisTitle: stdout.includes('JARVIS Mobile'),
      containsRouteText: stdout.includes('PairingScreen') || stdout.includes('CommandScreen'),
      containsNativeRuntimeProbe: stdout.includes('Native runtime probe'),
      containsSecureStoreProbe: stdout.includes('SecureStore native:'),
      containsNotificationsProbe: stdout.includes('Notifications native:'),
      bytes: stdout.length
    };
  } catch (error) {
    return { available: false, error: error.code ?? error.message };
  }
}

async function verifyRouteNavigation(serial, { artifactDir, packageName, routes = [] }) {
  const results = [];
  for (const route of routes) {
    try {
      const beforeXml = await readUiXml(serial);
      const resourceId = `route-button-${route}`;
      const bounds = findNodeBounds(beforeXml, resourceId);
      let activation = await openDeepLink(serial, packageName, `jarvis://route/${encodeURIComponent(route)}`).catch((error) => ({
        success: false,
        error: error.code ?? error.message
      }));
      if (!activation.success && bounds) {
        await tapAt(serial, bounds);
        activation = { ...activation, fallback: 'touchscreen-tap' };
      }
      await delay(1100);
      let afterXml = await readUiXml(serial);
      const outputPath = join(artifactDir, `${sanitizeSerial(serial)}-${route}-window.xml`);
      let containsRouteText = afterXml.includes(`현재 화면: ${route}`) || afterXml.includes(`current route ${route}`);
      let containsScreenContent = afterXml.includes(`screen-content-${route}`);
      for (let attempt = 0; attempt < 3 && !(containsRouteText && containsScreenContent); attempt += 1) {
        await delay(600);
        afterXml = await readUiXml(serial);
        containsRouteText = afterXml.includes(`현재 화면: ${route}`) || afterXml.includes(`current route ${route}`);
        containsScreenContent = afterXml.includes(`screen-content-${route}`);
      }
      await writeFile(outputPath, afterXml, 'utf8');
      results.push({
        route,
        success: containsRouteText && containsScreenContent,
        resourceId,
        buttonVisible: Boolean(bounds),
        tap: bounds ?? null,
        activation,
        outputPath,
        containsRouteText,
        containsScreenContent
      });
    } catch (error) {
      results.push({
        route,
        success: false,
        reason: error.code ?? error.message
      });
    }
  }
  return {
    attempted: routes.length > 0,
    passed: routes.length > 0 && results.every((item) => item.success),
    routes: results
  };
}

async function inspectDevice(device, { artifactDir, packageName, launchWaitMs = defaultLaunchWaitMs }) {
  const serial = device.serial;
  const properties = {
    model: await shell(serial, 'getprop ro.product.model').catch((error) => `unknown:${error.code ?? error.message}`),
    sdk: await shell(serial, 'getprop ro.build.version.sdk').catch((error) => `unknown:${error.code ?? error.message}`)
  };
  const installedPath = await shell(serial, `pm path ${packageName}`).catch(() => '');
  const installed = installedPath.includes(packageName);
  const launch = installed
    ? await launchApp(serial, { packageName, launchWaitMs })
    : { attempted: false, success: false, reason: 'app-not-installed' };
  const screenshotPath = join(artifactDir, `${sanitizeSerial(serial)}-screen.png`);
  const uiDumpPath = join(artifactDir, `${sanitizeSerial(serial)}-window.xml`);
  const screenshot = await captureScreenshot(serial, screenshotPath).catch((error) => ({
    outputPath: screenshotPath,
    bytes: 0,
    hasPngHeader: false,
    error: error.code ?? error.message
  }));
  const uiDump = installed ? await dumpUi(serial, uiDumpPath) : { available: false, outputPath: uiDumpPath, reason: 'app-not-installed' };
  const routeNavigation = installed && launch.success
    ? await verifyRouteNavigation(serial, {
        artifactDir,
        packageName,
        routes: [
          'CommandScreen',
          'ApprovalQueueScreen',
          'ApprovalDetailScreen',
          'TaskStatusScreen',
          'ResultScreen',
          'SettingsScreen',
          'GrowthReviewScreen',
          'PoisonQueueScreen'
        ]
      })
    : { attempted: false, passed: false, routes: [], reason: 'app-not-launched' };

  return {
    serial,
    state: device.state,
    properties,
    packageName,
    installed,
    installedPath: installedPath || null,
    launch,
    screenshot,
    uiDump,
    routeNavigation,
    verified: installed
      && launch.success === true
      && screenshot.hasPngHeader === true
      && uiDump.containsJarvisTitle === true
      && uiDump.containsRouteText === true
      && uiDump.containsNativeRuntimeProbe === true
      && uiDump.containsSecureStoreProbe === true
      && uiDump.containsNotificationsProbe === true
      && routeNavigation.passed === true
  };
}

export function createMobileDeviceVerificationPlan({ packageName = androidPackageName } = {}) {
  return {
    packageName,
    steps: [
      { id: 'adb.devices', command: 'adb devices', expected: 'At least one device in device state' },
      { id: 'adb.resolve', command: 'npm run mobile:setup-android -- --install, or set JARVIS_ADB_PATH / JARVIS_ANDROID_TOOLS_HOME / ANDROID_HOME / ANDROID_SDK_ROOT', expected: 'ADB command is discoverable' },
      { id: 'expo.install', command: 'npx expo run:android --device', expected: `${packageName} is installed on device` },
      { id: 'adb.launch', command: `adb shell am start -W -n ${packageName}/.MainActivity`, expected: 'MainActivity launch completes and stays foreground' },
      { id: 'adb.screenshot', command: 'adb exec-out screencap -p > dist/mobile-device/<serial>-screen.png', expected: 'PNG screenshot is captured' },
      { id: 'ui.dump', command: 'adb shell uiautomator dump /sdcard/jarvis-window.xml', expected: 'UI tree contains JARVIS Mobile and route text' },
      { id: 'native.runtime.probe', command: 'adb shell uiautomator dump /sdcard/jarvis-window.xml', expected: 'UI tree contains SecureStore and Notifications native runtime probe labels' },
      { id: 'route.navigation', command: 'adb shell input tap <route-button-bounds>', expected: 'Route buttons navigate to Command, Approval, Status, Result, Settings, Growth, and Poison Queue screens' }
    ]
  };
}

export function deviceSmokeNextActions(report) {
  if (report.actualDeviceVerified) return [];
  if (report.reason === 'adb-not-available') {
    return [
      'Install Android SDK Platform Tools or Android Studio.',
      'Run npm run mobile:setup-android -- --install to install Android Platform Tools into the JARVIS cache.',
      'Set ANDROID_HOME, ANDROID_SDK_ROOT, JARVIS_ANDROID_TOOLS_HOME, or JARVIS_ADB_PATH when using a custom SDK location.',
      'Open an Android emulator or connect a USB-debugging-enabled Android device.',
      'Run npm run mobile:device again.'
    ];
  }
  if (report.reason === 'no-ready-android-device') {
    return [
      'Start an Android emulator or connect a physical Android device.',
      'Confirm adb devices shows the device state as device.',
      'Run npx expo run:android --device from apps/mobile or through the planned command.',
      'Run npm run mobile:device again.'
    ];
  }
  return [
    `Install and launch ${report.plan.packageName} on the ready Android device.`,
    'Confirm the UI shows JARVIS Mobile, current route text, and native runtime probe labels.',
    'Run npm run mobile:device again to capture screenshot and UI XML artifacts.'
  ];
}

export function renderMobileDeviceSmokeMarkdown(report) {
  const lines = [
    '# JARVIS Mobile Device Smoke',
    '',
    `Generated: ${report.generatedAt ?? new Date().toISOString()}`,
    `Status: ${report.status}`,
    `Actual device verified: ${report.actualDeviceVerified}`,
    `Reason: ${report.reason ?? 'none'}`,
    `ADB command: ${report.probe.adb?.command ?? 'adb'}`,
    `ADB source: ${report.probe.adb?.source ?? 'PATH'}`,
    '',
    '## Plan'
  ];
  for (const step of report.plan.steps) {
    lines.push(`- ${step.id}: \`${step.command}\` -> ${step.expected}`);
  }
  lines.push('', '## Devices');
  if (report.devices.length === 0) {
    lines.push('- none');
  } else {
    for (const device of report.devices) {
      lines.push(`- ${device.serial}: installed=${device.installed}, launch=${device.launch.success === true}, screenshot=${device.screenshot.hasPngHeader === true}, uiProbe=${device.uiDump.containsNativeRuntimeProbe === true}, routeNavigation=${device.routeNavigation?.passed === true}`);
    }
  }
  const nextActions = deviceSmokeNextActions(report);
  if (nextActions.length) {
    lines.push('', '## Next Actions');
    for (const action of nextActions) lines.push(`- ${action}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderMobileDeviceSmokeHtml(report) {
  const plan = report.plan.steps.map((step) => `<li>${step.id}: <code>${step.command}</code> - ${step.expected}</li>`).join('');
  const devices = report.devices.length
    ? report.devices.map((device) => `<li>${device.serial}: installed=${device.installed}, verified=${device.verified}, routeNavigation=${device.routeNavigation?.passed === true}</li>`).join('')
    : '<li>none</li>';
  const actions = deviceSmokeNextActions(report).map((action) => `<li>${action}</li>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS Mobile Device Smoke</title></head>
<body>
  <h1>JARVIS Mobile Device Smoke</h1>
  <p>Status: ${report.status}</p>
  <p>Actual device verified: ${report.actualDeviceVerified}</p>
  <p>Reason: ${report.reason ?? 'none'}</p>
  <p>ADB: ${report.probe.adb?.command ?? 'adb'} (${report.probe.adb?.source ?? 'PATH'})</p>
  <h2>Plan</h2>
  <ul>${plan}</ul>
  <h2>Devices</h2>
  <ul>${devices}</ul>
  <h2>Next Actions</h2>
  <ul>${actions}</ul>
</body>
</html>
`;
}

export async function writeMobileDeviceSmokeArtifacts(report, {
  jsonPath = 'dist/mobile-device-smoke-report.json',
  markdownPath = 'dist/mobile-device-smoke-report.md',
  htmlPath = 'dist/mobile-device-smoke-report.html'
} = {}) {
  const stamped = {
    generatedAt: report.generatedAt ?? new Date().toISOString(),
    ...report,
    nextActions: deviceSmokeNextActions(report)
  };
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(stamped, null, 2), 'utf8');
  await writeFile(markdownPath, renderMobileDeviceSmokeMarkdown(stamped), 'utf8');
  await writeFile(htmlPath, renderMobileDeviceSmokeHtml(stamped), 'utf8');
  return { jsonPath, markdownPath, htmlPath };
}

export async function runMobileDeviceSmoke({ artifactDir = 'dist/mobile-device', packageName = androidPackageName, launchWaitMs = defaultLaunchWaitMs } = {}) {
  const probe = await listAndroidDevices();
  const readyDevices = probe.devices.filter((device) => device.state === 'device');
  const plan = createMobileDeviceVerificationPlan({ packageName });
  if (!probe.available) {
    return {
      generatedAt: new Date().toISOString(),
      status: 'blocked',
      actualDeviceVerified: false,
      reason: 'adb-not-available',
      probe,
      plan,
      devices: []
    };
  }
  if (readyDevices.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      status: 'blocked',
      actualDeviceVerified: false,
      reason: 'no-ready-android-device',
      probe,
      plan,
      devices: []
    };
  }
  await mkdir(artifactDir, { recursive: true });
  const devices = [];
  for (const device of readyDevices) {
    devices.push(await inspectDevice(device, { artifactDir, packageName, launchWaitMs }));
  }
  const actualDeviceVerified = devices.some((device) => device.verified);
  return {
    generatedAt: new Date().toISOString(),
    status: actualDeviceVerified ? 'passed' : 'product-readiness-blocked',
    actualDeviceVerified,
    reason: actualDeviceVerified ? null : 'app-install-launch-or-screen-contract-not-verified',
    probe,
    plan,
    devices
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runMobileDeviceSmoke();
  const artifacts = await writeMobileDeviceSmokeArtifacts(report);
  console.log('# JARVIS Mobile Device Smoke');
  console.log(`Status: ${report.status}`);
  console.log(`Actual device verified: ${report.actualDeviceVerified}`);
  console.log(`Reason: ${report.reason ?? 'none'}`);
  console.log(`Reports: ${artifacts.jsonPath}, ${artifacts.markdownPath}, ${artifacts.htmlPath}`);
  if (report.status === 'passed') console.log('Device artifacts: dist/mobile-device/*.png, dist/mobile-device/*.xml');
}
