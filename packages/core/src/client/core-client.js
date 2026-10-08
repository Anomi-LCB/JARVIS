import { createHash } from 'node:crypto';

export class CoreClient {
  constructor({ baseUrl = 'http://127.0.0.1:17780', adminToken = null, integrationHandoffToken = null, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('CoreClient requires fetchImpl.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.adminToken = adminToken;
    this.integrationHandoffToken = integrationHandoffToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async health() {
    return await this.request('/health');
  }

  async openApi() {
    return await this.request('/openapi.json');
  }

  async adminDiagnostics() {
    return await this.request('/admin/diagnostics', { admin: true });
  }

  async integrationReadiness() {
    return await this.request('/integrations', { admin: true });
  }

  /** Evaluates one provider offer and registered local alternatives without executing either. */
  async evaluateExternalCapability(input) {
    return await this.request('/capabilities/external/evaluate', { method: 'POST', body: input, admin: true });
  }

  /** Stores credentials only for a bundled connector; the response is explicitly unverified. */
  async storeIntegrationCredentials(input) {
    return await this.request('/integrations', { method: 'POST', body: input, admin: true });
  }

  /** Removes local vault credentials; it does not revoke the provider-side grant. */
  async removeIntegrationCredentials(connectionId) {
    return await this.request(`/integrations/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE', admin: true });
  }

  async createIntegrationCredentialHandoff(input) {
    return await this.request('/integrations/handoffs', {
      method: 'POST', body: input,
      admin: !this.integrationHandoffToken,
      authorizationToken: this.integrationHandoffToken
    });
  }

  async completeIntegrationCredentialHandoff(handoffId, ticket, input) {
    return await this.request(`/integrations/handoffs/${encodeURIComponent(handoffId)}/complete`, {
      method: 'POST', body: input, authorizationToken: ticket
    });
  }

  async cancelIntegrationCredentialHandoff(handoffId) {
    return await this.request(`/integrations/handoffs/${encodeURIComponent(handoffId)}`, {
      method: 'DELETE',
      admin: !this.integrationHandoffToken,
      authorizationToken: this.integrationHandoffToken
    });
  }

  async createMission(input) {
    return await this.request('/missions', {
      method: 'POST',
      body: input,
      admin: true
    });
  }

  async listMissions({ limit = 50, status = null } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (status) query.set('status', status);
    return await this.request(`/missions?${query}`, { admin: true });
  }

  async getMission(missionId) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}`, { admin: true });
  }

  async runMission(missionId, options = {}) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}/run`, {
      method: 'POST',
      body: options,
      admin: true
    });
  }

  /** Provision a blank remote session. The runtime's resource authorizer must approve it. */
  async createManagedAgentSession(missionId, input) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}/managed-agent/session`, {
      method: 'POST', body: input, admin: true
    });
  }

