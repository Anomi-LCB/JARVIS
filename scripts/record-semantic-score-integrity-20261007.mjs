import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/semantic-score-integrity-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const json=p=>JSON.parse(read(p));
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const failure=json('artifacts/semantic-holdout-20261007-author-v2/failure.json');
assert.equal(failure.accepted,2);assert.equal(failure.productEvaluations,0);
assert.equal(existsSync('artifacts/semantic-holdout-20261007-author-v2/corpus.json'),false);
assert.equal(existsSync('artifacts/semantic-holdout-20261007-author-v2/freeze.json'),false);
assert.match(read(`${prefix}-baseline.txt`),/ℹ fail 2(?:\r?\n|$)/);
for(const [key,value] of [['tests',32],['pass',32],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final-v2.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
for(const path of ['artifacts/v3-024-code-refutation-20261007.json','artifacts/v3-024-spec-refutation-20261007.json'])json(path);
const files=['scripts/semantic-requirement-evaluation.mjs','tests/semantic-requirement-evaluation.test.js','docs/semantic-requirement-evaluation.md'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptance=json('docs/universal-control-v3-acceptance.json');
const gates=acceptance.stages.flatMap(s=>s.gates),verified=gates.filter(g=>g.status==='verified').length;
assert.equal(verified,59);
write('verification.json',{observedAt,authorFailureObservedAt:failure.observedAt,authorOutcome:'failed',structurallyAcceptedDrafts:2,adjudicatedGoldCases:0,productEvaluations:0,
  baselineTests:5,baselineFailures:2,finalTests:32,finalFailures:0,holdout26Completed:false,expanded260Completed:false,formalVerified:verified,
  productActivated:false,paidProviderCalls:0,actualCost:null,originalResearchWatchChanged:0,
  remaining:['gold semantic adjudication','full semantic dimensions','new frozen 26 and 260 case evaluation']});
write('report.md',`# 의미평가 오채점 수정과 두 단계 작성 실패 기록

관측 ${observedAt}. 공식 인수59/100 유지. 평가 코드 수정이며 제품의 의미 이해 향상이나 실사용 완료 증거는 아니다.

## 실제 작성 실패

v2 로컬 Gemma 작성은 ${failure.observedAt}에 원문 주석 불일치로 종료됐다. 두 문장은 길이·enum·span 구조 검사만 통과했으며 금지와 요구 범위 등이 누락됐다. 독립 정답으로 승인된 문장은0, 제품 평가0이다. 다음 영역에서 과거 사실 서술을 생성하고 주석에서 원문을 바꿨다. corpus/freeze 파일은 없으며 실패 자료를 정상 코퍼스로 바꾸거나 확대 복제하지 않았다.

## 수정과 검증

개발 반례5검사 중2실패를 기록했다. 미해결 상태에 우연히 올바른 action/target/polarity가 있으면 보존2/2로 오채점하던 경로를 수정했다. 지원 행동은 recognized 상태를 요구한다. 추가로 꾸며낸 요구는 재현율과 별도로 precision·추가 요구 수·엄격 사례 통과율에 반영한다. 원래 요구를 모두 맞춰 재현율100%라도 추가 요구가 있으면 엄격 사례 통과율0이다. 전체 의미 미측정 차원과 fullSemanticCriteriaMet:false를 결과·CLI에 명시했다.

채점기5검사와 기존 goal contract27검사, 합계32/32 통과. 실제 모델26/260의 품질 점수가 아니며 개발 회귀다. 변경은 오프라인 평가 코드와 문서에 한정돼 제품 서비스·설치본·실제 계정·F/cognition을 바꾸지 않았다. 제품 build나 설치본 인수는 이번 수정의 증거로 계산하지 않는다.

## 독립 감사와 연구

V3-024 단일 요구를 별도 문맥에서 감사하고 코드·원래 문서 관점의 독립 반증을 보존했다. 이전 상태 검사 결함은 수정됐지만 작성 자료의 의미 적격성·금액/시간/조건/의존성/권한·결과의 전체 의미 오라클과26/260건이 여전히 남았다. 현재 원장과 기존 문서는 부분 구현을 명시해 허위 완료 판정은 하지 않았다.

출처 감시는6곳 변화0·오류0, 후보 동기화 변경0이었다. 기존 실패에서 출발해 공식 [Anthropic 평가 안내](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)(2026-10-07 확인)를 다시 검토했다. 실행 기록·채점·실제 결과를 분리하는 원칙을 적용했으며 해당 제품의 우열이나 성능 재현을 주장하지 않는다.

## 다음 작업과 복원

같은 Gemma 작성 과정을 그대로 반복하지 않는다. 전체 요구 주석·의미 적격성·독립 검토를 먼저 갖춘 뒤 새 자료를 동결해야 한다. 노출된 두 사례와 이번 반례는 개발 자료이며 새로운 미노출 평가를 대신하지 않는다. 복원은 이번 채점기 상태 조건과 추가 지표 변경만 코드 리뷰로 되돌리는 방식이다. 원래 실패 보고서는 보존한다. 비용은 전력·하드웨어 미측정 null이다. 파일 해시는 바이트 보존이며 평가 결론의 독립 검증이 아니다.
`);
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-baseline.txt`,`${prefix}-baseline-runner.json`,`${prefix}-final-v2.txt`,`${prefix}-final-runner-v2.json`,
 'artifacts/v3-024-spec-check-20261007.json','artifacts/v3-024-spec-check-20261007.md','artifacts/v3-024-code-refutation-20261007.json','artifacts/v3-024-spec-refutation-20261007.json',
 'artifacts/semantic-holdout-20261007-author-v2/failure.json','artifacts/semantic-holdout-20261007-author-v2/validated-0.json',
 'artifacts/semantic-holdout-20261007-author-v2/response-1-commands.json','artifacts/semantic-holdout-20261007-author-v2/response-1-annotation-0.json','artifacts/semantic-holdout-20261007-author-v2/response-1-annotation-1.json'];
write('attempt.json',{id:'semantic-score-integrity-20261007-v2-failure',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'failed',observedAt,evidencePaths,
 hypothesis:'문장 생성과 주석 생성을 나누면 독립 의미평가26건을 적격한 골드와 함께 완성할 수 있다.',
 lesson:'v2도 과거 사실 문장과 원문 재작성으로 실패했다. 구조 accepted2는 의미 정답이 아니다. 평가기의 추정값 오채점도 재현해 recognized 상태와 precision/엄격통과/미측정 차원을 추가했다.',
 limitations:'작성실패·독립정답0·제품평가0. 수정 회귀32/32와 제품 의미 능력은 별개. 전체26/260·의미 적격성·실계정·실사용 미완료. 비용 미측정·공식59%. 독립 코드/문서 반증은 해당 V3-024 범위에 한정.'});
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: v2작성 최종실패·구조accepted2/독립정답0/제품평가0·오채점2반례 수정/32회귀·독립감사/반증. 공식59% 유지. 다음 전체 의미 주석 적격성·미노출26/260 검증.\n`);
console.log(JSON.stringify({observedAt,verified,finalTests:32,authorOutcome:'failed',productEvaluations:0}));
