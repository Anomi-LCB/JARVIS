import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/rollback-move-20261007',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final-fixed.txt','utf8'),shared=await readFile(prefix+'-shared.txt','utf8');
if(!final.includes('ℹ pass 43')||!final.includes('ℹ fail 0')||!shared.includes('ℹ pass 7')||!shared.includes('ℹ fail 0'))throw Error('Final evidence unavailable');
const paths=['apps/pc-agent/src/pc-agent-runtime.js','tests/rollback-move-guard.test.js','tests/fixtures/rollback-move-process.mjs','tests/rollback-created-file-guard.test.js','tests/rollback-overwrite-guard.test.js','tests/mission-move-effect-process.test.js','tests/mission-macro-effect-process.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 이동 복원: 현재 파일 보존과 배타적 원위치 복원

관측 ${observedAt}. 원래100개 인수60 verified/20진행/20대기. 이번 실행은 격리 temp 파일·실제 B 이동/rollback·새 PID·공유 Core/E/B/G 회귀다. 운영서비스/설치EXE 활성화0, 실계정/외부발송/유료모델0. 사용자 실제 파일·F/cognition 수정0.

## 원인과 변경

기존 move_back은 현재 이동 위치의 파일 존재와 복원 위치의 부재만 미리 확인하고 await mkdir/rename으로 복원했다. 이동 뒤 사용자가 바꾼 내용, 같은 내용의 다른 파일, preview 이후 새 복원 대상, allowedRoots 안에서 바뀐 부모junction을 구분하지 않았다. rename은 늦게 생긴 복원 대상도 덮어쓸 수 있었다.

이제 이동 기록에 현재 파일의 dev/ino/크기/전체SHA와 두 물리경로를 보존한다. rollback 미리보기와 마지막 실행 직전에 같은 파일·내용·물리경로인지 대조한다. 원래 위치로의 게시에는 배타적 hard link를 사용해 늦게 생긴 대상도 덮어쓰지 않고, 두 경로의 원래 파일 증거를 확인한 뒤 현재 위치를 제거한다. 마지막 체크부터 link/unlink까지 애플리케이션의 await를 두지 않는다. 원래 복원 대상이 이미 있거나 기록에 증거가 없으면 파일을 보존하고 보류한다. 생성→이동→삭제 같은 의존 undo 순서는 가상 snapshot을 이어받으며 기존 순서를 유지한다.

## 실행 증거

변경전 새8테스트는8실패였다. 그중7건은 실제 안전 반례(내용수정·같은바이트교체·preview후수정·preview후복원대상생성·원래증거누락·symlink교체·parentjunction변경)다. 나머지1건은 이미 완료된 rollback의 재요청에 성공을 기대한 신규 테스트 오류였다. 기존 API는 pending 기록이 없으면 B_ROLLBACK_NOT_FOUND를 반환한다. 이 계약을 유지하고 재요청이 파일을 변경하지 않는지 검사하도록 새 테스트를 정정했다. 이1건을 제품 결함 수정으로 계산하지 않는다.

최종43/43 실패0 skip0: 새 이동보호10 + 생성보호9 + 덮어쓰기보호8 + 실제 Mission 이동 SIGKILL 복구6 + 매크로 SQL 프로세스 회귀10. 별도 기존 ag-runtime rollback 관련7/7 통과로 고유50개 성공. 단순 record 모의만 쓰지 않고 실제 filesystem.moveFiles 어댑터 실행→journal 영속→다른PID rollback을2조건(원래파일 정상복원,후속사용자변경 거부)으로 확인했다. 공유 검사에는 UndoJournal 영속/의존역순복원/부분skip/HTTP rollback/Core compensation/G rollback증거 검사가 포함된다. 중간43을 최종과 중복 합산하지 않는다. build/Core contract gate 통과.

처음 넓힌 실행35건 중 기능 패키지 rollback-recovery 별도4건은 Docker Desktop Linux 엔진 pipe가 없어 CONTAINER_CREATE_FAILED로 실패했다. 이는 파일 이동 rollback 시험과 다른 capability 패키지 복구 검사다. 해당 실패 로그를 보존하고 준비 조건 차단4로 분리했다. Docker 시험은 재실행/성공으로 기록하지 않았다. 따라서 이번 선택 범위 총54건은 성공50·환경차단4이며 차단을 분모에서 숨기지 않는다. 개발회귀 성공률을 제품 전체 실사용 성공률로 표현하지 않는다.

## 한계와 복원

파일증거 snapshot은 기존64MiB 제한을 따른다. 디렉터리·원래증거 없는 과거기록·다른볼륨·hard link를 지원하지 않는 파일시스템은 자동복원을 보장하지 않는다. link 뒤 unlink/영속 marker 전에 종료되면 두 경로가 남을 수 있어 무조건 재시도하지 않고 원래증거 대사/인계가 필요하다. 같은 원장 기록으로 복원했다고 다른 앱/계정/OS/모든 자연어가 완료된 것은 아니다. OS 공격자가 동시 디렉터리를 바꾸는 상황에서의 원자적 compare/unlink·sandbox 증명을 주장하지 않는다. 제품 p50/p95·PC연산비·실사용개입 횟수는 미측정이다.

복원은 이번 move_back journal 증거/미리보기/배타적실행 분기만 이전 구현으로 되돌릴 수 있으나 현재변경 보존 기능을 잃는다. 기존 사용자 파일·journal·SQL·lock은 삭제하지 않는다. 최신 실행색인에 남은 등록쓰기/일반 원문/remote 및 원래100개 인수 조건을 연결했다.90% 목표를 축소하지 않으며 V3-040/041 전체 승격0이다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'rollback-move-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,
hypothesis:'이동 당시 파일 신원/내용/물리경로를 영속하고 복원 직전 재검사·배타 게시하면 후속 사용자 파일 변경과 새 복원 대상의 덮어쓰기를 막을 수 있다.',
lesson:'존재 여부와 allowedRoots만으로 원래 파일을 식별할 수 없다. 늦은 대상은 rename 대신 배타적 게시로 보존하고, 새 시험의 잘못된 API 성공 기대는 제품 결함과 구별한다.',
limitations:'선택54건 성공50·Docker 미가동 차단4. 격리 실제파일/새PID·설치/운영 미활성·64MiB/파일/동일볼륨 경계·OS원자성 및 장기실사용 미검증·공식60유지.',
evidencePaths:['-report.md','-source.json','-baseline.txt','-focused.txt','-final-fixed.txt','-shared.txt','-build.txt','-contract.txt','-queue.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: move_back 실제후속변경/동일내용교체/late target/parentjunction7반례 보호·배타link 게시·실제어댑터새PID2·50성공/Docker차단4/build/contract. 공식60·운영활성화0. 다음 남은등록쓰기/일반원文·remote와 원래100인수·90%목표 유지.\n`);
