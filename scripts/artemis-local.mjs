import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, linkSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireOwnedProcessLock } from '../packages/shared/src/owned-process-lock.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config/artemis-integration.json'), 'utf8'));

export function artemisPaths(root = ROOT, config = CONFIG, platform = process.platform) {
  function contained(value) {
    const path = resolve(root, value);
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw new Error('Artemis paths must stay inside this workspace.');
    }
    return path;
  }
  if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('Artemis must use a valid loopback port.');
  }
  const checkout = contained(config.checkout);
  const runtime = contained(config.runtimeDirectory);
  return {
    checkout, runtime,
    python: join(checkout, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    serverInfo: join(runtime, '.artemis_server.json'),
    startupIntent: join(runtime, 'startup-intent.json'),
    stdout: join(runtime, 'stdout.log'), stderr: join(runtime, 'stderr.log'),
    baseUrl: `http://${config.host}:${config.port}`
  };
}

export function validateOwnedArtemisServer(info, paths, config = CONFIG, livePid = null) {
  return Boolean(info && info.host === config.host && info.port === config.port
    && Number.isInteger(info.pid) && info.pid > 0 && info.pid === livePid
    && typeof info.cwd === 'string' && resolve(info.cwd) === paths.checkout
    && typeof info.sys_executable === 'string' && resolve(info.sys_executable) === paths.python
    && typeof info.lifecycle_token === 'string' && info.lifecycle_token.length >= 24);
}

function readInfo(paths) {
  try { return JSON.parse(readFileSync(paths.serverInfo, 'utf8')); } catch { return null; }
}

