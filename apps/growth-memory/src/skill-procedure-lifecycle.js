import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createProcedureLifecycle(definition, options = {}, createdAt) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key=>key!=='expiresAt')) throw new Error('F_SKILL_PROCEDURE_LIFECYCLE_INVALID');
  const created = Date.parse(createdAt);
  const expiresAt = options.expiresAt ?? new Date(created + 7*86400000).toISOString();
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(created) || typeof expiresAt !== 'string' || !Number.isFinite(expiry)
    || new Date(expiry).toISOString() !== expiresAt || expiry <= created || expiry-created > 30*86400000) throw new Error('F_SKILL_PROCEDURE_LIFECYCLE_INVALID');
  const contract = { version:'f-tabular-procedure-lifecycle-v1', definitionSha256:hash(definition),
    applicability:{ kind:'tabular-group-sum-v1', minRows:1, maxRows:1000, scalarCellsOnly:true, uniqueGroupAndValueColumns:true },
    verifier:{ id:'f-tabular-cross-material-oracle-v1', runtimeId:'g-tabular-result-v1', requiresDistinctSources:true, requiresRenamedHoldout:true },
    failure:{ action:'stop-without-artifact', preserveOriginalInput:true },
    recovery:{ action:'explicit-reviewed-revision-or-rollback', allowAutomaticRetry:false },
    expiresAt };
  return {...contract,contractSha256:hash(contract)};
}
export function procedureLifecycleIssue(revision, now) {
  if (!revision?.procedureDefinition) return null;
  try {
    const contract=revision.procedureLifecycle;
    if (!contract) return 'F_SKILL_PROCEDURE_LIFECYCLE_REQUIRED';
    const expected=createProcedureLifecycle(revision.procedureDefinition,{expiresAt:contract.expiresAt},revision.createdAt);
    if (JSON.stringify(contract)!==JSON.stringify(expected)) return 'F_SKILL_PROCEDURE_LIFECYCLE_INVALID';
    if (!Number.isFinite(Date.parse(now))) return 'F_SKILL_PROCEDURE_LIFECYCLE_INVALID';
    return Date.parse(now)>=Date.parse(contract.expiresAt) ? 'F_SKILL_PROCEDURE_EXPIRED' : null;
  } catch { return 'F_SKILL_PROCEDURE_LIFECYCLE_INVALID'; }
}
