import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileSearchToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {MissionRuntime} from '../packages/core/src/mission/mission-runtime.js';
import {verifyLegacyFileAbsenceEvidence} from '../packages/core/src/mission/criteria-evidence.js';
import {sanitizeMissionArguments} from '../packages/core/src/planning/mission-action-arguments.js';
import {buildMissionPlanningPrompt} from '../packages/core/src/mission/mission-planner.js';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-multi-search-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const first=join(root,'first'),second=join(root,'second'),outside=join(root,'outside');
 await Promise.all([first,second,outside].map(p=>mkdir(p)));
 return {root,first,second,outside,args:{scope:'workspace',directories:[first,second],query:'report.txt'},adapter:new FileSearchToolAdapter({allowedRoots:[first,second]})};
}
test('all requested folders are validated and overlapping roots never duplicate files',async t=>{
 const f=await fixture(t);await writeFile(join(f.first,'report.txt'),'one');await writeFile(join(f.second,'report.txt'),'two');
 const found=await f.adapter.execute(f.args);
 assert.deepEqual(new Set(found.matches.map(m=>m.path)),new Set([join(f.first,'report.txt'),join(f.second,'report.txt')]));
 assert.equal(found.searchCompleteness.complete,true);
 const overlap=await f.adapter.execute({...f.args,directories:[f.first,f.first,f.second]});assert.equal(overlap.matches.length,2);assert.equal(overlap.roots.length,2);
 for(const directories of [[],[f.first,f.outside],[f.first,null],Array(21).fill(f.first)]){
  const denied=await f.adapter.execute({...f.args,directories});assert.equal(denied.status,'failed');assert.deepEqual(denied.matches,[]);
 }
 assert.equal((await f.adapter.execute({...f.args,directory:f.first})).status,'failed');
 assert.equal((await f.adapter.execute(f.args,{capabilityToken:{scope:{allowedPaths:[f.first]}}})).status,'failed');
 const sanitized=sanitizeMissionArguments('filesystem.searchFiles',{...f.args,capabilityToken:'INJECTED',approved:true});
 assert.deepEqual(sanitized,f.args);
});
test('result, time and depth limits expose partial search rather than claiming absence',async t=>{
 const f=await fixture(t);await writeFile(join(f.first,'report.txt'),'one');await writeFile(join(f.second,'report.txt'),'two');
 const limited=await f.adapter.execute({...f.args,maxResults:1});assert.equal(limited.matches.length,1);assert.equal(limited.searchCompleteness.complete,false);assert.ok(limited.searchCompleteness.reasons.includes('result-limit'));
 assert.equal((await f.adapter.execute({...f.args,maxResults:0})).status,'failed');
 const timeout=await new FileSearchToolAdapter({allowedRoots:[f.first,f.second],timeoutMs:-1}).execute(f.args);
 assert.equal(timeout.searchCompleteness.complete,false);assert.ok(timeout.searchCompleteness.reasons.includes('timeout'));assert.match(timeout.summary,/확인하지 못/);
 await mkdir(join(f.first,'nested'));await writeFile(join(f.first,'nested','report.txt'),'deep');
 const shallow=await new FileSearchToolAdapter({allowedRoots:[f.first],maxDepth:0}).execute({scope:'workspace',directory:f.first,query:'report.txt'});
 assert.ok(shallow.searchCompleteness.reasons.includes('depth-limit'));
});
test('a folder disappearing after preflight stays incomplete and reaches Mission as incomplete',async t=>{
 const f=await fixture(t);
 class DisappearingFolder extends FileSearchToolAdapter {async searchRoots(...args){const roots=await super.searchRoots(...args);await rm(f.second,{recursive:true,force:true});return roots;}}
 const result=await new DisappearingFolder({allowedRoots:[f.first,f.second]}).execute(f.args);
 assert.equal(result.searchCompleteness.complete,false);assert.ok(result.searchCompleteness.reasons.includes('path-unavailable'));
 const observation=MissionRuntime.prototype.successObservation.call({artifactReference:path=>({relativePath:path,rootIndex:0})},
  {actualToolName:'filesystem.searchFiles'}, {}, {execution:{executionResult:result}});
 assert.equal(observation.data.searchCompleteness.complete,false);
 const delivered=[];
 const prompt=buildMissionPlanningPrompt({mission:{objective:'두 폴더에서 빠짐없이 찾아줘',successCriteria:[],constraints:[],remainingBudget:{waves:2,actions:4,plannerCalls:2},waveCount:0},
  capabilities:[],observations:[{...observation,observationId:'partial-search',toolName:'filesystem.searchFiles'}],today:'2026-10-03',
  onObservationDelivery:observations=>delivered.push(...observations)});
 assert.match(prompt,/path-unavailable/);
 assert.match(prompt,/"complete":\s*false/u);
 assert.match(prompt,/전체 검색·파일 부재를 입증하지 못/);
});
test('an incomplete zero-result search cannot discharge an exact absence criterion',async t=>{
 const f=await fixture(t),args={scope:'workspace',directory:f.first,query:'missing.txt'};
 const run=await f.adapter.execute(args);
 const observation={actionId:'search',outcome:'success',toolName:'filesystem.searchFiles',verification:{status:'passed',failedCheckIds:[]},data:{matches:[],searchCompleteness:run.searchCompleteness}};
 const mission={waves:[{actions:[{actionId:'search',actualToolName:'filesystem.searchFiles',operation:{dispatch:{toolName:'filesystem.searchFiles',arguments:args}}}]}]};
 const input={statement:'missing.txt 파일이 존재하지 않는다.',allowedRoots:[f.first],mission,observations:[observation],evidenceActionIds:['search']};
 assert.equal(verifyLegacyFileAbsenceEvidence(input).passed,true);
 const validCoverage=structuredClone(observation.data.searchCompleteness);
 for(const malformed of [null,{}, {...validCoverage,complete:'true'}, {...validCoverage,version:'unknown'}, {...validCoverage,reasons:['timeout']}, {...validCoverage,returnedMatchCount:1}]){
  observation.data.searchCompleteness=malformed;assert.equal(verifyLegacyFileAbsenceEvidence(input).passed,false);
 }
 observation.data.searchCompleteness=validCoverage;
 observation.data.searchCompleteness.complete=false;assert.equal(verifyLegacyFileAbsenceEvidence(input).passed,false);
 observation.data.searchCompleteness.complete=true;mission.waves[0].actions[0].operation.dispatch.arguments={scope:'workspace',directories:[f.second],query:'missing.txt'};
 assert.equal(verifyLegacyFileAbsenceEvidence(input).passed,false);
});
