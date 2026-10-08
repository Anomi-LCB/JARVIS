import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {MissionCompletionDeadline} from '../packages/core/src/mission/mission-completion-deadline.js';

const cases=[
 ['2026-10-10','Asia/Seoul','2026-10-10T14:59:59.999Z'],
 ['2026-03-08','America/New_York','2026-03-09T03:59:59.999Z'],
 ['2026-11-01','America/New_York','2026-11-02T04:59:59.999Z'],
 ['2026-10-04','Australia/Lord_Howe','2026-10-04T12:59:59.999Z'],
 ['2026-04-05','Australia/Lord_Howe','2026-04-05T13:29:59.999Z'],
 ['2028-02-29','Asia/Kathmandu','2028-02-29T18:14:59.999Z'],
 ['2026-12-31','UTC','2026-12-31T23:59:59.999Z'],
 ['2011-12-30','Pacific/Apia',null],
 ['2026-02-29','Asia/Seoul',null],
 ['2026-13-01','UTC',null],
 ['2026-10-10','Invalid/Timezone',null]
];
for(const [date,timeZone,expected] of cases)test(`date-only source independent UTC oracle ${date} ${timeZone}`,()=>{
 const objective=date+"까지 'result.txt' 파일을 만들어줘",createdAt='2010-01-01T00:00:00.000Z';let goalContract;
 try{goalContract=createGoalContract({objective,referenceTime:createdAt,timeZone});}catch{goalContract={objective,timeZone,revision:1};}
 const mission={objective,createdAt,goalContract},guard=new MissionCompletionDeadline({clock:()=>new Date(expected??createdAt)});
 assert.equal(guard.source(mission)?.deadlineAt??null,expected);
 if(expected){
  assert.equal(guard.source(mission).dateOnlyPolicy,'end-of-local-calendar-date');
  assert.equal(guard.assertCurrentMission(mission).deadlineAt,expected);
  guard.clock=()=>new Date(Date.parse(expected)+1);
  assert.throws(()=>guard.assertCurrentMission(mission),/DEADLINE_EXCEEDED/);
 }
});

for(const objective of ["2026-10-10까지 내일 'result.txt' 파일을 만들어줘","2026-10-10까지 오전 9시에 'result.txt' 파일을 만들어줘","2026-10-10 이후 'result.txt' 파일을 만들어줘"])
test('date-only deadline never swallows another time condition: '+objective,()=>{
 const createdAt='2026-10-07T00:00:00.000Z',mission={objective,createdAt,goalContract:createGoalContract({objective,referenceTime:createdAt})};
 assert.equal(new MissionCompletionDeadline({clock:()=>new Date(createdAt)}).source(mission),null);
});
