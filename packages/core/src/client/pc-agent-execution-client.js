export class PcAgentExecutionClient {
  constructor({
    baseUrl = 'http://127.0.0.1:17776',
    executionToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = 90_000
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('PcAgentExecutionClient requires fetchImpl.');
    }
    if (!String(executionToken ?? '').trim()) {
      const error = new Error('PC Agent execution delegation token is required.');
      error.code = 'A_PC_AGENT_EXECUTION_TOKEN_REQUIRED';
      throw error;
    }
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.executionToken = String(executionToken);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000;
  }

  supportsDurableMissionEffects() {
    const endpoint = new URL(this.baseUrl);
    return endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash;
  }

  async receiveExecutionPacket(packet, { dryRun = false, beforeLocalExecute = null } = {}) {
    if (beforeLocalExecute !== null) {
      if (dryRun || typeof beforeLocalExecute !== 'function') throw clientError('A_PC_REMOTE_EFFECT_HOOK_INVALID', 'A trusted Core effect hook is required.');
      const fence = await beforeLocalExecute(packet);
      if (typeof fence !== 'function') throw clientError('A_PC_REMOTE_EFFECT_FENCE_INVALID', 'The Core fence could not be obtained.');
      fence();
      const prepared = await this.prepareOperation(packet);
      await this.remoteOperationBoundary?.('remote-prepared', prepared);
      try { fence(); }
      catch (cause) {
        // Only a B-confirmed cancellation is evidence of no dispatch. A lost
        // cancellation response or an in-flight result stays uncertain.
        try {
          const cancellation = await this.cancelOperation({ operationId: packet.idempotencyKey, taskId: packet.taskId, action: packet.action });
          if (cancellation?.state === 'cancelled' && cancellation.cancellationConfirmed === true
            && cancellation.operationId === packet.idempotencyKey && cancellation.taskId === packet.taskId
            && cancellation.fingerprint === prepared?.fingerprint) {
            await fence.onRemoteCancellation?.(cancellation);
          }
        } catch { /* Preserve the original fence failure; reconciliation remains required. */ }
        throw cause;
      }
      if (prepared?.state === 'succeeded') return prepared.receipt;
      if (prepared?.state !== 'prepared' || !prepared.ticket) throw clientError('A_PC_REMOTE_EFFECT_UNRESOLVED', 'The remote operation is not dispatchable.');
      // No automatic retry of this POST. Lost responses are reconciled via readOperation.
      return await this.request('/operations/execute', { method: 'POST', body: { packet, ticket: prepared.ticket, generation: prepared.generation } });
    }
    return await this.request('/execution-packets', {
      method: 'POST',
      body: { packet, dryRun }
    });
  }

  async prepareOperation(packet) { return this.request('/operations/prepare', { method: 'POST', body: { packet } }); }
  async resumeWorkflowPublication(packet) { return this.request('/execution-packets/resume-workflow', { method: 'POST', body: { packet, dryRun: false } }); }
  async readOperation(input) { return this.request('/operations/read', { method: 'POST', body: input }); }
  async cancelOperation(input) { return this.request('/operations/cancel', { method: 'POST', body: input }); }
  async receiptForOperation(input) { const operation = await this.readOperation(input); return operation?.state === 'succeeded' ? operation.receipt : null; }

  async rollbackTask(taskId, { reason = 'core-worker-rollback' } = {}) {
    return await this.request(`/rollback/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      body: { reason }
    });
  }

  async rollbackPlan(taskId) {
    return await this.request(`/rollback/${encodeURIComponent(taskId)}/plan`);
  }

  async taskResult(taskId) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}`);
  }

  async taskSummaries(taskIds) { return this.request('/tasks/summaries',{method:'POST',body:{taskIds}}); }

  async taskSummary(taskId) { return this.request(`/tasks/${encodeURIComponent(taskId)}/summary`); }

  async taskPublication(taskId) { return this.request(`/tasks/${encodeURIComponent(taskId)}/publication`); }

  async health() {
    return await this.request('/health', { authenticated: false });
  }
  async emailReadiness() {
    if(!this.supportsDurableMissionEffects())throw clientError('A_PC_EMAIL_READINESS_ENDPOINT_UNSUPPORTED','Local authenticated PC readiness is required.');
    try{return await this.request('/email/readiness',{timeoutMs:4000,maxResponseBytes:16384});}
    catch(error){throw clientError(error?.code==='B_API_TOKEN_REQUIRED'?'A_PC_EMAIL_READINESS_AUTH_REQUIRED':'A_PC_EMAIL_READINESS_UNAVAILABLE','PC email readiness could not be observed.');}
  }

  async request(path, { method = 'GET', body = null, authenticated = true, timeoutMs=this.timeoutMs, maxResponseBytes=null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: 'application/json' };
      if (authenticated) headers.authorization = `Bearer ${this.executionToken}`;
      if (body !== null) headers['content-type'] = 'application/json';
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        // An execution POST must never be replayed at a redirect destination.
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await response.text();
      if(maxResponseBytes!==null&&Buffer.byteLength(raw)>maxResponseBytes)throw clientError('A_PC_AGENT_RESPONSE_TOO_LARGE','PC Agent response exceeds the bounded contract.');
      let payload = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          throw clientError('A_PC_AGENT_INVALID_JSON', 'PC Agent returned an invalid JSON response.', {
            status: response.status
          });
        }
      }
      if (!response.ok) {
        throw clientError(
          payload?.error?.code ?? `A_PC_AGENT_HTTP_${response.status}`,
          payload?.error?.message ?? payload?.message ?? `PC Agent request failed with HTTP ${response.status}.`,
          { status: response.status, details: sanitizeRemoteError(payload) }
        );
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw clientError('A_PC_AGENT_TIMEOUT', 'PC Agent execution timed out.', { timeoutMs: this.timeoutMs });
      }
      if (error?.code) throw error;
      throw clientError('A_PC_AGENT_UNREACHABLE', 'PC Agent execution service is unavailable.', {
        causeCode: error?.cause?.code ?? error?.name ?? null
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function clientError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sanitizeRemoteError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    success: payload.success,
    status: payload.status,
    error: payload.error ? {
      code: payload.error.code,
      message: payload.error.message,
      errors: payload.error.errors
    } : null
  };
}
