import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

// Deterministic consumer of actual planner-delivered data, not an LLM benchmark.
for(const initialMax of [6000,50000])test(`real delivered text drives output with initial range ${initialMax}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-read-delivery-'));
 const source=Array.from({length:250},(_,i)=>JSON.stringify({record:i+1,value:i+1,padding:'자료'.repeat(120)})+'\n').join('');
 const expected='자료 250건; 합계 31375; 마지막 항목 250.';
 await writeFile(join(root,'source.jsonl'),source);
 let runtime;
 t.after(async()=>{runtime?.coreFacade.cognition.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 let received='',pinnedHash=null,steps=0,maxPromptObservations=0,withheldRows=0;const deliveryEvents=[];
 const runner=async prompt=>{
  steps++;
  const observations=JSON.parse(prompt.split('\n').find(s=>s.startsWith('실행 관찰: ')).slice('실행 관찰: '.length));
  assert.ok(JSON.stringify(observations).length<=14000);maxPromptObservations=Math.max(maxPromptObservations,observations.length);
  const latest=observations.at(-1);
  if(latest?.toolName==='filesystem.createTextFile')return JSON.stringify({decision:'complete',summary:'실제 전달 자료로 만든 결과 검증',actions:[],criteriaAssessment:[{criterionId:'result',status:'satisfied',evidenceActionIds:[latest.actionId],reason:'실제 산출물 확인'}],question:null,blockedReason:null});
  const data=latest?.toolName==='filesystem.readText'?latest.evidenceFacts.textRead:null;
  let nextOffset=0,nextMax=initialMax;
  if(data){
   assert.notEqual(data.deliveryStatus,'screened');assert.notEqual(data.deliveryStatus,'legacy-preview-only');
   pinnedHash??=data.sourceSha256;assert.equal(data.sourceSha256,pinnedHash);
   deliveryEvents.push({offset:data.offset,returnedChars:data.returnedChars,deliveredChars:data.deliveredChars,status:data.deliveryStatus,nextReadOffset:data.nextReadOffset});
   withheldRows+=data.withheldChars>0?1:0;
   if(data.deliveredChars){assert.equal(data.offset,received.length);received+=data.content;}
   if(data.completeChunkDelivered&&data.fileTruncated===false){
    const records=received.trimEnd().split('\n').map(s=>JSON.parse(s));
    const content=`자료 ${records.length}건; 합계 ${records.reduce((sum,r)=>sum+r.value,0)}; 마지막 항목 ${records.at(-1).record}.`;
    return JSON.stringify({decision:'continue',summary:'관측 자료에서 계산한 결과 저장',actions:[{id:'write',title:'결과 저장',command:'result.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'result.txt'),content,allowOverwrite:false},dependencies:[],successSignal:'독립 정확 내용 검증'}],criteriaAssessment:[],question:null,blockedReason:null});
   }
   nextOffset=data.nextReadOffset;assert.equal(nextOffset,received.length);
   nextMax=data.deliveredChars===0?2000:6000;
  }
  return JSON.stringify({decision:'continue',summary:'전달된 범위 뒤 원문 계속 읽기',actions:[{id:'read-'+nextOffset,title:'자료 읽기',command:'source.jsonl 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(root,'source.jsonl'),offset:nextOffset,maxChars:nextMax},dependencies:[],successSignal:'G 원문 읽기 확인'}],criteriaAssessment:[],question:null,blockedReason:null});
 };
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'runtime'),env,taskEnv:env,missionRunner:runner,workerDaemonEnabled:false});
 const owner=runtime.personalOwnerSession.activate({requestedBy:'read-delivery-test',durationMinutes:5});
 const created=runtime.missionRuntime.createMission({objective:"'source.jsonl'를 읽고 핵심을 요약해 'result.txt'로 저장해줘",budgets:{maxWaves:30,maxPlannerCalls:40},successCriteria:[{criterionId:'result',statement:'별도 고정 기대 합계',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:expected}}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
 const result=await runtime.missionRuntime.runMission(created.missionId,{maxWaves:30});
 assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,observations:result.observations.map(o=>o.error)}));
 assert.equal(received,source);assert.equal(await readFile(join(root,'result.txt'),'utf8'),expected);
 const rawReads=result.observations.filter(o=>o.toolName==='filesystem.readText');
 assert.ok(rawReads.every(o=>o.data.textRead.content.length===o.data.readExtent.returnedChars));
 assert.ok(rawReads.every(o=>o.data.textRead.sourceSha256===createHash('sha256').update(source).digest('hex')));
 if(initialMax===50000)assert.ok(withheldRows>0,'first long range must exercise continuation of an undelivered tail');
 console.log(JSON.stringify({readDeliveryRuntimeEvidence:{initialMax,sourceChars:source.length,sourceBytes:Buffer.byteLength(source),receivedChars:received.length,steps,rawReads:rawReads.length,withheldRows,maxPromptObservations,deliveryEvents,status:result.status,output:expected,syntheticConsumer:true,cost:'unmeasured'}}));
});
