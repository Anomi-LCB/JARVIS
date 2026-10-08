import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
test('a correction committed by another SQLite connection during restore staging remains retired',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-retirement-restore-'));
 const opts={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')};
 const store=new SqliteMemoryStore(opts);const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 const scope={userId:'synthetic-user',workspaceRoot:root,conversationId:null};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const emptyBackup=store.backup({backupId:'before-any-source'});
 growth.ingest({eventId:'original',taskId:'original',eventType:'task.created',createdAt:'2026-02-20T00:00:00.000Z',source:{module:'CORE',memoryScope:scope},
  payload:{rawText:'합성 진술',knowledge:{kind:'fact',subject:'합성 프로젝트',predicate:'선택',value:'이전 값'}},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 const backup=store.backup({backupId:'before-racing-correction'});
 const materialize=store.materializeBackupForRead.bind(store);let committed=false;
 store.materializeBackupForRead=input=>{
  const result=materialize(input);const writer=new SqliteMemoryStore(opts);
  try{
   const original=writer.allEvents().find(x=>x.eventId==='original');
   writer.saveEvent({...original,eventId:'correction',fingerprint:'correction',createdAt:'2026-02-21T00:00:00.000Z',payload:{rawText:'합성 정정',knowledge:{...original.payload.knowledge,value:'새 값',supersedesEventId:'original'}}},
    {expectedGeneration:writer.restoreGeneration(),expectedKnowledgeSource:{eventId:'original',observedAt:original.createdAt}});committed=true;
  }finally{writer.close();}
  return result;
 };
 assert.equal(growth.restoreStorage({backupPath:backup.filePath}).success,true);assert.equal(committed,true);
 assert.deepEqual(store.retiredKnowledgeSourceIds(),['original']);
 const items=growth.personalKnowledge({scope});assert.equal(items.length,1);assert.equal(items[0].status,'superseded');
 assert.equal(growth.query('합성 프로젝트',{scope}).some(x=>x.memoryType==='personal_knowledge'),false);
 store.materializeBackupForRead=materialize;
 assert.equal(growth.restoreStorage({backupPath:emptyBackup.filePath}).success,true);
 assert.equal(store.hasEvent('original'),false);
 assert.deepEqual(store.retiredKnowledgeSourceIds(),['original']);
 const fenceOnly=store.backup({backupId:'fence-only-no-original-row'});
 const portable=new SqliteMemoryStore({...opts,dbPath:join(root,'portable.sqlite')});
 try{
  assert.equal(portable.restore({backupPath:fenceOnly.filePath}).success,true);
  assert.equal(portable.hasEvent('original'),false);
  assert.deepEqual(portable.retiredKnowledgeSourceIds(),['original']);
  assert.equal(portable.restore({backupPath:backup.filePath}).success,true);
  const portableGrowth=new GrowthRuntime({memoryStore:portable,auditRoot:root});
  assert.equal(portableGrowth.personalKnowledge({scope})[0].status,'superseded');
 }finally{portable.close();}
 assert.equal(growth.restoreStorage({backupPath:backup.filePath}).success,true);
 assert.equal(growth.personalKnowledge({scope})[0].status,'superseded');
 const other=new SqliteMemoryStore(opts);
 try{assert.deepEqual(other.retiredKnowledgeSourceIds(),['original']);}finally{other.close();}
});
