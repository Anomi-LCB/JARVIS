import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {buildMissionPlanningPrompt} from '../packages/core/src/mission/mission-planner.js';

test('actual multi-root search identities reach the next planning delivery without basename substitution',async t=>{
 const base=await mkdtemp(join(tmpdir(),'jarvis-search-delivery-'));
 let runtime;t.after(async()=>{runtime?.coreFacade.cognition.close();await rm(base,{recursive:true,force:true});});
 const roots=[join(base,'first'),join(base,'한글 자료.txt')];await Promise.all(roots.map(p=>mkdir(p)));
 for(const [index,root] of roots.entries())await writeFile(join(root,'notes.txt'),`SOURCE_${index}`);
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 runtime=createAgRuntime({allowedRoots:roots,auditRoot:join(base,'audit'),cwd:()=>roots[0],env,taskEnv:env,workerDaemonEnabled:false});
 const task=runtime.coreFacade.createTask(`'${roots[0]}' 폴더와 '${roots[1]}' 폴더에서 notes.txt 파일을 찾아줘`);
 const run=await runtime.orchestrationWorker.runTask(task.taskId,{userConfirmation:{confirmed:true}});
 assert.equal(run.success,true);
 const observation=runtime.missionRuntime.successObservation({actualToolName:'filesystem.searchFiles'},task,run);
 const observations=[{...observation,observationId:'search-observation',actionId:'source-search',toolName:'filesystem.searchFiles'}];
 const delivered=[];
 const context={mission:{objective:'찾은 두 원문을 구분해 읽고 비교해',successCriteria:[],constraints:[],remainingBudget:{waves:3,actions:6,plannerCalls:3},waveCount:1},capabilities:[],observations,today:'2026-10-03'};
 buildMissionPlanningPrompt({...context,onObservationDelivery:rows=>delivered.push(...rows)});
 const locations=delivered[0].evidenceFacts.matchLocations;
 assert.deepEqual(new Set(locations.map(item=>item.path)),new Set(roots.map(root=>join(root,'notes.txt'))));
 assert.deepEqual(new Set(locations.map(item=>item.artifact.rootIndex)),new Set([0,1]));
 assert.ok(locations.every(item=>item.executionAuthorized===false));
 for(const location of locations){
  const read=runtime.coreFacade.createTask(`'${location.path}' 내용을 읽어줘`);
  const result=await runtime.orchestrationWorker.runTask(read.taskId,{userConfirmation:{confirmed:true}});
  assert.equal(result.success,true);
  assert.equal(result.execution.executionResult.stdoutPreview,`SOURCE_${location.artifact.rootIndex}`);
 }
 const external=buildMissionPlanningPrompt({...context,externalEgress:true,dataClassifier:{classify(value){return {dataClass:String(value).includes(base)?'D4':'D0'};}}});
 assert.equal(external.includes(base),false);
 const withheld=buildMissionPlanningPrompt({...context,externalEgress:true});
 assert.equal(withheld.includes(base),false);
 const outside=join(base,'unregistered','secret.txt');
 const invalid=runtime.missionRuntime.successObservation({actualToolName:'filesystem.searchFiles'},task,
  {execution:{executionResult:{matches:[{name:'secret.txt',path:outside}]}}});
 assert.equal(invalid.data.matches[0].path,undefined);
 assert.equal(invalid.data.matches[0].artifact.outsideAllowedRoots,true);
 const badLocations=[];
 buildMissionPlanningPrompt({...context,observations:[{...observations[0],data:invalid.data}],onObservationDelivery:rows=>badLocations.push(...rows)});
 assert.equal(badLocations[0].evidenceFacts.matchLocations[0].path,undefined);
 assert.equal(badLocations[0].evidenceFacts.matchLocations[0].artifact,undefined);
});

test('a planning locator is never silently shortened and omitted matches are explicit',()=>{
 const context={mission:{objective:'파일을 구분해줘',successCriteria:[],constraints:[],remainingBudget:{},waveCount:1},capabilities:[],today:'2026-10-03'};
 const rows=[];
 buildMissionPlanningPrompt({...context,observations:[{observationId:'many',toolName:'filesystem.searchFiles',outcome:'success',data:{
  matches:Array.from({length:40},(_,index)=>({name:`file-${index}.txt`,path:index===0?'x'.repeat(4001):index===1?'bad\u0000path':`/safe/file-${index}.txt`,artifact:{rootIndex:0,relativePath:`file-${index}.txt`,outsideAllowedRoots:false}})),
  searchCompleteness:{version:'pc-search-completeness-v1',complete:true,reasons:[],requestedRootCount:1,returnedMatchCount:40}
 }}],onObservationDelivery:observations=>rows.push(...observations)});
 assert.equal(rows[0].evidenceFacts.matchLocations[0].path,undefined);
 assert.equal(rows[0].evidenceFacts.matchLocations[1].path,undefined);
 assert.equal(rows[0].evidenceFacts.matchLocationsTruncated,true);
 assert.ok(rows[0].evidenceFacts.matchLocations.length<40);
});
