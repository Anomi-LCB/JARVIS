import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/microsoft-authority-20261007';
const read=p=>readFileSync(p,'utf8');
const json=p=>JSON.parse(read(p));
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString();
const final=read(`${prefix}-resumed.txt`),runner=json(`${prefix}-resumed-runner.json`);
assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
assert.match(final,/ℹ tests 97(?:\r?\n|$)/);assert.match(final,/ℹ pass 97(?:\r?\n|$)/);
assert.match(final,/ℹ fail 0(?:\r?\n|$)/);assert.match(final,/ℹ skipped 0(?:\r?\n|$)/);
assert.match(read(`${prefix}-baseline.txt`),/ℹ fail 8(?:\r?\n|$)/);
assert.match(read(`${prefix}-build-v2.txt`),/Built static JARVIS/);
assert.match(read(`${prefix}-contract-v2.txt`),/gatePassed: true/);
const statusText=read('artifacts/research-heartbeat-20261007-status.txt');
const status=JSON.parse(statusText.slice(statusText.indexOf('{'),statusText.lastIndexOf('}')+1));
const reasons={};for(const c of status.candidates)reasons[c.nextReason]=(reasons[c.nextReason]??0)+1;
const recheck=status.candidates.filter(c=>c.nextReason==='evidence-needs-recheck').map(c=>({id:c.id,nextExperiment:c.nextExperiment}));
write('ledger-review.json',{observedAt,candidateCount:status.candidateCount,reasons,evidenceRecheck:recheck,
 watch:status.latestWatch.sources.map(({id,status})=>({id,status})),
 integrityIsNotIndependentVerification:true});
const files=['packages/core/src/personal-operations/microsoft-source-reader.js','packages/core/src/main.mjs',
 'tests/microsoft-source-reader.test.js','docs/microsoft-source-adapters.md'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath);
const gates=acceptance.stages.flatMap(s=>s.gates),verified=gates.filter(g=>g.status==='verified').length;
assert.equal(verified,60);
write('verification.json',{observedAt,baseline:{tests:30,passed:22,failed:8},regression:{tests:97,passed:97,failed:0,skipped:0},
 buildPassed:true,coreContractPassed:true,coreHttpAndSql:true,providerResponses:'synthetic',
 providers:['outlook','teams-chat'],revocationPhases:['before-read','after-token','after-graph','before-commit'],
 productionActivated:false,realMicrosoftAccountVerified:false,commonFreshProviderMissionContractComplete:false,
 formalVerified:verified,externalProviderCalls:0,newPermissions:0,actualCost:null});
write('report.md',`# Microsoft 수집 중 권한 철회 반영

관측 ${observedAt}. 공식 인수 ${verified}/100 유지. 새 공개 출시가 아닌 기존 읽기 경로의 실제 권한 검사 결함을 수정했다.

이전에는 Core 요청 시작 시 ADMIN 권한을 확인하고 저장 때 다시 확인했지만, OAuth 토큰 응답 후 권한이 철회돼도 Graph 개인정보 조회를 시작할 수 있었다. 이제 자격증명 확인과 공급자 요청 전후에 같은 현재 권한을 검사하고, 반환된 페이지의 비공개 증명에도 정책 검사를 보존한다. 토큰 응답 뒤 철회 시 Graph 호출 0건, SQL 행 0건으로 차단한다. 이미 진행 중인 원격 요청을 소급 취소했다고 주장하지 않는다. 잘못된 동기 반환·예외·비동기 판단도 권한으로 인정하지 않는다.

Outlook·Teams의 네 철회 시점 개발 반례 30검사 중 8실패를 보존했다. 수정 후 공통 회귀 97/97, 실패·skip 0, build·Core 계약 통과다. 실제 격리 Core HTTP와 SQLite에서 토큰 직후/Graph 직후 철회 및 정상 읽기·재조회·오류 롤백을 검사했다. 공급자 응답과 ADMIN 인증은 합성이고, 기존 DPAPI 회귀는 실제 Windows 보호 저장을 사용한다. 사용자 계정·F/cognition·운영 서비스는 변경하지 않았다. 외부 유료 호출 0, 비용 미측정이다.

감시 6곳 변화 없음. 후보 ${status.candidateCount}개와 변경·누락·실패·준비 조건은 ledger-review.json에 집계했다. [Microsoft 공식 인증·권한 문서](https://learn.microsoft.com/en-us/graph/auth/auth-concepts)를 재검토했다. 제공자 OAuth 권한과 JARVIS의 현행 요청 권한은 서로 다른 경계라는 설계 판단을 적용했다. 신규 라이브러리 설치나 실제 계정 연결은 아니다.

V3-073은 계속 진행 중이다. 직접 Microsoft 수집을 Mission/E/B/G 공통 실행 계약에 연결하는 일이 남았다. V3-040 독립 감사도 workflow 영수증 존재를 확인했지만 원래 operationId·effectId·B 멱등키 연결의 공백을 발견했다. 다음은 이 실제 workflow 실행 효과 연결이며 평가 기준을 낮추지 않는다. 복원은 이번 정책 hook 및 Core callback 전달 변경을 함께 되돌리는 코드 검토 방식으로 하고 과거 실패 증거는 보존한다.
`);
const evidencePaths=['report.md','verification.json','source.json','ledger-review.json','baseline.txt','baseline-runner.json',
 'resumed.txt','resumed-runner.json','build-v2.txt','contract-v2.txt'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'microsoft-authority-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'contract-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'공급자 요청 전후와 반환 페이지의 저장 단계에 현재 ADMIN 권한을 재검사하면 읽기 도중 철회된 요청의 추가 개인정보 조회와 저장을 막을 수 있다.',
 lesson:'저장 차단만으로 조회 권한 철회가 충족되지는 않는다. 각 비동기 경계와 이후 독립 저장 경로에서 같은 현재 정책을 보존해야 한다.',
 limitations:'97개 개발 회귀와 실제 격리 HTTP/SQL·Windows DPAPI. Microsoft/OAuth 응답 합성, 실계정·운영 활성화·공통 직접수집 Mission 계약 미완료. 공식60%, 비용 미측정.'});
const gate=gates.find(g=>g.id==='V3-073');assert.equal(gate.status,'in_progress');
gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07 후속: Microsoft 읽기 전후/토큰 응답 직후/페이지 저장 시 현재 ADMIN 권한 검사 추가,97회귀 통과. 실제 격리HTTP/SQL,공급자합성. 직접수집 Mission/E/B/G·실계정은 미완료라 진행중 유지.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: Microsoft 읽기 도중 권한철회8반례 수정·97회귀/build/contract 통과, 공식60/100 유지. 다음 V3-040 실제workflow operationId/effectId/B멱등키 연결과 V3-073 직접수집 공통계약.\n`);
console.log(JSON.stringify({observedAt,verified,tests:97,evidenceCount:evidencePaths.length}));
