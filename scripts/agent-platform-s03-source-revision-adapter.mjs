import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testName = 'coalesced source revisions rerun after a stale workflow is compensated and publish only the latest report';
const percentile = (values,p) => { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]; };
function envFor(path) {
  const env={};
  for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','ComSpec','PATHEXT']) if(process.env[key]) env[key]=process.env[key];
  Object.assign(env,{JARVIS_TEST_MODE:'1',JARVIS_S03_EVIDENCE_PATH:path}); return env;
}
export function runS03SourceRevisionAdapter({outputRoot='artifacts/agent-platform-20260929/public-scenarios'}={}) {
  const observedAt=new Date().toISOString(); const runId=`${observedAt.replace(/[-:]/gu,'').replace(/\.\d{3}Z$/u,'Z')}-${randomUUID()}`;
  const runRelative=`${outputRoot}/S03-local-${runId}`; const runDirectory=resolve(root,runRelative); mkdirSync(runDirectory,{recursive:true});
  const measurements=[];
  for(let repetition=1;repetition<=3;repetition+=1) {
    const startedAt=new Date().toISOString(); const repRelative=`${runRelative}/repetition-${repetition}`; const rep=resolve(root,repRelative); mkdirSync(rep,{recursive:true});
    const evidence=resolve(rep,'evidence.json'); const oracleFile=resolve(rep,'oracle.json'); const log=resolve(rep,'adapter-test.log');
    let status='failed',stopCode=null,oracle=null;
    const child=spawnSync(process.execPath,['--test',`--test-name-pattern=${testName}`,'tests/source-revision-inbox.test.js'],
      {cwd:root,env:envFor(evidence),encoding:'utf8',timeout:30_000,windowsHide:true,maxBuffer:4*1024*1024});
    writeFileSync(log,`${child.stdout??''}${child.stderr??''}`,{encoding:'utf8',flag:'wx'});
    if(child.error||child.status!==0) stopCode=child.error?.code??`S03_TEST_EXIT_${child.status??'UNKNOWN'}`;
    else try {
      const output=execFileSync(process.execPath,['scripts/agent-platform-independent-oracle.mjs',evidence,oracleFile],
        {cwd:root,encoding:'utf8',timeout:10_000,windowsHide:true,env:envFor(evidence),maxBuffer:1024*1024});
      oracle=JSON.parse(output.trim().split(/\r?\n/u).at(-1)); status=oracle.status==='passed'?'completed':'failed';
      if(status!=='completed') stopCode='S03_ORACLE_FAILED';
    } catch(error) { stopCode=error?.code??'S03_ORACLE_ERROR'; }
    const finishedAt=new Date().toISOString(); const durationMs=Date.parse(finishedAt)-Date.parse(startedAt);
    measurements.push({scenarioId:'S03',adapterId:'s03-sqlite-source-revision-workflow-publication',
      executionMode:'durable-sqlite-coalescing-local-workflow-with-compensation-and-separate-process-oracle',repetition,startedAt,finishedAt,status,
      scenarioExecutionStatus:status==='completed'?'completed':'not-run',requirementResults:[
        {requirement:'입력 버전을 고정하고 실행 중 변경 시 오래된 publication을 보상한다',status,oracleCheckIds:['stale_revision_is_compensated_before_any_report_remains','input_and_artifact_hashes_are_recomputable']},
        {requirement:'중복·역순 이벤트를 억제하고 최신 revision을 완료한다',status,oracleCheckIds:['duplicate_and_reversed_events_are_observed','latest_revision_is_the_only_completed_revision']},
        {requirement:'최종 manifest가 현재 입력 내용과 일치한다',status,oracleCheckIds:['source_and_published_report_content_match','publication_manifest_binds_final_bytes']}
      ],evidencePaths:[`${repRelative}/adapter-test.log`,...(existsSync(evidence)?[`${repRelative}/evidence.json`]:[]),...(existsSync(oracleFile)?[`${repRelative}/oracle.json`]:[])],
      oracle:oracle?{status:oracle.status,name:oracle.oracle,independence:oracle.oracleIndependence,resultPath:`${repRelative}/oracle.json`,checks:oracle.checks}:null,
      durationMs,latencyMs:durationMs,providerCalls:0,networkRequests:0,externalWrites:0,retries:0,questions:null,approvals:null,costUsd:null,costMeasurement:'unmeasured',stopCode});
  }
  const outcome=measurements.every(item=>item.status==='completed')?'completed':measurements.some(item=>item.status==='failed')?'failed':'blocked';
  const report={schemaVersion:1,runId,observedAt,scenarioId:'S03',declaredFamily:'spark',mode:'public-scenario-local-latest-source-revision-publication-adapter',
    executionStatusChangedInCorpus:false,outcome,repetitionsPerConfiguration:3,measurementKind:'local-sqlite-revision-inbox-workflow-compensation-with-separate-process-semantic-oracle',measurements,
    counts:{total:3,completed:measurements.filter(item=>item.status==='completed').length,failed:measurements.filter(item=>item.status==='failed').length,
      blocked:measurements.filter(item=>item.status==='blocked').length,independentOracleRuns:measurements.filter(item=>item.oracle?.status==='passed').length},
    latencyMs:{p50:percentile(measurements.map(item=>item.latencyMs),.5),p95:percentile(measurements.map(item=>item.latencyMs),.95),unit:'ms',includes:'isolated source-event/workflow test plus separate-process oracle'},
    providerCalls:0,networkRequests:0,externalWrites:0,costUsd:null,costMeasurement:'unmeasured',limitations:[
      '파일 변경 이벤트는 테스트에서 주입했다. OS 파일 watcher, 파일 교체/네트워크 파일시스템 overflow 및 Core 서비스 설치 환경은 검증하지 않았다.',
      '합성 JSON 하나와 로컬 SQLite inbox/workflow adapter만 다룬다. 실행 중 도착한 변화는 다음 daemon tick에서 재실행한다.',
      '오라클은 분리된 프로세스의 고정 predicate이며 같은 저장소 코드다. 독립 인간 저자, 실계정, provider 비용은 미검증.'],
    evidence:{report:`${runRelative}/report.json`,summary:`${runRelative}/report.md`}};
  writeFileSync(resolve(runDirectory,'report.json'),`${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',flag:'wx'});
  const rows=measurements.map(item=>`| ${item.repetition} | ${item.status} | ${item.latencyMs}ms | ${item.oracle?.status??'not-run'} |`).join('\n');
  writeFileSync(resolve(runDirectory,'report.md'),`# S03 최신 입력 revision 발행 공개 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3, 별도 오라클 ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95}ms; provider/network/external writes 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n${report.limitations.map(item=>`- ${item}`).join('\n')}\n`,{encoding:'utf8',flag:'wx'});
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const report=runS03SourceRevisionAdapter();
  console.log(JSON.stringify({runId:report.runId,outcome:report.outcome,counts:report.counts,latencyMs:report.latencyMs,evidence:report.evidence},null,2));
}
