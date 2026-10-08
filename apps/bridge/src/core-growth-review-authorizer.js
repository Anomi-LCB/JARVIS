const defaultTimeoutMs = 2_000;

export function createCoreGrowthReviewAuthorizer({
  coreApiUrl = process.env.JARVIS_CORE_API_URL,
  token = process.env.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN,
  fetchImpl = globalThis.fetch,
  timeoutMs = defaultTimeoutMs
} = {}) {
  const endpoint = validateCoreEndpoint(coreApiUrl);
  return async function authorizeGrowthSkillReview({ action, deviceId } = {}) {
    if (!endpoint || !token || typeof fetchImpl !== 'function') {
      return denied('D_GROWTH_SKILL_OWNER_AUTH_UNAVAILABLE');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/owner-session/authorize-growth-skill-review`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action, deviceId }),
        signal: controller.signal
      });
      const body = await response.json();
      if (response.status === 200 && body?.allowed === true
        && body.authorizationVersion === 'a-owner-growth-skill-review-v1'
        && body.action === action && body.deviceId === deviceId) {
        return { allowed: true, authorization: body };
      }
      if (body?.code === 'A_OWNER_GROWTH_SKILL_REVIEW_DENIED' && body.reason === 'owner-session-inactive') {
        return denied('A_OWNER_SESSION_INACTIVE', 'PC에서 소유자 모드를 먼저 켜야 이 업무 절차를 검토할 수 있습니다.');
      }
      return denied(body?.code ?? 'D_GROWTH_SKILL_OWNER_AUTH_DENIED');
    } catch {
      return denied('D_GROWTH_SKILL_OWNER_AUTH_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  };
}

function validateCoreEndpoint(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function denied(code, message = '활성 소유자 검토 권한을 확인할 수 없어 변경을 중단했습니다.') {
  return { allowed: false, error: { code, message } };
}
