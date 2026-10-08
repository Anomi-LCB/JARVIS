import { capturePlannedCapabilityBinding,requiresCapabilityAvailability } from './mission-capability-availability.js';
import {dependencyImpactDigest} from './dependency-impact-digest.js';
export {dependencyImpactDigest} from './dependency-impact-digest.js';
import {missionMoneyDependencyImpact} from './mission-money-dependency.js';

const terminal = new Set(['COMPLETED','CANCELLED','FAILED']);
const finished = new Set(['succeeded','skipped']);

// Paginated current projections must not silently mix changed prerequisites.
export function missionDependencyImpacts(runtime,{limit=50,cursor=null}={}){
  const invalid=code=>({error:{code},executionAuthority:false});
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)return invalid('A_MISSION_IMPACT_PAGE_INVALID');
  if(cursor!==null&&(typeof cursor!=='string'||cursor.length>2048))return invalid('A_MISSION_IMPACT_CURSOR_INVALID');
  const ids=[...runtime.missions.keys()].sort();
  if(ids.length>5000)return invalid('A_MISSION_IMPACT_SCAN_LIMIT');
  const items=ids.map(id=>missionDependencyImpact(runtime,id));
  const digest=dependencyImpactDigest(items);
  let offset=0;
  if(cursor!==null){
    let token;try{token=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{return invalid('A_MISSION_IMPACT_CURSOR_INVALID');}
    if(!token||Object.keys(token).sort().join(',')!=='offset,sha256,version'||token.version!==1
      ||!Number.isSafeInteger(token.offset)||token.offset<1||token.offset>=items.length
      ||!/^[a-f0-9]{64}$/u.test(token.sha256??''))return invalid('A_MISSION_IMPACT_CURSOR_INVALID');
    if(token.sha256!==digest)return invalid('A_MISSION_IMPACT_SNAPSHOT_CHANGED');
    offset=token.offset;
  }
  const nextOffset=Math.min(offset+limit,items.length),counts={current:0,'requires-review':0,unknown:0,historical:0};
  for(const item of items)counts[item.status]++;
  return {impactVersion:'a-mission-dependency-impacts-v1',observedAt:runtime.clock().toISOString(),
    items:items.slice(offset,nextOffset),total:items.length,counts,snapshotSha256:digest,
    nextCursor:nextOffset<items.length?Buffer.from(JSON.stringify({version:1,sha256:digest,offset:nextOffset})).toString('base64url'):null,
    executionAuthority:false,scope:'current-explicit-links-and-planned-dependencies-only',
    persistence:'read-only-current-projection',semanticRelatednessVerified:false};
}

