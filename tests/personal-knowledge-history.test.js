import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

test('scoped durable history excludes withdrawn ancestors and marks broken lineage after reopen',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-history-'));
 const scope={userId:'synthetic-user',workspaceRoot:root,conversationId:'thread'};
 const options={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')};
 let store=new SqliteMemoryStore(options);
 const open=()=>new GrowthRuntime({memoryStore:store,auditRoot:root,clock:()=>new Date('2026-10-01T00:00:00.000Z')});
 let growth=open();t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 for(let i=0;i<3;i++)growth.ingest({eventId:`revision-${i}`,taskId:`task-${i}`,eventType:'task.created',
  createdAt:`2026-09-0${i+1}T00:00:00.000Z`,source:{module:'CORE',memoryScope:scope},
  payload:{rawText:'합성 계획',knowledge:{kind:'decision',subject:'합성 계획',predicate:'장소',value:`place-${i}`,reason:`reason-${i}`,
   validUntil:'2026-12-01T00:00:00.000Z',...(i?{supersedesEventId:`revision-${i-1}`}:{})}},
  learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}},{expectedKnowledgeSource:i?{eventId:`revision-${i-1}`,observedAt:`2026-09-0${i}T00:00:00.000Z`}:null});
 let history=growth.personalKnowledgeHistory({scope,sourceEventId:'revision-2'});
 assert.equal(history.complete,true);assert.deepEqual(history.entries.map(x=>x.sourceEventId),['revision-0','revision-1','revision-2']);
 assert.deepEqual(history.entries.map(x=>x.status),['superseded','superseded','active']);
 assert.ok(history.entries.every(x=>x.validUntil==='2026-12-01T00:00:00.000Z'&&x.reason&&x.observedAt&&x.usageScope.userId===scope.userId));
 assert.equal(growth.personalKnowledgeHistory({sourceEventId:'revision-2'}).found,false);
 assert.equal(growth.personalKnowledgeHistory({scope:{...scope,userId:'other'},sourceEventId:'revision-2'}).found,false);
 growth.decideHygiene({targetId:'revision-1',action:'delete'});
 history=growth.personalKnowledgeHistory({scope,sourceEventId:'revision-2'});
 assert.equal(history.complete,false);assert.deepEqual(history.entries.map(x=>x.sourceEventId),['revision-2']);
 assert.equal(history.entries[0].status,'correction-unresolved');
 assert.equal(JSON.stringify(history).includes('reason-1'),false);
 store.close();store=new SqliteMemoryStore(options);growth=open();
 assert.deepEqual(growth.personalKnowledgeHistory({scope,sourceEventId:'revision-2'}),history);
 assert.equal(growth.personalKnowledgeHistory({scope,sourceEventId:'revision-1'}).found,false);
 assert.equal(growth.query('합성 계획',{scope}).some(x=>x.memoryType==='personal_knowledge'),false);
});
