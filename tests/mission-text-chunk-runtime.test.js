import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

// Planner responses here are fixed deterministic fixtures, not LLM quality.
for(const fault of ['none','gap','source-change','repeat'])test(`real multi-read Mission ${fault}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-chunk-mission-'));
 const source='시작 사실: 회의 10시.\n'+'원문 자료.\n'.repeat(4000)+'끝 사실: 본당, 인쇄물 12부.\n';
 const summary='본당 10시 회의에 인쇄물 12부 준비.';
 await writeFile(join(root,'source.txt'),source);
 let runtime;
 t.after(async()=>{runtime?.coreFacade.cognition.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const chunkSize=6000;let step=0;const plannedOffsets=[];
 const offsets=Array.from({length:Math.ceil(source.length/chunkSize)},(_,i)=>i*chunkSize);
 if(fault==='gap')offsets.splice(1,1);
 if(fault==='repeat')offsets.fill(0);
 const missionRunner=async()=>{
  if(fault==='source-change'&&step===1)await writeFile(join(root,'source.txt'),'수정된 원문\n'+source.slice(7));
  const offset=offsets[step++];
  if(offset!==undefined){plannedOffsets.push(offset);return JSON.stringify({decision:'continue',summary:'원문 조각 읽기',actions:[{id:'read-'+offset,title:'원문 읽기',command:'source.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(root,'source.txt'),offset,maxChars:chunkSize},dependencies:[],successSignal:'G 읽기 확인'}],criteriaAssessment:[],question:null,blockedReason:null});}
  if(step===offsets.length+1)return JSON.stringify({decision:'continue',summary:'고정 기대 요약 저장',actions:[{id:'write',title:'요약 저장',command:'summary.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'summary.txt'),content:summary,allowOverwrite:false},dependencies:[],successSignal:'G 내용 확인'}],criteriaAssessment:[],question:null,blockedReason:null});
  return JSON.stringify({decision:'complete',summary:'검증 요청',actions:[],criteriaAssessment:[{criterionId:'summary',status:'satisfied',evidenceActionIds:['write'],reason:'고정 기대 내용'}],question:null,blockedReason:null});
 };
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'runtime'),env,taskEnv:env,missionRunner,workerDaemonEnabled:false});
 const owner=runtime.personalOwnerSession.activate({requestedBy:'chunk-runtime-test',durationMinutes:5});
 const created=runtime.missionRuntime.createMission({objective:"'source.txt'를 읽고 핵심을 요약해 'summary.txt'로 저장해줘",successCriteria:[{criterionId:'summary',statement:'독립 고정 내용 일치',verificationSpec:{version:1,kind:'text.equals',path:'summary.txt',equals:summary}}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
 const result=await runtime.missionRuntime.runMission(created.missionId,{maxWaves:offsets.length+3});
 console.log(JSON.stringify({diagnostic:{fault,status:result.status,reason:result.stopReason,waves:result.waves.length,observations:result.observations.map(o=>({tool:o.toolName,outcome:o.outcome,error:o.error}))}}));
 if(fault==='repeat'){
  assert.equal(result.status,'BLOCKED');assert.equal(result.stopReason,'repeated-plan-stall-detected');
  assert.equal(result.observations.filter(o=>o.toolName==='filesystem.readText').length,2);
  await assert.rejects(readFile(join(root,'summary.txt')),{code:'ENOENT'});return;
 }
 assert.equal(await readFile(join(root,'summary.txt'),'utf8'),summary,'output is valid even in the false-completion counterexamples');
 const reads=result.observations.filter(o=>o.toolName==='filesystem.readText');assert.equal(reads.length,offsets.length);
 assert.ok(reads.every(o=>o.verification.status==='passed'));
 if(fault==='none'){
  assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,coverage:result.goalCompletionCoverage}));
  assert.equal(result.goalCompletionCoverage.allowed,true);
  assert.equal(reads.reduce((n,o)=>n+o.data.readExtent.returnedChars,0),source.length);
 }else{
  assert.notEqual(result.status,'COMPLETED');assert.equal(result.goalCompletionCoverage.allowed,false);
 }
 console.log(JSON.stringify({chunkRuntimeEvidence:{fault,sourceChars:source.length,reads:reads.length,plannedOffsets,status:result.status,coverage:result.goalCompletionCoverage.allowed,cost:'unmeasured',syntheticPlanner:true}}));
});
