import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedSourceHistory} from '../packages/core/src/mission/selected-source-history.js';
import {captureSelectedSource} from '../packages/core/src/mission/selected-source-result.js';
const objective='선택한 연결의 저장 자료 전체를 조회해.',selection={provider:'outlook',streamRef:'a'.repeat(64)};
const mission=id=>({missionId:id,objective,selectedSource:captureSelectedSource(objective,selection),constraints:[],goalContract:{objective},successCriteria:[{statement:objective}],status:'COMPLETED',createdAt:'2026-10-07T00:00:00Z',updatedAt:'2026-10-07T00:00:00Z',privateContent:'never-return'});
test('history pages preserve all IDs and reject changes instead of mixing snapshots',()=>{
 const missions=new Map(Array.from({length:501},(_,i)=>[String(i),mission(String(i).padStart(4,'0'))]));
 const first=selectedSourceHistory(missions,{...selection,limit:500});assert.equal(first.items.length,500);assert.equal(first.total,501);
 const last=selectedSourceHistory(missions,{...selection,offset:first.nextOffset,limit:500,expectedRevision:first.revision});assert.equal(last.items.length,1);assert.equal(last.nextOffset,null);
 assert.equal(new Set([...first.items,...last.items].map(i=>i.missionId)).size,501);assert.doesNotMatch(JSON.stringify(first),/never-return|objective|authorization/);
 assert.equal(first.currentResultVerified,false);assert.equal(first.executionAuthority,false);
 missions.get('1').status='CANCELLED';assert.throws(()=>selectedSourceHistory(missions,{...selection,offset:500,expectedRevision:first.revision}),/REVISION_CHANGED/);
});
test('history excludes other selections and tampered goals and rejects unknown arguments',()=>{
 const good=mission('good'),bad=mission('bad'),other=mission('other');bad.objective+=' 그리고 보내줘.';other.selectedSource=captureSelectedSource(objective,{provider:'gmail',streamRef:'b'.repeat(64)});
 const items=selectedSourceHistory(new Map([['g',good],['b',bad],['o',other]]),selection).items;assert.deepEqual(items.map(m=>m.missionId),['good']);
 for(const extra of [{url:'http://evil'},{limit:501},{offset:1},{ownerSessionId:'spoof'}])assert.throws(()=>selectedSourceHistory(new Map(),{...selection,...extra}));
});
