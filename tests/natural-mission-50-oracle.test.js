import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NATURAL_MISSION_50_ORACLE_SHA256 } from '../scripts/natural-mission-50-oracle.mjs';
import { verifyNaturalMission50SemanticCase as verifyNaturalMission50Case } from '../scripts/natural-mission-50-reverify.mjs';

const schedule=[{id:'A',resource:0,start:0,end:3,duration:3},{id:'B',resource:0,start:3,end:7,duration:4},{id:'C',resource:1,start:3,end:5,duration:2},{id:'D',resource:0,start:7,end:12,duration:5},{id:'E',resource:1,start:5,end:6,duration:1}];
async function check(mutator){const root=await mkdtemp(join(tmpdir(),'natural50-schedule-oracle-'));try{await mkdir(join(root,'outputs'));const result={schedule:structuredClone(schedule),items:structuredClone(schedule),count:5,makespan:12};mutator?.(result);await writeFile(join(root,'outputs','result.json'),JSON.stringify(result));await writeFile(join(root,'outputs','risk.json'),JSON.stringify([{id:'D',duration:5},{id:'B',duration:4},{id:'A',duration:3},{id:'C',duration:2},{id:'E',duration:1}]));return await verifyNaturalMission50Case('N27',root);}finally{assert(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});}}
test('independent schedule oracle accepts valid dependency/resource schedule under frozen contract',async()=>{assert.equal((await check()).passed,true);assert.equal(NATURAL_MISSION_50_ORACLE_SHA256,'e8dcc367d977f4891ae1e6ea54025ae66fb28201c6f7d0ec81788eb6d5745331');});
test('schedule oracle rejects null or string time coercion',async()=>{for(const value of [null,'0'])assert.equal((await check(r=>{r.items[0].start=value;r.schedule[0].start=value;})).passed,false);});
test('schedule oracle rejects contradictory duplicated schedule fields',async()=>{assert.equal((await check(r=>{r.schedule[0].end=999;})).passed,false);});
test('schedule oracle rejects fabricated makespan and item count',async()=>{assert.equal((await check(r=>{r.makespan=0;})).passed,false);assert.equal((await check(r=>{r.count=500;})).passed,false);});
test('schedule oracle rejects resource overlap even when every duration is preserved',async()=>{assert.equal((await check(r=>{for(const field of ['items','schedule'])r[field][2]={...r[field][2],resource:0};})).passed,false);});
