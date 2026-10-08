// Memory supplies context, never execution permission or a current result proof.
// Unknown/legacy rows are preserved as unattributed references, not preferences.
export function projectMemoryContext(items = []) {
  const userPreferences = [], memoryEvidence = [];
  for (const item of items) {
    if (!item || item.memoryType === 'selected_conversation_quote') continue;
    const memoryId = item.eventId ?? item.memoryId ?? 'memory_item';
    const summary = item.payload?.rawText ?? item.description ?? item.text ?? 'memory context';
    const kind = item.provenance?.memoryKind;
    const sourceEventIds = Array.isArray(item.provenance?.sourceEventIds) ? item.provenance.sourceEventIds.filter(id=>typeof id==='string'&&id.length>0) : [];
    const observedAt = Array.isArray(item.provenance?.observedAt) ? item.provenance.observedAt.filter(at=>typeof at==='string') : [];
    const confirmedPreference = item.memoryType === 'confirmed_preference' && kind === 'user_confirmed_preference'
      && item.provenance?.missingSourceCount === 0 && sourceEventIds.length>0;
    const basis = confirmedPreference ? 'user-confirmed-preference'
      : kind === 'user_statement' ? 'user-statement'
      : kind === 'execution_observation' ? 'historical-execution-observation'
      : kind === 'failure_observation' ? 'historical-failure-observation'
      : ['preference_hypothesis','procedure_candidate'].includes(kind) ? 'system-inference'
      : 'unattributed-context';
    const reference = {memoryId, summary, basis,
      sourceEventIds,
      observedAt,
      validity: structuredClone(item.provenance?.validity ?? {validUntil:null,basis:'unspecified'}),
      usageScopes: structuredClone(item.provenance?.usageScopes ?? []),
      revisionReference: structuredClone(item.provenance?.revisionReference ?? {revision:null,supersedesEventId:null}),
      revisionHistory: structuredClone(item.provenance?.revisionHistory ?? []),
      scopePolicy: structuredClone(item.provenance?.scopePolicy ?? null),
      requiresUserResolution:item.requiresUserResolution === true,
      independentlyVerifiedOutcome:false, currentArtifactVerified:false, executionAuthority:false};
    memoryEvidence.push(reference);
    if (confirmedPreference) userPreferences.push(reference);
  }
  return {userPreferences, memoryEvidence};
}
