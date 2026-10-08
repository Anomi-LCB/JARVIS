import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/core-service-selected-source-20261007',observedAt=new Date().toISOString();
const read=path=>readFileSync(path,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [key,value] of [['tests',146],['pass',146],['fail',0],['skipped',0]])
 assert.match(read(`${prefix}-final-verification.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
const runner=JSON.parse(read(`${prefix}-final-runner-report.json`));assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
assert.match(read(`${prefix}-final-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-final-contract.txt`),/gatePassed: true/);
const sourceFiles=['apps/runtime-compose/src/selected-source-service-access.js','scripts/core-service-runtime.mjs','apps/runtime-compose/src/create-runtime.js',
 'apps/pc-agent/src/adapters/selected-source-client.js','packages/core/src/orchestration/core-orchestration-worker.js',
 'packages/core/src/mission/mission-runtime.js','packages/core/src/planning/task-planner.js','packages/core/src/planning/claude-cli-task-planner.js','tests/core-service-selected-source.test.js'];
write('source.json',{observedAt,files:sourceFiles.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:146,passed:146,failed:0,skipped:0,unsafeControlCases:1,newConfiguredServiceCases:3,
 actualServiceComposition:true,actualCoreHTTP:true,actualSQLite:true,localAndRemotePcRouting:true,
 sourceCredentialsAreOneShot:true,sourceCredentialsAreResourceBound:true,explicitRevocationPreserved:true,
 executionAuthorityReadGuard:true,externalProviderCalls:0,newProcessRecovery:false,productionActivation:false,
 installedProgramUpdated:false,providerAccountVerified:false,actualCost:null,productLatency:null,formalVerified:59});
write('report.md',`# 실제 Core 서비스의 선택 저장 자료 실행 연결

관측 ${observedAt}. 공식 인수59/100 유지. 구성 소스와 격리 서비스 실행을 확인했으며 설치된 프로그램이나 운영 서비스를 활성화한 보고는 아니다.

## 끝까지 연결한 동작

createConfiguredCoreServiceRuntime가 실제 개인 원장의 저장 자료를 정식 읽기 패키지와 Mission→E→B→G에 연결한다. 개인 실행 허용과 자료 위임은 그대로 필요하다. 등록된 저장 자료가 있다는 것은 해당 공급자 OAuth나 최신 상태가 정상이라는 뜻이 아니다. 준비도 제공자 이름도 core-inbox로 두고 SQL 저장 자료를 직접 읽은 관측만 기록한다.

Core 내부 HTTP 읽기는 매 호출마다 provider/opaque streamRef 한 쌍과60초 만료를 가진 무작위 자격증명을 발급한다. Core 인증기는 해시만 보관하고 읽기 완료·실패 뒤 제거한다. 동시 호출의 자격증명을 서로 지우지 않고 최대64개 진행 호출만 허용한다. 실제 감사 기록에서 selected-source-worker 역할과 전용 read scope 사용, 전달 뒤 남은 worker 자격증명0을 확인했다. 관리자 토큰·주소·SQL 위치는 작업 인자로 받지 않는다.

저장 자료 도구만 호스트가 설치한 Core 로컬 실행기에 보내고, 다른 PC 도구는 기존 원격 실행기 인스턴스를 그대로 사용한다. 원격 실행기의 outbound fencing 판별을 wrapper로 바꾸지 않았다. 단일 Core 실행 권한·자료 위임·B 최종 권한 검사도 실제 선택 실행기에 결속한다. 독립 G와 결과 전달은 현재 SQL·task·owner·위임·준비도를 다시 검사한다. 명시적으로 철회한 준비도를 저장 자료 관측으로 다시 connected로 덮어쓰지 않는다.

## 발견한 실패와 해결

1. 기본 서비스 계획기는 source 도구의 닫힌 인자에 내부 sequenceIndex를 삽입했다. 해당 도구에서는 순번을 그래프의 order/node에만 남기고 도구 인자에 추가하지 않는다. TaskPlanner와 Claude 경로를 함께 고쳤다. 미지원 외부 인자를 무시하도록 parser를 넓히지 않았다.
2. source만 로컬로 보내도 Mission 자료 위임 fence가 기본 원격 실행기를 대상으로 잡아 읽기를 거부했다. worker가 실제 선택한 실행기를 위임 검사에 사용하도록 연결했다.
3. SQLite 저장소의 Core 권한 검사는 BEGIN IMMEDIATE를 사용한다. source SQL 읽기 트랜잭션 안에서 다시 호출하면 중첩 트랜잭션이 된다. source 읽기 내부에서는 동일 권위의 lease owner/token/기한/단조 시계를 읽기 전용으로 대조하고, 트랜잭션 바로 전후의 완전한 권한 검사는 유지한다. 전역 권한 검사를 약화하거나 저장소 트랜잭션 구현을 바꾸지 않았다.
4. 후속 감사에서 SQL 관측을 통한 준비도 갱신이 명시적 철회를 덮어쓸 수 있음을 발견해 갱신을 금지했다. 현재 결과 접근도 철회된 준비도를 검사한다.
5. 초기 확대검사8건은 전용 test runner 없이 실행해 JARVIS_TEST_MODE 조건을 만족하지 못했다. 공식 runner를 사용하고 외부 모델 자격증명 제거·개인 원장 격리를 확인했다. 검사 조건을 삭제하지 않았다. 초기 실패·진단을 모두 보존했다.

## 검증과 정확한 한계

실제 구성 함수로 시작한3개 격리 서비스에서 local-only, 단일 Core authority, remote-PC+Core-local-source를 검사했다. 실제 HTTP와 SQLite로 Outlook 합성 자료를 읽고 Mission 완료 및 현재 결과 전달을 확인했다. source 요청은 원격 PC 서버로0회 전달됐고 다른 PC 도구가 해당 원격 실행기에 유지되는지도 확인했다. 미인증 호출, 준비도 철회 뒤 결과 거부와 재관측의 철회 보존, owner 철회 또는 Core 권위 해제 뒤 거부를 확인했다. 실제 공급자 호출0·개인 계정 연동0이다.

공유146개 통과·실패0·건너뜀0. 그중 기존 보호 제거 위험 대조군1개는 허위 완료를 보여 주는 시험이며 실제 업무 성공으로 계산하지 않는다. 실제 Core graph/G·자료 위임·outbound·LLM 계획 계약 회귀를 포함했다. build와 기존 OpenAPI baseline 계약 검사 통과. 테스트 총 소요시간은 runner 기록이고 제품 p95·운영 비용·실제 계정 완료율은 미측정이다.

새 프로세스 재시작 뒤 완료 source task/G 영수증의 복원, 실제 OAuth/본문/첨부, 제공자 동기화, 상시 클라우드, 설치 EXE 및 운영 서비스 활성화는 남았다. 특히 Mission JSON이나 자체 완료 문자열만으로 task/G 증거를 복원하지 않아야 한다. 다음 작업은 영속 영수증과 현재 자료·권한을 대조하는 실제 새 PID 복원이다. V3-031/073의 부분 증거를 추가했고 원래 범위의 인수 완료로 바꾸지 않았다.

복원은 이번 service access/worker source 분기/계획기 source 메타데이터 변경을 검토해 제거하는 코드 복원이다. 기존 개인 원장·F/cognition·계정 토큰·인수 기준은 삭제하지 않는다. 파일 해시는 증거 보존 검사이며 결론의 독립 검증이 아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','final-verification.txt','final-runner-report.json','final-build.txt','final-contract.txt','focused.txt','debug2.txt','debug3.txt','regression.txt','verified.txt'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'core-service-selected-source-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'정식 Core 서비스에서 자원별 단기 자격증명·로컬 읽기 실행·현재 SQL 오라클을 결합하면 원격 PC의 기존 실행 경계를 보존하며 저장 자료 Mission을 끝낼 수 있다.',
 lesson:'격리 createAgRuntime 성공만으로 서비스 연결을 보장할 수 없다. 기본 계획기의 내부 메타데이터, 실제 위임 실행기, 동일 SQL 트랜잭션의 권위 검사를 함께 검증해야 한다. 자동 준비도 갱신은 명시적 철회를 덮어쓰면 안 된다.',
 limitations:'실제 구성/HTTP/SQL/3서비스/146검사(위험대조군1). 합성 자료이며 실계정·제공자 호출·설치본·운영 활성화·새 PID복원·제품지연·비용 미실증.인수59%.'});
const path='docs/universal-control-v3-acceptance.json',data=JSON.parse(read(path)),gates=data.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,59);
for(const id of ['V3-031','V3-073']){const gate=gates.find(g=>g.id===id);assert.notEqual(gate.status,'verified');gate.evidence.push(...evidencePaths.slice(0,7));gate.limitations.push('2026-10-07: 실제 Core service 저장자료→단기 자원자격증명→local B/G 연결·remote PC 유지·authority SQL read 경계·철회 보존·3격리서비스/146회귀/build/contract.실계정·설치본·운영·새PID복원 미실증.');}
data.updatedAt=observedAt;writeFileSync(path,JSON.stringify(data,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제 Core 서비스 source 경로·단기 자원자격증명/폐기·Core 로컬과 원격PC 분리·위임/SQL authority/명시철회 경계 수정.3서비스/146회귀/build/contract.59% 유지. 다음 새 PID의 source task/G 영수증 복원·현재자료/권한 대사.\n`);
console.log(JSON.stringify({observedAt,tests:146,serviceCases:3,verified:59}));
