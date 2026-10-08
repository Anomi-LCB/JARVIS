import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/goal-quantity-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex'),observedAt=new Date().toISOString();
const final=read(`${prefix}-final-proof.txt`);for(const rx of [/tests 180\b/,/pass 180\b/,/fail 0\b/,/skipped 0\b/])assert.match(final,rx);
assert.match(read(`${prefix}-build-last.txt`),/Built static/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(path)),gates=acceptance.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-021');
assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,48);assert.equal(gate.status,'in_progress');
const requirementsSha256=hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));
const scanner=JSON.parse(read(`${prefix}-scanner-time.txt`).trim());
const verification={observedAt,acceptanceId:gate.id,originalRequirement:gate.requirement,originalRequirementsSha256:requirementsSha256,
 tests:{files:10,total:180,passed:180,failed:0,skipped:0,durationMs:10122.5556},newCases:{quantity:37,actualLocalMission:3,actualAdminHttp:1},
 build:'passed',coreContract:'passed',scanner,actualCorePcG:true,actualCoreAdminHttp:true,readiness:'synthetic',externalCalls:0,
 measuredProviderCost:null,cost:'미측정',operatingServiceUpdated:false,verified:48,scope:'수량 원문·정수 SI 단위·범위·비교 계산/현재 원문 API와 외부 실행 차단. 실제 배분/공급자 측정 출처·외부 효과 수량 검증 아님.'};
