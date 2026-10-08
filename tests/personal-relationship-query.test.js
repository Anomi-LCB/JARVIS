import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {CoreFacade} from '../packages/core/src/core-facade.js';import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {parseTypedMemoryEntity,parseMemoryRelationshipQuestion,queryPersonalRelationships} from '../apps/growth-memory/src/personal-relationship-query.js';

test('bounded directed traversal preserves types, cycles, parallel reasons and explicit truncation',()=>{
 const item=(id,subject,value)=>({sourceEventId:id,subject,value,predicate:'연결',status:'active',basis:'user-statement',observedAt:'2026-10-01T00:00:00.000Z',validUntil:null});
 const items=[item('a','사람:같은 이름','목표:같은 이름'),item('b','목표:같은 이름','프로젝트:연구'),item('c','프로젝트:연구','사람:같은 이름')];
 assert.notEqual(parseTypedMemoryEntity('사람:같은 이름').id,parseTypedMemoryEntity('목표:같은 이름').id);
 const all=queryPersonalRelationships(items,{entity:'사람:같은 이름',depth:8});assert.equal(all.nodes.length,3);assert.equal(all.edges.length,3);
 assert.equal(all.truncated,false);assert.equal(all.currentArtifactVerified,false);
 assert.equal(queryPersonalRelationships(items,{entity:'사람:같은 이름',direction:'outgoing',depth:1}).edges.length,1);
 assert.equal(queryPersonalRelationships(items,{entity:'사람:같은 이름',direction:'incoming',depth:1}).edges[0].sourceEventId,'c');
 const limited=queryPersonalRelationships(items,{entity:'사람:같은 이름',limit:1});assert.equal(limited.edges.length,1);assert.equal(limited.truncated,true);assert.ok(limited.nextAction);
 const conflict=queryPersonalRelationships([{...items[0],status:'conflict',value:'PRIVATE_CONFLICT_VALUE'}],{entity:'사람:같은 이름'});
 assert.equal(conflict.found,true);assert.equal(conflict.edges.length,0);assert.equal(conflict.requiresUserResolution,true);
 assert.equal(JSON.stringify(conflict).includes('PRIVATE_CONFLICT_VALUE'),false);
 assert.deepEqual(queryPersonalRelationships([...items].reverse(),{entity:'사람:같은 이름'}),queryPersonalRelationships(items,{entity:'사람:같은 이름'}));
 for(const patch of [{entity:'모호한 이름'},{depth:9},{depth:0},{direction:'invalid'},{limit:201},{limit:0}])
  assert.throws(()=>queryPersonalRelationships(items,{entity:'사람:같은 이름',...patch}),{code:'F_MEMORY_RELATION_QUERY_INVALID'});
 for(const label of ['person:이름','사람:','사람: \n비밀'])assert.equal(parseTypedMemoryEntity(label),null);
 assert.equal(parseMemoryRelationshipQuestion("'프로젝트:연구'의 연결 관계를 3단계까지 보여줘 그리고 메일 보내"),null);
});

