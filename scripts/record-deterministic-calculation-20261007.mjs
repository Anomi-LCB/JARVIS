import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/deterministic-calculation-20261007';
const read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString();
const suites=[['final',236],['paths',66],['currency',76]],names=new Set();
for(const [name,count] of suites){
 const log=read(`artifacts/money-comparison-20261007-${name}.txt`),runner=json(`artifacts/money-comparison-20261007-${name}-runner.json`);
 assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
 for(const [key,n] of [['tests',count],['pass',count],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${n}(?:\\r?\\n|$)`));
 for(const line of log.split(/\r?\n/u)){const match=/^✔ (.*) \([\d.]+ms\)$/u.exec(line);if(match)names.add(match[1]);}
}
assert.equal(names.size,303);
assert.match(read('artifacts/money-comparison-20261007-baseline.txt'),/ℹ fail 13(?:\r?\n|$)/);
assert.match(read('artifacts/money-comparison-20261007-build.txt'),/Built static JARVIS/);
assert.match(read('artifacts/money-comparison-20261007-contract.txt'),/gatePassed: true/);
const code=json('artifacts/v3021-code-refutation-current-20261007.json');
assert.equal(code.verdict,'no-blocking-defect-confirmed-in-examined-paths');
const spec=json('artifacts/v3021-spec-refutation-current-20261007-closure.json');
assert.equal(spec.verdict,'implemented-within-explicit-supported-deterministic-scope');
const line=read('artifacts/money-comparison-20261007-currency.txt').split(/\r?\n/u).find(l=>l.startsWith('{"lowerBoundHttpEvidence":'));
const lower=jsonFromLine(line);function jsonFromLine(value){return JSON.parse(value).lowerBoundHttpEvidence;}
assert.equal(lower.rows.length,6);assert.equal(lower.reservations,0);assert.equal(lower.effects,0);
assert.ok(lower.rows.every(r=>r.expected===r.actual));
const sourcePaths=['packages/core/src/mission/goal-money-expression.js','packages/core/src/mission/mission-money-dependency.js',
 'packages/core/src/mission/mission-commerce-source-gate.js','tests/goal-money-comparison.test.js','tests/mission-dependency-impact-journal.test.js',
 'tests/mission-commerce-source.test.js','scripts/semantic-contract-oracle.mjs','scripts/semantic-requirement-evaluation.mjs',
 'tests/semantic-contract-oracle.test.js','docs/deterministic-calculation-coverage.md','docs/mission-dependency-impact-api.md','docs/semantic-requirement-evaluation.md'];
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('matrix.json',{observedAt,coverageDocument:'docs/deterministic-calculation-coverage.md',categories:['date','timezone','quantity','amount','constraints'],
 assessmentDimensions:['positive-correct-calculation','boundary','unresolved-invalid','source-revision-change','actual-caller'],
 suites:suites.map(([name,count])=>({log:`artifacts/money-comparison-20261007-${name}.txt`,tests:count,passed:count,failed:0})),distinctTestNames:[...names].sort(),
 money:{currencies:['KRW','USD','EUR','GBP','JPY','KWD'],comparators:['lt','lte','gt','gte'],belowEqualAboveAssertions:72,lowerBoundHttp:lower},
 unknownsRemainUnverified:true,providerPriceOrChargeVerified:false,arbitraryFactPredicatesVerified:false,executionAuthority:false});
write('verification.json',{observedAt,originalGate:'V3-021',originalScopeVerified:true,baseline:{tests:26,failed:13},
 suites:suites.map(([name,tests])=>({name,tests,passed:tests,failed:0,skipped:0})),uniqueTests:303,
 buildPassed:true,coreContractPassed:true,independentCodeRefutation:code.verdict,independentSpecRefutation:spec.verdict,
 providerCalls:0,newPermissions:0,reservationsCreated:0,actualCost:null,installedProductActivated:false,newSemanticHoldoutCases:0,
 semanticFullCriteriaMet:false,formalBefore:59,formalAfter:60});
write('report.md',`# 결정형 계산 인수 완료와 금액 비교 확장

관측 ${observedAt}. 원래V3-021 인수 범위의 구현·실행·독립 감사가 충족돼 공식59→60/100으로 갱신한다. 목표70%는 아직 달성하지 않았다.

## 실제 개선

원문에서 파싱한 단일총액/총비용 조건을 lt/lte뿐 아니라 gte/gt로도 현재 원문·버전에 결속해 비교한다. KRW/USD/EUR/GBP/JPY/KWD 최소단위 정수를 사용하며 NaN·Infinity·음수·분수·정수범위초과·통화누락·불명통화는 실패로 남긴다. 기존 sourceMoney가NaN 선언을 통과시키거나 이미 인식한 하한 비교를 수행하지 못하던 개발 반례26검사 중13실패를 보존했다. 독립 반증에서 발견된 직접 helper의 누락통화 반례도 수정했다.

실제 격리 Core ADMIN HTTP→SQL 의존성 저장→현재영향 조회에서 USD70.00 이상/초과의6999/7000/7001을6개 독립 기대값과 대조했다. 새SQL읽기·익명401·원문revision변경거부·예약0·효과0을 확인했다. 하한이 통과해도 주문 경로는lt/lte 상한을 별도로 요구해 최소금액만으로 구매가 진행되지 않는다. 공급자가격/실제청구/결제 관측은미확인이다.

## 인수 검토와 검증

날짜·시간대·수량·금액·제약의 정상/경계/불명/원문정정/실제caller를 대조표에 연결했다. 실제Core/E/PC/G의 날짜 종료·시간 기한, 기록수·명시대상 배부계획·현재파일, 로컬workflow제약과 산출물 재검증이 포함된다. 모르는 제약을 사실로 인정하거나 전체PC 네트워크 감시로 표현하지 않는다.

공통236/236, 실제경로66/66, 통화보완관련76/76통과. 중복시험명을 제거한303고유검사·실패0·skip0이며 새의미평가303건이나 금액만303건이 아니다. build/Core계약도 통과했다. 별도감사와 code/spec 독립반증이 읽은 경로·검색·한계를 각JSON에 보존했다. 원래gate에 없는 임의 사실조건·설치본·실계정·30일을 추가조건으로 발명하지 않고, 해당 실사용gate는 남겨둔다.

## 의미평가 다음 단계

v3채점기에는 금액·시간·수량·조건·의존성·권한·결과의 선택적 주석오라클을 추가했다. 정답을 엔진에 전달하지 않고 정확JSON값/null/부재를 구분하며 차원별 미측정사례를 표시한다. 추가의미가 틀리면 행동 재현율100%여도 엄격사례는실패다. 기존코퍼스는7차원미측정이며 fullSemanticCriteriaMet:false다. 새26/260건·독립정답 적격성은 여전히미완료라 V3-024진행중을 유지한다.

비용은 전력·하드웨어미측정null, 외부유료/공급자호출0·새권한0이다. 운영서비스를 재시작하거나 설치본을 교체하지 않았다. 복원은 이번금액helper/sourceMoney/상한gate 변경을 함께 검토해 되돌리되 현재원문/통화/NaN검증을 제거하지 않는 방식이며 과거실패증거는보존한다. 다음은 V3-073의 Microsoft 직접수집 경로→공통Mission/E/B/G 연결과 V3-024 적격한 신규평가다.
`);
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-matrix.json`,
 'artifacts/money-comparison-20261007-baseline.txt','artifacts/money-comparison-20261007-final.txt','artifacts/money-comparison-20261007-paths.txt','artifacts/money-comparison-20261007-currency.txt',
 'artifacts/money-comparison-20261007-build.txt','artifacts/money-comparison-20261007-contract.txt','artifacts/v3021-code-refutation-current-20261007.json',
 'artifacts/v3021-spec-refutation-current-20261007-closure.json','artifacts/v3021-current-audit-20261007.json',
 'artifacts/money-comparison-20261007-final-runner.json','artifacts/money-comparison-20261007-paths-runner.json','artifacts/money-comparison-20261007-currency-runner.json'];
write('attempt.json',{id:'deterministic-calculation-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'원래 날짜/시간대/수량/금액/제약 인수에 필요한 결정형 지원계산·실제caller·독립기대값을 대조하고 파싱된 하한 비교 공백을 닫으면 해당gate를 완료할 수 있다.',
 lesson:'선언금액의 정확비교와 공급자가격/청구/권한을 구분한다. 지원하한계산을 확장해도 거래상한필수는 유지해야 한다. 완료기준을 원래scope보다 임의로 늘리거나 모의를실거래로 세지 않는다.',
 limitations:'V3-021지원결정형범위만완료·303고유회귀·격리HTTP/SQL/CorePCG·공식60%. 임의조건/실계정/설치/장기미완료. V3-0247차원주석은형식추가이며새26/260/전체의미미완료. 비용미측정.'});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,59);
const gate=gates.find(g=>g.id==='V3-021');assert.equal(gate.status,'in_progress');
gate.reviewHistory??=[];gate.reviewHistory.push({status:gate.status,evidence:structuredClone(gate.evidence),limitations:structuredClone(gate.limitations),reviewedAt:gate.reviewedAt??null,supersededAt:observedAt});
gate.status='verified';gate.reviewedAt=observedAt;gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07: 원래V3-021 지원결정형 범위의5유형/정상·경계·불명·원문정정·actualcaller 대조,금액lt/lte/gte/gt 및NaN/누락통화수정.303고유회귀/build/contract·독립code/spec감사완료. 공급자가격/청구/임의사실조건/실계정/설치/30일 인수와별개.');
const semantic=gates.find(g=>g.id==='V3-024');assert.equal(semantic.status,'in_progress');semantic.evidence.push(`${prefix}-source.json`,`${prefix}-verification.json`);
semantic.limitations.push('2026-10-07 후속: 7추가의미차원 선택주석오라클/정확값·부재·미측정집계·엄격사례 반영 추가,6개 개발회귀. 새26/260·독립정답적격성·전체의미미완료, fullSemanticCriteriaMet:false 유지.');
acceptance.updatedAt=observedAt;assert.equal(gates.filter(g=>g.status==='verified').length,60);writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: V3-0215유형 실제caller/계산matrix·단일총액4비교·NaN/누락통화보완·303고유회귀/build/contract·독립code/spec감사로verified. 공식60/100. V3-024추가7의미주석 오라클형식만·새26/260미완료. 다음V3-073 Microsoft직접수집 공통계약연결.\n`);
console.log(JSON.stringify({observedAt,verified:60,uniqueTests:303,evidenceCount:evidencePaths.length}));
