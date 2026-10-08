import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// HTTP contract reviewed against google/artemis commit 371aa6df56880643da57b30da936e9812fb0ec66.
export const ARTEMIS_CONTRACT_REVISION = '371aa6df56880643da57b30da936e9812fb0ec66';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEVICE_ID = /^[a-z0-9_.:[\]-]{1,128}$/i;

function fault(code, message, details = {}) {
  return Object.assign(new Error(message), { code: `B_ARTEMIS_${code}`, ...details });
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw fault('CONFIG_INVALID', 'ARTEMIS 시간 또는 크기 제한 설정이 올바르지 않습니다.');
  }
  return value;
}

function normalizeUrl(value, allowRemote) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw fault('CONFIG_INVALID', 'ARTEMIS 서버 주소가 올바르지 않습니다.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fault('CONFIG_INVALID', 'ARTEMIS 주소는 인증정보와 경로가 없는 HTTP 서버 주소여야 합니다.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && (!allowRemote || url.protocol !== 'https:')) {
    throw fault('REMOTE_DISABLED', '원격 ARTEMIS는 명시적인 HTTPS 원격 연결 설정이 필요합니다.');
  }
  return url.origin;
}

function deviceId(value) {
  if (typeof value !== 'string' || !DEVICE_ID.test(value)) throw fault('DEVICE_REQUIRED', '명시적인 Android 기기 일련번호가 필요합니다.');
  return value;
}

function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw fault('SESSION_INVALID', 'ARTEMIS 작업 ID는 UUID여야 합니다.');
  return value.toLowerCase();
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(fault('ABORTED', 'ARTEMIS 작업이 취소되었습니다.'));
        signal.addEventListener('abort', abort, { once: true });
      })
    ]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function statusName(value) {
  if (value === 'success') return 'completed';
  if (value === 'pending' || value === 'started') return 'queued';
  return ['queued', 'running', 'paused', ...TERMINAL].includes(value) ? value : 'unknown';
}

function metadataText(value, max = 128) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function safeDevice(raw) {
  if (!raw || !DEVICE_ID.test(raw.serial ?? '') || typeof raw.state !== 'string' || typeof raw.is_busy !== 'boolean') {
    throw fault('RESPONSE_INVALID', 'ARTEMIS 기기 응답 형식이 올바르지 않습니다.');
  }
  return {
    serial: raw.serial, state: metadataText(raw.state, 32), model: metadataText(raw.model),
    isEmulator: raw.is_emulator === true, busy: raw.is_busy,
    activeSessionId: SESSION_ID.test(raw.active_session_id ?? '') ? raw.active_session_id.toLowerCase() : null
  };
}

function bindSession(raw, id, expectedDevice) {
  if (!raw || raw.session_id?.toLowerCase?.() !== id) throw fault('SESSION_MISMATCH', 'ARTEMIS가 다른 작업의 응답을 반환했습니다.');
  let info = raw.device_info;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch { info = null; }
  }
  const serial = raw.device_serial ?? raw.device_id ?? info?.device_serial ?? info?.device_id;
  if (serial && expectedDevice && serial !== expectedDevice) throw fault('DEVICE_MISMATCH', 'ARTEMIS 응답의 실행 기기가 요청과 다릅니다.');
}

export class ArtemisClient {
  constructor({
    baseUrl = process.env.JARVIS_ARTEMIS_BASE_URL ?? '',
    deviceSerial = process.env.JARVIS_ARTEMIS_DEVICE_SERIAL ?? '',
    allowRemote = false, fetchImpl = globalThis.fetch, timeoutMs, pollIntervalMs,
    taskTimeoutMs, cancelTimeoutMs, maxResponseBytes,
    distributionChannel = process.env.JARVIS_ANDROID_DISTRIBUTION_CHANNEL ?? 'private-lab'
  } = {}) {
    if(!['private-lab','play-store'].includes(distributionChannel))throw fault('CONFIG_INVALID','Android 배포 경로가 올바르지 않습니다.');
    Object.defineProperty(this,'distributionChannel',{value:distributionChannel,enumerable:true});
    this.baseUrl = normalizeUrl(baseUrl, allowRemote);
    this.deviceSerial = deviceSerial ? deviceId(deviceSerial) : null;
    if (typeof fetchImpl !== 'function') throw new TypeError('ARTEMIS requires fetchImpl.');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = boundedInteger(timeoutMs, 10_000, 10, 120_000);
    this.pollIntervalMs = boundedInteger(pollIntervalMs, 1_000, 10, 10_000);
    this.taskTimeoutMs = boundedInteger(taskTimeoutMs, 600_000, 10, 3_600_000);
    this.cancelTimeoutMs = boundedInteger(cancelTimeoutMs, 5_000, 10, 60_000);
    this.maxResponseBytes = boundedInteger(maxResponseBytes, 2 * 1024 * 1024, 128, 8 * 1024 * 1024);
    this.tasks = new Map();
    this.admissions = new Map();
    this.sessionAdmissions = new Map();
    this.deviceRuns = new Map();
  }

