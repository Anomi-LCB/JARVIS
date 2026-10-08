import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {createLocalOllamaEmbeddingProvider} from '../apps/growth-memory/src/personal-memory-search.js';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-search-')),clock=()=>new Date('2026-10-06T00:00:00.000Z');
 const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock});
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock});
 const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:'search'};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const seed=(id,patch={},other=scope)=>growth.ingest({eventId:id,eventType:'feedback.good',taskId:id,
  createdAt:'2026-10-01T00:00:00.000Z',source:{memoryScope:other},
  payload:{knowledge:{kind:'fact',subject:'프로젝트:합성 연구',predicate:id,value:'자료:원문',...patch}},
  trustBoundary:{userProvided:true,externalContent:false,systemGenerated:false}});
 return {growth,scope,seed,store,root,clock};
}

test('real SQLite F projection shares scope, expiry, timestamps and source IDs across bounded search modes',async t=>{
 const {growth,scope,seed}=setup(t);
 assert.equal(seed('a').success,true);seed('b',{value:'자료:사전'});seed('expired',{validUntil:'2026-10-02T00:00:00.000Z'});
 seed('other',{value:'PRIVATE_OTHER'},{...scope,conversationId:'other'});
 const keyword=await growth.searchPersonalKnowledge({scope,query:'원문'});
 assert.deepEqual(keyword.items.map(x=>x.sourceEventId),['a']);
 const time=await growth.searchPersonalKnowledge({scope,mode:'time',from:'2026-10-01T00:00:00.000Z',to:'2026-10-01T00:00:00.000Z',limit:1});
 assert.equal(time.items[0].sourceEventId,'a');assert.equal(time.truncated,true);
 const graph=await growth.searchPersonalKnowledge({scope,mode:'relationship',entity:'프로젝트:합성 연구'});
 assert.deepEqual(graph.items.map(x=>x.sourceEventId),['a','b']);
 const blocked=await growth.searchPersonalKnowledge({scope,mode:'semantic',query:'근거 조사'});
 assert.equal(blocked.status,'blocked');assert.equal(blocked.metrics.cost.amount,null);
 let embedded;
 const semantic=await growth.searchPersonalKnowledge({scope,mode:'semantic',query:'근거 조사',embeddingProvider:{embed:async input=>{embedded=input;return {vectors:[[1,0],[1,0],[0,1]]};}}});
 assert.equal(semantic.items[0].sourceEventId,'a');assert.equal(embedded.length,3);
 assert.equal(JSON.stringify(embedded).includes('PRIVATE_OTHER'),false);
 assert.equal(semantic.items[0].executionAuthority,false);
 await assert.rejects(growth.searchPersonalKnowledge({query:'원문'}),{code:'F_MEMORY_SCOPE_REQUIRED'});
 for(const patch of [{mode:'invalid'},{limit:0},{from:'bad'},{from:'2026-10-05',to:'2026-10-01'}])
  await assert.rejects(growth.searchPersonalKnowledge({scope,...patch}),{code:'F_MEMORY_SEARCH_INVALID'});
});

test('async semantic recall rejects deleted, corrected or generation-changed source snapshots',async t=>{
 const {growth,scope,seed}=setup(t);seed('a');
 await assert.rejects(growth.searchPersonalKnowledge({scope,mode:'semantic',query:'원문',embeddingProvider:{embed:async()=>{
  growth.decideHygiene({targetId:'a',action:'delete',decidedBy:'test',reason:'withdrawn during embedding'});
  return {vectors:[[1],[1]]};
 }}}),{code:'F_MEMORY_SEARCH_SOURCE_CHANGED'});
 assert.equal((await growth.searchPersonalKnowledge({scope,query:'원문'})).items.length,0);
 seed('b');
 await assert.rejects(growth.searchPersonalKnowledge({scope,mode:'semantic',query:'원문',embeddingProvider:{embed:async()=>{
  growth.memoryStore.db.exec('UPDATE memory_restore_generation SET generation=generation+1 WHERE singleton=1');return {vectors:[[1],[1]]};
 }}}));
});

