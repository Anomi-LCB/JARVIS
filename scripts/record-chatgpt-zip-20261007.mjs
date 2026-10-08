import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/chatgpt-zip-20261007',observedAt=new Date().toISOString(),read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [key,value] of [['tests',22],['pass',22],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final2.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build2.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const browser=JSON.parse(read(`${prefix}-browser-final/report.json`));assert.equal(browser.status,'passed');assert.equal(browser.checks.length,2);
for(const check of browser.checks){assert.equal(check.choices,501);assert.equal(check.visiblePerPage,50);assert.equal(check.initialNetworkRequests,0);assert.equal(check.zipPrivateSent,false);assert.deepEqual(check.pageErrors,[]);}
const sourcePaths=['packages/shared/src/chatgpt-export-file.js','src/ui/selected-conversations.js','scripts/import-selected-conversations.mjs','tests/chatgpt-export-file.test.js','tests/fixtures/chatgpt-export-ui-browser.mjs','scripts/chatgpt-zip-browser-qa.py','docs/selected-conversation-import.md'];
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(acceptancePath)),gates=acceptance.stages.flatMap(s=>s.gates),verified=gates.filter(g=>g.status==='verified').length;assert.equal(verified,59);
write('verification.json',{observedAt,tests:22,passed:22,failed:0,skipped:0,browser,buildPassed:true,contractPassed:true,formalVerified:59,
  inputKind:'synthetic official-format ZIP generated independently with Python zipfile',installedAppActivated:false,realUserExportUsed:false,paidCalls:0,cost:null,costStatus:'unmeasured'});
