import test from 'node:test';import assert from 'node:assert/strict';
import {createMissionDependencyPanel} from '../src/ui/mission-dependency-panel.js';
const mission={missionId:'mission-a',goalContract:{revision:1}};
const observation={impactVersion:'a-mission-dependency-impact-v1',missionId:'mission-a',executionAuthority:false,status:'requires-review',observedAt:'2026-10-08T00:00:00Z',affectedActionIds:['a'],unknownActionIds:[],deadline:{previousDueAt:'2026-10-08T00:00:00Z',currentDueAt:'2026-10-10T00:00:00Z',requiresReplan:true},nextAction:'<img src=x onerror=alert(1)>'};
test('dependency UI uses only explicit GET and shows original/current deadlines with escaped advice',async()=>{
 const calls=[],panel=createMissionDependencyPanel({request:async(...args)=>{calls.push(args);return observation;}});
 await panel.inspect(mission);assert.equal(calls.length,1);assert.equal(calls[0][0],'/missions/mission-a/dependency-impact');assert.equal(calls[0][1].method,'GET');
 const html=panel.render(mission);assert.match(html,/2026\. 10\. 8\./u);assert.match(html,/2026\. 10\. 10\./u);assert.match(html,/영향받는 단계 1개/u);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/u);
});
test('failed refresh clears a stale success and gives a next step without raw secrets',async()=>{
 let fail=false;const panel=createMissionDependencyPanel({request:async()=>{if(fail)throw new Error('private-token');return observation;}});
 await panel.inspect(mission);fail=true;await panel.inspect(mission);const html=panel.render(mission);
 assert.match(html,/접근 권한/u);assert.ok(!html.includes('private-token'));assert.ok(!html.includes('현재 약속 기한'));
});
test('endpoint, mission and goal revision isolate tab-local observations',async()=>{
 let endpoint='one';const panel=createMissionDependencyPanel({request:async()=>observation,endpoint:()=>endpoint});await panel.inspect(mission);
 assert.match(panel.render(mission),/현재 약속 기한/u);endpoint='two';assert.ok(!panel.render(mission).includes('현재 약속 기한'));endpoint='one';assert.ok(!panel.render({...mission,goalContract:{revision:2}}).includes('현재 약속 기한'));
});
test('authentication changes discard cached observations, including late prior responses',async()=>{
 let context='first',release;const panel=createMissionDependencyPanel({accessContext:()=>context,request:()=>new Promise(resolve=>release=resolve)});
 const pending=panel.inspect(mission);context='second';assert.ok(!panel.render(mission).includes('disabled'));release(observation);await pending;
 assert.ok(!panel.render(mission).includes('현재 약속 기한'));
});
test('wrong target, invalid state, invalid time and claimed execution authority are rejected',async()=>{
 for(const change of [{missionId:'other'},{status:'completed'},{observedAt:'invalid'},{executionAuthority:true},{affectedActionIds:null}]){
  const panel=createMissionDependencyPanel({request:async()=>({...observation,...change})});await panel.inspect(mission);assert.match(panel.render(mission),/조회하지 못했습니다/u);
 }
});
test('repeated clicks share a single pending read and expose a disabled button',async()=>{
 let release,calls=0;const panel=createMissionDependencyPanel({request:()=>{calls++;return new Promise(resolve=>release=resolve);}});
 const first=panel.inspect(mission);await panel.inspect(mission);assert.equal(calls,1);assert.match(panel.render(mission),/disabled/u);release(observation);await first;assert.ok(!panel.render(mission).includes('disabled'));
});
test('missing baseline dates are explicit and no mission creates no panel or request',async()=>{
 let calls=0;const panel=createMissionDependencyPanel({request:async()=>{calls++;return {...observation,deadline:{currentDueAt:'2026-10-10T00:00:00Z'}};}});
 await panel.inspect(null);assert.equal(calls,0);assert.equal(panel.render(null),'');await panel.inspect(mission);assert.match(panel.render(mission),/기록 없음/u);
});
