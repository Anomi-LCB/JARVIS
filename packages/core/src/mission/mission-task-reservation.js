import {createHash} from 'node:crypto';

// A planned identity is not a task, delegation, capability or dispatched effect.
export function reservedMissionTaskId(missionId,actionId){
  if(typeof missionId!=='string'||!/^[\p{L}\p{N}._-]{1,128}$/u.test(missionId)
    ||typeof actionId!=='string'||!/^[\p{L}\p{N}._:-]{1,240}$/u.test(actionId)){
    throw Object.assign(new Error('A_MISSION_TASK_RESERVATION_INVALID'),{code:'A_MISSION_TASK_RESERVATION_INVALID'});
  }
  return `mission_task_${createHash('sha256').update(JSON.stringify([missionId,actionId])).digest('hex').slice(0,32)}`;
}
