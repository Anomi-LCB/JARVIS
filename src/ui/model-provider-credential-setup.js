import { isLoopbackHttpUrl } from '../../packages/shared/src/control-center-hosting.js';

const setupContracts = Object.freeze({
  xai: { connectorId: 'jarvis-model-xai', scope: 'model.plan' },
  meta: { connectorId: 'jarvis-model-meta', scope: 'model.plan' },
  gemini: { connectorId: 'jarvis-model-gemini', scope: 'model.plan' },
  'openai-agents': { connectorId: 'jarvis-openai-agents', scope: 'agents.provider.verify' }
});

export function isLocalCredentialHandoffAvailable({ hosted = false, coreBaseUrl, localApiBaseUrl, origin } = {}) {
  if (hosted) {
    const managedProxyUrl = localApiBaseUrl ? `${String(localApiBaseUrl).replace(/\/+$/u, '')}/api/core` : '/api/core';
    return Boolean(localApiBaseUrl && isLoopbackHttpUrl(localApiBaseUrl) && coreBaseUrl === managedProxyUrl);
  }
  try {
    return isLoopbackHttpUrl(new URL(String(coreBaseUrl ?? ''), origin ?? 'http://127.0.0.1').href);
  } catch {
    return false;
  }
}

/** Stores an API key using a short-lived, one-use, connector/scope-bound handoff ticket. */
export async function storeModelProviderApiKey({ provider, apiKey, request, adminToken } = {}) {
  const contract = setupContracts[provider];
  if (!contract || typeof request !== 'function' || typeof adminToken !== 'string' || !adminToken) {
    throw setupError('setup-unavailable');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 || apiKey !== apiKey.trim()) {
    throw setupError('invalid-key');
  }
  let handoff;
  let completed = false;
  let completionAttempted = false;
  let completionBody;
  try {
    handoff = await request('/integrations/handoffs', {
      method: 'POST', token: adminToken, timeoutMs: 8_000,
      body: { connectorId: contract.connectorId, authMethod: 'api-key', scopes: [contract.scope], ttlMs: 60_000 }
    });
    if (typeof handoff?.handoffId !== 'string' || typeof handoff?.ticket !== 'string' || !handoff.ticket) {
      throw setupError('handoff-unavailable');
    }
    completionBody = { providerAccountId: 'jarvis-local-primary', label: 'JARVIS 로컬 기본 키', credentials: { apiKey } };
    completionAttempted = true;
    const result = await request(`/integrations/handoffs/${encodeURIComponent(handoff.handoffId)}/complete`, {
      method: 'POST', token: handoff.ticket, timeoutMs: 8_000, body: completionBody
    });
    completed = true;
    if (!result?.connection?.connectionId || result.providerVerified !== false || result.executionAuthorized !== false) {
      throw setupError('save-result-unverified');
    }
    return { connection: result.connection, providerVerified: false, executionAuthorized: false };
  } catch (error) {
    if (error?.setupCode) throw error;
    throw setupError(completionAttempted ? 'save-outcome-unknown' : 'save-failed');
  } finally {
    if (completionBody?.credentials) completionBody.credentials.apiKey = '';
    completionBody = null;
    if (handoff?.handoffId && !completed) {
      await request(`/integrations/handoffs/${encodeURIComponent(handoff.handoffId)}`, {
        method: 'DELETE', token: adminToken, timeoutMs: 3_000
      }).catch(() => {});
    }
    apiKey = '';
  }
}

function setupError(setupCode) {
  const error = new Error(setupCode);
  error.setupCode = setupCode;
  return error;
}
