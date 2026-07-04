import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createAndroidSetupPlan } from './mobile-android-setup.mjs';
import { resolveAdbCommand } from './mobile-device-smoke.mjs';

const execFileAsync = promisify(execFile);
const defaultAvdName = 'Medium_Phone_API_36.1';

function isWindows(platform = process.platform) {
  return platform === 'win32';
}

function exeName(name, platform = process.platform) {
  if (!isWindows(platform)) return name;
  if (name === 'sdkmanager' || name === 'avdmanager') return `${name}.bat`;
  return `${name}.exe`;
}

function pathEnv(env = process.env) {
  return env.PATH ?? env.Path ?? '';
}

function isBareCommand(command) {
  return !/[\\/]/.test(command) && !/^[a-zA-Z]:/.test(command);
}

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

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate.command) return false;
    const key = `${candidate.source}:${candidate.command}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function commandCandidates(name, { env = process.env, platform = process.platform, sdkRoot } = {}) {
  const binary = exeName(name, platform);
  const envKey = `JARVIS_${name.toUpperCase()}_PATH`;
  const sdkRoots = [
    sdkRoot,
    env.JARVIS_ANDROID_SDK_ROOT,
    env.JARVIS_ANDROID_TOOLS_HOME,
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    isWindows(platform) && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : null
  ].filter(Boolean);
  const rooted = [];
  for (const root of sdkRoots) {
    if (name === 'emulator') {
      rooted.push({ command: join(root, 'emulator', binary), source: `${root}/emulator` });
    } else {
      rooted.push({ command: join(root, 'cmdline-tools', 'latest', 'bin', binary), source: `${root}/cmdline-tools/latest/bin` });
      rooted.push({ command: join(root, 'tools', 'bin', binary), source: `${root}/tools/bin` });
    }
  }
  return uniqueCandidates([
    { command: env[envKey], source: envKey },
    ...rooted,
    ...pathEnv(env).split(isWindows(platform) ? ';' : ':').filter(Boolean).map((entry) => ({
      command: join(entry, binary),
      source: 'PATH'
    })),
    { command: name, source: 'PATH' }
  ]);
}

function javaCandidates({ env = process.env, platform = process.platform } = {}) {
  const binary = exeName('java', platform);
  return uniqueCandidates([
    { command: env.JARVIS_JAVA_PATH, source: 'JARVIS_JAVA_PATH' },
    { command: env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', binary) : null, source: 'JAVA_HOME' },
    ...pathEnv(env).split(isWindows(platform) ? ';' : ':').filter(Boolean).map((entry) => ({
      command: join(entry, binary),
      source: 'PATH'
    })),
    { command: 'java', source: 'PATH' }
  ]);
}

async function probeExecutable(candidates, {
  probePathCommands = true,
  versionArgs = ['--version']
} = {}) {
  const checked = [];
  for (const candidate of candidates) {
    if (!isBareCommand(candidate.command)) {
      const found = await exists(candidate.command);
      checked.push({ ...candidate, exists: found, executable: found });
      if (found) {
        return { available: true, command: candidate.command, source: candidate.source, checked };
      }
      continue;
    }
    if (!probePathCommands) {
      checked.push({ ...candidate, exists: null, executable: 'deferred-to-PATH' });
      continue;
    }
    try {
      await execFileAsync(candidate.command, versionArgs, {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8'
      });
      checked.push({ ...candidate, exists: null, executable: true });
      return { available: true, command: candidate.command, source: candidate.source, checked };
    } catch (error) {
      checked.push({ ...candidate, exists: null, executable: false, error: error.code ?? error.message });
    }
  }
  return { available: false, command: null, source: null, checked };
}

function parseKeyValue(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return values;
}

function avdHome(env = process.env) {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return join(home, '.android', 'avd');
}

async function listFileSystemAvds({ env = process.env } = {}) {
  const root = avdHome(env);
  const avds = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith('.ini')) {
        const metadata = parseKeyValue(await readFile(fullPath, 'utf8').catch(() => ''));
        avds.push({
          name: entry.name.slice(0, -4),
          source: 'avd-ini',
          path: metadata.path ?? null,
          target: metadata.target ?? null
        });
      }
      if (entry.isDirectory() && entry.name.endsWith('.avd')) {
        const config = parseKeyValue(await readFile(join(fullPath, 'config.ini'), 'utf8').catch(() => ''));
        avds.push({
          name: config.AvdId ?? basename(entry.name, '.avd'),
          displayName: config['avd.ini.displayname'] ?? null,
          source: 'avd-directory',
          path: fullPath,
          target: config.target ?? null,
          abi: config['abi.type'] ?? null,
          deviceName: config['hw.device.name'] ?? null
        });
      }
    }
  } catch {
    return { root, available: false, avds: [] };
  }
  const unique = [];
  const seen = new Set();
  for (const avd of avds) {
    const key = avd.name;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(avd);
  }
  return { root, available: true, avds: unique };
}

async function listEmulatorAvds(emulatorProbe) {
  if (!emulatorProbe.available) {
    return { available: false, avds: [], error: 'emulator-not-found' };
  }
  try {
    const { stdout } = await execFileAsync(emulatorProbe.command, ['-list-avds'], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    return {
      available: true,
      avds: stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      error: null
    };
  } catch (error) {
    return { available: false, avds: [], error: error.code ?? error.message };
  }
}

async function listAdbDevices({ env = process.env } = {}) {
  const adbResolution = await resolveAdbCommand({ env });
  try {
    const { stdout } = await execFileAsync(adbResolution.command, ['devices'], {
      windowsHide: true,
      timeout: 7000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    const devices = stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state] = line.split(/\s+/);
        return { serial, state };
      });
    return { available: true, adb: adbResolution, devices, error: null };
  } catch (error) {
    return { available: false, adb: adbResolution, devices: [], error: error.code ?? error.message };
  }
}

function createEmulatorPlan({ sdkRoot, selectedAvd = defaultAvdName } = {}) {
  return {
    sdkRoot,
    selectedAvd,
    commands: [
      {
        id: 'emulator-readiness',
        command: 'npm run mobile:emulator',
        expected: 'Record SDK, emulator, AVD, Java, ADB, and running-device readiness.'
      },
      {
        id: 'start-emulator',
        command: `npm run mobile:emulator -- --start --avd ${selectedAvd}`,
        expected: 'Start the selected Android Virtual Device in the background.'
      },
      {
        id: 'start-emulator-headless',
        command: `npm run mobile:emulator -- --start --headless --wait --avd ${selectedAvd}`,
        expected: 'Start the selected AVD headlessly and wait for Android boot completion.'
      },
      {
        id: 'install-mobile-app',
        command: 'cd apps/mobile && npx expo run:android --device',
        expected: 'Install local.eureka.jarvis onto the running emulator or connected device.'
      },
      {
        id: 'capture-device-evidence',
        command: 'npm run mobile:device',
        expected: 'Capture screenshot, UI XML, launch, and native runtime probe evidence.'
      }
    ]
  };
}

function chooseAvd({ requestedAvd, emulatorAvds, fileSystemAvds }) {
  const names = [
    ...emulatorAvds.avds,
    ...fileSystemAvds.avds.map((item) => item.name)
  ].filter(Boolean);
  if (requestedAvd && names.includes(requestedAvd)) return requestedAvd;
  if (names.includes(defaultAvdName)) return defaultAvdName;
  return names[0] ?? requestedAvd ?? defaultAvdName;
}

function readinessStatus({ adbDevices, emulatorProbe, fileSystemAvds, emulatorAvds, startResult }) {
  if (adbDevices.devices.some((device) => device.state === 'device')) return 'running-device';
  if (startResult?.requested && startResult.bootCompleted === true) return 'running-device';
  if (startResult?.requested && startResult.started === true) return 'starting';
  if (adbDevices.available && emulatorProbe.available && (fileSystemAvds.avds.length > 0 || emulatorAvds.avds.length > 0)) {
    return 'ready-to-start';
  }
  if (adbDevices.available && (fileSystemAvds.avds.length > 0 || emulatorAvds.avds.length > 0)) return 'missing-emulator-tool';
  if (adbDevices.available && emulatorProbe.available) return 'missing-avd';
  return 'blocked';
}

function emulatorNextActions(report) {
  if (report.status === 'running-device') {
    return [
      'Run cd apps/mobile && npx expo run:android --device.',
      'Run npm run mobile:device to capture launch, screenshot, UI XML, and native runtime probe evidence.'
    ];
  }
  if (report.status === 'ready-to-start') {
    return [
      `Run npm run mobile:emulator -- --start --wait --avd ${report.selectedAvd}.`,
      'After boot completes, run cd apps/mobile && npx expo run:android --device.',
      'Run npm run mobile:device.'
    ];
  }
  if (report.status === 'missing-emulator-tool') {
    return [
      'Install Android SDK Emulator through Android Studio SDK Manager or sdkmanager.',
      `Confirm emulator exists under ${report.sdkRoot}\\emulator.`,
      'Run npm run mobile:emulator again.'
    ];
  }
  if (report.status === 'missing-avd') {
    return [
      'Create an Android Virtual Device in Android Studio Device Manager.',
      'Recommended name: Medium_Phone_API_36.1 or JarvisPixel.',
      'Run npm run mobile:emulator again.'
    ];
  }
  return [
    'Run npm run mobile:setup-android -- --install first.',
    'Install Android Studio command-line tools, SDK Emulator, and an Android system image.',
    'Create or start an Android emulator, then run npm run mobile:device.'
  ];
}

async function startEmulator({ emulatorProbe, selectedAvd, headless = false }) {
  if (!emulatorProbe.available) return { requested: true, started: false, error: 'emulator-not-found' };
  const args = ['-avd', selectedAvd, '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect'];
  if (headless) args.push('-no-window');
  const child = spawn(emulatorProbe.command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: headless
  });
  child.unref();
  return {
    requested: true,
    started: true,
    pid: child.pid,
    command: emulatorProbe.command,
    args,
    selectedAvd,
    headless
  };
}

async function waitForBoot({ adbCommand, timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(adbCommand, ['shell', 'getprop', 'sys.boot_completed'], {
        windowsHide: true,
        timeout: 7000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8'
      });
      if (stdout.trim() === '1') return { bootCompleted: true };
    } catch {
      // Keep polling until the deadline. A freshly started emulator often rejects early adb calls.
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { bootCompleted: false, timeoutMs };
}

export function createAndroidEmulatorPlan(options = {}) {
  const setupPlan = createAndroidSetupPlan(options);
  return createEmulatorPlan({
    sdkRoot: options.sdkRoot ?? setupPlan.toolsHome,
    selectedAvd: options.selectedAvd ?? defaultAvdName
  });
}

export function renderAndroidEmulatorMarkdown(report) {
  const lines = [
    '# JARVIS Android Emulator Readiness',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `SDK root: ${report.sdkRoot}`,
    `Selected AVD: ${report.selectedAvd}`,
    `ADB available: ${report.adb.available}`,
    `Emulator available: ${report.tools.emulator.available}`,
    `AVD count: ${report.avds.fileSystem.avds.length}`,
    `Running devices: ${report.adb.devices.length}`,
    '',
    '## Commands'
  ];
  for (const command of report.plan.commands) {
    lines.push(`- ${command.id}: \`${command.command}\` -> ${command.expected}`);
  }
  lines.push('', '## Tools');
  for (const [name, probe] of Object.entries(report.tools)) {
    lines.push(`- ${name}: available=${probe.available} command=${probe.command ?? 'none'}`);
  }
  lines.push('', '## AVDs');
  if (report.avds.fileSystem.avds.length === 0) {
    lines.push('- none');
  } else {
    for (const avd of report.avds.fileSystem.avds) {
      lines.push(`- ${avd.name}: ${avd.displayName ?? avd.target ?? avd.path ?? 'configured'}`);
    }
  }
  if (report.start.requested) {
    lines.push('', '## Start');
    lines.push(`- Started: ${report.start.started === true}`);
    if (report.start.pid) lines.push(`- PID: ${report.start.pid}`);
    if (report.start.bootCompleted !== undefined) lines.push(`- Boot completed: ${report.start.bootCompleted}`);
    if (report.start.error) lines.push(`- Error: ${report.start.error}`);
  }
  lines.push('', '## Next Actions');
  for (const action of report.nextActions) lines.push(`- ${action}`);
  return `${lines.join('\n')}\n`;
}

