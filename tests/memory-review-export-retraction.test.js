import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync,writeFileSync,linkSync,unlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-review-export-')),stores=[];
 const opts={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')};
 const open=()=>{const store=new SqliteMemoryStore(opts);stores.push(store);return store;};const store=open();
 t.after(()=>{stores.forEach(s=>s.close());rmSync(root,{recursive:true,force:true});});
 const save=(id='original')=>store.saveReview({reviewId:id,generatedAt:'2026-10-06T00:00:00.000Z',period:'synthetic',summary:'PRIVATE_SYNTHETIC_EXPORT'});
 const withdraw=()=>store.saveHygieneDecision({decisionId:'withdrawal',targetType:'memory_event',targetId:'source',action:'delete',decidedAt:'2026-10-06T00:00:00.000Z'});
 return {root,store,opts,open,save,withdraw};}

test('source withdrawal scrubs all owned exported report bodies immediately while retaining private SQL history',t=>{
 const f=fixture(t),a=f.save(),b=f.save('other');f.withdraw();
 for(const result of [a,b]){const exported=JSON.parse(readFileSync(result.filePath,'utf8'));
  assert.equal(exported.contentWithheld,true);assert.equal(JSON.stringify(exported).includes('PRIVATE_SYNTHETIC_EXPORT'),false);}
 assert.equal(f.store.reviewExportStatus.status,'ready');
 assert.equal(f.store.db.prepare('SELECT review_json FROM growth_reviews LIMIT 1').get().review_json.includes('PRIVATE_SYNTHETIC_EXPORT'),true);
});

test('export write failure is pending after committed deletion and reopening retries without resurrecting content',t=>{
 const f=fixture(t),a=f.save(),write=f.store.writeReviewExport.bind(f.store);
 f.store.writeReviewExport=()=>{throw new Error('synthetic file lock');};f.withdraw();
 assert.equal(f.store.hasSourceRetraction('source'),true);assert.equal(f.store.reviewExportStatus.status,'requires_retry');
 assert.equal(f.store.latestReview().contentWithheld,true);
 f.store.writeReviewExport=write;const reopened=f.open();
 assert.equal(reopened.reviewExportStatus.status,'ready');assert.equal(readFileSync(a.filePath,'utf8').includes('PRIVATE_SYNTHETIC_EXPORT'),false);
});

test('SQL report save failure leaves no orphan plaintext and export failures do not claim a file exists',t=>{
 const f=fixture(t);
 f.store.db.exec("CREATE TRIGGER block_review BEFORE INSERT ON growth_reviews BEGIN SELECT RAISE(ABORT,'synthetic failure');END;");
 assert.throws(()=>f.save('blocked'));assert.equal(existsSync(join(f.opts.reviewDir,'blocked.json')),false);
 f.store.db.exec('DROP TRIGGER block_review');f.store.writeReviewExport=()=>{throw new Error('synthetic lock');};
 const pending=f.save('pending');assert.equal(pending.exportPending,true);assert.equal(pending.filePath,undefined);
 assert.equal(f.store.latestReview().filePath,undefined);
});

test('unsafe stored export targets and hardlinks never modify unrelated files',t=>{
 const f=fixture(t),a=f.save(),external=join(f.root,'external.json');writeFileSync(external,'UNRELATED_SYNTHETIC_FILE');
 f.store.db.prepare('UPDATE growth_reviews SET file_path=?').run(external);f.withdraw();
 assert.equal(readFileSync(external,'utf8'),'UNRELATED_SYNTHETIC_FILE');assert.equal(f.store.reviewExportStatus.pending,1);
 f.store.db.prepare('UPDATE growth_reviews SET file_path=?').run(a.filePath);unlinkSync(a.filePath);linkSync(external,a.filePath);
 f.store.reconcileReviewExports();assert.equal(readFileSync(external,'utf8'),'UNRELATED_SYNTHETIC_FILE');assert.equal(f.store.reviewExportStatus.pending,1);
 for(const reviewId of ['../outside','a/b','..',''])assert.throws(()=>f.save(reviewId),{code:'F_REVIEW_ID_INVALID'});
});

test('pre-withdrawal backup remains byte-identical but restoring its rows keeps exported contents scrubbed',t=>{
 const f=fixture(t),a=f.save(),backup=f.store.backup({backupId:'old'}),bytes=readFileSync(backup.filePath);
 f.withdraw();assert.equal(f.store.restore({backupPath:backup.filePath}).success,true);
 assert.deepEqual(readFileSync(backup.filePath),bytes);assert.equal(readFileSync(a.filePath,'utf8').includes('PRIVATE_SYNTHETIC_EXPORT'),false);
});

test('actual F preference review export follows correction and reports locked-file retry independently of applied deletion',t=>{
 const f=fixture(t),runtime=new GrowthRuntime({memoryStore:f.store,auditRoot:f.root});
 const scope={userId:'synthetic-owner',workspaceRoot:f.root,conversationId:null};
 for(let i=0;i<3;i++)runtime.ingest({eventId:'source-'+i,eventType:'approval.edited',taskId:'source-'+i,
  source:{memoryScope:scope},payload:{editRequest:'회의자료를 표로 정리해줘'},learningFlags:{canBeUsedForPreference:true},trustBoundary:{userProvided:true}});
 const candidate=runtime.query('회의자료',{scope}).find(item=>item.hypothesisId);
 const confirmed=runtime.decidePreference({hypothesisId:candidate.hypothesisId});assert.equal(confirmed.success,true);
 let pref=f.store.getConfirmedPreference(confirmed.item.preferenceId);
 assert.equal(runtime.updatePreference(pref.preferenceId,{expectedRevision:pref.revision,patch:{statement:'PRIVATE_SYNTHETIC_EXPORT'}}).success,true);
 const review=runtime.latestReview();assert.ok(readFileSync(review.filePath,'utf8').includes('PRIVATE_SYNTHETIC_EXPORT'));
 pref=f.store.getConfirmedPreference(pref.preferenceId);
 assert.equal(runtime.updatePreference(pref.preferenceId,{expectedRevision:pref.revision,patch:{statement:'새 합성 선호'}}).success,true);
 assert.equal(readFileSync(review.filePath,'utf8').includes('PRIVATE_SYNTHETIC_EXPORT'),false);
 runtime.latestReview();f.store.writeReviewExport=()=>{throw new Error('synthetic locked export');};
 const result=runtime.decideHygiene({targetId:'source-0',action:'delete'});
 assert.equal(result.applied,true);assert.equal(result.persisted,true);
 assert.equal(result.followUps.reportExport.status,'requires_retry');
 assert.equal(f.store.storageStatus().reviewExports.status,'requires_retry');
});
