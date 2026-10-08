// Public, read-only diagnostics. Never include raw server messages or credentials.
export function describeReadFailure(error, { component = 'gateway', endpoint = '', now = new Date().toISOString() } = {}) {
  const status = Number(error?.status);
  const timeout = error?.name === 'AbortError' || error?.code === 'NEXUS_TIMEOUT';
  const denied = status === 401 || status === 403;
  const unavailable = status === 502 || status === 503;
  const invalid = error?.code === 'INVALID_RESPONSE';
  const code = timeout ? 'READ_TIMEOUT' : denied ? 'ACCESS_DENIED' : invalid ? 'INVALID_RESPONSE'
    : unavailable ? 'SERVICE_UNAVAILABLE' : status >= 400 ? 'HTTP_ERROR' : 'CONNECTION_UNCONFIRMED';
  return {
    code, component, checkedAt: now,
    endpoint: safeEndpoint(endpoint),
    summary: timeout ? '응답을 기다리는 시간이 초과되었습니다.'
      : denied ? '이 조회에 필요한 접근 권한을 확인할 수 없습니다.'
        : invalid ? '서비스 응답 형식이 올바르지 않습니다.'
          : unavailable ? '게이트웨이에 연결했지만 내부 서비스가 응답하지 않습니다.'
            : status >= 400 ? '서비스가 조회 요청을 처리하지 못했습니다.'
              : '서비스 연결을 확인하지 못했습니다. PC 서비스 또는 브라우저 접근 권한을 확인해 주세요.',
    nextAction: denied ? '제어 센터에서 연결 설정과 현재 권한을 확인한 뒤 다시 검사해 주세요.'
      : invalid ? '제어 센터와 서비스의 버전을 확인한 뒤 다시 검사해 주세요.'
        : unavailable ? 'JARVIS 실행 상태를 확인한 뒤 다시 검사해 주세요.'
          : '이 PC에서 JARVIS를 실행하고, 브라우저의 로컬 네트워크 접근 허용 상태를 확인한 뒤 다시 검사해 주세요.',
    safeToRetry: true,
    retryAfterMs: timeout || unavailable ? 3000 : 0,
    httpStatus: status >= 400 && status <= 599 ? status : null
  };
}

function safeEndpoint(value) {
  try {
    const url = new URL(value, 'http://localhost');
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${String(value).startsWith('/') ? '' : url.origin}${url.pathname}`;
  } catch { return ''; }
}
