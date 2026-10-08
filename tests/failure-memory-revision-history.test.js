import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
test('same-clock failure memory edits retain separate durable revisions and safe recall history',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-failure-history-')),scope={userId:'local_user',workspaceRoot:root,conversationId:null};
 const clock=()=>new Date('2026-09-30T00:00:00.000Z');const opts={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock};
 let store=new SqliteMemoryStore(opts),growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 assert.equal(growth.ingest({eventId:'failure-source',taskId:'synthetic-task',eventType:'verification.failed',source:{module:'CORE',memoryScope:scope},
  payload:{rawText:'감사자료 파일 확인',reason:'검증 evidence 누락',reasonCode:'G_EVIDENCE_MISSING',toolName:'filesystem.listFiles'},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{systemGenerated:true}}).stored,true);
 const original=growth.query('',{scope}).find(x=>x.failureId);assert.ok(original);
 const first=growth.failureBuilder.reviewGuardrail({failureId:original.failureId,patch:{lesson:'OLD_PRIVATE_REVISION',futureGuardrail:'원본을 다시 확인'}});assert.equal(first.success,true);
 const second=growth.failureBuilder.reviewGuardrail({failureId:original.failureId,patch:{lesson:'감사자료 최신 확인',futureGuardrail:'산출물을 다시 읽어 확인'}});assert.equal(second.success,true);
 assert.notEqual(first.review.reviewId,second.review.reviewId,'same clock must not overwrite a prior edit');
 assert.equal(store.allFailureGuardrailReviews().length,2);
 const check=()=>{const current=growth.query('',{scope}).find(x=>x.failureId===original.failureId);assert.equal(current.lesson,'감사자료 최신 확인');
  assert.equal(current.provenance.revisionHistory.length,2);assert.equal(current.provenance.revisionReference.revision,2);
  assert.deepEqual(current.provenance.usageScopes,[scope]);assert.deepEqual(current.provenance.sourceEventIds,['failure-source']);
  assert.equal(JSON.stringify(current.provenance).includes('OLD_PRIVATE_REVISION'),false);
 };check();store.close();store=new SqliteMemoryStore(opts);growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock});check();
 const raw=store.allFailureGuardrailReviews()[0];
 assert.throws(()=>store.saveFailureGuardrailReview({...raw,patch:{lesson:'OVERWRITE'}}),{code:'F_FAILURE_REVIEW_REVISION_CONFLICT'});
 assert.equal(store.allFailureGuardrailReviews()[0].patch.lesson,'OLD_PRIVATE_REVISION');
 assert.deepEqual(store.saveFailureGuardrailReview(raw),raw);assert.equal(store.allFailureGuardrailReviews().length,2);
 const writer=new SqliteMemoryStore(opts);
 try{const other=new GrowthRuntime({memoryStore:writer,auditRoot:root,clock});
  assert.equal(other.failureBuilder.reviewGuardrail({failureId:original.failureId,patch:{lesson:'감사자료 다른 연결 최신 확인'}}).success,true);
  const live=growth.query('',{scope}).find(x=>x.failureId===original.failureId);
  assert.equal(live.lesson,'감사자료 다른 연결 최신 확인');assert.equal(live.provenance.revisionHistory.length,3);
 }finally{writer.close();}
 store.db.exec("CREATE TRIGGER review_write_outage BEFORE INSERT ON failure_guardrail_reviews BEGIN SELECT RAISE(ABORT,'injected review outage'); END");
 assert.throws(()=>growth.failureBuilder.reviewGuardrail({failureId:original.failureId,patch:{lesson:'MUST_NOT_PUBLISH'}}),/injected review outage/);
 store.db.exec('DROP TRIGGER review_write_outage');
 assert.equal(store.allFailureGuardrailReviews().length,3);
 assert.equal(growth.query('',{scope}).find(x=>x.failureId===original.failureId).lesson,'감사자료 다른 연결 최신 확인');
 assert.deepEqual(growth.query('',{scope:{...scope,conversationId:'other'}}),[]);
 growth.decideHygiene({targetId:'failure-source',action:'delete'});
 assert.equal(growth.query('',{scope}).some(x=>x.failureId),false);
 assert.equal(JSON.stringify(store.allFailureGuardrailReviews()).includes('OLD_PRIVATE_REVISION'),false);
});
