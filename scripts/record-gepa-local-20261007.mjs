import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/gepa-local-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString(),gepa=JSON.parse(read(`${prefix}/comparison.json`)),hermes=JSON.parse(read('artifacts/hermes-local-20261007/comparison.json'));
const optimization=JSON.parse(read(`${prefix}/optimization.json`)),corpus=readFileSync('tests/fixtures/gepa-summary-20261007.json');
const sha=createHash('sha256').update(corpus).digest('hex');
assert.equal(gepa.corpusSha256,sha);assert.equal(hermes.corpusSha256,sha);assert.equal(gepa.reflectionCalls,1);
assert.equal(optimization.total_metric_calls,5);assert.equal(gepa.seed,gepa.best);
assert.equal(gepa.holdout.length,8);assert.equal(hermes.rows.length,8);
const entries=[...gepa.holdout,...hermes.rows];
const scenarios=JSON.parse(corpus).cases,results=[];
for(const config of ['baseline','gepa','hermes','gepa-rejected-proposal']){
 const rows=entries.filter(r=>r.configuration===config);assert.equal(rows.length,4);
 for(const row of rows){
  const expected=scenarios.find(c=>c.id===row.id).expected;
  assert.equal(row.completed,row.report.status==='COMPLETED'&&row.report.output===JSON.stringify(expected));
  assert.equal(row.report.model.localModel.digest,gepa.modelDigest);
  assert.ok(row.report.actions.every(a=>['filesystem.searchFiles','filesystem.readText','filesystem.createTextFile'].includes(a.toolName)));
  assert.equal(row.report.externalPaidCalls,0);
 }
 const times=rows.map(r=>r.report.totalMs).sort((a,b)=>a-b);
 results.push({configuration:config,total:4,completed:rows.filter(r=>r.completed).length,failed:rows.filter(r=>!r.completed).length,
  p50Ms:times[1],p95Ms:times[3],totalProviderCalls:rows.reduce((s,r)=>s+r.report.model.providerCalls,0),
  inputTokens:rows.reduce((s,r)=>s+r.report.model.usage.inputTokens,0),outputTokens:rows.reduce((s,r)=>s+r.report.model.usage.outputTokens,0),
  actualCost:null,userQuestions:0,userApprovals:0,retries:rows.reduce((s,r)=>s+Math.max(0,r.report.model.attempts.length-1),0)});
}
for(const [key,count] of [['tests',24],['pass',24],['fail',0],['skipped',0]])assert.match(read(`${prefix}-regression.txt`),new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const cleanup=JSON.parse(read(`${prefix}-cleanup.json`));assert.equal(cleanup.parentPresent,false);assert.equal(cleanup.runnerPresent,false);assert.equal(cleanup.listenerPresent,false);
const tool=JSON.parse(read(`${prefix}-hermes-tool-evidence.json`));assert.equal(tool.status.isError,false);assert.equal(tool.search.isError,false);
const files=['tests/fixtures/gepa-summary-20261007.json','scripts/gepa-local-comparison-20261007.py','scripts/gepa-summary-evaluate-20261007.mjs',
 'scripts/hermes-local-comparison-20261007.mjs','scripts/local-summary-mission-pilot.mjs','packages/core/src/mission/local-source-summary.js',
 'packages/core/src/mission/ollama-local-model-provider.js'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)})),
  packageWheelSha256:createHash('sha256').update(readFileSync('.runtime/gepa-eval-20261007/wheels/gepa-0.1.4-py3-none-any.whl')).digest('hex'),
  runtimeSourceConditions:'Initial Python process loaded before num_gpu:0 addition; first V1/D2 Node calls used automatic backend discovery. Later Node subprocesses use explicit CPU. No corpus/oracle change. Post-run source hashes are reproducibility, not proof of unchanged launch bytes.'});
