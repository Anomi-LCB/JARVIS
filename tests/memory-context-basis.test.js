import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectMemoryContext} from '../packages/core/src/context/memory-context-projection.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {ContextSnapshotContract} from '../packages/core/src/contracts/default-contracts.js';

test('context distinguishes assertions, inference and observations; only sourced confirmed preferences become preferences',()=>{
 const types=[['personal_knowledge','user_statement','user-statement'],['personal_knowledge_issue','user_statement','user-statement'],
  ['hypothesis','preference_hypothesis','system-inference'],['execution_observation','execution_observation','historical-execution-observation'],
  ['confirmed_preference','user_confirmed_preference','user-confirmed-preference'],['legacy',null,'unattributed-context']];
 const rows=types.map(([memoryType,memoryKind],i)=>({memoryId:`m${i}`,memoryType,text:`summary${i}`,requiresUserResolution:memoryType==='personal_knowledge_issue',
  provenance:{memoryKind,sourceEventIds:[`s${i}`],observedAt:['2026-10-01T00:00:00Z'],missingSourceCount:0,independentlyVerifiedOutcome:true}}));
 const projected=projectMemoryContext([...rows,{memoryType:'selected_conversation_quote',text:'UNTRUSTED_QUOTE'},
  {memoryType:'confirmed_preference',text:'MISSING_SOURCE',provenance:{memoryKind:'user_confirmed_preference',missingSourceCount:1}}]);
 assert.equal(projected.userPreferences.length,1);assert.equal(projected.userPreferences[0].memoryId,'m4');
 assert.deepEqual(projected.memoryEvidence.slice(0,6).map(item=>item.basis),types.map(item=>item[2]));
 assert.ok(projected.memoryEvidence.every(item=>item.executionAuthority===false&&item.currentArtifactVerified===false&&item.independentlyVerifiedOutcome===false));
 assert.equal(JSON.stringify(projected).includes('UNTRUSTED_QUOTE'),false);
});

