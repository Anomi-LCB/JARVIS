import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function percentile(values, p) { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] ?? null; }
function childEnv(evidencePath) {
  const env={};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','ComSpec','PATHEXT']) if (process.env[key]) env[key]=process.env[key];
  Object.assign(env,{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_G12_ORACLE_EVIDENCE_PATH:evidencePath});
  return env;
}

export function runG12HandoffAdapter({ outputRoot='artifacts/agent-platform-20260929/public-scenarios' }={}) {
  const observedAt=new Date().toISOString();
  const runId=`${observedAt.replace(/[-:]/gu,'').replace(/\.\d{3}Z$/u,'Z')}-${randomUUID()}`;
  const relative=`${outputRoot}/G12-local-${runId}`, directory=resolve(root,relative);
  mkdirSync(directory,{recursive:true});
  const measurements=[];
  for (let repetition=1; repetition<=3; repetition+=1) {
    const startedAt=new Date().toISOString(), repRelative=`${relative}/repetition-${repetition}`, repDir=resolve(root,repRelative);
    mkdirSync(repDir,{recursive:true});
    const evidencePath=resolve(repDir,'evidence.json'), oraclePath=resolve(repDir,'oracle.json'), logPath=resolve(repDir,'mission-test.log');
    let status='failed', stopCode=null, oracle=null;
    const child=spawnSync(process.execPath,['--test','--test-name-pattern=a failed researcher session is handed off to editor and verifier using the same Mission and G-verified artifact','tests/mission-runtime.test.js'],{
      cwd:root,env:childEnv(evidencePath),encoding:'utf8',timeout:45_000,windowsHide:true,maxBuffer:4*1024*1024
    });
    writeFileSync(logPath,`${child.stdout??''}${child.stderr??''}`,{encoding:'utf8',flag:'wx'});
    if (child.error || child.status!==0) stopCode=child.error?.code??`MISSION_TEST_EXIT_${child.status??'UNKNOWN'}`;
    else {
      try {
        const text=execFileSync(process.execPath,['scripts/agent-platform-independent-oracle.mjs',evidencePath,oraclePath],{cwd:root,encoding:'utf8',timeout:10_000,windowsHide:true,env:childEnv(evidencePath),maxBuffer:1024*1024});
        oracle=JSON.parse(text.trim().split(/\r?\n/u).at(-1)); status=oracle.status==='passed'?'completed':'failed';
        if(status!=='completed') stopCode='G12_HANDOFF_ORACLE_FAILED';
      } catch(error) { stopCode=error?.code??'G12_ORACLE_ERROR'; }
    }
    const finishedAt=new Date().toISOString(), durationMs=Date.parse(finishedAt)-Date.parse(startedAt);
    measurements.push({scenarioId:'G12',adapterId:'g12-local-role-handoff-mission',executionMode:'local-jarvis-mission-test-and-separate-process-oracle',repetition,startedAt,finishedAt,status,
      scenarioExecutionStatus:status==='completed'?'completed':'not-run',
      requirementResults:[
        {requirement:'실패한 조사자에서 편집자와 검증자로 같은 Mission을 인계',status,oracleCheckIds:['failed_researcher_handoff_is_durable','same_mission_completed','durable_mission_matches_runtime_result']},
        {requirement:'검증된 중간 결과와 동일 artifact를 재사용하고 모든 역할 관측을 G 검증',status,oracleCheckIds:['every_action_has_G_verified_observation','report_artifact_matches_expected_content']},
        {requirement:'한 개 결과 파일의 실제 bytes/hash 확인',status,oracleCheckIds:['artifact_bytes_match_expected','artifact_sha256_is_recomputable']}
      ],
      evidencePaths:[`${repRelative}/mission-test.log`,...(readJsonExists(evidencePath)?[`${repRelative}/evidence.json`]:[]),...(readJsonExists(oraclePath)?[`${repRelative}/oracle.json`]:[])],
      oracle:oracle?{status:oracle.status,name:oracle.oracle,independence:oracle.oracleIndependence,resultPath:`${repRelative}/oracle.json`,checks:oracle.checks}:null,
      durationMs,latencyMs:durationMs,providerCalls:0,networkRequests:0,externalWrites:0,retries:0,questions:null,approvals:null,costUsd:null,costMeasurement:'unmeasured',stopCode});
  }
  const report={schemaVersion:1,runId,observedAt,scenarioId:'G12',declaredFamily:'grok',mode:'public-scenario-local-role-handoff-mission-adapter',executionStatusChangedInCorpus:false,
    outcome:measurements.every(x=>x.status==='completed')?'completed':measurements.some(x=>x.status==='failed')?'failed':'blocked',repetitionsPerConfiguration:3,
    measurementKind:'local-real-Mission-runtime-fixed-role-handoff-test-with-separate-process-oracle',measurements,
    counts:{total:3,completed:measurements.filter(x=>x.status==='completed').length,failed:measurements.filter(x=>x.status==='failed').length,blocked:measurements.filter(x=>x.status==='blocked').length,independentOracleRuns:measurements.filter(x=>x.oracle?.status==='passed').length},
    latencyMs:{p50:percentile(measurements.map(x=>x.latencyMs),.5),p95:percentile(measurements.map(x=>x.latencyMs),.95),unit:'ms',includes:'local Mission test + separate-process oracle'},
    providerCalls:0,networkRequests:0,externalWrites:0,costUsd:null,costMeasurement:'unmeasured',
    limitations:['실제 Grok/Muse/Spark provider를 부르지 않았다. Mission test는 고정된 합성 자료와 규칙기반 fixture다.','oracle은 별도 프로세스·별도 predicate이나 같은 저장소에서 작성했으며 독립 인간 평가가 아니다.','실제 외부 역할 worker, 일반 문서, 사용자의 앱 종료/재시작을 시험하지 않았다. 이 테스트는 같은 프로세스에서 새 runtime instance를 다뤘다.','공개 corpus의 status는 변경하지 않았다. 비용·사용자 질문/승인은 UI에 연결하지 않아 미측정이다.'],
    evidence:{report:`${relative}/report.json`,summary:`${relative}/report.md`}};
  writeFileSync(resolve(directory,'report.json'),`${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',flag:'wx'});
  const table=measurements.map(x=>`| ${x.repetition} | ${x.status} | ${x.latencyMs} ms | ${x.oracle?.status??'not-run'} |`).join('\n');
  writeFileSync(resolve(directory,'report.md'),`# G12 역할 인계 공개 시나리오 로컬 실행\n\n관측: ${observedAt}\n\n- 결과: ${report.outcome} (${report.counts.completed}/3)\n- 로컬 Mission과 별도 프로세스 oracle; provider/network/external writes 0; 비용 미측정\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${table}\n\n## 한계\n\n${report.limitations.map(x=>`- ${x}`).join('\n')}\n`,{encoding:'utf8',flag:'wx'});
  return report;
}
function readJsonExists(path) { try { readFileSync(path); return true; } catch { return false; } }
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) { const r=runG12HandoffAdapter(); console.log(JSON.stringify({runId:r.runId,outcome:r.outcome,counts:r.counts,latencyMs:r.latencyMs,evidence:r.evidence},null,2)); }
