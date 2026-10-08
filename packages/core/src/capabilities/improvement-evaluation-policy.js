import {createHash} from 'node:crypto';
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
/** Stable host policy only; availability and measured spend are not configuration. */
export function snapshotImprovementEvaluationPolicy(value){
 if(!value||value.schemaVersion!=='a-improvement-evaluation-policy-v1'
  ||typeof value.mandateId!=='string'||!/^[a-zA-Z0-9_.:-]{1,200}$/.test(value.mandateId)
  ||!hex(value.suiteSha256)||!hex(value.requirementContractSha256)
  ||!integer(value.maxTimeoutMs,100,120000)||!integer(value.maxCalls,1,100000)||!integer(value.totalMinor,0)
  ||value.preparationReservation!=='before-research-and-generation'
  ||![null,'local-workflow-files-v1'].includes(value.resultContract))return null;
 const money=value.monetaryPolicy,comparison=value.comparison;
 if(money!==null&&(!money||!integer(money.maxCostMinor,1,value.totalMinor)
  ||typeof money.costPolicyId!=='string'||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(money.costPolicyId)))return null;
 if(money===null&&value.totalMinor!==0)return null;
 if(comparison!==null&&(!comparison||!integer(comparison.repeats,3,10)||!integer(comparison.minimumAdditionalPasses,1,100)))return null;
 const policy={schemaVersion:value.schemaVersion,mandateId:value.mandateId,suiteSha256:value.suiteSha256,
  requirementContractSha256:value.requirementContractSha256,maxTimeoutMs:value.maxTimeoutMs,maxCalls:value.maxCalls,totalMinor:value.totalMinor,
  monetaryPolicy:money===null?null:{maxCostMinor:money.maxCostMinor,costPolicyId:money.costPolicyId},resultContract:value.resultContract,
  comparison:comparison===null?null:{repeats:comparison.repeats,minimumAdditionalPasses:comparison.minimumAdditionalPasses},preparationReservation:value.preparationReservation};
 return{policy,sha256:createHash('sha256').update(JSON.stringify(policy)).digest('hex')};
}
