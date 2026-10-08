import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/microsoft-mission-ui-20261008',observedAt=new Date().toISOString();
for(const [suffix,markers] of [['-regression.txt',['ℹ pass 130','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0']],['-client-verified.txt',['ℹ pass 19','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0']],['-build.txt',['Built static JARVIS']],['-contract.txt',['gatePassed: true']]]){
 const log=await readFile(prefix+suffix,'utf8');for(const marker of markers)if(!log.includes(marker))throw Error('EVIDENCE_REQUIRED:'+marker);
}
const browser=JSON.parse(await readFile(prefix+'-browser-final-pass/report.json','utf8'));
if(browser.length!==2||browser.some(r=>!r.realConfiguredCoreSqliteEBGMission||!r.backgroundClearsContentNoExecution||!r.revokedClearsContent||r.creates!==1||r.runs!==2||r.pageErrors.length||r.horizontalOverflow))throw Error('BROWSER_EVIDENCE_REQUIRED');
const sources=['src/ui/connections/microsoft.html','src/ui/connections/microsoft.js','src/ui/connections/microsoft-mission-client.js','src/ui/connections/connection-center.js','apps/pc-agent/src/install/desktop-features.js','scripts/core-service-runtime.mjs','packages/core/src/main.mjs','tests/microsoft-mission-client.test.js','tests/fixtures/microsoft-mission-browser.mjs','scripts/microsoft-mission-browser-qa.py','docs/microsoft-collection-mission.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const raw=await readFile('artifacts/research-status-20261008-ui.json','utf8'),status=JSON.parse(raw.slice(raw.indexOf('{'))),watch=JSON.parse(await readFile('.runtime/research-watch/latest.json','utf8'));
const review=status.candidates.map(c=>({id:c.id,attemptCount:c.attemptCount,historyTruncated:c.historyTruncated,nextExperiment:c.nextExperiment,latestOutcome:c.attempts?.[0]?.reportedOutcome,evidenceIssues:(c.attempts??[]).flatMap(a=>(a.evidence??[]).filter(e=>e.integrity!=='intact'||e.sourceIntegrity!=='intact').map(e=>({path:e.path,integrity:e.integrity,sourceIntegrity:e.sourceIntegrity})))}));
await writeFile(prefix+'-research.json',JSON.stringify({observedAt,watch,candidates:review},null,2),{flag:'wx'});
await writeFile(prefix+'-research.md',[
'# 출처 변화와 현재 부족한 기능 대조',observedAt,
'research:watch → ledger sync → status를 순서대로 실행했다. 54개 후보의 최근 시도·다음 실험·증거 상태는 research.json에 보존한다. 원본 증거 변경과 보존 스냅샷 무결성은 별개이며 인수 승격 근거가 아니다. 실패한 UI fixture와 계약 시험을 수정한 뒤 재검증한다.',
'감시 6곳 중 OpenAI 문서 3곳 changed, 나머지3 unchanged, 오류0였다. HTML 바이트 변화는 새 기술 출시로 판단하지 않았다. 공식 본문을 다시 확인했다.',
'[Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)는 managed session/orchestration/recovery와 sandbox·tools를 설명한다. 외부 세션의 지속성은 JARVIS owner 세션과 현재 결과 권한 검사를 대체하지 않는다. 이번에는 기존 Core/SQL/G 경로를 UI로 연결하는 것이 실제 빈틈을 해결하므로 새 제공자 설치·유료 API 호출을 하지 않았다.',
'[Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)는 앱이 도구·저장·승인·배포를 소유하는 SDK 경로와 managed API를 구분한다. 이번 경로는 앱이 보존하는 요청 중복키·현재 읽기 권한·검증된 결과 회수를 유지한다.',
'[Changelog](https://developers.openai.com/api/docs/changelog)의 2026-10-07 chat-latest snapshot 갱신과 10-06 Decisions beta는 확인했으나 새 로컬 성능 개선으로 집계하지 않았다. Decisions는 기존 openai-decisions-bounded-routing-comparison 후보에 이미 정의돼 있다. 예산/API 가용성/동일 조건 실측 전 활성화하지 않는다. 이번 작업의 p50/p95·모델 비용 비교는 미측정이다.'
].join('\n\n'),{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
'# Microsoft 독립 수집 화면과 요청 복구',observedAt,'공식 인수 '+JSON.stringify(counts)+'/100. 이번 작업으로 상태를 승격하지 않았다.',
'## 구현과 사용',
'밝은 독립 화면 /src/ui/connections/microsoft.html을 추가했다. 현재 scope·permission revision·관측 준비도에 따라 선택 가능한 Outlook/Teams를 표시한다. 보호 자격증명은 화면/요청 기록으로 전달하지 않는다. 선택 연결의 제목·시각 등 한 페이지 메타데이터만 수집하며 본문·첨부·발송·전체 페이지 수집을 포함하지 않는다. 추가 자연어 절은 생략해 실행하지 않는다. Teams는 확인된 chat ID가 필요하고 자동 대화 목록 선택은 미구현이다.',
'요청을 Core로 보내기 전에 브라우저 저장소에 version·idempotency key·Mission ID·선택 연결만 보존한다. 자료 제목·본문·토큰을 요청 journal에 저장하지 않는다. 저장 불가/손상은 새 실행을 차단한다. 응답 소실 뒤 원래 요청을 찾고 CREATED는 명시적으로 이어 실행하며 COMPLETED는 현재 읽기 권한으로 결과만 회수한다. 자동 신규 생성/불명확 재실행을 막는다.',
'실행 허용은 기존 Mission gate를 따른다. 승인 endpoint의 기본 자동 resume와 별도 run이 겹치던 클라이언트 경로는 resume:false 뒤 한 번 run으로 수정했다. 읽기 권한을 실행 권한으로 확대하지 않는다. 명시적으로 철회된 owner를 자동 활성화하지 않는다. 생성 응답 대기 중 중단 요청도 이후 생성된 요청을 cancel하고 run하지 않는다. 화면을 떠나면 표시 결과를 비우며 권한 재확인 전 다시 공개하지 않는다.',
'공통 연결 메뉴와 PC 프로그램의 기능 목록에 바로가기를 추가하고 static build에 포함했다. 설치된 EXE/서비스를 재빌드·배포·재시작하지 않았다. Paperclip의 상태 표시·피드백 원칙과 기존 밝은 디자인 토큰을 재사용해 준비됨/이력 완료/현재 검증됨을 구분했다. 새 반짝이는 별표를 넣지 않았다.',
'## 검증과 발견한 실패',
'공유 회귀130개 통과, 추가/최종 클라이언트·연결·PC 메뉴19개 통과(17개 중복이므로 합계149개로 주장하지 않음; 고유132개). 실패/skip/cancel0. build와 Core contract gate 통과. 전체 제품/외부 실계정 인수 결과가 아니다.',
'실제 Chrome에서 1440px·390px 화면을 각각 검사했다. 실제 configured Core와 SQLite/E/B/G/Mission, localhost 관리 API, DPAPI 격리 저장을 사용했고 OAuth/Graph 응답은 합성이다. 선택·미지원 추가 절 차단·run 응답 소실·새로고침 후 요청 회수·기존 gate 허용·현재 결과 확인·다시 로드한 결과 회수·화면 숨김·연결 철회·악성 HTML 제목 이스케이프를 확인했다. 화면당 create1/run2(초기 gate 진입1+허용 후 실행1), 새 요청/중복 공급자 수집0, 결과 회수의 공급자 추가 호출0. JS 오류/수평 넘침0. screenshot을 직접 확인했다. hide 검사는 document visibility 이벤트를 제어해 수행한 UI 반례이며 실제 OS 최소화/SCM 테스트는 아니다.',
'첫 UI import는 중첩 template 조건문 오류로 실패해 결과 fragment를 따로 구성했다. 브라우저 fixture는 vault.save 계약 누락, OAuth connection의 authMethod 누락으로 실패했다. 실제 B의 A_MICROSOFT_CONNECTION_REQUIRED 원인을 확인하고 합성 fixture에 oauth2를 넣었다. 클라이언트 gate 시험은 아직 Mission ID를 회수하지 않은 fixture에서 CREATED를 받았기에 실패했으며 먼저 원래 Mission을 locate하도록 수정했다. 제품의 연결/승인 정책이나 오라클을 약화하지 않았다. before/failure 로그를 보존한다.',
'## 한계와 다음 작업',
'실제 계정 OAuth/probe·Teams UI 실계정·설치 업데이트·서비스 계정·장기 관측은 미완료다. 브라우저 저장소는 명령 중복 방지를 위한 기록이며 Core의 서명/권한/G 검증을 대체하지 않는다. 현재 화면은 마지막 명시 조회 시점의 검증 결과이며 권한 변경의 실시간 push 반영은 아직 없다. 유료 API·외부 발송·실거래0; 비용과 제품 p50/p95 미측정. 격리 helper는 종료했으며 사용자 vault·프로필·F/cognition은 수정하지 않았다.',
'다음은 미영수증 in_flight/uncertain의 운영 대사와 설치 후보 연결이다. 실계정/서비스/클라우드 예산 준비 조건을 합성 성공으로 대체하지 않는다. 복원은 독립 수집 진입을 비활성화하고 요청 journal·Mission·SQL/서명 증거를 보존하며, uncertain을 수동 완료로 바꾸지 않는다. 계정 연결 가이드는 docs/microsoft-collection-mission.md.'
].join('\n\n'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-research.md','-research.json','-regression.txt','-client-verified.txt','-build.txt','-contract.txt','-browser-diagnostic.txt','-client-final.txt','-browser-final-pass/report.json','-browser-final-pass/desktop-verified.png','-browser-final-pass/mobile-verified.png'].map(s=>prefix+s).concat('docs/microsoft-collection-mission.md');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'microsoft-mission-ui-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'원래 Mission 중복키·현재 읽기 권한·검증 결과를 독립 화면에 연결하면 응답 소실 후 중복 수집 없이 결과를 확인할 수 있다.',lesson:'승인 API 자동 resume와 클라이언트 run을 중복하지 않고, journal의 원문 결속과 현재 결과 검증을 분리해야 한다. 준비도와 historical COMPLETED는 현재 결과 공개 근거와 다르다.',limitations:'고유132검사/Chrome2화면/build/contract. OAuthGraph합성/실계정·SCM·운영설치·장기관측·권한실시간push 미완료. 비용/제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-032','V3-073']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),prefix+'-report.md',prefix+'-source.json',prefix+'-browser-final-pass/report.json'])];gate.limitations.push('2026-10-08: Microsoft 독립 수집UI/응답손실 요청회수/current result/Chrome2화면·132고유검사/build/contract. 실제계정/설치/TeamsUI/장기관측 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md','\n최신 '+prefix+'-report.md: Microsoft 독립 밝은 수집UI·요청 journal/회수/현재결과/중단·Chrome2화면/132고유검사/build/contract. 공식 '+counts.verified+'/100 유지. 다음 미영수증 uncertain 대사/설치 후보/실계정 준비.\n');
console.log(JSON.stringify({counts,uniqueTests:132,browserViews:2}));
