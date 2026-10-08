import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const androidPackageName = 'local.eureka.jarvis';
const adbBinaryName = process.platform === 'win32' ? 'adb.exe' : 'adb';
const defaultLaunchWaitMs = 3000;
export const defaultMobileDeviceEvidenceRoot = 'artifacts/field-evidence/mobile-device';
export const defaultMobileDeviceEvidenceMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

const mobileFingerprintRoots = [
  'apps/mobile/src',
  'apps/mobile/android/app/src/main'
];

const mobileFingerprintFiles = [
  'apps/mobile/app.json',
  'apps/mobile/package.json',
  'apps/mobile/android/app/build.gradle',
  'apps/mobile/android/build.gradle',
  'apps/mobile/android/gradle.properties',
  'apps/mobile/android/settings.gradle'
];

async function collectFiles(path) {
  if (!(await exists(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    if (entry.isFile()) files.push(child);
  }
  return files;
}

export async function createMobileAppFingerprint({ workspaceRoot = process.cwd() } = {}) {
  const root = resolve(workspaceRoot);
  const paths = [];
  for (const path of mobileFingerprintFiles) {
    const absolutePath = resolve(root, path);
    if (await exists(absolutePath)) paths.push(absolutePath);
  }
  for (const path of mobileFingerprintRoots) {
    paths.push(...await collectFiles(resolve(root, path)));
  }
  paths.sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return {
    algorithm: 'sha256',
    value: hash.digest('hex'),
    fileCount: paths.length,
    scope: 'mobile-source-and-android-runtime'
  };
}

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function currentAttemptSummary(report) {
  return {
    generatedAt: report.generatedAt,
    status: report.status,
    actualDeviceVerified: report.actualDeviceVerified,
    reason: report.reason ?? null,
    readyDeviceCount: report.probe?.devices?.filter((device) => device.state === 'device').length ?? 0
  };
}

async function retainedScreenshotIntegrity(report, { workspaceRoot = process.cwd() } = {}) {
  const verifiedDevices = report.devices?.filter((device) => device.verified) ?? [];
  if (verifiedDevices.length === 0) return { passed: false, reason: 'no-verified-device' };
  for (const device of verifiedDevices) {
    const screenshotPath = device.screenshot?.outputPath;
    const expectedHash = device.screenshot?.sha256;
    if (!screenshotPath || !expectedHash || device.screenshot?.persisted !== true) {
      return { passed: false, reason: 'persistent-screenshot-metadata-missing' };
    }
    const absolutePath = resolve(workspaceRoot, screenshotPath);
    if (!(await exists(absolutePath))) return { passed: false, reason: 'persistent-screenshot-missing' };
    if (await sha256File(absolutePath) !== expectedHash) {
      return { passed: false, reason: 'persistent-screenshot-integrity-failed' };
    }
  }
  return { passed: true, reason: null, verifiedScreenshots: verifiedDevices.length };
}

export async function reconcileMobileDeviceEvidence(currentReport, {
  evidenceRoot = defaultMobileDeviceEvidenceRoot,
  maxAgeMs = Number(process.env.JARVIS_MOBILE_EVIDENCE_MAX_AGE_MS ?? defaultMobileDeviceEvidenceMaxAgeMs),
  workspaceRoot = process.cwd(),
  now = Date.now()
} = {}) {
  if (currentReport.actualDeviceVerified === true) {
    return {
      ...currentReport,
      evidenceSource: 'live-device-probe',
      currentAttempt: currentAttemptSummary(currentReport),
      retainedEvidence: {
        status: 'not-needed',
        maxAgeMs
      }
    };
  }

  const lastPassedPath = join(evidenceRoot, 'last-passed.json');
  let retained;
  try {
    retained = JSON.parse(await readFile(lastPassedPath, 'utf8'));
  } catch {
    return {
      ...currentReport,
      evidenceSource: 'current-device-probe',
      currentAttempt: currentAttemptSummary(currentReport),
      retainedEvidence: {
        status: 'missing',
        path: lastPassedPath,
        maxAgeMs
      }
    };
  }

  const generatedAtMs = Date.parse(retained.generatedAt);
  const ageMs = Number.isFinite(generatedAtMs) ? now - generatedAtMs : Number.POSITIVE_INFINITY;
  const fingerprintMatches = retained.appFingerprint?.value === currentReport.appFingerprint?.value
    && retained.appFingerprint?.fileCount === currentReport.appFingerprint?.fileCount;
  const ageValid = ageMs >= -5 * 60 * 1000 && ageMs <= maxAgeMs;
  const screenshotIntegrity = await retainedScreenshotIntegrity(retained, { workspaceRoot });
  const valid = retained.actualDeviceVerified === true
    && fingerprintMatches
    && ageValid
    && screenshotIntegrity.passed;
  const invalidReason = retained.actualDeviceVerified !== true
    ? 'retained-report-not-passed'
    : !fingerprintMatches
      ? 'mobile-source-fingerprint-changed'
      : !ageValid
        ? 'retained-evidence-expired'
        : screenshotIntegrity.reason;

  if (!valid) {
    return {
      ...currentReport,
      evidenceSource: 'current-device-probe',
      currentAttempt: currentAttemptSummary(currentReport),
      retainedEvidence: {
        status: 'invalid',
        reason: invalidReason,
        path: lastPassedPath,
        generatedAt: retained.generatedAt ?? null,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        maxAgeMs,
        fingerprintMatches,
        screenshotIntegrity
      }
    };
  }

  return {
    ...currentReport,
    status: 'passed-retained-evidence',
    actualDeviceVerified: true,
    reason: null,
    evidenceSource: 'retained-last-passed',
    currentAttempt: currentAttemptSummary(currentReport),
    devices: retained.devices,
    retainedEvidence: {
      status: 'valid',
      path: lastPassedPath,
      generatedAt: retained.generatedAt,
      ageMs,
      maxAgeMs,
      fingerprintMatches,
      screenshotIntegrity
    }
  };
}

async function persistMobileDeviceEvidence(report, {
  attemptReport = report,
  evidenceRoot,
  workspaceRoot = process.cwd()
} = {}) {
  if (!evidenceRoot) return null;
  await mkdir(evidenceRoot, { recursive: true });
  const latestAttemptPath = join(evidenceRoot, 'latest-attempt.json');
  await writeFile(latestAttemptPath, `${JSON.stringify(attemptReport, null, 2)}\n`, 'utf8');

  if (attemptReport.actualDeviceVerified !== true || attemptReport.evidenceSource === 'retained-last-passed') {
    return {
      evidenceRoot,
      latestAttemptPath,
      lastPassedUpdated: false
    };
  }

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDir = join(evidenceRoot, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const persisted = clone(attemptReport);
  persisted.evidenceSource = 'live-device-probe';
  persisted.persistence = {
    persistenceVersion: 'c-mobile-device-evidence-store-v1',
    runId,
    immutableRunDirectory: runDir,
    rawUiXmlRetained: false,
    screenshotIntegrityRequired: true
  };
  for (const device of persisted.devices ?? []) {
    const sourceDevice = attemptReport.devices?.find((item) => item.serial === device.serial);
    const sourcePath = sourceDevice?.screenshot?.outputPath;
    if (sourcePath && sourceDevice.screenshot?.credibleImage === true) {
      const targetPath = join(runDir, `${sanitizeSerial(device.serial)}-screen.png`);
      await copyFile(resolve(workspaceRoot, sourcePath), targetPath);
      device.screenshot.outputPath = targetPath;
      device.screenshot.persisted = true;
      device.screenshot.sha256 = await sha256File(targetPath);
    }
    if (device.uiDump) {
      device.uiDump.outputPath = null;
      device.uiDump.rawUiXmlRetained = false;
    }
  }
  const runJsonPath = join(runDir, 'report.json');
  const runMarkdownPath = join(runDir, 'report.md');
  const lastPassedPath = join(evidenceRoot, 'last-passed.json');
  const lastPassedMarkdownPath = join(evidenceRoot, 'last-passed.md');
  await writeFile(runJsonPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  await writeFile(runMarkdownPath, renderMobileDeviceSmokeMarkdown(persisted), 'utf8');
  await writeFile(lastPassedPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  await writeFile(lastPassedMarkdownPath, renderMobileDeviceSmokeMarkdown(persisted), 'utf8');
  return {
    evidenceRoot,
    latestAttemptPath,
    runId,
    runJsonPath,
    runMarkdownPath,
    lastPassedPath,
    lastPassedMarkdownPath,
    lastPassedUpdated: true
  };
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
  const width = hasPngHeader && png.length >= 24 ? png.readUInt32BE(16) : 0;
  const height = hasPngHeader && png.length >= 24 ? png.readUInt32BE(20) : 0;
  return {
    outputPath,
    bytes: png.length,
    hasPngHeader,
    credibleImage: hasPngHeader && png.length >= 4096 && width > 0 && height > 0,
    width,
    height,
    sha256: hasPngHeader ? createHash('sha256').update(png).digest('hex') : null
  };
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

function findNodeTag(xml, resourceId) {
  const nodeMatch = xml.match(new RegExp(`<node\\b(?=[^>]*resource-id="${escapeRegExp(resourceId)}")[^>]*>`));
  return nodeMatch?.[0] ?? null;
}

function nodeAttribute(nodeTag, name) {
  return nodeTag?.match(new RegExp(`${escapeRegExp(name)}="([^"]*)"`))?.[1] ?? null;
}

function hasNode(xml, resourceId) {
  return Boolean(findNodeTag(xml, resourceId));
}

export function hasJarvisTitleContract(xml = '') {
  const titleNode = findNodeTag(xml, 'jarvis-mobile-title');
  if (!titleNode) return false;
  const title = (nodeAttribute(titleNode, 'text') || nodeAttribute(titleNode, 'content-desc') || '')
    .trim()
    .toLocaleLowerCase('ko-KR');
  return title === 'jarvis' || title === 'jarvis mobile' || title === '자비스';
}

function actionableNode(xml, resourceId) {
  const node = findNodeTag(xml, resourceId);
  return Boolean(node)
    && nodeAttribute(node, 'enabled') === 'true'
    && nodeAttribute(node, 'clickable') === 'true';
}

export function inspectProductionHomeSurface(xml = '') {
  const paired = /text="연결됨"|content-desc="연결됨"/.test(xml);
  const requiredIds = [
    'jarvis-mobile-root',
    'jarvis-mobile-title',
    'jarvis-current-route',
    'screen-content-HomeScreen',
    'home-command-input',
    'home-submit-button'
  ];
  const checks = requiredIds.map((resourceId) => ({
    checkId: `home-node:${resourceId}`,
    passed: hasNode(xml, resourceId),
    resourceId
  }));
  checks.push({
    checkId: 'home-copy:practical-command-prompt',
    passed: xml.includes('무엇을 도와드릴까요?') && xml.includes('무엇을 할까요?')
  });
  checks.push({
    checkId: 'home-action:voice-control-present',
    passed: hasNode(xml, 'home-conversation-button') || hasNode(xml, 'home-mic-button')
  });
  checks.push({
    checkId: paired ? 'home-action:submit-enabled' : 'home-action:pairing-surface-ready',
    passed: paired
      ? actionableNode(xml, 'home-submit-button')
      : hasNode(xml, 'home-bridge-url-input')
        && hasNode(xml, 'home-pairing-code-input')
        && actionableNode(xml, 'home-pair-button')
  });
  return {
    contractVersion: 'c-mobile-physical-home-surface-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    mode: paired ? 'paired-command-ready' : 'pairing-ready',
    pairedStateRestored: paired,
    checks,
    rawUiXmlEmbeddedInReport: false
  };
}

async function dumpUi(serial, outputPath) {
  try {
    const stdout = await readUiXml(serial);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, stdout, 'utf8');
    const homeSurface = inspectProductionHomeSurface(stdout);
    return {
      available: true,
      outputPath,
      containsJarvisTitle: hasJarvisTitleContract(stdout),
      containsHomeSubtitle: stdout.includes('무엇을 도와드릴까요?'),
      containsCommandInput: hasNode(stdout, 'home-command-input'),
      containsSubmitButton: hasNode(stdout, 'home-submit-button'),
      containsVoiceControl: hasNode(stdout, 'home-conversation-button') || hasNode(stdout, 'home-mic-button'),
      homeSurface,
      bytes: stdout.length
    };
  } catch (error) {
    return { available: false, error: error.code ?? error.message };
  }
}

async function inspectInstalledPackage(serial, packageName) {
  const requiredPermissions = [
    'android.permission.RECORD_AUDIO',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.USE_BIOMETRIC'
  ];
  try {
    const output = await shell(serial, `dumpsys package ${packageName}`, { timeout: 15000 });
    const permissions = requiredPermissions.map((permission) => ({
      permission,
      declared: output.includes(permission)
    }));
    return {
      contractVersion: 'c-mobile-installed-package-capabilities-v1',
      status: permissions.every((item) => item.declared) ? 'passed' : 'failed',
      permissions,
      rawPackageDumpStored: false
    };
  } catch (error) {
    return {
      contractVersion: 'c-mobile-installed-package-capabilities-v1',
      status: 'failed',
      permissions: requiredPermissions.map((permission) => ({ permission, declared: false })),
      rawPackageDumpStored: false,
      error: error.code ?? error.message
    };
  }
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
    credibleImage: false,
    width: 0,
    height: 0,
    sha256: null,
    error: error.code ?? error.message
  }));
  const uiDump = installed ? await dumpUi(serial, uiDumpPath) : { available: false, outputPath: uiDumpPath, reason: 'app-not-installed' };
  const packageCapabilities = installed
    ? await inspectInstalledPackage(serial, packageName)
    : { contractVersion: 'c-mobile-installed-package-capabilities-v1', status: 'failed', permissions: [], reason: 'app-not-installed' };
  const homeSurface = uiDump.homeSurface ?? {
    contractVersion: 'c-mobile-physical-home-surface-v1',
    status: 'failed',
    mode: 'unavailable',
    checks: [],
    reason: uiDump.reason ?? uiDump.error ?? 'ui-dump-unavailable'
  };

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
    homeSurface,
    packageCapabilities,
    verified: installed
      && launch.success === true
      && screenshot.credibleImage === true
      && uiDump.containsJarvisTitle === true
      && homeSurface.status === 'passed'
      && packageCapabilities.status === 'passed'
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
      { id: 'ui.dump', command: 'adb shell uiautomator dump /sdcard/jarvis-window.xml', expected: 'UI tree contains the production Jarvis home surface' },
      { id: 'home.surface.contract', command: 'adb shell uiautomator dump /sdcard/jarvis-window.xml', expected: 'Command input, execution, voice, and pairing-or-connected controls are actionable' },
      { id: 'installed.package.capabilities', command: `adb shell dumpsys package ${packageName}`, expected: 'Installed APK declares microphone, notifications, and biometric capabilities' }
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
    'Confirm the Jarvis home shows command input, execution, voice, and pairing or connected controls.',
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
    `Evidence source: ${report.evidenceSource ?? 'current-device-probe'}`,
    `Current ready devices: ${report.probe?.devices?.filter((device) => device.state === 'device').length ?? 0}`,
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
      lines.push(`- ${device.serial}: installed=${device.installed}, launch=${device.launch.success === true}, screenshot=${device.screenshot.credibleImage === true}, homeSurface=${device.homeSurface?.status}, packageCapabilities=${device.packageCapabilities?.status}`);
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
    ? report.devices.map((device) => `<li>${device.serial}: installed=${device.installed}, verified=${device.verified}, homeSurface=${device.homeSurface?.status}, packageCapabilities=${device.packageCapabilities?.status}</li>`).join('')
    : '<li>none</li>';
  const actions = deviceSmokeNextActions(report).map((action) => `<li>${action}</li>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS Mobile Device Smoke</title></head>
<body>
  <h1>JARVIS Mobile Device Smoke</h1>
  <p>Status: ${report.status}</p>
  <p>Actual device verified: ${report.actualDeviceVerified}</p>
  <p>Evidence source: ${report.evidenceSource ?? 'current-device-probe'}</p>
  <p>Current ready devices: ${report.probe?.devices?.filter((device) => device.state === 'device').length ?? 0}</p>
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
  htmlPath = 'dist/mobile-device-smoke-report.html',
  attemptReport = report,
  evidenceRoot = null,
  workspaceRoot = process.cwd()
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
  const persistentEvidence = await persistMobileDeviceEvidence(stamped, {
    attemptReport,
    evidenceRoot,
    workspaceRoot
  });
  return { jsonPath, markdownPath, htmlPath, persistentEvidence };
}

export async function runMobileDeviceSmoke({
  artifactDir = 'dist/mobile-device',
  packageName = androidPackageName,
  launchWaitMs = defaultLaunchWaitMs,
  probeDevices = process.env.JARVIS_EXTERNAL_DEVICE_PROBES !== '0',
  requestedSerial = process.env.JARVIS_MOBILE_DEVICE_SERIAL ?? '',
  workspaceRoot = process.cwd()
} = {}) {
  const normalizedRequestedSerial = String(requestedSerial ?? '').trim();
  const plan = createMobileDeviceVerificationPlan({ packageName });
  const appFingerprint = await createMobileAppFingerprint({ workspaceRoot });
  if (!probeDevices) {
    return {
      reportVersion: 'c-mobile-device-smoke-v2',
      generatedAt: new Date().toISOString(),
      status: 'blocked',
      actualDeviceVerified: false,
      reason: 'external-device-probe-disabled',
      requestedSerial: normalizedRequestedSerial || null,
      probe: {
        tool: 'adb',
        available: false,
        adb: { command: 'adb', source: 'probe-disabled', checked: [] },
        devices: [],
        error: 'external-device-probe-disabled'
      },
      plan,
      appFingerprint,
      devices: []
    };
  }
  const probe = await listAndroidDevices();
  if (!probe.available) {
    return {
      reportVersion: 'c-mobile-device-smoke-v2',
      generatedAt: new Date().toISOString(),
      status: 'blocked',
      actualDeviceVerified: false,
      reason: 'adb-not-available',
      requestedSerial: normalizedRequestedSerial || null,
      probe,
      plan,
      appFingerprint,
      devices: []
    };
  }
  const target = selectMobileDeviceSmokeTargets({
    devices: probe.devices,
    requestedSerial: normalizedRequestedSerial
  });
  if (target.reason) {
    return {
      reportVersion: 'c-mobile-device-smoke-v2',
      generatedAt: new Date().toISOString(),
      status: 'blocked',
      actualDeviceVerified: false,
      reason: target.reason,
      requestedSerial: normalizedRequestedSerial || null,
      probe,
      plan,
      appFingerprint,
      devices: []
    };
  }
  await mkdir(artifactDir, { recursive: true });
  const devices = [];
  for (const device of target.devices) {
    devices.push(await inspectDevice(device, { artifactDir, packageName, launchWaitMs }));
  }
  const actualDeviceVerified = devices.some((device) => device.verified);
  return {
    reportVersion: 'c-mobile-device-smoke-v2',
    generatedAt: new Date().toISOString(),
    status: actualDeviceVerified ? 'passed' : 'product-readiness-blocked',
    actualDeviceVerified,
    reason: actualDeviceVerified ? null : 'app-install-launch-or-screen-contract-not-verified',
    requestedSerial: normalizedRequestedSerial || null,
    probe,
    plan,
    appFingerprint,
    devices
  };
}

export function selectMobileDeviceSmokeTargets({ devices = [], requestedSerial = '' } = {}) {
  const normalizedRequestedSerial = String(requestedSerial ?? '').trim();
  if (!normalizedRequestedSerial) {
    const readyDevices = devices.filter((device) => device.state === 'device');
    return {
      devices: readyDevices,
      reason: readyDevices.length > 0 ? null : 'no-ready-android-device'
    };
  }

  const requestedDevice = devices.find((device) => device.serial === normalizedRequestedSerial);
  if (!requestedDevice) {
    return { devices: [], reason: `requested-android-device-not-found:${normalizedRequestedSerial}` };
  }
  if (requestedDevice.state !== 'device') {
    return {
      devices: [],
      reason: `requested-android-device-not-ready:${normalizedRequestedSerial}:${requestedDevice.state ?? 'unknown'}`
    };
  }
  return { devices: [requestedDevice], reason: null };
}

export function parseMobileDeviceSmokeCliOptions(argv = [], { env = process.env } = {}) {
  const options = {
    packageName: env.JARVIS_MOBILE_DEVICE_PACKAGE ?? androidPackageName
  };
  if (env.JARVIS_MOBILE_DEVICE_SERIAL) options.requestedSerial = env.JARVIS_MOBILE_DEVICE_SERIAL;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package' && argv[index + 1]) options.packageName = argv[index + 1];
    if (arg === '--serial' && argv[index + 1]) options.requestedSerial = argv[index + 1];
    if (arg === '--artifact-dir' && argv[index + 1]) options.artifactDir = argv[index + 1];
    if (arg === '--launch-wait-ms' && argv[index + 1]) {
      const value = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(value) && value > 0) options.launchWaitMs = value;
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attemptReport = await runMobileDeviceSmoke(parseMobileDeviceSmokeCliOptions(process.argv.slice(2)));
  const persistentDeviceEvidenceEnabled = attemptReport.reason !== 'external-device-probe-disabled';
  const report = persistentDeviceEvidenceEnabled
    ? await reconcileMobileDeviceEvidence(attemptReport)
    : {
        ...attemptReport,
        evidenceSource: 'external-probe-disabled',
        retainedEvidence: { status: 'not-evaluated', reason: 'external-device-probe-disabled' }
      };
  const artifacts = await writeMobileDeviceSmokeArtifacts(report, {
    attemptReport,
    evidenceRoot: persistentDeviceEvidenceEnabled ? defaultMobileDeviceEvidenceRoot : null
  });
  console.log('# JARVIS Mobile Device Smoke');
  console.log(`Status: ${report.status}`);
  console.log(`Actual device verified: ${report.actualDeviceVerified}`);
  console.log(`Reason: ${report.reason ?? 'none'}`);
  console.log(`Reports: ${artifacts.jsonPath}, ${artifacts.markdownPath}, ${artifacts.htmlPath}`);
  if (report.status === 'passed') console.log('Device artifacts: dist/mobile-device/*.png, dist/mobile-device/*.xml');
}
