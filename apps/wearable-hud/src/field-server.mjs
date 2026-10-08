import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import {
  isFetchSafePort as isSharedFetchSafePort,
  listenOnFetchSafePort
} from '../../../packages/shared/src/http.js';

const execFileAsync = promisify(execFile);
const evidenceReportVersion = 'c-d-wearable-physical-field-report-v1';
const evidenceEnvelopeVersion = 'c-d-wearable-field-evidence-envelope-v1';
const draftEnvelopeVersion = 'c-d-wearable-field-draft-envelope-v1';
const maximumEvidenceBytes = 128 * 1024;
const maximumAudioBytes = 8 * 1024 * 1024;
const maximumTranscriptionsPerMinute = 6;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

export function createWearableFieldServer({
  root = resolve(fileURLToPath(new URL('.', import.meta.url))),
  evidenceDir = resolve(root, 'field-evidence'),
  sttCommand = process.env.JARVIS_WEARABLE_STT_COMMAND ?? '',
  sttArgsJson = process.env.JARVIS_WEARABLE_STT_ARGS_JSON ?? '["{inputPath}"]',
  sttMode = process.env.JARVIS_WEARABLE_STT_MODE ?? 'exec',
  now = () => new Date(),
  executeFile = execFileAsync,
  spawnProcess = spawn
} = {}) {
  const transcriptionWindows = new Map();
  let activeTranscriptions = 0;
  const voiceTelemetry = {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    lastLatencyMs: null,
    lastErrorCode: null
  };
  const persistentStt = sttCommand && sttMode === 'daemon'
    ? createPersistentSttTranscriber({
      command: sttCommand,
      argsJson: sttArgsJson,
      spawnProcess
    })
    : null;

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          service: 'wearable-hud-field-server',
          status: 'ok',
          voice: {
            configured: Boolean(sttCommand),
            mode: persistentStt ? 'persistent-local' : sttCommand ? 'per-request-local' : 'unavailable',
            state: persistentStt?.state() ?? (sttCommand ? 'ready' : 'unavailable'),
            telemetry: { ...voiceTelemetry, contentLogged: false }
          },
          privacy: { rawAudioStored: false, rawTranscriptLogged: false }
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/field-evidence') {
        requireSameOrigin(request);
        requireRequestMarker(request, 'physical-field-evidence-v1');
        const payload = await readJsonBody(request, maximumEvidenceBytes);
        validatePhysicalFieldReport(payload);
        const stored = await storeFieldEvidence({ payload, evidenceDir, now });
        sendJson(response, 201, stored);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/field-evidence/latest') {
        const metadata = await readLatestEvidenceMetadata(evidenceDir);
        sendJson(response, metadata ? 200 : 404, metadata ?? { error: 'field_evidence_not_found' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/field-draft') {
        requireSameOrigin(request);
        requireRequestMarker(request, 'physical-field-draft-v1');
        const draft = await readFieldDraft(evidenceDir);
        sendJson(response, draft ? 200 : 404, draft ?? { error: 'field_draft_not_found' });
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/field-draft') {
        requireSameOrigin(request);
        requireRequestMarker(request, 'physical-field-draft-v1');
        const payload = await readJsonBody(request, maximumEvidenceBytes);
        validatePhysicalFieldReport(payload);
        const stored = await storeFieldDraft({ payload, evidenceDir, now });
        sendJson(response, 200, stored);
        return;
      }
      if (request.method === 'DELETE' && url.pathname === '/field-draft') {
        requireSameOrigin(request);
        requireRequestMarker(request, 'physical-field-draft-v1');
        await clearFieldDraft(evidenceDir);
        sendJson(response, 200, { status: 'cleared', rawFieldContentLogged: false });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/voice/transcribe') {
        requireSameOrigin(request);
        requireRequestMarker(request, 'voice-transcription-v1');
        if (!sttCommand) throw new HttpError(503, 'stt_provider_not_configured');
        if (activeTranscriptions >= 1) throw new HttpError(429, 'stt_busy');
        enforceTranscriptionRateLimit(request, transcriptionWindows, now);
        const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
          throw new HttpError(415, 'unsupported_audio_type');
        }
        const audio = await readBody(request, maximumAudioBytes);
        activeTranscriptions += 1;
        voiceTelemetry.requestCount += 1;
        const transcriptionStartedAt = Date.now();
        try {
          const result = await transcribeAudio({
            audio,
            contentType,
            language: sanitizeLanguage(request.headers['x-jarvis-language']),
            sttCommand,
            sttArgsJson,
            executeFile,
            persistentTranscriber: persistentStt
          });
          voiceTelemetry.successCount += 1;
          voiceTelemetry.lastLatencyMs = Math.max(0, Date.now() - transcriptionStartedAt);
          voiceTelemetry.lastErrorCode = null;
          sendJson(response, 200, result);
        } catch (error) {
          voiceTelemetry.failureCount += 1;
          voiceTelemetry.lastLatencyMs = Math.max(0, Date.now() - transcriptionStartedAt);
          voiceTelemetry.lastErrorCode = safeVoiceFailureCode(error);
          throw error;
        } finally {
          activeTranscriptions -= 1;
        }
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        throw new HttpError(405, 'method_not_allowed');
      }
      await serveStaticFile({ request, response, url, root });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = Number(error?.statusCode ?? 500);
      if (url.pathname === '/voice/transcribe' && statusCode >= 500) {
        const code = safeVoiceFailureCode(error);
        sendJson(response, statusCode, { error: { code, message: code } });
        return;
      }
      const publicMessage = statusCode >= 500 ? 'internal_server_error' : String(error?.message ?? 'request_failed');
      sendJson(response, statusCode, { error: publicMessage });
    }
  });
  server.once('close', () => persistentStt?.close());
  return server;
}

