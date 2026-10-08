// Drafts stay in memory and are bound to the revision that the user actually saw.
export function createGoalRevisionDraft(mission) {
  return { missionId: mission.missionId, expectedRevision: mission.goalContract?.revision ?? 1,
    objective: mission.objective ?? '', reason: '', replaceCriteria: false, replaceConstraints: false,
    criteria: (mission.successCriteria ?? []).map(item => item.statement).join('\n'),
    originalCriteria: structuredClone(mission.successCriteria ?? []), confirmExistingCriteria: false,
    criterionRoles: (mission.successCriteria ?? []).map(item => item.artifactRole ?? 'output'),
    constraints: (mission.constraints ?? []).map(item => typeof item === 'string' ? item : item.statement).join('\n'),
    request: null, busy: false, error: null };
}

export function goalRevisionRequest(draft, makeKey = () => `revision_${globalThis.crypto.randomUUID()}`) {
  const objective = draft.objective.trim();
  if (!objective || objective.length > 32768) throw new Error('목표를 1~32,768자 이내로 입력해 주세요.');
  const split = value => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const roles = draft.criterionRoles ?? draft.originalCriteria.map(item => item.artifactRole ?? 'output');
  if (roles.length !== draft.originalCriteria.length || roles.some(role => !['input', 'output'].includes(role))) {
    throw new Error('완료 기준의 자료 종류를 다시 선택해 주세요.');
  }
  const rolesChanged = roles.some((role, index) => role !== (draft.originalCriteria[index].artifactRole ?? 'output'));
  const reviewedCriteria = structuredClone(draft.originalCriteria);
  if (rolesChanged) reviewedCriteria.forEach((item, index) => { item.artifactRole = roles[index]; });
  const payload = { expectedRevision: draft.expectedRevision, objective,
    ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
    ...(draft.replaceCriteria ? { successCriteria: split(draft.criteria) }
      : draft.confirmExistingCriteria || rolesChanged ? { successCriteria: reviewedCriteria } : {}),
    ...(draft.replaceConstraints ? { constraints: split(draft.constraints) } : {}) };
  if (payload.successCriteria?.length === 0) throw new Error('완료 기준을 바꿀 때는 최소 한 가지 기준을 입력해 주세요.');
  // A lost response must reuse the same key; edits represent a new request.
  const fingerprint = JSON.stringify(payload);
  if (draft.request?.fingerprint !== fingerprint) draft.request = { fingerprint, payload: { ...payload, idempotencyKey: makeKey() } };
  return structuredClone(draft.request.payload);
}