test('embedding vector validation rejects cardinality, dimensions, non-finite and zero vectors',async t=>{
 const {growth,scope,seed}=setup(t);seed('a');
 for(const vectors of [[],[[1]],[[1],[1,2]],[[1],[NaN]],[[1],[0]],[[1],['1']],[[1e300],[1e300]]])
  await assert.rejects(growth.searchPersonalKnowledge({scope,mode:'semantic',query:'원문',embeddingProvider:{embed:async()=>({vectors})}}),{code:'F_MEMORY_EMBEDDING_INVALID'});
});

test('local adapter denies remote endpoints, cloud proxies, redirects and model mismatch without exposing response text',async()=>{
 for(const baseUrl of ['https://example.com','http://localhost:11434','http://127.0.0.1:11434/private','http://user:password@127.0.0.1:11434'])
  assert.throws(()=>createLocalOllamaEmbeddingProvider({baseUrl,model:'embeddinggemma:300m'}),{code:'F_MEMORY_EMBEDDING_CONFIG_INVALID'});
 const calls=[],responses=[{models:[{name:'embeddinggemma:300m',digest:'a'.repeat(64),size:600,capabilities:['embedding']}]},
  {model:'embeddinggemma:300m',embeddings:[[1]],prompt_eval_count:3}];
 const fetchImpl=async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(responses.shift()));};
 const provider=createLocalOllamaEmbeddingProvider({baseUrl:'http://127.0.0.1:11445',model:'embeddinggemma:300m',fetchImpl});
 const result=await provider.embed(['synthetic']);assert.equal(result.provider.digest,'a'.repeat(64));
 assert.equal(calls[1].options.redirect,'error');assert.equal(JSON.parse(calls[1].options.body).truncate,false);
 assert.deepEqual(JSON.parse(calls[1].options.body).input,['task: search result | query: synthetic']);
 for(const local of [null,{name:'embeddinggemma:300m',size:0},{name:'embeddinggemma:300m',size:2,digest:'a'.repeat(64),capabilities:['embedding'],remote_host:'cloud'}]){
  const denied=createLocalOllamaEmbeddingProvider({baseUrl:'http://127.0.0.1:11445',model:'embeddinggemma:300m',fetchImpl:async()=>new Response(JSON.stringify({models:local?[local]:[]}))});
  await assert.rejects(denied.embed(['synthetic']),{code:'F_MEMORY_EMBEDDING_LOCAL_MODEL_REQUIRED'});
 }
 const metadata={models:[{name:'embeddinggemma:300m',digest:'a'.repeat(64),size:600,capabilities:['embedding']}]};
 let n=0;
 const mismatch=createLocalOllamaEmbeddingProvider({baseUrl:'http://127.0.0.1:11445',model:'embeddinggemma:300m',fetchImpl:async()=>new Response(JSON.stringify(n++?{model:'wrong:300m',embeddings:[[1]]}:metadata))});
 await assert.rejects(mismatch.embed(['synthetic']),{code:'F_MEMORY_EMBEDDING_INVALID'});
 const redirect=createLocalOllamaEmbeddingProvider({baseUrl:'http://127.0.0.1:11445',model:'embeddinggemma:300m',fetchImpl:async()=>new Response('PRIVATE_ERROR',{status:302})});
 await assert.rejects(redirect.embed(['synthetic']),{code:'F_MEMORY_EMBEDDING_HTTP_ERROR'});
});

test('another SQLite connection correction during embedding invalidates stale vectors without caching private text',async t=>{
 const {growth,scope,seed,store,root,clock}=setup(t);seed('a');
 const writer=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock});
 const old=growth.ingestor.events.get('a');
 try{await assert.rejects(growth.searchPersonalKnowledge({scope,mode:'semantic',query:'원문',embeddingProvider:{embed:async()=>{
  writer.saveEvent({...old,eventId:'corrected',fingerprint:'corrected',createdAt:'2026-10-02T00:00:00.000Z',
   payload:{knowledge:{...old.payload.knowledge,value:'자료:새 원문',supersedesEventId:'a'}}},
   {expectedGeneration:writer.restoreGeneration(),expectedKnowledgeSource:{eventId:'a',observedAt:old.createdAt}});
  return {vectors:[[1],[1]]};
 }}}),{code:'F_MEMORY_SEARCH_SOURCE_CHANGED'});
 const current=await growth.searchPersonalKnowledge({scope,query:'새 원문'});
 assert.deepEqual(current.items.map(item=>item.sourceEventId),['corrected']);
 assert.equal(store.restoreGeneration(),writer.restoreGeneration());
 }finally{writer.close();}
});
