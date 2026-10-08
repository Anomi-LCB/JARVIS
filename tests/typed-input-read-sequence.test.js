import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {planTypedTextInputReads} from '../packages/core/src/mission/read-only-text-batch-plan.js';
import {inspectTextReadRequirement} from '../packages/core/src/mission/read-only-text-proof.js';
const objective="'source.txt'를 읽어; 'protected.txt'를 읽어; 'protected.txt'는 삭제하지 마";
async function fixture(t,size=10){
 const root=await mkdtemp(join(tmpdir(),'jarvis-typed-input-sequence-'));let calls=0;
 const source=size===9000?'a'.repeat(55000)+'😀':'합성 원문😀\n'.repeat(size),protectedContent='보존해야 할 합성 자료';
 await writeFile(join(root,'source.txt'),source);await writeFile(join(root,'protected.txt'),protectedContent);
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,
   missionPlanner:{async planNextWave(){calls++;throw Error('unplanned model fallback');}}});
 t.after(async()=>{runtime.pcAgent.remoteOperationStore?.close();runtime.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});});
 const criteria=[['source.txt',source],['protected.txt',protectedContent]].map(([path,equals])=>({statement:`${path} 입력 보존`,artifactRole:'input',verificationSpec:{version:1,kind:'text.equals',path,equals}}));
 const create=(changes={})=>runtime.missionRuntime.createMission({objective,successCriteria:criteria,authorization:{grants:['read_only']},
   metadata:{longTermMemory:false},budgets:{maxPlannerCalls:8,maxActions:8},...changes});
 return {root,source,protectedContent,runtime,create,calls:()=>calls};
}
for(const size of [0,10,9000])test(`typed input read sequence completes Core/E/B/G without a model: ${size}`,async t=>{
 const f=await fixture(t,size),created=f.create();
 assert.equal(created.success,true,JSON.stringify(created));
 const result=await f.runtime.missionRuntime.runMission(created.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify(result));assert.equal(f.calls(),0);
 assert.equal(result.observations.every(o=>o.toolName==='filesystem.readText'&&o.verification.status==='passed'),true);
 assert.equal(await readFile(join(f.root,'source.txt'),'utf8'),f.source);
 assert.equal(await readFile(join(f.root,'protected.txt'),'utf8'),f.protectedContent);
 assert.ok(result.observations.length>=(size===9000?3:2));
 const first=result.goalContract.requirements[0],check=mission=>inspectTextReadRequirement({mission,requirement:mission.goalContract.requirements[0],allowedRoots:[f.root]});
 assert.equal(check(result).passed,true);
 for(const mutate of [
  m=>{m.observations[0].data.textRead.content='forged';},
  m=>{m.observations[0].verification.status='failed';},
  m=>{m.waves[0].actions[0].operation.dispatch.arguments.path=join(f.root,'protected.txt');},
  m=>{m.waves[0].actions[0].requirementIds=[m.goalContract.requirements[1].requirementId];}
 ]){const altered=structuredClone(result);mutate(altered);assert.notEqual(check(altered).passed,true);}
 assert.equal(inspectTextReadRequirement({mission:result,requirement:{...first},allowedRoots:[f.root]}).applicable,false);
});
test('a prohibited target is never invented as a required read to discharge a criterion',async t=>{
 const f=await fixture(t),created=f.create({objective:"'source.txt'를 읽어; 'protected.txt'는 삭제하지 마"});
 assert.equal(planTypedTextInputReads({mission:created,allowedRoots:[f.root]}),null);
});
test('the original fixed output-role contract is not reinterpreted as input evidence',async t=>{
 const f=await fixture(t),created=f.create();
 const unchanged=structuredClone(created);for(const c of unchanged.successCriteria)delete c.artifactRole;
 assert.equal(planTypedTextInputReads({mission:unchanged,allowedRoots:[f.root]}),null);
});
for(const mutate of [
 m=>{m.goalContract.requirements[0].interpretation.target='protected.txt';},
 m=>{m.goalContract.requirements[0].text='changed';},
 m=>{m.constraints.push({statement:'이메일로 보내줘'});},
 m=>{m.successCriteria[0].verificationSpec.path='../outside.txt';},
 m=>{m.successCriteria.pop();},
 m=>{m.goalContract.unresolvedRequirementIds=['unknown'];},
 m=>{m.goalContract.requirements[0].interpretation.hasExclusion=true;}
])test(`typed read planner rejects unsupported or changed contract: ${mutate.toString()}`,async t=>{
 const f=await fixture(t),created=f.create();mutate(created);
 assert.equal(planTypedTextInputReads({mission:created,allowedRoots:[f.root]}),null);
});
