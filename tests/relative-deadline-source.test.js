import test from 'node:test';
import assert from 'node:assert/strict';
import {MissionCompletionDeadline} from '../packages/core/src/mission/mission-completion-deadline.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {parseKoreanOneTimeSchedule,resolveKoreanOneTimeDeadline} from '../packages/core/src/runtime/korean-time-expression.js';
const cases=[
 ['오늘 오전 12시','2026-10-07T00:00:00Z','Asia/Seoul','2026-10-06T15:00:00.000Z'],
 ['오늘 오후 12시','2026-10-07T00:00:00Z','Asia/Seoul','2026-10-07T03:00:00.000Z'],
 ['내일 오전 1시','2026-12-31T14:30:00Z','Asia/Seoul','2026-12-31T16:00:00.000Z'],
 ['오늘 오전 2시 30분','2026-03-08T05:00:00Z','America/New_York',null],
 ['오늘 오전 1시 30분','2026-11-01T04:00:00Z','America/New_York',null],
 ['오늘 오전 2시 15분','2026-10-03T14:30:00Z','Australia/Lord_Howe',null],
 ['오늘 오전 1시 45분','2026-04-04T13:00:00Z','Australia/Lord_Howe',null],
 ['오늘 오전 13시','2026-10-07T00:00:00Z','Asia/Seoul',null]
];
for(const [prefix,createdAt,timeZone,expected] of cases)test('relative deadline independent calendar oracle '+prefix+' '+timeZone,()=>{
 const objective=prefix+"까지 'result.txt' 파일을 만들어줘",mission={objective,createdAt,goalContract:createGoalContract({objective,referenceTime:createdAt,timeZone})};
 const guard=new MissionCompletionDeadline({clock:()=>new Date('2027-01-05T00:00:00Z')});
 assert.equal(guard.source(mission)?.deadlineAt??null,expected);
 assert.deepEqual(guard.source(JSON.parse(JSON.stringify(mission))),guard.source(mission));
 if(expected&&Date.parse(expected)<Date.parse(createdAt)){
  assert.equal(parseKoreanOneTimeSchedule(prefix,{clock:()=>new Date(createdAt),timeZone}).code,'A_ROUTINE_TIME_IN_PAST');
  assert.equal(resolveKoreanOneTimeDeadline(prefix,{clock:()=>new Date(createdAt),timeZone}).scheduledAt,expected);
 }
});
test('additional temporal predicates and quoted filename cannot become a deadline',()=>{
 for(const objective of ["오늘 오전 9시까지 내일 오전 8시에 'result.txt'를 만들어줘","'오늘 오전 9시까지.txt' 파일을 만들어줘","다음 주말까지 'result.txt'를 만들어줘"]){
  const createdAt='2026-10-07T00:00:00Z';const mission={objective,createdAt,goalContract:createGoalContract({objective,referenceTime:createdAt})};
  assert.equal(new MissionCompletionDeadline({clock:()=>new Date(createdAt)}).source(mission),null);
 }
});
