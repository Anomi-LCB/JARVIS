import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/macro-lock-20261007',observedAt=new Date().toISOString();
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['packages/core/src/macro-store.js','tests/macro-lock-recovery.test.js','tests/fixtures/macro-lock-process-child.mjs'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 매크로 저장 프로세스 종료 뒤 잠금 복구

관측 ${observedAt}. 공식60/100 유지. 운영서비스 재시작·설치EXE 적용0.

앞선 저장 원본보존 개선에서 lock은 소유자 정보가 없는 빈 파일이었다. 실제 자식 Node를 lock획득 후/임시파일작성 후/게시직후 SIGKILL한3조건 모두 다음 저장에 실패했다. 기준선4중3실패/출처불명잠금 보존1통과를 보존했다.

새 lock에는 version·저장소 경로 binding SHA-256·PID·무작위 nonce·관측시각을 쓰고 fsync한다. 이미 잠겨 있으면 일반파일/크기/신원·내용/지원 버전/binding을 검사한다. process.kill(pid,0)에서 ESRCH가 확인된 경우만 종료된 소유자로 본다. 살아 있거나 PID상태를 확인할 수 없으면 보류한다. PID가 재사용돼 다른 프로세스가 살아 있는 경우도 보수적으로 보류한다.

종료 확인 후 배타 recovery 잠금을 확보하고 원래 lock 신원·내용·소유자 종료와 현재 권한을 다시 검사한 뒤 회수한다. 새 lock은 wx로 확보하므로 다른 저장자가 먼저 얻으면 실패로 보류한다. recovery 정리도 보유 fd의 신원이 일치하는 파일만 대상으로 한다. 파일 나이만으로 active/unknown 잠금을 삭제하지 않는다.

최종31/31 실패0/skip0: 새 복구5(실제3SIGKILL/unknown잠금/다른store binding) + 기존 저장11 + 공유worker·역할15. 실제 자식의 IPC/PID와 lock에 저장된 PID 일치를 검사했고, SIGKILL exit를 기다린 후 다음 저장이 성공하는지 확인했다. 살아 있는 동안에는 MACRO_LOCK_OWNER_ACTIVE와 명령 미추가를 확인했다. 중단 전 old 명령은3조건 모두 유지되며, pending 명령은 게시직후 중단에서만 이미 저장된 채 보존한다. 임시파일 상태의 pending은 실행하거나 채택하지 않는다. 새 after 명령은 재열기에서 확인했다. build/core:contract-gate exit0. 중간15통과는 최종과 중복 집계하지 않는다.

비용 미측정. 실계정·유료호출·외부발송0, 테스트 전용 temp파일만 사용. 사용자 매크로/F/cognition 실제 기억 변경0. 시간 수치는 일반 제품p50/p95 증거가 아니다.

한계: 이것은 협력하는 로컬 저장 프로세스의 잠금 복구이지 commonSQL effect/원래Mission멱등 재개가 아니다. 게시직후 pending이 저장됐다는 사실을 원래 요청 완료 영수증으로 자동 계산하지 않는다. 생성한 owner metadata는 암호학적 신원 증명이 아니며 같은 디렉터리를 임의 수정할 공격자를 차단하는 보안 계층이 아니다. OS compare-and-delete·전원손실·디렉터리fsync·전체 다중장치 경합도 미검증이다. open과 owner메타데이터 쓰기 사이의 종료로 생긴 빈/잘못된 lock, recovery mutex 자체의 비정상 종료는 자동 회수하지 않는다. orphan stage는 원래내용/사용자데이터를 추정해 삭제하지 않고 보존하며 별도 정리 계약이 필요하다.

다음은 매크로 원래명령/저장소전체manifest·commonSQL 영수증/G검증·게시불확실 대사와 원래100개 인수를 이어 진행한다. 이번3경계로 전체V3-040·V3-041을 승격하지 않는다. 소스 복원 시 이미 남은 lock/effect/매크로 파일을 삭제하지 않는다. 이전 빈 lock 구현으로 복원하면 새 owner metadata lock을 자동해석하지 못해 수동 인계가 필요하다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'macro-lock-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'저장소에 결속한 lock소유자 PID와 현재 종료증거·배타회수 검사를 사용하면 살아있는 저장자를 방해하지 않고 실제 비정상종료 뒤 다음 저장을 재개할 수 있다.',lesson:'시간 경과는 프로세스 종료 증거가 아니다. 실제 PID 종료를 기다려야 하며 게시 전/후 상태와 원래Mission 완료를 구분해야 한다.',limitations:'31/31·actualSIGKILL3. SQL멱등/빈lock·recoverymutex종료/orphan정리/OS원자성/운영활성화 미완료·공식60유지·비용미측정.',evidencePaths:['-report.md','-source.json','-baseline.txt','-focused.txt','-final.txt','-build.txt','-contract.txt','-queue.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: macro ownerPID/store binding·종료증거/배타회수·actualSIGKILL3/active·unknown보존·31/31/build/contract. 공식60·운영활성화0. 다음 macro commonSQL/영수증/G/불확실대사와 원래100인수.\n`);
