import { createMemoryStatusPanel } from './memory-status.js';
import { createRequestMemoryControl } from './request-memory-control.js';
import { createJarvisSystem } from '../domain/core-engine.js';
import { createPersonalInboxPanel } from './personal-inbox.js';
import { applyDesktopNavigation } from './desktop-navigation.js';
import { createSelectedConversationPanel } from './selected-conversations.js';
import { createPreferenceManagementPanel } from './preference-management.js';
import { createSourceRevisionPanel } from './source-revisions.js';
import { createPersonalMandatePanel } from './personal-mandates.js';
import { describeReadFailure } from './recovery.js';
import {renderNativeRecovery,taskEmptyResultMessage} from './task-result-guidance.js';
import { currentOwnerSession, prepareOwnerCommand } from './owner-command-session.js';
import { conversationContext } from './conversation-context.js';
import { missionSelection, preferredMissionId, missionProgressMessage, missionVerificationView } from './mission-view-state.js';
import { createGoalRevisionDraft, goalRevisionRequest } from './mission-goal-editor.js';
import { createCancellationReviewPanel } from './cancelled-mission-review.js';
import { createMissionDependencyPanel } from './mission-dependency-panel.js';
import { renderIntegrationReadiness } from './integration-readiness.js';
import { isLocalCredentialHandoffAvailable as canUseLocalCredentialHandoff, storeModelProviderApiKey } from './model-provider-credential-setup.js';
import { createRoutineRequest, parseWeeklyRoutineCommand, parseWeeklyRoutineTimezoneCommand, renderRoutineControlPanel, routineApiFailureMessage } from './routine-control-panel.js';
import {
  PcConfirmationConsoleBridgeClient,
  createPcConsoleVisualBaseline,
  createPcConsoleVisualSnapshot,
  diffPcConsoleVisualSnapshots
} from '../domain/pc-console.js';
import {
  PcVoiceConfirmationController,
  createPcVoiceDecisionPrompt
} from '../domain/pc-voice-control.js';
import { classifyCommandLane } from '../../packages/shared/src/command-lane.js';
import {
  isLoopbackHttpUrl,
  resolveControlCenterNetwork
} from '../../packages/shared/src/control-center-hosting.js';

const system = createJarvisSystem();
const pcConsoleVisualBaseline = createPcConsoleVisualBaseline();
const pcConsoleBridgeClient = createConfiguredPcConsoleBridgeClient();
let pcConsoleBridgeStatus = {
  mode: pcConsoleBridgeClient ? 'bridge-fetch-ready' : 'local-demo',
  synced: false,
  error: null
};
let state = composeState();
const app = document.querySelector('#app');
const cancellationReviewPanel = createCancellationReviewPanel({
  request: (path, options) => coreRequest(path, { ...options, token: controlCenter.coreAdminToken }),
  endpoint: () => controlCenter.coreBaseUrl,
  changed: () => render({ preserveScroll: true })
});
const missionDependencyPanel = createMissionDependencyPanel({
  request: (path, options) => coreRequest(path, { ...options, token: controlCenter.coreAdminToken }),
  endpoint: () => controlCenter.coreBaseUrl,
  accessContext: () => controlCenter.coreAdminToken,
  changed: () => render({ preserveScroll: true })
});
const requestMemoryControl = createRequestMemoryControl();
let pcVoiceState = {
  status: 'idle',
  supported: Boolean(globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition),
  active: false,
  privacy: { transcriptStored: false, rawAudioStored: false }
};
const pcVoiceController = new PcVoiceConfirmationController({
  windowRef: globalThis,
  onDecision: handlePcVoiceDecision,
  onState: (nextState) => {
    pcVoiceState = nextState;
    if (app) render({ preserveScroll: true });
  }
});
let pcVoiceAutoEnabled = readUiSetting('jarvis.pcVoiceAuto', '0') === '1';
let lastAutoVoiceChallengeId = null;
const LIVE_OK_STATUSES = new Set(['ok', 'running', 'healthy', 'started', 'already-running', 'ready', 'completed', 'compensated']);
const LIVE_WARN_STATUSES = new Set(['degraded', 'warning', 'stopped', 'not-attached', 'disabled']);
const TASK_CREATION_TIMEOUT_MS = 60_000;
const controlCenterNetwork = resolveControlCenterNetwork({
  locationRef: globalThis.location,
  settingReader: (key) => readUiSetting(key, null)
});
const controlCenter = {
  networkMode: controlCenterNetwork.mode,
  coreBaseUrl: normalizeEndpoint(readUiSetting('jarvis.coreBaseUrl', controlCenterNetwork.coreBaseUrl)),
  pcBaseUrl: normalizeEndpoint(readUiSetting('jarvis.pcBaseUrl', controlCenterNetwork.pcBaseUrl)),
  bridgeBaseUrl: normalizeEndpoint(readUiSetting('jarvis.bridgeBaseUrl', controlCenterNetwork.bridgeBaseUrl)),
  coreAdminToken: readUiSecret('jarvis.coreAdminToken', ''),
  coreAdminProxyConfigured: false,
  pcAgentToken: readUiSecret('jarvis.pcAgentToken', ''),
  executionMode: readUiSetting('jarvis.executionMode', 'task') === 'mission' ? 'mission' : 'task',
  commandDraft: '',
  refreshing: false,
  commandBusy: false,
  goalRevisionDrafts: new Map(),
  rollbackFlow: {
    taskId: null,
    status: 'idle',
    plan: null,
    error: null
  },
  lastError: null,
  lastTechnicalError: null,
  lastErrorSource: null,
  lastErrorAt: null,
  lastRefreshAt: null,
  coreHealth: null,
  coreTasks: [],
  workerQueue: null,
  workerDaemon: null,
  pcHealth: null,
  pcRuntime: null,
  pcTray: null,
  pcQueue: null,
  bridgeHealth: null,
  localPackageStatus: null,
  releaseStatus: null,
  llmStatus: null,
  integrationReadiness: null,
  providerVerifyBusy: null,
  providerSetupBusy: false,
  externalCapabilityEvaluation: null,
  routines: [],
  routinesStatus: 'checking',
  routinesBusy: false,
  routinesError: null,
  routinesNotice: null,
  routinesDraft: { scheduleText: '', objective: '', successCriteria: '', recurrenceEnabled: false, weekday: 1, hour: 9, minute: 0, timeZone: 'Asia/Seoul' },
  routineTimezoneDrafts: {},
  diagnosticsOpen: false,
  supportBusy: false,
  supportDiagnostic: null,
  supportFailure: null,
  supportLastSuccessAt: null,
  ownerBusy: false,
  autoOwnerEnabled: readUiSetting('jarvis.autoOwnerEnabled', '1') === '1',
  ownerSession: null,
  runtimeTrust: null,
  pcRuntimeTrust: null,
  trustBusy: false,
  trustLockArmedUntil: 0,
  trustRecoveryChallenge: null,
  trustRecoveryPhrase: '',
  trustGateResult: null,
  activeTask: null,
  missions: [],
  missionStatus: null,
  activeMission: null,
  activeMissionId: null,
  activity: [createActivity('화면', '제어 센터 준비 완료', 'ok')]
};
controlCenter.activeMissionId = missionSelection.read(missionSelectionScope());

function missionSelectionScope() {
  return { endpoint: controlCenter.coreBaseUrl, conversationId: conversationContext.idFor(controlCenter.coreBaseUrl) };
}

function selectMission(missionId) {
  controlCenter.activeMissionId = missionSelection.write(missionSelectionScope(), missionId);
}

function composeState(command) {
  const nextState = system.composeDashboardState(command);
  return withPcConsoleEvidence(nextState);
}

function withPcConsoleEvidence(nextState, bridgeStatus = pcConsoleBridgeStatus) {
  pcConsoleBridgeStatus = bridgeStatus ?? pcConsoleBridgeStatus;
  const pcConsoleVisualSnapshot = createPcConsoleVisualSnapshot(nextState.pcConsole);
  const pcConsoleVisualRegression = diffPcConsoleVisualSnapshots(pcConsoleVisualBaseline, pcConsoleVisualSnapshot);
  return {
    ...nextState,
    pcConsoleBridgeStatus,
    pcConsoleVisualSnapshot,
    pcConsoleVisualRegression
  };
}

