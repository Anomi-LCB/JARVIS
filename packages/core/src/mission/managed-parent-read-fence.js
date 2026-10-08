import {missionEgressGoalBinding} from './mission-egress-goal-binding.js';

/** Restriction only: a child read never acquires a parent's quota or grant. */
export function withManagedParentReadFence({runtime,mission,executor,beforeExecute}){
 const binding=mission.metadata?.managedAgentReadScope;
 if(!binding)return beforeExecute;
 const assertCurrent=packet=>{
  const parent=runtime.missions.get(mission.metadata.managedAgentParentMissionId);
  if(!parent||['COMPLETED','CANCELLED','FAILED','BLOCKED'].includes(parent.status)
   ||!parent.authorization?.grants?.includes('read_only')
   ||missionEgressGoalBinding(parent)!==binding.goalBinding
   ||(parent.executionMandateId??null)!==binding.executionMandateId
   ||packet?.action?.toolName!=='filesystem.readText'||packet.action.arguments?.path!==binding.path)
   throw Object.assign(Error('A_MANAGED_AGENT_PARENT_READ_SCOPE_CHANGED'),{notDispatched:true});
  if(parent.executionMandateId){
   if(executor?.supportsTrustedLocalMissionEffects?.()!==true)throw Object.assign(Error('A_MANAGED_AGENT_PARENT_READ_FENCE_UNSUPPORTED'),{notDispatched:true});
   const guard=runtime.resultReadGuard(parent);
   if(typeof guard!=='function')throw Object.assign(Error('A_MANDATE_RESULT_PERMISSION_UNAVAILABLE'),{notDispatched:true});
   guard({path:binding.path,kind:'read'});
  }
 };
 return async packet=>{
  assertCurrent(packet);
  const original=beforeExecute?await beforeExecute(packet):null;
  if(beforeExecute&&typeof original!=='function')throw Error('B_LOCAL_EFFECT_FENCE_INVALID');
  const fence=()=>{assertCurrent(packet);original?.();assertCurrent(packet);};
  fence();return fence;
 };
}
