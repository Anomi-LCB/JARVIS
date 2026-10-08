import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {selectedConversationDocumentHash} from '../apps/growth-memory/src/selected-conversation-archive.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {selectMemoryResults} from '../apps/growth-memory/src/memory-result-selection.js';
import {memoryItemRelevant} from '../apps/growth-memory/src/memory-relevance.js';

test('output path delimiter segments remain discoverable without arbitrary substring matching',()=>{
 for(const [path,query,expected] of [
  ['C:/synthetic/result-1.txt','result',true],
  ['C:/synthetic/보고서_초안-v2.md','보고서',true],
  ['C:/synthetic/보고서_초안-v2.md','초안',true],
  ['C:/synthetic/report-final.md','report-final',true],
  ['C:/synthetic/planet-1.md','plan',false],
  ['C:/synthetic/result-1.txt','res',false],
  ['C:/synthetic/result-1.txt','budget',false]]) {
  assert.equal(memoryItemRelevant({outputPaths:[path]},query,{scope:{}}),expected,`${query}:${path}`);
 }
});

test('bounded selection distributes kinds, skips duplicate identities and retains stable within-pool order',()=>{
 const pool=Array.from({length:15},(_,i)=>({patternId:`p${i}`}));
 const confirmed={preferenceId:'confirmed'}, archive={memoryId:'archive'};
 const selected=selectMemoryResults([[confirmed],pool,[archive],[{...confirmed}]]);
 assert.equal(selected.length,10);
 assert.deepEqual(selected.slice(0,3),[confirmed,pool[0],archive]);
 assert.equal(selected.filter(x=>x.preferenceId).length,1);
 assert.deepEqual(selected.filter(x=>x.patternId).map(x=>x.patternId),pool.slice(0,8).map(x=>x.patternId));
 assert.deepEqual(selectMemoryResults([[{patternId:'same'},{failureId:'same'}]]),[{patternId:'same'},{failureId:'same'}]);
 assert.deepEqual(selectMemoryResults([[{patternId:'p'},{patternId:'p'}],[]]),[{patternId:'p'}]);
 assert.deepEqual(selectMemoryResults([[],[]]),[]);
 assert.deepEqual(selectMemoryResults([pool],{limit:0}),[]);
 assert.throws(()=>selectMemoryResults([pool],{limit:-1}),RangeError);
});

test('actual bounded Core recall preserves confirmed preference, output evidence and archival reference amid many patterns',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-result-selection-'));
 const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 let runtime;
 try {
  const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
  const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
  for(let j=0;j<12;j++)for(let i=0;i<3;i++)growth.ingestor.ingest({eventId:`edit-${j}-${i}`,taskId:`task-${j}-${i}`,eventType:'approval.edited',
   source:{module:'CORE',memoryScope:scope},payload:{editRequest:`자료 분류${j} 표로 정리해줘`},learningFlags:{canBeUsedForPreference:true,canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
  const candidates=growth.preferenceEngine.create(growth.ingestor.all());assert.ok(candidates.length>=12);
  const candidate=candidates.at(-1), confirmed=growth.decidePreference({hypothesisId:candidate.hypothesisId});assert.equal(confirmed.success,true);
  growth.ingestor.ingest({eventId:'output',taskId:'output-task',eventType:'execution.completed',source:{module:'CORE',memoryScope:scope},
   payload:{outputPaths:[join(root,'자료.md')]},trustBoundary:{systemGenerated:true}});
  const document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[{id:'chosen',messages:[
   {id:'quote',speaker:'user',text:'자료 연구의 이전 결정은 원문 대조다.',spokenAt:'2026-10-03T00:00:00Z'}]}]};
  growth.importSelectedConversations({document,scope,selectedConversationIds:['chosen'],expectedDocumentHash:selectedConversationDocumentHash(document),sourceRef:'synthetic-selected-snapshot'},{commit:true});
  const results=growth.query('자료',{scope});assert.equal(results.length,10);
  assert.ok(results.some(x=>x.preferenceId===confirmed.item.preferenceId),'confirmed preference must not be starved by patterns');
  assert.ok(results.some(x=>x.memoryType==='execution_observation'),'output evidence must not be starved by patterns');
  assert.ok(results.some(x=>x.memoryType==='selected_conversation_quote'),'selected quote must not be starved by local results');
  assert.ok(results.every(x=>x.provenance.executionAuthority===false));
  assert.equal(growth.query('자료',{scope:{...scope,userId:'other'}}).length,0);
  const context=growth.memoryContext('자료',{scope});
  assert.equal(context.items.filter(x=>x.preferenceId===confirmed.item.preferenceId).length,1,'confirmed items must not be duplicated');
  runtime=createAgRuntime({memoryStore:store,allowedRoots:[root],auditRoot:join(root,'core'),workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'},personalContextProvider:()=>null});
  const task=runtime.coreFacade.createTask('자료 파일 목록 보여줘',{userId:scope.userId,metadata:{doNotRemember:true}});
  assert.ok(task.memoryContext.some(x=>x.preferenceId===confirmed.item.preferenceId));
  assert.ok(task.memoryContext.some(x=>x.memoryType==='execution_observation'));
  assert.ok(task.memoryContext.some(x=>x.memoryType==='selected_conversation_quote'));
  growth.decideHygiene({targetId:candidate.evidenceEventIds[0],action:'delete',generateReport:false});
  assert.ok(!growth.query('자료',{scope}).some(x=>x.preferenceId===confirmed.item.preferenceId));
  growth.withdrawImportedConversationMessage({scope,id:results.find(x=>x.memoryType==='selected_conversation_quote').memoryId});
  assert.ok(!growth.query('자료',{scope}).some(x=>x.memoryType==='selected_conversation_quote'));
 }finally{runtime?.coreFacade.cognition?.close();store.close();rmSync(root,{recursive:true,force:true});}
});
