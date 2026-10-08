import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/local-runtime-20261007',observedAt=new Date().toISOString(),read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const before=JSON.parse(read(`${prefix}-before.json`)),after=JSON.parse(read(`${prefix}-after-final.json`)),selfcheck=JSON.parse(read(`${prefix}-selfcheck.json`)),ui=JSON.parse(read(`${prefix}-memory-ui3/report.json`));
assert.equal(before.operational,false);assert.equal(after.operational,true);assert.ok(after.services.every(s=>s.healthy&&s.identityVerified));assert.equal(selfcheck.status,'COMPLETED');assert.equal(selfcheck.humanApprovalObserved,false);assert.equal(ui.status,'passed');
for(const [key,value] of [['tests',63],['pass',63],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final2.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build2.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);assert.match(read(`${prefix}-package.txt`),/Status: created/);
const sourcePaths=['src/ui/workspace/app.js','src/ui/workspace/styles.css','apps/pc-agent/src/install/control-center-ui-payload.js','scripts/local-runtime-read-selfcheck-20261007.mjs','scripts/local-runtime-memory-ui-20261007.py','tests/product-runtime.test.js'];
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(acceptancePath)),gates=acceptance.stages.flatMap(s=>s.gates);assert.equal(gates.filter(g=>g.status==='verified').length,59);
write('verification.json',{observedAt,tests:63,passed:63,failed:0,skipped:0,sourceRuntimeReady:after.operational,selfcheck,ui,buildPassed:true,contractPassed:true,
  pcPackageFiles:748,pcPackageInstalled:false,windowsServiceStatus:'Stopped',oldMobileBridgeModified:false,coreWorkerAutostart:false,googleSync:false,personalImport:false,formalVerified:59,cost:null,costStatus:'unmeasured'});