writeFileSync(`${prefix}-verification.json`,JSON.stringify(verification,null,2),{flag:'wx'});
const files=['packages/core/src/mission/goal-quantity-expression.js','packages/core/src/mission/goal-money-expression.js','packages/core/src/mission/goal-contract.js','packages/core/src/mission/mission-quantity-constraints.js','packages/core/src/mission/mission-requirement-coverage.js','packages/core/src/mission/mission-runtime.js','packages/core/src/main.mjs','tests/goal-quantity-constraints.test.js','tests/mission-quantity-runtime.test.js','tests/mission-quantity-api.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 자연어 수량·단위의 원문 계약과 실제 Core 검증 연결

공식 인수율은 **48/100**. 원래 V3-021의 수량/제약 계산을 보강했으며 전체 항목은 진행 중으로 유지한다. 원래100개 요구·분모는 변경하지 않았다.

## 구현

Goal 계약에 개·명·장·건·회·대·페이지·병·권·부·묶음·세트와 SI 질량/부피/길이의 수량 사실을 추가했다. 일부 한국어 수사와 큰 수를 처리하며 원문 위치/인용 데이터 구분/정정 후 새 ID를 보존한다. 최대/최소/정확히·이하/미만/이상/초과·양 끝 포함 범위를 결정형 비교로 유지한다. 기존 정확 금액 계산기를 정수 SI scale에도 재사용했다. 질량/부피/길이는 microgram/microliter/micrometer 정수로 계산하며 부동소수점 환산을 사용하지 않는다.

음수·분수 개수·쉼표 오류·과도한 정밀도·안전정수 초과·역순 범위·상충 비교와 미지원 수식은 일부 숫자로 축소하지 않는다. 1/2개·2×3개·3~5~7명은 전체 후보가 미해석으로 남는다. 단위가 없는 숫자·일부/명단/개월/세대별 같은 단어를 수량으로 추측하지 않는다. 숫자 후보를 먼저 끝까지 소비한 뒤 단위를 조회해 긴 비수량 입력의 suffix 반복 탐색을 피했다.

3명에게2부씩은 사람 수와 부수, 배분 조건을 각각 보존한다. 단순히3×2=6이라고 계산해 전달/배분 완료로 만들지 않는다. 배분은 대상/개별 결과 대조가 필요한 이유로 남는다. 비교기의 측정 출처 검증은 false이며 권한을 발급하지 않는다. 수량이 없는 계약은 applicable:false/ passed:null이다.

## 실행 경로와 사용자 결과

실제 Core→PC→G에서 합성 원자료 읽기와 준비 문서 저장을 각 사례에서 완료했다. 0.5부씩, 3명에게2부씩, 500mg이하의 외부 요청은 수량 미해석 또는 실제 효과 수량 미검증 이유로 PAUSED·발송attempts0이었다. 준비 파일은 다시 읽어 실제 내용을 대조했고 G 통과 관측2건을 확인했다. 모델 quantityVerified:true를 제출해도 이를 효과 증거로 인정하지 않았다. readiness는 자격증명 없이 경계를 격리하기 위한 합성 값이다. 실제 외부 발송은 실행하지 않았다.

ADMIN POST /missions/{missionId}/quantity-constraints를 기존 Core HTTP에 연결했다. 현재 Goal revision와 원문SHA를 요구하고 원문에서 수량을 다시 계산한다. 파생 quantity metadata의 조작은 계산값을 바꾸지 못한다. 누락·다른 단위·잘못된 값·추가검증플래그·중복/알수없는ID·오래된revision/해시는 거절하거나 실패 이유를 반환한다. 원문손상은503으로 보류한다. 계산 통과도 caller-submitted-unattested-base-units이며 executionAuthorized:false/효과0이다. 기존 Mission·큐는 변경하지 않았다. 원문 개인 자료도 응답에 포함하지 않는다.

## 검증과 실패 보존

최종10파일180/180통과, 실패0·제외0, 빌드/기존Core계약gate통과. 새수량37·실제준비Mission3·실제ADMINHTTP1은 최종180에 포함되며 별도로 더하지 않는다. 최종 runner10,122.5556ms는 실사용p50/p95가 아니다. 숫자scanner별 실행 관측은 별도 JSON 로그에 보존했으며 제품 전체 속도의 향상률로 환산하지 않는다.

개발 중 실제HTTP 검사에서 잘못된 JSON을503으로 돌려주는 분류 오류가 발생했다. parser의400/413을 입력오류로 정규화해 수정했다. 이후 missing Mission 반례가200을 받은 원인은 인코딩된 URL의raw ID를 치환하지 못한 시험 fixture였다. URL 인코딩된 ID를 치환하도록 시험을 고쳤다. 최초/중간 실패 로그는 삭제하거나 성공으로 덮어쓰지 않았다. 최종 증거는 final-proof.txt다.

## 미완료·복원·다음 작업

이 구현은 제한된 문법의 결정형 수량 계산이다. 모든 자연어 단위/표현·단위 없는 대상·배분·최신 재고/공급자 영수증·수수료세금 포함총액/누적예산·임의 제약의 의미 오라클은 아직 연결되지 않았다. 실제 측정값의 공급자/기기 출처를 API 호출자가 주장한 것만으로 확인하지 않는다. 의료 용량 예시의 해석은 처치/약 복용을 실행하는 기능이 아니다. 실제 계정·기기·거래·운영서비스/PC설치본 활성화 없이 코드/격리 실행만 검증했다. 외부모델/계정 호출0·실제 비용미측정.

V3-021의 기존 날짜/DST·금액 증거와 이번 수량 증거를 연결했지만 전체 날짜/시간대/수량/금액/제약 의미와 효과 오라클의 인수 범위를 이번 결과로 대체하지 않는다. 다음은 실제 업무 결과에서 수량 측정을 추출하고 대상/배분과 원문 요구에 결합하는 검증 경로다. 지원하지 않는 효과는 계속 보류하되 독립 로컬 준비를 막지 않는다.

복원은 이번 quantity추출/비교/API와 외부수량guard 추가만 좁게 검토한다. 기존 금액/시각 계약·Core/E/B/G/F와 사용자 파일·기억·다른 변경은 유지한다. source snapshot은 전체현재파일 보존용이지 파일 전체를 이번 새 구현이라고 주장하는 자료가 아니다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-first.txt`,`${prefix}-runtime-first.txt`,`${prefix}-api-first.txt`,`${prefix}-verified.txt`,`${prefix}-last.txt`,`${prefix}-final-proof.txt`,`${prefix}-build-last.txt`,`${prefix}-contract.txt`,`${prefix}-scanner-time.txt`,'docs/goal-quantity-contract.md'];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'goal-quantity-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'수량을 원문 위치/단위/범위/배분과 보존하고 정수SI로 계산하면 모델의 임의 수량검증 주장 없이 실제 효과 미검증을 분리하고 로컬 준비를 계속할 수 있다.',
 lesson:'수량해석·수학비교·측정provenance·대상별실제효과는 별개다. 저장metadata를 믿지 않고 현재revision의 원문에서 재계산해야 한다. 없는수량은 null 판정으로 남긴다.',
 limitations:'공식48/100·V3-021부분.10파일180통과/실제CorePCG로컬준비·ADMINHTTP, 합성 readiness/자료. 실계정/기기·배분/효과수량·임의제약/설치본 미완료. 비용미측정.'},null,2),{flag:'wx'});
gate.evidence.push(...evidencePaths.slice(0,3));gate.reviewedAt=observedAt;
gate.limitations.push('2026-10-07 원문 수량·정수SI 단위·범위/배분 보존/현재원문 비교API·실제PC/G 준비 및 발송0,180회귀/build/contract. 일반제약 의미·실제배분/효과수량·측정출처·총비용/누적금액 미검증,48유지.');
assert.equal(hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))),requirementsSha256);
acceptance.updatedAt=observedAt;writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 원문 수량/정수SI/범위·배분·현재원문ADMIN API·실제 CorePCG 준비/발송0,180회귀/build/contract. V3-021 부분·공식48유지. 다음 실제업무 결과 수량 측정/대상별배분/효과검증 연결.\n`);
console.log(JSON.stringify({verified:48,evidenceBytes:evidencePaths.reduce((sum,p)=>sum+readFileSync(p).length,0)}));
