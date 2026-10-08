import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/selected-source-scoped-auth-20261007',observedAt=new Date().toISOString();
const read=path=>readFileSync(path,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [key,value] of [['tests',68],['pass',68],['fail',0],['skipped',0]])
 assert.match(read(`${prefix}-verified.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const current=JSON.parse(read('docs/universal-control-v3-acceptance.json'));
assert.equal(current.stages.flatMap(s=>s.gates).filter(g=>g.status==='verified').length,59);
const ledger=JSON.parse(read(`${prefix}-ledger-status.json`)).candidate;
const evidence=ledger.attempts.flatMap(a=>a.evidence);
write('status-summary.json',{observedAt,candidateId:ledger.id,nextReason:ledger.nextReason,attemptCount:ledger.attemptCount,
 inspectedRecentAttempts:ledger.attempts.length,evidenceProblems:evidence.filter(e=>e.integrity!=='intact').length,
 changedOrMissingSourceEvidence:evidence.filter(e=>e.sourceIntegrity!=='intact').length,
 currentDefinitionChanges:ledger.attempts.filter(a=>!a.currentDefinition).length,
 sourceWatch:JSON.parse(read('.runtime/research-watch/latest.json')).summary,
 scope:'Only this candidate recent history was inspected; no claim about all historical evidence.'});
write('source.json',{observedAt,files:['packages/core/src/security/core-admin-auth.js','packages/core/src/main.mjs','tests/selected-source-scoped-auth.test.js'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:68,passed:68,failed:0,skipped:0,newCases:5,unsafeControlCases:1,
 actualCoreHTTP:true,actualSQLite:true,hashOnlyWorkerCredentialVerified:true,externalProviderCalls:0,
 actualCost:null,productLatency:null,productionActivation:false,installedProgramUpdated:false,formalVerified:59});
write('report.md',`# 저장 자료 읽기 자격증명의 최소 권한 경계

관측 ${observedAt}. 공식 인수59/100 유지. 운영 Core 연결의 준비 작업이며 운영 서비스 활성화나 재시작 복원 완료는 아니다.

## 구현과 실험

앞선 선택 자료 B클라이언트는 Core HTTP에 ADMIN 자격증명을 사용했다. 서비스가 관리자 비밀 대신 해시만 보유하는 구성에서 이 토큰을 실행기에 넘기는 방식은 적절하지 않다. 별도 core:selected-source:read 범위를 추가했다. 전용 자격증명은 정확한 provider/opaque streamRef 목록과 명시적 만료 시각이 모두 있어야 하며, 둘 중 하나가 누락·잘못되면 거부한다. 등록 이후 원래 설정 객체를 바꿔도 허용 범위가 확장되지 않도록 복사한다. 기존 명시적 관리자·wildcard 경로와 다른 도구의 권한은 유지한다.

Core selected-source 엔드포인트는 요청 전 자격증명을 검사하고, 본문 파싱 뒤 SQL 조회 전후에 현재 만료와 자료 범위를 다시 검사한다. 전용 읽기 자격증명으로 전체 연결 목록·Mission 생성·다른 관리자 동작을 호출할 수 없다. 같은 provider의 다른 계정 stream과 다른 provider도 거부한다. 권한 감사와 상태에는 원문 토큰이나 전체 stream 식별자를 추가하지 않는다. 이 자격증명은 전송 계층의 제한이며 기존 Mission 요구·E 정책·자료 위임·B fence·G 결과 검사를 대체하지 않는다.

실제 격리 Core HTTP/SQLite에 해시만 등록한 자격증명을 사용해 기존 SelectedSourceClient로 한 자료를 읽었다. 다른 계정/목록/쓰기/만료/철회가 모두 거부됐고, SQL 관측 도중 만료되는 반례에서는 자료 응답이 나가지 않았다. 외부 공급자 호출0. 합성 계정 자료이며 실제 OAuth 연동 증거가 아니다.

신규5조건과 기존 source/Core 인증/연결 보안 회귀를 합쳐68개 통과·실패0·건너뜀0. 기존 보호 제거 위험 대조군1개는 허위 완료 가능성을 입증하며 실사용 성공으로 집계하지 않는다. build와 기존 OpenAPI baseline 계약 검사 통과. 초기 검사1건은 만료된 자격증명을403으로 기대했으나 기존 인증 규칙이401을 반환해 실패했다. 기대값을 기존 인증 정책에 맞췄고 자료 조회 중 철회는403을 별도로 확인했다. 보호 코드를 느슨하게 바꾸지 않았다. 초기 실패 로그도 보존했다.

## 조사와 한계

감시6곳은 변화0·오류0이었다. 해당 후보의 최근20개 시도에서는 증거 변경·누락0, 정의 변경0을 확인했다. 전체227개 시도의 모든 증거 감사라는 뜻은 아니다. 원문 MCP 권한 규격의 최소 범위와 자원 결속 원칙을 검토했다: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization . 이번 구현은 JARVIS 내부 bearer 경계이며 MCP OAuth2.1 구현·준수 완료라는 의미가 아니다.

서비스 구성에서 이 자격증명을 발급·보관·갱신하고 Core 로컬 읽기 실행으로 라우팅하는 작업은 남았다. 현재 원격 PC 실행기와 로컬 source 실행기의 authority/fencing을 함께 보존해야 하므로 원격 실행기를 단순 교체하지 않았다. 새 프로세스에서 실제 결과 영수증을 복원하는 검증·실계정·설치 EXE·운영 서비스·제품 p95·실제 비용은 미측정이다. 다음은 이 제한 자격증명과 실제 Core 서비스 조합, 원격PC 혼합 라우팅을 연결하는 것이다. 복원은 이번 추가 scope/binding 검사를 제거하는 코드 변경이며, 개인 원장·F/cognition·인수 기준은 유지한다. 증거 해시는 파일 보존 검사다.
`);
write('attempt.json',{id:'selected-source-scoped-auth-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,
 hypothesis:'선택 자료 HTTP 경로를 자원·만료로 제한한 별도 자격증명에 연결하면 관리자 비밀을 실행기에 주지 않고 실제 읽기를 유지하면서 다른 계정과 쓰기 권한을 차단할 수 있다.',
 lesson:'별도 읽기 scope만으로 충분하지 않다. 정확한 자료와 만료를 등록하고 SQL 관측 이후에도 다시 검사해야 한다. 해시만 등록한 Core에서 실제 클라이언트 읽기를 확인했다.',
 limitations:'격리 HTTP/SQLite/합성자료/68검사(위험 대조군1). 서비스 발급·갱신·원격혼합 실행·재시작 복원·실계정·설치본·비용·p95 미실증.인수59%.',
 evidencePaths:['report.md','verification.json','source.json','status-summary.json','focused.txt','verified.txt','build.txt','contract.txt'].map(s=>`${prefix}-${s}`)});
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 저장자료 전용 범위·자원/만료 결속·해시만 보유한 실제 Core HTTP/SQL 읽기와 다른계정/쓰기/철회 차단.68검사/build/contract.59% 유지. 다음 실제 Core 서비스 발급·원격PC 혼합 라우팅·새 프로세스 복원.\n`);
console.log(JSON.stringify({observedAt,tests:68,verified:59}));
