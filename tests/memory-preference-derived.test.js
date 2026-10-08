import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-preference-derived-'));const stores=[];
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});stores.push(store);return {store,runtime:new GrowthRuntime({memoryStore:store,auditRoot:root})};};
 const f=open(),scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
 for(let i=0;i<3;i++)f.runtime.ingest({eventId:`source-${i}`,taskId:`task-${i}`,eventType:'approval.edited',source:{module:'CORE',memoryScope:scope},payload:{editRequest:'회의자료를 표로 정리해줘'},learningFlags:{canBeUsedForPreference:true},trustBoundary:{userProvided:true}});
 const candidate=f.runtime.query('회의자료',{scope}).find(item=>item.hypothesisId);assert.ok(candidate);
 const confirmed=f.runtime.decidePreference({hypothesisId:candidate.hypothesisId});assert.equal(confirmed.success,true);
 const id=confirmed.item.preferenceId;
 const correct=()=>{const current=f.store.getConfirmedPreference(id);const result=f.runtime.updatePreference(id,{expectedRevision:current.revision,patch:{statement:'회의자료는 상세한 문장으로 작성한다.'}});assert.equal(result.success,true);};
 t.after(()=>{stores.forEach(s=>s.close());rmSync(root,{recursive:true,force:true});});return {...f,open,id,correct,root};}

test('saved report and trend become withheld after preference correction without any source withdrawal',t=>{
 const f=fixture(t);f.runtime.latestReview();assert.equal(f.store.latestReview().contentWithheld,undefined);
 f.correct();assert.equal(f.store.allSourceRetractions().length,0);
 assert.equal(f.store.latestReview().reasonCode,'F_REVIEW_PREFERENCE_CHANGED');
 const archive=f.runtime.growthTrendArchive({trendType:'genome'});assert.equal(archive.availableCount,0);assert.ok(archive.withheldCount>0);
 assert.ok(archive.items.every(item=>item.reasonCode==='F_TREND_PREFERENCE_CHANGED'));
 const fresh=f.runtime.latestReview();assert.equal(fresh.confirmedPreferences.find(item=>item.preferenceId===f.id).statement,'회의자료는 상세한 문장으로 작성한다.');
 assert.equal(f.store.latestReview().contentWithheld,undefined);
});

test('correction immediately before final report save rejects stale result and file creation then rebuilds',t=>{
 const f=fixture(t),save=f.store.saveReview.bind(f.store);let once=true,path;
 f.store.saveReview=(review,options)=>{if(once){once=false;path=join(f.root,'reviews',`${review.reviewId}.json`);f.correct();}return save(review,options);};
 const result=f.runtime.latestReview();assert.equal(result.contentWithheld,true);assert.equal(result.error.code,'F_MEMORY_PREFERENCE_CHANGED');
 assert.equal(existsSync(path),false);assert.equal(f.store.latestReview(),null);
 assert.equal(f.runtime.latestReview().confirmedPreferences.find(item=>item.preferenceId===f.id).statement,'회의자료는 상세한 문장으로 작성한다.');
});

test('direct SQLite write fence sees correction from an independent connection in same generation',t=>{
 const f=fixture(t),digest=f.store.preferenceStateDigest(),other=f.open();
 const current=other.store.getConfirmedPreference(f.id);other.store.saveConfirmedPreference({...current,statement:'합성 독립 연결 정정',revision:current.revision+1},{expectedRevision:current.revision});
 assert.throws(()=>f.store.saveTrendSnapshot({trendType:'genome',snapshotId:'stale',snapshot:{text:'old'}},{expectedGeneration:f.store.restoreGeneration(),expectedPreferenceStateDigest:digest}),{code:'F_MEMORY_PREFERENCE_CHANGED'});
 assert.equal(f.store.allTrendSnapshots().length,0);
});

test('actual genome calculation preserves initial preference digest through SQL write',t=>{
 const f=fixture(t),save=f.store.saveTrendSnapshot.bind(f.store);let once=true;
 f.store.saveTrendSnapshot=(input,options)=>{if(once){once=false;f.correct();}return save(input,options);};
 assert.throws(()=>f.runtime.buildGenomeSnapshot(),{code:'F_MEMORY_PREFERENCE_CHANGED'});
 assert.equal(f.store.allTrendSnapshots().length,0);
});

test('correction invalidates live histories and stale persisted histories are not rehydrated',t=>{
 const f=fixture(t);f.runtime.buildGenomeSnapshot();f.runtime.maturityScore();const before=f.runtime.genomeTrendTracker.snapshots.length;assert.ok(before>0);
 f.correct();assert.equal(f.runtime.maturityTrend().history.length,0);assert.equal(f.runtime.genomeTrendTracker.snapshots.length,0);
 const reopened=f.open().runtime;assert.equal(reopened.genomeTrendTracker.snapshots.length,0);assert.equal(reopened.maturityScoreEngine.trendHistory.length,0);
});

test('skill raw revision history remains private after preference correction even with a current digest',t=>{
 const f=fixture(t);f.correct();f.runtime.persistTrendSnapshot('skill_registry',{snapshotId:'private',history:['old synthetic statement']});
 assert.equal(f.store.latestTrendSnapshot({trendType:'skill_registry'}).reasonCode,'F_SKILL_SNAPSHOT_PRIVATE_RETAINED');
 assert.equal(f.store.latestTrendSnapshot({trendType:'skill_registry',includeRetractedContent:true}).snapshot.history[0],'old synthetic statement');
});


test('runtime restore copies derived revision state so valid restored history is preserved',t=>{
 const f=fixture(t);f.runtime.buildGenomeSnapshot();const backup=f.store.backup({backupId:'valid-history'});
 f.correct();f.runtime.maturityTrend();assert.equal(f.runtime.genomeTrendTracker.snapshots.length,0);
 assert.equal(f.runtime.restoreStorage({backupPath:backup.filePath}).success,true);
 const restoredCount=f.runtime.genomeTrendTracker.snapshots.length;assert.ok(restoredCount>0);
 f.runtime.buildGenomeSnapshot();assert.ok(f.runtime.genomeTrendTracker.snapshots.length>restoredCount);
 assert.equal(f.runtime.derivedTrendPreferenceDigest,f.store.preferenceStateDigest());
});
