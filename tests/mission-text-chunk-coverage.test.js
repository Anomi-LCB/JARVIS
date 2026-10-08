import test from 'node:test';
import assert from 'node:assert/strict';
import {completeTextReadChain} from '../packages/core/src/mission/mission-text-read-coverage.js';

function fixture(){
 const sourceFile={text:'앞😀중간끝',bytes:Buffer.byteLength('앞😀중간끝')};
 const parts=[[0,1],[1,2],[3,3]];
 const reads=parts.map(([offset,length],i)=>({actionId:'r'+i,observationId:'o'+i,operation:{dispatch:{arguments:{offset,maxChars:length},dispatchedAt:new Date(1000+i*2000).toISOString()}}}));
 const mission={observations:parts.map(([offset,length],i)=>({observationId:'o'+i,createdAt:new Date(2000+i*2000).toISOString(),data:{readExtent:{offset,returnedChars:length,bytes:sourceFile.bytes,truncated:offset+length<sourceFile.text.length,encoding:'utf8'}}}))};
 return {reads,mission,sourceFile,before:8000};
}
test('contiguous UTF16-safe chronological chunks prove full coverage; none alone does',()=>{
 const f=fixture();assert.deepEqual(completeTextReadChain(f).map(a=>a.actionId),['r0','r1','r2']);
 for(const read of f.reads)assert.equal(completeTextReadChain({...f,reads:[read]}),null);
});
test('gaps, overlap-only, dishonest EOF/size/encoding/range, late read and surrogate splits do not prove completion',()=>{
 const changes=[
  f=>f.reads.splice(1,1),
  f=>{f.mission.observations[1].data.readExtent.offset=0;f.reads[1].operation.dispatch.arguments.offset=0;},
  f=>f.mission.observations[0].data.readExtent.truncated=false,
  f=>f.mission.observations[2].data.readExtent.bytes++,
  f=>f.mission.observations[2].data.readExtent.encoding='utf16le',
  f=>f.reads[2].operation.dispatch.arguments.maxChars=1,
  f=>f.reads[0].operation.dispatch.arguments.offset=null,
  f=>f.reads[2].operation.dispatch.arguments.maxChars=null,
  f=>f.mission.observations[2].createdAt=new Date(9000).toISOString(),
  f=>f.reads[1].operation.dispatch.dispatchedAt=new Date(1000).toISOString(),
  f=>{f.mission.observations[1].data.readExtent.returnedChars=1;f.reads[1].operation.dispatch.arguments.maxChars=1;},
  f=>f.mission.observations[0].data.readExtent.offset='0',
  f=>f.mission.observations[2].data.readExtent.returnedChars=100
 ];
 for(const change of changes){const f=fixture();change(f);assert.equal(completeTextReadChain(f),null);}
});
test('retry reads add no duplicate coverage and empty source needs an observed valid read',()=>{
 const f=fixture();f.reads.splice(1,0,f.reads[0]);assert.equal(completeTextReadChain(f).length,3);
 const empty={sourceFile:{text:'',bytes:0},mission:{observations:[{observationId:'empty',createdAt:new Date(2).toISOString(),data:{readExtent:{offset:0,returnedChars:0,bytes:0,truncated:false,encoding:'utf8'}}}]},reads:[{observationId:'empty',operation:{dispatch:{arguments:{},dispatchedAt:new Date(1).toISOString()}}}]};
 assert.equal(completeTextReadChain(empty).length,1);assert.equal(completeTextReadChain({...empty,reads:[]}),null);
});
test('a later valid full reread replaces an abandoned partial chain',()=>{
 const f=fixture();const read={actionId:'full',observationId:'full',operation:{dispatch:{arguments:{offset:0,maxChars:100},dispatchedAt:new Date(7000).toISOString()}}};
 f.mission.observations.push({observationId:'full',createdAt:new Date(7500).toISOString(),data:{readExtent:{offset:0,returnedChars:f.sourceFile.text.length,bytes:f.sourceFile.bytes,truncated:false,encoding:'utf8'}}});
 assert.deepEqual(completeTextReadChain({...f,reads:[f.reads[0],read]}).map(a=>a.actionId),['full']);
});
test('a delivered-prefix continuation may overlap the adapter range without adding duplicate coverage',()=>{
 const f=fixture();f.sourceFile={text:'abcdef',bytes:6};
 const ranges=[[0,3],[2,4]];
 f.reads=ranges.map(([offset,length],i)=>({actionId:'overlap'+i,observationId:'overlap'+i,operation:{dispatch:{arguments:{offset,maxChars:length},dispatchedAt:new Date(1000+i*2000).toISOString()}}}));
 f.mission.observations=ranges.map(([offset,length],i)=>({observationId:'overlap'+i,createdAt:new Date(2000+i*2000).toISOString(),data:{readExtent:{offset,returnedChars:length,bytes:6,truncated:offset+length<6,encoding:'utf8'}}}));
 assert.equal(completeTextReadChain(f).length,2);
 f.reads[1].operation.dispatch.arguments.offset=4;f.mission.observations[1].data.readExtent.offset=4;f.mission.observations[1].data.readExtent.returnedChars=2;
 assert.equal(completeTextReadChain(f),null,'the genuinely missing position3 still blocks');
});
