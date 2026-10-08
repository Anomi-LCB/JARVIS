import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/mission-impact-batch-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex'),observedAt=new Date().toISOString();
const initial=read(`${prefix}-first.txt`),final=read(`${prefix}-regression.txt`);
assert.match(initial,/fail 1\b/);for(const rx of [/tests 71\b/,/pass 71\b/,/fail 0\b/,/skipped 0\b/])assert.match(final,rx);assert.match(read(`${prefix}-build.txt`),/Built static/);
writeFileSync(`${prefix}-verification.json`,JSON.stringify({observedAt,acceptanceId:'V3-054',officialVerified:47,initial:{tests:15,passed:14,failed:1},final:{tests:71,passed:71,failed:0,skipped:0,durationMs:22339.4516},build:'passed',actualHttp:true,apiResponseMocks:0,externalModelCalls:0,cost:'미측정',scope:'Synthetic stored calendar/device observations, actual local SQL quotas/Mission state/ADMIN HTTP; no live providers, no automatic modification or durable change journal.'},null,2),{flag:'wx'});
const files=['packages/core/src/mission/mission-dependency-impact.js','packages/core/src/mission/mission-runtime.js','packages/core/src/main.mjs','tests/mission-dependency-impact.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 여러 Mission의 명시적 의존 변화 현재 대사

공식 **47/100 유지**, V3-054 진행 중. 기존 개별 업무 영향 계산을 전체 현재 업무에 연결한 읽기 전용 API GET /missions/dependency-impacts를 추가했다. 권한·기기·출처·기한·실행 횟수 quota와 계획된 행동 의존은 기존 계산을 재사용한다. 실제 지출 금액으로 횟수를 대체하지 않는다.

## 구현과 검증

전체 current/requires-review/unknown/historical 집계 및 업무별 결과를 페이지로 제공한다. 공유 quota의 마지막1회를 한 Mission이 예약하면, 그 예약은 유지되고 같은 quota를 쓰는 다른 Mission만 부족 표시된다. 독립 Mission은 quota를 물려받지 않는다. 완료된 Mission/행동은 이력으로 보존한다. 조회는 Task/Mission 상태·예약·권한을 변경하지 않는다.

페이지 cursor는 현재 판정의 SHA와 다음 위치를 결합한다. 공유 한도·기기·권한·업무 집합이 바뀌면 기존 cursor를409로 거절한다. 시각 값만 달라져 동일한 결과가 불필요하게 무효화되는 것은 제외하지만 관측 stale 판정은 포함한다. 기록된 activeRuntimeMs를 읽는 이 화면에서 계산 코드의 몇 밀리초를 업무 소비 시간으로 차감하지 않도록 바로잡았다. 실행 예산 계산과 실제 실행 권한은 변경하지 않는다.

실제 Core HTTP에서 무인증401·정상 현재2업무·업무추가후409·limit/중복/알 수 없는 쿼리400·변경메서드405·OpenAPI 등록을 확인했다. 최초15개 중1실패는 변경된 기기 관측을 동일한 observedAt로 기록한 시험 데이터 충돌이었다. 시각을 순서대로 전진시켜 기존 원장의 충돌 방어를 유지했고 권한 revision 변경 대조도 추가했다. 최초 실패 로그를 보존한다.

4개 실제 존재하는 시험 파일에서 **71/71 통과·실패0·제외0**, runner22,339.4516ms, 빌드 성공. 기존 일정 변경·취소 실행 전 차단, 실제 quota SQL 원자성/프로세스 종료 및 Mission runtime 회귀를 포함한다. 외부 LLM0·비용미측정. 신규 기기/일정 입력은 합성이며 실계정·실기기 관측으로 보고하지 않는다. 실제 UI 변경·운영 서비스 재시작·설치본 교체는 하지 않았다.

## 남은 조건

조회 순간의 명시적 의존에 대한 현재 대사다. 변경 사건의 영속 이력·자동 알림/재계획·분류된 금액 예산·동적 연결 probe·미계획 요구의 의미 관련성은 남아 있다. 최대5000업무 스캔 한도 초과는 오류이며 일부를 전체로 표시하지 않는다. 단일 Core의 현재 상태에 대한 API를 다중 Core/장치의 분산 일관성 증거로 표현하지 않는다. 따라서 V3-054 승격은 보류한다.

다음 구현은 현재 projection을 반복 비교한 변경 사건을 원래 SQL Core 권위에 영속 기록하고, 변경/누락과 중복 이벤트를 구분하며, 명시적 금액 예약이 연결된 업무의 영향 계산을 실제 예산 계약과 결합하는 것이다. 조회 응답이 실행 승인을 주지는 않는다.

복원은 이번 메서드/API/문서/시험 추가 부분만 검토하며 기존 거대한 main.mjs 변경 전체를 되돌리지 않는다. source snapshot은 현재 파일 바이트 보존으로 무결성 증거이며 독립 검증 자체가 아니다. 사용 안내는 docs/mission-dependency-impact-api.md다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-first.txt`,`${prefix}-regression.txt`,`${prefix}-build.txt`,'docs/mission-dependency-impact-api.md'];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'mission-impact-batch-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'명시적 공유 의존의 현재 판정을 전체 Mission에 계산하고 스냅샷이 변하면 페이지 혼합을 거절할 수 있다.',lesson:'공유 quota 소비는 해당 예약 업무와 다른 신규 업무에 다른 영향을 주며 조회의 계산 시간은 기록된 업무 실행 시간을 증가시켜서는 안 된다.',limitations:'47/100/V3-054 진행중. 71회귀/build/실제 ADMIN HTTP. 입력관측은 합성. 금액예산/영속 사건/자동전파·실계정·다중Core·UI 활성화 미완료. 비용미측정.'},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-054');assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,47);assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths.slice(0,2));gate.limitations.push('2026-10-07 전체명시업무 현재의존 대사/API·quota/권한/기기/집합변경 cursor409·71통과/build. 금액예산·영속변경사건·자동전파·실계정은 남음.');a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 전체명시Mission 현재영향/API·공유quota 차등영향·pagination snapshot409·71통과/build. 전체47/100/V3-054 진행중. 다음 단일 SQL Core 권위에 변경 사건 영속대사 및 금액예약 연결.\n`);
console.log(JSON.stringify({verified:47,tests:71,evidenceBytes:evidencePaths.reduce((n,p)=>n+readFileSync(p).length,0)}));
