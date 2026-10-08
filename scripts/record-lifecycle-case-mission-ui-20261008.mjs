import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/lifecycle-case-mission-ui-20261008',observedAt=new Date().toISOString(),read=p=>readFile(p,'utf8');
const regression=await read(prefix+'-regression-final.txt');if(!regression.includes('ℹ pass 112')||!regression.includes('ℹ fail 0')||!regression.includes('ℹ skipped 0'))throw Error('regression required');
if(!(await read(prefix+'-build-final.txt')).includes('Built static JARVIS')||!(await read(prefix+'-contract-final.txt')).includes('gatePassed: true'))throw Error('build/contract required');
const browser=JSON.parse(await read(prefix+'-browser/report.json'));if(browser.length!==2||browser.some(v=>v.missionCreates!==2||v.missionRuns!==2||v.intents!==2||!v.changedSourceClearsContent||!v.lostCreateNoImplicitRun||!v.explicitContinueCreated||v.pageErrors.length||v.horizontalOverflow))throw Error('browser required');
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await read(path)).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('acceptance changed');
const sources=['src/ui/workspace/lifecycle-case-mission-client.js','src/ui/workspace/lifecycle-cases.js','src/ui/workspace/lifecycle-cases.html','tests/lifecycle-case-mission-client.test.js','tests/fixtures/lifecycle-case-mission-browser.mjs','scripts/lifecycle-case-mission-browser-qa.py','docs/lifecycle-cases.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 選択 생활 업무의 Mission 요청·현재 결과 화면

관측 ${observedAt}. 배송·반품·행정 독립 밝은 화면에 선택 기록의 Mission 요청과 현재 결과 재검증을 연결했다. “선택한 생활 업무의 로컬 기록과 마감을 조회해.”라는 제한 문장만 제출한다. 추가 취소·메일 지시는 일부만 실행하지 않고 설명한다. 사용자 화면에 요청 대상·현재 원장 검증·실제 공급자 미검증·외부 처리 요청 없음이 함께 표시된다. Paperclip의 상태 표시 원칙을 적용하고 기존 스타일/컴포넌트를 재사용했다. 반짝이는 별표 없음.

명시적인 새 조회 요청에서만 기존 prepareOwnerCommand로 세션을 준비한다. 활성 세션을 재사용하고 필요할 때 read_only만 요청하며 명시적 철회는 자동 취소하지 않는다. Mission의 longTermMemory=false로 업무 내용의 F 축적을 요청하지 않는다. 새 화면은 사용자 입력 제목/결과를 HTML escape하고 현재 결과의 Mission ID/선택case/store/revision 및 readOnly/providerVerified/completionVerified/executionAuthority 플래그를 확인한 뒤 표시한다. 현재 재검증 실패나 요청 오류 시 이전 내용은 지운다.

발신 전 sessionStorage에 요청키·Mission ID·case/store ID·버전만 기록한다. 제목·접수번호·자격증명·결과 내용은 넣지 않는다. 생성/실행 응답을 잃으면 새 요청을 차단하고 같은 Mission을 조회한다. 조회 자체로 다시 실행하지 않는다. 생성만 된 CREATED 상태는 별도 ‘미실행 조회 이어서 실행’을 사용자가 눌러야 실행한다. 잘못된 복구 기록·저장소 사용 불가·선택 버전 변경은 생성 차단. 동일 탭의 새로고침은 복구되지만 탭 종료/브라우저 삭제 이후 복구나 암호화 저장을 보장하지 않는다.

실제 브라우저 첫 실행에서 한국어 Mission ID를 ASCII-only 복구 스키마가 거절했다. 서버 Mission은 COMPLETED였지만 새로고침 뒤 결과를 회수하지 못했다. Unicode 문자/숫자와 underscore/hyphen을 허용하고 경로는 encodeURIComponent로 유지하여 수정했다. 최초 실패를 browser-first/second 로그에 보존했다. 단위 첫 실패는 테스트 mock이 JSON 네트워크 경계 없이 요청 selection 객체를 공유해 생겼고 fixture를 실제 네트워크처럼 clone하도록 수정했다. 제품 권한이나 원장 검증을 완화하지 않았다.

실제 임시 Core SQLite + Core/E/B/G Mission + 인증 dev proxy + Chrome, 데스크톱1440/모바일390에서 각각 두 업무를 수행했다. 실행 완료 후 응답 손실→새로고침→현재 결과 조회, 생성 완료 후 응답 손실→새로고침→CREATED 조회→사용자 이어 실행을 각각 검증했다. 화면당 명시적 요청2·Mission 생성2·실행2, 대사로 생긴 재발신0. 기록 변경 후 현재 결과 미검증/과거 내용 제거, 미지원 꼬리 생성0, pageerror0/가로 넘침0. 전체 페이지 캡처도 검토했다.

최종 공유112/112 실패0·생략0, build/Core contract gate 통과. 합성 임시 ops/growth DB만 사용했고 운영 F/cognition·실계정·제공자·설치 EXE·서비스는 변경하지 않았다. 테스트 도우미와 자식 UI/Core/Chrome은 종료했다. 실제 외부 공급자·유료 모델 호출0. 비용/p50/p95·장기 실사용 평가는 미측정이다.

운영 lifecycleCaseAccess와 검토된 준비도 계약의 활성화가 필요하다. 화면 구현은 현재 설치 PC 앱의 자동 활성화/업데이트 증거가 아니다. 실제 배송/반품/민원 조회·취소·환불·접수는 미연동이다. 재시작 뒤 task 영수증과 새 소유자 세션 회수는 남았다. 자유 자연어 전체 해석 완료로 확대하지 않는다. 복원은 새 Mission client·화면 블록·핸들러를 함께 제거하고 기존 로컬 원장과 이력을 유지하는 방식이다.

공식60 verified/23 in_progress/17 pending 유지. V3-041/077의 부분 증거로 연결하며 전체 기준은 줄이지 않는다. 다음은 운영 host의 선택 read 접근과 준비도 연결, 영속 영수증/새세션 경계 검증 및 실제 공급자 파일럿이다.
`.replace('選択 생활','선택 생활'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-browser-first.txt','-browser-latest.txt','-regression-final.txt','-build-final.txt','-contract-final.txt','-browser/report.json','-browser/desktop-verified.png','-browser/mobile-verified.png'].map(s=>prefix+s);
for(const id of ['V3-041','V3-077']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 선택 로컬 기록 Mission UI·읽기세션·새로고침 생성/실행손실복구·현재결과변경미공개,실제CoreSQLiteChrome2화면/112회귀/build/contract. 운영host/설치EXE·실공급자/재시작영수증 미완료.');}
doc.updatedAt=observedAt;await writeFile(path,JSON.stringify(doc,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-mission-ui-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'선택 기록 Mission과 현재 결과 오라클을 밝은 독립 화면에 연결하면 요구를 부분 실행하지 않고 응답 손실 뒤 같은 작업을 회수할 수 있다.',lesson:'실제 한국어 Mission ID가 들어간 브라우저 복구를 검사해야 ASCII 테스트 ID가 놓치는 오류를 찾는다. 읽기 대사와 새 실행을 구분하고 생성/실행 손실을 각각 확인했다.',limitations:'한정한국어·합성 임시CoreE/B/G/UI112회귀/Chrome2화면. 운영 설치본/실공급자/재시작영수증/범용자연어 미완료. 비용/지연미측정,공식60%유지.'},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 선택생활기록Mission UI/read_only/sessionjournal·생성/실행응답손실각각실CoreSQLiteChrome복구,한국어ID복구결함수정,112회귀/build/contract. 공식60/23/17 유지. 다음 운영host read준비도와 영속영수증/새세션 경계, 실제 공급자.\n`);
