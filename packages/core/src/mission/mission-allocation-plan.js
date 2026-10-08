import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createGoalContract} from './goal-contract.js';
import {evaluateGoalQuantityConstraints} from './goal-quantity-expression.js';
import {verifyArtifactConsistencyCriterion} from './criteria-evidence.js';
import {rejectDuplicateKeys} from './mission-source-outcome-oracle.js';
import {recordCountSource,verifyMissionRecordCount} from './mission-record-count.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

/** Explicit local planning output, never a delivery observation or send grant. */
export function allocationPlanSource(mission){
 const objective=mission.objective??'';
 const match=/^((?:'[^'\r\n]{1,200}'\s*,\s*)*'[^'\r\n]{1,200}') (.+)에게 (.+) 배부할 계획을 '([^'\r\n]+\.json)'에 JSON으로 저장해[.!]?$/u.exec(objective);
 if(!match)return null;
 const labels=[...match[1].matchAll(/'([^']+)'/gu)].map(m=>m[1]);
 const contract=createGoalContract({objective});
 const [people,copies]=contract.quantities;
 const recognized=contract.quantities.length===2&&people.text===match[2]&&people.baseUnit==='명'&&!people.distribution
   &&copies.text===match[3]&&copies.baseUnit==='부'&&copies.distribution==='per-item';
 return {kind:'allocation-plan',path:match[4],labels,contract,sourceValid:recognized&&labels.length<=1000&&new Set(labels).size===labels.length&&labels.every(label=>label.trim()===label&&!/[\u0000-\u001f\u007f]/u.test(label))};
}

export function verifyMissionAllocationPlan({mission,criterion,observations,evidenceActionIds,allowedRoots,beforeAccess}){
 const source=allocationPlanSource(mission);
 if(!source||criterion.statement!==mission.objective)return {applicable:false};
 const deny=reason=>({applicable:true,passed:false,status:'unverified',reasons:[reason],checks:[]});
 if(!source.sourceValid)return deny('allocation-source-unresolved');
 if(mission.goalContract?.objective!==mission.objective||mission.goalContract.objectiveSha256!==hash(mission.objective))return deny('allocation-source-changed');
 if(criterion.artifactRole==='input')return deny('allocation-output-required');
 if(criterion.verificationSpec)return {applicable:false};
 return {applicable:true,...verifyArtifactConsistencyCriterion({spec:{},observations,evidenceActionIds,roots:allowedRoots.map(root=>resolve(root)),filePaths:{allocation:source.path},beforeAccess,
  compare:({files})=>{
   let plan;
   try{const text=new TextDecoder('utf-8',{fatal:true}).decode(files.allocation);rejectDuplicateKeys(text);plan=JSON.parse(text);}catch{return deny('allocation-json-invalid');}
   if(!exact(plan,['version','kind','allocations','totalCopies','deliveryVerified'])||plan.version!==1||plan.kind!=='planned-copy-allocation'||plan.deliveryVerified!==false
     ||!Array.isArray(plan.allocations)||plan.allocations.length>1000||!Number.isSafeInteger(plan.totalCopies)||plan.totalCopies<0)return deny('allocation-contract-invalid');
   const seen=new Set();let total=0n;
   const [people,copies]=source.contract.quantities;
   const peopleCheck=evaluateGoalQuantityConstraints({quantities:[people]},[{quantityId:people.quantityId,baseUnit:'명',baseUnits:source.labels.length}]);
   if(!peopleCheck.passed)return deny('allocation-source-recipient-count-mismatch');
   if(copies.status!=='parsed')return deny('allocation-source-copy-count-unresolved');
   // Strip distribution only for comparing each individual bound row. This is
   // not the unbound submitted-measurement API and does not attest delivery.
   const individual={...copies,distribution:null};
   for(const row of plan.allocations){
    if(!exact(row,['recipient','copies'])||typeof row.recipient!=='string'||!source.labels.includes(row.recipient)||seen.has(row.recipient)
      ||!Number.isSafeInteger(row.copies)||row.copies<0)return deny('allocation-target-or-unit-invalid');
    seen.add(row.recipient);
    if(!evaluateGoalQuantityConstraints({quantities:[individual]},[{quantityId:copies.quantityId,baseUnit:'부',baseUnits:row.copies}]).passed)return deny('allocation-per-recipient-count-mismatch');
    total+=BigInt(row.copies);
   }
   if(seen.size!==source.labels.length)return deny('allocation-required-recipient-missing');
   if(total>BigInt(Number.MAX_SAFE_INTEGER)||total!==BigInt(plan.totalCopies))return deny('allocation-total-mismatch');
   return {passed:true,status:'passed',reasons:[],checks:[{checkId:'source_quantity_allocation_plan',passed:true,
    actualRecipientCount:seen.size,actualTotalCopies:Number(total),peopleQuantityId:people.quantityId,copiesQuantityId:copies.quantityId,
    sourceObjectiveSha256:mission.goalContract.objectiveSha256,goalRevision:mission.goalContract.revision,artifactContentSha256:hash(files.allocation),
    plannedAllocationVerified:true,measurementProvenanceVerified:true,verificationScope:'current-g-bound-targeted-copy-plan',
    deliveryVerified:false,executionAuthorized:false}]};
  }})};
}

export function missionSourceQuantity(mission){return recordCountSource(mission)??allocationPlanSource(mission);}
export function verifyMissionSourceQuantity(input){return recordCountSource(input.mission)?verifyMissionRecordCount(input):verifyMissionAllocationPlan(input);}
