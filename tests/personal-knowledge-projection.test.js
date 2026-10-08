import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
test('explicit scoped facts and decision reasons survive reopening and disappear after source withdrawal',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-knowledge-'));const stores=[];const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});stores.push(store);return new GrowthRuntime({memoryStore:store,auditRoot:root});};
 t.after(()=>{stores.forEach(s=>{try{s.close();}catch{}});rmSync(root,{recursive:true,force:true});});let runtime=open();
 for(const [id,kind,trust] of [['fact','fact',{userProvided:true,systemGenerated:false}],['decision','decision',{userProvided:true,systemGenerated:false}],['model','fact',{systemGenerated:true}],['external','fact',{userProvided:true,externalContent:true}]]){
  const result=runtime.ingest({eventId:id,taskId:id,eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:{rawText:'synthetic assertion',knowledge:{kind,subject:'synthetic-project',predicate:'choice',value:'local',reason:'private synthetic reason'}},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:trust});assert.equal(result.stored,true);
 }
 assert.deepEqual(runtime.personalKnowledge({scope}).map(x=>x.kind),['fact','decision']);
 assert.deepEqual(runtime.personalKnowledge(),[]);assert.deepEqual(runtime.personalKnowledge({scope:{...scope,userId:'other'}}),[]);
 stores[0].close();runtime=open();assert.equal(runtime.personalKnowledge({scope})[1].reason,'private synthetic reason');
 assert.equal(runtime.decideHygiene({targetId:'decision',action:'delete'}).success,true);
 assert.deepEqual(runtime.personalKnowledge({scope}).map(x=>x.kind),['fact']);assert.equal(JSON.stringify(runtime.personalKnowledge({scope})).includes('private synthetic reason'),false);
});


import {projectPersonalKnowledge} from '../apps/growth-memory/src/personal-knowledge-projection.js';
const event=(id,value,extra={},at='2026-02-20T00:00:00.000Z')=>({eventId:id,taskId:id,createdAt:at,trustBoundary:{userProvided:true,systemGenerated:false},payload:{knowledge:{kind:'fact',subject:'synthetic',predicate:'choice',value,...extra}}});
test('explicit correction supersedes only an older matching assertion and preserves provenance',()=>{
 const result=projectPersonalKnowledge([event('old','A'),event('new','B',{supersedesEventId:'old'},'2026-02-21T00:00:00.000Z')]);
 assert.deepEqual(result.map(x=>x.status),['superseded','active']);assert.equal(result[1].supersedesEventId,'old');
});
test('contradictions remain conflicts rather than silently selecting latest assertion',()=>{
 assert.deepEqual(projectPersonalKnowledge([event('a','A'),event('b','B')]).map(x=>x.status),['conflict','conflict']);
});
test('expired correction never revives the superseded value',()=>{
 const result=projectPersonalKnowledge([event('old','A'),event('new','B',{supersedesEventId:'old',validUntil:'2026-02-22T00:00:00.000Z'},'2026-02-21T00:00:00.000Z')],{now:new Date('2026-02-23T00:00:00Z')});
 assert.deepEqual(result.map(x=>x.status),['superseded','expired']);
});
test('missing, cross-key and cyclic correction sources are unresolved; invalid expiry omitted',()=>{
 assert.equal(projectPersonalKnowledge([event('new','B',{supersedesEventId:'deleted'})])[0].status,'correction-unresolved');
 assert.equal(projectPersonalKnowledge([event('a','A',{supersedesEventId:'b'}),event('b','B',{supersedesEventId:'a'})]).every(x=>x.status==='correction-unresolved'),true);
 assert.deepEqual(projectPersonalKnowledge([event('bad','A',{validUntil:'2026-02-30T00:00:00.000Z'})]),[]);
 const unrelated=event('old','A');unrelated.payload.knowledge.subject='other';
 assert.equal(projectPersonalKnowledge([unrelated,event('new','B',{supersedesEventId:'old'},'2026-02-21T00:00:00.000Z')])[1].status,'correction-unresolved');
});

