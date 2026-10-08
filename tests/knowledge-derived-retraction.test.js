import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-knowledge-derived-')),clock=()=>new Date('2026-10-06T00:00:00.000Z');
 const opts={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock};
 const stores=[],open=()=>{const store=new SqliteMemoryStore(opts);stores.push(store);return {store,runtime:new GrowthRuntime({memoryStore:store,auditRoot:root,clock})};};
 const f=open(),scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:'knowledge-derived'};
 t.after(()=>{for(const store of stores)store.close();rmSync(root,{recursive:true,force:true});});
 f.runtime.ingest({eventId:'old',eventType:'feedback.good',taskId:'old',createdAt:'2026-10-01T00:00:00.000Z',source:{memoryScope:scope},
  payload:{knowledge:{kind:'fact',subject:'프로젝트:합성 연구',predicate:'원본 위치',value:'PRIVATE_SYNTHETIC_RETIRED_VALUE'}},
  trustBoundary:{userProvided:true,externalContent:false,systemGenerated:false}});
 const correct=(writer=f.store)=>{
  const old=f.runtime.ingestor.events.get('old');
  writer.saveEvent({...old,eventId:'new',fingerprint:'synthetic-new',createdAt:'2026-10-02T00:00:00.000Z',
   payload:{knowledge:{...old.payload.knowledge,value:'자료:정정된 원본',supersedesEventId:'old'}}},
   {expectedGeneration:writer.restoreGeneration(),expectedKnowledgeSource:{eventId:'old',observedAt:old.createdAt}});
 };
 return {...f,scope,correct,open};
}

test('knowledge CAS correction invalidates persisted derived reviews and trend metadata without deleting unrelated sources',t=>{
 const f=fixture(t),source=f.store.sourceRetractionDigest();
 f.store.saveReview({reviewId:'derived-old',generatedAt:'2026-10-03T00:00:00.000Z',period:'synthetic',summary:'PRIVATE_SYNTHETIC_RETIRED_VALUE'});
 f.store.saveTrendSnapshot({trendType:'genome',snapshotId:'old',snapshot:{text:'PRIVATE_SYNTHETIC_RETIRED_VALUE'},metadata:{text:'PRIVATE_SYNTHETIC_RETIRED_VALUE'}});
 f.runtime.buildGenomeSnapshot();assert.ok(f.runtime.genomeTrendTracker.snapshots.length);
 f.correct(f.open().store);
 assert.notEqual(f.store.sourceRetractionDigest(),source,'retirement must change source eligibility digest');
 assert.equal(f.store.allSourceRetractions().length,0,'correction must not falsely delete whole task or cognition');
 assert.equal(f.store.latestReview().contentWithheld,true);
 assert.equal(JSON.stringify(f.store.latestReview()).includes('PRIVATE_SYNTHETIC_RETIRED_VALUE'),false);
 assert.equal(f.store.latestTrendSnapshot({trendType:'genome'}).contentWithheld,true);
 assert.equal(JSON.stringify(f.store.allTrendSnapshots()).includes('PRIVATE_SYNTHETIC_RETIRED_VALUE'),false);
 f.runtime.refreshDerivedTrendSources();assert.equal(f.runtime.genomeTrendTracker.snapshots.length,0);
 const reopened=f.open().runtime;assert.equal(reopened.genomeTrendTracker.snapshots.length,0);
 assert.equal(reopened.personalKnowledge({scope:f.scope}).find(item=>item.status==='active').value,'자료:정정된 원본');
});

test('knowledge correction immediately before final report SQL write rejects stale publication',t=>{
 const f=fixture(t),save=f.store.saveReview.bind(f.store);let once=true;
 f.store.saveReview=(review,options)=>{if(once){once=false;f.correct(f.open().store);}return save(review,options);};
 const result=f.runtime.latestReview();assert.equal(result.contentWithheld,true);
 assert.equal(result.error.code,'F_MEMORY_SOURCE_CHANGED');assert.equal(f.store.latestReview(),null);
 const fresh=f.runtime.latestReview();assert.equal(fresh.contentWithheld,undefined);
 assert.equal(f.store.latestReview().contentWithheld,undefined);
});

test('pre-correction backup cannot restore retired summary into normal recall',t=>{
 const f=fixture(t);
 f.store.saveReview({reviewId:'derived-old',generatedAt:'2026-10-03T00:00:00.000Z',period:'synthetic',summary:'PRIVATE_SYNTHETIC_RETIRED_VALUE'});
 const backup=f.store.backup({backupId:'synthetic-pre-correction'});f.correct();
 assert.equal(f.store.restore({backupPath:backup.filePath}).success,true);
 assert.equal(f.store.latestReview().contentWithheld,true);
 assert.equal(JSON.stringify(f.store.latestReview()).includes('PRIVATE_SYNTHETIC_RETIRED_VALUE'),false);
 const reopened=f.open().runtime;assert.equal(reopened.personalKnowledge({scope:f.scope}).some(item=>item.status==='active'&&item.sourceEventId==='old'),false);
});
