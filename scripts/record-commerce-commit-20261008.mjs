import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/commerce-commit-20261008',observedAt=new Date().toISOString();
for(const [suffix,count] of [['-final-v2.txt',58],['-ap2-final.txt',6]]){
 const log=await readFile(prefix+suffix,'utf8');
 if(!log.includes(`ℹ pass ${count}`)||!log.includes('ℹ fail 0')||!log.includes('ℹ skipped 0'))throw Error('Final execution evidence missing');
}
const paths=['packages/core/src/personal-operations/commerce-order-coordinator.js','packages/core/src/personal-operations/ucp-order-broker.js','packages/core/src/personal-operations/ucp-ap2-order-bridge.js','tests/commerce-order-coordinator.test.js','tests/mission-commerce-source.test.js','tests/ucp-ap2-order-bridge.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 거래 발신 직전 권한·조건 재확인

관측 ${observedAt}. 실제 돈·주문·외부 발송0, 서비스/설치 EXE 활성화0. 로컬 TLS 합성 판매자와 합성 서명키만 사용했다. 비용은 미측정이다.

## 재현과 수정

변경 전 네 반례가 실제 실패했다. 주문 준비 뒤 위임 철회·정책 거부·상품 변경을 해도 비Mission 주문이 발신했으며, AP2 연결 계층은 전달받은 마지막 확인 함수를 무시했다. baseline 로그를 보존한다. 통제를 무조건 차단으로 대체하지 않고 정상 주문·서명 영수증·응답 손실 후 조회도 검사했다.

모든 주문 어댑터는 supportsBeforeCommit와 비동기 beforeCommit 계약을 지켜야 한다. 지원하지 않는 어댑터는 예산 실행 시작 전에 보류된다. 발신 직전 현재 견적·정책·SQL 의도 결속·위임·Mission·만료를 다시 확인하며, 준비 중 동일 연결값의 어댑터/complete 함수 교체와 확인 지원 제거도 거부한다. AP2 서명 이후 TLS 브로커로 동일 확인 함수를 전달하고 브로커는 이를 await한 뒤 연결 권한과 견적 만료를 다시 검사한다. 인증정보는 기존 DPAPI 중개 안에 둔다.

첫 확대61검사에서40통과/21실패였다. 새 최종 위임 검사에 내부 intentFingerprint를 그대로 넣어 엄격한 요청 스키마가 정상 주문까지 거부한 구현 실수였다. 기존 budget.begin과 동일하게 fingerprint를 분리해 수정했다. 이후61통과, 어댑터 교체 반례3을 추가한 최종 소스에서 일반 주문·Mission·TLS·전체 예산58/58 및 실제 DPAPI/AP2 SDK/서명/TLS6/6 통과했다. 최종 서로 다른64검사 fail0/skip0이며 중간 실행을 중복 합산하지 않는다. build와 Core contract gate도 통과했다.

실제 SDK 서명과 암호 검증, SQLite 재열기, 로컬 TLS POST/GET, 응답 손실 후 중복 POST 없는 조회가 실행됐다. 합성 공급자 영수증은 실제 결제나 공급자 공식 샌드박스 성공을 뜻하지 않는다. 불명 결과는 uncertain과 예산 보존/조회 전용으로 유지한다. 최종 확인 이전 실패도 보수적으로 불명 상태에 남을 수 있으며 자동 재발신하지 않는다.

## 출처·연구·한계

[UCP 공식 개요](https://ucp.dev/specification/overview/)의 인증·결제·권한 경계와 [AP2 원본](https://github.com/google-agentic-commerce/AP2)을 재조회했다. 이 수정은 기존 고정 SDK의 연결 경계를 보강한 것으로 UCP/AP2 모든 버전 구현이 아니다. 신뢰된 host 어댑터의 확인 함수 준수 계약이며 악성 코드가 확인 함수를 무시해도 OS가 모든 발신을 통제한다는 증거는 아니다. 브로커의 비동기 확인 후 실제 네트워크 사이 OS/외부 상태 경합을 전역적으로 제거하지 않는다.

research:watch → ledger sync → status 실행 완료. 감시6곳 중 OpenAI3곳의 내용 해시가 변했고 나머지3곳은 동일했다. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [changelog](https://developers.openai.com/api/docs/changelog) 원문을 열어 재검토했으나 HTML 해시 변화만으로 새 출시·성능 향상·기술 채택을 선언하지 않았다. 새 모델/API 호출은 실행하지 않았다.

V3-080은 거래 범위 통제 일부 증거로 진행 중만 표시한다. 개인정보/금융정보의 모든 목적별 전송 경로, 실제 계정 연결·선택된 실거래·상시 노드·30일 관측은 남아 있다. 원래100항목의 전체 완료60개는 그대로다. 복원할 경우 새 확인 계약과 어댑터를 함께 검토해야 하며 기존 불명 주문을 reserved로 되돌려 재발신하지 않는다. 다음은 목적별 자료 범위/전송 통제를 실제 실행 경로와 연결하는 작업이다.
`,{flag:'wx'});
const evidence=['-report.md','-source.json','-baseline.txt','-first.txt','-final-v2.txt','-ap2-final.txt','-build.txt','-contract.txt'].map(s=>prefix+s);
const path='docs/universal-control-v3-acceptance.json',ledger=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),gates=ledger.stages.flatMap(s=>s.gates);
for(const id of ['V3-080','V3-032','V3-033','V3-040','V3-041','V3-079']){
 const gate=gates.find(g=>g.id===id);if(!gate)throw Error('Acceptance ID missing');
 gate.evidence=[...new Set([...(gate.evidence??[]),...evidence])];
 gate.limitations=[...(gate.limitations??[]),'2026-10-08: 주문 최종 위임/정책/견적/어댑터 확인과 AP2→TLS 비동기 확인 전달64검사. 로컬 합성 공급자/실제SDK·DPAPI·TLS이며 실제 돈/개인정보 외부전송/실계정 거래/설치 활성화0. 전체 항목 완료 아님.'];
 if(id==='V3-080'&&gate.status==='pending')gate.status='in_progress';
}
if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Original acceptance authority changed');
await writeFile(path,JSON.stringify(ledger,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'commerce-commit-20261008',candidateId:'commerce-final-commit-boundary',kind:'contract-test',reportedOutcome:'passed',observedAt,hypothesis:'주문 준비 이후 권한·정책·견적 변화 및 AP2 서명 이후 최종 확인 누락을 마지막 TLS 발신 확인에 연결하면 변경된 거래가 재확인 없이 발신되는 반례를 막는다.',lesson:'준비 시 허용과 발신 시 허용은 다르다. 어댑터 경계 전체에서 비동기 최종 확인을 전달하고 양성 발신과 손실 후 대사를 함께 검사해야 한다.',limitations:'최종64검사 로컬 합성판매자/실제SDK·DPAPI·TLS. 실계정/실결제/공식공급자샌드박스/설치활성화 없음. 미측정비용. 모든 목적별 개인정보 전송/OS강제경계 검증은 아님.',evidencePaths:evidence},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 거래 최종 위임/정책/견적 재확인·AP2→TLS async fence 누락4반례 수정·어댑터 변경3추가·최종64/64/build/contract. 공식60/22진행/18대기,080 부분 진행. 운영활성화/실계정 거래0. 다음 목적별 자료범위/전송통제·상시/실계정/기기 인수.\n`);
