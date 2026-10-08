export function currentOwnerSession(status, now = Date.now()) {
  const session = status?.session;
  return status?.active === true && typeof session?.sessionId === 'string'
    && Date.parse(session.expiresAt) > now ? session : null;
}

// Called only for a new user command, never by a timer or background refresh.
export async function prepareOwnerCommand({ enabled, locked, readStatus, activate, now = Date.now }) {
  if (!enabled || locked) return { session: null, status: null, suspended: false };
  const status = await readStatus();
  if (!status || typeof status.active !== 'boolean') throw new Error('자동 승인 상태를 확인하지 못했습니다.');
  const active = currentOwnerSession(status, now());
  if (active) return { session: active, status, suspended: false };
  // An explicit revoke is different from expiration: do not silently reverse it.
  const lifecycle = status?.recentAudit?.find((event) =>
    ['owner_session.revoked', 'owner_session.expired', 'owner_session.activated'].includes(event.eventType));
  if (lifecycle?.eventType === 'owner_session.revoked') {
    return { session: null, status, suspended: true };
  }
  const renewed = await activate();
  const session = currentOwnerSession(renewed, now());
  if (renewed?.success !== true || !session) throw new Error('자동 승인 세션을 준비하지 못했습니다.');
  return { session, status: renewed, suspended: false };
}
