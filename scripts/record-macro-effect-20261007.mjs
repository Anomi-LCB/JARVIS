import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/macro-effect-20261007',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final-fixed.txt','utf8');
const counts=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(final.match(new RegExp(`ℹ ${key} (\\d+)`))?.[1]??NaN)]));
if(!Number.isFinite(counts.tests)||counts.pass!==counts.tests||counts.fail!==0||counts.skipped!==0)throw Error('Final passing evidence unavailable');
const paths=['packages/core/src/macro-store.js','packages/shared/src/macro-publication-contract.js','apps/verification/src/macro-publication-verifier.js','apps/verification/src/verification-runtime.js','apps/pc-agent/src/pc-agent-runtime.js','packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/mission-requirement-coverage.js','packages/core/src/orchestration/core-orchestration-worker.js','packages/core/src/planning/mission-action-arguments.js','tests/macro-effect-contract.test.js','tests/mission-macro-effect-process.test.js','tests/fixtures/macro-effect-process-child.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,counts,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 매크로 저장: 영속 효과·등록 제어 저장소·독립 검증·재시작 복구

관측 ${observedAt}. 원래100개 인수 기준60 verified/20진행/20대기 유지. 신규 설치본/운영서비스 활성화0. 격리된 temp 실제파일·SQL·자식PID 시험이며 실계정/외부발송/유료모델0, 실제 사용자 매크로/F/cognition 수정0.

## 구현

단일 로컬 macro.save를 원래 Core→E→B→G 경로와 commonSQL effect에 연결했다. 원문·원래 명령과 이름·createdAt·현재 원본 신원·예정 전체 저장소SHA/크기·물리 경로를 SQL request에 고정한다. 모델 인수는 rawText만 받고 경로·준비 계약·권한은 신뢰된 내부 context에서만 전달한다. 준비 후 새PID에서도 원래 createdAt과 결과 바이트를 사용한다.

매크로는 일반 작업폴더 밖의 제어 저장소다. allowedRoots를 사용자 홈으로 넓히지 않고 E의 MACRO_SAVE 행동, 서명/인수 결속과 private effect fence, 등록된 실제 저장소 하나의 B 영속 자원 claim을 함께 검사한다. 계약 변경·등록 저장소 변경·물리 부모 junction 변경·현재권한 철회는 쓰기 전에 거부한다. B 영수증을 SQL의 원래 계약과 대조하고, 별도 G 모듈이 실제 파일을 다시 열어 전체SHA/크기·record·물리 경로를 확인한다. Mission 완료도 원래요청·task/effect·G관측·현재전체파일을 재확인한다. 모델의 완료 응답은 증거가 아니다.

## 실제 시험

최종 수정 이후 ${counts.tests}/${counts.tests}, 실패0·skip0. 매크로 관련43개(계약8·기존prepared9·저장11·잠금5·SQL프로세스10)와 공유 권위·역할·effect·복구·인수·workflow 회귀를 포함한다. 앞선175개 실행에서170통과/5실패였다. 다섯 기존 완료 검증 입력에 waves가 없는데 신규 매크로 분기가 바로 flatMap해 예외를 내는 동일 원인을 수정했다. 마지막 수정은 optional waves 처리이며 해당 다섯 회귀 모두 다시 실행했다. 앞선175 실행 중 document.edit 실제프로세스7과 weather HWPX 실제프로세스7은 통과했으며 최종 ${counts.tests}에 중복 합산하지 않는다. 매크로 첫실행의 G 비가역 postcondition/changedItems 누락, 이름 조사 포함, SQL 정렬 뒤 record 속성순서로 생긴 바이트 불일치도 실제 실패 로그를 보존하고 수정했다. 물리 경로의 루트 바로 아래 미존재 자식명 첫문자 소실도 basename으로 수정하고 파일 생성 없는 반례로 확인했다.

매크로 SQL 실제 자식프로세스10조건: 정상 현재권위 완료; prepared/B영수증/Core영수증 경계 SIGKILL 후 다른PID 복구; 저장 직후 영수증 없는 종료; 영수증 뒤 파일 변경; 위조영수증; 권위철회; 서명범위 변조; 등록store 교체. 완료복구 세 경계는 동일 operation/effect/멱등키·실제adapter호출1회·B claim 해제0잔여를 확인하며 세번째PID 재시작에도 재호출하지 않는다. 저장 직후 영수증이 없거나 현재 결과가 바뀌면 uncertain/PAUSED로 남기고 파일을 보존한다. 이를 성공한 요청으로 계산하지 않는다. 정상 저장 이름은 일일목록, 저장 명령은 파일 목록 확인이다. 명령을 저장한 것이며 그 안의 파일 목록 명령을 실행했다는 뜻은 아니다.

build/Core contract gate 통과. 고정 회귀는 개발 테스트이며 독립 의미평가/실사용 전체 완료율/제품p50·p95 증거가 아니다. 전체 요청 품질·PC연산 비용 미측정, 계정시험/사용자승인횟수 실사용 미측정.

## 연구 및 한계

출처 감시6곳 변화0/오류0. sync/status를 순차 실행했고52후보와 기존 evidence-needs-recheck10·revise-hypothesis3·conditions-missing1·definition-changed1을 유지했다. 기존 매크로 보고서의 SQL 미완료를 이번 실행으로 보완했으며 과거 스냅샷을 바꾸지 않는다. 새 기술 도입 없이 현재 실패에서 출발해 기존SQL/B/G를 재사용했다. [Node24.8 공식파일문서](https://nodejs.org/download/release/v24.8.0/docs/api/fs.html)를 다시 확인해 bytesRead·파일descriptor·realpath의 의미를 대조했다. 현재 G는 짧은 읽기를 안전차단하며 느린 네트워크 저장소 자동완료를 보장하지 않는다. 내용변화감지나 SHA 무결성은 기술적 우월성 또는 결론의 독립 검증이 아니다.

로컬 단일 매크로 저장만 지원한다. 원격 매크로effect, 모든 복합자연어, 모든 등록쓰기/외부거래, 악의적OS 작성자에 대한 원자적sandbox 증명, 설치EXE 적용,30일 관측은 미완료다. physicalPath 없는 기존 준비 계약은 안전하게 거부되므로 수동 대사가 필요하다. 영수증 없는 게시·신원확인 불가 잠금·잠금회수 중 종료의 무조건 자동재시도/강제삭제는 하지 않는다. 원래 V3-040/041 전체 완료로 승격하지 않는다.

복원: 이번 macro 전용 SQL/claim/receipt/G/완료 분기를 제거하면 이전 일반 macro 저장으로 돌아가지만 해당 재시작 보호를 잃는다. 다른 도구분기와 기존 사용자 파일/잠금/원장을 삭제하지 않는다. 다음 최신색인은 남은 등록쓰기·remote·원래100인수의 준비조건과 실행증거를 대조하며90% 목표를 축소하지 않는다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'macro-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,
hypothesis:'등록된 매크로 제어 저장소의 원래 SQL 계약과 private B 권한·영수증·별도 G 현재 대조를 연결하면 새PID 복구 시 중복 저장과 거짓 완료를 막을 수 있다.',
lesson:'일반 작업폴더 밖의 제어 저장소는 홈 권한 확대 대신 등록 행동과 물리 경로에 묶어야 한다. canonical SQL 속성순서와 실제출력바이트를 구분하고 영수증 없는 게시를 재실행하지 않는다. 기존 waves 없는 검증 입력도 보존해야 한다.',
limitations:`${counts.tests}/${counts.tests} 개발회귀·실제PID10조건. 로컬single macro만,원격/EXE/실계정/30일 미완료·공식60유지·제품속도/비용미측정.`,
evidencePaths:['-report.md','-source.json','-first.txt','-completion-debug.txt','-final.txt','-final-fixed.txt','-build-fixed.txt','-contract-fixed.txt','-queue.txt','-watch.txt','-sync.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: macro 등록제어store private권한/commonSQL/영속Bclaim·원래receipt/별도G/현재완료·actualPID10조건·${counts.tests}/${counts.tests}/build/contract. 앞선175실행의waves5실패수정·문서/날씨process14통과 보존. 공식60·설치/운영활성화0. 다음 남은등록쓰기/remote 및 원래100인수·90%목표 유지.\n`);
