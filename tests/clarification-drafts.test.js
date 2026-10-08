import test from 'node:test';import assert from 'node:assert/strict';
import {clarificationDraftKey,createClarificationDrafts} from '../src/ui/workspace/clarification-drafts.js';
const mission={missionId:'mission',objective:"'source.txt'를 읽어",goalContract:{revision:1}};
const gate={gateId:'gate',type:'clarification',status:'pending',goalRevision:1,goalObjectiveSha256:'a'.repeat(64),questions:['항목?','제목?']};
test('refresh preserves indexed draft copies but cannot submit or persist them',()=>{
 const d=createClarificationDrafts(),key=clarificationDraftKey(mission,gate),answers=['전체','보고'];
 d.save(key,answers);answers[0]='changed';d.retain([key]);assert.equal(d.read(key,0),'전체');assert.equal(d.read(key,1),'보고');
 assert.equal(createClarificationDrafts().read(key,0),'');d.clear();assert.equal(d.read(key,0),'');
});
for(const [name,m,g] of [
 ['mission',{...mission,missionId:'other'},gate],['objective',{...mission,objective:'다른 요청'},gate],
 ['gate',mission,{...gate,gateId:'other'}],['revision',{...mission,goalContract:{revision:2}},{...gate,goalRevision:2}],
 ['hash',mission,{...gate,goalObjectiveSha256:'b'.repeat(64)}],['questions',mission,{...gate,questions:['제목?','항목?']}],
 ['approved',mission,{...gate,status:'approved'}],['missing-proof',mission,{...gate,goalObjectiveSha256:undefined}],
 ['mismatched-revision',mission,{...gate,goalRevision:2}]
])test('draft does not follow changed '+name,()=>{
 const d=createClarificationDrafts(),old=clarificationDraftKey(mission,gate),next=clarificationDraftKey(m,g);
 d.save(old,['전체','보고']);assert.notEqual(next,old);d.retain([next]);assert.equal(d.read(old,0),'');assert.equal(d.read(next,0),'');
});