const evidencePaths=[`${prefix}/comparison.json`,`${prefix}/optimization.json`,`${prefix}/evaluations.jsonl`,`${prefix}/reflections.json`,
 'artifacts/hermes-local-20261007/comparison.json',`${prefix}-hermes-context.json`,`${prefix}-hermes-tool-evidence.json`,`${prefix}-run.txt`,
 'artifacts/hermes-local-20261007-run.txt',`${prefix}-regression.txt`,`${prefix}-build.txt`,`${prefix}-contract.txt`,`${prefix}-cleanup.json`,
 'artifacts/gepa-20261007-freeze.txt','artifacts/gepa-20261007-model.json','artifacts/gepa-20261007-ollama-stderr.txt',`${prefix}-source.json`];
write('verification.json',{observedAt,gepaLibraryExecuted:true,officialPackage:'gepa==0.1.4',metricEvaluations:5,actualReflectionCalls:1,
  hermesModulesObservedVersion:'0.21.1',hermesStoredAndRetrievedSession:'codex-eb688d0b-cdaf-4dac-b4fb-2827b0250197',
  fixedCorpusSha256:sha,holdoutCases:4,fullMissionExecutions:16,completed:entries.filter(r=>r.completed).length,
  falseCompletion:0,externalEffects:0,adoption:false,productActivation:false,results,regression:{tests:24,passed:24,failed:0,skipped:0},
  upstreamWholeAgentPerformanceMeasured:false,expertSemantic26or260Measured:false,cost:null,
  scopeAudit:{requirement:'Hermes/GEPA 개선 후보와 기존 방식의 독립 비교를 수행한다.',
   actualCandidates:'Real GEPA reflection proposal/selection and reviewed actual Hermes project lesson.',
   independentComparison:'Frozen source-fact holdouts withheld from reflection and lessons, same Core/E/B/G file Mission and independent fixed oracle.',
   preservedBoundaries:'No evaluator/authority/permission changes; no paid APIs, real accounts or personal profile.',
   satisfied:true,meaning:'Comparison completed. Improvements failed adoption; this is not proof of superior learning or general task reliability.'}});
