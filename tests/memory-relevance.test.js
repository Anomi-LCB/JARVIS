import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {memoryItemRelevant} from '../apps/growth-memory/src/memory-relevance.js';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const corpus=readFileSync('tests/fixtures/memory-relevance-v1.json');
test('fixed development and holdout wording finds content and excludes metadata-only or irrelevant matches',()=>{
 assert.equal(createHash('sha256').update(corpus).digest('hex'),'56c021b5b64c2dfc0ac1bc56c3d18d59f9e3c6f16497daeda66fcb14c4dd87b3');
 for(const c of JSON.parse(corpus).cases)assert.equal(memoryItemRelevant({statement:c.statement,userId:c.metadata,revision:c.metadata},c.query,{scope:{}}),c.expected,c.id);
 assert.equal(memoryItemRelevant({statement:'파일'},'소유자',{scope:{}}),false);
 assert.equal(memoryItemRelevant({userId:'소유자'},'소유자'),true);
});
test('actual SQLite preference planning and recall preserve scope and correction/retraction after leading-word changes',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-relevance-'));
 const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 let runtime;
 try{
  const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:'synthetic-session'};
  for(let i=0;i<3;i++)growth.ingestor.ingest({eventId:`e${i}`,taskId:`t${i}`,eventType:'approval.edited',source:{module:'CORE',memoryScope:scope},payload:{editRequest:'자료를 표로 정리해줘'},learningFlags:{canBeUsedForPreference:true},trustBoundary:{userProvided:true}});
  const candidate=growth.query('자료',{scope}).find(v=>v.hypothesisId);assert.ok(candidate);
  const confirmed=growth.decidePreference({hypothesisId:candidate.hypothesisId});assert.equal(confirmed.success,true);
  const id=confirmed.item.preferenceId;
  assert.equal(growth.planningPreferenceContext('오늘 자료를 정리해줘',{scope}).confirmedPreferenceHints.length,1);
  assert.ok(growth.query('오늘 자료를 정리해줘',{scope}).some(v=>v.preferenceId===id));
  assert.deepEqual(growth.planningPreferenceContext('오늘 자료를 정리해줘',{scope:{...scope,userId:'other'}}).confirmedPreferenceHints,[]);
  assert.deepEqual(growth.planningPreferenceContext('synthetic-owner',{scope}).confirmedPreferenceHints,[]);
  growth.updatePreference(id,{expectedRevision:1,patch:{statement:'자료 요약은 자세히 작성한다'}});
  assert.equal(growth.planningPreferenceContext('내일 자료 요약해줘',{scope}).confirmedPreferenceHints[0].statement,'자료 요약은 자세히 작성한다');
  runtime=createAgRuntime({memoryStore:store,allowedRoots:[root],auditRoot:join(root,'core-audit'),workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'},personalContextProvider:()=>null});
  const task=runtime.coreFacade.createTask('오늘 자료 파일 목록 보여줘',{userId:scope.userId,metadata:{conversationId:scope.conversationId,doNotRemember:true}});
  assert.equal(task.request.command.rawText,'오늘 자료 파일 목록 보여줘');
  assert.equal(task.planningContext.confirmedPreferenceHints[0].statement,'자료 요약은 자세히 작성한다');
  assert.equal(task.planningContext.confirmedPreferenceHints[0].provenance.executionAuthority,false);
  growth.decideHygiene({targetId:'e0',action:'delete',generateReport:false});
  assert.deepEqual(growth.planningPreferenceContext('내일 자료 요약해줘',{scope}).confirmedPreferenceHints,[]);
 }finally{runtime?.coreFacade.cognition?.close();store.close();rmSync(root,{recursive:true,force:true});}
});
