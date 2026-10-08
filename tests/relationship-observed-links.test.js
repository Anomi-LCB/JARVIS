import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {observedTaskRelations} from '../packages/core/src/context/owner-relationship-query.js';

test('unjoined, rejected and inconsistent historical outcomes never become result relationships',()=>{
 const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64),now='2026-10-01T00:00:00.000Z';
 const decision={id:a,scopeRef:b,taskRef:c,planRef:d,requestRef:a,approvalRef:b,kind:'approve',recordedAt:now};
 const outcome={id:d,decisionRef:a,scopeRef:b,taskRef:c,planRef:d,requestRef:a,approvalRef:b,outcome:'passed',recordedAt:now,
  packetRef:a,verificationRef:a,evidenceRef:a,verificationContentRef:a,executionContentRef:a};
 const evidence={trace:{scopeRef:b,taskRef:c,decisions:[decision],outcomes:[outcome]},goal:null};
 assert.equal(observedTaskRelations(evidence,'synthetic-task').filter(x=>x.historicalVerificationStatus==='passed').length,2);
 for(const patch of [{decisionRef:b},{scopeRef:a},{taskRef:b},{planRef:b},{approvalRef:a},{verificationRef:'caller-text'},{recordedAt:'bad'},{outcome:'success'}]){
  assert.equal(observedTaskRelations({...evidence,trace:{...evidence.trace,outcomes:[{...outcome,...patch}]}},'synthetic-task').some(x=>x.historicalVerificationStatus),false);
 }
 assert.equal(observedTaskRelations({...evidence,trace:{...evidence.trace,decisions:[]}},'synthetic-task').length,0);
 assert.equal(observedTaskRelations({...evidence,trace:{...evidence.trace,decisions:[{...decision,kind:'reject'}]}},'synthetic-task').some(x=>x.historicalVerificationStatus),false);
 assert.equal(observedTaskRelations({...evidence,trace:{...evidence.trace,outcomes:[{...outcome,outcome:'failed'}]}},'synthetic-task').filter(x=>x.historicalVerificationStatus==='failed').length,2);
});

