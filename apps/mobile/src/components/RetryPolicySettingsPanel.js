export function createRetryPolicySettingsState({ policy, readiness, draft = {} } = {}) {
  const maxAttempts = Number(draft.maxAttempts ?? policy?.maxAttempts ?? 3);
  const baseBackoffMs = Number(draft.baseBackoffMs ?? policy?.baseBackoffMs ?? 1000);
  const issues = [];
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    issues.push({ field: 'maxAttempts', code: 'retry_max_attempts_range', message: '1~10 사이의 정수여야 합니다.' });
  }
  if (!Number.isInteger(baseBackoffMs) || baseBackoffMs < 100 || baseBackoffMs > 60_000) {
    issues.push({ field: 'baseBackoffMs', code: 'retry_backoff_range', message: '100~60000ms 사이의 정수여야 합니다.' });
  }
  const sessionLocked = readiness?.allowed === false;
  const changed = maxAttempts !== policy?.maxAttempts || baseBackoffMs !== policy?.baseBackoffMs;
  const blockedReason = issues[0]?.message ?? (sessionLocked ? '모바일 세션 잠금 해제가 필요합니다.' : null);
  return {
    policy: policy ?? null,
    draft: {
      maxAttempts,
      baseBackoffMs,
      reason: draft.reason ?? ''
    },
    issues,
    valid: issues.length === 0,
    changed,
    blockedReason,
    saveAction: {
      action: 'save-retry-policy',
      label: '재시도 정책 저장',
      enabled: issues.length === 0 && changed && !sessionLocked,
      blockedReason
    },
    resetAction: {
      action: 'reset-draft',
      label: '초기화',
      enabled: changed
    },
    facts: {
      updatedAt: policy?.updatedAt ?? null,
      queuePath: policy?.queuePath ?? null,
      sessionReady: readiness?.allowed !== false
    }
  };
}
