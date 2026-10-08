import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/money-source-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const final=read(`${prefix}-final-v3.txt`);
for(const [key,value] of [['tests',133],['pass',133],['fail',0],['skipped',0]])assert.match(final,new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-first.txt`),/ℹ fail 11/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const files=['packages/core/src/mission/mission-money-dependency.js','tests/mission-dependency-impact-journal.test.js','docs/mission-dependency-impact-api.md'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:133,passed:133,failed:0,skipped:0,initialFailed:11,focusedJournalCases:23,buildPassed:true,contractGatePassed:true,
 executionScope:'actual-SQL-Core-ADMIN-HTTP-read-only-dependency-projection',sourceMoneyExecutionAuthority:false,quoteAndReceiptBindingVerified:false,realTransactions:0,actualCost:null,productLatencyPercentiles:null,productActivationVerified:false});
write('report.md',`# Mission 원문 총액 한도와 명시적 금액 연결의 대조\n\n관측 ${observedAt}. 공식 인수55/100 유지.\n\n기존 연결은 위임 예산만 검사하여, 원문이 총액6000원 이하인데 선언 금액7000원이 연결되어도 current로 표시했다. 최초20검사 중 새11검사가 실패했으며 로그를 보존했다.\n\n서버가 연결 등록 시 현재 원문 해시·목표 revision·금액 조건 존재 여부를 함께 저장한다. 영향 조회에서는 원문에서 금액을 다시 추출하여 총액/총비용으로 시작하는 독립 절의 단일 이하/미만 한도를 같은 통화 최소 단위로 대조한다. 미만의 경계값, USD 소수 단위, 통화 충돌, 모호한 달러, 건당/누적/복수 금액과 comparator 부재는 각각 확인하거나 재검토로 남긴다. 캐시 숫자 변경, 원문 정정과 금액 조건 삭제는 기존 연결을 우회하지 못한다.\n\n실제 SQLite Mission/활성 Core 권위/예산과 ADMIN HTTP를 사용했다. 연결된7000원을7001원으로 바꾸면 선언 금액을 고치지 않고 money-source-limit-exceeded를 반환한다. 영속 변경 사건은1건, 다음 대사는0건이며 효과행0/예약횟수0을 확인했다. SQL snapshot을 다시 읽어도 원문 금액 비교가 유지됐다. 재실행 중 초기 fixture의 load 반환형과 효과 테이블 이름 오류2건은 실제 구조에 맞춰 수정했고 실패 로그도 보존했다.\n\n최종8파일133/133, fail0/skip0, 빌드/Core 계약 통과. journal파일23검사에는 기존 실제 OS 종료/재시작·권위 만료·CAS·이력 롤백·HTTP 인증 회귀도 포함한다. 가격·판매자·계정은 합성 자료이며 실제 발송/결제0이다. 비용과 제품 p50/p95는 미측정이다.\n\n이 수정은 읽기 전용 준비 상태 판정이며 실제 견적/영수증 결합 또는 거래 실행의 완성이 아니다. providerChargeVerified/quoteAndReceiptBindingVerified/executionAuthority는 false를 유지한다. 기존 외부효과의 금액 미검증 차단을 제거하지 않았으며 선언 금액만으로 결제를 허용하지 않는다. 운영 서비스나 설치본을 교체하지 않았다. V3-021/079의 종단 견적·효과·영수증 연결과 실제 파일럿이 남아 상태를 올리지 않는다.\n\n다음: 검토된 UCP 견적 예약과 Mission의 원문 한도·버전을 결합하고, 정책/권한 fence 및 응답 유실의 조회 대사를 그대로 유지하여 종단 검증한다. 복원은 새 sourceBinding/sourceMoney 비교를 함께 검토하되 기존 위임·예산·불명 예약 보류·금액 미검증 외부효과 차단을 보존한다. 파일 해시는 재현성 증거이지 독립 의미 평가/활성화 증거가 아니다.\n`);
const evidencePaths=['report.md','verification.json','source.json','first.txt','focused.txt','correction.txt','http.txt','final.txt','final-v2.txt','final-v3.txt','build.txt','contract.txt'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'money-source-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'위임 한도 안의 선언 금액도 사용자 원문의 더 작은 총액 한도와 직접 대조해야 한다.',
 lesson:'현재 예산 충분과 원문 조건 충족은 별개이며 캐시된 해석 숫자 대신 원문을 재계산하고 변경된 연결을 재검토해야 한다.',
 limitations:'실제SQL/Core/ADMIN HTTP 읽기 전용 비교, 합성 자료. 실제 견적·영수증 종단 결합/거래/활성화 미완료. 비용·제품 지연 미측정.'});
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(path)),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,55);
for(const id of ['V3-021','V3-079']){const gate=gates.find(g=>g.id===id);assert.notEqual(gate.status,'verified');gate.evidence.push(...evidencePaths);
 (gate.limitations??=[]).push('2026-10-07: 원문 총액/총비용 한도→명시적 금액 연결/SQL/ADMIN HTTP/영속 영향 사건·133회귀/build/contract. 읽기 전용 판정이며 견적/영수증 종단거래 미완료.');}
acceptance.updatedAt=observedAt;writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 원문 총액→명시적 금액 연결/정정·통화·한도 재대조·SQL/ADMIN HTTP·133회귀/build/contract. 공식55 유지. 다음 검토 견적 예약→Mission 원문/효과/영수증 binding.\n`);
console.log(JSON.stringify({observedAt,verified:55,tests:133,executionScope:'read-only-money-source-comparison'}));
