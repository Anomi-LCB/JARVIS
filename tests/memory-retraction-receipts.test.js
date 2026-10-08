import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { CognitiveRuntime } from '../packages/core/src/cognition/cognitive-runtime.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-retraction-receipts-'));let stores=[],cognitions=[];
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});const cognition=new CognitiveRuntime({storePath:join(root,'cognition.sqlite')});stores.push(store);cognitions.push(cognition);return {store,cognition,growth:new GrowthRuntime({memoryStore:store,auditRoot:root})};};
 const f=open(),scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null},payload={taskId:'synthetic-task',sourceEventId:'synthetic-source',scope};
 f.growth.ingest({eventId:payload.sourceEventId,taskId:payload.taskId,eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:{rawText:'PRIVATE_SYNTHETIC_BODY'},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
 f.store.saveHygieneDecision({decisionId:'delete',targetType:'memory_event',targetId:payload.sourceEventId,action:'delete',decidedAt:new Date().toISOString()});
 t.after(()=>{cognitions.forEach(c=>c.close());stores.forEach(s=>s.close());rmSync(root,{recursive:true,force:true});});
 const attach=(runtime,cognition,handler)=>runtime.setSourceRetractionHandler(handler??(p=>cognition.revokeSource(p)),{receiverId:cognition.identity,verify:p=>cognition.sourceRetractionStatus(p)});
 return {...f,open,attach,scope,payload,root};
}

test('actual receiver state and hash-only receipt survive reopening both SQLite stores without repeat mutation',t=>{
 const f=fixture(t);let calls=0;f.attach(f.growth,f.cognition,p=>{calls++;return f.cognition.revokeSource(p);});assert.equal(calls,1);
 assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,true);
 const row=f.store.db.prepare('SELECT * FROM source_retraction_deliveries').get();assert.equal(row.state,'acknowledged');assert.equal(row.attempts,1);
 assert.equal(JSON.stringify(row).includes('synthetic'),false);assert.equal(JSON.stringify(row).includes(f.root),false);
 const reopened=f.open();f.attach(reopened.growth,reopened.cognition,p=>{calls++;return reopened.cognition.revokeSource(p);});assert.equal(calls,1);
 assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS n FROM source_retraction_deliveries').get().n,1);
});

test('old receipt and process cache cannot hide receiver state lost after restoration',t=>{
 const f=fixture(t);let calls=0;f.attach(f.growth,f.cognition,p=>{calls++;return f.cognition.revokeSource(p);});
 f.cognition.db.prepare("DELETE FROM cognitive_meta WHERE key LIKE 'source-retracted:%'").run();
 assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,false);
 f.growth.synchronizeSourceRetractions();assert.equal(calls,2);assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,true);
 assert.equal(f.store.db.prepare('SELECT attempts FROM source_retraction_deliveries').get().attempts,2);
});

test('receiver tombstone alone is insufficient when derived rows remain; reconciliation clears rows',t=>{
 const f=fixture(t);f.attach(f.growth,f.cognition);
 const scopeRef=f.cognition.scopeFor({userId:f.scope.userId,metadata:{conversationId:null}},f.root),taskRef=f.cognition.taskKey(f.payload.taskId);
 f.cognition.db.prepare('INSERT INTO cognitive_goals VALUES(?,?,?,?,?,?,?,?)').run(taskRef,scopeRef,'synthetic.tool','PLANNING',1,1,'2026-10-03','2026-10-03');
 assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,false);
 f.growth.synchronizeSourceRetractions();assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,true);
 assert.equal(f.cognition.db.prepare('SELECT COUNT(*) AS n FROM cognitive_goals').get().n,0);
});

test('lost acknowledgment journal write is reconciled without executing receiver again',t=>{
 const f=fixture(t);const save=f.store.recordSourceRetractionDelivery.bind(f.store);let calls=0;
 f.store.recordSourceRetractionDelivery=input=>{if(input.state==='acknowledged')throw new Error('PRIVATE_JOURNAL_ERROR');return save(input);};
 const result=f.attach(f.growth,f.cognition,p=>{calls++;return f.cognition.revokeSource(p);});assert.equal(result.deliveries[0].propagated,false);
 assert.equal(f.store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state,'attempted');
 f.store.recordSourceRetractionDelivery=save;f.growth.synchronizeSourceRetractions();assert.equal(calls,1);
 assert.equal(f.store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state,'acknowledged');
});

test('journal outage prevents untracked dispatch and generation fence rejects stale acknowledgment',t=>{
 const f=fixture(t),save=f.store.recordSourceRetractionDelivery.bind(f.store);let calls=0;
 f.store.recordSourceRetractionDelivery=()=>{throw new Error('storage down');};
 f.attach(f.growth,f.cognition,()=>{calls++;return {revoked:true};});assert.equal(calls,0);
 f.store.recordSourceRetractionDelivery=save;
 const generation=f.store.restoreGeneration(),backup=f.store.backup({backupId:'before-receipt'});
 const key={deliveryKey:'synthetic-key',receiverId:'synthetic-receiver',expectedGeneration:generation};
 save({...key,state:'attempted'});f.store.restore({backupPath:backup.filePath});
 assert.throws(()=>save({...key,state:'acknowledged'}),error=>error.code==='F_MEMORY_GENERATION_CONFLICT');
 assert.equal(f.store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state,'attempted');
});


