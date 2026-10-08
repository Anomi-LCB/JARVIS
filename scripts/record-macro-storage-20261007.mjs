import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/macro-storage-20261007',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-final-stable.txt','utf8');if(!log.includes('ℹ pass 26')||!log.includes('ℹ fail 0'))throw Error('Final tests missing');
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['packages/core/src/macro-store.js','apps/pc-agent/src/pc-agent-runtime.js','packages/core/src/orchestration/core-orchestration-worker.js','tests/macro-storage-safety.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 매크로 저장: 실제 성공·원본 보존·현재 권한

관측 ${observedAt}. 공식60/100 유지. 운영서비스 재시작·설치본 적용0.

기존 MacroStore.persist는 모든 IO 오류를 삼켰고 save는 메모리를 먼저 변경한 후 true를 반환했다. 손상 JSON을 빈 저장소로 취급해 기존 파일을 덮어썼다. 기본{}의 상속 key constructor/__proto__를 등록된 매크로로 반환했다. MacroSaveToolAdapter는 현재 권위/취소 context를 받지 않았고 실제 쓰기인데 mutatesSystem=false였다. 기준선4개 모두 실패했다.

저장 경로는 배타 lock→fresh strict snapshot→bounded JSON 생성→소유 임시파일 wx쓰기/fsync→현재 권위와 원본 신원·내용 재검사→rename→전체 저장바이트 재검증 순서다. 성공 검증 이후에만 메모리를 갱신한다. 손상·잘못된 스키마·심볼릭 링크 파일·2MiB 초과·잠금충돌은 기존 저장소를 보존하고 실패한다. 두 store instance의 순차 저장은 최신 파일을 읽어 다른 명령을 보존한다. 새로운 맵은 null prototype이며 resolveRun은 own key만 허용한다. constructor라는 실제 등록 이름은 정상 저장·조회할 수 있다.

adapter는 취소·현재 fence/context를 검사하고 최종 rename 전에도 다시 검사한다. mutatesSystem=true 및 Core local authority fence 대상에 연결했다. 게시 후 검증 실패는 성공으로 숨기지 않고 failed/uncertain 및 관측 파일 위치를 반환한다. 임시파일/lock 정리는 기록한 dev/ino가 일치하는 소유 파일만 대상으로 한다.

최종26/26 실패0/skip0: 새저장11+공유worker권위/역할15. 새 검사는 실제 파일·손상·IO실패·상속키·현재권위·취소·두instance·마지막권위거부·foreign lock·게시후 검증실패·전체저장소 후속변경·실제 새Node PID 재조회다. build/core:contract-gate exit0. 초기25통과는 전체바이트 검증 보강 전이며 최종과 중복 계산하지 않는다. 기준선·중간 로그 보존. 실제 Core→PC→SQL 매크로 Mission이나 SIGKILL 복구를 검증한 것은 아니다.

비용 미측정. 실계정·발송·유료호출0. 테스트 전용 temp파일만 사용하고 기존 사용자 매크로/F/cognition 자료를 수정하지 않았다. 신뢰한 로컬 MacroStore API의 설정 경로이며 임의 model path 등록 기능이 아니다.

한계: common SQL effect/멱등 영수증·자격증명/암호화·rollback·권한별 저장 경로 계약·설치본 적용은 남았다. lock 소유 프로세스가 비정상 종료하면 stale lock을 자동 삭제하지 않아 후속 저장이 보류될 수 있다. 디렉터리 fsync/전원손실/OS 원자적 compare-and-write·전체 프로세스 경합 보장은 아니다. 2MiB 제한에서의 메모리/지연 측정도 별도다. 손상 저장소는 읽기에서 빈 맵으로 표시될 수 있지만 저장은 strict검사로 기존 파일을 보존한다. 기존 public persist 호출은 저장 경로에서 제거했고 저장소 내 직접 호출은 save만 확인했다.

다음은 stale lock의 검증된 인계/복구와 매크로 원래명령·공통SQL 효과, 나머지 쓰기 경로 및 원래100개 인수다. 이번 개선으로 V3-040 전체를 승격하지 않는다. 복원은 MacroStore와 adapter/fence 수정의 소스 복원이며 기존 매크로 파일·기록을 삭제하지 않는다. 이전 오류삼킴 경로로 운영 복원하는 것을 권하지 않는다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'macro-storage-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'매크로 쓰기를 현재권위·배타게시·원본보존·전체재조회 검증에 연결하면 거짓저장완료와 기존명령 손실을 줄일 수 있다.',lesson:'선택 기능이라는 이유로 저장오류를 삼키면 사용자에게 잘못된 완료를 알린다. 저장증거 이후 메모리를 갱신하고 게시 이후 불확실 상태를 구분해야 한다.',limitations:'26/26·실파일/새PID조회. SQL효과/SIGKILL/stale lock회수/전체OS원자성/운영설치 미완료. 공식60유지·비용미측정.',evidencePaths:['-report.md','-source.json','-baseline.txt','-focused.txt','-final.txt','-final-stable.txt','-build-stable.txt','-contract-stable.txt','-queue.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 매크로 거짓저장/손상덮어쓰기/상속키/권위4결함·배타게시/전체바이트재검증/불확실표시·실파일/새PID조회·26/26/build/contract. 공식60·운영활성화0. 다음 stale lock복구/commonSQL 및 원래100인수.\n`);
