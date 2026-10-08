import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'jarvis-runtime-reload-'));
  const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const runtime=new GrowthRuntime({memoryStore:store,auditRoot:root});
  const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
  const resolver=()=>scope;runtime.setSourceScopeResolver(resolver);
  const verifier={verify:()=>[]};runtime.attachLearningVerifier(verifier);
  const retract=()=>({revoked:true});runtime.setSourceRetractionHandler(retract);
  const ingest=(id,text)=>runtime.ingestor.ingest({eventId:id,taskId:id,eventType:'task.created',source:{module:'CORE'},payload:{rawText:text},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
  ingest('base-event','기준 자료 정리');
  const approved=runtime.skillDraftRegistry.review({draftId:'base-draft',drafts:[{distilledSkillId:'base-draft',title:'자료 정리',evidenceEventIds:['base-event'],suggestedSteps:['기준 자료를 확인한다.'],styleHints:[],safetyConstraints:['requires_user_review','requires_policy_check'],confidence:.8}]});
  runtime.persistSkillRegistrySnapshot({action:'synthetic-fixture',skillId:approved.registryEntry.skillId});
  const backup=store.backup({backupId:'baseline'});
  ingest('post-event','POST_RESTORE_CACHE_MARKER_485 자료 정리');
  runtime.skillDraftRegistry.registry.get(approved.registryEntry.skillId).suggestedSteps=['POST_RESTORE_CACHE_MARKER_485'];
  runtime.submittedAutonomyCandidates.push({candidateId:'post-backup'});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {store,runtime,scope,ingest,backup,entry:approved.registryEntry,resolver,verifier,retract};
}
test('same GrowthRuntime reloads restored events/skills and preserves policy and scope callbacks',t=>{
  const f=fixture(t);assert.ok(f.runtime.ingestor.events.has('post-event'));
  const result=f.runtime.restoreStorage({backupPath:f.backup.filePath});assert.equal(result.success,true);assert.equal(result.memoryReload.loadedEventCount,1);
  assert.equal(f.runtime.ingestor.events.has('post-event'),false);
  assert.equal(f.runtime.ingestor.learningQueue.some(item=>item.eventId==='post-event'),false);
  assert.equal(f.runtime.query('POST_RESTORE_CACHE_MARKER_485',{scope:f.scope}).length,0);
  assert.equal(JSON.stringify(f.runtime.skillRegistryStatus()).includes('POST_RESTORE_CACHE_MARKER_485'),false);
  assert.deepEqual(f.runtime.skillDraftRegistry.registry.get(f.entry.skillId).suggestedSteps,['기준 자료를 확인한다.']);
  assert.deepEqual(f.runtime.submittedAutonomyCandidates,[]);
  assert.equal(f.runtime.learningVerifier,f.verifier);assert.equal(f.runtime.sourceRetractionHandler,f.retract);
  assert.equal(f.runtime.ingestor.sourceScopeResolver,f.resolver);
  assert.equal(f.ingest('new-event','새 자료 정리').success,true);
  assert.equal(f.store.allEvents().some(item=>item.eventId==='new-event'),true);
  assert.equal(f.runtime.ingestor.events.get('new-event').source.memoryScope.userId,f.scope.userId);
});
test('committed restore with cache reload failure discards stale caches and fails closed until recovery',t=>{
  const f=fixture(t),allEvents=f.store.allEvents.bind(f.store);
  f.store.allEvents=()=>{throw new Error('synthetic cache load failure');};
  const result=f.runtime.restoreStorage({backupPath:f.backup.filePath});assert.equal(result.success,false);assert.equal(result.databaseRestored,true);assert.equal(result.restartRequired,true);
  assert.equal(f.runtime.query('POST_RESTORE_CACHE_MARKER_485',{scope:f.scope}).length,0);
  assert.equal(f.runtime.ingestor.events.size,0);
  assert.equal(f.ingest('blocked-event','must not ingest').error.code,'F_MEMORY_RESTORE_RELOAD_REQUIRED');
  assert.equal(f.runtime.latestReview().error.code,'F_MEMORY_RESTORE_RELOAD_REQUIRED');
  assert.equal(f.runtime.storageStatus().memoryRecovery.status,'restart_required');
  f.store.allEvents=allEvents;
  assert.equal(f.runtime.restoreStorage({backupPath:f.backup.filePath}).success,true);
  assert.equal(f.runtime.ingestor.events.has('base-event'),true);assert.equal(f.runtime.ingestor.events.has('post-event'),false);
  assert.equal(f.ingest('recovered-event','복구 후 새 자료').success,true);
});
test('failed DB restore does not discard current valid runtime memory',t=>{
  const f=fixture(t);const original=f.runtime.ingestor;
  assert.equal(f.runtime.restoreStorage({backupPath:'missing-synthetic-backup'}).success,false);
  assert.equal(f.runtime.ingestor,original);assert.equal(f.runtime.ingestor.events.has('post-event'),true);
});

test('reloaded procedure callbacks use the current runtime and honor later source withdrawal',t=>{
  const f=fixture(t);
  assert.equal(f.runtime.restoreStorage({backupPath:f.backup.filePath}).success,true);
  assert.equal(f.runtime.skillDraftRegistry.status().registryEntries[0].contentWithheld,undefined);
  const result=f.runtime.decideHygiene({targetId:'base-event',action:'delete'});assert.equal(result.success,true);
  assert.equal(f.runtime.skillDraftRegistry.status().registryEntries[0].contentWithheld,true);
  assert.equal(f.runtime.skillDraftRegistry.createRevision({skillId:f.entry.skillId}).error.code,'F_SKILL_SOURCE_RETRACTED');
  assert.equal(f.runtime.ingestor.learningQueue.some(item=>item.eventId==='base-event'),false);
});