test('real owner relation joins worker/G proof, survives restart, excludes other scope and retracts without dispatch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-observed-relations-'));
 const env={JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:root,JARVIS_CORE_ROOT:root,JARVIS_CORE_ALLOWED_ROOTS:root,
  JARVIS_CORE_ADMIN_TOKEN:'synthetic-relations-token',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',
  JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 let runtime=await createConfiguredCoreServiceRuntime({env});
 t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
 await writeFile(join(root,'synthetic-input.txt'),'synthetic verification input');
 const task=runtime.coreFacade.createTask('파일 목록 보여줘',{metadata:{conversationId:'synthetic-relations'}});
 const run=await runtime.orchestrationWorker.runTask(task.taskId,{deviceId:'synthetic-relations-worker'});
 assert.equal(run.success,true);assert.equal(run.executionVerification.status,'passed');
 let owner=runtime.coreFacade.createTask('합성 관계 조회',{metadata:{conversationId:'synthetic-relations'}});
 let address=await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0}),base=`http://127.0.0.1:${address.port}`;
 const headers={authorization:'Bearer synthetic-relations-token'};
 const read=(extra={},taskId=owner.taskId)=>fetch(base+'/memory/knowledge/relations?'+new URLSearchParams({taskId,entity:'프로젝트:합성 연구',depth:'5',...extra}),{headers});
 const saved=await fetch(base+'/memory/knowledge/statements',{method:'POST',headers:{...headers,'content-type':'application/json'},
  body:JSON.stringify({taskId:owner.taskId,requestId:'synthetic-task-link',statement:`'프로젝트:합성 연구'의 '수행 작업'은 '작업:${task.taskId}'이라고 기억해줘`})});
 assert.equal(saved.status,201);
 const check=async()=>{
  const count=runtime.orchestrationWorker.runs.length;
  const response=await read();assert.equal(response.status,200);const graph=await response.json();
  assert.ok(graph.nodes.some(x=>x.type==='goal'));assert.ok(graph.nodes.some(x=>x.type==='decision'));
  assert.ok(graph.nodes.some(x=>x.type==='result'));assert.ok(graph.nodes.some(x=>x.type==='material'));
  assert.ok(graph.edges.some(x=>x.basis==='user-statement'));assert.ok(graph.edges.some(x=>x.basis==='historical-execution-observation'&&x.historicalVerificationStatus==='passed'));
  assert.ok(graph.edges.filter(x=>x.basis==='historical-execution-observation').every(x=>x.sourceEventId.startsWith('cognition:')));
  assert.equal(graph.currentArtifactVerified,false);assert.ok(graph.edges.every(x=>x.currentArtifactVerified===false&&x.executionAuthority===false));
  const serialized=JSON.stringify(graph);for(const value of [run.executionVerification.verificationId,run.execution.evidence.evidenceId])assert.equal(serialized.includes(value),false);
  const question="'프로젝트:합성 연구'의 연결 관계를 5단계까지 보여줘";
  const next=runtime.coreFacade.createTask(question,{metadata:{conversationId:'synthetic-relations'}});
  assert.ok(next.contextSnapshot.memoryEvidence.some(x=>x.basis==='historical-execution-observation'));
  assert.ok(next.contextSnapshot.memoryEvidence.some(x=>x.basis==='user-statement'));assert.deepEqual(next.contextSnapshot.userPreferences,[]);
  assert.equal(runtime.orchestrationWorker.runs.length,count,'relation lookup must not dispatch or repeat work');
  return graph;
 };
 const before=await check();
 runtime.orchestrationWorker.storeRun(run);assert.deepEqual(await (await read()).json(),before,'same outcome replay must not duplicate graph effects');
 const other=runtime.coreFacade.createTask('합성 다른 대화',{metadata:{conversationId:'other'}});
 const cross=await (await read({entity:'작업:'+task.taskId},other.taskId)).json();assert.equal(cross.found,false);assert.deepEqual(cross.edges,[]);
 const off=runtime.coreFacade.createTask('기억 제외',{metadata:{conversationId:'synthetic-relations',longTermMemory:false}});
 assert.equal((await read({},off.taskId)).status,404);
 await runtime.close();runtime=await createConfiguredCoreServiceRuntime({env});
 assert.equal(runtime.coreFacade.getTask(task.taskId),undefined);
 owner=runtime.coreFacade.createTask('재시작 후 합성 관계 조회',{metadata:{conversationId:'synthetic-relations'}});
 address=await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});base=`http://127.0.0.1:${address.port}`;
 assert.deepEqual(await check(),before);
 const direct=await (await read({entity:'작업:'+task.taskId})).json();assert.ok(direct.edges.some(x=>x.historicalVerificationStatus==='passed'));
 runtime.coreFacade.cognition.db.exec("CREATE TRIGGER synthetic_relation_retraction_failure BEFORE DELETE ON cognitive_episodes BEGIN SELECT RAISE(ABORT,'synthetic outage'); END");
 const feedback=runtime.growthRuntime.recordFeedback({taskId:task.taskId,feedbackType:'do_not_remember',text:'합성 실행 기억 제외'});
 assert.equal(feedback.success,false);assert.equal(feedback.error.code,'F_MEMORY_SCOPE_REQUIRED');assert.ok(feedback.nextAction);
 assert.equal(runtime.growthRuntime.ingestor.all().some(x=>x.taskId===task.taskId&&x.eventType==='feedback.do_not_remember'),false);
 const memoryEventId=run.learning?.memoryEvent?.eventId;assert.ok(memoryEventId);
 assert.equal(runtime.growthRuntime.ingestor.events.get(memoryEventId).source.memoryScope.conversationId,'synthetic-relations');
 runtime.growthRuntime.decideHygiene({targetId:memoryEventId,action:'delete',decidedBy:'scoped-synthetic-owner'});
 assert.equal((await read()).status,503,'failed cognition retraction must never return old outcomes');
 const blocked=runtime.coreFacade.createTask("'프로젝트:합성 연구'의 연결 관계를 5단계까지 보여줘",{metadata:{conversationId:'synthetic-relations'}});
 assert.ok(blocked.contextSnapshot.memoryEvidence.some(x=>x.requiresUserResolution));
 assert.equal(blocked.contextSnapshot.memoryEvidence.some(x=>x.basis==='historical-execution-observation'),false);
 runtime.coreFacade.cognition.db.exec('DROP TRIGGER synthetic_relation_retraction_failure');
 runtime.growthRuntime.synchronizeSourceRetractions();
 const withdrawn=await (await read()).json();assert.ok(withdrawn.edges.some(x=>x.basis==='user-statement'));
 assert.equal(withdrawn.edges.some(x=>x.basis==='historical-execution-observation'),false);
 assert.equal(withdrawn.nodes.some(x=>x.type==='result'),false);
 await runtime.close();runtime=await createConfiguredCoreServiceRuntime({env});
 owner=runtime.coreFacade.createTask('다시 재시작 관계 조회',{metadata:{conversationId:'synthetic-relations'}});
 address=await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});base=`http://127.0.0.1:${address.port}`;
 assert.equal((await (await read()).json()).edges.some(x=>x.basis==='historical-execution-observation'),false);
 const original=runtime.coreFacade.cognition.relationshipEvidence.bind(runtime.coreFacade.cognition);
 runtime.coreFacade.cognition.relationshipEvidence=query=>{
  const value=original(query);
  runtime.growthRuntime.memoryStore.db.exec('UPDATE memory_restore_generation SET generation=generation+1 WHERE singleton=1');
  return value;
 };
 assert.equal((await read()).status,503,'restore epoch changed during evidence lookup must reject a mixed graph');
 runtime.coreFacade.cognition.relationshipEvidence=original;
});
