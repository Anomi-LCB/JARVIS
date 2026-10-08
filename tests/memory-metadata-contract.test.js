import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {projectMemoryContext} from '../packages/core/src/context/memory-context-projection.js';
test('all F recall kinds retain real source clocks and scope through SQLite reopen and Core projection',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-memory-contract-')),scope={userId:'local_user',workspaceRoot:root,conversationId:'synthetic-thread'};
 let tick=Date.parse('2026-09-30T00:00:00.000Z');const clock=()=>new Date(tick++);
 const opts={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock};let store=new SqliteMemoryStore(opts),growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const put=(id,eventType,payload,user=true)=>{assert.equal(growth.ingest({eventId:id,taskId:id,eventType,source:{module:'CORE',memoryScope:scope},payload,
  learningFlags:{canBeUsedForPreference:true,canBeUsedForWorkflow:true},trustBoundary:{userProvided:user,systemGenerated:!user}}).stored,true);};
 for(let i=0;i<3;i++){put(`task-${i}`,'task.created',{rawText:'감사자료 파일 목록 보여줘'});put(`edit-${i}`,'approval.edited',{editRequest:'감사자료는 표로 작성'});}
 put('failed','verification.failed',{rawText:'감사자료 파일 확인',reason:'검증 evidence 누락',reasonCode:'G_EVIDENCE_MISSING',toolName:'filesystem.listFiles'},false);
 put('observed','execution.completed',{outputPaths:[join(root,'감사자료-미검증.txt')]},false);
 put('fact','task.created',{knowledge:{kind:'fact',subject:'감사자료',predicate:'형식',value:'표'},rawText:'명시적 합성 진술'});
 put('decision','task.created',{knowledge:{kind:'decision',subject:'감사자료',predicate:'위치',value:'로컬',reason:'오프라인'},rawText:'명시적 합성 결정'});
 const kinds=new Set();const check=()=>{
  const events=new Map(store.allEvents().map(x=>[x.eventId,x])),items=growth.query('',{scope});
  for(const item of items){const p=item.provenance;kinds.add(p.memoryKind);assert.ok(p.sourceEventIds.length>0);
   assert.deepEqual(p.observedAt,p.sourceEventIds.map(id=>events.get(id).createdAt).sort());
   assert.ok(p.usageScopes.every(s=>JSON.stringify(s)===JSON.stringify(scope)));
   assert.deepEqual(p.validity,{validUntil:null,basis:'unspecified'});assert.equal(p.executionAuthority,false);
   const ref=projectMemoryContext([item]).memoryEvidence[0];assert.deepEqual(ref.sourceEventIds,p.sourceEventIds);
   assert.deepEqual(ref.observedAt,p.observedAt);assert.deepEqual(ref.usageScopes,p.usageScopes);assert.equal(ref.currentArtifactVerified,false);
  }
  assert.deepEqual(growth.query('',{scope:{...scope,userId:'other'}}),[]);return items;
 };
 const initial=check();const hypothesis=initial.find(x=>x.hypothesisId);assert.ok(hypothesis);
 assert.equal(growth.decidePreference({hypothesisId:hypothesis.hypothesisId}).success,true);check();
 assert.deepEqual([...kinds].sort(),['execution_observation','failure_observation','preference_hypothesis','procedure_candidate','user_confirmed_preference','user_statement'].sort());
 store.close();store=new SqliteMemoryStore(opts);growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock});check();
 growth.decideHygiene({targetId:'edit-0',action:'delete'});
 assert.equal(growth.query('',{scope}).some(x=>x.preferenceId),false);
});
