const providers = Object.freeze({
  'openai-agents': Object.freeze({ connectorId: 'jarvis-openai-agents', scope: 'agents.provider.verify',
    url: 'https://api.openai.com/v1/models', authHeader: 'authorization', models: body => body?.data, modelId: item => item?.id }),
  xai: Object.freeze({ connectorId: 'jarvis-model-xai', url: 'https://api.x.ai/v1/models', authHeader: 'authorization',
    scope: 'model.plan', models: body => body?.data, modelId: item => item?.id }),
  meta: Object.freeze({ connectorId: 'jarvis-model-meta', url: 'https://api.meta.ai/v1/models', authHeader: 'authorization',
    scope: 'model.plan', models: body => body?.data, modelId: item => item?.id }),
  gemini: Object.freeze({ connectorId: 'jarvis-model-gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', authHeader: 'x-goog-api-key',
    scope: 'model.plan', models: body => body?.models, modelId: item => item?.baseModelId ?? item?.name?.replace(/^models\//u, '') }),
  'gemini-interactions': Object.freeze({ connectorId: 'jarvis-model-gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', authHeader: 'x-goog-api-key',
    scope: 'model.plan', models: body => body?.models, modelId: item => item?.baseModelId ?? item?.name?.replace(/^models\//u, '') })
});
const maxResponseBytes = 1_048_576;
const requestTimeoutMs = 8_000;

/**
 * Checks API-key access through one fixed, read-only provider model-catalog endpoint.
 * No user prompt or personal artifact is sent. The key is never put in a URL or result object.
 */
export function createModelProviderCredentialVerifier({ vault, fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  if (!vault?.list || !vault?.withCredentials || !vault?.recordProviderVerification) {
    throw new TypeError('Model provider verification requires a credential vault with verification persistence.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  return Object.freeze({
    async verify({ provider, modelId = null } = {}) {
      const definition = providers[provider];
      if (!definition) return { provider: String(provider ?? ''), providerVerified: false, status: 'invalid-response',
        checkedAt: clock().toISOString(), modelCount: 0, errorCode: 'A_MODEL_PROVIDER_UNSUPPORTED' };
      if (modelId !== null && (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 200
        || /[\u0000-\u001f\u007f]/u.test(modelId))) {
        return { provider, providerVerified: false, status: 'invalid-response', checkedAt: clock().toISOString(),
          modelCount: 0, errorCode: 'A_MODEL_ID_INVALID' };
      }
      const matches = vault.list().filter(item => item.connectorId === definition.connectorId
        && item.authMethod === 'api-key'
        && ['credentials-stored-unverified', 'credentials-stored-provider-verified'].includes(item.status)
        && item.scopes.includes(definition.scope));
      if (matches.length !== 1) return { provider, providerVerified: false,
        status: 'authentication-rejected', checkedAt: clock().toISOString(), modelCount: 0,
        errorCode: matches.length ? 'A_MODEL_PROVIDER_CREDENTIAL_AMBIGUOUS' : 'A_MODEL_CREDENTIAL_REQUIRED' };

      const connection = matches[0];
      const result = await vault.withCredentials(connection.connectionId, async (credentials, metadata) => {
        const capture = value => ({ ...value, credentialUpdatedAt: metadata.updatedAt });
        if (typeof credentials.apiKey !== 'string' || !credentials.apiKey) {
          return capture(resultRecord(provider, false, 'authentication-rejected', clock, modelId, 0, 'A_MODEL_CREDENTIAL_REQUIRED'));
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const headers = definition.authHeader === 'authorization'
            ? { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/json' }
            : { 'x-goog-api-key': credentials.apiKey, Accept: 'application/json' };
          const response = await fetchImpl(definition.url, {
            method: 'GET', headers, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
          });
          if (response.status === 401) {
            return capture(resultRecord(provider, false, 'authentication-rejected', clock, modelId, 0, 'A_MODEL_PROVIDER_AUTH_REJECTED'));
          }
          if (response.status === 403) {
            return capture(resultRecord(provider, false, 'authorization-rejected', clock, modelId, 0, 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED'));
          }
          if (response.status === 429) return capture(resultRecord(provider, false, 'rate-limited', clock, modelId, 0, 'A_MODEL_PROVIDER_RATE_LIMITED'));
          if (!response.ok) return capture(resultRecord(provider, false, 'provider-unavailable', clock, modelId, 0, 'A_MODEL_PROVIDER_HTTP_ERROR'));
          const contentLength = Number(response.headers?.get?.('content-length'));
          if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
            return capture(resultRecord(provider, false, 'invalid-response', clock, modelId, 0, 'A_MODEL_PROVIDER_RESPONSE_TOO_LARGE'));
          }
          const text = await readResponseBounded(response, maxResponseBytes);
          let body;
          try { body = JSON.parse(text); }
          catch { return capture(resultRecord(provider, false, 'invalid-response', clock, modelId, 0, 'A_MODEL_PROVIDER_RESPONSE_INVALID')); }
          const entries = definition.models(body);
          if (!Array.isArray(entries) || entries.length > 10_000) {
            return capture(resultRecord(provider, false, 'invalid-response', clock, modelId, 0, 'A_MODEL_PROVIDER_RESPONSE_INVALID'));
          }
          const ids = entries.map(definition.modelId).filter(value => typeof value === 'string');
          const requestedModelAvailable = modelId === null ? undefined : ids.some(id => id === modelId);
          const status = requestedModelAvailable === false ? 'model-unavailable' : 'verified';
          const verified = resultRecord(provider, true, status, clock, modelId, ids.length,
            requestedModelAvailable === false ? 'A_MODEL_NOT_AVAILABLE_TO_PROVIDER_KEY' : undefined);
          if (typeof requestedModelAvailable === 'boolean') verified.requestedModelAvailable = requestedModelAvailable;
          return capture(verified);
        } catch (error) {
          const aborted = error?.name === 'AbortError';
          const oversized = error?.message === 'A_MODEL_PROVIDER_RESPONSE_TOO_LARGE';
          return capture(resultRecord(provider, false, oversized ? 'invalid-response' : 'provider-unavailable', clock, modelId, 0,
            oversized ? 'A_MODEL_PROVIDER_RESPONSE_TOO_LARGE'
              : aborted ? 'A_MODEL_PROVIDER_CHECK_TIMEOUT' : 'A_MODEL_PROVIDER_NETWORK_ERROR'));
        } finally {
          clearTimeout(timer);
        }
      });

      const safeResult = {
        status: result.status,
        providerVerified: result.providerVerified,
        checkedAt: result.checkedAt,
        modelCount: result.modelCount,
        ...(modelId !== null ? { modelId, requestedModelAvailable: result.requestedModelAvailable === true } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {})
      };
      const persisted = vault.recordProviderVerification(connection.connectionId, safeResult,
        { expectedUpdatedAt: result.credentialUpdatedAt });
      return { provider, ...safeResult, connectionId: persisted.connectionId, executionAuthorized: false };
    }
  });
}

async function readResponseBounded(response, maximumBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error('A_MODEL_PROVIDER_RESPONSE_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('A_MODEL_PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function resultRecord(provider, providerVerified, status, clock, modelId, modelCount, errorCode) {
  return { provider, providerVerified, status, checkedAt: clock().toISOString(), modelCount,
    ...(modelId !== null ? { modelId } : {}), ...(errorCode ? { errorCode } : {}) };
}