export function createPersistentSttTranscriber({
  command,
  argsJson = '[]',
  spawnProcess = spawn,
  startupTimeoutMs = 45_000,
  requestTimeoutMs = 30_000
} = {}) {
  if (!command) throw new Error('stt_daemon_command_required');
  const args = parseSttArguments(argsJson);
  const pending = new Map();
  let child = null;
  let lineReader = null;
  let lifecycle = 'starting';
  let closing = false;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;

  const resetReady = () => {
    readyPromise = new Promise((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    readyPromise.catch(() => {});
  };

  const rejectPending = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new HttpError(502, 'stt_execution_failed'));
    }
    pending.clear();
  };

  const stopChild = () => {
    lineReader?.close();
    lineReader = null;
    if (child && !child.killed) child.kill();
    child = null;
  };

  const failProcess = (processRef) => {
    if (child !== processRef) return;
    lifecycle = closing ? 'stopped' : 'failed';
    rejectReady?.(new HttpError(502, 'stt_execution_failed'));
    rejectPending();
    stopChild();
  };

  const handleLine = (line) => {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (payload?.type === 'ready') {
      lifecycle = 'ready';
      resolveReady?.(true);
      return;
    }
    const item = pending.get(payload?.requestId);
    if (!item) return;
    pending.delete(payload.requestId);
    clearTimeout(item.timeout);
    if (payload.error) {
      item.reject(new HttpError(502, safeDaemonErrorCode(payload.error)));
      return;
    }
    try {
      item.resolve(parseTranscriptionOutput(JSON.stringify(payload)));
    } catch (error) {
      item.reject(error);
    }
  };

  const start = () => {
    if (closing || child) return;
    resetReady();
    lifecycle = 'starting';
    const processRef = spawnProcess(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child = processRef;
    processRef.stderr?.resume();
    lineReader = createInterface({ input: processRef.stdout });
    lineReader.on('line', handleLine);
    processRef.once('error', () => failProcess(processRef));
    processRef.once('exit', () => failProcess(processRef));
  };

  const withTimeout = (promise, timeoutMs) => new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new HttpError(502, 'stt_timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      }
    );
  });

  start();
  return {
    state: () => lifecycle,
    async transcribe({ inputPath, language }) {
      if (closing) throw new HttpError(503, 'stt_provider_not_configured');
      if (!child) start();
      await withTimeout(readyPromise, startupTimeoutMs);
      const requestId = randomUUID();
      return await new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          rejectPromise(new HttpError(502, 'stt_timeout'));
        }, requestTimeoutMs);
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timeout });
        child.stdin.write(`${JSON.stringify({ requestId, inputPath, language })}\n`, (error) => {
          if (!error) return;
          const item = pending.get(requestId);
          if (!item) return;
          pending.delete(requestId);
          clearTimeout(item.timeout);
          item.reject(new HttpError(502, 'stt_execution_failed'));
        });
      });
    },
    close() {
      if (closing) return;
      closing = true;
      lifecycle = 'stopped';
      rejectPending();
      child?.stdin?.end();
      stopChild();
    }
  };
}

