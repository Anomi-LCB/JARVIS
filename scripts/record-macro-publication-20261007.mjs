import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/macro-publication-20261007',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final-original.txt','utf8');
if(!final.includes('ℹ pass 40')||!final.includes('ℹ fail 0'))throw Error('Final evidence unavailable');
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['packages/core/src/macro-store.js','apps/pc-agent/src/pc-agent-runtime.js','tests/macro-publication.test.js','tests/macro-storage-safety.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 매크로 원래 요청·전체 저장소 게시 계약

관측 ${observedAt}. 공식60 verified/20진행/20대기 유지. 운영서비스/설치EXE 활성화0.

이번에는 일반 macro.save 경로에 준비 계약과 저장 후 실제 전체 파일 대조를 적용했다. 준비 시 원문·정규화 key·명령·createdAt·등록된 저장소 절대 경로·원본 파일 신원/전체 SHA·예정 결과 전체 SHA/크기를 고정한다. prepared 객체를 JSON으로 전달해 실제 다른 PID에서 저장해도 같은 createdAt과 전체 결과 SHA를 유지했다. 준비한 뒤 다른 명령이 추가되거나 원본 신원/내용이 바뀌면 원래 명령을 다시 해석해 덮어쓰지 않고 보류한다.

이름/명령/경로/SHA/크기/원문 변조6가지와 다른 명령의 보존을 검사했다. 현재 재조회는 새 매크로 한 항목뿐 아니라 이전 명령이 포함된 전체 저장소 SHA를 대조한다. 저장 후 old 항목을 제거하면 새 항목이 남아 있어도 완료 관측을 거부한다. 게시 후 관측 실패는 실제 파일을 보존하며 uncertain으로 반환한다. 최종 권한 철회/취소는 원본을 보존한다. 손상JSON은 준비부터 거부한다.

확인 중 기존 snapshot의 UTF-8 대체 디코딩 결함을 추가 재현했다. 잘못된 바이트가 있는 기존 명령을 정상JSON으로 읽어 대체문자로 다시 저장할 수 있었다. 변경전 해당1시험 실패를 보존했다. fatal UTF-8로 읽도록 수정해 invalid 바이트를 거부하고 기존 파일을 변경하지 않게 했다. 정상 한글은 유지한다.

최종40/40 실패0·skip0: 준비 계약9 + 기존 저장11 + 실제 SIGKILL 잠금복구5 + 공유worker·역할15. 새로운 prepared 계약은 실제 다른 PID의 전달/저장/전체재관측을 확인했다. SIGKILL3경계는 기존 MacroStore 직접 저장 경로의 회귀이며 prepared 계약의 SQL 재시작 시험으로 주장하지 않는다. 저장 후 관측은 동일 MacroStore의 별도 현재 읽기이며 별도 독립 G검증기 또는 의미 평가가 아니다. 중간23/38/39검사는 최종과 중복 집계하지 않는다. build/core contract 통과.

commonSQL 연결은 아직 미완료다. 기본 매크로 파일은 사용자 작업폴더 밖의 전용 제어 저장소라 일반 파일용 B publication claim이 검사하는 allowedRoots/서명 범위를 그대로 쓰거나 무조건 넓히면 안 된다. 다음 단계는 모델이 전달한 임의 경로 대신 등록된 저장소 하나에만 결속한 제어 자원 권한·영속 claim을 추가하고, 원래 prepared 계약을 SQL request에 저장해 receipt/G 현재 대사/실제 프로세스 종료 후 복구에 연결하는 것이다. 이번에는 coordinator supported 목록을 확대하지 않았고 재시작 멱등 완료를 주장하지 않는다. 원래 목표인 최소90% 인수를 축소하지 않는다.

실계정·외부발송·유료모델0. 테스트는 격리 temp파일/합성명령이며 사용자 매크로와 실제 F/cognition 변경0. PC연산 비용 미측정, 제품p50/p95 미측정. 보존한 계약은 private context에서 사용하며 model args에 준비 계약을 받는 새 권한을 추가하지 않았다. 이 계약 자체가 악의적 디렉터리 작성자에 대한 보안·OS 원자성 증명은 아니다. 전체V3-040/041 승격0, 설치된 프로그램 적용 미확인.

복원 시 preparedSave/inspect와 adapter의 준비 계약 부분만 되돌릴 수 있으나 해당 데이터 보존 기능을 잃는다. 기존 매크로/잠금/장부를 삭제하지 않는다. 이전 invalid UTF-8은 파일을 보존한 채 사용자 수정 인계가 필요하다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'macro-publication-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,
hypothesis:'매크로 원문·원본신원·전체예정결과를 준비 계약으로 고정하면 새 프로세스가 저장을 이어가도 기존 명령과 원래 요청의 바이트를 대조할 수 있다.',
lesson:'작업 파일과 제어 저장소는 같은 권한 범위로 임의 확장할 수 없다. 전체 SHA와 원문 결속은 SQL effect/receipt/G의 전제이지 그 완료 자체가 아니다. 손상 UTF-8을 대체해 저장하면 원본 보존이 깨진다.',
limitations:'40/40·실제새PID prepared 저장/기존SIGKILL3. commonSQL/B권한/G/멱등복구·설치활성화 미완료. 동일클래스 현재대조·공식60유지·비용미측정.',
evidencePaths:['-report.md','-source.json','-utf8-baseline.txt','-final-original.txt','-build-original.txt','-contract-original.txt','-queue-original.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 일반macro 원문/전체store prepared계약·실제새PID 저장·UTF8 원본손상1결함수정·40/40/build/contract. 공식60·운영활성화0. 다음 등록제어store 권한/commonSQL/Bclaim/receipt/G 및 원래100인수.\n`);