  get configured() { return this.distributionChannel==='private-lab'&&Boolean(this.baseUrl); }

  async request(path, { method = 'GET', body, signal, timeoutMs = this.timeoutMs, allow404 = false } = {}) {
    if(this.distributionChannel!=='private-lab')throw fault('DISTRIBUTION_DENIED','스토어 배포 경로에서는 ARTEMIS 기기 조작을 사용할 수 없습니다. 공식 API 또는 Intent 경로를 사용하세요.');
    if (!this.configured) throw fault('NOT_CONFIGURED', 'ARTEMIS 서버 주소가 설정되지 않았습니다.');
    const timerController = new AbortController();
    const combined = signal ? AbortSignal.any([signal, timerController.signal]) : timerController.signal;
    const timer = setTimeout(() => timerController.abort(), timeoutMs);
    try {
      combined.throwIfAborted();
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, signal: combined, redirect: 'error',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        throw fault('HTTP_ERROR', 'ARTEMIS 서버가 요청을 처리하지 못했습니다.', { httpStatus: response.status });
      }
      if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
        await response.body?.cancel();
        throw fault('RESPONSE_INVALID', 'ARTEMIS 서버에서 JSON 응답을 받지 못했습니다.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw fault('RESPONSE_INVALID', 'ARTEMIS 응답 본문이 없습니다.');
      let bytes = 0;
      const chunks = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > this.maxResponseBytes) throw fault('RESPONSE_TOO_LARGE', 'ARTEMIS 응답이 허용 크기를 초과했습니다.');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw fault('RESPONSE_INVALID', 'ARTEMIS JSON 응답을 해석하지 못했습니다.'); }
    } catch (error) {
      if (signal?.aborted) throw fault('ABORTED', 'ARTEMIS 요청이 취소되었습니다.');
      if (timerController.signal.aborted) throw fault('TIMEOUT', 'ARTEMIS 서버 응답 시간이 초과되었습니다.');
      if (error?.code?.startsWith('B_ARTEMIS_')) throw error;
      throw fault('UNREACHABLE', 'ARTEMIS 서버에 연결할 수 없습니다.');
    } finally { clearTimeout(timer); }
  }

  async listDevices({ signal } = {}) {
    const raw = await this.request('/api/devices', { signal });
    if (!Array.isArray(raw?.devices) || raw.devices.length > 256) throw fault('RESPONSE_INVALID', 'ARTEMIS 기기 목록이 올바르지 않습니다.');
    return raw.devices.map(safeDevice);
  }

  async readiness({ deviceSerial = this.deviceSerial, signal } = {}) {
    const base = { provider: 'google-artemis', configured: this.configured, connected: false, ready: false, deviceSerial: deviceSerial || null, deviceCount: null };
    if (!this.configured) return { ...base, reason: 'not_configured', device: null, probes: [] };
    try {
      const [raw, devices] = await Promise.all([
        this.request('/api/system/readiness', { signal }), this.listDevices({ signal })
      ]);
      if (typeof raw?.overall_ready !== 'boolean' || !Array.isArray(raw?.probes)) throw fault('RESPONSE_INVALID', 'ARTEMIS 준비 상태 응답이 올바르지 않습니다.');
      const device = devices.find(item => item.serial === deviceSerial) ?? null;
      const selectedMatches = raw.active_device?.serial === deviceSerial;
      const unlocked = selectedMatches && raw.active_device?.is_locked === false;
      const ready = Boolean(raw.overall_ready && device?.state === 'device' && !device.busy && unlocked);
      return {
        ...base, connected: true, ready, device, deviceCount: devices.length, serverReady: raw.overall_ready,
        targetUnlockVerified: unlocked,
        reason: ready ? 'ready' : !deviceSerial ? 'device_not_selected' : !device ? 'device_unavailable' : device.state !== 'device' ? 'device_not_ready' : device.busy ? 'device_busy' : !selectedMatches ? 'target_readiness_unverified' : !unlocked ? 'device_locked_or_unknown' : 'prerequisite_failed',
        probes: raw.probes.slice(0, 64).map(probe => ({
          id: metadataText(probe.id), category: metadataText(probe.category, 32),
          status: metadataText(probe.status, 32), blocker: probe.is_blocker !== false
        }))
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ...base, reason: error.code ?? 'B_ARTEMIS_UNREACHABLE', device: null, probes: [] };
    }
  }

  async serialize(map, key, operation, signal) {
    const previous = map.get(key) ?? Promise.resolve();
    let release;
    const completed = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => completed);
    map.set(key, tail);
    try {
      if (signal) {
        if (signal.aborted) throw fault('ABORTED', '대기 중인 ARTEMIS 작업이 취소되었습니다.');
        await new Promise((resolve, reject) => {
          const abort = () => reject(fault('ABORTED', '대기 중인 ARTEMIS 작업이 취소되었습니다.'));
          signal.addEventListener('abort', abort, { once: true });
          previous.then(resolve, resolve).finally(() => signal.removeEventListener('abort', abort));
        });
      } else await previous;
      if (signal?.aborted) throw fault('ABORTED', 'ARTEMIS 작업이 취소되었습니다.');
      return await operation();
    } finally {
      release();
      tail.finally(() => { if (map.get(key) === tail) map.delete(key); });
    }
  }

  async submitTask({ goal, deviceSerial = this.deviceSerial, sessionId: requestedId = randomUUID(), profile = 'flash', lockedAppPackage, expectedOutput, verificationLevel, signal } = {}) {
    const serial = deviceId(deviceSerial);
    const id = sessionId(requestedId);
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 12_000) throw fault('GOAL_INVALID', 'ARTEMIS 목표는 1~12,000자 문자열이어야 합니다.');
    if (!['flash', 'pro'].includes(profile)) throw fault('PROFILE_INVALID', 'ARTEMIS 실행 프로필은 flash 또는 pro여야 합니다.');
    if (lockedAppPackage !== undefined && !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(lockedAppPackage)) throw fault('APP_INVALID', 'Android 앱 패키지 이름이 올바르지 않습니다.');
    if (expectedOutput !== undefined && (typeof expectedOutput !== 'string' || expectedOutput.length > 4_000)) throw fault('GOAL_INVALID', 'ARTEMIS 예상 결과 형식이 올바르지 않습니다.');
    if (verificationLevel !== undefined && !['off', 'final', 'checkpoints', 'strict'].includes(verificationLevel)) throw fault('PROFILE_INVALID', 'ARTEMIS 검증 단계가 올바르지 않습니다.');
    const body = {
      goal, profile, device_serial: serial, session_id: id, ingress: 'jarvis',
      ...(lockedAppPackage === undefined ? {} : { locked_app_package: lockedAppPackage }),
      ...(expectedOutput === undefined ? {} : { expected_output: expectedOutput }),
      ...(verificationLevel === undefined ? {} : { verification_level: verificationLevel })
    };
    const requestDigest = digest(body);
    return this.serialize(this.sessionAdmissions, id, () => this.serialize(this.admissions, serial, async () => {
      const existing = this.tasks.get(id);
      if (existing && existing.requestDigest !== requestDigest) throw fault('SESSION_CONFLICT', '같은 작업 ID를 다른 명령에 재사용할 수 없습니다.', { sessionId: id });
      if (existing?.accepted) return this.getTaskStatus(id, { signal, deviceSerial: serial });
      if (existing) {
        const reconciled = await this.getTaskStatus(id, { signal, deviceSerial: serial });
        if (reconciled.accepted) {
          existing.accepted = true;
          return reconciled;
        }
      }
      if (!existing && this.tasks.size >= 1_024) throw fault('CAPACITY', 'ARTEMIS 작업 추적 한도를 초과했습니다.');
      const devices = await this.listDevices({ signal });
      const target = devices.find(item => item.serial === serial);
      if (!target || target.state !== 'device') throw fault('DEVICE_UNAVAILABLE', '요청한 Android 기기가 연결 또는 인증되지 않았습니다.');
      this.tasks.set(id, { requestDigest, deviceSerial: serial, accepted: false });
      let raw;
      try { raw = await this.request('/api/run', { method: 'POST', body, signal }); }
      catch (error) {
        // A lost POST response can still mean admission succeeded. Never retry with a new ID automatically.
        throw Object.assign(error, { sessionId: id, admissionUnknown: ![400, 401, 403, 404, 409, 422].includes(error.httpStatus) });
      }
      if (raw?.status === 'rejected') throw fault('REJECTED', 'ARTEMIS 서버가 작업 접수를 거부했습니다.', { sessionId: id, admissionUnknown: false });
      if (!Array.isArray(raw?.tasks) || raw.tasks.length !== 1) throw fault('RESPONSE_INVALID', 'ARTEMIS 작업 접수 결과가 올바르지 않습니다.', { sessionId: id, admissionUnknown: true });
      try { bindSession(raw.tasks[0], id, serial); }
      catch (error) { throw Object.assign(error, { sessionId: id, admissionUnknown: true }); }
      this.tasks.get(id).accepted = true;
      return { sessionId: id, deviceSerial: serial, status: statusName(raw.tasks[0].status), accepted: true, queuedWhileBusy: target.busy, verified: false };
    }, signal), signal);
  }

  async getTaskStatus(requestedId, { signal, deviceSerial = this.tasks.get(requestedId)?.deviceSerial ?? this.deviceSerial } = {}) {
    const id = sessionId(requestedId);
    const serial = deviceId(deviceSerial);
    const [session, global] = await Promise.all([
      this.request(`/api/sessions/${id}`, { signal, allow404: true }), this.request('/api/status', { signal })
    ]);
    if (!global || !Array.isArray(global.queue) || !Array.isArray(global.active_tasks)) throw fault('RESPONSE_INVALID', 'ARTEMIS 실행 상태 응답이 올바르지 않습니다.');
    const queued = global.queue.find(item => item.session_id === id);
    const active = global.active_tasks.find(item => item.session_id === id);
    if (session) bindSession(session, id, serial);
    if (queued) bindSession(queued, id, serial);
    if (active) bindSession(active, id, serial);
    const providerStatus = statusName(session?.status ?? queued?.status ?? (active ? 'running' : global.session_id === id ? global.status : undefined));
    const stillActive = Boolean(active || (global.session_id === id && ['running', 'paused'].includes(global.status)));
    const terminal = TERMINAL.has(providerStatus) && !stillActive && !queued;
    const status = TERMINAL.has(providerStatus) && !terminal ? (providerStatus === 'cancelled' ? 'cancelling' : 'settling') : providerStatus;
    return { sessionId: id, deviceSerial: serial, providerStatus, status, terminal, verified: false, accepted: Boolean(session || queued || active || this.tasks.get(id)?.accepted) };
  }

  async cancelTask(requestedId, { signal, timeoutMs = this.cancelTimeoutMs } = {}) {
    const id = sessionId(requestedId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedInteger(timeoutMs, this.cancelTimeoutMs, 10, 60_000));
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let last = { sessionId: id, status: 'unknown', terminal: false, verified: false };
    let cancellationRequested = false;
    try {
      const raw = await this.request('/api/stop', { method: 'POST', body: { session_id: id }, signal: combined });
      if (!['stopped', 'no_running_task'].includes(raw?.status)) throw fault('RESPONSE_INVALID', 'ARTEMIS 취소 응답이 올바르지 않습니다.');
      cancellationRequested = raw.status === 'stopped';
      while (true) {
        last = await this.getTaskStatus(id, { signal: combined });
        if (last.terminal) return { ...last, cancellationRequested, cancellationConfirmed: last.status === 'cancelled' };
        await delay(this.pollIntervalMs, undefined, { signal: combined });
      }
    } catch (error) {
      if (signal?.aborted) throw fault('ABORTED', 'ARTEMIS 취소 상태 조회가 중단되었습니다.');
      if (!controller.signal.aborted) throw error;
      return { ...last, cancellationRequested, cancellationConfirmed: false };
    } finally { clearTimeout(timer); }
  }

  async collectEvidence(requestedId, { signal } = {}) {
    const id = sessionId(requestedId);
    const [status, steps] = await Promise.all([
      this.getTaskStatus(id, { signal }), this.request(`/api/sessions/${id}/steps`, { signal })
    ]);
    if (!Array.isArray(steps)) throw fault('RESPONSE_INVALID', 'ARTEMIS 단계 증거가 올바르지 않습니다.');
    for (const step of steps) {
      if (step.session_id && step.session_id !== id) throw fault('SESSION_MISMATCH', '다른 ARTEMIS 작업의 단계 증거가 포함되어 있습니다.');
    }
    return {
      ...status, evidenceVersion: 'jarvis-artemis-evidence-v1', provider: 'google-artemis',
      contractRevision: ARTEMIS_CONTRACT_REVISION, capturedAt: new Date().toISOString(),
      sourceDigest: digest(steps), stepCount: steps.length, truncated: steps.length > 512,
      source: { session: `${this.baseUrl}/api/sessions/${id}`, steps: `${this.baseUrl}/api/sessions/${id}/steps` },
      steps: steps.slice(-512).map(step => ({
        stepId: metadataText(step.step_id), stepNumber: Number.isSafeInteger(step.step_number) ? step.step_number : null,
        status: metadataText(step.status, 32), preImageName: metadataText(step.pre_image_name, 256), postImageName: metadataText(step.post_image_name, 256),
        toolResults: Array.isArray(step.generic_tools) ? step.generic_tools.slice(0, 128).map(tool => ({
          traceId: metadataText(tool.trace_id), name: metadataText(tool.name), status: metadataText(tool.status, 32)
        })) : []
      }))
    };
  }

  async runTask(input = {}, { signal = input.signal, timeoutMs = this.taskTimeoutMs, verifyResult } = {}) {
    const serial = deviceId(input.deviceSerial ?? this.deviceSerial);
    const id = sessionId(input.sessionId ?? randomUUID());
    const budget = boundedInteger(timeoutMs, this.taskTimeoutMs, 10, 3_600_000);
    return this.serialize(this.deviceRuns, serial, async () => {
      let admissionAttempted = false;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), budget);
      const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      try {
        combined.throwIfAborted();
        admissionAttempted = true;
        await this.submitTask({ ...input, deviceSerial: serial, sessionId: id, signal: combined });
        while (true) {
          const state = await this.getTaskStatus(id, { signal: combined });
          if (state.terminal) {
            const evidence = await this.collectEvidence(id, { signal: combined });
            let verification = { verified: false, reason: 'independent_verification_required' };
            if (state.status === 'completed' && typeof verifyResult === 'function') {
              const result = await abortable(Promise.resolve().then(() => verifyResult(evidence, { signal: combined })), combined);
              verification = result?.verified === true && typeof result.evidenceId === 'string' && result.evidenceId.trim()
                ? { verified: true, evidenceId: result.evidenceId }
                : { verified: false, reason: 'postcondition_not_verified' };
            }
            return { ...evidence, verification, verified: verification.verified, success: state.status === 'completed' && verification.verified };
          }
          await delay(this.pollIntervalMs, undefined, { signal: combined });
        }
      } catch (error) {
        let cancellation = null;
        // A caller can abort after the provider accepted /api/run but before its
        // response was parsed and the local task receipt was persisted. Reconcile
        // by the same id whenever admission was attempted; absence of a local
        // receipt does not prove that no device-side work started.
        if (admissionAttempted) {
          try { cancellation = await this.cancelTask(id); }
          catch (cancelError) { cancellation = { cancellationConfirmed: false, code: cancelError.code ?? 'B_ARTEMIS_UNREACHABLE' }; }
        }
        const code = signal?.aborted ? 'ABORTED' : deadline.signal.aborted ? 'TASK_TIMEOUT' : null;
        if (code) throw fault(code, code === 'ABORTED' ? 'ARTEMIS 작업이 취소되었습니다.' : 'ARTEMIS 작업 제한 시간이 초과되었습니다.', { sessionId: id, cancellation });
        throw Object.assign(error, { sessionId: id, cancellation });
      } finally { clearTimeout(timer); }
    }, signal);
  }
}

export function createArtemisClient(options) { return new ArtemisClient(options); }