const STARTUP_VERSION = 'jarvis-artemis-startup-v1';

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function readStartupIntent(paths) {
  try { return JSON.parse(readFileSync(paths.startupIntent, 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? null : { invalid: true }; }
}

function validStartupIntent(intent, paths, config) {
  return Boolean(intent && intent.version === STARTUP_VERSION
    && typeof intent.id === 'string' && /^[a-f0-9-]{36}$/.test(intent.id)
    && Number.isInteger(intent.parentPid) && intent.parentPid > 0
    && (intent.forkPid === null || Number.isInteger(intent.forkPid) && intent.forkPid > 0)
    && typeof intent.lifecycleToken === 'string' && /^[a-f0-9]{64}$/.test(intent.lifecycleToken)
    && Number.isFinite(Date.parse(intent.createdAt))
    && intent.checkout === paths.checkout && intent.python === paths.python
    && intent.host === config.host && intent.port === config.port);
}

// Port readiness and parent liveness cannot establish that a detached child exited.
export function inspectArtemisStartup({ paths, config = CONFIG, isAlive = processAlive } = {}) {
  const intent = readStartupIntent(paths);
  if (intent && !validStartupIntent(intent, paths, config)) {
    return { state: 'unconfirmed', reason: 'invalid-startup-record', blocksSpawn: true };
  }
  const info = readInfo(paths);
  if (validateOwnedArtemisServer(info, paths, config, info?.pid) && isAlive(info.pid)) {
    return { state: 'process-alive', reason: 'managed-process-alive', pid: info.pid, blocksSpawn: true };
  }
  if (!intent) return { state: 'none', blocksSpawn: false };
  if (intent.forkPid === null) {
    // A parent may die after spawning but before saving the PID. Never guess no child exists.
    return { state: 'unconfirmed', reason: 'child-pid-not-recorded', parentPid: intent.parentPid, blocksSpawn: true };
  }
  if (isAlive(intent.forkPid)) {
    return { state: 'process-alive', reason: 'launched-process-alive', pid: intent.forkPid, blocksSpawn: true };
  }
  return { state: 'exited', pid: intent.forkPid, blocksSpawn: false };
}

function clearStartupIntent(paths, intent) {
  if (readStartupIntent(paths)?.id !== intent.id) throw new Error('ARTEMIS_STARTUP_RECORD_CHANGED');
  unlinkSync(paths.startupIntent);
}

function publishStartupIntent(paths, intent, replace = false) {
  const temporary = `${paths.startupIntent}.${randomUUID()}.candidate`;
  writeFileSync(temporary, `${JSON.stringify(intent)}\n`, { flag: 'wx', mode: 0o600, flush: true });
  try {
    if (replace) {
      if (readStartupIntent(paths)?.id !== intent.id) throw new Error('ARTEMIS_STARTUP_RECORD_CHANGED');
      renameSync(temporary, paths.startupIntent);
    } else {
      // Publish the complete pre-spawn intent exclusively; no empty record window.
      linkSync(temporary, paths.startupIntent);
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Caller holds lifecycle.lock throughout preparation, spawn, and PID publication.
export function prepareArtemisLaunch({ paths, config = CONFIG, isAlive = processAlive } = {}) {
  const state = inspectArtemisStartup({ paths, config, isAlive });
  if (state.blocksSpawn) {
    const error = new Error(`ARTEMIS_STARTUP_UNCONFIRMED: ${state.reason}; no additional process was started. Inspect ${paths.startupIntent} and ${paths.serverInfo}.`);
    error.code = 'ARTEMIS_STARTUP_UNCONFIRMED';
    error.startup = state;
    throw error;
  }
  const previous = readStartupIntent(paths);
  if (previous) clearStartupIntent(paths, previous);
  const intent = Object.freeze({
    version: STARTUP_VERSION, id: randomUUID(), parentPid: process.pid, forkPid: null,
    lifecycleToken: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(), checkout: paths.checkout, python: paths.python,
    host: config.host, port: config.port
  });
  mkdirSync(paths.runtime, { recursive: true });
  publishStartupIntent(paths, intent);
  return intent;
}

export function recordArtemisLaunchPid({ paths, intent, childPid } = {}) {
  if (!Number.isInteger(childPid) || childPid <= 0) throw new Error('ARTEMIS_CHILD_PID_REQUIRED');
  const updated = Object.freeze({ ...intent, forkPid: childPid });
  publishStartupIntent(paths, updated, true);
  return updated;
}

export function validateArtemisLaunchInstance({ paths, config = CONFIG, intent, info, livePid } = {}) {
  return Boolean(validStartupIntent(intent, paths, config)
    && validateOwnedArtemisServer(info, paths, config, livePid)
    && info.lifecycle_token === intent.lifecycleToken);
}

async function portOpen(port) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolveResult(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(800, () => finish(false));
  });
}

async function readJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Artemis HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Artemis status too large');
  return JSON.parse(text);
}

async function serverIdentity(paths) {
  try {
    const [api, status] = await Promise.all([
      readJson(`${paths.baseUrl}/openapi.json`), readJson(`${paths.baseUrl}/api/system/server-status`)
    ]);
    return {
      valid: api.info?.title === 'Artemis Admin & Trace Console'
        && Boolean(api.paths?.['/api/system/readiness'] && api.paths?.['/api/sessions/{session_id}'])
        && status.running === true && Number.isInteger(status.current_pid) && status.current_pid > 0,
      pid: status.current_pid ?? null
    };
  } catch { return { valid: false, pid: null }; }
}

export async function inspectArtemis({ paths = artemisPaths(), config = CONFIG } = {}) {
  let revision = null;
  if (existsSync(join(paths.checkout, '.git'))) {
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.checkout, encoding: 'utf8', windowsHide: true }).trim(); } catch { /* report unavailable */ }
  }
  const listening = await portOpen(config.port);
  const identity = listening ? await serverIdentity(paths) : { valid: false, pid: null };
  const identityVerified = identity.valid;
  const owned = validateOwnedArtemisServer(readInfo(paths), paths, config, identity.pid);
  return {
    reportVersion: 'jarvis-artemis-local-v1', generatedAt: new Date().toISOString(),
    installed: existsSync(paths.python), revision, revisionMatches: revision === config.revision,
    baseUrl: paths.baseUrl, listening, identityVerified,
    currentPid: identityVerified ? identity.pid : null,
    managedByThisCheckout: identityVerified && owned,
    startup: inspectArtemisStartup({ paths, config }),
    // Server readiness does not imply a connected device, model access or task success.
    deviceTaskVerified: false
  };
}

export async function startArtemis({ paths = artemisPaths(), config = CONFIG } = {}) {
  const lock = await acquireOwnedProcessLock({ lockPath: join(paths.runtime, 'lifecycle.lock') });
  try { return await startArtemisUnlocked({ paths, config }); }
  finally { await lock.release(); }
}

