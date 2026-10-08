import { sendJson } from '../../../shared/src/http.js';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function sourceRetractionStatus(growth, daemon) {
  const configured = typeof growth?.sourceRetractionHandler === "function";
  const last = daemon?.lastSourceRetractionSync;
  if (!configured) return { status: "not_configured", observedAt: null, pendingCount: null, deferredCount: null, preferenceUpdateFailedCount: null };
  if (!last) return { status: "not_observed", observedAt: null, pendingCount: null, deferredCount: null, preferenceUpdateFailedCount: null };
  const pendingCount = count(last.pendingCount), deferredCount = count(last.deferredCount);
  const preferenceUpdateFailedCount = count(last.preferenceUpdateFailedCount);
  const valid = last.success === true && last.projectionConfigured === true
    && pendingCount !== null && deferredCount !== null && preferenceUpdateFailedCount !== null
    && deferredCount <= pendingCount;
  return { status: !valid ? "unavailable" : pendingCount > 0 || preferenceUpdateFailedCount > 0 ? "retry_pending" : "checked",
    observedAt: typeof last.at === "string" ? last.at : null,
    pendingCount: valid ? pendingCount : null, deferredCount: valid ? deferredCount : null,
    preferenceUpdateFailedCount: valid ? preferenceUpdateFailedCount : null };
}
/** Entry requires the Core ADMIN guard. This endpoint never drains or mutates memory. */
export function handleMemoryStatus(request, response, { growth, daemon }) {
  if (request.method !== 'GET') return sendJson(response, 405, { success: false, error: { code: 'A_MEMORY_METHOD_NOT_ALLOWED' } });
  try {
    const configured = Boolean(growth?.memoryStore?.pendingMemoryStatus);
    const pending = configured ? growth.memoryStore.pendingMemoryStatus() : null;
    if (configured && (count(pending?.pendingCount) === null || count(pending?.replayAttempts) === null)) throw new Error('Invalid queue status.');
    const replay = daemon?.lastMemoryReplay;
    return sendJson(response, 200, {
      success: true, observedAt: new Date().toISOString(),
      status: !configured ? 'not_configured' : pending.pendingCount > 0 ? 'pending' : 'ready',
      pending: { pendingCount: count(pending?.pendingCount), replayAttempts: count(pending?.replayAttempts) },
      worker: {
        available: Boolean(daemon), running: Boolean(daemon?.timer),
        lastReplay: replay ? { success: replay.success === true, at: replay.at,
          stored: count(replay.stored), suppressed: count(replay.suppressed), failed: count(replay.failed),
          pendingCount: count(replay.pendingCount) } : null
      },
      sourceRetractions: sourceRetractionStatus(growth, daemon),
      executionAuthority: false
    });
  } catch {
    return sendJson(response, 503, { success: false, error: { code: 'F_MEMORY_STATUS_UNAVAILABLE' }, executionAuthority: false });
  }
}