  /** Reconcile an ambiguous session create without submitting a duplicate create request. */
  async reconcileManagedAgentSessionProvision(missionId, options = {}) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}/managed-agent/session/reconcile`, {
      method: 'POST', body: options, admin: true
    });
  }

  async decideMissionGate(missionId, gateId, decision) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}/gates/${encodeURIComponent(gateId)}/decision`, {
      method: 'POST',
      body: decision,
      admin: true
    });
  }

  async updateMission(missionId, settings) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}/settings`, {
      method: 'POST',
      body: settings,
      admin: true
    });
  }

  async cancelMission(missionId, options = {}) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}/cancel`, {
      method: 'POST',
      body: options,
      admin: true
    });
  }

  async reviseMissionGoal(missionId, revision) {
    return await this.request(`/missions/${encodeURIComponent(missionId)}/goal-revisions`, {
      method: 'POST', body: revision, admin: true
    });
  }

  async createRoutineFromCommand(command, routineId = undefined) {
    return await this.request('/routines/command', {
      method: 'POST', body: { command, ...(routineId ? { routineId } : {}) }, admin: true
    });
  }

  async createTask(rawText, options = {}) {
    return await this.request('/tasks', {
      method: 'POST',
      body: { rawText, options }
    });
  }

  async listTasks() {
    return await this.request('/tasks', { admin: true });
  }

  async getTask(taskId) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}`, { admin: true });
  }

  async approveTask(taskId, decision) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
      body: decision
    });
  }

  async runTask(taskId, options = {}) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}/run`, {
      method: 'POST',
      body: options
    });
  }

  async enqueueTask(taskId, options = {}) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}/queue`, {
      method: 'POST',
      body: { options }
    });
  }

  async workerQueue() {
    return await this.request('/worker/queue');
  }

  async drainWorkerQueue(options = {}) {
    return await this.request('/worker/queue/drain', {
      method: 'POST',
      body: options
    });
  }

  async workerLeases() {
    return await this.request('/worker/leases');
  }

  async recoverWorkerLeases(options = {}) {
    return await this.request('/worker/leases/recover', {
      method: 'POST',
      body: options
    });
  }

  async workerDaemon() {
    return await this.request('/worker/daemon', { admin: true });
  }

  async startWorkerDaemon(options = {}) {
    return await this.request('/worker/daemon/start', {
      method: 'POST',
      body: options,
      admin: true
    });
  }

  async stopWorkerDaemon(options = {}) {
    return await this.request('/worker/daemon/stop', {
      method: 'POST',
      body: options,
      admin: true
    });
  }

  async tickWorkerDaemon(options = {}) {
    return await this.request('/worker/daemon/tick', {
      method: 'POST',
      body: options,
      admin: true
    });
  }

  async createServicePlan(options = {}) {
    return await this.request('/runtime/service-plan', {
      method: 'POST',
      body: options,
      admin: true
    });
  }

  async beginCompensation(taskId, options = {}) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}/compensation`, {
      method: 'POST',
      body: options
    });
  }

  async runCompensation(taskId, options = {}) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}/compensation/run`, {
      method: 'POST',
      body: options
    });
  }

  async previewCompensation(taskId) {
    return await this.request(`/tasks/${encodeURIComponent(taskId)}/compensation/plan`, { admin: true });
  }

  async request(path, { method = 'GET', body = null, admin = false, authorizationToken = null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...((authorizationToken || admin && this.adminToken) ? { authorization: `Bearer ${authorizationToken || this.adminToken}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        return {
          success: false,
          statusCode: response.status,
          payload
        };
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async snapshotOpenApi({ label = 'current' } = {}) {
    return createCoreApiContractSnapshot(await this.openApi(), { label });
  }
}

export function createCoreApiContractSnapshot(openApi, { label = 'current', generatedAt = new Date().toISOString() } = {}) {
  const paths = Object.keys(openApi?.paths ?? {}).sort();
  const operations = paths.flatMap((path) => Object.entries(openApi.paths[path])
    .map(([method, operation]) => ({
      path,
      method: method.toUpperCase(),
      operationId: operation.operationId ?? null
    })))
    .sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
  const schemas = Object.keys(openApi?.components?.schemas ?? {}).sort();
  return {
    snapshotVersion: 'a-core-api-contract-snapshot-v1',
    label,
    generatedAt,
    openapi: openApi?.openapi ?? null,
    pathCount: paths.length,
    operationCount: operations.length,
    schemaCount: schemas.length,
    paths,
    operations,
    schemas,
    digest: `sha256:${sha256(canonicalJson({ paths, operations, schemas }))}`
  };
}

export function diffCoreApiContractSnapshots(previous, next, { label = 'contract-diff', generatedAt = new Date().toISOString() } = {}) {
  const previousPaths = new Set(previous?.paths ?? []);
  const nextPaths = new Set(next?.paths ?? []);
  const previousOperations = new Set((previous?.operations ?? []).map(operationKey));
  const nextOperations = new Set((next?.operations ?? []).map(operationKey));
  const removedPaths = [...previousPaths].filter((path) => !nextPaths.has(path));
  const addedPaths = [...nextPaths].filter((path) => !previousPaths.has(path));
  const removedOperations = [...previousOperations].filter((operation) => !nextOperations.has(operation));
  const addedOperations = [...nextOperations].filter((operation) => !previousOperations.has(operation));
  return {
    diffVersion: 'a-core-api-contract-diff-v1',
    label,
    generatedAt,
    status: removedPaths.length || removedOperations.length ? 'breaking-change' : 'compatible',
    previousDigest: previous?.digest ?? null,
    nextDigest: next?.digest ?? null,
    changed: previous?.digest !== next?.digest,
    addedPaths,
    removedPaths,
    addedOperations,
    removedOperations
  };
}

function operationKey(operation) {
  return `${operation.path}:${operation.method}:${operation.operationId ?? 'unknown'}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
