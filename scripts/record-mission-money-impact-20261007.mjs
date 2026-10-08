import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/mission-money-impact-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex'),observedAt=new Date().toISOString();
const final=read(`${prefix}-final.txt`),deadline=read(`${prefix}-deadline.txt`);
for(const rx of [/tests 51\b/,/pass 51\b/,/fail 0\b/,/skipped 0\b/])assert.match(final,rx);
for(const rx of [/tests 18\b/,/pass 18\b/,/fail 0\b/,/skipped 0\b/])assert.match(deadline,rx);
assert.match(read(`${prefix}-build.txt`),/Built static/);
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-054');assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,47);assert.equal(gate.status,'in_progress');
const requirementsSha256=hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));
const coverage=[
 {dimension:'일정',evidence:'tests/mission-dependency-impact.test.js',observed:'수락 출처 변경/취소 digest→linked Mission 영향·staging B0·최신hash 재계획, 빈/중복페이지는취소아님'},
 {dimension:'기한',evidence:'tests/personal-mission-link.test.js',observed:'기한revision/누적시각차·실제완료경계·staging 변경 보류·원래효과보존'},
 {dimension:'예산',evidence:'tests/mission-dependency-impact-journal.test.js',observed:'공유quota·명시적 금액예약/정산/uncertain·동일요청 이중차감0·미측정null·일치하지않는request/통화/지문거절'},
 {dimension:'권한',evidence:'tests/mission-dependency-impact.test.js',observed:'현재Task 정책과Mission grant·scope/revision 변경에 따른원인/후속행동 영향'},
 {dimension:'기기',evidence:'tests/mission-dependency-impact.test.js',observed:'등록관측offline/stale/누락에 따른명시행동/후속DAG·독립행동·이력보존'}];