test('actual A-G composition attaches stable receiver identity and persisted reconciliation',t=>{
 const f=fixture(t);
 const runtime=createAgRuntime({memoryStore:f.store,cognitionRuntime:f.cognition,auditRoot:f.root,
   allowedRoots:[f.root],env:{JARVIS_TEST_MODE:'1'},taskEnv:{JARVIS_TEST_MODE:'1'}});
 assert.equal(runtime.growthRuntime.sourceRetractionReceiverId,f.cognition.identity);
 assert.equal(f.store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state,'acknowledged');
 assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,true);
});

test('claimed success without actual receiver state never becomes a durable acknowledgment',t=>{
 const f=fixture(t);
 const result=f.attach(f.growth,f.cognition,()=>({revoked:true}));
 assert.equal(result.deliveries[0].propagated,false);
 assert.equal(f.store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state,'attempted');
 assert.equal(f.growth.deliveredSourceRetractions.size,0);
});


test('separate fresh Node process reconciles stored receiver state without inherited callback cache',t=>{
 const f=fixture(t);f.attach(f.growth,f.cognition);
 const source=`import {SqliteMemoryStore} from './apps/growth-memory/src/db/sqlite-store.js';
 import {GrowthRuntime} from './apps/growth-memory/src/growth-runtime.js';
 import {CognitiveRuntime} from './packages/core/src/cognition/cognitive-runtime.js';
 const root=${JSON.stringify(f.root)};
 const store=new SqliteMemoryStore({dbPath:root+'/f.sqlite',reviewDir:root+'/reviews',backupDir:root+'/backups'});
 const cognition=new CognitiveRuntime({storePath:root+'/cognition.sqlite'});
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});let calls=0;
 growth.setSourceRetractionHandler(p=>{calls++;return cognition.revokeSource(p);},{receiverId:cognition.identity,verify:p=>cognition.sourceRetractionStatus(p)});
 console.log(JSON.stringify({calls,revoked:cognition.sourceRetractionStatus(${JSON.stringify(f.payload)}).revoked,
 receipt:store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state}));
 cognition.close();store.close();`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:10000,windowsHide:true}));
 assert.deepEqual(result,{calls:0,revoked:true,receipt:'acknowledged'});
});

for(const table of ['cognitive_episodes','cognitive_decisions','cognitive_decision_outcomes'])test(`withdrawal reconciles stale ${table} rows without erasing another scope`,t=>{
 const f=fixture(t);f.attach(f.growth,f.cognition);
 const scope=f.cognition.scopeFor({userId:f.scope.userId,metadata:{conversationId:null}},f.root),task=f.cognition.taskKey(f.payload.taskId);
 const insert=(id,scopeRef)=>{
  if(table==='cognitive_episodes')f.cognition.db.prepare('INSERT INTO cognitive_episodes VALUES(?,?,?,?,?,?,?,?,?)').run(id,task,scopeRef,'synthetic.tool','synthetic.verification',1,1,0,'2026-10-03');
  else if(table==='cognitive_decisions')f.cognition.db.prepare('INSERT INTO cognitive_decisions VALUES(?,?,?,?,?)').run(id,scopeRef,task,'synthetic.plan','{}');
  else f.cognition.db.prepare('INSERT INTO cognitive_decision_outcomes VALUES(?,?,?,?,?,?)').run(id,scopeRef,task,'synthetic.plan','passed','{}');
 };
 insert('stale-target',scope);insert('unrelated','different-scope');
 assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,false);
 f.growth.synchronizeSourceRetractions();
 assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,true);
 assert.equal(f.cognition.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope=?`).get(scope).n,0);
 assert.equal(f.cognition.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope=?`).get('different-scope').n,1);
});

for(const boundary of ['before','after'])test(`process exit ${boundary} receiver commit recovers with the required mutation count`,t=>{
 const f=fixture(t);
 const program=crash=>`import {SqliteMemoryStore} from './apps/growth-memory/src/db/sqlite-store.js';
 import {GrowthRuntime} from './apps/growth-memory/src/growth-runtime.js';
 import {CognitiveRuntime} from './packages/core/src/cognition/cognitive-runtime.js';
 const root=${JSON.stringify(f.root)};
 const store=new SqliteMemoryStore({dbPath:root+'/f.sqlite',reviewDir:root+'/reviews',backupDir:root+'/backups'});
 const cognition=new CognitiveRuntime({storePath:root+'/cognition.sqlite'});
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});let calls=0;
 growth.setSourceRetractionHandler(p=>{calls++;${crash&&boundary==='before'?'process.exit(17);':''}const result=cognition.revokeSource(p);${crash&&boundary==='after'?'process.exit(17);':''}return result;},
 {receiverId:cognition.identity,verify:p=>cognition.sourceRetractionStatus(p)});
 console.log(JSON.stringify({calls,revoked:cognition.sourceRetractionStatus(${JSON.stringify(f.payload)}).revoked,
 receipt:store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state}));
 cognition.close();store.close();`;
 const crashed=spawnSync(process.execPath,['--input-type=module','--eval',program(true)],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(crashed.error,undefined);assert.equal(crashed.status,17);
 assert.equal(f.store.db.prepare('SELECT state FROM source_retraction_deliveries').get().state,'attempted');
 assert.equal(f.cognition.sourceRetractionStatus(f.payload).revoked,boundary==='after');
 const recovered=JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',program(false)],{encoding:'utf8',timeout:10000,windowsHide:true}));
 assert.deepEqual(recovered,{calls:boundary==='after'?0:1,revoked:true,receipt:'acknowledged'});
 const repeated=JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',program(false)],{encoding:'utf8',timeout:10000,windowsHide:true}));
 assert.deepEqual(repeated,{calls:0,revoked:true,receipt:'acknowledged'});
 assert.equal(f.growth.query('PRIVATE_SYNTHETIC_BODY',{scope:f.scope}).length,0);
});
