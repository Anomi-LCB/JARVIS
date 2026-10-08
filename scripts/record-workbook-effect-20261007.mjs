import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/workbook-effect-20261007';
const read=path=>readFileSync(path,'utf8'),json=path=>JSON.parse(read(path));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-verified-runner.json`),log=read(`${prefix}-verified.txt`);
assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
for(const [key,count]of [['tests',57],['pass',56],['fail',0],['skipped',1]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-final-compat-v3.txt`),/ℹ pass 1/);assert.match(read(`${prefix}-final-compat-v3.txt`),/ℹ fail 0/);
assert.match(read(`${prefix}-final-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-final-contract.txt`),/gatePassed: true/);
const review=json(`${prefix}-independent.json`);assert.ok(review.independentTests.every(t=>t.fail===0));
const observedAt=new Date().toISOString();
const sources=['packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js',
 'packages/core/src/mission/xlsx-cell-evidence.js','packages/core/src/orchestration/core-orchestration-worker.js',
 'apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/excel/excel-worker.js','apps/pc-agent/src/adapters/excel/native-pdf-renderer.js',
 'tests/fixtures/workbook-effect-process-child.mjs','tests/mission-workbook-effect-process.test.js','tests/workbook-native-pdf.test.js','tests/xlsx-content-fingerprint.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;assert.equal(verified,60);
write('verification.json',{observedAt,uniqueChecks:58,passed:57,failed:0,skipped:1,primaryRunnerTests:57,legacyDirectTests:1,
 primaryRunnerDurationMs:runner.durationMs,processKillBoundaries:['prepared','b-receipt','receipt-persisted','partial'],
 nativeExcelPdfExecuted:false,productionActivated:false,externalModelCalls:0,totalLocalCost:null,
 independentReview:review.verdict,original100AcceptanceVerified:verified,
 sources:[{url:'https://nodejs.org/api/globals.html#event-abort',checkedAt:observedAt,purpose:'AbortSignal one-shot event and pre-listener aborted check; no dependency installation'}]});
write('report.md',`# 로컬 Excel 제작 Mission 효과·영수증·복구 연결

관측: ${observedAt}. 원래 100개 인수항목 완료60개, 진행중19개, 대기21개. 이번 작업은 V3-040의 로컬 excel.createWorkbook 경로 증거를 추가하며 전체 인수 완료를 늘리지 않는다.

## 실제 바뀐 동작

기존 Excel 생성은 XLSX를 만들고 G 검증을 통과해도 공통 SQL effect/원래 operation에 결속된 B receipt와 재시작 복구가 빠져 있었다. 이번에는 Core→E→B→G→F의 실제 격리 Mission에 effectId·operationId·요청 해시·동일 멱등키·완료 영수증을 연결했다. 기존 공유 물리 파일 claim과 private E/Core fence를 재사용한다. PDF가 요청되면 XLSX와 PDF 두 목적지를 함께 계약에 넣고, PDF 실패를 전체 완료로 처리하지 않는다.

독립 반증은 두 실결함을 찾아냈다. 첫째 SQL 계획과 B claim 이후 worker가 준비 데이터를 다시 읽으며 rows7을999로 바꿔 저장해도 완료가 됐다. 실제 재prepare 결과를 쓰기 직전 private 계약과 다시 대조하도록 수정했다. 둘째 동일 경로의 XLSX와 B receipt 해시를 함께 바꾸면 복구가 자기일치 영수증을 믿었다. Core가 기록한 원래 OOXML 각 부분의 내용 지문과 실제 파일을 대조하도록 고쳤다. ZIP 날짜만 바뀌면 동일 내용으로 인정하고 시트·스타일·차트 등 실제 부분 변경이나 CRC 오류는 거절한다. 암호화·추출·매크로 실행 없는 bounded parser를 사용한다.

추가로 B context의 AbortSignal 전달과 정규화한 PDF 목적지 검사, 두 worker wrapper의 private 검사 보존을 확인했다. 기존 direct XLSX의 정책 기본 상대 scope('./workspace') 때문에 새 claim이 기존 G 테스트를 거절하는 회귀도 해결했다. 호환은 non-Mission·PDF 미요청·executionBinding 없음·정확한 legacy 기본 scope에만 host roots를 사용한다. Mission의 명시적 절대 경로·승인·인자 binding과 PDF의 기존 제한은 완화하지 않았다.

Native PDF 준비의 await 중 취소된 signal이 listener 등록 전에 사라지는 실제 실패도 관측했다. listener 등록 직후 이미 aborted인지 확인하여 취소를 놓치지 않게 했다. [Node 공식 AbortSignal 문서](https://nodejs.org/api/globals.html#event-abort)의 한 번 발생하는 abort 동작과 대조했다. 해당 경계를 동기 abort/실제 child 종료 시험으로 고정했다.

## 실행 결과와 실패 보존

최종 고유58검사 중57통과·0실패·1skip. 공통 runner57건(56통과/1skip), 기존 direct G verifier1건 통과. build 및 Core 계약 통과. 독립 malicious7·wrapper2 검사는 별도 증거로 보존하며 중복 포함 independent combined 숫자를58에 더하지 않는다. 초기 content2반례, 기존 direct 회귀, cancellation 실패는 독립 검토와 초기 로그에 남겼다.

실제 OS process SIGKILL은 prepared, B 완료receipt, SQL receipt-persisted, XLSX 저장 뒤 B receipt 이전의 네 경계다. 정상 복구는 원래 operation/effect/key/receipt를 유지하고 완료 adapter 반환1건, 완료 뒤 B claim0을 직접 관측했다. 이는 모든 시작된 adapter 호출이1이라는 의미가 아니다. 파일만 있고 영수증이 없는 partial 및 변경된 결과는 PAUSED/uncertain으로 보류해 자동 중복 생성을 막는다. SQLite Core authority 활성 양성도 통과했다. 실제 cells/charts를 다시 읽는 검증과 기억 복구도 회귀에 포함했다.

실험은 합성 입력·임시 OS 파일·격리 SQLite·실제 PID·일부 명시 시계·로컬 계획기 조건이다. 외부 LLM 호출0. 전체 로컬 비용은 미측정(null). runner 전체 ${runner.durationMs}ms이며 제품 p50/p95 또는 경쟁제품 우월성을 측정한 결과가 아니다. 사용자 개입은 격리 시험 중0이며 일반 사용 개입률을 뜻하지 않는다.

## 남은 조건과 다음 작업

Native Microsoft Excel COM→PDF 실제 성공 검사는 환경 조건으로 skip했다. 합성 renderer의 실패·철회·signal 검사를 실제 PDF 성공으로 세지 않는다. 설치된 Windows 프로그램과 운영 Core/PC 서비스에는 이번 소스를 활성화하지 않았다. 원격 Excel, 유료 모델/공급자 예산, 실계정, 모든 파일 경쟁, 모든 등록 쓰기 능력은 미검증이다. 상시 노드 설치와30일 실사용도 이번에 수행하지 않았다.

V3-040은 excel.exportPdf·문서·압축·외부 배포 등 등록 쓰기 전부의 공통 계약이 아직 남아 진행중이다. 다음 작업은 등록 쓰기 경로의 계약 목록에서 남은 실제 누락을 재현해 하나씩 연결하는 것과, 준비된 native PDF 현장 경로를 별도 증거로 실행하는 것이다. 현재58검사를 원래100개 인수항목58개 완료로 해석하지 않는다.

복원은 이번 workbook 지원·artifactPlan·private hook·content binding을 이전 소스와 비교해 제거하되 원래 SQL/B 영수증과 F/cognition 사용자 기억을 삭제하지 않는다. uncertain 파일은 현재 결과와 원래 operation 대사 전에 자동 재실행하지 않는다.
`);
const evidencePaths=['report.md','verification.json','source.json','verified.txt','verified-runner.json','final-compat-v3.txt',
 'final-build.txt','final-contract.txt','bound.txt','compat-v2.txt','independent.json','independent-tests.txt','independent-fence.txt',
 'independent-proof.test.mjs','independent-fence.test.mjs'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'workbook-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'실제 로컬 workbook 생성에 공통 SQL effect와 내용/목적지 계약·공유 B claim을 결속하면 재시작 복구에서 변조 또는 중복 생성 없이 원래 작업을 대사할 수 있다.',
 lesson:'B 자기일치 receipt는 원래 Core 내용 계약의 대체물이 아니다. 재prepare와 async preflight는 각각 계약 변경·취소 신호 손실의 실제 경계였다.',
 limitations:'격리 고유58(57pass/1native skip), true SIGKILL4경계, 독립반증. 실제native PDF/원격/실계정/운영활성화 없음·다른쓰기 미완료·공식60 유지·비용null.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 local Excel createWorkbook common effect/operation/key/receipt·artifactPlan/내용결속·SIGKILL4경계·57pass/1native skip/build/contract·독립반증. 다른등록쓰기/nativePDF/운영활성화 미완료로 부분 유지.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 로컬 Excel 제작 common effect/원래key/receipt·내용/목적지 결속·중단복구·독립2반례 및취소race 수정·고유58중57pass/1native skip/build/contract. 공식60 유지. 다음 남은등록쓰기 contract 감사·native PDF 현장검증.\n`);
console.log(JSON.stringify({observedAt,uniqueChecks:58,passed:57,skipped:1,verified,attempt:`${prefix}-attempt.json`}));
