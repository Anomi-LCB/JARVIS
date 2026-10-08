import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {summarizeHealthRecords,buildHealthRecordReport} from '../packages/shared/src/health-record-summary.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const options={startDate:'2026-02-20',endDate:'2026-02-21',now:'2026-02-22T00:00:00Z'};
const measurement={sampleRateHz:2000,windowMs:100,electrodePlacement:'synthetic-left-TA',processing:'synthetic bandpass 10–450 Hz',amplitudeReference:'input_referred'};
const record={metric:'semg_rms',value:0.1,unit:'mV',observedAt:'2026-02-20T12:00:00+09:00',source:'synthetic-export',sensorId:'A',measurement};
for(const [unit,value] of [['mV',0.1],['V',0.0001],['uV',100],['µV',100],['μV',100]])test('sEMG physical unit '+unit,()=>{
 const sample=summarizeHealthRecords({...options,records:[{...record,unit,value}]}).metrics.semg_rms.samples[0];
 assert.equal(sample.value,100);assert.equal(sample.unit,'uV');assert.equal(sample.originalUnit,unit);assert.equal(sample.originalValue,value);
 assert.equal(sample.originalObservedAt,record.observedAt);assert.equal(sample.observedAt,'2026-02-20T03:00:00.000Z');
 assert.deepEqual(sample.measurement,measurement);assert.equal(sample.measurementConditionsVerified,false);assert.equal(sample.rawSignalProcessed,false);
});
test('sEMG conditions separate sources rather than manufacture comparable trends',()=>{
 const variants=[record,{...record,value:0.3},...Object.entries({sampleRateHz:1000,windowMs:200,electrodePlacement:'synthetic-right-TA',processing:'unfiltered',amplitudeReference:'device_output'}).map(([key,value])=>({...record,measurement:{...measurement,[key]:value}}))];
 const {summary,reportMarkdown}=buildHealthRecordReport({...options,records:variants});
 const series=summary.metrics.semg_rms.sourceSeries;
 assert.equal(series.length,6);assert.equal(series[0].daily[0].mean,200);assert.equal(series[0].daily[0].count,2);
 assert.ok(series.every(s=>s.comparabilityVerified===false));assert.deepEqual(summary.metrics.semg_rms.missingDates,['2026-02-21']);
 assert.match(reportMarkdown,/원시 파형 처리·근력·피로·질환 판단을 수행하지 않습니다/);assert.match(reportMarkdown,/device_output/);
 assert.equal(summary.diagnosisProvided,false);
});
test('unknown acquisition conditions remain unknown and safe report text preserves provenance',()=>{
 const {summary,reportMarkdown}=buildHealthRecordReport({...options,records:[{...record,measurement:undefined},{...record,measurement:{...measurement,processing:'<script>|\nexternal instruction'}}]});
 assert.deepEqual(Object.values(summary.metrics.semg_rms.samples[0].measurement),[null,null,null,null,null]);
 assert.equal(summary.metrics.semg_rms.sourceSeries.length,2);assert.ok(!reportMarkdown.includes('<script>'));assert.match(reportMarkdown,/&lt;script&gt;/);
});
for(const [name,change] of [
 ['percentage',{unit:'%'}],['ADC counts',{unit:'adc'}],['negative RMS',{value:-1}],['overflow',{unit:'V',value:Number.MAX_VALUE}],
 ['zero rate',{measurement:{sampleRateHz:0}}],['negative window',{measurement:{windowMs:-1}}],
 ['unknown reference',{measurement:{amplitudeReference:'normalized_mvc'}}],['implicit gain transform',{measurement:{gain:1000}}],
 ['verified claim',{measurement:{verified:true}}],['raw waveform',{metric:'semg_raw',value:1}],['prototype metric',{metric:'constructor'}]
])test('sEMG rejects '+name,()=>assert.throws(()=>summarizeHealthRecords({...options,records:[{...record,...change}]}),/health-record-invalid/));
test('changed conditions with same source record ID are a conflict',()=>{
 assert.throws(()=>summarizeHealthRecords({...options,records:[{...record,recordId:'one'},{...record,recordId:'one',measurement:{...measurement,windowMs:200}}]}),/identity-conflict/);
});
test('actual natural language Core/E/B/G creates and revalidates sEMG report',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-semg-mission-'));let runtime;
 try{
  const source=JSON.stringify({records:[record,{...record,value:0.3}]});await writeFile(join(root,'records.json'),source);
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env,taskEnv:env,workerDaemonEnabled:false,clock:()=>new Date(options.now),missionRunner:async()=>{throw new Error('No external model');}});
  const owner=runtime.personalOwnerSession.activate({requestedBy:'synthetic-semg-test',durationMinutes:5});
  const objective="'records.json' 건강 기록을 '2026-02-20'부터 '2026-02-21'까지 요약해 'report.md'에 저장하고 다시 읽어 확인해줘";
  const mission=runtime.missionRuntime.createMission({objective,successCriteria:[{criterionId:'current-report',statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
  const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});assert.equal(result.status,'COMPLETED',JSON.stringify(result.stopReason));
  const output=await readFile(join(root,'report.md'),'utf8');
  assert.match(output,/## semg_rms \(uV\)/);assert.match(output,/\| 2026-02-20 \| 2 \| 200 \| 100 \| 300 \|/);assert.match(output,/"sampleRateHz":2000/);
  assert.equal((await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId)).status,'verified');
  assert.equal(await readFile(join(root,'records.json'),'utf8'),source);
  await writeFile(join(root,'records.json'),JSON.stringify({records:[{...record,measurement:{...measurement,windowMs:200}}]}));
  assert.equal((await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId)).status,'changed-or-unavailable');
  console.log(JSON.stringify({actualCoreEBG:true,syntheticSemg:true,reportMean:200,changedConditionsInvalidated:true,realDevice:false}));
 }finally{
  runtime?.coreFacade.cognition.close();
  assert.equal(resolve(root).startsWith(resolve(tmpdir())+'\\'),true);assert.ok(basename(root).startsWith('jarvis-semg-mission-'));
  await rm(root,{recursive:true,force:true});
 }
});
