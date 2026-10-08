import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/selected-sources-ui-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [file,count] of [['final',142],['navigation',10],['desktop-entry',3]]){
 for(const [key,n] of [['tests',count],['pass',count],['fail',0],['skipped',0]])assert.match(read(`${prefix}-${file}.txt`),new RegExp(`ℹ ${key} ${n}(?:\\r?\\n|$)`));
}
const browser=JSON.parse(read(`${prefix}-browser-verified/result.json`));assert.equal(browser.cases.length,2);assert.equal(browser.execution.reads,2);
for(const c of browser.cases){assert.equal(c.fullCount,51);assert.equal(c.revokedContentHidden,true);assert.deepEqual(c.pageErrors,[]);assert.equal(c.overflow,false);}
assert.match(read(`${prefix}-final-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-final-contract.txt`),/gatePassed: true/);
const files=['packages/core/src/personal-operations/source-inbox.js','packages/core/src/main.mjs','src/ui/connections/selected-sources.js',
 'src/ui/connections/sources.html','src/ui/connections/connection-center.js','apps/pc-agent/src/install/desktop-features.js',
 'tests/selected-sources-ui.test.js','tests/selected-source-stream.test.js','tests/fixtures/selected-sources-browser.mjs','scripts/selected-sources-browser-qa.py'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,regressionUniqueTests:152,testExecutions:155,passedExecutions:155,failed:0,skipped:0,
 unsafeControlCases:1,browserCases:2,actualCoreHTTP:true,actualMission:true,actualSQLite:true,actualSourceReads:2,
 desktopWidth:1440,mobileWidth:390,realProviderAccount:false,productionActivation:false,installerUpdated:false,
 browserPollingAutomaticRevocationMeasured:false,manualRevalidationRevocationVerified:true,actualCost:null,productLatency:null,formalVerified:59});
