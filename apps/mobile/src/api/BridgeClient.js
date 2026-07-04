export const defaultBridgeClientTimeoutMs = 30000;
export const bridgeClientGeneratedTypesVersion = 'd-bridge-openapi-client-types-v1';

export class BridgeClient {
  constructor({
    bridgeUrl,
    tokenProvider = () => null,
    fetchImpl = fetch,
    timeoutMs = defaultBridgeClientTimeoutMs,
    retries = 1,
    retryDelayMs = 250,
    tokenRefresher = null,
    onTokenRefresh = null
  } = {}) {
    this.bridgeUrl = bridgeUrl?.replace(/\/$/, '') ?? 'http://127.0.0.1:17777';
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.tokenRefresher = tokenRefresher;
    this.onTokenRefresh = onTokenRefresh;
    this.lastAuthRefresh = null;
  }

  async request(path, {
    method = 'GET',
    body,
    auth = true,
    timeoutMs = this.timeoutMs,
    retries = null,
    retryDelayMs = this.retryDelayMs,
    retryUnsafe = false,
    signal = null
  } = {}) {
    const normalizedMethod = method.toUpperCase();
    const maxRetries = retries ?? (isSafeRetryMethod(normalizedMethod) || retryUnsafe ? this.retries : 0);
    const url = `${this.bridgeUrl}${path}`;
    const startedAt = Date.now();
    let lastFailure = null;
    let authRefreshes = 0;
    let retryAttempts = 0;

    for (let attempt = 0; attempt <= maxRetries + 1; attempt += 1) {
      const token = await this.currentToken();
      const controller = typeof AbortController !== 'undefined' && (timeoutMs > 0 || signal)
        ? new AbortController()
        : null;
      let timeoutFired = false;
      const timeout = controller && timeoutMs > 0
        ? setTimeout(() => {
          timeoutFired = true;
          controller.abort();
        }, timeoutMs)
        : null;
      const externalAbort = controller && signal
        ? () => controller.abort(signal.reason ?? new Error('Bridge request cancelled.'))
        : null;
      if (externalAbort) {
        if (signal.aborted) externalAbort();
        else signal.addEventListener('abort', externalAbort, { once: true });
      }
      try {
        const response = await this.fetchImpl(url, {
          method: normalizedMethod,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(auth && token ? { authorization: `Bearer ${token}` } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          ...(controller ? { signal: controller.signal } : {})
        });
        if (timeout) clearTimeout(timeout);
        if (externalAbort) signal.removeEventListener('abort', externalAbort);
        const payload = await parseJsonResponse(response, {
          bridgeUrl: this.bridgeUrl,
          path,
          method: normalizedMethod,
          attempt,
          timeoutMs
        });
        const status = response?.status ?? 200;
        const ok = response?.ok ?? status < 400;
        if (!ok) {
          const failure = normalizeHttpFailure(payload, {
            bridgeUrl: this.bridgeUrl,
            path,
            method: normalizedMethod,
            status,
            attempts: attempt + 1,
            startedAt,
            timeoutMs
          });
          if (status >= 500 && attempt < maxRetries) {
            lastFailure = failure;
            retryAttempts += 1;
            await delay(retryDelayMs * (attempt + 1));
            continue;
          }
          if (auth && shouldRefreshAuthFailure(failure, status) && authRefreshes < 1) {
            const refreshed = await this.refreshAuthToken({
              failure,
              path,
              method: normalizedMethod,
              status,
              attempt: attempt + 1
            });
            if (refreshed.success) {
              authRefreshes += 1;
              lastFailure = failure;
              continue;
            }
          }
          return failure;
        }
        return withClientMeta(payload, {
          authRefreshes,
          retryAttempts
        });
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        if (externalAbort) signal.removeEventListener('abort', externalAbort);
        const failure = normalizeClientFailure(error, {
          bridgeUrl: this.bridgeUrl,
          path,
          method: normalizedMethod,
          attempts: attempt + 1,
          startedAt,
          timeoutMs,
          cancelled: signal?.aborted === true && timeoutFired !== true
        });
        lastFailure = failure;
        if (attempt < maxRetries) {
          retryAttempts += 1;
          await delay(retryDelayMs * (attempt + 1));
          continue;
        }
        return failure;
      }
    }
    return lastFailure ?? normalizeClientFailure(new Error('Bridge request failed.'), {
      bridgeUrl: this.bridgeUrl,
      path,
      method: normalizedMethod,
      attempts: maxRetries + 1,
      startedAt,
      timeoutMs
    });
  }

  async currentToken() {
    return typeof this.tokenProvider === 'function' ? await this.tokenProvider() : null;
  }

  async refreshAuthToken(context = {}) {
    const startedAt = Date.now();
    if (typeof this.tokenRefresher !== 'function') {
      this.lastAuthRefresh = {
        refreshVersion: 'c-bridge-client-auth-refresh-v1',
        success: false,
        reason: 'token-refresher-not-configured',
        durationMs: 0
      };
      return this.lastAuthRefresh;
    }
    try {
      const refreshed = await this.tokenRefresher(context);
      const nextToken = typeof refreshed === 'string'
        ? refreshed
        : refreshed?.deviceToken ?? refreshed?.token ?? null;
      if (nextToken && typeof this.onTokenRefresh === 'function') {
        await this.onTokenRefresh(nextToken, refreshed);
      }
      this.lastAuthRefresh = {
        refreshVersion: 'c-bridge-client-auth-refresh-v1',
        success: Boolean(nextToken),
        tokenUpdated: Boolean(nextToken),
        reason: context.failure?.error?.code ?? null,
        durationMs: Date.now() - startedAt
      };
      return {
        ...this.lastAuthRefresh,
        token: nextToken
      };
    } catch (error) {
      this.lastAuthRefresh = {
        refreshVersion: 'c-bridge-client-auth-refresh-v1',
        success: false,
        tokenUpdated: false,
        reason: error?.message ?? 'token-refresh-failed',
        durationMs: Date.now() - startedAt
      };
      return this.lastAuthRefresh;
    }
  }

  createCancelableRequest(path, options = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const cancelState = {
      cancelVersion: 'c-bridge-request-cancel-ux-v1',
      cancellable: Boolean(controller),
      cancelled: false,
      reason: null,
      userMessage: null
    };
    const promise = this.request(path, {
      ...options,
      signal: controller?.signal ?? options.signal ?? null
    }).then((result) => {
      if (result?.error?.code === 'C_BRIDGE_REQUEST_CANCELLED') {
        cancelState.userMessage = result.friendlyError?.userMessage ?? null;
      }
      return result;
    });
    return {
      cancelVersion: 'c-bridge-request-cancel-ux-v1',
      promise,
      signal: controller?.signal ?? null,
      cancelState,
      cancel(reason = 'user_cancelled') {
        if (!controller || cancelState.cancelled) return cancelState;
        cancelState.cancelled = true;
        cancelState.reason = reason;
        controller.abort(new Error(reason));
        return cancelState;
      }
    };
  }

  friendlyError(envelope) {
    return createBridgeFriendlyError(envelope);
  }

  productGate(evidence = {}) {
    return createBridgeClientProductGate({
      client: this,
      ...evidence
    });
  }

  getHealth() {
    return this.request('/health', { auth: false });
  }

  getServerProfile() {
    return this.request('/server/profile', { auth: false });
  }

  getDeploymentProfile() {
    return this.request('/server/deployment-profile', { auth: false });
  }

  getOpenApi() {
    return this.request('/openapi.json', { auth: false });
  }

  startPairing() {
    return this.request('/pairing/start', { method: 'POST', body: {}, auth: false });
  }

  confirmPairing(payload) {
    return this.request('/pairing/confirm', { method: 'POST', body: payload, auth: false });
  }

  runPairingReleaseDossier({ reason = 'mobile_requested_pairing_release_dossier' } = {}) {
    return this.request('/pairing/release-dossier', {
      method: 'POST',
      body: { reason }
    });
  }

  getDevices() {
    return this.request('/devices');
  }

  getDeviceInventory() {
    return this.request('/devices/inventory');
  }

  getDeviceTokenPolicy() {
    return this.request('/devices/token/policy');
  }

  revokeDevice(deviceId) {
    return this.request(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  }

  rotateDeviceToken({ reason = 'device_requested_rotation' } = {}) {
    return this.request('/devices/token/rotate', {
      method: 'POST',
      body: { reason }
    });
  }

  runDeviceTokenRotationDrill({ nextSecret } = {}) {
    return this.request('/devices/token/rotation-drill', {
      method: 'POST',
      body: nextSecret ? { nextSecret } : {}
    });
  }

  runDeviceTokenReleaseDossier({ nextSecret, reason = 'mobile_requested_device_token_release_dossier' } = {}) {
    return this.request('/devices/token/release-dossier', {
      method: 'POST',
      body: {
        ...(nextSecret ? { nextSecret } : {}),
        reason
      }
    });
  }

  getRequestNoncePolicy() {
    return this.request('/request-nonces/policy');
  }

  compactRequestNonces({ dryRun = true, reason = 'mobile_nonce_compaction' } = {}) {
    return this.request('/request-nonces/compact', {
      method: 'POST',
      body: { dryRun, reason }
    });
  }

  getRequestNonceClockSkewFixtures() {
    return this.request('/request-nonces/clock-skew-fixtures');
  }

  runRequestNonceProductGate({ drillRequestId } = {}) {
    return this.request('/request-nonces/product-gate', {
      method: 'POST',
      body: drillRequestId ? { drillRequestId } : {}
    });
  }

  runRequestNonceReleaseDossier({
    drillRequestId,
    reason = 'mobile_requested_request_nonce_release_dossier'
  } = {}) {
    return this.request('/request-nonces/release-dossier', {
      method: 'POST',
      body: {
        ...(drillRequestId ? { drillRequestId } : {}),
        reason
      }
    });
  }

  heartbeat() {
    return this.request('/connection/heartbeat', { method: 'POST', body: {} });
  }

  getRateLimitStatus() {
    return this.request('/rate-limit/status');
  }

  getRateLimitAbuseCorpus() {
    return this.request('/rate-limit/abuse-corpus');
  }

  runRateLimitProductGate() {
    return this.request('/rate-limit/product-gate', { method: 'POST', body: {} });
  }

  runRateLimitReleaseDossier({ reason = 'mobile_requested_rate_limit_release_dossier' } = {}) {
    return this.request('/rate-limit/release-dossier', {
      method: 'POST',
      body: { reason }
    });
  }

  runTaskApprovalResultReleaseDossier({ reason = 'mobile_requested_task_approval_result_release_dossier' } = {}) {
    return this.request('/task-approval-result/release-dossier', {
      method: 'POST',
      body: { reason }
    });
  }

  createTask(taskRequest) {
    return this.request('/tasks', { method: 'POST', body: taskRequest });
  }

  getTasks(status) {
    return this.request(status ? `/tasks?status=${encodeURIComponent(status)}` : '/tasks');
  }

  getTaskStatus(taskId) {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`);
  }

  getApprovals() {
    return this.request('/approvals');
  }

  getApproval(approvalId) {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}`);
  }

  getApprovalHistory(approvalId) {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}/history`);
  }

  sendApprovalDecision(approvalId, decision) {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: 'POST',
      body: decision
    });
  }

  renewApproval(approvalId) {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}/renew`, {
      method: 'POST',
      body: {}
    });
  }

  requestPcConfirmation(approvalId, { reason = 'mobile_requires_pc_confirmation' } = {}) {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}/pc-handoff`, {
      method: 'POST',
      body: { reason }
    });
  }

  cancelApproval(approvalId, { reason = 'mobile_cancelled' } = {}) {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}/cancel`, {
      method: 'POST',
      body: { reason }
    });
  }

  reRequestApproval(approvalId, { reason = 'mobile_re_request' } = {}) {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}/re-request`, {
      method: 'POST',
      body: { reason }
    });
  }

  confirmExecution(handoffId) {
    return this.request(`/execution-handoffs/${encodeURIComponent(handoffId)}/confirm`, {
      method: 'POST',
      body: {}
    });
  }

  getResult(taskId) {
    return this.request(`/results/${encodeURIComponent(taskId)}`);
  }

  rollbackResult(taskId, payload = {}) {
    return this.request(`/results/${encodeURIComponent(taskId)}/rollback`, {
      method: 'POST',
      body: payload
    });
  }

  getPoisonPackets({ includeIgnored = false } = {}) {
    const query = includeIgnored ? '?includeIgnored=true' : '';
    return this.request(`/pc-agent/poison-packets${query}`);
  }

  getQueuePolicy() {
    return this.request('/pc-agent/queue-policy');
  }

  drainPcAgentQueue(payload = {}) {
    return this.request('/pc-agent/queue/drain', {
      method: 'POST',
      body: payload
    });
  }

  updateQueuePolicy(payload = {}) {
    return this.request('/pc-agent/queue-policy', {
      method: 'POST',
      body: payload
    });
  }

  reviewPoisonPacket(queueId, payload = {}) {
    return this.request(`/pc-agent/poison-packets/${encodeURIComponent(queueId)}/review`, {
      method: 'POST',
      body: payload
    });
  }

  requeuePoisonPacket(queueId, payload = {}) {
    return this.request(`/pc-agent/poison-packets/${encodeURIComponent(queueId)}/requeue`, {
      method: 'POST',
      body: payload
    });
  }

  ignorePoisonPacket(queueId, payload = {}) {
    return this.request(`/pc-agent/poison-packets/${encodeURIComponent(queueId)}/ignore`, {
      method: 'POST',
      body: payload
    });
  }

  getPcConfirmationHandoffs(status) {
    return this.request(status
      ? `/pc-console/approval-handoffs?status=${encodeURIComponent(status)}`
      : '/pc-console/approval-handoffs');
  }

  decidePcConfirmationHandoff(handoffId, payload = {}) {
    return this.request(`/pc-console/approval-handoffs/${encodeURIComponent(handoffId)}/decision`, {
      method: 'POST',
      body: payload
    });
  }

  sendFeedback(feedback) {
    return this.request('/feedback', { method: 'POST', body: feedback });
  }

  getGrowthReview() {
    return this.request('/growth/review/latest');
  }

  getGrowthDecisionHistory({ routeName, kind, limit } = {}) {
    const params = new URLSearchParams();
    if (routeName) params.set('routeName', routeName);
    if (kind) params.set('kind', kind);
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return this.request(query ? `/growth/decisions/history?${query}` : '/growth/decisions/history');
  }

  getGrowthRoutingTrends({ windowMinutes } = {}) {
    const params = new URLSearchParams();
    if (windowMinutes) params.set('windowMinutes', String(windowMinutes));
    const query = params.toString();
    return this.request(query ? `/growth/decisions/trends?${query}` : '/growth/decisions/trends');
  }

  runGrowthRoutingReleaseDossier({ windowMinutes = 60, reason = 'mobile_requested_growth_routing_release_dossier' } = {}) {
    return this.request('/growth/routing/release-dossier', {
      method: 'POST',
      body: { windowMinutes, reason }
    });
  }

  decideGrowthPreference(hypothesisId, payload) {
    return this.request(`/growth/preferences/${encodeURIComponent(hypothesisId)}/decision`, {
      method: 'POST',
      body: payload
    });
  }

  decideGrowthHygiene(payload) {
    return this.request('/growth/hygiene/decisions', {
      method: 'POST',
      body: payload
    });
  }

  decideGrowthHygieneBatch(payload) {
    return this.request('/growth/hygiene/decisions/batch', {
      method: 'POST',
      body: payload
    });
  }

  getCacheSnapshot() {
    return this.request('/cache/snapshot');
  }

  getCacheSchemaSnapshot() {
    return this.request('/cache/schema-snapshot');
  }

  diffCacheSchema(baseline) {
    return this.request('/cache/schema-diff', {
      method: 'POST',
      body: { baseline }
    });
  }

  compactCache({ reason = 'mobile_requested_compaction' } = {}) {
    return this.request('/cache/compact', {
      method: 'POST',
      body: { reason }
    });
  }

  runCacheProductGate({ baseline = null, reason = 'mobile_requested_cache_product_gate', requireDurableExternalStore = false } = {}) {
    return this.request('/cache/product-gate', {
      method: 'POST',
      body: {
        ...(baseline ? { baseline } : {}),
        reason,
        requireDurableExternalStore
      }
    });
  }

  runCacheReleaseDossier({ baseline = null, reason = 'mobile_requested_cache_release_dossier', requireDurableExternalStore = false } = {}) {
    return this.request('/cache/release-dossier', {
      method: 'POST',
      body: {
        ...(baseline ? { baseline } : {}),
        reason,
        requireDurableExternalStore
      }
    });
  }

  getAuditSummary({ category, severity, cursor, limit } = {}) {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (severity) params.set('severity', severity);
    if (cursor !== undefined) params.set('cursor', String(cursor));
    if (limit !== undefined) params.set('limit', String(limit));
    const query = params.toString();
    return this.request(query ? `/audit/summary?${query}` : '/audit/summary');
  }

  exportAudit({ category, severity, cursor, limit, reason = 'mobile_requested_export' } = {}) {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (severity) params.set('severity', severity);
    if (cursor !== undefined) params.set('cursor', String(cursor));
    if (limit !== undefined) params.set('limit', String(limit));
    if (reason) params.set('reason', reason);
    const query = params.toString();
    return this.request(query ? `/audit/export?${query}` : '/audit/export');
  }

  exportAuditForSiem({ category, severity, cursor, limit, reason = 'mobile_requested_siem_export', format = 'both' } = {}) {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (severity) params.set('severity', severity);
    if (cursor !== undefined) params.set('cursor', String(cursor));
    if (limit !== undefined) params.set('limit', String(limit));
    if (reason) params.set('reason', reason);
    if (format) params.set('format', format);
    const query = params.toString();
    return this.request(query ? `/audit/siem-export?${query}` : '/audit/siem-export');
  }

  rotateAudit({ reason = 'mobile_requested_rotation' } = {}) {
    return this.request('/audit/rotate', {
      method: 'POST',
      body: { reason }
    });
  }

  runAuditRetention({ dryRun = true, reason = 'mobile_requested_audit_retention' } = {}) {
    return this.request('/audit/retention/run', {
      method: 'POST',
      body: { dryRun, reason }
    });
  }

  syncAuditArchive({ dryRun = true, targetDir, reason = 'mobile_requested_archive_sync' } = {}) {
    return this.request('/audit/archive/sync', {
      method: 'POST',
      body: { dryRun, targetDir, reason }
    });
  }

  runAuditArchiveRestoreDrill({ archivePath } = {}) {
    return this.request('/audit/archive/restore-drill', {
      method: 'POST',
      body: { archivePath }
    });
  }

  runAuditProductGate() {
    return this.request('/audit/product-gate', {
      method: 'POST',
      body: {}
    });
  }

  runAuditReleaseDossier({ reason = 'mobile_requested_audit_release_dossier' } = {}) {
    return this.request('/audit/release-dossier', {
      method: 'POST',
      body: { reason }
    });
  }

  getEvents({ sinceEventId, eventType } = {}) {
    const params = new URLSearchParams();
    if (sinceEventId) params.set('sinceEventId', sinceEventId);
    if (eventType) params.set('eventType', eventType);
    const query = params.toString();
    return this.request(query ? `/events?${query}` : '/events');
  }

  acknowledgeEvent(eventId, { streamId } = {}) {
    return this.request('/events/ack', {
      method: 'POST',
      body: { eventId, streamId }
    });
  }

  getEventStreamStatus() {
    return this.request('/events/stream/status');
  }

  getEventReconnectPlan({ sinceEventId, eventType, attempt = 0, lastError } = {}) {
    const params = new URLSearchParams();
    if (sinceEventId) params.set('sinceEventId', sinceEventId);
    if (eventType) params.set('eventType', eventType);
    if (Number.isFinite(Number(attempt))) params.set('attempt', String(attempt));
    if (lastError) params.set('lastError', lastError);
    const query = params.toString();
    return this.request(query ? `/events/reconnect-plan?${query}` : '/events/reconnect-plan');
  }

  getEventFallbackUxContract() {
    return this.request('/events/fallback-ux');
  }

  compactEventCursors({ keepLast = 50, dryRun = true, reason = 'mobile_requested_event_cursor_compaction' } = {}) {
    return this.request('/events/cursors/compact', {
      method: 'POST',
      body: { keepLast, dryRun, reason }
    });
  }

  runEventChaosDrill({ cycles = 3 } = {}) {
    return this.request('/events/chaos-drill', {
      method: 'POST',
      body: { cycles }
    });
  }

  runEventStreamProductGate({ cycles = 3 } = {}) {
    return this.request('/events/product-gate', {
      method: 'POST',
      body: { cycles }
    });
  }

  runEventStreamReleaseDossier({ cycles = 3, reason = 'mobile_requested_event_release_dossier' } = {}) {
    return this.request('/events/release-dossier', {
      method: 'POST',
      body: { cycles, reason }
    });
  }

  eventStreamUrl({ sinceEventId, eventType } = {}) {
    const params = new URLSearchParams();
    const token = this.tokenProvider();
    if (token) params.set('token', token);
    if (sinceEventId) params.set('sinceEventId', sinceEventId);
    if (eventType) params.set('eventType', eventType);
    return `${this.bridgeUrl}/events/stream?${params.toString()}`;
  }

  eventWebSocketUrl({ sinceEventId, eventType } = {}) {
    const token = this.tokenProvider();
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (sinceEventId) params.set('sinceEventId', sinceEventId);
    if (eventType) params.set('eventType', eventType);
    const webSocketBaseUrl = this.bridgeUrl
      .replace(/^https:/i, 'wss:')
      .replace(/^http:/i, 'ws:');
    return `${webSocketBaseUrl}/events/ws?${params.toString()}`;
  }
}

function isSafeRetryMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

async function parseJsonResponse(response, context) {
  try {
    if (typeof response?.text === 'function') {
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }
    if (typeof response?.json === 'function') {
      return await response.json();
    }
    return {};
  } catch (error) {
    return normalizeClientFailure(error, {
      ...context,
      code: 'C_BRIDGE_INVALID_JSON',
      message: 'Bridge returned a non-JSON response.'
    });
  }
}

function normalizeHttpFailure(payload, context) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const error = {
    code: base.error?.code ?? `D_HTTP_${context.status}`,
    message: base.error?.message ?? `Bridge returned HTTP ${context.status}.`
  };
  return {
    ...base,
    success: false,
    statusCode: base.statusCode ?? context.status,
    error,
    friendlyError: createBridgeFriendlyError({ error, statusCode: base.statusCode ?? context.status }),
    client: clientMeta(context)
  };
}

function normalizeClientFailure(error, context) {
  const isAbort = error?.name === 'AbortError';
  const isCancelled = context.cancelled === true;
  const code = context.code ?? (isAbort
    ? isCancelled ? 'C_BRIDGE_REQUEST_CANCELLED' : 'C_BRIDGE_TIMEOUT'
    : 'C_BRIDGE_NETWORK_ERROR');
  const message = context.message
    ?? (isAbort
      ? isCancelled ? 'Bridge request was cancelled before completion.' : `Bridge request timed out after ${context.timeoutMs}ms.`
      : error?.message ?? 'Bridge network request failed.');
  const envelope = { error: { code, message }, statusCode: 0 };
  return {
    success: false,
    statusCode: 0,
    error: envelope.error,
    friendlyError: createBridgeFriendlyError(envelope),
    client: clientMeta(context)
  };
}

function clientMeta({ bridgeUrl, path, method, status = null, attempts = 1, startedAt, timeoutMs }) {
  return {
    bridgeUrl,
    path,
    method,
    status,
    attempts,
    retried: attempts > 1,
    timeoutMs,
    durationMs: startedAt ? Date.now() - startedAt : null
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRefreshAuthFailure(failure, status) {
  const code = failure?.error?.code;
  return status === 401 || code === 'D_AUTH_INVALID_TOKEN' || code === 'D_HTTP_401';
}

function withClientMeta(payload, meta) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    client: {
      ...(payload.client ?? {}),
      authRefreshes: meta.authRefreshes,
      retryAttempts: meta.retryAttempts
    }
  };
}

export function createBridgeFriendlyError(envelope = {}) {
  const code = envelope?.error?.code ?? 'UNKNOWN';
  const statusCode = envelope?.statusCode ?? null;
  const table = {
    C_BRIDGE_TIMEOUT: {
      category: 'network_timeout',
      retryable: true,
      severity: 'warning',
      userMessage: '브릿지 응답이 지연되고 있어요. 잠시 후 다시 시도하세요.',
      actionLabel: '다시 시도'
    },
    C_BRIDGE_REQUEST_CANCELLED: {
      category: 'cancelled',
      retryable: false,
      severity: 'info',
      userMessage: '요청을 취소했어요.',
      actionLabel: '닫기'
    },
    C_BRIDGE_NETWORK_ERROR: {
      category: 'network_unreachable',
      retryable: true,
      severity: 'warning',
      userMessage: '브릿지에 연결할 수 없어요. 같은 네트워크인지 확인하세요.',
      actionLabel: '연결 확인'
    },
    C_BRIDGE_INVALID_JSON: {
      category: 'invalid_response',
      retryable: true,
      severity: 'error',
      userMessage: '브릿지 응답 형식이 올바르지 않아요.',
      actionLabel: '다시 시도'
    },
    D_AUTH_INVALID_TOKEN: {
      category: 'auth_expired',
      retryable: true,
      severity: 'warning',
      userMessage: '연결 인증이 만료됐어요. 다시 연결하세요.',
      actionLabel: '다시 페어링'
    },
    D_HTTP_401: {
      category: 'auth_expired',
      retryable: true,
      severity: 'warning',
      userMessage: '연결 인증이 만료됐어요. 다시 연결하세요.',
      actionLabel: '다시 페어링'
    },
    D_RATE_LIMITED: {
      category: 'rate_limited',
      retryable: true,
      severity: 'warning',
      userMessage: '요청이 너무 많아요. 잠시 후 다시 시도하세요.',
      actionLabel: '잠시 후 재시도'
    },
    D_REQUEST_REPLAY_BLOCKED: {
      category: 'duplicate_request',
      retryable: false,
      severity: 'info',
      userMessage: '이미 처리된 요청이라 다시 보내지 않았어요.',
      actionLabel: '확인'
    }
  };
  const fallback = statusCode >= 500
    ? {
      category: 'server_error',
      retryable: true,
      severity: 'error',
      userMessage: '브릿지 서버 오류가 발생했어요.',
      actionLabel: '다시 시도'
    }
    : {
      category: 'unknown',
      retryable: false,
      severity: 'error',
      userMessage: envelope?.error?.message ?? '요청을 처리하지 못했어요.',
      actionLabel: '확인'
    };
  return {
    taxonomyVersion: 'c-bridge-friendly-error-taxonomy-v1',
    code,
    statusCode,
    ...(table[code] ?? fallback)
  };
}

export function createBridgeClientProductGate({
  client,
  authRefreshResult = null,
  cancelResult = null,
  friendlyErrors = []
} = {}) {
  const releaseDossier = createBridgeClientReleaseDossier({
    client,
    authRefreshResult,
    cancelResult,
    friendlyErrors
  });
  const checks = [
    {
      checkId: 'auth_refresh_contract',
      status: (authRefreshResult?.refreshVersion ?? client?.lastAuthRefresh?.refreshVersion) === 'c-bridge-client-auth-refresh-v1'
        && (authRefreshResult?.success ?? client?.lastAuthRefresh?.success) === true ? 'passed' : 'blocked'
    },
    {
      checkId: 'request_cancel_ux_contract',
      status: cancelResult?.friendlyError?.taxonomyVersion === 'c-bridge-friendly-error-taxonomy-v1'
        && cancelResult?.error?.code === 'C_BRIDGE_REQUEST_CANCELLED' ? 'passed' : 'blocked'
    },
    {
      checkId: 'friendly_error_taxonomy',
      status: friendlyErrors.length >= 3 && friendlyErrors.every((item) => item.taxonomyVersion === 'c-bridge-friendly-error-taxonomy-v1') ? 'passed' : 'blocked',
      categories: friendlyErrors.map((item) => item.category)
    },
    {
      checkId: 'default_timeout_contract',
      status: client?.timeoutMs === defaultBridgeClientTimeoutMs ? 'passed' : 'blocked',
      timeoutMs: client?.timeoutMs ?? null
    },
    {
      checkId: 'generated_types_contract',
      status: bridgeClientGeneratedTypesVersion === 'd-bridge-openapi-client-types-v1' ? 'passed' : 'blocked'
    },
    {
      checkId: 'bridge_client_release_dossier_ready',
      status: releaseDossier.status === 'passed' && releaseDossier.dossierDigest.length === 64 ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    }
  ];
  return {
    productGateVersion: 'c-bridge-client-product-gate-v1',
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier.dossierVersion,
      status: releaseDossier.status,
      dossierDigest: releaseDossier.dossierDigest
    }
  };
}

export function createBridgeClientReleaseDossier({
  client,
  authRefreshResult = null,
  cancelResult = null,
  friendlyErrors = []
} = {}) {
  const authRefresh = authRefreshResult ?? client?.lastAuthRefresh ?? null;
  const releaseChecks = [
    {
      checkId: 'bridge_client_auth_refresh_ready',
      passed: authRefresh?.refreshVersion === 'c-bridge-client-auth-refresh-v1'
        && authRefresh.success === true
        && authRefresh.tokenUpdated === true,
      reason: authRefresh?.reason ?? null
    },
    {
      checkId: 'bridge_client_cancel_ux_ready',
      passed: cancelResult?.error?.code === 'C_BRIDGE_REQUEST_CANCELLED'
        && cancelResult?.friendlyError?.taxonomyVersion === 'c-bridge-friendly-error-taxonomy-v1'
        && cancelResult?.friendlyError?.category === 'cancelled',
      userMessage: cancelResult?.friendlyError?.userMessage ?? null
    },
    {
      checkId: 'bridge_client_friendly_error_taxonomy_ready',
      passed: friendlyErrors.length >= 3
        && friendlyErrors.every((item) => item.taxonomyVersion === 'c-bridge-friendly-error-taxonomy-v1')
        && friendlyErrors.every((item) => item.userMessage && item.actionLabel),
      categories: friendlyErrors.map((item) => item.category)
    },
    {
      checkId: 'bridge_client_timeout_retry_policy_ready',
      passed: client?.timeoutMs === defaultBridgeClientTimeoutMs
        && Number.isInteger(client?.retries)
        && client.retries >= 0
        && client.retryDelayMs >= 0,
      timeoutMs: client?.timeoutMs ?? null,
      retries: client?.retries ?? null,
      retryDelayMs: client?.retryDelayMs ?? null
    },
    {
      checkId: 'bridge_client_generated_types_ready',
      passed: bridgeClientGeneratedTypesVersion === 'd-bridge-openapi-client-types-v1',
      generatedTypesVersion: bridgeClientGeneratedTypesVersion
    }
  ];
  const dossier = {
    dossierVersion: 'c-bridge-client-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status: releaseChecks.every((check) => check.passed) ? 'passed' : 'blocked',
    clientContract: {
      bridgeUrl: client?.bridgeUrl ?? null,
      timeoutMs: client?.timeoutMs ?? null,
      retries: client?.retries ?? null,
      retryDelayMs: client?.retryDelayMs ?? null,
      generatedTypesVersion: bridgeClientGeneratedTypesVersion
    },
    authRefresh: {
      refreshVersion: authRefresh?.refreshVersion ?? null,
      success: authRefresh?.success === true,
      tokenUpdated: authRefresh?.tokenUpdated === true,
      reason: authRefresh?.reason ?? null
    },
    cancelUx: {
      cancelVersion: cancelResult?.cancelVersion ?? null,
      errorCode: cancelResult?.error?.code ?? null,
      friendlyCategory: cancelResult?.friendlyError?.category ?? null
    },
    friendlyErrors: friendlyErrors.map((item) => ({
      code: item.code,
      category: item.category,
      retryable: item.retryable,
      severity: item.severity,
      actionLabel: item.actionLabel
    })),
    releaseChecks,
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      ? 'run_live_bridge_e2e_with_token_refresh_and_cancelled_request_scenarios'
      : 'block_bridge_client_release_until_refresh_cancel_and_error_taxonomy_contracts_pass'
  };
  dossier.dossierDigest = stableDigest(canonicalJson(dossier));
  return dossier;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableDigest(value) {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }).join('').repeat(2).slice(0, 64);
}