function safeDaemonErrorCode(value) {
  const table = {
    empty_transcript: 'stt_empty_transcript',
    audio_decode_failed: 'stt_audio_decode_failed',
    invalid_audio: 'stt_invalid_audio',
    transcription_failed: 'stt_execution_failed'
  };
  return table[String(value ?? '')] ?? 'stt_execution_failed';
}

function safeVoiceFailureCode(error) {
  const allowed = new Set([
    'stt_timeout',
    'stt_empty_transcript',
    'stt_audio_decode_failed',
    'stt_invalid_audio',
    'stt_execution_failed'
  ]);
  const message = String(error?.message ?? 'stt_execution_failed');
  const code = message === 'empty_stt_result' ? 'stt_empty_transcript' : message;
  return allowed.has(code) ? code : 'stt_execution_failed';
}

export async function startWearableFieldServer({
  host = '0.0.0.0',
  port = 4176,
  root = resolve(fileURLToPath(new URL('.', import.meta.url))),
  ...options
} = {}) {
  const server = createWearableFieldServer({ root, ...options });
  await listenWearableFieldServer(server, { port, host });
  return server;
}

export function isFetchSafePort(value) {
  return isSharedFetchSafePort(value);
}

export async function listenWearableFieldServer(server, {
  host = '127.0.0.1',
  port = 0,
  maxAttempts = 32
} = {}) {
  const requestedPort = Number(port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new RangeError('wearable_field_port_invalid');
  }
  if (requestedPort !== 0 && !isFetchSafePort(requestedPort)) {
    throw new RangeError('wearable_field_port_blocked_by_fetch');
  }

  try {
    return await listenOnFetchSafePort(server, { host, port: requestedPort, maxAttempts });
  } catch (error) {
    if (error?.message === 'fetch_safe_port_unavailable') {
      throw new Error('wearable_field_fetch_safe_port_unavailable');
    }
    throw error;
  }
}

export async function storeFieldEvidence({ payload, evidenceDir, now = () => new Date() }) {
  const canonicalReport = JSON.stringify(payload);
  const evidenceId = createHash('sha256').update(canonicalReport).digest('hex');
  const receivedAt = now().toISOString();
  const envelope = {
    envelopeVersion: evidenceEnvelopeVersion,
    evidenceId,
    receivedAt,
    report: payload
  };
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const timestamp = receivedAt.replaceAll(':', '-');
  const evidencePath = resolve(evidenceDir, `${timestamp}-${evidenceId.slice(0, 12)}.json`);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, serialized, { encoding: 'utf8', flag: 'wx' });
  await writeFile(resolve(evidenceDir, 'latest-field-evidence.json'), serialized, 'utf8');
  return {
    status: 'stored',
    evidenceId,
    receivedAt,
    reportStatus: payload.status,
    privacy: { rawFieldContentLogged: false }
  };
}

