import { resolve } from 'node:path';

export function normalizeMemoryScope(scope) {
  if (!scope || typeof scope.userId !== 'string' || !scope.userId.trim() || typeof scope.workspaceRoot !== 'string' || !scope.workspaceRoot.trim()
    || (scope.conversationId != null && (typeof scope.conversationId !== 'string' || !scope.conversationId.trim()))) return null;
  return { userId: scope.userId, workspaceRoot: resolve(scope.workspaceRoot), conversationId: scope.conversationId ?? null };
}

export function memoryScopeMatches(event, scope) {
  if (scope === undefined) return true; // Legacy administrative inspection, never an implicit user scope.
  const requested = normalizeMemoryScope(scope), source = normalizeMemoryScope(event.source?.memoryScope);
  return !!requested && !!source && requested.userId === source.userId && requested.workspaceRoot === source.workspaceRoot && requested.conversationId === source.conversationId;
}

export const sourceRecallAllowed = event => !event.learningFlags?.doNotRemember && !event.learningFlags?.containsSensitiveData && !event.trustBoundary?.externalContent;

// Per-operation snapshot only: never reuse across correction, withdrawal or restore.
// Retain the first duplicate, exactly like Array.find in the legacy lookup.
export function indexMemorySources(events) {
  const sources = new Map();
  for (const event of events) if (!sources.has(event.eventId)) sources.set(event.eventId, event);
  return sources;
}

const sourceEvent = (events, id) => events instanceof Map ? events.get(id) : events.find(event => event.eventId === id);

export function memoryProvenance(item, events) {
  const ids = item.evidenceEventIds ?? [], sources = ids.map(id => sourceEvent(events, id)).filter(Boolean);
  const memoryKind = item.observationId ? 'execution_observation' : item.preferenceId ? 'user_confirmed_preference' : item.hypothesisId ? 'preference_hypothesis' : item.failureId ? 'failure_observation' : 'procedure_candidate';
  return {
    memoryKind,
    // Event labels describe declared provenance, not independently verified success or permission.
    sourceKinds: [...new Set(sources.map(event => event.trustBoundary?.externalContent ? 'external_content' : event.trustBoundary?.userProvided ? 'user_statement' : event.trustBoundary?.systemGenerated ? 'system_observation' : 'unattributed'))],
    sourceEventIds: [...ids],
    observedAt: sources.map(event => event.createdAt).filter(value => typeof value === 'string').sort(),
    missingSourceCount: ids.length - sources.length,
    usageScopes: sources.map(event => normalizeMemoryScope(event.source?.memoryScope)).filter(Boolean),
    validity: { validUntil: item.validUntil ?? null, basis: item.validUntil ? 'declared-expiry' : 'unspecified' },
    revisionReference: { revision: Number.isInteger(item.revision) ? item.revision : null,
      supersedesEventId: item.supersedesEventId ?? null },
    revisionHistory: (item.history ?? []).map(entry => ({action:entry.action,at:entry.at})),
    scopePolicy: item.scopePolicy ? structuredClone(item.scopePolicy) : null,
    independentlyVerifiedOutcome: false,
    procedureValidated: false,
    executionAuthority: false,
    boundaryBasis: 'declared-source-metadata; authenticated-worker scope is attached at ingestion'
  };
}

export function executionObservations(events, scope) {
  // Raw outcome lookup always requires an explicit scope, including for callers
  // using the legacy unscoped administrative pattern query.
  if (!normalizeMemoryScope(scope)) return [];
  return events.filter(event => event.eventType === 'execution.completed' && sourceRecallAllowed(event)
    && memoryScopeMatches(event, scope) && Array.isArray(event.payload?.outputPaths))
    .map(event => {
      const outputPaths = event.payload.outputPaths.filter(path => typeof path === 'string');
      return { observationId: `execution:${event.eventId}`, memoryId: `execution:${event.eventId}`, memoryType: 'execution_observation',
        taskId: event.taskId, observedAt: event.createdAt, outputPaths, text: outputPaths.join('\n'), evidenceEventIds: [event.eventId],
        currentArtifactVerified: false, executionAuthority: false };
    });
}

export function preferenceSourcesMatch(preference, events, scope) {
  if (scope === undefined) return true;
  const requested = normalizeMemoryScope(scope);
  if (!requested || !preferenceScopeMatches(preference.scopePolicy, { userScope: requested.userId, workspaceScope: requested.workspaceRoot, conversationScope: requested.conversationId })) return false;
  const ids = preference.evidenceEventIds ?? [];
  return ids.length > 0 && ids.every(id => {
    const event = sourceEvent(events, id);
    return event && sourceRecallAllowed(event) && memoryScopeMatches(event, scope);
  });
}

export function preferenceScopeMatches(left = {}, right = {}) {
  const key = value => JSON.stringify([value.userScope ?? 'default-user',
    value.workspaceScope && value.workspaceScope !== 'default-workspace' ? resolve(value.workspaceScope) : 'default-workspace', value.conversationScope ?? null]);
  return key(left) === key(right);
}
