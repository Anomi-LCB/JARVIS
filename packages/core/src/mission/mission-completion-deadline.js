import {createHash} from 'node:crypto';
import {createGoalContract} from './goal-contract.js';
import {resolveKoreanOneTimeDeadline,resolveLocalDateEnd} from '../runtime/korean-time-expression.js';
const fail=code=>{throw Object.assign(new Error(code),{code,notDispatched:true});};
const hash=value=>createHash('sha256').update(value).digest('hex');
/** Bounded source-derived deadline, never a model-supplied completion flag. */
export class MissionCompletionDeadline {
  constructor({clock}){this.clock=clock;}
  source(mission){
    if(typeof mission.objective!=='string')return null;
    const prefix=/^(\d{4}-\d{2}-\d{2}[Tt][0-9A-Za-z:.+-]+)\s*까지\s+/u.exec(mission.objective);
    const relative=/^((?:오늘|내일)\s*(?:오전|오후)\s*\d{1,2}시(?:\s*\d{1,2}분)?)\s*까지\s+/u.exec(mission.objective);
    const dateOnly=/^(\d{4}-\d{2}-\d{2})\s*까지\s+/u.exec(mission.objective);
    const duration=/^(?:지금부터\s*)?((?:\d+\s*(?:시간|분|초)\s*){1,3}(?:이내|안에))\s+/u.exec(mission.objective);
    if(!prefix&&!relative&&!dateOnly&&!duration)return null;
    let source;try{source=createGoalContract({objective:mission.objective,referenceTime:mission.createdAt,timeZone:mission.goalContract?.timeZone??'Asia/Seoul'});}catch{return null;}
    let deadlineAt=null;
    if(prefix){
      if(source.times.length!==1||source.times[0].kind!=='date-time'||source.times[0].status!=='parsed-instant')return null;
      deadlineAt=source.times[0].instant;
    }else if(duration){
      const item=source.times[0];
      if(source.times.length!==1||item.kind!=='elapsed-duration'||item.status!=='parsed-duration'||item.text!==duration[1])return null;
      deadlineAt=item.deadlineAt;
    }else if(dateOnly){
      if(source.times.length!==1||source.times[0].kind!=='date'||source.times[0].status!=='parsed-date'||source.times[0].date!==dateOnly[1])return null;
      const resolved=resolveLocalDateEnd(dateOnly[1],{timeZone:source.timeZone});
      if(!resolved.success)return null;deadlineAt=resolved.deadlineAt;
    }else{
      if(source.times.length!==2||!source.times.some(t=>t.kind==='date'&&t.status==='parsed-date')
        ||!source.times.some(t=>t.kind==='time-of-day'&&t.status==='parsed-time'))return null;
      const resolved=resolveKoreanOneTimeDeadline(relative[1],{clock:()=>new Date(mission.createdAt),timeZone:source.timeZone});
      if(!resolved.success||resolved.expression!==relative[1].trim())return null;
      deadlineAt=resolved.scheduledAt;
    }
    return {deadlineAt,sourceHash:hash(mission.objective),goalRevision:mission.goalContract?.revision,
      ...(duration?{durationPolicy:'elapsed-from-mission-created-at',durationMs:source.times[0].durationMs,referenceTime:source.times[0].referenceTime}:{}),
      ...(dateOnly?{dateOnlyPolicy:'end-of-local-calendar-date',timeZone:source.timeZone,sourceDate:dateOnly[1]}:{})};
  }
  bindSourceTime(mission,{toolName,phase='dispatch'}={}){
    if(toolName!=='filesystem.createTextFile')return false;
    try{return this.assertCurrentMission(mission,{phase,toolName})!==null;}
    catch(error){return {allowed:false,reason:error.code==='A_MISSION_COMPLETION_DEADLINE_EXCEEDED'
      ?'goal-time-deadline-exceeded':'goal-time-deadline-unverified',
      nextAction:error.code==='A_MISSION_COMPLETION_DEADLINE_EXCEEDED'
        ?'완료 기한이 지났습니다. 원문을 보존한 채 새 기한이나 후속 처리를 정해야 합니다. 파일을 자동으로 다시 생성하지 않습니다.'
        :'원문의 완료 기한·현재 시각·실행 증거를 확인하지 못했습니다. 현재 요구사항과 시계를 확인하세요.'};}
  }
  assertCurrentMission(mission,{phase='dispatch',toolName='filesystem.createTextFile'}={}){
    if(phase!=='completion'&&toolName!=='filesystem.createTextFile')return null;
    const source=this.source(mission);
    if(!source){
      if(phase==='completion'&&(mission.waves??[]).some(w=>w.actions?.some(a=>a.deadlineTemporalVerification)))fail('A_MISSION_DEADLINE_SOURCE_CHANGED');
      return null;
    }
    if(mission.goalContract?.objective!==mission.objective)fail('A_MISSION_DEADLINE_SOURCE_CHANGED');
    const now=this.clock().getTime(),created=Date.parse(mission.createdAt),deadline=Date.parse(source.deadlineAt);
    if(!Number.isFinite(now)||!Number.isFinite(created)||now<created)fail('A_MISSION_DEADLINE_CLOCK_INVALID');
    if(now>deadline)fail('A_MISSION_COMPLETION_DEADLINE_EXCEEDED');
    const actions=(mission.waves??[]).flatMap(w=>w.actions??[]).filter(a=>a.status==='succeeded'&&a.actualToolName==='filesystem.createTextFile');
    const valid=actions.filter(a=>{
      const proof=a.deadlineTemporalVerification,at=Date.parse(proof?.checkedAt);
      return proof?.version==='a-mission-completion-deadline-v1'&&proof.sourceHash===source.sourceHash
        &&proof.goalRevision===source.goalRevision&&proof.deadlineAt===source.deadlineAt&&proof.phase==='dispatch'
        &&proof.actionId===a.actionId&&proof.dispatchBeforeDeadline===true&&at>=created&&at<=deadline&&at<=now;
    }).length;
    if(phase==='completion'&&(!actions.length||actions.length!==valid))fail('A_MISSION_DEADLINE_DISPATCH_EVIDENCE_MISSING');
    return {version:'a-mission-completion-deadline-v1',...source,phase,checkedAt:new Date(now).toISOString(),
      dispatchBeforeDeadline:phase==='dispatch'?true:null,completionDeadlineVerified:phase==='completion',
      ...(phase==='completion'?{observedDispatchCount:actions.length,verifiedDispatchCount:valid}:{}),executionAuthority:false};
  }
}