test('real Core/F/cognition task preserves knowledge conflict and result boundaries across SQLite reopen',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-memory-basis-'));
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const opened=[];
 const open=()=>{
  const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const runtime=createAgRuntime({memoryStore:store,cognitionStorePath:join(root,'cognition.sqlite'),allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,bridgeRealExecution:true});
  const value={...runtime,close(){runtime.close?.();store.close();runtime.coreFacade.cognition.close();}};opened.push(value);return value;
 };
 t.after(()=>opened.forEach(value=>{try{value.close();}catch{}}));
 let runtime=open();const scope={userId:'local_user',workspaceRoot:root,conversationId:null};
 const put=(id,value,trust={userProvided:true,systemGenerated:false})=>runtime.growthRuntime.ingest({eventId:id,
  taskId:runtime.coreFacade.createTask('회의자료 파일 목록 확인').taskId,eventType:'task.created',source:{module:'CORE',memoryScope:scope},
  payload:{rawText:"'회의자료'의 '기본 형식'은 '"+value+"'이라고 기억해줘"},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:trust});
 put('assertion-a','표');put('assertion-b','문장');put('model-fact','MODEL_FACT',{systemGenerated:true});put('external-fact','EXTERNAL_FACT',{userProvided:true,externalContent:true});
 for(let i=0;i<3;i++)runtime.growthRuntime.ingest({eventId:`edit-${i}`,taskId:runtime.coreFacade.createTask('회의자료 파일 목록 확인').taskId,eventType:'approval.edited',source:{module:'CORE',memoryScope:scope},
  payload:{editRequest:'회의자료는 표로 정리해줘'},learningFlags:{canBeUsedForPreference:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 const candidate=runtime.growthRuntime.query('회의자료',{scope}).find(item=>item.hypothesisId);assert.ok(candidate);
 const owner=runtime.personalOwnerSession.activate({durationMinutes:15,requestedBy:'memory-basis-test'});
 const mission=runtime.missionRuntime.createMission({objective:'회의자료-결과 메모 파일을 만들어줘. 내용은 실제 검증 자료',
  authorization:{mode:'trusted_session',grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE],ownerSessionId:owner.session.sessionId}});
 const result=await runtime.missionRuntime.runMission(mission.missionId);assert.equal(result.status,'COMPLETED');assert.equal(result.verificationStatus,'passed');
 const verifiedEpisodes=runtime.coreFacade.cognitiveStatus().memory.episodeCount;assert.equal(verifiedEpisodes,1);
 const declaredTask=runtime.coreFacade.createTask('회의자료 파일 목록 확인');
 runtime.growthRuntime.ingest({eventId:'declared-not-verified',taskId:declaredTask.taskId,eventType:'execution.completed',
  source:{module:'PC_AGENT',memoryScope:scope},payload:{outputPaths:[join(root,'회의자료-미생성.txt')]},
  learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{systemGenerated:true}});
 assert.equal(runtime.coreFacade.cognitiveStatus().memory.episodeCount,verifiedEpisodes,'a declared F event is not a current G outcome');
 const inferred=runtime.coreFacade.createTask('회의자료 파일을 확인해줘');
 assert.equal(inferred.contextSnapshot.userPreferences.length,0);
 assert.ok(inferred.contextSnapshot.memoryEvidence.some(item=>item.basis==='system-inference'));
 assert.ok(inferred.contextSnapshot.memoryEvidence.some(item=>item.basis==='historical-execution-observation'));
 assert.ok(inferred.contextSnapshot.memoryEvidence.some(item=>item.requiresUserResolution));
 assert.equal(runtime.growthRuntime.decidePreference({hypothesisId:candidate.hypothesisId,decision:'confirm'}).success,true);
 const confirmed=runtime.coreFacade.createTask('회의자료 파일을 확인해줘');assert.ok(confirmed.contextSnapshot.userPreferences.length>0);
 assert.ok(confirmed.contextSnapshot.userPreferences.every(item=>item.basis==='user-confirmed-preference'));
 assert.equal(JSON.stringify(confirmed.memoryContext).includes('MODEL_FACT'),false);assert.equal(JSON.stringify(confirmed.memoryContext).includes('EXTERNAL_FACT'),false);
 runtime.close();runtime=open();
 const reopened=runtime.coreFacade.createTask('회의자료 파일을 확인해줘');
 assert.ok(reopened.contextSnapshot.userPreferences.every(item=>item.basis==='user-confirmed-preference'));
 assert.ok(reopened.contextSnapshot.memoryEvidence.some(item=>item.requiresUserResolution));
 assert.ok(reopened.contextSnapshot.memoryEvidence.some(item=>item.basis==='historical-execution-observation'&&item.currentArtifactVerified===false));
 assert.equal(ContextSnapshotContract.validate(reopened.contextSnapshot).valid,true);
 for(const [field,value] of [['validity',{validUntil:'invalid',basis:'declared-expiry'}],
   ['usageScopes',[{userId:'local_user'}]],['revisionReference',{revision:-1,supersedesEventId:null}]]){
  const invalid=structuredClone(reopened.contextSnapshot);invalid.memoryEvidence[0][field]=value;
  assert.equal(ContextSnapshotContract.validate(invalid).valid,false);
 }
 assert.ok(reopened.contextSnapshot.memoryEvidence.every(item=>item.validity.basis==='unspecified'));
 assert.ok(reopened.contextSnapshot.userPreferences.every(item=>item.revisionReference.revision>=1));
 assert.ok(reopened.contextSnapshot.memoryEvidence.filter(item=>item.basis!=='unattributed-context').every(item=>item.usageScopes.some(value=>value.userId==='local_user'&&value.workspaceRoot===root)));
 for(const field of ['executionAuthority','independentlyVerifiedOutcome','currentArtifactVerified']){
  const forged=structuredClone(reopened.contextSnapshot);forged.memoryEvidence[0][field]=true;
  assert.equal(ContextSnapshotContract.validate(forged).valid,false);
 }
 runtime.growthRuntime.decideHygiene({targetId:'assertion-b',action:'delete'});
 const resolved=runtime.coreFacade.createTask('회의자료 파일을 확인해줘');
 assert.ok(resolved.contextSnapshot.memoryEvidence.some(item=>item.basis==='user-statement'&&!item.requiresUserResolution));
 assert.equal(resolved.contextSnapshot.userPreferences.some(item=>item.summary.includes('기본 형식')),false);
 const off=runtime.coreFacade.createTask('회의자료 파일을 확인해줘',{metadata:{longTermMemory:false}});
 assert.deepEqual(off.contextSnapshot.memoryEvidence,[]);assert.deepEqual(off.contextSnapshot.userPreferences,[]);
 console.log(JSON.stringify({actualCoreF:true,actualFileG:true,inferenceWasNotPreference:true,conflictRetained:true,reopenedSqlite:true,memoryOff:true}));
});
