// Host-owned policy for Mission model inputs. This is eligibility/minimization,
// never an account permission or an external-transfer approval.
export const DATA_PURPOSE_POLICY_VERSION = 'mission-data-purpose-v1';
export const MANAGED_EVIDENCE_PURPOSE = 'mission-tool-evidence';
const kindsByPurpose = Object.freeze({
  'mission-planning': Object.freeze(['USER_REQUEST', 'USER_CONTEXT', 'LOCAL_FILE_CONTENT']),
  [MANAGED_EVIDENCE_PURPOSE]: Object.freeze(['LOCAL_FILE_CONTENT'])
});
const localOnlyFlags = new Set(['secret', 'national_id', 'financial', 'ministry_finance', 'health',
  'pastoral_care', 'minor', 'family_sensitive', 'ministry_sensitive']);
const maskedFlags = new Set(['email', 'pii', 'phone_number']);

export function evaluateMissionDataPurpose({ purpose, contentKind, classification } = {}) {
  const result = (action, reason, categories = []) => ({ policyVersion: DATA_PURPOSE_POLICY_VERSION,
    purpose: Object.hasOwn(kindsByPurpose, purpose ?? '') ? purpose : 'unrecognized',
    contentKind: ['USER_REQUEST', 'USER_CONTEXT', 'LOCAL_FILE_CONTENT'].includes(contentKind) ? contentKind : 'unrecognized',
    action, reason, categories, executionAuthorized: false });
  if (!Object.hasOwn(kindsByPurpose, purpose ?? '') || !kindsByPurpose[purpose].includes(contentKind)) {
    return result('withhold', 'data-purpose-not-permitted');
  }
  if (!classification || typeof classification !== 'object' || Array.isArray(classification)
    || typeof classification.then === 'function' || !/^D[0-4]$/u.test(classification.dataClass ?? '')
    || classification.ministryDataClass !== undefined && !/^M[0-4]$/u.test(classification.ministryDataClass)
    || classification.sensitiveFlags !== undefined && (!Array.isArray(classification.sensitiveFlags)
      || classification.sensitiveFlags.some(flag => typeof flag !== 'string'))) {
    return result('withhold', 'classification-invalid');
  }
  const flags = [...new Set(classification.sensitiveFlags ?? [])];
  if (flags.some(flag => !localOnlyFlags.has(flag) && !maskedFlags.has(flag))) {
    return result('withhold', 'classification-category-unsupported');
  }
  const rank = Math.max(Number(classification.dataClass[1]), Number(classification.ministryDataClass?.[1] ?? 0));
  if (rank >= 3 || flags.some(flag => localOnlyFlags.has(flag))) return result('withhold', 'sensitive-content-withheld', flags);
  if (rank >= 2 || flags.some(flag => maskedFlags.has(flag))) return result('mask', 'minimization-required', flags);
  return result('retain', 'purpose-eligible', flags);
}