write('report.md',`# ChatGPT 내보내기 ZIP의 선택 기억 연결

관측 ${observedAt}. V3-057 부분 개선, 공식 인수59/100 유지. 실제 사용자 내보내기·설치 PC 앱 호환 인수는 미완료다.

## 사용자에게 달라진 기능

ZIP을 먼저 풀지 않고 대화 파일을 선택한다. 대화 제목 검색과50개 단위 페이지를 사용하고 페이지 간 선택을 유지한다. 한 번에20개 대화만 고를 수 있다. 파일 이름을 계속 표시해 입력 필드가 다시 그려져도 읽은 파일을 확인할 수 있다. 파일 선택·제목 검색·페이지 이동은 로컬 처리이고 확인/저장 때 선택한 현재 텍스트 분기만 Core에 전달한다. 계정 JSON·HTML·이미지 등 ZIP의 다른 항목은 가져오기·실행·전송하지 않는다.

CLI의 기존 --chatgpt-export --document에 ZIP 경로를 사용할 수 있다. 원본 압축 바이트 SHA-256과 선택 문서 해시를 모두 확인하며 미선택 파일만 바뀌어도 이전 검토로 저장하지 않는다. 선택하지 않은 대화는 기억에 반영하지 않는다. 저장한 말은 출처 있는 참고 자료이며 실행 승인/확정 선호/검증 결과로 승격하지 않는다. 재저장 중복 및 철회는 기존 F 계약을 유지한다.

## 실제 실행 증거

Python 표준 zipfile이 만든 Store/Deflate ZIP과5MiB 초과 JSON을 Node에서 읽고, 실제 CLI→F SQLite 미리보기/저장/재전송을 확인했다. CRC 기준 벡터123456789와 헤더/이름/CRC/압축 방법/암호화/크기/경로/중복 ID/혼합 JSON/잘못된 UTF8/누락 반례를 검사했다. 선언보다 크게 풀리는 압축은 스트림 중단으로 제한한다.

실제 Chrome의1440·390 너비, 실제 인증된 Core HTTP·임시 F SQLite에서501개 대화/5.4MB JSON의 번호별 ZIP을 읽고50개 표시·페이지 왕복 선택 유지·제목 검색·선택2개 미리보기/저장·검색/철회를 완료했다. 최초 파일 읽기 전송0, 미선택 대화/계정 파일 전송0, 손상 파일에서 추가 요청0·저장 버튼0, 페이지 오류0·가로 넘침0. 화면은 생산 패널 컴포넌트이며 임시 검사 HTML의 스타일을 사용했고 설치 EXE·전체 제어센터 검사로 확대하지 않는다. 스크린샷을 육안으로 확인했다.

최종5파일22/22·실패0·skip0, 빌드/Core 계약 통과. 첫 단위2실패는 Windows Python stdin 인코딩 준비 오류로 -X utf8을 적용했다. 브라우저 초기 실행은 시험 전용 루트 미설정으로 차단되어 격리 루트를 지정했다. 중간 검색3개/예상2개 차이는 두 viewport의 기록이 같은 범위에 남고 검색 단어가 공통이었던 fixture 가정 오류로 고유 검색어를 사용했다. 실패 로그를 보존하며 제품 결함 수정으로 부풀리지 않는다.

## 조건과 한계

공식 문서는 ZIP 및 conversations.json 또는 번호 파일을 안내한다: https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts (2026-10-07 확인). 내부 mapping 스키마의 안정성·모든 export 버전 호환은 확인되지 않았다. 원본 해시는 진위/소유자 인증이 아니다. 원본 ZIP64·암호화·기타 압축·하위 폴더 내 JSON은 지원하지 않는다. ZIP64MiB/JSON합계32MiB·10000대화 제한이며 JSON 객체 전체는 로컬 메모리에 올린다. 저장 API의 기존4MiB/20대화/1000문장 제한은 별도로 유지한다. 무제한 대형 파일 스트리밍이 아니다.

유료 호출·개인 실제 파일·계정 발송·운영 서비스 재시작·설치본 활성화0. 비용 미측정. 실제 업무 F/cognition을 수정하지 않았다. 다음은 사용자가 직접 고른 실제 공식 export의 사적 호환 검사와 설치 프로그램의 같은 화면 실증이다. 복원은 새 로컬 파일 판독기/UI·CLI 호출부를 함께 검토하되 기존 선택/출처/철회 계약과 미선택 전송0 반례를 보존한다. Paperclip의 피드백·액션 원칙을 참고해 읽은 파일명과 선택 개수·다음 행동을 가까이 표시했다.
`);
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-first.txt`,`${prefix}-first-runner.json`,`${prefix}-final2.txt`,`${prefix}-final2-runner.json`,`${prefix}-browser-final/report.json`,`${prefix}-browser-final/preview-1440.png`,`${prefix}-browser-final/preview-390.png`,`${prefix}-browser2.txt`,`${prefix}-browser3.txt`,`${prefix}-build2.txt`,`${prefix}-contract.txt`];
write('attempt.json',{id:'chatgpt-zip-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'공식 ZIP/번호 JSON을 크기/CRC/출처 검사로 로컬에서 읽고 선택만 전달하면 대규모 내보내기에서 수동 압축 해제 없이 기존 기억 계약을 유지할 수 있다.',
 lesson:'큰 파일 읽기와 기억 저장 상한을 분리해야 한다. 원본 해시는 압축 바이트로 고정하고 UI 페이지 이동/검색에서도 선택을 유지하며 미선택 내용은 전달하지 않는다.',
 limitations:'22회귀/실Chrome2뷰/실CoreHTTP/F임시SQL/합성표준ZIP. 실제사용자export·내부스키마안정·설치앱·무제한스트리밍 미완료. 공식59% 유지, 비용미측정.'});
const gate=gates.find(g=>g.id==='V3-057');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: ZIP Store/Deflate·번호 JSON·32MB/10000대화 로컬 판독/CLI 원본해시 대조/Chrome2뷰501대화 제목·페이지·선택저장·철회/미선택전송0·22회귀/build/contract. 실제사용자export·설치앱·모든mapping/무제한스트리밍 미완료.');acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: ZIP/번호 JSON 로컬 판독·원본해시·제목/50페이지/20선택·실Chrome2뷰/Core HTTP/F SQL501대화·미선택전송0·22회귀/build/contract. V3-057 부분/공식59%. 실제사용자export·설치앱 호환 필요.\n`);
console.log(JSON.stringify({observedAt,verified,tests:22,browserViews:2,evidenceCount:evidencePaths.length}));
