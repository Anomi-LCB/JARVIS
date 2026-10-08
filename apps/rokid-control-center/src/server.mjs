import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdbClient, resolveAdbPath } from './adb-client.js';
import { AuditLog } from './audit-log.js';
import { BackupService } from './backup-service.js';
import { DeviceService } from './device-service.js';
import { FineTuneService } from './fine-tune-service.js';
import { JobStore } from './job-store.js';
import { ProfileService } from './profile-service.js';
import { UpdateService } from './update-service.js';

const sourceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const publicRoot = join(sourceRoot, 'public');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

export async function createRokidControlServer({
  portableRoot = '',
  dataRoot = '',
  adbPath = '',
  idleExitMs = 0,
  now = () => new Date()
} = {}) {
  const resolvedDataRoot = resolve(dataRoot || (portableRoot ? join(portableRoot, 'data') : join(sourceRoot, '..', 'data')));
  await mkdir(resolvedDataRoot, { recursive: true });
  const resolvedAdbPath = adbPath || await resolveAdbPath({ portableRoot });
  const audit = new AuditLog(join(resolvedDataRoot, 'audit', 'device-actions.jsonl'), { now });
  const adb = new AdbClient({ adbPath: resolvedAdbPath });
  const deviceService = new DeviceService({ adb, audit });
  const backupService = new BackupService({ adb, deviceService, audit, backupRoot: join(resolvedDataRoot, 'backups'), now });
  const profileService = new ProfileService({ deviceService, audit, dataRoot: resolvedDataRoot, now });
  const fineTuneService = new FineTuneService({ deviceService, audit, dataRoot: resolvedDataRoot, now });
  const updateService = new UpdateService({ adb, deviceService, audit, dataRoot: resolvedDataRoot, now });
  const jobs = new JobStore();
  const sessionToken = randomBytes(24).toString('hex');
  const context = { resolvedAdbPath, resolvedDataRoot, audit, deviceService, backupService, profileService, fineTuneService, updateService, jobs, sessionToken };
  const server = createServer((request, response) => routeRequest(request, response, context));
  installIdleShutdown(server, idleExitMs);
  return server;
}

