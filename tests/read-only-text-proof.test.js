import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {verifyReadOnlyText} from '../packages/core/src/mission/read-only-text-proof.js';
import {missionRequest} from '../src/ui/workspace/model.js';

for(const [maxChars,size] of [[100,'short'],[3,'short'],[100,'large'],[100,'empty']])test(`actual ordinary read Mission independently verifies the entire source: maxChars=${maxChars}/${size}`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-text-proof-')),path=join(root,'source.txt'),source=size==='empty'?'':size==='large'?'\uFEFF'+('자료😀\n').repeat(22000):'\uFEFF  자료😀\n확인된 원문.  ';
 writeFileSync(path,source);const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const planner={async planNextWave(c){
  if(c.observations.some(o=>o.outcome==='success'))return {decision:'complete',actions:[],criteriaAssessment:c.mission.successCriteria.map(k=>({criterionId:k.criterionId,status:'satisfied',evidenceActionIds:c.observations.map(o=>o.actionId)}))};
  return {decision:'continue',actions:[{id:'read',command:'source.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path,maxChars},dependencies:[],requirementIds:c.mission.goalContract.requirements.map(r=>r.requirementId)}]};
 }};
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,workerDaemonEnabled:false,missionPlanner:planner});
 t.after(()=>{runtime.close?.();runtime.coreFacade.cognition?.close();rmSync(root,{recursive:true,force:true});});
 const owner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'text-proof'});
 const created=runtime.missionRuntime.createMission(missionRequest("'source.txt' 내용을 읽어줘",{key:'synthetic-text',conversationId:'synthetic',session:{sessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY]}}));
 const result=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,obs:result.observations.map(o=>o.error)}));
 const mission=runtime.missionRuntime.missions.get(created.missionId),statement=mission.successCriteria[0].statement;
 const check=(m=mission)=>verifyReadOnlyText({mission:m,allowedRoots:[root],statement,evidenceActionIds:m.observations.filter(o=>o.outcome==='success').map(o=>o.actionId)});
 if(maxChars===3){
  const partial=structuredClone(mission);partial.waves=partial.waves.slice(0,1);partial.observations=partial.observations.slice(0,1);
  assert.ok(check(partial).reasons.includes('text-read-incomplete'));assert.equal(mission.observations.filter(o=>o.outcome==='success').length,2);
 }
 assert.equal(check().passed,true);assert.equal(result.gates.length,0);
 for(const mutate of [
  m=>{m.observations[0].data.textRead.content='forged';},
  m=>{m.observations[0].verification.status='failed';},
  m=>{m.waves[0].actions[0].operation.dispatch.arguments.path=join(root,'other.txt');},
  m=>{m.observations[0].data.textRead.offset=1;},
  m=>{m.constraints.push({statement:'이메일로 전송해'});},
  m=>{m.waves[0].actions.push({...structuredClone(m.waves[0].actions[0]),actualToolName:'email.send'});}
  ,m=>{m.waves[0].actions[0].goalRevision=0;}
  ,m=>{m.observations[0].data.textRead.pathHash='0'.repeat(64);}
 ]){const changed=structuredClone(mission);mutate(changed);assert.notEqual(check(changed).passed,true);}
 assert.equal(verifyReadOnlyText({mission,allowedRoots:[root],statement,beforeRead:()=>{throw new Error('revoked');}}).passed,false);
 if(size==='large')assert.ok(mission.observations.filter(o=>o.outcome==='success').length>=3);
 assert.equal(verifyReadOnlyText({mission,allowedRoots:[root],statement,evidenceActionIds:[]}).passed,false);
 writeFileSync(path,'변경된 원문');assert.ok(check().reasons.includes('text-read-gap-or-source-mismatch'));
});
