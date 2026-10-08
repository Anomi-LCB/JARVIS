const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/u.test(value);
}

/**
 * Exchanges a trusted workload JWT for a short-lived OpenAI API token.
 * The subject token is supplied by a trusted OS/cloud identity integration and
 * neither it nor the exchanged bearer token is persisted by this adapter.
 */
export function createOpenAiWorkloadIdentityTokenSource({
  identityProviderId,
  serviceAccountId,
  getSubjectToken,
  subjectTokenType = JWT_TOKEN_TYPE,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 10_000,
  refreshSkewSeconds = 60
} = {}) {
  if (!validIdentifier(identityProviderId) || !validIdentifier(serviceAccountId)) fail('A_OPENAI_WIF_CONFIGURATION_INVALID');
  if (typeof getSubjectToken !== 'function' || typeof fetchImpl !== 'function') fail('A_OPENAI_WIF_DEPENDENCY_INVALID');
  if (![JWT_TOKEN_TYPE, 'urn:ietf:params:oauth:token-type:id_token'].includes(subjectTokenType)) fail('A_OPENAI_WIF_SUBJECT_TOKEN_TYPE_INVALID');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
    || !Number.isSafeInteger(refreshSkewSeconds) || refreshSkewSeconds < 0 || refreshSkewSeconds > 300
    || typeof now !== 'function') fail('A_OPENAI_WIF_CONFIGURATION_INVALID');

  let cached = null;
  let pending = null;
  let generation = 0;

  async function exchange() {
    const exchangeGeneration = generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let subjectToken = null;
    let acquiringSubjectToken = true;
    let rejectTimeout;
    const timeoutPromise = new Promise((_, reject) => {
      rejectTimeout = () => reject(Object.assign(new Error('A_OPENAI_WIF_EXCHANGE_TIMEOUT'), { code: 'A_OPENAI_WIF_EXCHANGE_TIMEOUT' }));
    });
    const onAbort = () => rejectTimeout();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const subjectTokenPromise = Promise.resolve().then(() => getSubjectToken({ signal: controller.signal }));
      subjectToken = await Promise.race([subjectTokenPromise, timeoutPromise]);
      if (typeof subjectToken !== 'string' || !subjectToken.trim() || /[\r\n]/u.test(subjectToken) || subjectToken.length > 32_000) {
        fail('A_OPENAI_WIF_SUBJECT_TOKEN_INVALID');
      }
      acquiringSubjectToken = false;
      const response = await Promise.race([fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: GRANT_TYPE,
          subject_token_type: subjectTokenType,
          subject_token: subjectToken.trim(),
          identity_provider_id: identityProviderId,
          service_account_id: serviceAccountId
        }),
        signal: controller.signal,
        redirect: 'error'
      }), timeoutPromise]);
      if (!response.ok) fail('A_OPENAI_WIF_EXCHANGE_REJECTED');
      let result;
      try { result = await response.json(); } catch { fail('A_OPENAI_WIF_RESPONSE_INVALID'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || typeof result.access_token !== 'string' || !result.access_token.trim()
        || result.access_token.length > 16_384 || /[\r\n]/u.test(result.access_token)
        || typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer'
        || !Number.isSafeInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 3600
        || !Number.isSafeInteger(result.expires_at) || result.expires_at <= 0) {
        fail('A_OPENAI_WIF_RESPONSE_INVALID');
      }
      const receivedAt = now();
      if (!Number.isFinite(receivedAt)) fail('A_OPENAI_WIF_CLOCK_INVALID');
      const expiresAt = Math.min(result.expires_at * 1000, receivedAt + result.expires_in * 1000);
      if (expiresAt <= receivedAt) fail('A_OPENAI_WIF_TOKEN_EXPIRED');
      if (exchangeGeneration !== generation) fail('A_OPENAI_WIF_CREDENTIAL_REVOKED');
      cached = { token: result.access_token, expiresAt };
      return cached.token;
    } catch (error) {
      if (error?.code?.startsWith('A_OPENAI_WIF_')) throw error;
      if (controller.signal.aborted) fail('A_OPENAI_WIF_EXCHANGE_TIMEOUT');
      if (acquiringSubjectToken) fail('A_OPENAI_WIF_SUBJECT_TOKEN_UNAVAILABLE');
      fail('A_OPENAI_WIF_TRANSPORT_FAILED');
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      subjectToken = null;
    }
  }

  return Object.freeze({
    getAccessToken() {
      const currentTime = now();
      if (!Number.isFinite(currentTime)) return Promise.reject(Object.assign(new Error('A_OPENAI_WIF_CLOCK_INVALID'), { code: 'A_OPENAI_WIF_CLOCK_INVALID' }));
      if (cached && cached.expiresAt - refreshSkewSeconds * 1000 > currentTime) return Promise.resolve(cached.token);
      if (!pending) {
        pending = exchange().finally(() => { pending = null; });
      }
      return pending;
    },
    clearMemoryCache() {
      generation++;
      cached = null;
    },
    status() {
      return Object.freeze({ configured: true, tokenCached: Boolean(cached), expiresAt: cached?.expiresAt ?? null });
    }
  });
}

export const openAiWorkloadIdentityConstants = Object.freeze({ tokenEndpoint: TOKEN_ENDPOINT, jwtSubjectTokenType: JWT_TOKEN_TYPE });
