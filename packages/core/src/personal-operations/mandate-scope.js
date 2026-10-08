import {isAbsolute,relative,sep} from 'node:path';
const invalid = () => { throw new Error('A_MANDATE_SCOPE_INVALID'); };
// Only recursive local metadata references inherit a parent grant. A tree
// never grants file-content access. Explicit tree exclusions cover contents too.
function treeContains(parent,child,{deny=false}={}) {
  if(!parent.startsWith('file-tree:'))return false;
  const prefix=child.startsWith('file-tree:')?'file-tree:':deny&&child.startsWith('file:')?'file:':null;
  if(!prefix)return false;
  const base=parent.slice(10),target=child.slice(prefix.length);
  if(!isAbsolute(base)||!isAbsolute(target))return false;
  const rel=relative(base,target);
  return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);
}
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function ref(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 300
      || /[\u0000-\u001f]/u.test(value)) invalid();
  return value;
}
function refs(value) {
  if (!Array.isArray(value) || value.length > 100) invalid();
  const result = value.map(ref);
  if (new Set(result).size !== result.length) invalid();
  return result.sort();
}
export function normalizeMandateScope(value) {
  keys(value, ['accountRef', 'dataRefs', 'deniedDataRefs']);
  const accountRef = value.accountRef === null ? null : ref(value.accountRef);
  const dataRefs = refs(value.dataRefs), deniedDataRefs = refs(value.deniedDataRefs);
  if (deniedDataRefs.some(item => !dataRefs.includes(item))) invalid();
  return { accountRef, dataRefs, deniedDataRefs };
}
export function normalizeMandateRequestScope(value) {
  const result = {};
  if (Object.hasOwn(value, 'accountRef')) result.accountRef = value.accountRef === null ? null : ref(value.accountRef);
  if (Object.hasOwn(value, 'dataRefs')) result.dataRefs = refs(value.dataRefs);
  if (Object.hasOwn(value, 'mandateRevision')) {
    if (!Number.isSafeInteger(value.mandateRevision) || value.mandateRevision < 1) invalid();
    result.mandateRevision = value.mandateRevision;
  }
  return result;
}
export function mandateScopeReasons(mandate, input) {
  const request = normalizeMandateRequestScope(input), reasons = [];
  if (!mandate.scope) return Object.keys(request).length ? ['scope-not-delegated'] : [];
  if (request.mandateRevision !== mandate.revision) reasons.push('mandate-revision-mismatch');
  if (!Object.hasOwn(request, 'accountRef')) reasons.push('account-ref-required');
  else if (request.accountRef !== mandate.scope.accountRef) reasons.push('account-ref-mismatch');
  if (!Object.hasOwn(request, 'dataRefs')) reasons.push('data-refs-required');
  else {
    if (request.dataRefs.some(item => !mandate.scope.dataRefs.some(grant=>grant===item||treeContains(grant,item)))) reasons.push('data-scope-exceeded');
    if (request.dataRefs.some(item => mandate.scope.deniedDataRefs.some(denied=>denied===item||treeContains(denied,item,{deny:true})))) reasons.push('data-exception-denied');
  }
  return reasons;
}
