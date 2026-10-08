import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ResearchLedger} from '../packages/shared/src/research-ledger.js';
const prefix='artifacts/selected-source-result-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [key,n] of [['tests',139],['pass',139],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${n}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-diagnostic.txt`),/repeated-plan-stall-detected/);
assert.match(read(`${prefix}-cancel-diagnostic.txt`),/literal-text-whole-request-binding-unresolved/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const files=['packages/core/src/mission/selected-source-result.js','packages/core/src/mission/mission-runtime.js',
 'packages/core/src/mission/mission-requirement-coverage.js','packages/core/src/personal-operations/mission-budget-gate.js',
 'packages/core/src/main.mjs','apps/runtime-compose/src/create-runtime.js','tests/selected-source-result.test.js','tests/mission-runtime.test.js'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const ledger=new ResearchLedger({workspaceRoot:process.cwd(),storePath:'.runtime/research/research.sqlite'});
try{const snapshot=ledger.snapshot();write('ledger-review.json',{observedAt,candidates:snapshot.candidates.map(c=>({id:c.id,revision:c.revision,nextReason:c.nextReason,attemptCount:c.attemptCount,
  lastAttempts:c.attempts.slice(0,2).map(a=>({id:a.id,reportedOutcome:a.reportedOutcome,currentDefinition:a.currentDefinition,
   evidence:a.evidence.map(e=>({path:e.path,integrity:e.integrity,sourceIntegrity:e.sourceIntegrity,snapshotIntegrity:e.snapshotIntegrity}))}))})),boundaries:snapshot.boundaries});}finally{ledger.close();}
write('watch.json',JSON.parse(read('.runtime/research-watch/latest.json')));
write('verification.json',{observedAt,tests:139,passed:139,failed:0,skipped:0,newSelectedSourceCases:13,unsafeControlCases:1,
 actualMissionExecution:true,actualCoreHTTP:true,actualSQLite:true,selectedSourceCompleteResult:true,maximumTestItems:1001,
 realProviderAccount:false,humanReadConfirmed:false,paidModelCalls:0,actualCost:null,productLatency:null,productionActivation:false,
 buildPassed:true,contractPassed:true,formalVerified:59});
write('report.md',`# 선택한 저장 자료 전체 조회의 Mission 완료와 결과 전달

관측 ${observedAt}. 원래 100개 인수 중 59개 완료를 유지한다. V3-020/031/032/033/073의 부분 증거이며 실제 공급자 계정이나 설치본 활성화 증거가 아니다.

## 구현한 경로

‘선택한 연결의 저장 자료 전체를 조회해.’와 닫힌 provider/opaque streamRef 선택을 원문 요구 계약에 결속한다. 이 문법은 전체 저장 메타데이터 조회만 지원한다. 추가 발송·시간 제한·제외·요약 지시는 생략해 부분 실행하지 않는다. URL·토큰·모델이 주장하는 권한도 선택 필드로 받지 않는다. 선택값은 생성 요청의 멱등성 해시에도 포함한다.

기존 Core→E→B→G의 source.readSelectedInbox를 페이지당 500개로 실행한다. 다음 페이지는 동일 revision을 요구한다. 모델 플래너를 호출하지 않고 현재 독립 Core SQL과 실제 task 실행 영수증을 대조해 다음 offset을 계산한다. 현재 범위·위임·owner session·host 허용 상태를 결과 읽기 전후에 재검사한다. 완료는 모든 페이지가 연속되고 자료 ID 중복이 없으며 현재 SQL에서 동일 개수·내용·revision이 재확인될 때만 인정한다. 출력 미리보기 문자열이나 플래너의 완료 주장은 증거로 사용하지 않는다.

ADMIN 전용 GET /missions/:missionId/verified-selected-source는 완료 Mission의 결과를 재검증해 JSON으로 전달한다. no-store이며 권한을 반환 직전 다시 검사한다. 자료 변경·페이지 누락·중복·영수증 변조·위임 철회·host 철회 시 items를 반환하지 않는다. 결과에는 저장 메타데이터, 외부에서 온 신뢰하지 않는 문장, 실공급자 최신 확인 아님, 사람이 읽었다는 확인 아님을 구분한다. UI에 실제 표시했다거나 메일 본문 전체를 수집했다는 뜻이 아니다.

## 발견과 수정

1,001개 자료의 첫 실행은 500개씩 두 페이지까지 성공한 뒤 반복계획 차단으로 멈췄다. 기존 semanticPlanFingerprint가 source 읽기의 offset/revision을 포함하지 않아 다른 페이지를 같은 행동으로 보았다. source 도구의 provider·stream·offset·limit·revision을 비교 범위에 추가했다. 반복 차단을 해제하거나 임계값을 늘리지 않았다. 동일 페이지 실패는 계속 같은 계획으로 인식한다.

공유 회귀의 기존 취소 시험도 재현했다. 시험 목표가 실제 파일 행동을 나타내지 않아 요구 보존 검사에서 먼저 PAUSED가 됐다. 해당 시험은 승인 뒤 파일 생성 목표와 실제 파일 criterion으로 수정해 취소 게이트 경로까지 도달하게 했다. 제품의 요구 보호를 완화하지 않았다. 첫 literal 목표 수정도 실패한 원인을 별도 diagnostic에 보존했다.

초기 별도 실행에서 page0 두 건 실패도 관측했으나 그때 오류 세부를 보존하지 못해 원인을 확정하지 않는다. HTTP 시험에 저장소의 fetch-safe ephemeral-port helper를 적용했다. 이는 시험 포트 방어이며 최초 실패의 확정 원인이라는 주장은 하지 않는다.

## 검증

최종 139/139, 실패0·skip0. 이 중 새 selected-result 13개, 기존 위험 대조군 1개를 포함한다. 위험 대조군은 보호 제거 시 허위 완료 가능성을 입증하는 시험이며 실제 업무 성공으로 계산하지 않는다. Outlook 합성 자료1,001개를 실제 Mission의 3개 B/G task와 Core HTTP로 전부 반환했다. Teams2개·Gmail0개·Calendar1개도 현재 저장 자료 범위에서 완료했다. 타계정 제외, 위임/host 철회, 변경, 재계산한 변조 해시, 누락/중복 페이지, 2-action 예산, 페이지 중간 자료 변경, 추가 원문 지시를 검사했다.

build와 기존 OpenAPI baseline을 바꾸지 않는 contract gate 통과. 전체 저장소의 모든 검사, 실OAuth/실계정/메일 발송/기기/제품 p95는 미측정이다. 외부 유료 모델 호출0, 실제 비용은 미측정. 기존 개인 자료와 F/cognition 기억·운영서비스·설치본은 변경하지 않았다.

## 공식 자료 재검토

research:watch→ledger sync→status를 순서대로 실행했다. 05:33Z 감시6곳 중 raw변경3·동일3·오류0이다. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [변경 기록](https://developers.openai.com/api/docs/changelog) 본문을 다시 확인했다. 관리형 세션과 코드 기반 SDK의 공개 경로는 현재 Core 원장·권한·결과 검증을 대신하지 않는다. HTML 변화의 전후 의미 비교가 없으므로 새 기능 발표라고 판정하지 않는다. 10월6일 Decisions 후보는 이미 04:04Z 보고서와 기존 Jev 후보에 등록되어 있어 중복 구현하지 않았다. [Decisions 계약](https://developers.openai.com/api/docs/guides/decisions)의 choice/predicate/score를 재확인했으며 유료 API 실험은 인증·예산 조건이 준비될 때까지 보류한다. 공급자 속도 주장을 제품 성능으로 보고하지 않는다. 장부의 최근 정의·증거 상태를 ledger-review.json에 보존했다. 파일 해시는 보존 여부일 뿐 결론의 독립 검증이 아니다.

## 다음 작업과 복원

다음은 실제 사용자 연결 화면에서 선택→Mission 생성→전체 결과 표시→철회 후 결과 숨김을 연결하는 것이다. 실OAuth와 현재 공급자 동기화, 서비스 재시작 후 기록 복원, 원격 B, 본문 수집과 설치본 활성화는 별도 실증이다. 기존 인수율을 올리지 않는다. 복원은 이 결과 모듈·선택 Mission 분기·source 페이지 fingerprint·ADMIN 결과 경로와 관련 검사만 검토하고 기존 SQLite/개인자료/권한/증거를 삭제하지 않는다.
`);
const evidencePaths=['report.md','verification.json','source.json','watch.json','ledger-review.json','first.txt','diagnostic.txt','focused.txt','regression.txt','cancel-diagnostic.txt','cancel-final.txt','final.txt','build.txt','contract.txt'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'selected-source-result-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'선택 저장자료의 원문과 전체 페이지 영수증을 현재 Core SQL 및 실행권한에 결속하면 누락 없는 결과에 한해서 Mission 완료와 결과 반환을 허용할 수 있다.',
 lesson:'페이지 offset을 생략한 반복계획 fingerprint는 올바른 전체 조회를 차단한다. 완료는 preview나 자체 주장 대신 실제 task와 현재 SQL 결과·위임을 함께 대조해야 한다.',
 limitations:'격리 실제 Mission/Core HTTP/SQLite와 합성 공급자 메타데이터. 실계정·OAuth·본문·UI 표시·새 프로세스 복원·운영 활성화·제품 p95/비용은 미검증.139개에 위험 대조군1개 포함.원래 인수59% 유지.'});
const path='docs/universal-control-v3-acceptance.json',data=JSON.parse(read(path)),gates=data.stages.flatMap(s=>s.gates);assert.equal(gates.filter(g=>g.status==='verified').length,59);
for(const id of ['V3-020','V3-031','V3-032','V3-033','V3-073']){const gate=gates.find(g=>g.id===id);assert.notEqual(gate.status,'verified');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 저장 selected-source 원문 binding/1001항목 전체 Mission 3페이지/현재 SQL 독립 검증/ADMIN 결과 API/위임 철회 반례/139회귀/build/contract.실공급자·본문·OAuth·UI·재시작·제품 활성화 미검증;부분증거.');}
data.updatedAt=observedAt;writeFileSync(path,JSON.stringify(data,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 선택 저장자료의 전체 Mission→현재 SQL 검증→ADMIN 결과 API;1001자료3페이지/139회귀(위험 대조군1)/build/contract.59% 유지. 다음 실제 연결 화면의 선택·결과·철회 표시와 새 프로세스 복원.\n`);
appendFileSync('docs/microsoft-source-adapters.md','\n선택 저장자료 전체 조회는 닫힌 selectedSource(provider,streamRef)와 원문을 결속하고 동일revision의500개 페이지를 Core/E/B/G로 읽는다. ADMIN verified-selected-source 결과는 현재SQL/영수증/위임 재검증 후 반환한다. 현재 저장 메타데이터이며 실공급자 최신동기화·본문 전체·UI 표시·사람 읽기·설치본 활성화는 별도다.\n');
console.log(JSON.stringify({observedAt,verified:59,tests:139,unsafeControls:1}));
