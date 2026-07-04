export function approvalExpiryState(card, { now = new Date() } = {}) {
  const expiresAt = card?.expiresAt ?? null;
  const nowMs = toMillis(now);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const invalid = Boolean(expiresAt) && Number.isNaN(expiresAtMs);
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
  const remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : null;
  return {
    expiresAt,
    invalid,
    expired,
    remainingMs,
    status: expired ? 'expired' : invalid ? 'invalid' : expiresAt ? 'active' : 'unknown',
    label: expired
      ? '승인 카드 만료'
      : invalid
        ? '승인 만료시간 확인 필요'
        : expiresAt
          ? `만료 ${expiresAt}`
          : '만료시간 없음',
    blockedReason: expired ? '승인 카드가 만료되었습니다. 새 승인을 요청해야 합니다.' : null
  };
}

export function isApprovalExpired(card, options = {}) {
  return approvalExpiryState(card, options).expired;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}