// Current, read-only projections of explicit dependencies. No probe, grant,
// reservation, cancellation, plan mutation or inferred cross-task dependency.
export function missionDependencyImpact(runtime, missionId) {
  const mission=runtime.missions.get(missionId);
  if(!mission)return {error:{code:'A_MISSION_NOT_FOUND'}};
  const now=runtime.clock().toISOString(),reasons=[],unknown=[];
  let deadline=null,schedule=null;
  const guard=runtime.personalDependencyGuard;
  if(guard){
    try{
      const link=guard.store.db.prepare('SELECT * FROM personal_mission_links WHERE mission_id=?').get(missionId);
      if(link){
        const row=guard.row(link.followup_id);
        deadline=guard.deadlineImpact(row,link,runtime.publicMission(mission));
        if(deadline.status!=='current')reasons.push('linked-commitment-changed');
        const source=guard.sourceDependency(row,link);
        if(source.required){
          schedule={...source,acceptedSourceHash:source.boundSourceHash};
          if(schedule.status==='unknown')unknown.push('accepted-source-version-unavailable');
          else if(schedule.status!=='current')reasons.push('accepted-source-'+schedule.status);
        }
      }
    }catch{unknown.push('personal-dependency-read-unavailable');}
  }
  let quota={status:'not-required',reasons:[],executionAuthority:false};
  if(mission.executionMandateId){
    try{
      if(typeof runtime.executionBudget?.inspect!=='function')throw new Error('unavailable');
      quota=runtime.executionBudget.inspect(mission);
      // A past settled effect stays a valid historical result; this calculation
      // describes prerequisites for new work, not revocation of past receipts.
      if(!terminal.has(mission.status))reasons.push(...quota.reasons);
    }catch{quota={status:'unknown',executionAuthority:false};unknown.push('budget-read-unavailable');}
  }
  const money=missionMoneyDependencyImpact(runtime,missionId);
  if(!terminal.has(mission.status))for(const item of money){if(item.status==='unknown')unknown.push(...item.reasons);else if(item.status!=='current')reasons.push(...item.reasons);}
  const remaining=runtime.remainingBudget(mission,Date.now());
  // This read projection reports recorded runtime only. Do not let the few
  // milliseconds spent calculating the projection consume a Mission budget.
  remaining.activeRuntimeMs=Math.max(0,mission.budgets.maxActiveRuntimeMs-mission.metrics.activeRuntimeMs);
  if(!terminal.has(mission.status)){
    if(remaining.actions===0)reasons.push('mission-action-budget-exhausted');
    if(remaining.activeRuntimeMs===0)reasons.push('mission-runtime-budget-exhausted');
  }
  const actions=mission.waves.flatMap(wave=>wave.actions).map(action=>{
    const codes=[],unmeasured=[],snapshot=action.availabilityBindingSnapshot;
    const toolName=action.actualToolName??action.expectedToolName;
    const contract=runtime.pcAgent.registry?.contractFor?.(toolName)??{};
    const binding=snapshot?.binding??action.plannedCapabilityBinding??contract.availabilityBinding;
    let availability=null;
    if(contract.availabilityBinding&&binding&&JSON.stringify(capturePlannedCapabilityBinding(contract.availabilityBinding))!==JSON.stringify(capturePlannedCapabilityBinding(binding)))
      codes.push('contract-binding-changed');
    // This endpoint never invokes a potentially remote resolver/probe. A stored
    // binding is not proof that a dynamic resolver still selects that binding.
    if(binding&&runtime.capabilityAvailabilityGuard.resolver)unmeasured.push('dynamic-binding-not-rechecked');
    if(binding&&!binding.invalid){
      try{
        const registry=runtime.capabilityAvailabilityGuard.registry;
        availability=registry.availabilityFor(binding,{minimumVerification:'live-probe',permissionRevision:snapshot?.permissionRevision??null});
        codes.push(...availability.reasons.map(reason=>reason.code));
        if(snapshot?.codeVersion&&snapshot.codeVersion!==availability.codeVersion)codes.push('code-version-changed');
      }catch{unmeasured.push('capability-read-unavailable');}
    }else if(binding?.invalid||requiresCapabilityAvailability(toolName,contract))unmeasured.push('capability-binding-unavailable');
    // actionAuthorized mutates authorization metadata on its input; use a copy.
    let authorization='unknown';
    try{
      const task=action.taskId?runtime.coreFacade.getTask(action.taskId):null;
      if(task?.plan){
        authorization=runtime.actionAuthorized(mission,structuredClone(action),runtime.capabilityProfile(task))?'current':'requires-review';
        if(authorization!=='current')codes.push('action-authorization-required');
      }else unmeasured.push('action-policy-not-prepared');
    }catch{unmeasured.push('authorization-read-unavailable');}
    return {actionId:action.actionId,dependencies:[...(action.dependencies??[])],executionState:action.status,
      historical:finished.has(action.status),directReasons:[...new Set(codes)],unknownReasons:[...new Set(unmeasured)],
      authorization,availability:availability?{status:availability.status,observedAt:availability.observedAt,
        evaluatedAt:availability.evaluatedAt,accountStatus:availability.accountStatus,deviceStatus:availability.deviceStatus,
        permissionRevision:availability.permissionRevision,binding:structuredClone(binding)}:null,
      affectedBy:[],executionAuthority:false};
  });
  const ids=new Map(actions.map(action=>[action.actionId,action]));
  for(const action of actions){
    if(action.historical){action.status='historical';continue;}
    const visited=new Set(),path=new Set([action.actionId]),visit=id=>{
      if(path.has(id)){action.unknownReasons.push('dependency-cycle');return;}
      if(visited.has(id))return;visited.add(id);
      const parent=ids.get(id);
      if(!parent){action.unknownReasons.push('dependency-action-missing');return;}
      if(parent.historical)return;
      if(!parent.historical&&(parent.directReasons.length||parent.unknownReasons.length))action.affectedBy.push(id);
      path.add(id);
      for(const next of parent.dependencies)visit(next);
      path.delete(id);
    };
    for(const parent of action.dependencies)visit(parent);
    action.affectedBy=[...new Set(action.affectedBy)].sort();
    action.status=reasons.length||action.directReasons.length||action.affectedBy.length?'requires-review'
      :unknown.length||action.unknownReasons.length?'unknown':'current';
  }
  const affected=actions.filter(action=>!action.historical&&action.status==='requires-review');
  const uncertain=actions.filter(action=>!action.historical&&action.status==='unknown');
  return {impactVersion:'a-mission-dependency-impact-v1',missionId,observedAt:now,missionStatus:mission.status,
    status:terminal.has(mission.status)?'historical':reasons.length||affected.length?'requires-review':unknown.length||uncertain.length||!actions.length?'unknown':'current',
    reasons:[...new Set(reasons)],unknownReasons:[...new Set(unknown)],deadline,schedule,
    budget:{quota,money,remaining,activeRuntimeMeaning:'recorded-runtime-only'},actions,
    affectedActionIds:affected.map(action=>action.actionId),unknownActionIds:uncertain.map(action=>action.actionId),
    completedActionCount:mission.metrics.successfulActions,executionAuthority:false,
    scope:'explicit-links-and-planned-action-dependencies-only',
    nextAction:reasons.length||affected.length?'이미 실행된 결과를 보존하고 변경된 조건을 확인한 뒤 남은 작업을 다시 계획하세요.'
      :unknown.length||uncertain.length||!actions.length?'아직 계획되지 않았거나 확인되지 않은 조건을 먼저 확인하세요.':null};
}
