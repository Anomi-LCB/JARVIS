import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {verifyReadOnlyText,planReadOnlyTextStart,planReadOnlyTextContinuation} from '../packages/core/src/mission/read-only-text-proof.js';
async function fixture(t,source){
 const root=await mkdtemp(join(tmpdir(),'jarvis-default-read-'));
 await writeFile(join(root,'source.txt'),source);
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
 t.after(async()=>{runtime.pcAgent.remoteOperationStore?.close();runtime.coreFacade.cognition.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-default-read-'));await rm(root,{recursive:true,force:true});});
 return {root,runtime};
}
for(const [name,source] of [['empty',''],['short','합성 자료😀'],['paged','자료😀\n'.repeat(24000)]])test(`default direct read preserves the original criterion and completes: ${name}`,async t=>{
 const f=await fixture(t,source),objective="'source.txt'를 읽어";
 const created=f.runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only']},metadata:{longTermMemory:false},budgets:{maxPlannerCalls:8,maxActions:8}});
 assert.equal(created.success,true);assert.equal(created.successCriteria[0].statement,objective);
 const result=await f.runtime.missionRuntime.runMission(created.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,criteria:result.verificationSummary}));
 assert.equal(result.successCriteria[0].statement,objective);assert.equal(result.metrics.plannerAttempts,0);
 assert.equal(result.observations.every(o=>o.toolName==='filesystem.readText'&&o.verification.status==='passed'),true);
 assert.equal(result.observations.length,name==='paged'?3:1);assert.equal(await readFile(join(f.root,'source.txt'),'utf8'),source);
 assert.equal(result.pendingGates.length,0);
 const mutation=structuredClone(result);mutation.observations[0].data.textRead.content='forged';
 assert.equal(verifyReadOnlyText({mission:mutation,allowedRoots:[f.root],statement:objective}).passed,false);
});
test('continuation pauses without actions when source disappears or current read authority is revoked',async t=>{
 const f=await fixture(t,'x'.repeat(60000)),objective="'source.txt'를 읽어";
 const created=f.runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only']},metadata:{longTermMemory:false}});
 await f.runtime.missionRuntime.runMission(created.missionId,{maxWaves:1});
 const mission=f.runtime.missionRuntime.missions.get(created.missionId);
 const revoked=planReadOnlyTextContinuation({mission,allowedRoots:[f.root],beforeRead:()=>{throw Error('revoked');}});
 assert.equal(revoked.pauseReason,'mission-text-read-evidence-invalidated');assert.deepEqual(revoked.actions,[]);
 assert.equal(revoked.planning.modelRoundTrips,0);assert.equal(revoked.planning.retryable,false);
 await rm(join(f.root,'source.txt'));
 const missing=planReadOnlyTextContinuation({mission,allowedRoots:[f.root]});
 assert.equal(missing.pauseReason,'mission-text-read-evidence-invalidated');assert.deepEqual(missing.actions,[]);
});

test('an explicit typed criterion cannot be replaced with full-read proof by using the objective as its statement',async t=>{
 const f=await fixture(t,'actual'),objective="'source.txt'를 읽어";
 const created=f.runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only']},metadata:{longTermMemory:false},
  successCriteria:[{statement:objective,artifactRole:'input',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'wrong'}}],budgets:{maxPlannerCalls:3,maxActions:3}});
 const result=await f.runtime.missionRuntime.runMission(created.missionId);
 assert.notEqual(result.status,'COMPLETED');
 assert.equal(result.successCriteria[0].verificationSpec.equals,'wrong');
 assert.equal(planReadOnlyTextStart({mission:created,allowedRoots:[f.root]}),null);
});
test('unknown appended meaning, conditions and prohibitions cannot become plain default reads',async t=>{
 const f=await fixture(t,'actual');
 for(const objective of ["'source.txt'를 읽어; 내용을 의학적으로 진단해", "승인하면 'source.txt'를 읽어", "'source.txt'를 읽어; 'protected.txt'는 삭제하지 마"]){
  const created=f.runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only']},metadata:{longTermMemory:false}});
  assert.equal(planReadOnlyTextStart({mission:created,allowedRoots:[f.root]}),null,objective);
 }
});