export async function storeFieldDraft({ payload, evidenceDir, now = () => new Date() }) {
  const canonicalReport = JSON.stringify(payload);
  const draftId = createHash('sha256').update(canonicalReport).digest('hex');
  const updatedAt = now().toISOString();
  const envelope = {
    envelopeVersion: draftEnvelopeVersion,
    draftId,
    updatedAt,
    report: payload,
    privacy: {
      rawAudioStored: false,
      rawTranscriptStored: false,
      rawBridgeTokenStored: false
    }
  };
  const target = resolve(evidenceDir, 'latest-field-draft.json');
  const temporary = resolve(evidenceDir, `.latest-field-draft-${randomUUID()}.tmp`);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    if (process.platform === 'win32') {
      await rm(target, { force: true });
      await rename(temporary, target);
    } else {
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    status: 'stored',
    draftId,
    updatedAt,
    passedChecks: payload.summary?.passedChecks ?? 0,
    totalChecks: payload.summary?.totalChecks ?? 12,
    privacy: { rawFieldContentLogged: false }
  };
}

export async function readFieldDraft(evidenceDir) {
  try {
    const envelope = JSON.parse(await readFile(resolve(evidenceDir, 'latest-field-draft.json'), 'utf8'));
    if (envelope.envelopeVersion !== draftEnvelopeVersion) return null;
    const expectedId = createHash('sha256').update(JSON.stringify(envelope.report)).digest('hex');
    if (envelope.draftId !== expectedId) return null;
    validatePhysicalFieldReport(envelope.report);
    return envelope;
  } catch {
    return null;
  }
}

export async function clearFieldDraft(evidenceDir) {
  await rm(resolve(evidenceDir, 'latest-field-draft.json'), { force: true });
}

export function validatePhysicalFieldReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new HttpError(400, 'invalid_field_report');
  }
  if (report.reportVersion !== evidenceReportVersion) throw new HttpError(422, 'unsupported_field_report');
  if (report.source?.interactiveFieldRun !== true) throw new HttpError(422, 'interactive_field_run_required');
  const privacy = report.privacy ?? {};
  const privacyReady = privacy.rawTranscriptStored === false
    && privacy.rawAudioStored === false
    && privacy.rawBridgeTokenStored === false
    && privacy.screenshotStored === false
    && privacy.userAgentStored === false;
  if (!privacyReady) throw new HttpError(422, 'field_privacy_contract_failed');
  assertNoSensitiveField(report);
  return true;
}

async function serveStaticFile({ request, response, url, root }) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = resolve(join(root, normalize(pathname).replace(/^([/\\])+/, '')));
  if (!isWithinRoot(root, filePath)) throw new HttpError(403, 'forbidden');
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, 'not_found');
  }
  if (!info.isFile()) throw new HttpError(404, 'not_found');
  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-jarvis-server': 'wearable-hud-field-server'
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

async function transcribeAudio({
  audio,
  contentType,
  language,
  sttCommand,
  sttArgsJson,
  executeFile,
  persistentTranscriber = null
}) {
  const extension = audioExtension(contentType);
  const inputPath = resolve(tmpdir(), `jarvis-wearable-${randomUUID()}${extension}`);
  await writeFile(inputPath, audio, { flag: 'wx' });
  try {
    const parsed = persistentTranscriber
      ? await persistentTranscriber.transcribe({ inputPath, language })
      : await executeSttProcess({ inputPath, language, sttCommand, sttArgsJson, executeFile });
    return {
      transcript: parsed.transcript,
      confidence: parsed.confidence,
      provider: 'configured-local-stt',
      language,
      privacy: { rawAudioStored: false, rawTranscriptLogged: false }
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, error?.killed ? 'stt_timeout' : 'stt_execution_failed');
  } finally {
    await rm(inputPath, { force: true });
  }
}

async function executeSttProcess({ inputPath, language, sttCommand, sttArgsJson, executeFile }) {
  const argsTemplate = parseSttArguments(sttArgsJson);
  const args = argsTemplate.map((value) => value
    .replaceAll('{inputPath}', inputPath)
    .replaceAll('{language}', language));
  const { stdout } = await executeFile(sttCommand, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    shell: false
  });
  return parseTranscriptionOutput(stdout);
}

