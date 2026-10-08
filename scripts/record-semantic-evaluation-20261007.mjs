import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/semantic-evaluation-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(s,v)=>writeFileSync(`${prefix}-${s}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
for(const [k,v] of [['tests',30],['pass',30],['fail',0],['skipped',0]])assert.match(read('artifacts/semantic-holdout-20261007-scorer.txt'),new RegExp(`ℹ ${k} ${v}(?:\\r?\\n|$)`));
assert.match(read('artifacts/semantic-holdout-20261007-build.txt'),/Built static JARVIS/);
const failure=JSON.parse(read('artifacts/semantic-holdout-20261007-author/failure.json'));
assert.equal(failure.accepted,0);assert.equal(failure.productEvaluations,0);
const response=JSON.parse(read('artifacts/semantic-holdout-20261007-author/response-0.json'));
const sourcePaths=['scripts/author-semantic-holdout-20261007.mjs','scripts/semantic-requirement-evaluation.mjs','tests/semantic-requirement-evaluation.test.js','docs/semantic-requirement-evaluation.md'];
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,scorerRegressionTests:30,passed:30,failed:0,authorBaseline:'failed',authorBaselineAcceptedCases:0,
 authorBaselineProductEvaluations:0,authorElapsedMs:response.elapsedMs,authorModel:'gemma3:latest',plannedHoldoutCases:26,
 plannedExpandedCases:260,holdoutCriteriaMet:false,formalVerified:59,humanExpertReview:false,paidProviderCalls:0,actualCost:null});
write('report.md',`# 독립 의미평가 작성·채점 경로와 실제 작성 실패

관측 ${observedAt}. 공식 인수59/100 유지. V3-024를 착수 상태로 변경했으며26/260건 완료나95% 의미 보존을 주장하지 않는다.

## 구현한 평가 계약

별도 작성 세션에 JARVIS 구현·기존 테스트·기존 정답을 제공하지 않는다. 합성 명령만 생성하고 제품 호출·계정 권한·개인 기억을 사용하지 않는다. 실제 로컬 Ollama와 설치된 Gemma3 4.3B Q4_K_M을 사용했다. model digest는 model.json에 보존했다. 기존 gemma3가 존재한다는 것을 확인했고 새 모델을 내려받거나 cloud 모델을 호출하지 않았다.

주석의 text는 원문 위치·순서에 정확히 결속해야 하며 잘못된 자료는 거부한다. 평가 전에 corpus 바이트를 고정한다. 평가기는 기대 정답을 제품 엔진에 넘기지 않으며 행동·대상·금지를 각각 대조한다. 여러 요구를 하나의 미해석 문자열로 유지하거나 원문만 복사해도 통과시키지 않는다. parse 실패·잘못된 대상·잘못된 금지는 모두 분모에 남는다. 비용은 미측정 null이다.

## 실제 실패와 수정 경로

첫 작성 요청은 실제 모델 HTTP200, 약${Math.round(response.elapsedMs)}ms였다. 하지만 모델이 command에 한국어 복합 명령 대신 read/delete를 넣고 서로 무관한 긴 requirements.text를 작성했다. JSON이 유효해도 정답 주석이 원문에 없으므로 accepted0·제품 평가0으로 거부했다. 원문을 주석으로 조립해 정상인 척하거나 해당 자료를260건 평가에 복제하지 않았다. 원본 응답·요청·당시 작성 소스·오류를 모두 보존했다.

수정된 작성 경로는 자연어 문장 생성과 고정 원문에 대한 정답 주석을 두 모델 요청으로 분리한다. 기존 실패 자료를 지우지 않고 새 v2 출력 디렉터리에 실행했다. 기록 시 v2 작성은 진행 중이므로 완성·품질을 이 보고서의 성공으로 계산하지 않는다. 해당 실행의 실제 프로세스 상태와 새 결과를 다음 단계에서 확인해야 한다.

## 검증 범위

채점기3개 검사와 기존 goal contract27개, 합계30/30 통과. 행동·대상·금지 각각의 오답을 잡고, 원문 통째로 복사한 미해석 응답은0점, 중복ID·잘못된 gold span은 검사 자체를 거부하며 모든 엔진 실패는 분모에 남겼다. 정답이 엔진 인자로 전달되지 않았음을 검사했다. build 통과. 작성 v2 소스는 구문 검사를 통과했으나 완료한 작성 성공이 아니다.

이 점수의 대상은 단위 요구·행동·대상·금지이며 금액·시각·조건·의존성 전체나 실제 실행 완료가 아니다. 별도 모델 문맥은 인간 전문가/완전 blind의 대체 증거가 아니다. 공식 [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)의 JSON schema 경로를 사용했지만 형식 제약만으로 의미 정답이 보장되지 않음을 실제로 확인했다.

## 다음 인수와 복원

v2 결과의 실제 원문 주석을 검토하고 동결한26개를 평가한다. 전체 의미 조건과 독립 주석 검토를 갖춘260개 확대 평가가 남았다. 노출된 실패를 개발에 사용하면 개발 회귀로 분류하며 미노출 평가를 새로 유지한다. 사용자의70% 목표를59%나 이 평가기 구현으로 완료시키지 않는다.

복원은 새 작성기·채점기·문서를 제거하는 코드 복원이며, 기존 Core 실행·인수 정답·사용자 자료·F/cognition은 바꾸지 않았다. 이 작업에서 생성한 합성 자료를 실제 사용자 경험 기억으로 넣지 않는다. 파일 무결성은 기록 보존 검사이지 의미 평가의 독립 검증이 아니다.
`);
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,
 'artifacts/semantic-holdout-20261007-scorer.txt','artifacts/semantic-holdout-20261007-scorer-runner.json','artifacts/semantic-holdout-20261007-build.txt',
 'artifacts/semantic-holdout-20261007-author/author-source-v1.json','artifacts/semantic-holdout-20261007-author/author-contract.json',
 'artifacts/semantic-holdout-20261007-author/model.json','artifacts/semantic-holdout-20261007-author/request-0.json',
 'artifacts/semantic-holdout-20261007-author/response-0.json','artifacts/semantic-holdout-20261007-author/failure.json',
 'artifacts/semantic-holdout-20261007-author-v2/author-contract.json'];
write('attempt.json',{id:'semantic-evaluation-20261007-author-failure',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'failed',observedAt,evidencePaths,
 hypothesis:'독립 작성 모델의 JSON schema 출력과 원문결속 검사로 고정 의미평가 자료를 작성할 수 있다.',
 lesson:'실제 모델의 JSON성공은 유효한 평가 정답이 아니다. 명령을 행동분류로 오해한 응답의 주석을 원문위치 검사가 거부했다. 문장 생성과 원문 주석을 분리해 다음 시도를 진행한다.',
 limitations:'작성 baseline 실제Gemma1요청·accepted0·제품평가0. 채점기/goal계약30검사·build 통과와 작성 성공은 별개. v2진행중/26및260·인간전문가·전체의미·실사용 미검증. 공식59%.'});
const path='docs/universal-control-v3-acceptance.json',data=JSON.parse(read(path)),gates=data.stages.flatMap(s=>s.gates);assert.equal(gates.filter(g=>g.status==='verified').length,59);
const gate=gates.find(g=>g.id==='V3-024');assert.equal(gate.status,'pending');
gate.reviewHistory??=[];gate.reviewHistory.push({status:gate.status,evidence:structuredClone(gate.evidence),limitations:structuredClone(gate.limitations),reviewedAt:gate.reviewedAt??null,supersededAt:observedAt});
gate.status='in_progress';gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 별도Gemma작성 첫시도 원문불일치로accepted0·채점기/goal30검사/build. v2작성 진행중; 26/260·전체의미·독립전문가·실사용 미완료.');gate.reviewedAt=observedAt;
data.updatedAt=observedAt;writeFileSync(path,JSON.stringify(data,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: V3-024착수·정답미전달 채점기·실Gemma 작성실패accepted0 보존/2단계v2진행·30회귀/build.59% 유지. 다음 실제v2원문주석 동결26/260·전체의미 독립검토.\n`);
console.log(JSON.stringify({observedAt,verified:59,authorAccepted:0,scorerTests:30}));
