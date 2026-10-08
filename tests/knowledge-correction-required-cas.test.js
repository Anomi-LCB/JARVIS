import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
test('every durable correction requires a revision guard before event and retirement publication',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-required-cas-'));
 const options={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')};
 let store=new SqliteMemoryStore(options);const scope={userId:'synthetic-user',workspaceRoot:root,conversationId:null};
 let growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const event=(id,value,at,parent)=>({eventId:id,taskId:id,eventType:'task.created',createdAt:at,source:{module:'CORE',memoryScope:scope},
  payload:{rawText:'합성 기억',knowledge:{kind:'fact',subject:'합성 계획',predicate:'장소',value,...(parent?{supersedesEventId:parent}:{})}},
  learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
 const parent=event('original','이전 장소','2026-09-01T00:00:00.000Z');assert.equal(growth.ingest(parent).stored,true);
 const child=event('unguarded','새 장소','2026-09-02T00:00:00.000Z','original');
 assert.throws(()=>growth.ingest(child),{code:'F_KNOWLEDGE_REVISION_REQUIRED'});
 assert.equal(store.hasEvent('unguarded'),false);assert.equal(growth.ingestor.events.has('unguarded'),false);
 assert.deepEqual(store.retiredKnowledgeSourceIds(),[]);
 const guard={expectedKnowledgeSource:{eventId:parent.eventId,observedAt:parent.createdAt}};
 store.db.exec("CREATE TRIGGER reject_retirement BEFORE INSERT ON knowledge_retirements BEGIN SELECT RAISE(ABORT,'injected retirement failure'); END");
 assert.throws(()=>growth.ingest({...child,eventId:'guarded'},guard),/injected retirement failure/);
 assert.equal(store.hasEvent('guarded'),false);assert.equal(growth.ingestor.events.has('guarded'),false);
 assert.deepEqual(store.retiredKnowledgeSourceIds(),[]);
 store.db.exec('DROP TRIGGER reject_retirement');
 assert.equal(growth.ingest({...child,eventId:'guarded'},guard).stored,true);
 assert.deepEqual(store.retiredKnowledgeSourceIds(),['original']);
 const writer=new SqliteMemoryStore(options);
 try{assert.throws(()=>writer.saveEvent({...child,eventId:'stale',fingerprint:'stale'},guard),{code:'F_KNOWLEDGE_REVISION_CONFLICT'});
  assert.throws(()=>writer.saveEvent({...child,eventId:'raw',fingerprint:'raw'}),{code:'F_KNOWLEDGE_REVISION_REQUIRED'});
 }finally{writer.close();}
 growth.decideHygiene({targetId:'guarded',action:'delete'});
 assert.equal(growth.personalKnowledge({scope}).some(x=>x.status==='active'),false);
 store.close();store=new SqliteMemoryStore(options);growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 assert.equal(growth.personalKnowledge({scope}).some(x=>x.status==='active'),false);
 assert.equal(store.hasEvent('stale'),false);assert.equal(store.hasEvent('raw'),false);
});
