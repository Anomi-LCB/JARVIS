import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
test('an already-open reader recalls a correction committed on another SQLite connection',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-cross-recall-'));const opts={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')};
 const store=new SqliteMemoryStore(opts),growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 const scope={userId:'synthetic-user',workspaceRoot:root,conversationId:null};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 growth.ingest({eventId:'old',taskId:'old',eventType:'task.created',createdAt:'2026-02-20T00:00:00.000Z',source:{module:'CORE',memoryScope:scope},payload:{rawText:'합성 기억',knowledge:{kind:'fact',subject:'합성 프로젝트',predicate:'위치',value:'이전 위치'}},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 assert.equal(growth.personalKnowledge({scope})[0].value,'이전 위치');
 const writer=new SqliteMemoryStore(opts);
 try{
  const old=writer.allEvents()[0],allEvents=store.allEvents.bind(store);let committed=false;
  const valid={...old,eventId:'invalid-correction',fingerprint:'invalid-correction',createdAt:'2026-02-21T00:00:00.000Z',payload:{knowledge:{...old.payload.knowledge,value:'새 위치',supersedesEventId:'old'}}};
  for(const invalid of [
   {...valid,payload:{knowledge:{...valid.payload.knowledge,subject:'다른 프로젝트'}}},
   {...valid,source:{...valid.source,memoryScope:{...scope,conversationId:'other'}}},
   {...valid,payload:{knowledge:{...valid.payload.knowledge,supersedesEventId:'unrelated'}}},
   {...valid,createdAt:old.createdAt},
   {...valid,trustBoundary:{userProvided:true,systemGenerated:true}}
  ])assert.throws(()=>writer.saveEvent(invalid,{expectedKnowledgeSource:{eventId:'old',observedAt:old.createdAt}}),{code:'F_KNOWLEDGE_CORRECTION_INVALID'});
  assert.equal(writer.hasEvent('invalid-correction'),false);assert.deepEqual(writer.retiredKnowledgeSourceIds(),[]);
  store.allEvents=()=>{
   const events=allEvents();
   if(!committed){writer.saveEvent({...old,eventId:'new',fingerprint:'new',createdAt:'2026-02-21T00:00:00.000Z',payload:{rawText:'합성 정정',knowledge:{...old.payload.knowledge,value:'새 위치',supersedesEventId:'old'}}},{expectedGeneration:writer.restoreGeneration(),expectedKnowledgeSource:{eventId:'old',observedAt:old.createdAt}});committed=true;}
   return events;
  };
  const beforeCommitSnapshot=growth.personalKnowledge({scope});
  assert.equal(committed,true);assert.equal(beforeCommitSnapshot.find(x=>x.status==='active')?.value,'이전 위치');
  store.allEvents=allEvents;
  assert.equal(growth.personalKnowledge({scope}).find(x=>x.status==='active')?.value,'새 위치');
  assert.equal(growth.query('합성 프로젝트',{scope}).find(x=>x.memoryType==='personal_knowledge')?.value,'새 위치');
  writer.saveHygieneDecision({decisionId:'delete-new',targetType:'memory_event',targetId:'new',action:'delete',decidedAt:new Date().toISOString()});
  assert.equal(growth.personalKnowledge({scope}).some(x=>x.sourceEventId==='new'),false);
  assert.equal(growth.query('합성 프로젝트',{scope}).some(x=>x.memoryType==='personal_knowledge'),false);
 }finally{writer.close();}
});
