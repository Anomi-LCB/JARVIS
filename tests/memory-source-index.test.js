import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {indexMemorySources,memoryProvenance,preferenceSourcesMatch} from '../apps/growth-memory/src/memory-provenance.js';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

test('indexed source checks preserve scope, unavailable/sensitive/external sources and first duplicate semantics',()=>{
 const scope={userId:'owner',workspaceRoot:join(tmpdir(),'synthetic'),conversationId:'conversation'};
 const pref={preferenceId:'p',scopePolicy:{userScope:'owner',workspaceScope:scope.workspaceRoot,conversationScope:'conversation'},evidenceEventIds:['e']};
 const event={eventId:'e',source:{memoryScope:scope},trustBoundary:{userProvided:true},createdAt:'2026-10-03T00:00:00.000Z'};
 const cases=[{events:[event],expected:true},{events:[],expected:false},
  {events:[{...event,learningFlags:{doNotRemember:true}}],expected:false},
  {events:[{...event,learningFlags:{containsSensitiveData:true}}],expected:false},
  {events:[{...event,trustBoundary:{externalContent:true}}],expected:false},
  {events:[{...event,source:{memoryScope:{...scope,userId:'another'}}}],expected:false},
  {events:[{...event,source:{memoryScope:{...scope,conversationId:'another'}}}],expected:false},
  {events:[{...event,learningFlags:{doNotRemember:true}},event],expected:false},
  {events:[event,{...event,learningFlags:{doNotRemember:true}}],expected:true}];
 for(const c of cases){const index=indexMemorySources(c.events);
  assert.equal(preferenceSourcesMatch(pref,c.events,scope),c.expected);
  assert.equal(preferenceSourcesMatch(pref,index,scope),c.expected);
  assert.deepEqual(memoryProvenance(pref,index),memoryProvenance(pref,c.events));
 }
 assert.equal(preferenceSourcesMatch(pref,indexMemorySources([event]),null),false);
 assert.equal(preferenceSourcesMatch(pref,indexMemorySources([]),undefined),true);
});

test('actual SQLite operation snapshots do not retain pre-correction or pre-withdrawal content across calls',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-memory-index-'));
 const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 try{
  const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
  const scope={userId:'owner',workspaceRoot:root,conversationId:'conversation'};
  for(let i=0;i<3;i++)growth.ingestor.ingest({eventId:`e${i}`,taskId:`t${i}`,eventType:'approval.edited',source:{module:'CORE',memoryScope:scope},
   payload:{editRequest:'자료를 표로 정리해줘'},learningFlags:{canBeUsedForPreference:true},trustBoundary:{userProvided:true}});
  const candidate=growth.query('자료',{scope}).find(v=>v.hypothesisId);
  const confirmed=growth.decidePreference({hypothesisId:candidate.hypothesisId});assert.equal(confirmed.success,true);
  const id=confirmed.item.preferenceId;
  let reads=0;const all=growth.ingestor.all.bind(growth.ingestor);
  growth.ingestor.all=()=>{reads++;return all();};
  growth.planningPreferenceContext('자료',{scope});const initialReads=reads;
  assert.ok(initialReads>0);
  growth.updatePreference(id,{expectedRevision:1,patch:{statement:'자료를 짧게 정리한다'}});
  assert.equal(growth.planningPreferenceContext('자료',{scope}).confirmedPreferenceHints[0].statement,'자료를 짧게 정리한다');
  growth.decideHygiene({targetId:'e0',action:'delete',generateReport:false});
  assert.deepEqual(growth.planningPreferenceContext('자료',{scope}).confirmedPreferenceHints,[]);
  assert.equal(growth.query('자료',{scope}).some(v=>v.preferenceId===id),false);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