function parseTranscriptionOutput(stdout) {
  const value = String(stdout ?? '').trim();
  if (!value) throw new HttpError(502, 'empty_stt_result');
  try {
    const parsed = JSON.parse(value);
    const transcript = String(parsed.transcript ?? parsed.text ?? '').trim();
    if (!transcript) throw new HttpError(502, 'empty_stt_result');
    return { transcript: transcript.slice(0, 4_000), confidence: clampConfidence(parsed.confidence) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return { transcript: value.slice(0, 4_000), confidence: null };
  }
}

function parseSttArguments(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(500, 'invalid_stt_arguments');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new HttpError(500, 'invalid_stt_arguments');
  }
  return parsed;
}

async function readJsonBody(request, maximumBytes) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new HttpError(415, 'json_content_type_required');
  const body = await readBody(request, maximumBytes);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

async function readBody(request, maximumBytes) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > maximumBytes) throw new HttpError(413, 'payload_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new HttpError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readLatestEvidenceMetadata(evidenceDir) {
  try {
    const envelope = JSON.parse(await readFile(resolve(evidenceDir, 'latest-field-evidence.json'), 'utf8'));
    return {
      status: 'available',
      evidenceId: envelope.evidenceId,
      receivedAt: envelope.receivedAt,
      reportStatus: envelope.report?.status ?? null,
      deviceAlias: envelope.report?.source?.deviceAlias ?? null
    };
  } catch {
    return null;
  }
}

function enforceTranscriptionRateLimit(request, windows, now) {
  const key = createHash('sha256')
    .update(String(request.socket?.remoteAddress ?? 'local'))
    .digest('hex')
    .slice(0, 16);
  const timestamp = now().getTime();
  const active = (windows.get(key) ?? []).filter((item) => timestamp - item < 60_000);
  if (active.length >= maximumTranscriptionsPerMinute) throw new HttpError(429, 'stt_rate_limited');
  active.push(timestamp);
  windows.set(key, active);
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'origin_rejected');
  }
  if (!request.headers.host || originHost !== request.headers.host) throw new HttpError(403, 'origin_rejected');
}

function requireRequestMarker(request, expected) {
  if (request.headers['x-jarvis-wearable-request'] !== expected) {
    throw new HttpError(403, 'wearable_request_marker_required');
  }
}

function assertNoSensitiveField(value, path = 'report') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveField(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,})/i.test(value)) {
      throw new HttpError(422, 'sensitive_field_content_rejected');
    }
    return;
  }
  const forbiddenNames = new Set([
    'token', 'authorization', 'rawtranscript', 'rawaudio', 'audiobase64',
    'screenshot', 'useragent', 'secret', 'apikey'
  ]);
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
    if (forbiddenNames.has(normalized)) throw new HttpError(422, `sensitive_field_rejected:${path}.${key}`);
    assertNoSensitiveField(item, `${path}.${key}`);
  }
}

function setSecurityHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), geolocation=()');
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function isWithinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}

function sanitizeLanguage(value) {
  const language = String(value ?? 'ko-KR').trim();
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language) ? language : 'ko-KR';
}

function audioExtension(contentType) {
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('ogg')) return '.ogg';
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return '.m4a';
  return '.audio';
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host') parsed.host = argv[++index];
    else if (argv[index] === '--port') parsed.port = argv[++index];
    else if (argv[index] === '--root') parsed.root = argv[++index];
  }
  return parsed;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? fileURLToPath(new URL('.', import.meta.url)));
  const server = await startWearableFieldServer({ host: args.host, port: args.port, root });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : Number(args.port ?? 4176);
  console.log('# wearable-hud-field-server');
  console.log(`Local:   http://127.0.0.1:${port}/`);
  console.log(`Field:   http://127.0.0.1:${port}/field-calibration.html`);
  console.log(`Network: http://<this-pc-ip>:${port}/`);
}
