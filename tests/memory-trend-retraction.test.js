import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {createGrowthMemoryServer} from '../apps/growth-memory/src/main.mjs';
const marker='SYNTHETIC_TREND_PRIVATE_538';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-trend-retraction-'));let stores=[];
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});stores.push(store);return {store,runtime:new GrowthRuntime({memoryStore:store,auditRoot:root})};};
 const f=open();f.runtime.ingest({eventId:'source',taskId:'task',eventType:'task.created',source:{module:'CORE'},payload:{rawText:'합성 연구'},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
 const retract=()=>f.store.saveHygieneDecision({decisionId:'delete',targetType:'memory_event',targetId:'source',action:'delete',decidedAt:new Date().toISOString()});
 t.after(()=>{stores.forEach(s=>s.close());rmSync(root,{recursive:true,force:true});});return {...f,open,retract};}

test('archive and latest trend withhold stale bodies and metadata after withdrawal; current safe snapshot remains visible',t=>{
 const f=fixture(t);f.runtime.persistTrendSnapshot('genome',{snapshotId:'old',generatedAt:'2026-10-03T00:00:00Z',text:marker},{reason:marker});
 assert.ok(JSON.stringify(f.runtime.growthTrendArchive()).includes(marker));f.retract();
 assert.equal(f.store.latestTrendSnapshot({trendType:'genome'}).contentWithheld,true);
 const archive=f.runtime.growthTrendArchive();assert.equal(archive.withheldCount,1);assert.equal(archive.availableCount,0);assert.equal(archive.latestByType.genome,undefined);
 assert.equal(JSON.stringify(archive).includes(marker),false);
 f.runtime.persistTrendSnapshot('genome',{snapshotId:'fresh',generatedAt:'2026-10-03T01:00:00Z',text:'fresh'});
 assert.equal(f.runtime.growthTrendArchive().availableCount,1);assert.equal(f.store.latestTrendSnapshot({trendType:'genome'}).snapshot.text,'fresh');
 assert.equal(JSON.stringify(f.open().runtime.genomeTrendTracker.snapshots).includes(marker),false);
});

test('skill private history remains internally restorable but never returns through public archive even with fresh digest',t=>{
 const f=fixture(t);const draft={distilledSkillId:'draft',title:marker,evidenceEventIds:['source'],suggestedSteps:[marker],safetyConstraints:['requires_user_review','requires_policy_check'],styleHints:[],confidence:0.8};
 const result=f.runtime.skillDraftRegistry.review({draftId:'draft',drafts:[draft],reason:marker});assert.equal(result.success,true);
 f.runtime.persistSkillRegistrySnapshot();f.retract();f.runtime.synchronizeSourceRetractions();
 assert.equal(JSON.stringify(f.store.allTrendSnapshots()).includes(marker),false);
 assert.equal(JSON.stringify(f.store.allTrendSnapshots({includeRetractedContent:true})).includes(marker),true);
 const reopened=f.open().runtime;
 assert.equal(reopened.skillDraftRegistry.registry.size,1);assert.equal(JSON.stringify(reopened.skillRegistryStatus()).includes(marker),false);
 assert.equal(reopened.growthTrendArchive({trendType:'skill_registry'}).availableCount,0);
});

test('SQL write fence rejects same-generation withdrawal occurring after trend calculation',t=>{
 const f=fixture(t),digest=f.store.sourceRetractionDigest(),generation=f.store.restoreGeneration();f.retract();
 assert.throws(()=>f.store.saveTrendSnapshot({trendType:'genome',snapshotId:'stale',snapshot:{text:marker}},{expectedGeneration:generation,expectedSourceRetractionDigest:digest}),{code:'F_MEMORY_SOURCE_CHANGED'});
 assert.equal(f.store.allTrendSnapshots().length,0);
});

test('actual genome calculation carries start digest through write and fails closed on late withdrawal',t=>{
 const f=fixture(t),save=f.store.saveTrendSnapshot.bind(f.store);let once=true;
 f.store.saveTrendSnapshot=(input,options)=>{if(once){once=false;f.retract();}return save(input,options);};
 assert.throws(()=>f.runtime.buildGenomeSnapshot(),{code:'F_MEMORY_SOURCE_CHANGED'});
 assert.equal(f.store.allTrendSnapshots().length,0);
});

test('actual F HTTP archive cannot expose raw private history through query flags',async t=>{
 const f=fixture(t);f.runtime.persistTrendSnapshot('skill_registry',{snapshotId:'private',text:marker},{note:marker});f.retract();
 const server=createGrowthMemoryServer(f.runtime);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/trends/archive?trendType=skill_registry&includeRetractedContent=true`);
 assert.equal(response.status,200);const value=await response.json();assert.equal(value.withheldCount,1);assert.equal(JSON.stringify(value).includes(marker),false);
});


test('live cached trend histories are discarded after source change before reuse',t=>{
 const f=fixture(t);
 f.runtime.genomeTrendTracker.snapshots.push({snapshotId:'cached',text:marker});
 f.runtime.maturityScoreEngine.trendHistory.push({snapshotId:'cached',text:marker});
 f.retract();const result=f.runtime.maturityTrend();
 assert.equal(JSON.stringify(result).includes(marker),false);
 assert.equal(f.runtime.genomeTrendTracker.snapshots.length,0);
 const rebuilt=f.runtime.buildGenomeSnapshot();assert.equal(rebuilt.events.find(e=>e.eventId==='source').learningFlags.doNotRemember,true);
});
