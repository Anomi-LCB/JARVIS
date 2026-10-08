import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sourceFingerprint(appDir) {
  const root = resolve(appDir, '..', '..');
  const files = [
    join(appDir, 'app.json'),
    join(appDir, 'eas.json'),
    join(appDir, 'package.json'),
    join(appDir, 'android', 'app', 'build.gradle'),
    join(root, 'pnpm-lock.yaml')
  ];
  const records = await Promise.all(files.map(async (path) => ({
    path: path.slice(root.length).replaceAll('\\', '/'),
    content: await readFile(path, 'utf8')
  })));
  return sha256(records.map((record) => `${record.path}\0${record.content}`).join('\0'));
}

function parseJsonOutput(value) {
  const text = String(value ?? '').trim();
  for (const opener of ['[', '{']) {
    const start = text.indexOf(opener);
    if (start < 0) continue;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      // Try the next JSON shape.
    }
  }
  return null;
}

function flattenBuilds(value) {
  if (Array.isArray(value)) return value.flatMap(flattenBuilds);
  if (!value || typeof value !== 'object') return [];
  if (value.id && (value.status || value.platform)) return [value];
  return Object.values(value).flatMap(flattenBuilds);
}

async function resolveEasCli(appDir, env) {
  const root = resolve(appDir, '..', '..');
  const binary = process.platform === 'win32' ? 'eas.cmd' : 'eas';
  const candidates = [
    env.JARVIS_EAS_CLI_PATH,
    join(appDir, 'node_modules', '.bin', binary),
    join(root, 'node_modules', '.bin', binary)
  ].filter(configured);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return binary;
}

function childEnvironment(env) {
  return Object.fromEntries(Object.entries({
    SystemRoot: env.SystemRoot ?? process.env.SystemRoot,
    WINDIR: env.WINDIR ?? process.env.WINDIR,
    PATH: env.PATH ?? process.env.PATH,
    TEMP: env.TEMP ?? process.env.TEMP,
    TMP: env.TMP ?? process.env.TMP,
    EXPO_TOKEN: env.EXPO_TOKEN,
    EXPO_NO_DOCTOR: '1',
    CI: '1'
  }).filter(([, value]) => configured(value)));
}

async function runEas(cli, args, options, runner) {
  if (process.platform === 'win32' && extname(cli).toLowerCase() === '.cmd') {
    const command = `"${cli}" ${args.join(' ')}`;
    return runner(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], options);
  }
  return runner(cli, args, options);
}

function safeBuild(build) {
  return {
    buildIdHash: configured(build?.id) ? sha256(String(build.id)) : null,
    platform: String(build?.platform ?? '').toLowerCase(),
    status: String(build?.status ?? '').toUpperCase(),
    appVersion: build?.appVersion ?? null,
    appBuildVersion: build?.appBuildVersion ?? null
  };
}

export async function runMobileEasProductionBuild({
  appDir = 'apps/mobile',
  env = process.env,
  platform = 'android',
  outputPath = 'dist/mobile-eas-production-build.json',
  execute = false,
  runner = execFileAsync,
  clock = () => new Date()
} = {}) {
  if (!execute) throw new Error('explicit-execute-required');
  const projectId = env.JARVIS_EAS_PROJECT_ID;
  if (!configured(env.EXPO_TOKEN) || !configured(projectId) || !uuidPattern.test(projectId)) {
    throw new Error('valid-eas-credential-and-project-required');
  }
  const cli = await resolveEasCli(appDir, env);
  const options = {
    cwd: appDir,
    env: childEnvironment(env),
    timeout: 45 * 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  };
  let result;
  try {
    result = await runEas(cli, [
      'build', '--platform', platform, '--profile', 'production', '--non-interactive', '--wait', '--json'
    ], options, runner);
  } catch (error) {
    throw new Error(error?.code === 'ENOENT' ? 'eas-cli-unavailable' : 'eas-production-build-failed');
  }
  const builds = flattenBuilds(parseJsonOutput(result.stdout)).map(safeBuild);
  const matchingBuild = builds.find((build) => build.platform === platform && build.status === 'FINISHED');
  const report = {
    reportVersion: 'jarvis-mobile-eas-production-build-v1',
    generatedAt: clock().toISOString(),
    status: matchingBuild ? 'passed' : 'blocked',
    platform,
    profile: 'production',
    projectIdHash: sha256(projectId),
    sourceFingerprint: await sourceFingerprint(appDir),
    build: matchingBuild ?? builds[0] ?? null,
    privacy: {
      rawExpoTokenStored: false,
      rawProjectIdStored: false,
      rawBuildUrlStored: false,
      rawCliOutputStored: false,
      credentialsPassedInProcessArguments: false
    }
  };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function verifyMobileEasBuildEvidence({
  appDir = 'apps/mobile',
  env = process.env,
  evidencePath = 'dist/mobile-eas-production-build.json',
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  now = new Date()
} = {}) {
  let report;
  try {
    report = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch {
    return { status: 'missing', passed: false, secretValuesStored: false };
  }
  const projectId = env.JARVIS_EAS_PROJECT_ID;
  const generatedAt = Date.parse(report.generatedAt);
  const ageMs = Number.isFinite(generatedAt) ? now.getTime() - generatedAt : Number.POSITIVE_INFINITY;
  const checks = {
    schemaValid: report.reportVersion === 'jarvis-mobile-eas-production-build-v1',
    buildPassed: report.status === 'passed' && report.build?.status === 'FINISHED' && report.build?.platform === 'android',
    projectMatches: configured(projectId) && report.projectIdHash === sha256(projectId),
    sourceMatches: report.sourceFingerprint === await sourceFingerprint(appDir),
    evidenceFresh: ageMs >= 0 && ageMs <= maxAgeMs,
    privacySafe: report.privacy?.rawExpoTokenStored === false
      && report.privacy?.rawProjectIdStored === false
      && report.privacy?.rawBuildUrlStored === false
      && report.privacy?.rawCliOutputStored === false
      && report.privacy?.credentialsPassedInProcessArguments === false
  };
  return {
    status: Object.values(checks).every(Boolean) ? 'passed' : 'blocked',
    passed: Object.values(checks).every(Boolean),
    checks,
    ageHours: Number.isFinite(ageMs) ? Math.round(ageMs / 36_000) / 100 : null,
    secretValuesStored: false
  };
}

function parseArgs(argv) {
  const options = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--execute') options.execute = true;
    else if (argv[index] === '--platform') options.platform = argv[++index];
    else if (argv[index] === '--app-dir') options.appDir = argv[++index];
    else if (argv[index] === '--output') options.outputPath = argv[++index];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.execute) {
    runMobileEasProductionBuild(options).then((report) => {
      console.log(JSON.stringify({ status: report.status, platform: report.platform, privacy: report.privacy }, null, 2));
      if (report.status !== 'passed') process.exitCode = 1;
    }).catch((error) => {
      console.error(`JARVIS EAS production build blocked: ${error.message}`);
      process.exit(1);
    });
  } else {
    verifyMobileEasBuildEvidence(options).then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    });
  }
}
