import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const javaVerifierPath = join(scriptsRoot, 'java', 'JarvisAndroidKeystoreVerifier.java');
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

function minimalEnvironment(env, extra = {}) {
  return Object.fromEntries(Object.entries({
    SystemRoot: env.SystemRoot ?? process.env.SystemRoot,
    WINDIR: env.WINDIR ?? process.env.WINDIR,
    PATH: env.PATH ?? process.env.PATH,
    TEMP: env.TEMP ?? process.env.TEMP,
    TMP: env.TMP ?? process.env.TMP,
    ...extra
  }).filter(([, value]) => configured(value)));
}

function javaCommand(env) {
  const home = env.JARVIS_ANDROID_JAVA_HOME || env.JAVA_HOME;
  return home ? join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : (process.platform === 'win32' ? 'java.exe' : 'java');
}

function parseSafeJson(value) {
  try {
    const start = String(value ?? '').indexOf('{');
    const end = String(value ?? '').lastIndexOf('}');
    if (start < 0 || end < start) return null;
    return JSON.parse(String(value).slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function verifyAndroidReleaseKeystore({
  env = process.env,
  runner = execFileAsync
} = {}) {
  const required = {
    path: configured(env.JARVIS_ANDROID_KEYSTORE_PATH),
    storePassword: configured(env.JARVIS_ANDROID_KEYSTORE_PASSWORD),
    alias: configured(env.JARVIS_ANDROID_KEY_ALIAS),
    keyPassword: configured(env.JARVIS_ANDROID_KEY_PASSWORD)
  };
  const configuredAll = Object.values(required).every(Boolean);
  if (!configuredAll) {
    return { status: 'not-configured', configured: required, verifierAvailable: null, secretValuesStored: false };
  }
  if (!await exists(env.JARVIS_ANDROID_KEYSTORE_PATH)) {
    return { status: 'file-missing', configured: required, verifierAvailable: null, secretValuesStored: false };
  }

  const childEnv = minimalEnvironment(env, {
    JARVIS_ANDROID_KEYSTORE_PATH: env.JARVIS_ANDROID_KEYSTORE_PATH,
    JARVIS_ANDROID_KEYSTORE_PASSWORD: env.JARVIS_ANDROID_KEYSTORE_PASSWORD,
    JARVIS_ANDROID_KEY_ALIAS: env.JARVIS_ANDROID_KEY_ALIAS,
    JARVIS_ANDROID_KEY_PASSWORD: env.JARVIS_ANDROID_KEY_PASSWORD
  });
  try {
    const { stdout } = await runner(javaCommand(env), [javaVerifierPath], {
      cwd: scriptsRoot,
      env: childEnv,
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 256 * 1024
    });
    const parsed = parseSafeJson(stdout);
    return parsed?.status === 'passed'
      ? { ...parsed, configured: required, verifierAvailable: true, secretValuesStored: false }
      : { status: 'verification-failed', configured: required, verifierAvailable: true, secretValuesStored: false };
  } catch (error) {
    const parsed = parseSafeJson(error?.stdout);
    return {
      ...(parsed ?? {}),
      status: 'verification-failed',
      configured: required,
      verifierAvailable: error?.code !== 'ENOENT',
      secretValuesStored: false
    };
  }
}

async function resolveEasCli({ appDir, env }) {
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

async function runEas(cli, args, options, runner) {
  if (process.platform === 'win32' && extname(cli).toLowerCase() === '.cmd') {
    const command = `"${cli}" ${args.join(' ')}`;
    return runner(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], options);
  }
  return runner(cli, args, options);
}

function containsExpectedProjectId(value, expectedId) {
  if (value === expectedId) return true;
  if (Array.isArray(value)) return value.some((item) => containsExpectedProjectId(item, expectedId));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsExpectedProjectId(item, expectedId));
  return false;
}

export async function verifyEasReleaseAccount({
  env = process.env,
  appDir,
  projectId,
  runner = execFileAsync
} = {}) {
  const configuredState = {
    token: configured(env.EXPO_TOKEN),
    projectId: configured(projectId) && uuidPattern.test(projectId)
  };
  if (!configuredState.token || !configuredState.projectId) {
    return { status: 'not-configured', configured: configuredState, cliAvailable: null, secretValuesStored: false };
  }
  const cli = await resolveEasCli({ appDir, env });
  const options = {
    cwd: appDir,
    env: minimalEnvironment(env, {
      EXPO_TOKEN: env.EXPO_TOKEN,
      EXPO_NO_DOCTOR: '1',
      CI: '1'
    }),
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  };
  try {
    await runEas(cli, ['whoami', '--non-interactive'], options, runner);
    const projectResult = await runEas(cli, ['project:info', '--json', '--non-interactive'], options, runner);
    const project = parseSafeJson(projectResult.stdout);
    const projectIdMatches = containsExpectedProjectId(project, projectId);
    return {
      status: projectIdMatches ? 'passed' : 'project-mismatch',
      configured: configuredState,
      cliAvailable: true,
      tokenAccepted: true,
      projectResolved: Boolean(project),
      projectIdMatches,
      secretValuesStored: false
    };
  } catch (error) {
    return {
      status: error?.code === 'ENOENT' ? 'cli-unavailable' : 'verification-failed',
      configured: configuredState,
      cliAvailable: error?.code !== 'ENOENT',
      tokenAccepted: false,
      projectResolved: false,
      projectIdMatches: false,
      secretValuesStored: false
    };
  }
}

export async function verifyMobileReleaseCredentials({
  env = process.env,
  appDir,
  projectId,
  androidVerifier = verifyAndroidReleaseKeystore,
  easVerifier = verifyEasReleaseAccount
} = {}) {
  const [androidKeystore, easAccount] = await Promise.all([
    androidVerifier({ env }),
    easVerifier({ env, appDir, projectId })
  ]);
  return {
    status: androidKeystore.status === 'passed' && easAccount.status === 'passed' ? 'passed' : 'blocked',
    androidKeystore,
    easAccount,
    privacy: {
      rawKeystorePasswordStored: false,
      rawKeyPasswordStored: false,
      rawAliasStored: false,
      rawExpoTokenStored: false,
      rawProjectIdStored: false,
      subprocessArgumentsContainSecrets: false
    }
  };
}
