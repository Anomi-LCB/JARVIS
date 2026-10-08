import { readJsonBody, sendJson } from '../../../shared/src/http.js';
import { selectedConversationDocumentHash } from '../../../../apps/growth-memory/src/selected-conversation-archive.js';

const validIdentifier = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const errorResponse = (response, status, code) => sendJson(response, status, { error: { code } });

/** Called only after the Core ADMIN and loopback guards. Never accepts a client workspace. */
export async function handleSelectedConversationRequest(request, response, { operation, coreFacade }) {
  if (!['preview', 'commit', 'query', 'page', 'withdraw'].includes(operation))
    return errorResponse(response, 404, 'A_CONVERSATION_ROUTE_NOT_FOUND');
  if (request.method !== 'POST') return errorResponse(response, 405, 'A_CONVERSATION_METHOD_NOT_ALLOWED');
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? ''))
    return errorResponse(response, 415, 'A_CONVERSATION_JSON_REQUIRED');
  const archive = coreFacade.memoryStore?.selectedConversationImports;
  if (!archive) return errorResponse(response, 503, 'F_CONVERSATION_STORAGE_REQUIRED');
  let body;
  try { body = await readJsonBody(request, { maximumBytes: ['preview', 'commit'].includes(operation) ? 4 * 1024 * 1024 : 8 * 1024 }); }
  catch (error) { return errorResponse(response, error?.statusCode === 413 ? 413 : 400, 'A_CONVERSATION_BODY_INVALID'); }
  const fields = ['userId', 'conversationId', ...(['preview', 'commit'].includes(operation)
    ? ['document', 'selectedConversationIds', 'sourceRef', 'expectedDocumentHash']
    : operation === 'query' ? ['query'] : operation === 'page' ? ['query','pageSize','cursor'] : ['id'])];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))
    || !validIdentifier(body.userId) || (body.conversationId != null && !validIdentifier(body.conversationId)))
    return errorResponse(response, 400, 'A_CONVERSATION_INPUT_INVALID');
  const scope = { userId: body.userId, conversationId: body.conversationId ?? null, workspaceRoot: coreFacade.workspaceRoot };
  try {
    if (operation === 'query' || operation === 'page') {
      if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 4000)
        return errorResponse(response, 400, 'A_CONVERSATION_QUERY_REQUIRED');
      return sendJson(response, 200, operation === 'page'
        ? archive.queryPage(body.query,{scope,pageSize:body.pageSize ?? 20,cursor:body.cursor ?? null})
        : { items: archive.query(body.query, { scope }), limit: 5, executionAuthority: false });
    }
    if (operation === 'withdraw') {
      if (typeof body.id !== 'string' || !/^[a-f0-9]{64}$/u.test(body.id))
        return errorResponse(response, 400, 'A_CONVERSATION_ID_INVALID');
      return sendJson(response, 200, archive.withdraw({ id: body.id, scope }));
    }
    if (operation === 'commit' && (typeof body.expectedDocumentHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(body.expectedDocumentHash)))
      return errorResponse(response, 400, 'A_CONVERSATION_REVIEW_HASH_REQUIRED');
    if (!body.document || typeof body.document !== 'object' || Array.isArray(body.document))
      return errorResponse(response, 400, 'A_CONVERSATION_DOCUMENT_REQUIRED');
    const input = { document: body.document, selectedConversationIds: body.selectedConversationIds,
      sourceRef: body.sourceRef, scope, expectedDocumentHash: operation === 'preview'
        ? selectedConversationDocumentHash(body.document) : body.expectedDocumentHash };
    return sendJson(response, 200, archive.import(input, { commit: operation === 'commit' }));
  } catch (error) {
    // Neither file content nor exception messages are exposed to clients or logs here.
    const code = /^F_CONVERSATION_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'A_CONVERSATION_OPERATION_FAILED';
    const status = code === 'F_CONVERSATION_IMPORT_TOO_LARGE' ? 413
      : ['F_CONVERSATION_DOCUMENT_CHANGED', 'F_CONVERSATION_REVISION_CONFLICT','F_CONVERSATION_PAGE_CHANGED'].includes(code) ? 409
      : code.startsWith('F_CONVERSATION_') ? 400 : 500;
    return errorResponse(response, status, code);
  }
}