export function installIdleShutdown(server, idleExitMs) {
  const timeoutMs = Number(idleExitMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
  let interval = null;
  let lastRequestAt = 0;
  let requestSeen = false;
  const start = () => {
    if (interval) return;
    lastRequestAt = Date.now();
    interval = setInterval(() => {
      const activeTimeoutMs = requestSeen ? timeoutMs : Math.max(timeoutMs, 1_000);
      if (Date.now() - lastRequestAt < activeTimeoutMs) return;
      clearInterval(interval);
      interval = null;
      server.close();
    }, Math.min(1_000, Math.max(50, Math.floor(timeoutMs / 3))));
    interval.unref();
  };
  server.on('request', () => {
    requestSeen = true;
    lastRequestAt = Date.now();
  });
  server.once('listening', start);
  if (server.listening) start();
  server.on('close', () => {
    if (interval) clearInterval(interval);
    interval = null;
  });
}

async function routeRequest(request, response, context) {
  setSecurityHeaders(response);
  try {
    const host = String(request.headers.host ?? '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) throw new HttpError(403, '로컬 요청만 허용됩니다.');
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname === '/api/session' && request.method === 'GET') {
      sendJson(response, 200, { token: context.sessionToken, server: 'rokid-control-center-v1' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') requireMutationGuard(request, context.sessionToken);
      await routeApi(request, response, url, context);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) throw new HttpError(405, '지원하지 않는 HTTP 메서드입니다.');
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const statusCode = Number(error.statusCode ?? 500);
    sendJson(response, statusCode, {
      error: statusCode >= 500 ? '내부 처리 오류가 발생했습니다.' : String(error.message),
      details: error.details ?? undefined
    });
  }
}

async function routeApi(request, response, url, context) {
  const { deviceService, backupService, profileService, fineTuneService, updateService, audit, jobs } = context;
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', server: 'rokid-control-center-v1' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    const [devices, latestBackup, auditTail] = await Promise.all([deviceService.devices(), backupService.latest(), audit.tail(25)]);
    sendJson(response, 200, { devices, latestBackup, audit: auditTail, adbPath: context.resolvedAdbPath, dataRoot: context.resolvedDataRoot });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/overview') {
    sendJson(response, 200, await deviceService.overview(url.searchParams.get('serial') ?? ''));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/packages') {
    sendJson(response, 200, await deviceService.packages(url.searchParams.get('serial') ?? ''));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/settings') {
    sendJson(response, 200, await deviceService.settings(url.searchParams.get('scope') ?? 'system', url.searchParams.get('serial') ?? ''));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/logcat') {
    sendJson(response, 200, { output: await deviceService.logcat({ serial: url.searchParams.get('serial') ?? '', lines: url.searchParams.get('lines') ?? 200 }) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/screenshot') {
    const screenshot = await deviceService.screenshot(url.searchParams.get('serial') ?? '');
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': screenshot.length, 'cache-control': 'no-store' });
    response.end(screenshot);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/screen-stream') {
    await streamDeviceScreen(request, response, deviceService, url.searchParams.get('serial') ?? '');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/device/screen-interaction') {
    const payload = await readJson(request);
    sendJson(response, 200, await deviceService.screenInteraction(payload));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/device/control') {
    const payload = await readJson(request);
    sendJson(response, 200, await deviceService.control(payload));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/backup') {
    const payload = await readJson(request);
    const job = jobs.start('backup', (onProgress) => backupService.create({ mode: payload.mode, serial: payload.serial, onProgress }));
    sendJson(response, 202, job);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/profiles') {
    sendJson(response, 200, await profileService.list());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/profiles/save') {
    const payload = await readJson(request);
    sendJson(response, 201, await profileService.saveCurrent(payload.name, payload.serial ?? ''));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/profiles/apply') {
    const payload = await readJson(request);
    sendJson(response, 200, await profileService.apply(payload.profileId, payload.serial ?? ''));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/profiles/undo') {
    const payload = await readJson(request);
    sendJson(response, 200, await profileService.undo(payload.serial ?? ''));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/fine-tune') {
    sendJson(response, 200, await fineTuneService.list(url.searchParams.get('serial') ?? ''));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/fine-tune/change') {
    const payload = await readJson(request);
    sendJson(response, 200, await fineTuneService.change(payload));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/fine-tune/undo') {
    const payload = await readJson(request);
    sendJson(response, 200, await fineTuneService.undo(payload.serial ?? ''));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/update/status') {
    sendJson(response, 200, await updateService.status(url.searchParams.get('serial') ?? ''));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/update/open-inbox') {
    sendJson(response, 200, await updateService.openInbox());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/update/import') {
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    if (!['application/zip', 'application/octet-stream'].some((type) => contentType.startsWith(type))) throw new HttpError(415, 'ZIP 파일만 가져올 수 있습니다.');
    sendJson(response, 201, await updateService.importPackage(url.searchParams.get('filename') ?? '', request));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/update/prepare') {
    const payload = await readJson(request);
    sendJson(response, 200, await updateService.prepare(payload.filename));
    return;
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (request.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) throw new HttpError(404, '작업을 찾을 수 없습니다.');
    sendJson(response, 200, job);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/audit') {
    sendJson(response, 200, await audit.tail(url.searchParams.get('limit') ?? 100));
    return;
  }
  throw new HttpError(404, 'API 경로를 찾을 수 없습니다.');
}

async function streamDeviceScreen(request, response, deviceService, serial) {
  const boundary = 'rokid-live-frame';
  let closed = false;
  request.once('close', () => { closed = true; });
  response.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
    'cache-control': 'no-store, no-cache, must-revalidate',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  });
  while (!closed && !response.destroyed) {
    const startedAt = Date.now();
    const screenshot = await deviceService.screenshot(serial);
    if (closed || response.destroyed) break;
    response.write(`--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${screenshot.length}\r\nX-Frame-Time: ${Date.now()}\r\n\r\n`);
    response.write(screenshot);
    response.write('\r\n');
    const waitMs = Math.max(0, 500 - (Date.now() - startedAt));
    if (waitMs) await delay(waitMs);
  }
  if (!response.destroyed) response.end(`--${boundary}--\r\n`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function serveStatic(request, response, pathname) {
  const relativePath = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, ''));
  const filePath = resolve(publicRoot, relativePath);
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + sep)) throw new HttpError(403, '허용되지 않는 경로입니다.');
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, '파일을 찾을 수 없습니다.');
  }
  if (!info.isFile()) throw new HttpError(404, '파일을 찾을 수 없습니다.');
  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store'
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

async function readJson(request, maximum = 64 * 1024) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON 요청만 허용됩니다.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new HttpError(413, '요청 크기가 너무 큽니다.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, '올바른 JSON이 아닙니다.');
  }
}

function requireMutationGuard(request, token) {
  const origin = String(request.headers.origin ?? '');
  const host = String(request.headers.host ?? '');
  if (origin && new URL(origin).host !== host) throw new HttpError(403, '다른 출처의 변경 요청을 거부했습니다.');
  if (request.headers['x-rokid-control-token'] !== token) throw new HttpError(403, '제어 세션 토큰이 필요합니다.');
}

function setSecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(body);
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host') parsed.host = argv[++index];
    else if (argv[index] === '--port') parsed.port = Number(argv[++index]);
    else if (argv[index] === '--portable-root') parsed.portableRoot = resolve(argv[++index]);
    else if (argv[index] === '--data-root') parsed.dataRoot = resolve(argv[++index]);
    else if (argv[index] === '--adb') parsed.adbPath = resolve(argv[++index]);
    else if (argv[index] === '--idle-exit-ms') parsed.idleExitMs = Number(argv[++index]);
  }
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const host = args.host ?? '127.0.0.1';
  const port = args.port ?? 4785;
  const server = await createRokidControlServer(args);
  server.listen(port, host, () => {
    console.log(`Rokid 제어 센터: http://${host}:${port}`);
  });
}
