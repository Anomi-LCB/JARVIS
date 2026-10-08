import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/lifecycle-case-ui-20261008',observedAt=new Date().toISOString();
const regression=await readFile(prefix+'-regression-final.txt','utf8');
if(!regression.includes('ℹ pass 60')||!regression.includes('ℹ fail 0')||!regression.includes('ℹ skipped 0'))throw Error('Terminal regression required');
const browser=JSON.parse(await readFile(prefix+'-browser/report.json','utf8'));
if(browser.length!==2||browser.some(b=>!b.realCoreSqlite||!b.reloadPersisted||b.events!==3||b.providerVerified||b.externalCalls||b.pageErrors.length||b.horizontalOverflow))throw Error('Browser evidence required');
if(!(await readFile(prefix+'-build-final.txt','utf8')).includes('Built static JARVIS')||!(await readFile(prefix+'-contract-final.txt','utf8')).includes('gatePassed: true'))throw Error('Build required');
const sources=['packages/core/src/personal-operations/lifecycle-cases.js','packages/core/src/main.mjs','src/ui/workspace/lifecycle-case-client.js','src/ui/workspace/lifecycle-cases.html','src/ui/workspace/lifecycle-cases.js','src/ui/workspace/app.js','tests/lifecycle-case-page-client.test.js','tests/fixtures/lifecycle-case-browser.mjs','scripts/lifecycle-case-browser-qa.py','docs/lifecycle-cases.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 配送·반품·행정 기록 사용자 화면

관측 ${observedAt}. V3-077의 기존 개인 업무 SQLite·ADMIN API를 일반 연결 화면의 밝은 독립 페이지에 연결했다. 업무 종류·구분 이름·운송장/주문/접수번호·마감 등록, 직접 확인한 상태와 증빙 이름 기록, 취소 의사, 공식 창구 안내 준비를 조작할 수 있다. Paperclip의 상태를 분리하고 오류를 가까이 안내하는 원칙과 기존 밝은 디자인을 사용했다. 반짝이는 별표 없음.

공급자 자동 조회·취소·환불·민원 접수는 미연결임을 명시한다. 사용자 제공 상태는 완료·권한 증거가 아니며 취소 의사는 외부 미발송이다. 안내 URL은 종류별 공식 주소와 일치할 때만 표시한다. 계정 비밀번호·OTP를 받지 않는다. 실제 계정/민원 신청이나 외부 창구 방문은 수행하지 않았다.

목록 API는 limit1~100과 구성원 고정 cursor를 추가했고, 새 등록이 중간에 발생해도 최초105건을 빠짐없이 중복 없이 조회했다. 목록 응답은 전체 이벤트를 제외한다. 내용 값은 현재 값이므로 완전한 시점 스냅샷이 아니다. 기존 query 없는 최신100건 배열 계약은 유지한다. 인증401 및 잘못된 limit/cursor/중복·미지원 query400을 실제 HTTP에서 확인했다. cursor는 서명된 권한 증표가 아니며 ADMIN 권한을 바꾸지 않는다. 상세 이벤트 이력 페이지 조회는 남았다.

클라이언트는 응답 손실 후 새 변경을 보류하고 원래 request/event ID·대상·원본 입력·revision을 그대로 재시도한다. 실제 SQL 반영 후 응답만 잃은 등록과 상태 입력에서 재생 결과·중복0을 확인했다. 원래 선택 대상을 바꾸어도 보류 요청의 대상이 바뀌지 않는다. 관측 source는 현재 기록에 고정하며 임의 source/revision 입력으로 덮어쓰지 않는다. 동시에 retry를 호출해도 하나만 실행한다. 목록 최신 요청과 선택 최신 요청의 응답만 화면에 반영한다. **보류 요청은 탭 메모리만 사용하여 새로고침/종료 뒤 복구되지 않는다.** 화면에 이를 안내하고 실제 외부 거래 복구 방식으로 주장하지 않는다.

최종 공유5파일60/60, 실패0·생략0. 실제 격리 Core/SQLite+dev proxy+Chrome desktop1440/mobile390에서21건 페이지 조회, 등록→제공된 환불 상태→취소 의사→공식 안내, 새로고침 후3개 이벤트 영속성을 확인했다. 양쪽 페이지 오류0/가로 넘침0. 공급자 확인false, 외부 호출0. 두 스크린샷을 직접 확인했다. 정적 build와 Core contract gate 통과. 설치 EXE·운영 서비스는 업데이트하지 않았다. 개인 F/cognition은 수정하지 않았다.

중간 실패는 테스트의 가변 객체 ID를 assertion에서도 바꾸어 원래 대상 확인을 잘못한 경우(focused20/21), 브라우저의 접힌 details 내용을 inner_text로 읽어 비표시 텍스트를 세려 한 경우다. ID를 별도 고정하고 details를 실제 펼친 뒤 확인했다. 최종 결과를 중간 실패 삭제로 만들지 않았으며 focused 로그를 보존했다.

API/외부 모델 유료 호출0. CPU/전력 비용 및 업무 p50/p95는 미측정. 공식 인수는60/100 유지한다. 자연어 Mission/E/B/G, 공급자 실제 상태·취소/환불·접수 영수증/독립 대사·계정 파일럿·상세 이력 페이지가 남아 V3-077을 승격하지 않았다. 다음은 이 기록을 요구 계약에 연결하되 사용자 제공 상태를 완료로 인정하지 않는 검증 경로와 실제 공급자 읽기 준비도이다. 복원은 새 화면/연결 링크와 query page 경로를 함께 제거하는 좁은 변경이며 DB 기록을 삭제하지 않는다.
`,{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-focused.txt','-regression-final.txt','-browser-closeout.txt','-browser/report.json','-browser/desktop.png','-browser/mobile.png','-build-final.txt','-contract-final.txt'].map(s=>prefix+s);
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Acceptance changed');
const gate=gates.find(g=>g.id==='V3-077');gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 밝은 독립 UI·구성원 고정 목록 페이지·탭 내 응답 손실 동일 요청 재생, 실제Core/SQLite/Chrome2화면60회귀/build/contract. 자연어/실공급자/취소대사·이벤트페이지·보류요청탭종료복구/설치EXE 미완료. 인수60% 유지.');doc.updatedAt=observedAt;await writeFile(path,JSON.stringify(doc,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-ui-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'사용자 제공 생활 업무 기록을 독립 UI와 구성원 고정 목록 조회에 연결해 공급자 완료와 혼동 없이 조작할 수 있다.',lesson:'요청 결과 불명은 기존 ID·대상·입력을 유지해야 하며 페이지 구성원과 최신 내용의 차이를 명시한다. 접힌 이력은 펼친 후 실제 표시를 검사한다.',limitations:'로컬 합성Core/SQLite/Chrome2화면60검사. 실공급자/자연어/설치EXE/상세이력페이지/탭 종료 보류 복구 미완료. 비용/p50p95미측정, 인수60%유지.'},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 배송·반품·행정 독립UI/목록페이지/응답손실동일요청·실제CoreSQLiteChrome2화면60회귀/build/contract. 공식60/23/17 유지. 다음 자연어 요구계약·제공 상태 검증 경계 및 공급자 읽기 준비도, 상세 이력 페이지.\n`);
