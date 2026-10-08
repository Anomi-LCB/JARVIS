import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/selected-source-history-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(s,v)=>writeFileSync(`${prefix}-${s}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
for(const [key,value] of [['tests',80],['pass',80],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.equal(JSON.parse(read(`${prefix}-final-runner.json`)).status,'passed');assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const browser=JSON.parse(read(`${prefix}-browser-first/result.json`));assert.equal(browser.cases.length,2);
assert.ok(browser.cases.every(c=>c.reloadHistoryRevalidated&&c.revokedContentHidden&&c.pageErrors.length===0));assert.equal(browser.execution.reads,2);assert.equal(browser.execution.missions.length,2);
const sources=['packages/core/src/mission/selected-source-history.js','packages/core/src/main.mjs','src/ui/connections/selected-sources.js',
 'tests/selected-source-history.test.js','tests/selected-source-result.test.js','tests/selected-sources-ui.test.js',
 'tests/fixtures/selected-source-restart-child.mjs','scripts/selected-sources-browser-qa.py','docs/personal-source-inbox.md'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:80,passed:80,failed:0,skipped:0,unsafeControlCases:1,
 historyPaginationItems:501,newPidHistoryCases:9,processes:18,browserReloadCases:2,
 historicalMetadataAsCurrentVerification:false,newBExecutionsForOpeningHistory:0,externalProviderCalls:0,
 productionActivation:false,installedProgramUpdated:false,formalVerified:59,actualCost:null,productLatency:null});
write('report.md',`# 저장 자료의 이전 조회 찾기와 현재 결과 재검증

관측 ${observedAt}. 공식 인수59/100 유지. 완료 결과의 새 PID 복원에 이어 실제 사용자 화면에서 과거 작업을 찾는 흐름을 연결했다.

## 실제 사용 흐름

독립 저장 자료 화면에서 연결을 선택하면 해당 연결의 이전 Mission 이력이50건씩 표시된다. 전체 브라우저 새로고침 뒤 같은 연결을 선택하고 '현재 자료로 다시 검증해 열기'를 누르면 기존 결과 경로에 현재 owner 읽기 허용을 전달한다. 새 Mission 생성·실행 없이 현재 SQL와 task/G 증거를 대조한다. 원래 실행 권한을 바꾸지 않는다. 자료나 권한이 달라졌으면 내용은 숨긴다.

새 ADMIN 전용 이력 API는 선택 자료에 결속된 Mission의 ID·상태·시각만 반환한다. 제목·본문·자격증명·원문 요구·전체 개인 Mission은 전달하지 않는다. 과거 완료 상태와 현재 결과 검증은 분리하고 currentResultVerified=false를 명시한다. 읽기 전용 source worker나 diagnostics scope는 이력 관리자 권한으로 확대되지 않는다.

페이지는 전체 최소 이력의 SHA-256 revision에 결속한다. 다음 페이지 중 추가·수정·취소가 생기면409로 재조회하게 한다. 누락된 페이지를 조용히 섞지 않는다. 과거 이력은 새 계정 인증이나 현재 공급자 동기화 성공의 증거가 아니다.

Paperclip의 일관된 상태·행동 문구 원칙을 참고해 '이전 조회'와 '현재 자료로 재검증'을 구분했다. 기존 밝은 배경·토큰·버튼 스타일을 사용하며 반짝이는 별표를 추가하지 않았다. 설치 EXE 적용 보고는 아니다.

## 검증

공유80개 통과·실패0·건너뜀0, build·Core OpenAPI baseline gate 통과.501개 이력을500+1로 나눠 ID 누락·중복0을 확인하고 revision 변경·타계정·원문 변조·미지원 인자를 거부했다. 실제 Core HTTP의 미인증401, diagnostics403, 잘못된 선택404, 추가 필드400, 변경된 페이지409를 확인했다. 기존 위험 보호 제거 대조군1개는 허위 완료 반례이며 업무 성공으로 계산하지 않는다.

Windows 보호 키를 사용하는9개 새 PID 복원 사례에서 이전 Mission을 실제 이력 HTTP로 찾았다(18프로세스). 현재 결과의 양성1개와 자료·서명·위임·읽기권한·준비도·관측 변조8개 차단을 재확인했다. 현재 이력에는 실제 자료 텍스트나 계정·토큰 문자열이 없었다.

실제 Chrome1440/390 두 폭에서51개 저장자료의50+1페이지, 전체 reload 뒤 이력 찾기→현재 결과 재검증→철회 후 내용 숨김을 수행했다. 새로 연 결과 때문에 B 실행이 늘지 않았으며 전체2개 최초 Mission/2회 B읽기를 유지했다. 화면 overflow·주입 img·console/page 오류0. narrow screenshot도 실제로 확인했다. 합성 저장자료이며 외부 공급자 호출0이다.

## 한계·복원·다음 인수

실제 Outlook/Teams OAuth·본문/첨부·증분수집, 운영 서비스·설치EXE, 다른PC/Linux 키 이전 및 장기 실사용은 아직 미실증이다. 새 프로세스의 결과는 이전 작업이 보호된 서명 영수증을 보유할 때만 열리며 legacy 기록을 재서명하지 않는다. 제품 p95·비용·실계정 완료율은 미측정이다.

복원하려면 이력 API/helper와 UI의 이력 액션을 제거하고 기존 조회/현재 결과 경로를 유지할 수 있다. 사용자 원장·F/cognition·과거 Mission은 삭제하지 않는다. 전체 인수 범위를 이 좁은 화면으로 줄이지 않는다. 다음 작업은 V3-024의 독립 의미평가26/260과 V3-020의 일반 질문 필요성·독립읽기 종료 조건을 고정해 구현/평가를 진행하는 것이다. 파일 무결성은 증거 보존일 뿐 결론의 독립 검증이 아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','final.txt','final-runner.json','first.txt','first-runner.json','build.txt','contract.txt','browser-first/result.json'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'selected-source-history-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'최소 이력 API와 현재 읽기 재검증을 분리하면 재시작/새로고침 뒤 과거 완료를 허위 현재 완료로 표시하거나 실행을 반복하지 않고 결과를 다시 찾을 수 있다.',
 lesson:'새PID 내부 복원만으로 사용자 연속성이 완성되지 않는다. 브라우저 새로고침→선택별 이력→현재권한/자료 대사까지 수행하고 역사적 상태는 현재검증과 분리해야 한다.',
 limitations:'80검사·Windows9복원/18프로세스·실Chrome2폭 reload. 합성metadata·실공급자OAuth/본문/첨부·다른PC/Linux·설치/운영·장기실사용 미검증. 공식59%.'});
const path='docs/universal-control-v3-acceptance.json',data=JSON.parse(read(path)),gates=data.stages.flatMap(s=>s.gates);assert.equal(gates.filter(g=>g.status==='verified').length,59);
const gate=gates.find(g=>g.id==='V3-073');assert.notEqual(gate.status,'verified');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 저장자료 최소이력·revision페이지·새PID 이력→현재읽기대사·실Chrome reload2폭·80회귀/build/contract. 실공급자OAuth/본문/첨부/증분수집·설치운영 남음.');
data.updatedAt=observedAt;writeFileSync(path,JSON.stringify(data,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 최소이력 API·새PID조회·브라우저 reload후 이전조회→현재읽기 재검증,501이력/80회귀/2폭/build/contract.59% 유지. 다음 V3-024 독립의미26/260 및 V3-020 일반질문·독립읽기 종료조건.\n`);
console.log(JSON.stringify({observedAt,tests:80,verified:59}));
