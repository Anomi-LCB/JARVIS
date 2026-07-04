import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveAdbCommand } from './mobile-device-smoke.mjs';

const execFileAsync = promisify(execFile);

function adbBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'adb.exe' : 'adb';
}

function archivePlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

function defaultAndroidToolsHome(env = process.env, platform = process.platform) {
  if (env.JARVIS_ANDROID_TOOLS_HOME) return env.JARVIS_ANDROID_TOOLS_HOME;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : null);
    if (localAppData) return join(localAppData, 'Jarvis', 'Android');
  }
  return join(env.HOME ?? homedir(), '.jarvis', 'android');
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

function setupStatusLabel(report) {
  if (report.adbProbe.available) return report.install.success ? 'installed' : 'ready';
  if (report.install.requested) return 'blocked';
  return 'missing';
}

function powerShellEnvCommand(name, value) {
  const escaped = String(value).replaceAll("'", "''");
  return `$env:${name}='${escaped}'`;
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function serializeCommandError(error) {
  return {
    code: error.code ?? null,
    message: error.message,
    stdout: error.stdout ? String(error.stdout).trim() : '',
    stderr: error.stderr ? String(error.stderr).trim() : ''
  };
}

function installErrorMessage(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string' || typeof error === 'number') return String(error);
  return error.stderr || error.message || error.code || 'unknown error';
}

async function probeAdbVersion(adbResolution) {
  try {
    const { stdout } = await execFileAsync(adbResolution.command, ['version'], {
      windowsHide: true,
      timeout: 7000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    const versionLine = stdout.split(/\r?\n/).find(Boolean) ?? '';
    return {
      available: true,
      command: adbResolution.command,
      source: adbResolution.source,
      versionLine
    };
  } catch (error) {
    return {
      available: false,
      command: adbResolution.command,
      source: adbResolution.source,
      error: error.code ?? error.message
    };
  }
}

async function downloadPlatformTools(plan) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is unavailable in this Node runtime');
  }
  await mkdir(plan.toolsHome, { recursive: true });
  const response = await fetch(plan.downloadUrl);
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(plan.archivePath, bytes);
  return { archivePath: plan.archivePath, bytes: bytes.length };
}

async function extractPlatformToolsArchive(plan) {
  await mkdir(plan.toolsHome, { recursive: true });
  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath ${powerShellLiteral(plan.archivePath)} -DestinationPath ${powerShellLiteral(plan.toolsHome)} -Force`
      ],
      { windowsHide: true, timeout: 60000, maxBuffer: 5 * 1024 * 1024 }
    );
    return { extractor: 'powershell Expand-Archive', destination: plan.toolsHome };
  }
  await execFileAsync('unzip', ['-o', plan.archivePath, '-d', plan.toolsHome], {
    timeout: 60000,
    maxBuffer: 5 * 1024 * 1024
  });
  return { extractor: 'unzip', destination: plan.toolsHome };
}

export function createAndroidSetupPlan({ env = process.env, platform = process.platform } = {}) {
  const toolsHome = defaultAndroidToolsHome(env, platform);
  const platformToolsDir = join(toolsHome, 'platform-tools');
  const adbPath = join(platformToolsDir, adbBinaryName(platform));
  const archiveName = `platform-tools-latest-${archivePlatform(platform)}.zip`;
  const archivePath = join(toolsHome, archiveName);
  const downloadUrl = `https://dl.google.com/android/repository/${archiveName}`;
  return {
    toolsHome,
    platformToolsDir,
    adbPath,
    archiveName,
    archivePath,
    downloadUrl,
    environment: {
      jarvisAndroidToolsHome: 'JARVIS_ANDROID_TOOLS_HOME',
      jarvisAdbPath: 'JARVIS_ADB_PATH',
      androidHome: 'ANDROID_HOME',
      androidSdkRoot: 'ANDROID_SDK_ROOT'
    },
    commands: [
      {
        id: 'detect',
        command: 'npm run mobile:setup-android',
        expected: 'Resolve existing adb and write setup reports without changing the machine.'
      },
      {
        id: 'install-platform-tools',
        command: 'npm run mobile:setup-android -- --install',
        expected: 'Download Android SDK Platform Tools into the local JARVIS tools cache.'
      },
      {
        id: 'use-local-adb-powershell',
        command: `${powerShellEnvCommand('JARVIS_ADB_PATH', adbPath)}; npm run mobile:device`,
        expected: 'Run device smoke with the locally resolved adb executable.'
      },
      {
        id: 'expo-install-device',
        command: 'cd apps/mobile && npx expo run:android --device',
        expected: 'Install local.eureka.jarvis on a connected Android device or emulator.'
      },
      {
        id: 'verify-device',
        command: 'npm run mobile:device',
        expected: 'Capture screenshot, UI XML, and native runtime probe evidence.'
      }
    ]
  };
}

export function androidSetupNextActions(report) {
  if (report.status === 'ready' || report.status === 'installed') {
    return [
      'Open an Android emulator or connect a USB-debugging-enabled Android device.',
      'Run cd apps/mobile && npx expo run:android --device.',
      'Run npm run mobile:device to capture device evidence.'
    ];
  }
  if (report.install.requested) {
    return [
      `Review the install error: ${installErrorMessage(report.install.error)}.`,
      `Download manually if needed: ${report.plan.downloadUrl}`,
      `Extract platform-tools into: ${report.plan.toolsHome}`,
      `Set JARVIS_ADB_PATH to: ${report.plan.adbPath}`,
      'Run npm run mobile:setup-android again.'
    ];
  }
  return [
    'Run npm run mobile:setup-android -- --install to download Android SDK Platform Tools into the JARVIS cache.',
    `Or install Android Studio / Platform Tools manually and set JARVIS_ADB_PATH to ${report.plan.adbPath}.`,
    'Then start an emulator or connect a USB-debugging-enabled Android device.',
    'Run npm run mobile:device again.'
  ];
}

export function renderAndroidSetupMarkdown(report) {
  const lines = [
    '# JARVIS Android Platform Tools Setup',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `ADB available: ${report.adbProbe.available}`,
    `ADB command: ${report.adbProbe.command}`,
    `ADB source: ${report.adbProbe.source}`,
    report.adbProbe.versionLine ? `ADB version: ${report.adbProbe.versionLine}` : `ADB error: ${report.adbProbe.error ?? 'none'}`,
    '',
    '## Local Tools Plan',
    `- Tools home: ${report.plan.toolsHome}`,
    `- Platform tools dir: ${report.plan.platformToolsDir}`,
    `- ADB path: ${report.plan.adbPath}`,
    `- Download URL: ${report.plan.downloadUrl}`,
    '',
    '## Commands'
  ];
  for (const command of report.plan.commands) {
    lines.push(`- ${command.id}: \`${command.command}\` -> ${command.expected}`);
  }
  lines.push('', '## ADB Resolution');
  for (const item of report.adbResolution.checked ?? []) {
    lines.push(`- ${item.source}: ${item.command} exists=${item.exists ?? item.executable ?? 'unknown'}`);
  }
  lines.push('', '## Next Actions');
  for (const action of report.nextActions) lines.push(`- ${action}`);
  return `${lines.join('\n')}\n`;
}

export function renderAndroidSetupHtml(report) {
  const commands = report.plan.commands
    .map((item) => `<li>${htmlEscape(item.id)}: <code>${htmlEscape(item.command)}</code> - ${htmlEscape(item.expected)}</li>`)
    .join('');
  const checked = (report.adbResolution.checked ?? [])
    .map((item) => `<li>${htmlEscape(item.source)}: <code>${htmlEscape(item.command)}</code> exists=${htmlEscape(item.exists ?? item.executable ?? 'unknown')}</li>`)
    .join('');
  const actions = report.nextActions.map((item) => `<li>${htmlEscape(item)}</li>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS Android Platform Tools Setup</title></head>
<body>
  <h1>JARVIS Android Platform Tools Setup</h1>
  <p>Status: ${htmlEscape(report.status)}</p>
  <p>ADB available: ${htmlEscape(report.adbProbe.available)}</p>
  <p>ADB: ${htmlEscape(report.adbProbe.command)} (${htmlEscape(report.adbProbe.source)})</p>
  <h2>Local Tools Plan</h2>
  <pre>${htmlEscape(JSON.stringify(report.plan, null, 2))}</pre>
  <h2>Commands</h2>
  <ul>${commands}</ul>
  <h2>ADB Resolution</h2>
  <ul>${checked}</ul>
  <h2>Next Actions</h2>
  <ul>${actions}</ul>
</body>
</html>
`;
}

export async function writeAndroidSetupArtifacts(report, {
  jsonPath = 'dist/mobile-android-setup-report.json',
  markdownPath = 'dist/mobile-android-setup-report.md',
  htmlPath = 'dist/mobile-android-setup-report.html'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderAndroidSetupMarkdown(report), 'utf8');
  await writeFile(htmlPath, renderAndroidSetupHtml(report), 'utf8');
  return { jsonPath, markdownPath, htmlPath };
}

export async function runAndroidSetup({
  install = false,
  env = process.env,
  jsonPath = 'dist/mobile-android-setup-report.json',
  markdownPath = 'dist/mobile-android-setup-report.md',
  htmlPath = 'dist/mobile-android-setup-report.html'
} = {}) {
  const plan = createAndroidSetupPlan({ env });
  const installResult = {
    requested: install,
    attempted: false,
    downloaded: null,
    extracted: null,
    success: false,
    error: null
  };

  if (install) {
    installResult.attempted = true;
    try {
      installResult.downloaded = await downloadPlatformTools(plan);
      installResult.extracted = await extractPlatformToolsArchive(plan);
      installResult.success = await exists(plan.adbPath);
    } catch (error) {
      installResult.error = serializeCommandError(error);
    }
  }

  const localAdbExists = await exists(plan.adbPath);
  const resolutionEnv = {
    ...env,
    JARVIS_ANDROID_TOOLS_HOME: plan.toolsHome,
    JARVIS_ADB_PATH: localAdbExists ? plan.adbPath : env.JARVIS_ADB_PATH
  };
  const adbResolution = await resolveAdbCommand({ env: resolutionEnv });
  const adbProbe = await probeAdbVersion(adbResolution);
  const draft = {
    generatedAt: new Date().toISOString(),
    status: 'missing',
    install: installResult,
    plan,
    localAdbExists,
    adbResolution,
    adbProbe,
    nextActions: []
  };
  const report = {
    ...draft,
    status: setupStatusLabel(draft)
  };
  report.nextActions = androidSetupNextActions(report);
  report.artifacts = await writeAndroidSetupArtifacts(report, { jsonPath, markdownPath, htmlPath });
  return report;
}

function cliOptions(argv) {
  const options = { install: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--install') options.install = true;
    if (arg === '--json') options.jsonPath = argv[index + 1];
    if (arg === '--md') options.markdownPath = argv[index + 1];
    if (arg === '--html') options.htmlPath = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runAndroidSetup(cliOptions(process.argv.slice(2)));
  console.log('# JARVIS Android Platform Tools Setup');
  console.log(`Status: ${report.status}`);
  console.log(`ADB available: ${report.adbProbe.available}`);
  console.log(`ADB command: ${report.adbProbe.command}`);
  console.log(`Reports: ${report.artifacts.jsonPath}, ${report.artifacts.markdownPath}, ${report.artifacts.htmlPath}`);
  if (report.status === 'blocked') process.exitCode = 1;
}