write('report.md',`# 독립 저장 자료 조회 화면의 실제 Mission 연결

관측 ${observedAt}. 원래 인수59/100 유지. V3-031/073의 부분 증거다.

## 사용자 동작

밝은 독립 연결 화면 sources.html과 PC 기능 목록의 ‘저장 자료 전체 조회’ 진입점을 추가했다. 기존 공용 버튼·간격·상태 표시를 재사용했다. Paperclip의 일관된 상태와 결과 옆 다음 조치 원칙을 적용했고 외부 서비스나 디자인 코드를 복제하지 않았다. 반짝이는 별표 아이콘을 추가하지 않았다.

ADMIN 전용 /personal-inbox/streams는 provider·opaque streamRef·저장 개수·관측 시각과 구성 준비 여부만 반환한다. 원래 계정명이나 비밀을 내보내지 않는다. provider provenance가 없는 과거 연결은 선택 목록에 넣지 않는다. 목록 조회는 실제 계정 연결이나 공급자 최신 조회 증거가 아니다. API의 초기·최종 ADMIN 검사를 유지했다.

사용자는 저장 연결을 선택하고 기존 개인 실행 허용을 사용해 전체 조회한다. 화면에서 새 owner session을 활성화하거나 권한을 늘리지 않는다. 선택한 provider/stream이 원문 Mission과 결속되고, 기존 Core→E→B→G의 결과 API를 통해 전체 자료를 받는다. 50개씩 표시하며 외부 HTML은 텍스트로 escape한다. 결과는 브라우저 메모리에만 두고 localStorage/sessionStorage에 저장하지 않는다.

새 상태 확인·선택 변경·중단·화면 숨김에서는 먼저 결과를 비운다. 늦게 도착한 이전 요청은 epoch가 다르면 반영하지 않는다. 현재 SQL/위임/owner/host 권한이 더 이상 맞지 않으면 결과 본문을 숨긴다. 표시 중에는5초마다 재검증하도록 구현했다. 이번 브라우저에서 실증한 것은 수동 재검증 후 숨김이며 자동 주기의 철회 지연은 따로 측정하지 않았다. 중단 요청과 권한 철회를 혼동하지 않고 중단 오류는 미확인으로 표시한다.

## 실제 검증

공유142개 + 연결 화면10개 + PC 진입점3개 호출 모두 통과. 새 UI3개가 앞 두 집합에 중복되어 고유152개, 총155회 호출이다. 기존 위험 대조군1개는 보호 제거 시 허위 완료 가능성을 입증하는 시험이며 업무 성공으로 집계하지 않는다. build와 기존 baseline 유지 OpenAPI contract gate도 통과했다.

실제 Chromium에서1440px와390px 두 화면을 검사했다. 격리 Core HTTP·SQLite·실제 Mission에서 합성 Outlook자료51개를 조회해50개/1개 페이지 이동을 확인했다. 실제 source B읽기2회·Mission COMPLETED2개·외부공급자 호출0이다. 다른 계정 OAuth 성공이나 실제 메일 본문 수집을 뜻하지 않는다. 문서 속 img 태그가 DOM 실행 노드로 만들어지지 않았고, host 읽기 권한 철회 뒤 새로고침하면 결과가 숨겨졌다. 브라우저 오류0·가로 넘침0. 스크린샷과 result.json을 보존했다.

## 발견한 문제와 수정

첫 브라우저 시험은 시험 서버가 공용 화면 모듈을 모두 제공하지 않아 빈 화면이었다. 필요한 브라우저 공용 모듈4개만 시험 서버에서 제공했다. 다음 시험은 fixture의 ownerSessionManager 옵션 이름이 잘못되어 별도 기본 소유자 관리자에 조회됐고 버튼이 정확히 비활성 상태였다. fixture를 실제 runtime manager로 결속했다. 두 상태 메시지 중 구분되지 않은 role 선택으로 실패한 시험은 source 전용 상태 selector로 고쳤다. 동시에 실제 화면의 상위 ‘확인 중’ 문구가 남는 문제도 중립 안내로 수정했다. 권한 검사나 대기 시간을 느슨하게 바꿔 시험을 통과시키지 않았다. 이전 실패와 빈 화면 증거도 보존한다.

## 한계와 다음 작업

실계정·OAuth·공급자 직접 동기화·본문/첨부·Windows 설치본 업데이트·운영 서비스 활성화·제품 p95·비용은 미측정이다. 기본 운영 구성에 selectedSourceAccess가 연결되지 않았다면 화면은 준비 미완료로 표시하고 실행하지 않는다. 이 상태를 숨기지 않는다. PC 기능 목록 변경은 다음 설치 패키지에 들어갈 소스이며 이미 설치된 EXE 업데이트 증거가 아니다.

다음은 실제 Core 구성의 보호 자격증명·읽기 패키지·계정 준비도와 이 화면을 연결하고, 새 프로세스에서 결과 복원 및 철회를 검증하는 것이다. 원래 인수율을 올리지 않는다. 복원은 새 source 화면/PC 진입점/stream 목록 API만 검토하며 기존 개인 원장·F/cognition·계정 토큰·인수 기준을 삭제하지 않는다. 파일 해시는 보존 검사이며 실험 결론의 독립 검증이 아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','focused.txt','final.txt','navigation.txt','desktop-entry.txt','final-build.txt','final-contract.txt','browser-v2/failure.json','browser-v4.txt','browser-final.txt','browser-verified/result.json','browser-verified/result-390.png','browser-verified/revoked-1440.png'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'selected-sources-ui-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'독립 연결 화면에서 현재 준비도·기존 실행 허용·선택 source Mission·현재 결과 재검증을 연결하면 일반 사용자가 범위가 보존된 저장 자료를 조회하고 철회된 결과를 숨길 수 있다.',
 lesson:'실제 화면 검증은 잘못된 서버 공용 모듈 경로와 owner manager 결속을 드러냈다. 결과는 다시 확인하기 전에 비우고 선택 변경 뒤의 늦은 응답을 반영하지 않아야 한다.',
 limitations:'실제 브라우저2폭/Core HTTP/SQLite/Mission,합성메타데이터. 실계정·OAuth·운영 구성·설치본·재시작 복원·자동 폴링 지연·비용·제품 p95는 미검증.고유152검사 중 위험 대조군1개 포함.인수59%.'});
const path='docs/universal-control-v3-acceptance.json',data=JSON.parse(read(path)),gates=data.stages.flatMap(s=>s.gates);assert.equal(gates.filter(g=>g.status==='verified').length,59);
for(const id of ['V3-031','V3-073']){const gate=gates.find(g=>g.id===id);assert.notEqual(gate.status,'verified');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 독립 저장자료 화면/실CoreHTTP Mission2개/브라우저1440·390폭51개50+1표시/철회 재검증 숨김/152고유검사/build/contract.운영 구성·설치본·실계정·재시작·자동철회지연 미실증.');}
data.updatedAt=observedAt;writeFileSync(path,JSON.stringify(data,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 독립 저장자료 화면→선택 Mission→전체 결과·철회 숨김,실브라우저2폭51개·152고유검사/build/contract.59% 유지. 다음 실제 Core 보호 연결 구성·새 프로세스 복원·운영 UI 연결.\n`);
console.log(JSON.stringify({observedAt,verified:59,uniqueTests:152,browserCases:2}));