test('SQLite correction lifecycle survives reopen, expires without fallback and fences withdrawn predecessor',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-knowledge-lifecycle-')),stores=[];let now=new Date('2026-02-21T12:00:00.000Z');
 const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:'synthetic-session'};
 const open=()=>{const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock:()=>now});stores.push(store);return new GrowthRuntime({memoryStore:store,auditRoot:root,clock:()=>now});};
 t.after(()=>{stores.forEach(s=>{try{s.close();}catch{}});rmSync(root,{recursive:true,force:true});});let runtime=open();
 for(const e of [event('old','A'),event('new','B',{supersedesEventId:'old',validUntil:'2026-02-22T00:00:00.000Z'},'2026-02-21T00:00:00.000Z')]){
  const result=runtime.ingest({...e,eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:{...e.payload,rawText:'synthetic explicit correction'},learningFlags:{canBeUsedForWorkflow:true}},{expectedKnowledgeSource:e.payload.knowledge.supersedesEventId?{eventId:'old',observedAt:'2026-02-20T00:00:00.000Z'}:null});assert.equal(result.stored,true);
 }
 assert.deepEqual(runtime.personalKnowledge({scope}).map(x=>x.status),['superseded','active']);
 stores[0].close();runtime=open();assert.deepEqual(runtime.personalKnowledge({scope}).map(x=>x.status),['superseded','active']);
 now=new Date('2026-02-23T00:00:00.000Z');assert.deepEqual(runtime.personalKnowledge({scope}).map(x=>x.status),['superseded','expired']);
 now=new Date('2026-02-21T12:00:00.000Z');assert.equal(runtime.decideHygiene({targetId:'old',action:'delete'}).success,true);
 const remaining=runtime.personalKnowledge({scope});assert.equal(remaining.length,1);assert.equal(remaining[0].status,'correction-unresolved');assert.equal(remaining[0].value,'B');
 assert.deepEqual(runtime.personalKnowledge({scope:{...scope,conversationId:'other'}}),[]);
 const korean="'합성 계획'의 '선택'은 '로컬'이라고 기억해줘";
 assert.equal(runtime.ingest({eventId:'korean-input',taskId:'korean-input',eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:{rawText:korean},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}}).stored,true);
 assert.equal(runtime.personalKnowledge({scope}).find(x=>x.sourceEventId==='korean-input').value,'로컬');
});

test('explicit Korean memory statements preserve decision reason and never drop extra instructions',()=>{
 const make=rawText=>({...event('ko','unused'),payload:{rawText}});
 const fact="'합성 프로젝트'의 '실행 위치'는 '로컬'이라고 기억해줘";
 const decision="'합성 프로젝트'의 '실행 위치'를 '로컬'로 결정했어. 이유는 '오프라인 지원'이야. 기억해줘";
 assert.equal(projectPersonalKnowledge([make(fact)])[0].value,'로컬');
 assert.equal(projectPersonalKnowledge([make(decision)])[0].reason,'오프라인 지원');
 assert.deepEqual(projectPersonalKnowledge([make(fact+' 그리고 메일로 보내줘')]),[]);
 assert.deepEqual(projectPersonalKnowledge([{...make(fact),trustBoundary:{userProvided:true,externalContent:true}}]),[]);
});

test('correction cannot become active through an unresolved predecessor in either arrival order',()=>{
 const parent=event('parent','B',{supersedesEventId:'missing'},'2026-02-21T00:00:00.000Z');
 const child=event('child','C',{supersedesEventId:'parent'},'2026-02-22T00:00:00.000Z');
 for(const events of [[parent,child],[child,parent]])assert.equal(projectPersonalKnowledge(events).every(x=>x.status==='correction-unresolved'),true);
});

test('invalid or future observation times cannot become active personal knowledge',()=>{
 const now=new Date('2026-02-21T00:00:00Z');
 for(const at of ['not-a-date','2026-02-30T00:00:00.000Z','2026-02-22T00:00:00.000Z'])assert.deepEqual(projectPersonalKnowledge([event('bad','A',{},at)],{now}),[]);
 assert.throws(()=>projectPersonalKnowledge([event('valid','A')],{now:new Date('invalid')}),{code:'F_KNOWLEDGE_CLOCK_INVALID'});
});

test('exclusion diagnostics contain only reason counts and no rejected personal content',()=>{
 const diagnostics={},now=new Date('2026-02-21T00:00:00Z');
 projectPersonalKnowledge([event('bad','PRIVATE_EXCLUDED_MARKER',{},'bad-time'),event('future','PRIVATE_FUTURE_MARKER',{},'2026-02-22T00:00:00.000Z'),event('shape','A',{value:''})],{now,diagnostics});
 assert.deepEqual(diagnostics.excluded,{invalidObservationTime:1,futureObservationTime:1,invalidKnowledge:1});
 assert.equal(diagnostics.scope,'eligible-sources-only');assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_'),false);
 assert.equal(diagnostics.nextAction,'check-record-time-and-required-fields');
});
