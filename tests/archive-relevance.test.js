import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {selectedConversationDocumentHash} from '../apps/growth-memory/src/selected-conversation-archive.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createHash} from 'node:crypto';
import {createMemoryTextMatcher} from '../apps/growth-memory/src/memory-relevance.js';

test('normalized query matches keep original offsets and ignore filler-only requests',()=>{
 assert.deepEqual(createMemoryTextMatcher('ffi').findMatch('A ﬃ B'),{start:2,end:3});
 assert.deepEqual(createMemoryTextMatcher('x').findMatch('📄 𝒙 자료'),{start:3,end:5});
 assert.deepEqual(createMemoryTextMatcher('café').findMatch('A cafe\u0301 B'),{start:2,end:7});
 assert.equal(createMemoryTextMatcher('오늘 확인해줘').hasTerms,false);
 assert.equal(createMemoryTextMatcher('plan').findMatch('planet'),null);
});

test('fixed archive wording corpus is evaluated against actual scoped SQLite lookup',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-archive-relevance-'));const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 try {
  const bytes=readFileSync('tests/fixtures/archive-relevance-v1.json');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'099624b577476d9ede51c919486e79891331bb4585eaa1a71636dba8ac967f2f');
  const growth=new GrowthRuntime({memoryStore:store,auditRoot:root}), corpus=JSON.parse(bytes);
  for(const c of corpus.cases){
   const scope={userId:`synthetic-${c.id}`,workspaceRoot:root,conversationId:null};
   const document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[{id:'chosen',messages:[{id:'m',speaker:'user',text:c.text,spokenAt:'2026-10-03T00:00:00Z'}]}]};
   growth.importSelectedConversations({document,scope,selectedConversationIds:['chosen'],expectedDocumentHash:selectedConversationDocumentHash(document),sourceRef:'synthetic-snapshot'},{commit:true});
   assert.equal(growth.selectedConversationImports.query(c.query,{scope}).length>0,c.expected,c.id);
  }
 }finally{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});}
});

test('late matching archive text is visible with exact offsets, bounded results and Core scope/withdrawal preserved',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-archive-window-'));const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});let runtime;
 try {
  const growth=new GrowthRuntime({memoryStore:store,auditRoot:root}),scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
  const fullText='서론. '.repeat(900)+'자료 원문 대조는 이전 결정의 이유다. '+ '후기. '.repeat(200);
  const messages=Array.from({length:200},(_,i)=>({id:`other-${i}`,speaker:'user',text:'오늘 일정 초안',spokenAt:'2026-10-03T00:00:00Z'}));
  for(let i=0;i<7;i++)messages.push({id:`match-${i}`,speaker:i===0?'assistant':'user',text:fullText,spokenAt:'2026-10-02T00:00:00Z'});
  const document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[{id:'chosen',messages}]};
  growth.importSelectedConversations({document,scope,selectedConversationIds:['chosen'],expectedDocumentHash:selectedConversationDocumentHash(document),sourceRef:'synthetic-long-snapshot'},{commit:true});
  const quotes=growth.selectedConversationImports.query('오늘 자료를 정리해줘',{scope});
  assert.equal(quotes.length,5);
  for(const quote of quotes){assert.match(quote.text,/자료 원문/);assert.ok(quote.text.length<=2000);assert.ok(quote.sourceTextStart>0);
   assert.equal(quote.text,fullText.slice(quote.sourceTextStart,quote.sourceTextEnd));assert.equal(quote.truncated,true);assert.equal(quote.provenance.executionAuthority,false);}
  assert.deepEqual(growth.selectedConversationImports.query('오늘 자료를 정리해줘',{scope:{...scope,userId:'other'}}),[]);
  runtime=createAgRuntime({memoryStore:store,allowedRoots:[root],auditRoot:join(root,'core'),workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'},personalContextProvider:()=>null});
  const task=runtime.coreFacade.createTask('오늘 자료 파일 목록 보여줘',{userId:scope.userId,metadata:{doNotRemember:true}});
  assert.ok(task.memoryContext.some(item=>item.memoryType==='selected_conversation_quote'&&item.text.includes('자료 원문')));
  assert.equal(task.contextSnapshot.userPreferences.some(item=>item.summary?.includes('자료 원문')),false);
  const withdrawn=quotes[0].memoryId;growth.withdrawImportedConversationMessage({id:withdrawn,scope});
  assert.ok(!growth.selectedConversationImports.query('오늘 자료를 정리해줘',{scope}).some(item=>item.memoryId===withdrawn));
  assert.equal(growth.selectedConversationImports.query('오늘 자료를 정리해줘',{scope}).length,5);
 }finally{runtime?.coreFacade.cognition?.close();store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});}
});
