import { createHash } from 'node:crypto';
const fail=()=>{throw Object.assign(new Error('Invalid host evaluation requirement contract'),{code:'A_EVALUATION_REQUIREMENT_CONTRACT_INVALID'});};
export function snapshotEvaluationRequirements(contract) {
  if (contract === null || contract === undefined) return null;
  if (!contract || typeof contract.originalRequest !== 'string' || !contract.originalRequest.trim()
    || contract.originalRequest.length>100000 || !Number.isSafeInteger(contract.revision) || contract.revision<1
    || !Array.isArray(contract.requirements) || contract.requirements.length<1 || contract.requirements.length>100
    || Object.keys(contract).some(k=>!['originalRequest','revision','requirements'].includes(k))) fail();
  const ids=new Set();
  const requirements=contract.requirements.map(r=>{
    if(!r || typeof r.id!=='string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(r.id) || ids.has(r.id)
      || typeof r.text!=='string' || !r.text.trim() || r.text.length>10000 || Object.keys(r).some(k=>!['id','text'].includes(k)))fail();
    ids.add(r.id);return Object.freeze({id:r.id,text:r.text});
  });
  const value=Object.freeze({originalRequest:contract.originalRequest,revision:contract.revision,requirements:Object.freeze(requirements)});
  return Object.freeze({value,sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex')});
}
export function assertEvaluationRequirementCoverage(contract,cases) {
  if(!contract)return;
  const required=new Set(contract.value.requirements.map(r=>r.id)),covered=new Set();
  for(const c of cases){
    if(!Array.isArray(c.requirementIds)||c.requirementIds.length<1||new Set(c.requirementIds).size!==c.requirementIds.length
      ||c.requirementIds.some(id=>typeof id!=='string'||!required.has(id)))throw Object.assign(new Error('Case requirement mapping invalid'),{code:'A_EVALUATION_REQUIREMENT_COVERAGE_INVALID'});
    c.requirementIds.forEach(id=>covered.add(id));
  }
  if(covered.size!==required.size)throw Object.assign(new Error('Required evaluation cases missing'),{code:'A_EVALUATION_REQUIREMENTS_MISSING'});
}