async function startArtemisUnlocked({ paths, config }) {
  const before = await inspectArtemis({ paths, config });
  if (before.listening) {
    if (!before.managedByThisCheckout) throw new Error('Port is occupied by an unowned service; no process was changed.');
    return { ...before, action: 'already-running' };
  }
  if (!before.installed || !before.revisionMatches) {
    throw new Error('Pinned ARTEMIS checkout and its virtual environment are required. See docs/artemis-integration.md.');
  }
  mkdirSync(paths.runtime, { recursive: true });
  const stdout = openSync(paths.stdout, 'a');
  const stderr = openSync(paths.stderr, 'a');
  const env = {
    ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
    ARTEMIS_APP_DIR: paths.runtime, ARTEMIS_TRACES_DIR: join(paths.runtime, 'traces'),
    ARTEMIS_KEEP_DEVICE_AWAKE: 'false', ARTEMIS_HELPER_AUTO_INSTALL: 'false',
    ARTEMIS_DESKTOP_NOTIFY: 'false', LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false'
  };
  for (const key of ['ARTEMIS_LIFECYCLE_TOKEN', 'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN',
    'ARTEMIS_NOTIFY_CMD', 'OPENCLAW_WEBHOOK_URL', 'MCP_NOTIFICATION_WEBHOOK', 'ARTEMIS_WEBHOOK_URL']) delete env[key];
  let child;
  let intent;
  try {
    intent = prepareArtemisLaunch({ paths, config });
    env.ARTEMIS_LIFECYCLE_TOKEN = intent.lifecycleToken;
    child = spawn(paths.python, ['-m', config.entryModule, '--host', config.host, '--port', String(config.port)], {
      cwd: paths.checkout, env, stdio: ['ignore', stdout, stderr], detached: true, windowsHide: true
    });
    child.unref();
    if (Number.isInteger(child.pid) && child.pid > 0) {
      intent = recordArtemisLaunchPid({ paths, intent, childPid: child.pid });
    }
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  } catch (error) {
    // A spawn failure with no PID proves no child was created. Otherwise retain the evidence.
    if (intent && !child?.pid) clearStartupIntent(paths, intent);
    throw error;
  } finally { closeSync(stdout); closeSync(stderr); }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await inspectArtemis({ paths, config });
    if (state.managedByThisCheckout && validateArtemisLaunchInstance({
      paths, config, intent, info: readInfo(paths), livePid: state.currentPid
    })) {
      clearStartupIntent(paths, intent);
      return { ...state, action: 'started' };
    }
    if (child.exitCode !== null) throw new Error(`Artemis startup failed (exit ${child.exitCode}); see ${paths.stderr}`);
    await delay(500);
  }
  throw new Error(`ARTEMIS_STARTUP_UNCONFIRMED: startup did not verify within 30 seconds; child PID ${child.pid} remains recorded and duplicate starts are blocked while it is alive. Inspect ${paths.stderr}`);
}

export async function stopArtemis({ paths = artemisPaths(), config = CONFIG } = {}) {
  const lock = await acquireOwnedProcessLock({ lockPath: join(paths.runtime, 'lifecycle.lock') });
  try { return await stopArtemisUnlocked({ paths, config }); }
  finally { await lock.release(); }
}

async function stopArtemisUnlocked({ paths, config }) {
  const before = await inspectArtemis({ paths, config });
  if (!before.listening) {
    if (before.startup.blocksSpawn) throw new Error(`ARTEMIS_STARTUP_UNCONFIRMED: ${before.startup.reason}; the process has not been confirmed stopped.`);
    return { ...before, action: 'already-stopped' };
  }
  if (!before.managedByThisCheckout) throw new Error('Refusing to stop a service not owned by this checkout.');
  const info = readInfo(paths);
  if (!validateOwnedArtemisServer(info, paths, config, before.currentPid)) throw new Error('Server ownership changed.');
  await readJson(`${paths.baseUrl}/api/system/shutdown`, {
    method: 'POST', headers: { 'X-Artemis-Lifecycle-Token': info.lifecycle_token }
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!await portOpen(config.port) && !processAlive(before.currentPid)) {
      return { ...before, currentPid: null, listening: false, identityVerified: false,
        managedByThisCheckout: false, startup: inspectArtemisStartup({ paths, config }), action: 'stopped' };
    }
    await delay(300);
  }
  throw new Error('Graceful stop remains unconfirmed; no unrelated process was terminated.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--status';
    if (!['--status', '--start', '--stop'].includes(mode)) throw new Error('Use --status, --start or --stop.');
    const report = await (mode === '--start' ? startArtemis() : mode === '--stop' ? stopArtemis() : inspectArtemis());
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
