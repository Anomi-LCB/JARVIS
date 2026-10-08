import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/forward-move-20261007',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final-v2.txt','utf8');
if(!final.includes('ℹ pass 24')||!final.includes('ℹ fail 0')||!final.includes('ℹ skipped 0'))throw Error('Final 24-case evidence missing');
const paths=['apps/pc-agent/src/pc-agent-runtime.js','tests/forward-move-conflict.test.js','tests/mission-move-effect-process.test.js','tests/fixtures/move-effect-process-child.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 파일 이동·복사 충돌과 부분 효과 기록 수정

관측 ${observedAt}. 원래100 인수60 완료/20진행/20대기 유지. 90% 목표를 축소하지 않는다. 실행 중 운영서비스·설치 EXE에 새 코드 활성화0, 외부 계정·유료 호출·발송0. 합성 로컬 자료와 격리 temp를 사용했다.

## 변경 전 재현

사전 검사 후 beforeMoves에서 대상 파일을 생성하면 기존 rename/copyFile이 그 파일을 덮어썼다. 이동·복사2개 반례가 실제 실패했다. 배치 첫 이동 후 fence가 실패하면 예외만 올라가 첫 결과가 반환되지 않는 반례1개도 실패했다. 정상 파일 복사/Windows 폴더 이동은 통과했다. 기준선4개 중3실패이며 결과를 보존했다.

## 구현

파일 이동은 배타적 hardlink 게시 후 원본 이름 제거로 바꾸고 게시 직후 변경 내역을 저장한다. unlink 실패 시 이미 만들어진 대상을 숨기지 않고 원본 잔존 여부를 남긴다. hardlink 미지원 Windows 파일 시스템은 비덮어쓰기 File.Move로 진행할 경로를 유지한다. 복사는 COPYFILE_EXCL을 적용하며 비동기 복사를 유지한다. Windows 폴더는 Directory.Move로 기존 폴더 이동 기능을 유지한다. 인수는 단일 인용부호를 이스케이프하고 EncodedCommand로 전달하며 숨겨진 PowerShell 프로세스를 사용한다. 교차 볼륨을 암묵적으로 복사·삭제로 바꾸지 않는다.

mkdir 전과 비동기 경계 뒤 모두 물리 경로와 허용 루트를 확인한다. 대체 파일명으로 해결한 충돌도 허용 루트 밖으로 빠져나가지 못한다. 배치 중간 실패는 failed/uncertain, 실제 출력·처리 내역·복구 기록을 보존한다. B 실패 packet 결과도 파일 이동에서는 즉시 영속 기록한다. 불명 상태를 성공으로 바꾸거나 다음 재시작에서 배치를 다시 실행하지 않는다.

## 검증

최종24/24 실패0/skip0: 새 충돌·경로 검사7, 실제 Core/E/B/G 이동·효과 원장의 별도PID 복구7, 안전한 rollback10. 늦은 두 번째 대상 파일이 생기는 실제 실행에서 첫 이동만 완료되고 둘째 원본/사용자 대상 모두 보존된다. 재시작 후 원장은 uncertain, 재실행0, B의 부분 결과1개와 출력1개가 다시 읽힌다. 기존 정상이동/receipt 대사/권위/복원/변경 파일 보존도 함께 통과했다.

중간 새 프로세스 검사의 처음1실패는 테스트에서 packet 로그 경로를 잘못 가정한 ENOENT였다. 임의 경로 대신 재시작한 실제 packetJournal 결과를 관측하도록 검사만 고쳤다. 최종21개 뒤 경로 검사3개를 추가한24개 결과가 최종이며 중간4/21을 더하지 않는다. build/Core contract gate 통과.

더 넓은 ag-runtime 포함 회귀는 session24850에서 실제 진행 중이며 이 보고서 시점에는 미완료다. 해당 진행 로그는 forward-move-20261007-regression.txt이며 통과 총계로 계산하지 않는다. 초기 실행 중 소스가 추가 보강됐으므로 그 회귀가 끝나도 최종 소스의24개 검사를 대체하지 않는다. 새로운 실행을 중복 시작하지 않는다.

## 근거·한계·다음 작업

[Node24.8 fs 문서](https://nodejs.org/download/release/v24.8.0/docs/api/fs.html)의 COPYFILE_EXCL과 [Microsoft Directory.Move](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.move?view=net-9.0)의 대상 존재 예외를 확인했다. 공식 문서와 SHA는 이번 실행 증거의 독립 품질평가를 대신하지 않는다.

파일/폴더 전체 처리 시간을 제품 p50/p95로 측정하지 않았다. Windows 기본 NTFS에서 실측했으며 hardlink 미지원 볼륨 fallback·다른OS 폴더의 rename-no-replace·임의 외부OS 프로세스에 의한 최종 파일 신원 교체·복사실패 후 OS 삭제실패 등 모든 파일 시스템 경합을 검증한 것은 아니다. 비Windows 폴더 이동은 기존 renameSync 동작을 유지해 추가 native 보호가 남는다. 복원 정책은 안전한 regular file snapshot 중심이므로 폴더 rollback을 완성했다고 주장하지 않는다. 실제 사용자 F/cognition에 시험 결과를 쓰지 않았다. 과거 실제 운영 undo-journal 무변경의 전후 해시는 이번에 확보하지 않아 해당 증명을 주장하지 않는다.

복원은 이번 FileMoveToolAdapter 충돌/부분결과 변경과 파일 이동 실패의 즉시 packet 기록만 되돌리는 방식이며 기존 사용자 자료·원장·권한을 삭제하지 않는다. 보호를 되돌리면 덮어쓰기 결함이 돌아온다. 다음은 실행 중 광범위 회귀의 실제 종료 확인, 남은 원문 의미·계정/상시 배포·기기·30일 인수다. 공식 인수를 검사 개수로 올리지 않는다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'forward-move-20261007',candidateId:'m12-signed-promotion-journal-and-recovery',kind:'workflow-test',reportedOutcome:'passed',observedAt,
hypothesis:'배타적 대상 게시와 배치 부분 효과의 영속 기록을 기존 실행 경로에 적용하면 사전 검사 이후의 충돌을 덮어쓰지 않고 재시작 중복 실행을 막을 수 있다.',
lesson:'사전 검사만으로 동시 대상 생성에 안전하지 않다. 실패에도 이미 실행한 변경을 원장과 packet receipt에 남겨야 복구가 거짓 완료나 재실행으로 변하지 않는다.',
limitations:'변경전3실패 재현·최종24성공/build/contract. 광범위 회귀session24850 미완료. Windows NTFS 관측이며 비Windows directory native 경합/미지원볼륨/전체외부OS교체 미검증. 공식60/운영활성화0.',
evidencePaths:['-report.md','-source.json','-baseline.txt','-focused.txt','-process.txt','-final-v2.txt','-build.txt','-contract.txt','-queue.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n最新 ${prefix}-report.md: 이동/복사 늦은대상 덮어쓰기2·부분효과누락1 재현수정, 최종24/24/build/contract. 공식60·운영활성화0. ag-runtime 광범위회귀session24850 실제진행중/재시작금지; 종료를 다음에 확인. 비Windows directory/native 경합/미지원볼륨 및 원래100 인수 계속.\n`);
