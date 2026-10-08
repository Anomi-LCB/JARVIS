import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {CoreFacade} from '../packages/core/src/core-facade.js';
for(const reason of ['expired','revoked','corrected'])test(`inactive ${reason} preference cannot reappear as inference in the same scope`,t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-inactive-inference-'));let now=new Date('2026-09-01T00:00:00.000Z');
 const options={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock:()=>now};let store=new SqliteMemoryStore(options);
 const open=()=>new GrowthRuntime({memoryStore:store,auditRoot:root,clock:()=>now});let growth=open();
 const scope={userId:'local_user',workspaceRoot:root,conversationId:null},other={...scope,conversationId:'other-thread'};
 const fill=s=>{for(let i=0;i<3;i++)growth.ingest({eventId:`${s.conversationId??'default'}-${i}`,taskId:`task-${s.conversationId??'default'}-${i}`,eventType:'approval.edited',source:{module:'CORE',memoryScope:s},payload:{editRequest:'회의자료는 표로 작성'},learningFlags:{canBeUsedForPreference:true},trustBoundary:{userProvided:true}});};fill(scope);fill(other);
 const candidate=growth.query('회의자료',{scope}).find(x=>x.hypothesisId);assert.ok(candidate);const confirmed=growth.decidePreference({hypothesisId:candidate.hypothesisId});assert.equal(confirmed.success,true);
 if(reason==='expired'){assert.equal(growth.updatePreference(confirmed.item.preferenceId,{expectedRevision:1,patch:{validUntil:'2026-09-02T00:00:00.000Z'}}).success,true);now=new Date('2026-09-02T00:00:00.000Z');}
 else if(reason==='corrected')assert.equal(growth.updatePreference(confirmed.item.preferenceId,{expectedRevision:1,patch:{statement:'회의자료는 문장으로 작성'}}).success,true);
 else assert.equal(growth.revokePreference(confirmed.item.preferenceId,{expectedRevision:1}).success,true);
 const check=()=>{
  const recalled=growth.query('회의자료',{scope});assert.equal(recalled.some(x=>x.memoryType!=='confirmed_preference'&&x.hypothesisId===candidate.hypothesisId),false);
  const memory=growth.memoryContext('회의자료',{scope});assert.equal(memory.preferenceHints.some(x=>x.hypothesisId===candidate.hypothesisId),false);
  assert.equal(memory.confirmedPreferenceHints.length,reason==='corrected'?1:0);
  if(reason==='corrected')assert.equal(memory.confirmedPreferenceHints[0].statement,'회의자료는 문장으로 작성');
  assert.ok(growth.query('회의자료',{scope:other}).some(x=>x.hypothesisId),'another conversation is not suppressed');
  assert.equal(store.allEvents().filter(x=>x.eventType==='approval.edited').length,6,'raw evidence retained');
  const core=new CoreFacade({workspaceRoot:root,memoryStore:growth});try{const task=core.createTask('회의자료 파일 확인');assert.equal(task.contextSnapshot.memoryEvidence.some(x=>x.summary.includes('표로')),false);}finally{core.cognition?.close();}
 };t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});check();
 store.close();store=new SqliteMemoryStore(options);growth=open();check();
 if(reason==='expired'){const current=store.getConfirmedPreference(confirmed.item.preferenceId);assert.equal(growth.updatePreference(current.preferenceId,{expectedRevision:current.revision,patch:{validUntil:null}}).success,true);
  assert.ok(growth.query('회의자료',{scope}).some(x=>x.memoryType==='confirmed_preference'));}
});
