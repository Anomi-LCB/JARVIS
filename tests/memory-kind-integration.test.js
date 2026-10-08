import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';

test('durable F/Core separates assertions, decision reasons, observed experience and verified procedure across restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-memory-kinds-'));
  const env = { JARVIS_TEST_MODE:'1', JARVIS_TEST_AUDIT_ROOT:root, JARVIS_CORE_ROOT:root,
    JARVIS_CORE_ALLOWED_ROOTS:root, JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0', JARVIS_PERSONAL_IMPORT_ENABLED:'0', JARVIS_GOOGLE_SYNC_ENABLED:'0' };
  let runtime = await createConfiguredCoreServiceRuntime({env});
  t.after(async () => { await runtime.close(); await rm(root,{recursive:true,force:true}); });
  const scope = {userId:'local_user',workspaceRoot:root,conversationId:'synthetic-kinds'};
  const objective = '연구 자료를 읽고 핵심 근거를 정리해줘';
  const put = (id, knowledge) => runtime.growthRuntime.ingest({eventId:id,taskId:runtime.coreFacade.createTask('합성 기억 저장',{metadata:{conversationId:scope.conversationId}}).taskId,eventType:'task.created',
    createdAt:new Date().toISOString(),source:{module:'CORE',memoryScope:scope},
    payload:{rawText:'합성 연구 기억',knowledge},learningFlags:{canBeUsedForWorkflow:true},
    trustBoundary:{userProvided:true,externalContent:false,systemGenerated:false}});
  put('kind-fact',{kind:'fact',subject:'합성 연구',predicate:'자료 위치',value:'선택 폴더'});
  put('kind-decision',{kind:'decision',subject:'합성 연구',predicate:'작업 방식',value:'원본 보존',reason:'재검증 가능성'});
  for(let i=0;i<3;i++)runtime.growthRuntime.ingestor.ingest({eventId:`kind-procedure-${i}`,taskId:runtime.coreFacade.createTask(objective,{metadata:{conversationId:scope.conversationId}}).taskId,
    eventType:'task.created',source:{memoryScope:scope},payload:{rawText:objective},
    learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,externalContent:false,systemGenerated:false}});
  const draft = runtime.growthRuntime.advancedLearningModels().skillDistillations[0];
  assert.ok(draft);
  const entry = runtime.growthRuntime.reviewSkillDraft(draft.distilledSkillId,{decision:'approve',decidedBy:'synthetic-owner'}).registryEntry;
  const f=JSON.parse(await readFile(new URL('./fixtures/agent-platform-g05-cross-material.json',import.meta.url),'utf8'));
  const created=runtime.growthRuntime.mutateSkillRevision('create',{skillId:entry.skillId,expectedActiveRevisionId:entry.activeRevisionId,
    suggestedSteps:['원문 필드를 확인한다.','그룹 합계와 건수를 대조한다.'],procedureDefinition:f.procedureDefinition});
  assert.equal(created.success,true);
  const revision={skillId:entry.skillId,revisionId:created.revision.revisionId};
  assert.equal(runtime.growthRuntime.mutateSkillRevision('review',{...revision,decision:'approve'}).success,false,'unverified drafts cannot be promoted by review alone');
  assert.equal(runtime.growthRuntime.mutateSkillRevision('evaluate',{...revision,trialCases:f.cases}).success,true);
  assert.equal(runtime.growthRuntime.mutateSkillRevision('review',{...revision,decision:'approve'}).success,true);
  assert.equal(runtime.growthRuntime.mutateSkillRevision('promote',{...revision,expectedActiveRevisionId:entry.activeRevisionId}).success,true);
  await writeFile(join(root,'synthetic-material.txt'),'synthetic source material');
  const task=runtime.coreFacade.createTask('파일 목록 보여줘',{metadata:{conversationId:scope.conversationId}});
  const run=await runtime.orchestrationWorker.runTask(task.taskId,{deviceId:'synthetic-kind-worker'});
  assert.equal(run.success,true);assert.equal(run.executionVerification.status,'passed');
  const check=()=>{
    const knowledge=runtime.growthRuntime.query('합성 연구',{scope}).filter(x=>x.memoryType==='personal_knowledge');
    assert.deepEqual(knowledge.map(x=>x.kind).sort(),['decision','fact']);
    assert.equal(knowledge.find(x=>x.kind==='decision').reason,'재검증 가능성');
    assert.ok(knowledge.every(x=>x.provenance.independentlyVerifiedOutcome===false&&x.executionAuthority===false));
    const evidence=runtime.coreFacade.cognition.relationshipEvidence({taskId:task.taskId,taskRequest:task.request,workspaceRoot:root});
    assert.equal(evidence.trace.outcomes.filter(x=>x.outcome==='passed').length,1);
    assert.ok(evidence.trace.decisions.length>0);assert.ok(evidence.goal);
    assert.equal(JSON.stringify(evidence).includes('재검증 가능성'),false,'user reasons never become observed execution decisions');
    const guidance=runtime.growthRuntime.missionSkillGuidance(objective,{scope});
    assert.equal(guidance.length,1);assert.equal(guidance[0].revisionId,revision.revisionId);
    const result=runtime.growthRuntime.runReviewedTabularProcedure({...revision,scope,
      lifecycleSha256:created.revision.procedureLifecycle.contractSha256,rows:[{부서:'합성',금액:11},{부서:'합성',금액:7}]});
    assert.equal(result.success,true);assert.equal(result.verification.status,'passed');
    assert.deepEqual(result.resultRows,[{group:'합성',total:18,count:2}]);assert.equal(result.externalEffects,false);
    const other={...scope,conversationId:'other'};
    assert.deepEqual(runtime.growthRuntime.query('합성 연구',{scope:other}),[]);
    assert.deepEqual(runtime.growthRuntime.missionSkillGuidance(objective,{scope:other}),[]);
    assert.equal(runtime.growthRuntime.runReviewedTabularProcedure({...revision,scope:other,
      lifecycleSha256:created.revision.procedureLifecycle.contractSha256,rows:[{부서:'합성',금액:1}]}).success,false);
  };
  check();
  await runtime.close();runtime=await createConfiguredCoreServiceRuntime({env});check();
  runtime.growthRuntime.decideHygiene({targetId:'kind-procedure-0',action:'delete',decidedBy:'synthetic-owner'});
  assert.deepEqual(runtime.growthRuntime.missionSkillGuidance(objective,{scope}),[]);
  assert.equal(runtime.growthRuntime.runReviewedTabularProcedure({...revision,scope,
    lifecycleSha256:created.revision.procedureLifecycle.contractSha256,rows:[{부서:'합성',금액:1}]}).success,false);
  assert.equal(runtime.growthRuntime.query('합성 연구',{scope}).filter(x=>x.memoryType==='personal_knowledge').length,2);
  assert.equal(runtime.coreFacade.cognition.relationshipEvidence({taskId:task.taskId,taskRequest:task.request,workspaceRoot:root}).trace.outcomes.length,1);
});