export function renderAndroidEmulatorHtml(report) {
  const commands = report.plan.commands
    .map((item) => `<li>${htmlEscape(item.id)}: <code>${htmlEscape(item.command)}</code> - ${htmlEscape(item.expected)}</li>`)
    .join('');
  const actions = report.nextActions.map((item) => `<li>${htmlEscape(item)}</li>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS Android Emulator Readiness</title></head>
<body>
  <h1>JARVIS Android Emulator Readiness</h1>
  <p>Status: ${htmlEscape(report.status)}</p>
  <p>Selected AVD: ${htmlEscape(report.selectedAvd)}</p>
  <h2>Commands</h2>
  <ul>${commands}</ul>
  <h2>Readiness</h2>
  <pre>${htmlEscape(JSON.stringify(report, null, 2))}</pre>
  <h2>Next Actions</h2>
  <ul>${actions}</ul>
</body>
</html>
`;
}

export async function writeAndroidEmulatorArtifacts(report, {
  jsonPath = 'dist/mobile-android-emulator-report.json',
  markdownPath = 'dist/mobile-android-emulator-report.md',
  htmlPath = 'dist/mobile-android-emulator-report.html'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderAndroidEmulatorMarkdown(report), 'utf8');
  await writeFile(htmlPath, renderAndroidEmulatorHtml(report), 'utf8');
  return { jsonPath, markdownPath, htmlPath };
}

export async function runAndroidEmulatorReadiness({
  env = process.env,
  start = false,
  wait = false,
  headless = false,
  avd,
  probePathCommands = true,
  jsonPath = 'dist/mobile-android-emulator-report.json',
  markdownPath = 'dist/mobile-android-emulator-report.md',
  htmlPath = 'dist/mobile-android-emulator-report.html'
} = {}) {
  const setupPlan = createAndroidSetupPlan({ env });
  const sdkRoot = env.JARVIS_ANDROID_SDK_ROOT ?? env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? setupPlan.toolsHome;
  const emulatorProbe = await probeExecutable(commandCandidates('emulator', { env, sdkRoot }), {
    probePathCommands,
    versionArgs: ['-version']
  });
  const sdkManagerProbe = await probeExecutable(commandCandidates('sdkmanager', { env, sdkRoot }), { probePathCommands });
  const avdManagerProbe = await probeExecutable(commandCandidates('avdmanager', { env, sdkRoot }), { probePathCommands });
  const javaProbe = await probeExecutable(javaCandidates({ env }), { probePathCommands, versionArgs: ['-version'] });
  let adb = await listAdbDevices({ env: { ...env, JARVIS_ANDROID_TOOLS_HOME: setupPlan.toolsHome } });
  const fileSystemAvds = await listFileSystemAvds({ env });
  const emulatorAvds = await listEmulatorAvds(emulatorProbe);
  const selectedAvd = chooseAvd({ requestedAvd: avd, emulatorAvds, fileSystemAvds });
  const plan = createEmulatorPlan({ sdkRoot, selectedAvd });
  let startResult = { requested: false, started: false };
  if (start) {
    startResult = await startEmulator({ emulatorProbe, selectedAvd, headless });
    if (startResult.started && wait) {
      const boot = await waitForBoot({ adbCommand: adb.adb.command });
      startResult = { ...startResult, ...boot };
      adb = await listAdbDevices({ env: { ...env, JARVIS_ANDROID_TOOLS_HOME: setupPlan.toolsHome } });
    }
  }
  const draft = {
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    sdkRoot,
    selectedAvd,
    plan,
    tools: {
      emulator: emulatorProbe,
      sdkmanager: sdkManagerProbe,
      avdmanager: avdManagerProbe,
      java: javaProbe
    },
    adb,
    avds: {
      fileSystem: fileSystemAvds,
      emulator: emulatorAvds
    },
    start: startResult,
    nextActions: []
  };
  const report = {
    ...draft,
    status: readinessStatus({
      adbDevices: adb,
      emulatorProbe,
      fileSystemAvds,
      emulatorAvds,
      startResult
    })
  };
  report.nextActions = emulatorNextActions(report);
  report.artifacts = await writeAndroidEmulatorArtifacts(report, { jsonPath, markdownPath, htmlPath });
  return report;
}

function cliOptions(argv) {
  const options = { start: false, wait: false, headless: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--start') options.start = true;
    if (arg === '--wait') options.wait = true;
    if (arg === '--headless') options.headless = true;
    if (arg === '--avd') options.avd = argv[index + 1];
    if (arg === '--json') options.jsonPath = argv[index + 1];
    if (arg === '--md') options.markdownPath = argv[index + 1];
    if (arg === '--html') options.htmlPath = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runAndroidEmulatorReadiness(cliOptions(process.argv.slice(2)));
  console.log('# JARVIS Android Emulator Readiness');
  console.log(`Status: ${report.status}`);
  console.log(`Selected AVD: ${report.selectedAvd}`);
  console.log(`ADB devices: ${report.adb.devices.length}`);
  console.log(`Emulator available: ${report.tools.emulator.available}`);
  console.log(`Reports: ${report.artifacts.jsonPath}, ${report.artifacts.markdownPath}, ${report.artifacts.htmlPath}`);
  if (report.status === 'blocked') process.exitCode = 1;
}
