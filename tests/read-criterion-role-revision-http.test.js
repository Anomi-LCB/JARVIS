import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {planTypedTextInputReads} from '../packages/core/src/mission/read-only-text-batch-plan.js';
import {createGoalRevisionDraft,goalRevisionRequest} from '../src/ui/mission-goal-editor.js';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
test('explicit UI draft revision preserves typed criteria and read-only authority through HTTP resume',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-read-role-http-')),workspace=join(root,'workspace');let service;
 t.after(async()=>{service?.server.closeAllConnections();await service?.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-read-role-http-'));await rm(root,{recursive:true,force:true});});
 await mkdir(workspace);await writeFile(join(workspace,'source.txt'),'합성 원문 3건');await writeFile(join(workspace,'protected.txt'),'보존해야 할 합성 자료');
 service=await createConfiguredCoreServiceRuntime({env:{JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'ops.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',JARVIS_CORE_ADMIN_TOKEN:'synthetic-read-role-admin',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${service.server.address().port}`;
 const headers={authorization:'Bearer synthetic-read-role-admin','content-type':'application/json'};
 const post=async(path,body)=>{const r=await fetch(url+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,path==='/missions'?201:200,await r.clone().text());return r.json();};
 const owner=await post('/owner-session/activate',{durationMinutes:5,grants:['read_only']});assert.ok(owner.session.sessionId);
 const objective="'source.txt'를 읽어; 'protected.txt'는 삭제하지 마";
 const successCriteria=[{statement:'원본 보존',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'합성 원문 3건'}},{statement:'삭제 금지 자료 보존',verificationSpec:{version:1,kind:'text.equals',path:'protected.txt',equals:'보존해야 할 합성 자료'}}];
 const created=await post('/missions',{objective,successCriteria,metadata:{longTermMemory:false},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only']},budgets:{maxPlannerCalls:6,maxActions:6}});
 const waiting=await post(`/missions/${encodeURIComponent(created.missionId)}/run`,{});
 assert.equal(waiting.status,'WAITING_APPROVAL');assert.equal(waiting.stopReason,'clarification-required');assert.equal(waiting.metrics.successfulActions,1);assert.equal(waiting.metrics.plannerAttempts,0);
 assert.equal(waiting.pendingGates.length,1);assert.equal(waiting.pendingGates[0].questions.length,2);assert.deepEqual(waiting.successCriteria,created.successCriteria);
 assert.equal(waiting.observations.filter(o=>o.outcome==='success'&&o.toolName==='filesystem.readText').length,1);
 const draft=createGoalRevisionDraft(waiting);
 draft.objective="'source.txt'를 읽어; 'protected.txt'를 읽어; 'protected.txt'는 삭제하지 마";
 draft.reason='두 파일의 기존 자료 확인을 명시';draft.criterionRoles=['input','input'];
 const request=goalRevisionRequest(draft,()=> 'explicit-input-role');
 const revised=await post(`/missions/${created.missionId}/goal-revisions`,request);
 assert.equal(revised.status,'applied');assert.equal(revised.mission.missionId,created.missionId);
 assert.equal(revised.mission.goalContract.revision,2);
 assert.deepEqual(revised.mission.successCriteria.map(c=>c.verificationSpec),created.successCriteria.map(c=>c.verificationSpec));
 assert.deepEqual(revised.mission.goalRevisionHistory[0].successCriteria,created.successCriteria);
 assert.deepEqual(revised.mission.authorization.grants,['read_only']);
 for(const mutate of [
  m=>{m.waves[0].actions[0].goalRevision=3;},
  m=>{delete m.waves[0].actions[0].goalRevision;},
  m=>{m.goalRevisionRequest.state='pending';},
  m=>{m.goalRevisionConflicts=[{code:'unknown-effect'}];},
  m=>{m.successCriteria[0].verificationSpec.path='../outside.txt';}
 ]){const altered=structuredClone(revised.mission);mutate(altered);assert.equal(planTypedTextInputReads({mission:altered,allowedRoots:[workspace]}),null);}
 assert.equal(planTypedTextInputReads({mission:revised.mission,allowedRoots:[workspace]}).decision,'continue');
 const replay=await post(`/missions/${created.missionId}/goal-revisions`,request);assert.equal(replay.mission.goalContract.revision,2);
 const after=await post(`/missions/${created.missionId}/run`,{});
 assert.equal(after.status,'COMPLETED',JSON.stringify({status:after.status,reason:after.stopReason,completion:after.completion}));
 assert.deepEqual(after.authorization.grants,['read_only']);
 assert.equal(after.goalRevisionHistory.length,1);
 assert.equal(after.waves.flatMap(w=>w.actions).filter(a=>a.status==='succeeded').every(a=>a.actualToolName==='filesystem.readText'),true);
 assert.equal(await readFile(join(workspace,'source.txt'),'utf8'),'합성 원문 3건');assert.equal(await readFile(join(workspace,'protected.txt'),'utf8'),'보존해야 할 합성 자료');
 t.diagnostic(JSON.stringify({configuredTestMode:false,actualCoreEBGSqlite:true,syntheticLocalFiles:true,readCount:after.metrics.successfulActions,questionCount:2,questionBatches:1,plannerAttempts:0,criteriaExplicitlyChanged:true,writePermissionAdded:false,revisedObjectiveCompleted:true}));
});
