import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runResearchLedger} from './research-ledger.mjs';
const prefix='artifacts/semantic-engine-shape-20261007';
const read=p=>readFileSync(p,'utf8');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString();
assert.match(read(`${prefix}-baseline.txt`),/ℹ fail 1(?:\r?\n|$)/);
for(const [key,value] of [['tests',34],['pass',34],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
const status=runResearchLedger(['status']);
write('ledger-review.json',{observedAt,candidateCount:status.candidateCount,watch:status.latestWatch,
 candidates:status.candidates?.map(c=>({id:c.id,nextReason:c.nextReason,attempts:c.attemptCount,
  evidenceIssues:(c.attempts??[]).flatMap(a=>(a.evidence??[]).filter(e=>e.integrity!=='intact'||e.sourceIntegrity!=='intact'))}))??[],
 note:'File integrity and reported experiment outcome are not independent evaluation.'});
const sourcePaths=['scripts/semantic-requirement-evaluation.mjs','tests/semantic-requirement-evaluation.test.js','docs/semantic-requirement-evaluation.md'];
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json';
const acceptance=JSON.parse(read(acceptancePath)),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;
assert.equal(verified,59);
write('verification.json',{observedAt,baseline:{tests:7,passed:6,failed:1},final:{tests:34,passed:34,failed:0,skipped:0},
 malformedOutputVariants:6,additionalEmptyOutputCase:1,formalVerified:verified,
 productExecuted:false,productActivated:false,newHoldoutCases:0,fullSemanticCriteriaMet:false,externalCalls:0,actualCost:null});
write('report.md',`# 잘못된 계약 반환으로 의미평가가 중단되는 결함 수정

관측 ${observedAt}. 공식 인수59/100 유지. 이번 변경은 오프라인 평가기의 오류 처리이며 제품 자연어 이해 향상이나26/260개 새 의미평가 완료가 아니다.

이전 평가기는 null 응답을 파싱 실패로 세지 않았고, requirements 또는 개별 원문/해석 객체가 잘못되면 채점 도중 전체 평가가 중단될 수 있었다. 개발 반례7검사에서1실패를 먼저 보존했다. 이제 반환 계약을 사례 안에서 검증하고 잘못된 응답은 명시적인 EVALUATION_ENGINE_CONTRACT_INVALID로 기록하며 해당 사례의 요구 전부를0점으로 분모에 남긴다. 다음 사례의 채점은 계속한다. 빈 목록은 별도 요구 누락0점이며 잘못된 정답 주석의 실행 거부는 유지한다.

null·빈 객체·잘못된 목록·null 요구·숫자 원문·null 해석의6종 반환과 빈 목록을 검사했다. 평가기7검사 및 실제 goal-contract27검사, 총34/34통과·실패0·skip0. 이는 개발 회귀이며 새로운 독립 정답이나 실제 업무 완료 관측이 아니다. 외부 유료 호출0, 전력/하드웨어 비용 미측정null, F/cognition·사용자 계정·운영 서비스 변경0.

출처 감시6곳 변화0·오류0, 후보 동기화 변경0이다. [Inspect 공식 채점 안내](https://inspect.aisi.org.uk/scoring.html)를 확인해 실패 처리와 지표 정책을 구분했다. Inspect 설치 또는 성능 재현은 하지 않았다. 장부 조회 결과는 별도 요약에 보존했으며 해시는 바이트 보존만 뜻한다.

앞선 Gemma v2 작성은06:54:58.978Z에 실패했으므로 원장의 오래된 “작성 진행중” 이후 상태를 새 한계 기록으로 정정했다. 새26/260건과 전체 금액·시각·조건·의존성·권한·결과 의미 검증은 여전히 미완료다. 다음은 적격한 독립 주석을 준비하고 전체 의미 오라클을 확장하는 작업이다. 복원은 이번 반환 검증과 해당 오류 처리만 검토해 제거하는 방식이며 이전 실패 증거는 보존한다.
`);
const evidencePaths=['report.md','verification.json','source.json','baseline.txt','baseline-runner.json','final.txt','final-runner.json','ledger-review.json'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'semantic-engine-shape-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'contract-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'잘못된 실행 엔진 반환을 사례별 실패로 기록하면 평가가 중단되거나 실패가 분모에서 빠지는 문제를 막을 수 있다.',
 lesson:'정답 입력 오류와 제품 엔진 출력 오류를 분리해야 한다. null과 잘못된 반환은 전체 사례0점·명시 실패로 기록하고 이후 사례를 유지한다.',
 limitations:'개발 반례7·goal27 회귀34/34. 새26/260·전체 의미 오라클·독립 전문가·실사용 미완료, 공식59%. 동기 엔진 한정·실제 비용 미측정·제품/계정 변경0.'});
const gate=gates.find(g=>g.id==='V3-024');assert.equal(gate.status,'in_progress');
gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 후속: 앞선Gemma v2 작성은06:54:58.978Z 실패로 종료, 작성진행중 아님. 잘못된 엔진 반환6종/빈목록의 분모 보존·후속사례 유지 수정,34/34 회귀. 새26/260·전체의미·독립전문가·실사용 미완료.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 잘못된 의미평가 엔진 반환의 오류 처리·전체 분모/후속 사례 유지,34회귀 통과. 공식59%. Gemma v2는 종료실패이며 새26/260·전체 의미 오라클이 남음.\n`);
console.log(JSON.stringify({observedAt,verified,tests:34,evidenceCount:evidencePaths.length}));
