import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/mission-commerce-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(s,v)=>writeFileSync(`${prefix}-${s}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const final=read(`${prefix}-final.txt`);
for(const [key,value] of [['tests',220],['pass',220],['fail',0],['skipped',0]])assert.match(final,new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(final,/SQL Mission correction inside UCP policy await is caught by final fence before actual TLS POST/);
assert.match(final,/DPAPI root -> SDK signing -> full preorder verification -> actual TLS POST -> two real signed receipts -> durable success/);
assert.match(read(`${prefix}-first.txt`),/ℹ fail 19/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const files=['packages/core/src/mission/mission-money-dependency.js','packages/core/src/mission/mission-commerce-source-gate.js','packages/core/src/personal-operations/commerce-order-coordinator.js','packages/core/src/personal-operations/ucp-order-broker.js','packages/core/src/main.mjs','tests/mission-commerce-source.test.js','tests/ucp-order-broker.test.js','docs/ucp-ap2-contract.md'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:220,passed:220,failed:0,skipped:0,newSourceCases:19,newActualTlsCases:3,
 buildPassed:true,contractGatePassed:true,sourceCorrectionBeforePost:{actualSql:true,actualTlsReads:true,posts:0},
 cancelledMissionLossReconciliation:{posts:1,secondPost:false},supplier:'synthetic',realTransactions:0,actualCost:null,productLatencyPercentiles:null,
 naturalLanguageWholeMissionOrderCompletionVerified:false,productActivationVerified:false});
write('report.md',`# SQL Mission 원문 한도와 주문 준비·전송·대사 결합\n\n관측 ${observedAt}. 공식55/100 유지.\n\n이전 단계는 원문 한도와 선언 비용의 읽기 전용 준비 상태 비교였다. 이번에는 호스트가 검토한 주문의 실제 선언 총액/견적 해시를 같은 SQL Mission의 현재 원문·목표 revision에 결합했다.\n\n## 실행 계약\n\nMissionCommerceSourceGate는 같은 PersonalOperationsStore/실제 SqliteMissionStore/활성 MissionExecutionAuthority만 받는다. ADMIN prepare에는 기존 세 필드와 선택적인 missionId만 전달한다. 원문 총액/총비용의 단일 이하/미만 조건을 재계산하여 일치할 때만 예산을 예약한다. 모호한 통화, 한도 초과, 건당/누적/복수 범위와 금액 조건 부재는 예약0·전송0이다. 기존 일반 주문 경로와 위임/예산/영수증 검사는 유지한다.\n\n원문 해시·revision·금액·통화·견적 해시를 원래 예산 intent fingerprint와 주문 binding에 함께 저장한다. 같은 requestId에서 Mission을 제거/교체하는 재요청과 저장된 연결 삭제/변경은 원래 지문 불일치로 차단한다. 조회 결과의 missionSourceBound는 결합 상태이며 권한/자금 이동 증명은 아니다.\n\n전송 전과 비동기 정책 검사 후 원문/취소/권위/snapshot을 다시 확인한다. 결합 주문은 최종 commit fence를 지원하는 검토된 어댑터만 사용한다. UCP broker는 credential·서명 견적·위임·정책 검사 뒤 실제 POST 직전에 동기 호스트 fence를 호출한다. 그 사이 변경이 생기면 전송하지 않는다. 이미 in_flight인 시도는 불명/예산 보류로 남기고 임의 반환/재시도하지 않는다.\n\n과거 전송의 응답 유실 뒤 Mission 취소/원문 정정/위임 철회는 새 전송을 막되 원래 결합의 영수증 관측을 허용한다. 영수증 회계 정산은 취소 Mission을 COMPLETED로 바꾸지 않는다.\n\n## 관측\n\n새 SQL source 경계19사례와 실제 TLS broker3사례를 추가했다. 첫 실행은 기존 ASCII-only 주문 ID 검사를 실제 한국어를 포함하는 Mission ID에도 적용해 새19사례가 실패했다. Mission ID에만 저장소의 한국어 stableId 형식을 허용하고 기존 금융/checkout/request ID 검사는 유지했다. 실패 로그도 보존했다. 수정 후 첫33검사, TLS 포함49검사 통과.\n\n실제 TLS의 정상 signed quote→POST→독립 합성 receipt 결과는 원래 SQL Mission에 결합되어 저장됐다. UCP 정책 await 안에서 원문 revision을 바꾸고 SQL에 저장한 경우 실제 quote GET은1회, 최종POST0/receipt observer0이었다. 공급자 commit 뒤 소켓을 끊고 Mission을 취소한 경우 원래 영수증만 GET 대사해 POST1·재전송0을 확인했다. Core ADMIN HTTP는 사용자가 source proof/fence를 주입하는 입력을 거절했다.\n\n최종14파일220/220, fail0/skip0, 빌드/Core 계약 통과. 실제 Windows DPAPI·고정 AP2 SDK full nesting/두 암호학적 서명 영수증·TLS/SQL 재생성·중복/예산/금액/요구/이력 회귀도 포함한다.\n\n## 남은 범위와 복원\n\n판매자/계정/위임 키/영수증 신뢰 설정은 합성이고 실거래0이다. 원문→호스트가 검토한 주문의 연결은 구현했지만 자연어 Core 계획·E 정책·B 도구·G 기준을 통한 자유 주문 Mission 자동 완료/설치 UI/실계정은 미완료다. source gate는 정책을 대체하지 않으며 executionAuthority/fundsSettlementObserved는 false다. 공급자에게 POST가 전달된 뒤의 원격 원자적 철회도 보장하지 않는다. 여러 금액의 의미 범위와 일반 제약 인수가 남아 V3-021/032/041/079를 승격하지 않는다. 비용·제품 지연은 미측정이며 운영 서비스/설치본은 교체하지 않았다.\n\n복원 시 새 source gate/coordinator binding/broker commit fence를 함께 검토하며 기존 source-bound 예약은 무검사 일반 주문으로 되돌리지 않는다. 결합 게이트가 없는 호스트는 새 전송을 거절하되 원래 영수증의 조회 대사를 수행할 수 있다. 다음에는 동일 실행 계약의 남은 인수 항목을 감사하고 실제 닫을 수 있는 경로를 우선 구현한다. 파일 해시는 재현성 자료이며 독립 의미 평가나 활성화 증거가 아니다.\n`);
const evidencePaths=['report.md','verification.json','source.json','first.txt','focused.txt','tls.txt','final.txt','build.txt','contract.txt'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'mission-commerce-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'원문 금액 한도는 검토된 주문과 영속적으로 결합하고 비동기 검사 뒤 실제 POST 직전에도 재확인해야 한다.',
 lesson:'준비 상태 비교만으로 실행 중 정정을 보장하지 못한다. 최초 원문/견적 지문과 최종 동기 전송 fence, 과거 효과의 조회 대사를 분리해야 한다.',
 limitations:'실제SQL/Core/ADMIN/TLS/DPAPI/SDK, 합성 공급자/계정/키. 자연어 전체 주문 Mission/E/B/G/UI/실계정 거래 미완료; 비용·제품 지연 미측정.'});
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(path)),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,55);
for(const id of ['V3-021','V3-032','V3-041','V3-079']){const gate=gates.find(g=>g.id===id);assert.notEqual(gate.status,'verified');gate.evidence.push(...evidencePaths);
 (gate.limitations??=[]).push('2026-10-07: SQL Mission 원문/금액/견적 지문→예약/최종POST fence/불명 조회대사·220회귀/build/contract. 합성 공급자/실거래0, 자연어 주문 전체E/B/G/UI·일반제약 미완료.');}
acceptance.updatedAt=observedAt;writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: SQL Mission 원문/총액→검토 주문/최종POST fence·TLS정정POST0/취소대사중복0·220회귀/build/contract. 공식55 유지. 다음 전체 남은 인수 증거 감사→닫을 수 있는 실행 계약부터 진행.\n`);
console.log(JSON.stringify({observedAt,verified:55,tests:220,newSourceCases:19,actualTlsCases:3}));
