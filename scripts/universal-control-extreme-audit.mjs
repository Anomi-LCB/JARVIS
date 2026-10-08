import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCorpus, validateCorpus, renderMarkdown, OUTPUT } from './universal-control-extreme-corpus.mjs';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';
import { runLocalPositiveControl } from './universal-control-local-positive.mjs';
import { runMissingInputControl } from './universal-control-local-missing-input.mjs';
import { runLocalDuplicateFileControl } from './universal-control-local-file-duplicates.mjs';
import { createEvidenceRun, writeEvidence, evidenceReference, summarizeProductRuns } from './lib/universal-control-evidence.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const percentile=(values,p)=>values.length?values[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
const states=['완료','사전 조건 차단','정보 확인 필요','사용자 인계','실패'];

// This only checks declarations against the SAME authored baseline model.
// It is neither an independent oracle nor execution of the user's command.
export function evaluateReadinessDeclaration(testCase,variant,expectedStatus) {
  const predicted=testCase.class==='safety-boundary'?'사용자 인계':testCase.class==='positive-control'?(variant==='missing-prerequisite'?'사전 조건 차단':'완료'):testCase.readinessAtBaseline==='local-limited'?'정보 확인 필요':'사전 조건 차단';
  return {caseId:testCase.id,variant,expectedStatus,predictedStatus:predicted,declarationConsistent:predicted===expectedStatus,productExecuted:false,requirementsVerified:0,independentOracle:false};
}

export function renderAuditMarkdown(report) {
  const {overall:o}=report,p=o.localProduct;
  return [
    '# 극한 자연어 평가 — 선언·라우팅·제품 실행 분리', '',
    `- 관측 시각: ${report.generatedAt}`,
    `- 코퍼스: ${report.corpusVersion} / SHA-256 ${report.corpusSha256}`,
    '- 기존 증거를 덮어쓰지 않은 이번 실행의 결과다. 모의 예상 완료와 실제 완료는 합산하지 않는다.', '',
    '| 측정 | 결과 |', '|---|---|',
    `| 코퍼스 원명령 | ${o.cases} |`,
    `| readiness 선언 일관성 | ${o.readinessConsistent} / ${o.readinessSlots} (제품 실행 0) |`,
    `| 실제 lane classifier 호출 | ${o.classifierCalls} |`,
    `| 공개 개발 회귀 lane 일치 | ${o.developmentRegressionLaneCorrect} / ${o.developmentRegressionCases} |`,
    `| 미사용 독립 홀드아웃 | ${o.untouchedHoldoutCases} (아직 없음) |`,
    `| 원명령 전체 요구 완료 | ${p.originalCorpusCasesCompleted.length} / ${o.cases} |`,
    `| 실제 로컬 양성 부분 시험 | ${p.positiveControls.passed} / ${p.positiveControls.attempted} |`,
    `| 실제 로컬 실패조건 시험 | ${p.faultControls.passed} / ${p.faultControls.attempted} |`,
    `| 관측 Mission 상태 | ${Object.entries(p.observedMissionStates).map(([status,count])=>`${status} ${count}`).join(', ')} |`,
    `| 서로 다른 실제 adapter | ${p.uniqueAdapterCount} (${p.adaptersExercised.join(', ')||'없음'}) |`,
    `| 실계정 / 실기기 | ${p.liveAccountsTested} / ${p.liveDevicesTested} |`,
    `| 요구사항 의미 보존율 | 미측정 |`,
    `| classifier p50 / p95 | ${o.classifierLatencyMs.p50} / ${o.classifierLatencyMs.p95} ms |`,
    `| 로컬 제품 run p50 / p95 | ${o.localProductLatencyMs.p50} / ${o.localProductLatencyMs.p95} ms (작은 표본) |`,
    '| 비용 | 미측정 |', '',
    '## 실제 제품 부분 시험', '', '| ID | 부모 명령 | 결과 | Mission | 미검증 범위 |', '|---|---|---|---|',
    ...report.productRuns.map(run=>`| ${run.caseId} | ${run.parentCaseId} | ${run.productPass?'통과':'실패'} | ${run.missionStatus} | ${run.coverage.notCovered.join('; ')} |`), '',
    '## 해석', '', ...report.findings.map(value=>`- ${value}`), '',
    '각 result.json과 전체 Mission 결과는 evidenceManifest.json의 경로와 SHA-256으로 연결된다. 해시는 파일 변경 감지이며 실험 결론의 독립 검증을 대신하지 않는다.', ''
  ].join('\n');
}

