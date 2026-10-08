import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {parseKoreanOneTimeSchedule} from './korean-time-expression.js';
import {createGoalContract} from '../mission/goal-contract.js';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deny=code=>{throw Object.assign(new Error(code),{code,notDispatched:true});};

export function routineMissionRequest(routine) {
  const occurrenceKey=routine.recurrence
    ? `routine:${routine.routineId}:revision:${routine.recurrenceRevision??1}:occurrence:${routine.occurrenceIndex??0}`
    : `routine:${routine.routineId}`;
  return {...routine.missionRequest,idempotencyKey:occurrenceKey,metadata:{...(routine.missionRequest.metadata??{}),
    scheduledRoutineId:routine.routineId,scheduledOccurrence:occurrenceKey,scheduledFor:routine.scheduledAt,recoveredDispatch:false}};
}
function requestHash(request){
  return sha({objective:request.objective,successCriteria:request.successCriteria??[],constraints:request.constraints??[],
    budgets:request.budgets??{},authorization:request.authorization??{},metadata:request.metadata??{},
    ...(request.executionMandateId?{executionMandateId:request.executionMandateId}:{})});
}

/** Server-owned invocation context. No JSON metadata or planner flag grants this proof. */
export class RoutineMissionTemporalGuard {
  constructor({clock}){this.clock=clock;this.stores=new Set();this.context=new AsyncLocalStorage();}
  registerStore(store){this.stores.add(store);}
  bindSourceTime(mission,{toolName,phase='dispatch'}={}){
    if(toolName!=='filesystem.createTextFile')return false;
    try{
      const proof=this.assertCurrentMission(mission,{phase});
      const row=this.context.getStore().store.get(proof.routineId);
      const prefix=row.timeExpression;
      if(row.recurrence||!prefix||!mission.objective.startsWith(prefix+'에 '))return false;
      const parsed=parseKoreanOneTimeSchedule(prefix,{clock:()=>new Date(row.createdAt),timeZone:row.timeZone});
      if(!parsed.success||parsed.expression!==prefix||parsed.scheduledAt!==row.scheduledAt)return false;
      const rest=mission.objective.slice(prefix.length+2);
      return createGoalContract({objective:rest,referenceTime:row.createdAt,timeZone:row.timeZone}).times.length===0;
    }catch{return false;}
  }
  async runClaimed({store,routine,missionId,lateGraceMs},run){
    if(!this.stores.has(store))deny('A_ROUTINE_TEMPORAL_STORE_UNREGISTERED');
    const request=routineMissionRequest(routine);
    const ticket=Object.freeze({store,missionId,routineId:routine.routineId,ownerId:routine.ownerId,attempts:routine.attempts,
      scheduledAt:routine.scheduledAt,occurrenceKey:request.idempotencyKey,requestHash:requestHash(request),
      missionRequestHash:sha(routine.missionRequest),lateGraceMs,enteredAt:this.clock().toISOString()});
    return this.context.run(ticket,run);
  }
  assertCurrentMission(mission,{phase='dispatch'}={}){
    const id=mission.metadata?.scheduledRoutineId;
    if(id===undefined)return null;
    const ticket=this.context.getStore();
    if(!ticket||ticket.missionId!==mission.missionId||ticket.routineId!==id)deny('A_ROUTINE_TEMPORAL_CONTEXT_REQUIRED');
    let row;
    try{row=ticket.store.get(id);}catch{deny('A_ROUTINE_TEMPORAL_STORE_UNAVAILABLE');}
    if(!row||row.status!=='dispatching'||row.ownerId!==ticket.ownerId||row.attempts!==ticket.attempts
      ||row.scheduledAt!==ticket.scheduledAt||sha(row.missionRequest)!==ticket.missionRequestHash
      ||routineMissionRequest(row).idempotencyKey!==ticket.occurrenceKey)deny('A_ROUTINE_TEMPORAL_CLAIM_CHANGED');
    if(mission.idempotencyKey!==ticket.occurrenceKey||mission.creationRequestHash!==ticket.requestHash
      ||mission.objective!==row.missionRequest.objective||mission.goalContract?.revision!==1
      ||mission.metadata.scheduledOccurrence!==ticket.occurrenceKey||mission.metadata.scheduledFor!==ticket.scheduledAt)
      deny('A_ROUTINE_TEMPORAL_REQUEST_CHANGED');
    const checkedAt=this.clock().toISOString(),now=Date.parse(checkedAt),earliest=Date.parse(ticket.scheduledAt);
    const latest=earliest+ticket.lateGraceMs,entered=Date.parse(ticket.enteredAt);
    if(!Number.isFinite(now)||!Number.isFinite(earliest)||now<earliest||now<entered)deny('A_ROUTINE_TEMPORAL_CLOCK_OUTSIDE_WINDOW');
    // Completion is not a newly dispatched effect. Keep its real finish time;
    // grace bounds new handoffs, not the duration of a result already observed.
    if(phase!=='completion'&&phase!=='start'&&now>latest)deny('A_ROUTINE_TEMPORAL_DISPATCH_TOO_LATE');
    const actions=(mission.waves??[]).flatMap(wave=>wave.actions??[]).filter(action=>action.status==='succeeded');
    const verifiedDispatchCount=actions.filter(action=>{
      const proof=action.scheduleTemporalVerification,time=Date.parse(proof?.checkedAt);
      return proof?.requestHash===ticket.requestHash&&proof.routineId===id&&proof.scheduledFor===ticket.scheduledAt
        &&proof.claimCurrent===true&&proof.newDispatchInsideWindow===true&&time>=earliest&&time<=latest;
    }).length;
    if(phase==='completion'&&(actions.length===0||verifiedDispatchCount!==actions.length))
      deny('A_ROUTINE_TEMPORAL_DISPATCH_EVIDENCE_MISSING');
    return {version:'a-routine-mission-temporal-proof-v1',phase,routineId:id,scheduledFor:ticket.scheduledAt,
      timeZone:row.timeZone,enteredAt:ticket.enteredAt,checkedAt,latestDispatchAt:new Date(latest).toISOString(),
      ownerId:ticket.ownerId,attempts:ticket.attempts,requestHash:ticket.requestHash,
      claimCurrent:true,clockChronologyPassed:true,newDispatchInsideWindow:phase==='dispatch'?true:null,
      ...(phase==='completion'?{observedDispatchCount:actions.length,verifiedDispatchCount,dispatchTimingVerified:actions.length>0&&actions.length===verifiedDispatchCount}:{}),
      completionDeadlineVerified:false,executionAuthority:false};
  }
}