writeFileSync(`${prefix}-verification.json`,JSON.stringify({observedAt,before:47,after:48,acceptanceId:'V3-054',originalRequirementsSha256:requirementsSha256,coverage,regressions:[{files:5,tests:51,passed:51,failed:0,skipped:0,durationMs:11967.4785},{files:2,tests:18,passed:18,failed:0,skipped:0,durationMs:17263.8623}],build:'passed',actualAdminHttp:true,actualCoreOsKill:true,providerChargeVerified:false,externalModelCalls:0,cost:'미측정',scope:'현재 등록/명시된 의존 관계의 계산·조회·영속이력. 공급자/기기 관측 입력은 합성; 실제 연결·자동알림·의미 관련성 일반화 아님.'},null,2),{flag:'wx'});
const files=['packages/core/src/mission/mission-money-dependency.js','packages/core/src/mission/dependency-impact-digest.js','packages/core/src/mission/mission-dependency-impact.js','packages/core/src/mission/mission-dependency-impact-journal.js','packages/core/src/mission/mission-runtime.js','packages/core/src/main.mjs','tests/mission-dependency-impact-journal.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 명시적 금액 예산 영향 연결과 V3-054 완료 감사

공식 인수 **47→48/100**. 원래 V3-054 “일정·기한·예산·권한·기기 상태 변화의 영향을 연관 업무에 계산한다.”를5차원별 현재 코드/실행 증거로 감사했다. 원래100개 ID·요구·분모를 유지한다. 이는 등록된 명시적 업무 관계의 영향 계산 기능이며 실제 모든 계정/기기가 연결됐다는 뜻은 아니다.

## 추가 구현

ADMIN PUT /missions/{missionId}/money-dependencies에서 기존 금액 위임/요청을 Mission에 명시적으로 결합한다. 활성 SQL Core 권위·현재 snapshot·expectedRevision CAS가 필요하다. 단순 모델 metadata나 새 위임 생성으로 대신하지 않는다. 입력은 검토된 필드만 허용하고 원래 account/data/revision·견적 지문을 그대로 결합한다. 등록 자체의 예약0·외부실행0을 실제 HTTP로 확인했다.

현재 SQL 예산의 예약/정산/응답 불명과 남은 금액을 조회한다. 자기 요청의 예약은 이중 차감하지 않고, 다른 업무에는 남은 예산만 적용한다. 10000 최소단위 예산에7000을 예약한 경우 자기 요청 available10000/current, 다른7000요청 remaining3000/부족으로 계산했다. uncertain은 대사 필요, 회계정산4000 뒤 remaining6000, 원래 settled 요청은 새실행으로 취급하지 않았다. 공급자 비용 검증은 여전히false다.

금액null은 unknown/미측정으로 보존하고0으로 변환하지 않는다. 음수·분수·안전정수초과·필드누락은 거절한다. KRW/USD 통화 불일치·위임 철회·request/intentFingerprint 불일치·손상된 연결은 정상 준비로 표시하지 않는다. 환율을 임의 적용하지 않는다. 공유횟수quota와 실제회계금액은 별도 값이다.

금액 영향은 기존 전체 Mission 현재 projection과 영속 변경 이력에 포함한다. 기존 일정 수락출처 digest·기한revision·Task/Mission권한·능력registry의기기관측 영향 계산을 재사용했다. 직접 및 후속 행동에 전파하고 독립 업무와 완료 효과를 보존한다. 관측미준비/오래됨/동적resolver미조회는unknown으로 남기며 거짓current를 만들지 않는다. digest helper를 별도 모듈로 분리해 money↔impact의 순환 의존도 제거했다.

## 원래 인수 감사

verification.json의5차원 대응표에 원래 requirement와 실제 검사 파일/동작을 연결했다. 일정 변경/취소→기존Core/E/B/G staging차단·최신출처재계획, 기한revision/누적시각차→실제완료경계검사, quota/금액예산→연관Mission 및남은행동영향, 정책/권한revision→직접/후속행동영향, 기기offline/stale/누락→영향/unknown을 모두 관측했다. 전체 업무 페이지 혼합거절·SQL권위/이력원자성/실제Core SIGKILL복원 증거도 유지했다.

이번 승격은 계산/조회 기능에 대한 원래 인수 범위다. 실제 Google OAuth, 기기 등록/실기기 상태, 자동 선제알림·외부 거래·동적binding의실행직전검사는 해당 별도 인수항목에서 계속 미완료로 남는다. 미계획 업무의 암묵적 의미 관련성이나 모든 미래 변화의 자동복구를 구현했다고 주장하지 않는다. 원래 V3-054의 문구는 바꾸지 않았고 이전 제한/이력은 reviewHistory에 보존한다.

## 검사·한계·복원

새 금액기능 집중9/9통과. 최종5파일51/51과 별도2파일기한18/18, 실패0·제외0, 빌드 성공. 두 집합은 시험파일이 겹치지 않으며 집중9를 별도로 더해 부풀리지 않았다. 전체 runner11,967.4785/17,263.8623ms는 실제 업무 p50/p95가 아니다. actual ADMIN HTTP·SQL·별도Core프로세스3개kill복구를 사용했으며 입력은 합성이다. 실계정/실기기/운영설치본 변경 없음. 외부모델0·비용미측정.

예산 등록은 정책 승인/예약/결제가 아니다. 선언금액과 회계정산은 공급자 영수증을 대사한 실비증거가 아니다. 상태에 따라 남은 작업 영향이 달라져도 과거 완료효과를 무효화하거나 재실행하지 않는다. 새자동알림/일정변경은 하지 않았다. 이 기능의 일반화는 등록된 명시적 의존에 한정한다.

복원은 이번 money 연결/module/API/현재projection·journal요약 부분만 좁게 검토하고 원래 사용자자료/기억/다른 변경을 유지한다. SQL 연결/변경이력은 별도 테이블이며 자동삭제하지 않는다. source SHA는 무결성 자료다. 다음은 V3-056 선제 점검·기한 알림의 영속 변경 사건 소비/중복 억제와 불필요알림 감소를 사용자 평가 범위까지 연결하는 것이다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-first.txt`,`${prefix}-final.txt`,`${prefix}-deadline.txt`,`${prefix}-build.txt`,'docs/mission-dependency-impact-api.md'];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'mission-money-impact-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'명시적 금액 위임/요청을 연결하면 자기예약 이중차감 없이 공유 업무의 부족/대사 필요를 계산하고 미측정 값을 unknown으로 보존할 수 있다.',lesson:'선언견적·회계예약·공급자실비 검증은 별개다. 자신의 held 금액을 사용가능금액 계산에 복원하되 settled/uncertain/request지문 불일치는 새실행 준비로 처리하지 않는다.',limitations:'48/100/V3-054 계산기능 인수. 현재명시연결/합성입력·SQL/HTTP/실제프로세스. 실계정/실기기·외부거래·자동알림·암묵적의미 관련성 아님.비용미측정.'},null,2),{flag:'wx'});
gate.reviewHistory??=[];gate.reviewHistory.push({status:gate.status,evidence:[...gate.evidence],limitations:[...gate.limitations],supersededAt:observedAt,reason:'원래5차원 영향 계산의 현재명시연결/전체업무대사/영속이력·금액예산 경계를 종합 검토. 실제연결/알림 등 별도항목은 승격하지 않음.'});
gate.status='verified';gate.verifiedAt=observedAt;gate.evidence.push(...evidencePaths.slice(0,3));gate.limitations=['현재 등록된 명시적 출처·기한·quota/금액요청·권한·기기관측과 계획된 DAG의 영향 계산/조회/이력 기능. 입력 관측은 합성이고 실제 계정/기기 연결 완료 증거가 아니다.','동적 resolver 미재조회·출처/예산/기기 미준비는 unknown. 암묵적 의미 관련성/자동알림/자동재계획/실제 거래 활성화/다중Core 전체일관성은 별도 미완료. 비용미측정이며 providerChargeVerified=false 유지.'];
assert.equal(hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))),requirementsSha256);assert.equal(gates.filter(g=>g.status==='verified').length,48);a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 명시적금액예산/자기예약중복차감0/미측정unknown·51+기한18통과/build. 원래V3-054 5차원현재영향계산 인수검토완료, 전체48/100. 다음V3-056 영속변경사건 소비·선제알림 중복억제/불필요알림 평가.\n`);
console.log(JSON.stringify({verified:48,evidenceBytes:evidencePaths.reduce((n,p)=>n+readFileSync(p).length,0)}));
