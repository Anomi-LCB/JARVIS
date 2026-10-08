import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/rollback-created-20261007',observedAt=new Date().toISOString();
const sources=['apps/pc-agent/src/pc-agent-runtime.js','tests/rollback-created-file-guard.test.js','tests/ag-runtime.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const raw=await readFile('artifacts/research-heartbeat-20261007-status.txt','utf8');
const status=JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1));
await writeFile(prefix+'-research-summary.json',JSON.stringify({observedAt,candidateCount:status.candidateCount,watch:status.latestWatch,nextStates:status.nextReview??null},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 생성 파일 되돌리기: 수정·교체 파일 보호

관측: ${observedAt}. 공식 인수율60/100 유지. 설치EXE/운영서비스 활성화 없음.

## 실제 실패와 수정

격리된 실제 파일과 PC 에이전트의 UndoJournal/rollbackTask로 검사했다. 변경 전4개 중3개가 실패했다. 생성 후 사용자 수정, 같은 경로에 동일 내용의 새 파일 배치, 미리보기 이후 수정 모두 삭제됐다. 원인은 경로 존재만 검사하고 rm(force)를 수행했기 때문이다. baseline.txt를 보존했다.

새 delete_created_file 기록은 파일의 dev/ino/크기/SHA-256을 저널 해시에 포함한다. 미리보기와 실행 직전에 각각 대조하며 마지막 대조와 unlink 사이에 비동기 양보를 하지 않는다. 수정·교체·심볼릭 링크와 증거 없는 과거 기록은 보류한다. 없는 파일은 정상 no-op이며 미리보기 후 다른 파일이 나타나면 보류한다. 실패 시 causeCode를 반환한다. 생성→이동의 미리보기는 이동 대상의 관측 증거를 가상 상태에 전달하고 실제 실행에서 다시 검사한다.

기존 순차 이동 테스트는 파일이 이동된 후 존재하지 않는 staging 경로를 처음 기록하는 비현실적 fixture였다. 실제 생성→저널기록→이동 순서로 수정했고, 증거 없는 기록 차단을 별도 음성 테스트로 유지했다. 최초 공유 검사에서 rename 미수입 실패1건을 확인·수정했고 로그를 보존했다.

## 검증과 근거

- 최종 고정 소스: 신규9 + 문서안전4 + 카드권한8 =21/21. 공유 UndoJournal/저널재열기/순차이동/Excel/HTTP 검사7/7. 총28/28, 실패0·skip0. 테스트 시간은 제품 지연 목표/p50/p95의 증거가 아니다.
- 새 검사에는 실제 임시 파일/영속 JSONL 재열기, 동일 내용 다른 inode, 실제 symlink, preview 후 변경, 과거 미증거, 이동, 없어짐 양성을 포함한다. 프로세스 SIGKILL·실계정·외부 발송은 이번 범위에서 실행하지 않았다. 실제 업무 F/cognition을 시험 결과로 채우지 않았다.
- build와 core:contract-gate exit0. 비용 미측정. 유료 호출과 계정 변경 없음. 임시 워크스페이스와 저널만 사용했다.
- 감시6곳 변화0/오류0/기준선초기화0. 장부 sync/status 완료. 새 모델을 도입할 문제가 아니라 기존 삭제 계약의 누락이므로 로컬 수정 경로를 택했다.
- [Node 공식 fs 문서](https://nodejs.org/api/fs.html): lstat과 unlink의 책임이 다르므로 경로의 존재나 producer 성공만으로 파일 소유를 추정하지 않았다. 이 사용자 공간 검사는 OS 원자적 compare-and-delete 구현이 아니다.

## 한계와 다음 작업

64MiB 초과 파일이나 안정적인 일반 파일 증거를 확보하지 못하면 자동 삭제를 보류한다. 과거 원본 증거가 없는 기록도 자동 삭제하지 않는다. 파일 내용 자체는 저널에 새로 복제하지 않는다. 같은 OS 프로세스의 경합 전체를 원자적으로 배제한 것이 아니며 대용량 해시 지연은 별도 측정이 필요하다.

restore_previous_file/restore_backup_file/move_back 자체의 사용자 변경 보호 및 권한 계약, document.edit 원본/백업/SQL 효과/중단복구, orphan staging 영속 정리와 나머지100개 인수는 남았다. 이번 생성파일 삭제 보호를 전체 rollback 또는 전체쓰기 완료로 확대하지 않는다. 복원은 관련 helper/record/preview/delete 변경을 이전 코드로 되돌리는 소스 복원이며 새 저널 필드는 보존한다. 보호를 해제하는 운영 복원은 권하지 않는다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'rollback-created-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'생성 시의 파일 신원과 내용 증거를 영속 저널과 실행 직전 대조에 연결하면 후속 사용자 변경 및 경로 교체 파일의 오삭제를 막을 수 있다.',lesson:'경로 존재와 dry-run 통과는 현재 파일의 삭제 권한 증거가 아니다. 증거 없는 과거 기록과 변경 후 파일은 보류해야 한다.',limitations:'28/28 실제 파일·격리 저널. 모든 rollback/OS 원자성/대용량 성능/document.edit/운영 활성화 미완료. 공식60/100, 비용미측정.',evidencePaths:['-report.md','-source.json','-baseline.txt','-focused.txt','-shared-first.txt','-final-stable.txt','-shared-stable.txt','-build.txt','-contract.txt','-research-summary.json'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 생성파일 manual rollback 오삭제3반례 수정·신원/내용 저널·실행직전 재검사·실제파일9/공유19=28통과/build/contract. 공식60·운영활성화0. 다음 document.edit 원본/backup/전체효과·다른 restore/move rollback 현재변경 보호.\n`);
