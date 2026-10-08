import {SqliteMissionStore} from './sqlite-mission-store.js';
import {MissionExecutionAuthority} from './mission-execution-authority.js';
import {sourceBinding,sourceMoney} from './mission-money-dependency.js';
import {dependencyImpactDigest} from './dependency-impact-digest.js';
const fail=reason=>{throw Object.assign(new Error('A_COMMERCE_MISSION_SOURCE_'+reason),{code:'A_COMMERCE_MISSION_SOURCE_'+reason});};

/** Host-installed source predicate, additional to E policy, quote verification,
 * mandate and budget. A model/caller cannot submit its own source proof. */
export class MissionCommerceSourceGate {
 constructor({runtime,operationsStore}={}){
  if(!(runtime?.store instanceof SqliteMissionStore)||runtime.store.operationsStore!==operationsStore
   ||!(runtime.executionAuthority instanceof MissionExecutionAuthority)||runtime.executionAuthority.store!==runtime.store)
   fail('AUTHORITY_REQUIRED');
  this.runtime=runtime;this.operationsStore=operationsStore;
 }
 current(missionId){
  try{this.runtime.executionAuthority.assertActive();}catch{fail('AUTHORITY_UNAVAILABLE');}
  if(this.runtime.store._snapshot().revision!==this.runtime.store.revision)fail('CORE_STALE');
  const mission=this.runtime.missions.get(missionId);
  if(!mission||['COMPLETED','FAILED','CANCELLED'].includes(mission.status))fail('MISSION_UNAVAILABLE');
  return mission;
 }
 capture(missionId,order){
  const mission=this.current(missionId),binding=sourceBinding(mission);
  const comparison=sourceMoney(mission,{sourceBinding:binding,request:order.request});
  // A minimum amount is a calculable source predicate, never a spending cap.
  // Preserve the existing transaction ceiling requirement independently of
  // the read-only dependency calculation's lower-bound support.
  if(comparison.required!==true||comparison.passed!==true||!['lt','lte'].includes(comparison.comparator))fail('LIMIT_UNVERIFIED');
  return {version:1,missionId,sourceBinding:binding,currency:order.expected.currency,totalMinor:order.expected.totalMinor,
   quoteEvidenceSha256:order.quoteEvidenceSha256,executionAuthority:false};
 }
 assertCurrent(binding,order){
  if(!binding||binding.version!==1)fail('BINDING_REQUIRED');
  const expected=this.capture(binding.missionId,order);
  if(dependencyImpactDigest(expected)!==dependencyImpactDigest(binding))fail('BINDING_CHANGED');
  return true;
 }
}
