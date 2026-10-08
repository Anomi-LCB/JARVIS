import { readJsonBody, sendJson, routeParams } from '../../../shared/src/http.js';
const fail = (response, status, code) => sendJson(response, status, { success: false, error: { code } });
const project = item => ({ preferenceId: item.preferenceId, revision: item.revision ?? 1, status: item.status,
  statement: item.statement, validUntil:item.validUntil??null, scopePolicy:item.scopePolicy??null,
  revisionHistory:(item.history??[]).map(entry=>({action:entry.action,at:entry.at})), contentWithheld: item.contentWithheld === true });
/** Core ADMIN guard is required before entry. No permission or provenance changes accepted. */
export async function handlePreferenceManagement(request, response, { path, growth }) {
  if (!growth?.confirmedPreferenceRegistry) return fail(response, 503, 'F_MEMORY_STORAGE_REQUIRED');
  if (growth.ensureMemoryGeneration?.() === false) return fail(response, 503, 'F_MEMORY_RESTORE_RELOAD_REQUIRED');
  growth.synchronizeSourceRetractions();
  if (path === '/memory/preferences' && request.method === 'GET') {
    const memoryGeneration = growth.memoryGeneration;
    const items = growth.confirmedPreferenceRegistry.all({ includeInactive: true }).map(project);
    if (growth.memoryStore?.restoreGeneration?.() !== undefined
      && growth.memoryStore.restoreGeneration() !== memoryGeneration) return fail(response, 409, 'F_MEMORY_GENERATION_CONFLICT');
    return sendJson(response, 200, { items, memoryGeneration, executionAuthority: false });
  }
  const update = routeParams('/memory/preferences/:preferenceId', path);
  const revoke = routeParams('/memory/preferences/:preferenceId/revoke', path);
  if (!(request.method === 'PATCH' && update || request.method === 'POST' && revoke)) return fail(response, 405, 'A_MEMORY_METHOD_NOT_ALLOWED');
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) return fail(response, 415, 'A_MEMORY_JSON_REQUIRED');
  let body;
  try { body = await readJsonBody(request, { maximumBytes: 8192 }); }
  catch { return fail(response, 400, 'A_MEMORY_BODY_INVALID'); }
  const allowed = update ? ['expectedRevision', 'expectedGeneration', 'statement', 'validUntil'] : ['expectedRevision', 'expectedGeneration'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
    || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0
    || update && (typeof body.statement !== 'string' || !body.statement.trim() || body.statement.length > 2000)) return fail(response, 400, 'A_MEMORY_INPUT_INVALID');
  if(body.validUntil!==undefined && body.validUntil!==null && (typeof body.validUntil!=='string'
    || !Number.isFinite(Date.parse(body.validUntil)) || new Date(body.validUntil).toISOString()!==body.validUntil)) return fail(response,400,'F_MEMORY_EXPIRY_INVALID');
  const id = (update ?? revoke).preferenceId;
  const result = update ? growth.updatePreference(id, { expectedRevision: body.expectedRevision, expectedGeneration: body.expectedGeneration, patch: { statement: body.statement.trim(),...(body.validUntil!==undefined?{validUntil:body.validUntil}:{}) }, decidedBy: 'owner-memory-screen', reason: 'owner correction' })
    : growth.revokePreference(id, { expectedRevision: body.expectedRevision, expectedGeneration: body.expectedGeneration, decidedBy: 'owner-memory-screen', reason: 'owner withdrawal' });
  if (result.success) return sendJson(response, 200, { success: true, item: project(result.item), executionAuthority: false });
  return sendJson(response, ['F_MEMORY_REVISION_CONFLICT', 'F_MEMORY_SOURCE_RETRACTED', 'F_MEMORY_GENERATION_CONFLICT'].includes(result.error?.code) ? 409
    : result.error?.code === 'F_MEMORY_RESTORE_RELOAD_REQUIRED' ? 503
    : result.error?.code === 'F_CONFIRMED_PREFERENCE_NOT_FOUND' ? 404 : 400, result);
}
