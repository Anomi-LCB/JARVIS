import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import assert from 'node:assert/strict';import {performance} from 'node:perf_hooks';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
const output=process.argv[2];if(!output)throw new Error('Output path required');
const root=mkdtempSync(join(tmpdir(),'jarvis-scope-benchmark-'));
const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
try{
 const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:'selected'};
 const event=(id,sourceScope,value)=>({eventId:id,taskId:id,eventType:'task.created',createdAt:'2026-02-20T00:00:00.000Z',fingerprint:id,
  source:{module:'CORE',memoryScope:sourceScope},payload:{rawText:'합성 기억',knowledge:{kind:'fact',subject:'합성 프로젝트',predicate:id,value}},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 store.transaction(()=>{for(let i=0;i<10000;i++)store.saveEvent(event('noise-'+i,{...scope,conversationId:'other'},'PRIVATE_SYNTHETIC_OTHER_SCOPE'));store.saveEvent(event('target',scope,'선택한 값'));});
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});const times=[];
 for(let i=0;i<30;i++){
  const start=performance.now(),items=growth.personalKnowledge({scope});times.push(performance.now()-start);
  assert.deepEqual(items.map(x=>[x.sourceEventId,x.value,x.status,x.executionAuthority]),[['target','선택한 값','active',false]]);
 }
 const loaded=store.knowledgeSnapshot({scope}).events.length;
 times.sort((a,b)=>a-b);
 writeFileSync(output,JSON.stringify({observedAt:new Date().toISOString(),noiseEvents:10000,selectedEvents:1,iterations:30,
  returnedMatches:30,snapshotRowsLoaded:loaded,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],paidCalls:0,operatingCost:'unmeasured'},null,2),{flag:'wx'});
}finally{store.close();rmSync(root,{recursive:true,force:true});}
