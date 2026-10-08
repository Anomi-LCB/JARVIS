import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {MissionCompletionDeadline} from '../packages/core/src/mission/mission-completion-deadline.js';
const guard=new MissionCompletionDeadline({clock:()=>new Date('2027-01-01T00:00:00Z')});
const make=(prefix,createdAt='2026-10-07T00:00:00.000Z',timeZone='Asia/Seoul')=>{
 const objective=prefix+" 'result.txt' 파일을 만들어줘";
 return {objective,createdAt,goalContract:createGoalContract({objective,referenceTime:createdAt,timeZone})};
};
for(const [prefix,at,zone,expected] of [
 ['지금부터 30초 이내','2026-10-07T00:00:00.000Z','Asia/Seoul','2026-10-07T00:00:30.000Z'],
 ['30분 안에','2026-12-31T23:45:00.000Z','UTC','2027-01-01T00:15:00.000Z'],
 ['지금부터 2시간 이내','2026-03-08T06:30:00.000Z','America/New_York','2026-03-08T08:30:00.000Z'],
 ['1시간 이내','2026-11-01T05:30:00.000Z','America/New_York','2026-11-01T06:30:00.000Z'],
 ['지금부터 1시간 30분 이내','2026-10-07T00:00:00.000Z','Asia/Seoul','2026-10-07T01:30:00.000Z'],
 ['2시간 3분 4초 안에','2026-10-07T00:00:00.000Z','UTC','2026-10-07T02:03:04.000Z']
])test('elapsed duration fixed oracle '+prefix+' '+zone,()=>{
 const mission=make(prefix,at,zone),source=guard.source(mission);
 assert.equal(source.deadlineAt,expected);
 assert.equal(source.durationPolicy,'elapsed-from-mission-created-at');
 assert.deepEqual(guard.source(JSON.parse(JSON.stringify(mission))),source);
});
for(const prefix of ['0초 이내','-30초 이내','0.5시간 이내','한 시간 이내','30초 후','99999999999999999999시간 이내','30분 1시간 이내','1시간 1시간 이내','30분 이내 내일 오전 9시에'])test('unsupported duration is preserved and cannot bind '+prefix,()=>{
 const mission=make(prefix);assert.ok(mission.goalContract.times.length>0);
 assert.equal(guard.source(mission),null);
});
test('quoted duration is data and does not impose a deadline',()=>{
 const objective="'30분 이내.txt' 파일을 만들어줘",mission={objective,createdAt:'2026-10-07T00:00:00Z'};
 mission.goalContract=createGoalContract({objective,referenceTime:mission.createdAt});
 assert.equal(mission.goalContract.times.length,0);assert.equal(guard.source(mission),null);
});
