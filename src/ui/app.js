import { createJarvisSystem } from '../domain/core-engine.js';
import { PermissionLevel } from '../domain/models.js';
import {
  PcConfirmationConsoleBridgeClient,
  createPcConsoleVisualBaseline,
  createPcConsoleVisualSnapshot,
  diffPcConsoleVisualSnapshots
} from '../domain/pc-console.js';

const system = createJarvisSystem();
const pcConsoleVisualBaseline = createPcConsoleVisualBaseline();
const pcConsoleBridgeClient = createConfiguredPcConsoleBridgeClient();
let pcConsoleBridgeStatus = {
  mode: pcConsoleBridgeClient ? 'bridge-fetch-ready' : 'local-demo',
  synced: false,
  error: null
};
let elevatedMode = false;
let state = composeState();
const app = document.querySelector('#app');
const LIVE_OK_STATUSES = new Set(['ok', 'running', 'healthy', 'started', 'already-running', 'ready']);
const LIVE_WARN_STATUSES = new Set(['degraded', 'warning', 'stopped', 'not-attached', 'disabled']);
const controlCenter = {
  coreBaseUrl: normalizeEndpoint(readUiSetting('jarvis.coreBaseUrl', '/api/core')),
  pcBaseUrl: normalizeEndpoint(readUiSetting('jarvis.pcBaseUrl', '/api/pc')),
  coreAdminToken: readUiSetting('jarvis.coreAdminToken', 'local-core-admin'),
  pcAgentToken: readUiSetting('jarvis.pcAgentToken', 'local-pc-agent-api'),
  refreshing: false,
  commandBusy: false,
  lastError: null,
  lastRefreshAt: null,
  coreHealth: null,
  coreTasks: [],
  workerQueue: null,
  workerDaemon: null,
  pcHealth: null,
  pcRuntime: null,
  pcTray: null,
  pcQueue: null,
  localPackageStatus: null,
  activeTask: null,
  activity: [createActivity('ui', 'Control Center ready', 'ok')]
};