const table=results.map(r=>`|${r.configuration}|${r.completed}/4|${(r.p50Ms/1000).toFixed(2)}秒|${(r.p95Ms/1000).toFixed(2)}秒|${r.totalProviderCalls}|${r.inputTokens}/${r.outputTokens}|`).join('\n');
write('report.md',`# 실제 Hermes·GEPA 후보와 기존 방식 비교\n\n관측 ${observedAt}. V3-092의 비교 수행 인수를 완료해 공식56/100이다. 후보 개선 성공률이나 일반 자율성 56%가 아니다.\n\n## 실제 실행 범위\n\n[GEPA 공식 구현](https://github.com/gepa-ai/gepa)의 PyPI0.1.4 MIT wheel을 고정해 별도 venv에 설치하고 optimize_anything을 실행했다. 로컬 gemma3:latest 4.3B Q4_K_M, digest ${gepa.modelDigest}, 실제 개발 평가5회·반성 모델1회를 사용했다. 외부 LLM 응답을 모의로 작성하지 않았다. CPU3threads/temperature0/typed JSON, 반성은 실제 모델 출력에서 프롬프트만 받아 원래 코드를 실행하지 않는다. GEPA는 한 제안의 개발 점수가 개선되지 않아 거절하고 원래 seed를 유지했다.\n\n실제 NousResearch Hermes0.21.1 MemoryStore/SessionDB/skill_manage 모듈의 프로젝트 경험 저장·검색을 호출해 session codex-eb688d0b-cdaf-4dac-b4fb-2827b0250197을 회수했다. 현재 개발 D2/검증 V1에서 관측한 결과와 과거 실패 보고서를 구분한 일반 지침이다. 사람 프로필/비밀번호/다른 ChatGPT 대화를 가져오지 않았다. Hermes standalone agent가 학습·실행한 것이 아니라 실제 경험 저장·검색 모듈의 검토된 지침을 후보 문맥에 넣은 비교다. 결과를 사용자 업무 F/cognition의 실제 경험으로 복제하지 않는다.\n\n## 정답·학습·실행 분리\n\n실행 전 개발2/검증1/홀드아웃4 입력과 원문 사실 오라클을 동결했다. GEPA 반성에는 개발 피드백만, Hermes 지침에는 개발/기존 보고서의 일반 교훈만 전달했다. 홀드아웃 정답은 모델 요청에 전달하지 않는다. 오라클·권한·실행 정책은 후보가 수정하지 못한다. 원래 연구 코퍼스와130/520 명령 정답을 수정하지 않았다. 작성자 합성4건으로 독립 전문가26/260 평가나 실계정 점수를 대신하지 않는다.\n\n홀드아웃은 악성 문서 지시와 견적/실지출, 최초/최종 정정, 임시/최종 검증 상태, 전체/부분 인원을 포함한다. 기존 실제 Core/E/B/G 파일 Mission에서 발견→읽기→모델 사실 요약→저장→다시 발견→읽기→최종 원문/고정 오라클 판정을 수행했다. 각 완료는 파일 내용과 고정 정답에 일치한다. 단순 파일 존재나 모델의 완료 발언을 인정하지 않는다.\n\n## 결과 — 실패도 포함\n\n|구성|완료|전체 Mission p50|전체 Mission p95|provider HTTP 호출|입력/출력 tokens|\n|---|---:|---:|---:|---:|---:|\n${table}\n\n모든 분모를 유지했다. 16 Mission에서6완료·10미완료, 잘못된 완료0이다. 실제 유료 API0·요금0, 전기/하드웨어/총비용은 미측정이다. 각 profile의 providerCalls는 catalog+generation HTTP를 함께 기록하며 2호출을 2추론으로 해석하지 않는다. 질문/승인0은 격리 Mission의 기존 명시 위임 조건이지 일반 사용자 개입0 보장도 아니다.\n\nGEPA-selected는 원래 seed와 완전히 같다. 그럼에도 두 실행에서 H4 응답이 달라 각각1/4와2/4였다. 반성 제안의 별도 홀드아웃도2/4, Hermes는1/4다. 네 사례·순차 캐시·로딩 및 동일 프롬프트 응답 차이 때문에 우열/속도 향상/학습 효과를 주장하지 않는다. 모든 구성에서 필수 요구 미일치가 남아 승격하지 않는다.\n\nH1은 실제 지출0을 견적920000으로 읽거나 승인 상태를 필요 이상으로 복사했다. H3은 최종 미검증을 임시 검증됨으로 반환했다. H4는 일부 실행에서 응답자21을 전체58로 바꿨다. 숫자가 인용 안에 있어도 질문에 맞는 값이라는 뜻이 아니다. 최종 G는 오답을 PAUSED로 남겼다. 하지만 일부 오답 초안 파일은 생성됐다. 따라서 초안 저장 안전성과 전체 의미 검증은 추가 개선 대상이며 해당 요약 인수 V3-059를 완료시키지 않는다.\n\n## 환경 관측 정정\n\n초기 자동 탐색에서 Vulkan GT710 메모리 적합성을 계산했지만 최종 로그는 offloaded0/35였다. GPU가 실제21층을 계산했다고 주장하지 않는다. 첫 자동 로딩 약63초, 뒤 명시적 num_gpu0 로딩 약19초와 입력 속도 차이가 있다. 콜드/웜·옵션·OS캐시가 달라 CPU/GPU 인과 비교는 아니다. 초기 V1/D2와 반성은 최초 Python/Node 소스 조건, 이후 Node 및 전체 Mission은 명시CPU 조건이다. 변경된 실행 조건과 처음 로그를 보존했다. 제품 기본 스레드/GPU/모델 설정은 바꾸지 않았다.\n\n## 인수 감사와 한계\n\nV3-092의 원문은 ‘Hermes/GEPA 개선 후보와 기존 방식의 독립 비교를 수행한다’다. 실제 모듈/실제 SDK·실제 반성 생성, 학습 미공개 사실 오라클의 전체 Mission 비교, 실패/시간/호출/tokens/미측정 비용, 권한 분리와 미승격 결과를 모두 기록했다. 그래서 이 비교 수행 항목만 verified로 판정한다. 개선 후보는 failed/inconclusive이고 실생활 신뢰성·전체 Hermes agent·온라인 자동학습·독립 전문가 평가가 완료된 것이 아니다. 나머지99항목의 범위를 줄이지 않는다.\n\n관련 의미/인용/숫자/실제 Mission/로컬 모델 계약 회귀24/24·fail0/skip0, 빌드/Core 계약 통과. 테스트 서버의 실제 소유 exe/PID를 확인해 모델을 내려 부모/runner/11436 listener 부재까지 관측했다. 기존 운영 서비스/설치본/워드/한글 프로세스는 변경하지 않았다.\n\n## 다음 행동과 복원\n\n예정액/실제 지출, 임시/최종 상태, 전체/부분 값의 질문 적합성을 현재 구조화 sourceFields 경로와 독립 판정으로 연결한다. 모델의 자기 확신이나 프롬프트 지침 추가만으로 이 오류를 해결됐다고 하지 않는다. 이후 비교에는 새 홀드아웃을 동결한다. 현재4건은 개발에 노출됐으므로 독립 holdout으로 재사용하지 않는다. 후보는 평가 전용이라 운영 모델을 되돌릴 변경이 없다. 실제 Hermes 교훈은 정정/삭제 가능한 프로젝트 경험이며 업무 권한이 아니다. 프롬프트 후보/오라클/로그를 보존하고 불합격 후보를 자동 활성화하지 않는다.\n`);
evidencePaths.push(`${prefix}-verification.json`,`${prefix}-report.md`);
write('attempt.json',{id:'gepa-local-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'comparison',reportedOutcome:'failed',observedAt,evidencePaths,
  hypothesis:'실제 GEPA 반성과 Hermes 경험 지침이 한국어 요약 Mission의 의미 보존과 전체 시간을 개선한다.',
  lesson:'실제 공식GEPA5평가/1반성과16Mission 비교에서6완료/10미완료. 저장/검색이나 지침 변경은 의미 정확성을 보장하지 않는다. 후보는 미승격, 비교 수행 인수만 완료했다.',
  limitations:'합성 개발2/검증1/홀드아웃4·로컬Gemma/명시CoreE/B/G·Hermes 모듈. 실계정/전체Hermesagent/260전문가평가/장기/총비용/성능우열 미검증.'});
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(path)),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,55);
const gate=gates.find(g=>g.id==='V3-092');assert.equal(gate.status,'pending');
assert.equal(gate.requirement,'Hermes/GEPA 개선 후보와 기존 방식의 독립 비교를 수행한다.');
gate.status='verified';gate.evidence.push(...evidencePaths);gate.reviewedAt=observedAt;
const limitations=['2026-10-07 실제Hermes0.21.1모듈/GEPA0.1.4/로컬반성1·평가5·동결4홀드아웃16실제CoreE/B/G 비교 완료.6완료/10미완료·후보미승격. 비교 수행 인수이며 자동학습 향상/실생활 신뢰도/전체Hermesagent/전문가260/총비용 증명은 아니다.'];
gate.limitations.push(...limitations);(gate.reviewHistory??=[]).push({status:'verified',evidence:evidencePaths,limitations,reviewedAt:observedAt});
acceptance.updatedAt=observedAt;writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제GEPA5평가/1반성·Hermes경험저장/조회·4홀드아웃16CoreE/B/G비교6완료/10미완료·후보미승격·24회귀/build/contract. 원래V3-092 비교수행 인수 verified→공식56. 다음 실제 의미 실패의 질문/원문 사실 결속과 구조화 경로 확장.\n`);
console.log(JSON.stringify({observedAt,verified:56,completedComparison:'V3-092',fullMissionExecutions:16,candidateActivation:false}));
