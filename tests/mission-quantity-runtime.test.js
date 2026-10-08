import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

for(const [expression,reason] of [['0.5부씩','goal-quantity-unresolved'],['3명에게 2부씩','goal-quantity-effect-unverified'],['500mg 이하','goal-quantity-effect-unverified']])
test(`actual local preparation persists source quantity and prevents unverified sending: ${expression}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-quantity-runtime-')),output='합성 수량 확인용 준비 문서',hash=createHash('sha256').update(output).digest('hex');
 await writeFile(join(root,'source.txt'),'합성 원자료');const calls=[];
 const planner={async planNextWave({mission}){
  const ids=mission.goalContract.requirements.map(r=>r.requirementId);
  return {decision:'continue',actions:[
   {id:'read',title:'원자료',command:'source.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(root,'source.txt')},requirementIds:[ids[0]],dependencies:[]},
   {id:'save',title:'준비 문서',command:'draft.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'draft.txt'),content:output},requirementIds:[ids[1]],dependencies:['read']},
   {id:'send',title:'수량이 있는 외부 요청',command:'이메일로 보내줘',expectedToolName:'email.send',arguments:{recipientMode:'self',subject:'합성 수량',body:'합성 자료',attachments:[{attachmentRef:{rootIndex:0,relativePath:'draft.txt'},attachmentSha256:hash}],quantityVerified:true},requirementIds:[ids[2]],dependencies:['save']}
  ],criteriaAssessment:[]};
 }};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,missionStorePath:join(root,'missions.json'),missionPlanner:planner,workerDaemonEnabled:false});
 t.after(async()=>{runtime.coreFacade.cognition.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 runtime.missionRuntime.capabilityAvailabilityGuard.assess=async()=>({required:false});
 const original=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
 runtime.orchestrationWorker.runTask=async(taskId,...rest)=>{const tool=runtime.coreFacade.getTask(taskId).plan.action.toolName;calls.push(tool);if(tool==='email.send')throw Error('FORBIDDEN_TEST_EXTERNAL_SEND');return original(taskId,...rest);};
 const created=runtime.missionRuntime.createMission({objective:`'source.txt'를 읽어; 'draft.txt'를 저장해; ${expression} 'draft.txt'를 보내`,authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]},successCriteria:[{criterionId:'draft',statement:'실제 준비 문서',verificationSpec:{version:1,kind:'text.equals',path:'draft.txt',equals:output}}]});
 const result=await runtime.missionRuntime.runMission(created.missionId),mission=runtime.missionRuntime.getMission(created.missionId);
 assert.equal(result.status,'PAUSED',JSON.stringify(result));assert.deepEqual(calls,['filesystem.readText','filesystem.createTextFile']);
 assert.equal(await readFile(join(root,'draft.txt'),'utf8'),output);const send=mission.waves.flatMap(w=>w.actions).find(a=>a.expectedToolName==='email.send');
 assert.equal(send.attempts,0);assert.ok(send.requirementCoverage.reasons.some(r=>r.code===reason));
 assert.equal(mission.observations.filter(o=>o.verification?.status==='passed').length,2);
 const disk=JSON.parse(await readFile(join(root,'missions.json'),'utf8'));assert.ok(JSON.stringify(disk).includes(reason));
 assert.ok(mission.goalContract.quantities.length);assert.equal(mission.goalContract.quantities[0].text,expression==='3명에게 2부씩'?'3명':expression);
 console.log(JSON.stringify({quantityRuntimeEvidence:{observedAt:new Date().toISOString(),expression,status:mission.status,reason,quantities:mission.goalContract.quantities,calls,sendAttempts:send.attempts,actualPcAndG:true,readiness:'synthetic',externalCalls:0,cost:'미측정'}}));
});