function createConfiguredPcConsoleBridgeClient() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const bridgeUrl = globalThis.JARVIS_BRIDGE_URL ?? params.get('bridgeUrl');
  const bridgeToken = globalThis.JARVIS_BRIDGE_TOKEN ?? params.get('token');
  if (!bridgeUrl) return null;
  return new PcConfirmationConsoleBridgeClient({
    bridgeUrl,
    tokenProvider: () => bridgeToken
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function panel(title, icon, content, className = '') {
  return `<section class="panel ${className}">
    <header><span class="icon">${icon}</span><h2>${escapeHtml(title)}</h2></header>
    ${content}
  </section>`;
}

function renderSchedule(items) {
  return `<ul class="schedule-list">${items
    .map((item) => `<li><time>${item.time}</time><span>${item.title}</span><small>${item.place}</small></li>`)
    .join('')}</ul>`;
}

function renderWorkflow(items) {
  return `<ol class="workflow">${items
    .map((item) => `<li class="${item.status}"><span></span><strong>${escapeHtml(item.label)}</strong><em>${statusLabel(item.status)}</em></li>`)
    .join('')}</ol>`;
}

function statusLabel(status) {
  return { done: '완료', active: '진행 중', pending: '대기' }[status] ?? status;
}

function renderConnections(items) {
  return `<ul class="connection-list">${items
    .map((item) => `<li><span>${connectionIcon(item.type)}</span><strong>${escapeHtml(item.name)}</strong><em>${item.status === 'connected' ? '연결됨' : '동기화 중'}</em></li>`)
    .join('')}</ul>`;
}

function connectionIcon(type) {
  return { mobile: '▯', audio: 'ᖰ', cloud: '☁', network: '⌁' }[type] ?? '•';
}

function renderApprovals(items) {
  return `<ul class="approval-list">${items
    .map((item) => `<li><span>♙</span><strong>${escapeHtml(item.title)}</strong><em>${escapeHtml(item.status ?? item.requester)}</em><time>${item.expiresAt ? expiresLabel(item.expiresAt) : item.time}</time></li>`)
    .join('')}</ul><button class="ghost">모두 보기 ›</button>`;
}

function renderPcConsole(consoleState, visualRegression = state.pcConsoleVisualRegression, bridgeStatus = state.pcConsoleBridgeStatus) {
  const voiceTarget = consoleState.items.find((item) => (
    item.status === 'awaiting_pc_confirmation'
    && item.voiceChallenge?.challengeId
    && !item.voiceChallenge?.consumedAt
  ));
  const voiceAvailable = Boolean(pcConsoleBridgeClient && pcVoiceState.supported && voiceTarget);
  return `<div class="pc-console" aria-label="PC 확인 수락 거절 콘솔">
    <header>
      <div><strong>대기 ${consoleState.pending}</strong><em>수락 ${consoleState.accepted} · 거절 ${consoleState.rejected}</em></div>
      <button type="button" class="pc-voice-toggle ${pcVoiceState.active ? 'active' : ''}" data-pc-voice-toggle
        aria-pressed="${pcVoiceState.active ? 'true' : 'false'}" ${voiceAvailable || pcVoiceState.active ? '' : 'disabled'}>
        ${pcVoiceState.active ? '음성 중지' : '음성 확인'}
      </button>
    </header>
    <ul>${consoleState.items
      .slice(0, 3)
      .map((item) => `<li class="${escapeHtml(item.status)}">
        <div>
          <b>위험 ${escapeHtml(item.riskTier)}단계</b>
          <strong>${escapeHtml(item.title)}</strong>
          <em>${pcHandoffStatusLabel(item.status)} · ${item.externalTransfer ? '외부 전송' : '로컬 확인'}</em>
          <small>${escapeHtml(item.interpretedIntent)}</small>
          ${item.status === 'awaiting_pc_confirmation' && item.voiceChallenge?.phrase
            ? `<p class="pc-voice-phrase"><span>음성 문구</span><code>${escapeHtml(createPcVoiceDecisionPrompt(item).approveUtterance)}</code></p>`
            : ''}
        </div>
        ${item.status === 'awaiting_pc_confirmation'
          ? `<menu>
              <button type="button" class="accept" data-pc-handoff-decision="approve" data-handoff-id="${escapeHtml(item.handoffId)}">수락</button>
              <button type="button" class="reject" data-pc-handoff-decision="reject" data-handoff-id="${escapeHtml(item.handoffId)}">거절</button>
            </menu>`
          : `<time>${item.decidedAt ? expiresLabel(item.decidedAt) : expiresLabel(item.createdAt)}</time>`}
      </li>`)
      .join('')}</ul>
    ${consoleState.lastDecision ? `<p class="pc-console-last">최근 결정: ${escapeHtml(consoleState.lastDecision.handoffId)} · ${escapeHtml(consoleState.lastDecision.decision)}</p>` : ''}
    ${pcVoiceState.status !== 'idle' ? `<p class="pc-voice-status ${escapeHtml(pcVoiceState.status)}">${escapeHtml(pcVoiceStatusLabel(pcVoiceState))}</p>` : ''}
  </div>`;
}

function pcVoiceStatusLabel(voiceState) {
  return {
    prompting: '확인 문구 안내 중',
    listening: '음성 확인 듣는 중',
    'repeat-required': '같은 문구를 한 번 더 확인',
    retrying: '확인 문구 다시 듣기',
    submitting: 'PC 승인 처리 중',
    completed: '음성 확인 완료',
    unsupported: '이 브라우저는 음성 확인을 지원하지 않음',
    error: `음성 확인 중단 · ${voiceState.reason ?? '오류'}`
  }[voiceState.status] ?? voiceState.status;
}

function pcHandoffStatusLabel(status) {
  return {
    awaiting_pc_confirmation: 'PC 확인 대기',
    accepted: '수락됨',
    rejected: '거절됨',
    expired: '만료됨'
  }[status] ?? status;
}

function expiresLabel(expiresAt) {
  return new Date(expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function currentTimeLabel() {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function readUiSetting(key, fallback) {
  try {
    return globalThis.localStorage?.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeUiSetting(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Local storage can be unavailable in hardened browser profiles.
  }
}

function readUiSecret(key, fallback) {
  try {
    const sessionValue = globalThis.sessionStorage?.getItem(key);
    if (sessionValue) {
      if (isLegacyInsecureUiToken(sessionValue)) {
        globalThis.sessionStorage?.removeItem(key);
      } else {
        return sessionValue;
      }
    }
    const legacyValue = globalThis.localStorage?.getItem(key);
    if (legacyValue) {
      globalThis.localStorage?.removeItem(key);
      if (!isLegacyInsecureUiToken(legacyValue)) {
        globalThis.sessionStorage?.setItem(key, legacyValue);
        return legacyValue;
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function isLegacyInsecureUiToken(value) {
  return value === 'local-core-admin' || value === 'local-pc-agent-api';
}

function writeUiSecret(key, value) {
  try {
    globalThis.sessionStorage?.setItem(key, value);
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Secrets remain in memory when browser storage is unavailable.
  }
}

function normalizeEndpoint(value) {
  return String(value || '').replace(/\/+$/, '') || '/';
}

function joinEndpoint(baseUrl, path) {
  const normalizedBase = normalizeEndpoint(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function createActivity(source, message, tone = 'ok') {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    source,
    message,
    tone
  };
}

function pushActivity(source, message, tone = 'ok') {
  controlCenter.activity = [createActivity(source, message, tone), ...controlCenter.activity].slice(0, 7);
}

function formatShortTime(value) {
  return value ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '대기';
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0초';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function liveStatusClass(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (LIVE_OK_STATUSES.has(normalized)) return 'ok';
  if (LIVE_WARN_STATUSES.has(normalized)) return 'warn';
  if (!normalized || normalized === 'offline' || normalized === 'unavailable') return 'down';
  if (normalized.includes('fail') || normalized.includes('unhealthy') || normalized.includes('blocked')) return 'down';
  return 'warn';
}

function liveStatusText(status) {
  const normalized = String(status ?? 'offline').toLowerCase();
  return {
    ok: '정상',
    running: '실행 중',
    healthy: '정상',
    ready: '준비',
    started: '실행 중',
    'already-running': '실행 중',
    checking: '확인 중',
    degraded: '성능 저하',
    warning: '주의',
    stopped: '중지',
    'not-attached': '미연결',
    disabled: '사용 안 함',
    offline: '연결 안 됨',
    unavailable: '사용 불가'
  }[normalized] ?? normalized.replaceAll('_', ' ');
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function parseJsonPayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function responseErrorMessage(response, payload) {
  const structured = payload?.error?.message ?? payload?.reason ?? payload?.message;
  if (structured) return structured;
  const rawText = String(payload?.rawText ?? '').trim();
  if (rawText) return `${response.status} ${response.statusText}: ${rawText.slice(0, 180)}`;
  return response.statusText || `HTTP ${response.status}`;
}

function technicalErrorMessage(error) {
  const status = Number.isFinite(error?.status) ? `HTTP ${error.status}` : null;
  const code = error?.payload?.error?.code ?? error?.code ?? null;
  const message = error?.message ?? String(error ?? 'unknown-error');
  return [status, code, message].filter(Boolean).join(' · ').slice(0, 500);
}

function friendlyOperationalError(error, { action = '요청' } = {}) {
  if (/^A_WORK_REFERENCE_/.test(error?.payload?.error?.code ?? '')) {
    return error.payload.error.message ?? '사용할 파일 이름이나 경로를 알려주세요.';
  }
  const status = Number(error?.status ?? 0);
  const text = technicalErrorMessage(error);
  if (/A_MANDATE_|A_BUDGET_/.test(text)) {
    return '선택한 실행 위임을 사용할 수 없습니다. 실행 위임 관리에서 철회·만료 여부와 남은 횟수를 확인해 주세요.';
  }
  if (error?.name === 'AbortError' || /timed?\s*out|시간 초과/i.test(text)) {
    return `${action} 응답이 늦어지고 있습니다. 잠시 후 다시 확인해 주세요.`;
  }
  if (status === 401 || status === 403) {
    return '로컬 연결 권한을 확인해야 합니다. 진단 및 연결에서 설정을 확인해 주세요.';
  }
  if (status === 409) {
    return '같은 작업이 이미 처리 중입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요.';
  }
  if (status === 429) {
    return '요청이 많아 잠시 기다리는 중입니다. 잠시 후 자동으로 다시 확인할 수 있습니다.';
  }
  if (/failed to fetch|fetch failed|network|econnrefused|econnreset|enotfound|socket/i.test(text)) {
    return 'JARVIS 서비스와 연결할 수 없습니다. 자동 복구를 기다린 뒤 다시 확인해 주세요.';
  }
  if (status >= 500) {
    return 'JARVIS 내부 서비스가 복구 중입니다. 잠시 후 다시 확인해 주세요.';
  }
  if (status === 404) {
    return '요청한 기능을 찾지 못했습니다. 제품 업데이트 상태를 확인해 주세요.';
  }
  return `${action} 작업을 완료하지 못했습니다. 자동 진단에서 상태를 확인해 주세요.`;
}

function clearOperationalError(source = null) {
  if (source && controlCenter.lastErrorSource !== source) return;
  controlCenter.lastError = null;
  controlCenter.lastTechnicalError = null;
  controlCenter.lastErrorSource = null;
  controlCenter.lastErrorAt = null;
}

function clearRecoveredConnectivityError() {
  if (!controlCenter.lastError || controlCenter.lastErrorSource === 'runtime-trust') return;
  const technical = String(controlCenter.lastTechnicalError ?? '');
  if (/HTTP\s+5\d\d|failed to fetch|fetch failed|network|econnrefused|econnreset|socket|service.*unavailable/i.test(technical)) {
    clearOperationalError();
  }
}

function recordOperationalError(error, { action = '요청', source = 'operation' } = {}) {
  controlCenter.lastError = friendlyOperationalError(error, { action });
  controlCenter.lastTechnicalError = technicalErrorMessage(error);
  controlCenter.lastErrorSource = source;
  controlCenter.lastErrorAt = new Date().toISOString();
  controlCenter.diagnosticsOpen = true;
  return controlCenter.lastError;
}

function cacheBustedUrl(url) {
  const [withoutHash, hash = ''] = String(url).split('#', 2);
  const separator = withoutHash.includes('?') ? '&' : '?';
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${withoutHash}${separator}_jarvis=${nonce}${hash ? `#${hash}` : ''}`;
}

async function requestJson(url, { method = 'GET', body, token, timeoutMs = 6_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(method === 'GET' ? cacheBustedUrl(url) : url, {
      method,
      cache: 'no-store',
      ...(controlCenterNetwork.hosted && isLoopbackHttpUrl(url)
        ? { targetAddressSpace: 'loopback' }
        : {}),
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...authHeaders(token)
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseJsonPayload(text);
    if (!response.ok) {
      const error = new Error(responseErrorMessage(response, payload));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function coreRequest(path, options = {}) {
  return requestJson(joinEndpoint(controlCenter.coreBaseUrl, path), options);
}

function pcRequest(path, options = {}) {
  return requestJson(joinEndpoint(controlCenter.pcBaseUrl, path), {
    ...options,
    token: options.token ?? controlCenter.pcAgentToken
  });
}

function localControlUrl(path) {
  if (!controlCenterNetwork.localApiBaseUrl) return path;
  return joinEndpoint(controlCenterNetwork.localApiBaseUrl, path);
}

function localControlRequest(path, options = {}) {
  return requestJson(localControlUrl(path), options);
}

function hasCoreAdminAccess() {
  const managedProxyUrl = controlCenterNetwork.localApiBaseUrl
    ? joinEndpoint(controlCenterNetwork.localApiBaseUrl, '/api/core') : '/api/core';
  return Boolean(controlCenter.coreAdminToken)
    || (controlCenter.coreAdminProxyConfigured && controlCenter.coreBaseUrl === managedProxyUrl);
}

function settledValue(result) {
  return result.status === 'fulfilled' ? result.value : null;
}

function settledError(result) {
  return result.status === 'fulfilled' ? null : result.reason;
}

async function refreshLiveState({ silent = false } = {}) {
  if (controlCenter.refreshing) return;
  controlCenter.refreshing = true;
  if (!silent) render({ preserveScroll: true });

  const localCapabilities = await localControlRequest('/api/local/capabilities', { timeoutMs: 4_000 }).catch(() => null);
  controlCenter.coreAdminProxyConfigured = localCapabilities?.credentialsExposed === false
    && localCapabilities?.coreAdminProxyConfigured === true;

  const results = await Promise.allSettled([
    coreRequest('/health', { timeoutMs: 4_000 }),
    coreRequest('/tasks', { timeoutMs: 4_000 }),
    coreRequest('/worker/queue', { timeoutMs: 4_000 }),
    coreRequest('/worker/daemon', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }),
    requestJson(joinEndpoint(controlCenter.pcBaseUrl, '/health'), { timeoutMs: 4_000 }),
    requestJson(joinEndpoint(controlCenter.pcBaseUrl, '/service/runtime'), { timeoutMs: 4_000 }),
    requestJson(joinEndpoint(controlCenter.pcBaseUrl, '/tray/state'), { timeoutMs: 4_000 }),
    pcRequest('/execution-packets/queue', { timeoutMs: 4_000 }),
    requestJson(joinEndpoint(controlCenter.bridgeBaseUrl, '/health'), { timeoutMs: 4_000 }),
    localControlRequest('/api/local/package-status', { timeoutMs: 4_000 }),
    localControlRequest('/api/local/release-status', { timeoutMs: 4_000 }),
    localControlRequest('/api/local/llm-status', { timeoutMs: 4_000 }),
    coreRequest('/missions?limit=20', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }),
    coreRequest('/owner-session', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }),
    coreRequest('/security/trust', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }),
    pcRequest('/api/trust/status', { timeoutMs: 4_000 }),
    coreRequest('/integrations', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }),
    hasCoreAdminAccess() ? coreRequest('/capabilities/external/evaluate', {
      method: 'POST', token: controlCenter.coreAdminToken, timeoutMs: 4_000,
      body: {
        offerId: 'gemini-spark-custom-apps',
        ...(typeof navigator !== 'undefined' && navigator.language ? { language: navigator.language } : {}),
        ...(typeof navigator !== 'undefined' && navigator.language ? (() => {
          try { const region = new Intl.Locale(navigator.language).region; return region ? { region } : {}; }
          catch { return {}; }
        })() : {}),
        direction: 'jarvis-calls-provider'
      }
    }) : Promise.resolve(null),
    hasCoreAdminAccess() ? coreRequest('/routines', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }) : Promise.resolve(null)
  ]);

  const [coreHealth, coreTasks, workerQueue, workerDaemon, pcHealth, pcRuntime, pcTray, pcQueue, bridgeHealth, localPackageStatus, releaseStatus, llmStatus, missionList, ownerSession, runtimeTrust, pcRuntimeTrust, integrationReadiness, externalCapabilityEvaluation, routineList] = results;
  controlCenter.coreHealth = settledValue(coreHealth);
  controlCenter.coreTasks = settledValue(coreTasks)?.items ?? [];
  controlCenter.workerQueue = settledValue(workerQueue);
  controlCenter.workerDaemon = settledValue(workerDaemon);
  controlCenter.pcHealth = settledValue(pcHealth);
  controlCenter.pcRuntime = settledValue(pcRuntime);
  controlCenter.pcTray = settledValue(pcTray);
  controlCenter.pcQueue = settledValue(pcQueue);
  controlCenter.bridgeHealth = settledValue(bridgeHealth);
  controlCenter.localPackageStatus = settledValue(localPackageStatus);
  controlCenter.releaseStatus = settledValue(releaseStatus);
  controlCenter.llmStatus = settledValue(llmStatus);
  controlCenter.integrationReadiness = settledValue(integrationReadiness);
  controlCenter.externalCapabilityEvaluation = settledValue(externalCapabilityEvaluation);
  if (!hasCoreAdminAccess()) {
    controlCenter.routinesStatus = 'auth-required';
    controlCenter.routines = [];
  } else if (routineList.status === 'fulfilled') {
    controlCenter.routinesStatus = 'ready';
    controlCenter.routines = Array.isArray(routineList.value?.items) ? routineList.value.items : [];
  } else {
    controlCenter.routinesStatus = 'unavailable';
    controlCenter.routines = [];
  }
  if (missionList.status === 'fulfilled') {
    controlCenter.missions = settledValue(missionList)?.items ?? [];
    controlCenter.missionStatus = settledValue(missionList)?.status ?? null;
  }
  controlCenter.ownerSession = settledValue(ownerSession);
  controlCenter.runtimeTrust = settledValue(runtimeTrust) ?? controlCenter.coreHealth?.trust ?? null;
  controlCenter.pcRuntimeTrust = settledValue(pcRuntimeTrust) ?? controlCenter.pcHealth?.trust ?? null;
  const selectedTaskId = controlCenter.coreTasks.some((task) => task.taskId === controlCenter.activeTask?.taskId)
    ? controlCenter.activeTask.taskId
    : controlCenter.coreTasks.at(-1)?.taskId;
  if (selectedTaskId) {
    try {
      controlCenter.activeTask = await coreRequest(`/tasks/${encodeURIComponent(selectedTaskId)}`, { timeoutMs: 4_000 });
    } catch {
      controlCenter.activeTask = controlCenter.coreTasks.find((task) => task.taskId === selectedTaskId) ?? null;
    }
  } else {
    controlCenter.activeTask = null;
  }
  const latestMissionId = preferredMissionId(controlCenter.missions);
  const selectedMissionId = controlCenter.activeMissionId ?? latestMissionId;
  if (selectedMissionId) {
    selectMission(selectedMissionId);
    try {
      const selectedMission = await coreRequest(`/missions/${encodeURIComponent(selectedMissionId)}`, {
        token: controlCenter.coreAdminToken,
        timeoutMs: 4_000
      });
      if (controlCenter.activeMissionId === selectedMissionId) controlCenter.activeMission = selectedMission;
    } catch (error) {
      if (controlCenter.activeMissionId === selectedMissionId) {
        if (error.status === 404) {
          selectMission(latestMissionId === selectedMissionId ? null : latestMissionId);
          controlCenter.activeMission = controlCenter.missions.find((mission) => mission.missionId === controlCenter.activeMissionId) ?? null;
        } else {
          controlCenter.activeMission = controlCenter.missions.find((mission) => mission.missionId === selectedMissionId)
            ?? (controlCenter.activeMission?.missionId === selectedMissionId ? controlCenter.activeMission : null);
        }
      }
    }
  } else {
    controlCenter.activeMission = null;
    selectMission(null);
  }
  controlCenter.lastRefreshAt = new Date().toISOString();
  controlCenter.refreshing = false;

  const serviceErrors = [...results.slice(0, 9), missionList, ownerSession, runtimeTrust, pcRuntimeTrust].map(settledError).filter(Boolean);
  if (serviceErrors.length > 0) {
    recordOperationalError(serviceErrors[0], { action: '상태 확인', source: 'service' });
  } else {
    clearOperationalError('service');
    clearRecoveredConnectivityError();
  }
  render({ preserveScroll: true });
}

async function verifyModelProvider(provider) {
  const allowedProviders = new Set(['xai', 'meta', 'gemini', 'openai-agents']);
  if (!allowedProviders.has(provider) || controlCenter.providerVerifyBusy || !hasCoreAdminAccess()) return;
  controlCenter.providerVerifyBusy = provider;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest(`/integrations/model-providers/${encodeURIComponent(provider)}/verify`, {
      method: 'POST', token: controlCenter.coreAdminToken, timeoutMs: 12_000, body: {}
    });
    pushActivity('연결 점검', result.providerVerified ? `${provider} 제공자 읽기 검증 성공 · 모델 실행 권한은 부여되지 않았습니다.` : `${provider} 제공자 점검 결과: ${result.errorCode ?? result.status ?? '확인 필요'}`, result.providerVerified ? 'ok' : 'warn');
    await refreshLiveState({ silent: true });
  } catch (error) {
    const status = Number(error?.status);
    const message = status === 401 || status === 403 ? '통합 관리 권한이 없어 점검을 실행하지 못했습니다.'
      : status === 503 ? 'Core에서 제공자 점검 기능을 사용할 수 없습니다.'
        : status ? `연결 점검 실패 (HTTP ${status}).` : 'Core 서비스에 연결하지 못해 점검하지 못했습니다.';
    pushActivity('연결 점검', message, 'warn');
  } finally {
    controlCenter.providerVerifyBusy = null;
    render({ preserveScroll: true });
  }
}

function isLocalCredentialHandoffAvailable() {
  return canUseLocalCredentialHandoff({
    hosted: controlCenterNetwork.hosted,
    coreBaseUrl: controlCenter.coreBaseUrl,
    localApiBaseUrl: controlCenterNetwork.localApiBaseUrl,
    origin: globalThis.location?.origin
  });
}

async function submitProviderCredentialSetup(form) {
  if (controlCenter.providerSetupBusy || !hasCoreAdminAccess() || !isLocalCredentialHandoffAvailable()) return;
  const formData = new FormData(form);
  const provider = String(formData.get('provider') ?? '');
  let apiKey = String(formData.get('apiKey') ?? '');
  const keyInput = form.querySelector('[data-provider-key-input]');
  if (keyInput) keyInput.value = '';
  if (!apiKey || apiKey.length > 8192 || apiKey !== apiKey.trim()) {
    apiKey = '';
    pushActivity('제공자 연결', 'API 키 입력을 확인해 주세요. 키는 다시 표시하지 않습니다.', 'warn');
    render({ preserveScroll: true });
    return;
  }
  controlCenter.providerSetupBusy = true;
  render({ preserveScroll: true });
  try {
    await storeModelProviderApiKey({
      provider,
      apiKey,
      adminToken: controlCenter.coreAdminToken,
      request: (path, options) => coreRequest(path, options)
    });
    pushActivity('제공자 연결', `${provider} 키를 로컬 보호 저장소에 전달했습니다. 제공자 접근과 실행 권한은 아직 검증되지 않았습니다.`, 'ok');
    await refreshLiveState({ silent: true });
  } catch (error) {
    const messages = {
      'setup-unavailable': '이 연결의 안전 설정을 사용할 수 없습니다.',
      'invalid-key': 'API 키 형식을 확인하고 다시 입력해 주세요.',
      'handoff-unavailable': 'Core에서 일회용 안전 전달 경로를 열지 못했습니다.',
      'save-result-unverified': '저장 응답을 검증하지 못했습니다. 연결 상태를 새로 고쳐 확인해 주세요.',
      'save-outcome-unknown': '저장 요청 응답이 끊겨 결과가 불명확합니다. 키를 다시 보내지 말고 연결 상태부터 새로 고쳐 확인해 주세요.',
      'save-failed': '로컬 보호 저장소에 키를 전달하지 못했습니다. Core 상태와 권한을 확인해 주세요.'
    };
    pushActivity('제공자 연결', messages[error?.setupCode] ?? '연결을 완료하지 못했습니다. 키는 화면에서 지워졌습니다.', 'warn');
    if (error?.setupCode === 'save-outcome-unknown') await refreshLiveState({ silent: true });
  } finally {
    apiKey = '';
    controlCenter.providerSetupBusy = false;
    render({ preserveScroll: true });
  }
}

async function runSupportDiagnostic() {
  if (controlCenter.supportBusy) return;
  controlCenter.supportBusy = true;
  controlCenter.supportFailure = null;
  controlCenter.diagnosticsOpen = true;
  render({ preserveScroll: true });
  try {
    const diagnostic = await localControlRequest('/api/local/support-bundle', { timeoutMs: 12_000 });
    if (!diagnostic?.runtime || !Number.isFinite(diagnostic.runtime.serviceCount)
      || diagnostic.runtime.serviceCount < 1 || !Number.isFinite(diagnostic.runtime.healthyCount)) {
      const error = new Error('Invalid diagnostic response');
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    controlCenter.supportDiagnostic = diagnostic;
    controlCenter.supportLastSuccessAt = new Date().toISOString();
    clearOperationalError('diagnostic');
    const healthy = diagnostic?.runtime?.healthyCount ?? 0;
    const total = diagnostic?.runtime?.serviceCount ?? 0;
    const limitations = diagnostic?.issues?.length ?? 0;
    pushActivity('진단', `서비스 ${healthy}/${total} 정상 · 확인 ${limitations}건`, healthy === total ? 'ok' : 'warn');
  } catch (error) {
    controlCenter.supportFailure = describeReadFailure(error, {
      component: 'gateway', endpoint: localControlUrl('/api/local/support-bundle')
    });
    recordOperationalError(error, { action: '자동 진단', source: 'diagnostic' });
    pushActivity('진단', controlCenter.lastError, 'down');
  } finally {
    controlCenter.supportBusy = false;
    render({ preserveScroll: true });
  }
}

async function submitRoutine() {
  if (controlCenter.routinesBusy) return;
  controlCenter.routinesBusy = true;
  controlCenter.routinesError = null;
  controlCenter.routinesNotice = null;
  render({ preserveScroll: true });
  try {
    const request = createRoutineRequest(controlCenter.routinesDraft, `routine_${globalThis.crypto.randomUUID()}`);
    request.missionRequest.metadata={...(request.missionRequest.metadata ?? {}),...requestMemoryControl.metadata()};
    const result = await coreRequest('/routines', { method: 'POST', token: controlCenter.coreAdminToken, timeoutMs: 8_000, body: request });
    if (!result?.routine?.routineId) throw Object.assign(new Error('Invalid routine response'), { code: 'INVALID_RESPONSE' });
    controlCenter.routinesNotice = result.created === false ? '같은 예약이 이미 저장되어 있어 기존 기록을 표시했습니다.' : '일회성 예약을 Core SQLite 장부에 저장했습니다.';
    controlCenter.routinesDraft = { scheduleText: '', objective: '', successCriteria: '', recurrenceEnabled: false, weekday: 1, hour: 9, minute: 0, timeZone: 'Asia/Seoul' };
    const refreshed = await coreRequest('/routines', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 });
    controlCenter.routines = Array.isArray(refreshed?.items) ? refreshed.items : [];
    controlCenter.routinesStatus = 'ready';
    pushActivity('예약 작업', `${result.routine.timeExpression ?? result.routine.scheduledAt} · ${result.routine.status}`, 'ok');
  } catch (error) {
    controlCenter.routinesError = error instanceof TypeError && !error.status
      ? '예약 API에 연결하지 못했습니다. Core 주소와 서비스 상태를 확인해 주세요.'
      : error?.code === 'INVALID_RESPONSE' ? 'Core 예약 응답을 확인할 수 없습니다. 저장 상태를 새로고침해 주세요.'
        : error?.message && error?.payload == null && !error?.status ? error.message : routineApiFailureMessage(error);
  } finally {
    controlCenter.routinesBusy = false;
    render({ preserveScroll: true });
  }
}

async function cancelRoutine(routineId) {
  if (controlCenter.routinesBusy || !routineId) return;
  controlCenter.routinesBusy = true;
  controlCenter.routinesError = null;
  controlCenter.routinesNotice = null;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest(`/routines/${encodeURIComponent(routineId)}/cancel`, {
      method: 'POST', token: controlCenter.coreAdminToken, timeoutMs: 8_000
    });
    if (!result?.cancelled || result.routine?.routineId !== routineId) {
      throw Object.assign(new Error('Invalid cancellation response'), { code: 'INVALID_RESPONSE' });
    }
    controlCenter.routinesNotice = result.alreadyCancelled ? '이미 취소된 예약입니다.' : '실행 전 예약을 취소했습니다.';
    const refreshed = await coreRequest('/routines', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 });
    controlCenter.routines = Array.isArray(refreshed?.items) ? refreshed.items : [];
    controlCenter.routinesStatus = 'ready';
    pushActivity('예약 작업', '실행 전 취소', 'ok');
  } catch (error) {
    controlCenter.routinesError = error?.payload?.error?.code === 'A_ROUTINE_NOT_CANCELLABLE'
      ? '이미 실행을 시작했거나 종료된 예약은 여기서 취소할 수 없습니다.'
      : error?.code === 'INVALID_RESPONSE' ? '취소 응답을 확인할 수 없습니다. 저장 상태를 새로고침해 주세요.'
        : routineApiFailureMessage(error);
  } finally {
    controlCenter.routinesBusy = false;
    render({ preserveScroll: true });
  }
}

async function reviseRoutineTimezone(routineId) {
  if (controlCenter.routinesBusy || !routineId) return;
  const timeZone = String(controlCenter.routineTimezoneDrafts[routineId] ?? '').trim();
  controlCenter.routinesBusy = true; controlCenter.routinesError = null; controlCenter.routinesNotice = null;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest(`/routines/${encodeURIComponent(routineId)}/timezone`, { method: 'PATCH', token: controlCenter.coreAdminToken, timeoutMs: 8_000, body: { timeZone } });
    if (!result?.success || result.routine?.routineId !== routineId || result.routine.timeZone !== timeZone) throw Object.assign(new Error('Invalid timezone revision response'), { code: 'INVALID_RESPONSE' });
    controlCenter.routinesNotice = '반복 일정의 시간대를 바꾸고 이전 실행 시각을 폐기했습니다.';
    const refreshed = await coreRequest('/routines', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 });
    controlCenter.routines = Array.isArray(refreshed?.items) ? refreshed.items : [];
    controlCenter.routinesStatus = 'ready';
  } catch (error) {
    controlCenter.routinesError = routineApiFailureMessage(error);
  } finally { controlCenter.routinesBusy = false; render({ preserveScroll: true }); }
}

async function tickCoreDaemon(reason = 'control-center-manual') {
  try {
    const tick = await coreRequest('/worker/daemon/tick', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 12_000,
      body: { reason }
    });
    pushActivity('작업자', `${liveStatusText(tick.status ?? 'running')} · ${tick.drain?.processed ?? 0}건 처리`, 'ok');
    return tick;
  } catch (error) {
    pushActivity('작업자', friendlyOperationalError(error, { action: '작업자 실행' }), 'warn');
    return null;
  }
}

function terminalTaskStatus(status) {
  return ['completed', 'failed', 'blocked', 'cancelled', 'expired', 'compensated'].includes(String(status ?? '').toLowerCase());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollTask(taskId) {
  let latest = null;
  for (let index = 0; index < 12; index += 1) {
    await delay(index === 0 ? 250 : 700);
    latest = await coreRequest(`/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 5_000 });
    controlCenter.activeTask = latest;
    if (terminalTaskStatus(latest?.status)) return latest;
  }
  return latest;
}

async function submitLiveCommand(command) {
  if (controlCenter.commandBusy || controlCenter.ownerBusy) return;
  if (effectiveRuntimeTrust()?.mode === 'lockdown') {
    recordOperationalError(new Error('긴급 잠금이 활성화되어 변경 작업을 실행할 수 없습니다.'), {
      action: '작업 실행',
      source: 'runtime-trust'
    });
    controlCenter.diagnosticsOpen = true;
    render({ preserveScroll: true });
    return;
  }
  const trimmed = String(command ?? '').trim() || '회의 자료 분석';
  const timezoneRevision = parseWeeklyRoutineTimezoneCommand(trimmed, controlCenter.routines);
  if (timezoneRevision.matched) {
    if (!timezoneRevision.valid) {
      controlCenter.commandDraft = trimmed;
      controlCenter.routinesError = timezoneRevision.reason;
      pushActivity('예약 수정 차단', timezoneRevision.reason, 'warn');
      render({ preserveScroll: true });
      return;
    }
    return await reviseRoutineTimezoneFromCommand(timezoneRevision, trimmed);
  }
  const weeklyRoutine = parseWeeklyRoutineCommand(trimmed, `routine_${globalThis.crypto.randomUUID()}`);
  if (weeklyRoutine.matched) {
    if (!weeklyRoutine.valid) {
      controlCenter.commandDraft = trimmed;
      controlCenter.lastError = weeklyRoutine.reason;
      controlCenter.diagnosticsOpen = false;
      pushActivity('예약 확인 필요', weeklyRoutine.reason, 'warn');
      render({ preserveScroll: true });
      return;
    }
    return await submitNaturalWeeklyRoutine(weeklyRoutine.request, trimmed);
  }
  if (controlCenter.executionMode === 'mission') return await submitLiveMission(trimmed);
  const routing = classifyCommandLane(trimmed);
  if (routing.lane === 'mission') {
    controlCenter.executionMode = 'mission';
    writeUiSetting('jarvis.executionMode', 'mission');
    pushActivity('자동 분기', routing.userSummary, 'ok');
    return await submitLiveMission(trimmed, { routing, autoPromoted: true });
  }
  controlCenter.commandDraft = trimmed;
  controlCenter.commandBusy = true;
  clearOperationalError();
  state = composeState(trimmed);
  pushActivity('명령', trimmed, 'ok');
  render({ preserveScroll: true });

  try {
    const ownerSessionId = (await prepareCommandOwnerSession())?.sessionId ?? null;
    const created = await coreRequest('/tasks', {
      method: 'POST',
      token: ownerSessionId ? controlCenter.coreAdminToken : null,
      timeoutMs: TASK_CREATION_TIMEOUT_MS,
      body: {
        rawText: trimmed,
        options: {
          source: 'pc_ui',
          sourceModule: 'B_PC_AGENT',
          deviceId: 'local-control-center',
          metadata: {
            submittedBy: 'jarvis-control-center',
            ...requestMemoryControl.metadata(),
            conversationId: conversationContext.idFor(controlCenter.coreBaseUrl)
          },
          ownerSessionId
        }
      }
    });
    controlCenter.activeTask = created;
    pushActivity('핵심 엔진', `${created.taskId} · ${practicalStatusLabel(created.status)}`, 'ok');

    if (['WAITING_APPROVAL', 'WAITING_INPUT', 'BLOCKED', 'REJECTED'].includes(String(created.status ?? '').toUpperCase())) {
      pushActivity('승인', practicalStatusLabel(created.status), 'warn');
      controlCenter.commandDraft = '';
      await refreshLiveState({ silent: true });
      return;
    }

    const queued = await coreRequest(`/tasks/${encodeURIComponent(created.taskId)}/queue`, {
      method: 'POST',
      timeoutMs: 8_000,
      body: {
        options: {
          source: 'pc_ui',
          timeoutMs: 30_000,
          userConfirmation: ownerTaskConfirmation(ownerSessionId)
        }
      }
    });
    controlCenter.activeTask = { ...created, queue: queued };
    pushActivity('대기열', practicalStatusLabel(queued.status ?? 'QUEUED'), 'ok');
    await tickCoreDaemon('control-center-command');
    const latest = await pollTask(created.taskId);
    if (latest) controlCenter.activeTask = latest;
    controlCenter.commandDraft = '';
    await refreshLiveState({ silent: true });
  } catch (error) {
    if (requiresMissionRoute(error)) {
      controlCenter.executionMode = 'mission';
      writeUiSetting('jarvis.executionMode', 'mission');
      controlCenter.commandBusy = false;
      clearOperationalError();
      const serverRouting = error.payload?.routing ?? classifyCommandLane(trimmed);
      pushActivity('자동 분기', serverRouting.userSummary ?? '복합 요청을 목표 실행으로 전환합니다.', 'ok');
      await submitLiveMission(trimmed, { routing: serverRouting, autoPromoted: true });
      return;
    }
    recordOperationalError(error, { action: '작업 실행' });
    pushActivity('오류', controlCenter.lastError, 'down');
  } finally {
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

async function submitNaturalWeeklyRoutine(request, originalCommand) {
  if (!hasCoreAdminAccess()) {
    controlCenter.commandDraft = originalCommand;
    controlCenter.lastError = '주간 예약에는 Core 관리자 인증 연결이 필요합니다. 명령은 즉시 실행하지 않았습니다.';
    pushActivity('예약 차단', controlCenter.lastError, 'warn');
    render({ preserveScroll: true });
    return;
  }
  controlCenter.commandDraft = originalCommand;
  controlCenter.commandBusy = true;
  controlCenter.routinesError = null;
  controlCenter.routinesNotice = null;
  clearOperationalError();
  pushActivity('주간 예약', `${request.scheduleText} · ${request.missionRequest.objective}`, 'ok');
  render({ preserveScroll: true });
  try {
    const created = await coreRequest('/routines/command', { method: 'POST', token: controlCenter.coreAdminToken, timeoutMs: 8_000,
      body: { command: originalCommand, routineId: request.routineId, ...requestMemoryControl.metadata() } });
    if (!created?.routine?.routineId) throw Object.assign(new Error('Invalid routine response'), { code: 'INVALID_RESPONSE' });
    const refreshed = await coreRequest('/routines', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 });
    controlCenter.routines = Array.isArray(refreshed?.items) ? refreshed.items : [];
    controlCenter.routinesStatus = 'ready';
    controlCenter.routinesNotice = created.created === false ? '같은 예약 요청이 이미 등록되어 있습니다.' : '저위험 권한으로 주간 예약을 저장했습니다. 각 실행은 예정 시각에 현재 연결과 권한을 다시 확인합니다.';
    controlCenter.commandDraft = '';
    pushActivity('예약 저장', `${created.routine.timeExpression ?? created.routine.scheduledAt} · ${created.routine.status}`, 'ok');
  } catch (error) {
    controlCenter.commandDraft = originalCommand;
    controlCenter.routinesError = routineApiFailureMessage(error);
    pushActivity('예약 실패', controlCenter.routinesError, 'down');
  } finally {
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

async function reviseRoutineTimezoneFromCommand(revision, originalCommand) {
  if (!hasCoreAdminAccess()) {
    controlCenter.commandDraft = originalCommand;
    controlCenter.routinesError = '주간 예약 변경에는 Core 관리자 인증 연결이 필요합니다. 기존 예약은 변경하지 않았습니다.';
    pushActivity('예약 수정 차단', controlCenter.routinesError, 'warn');
    render({ preserveScroll: true });
    return;
  }
  controlCenter.commandBusy = true;
  controlCenter.routinesBusy = true;
  controlCenter.routinesError = null;
  controlCenter.routinesNotice = null;
  try {
    const result = await coreRequest(`/routines/${encodeURIComponent(revision.routineId)}/timezone`, {
      method: 'PATCH', token: controlCenter.coreAdminToken, timeoutMs: 8_000, body: { timeZone: revision.timeZone }
    });
    if (!result?.success || result.routine?.routineId !== revision.routineId || result.routine.timeZone !== revision.timeZone) {
      throw Object.assign(new Error('Invalid timezone revision response'), { code: 'INVALID_RESPONSE' });
    }
    const refreshed = await coreRequest('/routines', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 });
    controlCenter.routines = Array.isArray(refreshed?.items) ? refreshed.items : [];
    controlCenter.routinesStatus = 'ready';
    controlCenter.routinesNotice = '대기 중인 주간 예약의 시간대를 변경했습니다. 기존 실행 시각은 폐기되고 새 시간대 기준으로 다시 계산됐습니다.';
    controlCenter.commandDraft = '';
    pushActivity('예약 시간대 변경', `${revision.timeZone} · ${revision.routineId}`, 'ok');
  } catch (error) {
    controlCenter.commandDraft = originalCommand;
    controlCenter.routinesError = routineApiFailureMessage(error);
    pushActivity('예약 수정 실패', controlCenter.routinesError, 'down');
  } finally {
    controlCenter.commandBusy = false;
    controlCenter.routinesBusy = false;
    render({ preserveScroll: true });
  }
}

function requiresMissionRoute(error) {
  return Number(error?.status) === 409
    && error?.payload?.error?.code === 'A_COMMAND_REQUIRES_MISSION';
}

async function submitLiveMission(objective, { routing = null, autoPromoted = false } = {}) {
  const trimmed = String(objective ?? '').trim() || '작업 폴더를 점검하고 검증된 결과를 완성하라.';
  const effectiveRouting = routing ?? classifyCommandLane(trimmed);
  controlCenter.commandDraft = trimmed;
  controlCenter.commandBusy = true;
  clearOperationalError();
  state = composeState(trimmed);
  pushActivity(autoPromoted ? '복합 목표' : '목표', trimmed, 'ok');
  render({ preserveScroll: true });

  try {
    const ownerSession = await prepareCommandOwnerSession();
    const created = await coreRequest('/missions', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 8_000,
      body: {
        objective: trimmed,
        executionMandateId: personalMandatePanel.selected(),
        successCriteria: missionSuccessCriteria(trimmed, effectiveRouting),
        constraints: [
          '허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.',
          '최신 정보가 필요하면 출처와 조회 시점을 실행 증거에 남긴다.',
          '외부 전송과 되돌릴 수 없는 작업은 행동별 승인을 받는다.'
        ],
        budgets: {
          maxWaves: 12,
          maxActions: 40,
          maxActiveRuntimeMs: 1_200_000
        },
        authorization: missionAuthorization(ownerSession),
        metadata: {
          submittedBy: 'jarvis-control-center',
          ...requestMemoryControl.metadata(),
          conversationId: conversationContext.idFor(controlCenter.coreBaseUrl),
          automaticallyRouted: autoPromoted,
          commandRouting: effectiveRouting
        }
      }
    });
    controlCenter.activeMission = created;
    selectMission(created.missionId);
    pushActivity('미션', `${created.missionId} · 등록됨`, 'ok');
    render({ preserveScroll: true });

    const result = await coreRequest(`/missions/${encodeURIComponent(created.missionId)}/run`, {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 180_000,
      body: {}
    });
    controlCenter.activeMission = result;
    selectMission(result.missionId ?? created.missionId);
    controlCenter.commandDraft = '';
    pushActivity('미션', `${practicalStatusLabel(result.status)} · 행동 ${result.metrics?.successfulActions ?? 0}건 완료`,
      result.status === 'COMPLETED' ? 'ok' : result.status === 'WAITING_APPROVAL' ? 'warn' : 'down');
    await refreshLiveState({ silent: true });
  } catch (error) {
    recordOperationalError(error, { action: '목표 실행' });
    pushActivity('오류', controlCenter.lastError, 'down');
  } finally {
    await personalMandatePanel.refresh();
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

function missionSuccessCriteria(objective, routing) {
  const criteria = [`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`];
  const stageIds = new Set(routing?.stageIds ?? []);
  if (stageIds.has('live-data') || stageIds.has('research')) {
    criteria.push('사용한 최신 정보의 출처와 조회 시점이 실행 증거로 확인된다.');
  }
  if (stageIds.has('document')) {
    criteria.push('요청한 형식과 저장 위치에 실제 산출물이 생성되고 다시 열 수 있음이 확인된다.');
  }
  if (stageIds.has('external-transfer')) {
    criteria.push('사용자 승인 후 정확한 수신자와 첨부 파일로 전송되고 발송 결과가 확인된다.');
  }
  return criteria;
}

async function decideLiveMissionGate(missionId, gateId, decision, responseText = null, answers = undefined) {
  controlCenter.commandBusy = true;
  clearOperationalError();
  render({ preserveScroll: true });
  try {
    const result = await coreRequest(`/missions/${encodeURIComponent(missionId)}/gates/${encodeURIComponent(gateId)}/decision`, {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 180_000,
      body: {
        decision,
        responseText,
        ...(answers ? { answers } : {}),
        decidedBy: 'local-control-center',
        resume: decision === 'approve'
      }
    });
    controlCenter.activeMission = result;
    selectMission(result.missionId ?? missionId);
    pushActivity('승인', `${practicalStatusLabel(result.status)} · ${decision === 'approve' ? '계속 실행' : '거절'}`,
      decision === 'approve' ? 'ok' : 'warn');
    await refreshLiveState({ silent: true });
  } catch (error) {
    recordOperationalError(error, { action: '목표 재개' });
    pushActivity('오류', controlCenter.lastError, 'down');
  } finally {
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

async function cancelLiveMission(missionId) {
  clearOperationalError();
  try {
    const result = await coreRequest(`/missions/${encodeURIComponent(missionId)}/cancel`, {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 12_000,
      body: { reason: 'cancelled-from-local-control-center' }
    });
    controlCenter.activeMission = result;
    selectMission(result.missionId ?? missionId);
    pushActivity('미션', '목표 실행을 중단했습니다.', 'warn');
    await refreshLiveState({ silent: true });
  } catch (error) {
    recordOperationalError(error, { action: '목표 중단' });
    pushActivity('오류', controlCenter.lastError, 'down');
  } finally {
    render({ preserveScroll: true });
  }
}

async function resumeLiveMission(missionId) {
  controlCenter.commandBusy = true;
  clearOperationalError();
  render({ preserveScroll: true });
  try {
    const result = await coreRequest(`/missions/${encodeURIComponent(missionId)}/run`, {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 180_000,
      body: {}
    });
    controlCenter.activeMission = result;
    selectMission(result.missionId ?? missionId);
    pushActivity('미션', `${practicalStatusLabel(result.status)} · 중단된 지점부터 계속 실행`,
      result.status === 'COMPLETED' ? 'ok' : result.status === 'WAITING_APPROVAL' ? 'warn' : 'down');
    await refreshLiveState({ silent: true });
  } catch (error) {
    recordOperationalError(error, { action: '목표 계속 실행' });
    pushActivity('오류', controlCenter.lastError, 'down');
  } finally {
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

function setExecutionMode(mode) {
  controlCenter.executionMode = mode === 'mission' ? 'mission' : 'task';
  writeUiSetting('jarvis.executionMode', controlCenter.executionMode);
  render({ preserveScroll: true });
  app.querySelector(`[data-execution-mode="${controlCenter.executionMode}"]`)?.focus();
}

function activeOwnerSession() {
  return currentOwnerSession(controlCenter.ownerSession);
}

async function submitGoalRevision(missionId) {
  const draft = controlCenter.goalRevisionDrafts.get(missionId);
  if (!draft || draft.busy) return;
  draft.busy = true;
  draft.error = null;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest(`/missions/${encodeURIComponent(missionId)}/goal-revisions`, {
      method: 'POST', token: controlCenter.coreAdminToken, timeoutMs: 12_000,
      body: goalRevisionRequest(draft)
    });
    if (!result.success || !result.mission) throw new Error(result.error?.message ?? '목표 변경 결과를 확인하지 못했습니다.');
    if (controlCenter.activeMissionId === missionId) controlCenter.activeMission = result.mission;
    controlCenter.goalRevisionDrafts.delete(missionId);
    pushActivity('목표 수정', result.status === 'pending'
      ? '현재 실행 결과를 확인한 뒤 새 목표를 적용합니다.' : '수정한 목표를 저장했습니다.', 'ok');
    await refreshLiveState({ silent: true });
  } catch (error) {
    draft.error = Number(error.status) === 409
      ? '목표 상태가 변경되었습니다. 작성한 내용은 유지됩니다. 최신 목표를 불러온 후 다시 수정해 주세요.'
      : error.message ?? '목표 변경을 확인하지 못했습니다. 같은 내용으로 재시도할 수 있습니다.';
  } finally {
    draft.busy = false;
    render({ preserveScroll: true });
  }
}

function renderGoalRevisionEditor(mission) {
  const draft = controlCenter.goalRevisionDrafts.get(mission.missionId);
  if (!draft) return '';
  const disabled = draft.busy ? 'disabled' : '';
  return `<form class="mission-goal-editor" data-goal-revision-form data-mission-id="${escapeHtml(mission.missionId)}">
    <label>수정할 목표<textarea name="objective" data-goal-revision-field="objective" required maxlength="32768" ${disabled}>${escapeHtml(draft.objective)}</textarea></label>
    <label>변경 이유 (선택)<input name="reason" data-goal-revision-field="reason" maxlength="1000" value="${escapeHtml(draft.reason)}" ${disabled}></label>
    <p>실행된 작업과 이전 목표는 기록에 남습니다. 새 목표의 실행은 변경 내용을 저장한 뒤 이어갈 수 있습니다.</p>
    <label class="mission-edit-option"><input type="checkbox" data-goal-revision-field="replaceCriteria" ${draft.replaceCriteria ? 'checked' : ''} ${disabled}>완료 기준도 새로 지정</label>
    ${draft.replaceCriteria ? `<label>완료 기준 (한 줄에 하나씩)<textarea data-goal-revision-field="criteria" ${disabled}>${escapeHtml(draft.criteria)}</textarea></label>` : `<small>기준 내용과 검증 방법을 유지합니다. 자료 종류를 바꾸면 변경 이력에 저장됩니다.</small>
      ${draft.originalCriteria.map((criterion, index) => `<label>${escapeHtml(criterion.statement)}<select data-goal-criterion-role="${index}" ${disabled}>
        <option value="output" ${draft.criterionRoles[index] === 'output' ? 'selected' : ''}>새로 만들 결과물 확인</option>
        <option value="input" ${draft.criterionRoles[index] === 'input' ? 'selected' : ''}>기존 자료 확인</option></select></label>`).join('')}
      <small>기존 자료를 선택해도 읽기 권한이 추가되지 않습니다. 확인할 자료는 목표에 명시해 주세요.</small>
      <label class="mission-edit-option"><input type="checkbox" data-goal-revision-field="confirmExistingCriteria" ${draft.confirmExistingCriteria ? 'checked' : ''} ${disabled}>현재 완료 기준을 검토했습니다</label>`}
    <label class="mission-edit-option"><input type="checkbox" data-goal-revision-field="replaceConstraints" ${draft.replaceConstraints ? 'checked' : ''} ${disabled}>작업 조건도 새로 지정</label>
    ${draft.replaceConstraints ? `<label>작업 조건 (한 줄에 하나씩)<textarea data-goal-revision-field="constraints" ${disabled}>${escapeHtml(draft.constraints)}</textarea></label>` : '<small>기존 작업 조건과 연결 권한을 유지합니다.</small>'}
    ${draft.error ? `<p role="alert">${escapeHtml(draft.error)}</p>` : ''}
    <div class="mission-controls"><button type="submit" class="accept" ${disabled}>${draft.busy ? '변경 저장 중' : '변경 저장'}</button>
      <button type="button" data-goal-revision-reload="${escapeHtml(mission.missionId)}" ${disabled}>최신 목표 불러오기</button>
      <button type="button" data-goal-revision-close="${escapeHtml(mission.missionId)}" ${disabled}>닫기</button></div>
  </form>`;
}

async function prepareCommandOwnerSession() {
  const result = await prepareOwnerCommand({
    enabled: controlCenter.autoOwnerEnabled,
    locked: effectiveRuntimeTrust()?.mode === 'lockdown',
    readStatus: () => coreRequest('/owner-session', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }),
    activate: () => coreRequest('/owner-session/activate', {
      method: 'POST', token: controlCenter.coreAdminToken, timeoutMs: 8_000,
      body: { durationMinutes: 30, requestedBy: 'local-control-center-command', grants: ['read_only', 'local_reversible', 'high_impact'] }
    })
  });
  if (result.status) controlCenter.ownerSession = result.status;
  if (result.suspended) {
    controlCenter.autoOwnerEnabled = false;
    writeUiSetting('jarvis.autoOwnerEnabled', '0');
    pushActivity('권한', '철회된 자동 승인을 유지합니다. 필요할 때 자동 승인을 다시 켤 수 있습니다.', 'warn');
  }
  return result.session;
}

function ownerTaskConfirmation(ownerSessionId) {
  if (!ownerSessionId) {
    return {
      confirmed: false,
      confirmedAt: null,
      source: 'local-control-center'
    };
  }
  return {
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    source: 'personal-owner-session'
  };
}

function missionAuthorization(ownerSession) {
  if (!ownerSession) {
    return {
      mode: 'supervised',
      grants: ['read_only', 'local_reversible']
    };
  }
  return {
    mode: 'trusted_session',
    grants: ['read_only', 'local_reversible', 'high_impact'],
    ownerSessionId: ownerSession.sessionId
  };
}

function ownerSessionLabel() {
  if (!controlCenter.autoOwnerEnabled) return '자동 승인 꺼짐';
  const session = activeOwnerSession();
  if (!session) return '자동 승인 · 명령 시 준비';
  const minutes = Math.max(1, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 60_000));
  return `자동 승인 · ${minutes}분`;
}

async function toggleOwnerSession() {
  if (controlCenter.ownerBusy || controlCenter.commandBusy) return;
  if (effectiveRuntimeTrust()?.mode === 'lockdown') {
    recordOperationalError(new Error('긴급 잠금 중에는 소유자 모드를 활성화할 수 없습니다.'), {
      action: '소유자 모드 변경',
      source: 'runtime-trust'
    });
    controlCenter.diagnosticsOpen = true;
    render({ preserveScroll: true });
    return;
  }
  controlCenter.ownerBusy = true;
  clearOperationalError();
  render({ preserveScroll: true });
  try {
    const active = controlCenter.autoOwnerEnabled;
    if (active) {
      controlCenter.autoOwnerEnabled = false;
      writeUiSetting('jarvis.autoOwnerEnabled', '0');
    }
    const result = await coreRequest(active ? '/owner-session/revoke' : '/owner-session/activate', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 8_000,
      body: active
        ? { reason: 'owner-disabled-from-control-center', revokedBy: 'local-control-center' }
        : {
            durationMinutes: 30,
            requestedBy: 'local-control-center',
            grants: ['read_only', 'local_reversible', 'high_impact']
          }
    });
    if (result?.success !== true) throw new Error('자동 승인 설정을 변경하지 못했습니다.');
    controlCenter.ownerSession = result;
    if (!active && result.success === true && currentOwnerSession(result)) {
      controlCenter.autoOwnerEnabled = true;
      writeUiSetting('jarvis.autoOwnerEnabled', '1');
    }
    pushActivity('권한', active ? '자동 승인을 껐습니다.' : '자동 승인을 켰습니다. 만료 후 다음 명령에서 새 세션을 준비합니다.', active ? 'warn' : 'ok');
  } catch (error) {
    recordOperationalError(error, { action: '소유자 모드 변경', source: 'owner-session' });
    pushActivity('권한', controlCenter.lastError, 'down');
  } finally {
    controlCenter.ownerBusy = false;
    render({ preserveScroll: true });
  }
}

async function decideLiveTask(taskId, decision) {
  controlCenter.commandBusy = true;
  clearOperationalError();
  render({ preserveScroll: true });
  try {
    await coreRequest(`/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
      timeoutMs: 8_000,
      body: {
        decision,
        deviceId: 'local-control-center',
        decidedAt: new Date().toISOString()
      }
    });
    const decidedTask = await coreRequest(`/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 5_000 });
    controlCenter.activeTask = decidedTask;
    pushActivity('승인', `${taskId} · ${practicalStatusLabel(decidedTask.status)}`, decision === 'approve' ? 'ok' : 'warn');
    if (decision === 'approve') {
      const queued = await coreRequest(`/tasks/${encodeURIComponent(taskId)}/queue`, {
        method: 'POST',
        timeoutMs: 8_000,
        body: {
          options: {
            source: 'pc_ui',
            timeoutMs: 30_000,
            userConfirmation: {
              confirmed: true,
              confirmedAt: new Date().toISOString()
            }
          }
        }
      });
      controlCenter.activeTask = { ...decidedTask, queue: queued };
      await tickCoreDaemon('control-center-approved-task');
      const latest = await pollTask(taskId);
      if (latest) controlCenter.activeTask = latest;
    }
    await refreshLiveState({ silent: true });
  } catch (error) {
    recordOperationalError(error, { action: '승인 처리' });
    pushActivity('오류', controlCenter.lastError, 'down');
  } finally {
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

function resetTaskRollback(taskId = null) {
  controlCenter.rollbackFlow = {
    taskId,
    status: 'idle',
    plan: null,
    error: null
  };
}

function rollbackFailureMessage(error) {
  const code = error?.payload?.error?.code ?? error?.error?.code ?? error?.code ?? null;
  return {
    B_ROLLBACK_NOT_FOUND: '이 작업의 되돌리기 기록을 찾지 못했습니다.',
    B_ROLLBACK_UNSAFE_ENTRIES: '현재 상태에서는 모든 변경을 안전하게 되돌릴 수 없습니다.',
    A_COMPENSATION_CONFIRMATION_REQUIRED: '되돌리기 전에 명시적인 확인이 필요합니다.',
    A_COMPENSATION_NOT_AVAILABLE: '이 작업은 검증된 되돌리기를 지원하지 않습니다.',
    A_COMPENSATION_ACTIONS_NOT_FOUND: '되돌릴 변경 동작을 찾지 못했습니다.',
    A_COMPENSATION_STATE_NOT_ALLOWED: '현재 작업 상태에서는 되돌릴 수 없습니다.'
  }[code] ?? friendlyOperationalError(error, { action: '되돌리기 준비' });
}

async function previewTaskRollback(taskId) {
  controlCenter.rollbackFlow = { taskId, status: 'checking', plan: null, error: null };
  clearOperationalError();
  render({ preserveScroll: true });
  try {
    const plan = await coreRequest(`/tasks/${encodeURIComponent(taskId)}/compensation/plan`, { timeoutMs: 8_000 });
    if (plan?.success !== true) {
      const error = new Error(plan?.error?.message ?? plan?.error?.code ?? 'rollback-preview-failed');
      error.error = plan?.error;
      throw error;
    }
    controlCenter.rollbackFlow = {
      taskId,
      status: 'preview',
      plan,
      error: null
    };
    pushActivity('복구', `${plan.readyCount ?? 0}개 변경의 되돌리기 점검 완료`, plan.blockedCount ? 'warn' : 'ok');
  } catch (error) {
    controlCenter.rollbackFlow = {
      taskId,
      status: 'error',
      plan: null,
      error: rollbackFailureMessage(error)
    };
  } finally {
    render({ preserveScroll: true });
  }
}

async function confirmTaskRollback(taskId) {
  const flow = controlCenter.rollbackFlow;
  if (flow.taskId !== taskId || flow.status !== 'preview' || flow.plan?.blockedCount > 0) return;
  controlCenter.commandBusy = true;
  controlCenter.rollbackFlow = { ...flow, status: 'executing', error: null };
  clearOperationalError();
  render({ preserveScroll: true });
  try {
    const result = await coreRequest(`/tasks/${encodeURIComponent(taskId)}/compensation/run`, {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        reason: 'user-requested-undo-from-local-control-center',
        userConfirmation: {
          confirmed: true,
          confirmedAt: new Date().toISOString(),
          source: 'local-control-center'
        }
      }
    });
    if (result?.success !== true) {
      const error = new Error(result?.error?.message ?? result?.error?.code ?? 'rollback-execution-failed');
      error.error = result?.error;
      throw error;
    }
    controlCenter.rollbackFlow = { taskId, status: 'completed', plan: flow.plan, error: null };
    controlCenter.activeTask = await coreRequest(`/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 5_000 });
    pushActivity('복구', `${flow.plan.readyCount ?? 0}개 변경을 원래 상태로 되돌렸습니다.`, 'ok');
    await refreshLiveState({ silent: true });
  } catch (error) {
    controlCenter.rollbackFlow = {
      taskId,
      status: 'error',
      plan: flow.plan,
      error: rollbackFailureMessage(error)
    };
    pushActivity('복구', controlCenter.rollbackFlow.error, 'down');
  } finally {
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

async function openLiveTask(taskId) {
  try {
    if (controlCenter.rollbackFlow.taskId !== taskId) resetTaskRollback(taskId);
    controlCenter.activeTask = await coreRequest(`/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 5_000 });
    render({ preserveScroll: true });
  } catch (error) {
    recordOperationalError(error, { action: '작업 열기' });
    pushActivity('오류', controlCenter.lastError, 'down');
    render({ preserveScroll: true });
  }
}

function saveLiveSettings(formData) {
  const previousCoreBaseUrl = controlCenter.coreBaseUrl;
  controlCenter.coreBaseUrl = normalizeEndpoint(formData.get('coreBaseUrl') || controlCenter.coreBaseUrl);
  if (controlCenter.coreBaseUrl !== previousCoreBaseUrl) {
    controlCenter.activeMissionId = missionSelection.read(missionSelectionScope());
    controlCenter.activeMission = null;
    controlCenter.missions = [];
  }
  controlCenter.pcBaseUrl = normalizeEndpoint(formData.get('pcBaseUrl') || controlCenter.pcBaseUrl);
  controlCenter.bridgeBaseUrl = normalizeEndpoint(formData.get('bridgeBaseUrl') || controlCenter.bridgeBaseUrl);
  controlCenter.coreAdminToken = String(formData.get('coreAdminToken') || controlCenter.coreAdminToken);
  controlCenter.pcAgentToken = String(formData.get('pcAgentToken') || controlCenter.pcAgentToken);
  writeUiSetting('jarvis.coreBaseUrl', controlCenter.coreBaseUrl);
  writeUiSetting('jarvis.pcBaseUrl', controlCenter.pcBaseUrl);
  writeUiSetting('jarvis.bridgeBaseUrl', controlCenter.bridgeBaseUrl);
  writeUiSecret('jarvis.coreAdminToken', controlCenter.coreAdminToken);
  writeUiSecret('jarvis.pcAgentToken', controlCenter.pcAgentToken);
  pushActivity('설정', '저장됨', 'ok');
  refreshLiveState();
}

function renderNearby(items) {
  return `<div class="nearby-grid"><ul>${items
    .map((item) => `<li><span>${item.icon}</span><strong>${escapeHtml(item.label)}</strong><em>${item.distance}</em></li>`)
    .join('')}</ul><div class="radar"><i></i><b></b></div></div>`;
}

function renderServiceCard(label, status, metric, detail) {
  const statusClass = liveStatusClass(status);
  return `<article class="service-card ${statusClass}">
    <header><strong>${escapeHtml(label)}</strong><span>${escapeHtml(liveStatusText(status))}</span></header>
    <b>${escapeHtml(metric ?? '대기')}</b>
    <em>${escapeHtml(detail ?? 'local')}</em>
  </article>`;
}

function renderLiveSettings() {
  return `<form class="live-settings" id="live-settings">
    <label>핵심 엔진 주소<input name="coreBaseUrl" value="${escapeHtml(controlCenter.coreBaseUrl)}" autocomplete="off" /></label>
    <label>PC 실행기 주소<input name="pcBaseUrl" value="${escapeHtml(controlCenter.pcBaseUrl)}" autocomplete="off" /></label>
    <label>모바일 연결 주소<input name="bridgeBaseUrl" value="${escapeHtml(controlCenter.bridgeBaseUrl)}" autocomplete="off" /></label>
    <label>핵심 엔진 토큰<input name="coreAdminToken" type="password" value="${escapeHtml(controlCenter.coreAdminToken)}" autocomplete="off" aria-describedby="secret-storage-note" /></label>
    <label>PC 실행기 토큰<input name="pcAgentToken" type="password" value="${escapeHtml(controlCenter.pcAgentToken)}" autocomplete="off" aria-describedby="secret-storage-note" /></label>
    <small id="secret-storage-note">토큰은 현재 탭에서만 유지되며 영구 저장되지 않습니다.</small>
    <button type="submit">저장</button>
  </form>`;
}

function timestampMs(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function servicePackageStatus(packageId, serviceStartedAt) {
  const packageInfo = controlCenter.localPackageStatus?.packages?.[packageId];
  if (!packageInfo) {
    return {
      status: 'checking',
      stateLabel: '확인 중',
      detail: '패키지 상태를 확인하고 있습니다'
    };
  }
  if (packageInfo.status !== 'ready') {
    return {
      status: 'down',
      stateLabel: '누락',
      detail: packageInfo.error ?? '패키지 정보를 읽을 수 없습니다'
    };
  }
  if (!packageInfo.serviceHostRecoveryReady) {
    return {
      status: 'warn',
      stateLabel: '재빌드',
      detail: '서비스 복구 보호 기능이 필요합니다'
    };
  }
  const packageTime = timestampMs(packageInfo.generatedAt ?? packageInfo.manifestUpdatedAt);
  const serviceTime = timestampMs(serviceStartedAt);
  if (packageTime && serviceTime && packageTime > serviceTime + 1_000) {
    return {
      status: 'warn',
      stateLabel: '업데이트 대기',
      detail: `패키지 ${formatShortTime(packageInfo.generatedAt ?? packageInfo.manifestUpdatedAt)} · 서비스 ${formatShortTime(serviceStartedAt)}`
    };
  }
  return {
    status: 'ok',
    stateLabel: '최신',
    detail: packageInfo.serviceHostRecoveryReady ? '복구 보호 기능 활성' : '준비 완료'
  };
}

function renderServiceUpdatePanel() {
  const rows = [
    {
      id: 'core',
      label: '핵심 엔진 서비스',
      ...servicePackageStatus('core', controlCenter.coreHealth?.startedAt)
    },
    {
      id: 'pc',
      label: 'PC 실행기',
      ...servicePackageStatus('pc', controlCenter.pcRuntime?.startedAt ?? controlCenter.pcHealth?.serviceRuntime?.startedAt)
    }
  ];
  const actionRequired = rows.some((row) => row.status === 'warn' || row.status === 'down');
  return `<section class="service-update-panel ${actionRequired ? 'warn' : 'ok'}">
    <header><strong>서비스 빌드</strong><span>${actionRequired ? '조치 필요' : '최신'}</span></header>
    <ul>${rows.map((row) => `<li class="${escapeHtml(row.status)}">
      <span>${escapeHtml(row.stateLabel)}</span>
      <strong>${escapeHtml(row.label)}</strong>
      <em>${escapeHtml(row.detail)}</em>
    </li>`).join('')}</ul>
  </section>`;
}

function taskImpactLabel(task) {
  const actionType = String(task?.actionType ?? task?.plan?.action?.actionType ?? '').toUpperCase();
  const approval = task?.approvalCard ?? {};
  if (approval.externalTransfer) return '외부 전송';
  if (approval.irreversible) return '되돌릴 수 없는 변경';
  if (/^(LIST|SEARCH|READ|GET|CAPABILITY_QUERY)/.test(actionType)) return '로컬 읽기';
  if (approval.rollbackAvailable) return '복구 가능한 로컬 변경';
  return '로컬 작업';
}

function renderInlineTaskApproval(task) {
  if (!isApprovalPending(task)) return '';
  const approval = task.approvalCard ?? {};
  const affected = approval.affectedItems?.[0]?.path ?? approval.affectedItems?.[0]?.name ?? null;
  return `<section class="task-approval" aria-label="실행 승인">
    <div>
      <span>실행 전 확인</span>
      <strong>${escapeHtml(approval.interpretedIntent ?? task.plan?.interpretedIntent ?? task.title ?? '요청한 작업')}</strong>
      <em>${escapeHtml(taskImpactLabel(task))}${affected ? ` · ${escapeHtml(affected)}` : ''}</em>
    </div>
    <menu>
      <button type="button" class="accept" data-task-decision="approve" data-task-id="${escapeHtml(task.taskId)}">승인하고 실행</button>
      <button type="button" class="reject" data-task-decision="reject" data-task-id="${escapeHtml(task.taskId)}">거절</button>
    </menu>
  </section>`;
}

function renderTaskTimeline(task) {
  if (!task) {
    return `<div class="task-focus empty"><strong>새 작업을 기다리고 있습니다</strong><span>요청을 보내면 진행 상태와 결과가 여기에 표시됩니다.</span></div>`;
  }
  const lifecycle = (task.lifecycle ?? []).slice(-5);
  return `<div class="task-focus ${liveStatusClass(task.status)}">
    <header>
      <div><span>${escapeHtml(taskImpactLabel(task))}</span><strong>${escapeHtml(task.title ?? task.plan?.title ?? '작업')}</strong></div>
      <b>${escapeHtml(practicalStatusLabel(task.status ?? 'created'))}</b>
    </header>
    ${task.request?.metadata?.workReferenceIssue || /^A_WORK_REFERENCE_/.test(task.policy?.blockedCode ?? '')
      ? `<p role="status">${escapeHtml(task.request?.metadata?.workReferenceIssue?.message ?? task.policy.blockedReason)}</p>`
      : renderRememberedFile(task.request?.metadata)}
    ${renderInlineTaskApproval(task)}
    ${lifecycle.length
      ? `<ol class="task-progress">${lifecycle.map((item) => `<li><span>${escapeHtml(practicalStatusLabel(item.status))}</span><strong>${escapeHtml(item.label ?? item.reason ?? '진행')}</strong><em>${formatShortTime(item.at)}</em></li>`).join('')}</ol>`
      : ''}
    ${renderTaskResult(task)}
    <details class="task-technical">
      <summary>작업 세부정보</summary>
      <dl>
        <div><dt>작업 ID</dt><dd>${escapeHtml(task.taskId)}</dd></div>
        <div><dt>동작</dt><dd>${escapeHtml(task.actionType ?? task.plan?.action?.actionType ?? '계획')}</dd></div>
        <div><dt>도구</dt><dd>${escapeHtml(practicalToolLabel(task.toolName ?? task.plan?.action?.toolName ?? '라우터'))}</dd></div>
      </dl>
    </details>
  </div>`;
}

function renderRememberedFile(metadata) {
  const path = metadata?.workReference?.path;
  if (!path) return '';
  return `<p class="task-result-path">이어서 사용할 파일: ${escapeHtml(path)}</p>`;
}

function renderMissionTimeline(mission) {
  if (!mission) {
    return `<div class="task-focus mission-focus empty"><strong>새 목표를 기다리고 있습니다</strong><span>완료할 내용을 입력하면 계획부터 검증까지 이어서 진행합니다.</span></div>`;
  }
  const pendingGates = mission.status === 'WAITING_APPROVAL'
    ? mission.pendingGates ?? (mission.gates ?? []).filter((gate) => gate.status === 'pending')
    : [];
  const recentActions = (mission.waves ?? [])
    .flatMap((wave) => wave.actions ?? [])
    .slice(-6)
    .reverse();
  const metrics = mission.metrics ?? {};
  const gate = pendingGates[0] ?? null;
  const verificationView = missionVerificationView(mission);
  const canCancel = !['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(mission.status);
  const revisionPending = mission.goalRevisionRequest?.state === 'pending';
  const revisionBlocked = revisionPending || mission.goalRevisionConflicts?.length
    || mission.goalContract?.revisionChange?.invalidatedCriterionIds?.length;
  const canResume = mission.status === 'PAUSED' && !revisionBlocked;
  const canRevise = mission.status !== 'CANCELLED';
  return `<div class="task-focus mission-focus ${liveStatusClass(mission.status)}">
    <header>
      <div><span>다단계 목표</span><strong>${escapeHtml(mission.objective ?? '목표 실행')}</strong></div>
      <b>${escapeHtml(verificationView.label ?? practicalStatusLabel(mission.status))}</b>
    </header>
    ${renderRememberedFile(mission.metadata)}
    <dl>
      <div><dt>실행된 작업</dt><dd>${metrics.successfulActions ?? 0} / ${metrics.plannedActions ?? 0}</dd></div>
      <div><dt>완료 기준 검사</dt><dd>${verificationView.verifiedCount} / ${verificationView.totalCount}</dd></div>
      <div><dt>진행 단계</dt><dd>${mission.waveCount ?? mission.waves?.length ?? 0}</dd></div>
      <div><dt>확인 대기</dt><dd>${pendingGates.length}</dd></div>
    </dl>
    ${verificationView.criteria.length ? `<ul class="mission-criteria" aria-label="요구사항 검증">${verificationView.criteria.map((criterion) => `<li><strong>${escapeHtml(criterion.label)}</strong> ${escapeHtml(criterion.statement)}</li>`).join('')}</ul>` : ''}
    ${verificationView.goalBlocked ? `<div role="status" class="mission-outcome"><p>명령에 포함된 단계가 모두 확인되지 않았습니다.</p><ul class="mission-criteria" aria-label="원문 단계 확인">${verificationView.goalRequirements.map(item => `<li><strong>${escapeHtml(item.label)}</strong> ${escapeHtml(item.text)}</li>`).join('')}</ul></div>` : ''}
    ${verificationView.legacy ? '<p class="mission-outcome">이전 검증 기준으로 완료된 기록입니다. 새 요구사항별 검증 결과는 없습니다.</p>' : ''}
    ${recentActions.length
      ? `<ol>${recentActions.map((action) => `<li>
          <span>${escapeHtml(practicalStatusLabel(action.status))}</span>
          <strong>${escapeHtml(practicalTextLabel(action.title ?? action.command ?? '행동'))}</strong>
          <em>${escapeHtml(practicalToolLabel(action.actualToolName ?? action.expectedToolName ?? '계획'))}</em>
        </li>`).join('')}</ol>`
      : `<small role="status">${escapeHtml(missionProgressMessage(mission))}</small>`}
    ${recentActions.length && ['BLOCKED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(mission.status)
      ? `<p role="status">${escapeHtml(missionProgressMessage(mission))}</p>` : ''}
    ${canCancel || canResume || canRevise ? `<div class="mission-controls">
      ${canResume ? `<button type="button" class="accept" data-mission-resume="${escapeHtml(mission.missionId)}" ${controlCenter.commandBusy ? 'disabled' : ''}>계속 실행</button>` : ''}
      ${canCancel ? `<button type="button" data-mission-cancel="${escapeHtml(mission.missionId)}">목표 중단</button>` : ''}
      ${canRevise ? `<button type="button" data-goal-revision-open="${escapeHtml(mission.missionId)}">목표 수정</button>` : ''}
    </div>` : ''}
    ${renderGoalRevisionEditor(mission)}
    ${cancellationReviewPanel.render(mission)}
    ${missionDependencyPanel.render(mission)}
    ${revisionPending ? '<p role="status" class="mission-outcome">현재 실행 결과를 보존한 뒤 수정한 목표를 적용하고 있습니다.</p>' : ''}
    ${mission.goalRevisionRequest?.nextAction ? `<p role="status" class="mission-outcome">${escapeHtml(mission.goalRevisionRequest.nextAction)}</p>` : ''}
    ${gate ? renderMissionGate(mission, gate) : ''}
    <details class="task-technical"><summary>목표 세부정보</summary><dl>
      <div><dt>목표 ID</dt><dd>${escapeHtml(mission.missionId)}</dd></div>
      ${mission.stopReason ? `<div><dt>중단 사유</dt><dd>${escapeHtml(mission.stopReason)}</dd></div>` : ''}
      <div><dt>재계획</dt><dd>${metrics.replans ?? 0}</dd></div>
    </dl></details>
  </div>`;
}

function renderMissionGate(mission, gate) {
  if (gate.type === 'clarification') {
    return `<form class="mission-gate mission-clarification" data-mission-clarification
      data-mission-id="${escapeHtml(mission.missionId)}" data-gate-id="${escapeHtml(gate.gateId)}">
      ${Array.isArray(gate.questions) && gate.questions.length
        ? gate.questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}
            <input name="clarificationAnswer" data-question-index="${index}" maxlength="500" autocomplete="off" required />
          </label>`).join('')
        : `<label>${escapeHtml(gate.question ?? '추가 정보가 필요합니다.')}
            <input name="responseText" autocomplete="off" required />
          </label>`}
      <p>필요한 답변을 한 번에 입력하면 이어서 진행합니다.</p>
      <div>
        <button type="submit" class="accept" ${controlCenter.commandBusy ? 'disabled' : ''}>답변하고 계속</button>
        <button type="button" class="reject" data-mission-gate-decision="reject"
          data-mission-id="${escapeHtml(mission.missionId)}" data-gate-id="${escapeHtml(gate.gateId)}">취소</button>
      </div>
    </form>`;
  }
  const affectedDetails = renderMissionGateAffectedDetails(gate);
  return `<section class="mission-gate">
    <div><span>승인 필요</span><strong>${escapeHtml(practicalTextLabel(gate.title ?? gate.command ?? '다음 행동'))}</strong>
      <em>${escapeHtml(practicalToolLabel(gate.toolName ?? gate.executionClass ?? '고영향 작업'))}</em>
      ${affectedDetails}</div>
    <menu>
      <button type="button" class="accept" data-mission-gate-decision="approve"
        data-mission-id="${escapeHtml(mission.missionId)}" data-gate-id="${escapeHtml(gate.gateId)}">승인</button>
      <button type="button" class="reject" data-mission-gate-decision="reject"
        data-mission-id="${escapeHtml(mission.missionId)}" data-gate-id="${escapeHtml(gate.gateId)}">거절</button>
    </menu>
  </section>`;
}

function renderMissionGateAffectedDetails(gate) {
  if (gate?.type === 'external_data_egress') {
    const classLabels = { D0: '일반', D1: '내부', D2: '개인정보 포함 가능', D3: '민감정보', D4: '고민감 정보' };
    const ministryLabels = { M0: '일반', M1: '내부', M2: '개인정보 포함 가능', M3: '민감정보', M4: '고민감 정보' };
    const contentHash = typeof gate.contentSha256 === 'string' ? gate.contentSha256.slice(0, 16) : '확인 불가';
    return `<dl class="mission-gate-details">
      <div><dt>전송 대상</dt><dd>${escapeHtml(gate.providerId ?? '알 수 없음')}</dd></div>
      <div><dt>요청 도구</dt><dd>${escapeHtml(gate.toolName ?? '알 수 없음')}</dd></div>
      <div><dt>자료 등급</dt><dd>${escapeHtml(classLabels[gate.dataClass] ?? '분류 미확인')}${gate.ministryDataClass ? ` · ${escapeHtml(ministryLabels[gate.ministryDataClass] ?? '분류 미확인')}` : ''}</dd></div>
      <div><dt>전송 자료 식별값</dt><dd>SHA-256 ${escapeHtml(contentHash)}…</dd></div>
      <div><dt>승인 만료</dt><dd>${escapeHtml(gate.expiresAt ?? '알 수 없음')}</dd></div>
    </dl>`;
  }
  const item = gate?.affectedItems?.[0];
  if (!item || item.type !== 'external_transfer') return '';
  const recipient = item.recipientMode === 'self' || item.recipient === 'self' || item.recipient === 'self-or-unspecified'
    ? '내 구글 메일 연결 계정'
    : item.recipient && item.recipient !== 'unspecified' ? item.recipient : '승인 후 수신자 확인';
  const attachment = item.attachmentRef?.relativePath ?? item.attachmentQuery ?? '첨부 없음';
  const subject = item.subject ?? 'JARVIS 작업 결과';
  const integrity = /^[a-f0-9]{64}$/iu.test(String(item.attachmentSha256 ?? ''))
    ? 'SHA-256 확인됨'
    : '무결성 확인 필요';
  return `<dl class="mission-gate-details" aria-label="전송 내용">
    <div><dt>받는 사람</dt><dd>${escapeHtml(recipient)}</dd></div>
    <div><dt>제목</dt><dd>${escapeHtml(subject)}</dd></div>
    <div><dt>첨부</dt><dd title="${escapeHtml(attachment)}">${escapeHtml(attachment)}</dd></div>
    <div><dt>무결성</dt><dd>${escapeHtml(integrity)}</dd></div>
  </dl><small class="mission-gate-notice">승인하면 현재 확인된 상태의 위 파일 한 개를 한 번만 전송합니다.</small>`;
}

function taskExecutionResult(task) {
  const envelope = task?.executionResult;
  return envelope?.executionResult ?? envelope ?? null;
}

function taskResultItemLabel(item) {
  if (typeof item === 'string') return item;
  return item?.name ?? item?.path ?? item?.to ?? item?.from ?? item?.label ?? '결과 항목';
}

function taskResultItemMeta(item, fallback) {
  if (!item || typeof item === 'string') return fallback;
  const type = String(item.type ?? item.changeType ?? fallback).toLowerCase();
  const parts = [{
    file: '파일',
    directory: '폴더',
    create_file: '파일 생성',
    overwrite_file: '파일 수정',
    move_file: '파일 이동',
    copy_file: '파일 복사'
  }[type] ?? type.replaceAll('_', ' ')];
  if (Number.isFinite(Number(item.size))) parts.push(formatResultSize(Number(item.size)));
  return parts.filter(Boolean).join(' · ');
}

function isInternalListArtifact(item) {
  return /^ag-smoke-output-/i.test(String(taskResultItemLabel(item)));
}

function formatResultSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function executionDurationLabel(result) {
  const startedAt = Date.parse(result?.startedAt ?? '');
  const finishedAt = Date.parse(result?.finishedAt ?? '');
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return null;
  const elapsedMs = finishedAt - startedAt;
  return elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}초`;
}

function renderTaskResult(task) {
  const result = taskExecutionResult(task);
  if (!result) return '';

  const outputPaths = Array.isArray(result.outputPaths) ? result.outputPaths : [];
  const changedItems = Array.isArray(result.changedItems) ? result.changedItems : [];
  const listedItems = Array.isArray(result.listedItems)
    ? [...result.listedItems].sort((left, right) => Date.parse(right?.modifiedAt ?? '') - Date.parse(left?.modifiedAt ?? ''))
    : [];
  const userFacingListedItems = listedItems.filter((item) => !isInternalListArtifact(item));
  const listedItemsForDisplay = userFacingListedItems.length ? userFacingListedItems : listedItems;
  const directory = task.executionResult?.shadow?.directory ?? result.directory ?? null;
  const visibleItems = outputPaths.length
    ? outputPaths.slice(0, 8).map((item) => ({ value: item, meta: '산출물' }))
    : changedItems.length
      ? changedItems.slice(0, 8).map((item) => ({ value: taskResultItemLabel(item), meta: taskResultItemMeta(item, '변경') }))
      : listedItemsForDisplay.slice(0, 10).map((item) => ({ value: taskResultItemLabel(item), meta: taskResultItemMeta(item, '항목') }));
  const totalItems = outputPaths.length || changedItems.length || listedItems.length;
  const summary = result.summary
    ?? (listedItems.length
      ? `${listedItems.length}개 항목을 확인했습니다. 사용자 파일을 우선 표시합니다.`
      : outputPaths.length
        ? `${outputPaths.length}개 산출물이 준비되었습니다.`
        : changedItems.length
          ? `${changedItems.length}개 항목이 변경되었습니다.`
          : String(result.status ?? '').toLowerCase() === 'success'
            ? '작업이 정상적으로 완료되었습니다.'
            : '작업 결과를 확인해 주세요.');
  const verification = task.executionVerification;
  const verificationLabel = verification
    ? `검증 ${escapeHtml(verificationStatusLabel(verification.status))} · ${escapeHtml(verification.score ?? '-')}점`
    : '검증 정보 없음';
  const duration = executionDurationLabel(result);
  const resultCountLabel = listedItems.length
    ? `사용자 파일 ${userFacingListedItems.length}개 · 전체 ${listedItems.length}개`
    : totalItems > visibleItems.length
      ? `최근 ${visibleItems.length}개 표시 · 전체 ${totalItems}개`
      : `${totalItems}개 결과`;

  return `<section class="task-result ${liveStatusClass(result.status)}" aria-label="실제 실행 결과">
    <header>
      <div><span>실제 실행 결과</span><strong>${escapeHtml(summary)}</strong></div>
      <b>${verificationLabel}</b>
    </header>
    ${directory ? `<code class="task-result-path">${escapeHtml(directory)}</code>` : ''}
    ${visibleItems.length
      ? `<ul>${visibleItems.map((item) => `<li><strong>${escapeHtml(item.value)}</strong><span>${escapeHtml(item.meta)}</span></li>`).join('')}</ul>`
      : `<p>${escapeHtml(taskEmptyResultMessage(result,task))}</p>`}
    ${renderNativeRecovery(result)}
    <footer>
      <span>${escapeHtml(practicalToolLabel(result.executedBy?.toolName ?? task.toolName ?? '핵심 엔진'))}</span>
      <span>${resultCountLabel}</span>
      ${duration ? `<span>${escapeHtml(duration)}</span>` : ''}
    </footer>
    ${renderTaskRollback(task, result)}
  </section>`;
}

function taskSupportsRollback(task, result) {
  const status = String(task?.status ?? '').toUpperCase();
  const actionType = String(task?.actionType ?? task?.plan?.action?.actionType ?? '').toUpperCase();
  const readOnlyAction = /^(LIST|SEARCH|READ|GET|CAPABILITY_QUERY)/.test(actionType);
  return status === 'COMPLETED' && result?.rollbackAvailable === true && !readOnlyAction;
}

function renderTaskRollback(task, result) {
  const status = String(task?.status ?? '').toUpperCase();
  const proof = task?.compensationReplay?.rollbackProof ?? null;
  if (status === 'COMPENSATED') {
    const restored = proof?.rolledBack?.length ?? proof?.transaction?.rolledBackCount ?? 0;
    return `<section class="task-rollback completed" aria-label="되돌리기 완료">
      <div><span>복구 증명</span><strong>변경을 원래 상태로 되돌렸습니다.</strong><em>${restored}개 변경 · 무결성 ${escapeHtml(proof?.plan?.chain?.status ?? '검증됨')}</em></div>
    </section>`;
  }
  if (!taskSupportsRollback(task, result)) return '';

  const flow = controlCenter.rollbackFlow.taskId === task.taskId
    ? controlCenter.rollbackFlow
    : { status: 'idle', plan: null, error: null };
  if (flow.status === 'checking') {
    return `<section class="task-rollback checking" aria-live="polite"><div><span>되돌리기 점검</span><strong>현재 파일 상태와 복구 기록을 확인하고 있습니다.</strong></div></section>`;
  }
  if (flow.status === 'executing') {
    return `<section class="task-rollback checking" aria-live="polite"><div><span>되돌리는 중</span><strong>복구 후 파일 상태를 다시 검증하고 있습니다.</strong></div></section>`;
  }
  if (flow.status === 'preview') {
    const blocked = Number(flow.plan?.blockedCount ?? 0);
    const ready = Number(flow.plan?.readyCount ?? 0);
    const noop = Number(flow.plan?.noopCount ?? 0);
    return `<section class="task-rollback ${blocked ? 'blocked' : 'confirm'}" aria-label="되돌리기 확인">
      <div>
        <span>되돌리기 확인</span>
        <strong>${blocked ? '자동으로 안전하게 되돌릴 수 없는 변경이 있습니다.' : `${ready}개 변경을 실행 전 상태로 되돌립니다.`}</strong>
        <em>복구 ${ready}개 · 변경 없음 ${noop}개 · 차단 ${blocked}개 · 기록 무결성 ${escapeHtml(flow.plan?.chain?.status ?? '확인')}</em>
      </div>
      <menu>
        <button type="button" class="accept" data-task-rollback-confirm="${escapeHtml(task.taskId)}" ${blocked ? 'disabled' : ''}>확인하고 되돌리기</button>
        <button type="button" class="reject" data-task-rollback-cancel="${escapeHtml(task.taskId)}">취소</button>
      </menu>
    </section>`;
  }
  if (flow.status === 'error') {
    return `<section class="task-rollback error" role="alert">
      <div><span>되돌리기 확인 필요</span><strong>${escapeHtml(flow.error)}</strong></div>
      <button type="button" data-task-rollback-preview="${escapeHtml(task.taskId)}">다시 점검</button>
    </section>`;
  }
  return `<div class="task-result-actions"><button type="button" data-task-rollback-preview="${escapeHtml(task.taskId)}">되돌리기</button></div>`;
}

function verificationStatusLabel(status) {
  return {
    passed: '통과',
    failed: '실패',
    blocked: '차단',
    warning: '주의'
  }[String(status ?? '').toLowerCase()] ?? String(status ?? '완료');
}

function missionChildTaskIds(mission = controlCenter.activeMission) {
  return new Set((mission?.waves ?? []).flatMap((wave) => (
    (wave.actions ?? []).map((action) => action.taskId).filter(Boolean)
  )));
}

function renderTaskList({ excludeTaskIds = new Set() } = {}) {
  const tasks = controlCenter.coreTasks.filter((task) => !excludeTaskIds.has(task.taskId)).slice(-5).reverse();
  if (!tasks.length) return '<div class="compact-empty">아직 실행한 작업이 없습니다.</div>';
  return `<ul class="live-task-list">${tasks.map((task) => `<li>
    <span>${escapeHtml(practicalStatusLabel(task.status))}</span>
    <button type="button" data-open-task="${escapeHtml(task.taskId)}">${escapeHtml(task.title ?? task.taskId)}</button>
    <em>${escapeHtml(taskImpactLabel(task))}</em>
  </li>`).join('')}</ul>`;
}

function renderActivityFeed() {
  return `<ul class="activity-feed">${controlCenter.activity
    .map((item) => `<li class="${escapeHtml(item.tone)}"><time>${formatShortTime(item.at)}</time><strong>${escapeHtml(activitySourceLabel(item.source))}</strong><span>${escapeHtml(item.message)}</span></li>`)
    .join('')}</ul>`;
}

function activitySourceLabel(source) {
  return {
    daemon: '작업자',
    command: '명령',
    core: '핵심 엔진',
    approval: '승인',
    queue: '대기열',
    error: '오류',
    settings: '설정'
  }[source] ?? source;
}

function activeQueueCount(queue) {
  const activeStatuses = new Set(['queued', 'running', 'leased', 'retry_scheduled', 'retrying', 'pending']);
  return (queue?.items ?? []).filter((item) => activeStatuses.has(String(item.status ?? '').toLowerCase())).length;
}

function isApprovalPending(task) {
  return String(task?.status ?? '').toUpperCase() === 'WAITING_APPROVAL';
}

function practicalStatusLabel(status) {
  return {
    CREATED: '등록됨',
    PLANNING: '계획 중',
    PAUSED: '일시 중지',
    PLANNED: '계획됨',
    WAITING_APPROVAL: '승인 대기',
    WAITING_INPUT: '추가 입력 대기',
    APPROVED: '승인됨',
    QUEUED: '실행 대기',
    RUNNING: '실행 중',
    EXECUTING: '실행 중',
    VERIFYING: '검증 중',
    COMPLETED: '완료',
    SUCCEEDED: '완료',
    SUCCESS: '완료',
    SKIPPED: '건너뜀',
    FAILED: '실패',
    BLOCKED: '차단',
    REJECTED: '거절됨',
    CANCELLED: '취소됨',
    EXPIRED: '만료됨',
    COMPENSATING: '복구 중',
    COMPENSATED: '복구됨'
  }[String(status ?? '').toUpperCase()] ?? String(status ?? '대기');
}

function practicalToolLabel(toolName) {
  const raw = String(toolName ?? '').trim();
  return {
    'browser.search': '웹 검색',
    'capability.describe': '기능 조회',
    'desktop.control': '화면 제어',
    'document.edit': '문서 편집',
    'email.send': '메일 발송',
    'excel.createWorkbook': '엑셀 문서 생성',
    'filesystem.createTextFile': '텍스트 파일 생성',
    'filesystem.listFiles': '파일 목록 확인',
    'filesystem.moveFiles': '파일 이동',
    'filesystem.previewMoveFiles': '파일 이동 미리보기',
    'filesystem.searchFiles': '파일 검색',
    'hwp.create': '한글 문서 생성',
    'macro.save': '매크로 저장',
    'powerpoint.create': '프레젠테이션 생성',
    'shell.execute': '시스템 명령 실행',
    'weather.createHwpReport': '주간 날씨 한글 보고서 생성',
    'word.create': '워드 문서 생성',
    external_commit: '외부 전송 작업',
    irreversible_commit: '되돌릴 수 없는 작업',
    local_reversible: '되돌릴 수 있는 로컬 작업',
    read_only: '읽기 전용 작업'
  }[raw] ?? raw;
}

function practicalTextLabel(value) {
  return String(value ?? '')
    .replaceAll('Gmail', '구글 메일')
    .replaceAll('Google 메일', '구글 메일');
}

function renderAttentionQueue({ excludeTaskId = null, excludeTaskIds = new Set() } = {}) {
  const reviewTasks = controlCenter.coreTasks
    .filter((task) => task.taskId !== excludeTaskId
      && !excludeTaskIds.has(task.taskId)
      && (isApprovalPending(task) || ['FAILED', 'BLOCKED'].includes(String(task.status ?? '').toUpperCase())))
    .slice(-6)
    .reverse();
  if (!reviewTasks.length) {
    return `<div class="compact-empty">추가로 확인할 작업이 없습니다.</div>`;
  }
  return `<div class="attention-list">${reviewTasks.map((task) => `<article class="${liveStatusClass(task.status)}">
    <div>
      <span>${escapeHtml(practicalStatusLabel(task.status))}</span>
      <strong>${escapeHtml(task.title ?? task.taskId)}</strong>
      <em>${escapeHtml(practicalToolLabel(task.toolName ?? task.actionType ?? '작업'))} · 위험 ${escapeHtml(task.riskTier ?? '미정')}</em>
    </div>
    ${isApprovalPending(task)
      ? `<menu>
          <button type="button" class="accept" data-task-decision="approve" data-task-id="${escapeHtml(task.taskId)}">승인</button>
          <button type="button" class="reject" data-task-decision="reject" data-task-id="${escapeHtml(task.taskId)}">거절</button>
        </menu>`
      : `<button type="button" class="task-detail-button" data-open-task="${escapeHtml(task.taskId)}">상세</button>`}
  </article>`).join('')}</div>`;
}

function renderReleaseState() {
  const release = controlCenter.releaseStatus;
  if (!release) {
    return `<div class="practical-empty"><strong>릴리스 상태 확인 중</strong><span>최종 게이트 보고서를 불러오고 있습니다.</span></div>`;
  }
  const pending = release.pendingValidation ?? [];
  const passed = release.status === 'passed' || release.status === 'release-ready';
  return `<div class="release-state ${passed ? 'ok' : 'warn'}">
    <header>
      <div><span>현재 제품 상태</span><strong>${passed ? '실사용 준비 완료' : `현장 검증 ${pending.length}건 남음`}</strong></div>
      <em>${escapeHtml(releaseStatusLabel(release.status))}</em>
    </header>
    ${pending.length
      ? `<ul>${pending.map((item) => `<li><strong>${escapeHtml(releaseValidationTitle(item))}</strong><span>${escapeHtml(releaseValidationAction(item))}</span></li>`).join('')}</ul>`
      : '<p>최종 릴리스 게이트를 통과했습니다.</p>'}
  </div>`;
}

function llmProviderLabel(provider) {
  return {
    'anthropic-api': 'Anthropic API',
    'openai-api': 'OpenAI API',
    'claude-cli': 'Claude CLI'
  }[provider] ?? 'AI 공급자';
}

function llmOperationalView(status) {
  return {
    passed: {
      tone: 'ok',
      title: 'AI 응답 준비 완료',
      description: '실제 공급자 호출이 검증되었습니다.'
    },
    'ready-unverified': {
      tone: 'warn',
      title: 'AI 실호출 확인 필요',
      description: '공급자는 감지되었지만 현재 세션의 응답은 아직 검증되지 않았습니다.'
    },
    running: {
      tone: 'warn',
      title: 'AI 응답 확인 중',
      description: '공급자 실호출 진단이 진행 중입니다.'
    },
    'blocked-authentication': {
      tone: 'down',
      title: 'Claude 로그인 필요',
      description: '로컬 명령은 유지되며 AI 해석과 초안 기능은 로그인 전까지 제한됩니다.'
    },
    blocked: {
      tone: 'down',
      title: 'AI 공급자 설정 필요',
      description: '사용 가능한 API 키나 Claude CLI 세션이 없습니다.'
    },
    failed: {
      tone: 'down',
      title: 'AI 공급자 점검 필요',
      description: '최근 실호출 진단이 완료되지 않았습니다.'
    },
    'not-generated': {
      tone: 'warn',
      title: 'AI 진단 필요',
      description: '아직 공급자 진단 보고서가 생성되지 않았습니다.'
    }
  }[status] ?? {
    tone: 'warn',
    title: 'AI 상태 확인 필요',
    description: '공급자 상태를 다시 확인해 주세요.'
  };
}

function renderLlmOperationalState() {
  const diagnostic = controlCenter.llmStatus;
  const view = llmOperationalView(diagnostic?.status ?? 'not-generated');
  const provider = diagnostic?.effectiveProvider ?? diagnostic?.providerOrder?.[0] ?? null;
  const command = diagnostic?.recovery?.command ?? null;
  return `<div class="llm-operation-state ${view.tone}">
    <div>
      <span>AI 응답 엔진${provider ? ` · ${escapeHtml(llmProviderLabel(provider))}` : ''}</span>
      <strong>${escapeHtml(view.title)}</strong>
      <em>${escapeHtml(view.description)}</em>
    </div>
    ${command ? `<code title="터미널에서 실행">${escapeHtml(command)}</code>` : '<small>실호출 검증 완료</small>'}
  </div>`;
}

function releaseStatusLabel(status) {
  return {
    'blocked-field-validation': '현장 검증 대기',
    passed: '통과',
    'release-ready': '출시 준비 완료'
  }[String(status ?? '').toLowerCase()] ?? String(status ?? '확인 중');
}

function releaseValidationTitle(item) {
  const command = String(item?.command ?? '');
  if (command.includes('wearable:')) return 'AI 안경 화면·음성·연결 현장 확인';
  if (command.includes('mobile:live-bridge-e2e')) return '모바일-브리지 실연결 검증';
  if (command.includes('mobile:device')) return 'Android 실기기 기본 검증';
  return '외부 환경 현장 검증';
}

function releaseValidationAction(item) {
  const command = String(item?.command ?? '');
  if (command.includes('wearable:')) return '실제 안경에서 화면 표시, 음성 입력, 로컬 연결을 확인해야 합니다.';
  if (command.includes('mobile:live-bridge-e2e')) return '휴대폰과 PC 사이의 실제 연결을 다시 확인해야 합니다.';
  if (command.includes('mobile:device')) return '설치된 Android 앱의 시작과 기본 동작을 확인해야 합니다.';
  return '대상 환경에서 최종 동작을 확인해야 합니다.';
}

function renderSupportDiagnostic() {
  const diagnostic = controlCenter.supportDiagnostic;
  const failure = controlCenter.supportFailure;
  if (failure) return `<section class="support-diagnostic down" aria-labelledby="support-failure-title">
    <h3 id="support-failure-title">자동 진단을 완료하지 못했습니다</h3>
    <p role="status">${escapeHtml(failure.summary)}</p><p>${escapeHtml(failure.nextAction)}</p>
    <details><summary>진단 정보</summary><p>${escapeHtml(failure.code)} · ${escapeHtml(failure.component)}</p>
      <p>${escapeHtml(failure.endpoint)}</p><p>확인 시각 ${escapeHtml(failure.checkedAt)}</p>
      <p>${controlCenter.supportLastSuccessAt ? `마지막 정상 조회 ${escapeHtml(controlCenter.supportLastSuccessAt)}` : '아직 정상 진단 결과가 없습니다.'} · 조회만 다시 시도합니다.</p>
    </details>
    <button type="button" data-run-support-diagnostic ${controlCenter.supportBusy ? 'disabled' : ''}>${controlCenter.supportBusy ? '진단 중' : '다시 진단'}</button>
  </section>`;
  const runtimeReady = diagnostic?.runtime?.status === 'ready';
  const paidReady = diagnostic?.readiness?.paidDistributionReady === true;
  const personalReady = diagnostic?.readiness?.personalLocalUseReady === true;
  const issues = diagnostic?.issues ?? [];
  return `<div class="support-diagnostic ${diagnostic ? (runtimeReady ? 'ok' : 'down') : 'pending'}">
    <header>
      <div>
        <span>고객 지원 진단</span>
        <strong>${diagnostic
          ? runtimeReady
            ? `실행 서비스 ${diagnostic.runtime.healthyCount}/${diagnostic.runtime.serviceCount} 정상`
            : '실행 서비스 확인 필요'
          : '진단 실행 전'}</strong>
        ${diagnostic ? `<small>${paidReady ? '유료 배포 검증 완료' : personalReady ? `개인 로컬 사용 준비 · 배포 확인 ${issues.length}건` : `확인 ${issues.length}건 · 지원 ID ${escapeHtml(diagnostic.supportId)}`}</small>` : ''}
      </div>
      <menu class="diagnostic-actions">
        <button type="button" data-run-support-diagnostic ${controlCenter.supportBusy ? 'disabled' : ''}>${controlCenter.supportBusy ? '진단 중' : '자동 진단'}</button>
        <a href="${escapeHtml(localControlUrl('/api/local/support-bundle?download=1'))}" download="jarvis-support-bundle.json">진단 파일</a>
      </menu>
    </header>
    ${issues.length > 0 ? `<ul>${issues.slice(0, 3).map((issue) => `<li>${escapeHtml(issue.message)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function assistantAvailability() {
  const coreStatus = controlCenter.coreHealth?.status ?? (controlCenter.lastRefreshAt ? 'offline' : 'checking');
  const pcStatus = controlCenter.pcHealth?.status ?? (controlCenter.lastRefreshAt ? 'offline' : 'checking');
  const trust = effectiveRuntimeTrust();
  if (trust?.mode === 'lockdown') {
    return { tone: 'down', label: '긴급 잠금', detail: '변경 작업이 차단되었습니다. 진단에서 복구를 진행하세요' };
  }
  if (trust?.mode === 'guarded') {
    return { tone: 'warn', label: '보호 모드', detail: '고위험·외부 전송 작업을 일시 차단하고 있습니다' };
  }
  if (controlCenter.commandBusy) {
    return { tone: 'working', label: '작업 중', detail: '요청을 처리하고 있습니다' };
  }
  if (controlCenter.lastError) {
    return { tone: 'down', label: '확인 필요', detail: controlCenter.lastError };
  }
  if (liveStatusClass(coreStatus) === 'ok' && liveStatusClass(pcStatus) === 'ok') {
    return { tone: 'ok', label: '준비됨', detail: '로컬 PC 작업 실행 가능' };
  }
  if (liveStatusClass(coreStatus) === 'ok') {
    return { tone: 'warn', label: '부분 준비', detail: 'PC 연결을 확인해 주세요' };
  }
  if (!controlCenter.lastRefreshAt) {
    return { tone: 'checking', label: '연결 확인 중', detail: '실행 환경을 준비하고 있습니다' };
  }
  return { tone: 'down', label: '연결 필요', detail: '핵심 엔진 서비스를 확인해 주세요' };
}

function effectiveRuntimeTrust() {
  return controlCenter.runtimeTrust ?? controlCenter.coreHealth?.trust ?? null;
}

function runtimeTrustView(trust = effectiveRuntimeTrust()) {
  const mode = trust?.mode ?? 'unavailable';
  return {
    mode,
    tone: mode === 'trusted' ? 'ok' : mode === 'guarded' ? 'warn' : 'down',
    label: mode === 'trusted' ? '정상 보호' : mode === 'guarded' ? '제한 보호' : mode === 'lockdown' ? '긴급 잠금' : '상태 확인 필요',
    detail: mode === 'trusted'
      ? '서명 상태와 감사 기록이 정상입니다'
      : mode === 'guarded'
        ? '위험 신호를 감지해 고위험 작업을 제한합니다'
        : mode === 'lockdown'
          ? '모든 변경 작업과 연속 권한을 차단했습니다'
          : '신뢰 커널에 연결할 수 없습니다'
  };
}

function trustReasonLabel(code) {
  return {
    A_TRUST_MANUAL_LOCKDOWN: '사용자가 긴급 잠금을 실행함',
    A_TRUST_STATE_SIGNATURE_INVALID: '저장된 신뢰 상태의 서명이 일치하지 않음',
    A_TRUST_AUDIT_CHAIN_INVALID: '보안 감사 기록의 연결 무결성이 깨짐',
    E_CAPABILITY_TOKEN_SIGNATURE_INVALID: '실행 권한 서명이 유효하지 않음',
    E_TOOL_OUTPUT_PROVENANCE_TAINTED: '신뢰할 수 없는 도구 출력이 감지됨'
  }[code] ?? String(code ?? '위험 신호 없음').replaceAll('_', ' ');
}

function runtimeTrustIncidentView(trust = effectiveRuntimeTrust()) {
  const incident = trust?.activeIncident ?? null;
  const activeReason = trust?.reasonCodes?.[0]
    ?? (incident && incident.status !== 'recovered' ? incident.reasonCode : null);
  if (activeReason) {
    return {
      tone: 'active',
      heading: '감지 사유',
      detail: trustReasonLabel(activeReason)
    };
  }
  if (incident?.status === 'recovered' && incident.reasonCode) {
    const recoveredAt = formatShortTime(incident.recoveredAt);
    return {
      tone: 'recovered',
      heading: '최근 복구',
      detail: `${trustReasonLabel(incident.reasonCode)} · ${recoveredAt} 복구 완료`
    };
  }
  return null;
}

async function runRuntimeTrustGate() {
  if (controlCenter.trustBusy) return;
  controlCenter.trustBusy = true;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest('/security/trust/product-gate', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      body: { requestedBy: 'local-control-center' },
      timeoutMs: 12_000
    });
    controlCenter.trustGateResult = result;
    clearOperationalError('runtime-trust');
    pushActivity('실행 보호', result.status === 'passed' ? '공격 방어 점검 통과' : '공격 방어 점검 확인 필요', result.status === 'passed' ? 'ok' : 'warn');
  } catch (error) {
    recordOperationalError(error, { action: '공격 방어 점검', source: 'runtime-trust' });
  } finally {
    controlCenter.trustBusy = false;
    await refreshLiveState({ silent: true });
  }
}

async function armOrEngageRuntimeLockdown() {
  if (controlCenter.trustBusy || effectiveRuntimeTrust()?.mode === 'lockdown') return;
  const now = Date.now();
  if (controlCenter.trustLockArmedUntil <= now) {
    controlCenter.trustLockArmedUntil = now + 8_000;
    pushActivity('실행 보호', '긴급 잠금 확인 대기', 'warn');
    render({ preserveScroll: true });
    setTimeout(() => {
      if (controlCenter.trustLockArmedUntil <= Date.now()) {
        controlCenter.trustLockArmedUntil = 0;
        render({ preserveScroll: true });
      }
    }, 8_100);
    return;
  }
  controlCenter.trustBusy = true;
  controlCenter.trustLockArmedUntil = 0;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest('/security/trust/lockdown', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      body: { reason: 'operator-emergency-lockdown', requestedBy: 'local-control-center' }
    });
    controlCenter.runtimeTrust = result.trust ?? result;
    controlCenter.ownerSession = null;
    controlCenter.trustRecoveryChallenge = null;
    controlCenter.trustRecoveryPhrase = '';
    clearOperationalError('runtime-trust');
    pushActivity('실행 보호', '긴급 잠금 활성화 · 변경 작업 차단', 'down');
  } catch (error) {
    recordOperationalError(error, { action: '긴급 잠금', source: 'runtime-trust' });
  } finally {
    controlCenter.trustBusy = false;
    await refreshLiveState({ silent: true });
  }
}

async function beginRuntimeTrustRecovery() {
  if (controlCenter.trustBusy || effectiveRuntimeTrust()?.mode !== 'lockdown') return;
  controlCenter.trustBusy = true;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest('/security/trust/recovery/challenge', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      body: { requestedBy: 'local-control-center' }
    });
    controlCenter.trustRecoveryChallenge = result;
    controlCenter.trustRecoveryPhrase = '';
    clearOperationalError('runtime-trust');
    pushActivity('실행 보호', '일회성 복구 점검 준비 완료', 'warn');
  } catch (error) {
    recordOperationalError(error, { action: '복구 점검 준비', source: 'runtime-trust' });
  } finally {
    controlCenter.trustBusy = false;
    render({ preserveScroll: true });
  }
}

async function completeRuntimeTrustRecovery() {
  const challenge = controlCenter.trustRecoveryChallenge?.challenge;
  if (controlCenter.trustBusy || !challenge) return;
  if (controlCenter.trustRecoveryPhrase.trim() !== '복구 승인') {
    recordOperationalError(new Error('복구 승인 문구를 정확히 입력해 주세요.'), {
      action: '보호 복구',
      source: 'runtime-trust'
    });
    render({ preserveScroll: true });
    return;
  }
  controlCenter.trustBusy = true;
  render({ preserveScroll: true });
  try {
    const result = await coreRequest('/security/trust/recover', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      body: {
        challenge,
        recoveredBy: 'local-control-center',
        reason: 'operator-confirmed-after-integrity-checks'
      },
      timeoutMs: 12_000
    });
    controlCenter.runtimeTrust = result.trust ?? result;
    controlCenter.trustRecoveryChallenge = null;
    controlCenter.trustRecoveryPhrase = '';
    clearOperationalError('runtime-trust');
    pushActivity('실행 보호', '무결성 검사 통과 · 정상 보호 복구', 'ok');
  } catch (error) {
    recordOperationalError(error, { action: '보호 복구', source: 'runtime-trust' });
  } finally {
    controlCenter.trustBusy = false;
    await refreshLiveState({ silent: true });
  }
}

function renderRuntimeTrustPanel() {
  const trust = effectiveRuntimeTrust();
  const view = runtimeTrustView(trust);
  const stateSigned = trust?.integrity?.stateSignatureValid === true;
  const auditValid = trust?.integrity?.auditChainValid === true;
  const pcAligned = !controlCenter.pcRuntimeTrust?.mode || controlCenter.pcRuntimeTrust.mode === trust?.mode;
  const incidentView = runtimeTrustIncidentView(trust);
  const armed = controlCenter.trustLockArmedUntil > Date.now();
  const gatePassed = controlCenter.trustGateResult?.status === 'passed';
  const challengeReady = Boolean(controlCenter.trustRecoveryChallenge?.challenge);
  const requiredChecks = controlCenter.trustRecoveryChallenge?.requiredChecks ?? trust?.recovery?.requiredChecks ?? [];
  return `<div class="runtime-trust-panel ${escapeHtml(view.tone)}" aria-label="실행 보호 상태">
    <header>
      <div><span>실행 보호</span><strong>${escapeHtml(view.label)}</strong><small>${escapeHtml(view.detail)}</small></div>
      <b>${Number.isFinite(trust?.riskScore) ? `위험 ${trust.riskScore}` : '확인 중'}</b>
    </header>
    <div class="trust-integrity" role="list" aria-label="무결성 검사">
      <span class="${stateSigned ? 'pass' : 'fail'}" role="listitem">상태 서명 ${stateSigned ? '정상' : '확인 필요'}</span>
      <span class="${auditValid ? 'pass' : 'fail'}" role="listitem">감사 기록 ${auditValid ? '정상' : '확인 필요'}</span>
      <span class="${pcAligned ? 'pass' : 'fail'}" role="listitem">PC 실행기 ${pcAligned ? '동기화' : '상태 불일치'}</span>
      <span class="${trust?.keyProvider?.protectedByOs ? 'pass' : 'warn'}" role="listitem">보호 키 ${trust?.keyProvider?.protectedByOs ? 'Windows 보호' : '로컬 보호'}</span>
    </div>
    ${incidentView ? `<p class="trust-reason ${escapeHtml(incidentView.tone)}"><strong>${escapeHtml(incidentView.heading)}</strong><span>${escapeHtml(incidentView.detail)}</span></p>` : ''}
    ${challengeReady ? `<div class="trust-recovery">
      <p><strong>복구 전 내부 검사 ${requiredChecks.length}개</strong><span>아래 문구를 입력하면 서명·감사·권한·복구 저널을 다시 확인합니다.</span></p>
      <div><input type="text" data-trust-recovery-phrase value="${escapeHtml(controlCenter.trustRecoveryPhrase)}" placeholder="복구 승인" autocomplete="off" aria-label="복구 승인 문구" /><button type="button" data-trust-recover ${controlCenter.trustBusy ? 'disabled' : ''}>검사 후 복구</button></div>
    </div>` : ''}
    <menu class="trust-actions">
      <button type="button" data-trust-gate ${controlCenter.trustBusy ? 'disabled' : ''}>${controlCenter.trustBusy ? '점검 중' : gatePassed ? '방어 점검 통과' : '공격 방어 점검'}</button>
      ${trust?.mode === 'lockdown'
        ? `<button type="button" class="recover" data-trust-recovery-start ${controlCenter.trustBusy || challengeReady ? 'disabled' : ''}>복구 점검 시작</button>`
        : `<button type="button" class="lockdown ${armed ? 'armed' : ''}" data-trust-lockdown ${controlCenter.trustBusy ? 'disabled' : ''}>${armed ? '긴급 잠금 확정' : '긴급 잠금'}</button>`}
    </menu>
  </div>`;
}

function renderPracticalWorkspace() {
  const availability = assistantAvailability();
  const coreStatus = controlCenter.coreHealth?.status ?? (controlCenter.lastRefreshAt ? 'offline' : 'checking');
  const pcStatus = controlCenter.pcHealth?.status ?? (controlCenter.lastRefreshAt ? 'offline' : 'checking');
  const bridgeStatus = controlCenter.bridgeHealth?.status ?? (controlCenter.lastRefreshAt ? 'offline' : 'checking');
  const daemonStatus = controlCenter.workerDaemon?.status ?? 'offline';
  const pcRuntimeStatus = controlCenter.pcRuntime?.status ?? controlCenter.pcRuntime?.supervisor?.status ?? 'offline';
  const queueTotal = activeQueueCount(controlCenter.workerQueue);
  const pcQueued = activeQueueCount(controlCenter.pcQueue);
  return `<section class="assistant-support" aria-label="JARVIS 진단 및 연결">
    <details class="system-diagnostics" ${controlCenter.diagnosticsOpen || controlCenter.lastError || controlCenter.supportBusy ? 'open' : ''}>
      <summary>
        <div><strong>진단 및 연결</strong><span>문제 확인과 고급 설정</span></div>
        <b class="${escapeHtml(availability.tone)}">${escapeHtml(availability.label)}</b>
      </summary>
      <div class="diagnostic-grid">
        <section class="diagnostic-services" aria-labelledby="services-title">
          <header><h2 id="services-title">실행 서비스</h2><span>${controlCenter.lastRefreshAt ? formatShortTime(controlCenter.lastRefreshAt) : '확인 중'}</span></header>
          <div class="service-grid">
            ${renderServiceCard('핵심 엔진', coreStatus, `가동 ${formatDuration(controlCenter.coreHealth?.metrics?.uptimeMs ?? 0)}`, '로컬')}
            ${renderServiceCard('작업자', daemonStatus, `처리 ${controlCenter.workerDaemon?.processedTotal ?? 0}건`, `대기 ${queueTotal}건`)}
            ${renderServiceCard('PC 실행기', pcStatus, liveStatusText(pcStatus), controlCenter.pcBaseUrl)}
            ${renderServiceCard('PC 서비스', pcRuntimeStatus, `처리 ${controlCenter.pcRuntime?.processedTotal ?? 0}건`, `대기 ${pcQueued}건`)}
            ${renderServiceCard('모바일', bridgeStatus, `등록 ${controlCenter.bridgeHealth?.pairedDevices ?? 0}대`, '브리지')}
          </div>
          ${renderRuntimeTrustPanel()}
        </section>
        <section class="diagnostic-activity" aria-labelledby="activity-title">
          <header><h2 id="activity-title">최근 활동</h2><span>${controlCenter.activity.length}건</span></header>
          ${renderActivityFeed()}
        </section>
        <section class="diagnostic-settings" aria-labelledby="settings-title">
          <header><h2 id="settings-title">고급 설정</h2><span>로컬</span></header>
          <details class="settings-drawer">
            <summary>연결 주소 및 토큰</summary>
            ${renderLiveSettings()}
          </details>
          ${renderServiceUpdatePanel()}
        </section>
        <section class="diagnostic-readiness" aria-labelledby="readiness-title">
          <header><h2 id="readiness-title">검증 상태</h2><span>제품 진단</span></header>
          <nav aria-label="독립 연결 설정"><a href="/src/ui/connections/api.html">API 연결</a> · <a href="/src/ui/connections/agents.html">에이전트 연결</a> · <a href="/src/ui/connections/mcp.html">MCP 연결</a> · <a href="/src/ui/connections/accounts.html">계정 연결</a> · <a href="/src/ui/connections/runtime.html">실행 환경</a></nav>
          <div class="readiness-stack">
            ${renderIntegrationReadiness({ ...controlCenter.integrationReadiness, externalCapabilityEvaluation: controlCenter.externalCapabilityEvaluation, canManageIntegrations: hasCoreAdminAccess(), canSetupProviderCredentials: hasCoreAdminAccess() && isLocalCredentialHandoffAvailable(), providerVerifyBusy: controlCenter.providerVerifyBusy, providerSetupBusy: controlCenter.providerSetupBusy })}
            ${renderReleaseState()}
            ${renderLlmOperationalState()}
            ${renderSupportDiagnostic()}
          </div>
        </section>
      </div>
    </details>
  </section>`;
}

function renderRoutineWorkspace() {
  return `<section class="assistant-routines" aria-label="예약 작업 관리">
    ${renderRoutineControlPanel({ items: controlCenter.routines, status: controlCenter.routinesStatus,
      busy: controlCenter.routinesBusy, error: controlCenter.routinesError, notice: controlCenter.routinesNotice,
      draft: controlCenter.routinesDraft, timezoneDrafts: controlCenter.routineTimezoneDrafts, canManage: hasCoreAdminAccess() })}
  </section>`;
}

function renderLiveTopbar() {
  const availability = assistantAvailability();
  const trust = runtimeTrustView();
  const missionTaskIds = missionChildTaskIds();
  const taskApprovals = controlCenter.coreTasks.filter((task) => isApprovalPending(task) && !missionTaskIds.has(task.taskId)).length;
  const missionApprovals = (controlCenter.activeMission?.pendingGates ?? []).length;
  const pendingApprovals = taskApprovals + missionApprovals;
  return `<nav class="topbar practical-topbar" aria-label="JARVIS 상태">
    <strong class="assistant-brand">JARVIS<span>로컬 AI 비서</span></strong>
    <div class="assistant-availability ${escapeHtml(availability.tone)}"><i></i><div><strong>${escapeHtml(availability.label)}</strong><span>${escapeHtml(availability.detail)}</span></div></div>
    <div class="system">
      ${pendingApprovals ? `<span class="warn">승인 ${pendingApprovals}건</span>` : ''}
      <span class="trust-state ${escapeHtml(trust.tone)}">${escapeHtml(trust.label)}</span>
      <a class="skill-center-entry" href="./src/ui/skill-center/index.html">스킬 센터</a>
      <button type="button" data-refresh-live aria-label="상태 새로고침" ${controlCenter.refreshing ? 'disabled' : ''}>새로고침</button>
      <time>${currentTimeLabel()}</time>
    </div>
  </nav>`;
}

function renderLiveOperations() {
  const activeTask = controlCenter.activeTask ?? controlCenter.coreTasks.at(-1) ?? null;
  const activeMissionTaskIds = controlCenter.executionMode === 'mission' ? missionChildTaskIds() : new Set();
  const activeId = controlCenter.executionMode === 'mission'
    ? controlCenter.activeMission?.missionId
    : activeTask?.taskId;
  const pendingOthers = controlCenter.coreTasks.filter((task) => (
    isApprovalPending(task) && task.taskId !== activeId && !activeMissionTaskIds.has(task.taskId)
  )).length;
  const recentTasks = controlCenter.coreTasks.filter((task) => !activeMissionTaskIds.has(task.taskId));
  return `<section class="assistant-workspace" aria-label="JARVIS 작업 공간">
    <section class="assistant-compose" aria-labelledby="compose-title">
      <header>
        <span>새 요청</span>
        <h2 id="compose-title">무엇을 도와드릴까요?</h2>
      </header>
      ${renderCommandOpsPanel()}
    </section>
    <section class="assistant-current" id="current-task" tabindex="-1" aria-labelledby="current-title" aria-live="polite">
      <header>
        <div><span>${controlCenter.executionMode === 'mission' ? '현재 목표' : '현재 작업'}</span><h2 id="current-title">${controlCenter.commandBusy ? '요청을 처리하고 있습니다' : '실행 현황과 결과'}</h2></div>
        <em>${controlCenter.lastRefreshAt ? formatShortTime(controlCenter.lastRefreshAt) : '대기'}</em>
      </header>
      ${controlCenter.executionMode === 'mission'
        ? renderMissionTimeline(controlCenter.activeMission)
        : renderTaskTimeline(activeTask)}
    </section>
    <aside class="assistant-sidebar" aria-label="작업 보조 정보">
      <section class="assistant-review">
        <header><div><span>확인</span><h2>승인과 오류</h2></div><em>${pendingOthers}건</em></header>
        ${renderAttentionQueue({ excludeTaskId: activeId, excludeTaskIds: activeMissionTaskIds })}
      </section>
      <section class="assistant-recent">
        <header><div><span>기록</span><h2>최근 작업</h2></div><em>${recentTasks.length}건</em></header>
        ${renderTaskList({ excludeTaskIds: activeMissionTaskIds })}
      </section>
    </aside>
    ${controlCenter.lastError ? `<div class="live-error" role="alert"><span>${escapeHtml(controlCenter.lastError)}</span><button type="button" data-refresh-live>다시 확인</button></div>` : ''}
  </section>`;
}

function renderCommandConsole() {
  const ownerActive = controlCenter.autoOwnerEnabled;
  const trustLocked = effectiveRuntimeTrust()?.mode === 'lockdown';
  return `<form class="command-console" id="command-console">
    <div class="execution-controls">
      <div class="execution-mode" role="group" aria-label="실행 방식">
        <button type="button" data-execution-mode="task" aria-pressed="${controlCenter.executionMode === 'task'}" class="${controlCenter.executionMode === 'task' ? 'active' : ''}">빠른 작업</button>
        <button type="button" data-execution-mode="mission" aria-pressed="${controlCenter.executionMode === 'mission'}" class="${controlCenter.executionMode === 'mission' ? 'active' : ''}">목표 실행</button>
      </div>
      <button type="button" class="owner-session-toggle ${ownerActive ? 'active' : ''}" role="switch"
        aria-checked="${ownerActive ? 'true' : 'false'}" aria-describedby="owner-session-help" data-owner-session-toggle
        title="로컬 작업 자동 승인. 만료 시 다음 명령에서 새 세션을 준비합니다. 외부 전송과 되돌릴 수 없는 작업은 계속 개별 확인합니다."
        ${controlCenter.ownerBusy || controlCenter.commandBusy || trustLocked ? 'disabled' : ''}>${trustLocked ? '긴급 잠금 중' : controlCenter.ownerBusy ? '변경 중' : escapeHtml(ownerSessionLabel())}</button>
    </div>
    <p id="owner-session-help" class="sr-only">자동 승인을 켜면 설정을 기억하고, 새 명령을 보낼 때 만료된 세션을 다시 준비합니다. 명시적으로 철회된 세션은 자동으로 재활성화하지 않습니다. 외부 전송과 되돌릴 수 없는 작업은 계속 개별 확인합니다.</p>
    ${requestMemoryControl.render({busy: controlCenter.commandBusy || controlCenter.ownerBusy || controlCenter.routinesBusy})}
    <div class="command-entry">
      <label class="sr-only" for="command-input">${controlCenter.executionMode === 'mission' ? '목표 입력' : '명령 입력'}</label>
      <input id="command-input" name="command" value="${escapeHtml(controlCenter.commandDraft)}" autocomplete="off"
        aria-label="${controlCenter.executionMode === 'mission' ? '목표 입력' : '명령 입력'}"
        placeholder="${trustLocked ? '긴급 잠금 해제 후 작업할 수 있습니다' : controlCenter.executionMode === 'mission' ? '완료할 목표를 입력하세요' : '자비스에게 할 일을 입력하세요'}" />
      <button type="submit" ${controlCenter.commandBusy || controlCenter.ownerBusy || trustLocked ? 'disabled' : ''}>${trustLocked ? '잠금 중' : controlCenter.commandBusy ? '처리 중' : controlCenter.executionMode === 'mission' ? '시작' : '실행'}</button>
    </div>
    <div class="suggestions" aria-label="빠른 요청 · 누르면 바로 실행">${state.commandSuggestions
      .slice(0, 5)
      .map((command) => `<button type="button" data-command="${escapeHtml(command)}" title="바로 실행" ${controlCenter.commandBusy || controlCenter.ownerBusy || trustLocked ? 'disabled' : ''}>${escapeHtml(command)}</button>`)
      .join('')}</div>
  </form>`;
}

function renderModuleTelemetry(items) {
  return `<div class="module-strip">${items
    .map((item) => `<article class="${item.status}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.metric)}</strong>
      <em>${escapeHtml(item.status)}</em>
    </article>`)
    .join('')}</div>`;
}

function renderPlan(plan) {
  return `<div class="plan-readout">
    <strong>${escapeHtml(plan.capability.toUpperCase())}</strong>
    <em>${plan.executable ? `${escapeHtml(plan.mode)} · ${escapeHtml(plan.risk)}` : escapeHtml(plan.reason)}</em>
    <ol>${plan.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <div class="guardrails">${plan.guardrails.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
  </div>`;
}

function renderMemory(items) {
  return `<ul class="memory-list">${items
    .map((item) => `<li><strong>${escapeHtml(item.title)}</strong><em>${item.tags.map(escapeHtml).join(' · ')}</em></li>`)
    .join('')}</ul>`;
}

function renderAudit(items) {
  return `<ul class="audit-list">${items
    .map((item) => `<li><strong>${escapeHtml(item.event)}</strong><em>${new Date(item.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</em></li>`)
    .join('')}</ul>`;
}

function renderHistory(items) {
  const statusText = { 'approval-required': '승인 대기', 'local-blocked': '로컬 차단', running: '실행 중' };
  return `<ul class="history-list">${items
    .map((item) => `<li>
      <span>${escapeHtml(item.id)}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <em>${escapeHtml(statusText[item.status] ?? item.status)} · ${escapeHtml(item.capability)}</em>
    </li>`)
    .join('')}</ul>`;
}

function renderActionPlan(plan) {
  return `<div class="action-plan">
    <header><strong>${escapeHtml(plan.focus)}</strong><em>C${plan.counts.critical} H${plan.counts.high} M${plan.counts.medium}</em></header>
    <ol>${plan.nextActions
      .slice(0, 4)
      .map((item) => `<li class="${item.priority}">
        <span>${escapeHtml(item.docId)}</span>
        <strong>${escapeHtml(item.action)}</strong>
        <em>${escapeHtml(item.priority)} · ${escapeHtml(item.type)}</em>
      </li>`)
      .join('')}</ol>
  </div>`;
}

function stageLabel(stage) {
  return {
    ready: '준비',
    building: '구축',
    verifying: '검증',
    blocked: '보류',
    complete: '완료'
  }[stage] ?? stage;
}

function renderDocumentStreams(items) {
  return `<div class="document-streams" aria-label="A부터 G까지 문서 진행">
    <header>
      <div><span>A-G 실행 흐름</span><strong>${state.readiness.score}</strong></div>
      <em>${escapeHtml(state.readiness.status.toUpperCase())} · ${state.documentProgress}%</em>
    </header>
    <div>${items
      .map((item) => `<article class="${item.health}">
        <div class="doc-head"><b>${item.id}</b><strong>${escapeHtml(item.title)}</strong><em>${stageLabel(item.stage)}</em></div>
        <p>${escapeHtml(item.objective)}</p>
        <div class="doc-meter"><span style="width:${item.progress}%"></span></div>
        <small>${escapeHtml(item.evidence)}</small>
        <small>다음: ${escapeHtml(item.nextAction)}</small>
      </article>`)
      .join('')}</div>
    ${renderReadinessGate(state.readiness)}
  </div>`;
}

function renderReadinessGate(readiness) {
  const blockers = readiness.blockers.slice(0, 2);
  const watches = readiness.watchItems.slice(0, 2);
  return `<div class="readiness-gate ${readiness.status}">
    <strong>${escapeHtml(readiness.summary)}</strong>
    <ul class="criteria-list">${readiness.goCriteria
      .map((item) => `<li class="${item.pass ? 'pass' : 'fail'}"><span>${item.pass ? '✓' : '!'}</span>${escapeHtml(item.label)}</li>`)
      .join('')}</ul>
    <div class="issue-list">
      ${blockers.map((item) => `<p><b>${escapeHtml(item.id)}</b>${escapeHtml(item.reason)}</p>`).join('')}
      ${watches.map((item) => `<p><b>${escapeHtml(item.id)}</b>${escapeHtml(item.reason)}</p>`).join('')}
      ${blockers.length === 0 && watches.length === 0 ? '<p><b>통과</b>모든 검증 기준 통과</p>' : ''}
    </div>
  </div>`;
}

function renderConsoleCore() {
  const dots = Array.from({ length: 12 }, (_, index) => `<span class="${index < Math.round(state.progress / 9) ? 'on' : ''}"></span>`).join('');
  return `<section class="console-core" aria-label="현재 작업 진행률" style="--progress:${state.progress * 3.6}deg">
    <div class="rings"><div class="inner-ring">
      <small>현재 작업</small>
      <h1>${escapeHtml(state.commandProfile.title)}</h1>
      <p>진행률</p>
      <strong>${state.progress}%</strong>
      <div class="progress-dots">${dots}</div>
      <p>남은 시간</p>
      <time>${state.eta}</time>
    </div></div>
    <div class="core-stats">
      <span><em>모드</em><strong>${escapeHtml(state.plan.mode)}</strong></span>
      <span><em>위험</em><strong>${escapeHtml(state.plan.risk)}</strong></span>
      <span><em>검증</em><strong>${escapeHtml(state.readiness.status)}</strong></span>
    </div>
    <div class="route-card"><b>↗</b><div><span>현재 경로</span><strong>${state.route.distanceM}미터</strong><span>${escapeHtml(state.route.instruction)}</span></div></div>
  </section>`;
}

function renderCommandOpsPanel() {
  return `<div class="command-ops-panel">
    ${renderCommandConsole()}
  </div>`;
}

function renderOperationalSummary() {
  const activeStep = state.workflow.find((item) => item.status === 'active') ?? state.workflow.at(0);
  return `<div class="ops-summary">
    <div class="command-status-strip">
      <span><em>현재 단계</em><strong>${escapeHtml(activeStep?.label ?? '대기')}</strong></span>
      <span><em>권한</em><strong>${escapeHtml(state.approval.status)}</strong></span>
      <span><em>준비도</em><strong>${escapeHtml(state.readiness.status)}</strong></span>
    </div>
    <div class="ops-summary-lines">
      <p><strong>${escapeHtml(state.commandProfile.title)}</strong><span>${escapeHtml(state.plan.capability)} · ${escapeHtml(state.plan.risk)}</span></p>
      <p><strong>${escapeHtml(state.simulationResult.name)}</strong><span>${state.simulationResult.passRate}% · ${state.simulationResult.failedChecks.length ? '검토 필요' : '검증 통과'}</span></p>
    </div>
  </div>`;
}

function renderTodayOpsPanel() {
  return `<div class="today-ops">
    ${renderSchedule(state.schedule)}
    <div class="next compact-next">
      <time>10:00</time>
      <strong>팀 회의</strong>
      <span>회의실 A</span>
    </div>
  </div>`;
}

function renderQuickActionBoard() {
  const actions = [
    ['현재 화면 캡처', 'CAP', '화면'],
    ['회의 녹음 시작', 'REC', '음성'],
    ['회의 자료 분석', 'AI', '분석'],
    ['프로젝트 자료 검색', 'SRC', '검색'],
    ['메모 요약', 'MEM', '기억'],
    ['설정 점검', 'CFG', '점검']
  ];
  return `<section class="quick-action-board" aria-label="빠른 실행">
    ${actions.map(([command, code, label]) => `<button type="button" data-command="${escapeHtml(command)}">
      <span>${escapeHtml(code)}</span>
      <strong>${escapeHtml(command)}</strong>
      <em>${escapeHtml(label)}</em>
    </button>`).join('')}
  </section>`;
}

function renderApprovalWorkbench() {
  return `<div class="approval-workbench">
    ${renderApprovals(state.approvals)}
    <div class="approval-divider"></div>
    ${renderPcConsole(state.pcConsole, state.pcConsoleVisualRegression, state.pcConsoleBridgeStatus)}
  </div>`;
}

function renderCompactSignals() {
  return `<div class="compact-signals">
    <section>
      <header><strong>연결</strong><span>${state.connections.length}</span></header>
      ${renderConnections(state.connections)}
    </section>
    <section>
      <header><strong>기록</strong><span>${state.commandHistory.length}</span></header>
      ${renderHistory(state.commandHistory)}
    </section>
  </div>`;
}

function renderOperatorDock() {
  return `<footer class="dock operator-dock" aria-label="작업 명령 모음">
    ${[
        ['현재 화면 캡처', 'CAP'],
        ['메모 요약', 'MEM'],
        ['프로젝트 자료 검색', 'SRC'],
        ['회의 자료 분석', 'AI'],
        ['설정 점검', 'CFG'],
        ['회의 녹음 시작', 'REC']
      ]
      .map(([command, item]) => `<button type="button" data-command="${escapeHtml(command)}" aria-label="${escapeHtml(command)}" title="${escapeHtml(command)}"><span>${item}</span>${escapeHtml(command)}</button>`)
      .join('')}
  </footer>`;
}

function captureFocusedField() {
  const element = document.activeElement;
  if (!element || !app.contains(element)) return null;
  const tagName = element.tagName;
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName)) return null;
  // Browsers prohibit restoring file paths; anonymous fields cannot be matched safely.
  if (element.type === 'file' || (!element.id && !element.getAttribute('name') && !element.dataset.goalRevisionField)) return null;
  return {
    id: element.id || null,
    goalRevisionField: element.dataset.goalRevisionField ?? null,
    goalRevisionMission: element.closest('[data-goal-revision-form]')?.dataset.missionId ?? null,
    name: element.getAttribute('name') || null,
    tagName,
    value: 'value' in element ? element.value : null,
    selectionStart: typeof element.selectionStart === 'number' ? element.selectionStart : null,
    selectionEnd: typeof element.selectionEnd === 'number' ? element.selectionEnd : null
  };
}

function restoreFocusedField(snapshot) {
  if (!snapshot) return;
  const candidates = Array.from(app.querySelectorAll('input, textarea, select'));
  const element = snapshot.goalRevisionField
    ? candidates.find(candidate => candidate.dataset.goalRevisionField === snapshot.goalRevisionField
      && candidate.closest('[data-goal-revision-form]')?.dataset.missionId === snapshot.goalRevisionMission)
    : snapshot.id
    ? document.getElementById(snapshot.id)
    : candidates.find((candidate) => candidate.getAttribute('name') === snapshot.name && candidate.tagName === snapshot.tagName);
  if (!element || element.type === 'file') return;
  if (snapshot.value !== null && 'value' in element) element.value = snapshot.value;
  element.focus({ preventScroll: true });
  if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null && typeof element.setSelectionRange === 'function') {
    try {
      element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch {
      // Some input types, such as password, do not expose selection ranges.
    }
  }
}

const personalInboxPanel = createPersonalInboxPanel({onQuotaChanged:()=>personalMandatePanel.refresh(),request:(path,options={})=>coreRequest(path,{...options,token:controlCenter.coreAdminToken}),changed:()=>render({preserveScroll:true}),escape:escapeHtml});
const selectedConversationPanel = createSelectedConversationPanel({request:(path,options={})=>coreRequest(path,{...options,token:controlCenter.coreAdminToken}),changed:()=>render({preserveScroll:true}),escape:escapeHtml});
const memoryStatusPanel = createMemoryStatusPanel({request:(path,options={})=>coreRequest(path,{...options,token:controlCenter.coreAdminToken}),changed:()=>render({preserveScroll:true}),escape:escapeHtml,canManage:hasCoreAdminAccess});
const preferenceManagementPanel = createPreferenceManagementPanel({request:(path,options={})=>coreRequest(path,{...options,token:controlCenter.coreAdminToken}),changed:()=>render({preserveScroll:true}),escape:escapeHtml,canManage:hasCoreAdminAccess});
const sourceRevisionPanel = createSourceRevisionPanel({request:(path,options={})=>coreRequest(path,{...options,token:controlCenter.coreAdminToken}),changed:()=>render({preserveScroll:true}),escape:escapeHtml,canManage:hasCoreAdminAccess});
const personalMandatePanel = createPersonalMandatePanel({request:(path,options={})=>coreRequest(path,{...options,token:controlCenter.coreAdminToken}),changed:()=>render({preserveScroll:true}),escape:escapeHtml});

let desktopNavigationHash = null;
globalThis.addEventListener('hashchange', () => {
  desktopNavigationHash = null;
  applyDesktopNavigation(app, globalThis.location.hash);
});

function render({ preserveScroll = false } = {}) {
  const scrollTop = globalThis.scrollY ?? 0;
  const focusedField = preserveScroll ? captureFocusedField() : null;
  app.dataset.activeMissionId = controlCenter.activeMissionId ?? '';
  app.dataset.latestMissionId = controlCenter.missions.at(0)?.missionId ?? '';
  app.dataset.missionCount = String(controlCenter.missions.length);
  app.innerHTML = `<a class="skip-link" href="#command-input">명령 입력으로 건너뛰기</a><a class="skip-link" href="#current-task">현재 작업으로 건너뛰기</a><h1 class="sr-only">JARVIS 제어 센터</h1><div class="shell practical-shell">
  ${renderLiveTopbar()}
  ${renderLiveOperations()}
  ${renderRoutineWorkspace()}
  <div id="desktop-inbox">${personalInboxPanel.render()}</div>
  <div id="desktop-memory">${selectedConversationPanel.render()}${memoryStatusPanel.render()}${preferenceManagementPanel.render()}</div>
  <div id="desktop-sources">${sourceRevisionPanel.render()}</div>
  <div id="desktop-delegation">${personalMandatePanel.render()}</div>
  ${renderPracticalWorkspace()}
</div>`;
  applyDesktopNavigation(app, globalThis.location.hash, { scroll: false });
  restoreFocusedField(focusedField);
  const taskProgress = app.querySelector('.task-progress');
  if (taskProgress && taskProgress.scrollWidth > taskProgress.clientWidth) {
    taskProgress.scrollLeft = taskProgress.scrollWidth;
  }
  window.scrollTo({ top: preserveScroll ? scrollTop : 0, left: 0 });
  const hash = globalThis.location.hash;
  if (applyDesktopNavigation(app, hash, { scroll: !preserveScroll || desktopNavigationHash !== hash })) desktopNavigationHash = hash;
}

function updateClock() {
  const clock = app.querySelector('.system time');
  if (clock) clock.textContent = currentTimeLabel();
}

function runCommand(command) {
  state = composeState(String(command ?? '').trim() || '회의 자료 분석');
  render();
}

async function syncPcConsoleFromBridge() {
  if (!pcConsoleBridgeClient) return;
  const queue = await pcConsoleBridgeClient.list();
  if (queue?.items) {
    system.replacePcConsoleHandoffs(queue.items);
    state = withPcConsoleEvidence(system.composeDashboardState(state.command), {
      mode: 'bridge-fetch',
      synced: true,
      error: null,
      fetchedCount: queue.items.length,
      counts: queue.counts ?? null
    });
    render();
    maybeAutoStartPcVoiceConfirmation();
    return;
  }
  state = withPcConsoleEvidence(state, {
    mode: 'bridge-fetch',
    synced: false,
    error: queue?.error?.code ?? 'C_PC_CONSOLE_FETCH_FAILED'
  });
  render();
}

async function submitPcHandoffDecision(handoffId, decision, {
  operatorId = 'pc-hud-operator',
  voiceProof = null
} = {}) {
  if (!pcConsoleBridgeClient) {
    return { success: false, error: { code: 'C_PC_CONSOLE_BRIDGE_NOT_CONFIGURED' } };
  }
  const decided = await pcConsoleBridgeClient.decide(handoffId, {
    decision,
    operatorId,
    voiceProof
  });
  if (decided?.success === false) return decided;
  let execution = null;
  if (decided?.executionHandoffId) {
    execution = await pcConsoleBridgeClient.confirmExecution(decided.executionHandoffId);
    if (execution?.success === false) return execution;
  }
  await syncPcConsoleFromBridge();
  return {
    ...decided,
    execution,
    taskStatus: execution?.status ?? decided?.taskStatus ?? null
  };
}

async function handlePcVoiceDecision({ handoff, decision, voiceProof }) {
  return submitPcHandoffDecision(handoff.handoffId, decision, {
    operatorId: 'pc-hud-voice',
    voiceProof
  });
}

function togglePcVoiceConfirmation() {
  if (pcVoiceState.active) {
    pcVoiceAutoEnabled = false;
    writeUiSetting('jarvis.pcVoiceAuto', '0');
    pcVoiceController.stop();
    return;
  }
  const target = state.pcConsole.items.find((item) => (
    item.status === 'awaiting_pc_confirmation'
    && item.voiceChallenge?.challengeId
    && !item.voiceChallenge?.consumedAt
  ));
  if (target) {
    pcVoiceAutoEnabled = true;
    writeUiSetting('jarvis.pcVoiceAuto', '1');
    lastAutoVoiceChallengeId = target.voiceChallenge.challengeId;
    pcVoiceController.start(target);
  }
}

function maybeAutoStartPcVoiceConfirmation() {
  if (!pcVoiceAutoEnabled || pcVoiceState.active || !pcVoiceState.supported) return;
  const target = state.pcConsole.items.find((item) => (
    item.status === 'awaiting_pc_confirmation'
    && item.voiceChallenge?.challengeId
    && !item.voiceChallenge?.consumedAt
  ));
  if (!target || target.voiceChallenge.challengeId === lastAutoVoiceChallengeId) return;
  lastAutoVoiceChallengeId = target.voiceChallenge.challengeId;
  setTimeout(() => pcVoiceController.start(target), 0);
}

app.addEventListener('input', (event) => {
  const routineField = event.target.dataset.routineField;
  if (routineField) {
    controlCenter.routinesDraft[routineField] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if (event.target.type === 'checkbox') render({ preserveScroll: true });
    return;
  }
  const timezoneRoutineId = event.target.dataset.routineTimezoneField;
  if (timezoneRoutineId) {
    controlCenter.routineTimezoneDrafts[timezoneRoutineId] = event.target.value;
    return;
  }
  const criterionRole = event.target.dataset.goalCriterionRole;
  if (criterionRole !== undefined) {
    const draft = controlCenter.goalRevisionDrafts.get(event.target.closest('[data-goal-revision-form]')?.dataset.missionId);
    const index = Number(criterionRole);
    if (draft && !draft.busy && Number.isSafeInteger(index) && index >= 0 && index < draft.criterionRoles.length
      && ['input', 'output'].includes(event.target.value)) draft.criterionRoles[index] = event.target.value;
    return;
  }
  const revisionField = event.target.dataset.goalRevisionField;
  if (revisionField) {
    const draft = controlCenter.goalRevisionDrafts.get(event.target.closest('[data-goal-revision-form]')?.dataset.missionId);
    if (draft && !draft.busy) {
      draft[revisionField] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
      if (event.target.type === 'checkbox') render({ preserveScroll: true });
    }
    return;
  }
  if (event.target.id === 'command-input') {
    controlCenter.commandDraft = event.target.value;
  }
  if (event.target.matches('[data-trust-recovery-phrase]')) {
    controlCenter.trustRecoveryPhrase = event.target.value;
  }
});

app.addEventListener('submit', (event) => {
  if (event.target.matches('[data-provider-credential-setup]')) {
    event.preventDefault();
    submitProviderCredentialSetup(event.target);
    return;
  }
  if (event.target.matches('[data-routine-form]')) {
    event.preventDefault();
    const formData = new FormData(event.target);
    controlCenter.routinesDraft = {
      scheduleText: String(formData.get('scheduleText') ?? ''),
      objective: String(formData.get('objective') ?? ''),
      successCriteria: String(formData.get('successCriteria') ?? ''),
      recurrenceEnabled: formData.get('recurrenceEnabled') === 'on',
      weekday: Number(formData.get('weekday') ?? controlCenter.routinesDraft.weekday ?? 1),
      hour: Number(formData.get('hour') ?? controlCenter.routinesDraft.hour ?? 9),
      minute: Number(formData.get('minute') ?? controlCenter.routinesDraft.minute ?? 0),
      timeZone: String(formData.get('timeZone') ?? 'Asia/Seoul')
    };
    submitRoutine(formData);
    return;
  }
  if (event.target.matches('[data-goal-revision-form]')) {
    event.preventDefault();
    submitGoalRevision(event.target.dataset.missionId);
    return;
  }
  if (event.target.matches('[data-mission-clarification]')) {
    event.preventDefault();
    const formData = new FormData(event.target);
    decideLiveMissionGate(
      event.target.dataset.missionId,
      event.target.dataset.gateId,
      'approve',
      formData.get('responseText'),
      formData.has('clarificationAnswer') ? formData.getAll('clarificationAnswer') : undefined
    );
    return;
  }
  if (event.target.id === 'live-settings') {
    event.preventDefault();
    saveLiveSettings(new FormData(event.target));
    return;
  }
  if (event.target.id !== 'command-console') return;
  event.preventDefault();
  submitLiveCommand(new FormData(event.target).get('command'));
});

app.addEventListener('click', async (event) => {
  const verifyModelProviderTrigger = event.target.closest('[data-verify-model-provider]');
  if (verifyModelProviderTrigger) {
    await verifyModelProvider(verifyModelProviderTrigger.dataset.verifyModelProvider);
    return;
  }
  const routineTimezone = event.target.closest('[data-routine-timezone]');
  if (routineTimezone) {
    await reviseRoutineTimezone(routineTimezone.dataset.routineTimezone);
    return;
  }
  const routineCancel = event.target.closest('[data-routine-cancel]');
  if (routineCancel) {
    await cancelRoutine(routineCancel.dataset.routineCancel);
    return;
  }
  if (event.target.closest('[data-routine-refresh]')) {
    await refreshLiveState({ silent: true });
    return;
  }
  const goalEdit = event.target.closest('[data-goal-revision-open], [data-goal-revision-reload], [data-goal-revision-close]');
  if (goalEdit) {
    const mission = controlCenter.activeMission;
    if (goalEdit.dataset.goalRevisionClose) controlCenter.goalRevisionDrafts.delete(goalEdit.dataset.goalRevisionClose);
    else if (mission && (goalEdit.dataset.goalRevisionOpen ?? goalEdit.dataset.goalRevisionReload) === mission.missionId) {
      if (!controlCenter.goalRevisionDrafts.has(mission.missionId) || goalEdit.dataset.goalRevisionReload) {
        controlCenter.goalRevisionDrafts.set(mission.missionId, createGoalRevisionDraft(mission));
      }
    }
    render({ preserveScroll: true });
    return;
  }
  const executionModeTrigger = event.target.closest('[data-execution-mode]');
  if (executionModeTrigger) {
    setExecutionMode(executionModeTrigger.dataset.executionMode);
    return;
  }
  if (event.target.closest('[data-refresh-live]')) {
    await refreshLiveState();
    return;
  }
  if (event.target.closest('[data-run-support-diagnostic]')) {
    await runSupportDiagnostic();
    return;
  }
  if (event.target.closest('[data-owner-session-toggle]')) {
    await toggleOwnerSession();
    return;
  }
  if (event.target.closest('[data-trust-gate]')) {
    await runRuntimeTrustGate();
    return;
  }
  if (event.target.closest('[data-trust-lockdown]')) {
    await armOrEngageRuntimeLockdown();
    return;
  }
  if (event.target.closest('[data-trust-recovery-start]')) {
    await beginRuntimeTrustRecovery();
    return;
  }
  if (event.target.closest('[data-trust-recover]')) {
    await completeRuntimeTrustRecovery();
    return;
  }
  if (event.target.closest('[data-core-daemon-tick]')) {
    await tickCoreDaemon();
    await refreshLiveState({ silent: true });
    return;
  }
  if (event.target.closest('[data-pc-voice-toggle]')) {
    togglePcVoiceConfirmation();
    return;
  }
  const taskDecisionTrigger = event.target.closest('[data-task-decision]');
  if (taskDecisionTrigger) {
    await decideLiveTask(taskDecisionTrigger.dataset.taskId, taskDecisionTrigger.dataset.taskDecision);
    return;
  }
  const rollbackPreviewTrigger = event.target.closest('[data-task-rollback-preview]');
  if (rollbackPreviewTrigger) {
    await previewTaskRollback(rollbackPreviewTrigger.dataset.taskRollbackPreview);
    return;
  }
  const rollbackConfirmTrigger = event.target.closest('[data-task-rollback-confirm]');
  if (rollbackConfirmTrigger) {
    await confirmTaskRollback(rollbackConfirmTrigger.dataset.taskRollbackConfirm);
    return;
  }
  const rollbackCancelTrigger = event.target.closest('[data-task-rollback-cancel]');
  if (rollbackCancelTrigger) {
    resetTaskRollback(rollbackCancelTrigger.dataset.taskRollbackCancel);
    render({ preserveScroll: true });
    return;
  }
  const missionGateTrigger = event.target.closest('[data-mission-gate-decision]');
  if (missionGateTrigger) {
    await decideLiveMissionGate(
      missionGateTrigger.dataset.missionId,
      missionGateTrigger.dataset.gateId,
      missionGateTrigger.dataset.missionGateDecision
    );
    return;
  }
  const dependencyTrigger = event.target.closest('[data-mission-dependencies-inspect]');
  if (dependencyTrigger) {
    const mission = controlCenter.activeMission;
    if (mission?.missionId === dependencyTrigger.dataset.missionDependenciesInspect) await missionDependencyPanel.inspect(mission);
    return;
  }
  const missionReviewTrigger = event.target.closest('[data-mission-review]');
  if (missionReviewTrigger) {
    const mission = controlCenter.activeMission;
    if (mission?.missionId === missionReviewTrigger.dataset.missionReview) await cancellationReviewPanel.review(mission);
    return;
  }
  const missionCancelTrigger = event.target.closest('[data-mission-cancel]');
  if (missionCancelTrigger) {
    await cancelLiveMission(missionCancelTrigger.dataset.missionCancel);
    return;
  }
  const missionResumeTrigger = event.target.closest('[data-mission-resume]');
  if (missionResumeTrigger) {
    await resumeLiveMission(missionResumeTrigger.dataset.missionResume);
    return;
  }
  const openTaskTrigger = event.target.closest('[data-open-task]');
  if (openTaskTrigger) {
    await openLiveTask(openTaskTrigger.dataset.openTask);
    return;
  }
  const pcHandoffTrigger = event.target.closest('[data-pc-handoff-decision]');
  if (pcHandoffTrigger) {
    if (pcConsoleBridgeClient) {
      const result = await submitPcHandoffDecision(
        pcHandoffTrigger.dataset.handoffId,
        pcHandoffTrigger.dataset.pcHandoffDecision
      );
      if (result?.success) {
        return;
      }
    } else {
      system.decidePcConsoleHandoff(
        pcHandoffTrigger.dataset.handoffId,
        pcHandoffTrigger.dataset.pcHandoffDecision,
        { operatorId: 'pc-hud-operator' }
      );
    }
    state = composeState(state.command);
    render();
    return;
  }
  const trigger = event.target.closest('[data-command]');
  if (!trigger) return;
  await submitLiveCommand(trigger.dataset.command);
});

app.addEventListener('toggle', (event) => {
  if (event.target.matches?.('.system-diagnostics')) {
    controlCenter.diagnosticsOpen = event.target.open;
  }
}, true);

personalInboxPanel.attach(app);
selectedConversationPanel.attach(app);
sourceRevisionPanel.attach(app);
requestMemoryControl.attach(app, {isBusy:()=>controlCenter.commandBusy || controlCenter.ownerBusy || controlCenter.routinesBusy, changed:()=>render({preserveScroll:true})});
memoryStatusPanel.attach(app);
preferenceManagementPanel.attach(app);
personalMandatePanel.attach(app);
render();
personalInboxPanel.refresh();
sourceRevisionPanel.refresh();
memoryStatusPanel.refresh();
preferenceManagementPanel.refresh();
personalMandatePanel.refresh();
syncPcConsoleFromBridge();
refreshLiveState({ silent: true });
setInterval(updateClock, 30_000);
setInterval(() => refreshLiveState({ silent: true }), 15_000);
