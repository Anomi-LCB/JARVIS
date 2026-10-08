import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {MissionGrant,MissionStatus} from '../packages/core/src/mission/mission-runtime.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/agent-platform-g05-cross-material.json',import.meta.url),'utf8'));
for(const mode of ['valid','expiry','withdrawal'])test(`real F SQLite to Mission handoff and restart: ${mode}`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-real-f-handoff-'));let now='2026-10-04T00:00:00.000Z';let runtime;const stores=[],runtimes=[];
 t.after(()=>{for(const r of runtimes)r.coreFacade.cognition?.close();for(const s of stores)try{s.close();}catch{}rmSync(root,{recursive:true,force:true});});
 const objective='연구 자료를 읽고 핵심 근거를 정리해줘';const scope=()=>({userId:'local_user',workspaceRoot:runtime.coreFacade.workspaceRoot,conversationId:null});
 const planner={skillGuidanceProvider({objective,scope}){return runtime.growthRuntime.missionSkillGuidance(objective,{scope});},async planNextWave(ctx){
  if(ctx.observations.some(o=>o.outcome==='success'))return {decision:'blocked',blockedReason:'fixture-one-action-only',actions:[]};
  const g=this.skillGuidanceProvider({objective,scope:scope()})[0];assert.ok(g,'real approved F guidance selected');
  const computed=runtime.growthRuntime.runReviewedTabularProcedure({skillId:g.skillId,revisionId:g.revisionId,lifecycleSha256:g.procedureLifecycle.contractSha256,rows:fixture.cases[1].rows,scope:scope()});assert.equal(computed.success,true);
  return {decision:'continue',planning:{missionSkillGuidance:{mode:'reference-only',executableByDefault:false,references:[{skillId:g.skillId,revisionId:g.revisionId,lifecycleSha256:g.procedureLifecycle.contractSha256}]}},actions:[{id:'write',command:`f-result 메모 파일을 만들어줘. 내용은 ${JSON.stringify(computed.resultRows)}`,expectedToolName:'filesystem.createTextFile',dependencies:[]}]};
 }};
 const open=()=>{const s=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});stores.push(s);runtime=createAgRuntime({memoryStore:s,allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,clock:()=>new Date(now),env:{},workerDaemonEnabled:false,missionPlanner:planner});runtimes.push(runtime);return runtime;};
 open();for(let i=0;i<3;i++)runtime.growthRuntime.ingestor.ingest({eventId:`src-${i}`,eventType:'task.created',taskId:runtime.coreFacade.createTask(objective,{userId:'local_user'}).taskId,source:{memoryScope:scope()},payload:{rawText:objective},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,externalContent:false}});
 const draft=runtime.growthRuntime.advancedLearningModels().skillDistillations[0];const entry=runtime.growthRuntime.reviewSkillDraft(draft.distilledSkillId,{decision:'approve'}).registryEntry;assert.ok(entry);
 const rev=runtime.growthRuntime.mutateSkillRevision('create',{skillId:entry.skillId,expectedActiveRevisionId:entry.activeRevisionId,suggestedSteps:['원문을 확인한다.','합계를 검증한다.'],procedureDefinition:fixture.procedureDefinition,procedureLifecycle:{expiresAt:'2026-10-05T00:00:00.000Z'}});assert.equal(rev.success,true);
 const payload={skillId:entry.skillId,revisionId:rev.revision.revisionId};
 for(const [action,extra] of [['evaluate',{trialCases:fixture.cases}],['review',{decision:'approve'}],['promote',{expectedActiveRevisionId:entry.activeRevisionId}]])assert.equal(runtime.growthRuntime.mutateSkillRevision(action,{...payload,...extra}).success,true);
 const calculation={...payload,lifecycleSha256:rev.revision.procedureLifecycle.contractSha256,rows:fixture.cases[1].rows,scope:scope()};
 const computed=runtime.growthRuntime.runReviewedTabularProcedure(calculation);
 assert.equal(computed.success,true);assert.deepEqual(computed.resultRows,fixture.cases[1].expectedRows);
 assert.equal(computed.externalEffects,false);assert.equal(computed.verificationStatus,'deterministic-result-verified');
 for(const patch of [{scope:null},{revisionId:'stale'},{lifecycleSha256:'changed'},{rows:[{Team:'A',Amount:1,amount:9}]},{scope:{...scope(),userId:'other'}}]) {
  const denied=runtime.growthRuntime.runReviewedTabularProcedure({...calculation,...patch});assert.equal(denied.success,false);assert.equal('markdown' in denied,false);
 }
 const co=runtime.missionRuntime.effectCoordinator,stage=co.stage.bind(co);co.stage=async(...args)=>{const out=await stage(...args);if(mode==='expiry')now='2026-10-05T00:00:00.000Z';if(mode==='withdrawal'){const result=runtime.growthRuntime.decideHygiene({targetId:'src-0',action:'delete',decidedBy:'fixture-owner'});assert.equal(result.success,true);}return out;};
 const m=runtime.missionRuntime.createMission({objective,authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});const result=await runtime.missionRuntime.runMission(m.missionId);
 if(mode==='valid'){assert.equal(result.metrics.successfulActions,1,JSON.stringify({error:result.lastError,reason:result.stopReason}));assert.deepEqual(JSON.parse(readFileSync(join(root,'f-result.txt'),'utf8').trim()),fixture.cases[1].expectedRows);}
 else{assert.equal(result.status,MissionStatus.PAUSED,JSON.stringify({error:result.lastError,reason:result.stopReason}));assert.equal(result.lastError.code,'A_MISSION_SKILL_GUIDANCE_STALE');assert.equal(result.metrics.executedActions,0);assert.equal(existsSync(join(root,'f-result.txt')),false);}
 const after=runtime.growthRuntime.runReviewedTabularProcedure(calculation);assert.equal(after.success,mode==='valid');
 stores.at(-1).close();open();const saved=runtime.missionRuntime.missions.get(m.missionId);assert.equal(await runtime.missionRuntime.checkLearnedGuidance(saved,saved.waves[0]),mode==='valid');
});
