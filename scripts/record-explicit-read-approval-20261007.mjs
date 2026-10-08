import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/explicit-read-approval-20261007',observedAt=new Date().toISOString();
const read=path=>readFileSync(path,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [key,value] of [['tests',172],['pass',172],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-first.txt`),/ℹ fail 2(?:\r?\n|$)/);
assert.match(read(`${prefix}-second.txt`),/ℹ fail 1(?:\r?\n|$)/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const events=read(`${prefix}-final.txt`).split(/\r?\n/u).filter(line=>line.startsWith('{"mode"')).map(line=>JSON.parse(line)).filter(e=>e.defaultPlanner);
assert.equal(events.length,3);
for(const event of events){assert.equal(event.status,'COMPLETED');assert.equal(event.conditionQuestions,1);assert.equal(event.authorityUnchanged,true);}
assert.equal(events.find(e=>e.mode==='large').reads,3);
const sourcePaths=['packages/core/src/mission/explicit-read-approval.js','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/read-only-text-proof.js','tests/explicit-read-approval.test.js','docs/conditional-goal-boundary.md'];
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(acceptancePath)),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;assert.equal(verified,59);
write('verification.json',{observedAt,tests:172,passed:172,failed:0,skipped:0,focusedTests:8,events,buildPassed:true,contractPassed:true,
  formalVerified:verified,externalProviderCalls:0,paidModelCalls:0,cost:null,costStatus:'unmeasured',productActivated:false,
  limits:['실제 설치 UI 미검사','별도 프로세스 강제 종료 복구 미검사','범용 조건 진위와 전체 의미 인수 미완료']});
write('report.md',`# 명시적인 본인 승인 뒤 같은 작업의 파일 읽기 완료

관측 ${observedAt}. 공식 인수59/100 유지. V3-020/021 부분 구현이며 전체 인수 완료가 아니다.

## 구현과 실제 결과

“내가 승인하면 source.txt를 읽어”와 “내 승인을 받은 후 source.txt를 읽어” 중 하나의 텍스트 읽기만 포함한 요청에 조건 확인 질문1개를 만든다. 승인 전에 파일 읽기0·계획기 호출0이다. 인증된 Core 관리자 경로에서 “승인” 또는 “승인합니다”라고 답하면 같은 Mission의 revision2로 조건을 해소하고 기존 E/B/G 경로로 읽어 완료한다. 원문·질문·대상·해시·답변 주체와 변경 이력을 보존하며 권한을 추가하지 않는다.

실제 Core/E/B/G·SQLite·기본 계획기를 사용하는 임시 파일 시험에서 일반 승인 읽기1회·COMPLETED, 실제 HTTP 승인 읽기1회·COMPLETED, 120000자 파일 읽기3구간·COMPLETED를 확인했다. 재실행 시 추가 읽기0이다. HTTP 미인증 요청은401로 거부했고 본문에 위조한 행위자 이름은 실제 인증 주체를 대체하지 못했다. 거절, 모호한 “예”, 승인 대상 변조, 기존 읽기 권한 제거는 읽기0이다. 승인 이력은 SQLite 재조회로 확인했다. 별도 PID 종료·복구 시험은 아니다.

지원 형식은 TXT/Markdown/CSV/JSON이다. 부가 기한·금액·복합 행동·별도 검증 명세, 다른 사람의 승인, 사실 판단 조건, 외부 발송·거래는 이 경로로 해소하지 않는다. 이 좁은 조건에서 사용자 답변1회는 원문에서 요청한 조건 확인이며 일반적인 실행 승인 절차를 추가하는 것이 아니다.

## 실패에서 수정한 부분

초기6검사 중2실패: 조건 정정 후 기본 계획기의 일반 읽기 시작 경로가 없어 PAUSED로 남은 제품 부족1건을 수정했다. 나머지는 createMission의 기본 read_only 정규화를 권한 제거로 잘못 가정한 시험 준비 오류로, 생성 뒤 기존 권한을 제거하는 반례로 바로잡았다. 두 번째16검사 중1실패: 새 읽기 시작 경로를 모든 단일 읽기에 적용해 기존 maxChars=3 계획을 덮어쓴 회귀를 확인했다. 본인 승인 조건에서 실제로 변경한 현재 버전에만 시작 경로를 적용하도록 제한했다. 최초·중간 로그는 보존했다.

## 검증·제한·다음 작업

최종13파일172/172, 실패0·건너뛰기0. 빌드와Core 계약 통과. 새 기능 집중8검사도 통과했다. 유료 모델 호출·실계정·외부 발송·운영 서비스 재시작·설치본 활성화는 수행하지 않았다. 비용은 미측정이다. 사용자 실제 F/cognition 기억은 수정하지 않았다. 허위 완료·조건 선행 읽기 방지 및 사용자 개입 감소의 부분 증거이며 전체 자연어100% 성공이나 설치본 검증을 뜻하지 않는다.

다음은 독립 질문 필요성과 의미 보존 평가, 설치 화면의 조건 답변·정정·복구 실증이다. 복원 검토 시 명시 조건 모듈, runtime 승인/시작 경로, 읽기 시작 검증을 함께 검토하고 승인 전 읽기0·권한 유지·일반 작은 구간 읽기 반례를 유지한다.
`);
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-first.txt`,`${prefix}-first-runner.json`,`${prefix}-second.txt`,`${prefix}-second-runner.json`,`${prefix}-third.txt`,`${prefix}-http.txt`,`${prefix}-http-runner.json`,`${prefix}-final.txt`,`${prefix}-final-runner.json`,`${prefix}-build.txt`,`${prefix}-contract.txt`];
assert.ok(evidencePaths.length<=16);
write('attempt.json',{id:'explicit-read-approval-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
  hypothesis:'엄격한 본인 승인 읽기 조건을 원문/버전/대상에 묶어 같은 Mission에서 정정하면 권한 확대 없이 답변 한 번으로 실제 완료할 수 있다.',
  lesson:'원문 승인 조건과 실행 권한은 별개다. 제한된 조건 해소 후 기본 계획 경로를 연결하되 일반 읽기의 기존 계획/구간 크기를 덮어쓰지 않아야 한다.',
  limitations:'172회귀/8집중/실제CoreHTTP/E/B/G/임시파일/SQLite. 설치UI·PID종료복구·범용조건/의미·실계정·장기 미검증. 공식59% 유지. 비용 미측정.'});
for(const id of ['V3-020','V3-021']){const gate=gates.find(g=>g.id===id);assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 본인 승인 단일 텍스트 읽기 조건1답변/같은Mission정정/실제HTTP·기본계획·G완료·큰파일3구간·권한불변·172회귀. 범용조건/질문필요성/의미·설치UI/PID복구 전체인수 미완료.');}
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 명시 본인 승인 단일 읽기 조건1질문/1답변 뒤 같은Mission revision2 실제완료·HTTP 인증/행위자/권한 유지·큰파일3구간·172회귀/build/contract. 공식59% 유지. 다음 독립 질문 필요성/의미·설치 화면/복구 실증.\n`);
console.log(JSON.stringify({observedAt,verified,tests:172,events,evidenceCount:evidencePaths.length}));
