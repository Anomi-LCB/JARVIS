import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant,MissionStatus} from '../packages/core/src/mission/mission-runtime.js';
for(const phase of ['current','before-dispatch','during-stage','provider-failure','contract-change']) test(`actual Mission learned reference guard: ${phase}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-guidance-handoff-'));let runtime;
 t.after(async()=>{runtime?.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});});
 let current=true;let calls=0;
 const planner={skillGuidanceProvider(){calls++;if(phase==='provider-failure')throw new Error('unavailable');return current?[{skillId:'skill',revisionId:'revision',procedureLifecycle:{contractSha256:phase==='contract-change'?'changed':'contract'}}]:[];},
 async planNextWave(context){if(context.observations.some(o=>o.outcome==='success'))return {decision:'blocked',blockedReason:'fixture-stops-after-observation',actions:[]};return {decision:'continue',planning:{missionSkillGuidance:{mode:'reference-only',executableByDefault:false,references:[{skillId:'skill',revisionId:'revision',lifecycleSha256:'contract'}]}},actions:[{id:'write',command:'guard-result 메모 파일을 만들어줘. 내용은 검증 완료',expectedToolName:'filesystem.createTextFile',dependencies:[]}]};}};
 runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false,missionPlanner:planner});
 const coordinator=runtime.missionRuntime.effectCoordinator;const original=coordinator.stage.bind(coordinator);
 coordinator.stage=async(...args)=>{const result=await original(...args);if(phase==='during-stage')current=false;return result;};
 if(phase==='before-dispatch')current=false;
 const created=runtime.missionRuntime.createMission({objective:'검증한 절차로 결과 작성',maxWaves:1,authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
 const result=await runtime.missionRuntime.runMission(created.missionId);
 if(phase==='current'){assert.match(await readFile(join(root,'guard-result.txt'),'utf8'),/검증 완료/);assert.equal(result.metrics.successfulActions,1);assert.ok(calls>=2);}
 else{assert.equal(result.status,MissionStatus.PAUSED,JSON.stringify(result));assert.equal(result.lastError.code,'A_MISSION_SKILL_GUIDANCE_STALE');assert.equal(result.metrics.executedActions,0);assert.equal(result.waves[0].planning.missionSkillGuidance.references[0].lifecycleSha256,'contract');await assert.rejects(access(join(root,'guard-result.txt')));if(phase==='during-stage')assert.ok(calls>=2);
  const restored=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false,missionPlanner:planner});
  try{const saved=restored.missionRuntime.missions.get(created.missionId);assert.equal(saved.waves[0].planning.missionSkillGuidance.references[0].lifecycleSha256,'contract');assert.equal(await restored.missionRuntime.checkLearnedGuidance(saved,saved.waves[0]),false);}
  finally{restored.coreFacade.cognition?.close();}
 }
});
