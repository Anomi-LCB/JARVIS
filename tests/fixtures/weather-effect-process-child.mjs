import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {mkdirSync,writeFileSync,existsSync,appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [root,mode,format='hwpx']=process.argv.slice(2),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
const inputPath=join(workspace,'source.txt'),outputPath=join(workspace,format==='hwpx'?'document.hwpx':'document.hwp');
if(!existsSync(inputPath))writeFileSync(inputPath,'original synthetic archive source');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),args={path:outputPath,verifyRendering:false,location:'서울'};
const clock=()=>new Date(mode.startsWith('resume')?'2026-10-07T11:22:00Z':'2026-10-07T11:20:00Z');
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const store=new SqliteMissionStore({operationsStore:operations}),authority=mode.startsWith('authority')?new MissionExecutionAuthority({store}):null;authority?.activate({expectedToken:0,heartbeat:false});
const runtime=createAgRuntime({missionStore:store,memoryStore,clock,...(authority?{missionExecutionAuthority:authority}:{}),allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
 trustSigningSecret:'synthetic-archive-fixture-key-not-production',env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
 missionPlanner:{async planNextWave(context){return context.observations.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceObservationIds:context.observations.map(o=>o.observationId)}))}:
 {decision:'continue',actions:[{id:'hancom',command:`'${outputPath}' 지역: 서울 향후 7일 날씨 통계를 한글 보고서로 만들어줘`,expectedToolName:'weather.createHwpReport',arguments:args,dependencies:[],requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId)}]};}}});
const stop=async boundary=>{const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];process.send({type:'boundary',boundary,pid:process.pid,operationId:action?.operation?.operationId,effectId:action?.effect?.effectId});await new Promise(r=>process.once('message',r));};
runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(mode===boundary)await stop(boundary);};
runtime.pcAgent.remoteOperationBoundary=async boundary=>{if(mode==='b-receipt'&&boundary==='workflow-receipt-persisted')await stop(mode);};
const adapter=runtime.pcAgent.registry.get('weather.createHwpReport'),execute=adapter.execute.bind(adapter);
adapter.weatherClient={async weeklyForecast(){appendFileSync(join(root,'fetches.jsonl'),'fetch\n');return reportFixture();}};
adapter.execute=async(...values)=>{const result=await execute(...values);if(mode==='forged'&&result.status==='success'){result.document={...result.document,title:'unrequested'};result.hwpxDocument=result.document;result.artifactManifest={...result.artifactManifest,document:result.document};}appendFileSync(join(root,'calls.jsonl'),JSON.stringify({status:result.status})+'\n');return result;};
if(mode==='partial'){
 const record=runtime.pcAgent.undoJournal.record.bind(runtime.pcAgent.undoJournal);
 runtime.pcAgent.undoJournal.record=(...values)=>{const result=record(...values);process.send({type:'boundary',boundary:'partial',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
}
const verify=runtime.orchestrationWorker.verifyExecution.bind(runtime.orchestrationWorker);
runtime.orchestrationWorker.verifyExecution=async(...values)=>{const result=await verify(...values);if(result.status!=='passed')appendFileSync(join(root,'verification-failures.jsonl'),JSON.stringify(result)+'\n');return result;};
process.send({type:'ready',pid:process.pid});
process.once('message',async()=>{try{
 const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective:'지역: 서울 향후 7일 날씨 통계를 한글 보고서로 만들어줘',authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'Hancom 확인',verificationSpec:{version:1,kind:'file.exists',path:outputPath}}]});
 if(mode==='resume-changed')writeFileSync(outputPath,'synthetic changed');
 if(mode==='resume-source-changed'){const artifact=[...runtime.missionRuntime.missions.values()][0].waves[0].actions[0].effect;const plan=store.getEffect(artifact.effectId).intent.request.artifactPlan;writeFileSync(plan.paths[1],'changed preview');}
 const result=await runtime.missionRuntime.runMission(mission.missionId),action=result.waves[0]?.actions[0];
 process.send({type:'result',pid:process.pid,status:result.status,stopReason:result.stopReason,recovery:action?.recovery,verificationFailures:existsSync(join(root,'verification-failures.jsonl'))?readFileSync(join(root,'verification-failures.jsonl'),'utf8'):null,lastError:action?.lastError??action?.requirementCoverage,
  effect:action?.effect?.effectId?store.getEffect(action.effect.effectId):null,outputExists:existsSync(outputPath),sourceSha256:hash(readFileSync(inputPath)),task:runtime.coreFacade.getTask(action?.taskId),
  bClaims:runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n,
  keys:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.dryRun===false&&r.toolName==='weather.createHwpReport').map(r=>r.idempotencyKey)});
 runtime.coreFacade.cognition.close();memoryStore.close();operations.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;process.disconnect();}});

function forecastFixture() {
  const dates = Array.from({ length: 7 }, (_, index) => `2026-09-0${index + 1}`);
  return {
    timezone: 'Asia/Seoul',
    timezone_abbreviation: 'GMT+9',
    daily_units: {
      temperature_2m_max: '°C',
      precipitation_probability_max: '%',
      precipitation_sum: 'mm',
      wind_speed_10m_max: 'km/h'
    },
    daily: {
      time: dates,
      weather_code: [0, 1, 2, 3, 61, 80, 0],
      temperature_2m_max: [24, 25, 26, 27, 28, 29, 30],
      temperature_2m_min: [14, 15, 16, 17, 18, 19, 20],
      precipitation_probability_max: [0, 10, 20, 30, 70, 80, 10],
      precipitation_sum: [0, 0, 0, 0, 3.2, 8.5, 0],
      wind_speed_10m_max: [5, 6, 7, 8, 9, 10, 11],
      sunrise: dates.map((date) => `${date}T06:00`),
      sunset: dates.map((date) => `${date}T19:00`)
    }
  };
}

function reportFixture() {
  const fixture = forecastFixture();
  const days = fixture.daily.time.map((date, index) => ({
    date,
    weekday: ['화', '수', '목', '금', '토', '일', '월'][index],
    weatherCode: fixture.daily.weather_code[index],
    weatherLabel: ['맑음', '대체로 맑음', '대체로 맑음', '흐림', '비', '비', '맑음'][index],
    temperatureMax: fixture.daily.temperature_2m_max[index],
    temperatureMin: fixture.daily.temperature_2m_min[index],
    precipitationProbabilityMax: fixture.daily.precipitation_probability_max[index],
    precipitationSum: fixture.daily.precipitation_sum[index],
    windSpeedMax: fixture.daily.wind_speed_10m_max[index],
    sunrise: fixture.daily.sunrise[index],
    sunset: fixture.daily.sunset[index]
  }));
  return {
    reportVersion: 'jarvis-weather-weekly-report-v1',
    query: '서울',
    location: { name: '서울', displayName: '서울특별시, 대한민국' },
    timezone: 'Asia/Seoul',
    units: { temperature: '°C', precipitationProbability: '%', precipitation: 'mm', windSpeed: 'km/h' },
    days,
    statistics: {
      averageHigh: 27,
      averageLow: 17,
      highestTemperature: 30,
      lowestTemperature: 14,
      totalPrecipitation: 11.7,
      rainyDayCount: 2,
      maximumPrecipitationProbability: 80,
      maximumWindSpeed: 11
    },
    source: {
      provider: 'Open-Meteo',
      geocodingProvider: 'JARVIS 한국 주요 도시 좌표 사전',
      geocodingAttribution: null,
      forecastUrl: 'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978',
      retrievedAt: '2026-08-30T00:00:00.000Z'
    }
  };
}

