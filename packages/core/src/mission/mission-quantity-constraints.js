import {createHash} from 'node:crypto';
import {createGoalContract,GOAL_CONTRACT_VERSION} from './goal-contract.js';
import {evaluateGoalQuantityConstraints} from './goal-quantity-expression.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};

/** Read-only source-bound calculation. Submitted measurements remain unattested. */
export function assessMissionQuantityConstraints(runtime,missionId,input){
 if(!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).some(k=>!['expectedGoalRevision','expectedObjectiveSha256','measurements'].includes(k))
  ||!Number.isSafeInteger(input.expectedGoalRevision)||input.expectedGoalRevision<1
  ||typeof input.expectedObjectiveSha256!=='string'||!/^[a-f0-9]{64}$/u.test(input.expectedObjectiveSha256)
  ||!Array.isArray(input.measurements))fail('A_MISSION_QUANTITY_INPUT_INVALID');
 const mission=runtime.missions.get(missionId);if(!mission)fail('A_MISSION_NOT_FOUND');
 const current=mission.goalContract;
 if(current?.schemaVersion!==GOAL_CONTRACT_VERSION||typeof current.objective!=='string')fail('A_MISSION_QUANTITY_CONTRACT_UNAVAILABLE');
 if(current.revision!==input.expectedGoalRevision||current.objectiveSha256!==input.expectedObjectiveSha256)
  fail('A_MISSION_QUANTITY_REVISION_CONFLICT');
 if(createHash('sha256').update(current.objective).digest('hex')!==current.objectiveSha256)fail('A_MISSION_QUANTITY_CONTRACT_CORRUPTED');
 let contract,result;
 try{
  // Recalculate facts from the exact source rather than accepting planner or
  // persisted metadata claiming particular quantities/verification flags.
  contract=createGoalContract({objective:current.objective,goalId:current.goalId,revision:current.revision,referenceTime:current.referenceTime,timeZone:current.timeZone});
  result=evaluateGoalQuantityConstraints(contract,input.measurements);
 }catch{fail('A_MISSION_QUANTITY_INPUT_INVALID');}
 return {missionId,goalRevision:current.revision,objectiveSha256:current.objectiveSha256,...result,
  sourceQuantitiesRecomputed:true,measurementMeaning:'caller-submitted-unattested-base-units',effectsDispatched:0};
}