export async function runExtremeAudit({outputBase=OUTPUT,quiet=false}={}) {
  const started=performance.now();
  const corpus=await generateCorpus(),errors=validateCorpus(corpus);
  if(errors.length)throw new Error(`Corpus validation failed: ${errors.join('; ')}`);
  const output=await createEvidenceRun(outputBase,'audit');
  const readinessResults=[],laneResults=[];
  for(const c of corpus.cases) {
    const scenarios=[{id:'nominal',text:c.command,expected:c.expectedStatus},...c.faultVariants.map(v=>({id:v.id,text:`${c.command}\n[격리 시험 조건] ${v.condition}`,expected:v.expected}))];
    for(const scenario of scenarios) {
      readinessResults.push(evaluateReadinessDeclaration(c,scenario.id,scenario.expected));
      const began=performance.now(),route=classifyCommandLane(scenario.text);
      laneResults.push({caseId:c.id,variant:scenario.id,lane:route.lane,stages:route.stageIds,reasonCodes:route.reasonCodes,latencyMs:Number((performance.now()-began).toFixed(3)),productExecuted:false});
    }
  }
  const developmentRegressionResults=corpus.developmentRegression.map(c=>{
    const route=classifyCommandLane(c.command);
    return {id:c.id,expectedLane:c.expectedLane,lane:route.lane,matched:route.lane===c.expectedLane,evaluationRole:'development-regression',previouslyUsedForTuning:true,requirementsVerified:0};
  });
  // Fresh isolated Mission runs: never import a prior productPass verdict as today's test.
  const productRuns=[];
  productRuns.push(await runLocalPositiveControl({outputBase:output,quiet:true}));
  productRuns.push(await runMissingInputControl({outputBase:output,quiet:true}));
  productRuns.push(await runLocalPositiveControl({outputBase:output,quiet:true,untrustedInput:true}));
  productRuns.push(await runLocalDuplicateFileControl({outputBase:output,quiet:true}));
  const localProduct=summarizeProductRuns(productRuns);
  const laneTimes=laneResults.map(item=>item.latencyMs).sort((a,b)=>a-b);
  const productTimes=productRuns.map(item=>item.elapsedMs).filter(Number.isFinite).sort((a,b)=>a-b);
  const overall={cases:corpus.cases.length,readinessSlots:readinessResults.length,readinessConsistent:readinessResults.filter(item=>item.declarationConsistent).length,classifierCalls:laneResults.length,developmentRegressionCases:developmentRegressionResults.length,developmentRegressionLaneCorrect:developmentRegressionResults.filter(item=>item.matched).length,untouchedHoldoutCases:0,semanticRequirementPreservation:'미측정',requirementOmissions:'미측정',requirementsDeclared:corpus.cases.reduce((total,c)=>total+c.requirementCount,0),classifierLatencyMs:{p50:percentile(laneTimes,.5),p95:percentile(laneTimes,.95)},localProductLatencyMs:{p50:percentile(productTimes,.5),p95:percentile(productTimes,.95)},localProduct,elapsedMs:Number((performance.now()-started).toFixed(3))};
  const byDomain=corpus.domainDefinitions.map(domain=>{
    const cases=corpus.cases.filter(c=>c.domainId===domain.id);
    return {domainId:domain.id,domain:domain.name,cases:cases.length,expectedStatuses:Object.fromEntries(states.map(state=>[state,cases.filter(c=>c.expectedStatus===state).length])),actualCompleteOriginalCases:localProduct.originalCorpusCasesCompleted.filter(id=>id.startsWith(`${domain.id}-`)).length};
  });
  const findings=[
    '520건은 readiness 선언 일관성 검사와 lane 분류 호출이다. 520건의 실제 업무나 독립 안전 검증을 실행한 것이 아니다.',
    '종전 홀드아웃 26건은 분류기 수정에 사용됐으므로 공개 개발 회귀로 재분류했다. 새로운 독립 홀드아웃은 아직 없다.',
    '코퍼스 요구사항은 영역별 템플릿에서 생성됐다. 명령별 의미 오라클 구현이 완료되지 않아 1,092개 요구 충족 또는 95% 의미 보존을 주장하지 않는다.',
    'D01-02.local-exact-duplicates는 세 개 텍스트 파일의 exact-content 중복 부분 시험이다. 대용량·오래된 파일·격리 목록·복구 명령이라는 원요청 전체 완료는 아니다.',
    'D01-09의 원래 한국어 명령과 엄격한 CSV 전체 행 오라클을 유지했다. 불필요한 value 별칭 열을 내보내던 자연어 컴파일 경로를 수정했다. 코퍼스의 전체 템플릿 요구까지 검증한 것은 아니므로 원명령 전체 완료로 집계하지 않는다.',
    '누락 자료 시험에서 BLOCKED는 기대된 방어 동작 통과이며 사용자 업무 완료가 아니다.',
    '비신뢰 문구 시험은 LLM 없이 CSV 문자열을 처리한 결과다. 모델·브라우저 prompt injection 방어의 증거가 아니다.',
    '외부 행동 수는 이 로컬 workflow의 도구 영수증 범위다. 호스트 전체 네트워크 감사는 수행하지 않았다.',
    '명령 성공 수, 실패조건 처리 수, 서로 다른 adapter 수를 별도로 집계한다. 동일 workflow.execute의 반복은 adapter 하나다.'
  ];
  const report={schemaVersion:'2.0.0',generatedAt:new Date().toISOString(),output,corpusVersion:corpus.schemaVersion,corpusSha256:corpus.sha256,executionMode:'readiness-declarations; actual-lane-classifier; fresh-isolated-local-product-subcases',productionActivation:false,overall,byDomain,readinessResults,laneResults,developmentRegressionResults,productRuns,findings};
  await writeEvidence(path.join(output,'commands.json'),corpus);
  await writeEvidence(path.join(output,'commands.md'),renderMarkdown(corpus));
  await writeEvidence(path.join(output,'audit-report.json'),report);
  await writeEvidence(path.join(output,'report.md'),renderAuditMarkdown(report));
  const evidenceFiles=['commands.json','audit-report.json',...productRuns.flatMap(run=>['result.json','mission-created.json','mission-result.json'].map(file=>path.relative(output,path.join(run.root,file))))];
  const sourceFiles=['scripts/universal-control-extreme-audit.mjs','scripts/universal-control-extreme-corpus.mjs','scripts/universal-control-local-positive.mjs','scripts/universal-control-local-missing-input.mjs','scripts/universal-control-local-file-duplicates.mjs','scripts/lib/universal-control-evidence.mjs','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/criteria-evidence.js','packages/core/src/mission/natural-workflow-compiler.js','packages/shared/src/command-lane.js','apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js'];
  await writeEvidence(path.join(output,'evidenceManifest.json'),{schemaVersion:1,observedAt:report.generatedAt,interpretation:'integrity and provenance, not independent experiment validation',evidence:await Promise.all(evidenceFiles.map(file=>evidenceReference(path.join(output,file)))),sources:await Promise.all(sourceFiles.map(file=>evidenceReference(path.join(ROOT,file))))});
  if(!quiet)console.log(JSON.stringify({output,...overall},null,2));
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runExtremeAudit().then(report=>{if(report.overall.localProduct.failedRuns||report.overall.developmentRegressionLaneCorrect!==report.overall.developmentRegressionCases)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
