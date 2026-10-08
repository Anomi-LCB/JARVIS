import { createHash } from 'node:crypto';
import { createGoalContract, GOAL_CONTRACT_VERSION } from './goal-contract.js';
const digest = text => createHash('sha256').update(text).digest('hex');

// Failed lexical interpretation must not delete or invent requirements. Keep
// the original request for a later planner while explicitly withholding coverage.
export function captureMissionGoalContract({ objective, resolvedObjective = objective, missionId, successCriteria, createdAt }) {
  // Existing mission IDs may contain Korean. Contract IDs are opaque ASCII;
  // hash the identity instead of discarding source clauses on ID validation.
  const goalId = `goal_${digest(missionId).slice(0, 24)}`;
  let contract;
  try {
    contract = createGoalContract({ objective, goalId, successCriteria, referenceTime: createdAt });
  } catch (error) {
    const requirementId = `req_${digest(objective).slice(0, 24)}_1`;
    contract = { schemaVersion: GOAL_CONTRACT_VERSION, goalId, revision: 1, objective,
      objectiveSha256: digest(objective), offsetEncoding: 'utf16-code-units', referenceTime: createdAt, timeZone: 'Asia/Seoul',
      requirements: [{ requirementId, sourceSpan: { start: 0, end: objective.length }, text: objective,
        sourceRevision: 1, interpretation: { status: 'unresolved', polarity: 'unknown' }, dependsOn: [] }],
      successCriteria: structuredClone(successCriteria), criterionBindings: [],
      unresolvedCriterionIds: successCriteria.map(criterion => criterion.criterionId),
      unresolvedRequirementIds: [requirementId], constraints: [], amounts: [], times: [], contradictions: [],
      interpretationBasis: 'unparsed-original-request', semanticCoverage: 'unverified', executionAuthorized: false,
      interpretationIssue: typeof error.code === 'string' && /^A_GOAL_/.test(error.code) ? error.code : 'A_GOAL_INTERPRETATION_UNAVAILABLE' };
  }
  return { ...contract, resolvedObjectiveSha256: digest(resolvedObjective),
    referenceSubstitutionApplied: objective.trim() !== resolvedObjective };
}