function composeState(command) {
  const nextState = system.composeDashboardState(command, elevatedMode ? {
    autoApprove: true,
    userLevel: PermissionLevel.ADMIN
  } : undefined);
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
  return `<div class="pc-console" aria-label="PC 확인 수락 거절 콘솔">
    <header>
      <strong>대기 ${consoleState.pending}</strong>
      <em>수락 ${consoleState.accepted} · 거절 ${consoleState.rejected}</em>
    </header>
    <ul>${consoleState.items
      .slice(0, 3)
      .map((item) => `<li class="${escapeHtml(item.status)}">
        <div>
          <b>Tier ${escapeHtml(item.riskTier)}</b>
          <strong>${escapeHtml(item.title)}</strong>
          <em>${pcHandoffStatusLabel(item.status)} · ${item.externalTransfer ? '외부 전송' : '로컬 확인'}</em>
          <small>${escapeHtml(item.interpretedIntent)}</small>
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
    <footer class="pc-console-visual ${visualRegression.status}">
      <span>Visual ${escapeHtml(visualRegression.status)}</span>
      <small>${escapeHtml(bridgeStatus.mode)}${bridgeStatus.synced ? ' · fetch synced' : ''}</small>
    </footer>
  </div>`;
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
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
  return String(status ?? 'offline').replaceAll('_', ' ');
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

async function requestJson(url, { method = 'GET', body, token, timeoutMs = 6_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
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

function settledValue(result) {
  return result.status === 'fulfilled' ? result.value : null;
}

function settledMessage(result) {
  if (result.status === 'fulfilled') return null;
  if (result.reason?.name === 'AbortError') return '요청 시간 초과';
  return result.reason?.message ?? String(result.reason);
}

async function refreshLiveState({ silent = false } = {}) {
  if (controlCenter.refreshing) return;
  controlCenter.refreshing = true;
  if (!silent) render({ preserveScroll: true });

  const results = await Promise.allSettled([
    coreRequest('/health', { timeoutMs: 4_000 }),
    coreRequest('/tasks', { timeoutMs: 4_000 }),
    coreRequest('/worker/queue', { timeoutMs: 4_000 }),
    coreRequest('/worker/daemon', { token: controlCenter.coreAdminToken, timeoutMs: 4_000 }),
    requestJson(joinEndpoint(controlCenter.pcBaseUrl, '/health'), { timeoutMs: 4_000 }),
    requestJson(joinEndpoint(controlCenter.pcBaseUrl, '/service/runtime'), { timeoutMs: 4_000 }),
    requestJson(joinEndpoint(controlCenter.pcBaseUrl, '/tray/state'), { timeoutMs: 4_000 }),
    pcRequest('/execution-packets/queue', { timeoutMs: 4_000 }),
    requestJson('/api/local/package-status', { timeoutMs: 4_000 })
  ]);

  const [coreHealth, coreTasks, workerQueue, workerDaemon, pcHealth, pcRuntime, pcTray, pcQueue, localPackageStatus] = results;
  controlCenter.coreHealth = settledValue(coreHealth);
  controlCenter.coreTasks = settledValue(coreTasks)?.items ?? [];
  controlCenter.workerQueue = settledValue(workerQueue);
  controlCenter.workerDaemon = settledValue(workerDaemon);
  controlCenter.pcHealth = settledValue(pcHealth);
  controlCenter.pcRuntime = settledValue(pcRuntime);
  controlCenter.pcTray = settledValue(pcTray);
  controlCenter.pcQueue = settledValue(pcQueue);
  controlCenter.localPackageStatus = settledValue(localPackageStatus);
  controlCenter.lastRefreshAt = new Date().toISOString();
  controlCenter.refreshing = false;

  const requiredResults = results.slice(0, 8);
  const messages = requiredResults.map(settledMessage).filter(Boolean);
  controlCenter.lastError = messages.length >= requiredResults.length ? messages[0] : null;
  render({ preserveScroll: true });
}

async function tickCoreDaemon(reason = 'control-center-manual') {
  try {
    const tick = await coreRequest('/worker/daemon/tick', {
      method: 'POST',
      token: controlCenter.coreAdminToken,
      timeoutMs: 12_000,
      body: { reason }
    });
    pushActivity('daemon', `${tick.status ?? 'tick'} · processed ${tick.drain?.processed ?? 0}`, 'ok');
    return tick;
  } catch (error) {
    pushActivity('daemon', error.status === 401 ? 'admin token required' : error.message, 'warn');
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
  const trimmed = String(command ?? '').trim() || '회의 자료 분석';
  controlCenter.commandBusy = true;
  controlCenter.lastError = null;
  state = composeState(trimmed);
  pushActivity('command', trimmed, 'ok');
  render({ preserveScroll: true });

  try {
    const created = await coreRequest('/tasks', {
      method: 'POST',
      timeoutMs: 8_000,
      body: {
        rawText: trimmed,
        options: {
          source: 'pc_ui',
          sourceModule: 'B_PC_AGENT',
          deviceId: 'local-control-center',
          metadata: {
            submittedBy: 'jarvis-control-center'
          }
        }
      }
    });
    controlCenter.activeTask = created;
    pushActivity('core', `${created.taskId} · ${created.status}`, 'ok');

    const queued = await coreRequest(`/tasks/${encodeURIComponent(created.taskId)}/queue`, {
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
    controlCenter.activeTask = { ...created, queue: queued };
    pushActivity('queue', `${queued.status ?? 'queued'}`, 'ok');
    await tickCoreDaemon('control-center-command');
    const latest = await pollTask(created.taskId);
    if (latest) controlCenter.activeTask = latest;
    await refreshLiveState({ silent: true });
  } catch (error) {
    controlCenter.lastError = error.name === 'AbortError' ? '요청 시간 초과' : error.message;
    pushActivity('error', controlCenter.lastError, 'down');
  } finally {
    controlCenter.commandBusy = false;
    render({ preserveScroll: true });
  }
}

function saveLiveSettings(formData) {
  controlCenter.coreBaseUrl = normalizeEndpoint(formData.get('coreBaseUrl') || controlCenter.coreBaseUrl);
  controlCenter.pcBaseUrl = normalizeEndpoint(formData.get('pcBaseUrl') || controlCenter.pcBaseUrl);
  controlCenter.coreAdminToken = String(formData.get('coreAdminToken') || controlCenter.coreAdminToken);
  controlCenter.pcAgentToken = String(formData.get('pcAgentToken') || controlCenter.pcAgentToken);
  writeUiSetting('jarvis.coreBaseUrl', controlCenter.coreBaseUrl);
  writeUiSetting('jarvis.pcBaseUrl', controlCenter.pcBaseUrl);
  writeUiSetting('jarvis.coreAdminToken', controlCenter.coreAdminToken);
  writeUiSetting('jarvis.pcAgentToken', controlCenter.pcAgentToken);
  pushActivity('settings', 'saved', 'ok');
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
    <label>Core API<input name="coreBaseUrl" value="${escapeHtml(controlCenter.coreBaseUrl)}" autocomplete="off" /></label>
    <label>PC API<input name="pcBaseUrl" value="${escapeHtml(controlCenter.pcBaseUrl)}" autocomplete="off" /></label>
    <label>Core Token<input name="coreAdminToken" type="password" value="${escapeHtml(controlCenter.coreAdminToken)}" autocomplete="off" /></label>
    <label>PC Token<input name="pcAgentToken" type="password" value="${escapeHtml(controlCenter.pcAgentToken)}" autocomplete="off" /></label>
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
      stateLabel: 'checking',
      detail: 'package status pending'
    };
  }
  if (packageInfo.status !== 'ready') {
    return {
      status: 'down',
      stateLabel: 'missing',
      detail: packageInfo.error ?? 'package manifest unavailable'
    };
  }
  if (!packageInfo.serviceHostRecoveryReady) {
    return {
      status: 'warn',
      stateLabel: 'rebuild',
      detail: 'service host recovery guard missing'
    };
  }
  const packageTime = timestampMs(packageInfo.generatedAt ?? packageInfo.manifestUpdatedAt);
  const serviceTime = timestampMs(serviceStartedAt);
  if (packageTime && serviceTime && packageTime > serviceTime + 1_000) {
    return {
      status: 'warn',
      stateLabel: 'update pending',
      detail: `pkg ${formatShortTime(packageInfo.generatedAt ?? packageInfo.manifestUpdatedAt)} · svc ${formatShortTime(serviceStartedAt)}`
    };
  }
  return {
    status: 'ok',
    stateLabel: 'current',
    detail: packageInfo.serviceHostRecoveryReady ? 'recovery guard active' : 'ready'
  };
}

function renderServiceUpdatePanel() {
  const rows = [
    {
      id: 'core',
      label: 'Core Service',
      ...servicePackageStatus('core', controlCenter.coreHealth?.startedAt)
    },
    {
      id: 'pc',
      label: 'PC Agent',
      ...servicePackageStatus('pc', controlCenter.pcRuntime?.startedAt ?? controlCenter.pcHealth?.serviceRuntime?.startedAt)
    }
  ];
  const actionRequired = rows.some((row) => row.status === 'warn' || row.status === 'down');
  return `<section class="service-update-panel ${actionRequired ? 'warn' : 'ok'}">
    <header><strong>Service Build</strong><span>${actionRequired ? 'ACTION' : 'CURRENT'}</span></header>
    <ul>${rows.map((row) => `<li class="${escapeHtml(row.status)}">
      <span>${escapeHtml(row.stateLabel)}</span>
      <strong>${escapeHtml(row.label)}</strong>
      <em>${escapeHtml(row.detail)}</em>
    </li>`).join('')}</ul>
  </section>`;
}

function renderTaskTimeline(task) {
  if (!task) {
    return `<div class="task-focus empty"><strong>대기 중</strong><span>최근 Core 작업 없음</span></div>`;
  }
  const lifecycle = (task.lifecycle ?? []).slice(-4);
  return `<div class="task-focus ${liveStatusClass(task.status)}">
    <header>
      <div><span>${escapeHtml(task.taskId)}</span><strong>${escapeHtml(task.title ?? task.plan?.title ?? 'Core Task')}</strong></div>
      <b>${escapeHtml(task.status ?? 'created')}</b>
    </header>
    <dl>
      <div><dt>Action</dt><dd>${escapeHtml(task.actionType ?? task.plan?.action?.actionType ?? 'planned')}</dd></div>
      <div><dt>Tool</dt><dd>${escapeHtml(task.toolName ?? task.plan?.action?.toolName ?? 'router')}</dd></div>
      <div><dt>Risk</dt><dd>${escapeHtml(task.riskTier ?? task.approvalCard?.riskTier ?? 'n/a')}</dd></div>
    </dl>
    ${task.queue ? `<small>Queue: ${escapeHtml(task.queue.status ?? 'queued')}</small>` : ''}
    ${lifecycle.length
      ? `<ol>${lifecycle.map((item) => `<li><span>${escapeHtml(item.status)}</span><strong>${escapeHtml(item.label ?? item.reason ?? 'event')}</strong><em>${formatShortTime(item.at)}</em></li>`).join('')}</ol>`
      : '<small>Lifecycle pending</small>'}
  </div>`;
}

function renderTaskList() {
  const tasks = controlCenter.coreTasks.slice(-5).reverse();
  if (!tasks.length) return '<ul class="live-task-list"><li><strong>작업 없음</strong><em>Core queue empty</em></li></ul>';
  return `<ul class="live-task-list">${tasks.map((task) => `<li>
    <span>${escapeHtml(task.status)}</span>
    <strong>${escapeHtml(task.title ?? task.taskId)}</strong>
    <em>${escapeHtml(task.actionType ?? task.toolName ?? task.taskId)}</em>
  </li>`).join('')}</ul>`;
}

function renderActivityFeed() {
  return `<ul class="activity-feed">${controlCenter.activity
    .map((item) => `<li class="${escapeHtml(item.tone)}"><time>${formatShortTime(item.at)}</time><strong>${escapeHtml(item.source)}</strong><span>${escapeHtml(item.message)}</span></li>`)
    .join('')}</ul>`;
}

function renderLiveOperations() {
  const coreStatus = controlCenter.coreHealth?.status ?? (controlCenter.lastRefreshAt ? 'offline' : 'checking');
  const pcStatus = controlCenter.pcHealth?.status ?? (controlCenter.lastRefreshAt ? 'offline' : 'checking');
  const daemonStatus = controlCenter.workerDaemon?.status ?? 'offline';
  const pcRuntimeStatus = controlCenter.pcRuntime?.status ?? controlCenter.pcRuntime?.supervisor?.status ?? 'offline';
  const activeTask = controlCenter.activeTask ?? controlCenter.coreTasks.at(-1) ?? null;
  const queueTotal = controlCenter.workerQueue?.total ?? controlCenter.workerQueue?.queued ?? 0;
  const pcQueued = controlCenter.pcQueue?.queued ?? controlCenter.pcQueue?.total ?? 0;
  return `<section class="live-ops" aria-label="JARVIS live control center">
    <div class="live-header">
      <div>
        <span>CONTROL CENTER</span>
        <strong>${escapeHtml(controlCenter.lastError ? 'LOCAL SERVICES DEGRADED' : 'LOCAL SERVICES')}</strong>
        <em>${controlCenter.lastRefreshAt ? `SYNC ${formatShortTime(controlCenter.lastRefreshAt)}` : 'SYNC 대기'}</em>
      </div>
      <menu>
        <button type="button" data-refresh-live ${controlCenter.refreshing ? 'disabled' : ''}>새로고침</button>
        <button type="button" data-core-daemon-tick>Daemon Tick</button>
      </menu>
    </div>
    <div class="live-command-row">
      ${renderCommandOpsPanel()}
    </div>
    <div class="service-grid">
      ${renderServiceCard('Core Runtime', coreStatus, `uptime ${formatDuration(controlCenter.coreHealth?.metrics?.uptimeMs ?? 0)}`, controlCenter.coreHealth?.module)}
      ${renderServiceCard('Core Worker', daemonStatus, `processed ${controlCenter.workerDaemon?.processedTotal ?? 0}`, `queue ${queueTotal}`)}
      ${renderServiceCard('PC Agent', pcStatus, controlCenter.pcHealth?.module ?? 'B_LOCAL_PC_AGENT', controlCenter.pcBaseUrl)}
      ${renderServiceCard('PC Service', pcRuntimeStatus, `processed ${controlCenter.pcRuntime?.processedTotal ?? 0}`, `queue ${pcQueued}`)}
    </div>
    <div class="live-grid">
      <div class="live-primary">
        ${renderTaskTimeline(activeTask)}
      </div>
      <div class="live-secondary">
        <section>
          <header><strong>최근 작업</strong><span>${controlCenter.coreTasks.length}</span></header>
          ${renderTaskList()}
        </section>
        <section>
          <header><strong>Activity</strong><span>${controlCenter.refreshing ? 'SYNC' : 'IDLE'}</span></header>
          ${renderActivityFeed()}
        </section>
      </div>
      <div class="live-config">
        <details class="settings-drawer">
          <summary>연결 설정</summary>
          ${renderLiveSettings()}
        </details>
        ${renderServiceUpdatePanel()}
        ${controlCenter.lastError ? `<p class="live-error">${escapeHtml(controlCenter.lastError)}</p>` : ''}
      </div>
    </div>
  </section>`;
}

function renderCommandConsole() {
  return `<form class="command-console" id="command-console">
    <div class="console-head">
      <label for="command-input">명령 입력</label>
      <button type="button" class="${elevatedMode ? 'mode active' : 'mode'}" data-toggle-elevated>${elevatedMode ? '관리자 승인' : '일반 모드'}</button>
    </div>
    <div>
      <input id="command-input" name="command" value="${escapeHtml(state.command)}" autocomplete="off" aria-label="명령 입력" placeholder="명령을 입력하거나 제안 버튼을 선택" />
      <button type="submit" ${controlCenter.commandBusy ? 'disabled' : ''}>${controlCenter.commandBusy ? '처리 중' : '실행'}</button>
    </div>
    <div class="suggestions">${state.commandSuggestions
      .map((command) => `<button type="button" data-command="${escapeHtml(command)}">${escapeHtml(command)}</button>`)
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
      ${blockers.length === 0 && watches.length === 0 ? '<p><b>OK</b>모든 gate 통과</p>' : ''}
    </div>
  </div>`;
}

function renderConsoleCore() {
  const dots = Array.from({ length: 12 }, (_, index) => `<span class="${index < Math.round(state.progress / 9) ? 'on' : ''}"></span>`).join('');
  return `<section class="console-core" aria-label="현재 작업 진행률" style="--progress:${state.progress * 3.6}deg">
    <div class="rings"><div class="inner-ring">
      <small>ACTIVE OPERATION</small>
      <h1>${escapeHtml(state.commandProfile.title)}</h1>
      <p>PROGRESS</p>
      <strong>${state.progress}%</strong>
      <div class="progress-dots">${dots}</div>
      <p>ETA</p>
      <time>${state.eta}</time>
    </div></div>
    <div class="core-stats">
      <span><em>MODE</em><strong>${escapeHtml(state.plan.mode)}</strong></span>
      <span><em>RISK</em><strong>${escapeHtml(state.plan.risk)}</strong></span>
      <span><em>GATE</em><strong>${escapeHtml(state.readiness.status)}</strong></span>
    </div>
    <div class="route-card"><b>↗</b><div><span>현재 경로</span><strong>${state.route.distanceM}m</strong><span>${escapeHtml(state.route.instruction)}</span></div></div>
  </section>`;
}

function renderCommandOpsPanel() {
  const activeStep = state.workflow.find((item) => item.status === 'active') ?? state.workflow.at(0);
  return `<div class="command-ops-panel">
    ${renderCommandConsole()}
    <div class="command-status-strip">
      <span><em>현재 단계</em><strong>${escapeHtml(activeStep?.label ?? '대기')}</strong></span>
      <span><em>권한</em><strong>${escapeHtml(state.approval.status)}</strong></span>
      <span><em>준비도</em><strong>${escapeHtml(state.readiness.status)}</strong></span>
    </div>
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
  return {
    id: element.id || null,
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
  const element = snapshot.id
    ? document.getElementById(snapshot.id)
    : candidates.find((candidate) => candidate.getAttribute('name') === snapshot.name && candidate.tagName === snapshot.tagName);
  if (!element) return;
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

function render({ preserveScroll = false } = {}) {
  const scrollTop = globalThis.scrollY ?? 0;
  const focusedField = preserveScroll ? captureFocusedField() : null;
  app.innerHTML = `<div class="shell practical-shell">
  <nav class="topbar">
    <strong>JARVIS<span>Control Center</span></strong>
    <div class="compass"><span>A-Core</span><span>B-Local</span><span>C-Mobile</span><span>D-Bridge</span><span>E-G Guard</span></div>
    <div class="system"><span>LOCAL</span><span>${controlCenter.lastError ? 'SYNC WARN' : 'SECURE 98%'}</span><time>${currentTimeLabel()}</time></div>
  </nav>
  <div class="meta"><span>LOCATION · ${state.location}</span><span>ALTITUDE <strong>${state.altitudeM}m</strong></span></div>
  ${renderModuleTelemetry(state.moduleTelemetry)}
  ${renderLiveOperations()}
  <main class="operator-workbench" aria-label="JARVIS 실용 작업대">
    <aside class="workbench-left">
      ${panel('운영 상태', '01', renderOperationalSummary())}
      ${panel('워크플로우', '02', renderWorkflow(state.workflow))}
      ${panel('오늘 일정', '03', renderTodayOpsPanel())}
    </aside>
    <section class="workbench-center">
      ${renderConsoleCore()}
      ${renderQuickActionBoard()}
    </section>
    <aside class="workbench-right">
      ${panel('승인 / PC 확인', '04', renderApprovalWorkbench(), 'pc-console-panel')}
      ${panel('A-G 진행', '05', renderDocumentStreams(state.documentStreams), 'doc-panel')}
      ${panel('실행 계획', '06', renderPlan(state.plan), 'compact')}
      ${panel('연결 / 기록', '07', renderCompactSignals(), 'compact')}
    </aside>
  </main>
  ${renderOperatorDock()}
</div>`;
  restoreFocusedField(focusedField);
  window.scrollTo({ top: preserveScroll ? scrollTop : 0, left: 0 });
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
    return;
  }
  state = withPcConsoleEvidence(state, {
    mode: 'bridge-fetch',
    synced: false,
    error: queue?.error?.code ?? 'C_PC_CONSOLE_FETCH_FAILED'
  });
  render();
}

app.addEventListener('submit', (event) => {
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
  if (event.target.closest('[data-refresh-live]')) {
    await refreshLiveState();
    return;
  }
  if (event.target.closest('[data-core-daemon-tick]')) {
    await tickCoreDaemon();
    await refreshLiveState({ silent: true });
    return;
  }
  if (event.target.closest('[data-toggle-elevated]')) {
    elevatedMode = !elevatedMode;
    state = composeState(state.command);
    render();
    return;
  }
  const pcHandoffTrigger = event.target.closest('[data-pc-handoff-decision]');
  if (pcHandoffTrigger) {
    if (pcConsoleBridgeClient) {
      const result = await pcConsoleBridgeClient.decide(pcHandoffTrigger.dataset.handoffId, {
        decision: pcHandoffTrigger.dataset.pcHandoffDecision,
        operatorId: 'pc-hud-operator'
      });
      if (result?.success) {
        await syncPcConsoleFromBridge();
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

render();
syncPcConsoleFromBridge();
refreshLiveState({ silent: true });
setInterval(updateClock, 30_000);
setInterval(() => refreshLiveState({ silent: true }), 15_000);