write('report.md',`# 실제 로컬 실행 복원과 기본 기억 화면 연결

관측 ${observedAt}. 공식 인수59/100 유지. 실행 가능한 소스 런타임을 복원했고 설치·Windows 서비스·재부팅 인수와 구분한다.

## 실제 운영 상태와 요청

시작 전 Core4071·PC17776·제어센터41730은 모두 network-error로 응답하지 않았다. 기존 모바일 브리지1468은 보존했다. 기존 DPAPI 자격증명과 product-runtime --connections-only를 사용해 새 supervisor30672에서 세 서비스를 시작했다. 최신 검사에서 세 endpoint200·신원 일치·operational=true를 확인했다. Core 자동 worker 시작·Google 증분 동기화·개인 파일 수집은0으로 두었다. PC의 기존 queue drain supervisor는 정상 시작한다. 운영상 모든 자동 작업을 비활성화했다는 의미는 아니다. 저장된 Core Mission을 자동 재개하지 않고 이번 진단 작업만 명시 실행했다.

실제 제어센터 인증 프록시→Core→PC 실행→G에서 진단용70바이트 파일을 읽었다. 원문 조건에서는 읽기 action0·질문1·계획기 호출0, 운영자 시험 답변 후 같은 Mission revision2의 실제읽기1·전체현재원문/독립G 체크2 통과·COMPLETED를 확인했다. 파일 원본 해시는 유지했고 Mission 재조회도 완료 상태다. 이것은 운영자 기능 시험 답변이며 사용자 본인의 승인 관측을 주장하지 않는다. longTermMemory=false로 개인 장기 기억 참고를 비활성화했다. 비밀정보·외부 모델 요청·외부 발송을 실행하지 않았다.

## 사용자 화면과 배포 누락 수정

기존 ZIP 가져오기 컴포넌트가 고급 화면에만 연결돼 기본 기억 페이지에서는 보이지 않았다. 기본 작업공간 #memory에 같은 컴포넌트를 연결하고 기존 밝은 색·입력·버튼/패널 스타일을 재사용했다. 현재 읽은 파일명을 표시하고 제목 검색·50개 페이지·선택 유지·20개 선택 상한을 그대로 적용한다. 같은 기억 범위와 기존 Core 인증·선택/출처 계약을 사용한다.

실제 운영 중인 제어센터 전체 페이지와 실제 Core에서1440/390 두 뷰로501대화 ZIP을 선택·페이지 왕복·제목 검색·2대화 미리보기했다. 선택 전0요청, 선택 JSON만1요청, 미선택 원본필드/계정 파일 전송0, 개인 기억 저장0, pageerror/가로넘침0. 생산 패널 스크린샷을 확인했다. 첫 실제 미리보기는 시험 문구의 “진단”이 기존 건강 정보 규칙에 걸려400 F_CONVERSATION_SENSITIVE_REVIEW_REQUIRED였다. 해당 규칙은 유지하고 건강 언급 없는 합성 자료로 일반 경로를 검사했다. 민감 내용을 일반 기억에 저장하는 허용을 추가하지 않았다.

공유 회귀58검사에서 설치 UI 의존성 누락1과 오래된 장치 비밀 배치 기대2를 확인했다. ZIP 모듈을 PC 설치 UI 명시 목록에 추가해 설치 그래프 누락을 수정했다. 옛 검사 두 곳은 장치 인증 secret을 브리지에 기대했지만 현재 제품 구조는 Core가 모바일 인증을 담당한다. Core 값/게이트웨이/브리지 core-api 경로 및 브리지·UI로 상속된 secret 제거를 검사하도록 수정했으며 비밀을 브리지로 다시 보내지 않았다.

최종13파일63/63·fail0·skip0, build/Core계약 통과. 별도 artifacts/local-runtime-20261007-pc-package에748파일의 새 설치 소스 패키지를 생성했으며 기존 설치본은 덮어쓰지 않았다. 새 ZIP 모듈·기본 작업공간이 배포 그래프에 포함된다. package signed=false로 Windows 출시 서명·EXE 설치/교체·다른PC·rollback 성공으로 계산하지 않는다.

## 남은 조건과 복원

등록된 JarvisPcAgent Windows 서비스는 여전히Stopped이며 새 소스 런타임과 같은 포트라 동시에 시작하지 않았다. 기존 모바일 브리지 건강 응답에는 새 executionAuthorityMode/Core API 신원이 없어 현행 통합 경로 검증이 남아 있다. 브리지/서비스를 임의 종료하거나 새 자격증명을 넘기지 않았다. 24시간 클라우드·재부팅·오프라인 요청함·백업 복원·실계정·사용자 실제 export·설치 UI 장기 인수는 이번 완료가 아니다. 원래057/099 진행중·047대기 유지다.

현재 사용 URL은 http://127.0.0.1:41730/#memory 이다. 이번 supervisor는 살아 있으며 종료가 필요하면 기록된 PID/정확한 명령 소유권을 확인해 종료하고 기존 Windows 서비스/브리지 프로세스는 건드리지 않는다. UI/패키지 복원은 workspace 연결부와 설치 모듈 목록을 함께 검토하되 미선택 전송0·출처 해시·기본 입력 동작을 유지한다. Paperclip의 기존 컴포넌트·피드백 원칙을 적용해 같은 가져오기 기능을 기본 기억 메뉴에서도 찾을 수 있게 했다. 다음은 기존 설치/브리지의 현행 단일Core 전환 및 실제 Windows 서비스 복구 인수다.
`);
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-before.json`,`${prefix}-after-final.json`,`${prefix}-selfcheck.json`,`${prefix}-mission-after-answer.json`,`${prefix}-memory-ui3/report.json`,`${prefix}-memory-ui3/preview-390.png`,`${prefix}-regression.txt`,`${prefix}-final2.txt`,`${prefix}-final2-runner.json`,`${prefix}-build2.txt`,`${prefix}-contract.txt`,`${prefix}-package.txt`,`${prefix}-memory-ui2/preview-failure.json`];
write('attempt.json',{id:'local-runtime-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'runtime-connection',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'현재 코드의 authenticated source runtime을 복원하고 기본 UI/배포 의존성까지 연결하면 모듈 검사 성공을 실제 사용자 진입과 파일 검증으로 확장할 수 있다.',
 lesson:'기본 화면에 없는 기능과 설치 그래프에 누락된 의존성은 사용 가능 기능이 아니다. 운영 서비스/신원/실제 요청/개인자료 경계를 따로 확인하고 소스 패키지와 설치 활성화를 구분한다.',
 limitations:'실제소스3서비스/실Core-PC-G 파일/Chrome2뷰 preview만/63회귀/748소스패키지. Windows서비스·구브리지전환·설치EXE·서명/다른PC·실계정·장기 미완료. 공식59%, 비용미측정.'});
for(const id of ['V3-057','V3-099']){const gate=gates.find(g=>g.id===id);assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 실제3소스서비스 복원·Core/PC/G read완료·기본기억화면 ZIP/2뷰501대화 선택preview 전송1/개인저장0·설치UI모듈누락수정·63회귀/748파일격리패키지. 실제사용자export·설치/서명/다른PC/rollback·Windows서비스/구브리지전환·장기 미완료.');}
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제Core/PC/UI 복원·운영자조건답변후 read/G완료·기본Memory ZIP/2뷰/미선택전송0·설치UI의존성누락수정·63회귀/build/contract·748파일격리소스패키지. 공식59%. supervisor30672 유지/Core자동재개·Google수집0. Windows서비스Stopped/구브리지신원·설치EXE/서명/실계정 인수 별도.\n`);
console.log(JSON.stringify({observedAt,verified:59,tests:63,sourceRuntimeReady:true,evidenceCount:evidencePaths.length}));
