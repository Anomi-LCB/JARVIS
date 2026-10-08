import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {createGrowthMemoryServer} from '../apps/growth-memory/src/main.mjs';
const marker='SYNTHETIC_FAILURE_PATCH_662';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-failure-retraction-'));const stores=[];
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});stores.push(store);return {store,runtime:new GrowthRuntime({memoryStore:store,auditRoot:root})};};
 const f=open();f.runtime.ingest({eventId:'failed-source',taskId:'task',eventType:'execution.failed',source:{module:'CORE'},payload:{reasonCode:'LOCAL_FAILURE'},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{systemGenerated:true}});
 const lesson=f.runtime.failureBuilder.build(f.runtime.ingestor.all())[0];assert.ok(lesson);
 const retract=()=>f.store.saveHygieneDecision({decisionId:'delete',targetType:'memory_event',targetId:'failed-source',action:'delete',decidedAt:new Date().toISOString()});
 t.after(()=>{stores.forEach(s=>s.close());rmSync(root,{recursive:true,force:true});});return {...f,open,retract,id:lesson.failureId};}

test('raw review projection and preopened failure cache stop exposing withdrawn patch and reason',t=>{
 const f=fixture(t);assert.equal(f.runtime.reviewFailureGuardrail(f.id,{patch:{lesson:marker},reason:marker}).success,true);
 const observer=f.open();assert.ok(JSON.stringify(observer.runtime.failureBuilder.build(observer.runtime.ingestor.all())).includes(marker));
 f.retract();const reviews=f.store.allFailureGuardrailReviews();assert.equal(reviews[0].contentWithheld,true);assert.equal(JSON.stringify(reviews).includes(marker),false);
 assert.deepEqual(observer.runtime.failureBuilder.build(observer.runtime.ingestor.all()),[]);
 const status=observer.runtime.failureBuilder.trendStatus();assert.equal(status.withheldReviewCount,1);assert.equal(status.dashboard.status,'source_review_required');
 assert.equal(observer.runtime.failureBuilder.guardrailReviews.size,0);
 assert.equal(f.open().runtime.failureBuilder.guardrailReviews.size,0);
 assert.ok(f.store.db.prepare('SELECT review_json FROM failure_guardrail_reviews').get().review_json.includes(marker),'private retained DB is not erased');
});

test('same-generation withdrawal immediately before review write rejects patch and cache publication',t=>{
 const f=fixture(t),save=f.store.saveFailureGuardrailReview.bind(f.store);
 f.store.saveFailureGuardrailReview=(review,options)=>{f.retract();return save(review,options);};
 const result=f.runtime.reviewFailureGuardrail(f.id,{patch:{lesson:marker}});assert.equal(result.success,false);assert.equal(result.error.code,'F_MEMORY_SOURCE_CHANGED');
 assert.equal(f.store.allFailureGuardrailReviews().length,0);assert.equal(f.runtime.failureBuilder.guardrailReviews.size,0);
});

test('retracted failure cannot accept a new review, while current source can',t=>{
 const f=fixture(t);const result=f.runtime.reviewFailureGuardrail(f.id,{decision:'keep'});assert.equal(result.success,true);
 assert.deepEqual(f.store.allFailureGuardrailReviews()[0].evidenceEventIds,['failed-source']);f.retract();
 assert.equal(f.runtime.reviewFailureGuardrail(f.id,{patch:{lesson:marker}}).error.code,'F_MEMORY_SOURCE_RETRACTED');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM failure_guardrail_reviews').get().n,1);
});

test('old failure builder cannot reuse review cache across restored generation',t=>{
 const f=fixture(t),old=f.runtime.failureBuilder,backup=f.store.backup({backupId:'old'});
 f.store.restore({backupPath:backup.filePath});assert.throws(()=>old.trendStatus(),{code:'F_MEMORY_GENERATION_CONFLICT'});
});

test('actual F HTTP exposes source review required dashboard and409 for withdrawn review',async t=>{
 const f=fixture(t);f.runtime.reviewFailureGuardrail(f.id,{patch:{lesson:marker},reason:marker});f.retract();
 const server=createGrowthMemoryServer(f.runtime);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(`${base}/failures/${f.id}/guardrail`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({failureId:'body-must-not-override-route',patch:{lesson:marker}})});
 assert.equal(response.status,409);assert.equal(JSON.stringify(await response.json()).includes(marker),false);
 const dashboard=await (await fetch(`${base}/failures/recurrence-dashboard`)).json();assert.equal(dashboard.status,'source_review_required');assert.equal(dashboard.withheldReviewCount,1);
});
