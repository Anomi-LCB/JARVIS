import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/weather-effect-20261007',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-final-original-contract.txt','utf8');
if(!log.includes('ℹ fail 0')||!log.includes('ℹ pass 113'))throw Error('Final tests not completed');
const paths=['apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/weather/publication-contract.js','packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js','packages/core/src/mission/mission-requirement-coverage.js','packages/core/src/orchestration/core-orchestration-worker.js','apps/verification/src/verification-runtime.js','packages/core/src/planning/mission-action-arguments.js','tests/mission-weather-effect-process.test.js','tests/fixtures/weather-effect-process-child.mjs','tests/weather-source-binding.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 날씨 보고서: SQL 효과·원래 예보·실제 HWPX·종료 복구

관측 ${observedAt}. 공식 인수60/100(진행20/대기20) 유지. 이번 소스 적용을 실행 중인 운영 프로세스/설치EXE에 활성화하지 않았다.

## 연결과 실패 수정

weather.createHwpReport를 trusted-local single-action SQL 효과 대상, B 공유 게시 claim/영속 packet receipt/대사 경로, Core 권위 래퍼, G 현재 HWPX 검사에 연결했다. SQL request.weatherPublication에 원래 예보·출처 evidence·한글 원문/전체 출력 manifest를 저장한다. Core와 두 execution wrapper가 private fence로 전달해 B에서 예보를 다시 조회하지 않는다. HWP beforeArtifactWrite는 SQL 원래 문서 준비 해시 및 전체 경로를 대조한다. 외부/원격 연결 지원으로 확대하지 않았다.

실제 Mission에서 처음 명령을 실행했을 때 요구 해석 보류를 확인했다. 요구 검사를 해제하지 않고 전체 원문과 실행 인수를 대조하는 제한된 문법을 추가했다: “지역: 서울 향후 7일 날씨 통계를 한글 보고서로 만들어줘”. 지역·7일 범위·한글 보고서·허용 출력 경로·한 행동을 요구하고 추가 명령/금지/정정/충돌은 자동 확대하지 않는다. 별도5조건으로 다른 지역·범위 밖 출력·추가 메일 명령·여러 행동·미검증 결과 완료를 거부한다. 이것은 전체 자연어 의미 평가의 완료가 아니다.

그 후 private fence를 감싼 worker가 weather 계약 필드를 누락해 B가 재조회하고 영수증 계약에 실패했다. 두 래퍼에서 원래 snapshot 전달을 보강했다. 준비 직후 실제 SIGKILL 재개에서는 예보를 두 번 조회하는 실패도 확인·수정했다. 기존 prepared SQL intent의 task/operation/action/인수/roots/실행자 일치 및 현재 권한을 확인한 뒤 원래 snapshot을 재사용한다.

Core onReceipt와 복구 모두 원래 weather 계약에 대해 예보 evidence/hash뿐 아니라 HWP 전체 manifest·문서·실제출력 목록·target/render 경로를 비교한다. 영수증 문서와 manifest를 함께 다른 내용으로 바꾼 실제 B 반환 반례는 SQL 성공으로 올리지 않고 uncertain으로 보류했다. 이미 생성된 파일은 보존한다.

## 실행 증거

최종 고정 소스113/113, 실패0/skip0. 구성: 실제 별도 프로세스7 + 원문 weather binding5 + 기존 요구검사/날씨/취소/응답제한/인수/worker 권위101. build/core:contract-gate exit0. 중간112통과 결과는 이후 원래전체계약 강화 전이므로 최종 증거 대신 쓰지 않았다. 중간 실패·baseline 로그를 보존했다.

실제 프로세스7: prepared, B receipt 기록, Core receipt 저장, 부분 발행, 현재 파일 변경, 정상 실행 권위, 변조 영수증. 정상/복구는 실제 Python HWPX 생성·G현재내용 검사·SQL효과 succeeded·B claim0·원래operation/effect/key/receipt 보존을 확인했다. prepared/Breceipt/Corereceipt는 새 PID 재개와 반복 재조회에서 완성된 adapter 반환1회, 예보 조회1회를 검사했다. 부분 발행·후속 파일 변경은 재제작하지 않고 uncertain/PAUSED다. 변조 영수증은 이미 파일이 있는 상태에서도 A_MISSION_EFFECT_WEATHER_RECEIPT_CONTRACT_MISMATCH로 보류한다. 실제 native HWP/렌더 옵션 true는 이번7조건에 포함하지 않았다.

예보는 합성7일 JSON이며 공식 제공자를 실제 호출한 증거가 아니다. 사용자 프로필·실계정·메일·금융·유료호출·외부발송0. F/cognition은 격리 temp SQL이며 실제 사용자 기억을 시험 성공으로 채우지 않았다. 비용 미측정. 테스트 duration은 일반 제품p50/p95 또는 사용자가 기대한 성능 비교가 아니다. Runtime 상태 파일은 현재 서비스 조회만 뜻하고 이번 소스가 로드됐다는 증거가 아니다.

## 남은 범위와 복원

정해진 단일 weather 문법 외 다양한 원문·실예보 freshness/자료 유효기한·Core 준비 중 즉시취소·실제 HWP렌더·원격계약·설치본 적용은 남았다. helper의 hash만으로 외부 예보 진실성이나 보안 권위를 입증하지 않는다. 공통효과의 등록쓰기 전수(매크로/셸/화면/메일 별도효과), 클라우드/계정/기기/30일 관측 및 원래100개 인수도 남았다. 따라서 이번 경로 성공으로 V3-040 전체를 승격하지 않는다.

복원은 weather effect 포함목록·prepare/worker private 전달·한정 원문 binding·원래 receipt 검증 변경을 소스 복원하는 방식이다. 기존 SQL effect/receipt를 삭제하거나 다른 인수로 재실행하지 않는다. 이미 효과가 남은 Mission은 원래 영수증을 대사해야 한다. 다음은 남은쓰기 및 미완료원문/사용자 연결 인수를 이어 진행한다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'weather-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'원래 예보/HWP 전체문서 계약을 SQL 효과와 private B guard·영속receipt·독립 현재검증에 연결하면 재시작 뒤 재조회·중복제작 및 변조 완료를 막을 수 있다.',lesson:'준비 helper만으로는 원장 권위가 전달되지 않는다. worker wrapper와 prepared 재개 경로까지 원래 snapshot을 보존하고 전체 receipt를 대조해야 한다.',limitations:'113/113·실HWPX/actualSIGKILL·합성예보. 실제공식API/nativeHWPrender/일반의미/원격/운영EXE/전체쓰기인수 미완료. 공식60유지·비용미측정.',evidencePaths:['-report.md','-source.json','-first.txt','-second.txt','-third.txt','-regression.txt','-prepared.txt','-final-original-contract.txt','-build-final.txt','-contract-final.txt','-runtime-status.json','-queue.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: weather 원래예보/한글manifest SQL·private B claim/receipt/G·actual7프로세스/재조회1회·한정원문binding/복구·113/113/build/contract. 공식60·운영활성화0. 다음 매크로등남은쓰기·일반원문/계정/설치 및 원래100인수.\n`);
