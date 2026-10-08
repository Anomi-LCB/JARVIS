import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/rollback-overwrite-20261007',observedAt=new Date().toISOString();
const paths=['apps/pc-agent/src/pc-agent-runtime.js','tests/rollback-overwrite-guard.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 덮어쓴 파일 복원: 사용자 변경 보호와 바이너리 원본 보존

관측 ${observedAt}. 공식 인수율60/100(진행20/대기20), 승격0. 새 운영서비스/설치EXE 활성화0.

## 실패 재현과 수정

실제 임시 파일·PC FileSystemToolAdapter·UndoJournal·rollbackTask를 사용했다. 기준선5건 중4건 실패: 후속 사용자 수정본 덮어쓰기, 동일 내용의 다른 파일 덮어쓰기, preview 이후 변경 덮어쓰기, 바이너리 원본 UTF-8 변환 손상. 변경 없는 텍스트 복원 양성1건은 통과했다. 기존 baseline 로그를 보존했다.

이제 덮어쓰기 전 원본 Buffer를 보존하고 원본 해시, 덮어쓰기 후 파일 신원(dev/ino)·크기·SHA-256을 영속 저널에 기록한다. 미리보기와 실행 직전 모두 검사하며 최종 검사→동기 write 사이의 비동기 양보를 없앴다. 변경·교체·없어진 파일과 증거 없는 과거 기록은 자동 복원하지 않는다. 저장 원본의 canonical base64 및 SHA-256도 검사한다. 원본64MiB 초과는 덮어쓰기 전에 차단한다. 새 원본 바이트 필드는 기존 민감키 마스킹·누출 검사에 포함했다.

## 실제 검증

- 최종 고정 소스43/43: 새 복원8 + 생성 rollback9 + 문서 안전4 + 편집권한16 + 편집계약6. 공유 저널/순차이동/Excel/HTTP7/7. 총50/50, 실패0·skip0.
- 새8에는 손상·사용자 변경 음성뿐 아니라 텍스트/바이너리 양성, 원본 증거 변조, 사라진 파일, 실제 새 Node PID에서 영속 저널을 읽어 바이너리를 복원하고 해시 체인을 확인하는 실행을 포함한다. SIGKILL/power-loss 검사는 이번에 수행하지 않았다.
- build 및 core:contract-gate exit0. 비용 미측정; 외부 모델·유료 호출·실계정·외부 발송0. 테스트 시간은 제품 p50/p95 성능 증거가 아니다. F/cognition 실제 업무 기억을 합성 성공으로 채우지 않았다.
- watch6 동일/오류0/reset0, ledger sync/status 완료. 기존 파일 복원 계약 누락이므로 새 모델 설치 대신 로컬 수정했다. [Node 공식 fs 문서](https://nodejs.org/api/fs.html)를 재확인했다. Buffer 원본과 경로 신원 검사는 서로 다른 책임이며 파일 존재만으로 복원 권한을 추정하지 않는다.
- source runtime 상태 조회는 Core/PC/UI ready·operational·신원200을 확인했다. 이미 실행 중인 프로세스에 이번 소스가 로드됐다고 주장하지 않는다.

## 전체 쓰기 경로 색인과 잔여

격리된 실제 runtime registry27개와 trusted-local SQL coordinator를 조회했다. 단일 action 구성에서 공통 effect 대상11개가 반환됐다. 이것은 설정상 자격이며 도구 실행·입력 적격성·실사용 완료 증거가 아니다. JSON에는 읽기와 쓰기 모두 기록했다. desktop.control, shell.execute, weather.createHwpReport 및 readOnly=false인 macro.save/email.send는 해당 공통 경로 대상이 아니었다. macro/email의 mutatesSystem=false를 안전한 읽기로 해석하면 안 된다. 별도 ledger·외부효과와 원격/plan graph는 추가 감사가 필요하다.

base64는 암호화가 아니다. 기존 로컬 저널의 텍스트 원본 보관을 바이너리까지 확장했으며 민감키 마스킹이 저장소 암호화를 뜻하지 않는다. 별도 보호 저장소·저널 용량·대용량 해시 지연은 남았다. 현재 write 자체의 원자성, OS 차원의 compare-and-write, 모든 rollback(move_back 포함), 전원 손실, 원격/설치본 적용까지 해결한 것은 아니다. 과거 증거 없는 저널은 수동 인계가 필요하다.

다음은 weather wrapper/macro 등 공통 효과 사각지대의 실제 실행 증거, move_back 후속 사용자 변경 보호, 원래100개 인수(실계정·클라우드·30일 관측 포함)를 이어 진행한다. 소스 복원은 해당 helper/저널/preview/restore/masking 변경을 이전 구현으로 복원하되 증거 필드는 보존하는 방식이다. 보호 제거를 운영 복원 방법으로 권하지 않는다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'rollback-overwrite-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'원본 바이트와 덮어쓰기 이후 파일 신원·내용 증거를 영속 저널 및 실행 직전 검사에 연결하면 후속 사용자 변경을 보존하면서 바이너리 원본을 정확히 복원할 수 있다.',lesson:'경로 존재 및 UTF-8 텍스트 백업만으로 복원 권한과 원본 무결성을 보장하지 못한다. 범위별 현재 증거와 바이트 보존이 필요하다.',limitations:'격리 실제파일50/50·새PID 복원. OS 원자성/전체rollback/저널암호화/대용량 성능/원격·설치본 적용 미완료. 공식60/100 유지, 비용미측정.',evidencePaths:['-report.md','-source.json','-baseline.txt','-final.txt','-shared.txt','-build.txt','-contract.txt','-tool-inventory.json','-runtime-status.json','-queue.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 덮어쓰기복원4결함 수정·현재파일 신원/내용·원본바이트·새PID복원·50/50/build/contract·registry27/설정effect11색인. 공식60 유지·운영새소스활성화0. 다음 weather/macro 등효과 사각지대·move_back 및 원래100인수.\n`);
