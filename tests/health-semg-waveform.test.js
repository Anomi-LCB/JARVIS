import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeHealthRecords,buildHealthRecordReport} from '../packages/shared/src/health-record-summary.js';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {CoreFacade} from '../packages/core/src/core-facade.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {fork} from 'node:child_process';
import {once} from 'node:events';
const options={startDate:'2026-02-20',endDate:'2026-02-21',now:'2026-02-22T00:00:00Z'};
const record={metric:'semg_raw',unit:'mV',observedAt:'2026-02-20T12:00:00+09:00',source:'synthetic-packet-export',sensorId:'synthetic-A',recordId:'wave-1',
 measurement:{sampleRateHz:1000,electrodePlacement:'synthetic-left',processing:'unfiltered',amplitudeReference:'device_output'},
 waveform:{firstSequence:10,expectedPacketCount:3,expectedSampleCount:6,packets:[{sequence:10,startSample:0,values:[-0.003,0.003]},{sequence:12,startSample:4,values:[-0.004,0.004]}]}};
const summarize=r=>summarizeHealthRecords({...options,records:[r]}).metrics.semg_raw.samples[0];
for (const [unit,value] of [['V',0.000003],['mV',0.003],['uV',3],['µV',3],['μV',3]]) test('raw signed unit '+unit,()=>{
 const r=structuredClone(record);r.unit=unit;r.waveform.packets=[{sequence:10,startSample:0,values:[-value,value]}];
 assert.equal(summarize(r).value,3);
});
test('raw packet gaps remain missing, signed voltages and provenance survive without implicit calibration',()=>{
 const original=structuredClone(record),sample=summarize(record),wave=sample.waveform;
 assert.deepEqual(record,original);assert.deepEqual(wave.packets[0].values,[-3,3]);assert.deepEqual(wave.packets[0].originalValues,[-0.003,0.003]);
 assert.equal(sample.value,Math.sqrt(12.5));assert.equal(sample.originalValue,null);assert.equal(sample.valueMeaning,'received-samples-rms');
 assert.equal(wave.receivedSampleCount,4);assert.equal(wave.missingSampleCount,2);assert.equal(wave.coverage,4/6);
 assert.deepEqual(wave.missingSampleRanges,[{startSample:2,endSampleExclusive:4}]);assert.deepEqual(wave.missingPacketSequences,[11]);
 assert.equal(wave.calibrationApplied,false);assert.equal(wave.filteringApplied,false);assert.equal(wave.interpolationApplied,false);assert.equal(wave.deviceConnectionVerified,false);
 assert.equal(sample.calibrationVerified,false);assert.equal(sample.originalObservedAt,record.observedAt);
 const {reportMarkdown}=buildHealthRecordReport({...options,records:[record]});
 assert.match(reportMarkdown,/수신 4\/6 표본 · 결측 2 표본/);assert.match(reportMarkdown,/누락 패킷 11/);assert.match(reportMarkdown,/0으로 채우지 않습니다/);
});
test('complete zero signal is a measured zero, not an inferred missing value',()=>{
 const r=structuredClone(record);r.waveform={firstSequence:0,expectedPacketCount:1,expectedSampleCount:3,packets:[{sequence:0,startSample:0,values:[0,0,0]}]};
 const s=summarize(r);assert.equal(s.value,0);assert.equal(s.waveform.coverage,1);assert.deepEqual(s.waveform.missingSampleRanges,[]);
});
test('edge missing ranges and packet sequences are explicit',()=>{
 const r=structuredClone(record);r.waveform.packets=[{sequence:11,startSample:2,values:[1]}];
 const wave=summarize(r).waveform;assert.deepEqual(wave.missingPacketSequences,[10,12]);
 assert.deepEqual(wave.missingSampleRanges,[{startSample:0,endSampleExclusive:2},{startSample:3,endSampleExclusive:6}]);
});
for(const [name,mutate] of [
 ['duplicate sequence',r=>r.waveform.packets[1].sequence=10],
 ['out of order',r=>r.waveform.packets.reverse()],
 ['sample overlap',r=>r.waveform.packets[1].startSample=1],
 ['sample overrun',r=>r.waveform.expectedSampleCount=5],
 ['packet range',r=>r.waveform.expectedPacketCount=2],
 ['negative origin',r=>r.waveform.firstSequence=-1],
 ['fractional origin',r=>r.waveform.packets[0].startSample=0.5],
 ['no packets',r=>r.waveform.packets=[]],
 ['nonfinite',r=>r.waveform.packets[0].values[0]=NaN],
 ['missing array element',r=>delete r.waveform.packets[0].values[0]],
 ['unsupported unit',r=>r.unit='adc'],
 ['aggregate value',r=>r.value=1],
 ['no sample clock',r=>delete r.measurement.sampleRateHz],
 ['unknown clock',r=>r.measurement.sampleRateHz=0],
 ['claimed device verification',r=>r.waveform.verified=true],
 ['future last sample',r=>r.observedAt=options.now],
 ['unbounded duration',r=>r.measurement.sampleRateHz=0.001],
 ['conversion overflow',r=>{r.unit='V';r.waveform.packets[0].values[0]=Number.MAX_VALUE;}]
])test('raw waveform rejects '+name,()=>{const r=structuredClone(record);mutate(r);assert.throws(()=>summarize(r),/health-record-invalid|health-waveform/);});
test('total waveform allocation is bounded even across records',()=>{
 const r=structuredClone(record);r.measurement.sampleRateHz=100_000;r.waveform={firstSequence:0,expectedPacketCount:1,expectedSampleCount:60_000,packets:[{sequence:0,startSample:0,values:Array(60_000).fill(0)}]};
 assert.throws(()=>summarizeHealthRecords({...options,records:[r,{...r,recordId:'two'}]}),/health-waveform-input-limit/);
});
test('same record identity with changed raw samples is a conflict; exact replay deduplicates',()=>{
 const changed=structuredClone(record);changed.waveform.packets[0].values[0]=1;
 assert.throws(()=>summarizeHealthRecords({...options,records:[record,changed]}),/identity-conflict/);
 assert.equal(summarizeHealthRecords({...options,records:[record,structuredClone(record)]}).duplicateRecordCount,1);
});
const cleanup=async root=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-waveform-'));await rm(root,{recursive:true,force:true});};
test('authenticated Core HTTP exposes raw packet summary and rejects mismatched metric',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-waveform-http-'));let server;
 try{
  server=createCoreServer(new CoreFacade({workspaceRoot:root}),{adminToken:'synthetic-waveform-admin'});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  const post=(records,token='synthetic-waveform-admin')=>fetch(`http://127.0.0.1:${server.address().port}/health-records/summary`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({records,startDate:options.startDate,endDate:options.endDate})});
  assert.equal((await post([record],'invalid')).status,401);const response=await post([record]);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.summary.metrics.semg_raw.samples[0].waveform.missingSampleCount,2);assert.equal(result.deviceConnectionVerified,false);
  assert.equal((await post([{...record,metric:'semg_rms',value:1}])).status,400);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await cleanup(root);}
});
test('natural Core E B G persists report and invalidates a changed raw packet on result retrieval',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-waveform-mission-'));let runtime;
 try{
  const source=JSON.stringify({records:[record]});await writeFile(join(root,'records.json'),source);
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env,taskEnv:env,workerDaemonEnabled:false,clock:()=>new Date(options.now),missionRunner:async()=>{throw Error('No external model');}});
  const owner=runtime.personalOwnerSession.activate({requestedBy:'synthetic-waveform-test',durationMinutes:5});
  const objective="'records.json' 건강 기록을 '2026-02-20'부터 '2026-02-21'까지 요약해 'report.md'에 저장하고 다시 읽어 확인해줘";
  const mission=runtime.missionRuntime.createMission({objective,successCriteria:[{criterionId:'current-report',statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
  const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});assert.equal(result.status,'COMPLETED',JSON.stringify(result.stopReason));
  assert.match(await readFile(join(root,'report.md'),'utf8'),/수신 4\/6 표본 · 결측 2 표본/);
  assert.equal((await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId)).status,'verified');assert.equal(await readFile(join(root,'records.json'),'utf8'),source);
  const changed=structuredClone(record);changed.waveform.packets[0].values[0]=0;await writeFile(join(root,'records.json'),JSON.stringify({records:[changed]}));
  assert.equal((await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId)).status,'changed-or-unavailable');
  console.log(JSON.stringify({actualCoreEBG:true,rawPacketMissing:2,sourcePreserved:true,changedRawInvalidated:true,realDevice:false,modelCalls:0}));
 }finally{runtime?.coreFacade.cognition.close();await cleanup(root);}
});
test('raw waveform report remains verified in a fresh PID and changed packets remain hidden after generator kill', {timeout:45000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-waveform-process-'));let active;
 const invoke=async(mode,missionId)=>{
  const child=fork(new URL('./fixtures/health-report-process.mjs',import.meta.url),[root,mode,...(missionId?[missionId]:[])],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});active=child;
  let stderr='';child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-2000);});
  const ended=once(child,'exit');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);
  try{
   const response=await Promise.race([once(child,'message').then(([message])=>message),ended.then(([code])=>{throw Error(`child ended ${code}: ${stderr}`);})]);
   assert.equal(response.error,undefined,JSON.stringify(response));if(mode==='generate')child.kill('SIGKILL');
   const [code]=await ended;if(mode!=='generate')assert.equal(code,0,stderr);active=null;return response;
  }finally{clearTimeout(timer);}
 };
 try{
  const source=JSON.stringify({records:[record]});await writeFile(join(root,'records.json'),source);
  const generated=await invoke('generate');assert.equal(generated.status,'COMPLETED');
  const before=await readFile(join(root,'missions.json'));
  const restored=await invoke('preview',generated.missionId);assert.notEqual(generated.pid,restored.pid);assert.equal(restored.preview.status,'verified');assert.match(restored.preview.reportMarkdown,/수신 4\/6 표본 · 결측 2 표본/);
  const changed=structuredClone(record);changed.waveform.packets[1].sequence=11;await writeFile(join(root,'records.json'),JSON.stringify({records:[changed]}));
  const stale=await invoke('preview',generated.missionId);assert.equal(stale.preview.status,'changed-or-unavailable');assert.equal(stale.preview.reportMarkdown,undefined);
  assert.deepEqual(await readFile(join(root,'missions.json')),before);
  console.log(JSON.stringify({actualProcessIds:[generated.pid,restored.pid,stale.pid],ownedGeneratorKilled:true,rawReportRecovered:true,changedPacketHidden:true,missionBytesPreserved:true,realDevice:false}));
 }finally{if(active&&active.exitCode===null&&active.signalCode===null){const ended=once(active,'exit');active.kill('SIGKILL');await ended;}await cleanup(root);}
});