test('existing owner assertion API and SQLite feed seven-type graph and real Core context with lifecycle isolation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-relations-'));let tick=Date.now()-1000;const clock=()=>new Date(tick++);
 const opts={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock};
 let store=new SqliteMemoryStore(opts),growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock}),core=new CoreFacade({workspaceRoot:root,memoryStore:growth});
 let server=createCoreServer(core,{adminToken:'synthetic-admin',adminTokens:[{token:'reader',scopes:['read_diagnostics']}]});
 await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();core.cognition?.close();rmSync(root,{recursive:true,force:true});});
 const scope={userId:'local_user',workspaceRoot:root,conversationId:'synthetic-thread'};
 let task=core.createTask('합성 관계 조회',{metadata:{conversationId:scope.conversationId}});
 let base=`http://127.0.0.1:${server.address().port}`;
 const read=(extra={},taskId=task.taskId,token='synthetic-admin')=>fetch(base+'/memory/knowledge/relations?'+new URLSearchParams({taskId,entity:'사람:합성 담당자',depth:'6',direction:'outgoing',...extra}),{headers:{authorization:'Bearer '+token}});
 const post=body=>fetch(base+'/memory/knowledge/statements',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-admin'},body:JSON.stringify({taskId:task.taskId,...body})});
 const labels=['사람:합성 담당자','목표:근거 있는 연구','프로젝트:합성 연구','자료:합성 원문','결정:로컬 보관','작업:합성 검토','결과:합성 보고서'];
 const saved=[];
 for(let i=0;i<6;i++){
  const statement=i===4?`'${labels[i]}'의 '후속'을 '${labels[i+1]}'로 결정했어. 이유는 '원본 보존'이야. 기억해줘`
   :`'${labels[i]}'의 '연결'는 '${labels[i+1]}'이라고 기억해줘`;
  const r=await post({requestId:`relation-${i}`,statement});assert.equal(r.status,201);saved.push(await r.json());
 }
 let response=await read();assert.equal(response.status,200);let graph=await response.json();
 assert.equal(graph.edges.length,6);assert.equal(graph.nodes.length,7);
 assert.deepEqual(graph.nodes.map(x=>x.type),['person','goal','project','material','decision','task','result']);
 assert.equal(graph.edges[4].reason,'원본 보존');assert.equal(graph.edges[4].basis,'user-statement');
 assert.ok(graph.edges.every(x=>x.executionAuthority===false&&x.currentArtifactVerified===false));
 const question="'사람:합성 담당자'의 연결 관계를 6단계까지 보여줘";
 const context=core.createTask(question,{metadata:{conversationId:scope.conversationId}}).contextSnapshot;
 assert.equal(context.memoryEvidence.filter(x=>x.basis==='user-statement').length,6);assert.deepEqual(context.userPreferences,[]);
 assert.ok(context.memoryEvidence.every(x=>x.sourceEventIds.length===1&&x.usageScopes[0].conversationId===scope.conversationId));
 assert.deepEqual(core.createTask(question,{metadata:{conversationId:scope.conversationId,longTermMemory:false}}).contextSnapshot.memoryEvidence,[]);
 assert.equal((await read({},task.taskId,'reader')).status,403);
 for(const patch of [{depth:'0'},{depth:'2.5'},{limit:'201'},{limit:'1e2'},{direction:'bad'},{entity:'미지정 이름'},{userId:'other'}])assert.equal((await read(patch)).status,400);
 const duplicate=await fetch(base+'/memory/knowledge/relations?'+new URLSearchParams({taskId:task.taskId,entity:labels[0]})+'&depth=1&depth=2',{headers:{authorization:'Bearer synthetic-admin'}});assert.equal(duplicate.status,400);
 const other=core.createTask('합성 다른 대화',{metadata:{conversationId:'other'}});assert.equal((await (await read({},other.taskId)).json()).found,false);
 const off=core.createTask('합성 기억 금지',{metadata:{longTermMemory:false}});assert.equal((await read({},off.taskId)).status,404);
 const truncated=await (await read({limit:'2'})).json();assert.equal(truncated.truncated,true);assert.equal(truncated.edges.length,2);
 const edgePayload={knowledge:{kind:'fact',subject:labels[0],predicate:'비신뢰 연결',value:'프로젝트:MUST_NOT_RECALL'}};
 for(const [id,trust,flags] of [['external',{userProvided:true,externalContent:true},{}],['model',{systemGenerated:true},{}],['sensitive',{userProvided:true},{containsSensitiveData:true}]])
  growth.ingest({eventId:id,taskId:task.taskId,eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:edgePayload,trustBoundary:trust,learningFlags:flags});
 await post({requestId:'expired-relation',statement:`'${labels[0]}'의 '만료 연결'는 '프로젝트:EXPIRED'이라고 기억해줘`,validUntil:'2000-01-01T00:00:00.000Z'});
 graph=await (await read()).json();assert.equal(graph.edges.length,6);assert.equal(JSON.stringify(graph).includes('MUST_NOT_RECALL'),false);assert.equal(JSON.stringify(graph).includes('EXPIRED'),false);
 const correction=await post({requestId:'relation-correction',statement:`'${labels[4]}'의 '후속'을 '작업:새 검토'로 결정했어. 이유는 '정정 사유'야. 기억해줘`,supersedesEventId:saved[4].item.sourceEventId,expectedObservedAt:saved[4].item.observedAt});
 assert.equal(correction.status,201);const corrected=await correction.json();
 graph=await (await read()).json();assert.equal(graph.edges.length,5);assert.equal(graph.nodes.at(-1).label,'새 검토');assert.equal(graph.edges.at(-1).reason,'정정 사유');
 assert.equal(graph.edges.at(-1).supersedesEventId,saved[4].item.sourceEventId);assert.deepEqual(graph.usageScope,scope);
 const correctedContext=core.createTask(question,{metadata:{conversationId:scope.conversationId}}).contextSnapshot;
 assert.ok(correctedContext.memoryEvidence.some(x=>x.revisionReference.supersedesEventId===saved[4].item.sourceEventId));
 growth.decideHygiene({targetId:corrected.item.sourceEventId,action:'delete'});
 graph=await (await read()).json();assert.equal(graph.edges.length,4);assert.equal(JSON.stringify(graph).includes('새 검토'),false);assert.equal(JSON.stringify(graph).includes('원본 보존'),false);
 await new Promise(r=>server.close(r));store.close();core.cognition?.close();
 store=new SqliteMemoryStore(opts);growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock});core=new CoreFacade({workspaceRoot:root,memoryStore:growth});
 server=createCoreServer(core,{adminToken:'synthetic-admin'});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});base=`http://127.0.0.1:${server.address().port}`;
 task=core.createTask('재시작 후 합성 관계 조회',{metadata:{conversationId:scope.conversationId}});
 assert.equal((await (await read()).json()).edges.length,4);
 const otherStore=new SqliteMemoryStore(opts);try{
  const otherGrowth=new GrowthRuntime({memoryStore:otherStore,auditRoot:root,clock});otherGrowth.decideHygiene({targetId:saved[1].item.sourceEventId,action:'delete'});
  assert.equal((await (await read()).json()).edges.length,1,'other connection withdrawal must remove the graph path immediately');
 }finally{otherStore.close();}
 const conflictResponse=await post({requestId:'relationship-conflict',statement:`'${labels[0]}'의 '연결'는 '목표:비공개 상충값'이라고 기억해줘`});assert.equal(conflictResponse.status,201);
 const conflicted=await (await read()).json();assert.equal(conflicted.found,true);assert.equal(conflicted.edges.length,0);
 assert.equal(conflicted.requiresUserResolution,true);assert.equal(conflicted.issues.length,2);
 assert.equal(JSON.stringify(conflicted).includes('비공개 상충값'),false);
 const conflictContext=core.createTask(question,{metadata:{conversationId:scope.conversationId}}).contextSnapshot;
 assert.ok(conflictContext.memoryEvidence.some(x=>x.requiresUserResolution));
 assert.throws(()=>growth.personalRelationships({entity:labels[0]}),{code:'F_MEMORY_SCOPE_REQUIRED'});
});
