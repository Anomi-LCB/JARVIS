import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';import {CoreFacade} from '../packages/core/src/core-facade.js';import {createCoreServer} from '../packages/core/src/main.mjs';import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
test('actual authenticated Core knowledge lookup binds owner and workspace and fences deleted sources',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-knowledge-http-'));const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 for(const [id,userId] of [['owner','local_user'],['other','other-user']])growth.ingest({eventId:id,taskId:id,eventType:'task.created',source:{module:'CORE',memoryScope:{userId,workspaceRoot:root,conversationId:null}},payload:{rawText:"'합성 계획'의 '선택'은 '로컬'이라고 기억해줘"},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 const core=new CoreFacade({workspaceRoot:root,memoryStore:growth});const server=createCoreServer(core,{adminToken:'synthetic-admin',adminTokens:[{token:'reader',scopes:['read_diagnostics']}]});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();core.cognition?.close();rmSync(root,{recursive:true,force:true});});const url=`http://127.0.0.1:${server.address().port}/memory/knowledge`,headers={authorization:'Bearer synthetic-admin'};
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{authorization:'Bearer reader'}})).status,403);
 assert.equal((await fetch(url+'?userId=other-user',{headers})).status,400);assert.equal((await fetch(url,{method:'POST',headers})).status,405);
 const response=await fetch(url,{headers});assert.equal(response.headers.get('cache-control'),'no-store');const result=await response.json();assert.deepEqual(result.items.map(x=>x.sourceEventId),['owner']);assert.equal(result.executionAuthority,false);
 const backup=store.backup({backupId:'before-concurrent-lookup'});
 growth.ingest({eventId:'after-backup',taskId:'after-backup',eventType:'task.created',source:{module:'CORE',memoryScope:{userId:'local_user',workspaceRoot:root,conversationId:null}},payload:{rawText:"'합성 계획'의 '추가 선택'은 '임시'라고 기억해줘"},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 const originalLookup=growth.personalKnowledge.bind(growth);
 growth.personalKnowledge=input=>{const stale=originalLookup(input);assert.equal(stale.length,2);assert.equal(growth.restoreStorage({backupPath:backup.filePath}).success,true);return stale;};
 const raced=await fetch(url,{headers});assert.equal(raced.status,503);const raceBody=await raced.json();assert.equal(raceBody.items,undefined);assert.equal(raceBody.error.code,'F_MEMORY_RESTORE_RELOAD_REQUIRED');
 growth.personalKnowledge=originalLookup;
 const restored=await fetch(url,{headers});assert.equal(restored.status,200);assert.deepEqual((await restored.json()).items.map(x=>x.sourceEventId),['owner']);
 growth.decideHygiene({targetId:'owner',action:'delete'});assert.deepEqual((await (await fetch(url,{headers})).json()).items,[]);
 growth.memoryRecoveryState={status:'restart_required'};
 const unavailable=await fetch(url,{headers});assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).items,undefined);
 growth.memoryRecoveryState=null;
 const lookup=growth.personalKnowledge.bind(growth);growth.personalKnowledge=()=>{throw new Error('PRIVATE_SYNTHETIC_STORAGE_DETAIL');};
 const failed=await fetch(url,{headers});assert.equal(failed.status,503);assert.equal(JSON.stringify(await failed.json()).includes('PRIVATE_SYNTHETIC_STORAGE_DETAIL'),false);
 growth.personalKnowledge=lookup;
 growth.ingest({eventId:'future-source',taskId:'future-source',eventType:'task.created',createdAt:'2199-01-01T00:00:00.000Z',source:{module:'CORE',memoryScope:{userId:'local_user',workspaceRoot:root,conversationId:null}},payload:{rawText:"'합성 계획'의 '선택'은 'FUTURE_PRIVATE_MARKER'라고 기억해줘"},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 const futureResult=await (await fetch(url,{headers})).json();assert.deepEqual(futureResult.items,[]);assert.equal(futureResult.diagnostics.excluded.futureObservationTime,1);assert.equal(JSON.stringify(futureResult).includes('FUTURE_PRIVATE_MARKER'),false);
});

