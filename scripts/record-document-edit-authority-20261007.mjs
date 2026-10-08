import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/document-edit-authority-20261007',observedAt=new Date().toISOString();
const sources=['apps/pc-agent/src/pc-agent-runtime.js','tests/document-edit-authority.test.js','tests/pc-document-safety.test.js','tests/rollback-created-file-guard.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 문서 편집: 현재 권한·원본·백업 보호

관측 ${observedAt}. 공식 인수60/100 유지. 운영 서비스/설치EXE 활성화 없음.

## 재현과 변경

변경 전 actual XLSX4개 검사 모두 실패했다. direct adapter의 현재권한과 signed pathscope가 무시됐고, 지정한 시트가 없으면 첫 시트를 수정하며, findText를 찾지 못하면 다른 요청만 수정하고 success를 반환했다. baseline.txt를 보존했다.

document.edit에 signal/current private fence/context assertAccess를 연결했다. B packet 경로도 실행 중 실제 서명 토큰 상태를 재확인한다. 대상과 백업·임시 파일 모두 allowedroots와 signedpaths를 확인한다. 정확한 시트와 유효한 모든 편집 항목을 요구하며 찾지 못한 요구나 앞선 편집 후 소실된 검색은 저장 전에 실패한다. 임의로 시트/요구를 대체하지 않는다.

원본 dev/ino/size/SHA와 바이트를 관측한 뒤 메모리에서 편집하고, 새 XLSX를 다시 열어 최종 셀 값을 대조한다. 백업과 임시 파일은 충돌 없는 난수 경로/exclusive wx를 사용한다. 원본·백업·stage 현재 상태와 권한을 재검사하고 마지막 검사부터 renameSync까지 비동기 양보 없이 원본을 교체한다. 교체 후 상태나 권한이 바뀌면 failed/uncertain과 원본·백업 경로를 보존한다. undo 기록은 생성한 stage/backup의 원래 신원·해시를 유지하며 기록 직후 현재 파일을 다시 검사한다. 변경된 stage를 정리하지 않는다.

restore_backup_file의 preview와 실행은 편집 직후의 문서와 원래 백업을 각각 대조한다. 변경된 문서, 변조된 백업, 증거 없는 과거 기록은 자동 덮어쓰기를 보류한다. 실행 직전 검사 후 동기 복원하므로 preview 후 변경도 보존한다. restore_previous_file/move_back 전체 보호를 완료했다는 뜻은 아니다.

## 실제 검증

- 새16개 actual XLSX/임시파일 검사: 권한/범위/시트/누락/원본변경/취소/백업생성후철회/정상편집/연쇄편집누락/문서수정후복원보류/백업변조/preview후변경/교체후철회/실제stage후취소/실B서명토큰철회/undo기록중변조.
- 관련 문서안전4와 이전 생성파일 rollback9를 합쳐29/29; 별도 공유 UndoJournal/Excel/PC HTTP7/7. 총36/36·실패0·skip0. native Excel COM은 필요 없는 구조화 ExcelJS 경로다. pc-document-safety의 실제B packet 정상편집·원본복원도 통과했다.
- build/Core contract gate exit0. 테스트 전체 시간은 제품 p50/p95 성능 입증이 아니다. 유료API/실계정/외부메일 실행0, 실제 사용자 기억에 시험업무 추가0. 비용 미측정.
- [Node fs 공식 문서](https://nodejs.org/api/fs.html)의 파일 조회·동기 파일 동작과 로컬 ExcelJS를 재사용했다. 새 모델/패키지 설치로 해결할 문제가 아니라 기존 편집 계약·게시 경계 누락의 수정이다.

## 미완료와 다음 실험

document.edit의 전체 원 요청/입력 해시/백업·출력 manifest를 SQL effect/B claim/영속 receipt/G 현재 내용과 연결하는 작업은 남아 있다. 아직 Core authority allowlist에 이 도구를 추가하거나 모든 중단 복구가 가능하다고 선언하지 않았다. SIGKILL 직후 및 새 CorePID에서 복구하는 전체 Mission 시험도 다음 단계다.

OS 외부 프로세스와의 원자적 compare-and-replace, 모든 엑셀 수식/서식의 의미 인수,64MiB 초과 파일/압축폭탄·대용량 지연, orphan stage/backup 영속 정리는 별도다. 실패 전 생성한 백업은 보존되며 이것을 완성된 자동 청소 기능으로 계산하지 않는다. missing/partial이 성공이 되지 않는 좁은 경로를 검증했지만 전체 자연어 편집 완료율을 보증하지 않는다.

소스 복원 범위는 DocumentEditToolAdapter의 변경 및 B context/restore_backup_file 보호 변경이며 저널의 새 증거는 보존한다. 자동 보호를 해제하는 운영 복원은 권하지 않는다. 기존 원래100개 인수항목은 축소하지 않았다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'document-edit-authority-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'원본 snapshot과 전체편집 검증·현재권한/배타 staging·변조보호 백업 복원을 연결하면 원본 경합과 요구누락에 의한 오수정/허위완료를 줄일 수 있다.',lesson:'원본 편집은 생성 파일과 달리 입력 신원·백업·전체 요구가 게시 직전에 함께 유효해야 하며 되돌리기도 현재 사용자 변경을 덮어쓰면 안 된다.',limitations:'실제XLSX16+회귀20=36/36. SQL effect/claim/새PID복구/운영활성화/모든rollback/OS원자성/대용량·전체서식 의미 미완료. 공식60, 비용미측정.',evidencePaths:['-report.md','-source.json','-baseline.txt','-first.txt','-second.txt','-boundaries.txt','-final-stable.txt','-shared-stable.txt','-build.txt','-contract.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: document.edit 실제XLSX 원본/staging/backup/현재권한·signed scope/전체요구·restore현재변조 보호,baseline4실패수정·36/36/build/contract. 공식60·운영활성화0. 다음 원래편집 SQLeffect/Bclaim/receipt/G현재내용·새PID복구.\n`);
