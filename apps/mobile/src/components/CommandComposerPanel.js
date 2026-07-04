export function createCommandComposerState({
  rawText = '',
  connected = false,
  pendingOfflineCount = 0,
  requestStatus = 'idle',
  requestStartedAt = null,
  requestTimeoutMs = 8000,
  now = new Date()
} = {}) {
  const normalized = String(rawText ?? '').trim();
  const tooLong = normalized.length > 1000;
  const empty = normalized.length === 0;
  const canSend = !empty && !tooLong;
  const requestState = createCommandRequestState({ requestStatus, requestStartedAt, requestTimeoutMs, now });
  return {
    rawText,
    normalized,
    connected,
    pendingOfflineCount,
    canSend,
    requestState,
    validation: {
      empty,
      tooLong,
      message: empty
        ? '명령을 입력해야 합니다.'
        : tooLong
          ? '명령은 1000자 이하로 입력해야 합니다.'
          : null
    },
    primaryAction: {
      label: connected ? '전송' : '오프라인 큐에 저장',
      enabled: canSend && !requestState.pending,
      mode: connected ? 'send-now' : 'queue-offline'
    },
    keyboardSubmit: {
      enabled: canSend && !requestState.pending,
      returnKeyType: 'send',
      submitBehavior: 'submit',
      blurOnSubmit: false
    },
    cancelRequestAction: {
      label: '요청 취소',
      enabled: requestState.canCancel,
      reason: requestState.pending ? 'request-in-flight' : requestState.timedOut ? 'request-timeout' : null
    },
    queueAction: {
      label: `대기 ${pendingOfflineCount}`,
      enabled: pendingOfflineCount > 0,
      nextRoute: 'CommandScreen'
    }
  };
}

export function createCommandRequestState({
  requestStatus = 'idle',
  requestStartedAt = null,
  requestTimeoutMs = 8000,
  now = new Date()
} = {}) {
  const startedAtMs = requestStartedAt ? Date.parse(requestStartedAt) : null;
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, now.getTime() - startedAtMs) : 0;
  const pending = requestStatus === 'pending';
  const timedOut = pending && elapsedMs >= requestTimeoutMs;
  return {
    status: timedOut ? 'timeout' : requestStatus,
    pending,
    timedOut,
    canCancel: pending || timedOut,
    startedAt: requestStartedAt,
    elapsedMs,
    timeoutMs: requestTimeoutMs,
    message: timedOut
      ? `요청 시간이 ${requestTimeoutMs}ms를 넘었습니다.`
      : pending
        ? '브릿지 응답을 기다리는 중입니다.'
        : null
  };
}
