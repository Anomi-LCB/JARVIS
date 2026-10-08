import { createHash } from 'node:crypto';
import { reservedMissionTaskId } from '../mission/mission-task-reservation.js';

const fail=code=>{throw new Error(`A_PC_OUTBOUND_${code}`);};
const integer=(params,key,fallback,max)=>{
  if(!params.has(key))return fallback;
  const raw=params.get(key);
  if(!/^(0|[1-9][0-9]*)$/u.test(raw)||Number(raw)>max)fail('INPUT_INVALID');
  return Number(raw);
};

/** Core planning records, not PC availability, delegation or verified outcomes. */
export function pcTaskOptions(tasks,params=new URLSearchParams(),missions=null){
  if(!(tasks instanceof Map))fail('TASK_OPTIONS_UNAVAILABLE');
  const keys=[...params.keys()];
  if(keys.some(key=>!['offset','limit','snapshot'].includes(key))||new Set(keys).size!==keys.length)fail('INPUT_INVALID');
  const offset=integer(params,'offset',0,100000),limit=integer(params,'limit',100,100);
  if(limit<1||offset>0&&!params.has('snapshot')||params.has('snapshot')&&!/^[a-f0-9]{64}$/u.test(params.get('snapshot')))fail('INPUT_INVALID');
  const items=projectTaskOptions(tasks,missions);
  const snapshot=createHash('sha256').update(JSON.stringify(items)).digest('hex');
  if(params.has('snapshot')&&params.get('snapshot')!==snapshot)fail('TASK_OPTIONS_CHANGED');
  if(offset>items.length)fail('INPUT_INVALID');
  const page=items.slice(offset,offset+limit);
  return {source:missions===null?'core-runtime-planning-records':'core-runtime-and-mission-records',snapshot,offset,limit,totalEntries:items.length,items:page,
    nextOffset:offset+page.length,hasMore:offset+page.length<items.length,
    deviceAvailabilityVerified:false,executionAuthority:false,verifiedCompletion:false};
}

function projectTaskOptions(tasks,missions){
  if(!(tasks instanceof Map))fail('TASK_OPTIONS_UNAVAILABLE');
  if(tasks.size>100000)fail('TASK_OPTIONS_TOO_LARGE');
  let items=[];
  for(const [id,task] of tasks){
    if(typeof id!=='string'||! /^[\p{L}\p{N}._-]{1,128}$/u.test(id)||task?.taskId!==id)fail('TASK_OPTIONS_INVALID');
    const title=typeof task.plan?.title==='string'?task.plan.title.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim().slice(0,120):'';
    const status=typeof task.status==='string'&&/^[A-Z_]{1,40}$/u.test(task.status)?task.status:'UNKNOWN';
    items.push({taskId:id,title:title||'제목 없는 업무',status});
  }
  if(missions!==null){
    if(!(missions instanceof Map))fail('TASK_OPTIONS_UNAVAILABLE');
    const byTask=new Map(items.map(item=>[item.taskId,item])),owners=new Map();
    for(const [missionId,mission] of missions){
      if(mission?.missionId!==missionId||typeof missionId!=='string'||!/^[\p{L}\p{N}._-]{1,128}$/u.test(missionId)||!Array.isArray(mission.waves))fail('TASK_OPTIONS_INVALID');
      for(const wave of mission.waves){
        if(!Array.isArray(wave.actions))fail('TASK_OPTIONS_INVALID');
        for(const action of wave.actions){
          const reserved=action.taskId===null||action.taskId===undefined;
          if(reserved&&(action.reservedTaskId===null||action.reservedTaskId===undefined))continue;
          if(action.reservedTaskId!==null&&action.reservedTaskId!==undefined
            &&(action.reservedTaskId!==reservedMissionTaskId(missionId,action.actionId)
              ||!reserved&&action.taskId!==action.reservedTaskId))fail('TASK_OPTIONS_INVALID');
          const id=reserved?action.reservedTaskId:action.taskId;
          if(typeof id!=='string'||!/^[\p{L}\p{N}._-]{1,128}$/u.test(id)||typeof action.actionId!=='string'||!/^[\p{L}\p{N}._:-]{1,240}$/u.test(action.actionId))fail('TASK_OPTIONS_INVALID');
          const owner=JSON.stringify([missionId,action.actionId]);
          if(owners.has(id)&&owners.get(id)!==owner)fail('TASK_OPTIONS_AMBIGUOUS');
          owners.set(id,owner);
          const current=byTask.get(id),title=typeof action.title==='string'?action.title.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim().slice(0,120):'';
          if(reserved&&current)fail('TASK_OPTIONS_AMBIGUOUS');
          byTask.set(id,{taskId:id,title:title||current?.title||'저장된 업무 단계',status:reserved?'RESERVED':current?.status??'HISTORICAL',
            recordSource:reserved?'planned-mission':tasks.has(id)?'current-core-mission':'saved-mission',missionId,actionId:action.actionId});
          if(byTask.size>100000)fail('TASK_OPTIONS_TOO_LARGE');
        }
      }
    }
    items=[...byTask.values()];
  }
  items.sort((a,b)=>a.taskId<b.taskId?-1:a.taskId>b.taskId?1:0);
  return items;
}

export function pcTaskLabels(tasks,input,missions=null){
  if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length!==1||!Object.hasOwn(input,'taskIds')
    ||!Array.isArray(input.taskIds)||input.taskIds.length<1||input.taskIds.length>1000||new Set(input.taskIds).size!==input.taskIds.length
    ||input.taskIds.some(id=>typeof id!=='string'||!/^[\p{L}\p{N}._-]{1,128}$/u.test(id)))fail('INPUT_INVALID');
  const byId=new Map(projectTaskOptions(tasks,missions).map(item=>[item.taskId,item]));
  return {source:missions===null?'core-runtime-planning-records':'core-runtime-and-mission-records',items:input.taskIds.map(taskId=>{const item=byId.get(taskId);return {taskId,title:item?.title??null,found:Boolean(item)};}),
    deviceAvailabilityVerified:false,executionAuthority:false,verifiedCompletion:false};
}
