import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {FileMissionStore} from '../packages/core/src/mission/mission-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

const EXPECTED='자료 250건; 합계 31375; 마지막 항목 250.';
const field=(p,name)=>JSON.parse(p.split('\n').find(s=>s.startsWith(name+': ')).slice(name.length+2));
// No accumulator closure survives a runner invocation, let alone restart.
function consumer(root){return async prompt=>{
 const observations=field(prompt,'실행 관찰'),view=field(prompt,'원문 처리 초안'),latest=observations.at(-1);
 const wrap=(decision,actions=[],sourceNotes=[],extra={})=>JSON.stringify({decision,summary:'저장된 초안과 실제 전달 조각 처리',actions,sourceNotes,criteriaAssessment:[],question:null,blockedReason:null,...extra});
 if(latest?.toolName==='filesystem.createTextFile')return wrap('complete',[],[],{criteriaAssessment:[{criterionId:'result',status:'satisfied',evidenceActionIds:[latest.actionId],reason:'G 내용 확인'}]});
 const delivery=latest?.toolName==='filesystem.readText'?latest.evidenceFacts.textRead:null;
 const old=(view?.records??[]).find(r=>r.status==='current-draft'&&r.sourceSha256===delivery?.sourceSha256);
 if((view?.records??[]).some(r=>r.status==='unavailable'))return wrap('blocked',[],[],{blockedReason:'source-draft-current-check-failed'});
 let state=old?JSON.parse(old.draft):{through:0,count:0,sum:0,last:0,pending:''};
 const notes=[];
 if(delivery&&delivery.offset+delivery.deliveredChars>state.through){
  assert.equal(delivery.offset,state.through);assert.ok(['partial','complete'].includes(delivery.deliveryStatus));
  const lines=(state.pending+delivery.content).split('\n');state.pending=lines.pop();
  for(const line of lines){const r=JSON.parse(line);state.count++;state.sum+=r.value;state.last=r.record;}
  state.through=delivery.offset+delivery.deliveredChars;
  notes.push({noteKey:'note-'+state.through,sourceObservationId:latest.observationId,expectedRevision:old?.revision??0,throughOffset:state.through,draft:JSON.stringify(state)});
 }
 if(delivery&&delivery.completeChunkDelivered&&delivery.fileTruncated===false){
  assert.equal(state.pending,'');
  const content=`자료 ${state.count}건; 합계 ${state.sum}; 마지막 항목 ${state.last}.`;
  return wrap('continue',[{id:'write',title:'결과 저장',command:'result.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'result.txt'),content,allowOverwrite:false},dependencies:[],successSignal:'독립 고정 결과 검증'}],notes);
 }
 return wrap('continue',[{id:'read-'+state.through,title:'자료 읽기',command:'source.jsonl 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(root,'source.jsonl'),offset:state.through,maxChars:6000},dependencies:[],successSignal:'G 원문 확인'}],notes);
};}

for(const [backend,fault] of [['file','none'],['sqlite','none'],['file','source-change'],['file','permission-revoked'],['file','storage-failure']])test(`persisted source draft resumes ${backend}/${fault}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-source-resume-')),storePath=join(root,'missions.json');
 const source=await readFile(new URL('../artifacts/text-read-delivery-20261003-input.jsonl',import.meta.url));
 assert.equal(createHash('sha256').update(source).digest('hex'),'5228ca1ce05ba95bd0f73ec846d1fecba9c4bf29e138dfec1a01aa234ea0f22f');
 await writeFile(join(root,'source.jsonl'),source);
 let runtime,operations,memoryStore;
 t.after(async()=>{runtime?.coreFacade.cognition.close();operations?.close();memoryStore?.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 const store=()=>{if(backend==='file')return new FileMissionStore({filePath:storePath});operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});return new SqliteMissionStore({operationsStore:operations});};
 const make=()=>{memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});return createAgRuntime({memoryStore,allowedRoots:[root],auditRoot:join(root,'runtime'),missionStore:store(),env,taskEnv:env,missionRunner:consumer(root),workerDaemonEnabled:false});};
 runtime=make();
 const owner=runtime.personalOwnerSession.activate({requestedBy:'source-resume-test',durationMinutes:5});
 const grants=[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT];
 const created=runtime.missionRuntime.createMission({objective:"'source.jsonl'를 읽고 핵심을 요약해 'result.txt'로 저장해줘",budgets:{maxWaves:30,maxPlannerCalls:40},successCriteria:[{criterionId:'result',statement:'독립 자료 개수와 합계',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:EXPECTED}}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants}});
 const paused=await runtime.missionRuntime.runMission(created.missionId,{maxWaves:6});
 assert.equal(paused.status,'PAUSED');assert.equal(paused.stopReason,'run-wave-limit-reached');
 const persisted=runtime.missionRuntime.store.load().find(m=>m.missionId===created.missionId);
 const records=Object.values(persisted.sourceProcessing.records);assert.equal(records.length,1);assert.equal(records[0].deliveredThrough,30000);assert.equal(records[0].revision,5);
 const beforeReads=paused.observations.filter(o=>o.toolName==='filesystem.readText').map(o=>o.data.readExtent.offset);
 runtime.coreFacade.cognition.close();runtime=null;operations?.close();operations=null;memoryStore.close();memoryStore=null;
 if(fault==='source-change')await writeFile(join(root,'source.jsonl'),Buffer.concat([Buffer.from('changed\n'),source]));
 runtime=make();
 const resumedOwner=runtime.personalOwnerSession.activate({requestedBy:'source-resume-test',durationMinutes:5});
 runtime.missionRuntime.updateMission(created.missionId,{authorization:{mode:'trusted_session',ownerSessionId:resumedOwner.session.sessionId,grants}});
 if(fault==='permission-revoked')runtime.personalOwnerSession.revoke({reason:'test revoke before resume'});
 if(fault==='storage-failure'){const target=runtime.missionRuntime.store,save=target.save.bind(target);let injected=false;target.save=(missions,options)=>{if(!injected&&options?.reason?.startsWith('mission-source-checkpoint-saved:')){injected=true;throw new Error('injected write failure');}return save(missions,options);};}
 const result=await runtime.missionRuntime.runMission(created.missionId,{maxWaves:30});
 if(fault==='none'){
  assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,errors:result.observations.map(o=>o.error),actions:result.waves.flatMap(w=>w.actions).map(a=>({tool:a.expectedToolName,status:a.status,recovery:a.recovery,effect:a.effect}))}));
  assert.equal(await readFile(join(root,'result.txt'),'utf8'),EXPECTED);
  const reads=result.observations.filter(o=>o.toolName==='filesystem.readText');assert.equal(reads.length,12);assert.equal(new Set(reads.map(o=>o.data.readExtent.offset)).size,12);
  assert.deepEqual(reads.slice(0,6).map(o=>o.data.readExtent.offset),beforeReads);
  const saved=runtime.missionRuntime.store.load().find(m=>m.missionId===created.missionId);assert.equal(Object.values(saved.sourceProcessing.records)[0].deliveredThrough,69784);
 }else{
  if(fault==='storage-failure'){assert.equal(result.stopReason,'source-checkpoint-invalid');assert.equal(result.observations.at(-1).error.code,'A_SOURCE_CHECKPOINT_STORAGE_FAILED');const saved=runtime.missionRuntime.store.load().find(m=>m.missionId===created.missionId);assert.equal(Object.values(saved.sourceProcessing.records)[0].revision,5);assert.equal(result.observations.filter(o=>o.toolName==='filesystem.readText').length,6);}
  assert.notEqual(result.status,'COMPLETED');await assert.rejects(readFile(join(root,'result.txt')),{code:'ENOENT'});
 }
 console.log(JSON.stringify({sourceResumeEvidence:{backend,fault,pausedThrough:records[0].deliveredThrough,storedRevision:records[0].revision,status:result.status,stopReason:result.stopReason,totalReads:result.observations.filter(o=>o.toolName==='filesystem.readText').length,syntheticConsumer:true,cost:'unmeasured'}}));
});
