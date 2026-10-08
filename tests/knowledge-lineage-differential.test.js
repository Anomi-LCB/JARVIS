import test from 'node:test';import assert from 'node:assert/strict';
import {projectPersonalKnowledge as current} from '../apps/growth-memory/src/personal-knowledge-projection.js';
import {projectPersonalKnowledge as reference} from './fixtures/personal-knowledge-projection-reference-20261005.mjs';
test('memoized lineage preserves frozen reference across seeded missing, cyclic, duplicate and conflicting inputs',()=>{
 let seed=93217;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 const now=new Date('2026-02-25T00:00:00.000Z');
 for(let trial=0;trial<2000;trial++){
  const count=random(30),events=Array.from({length:count},(_,i)=>({eventId:'id-'+(random(8)===0?random(Math.max(1,count)):i),taskId:'synthetic',
   createdAt:new Date(Date.parse('2026-02-20T00:00:00.000Z')+random(40)).toISOString(),trustBoundary:{userProvided:true,systemGenerated:false},
   payload:{knowledge:{kind:'fact',subject:'project-'+random(2),predicate:'choice',value:'value-'+random(3),
    ...(random(3)?{supersedesEventId:'id-'+random(count+3)}:{}),...(random(9)===0?{validUntil:'2026-02-21T00:00:00.000Z'}:{})}}}));
  const diagnostics={},priorDiagnostics={};
  assert.deepEqual(current(events,{now,diagnostics}),reference(events,{now,diagnostics:priorDiagnostics}),'trial '+trial);
  assert.deepEqual(diagnostics,priorDiagnostics);
 }
});

test('ten thousand ordered revisions preserve the single current assertion without recursive stack growth',()=>{
 const base=Date.parse('2026-02-20T00:00:00.000Z');
 const events=Array.from({length:10000},(_,i)=>({eventId:'revision-'+i,createdAt:new Date(base+i).toISOString(),trustBoundary:{userProvided:true,systemGenerated:false},
  payload:{knowledge:{kind:'fact',subject:'합성 프로젝트',predicate:'위치',value:'값-'+i,...(i?{supersedesEventId:'revision-'+(i-1)}:{})}}}));
 const result=current(events,{now:new Date('2026-02-25T00:00:00.000Z')});
 assert.equal(result.length,10000);assert.equal(result.slice(0,-1).every(x=>x.status==='superseded'),true);
 assert.equal(result.at(-1).status,'active');assert.equal(result.at(-1).value,'값-9999');
});
