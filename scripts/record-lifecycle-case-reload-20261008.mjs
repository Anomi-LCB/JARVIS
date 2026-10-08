import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/lifecycle-case-reload-20261008',observedAt=new Date().toISOString();
const regression=await readFile(prefix+'-regression-final.txt','utf8'),browser=JSON.parse(await readFile(prefix+'-browser/report.json','utf8'));
if(!regression.includes('ℹ pass 65')||!regression.includes('ℹ fail 0')||!regression.includes('ℹ skipped 0'))throw Error('Regression required');
if(browser.length!==2||browser.some(b=>!b.realCoreSqlite||!b.lostAfterServerCommit||!b.sameRequestAfterReload||b.posts!==2||b.duplicates||b.externalCalls||b.pageErrors.length||b.horizontalOverflow))throw Error('Browser proof required');
if(!(await readFile(prefix+'-build-final.txt','utf8')).includes('Built static JARVIS')||!(await readFile(prefix+'-contract-final.txt','utf8')).includes('gatePassed: true'))throw Error('Build/contract required');
const sources=['packages/core/src/personal-operations/lifecycle-cases.js','packages/core/src/main.mjs','src/ui/workspace/lifecycle-case-client.js','src/ui/workspace/lifecycle-cases.js','tests/lifecycle-case-reload.test.js','tests/lifecycle-case-page-client.test.js','tests/lifecycle-cases.test.js','scripts/lifecycle-case-reload-browser-qa.py','docs/lifecycle-cases.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 새로고침 후 불명 업무 기록 복구

관측 ${observedAt}. 이전 lifecycle-case-ui 보고서의 보류 요청이 새로고침 뒤 사라지는 한계를 보완했다. 기존 Core 개인 업무 SQLite, 동일 요청 재생, 밝은 사용자 화면을 재사용했다.

발신 전에 보류 요청의 path·본문·ID·expectedStoreId를 같은 origin/tab의 sessionStorage에 저장한다. 새로고침 뒤 미확인 요청을 복원하고 신규 기록을 막는다. 사용자가 이전 요청 결과 확인을 누르면 원래 ID·대상·입력·revision으로 재생한다. 자동 새 요청 생성/자동 공급자 재발신은 없다. 성공이나 명확한 입력 거절 뒤 복구 기록을 지운다. 저장 실패는 POST 전에 차단하고 잘못된 journal은 다른 API로 실행하지 않는다. 보류 기록 삭제 실패 시 메모리 요청도 유지하여 재생 가능성을 보존한다.

DB에 persisted storeId를 추가하고 ADMIN context API로 읽는다. 새로운 UI는 expectedStoreId를 쓰기에 포함하며 server가 불일치를409로 거절한다. 이전 탭의 보류 요청이 다른 DB에 재생되어 새 업무를 만들지 않도록 복원 시 context와 비교한다. source/context를 읽은 직후 DB가 바뀌는 반례는 서버 guard가 거절한다. store 변경 오류는 journal을 보존한다. 신규 발신은 context 읽기1회로 제한했다. 중복 context 조회를 줄였지만 실사용 속도 향상은 측정하지 않았다. 기존 API의 필드는 선택으로 유지한다.

최종 공유6파일65/65 실패0·생략0. SQL 반영 후 응답 손실, 새 client/동일 DB 재생, 취소 event 재생1개, 다른 DB noPOST, storage quota noPOST, malformed/외부 API path noPOST, context 검사 직후 저장소 변경과 실제 HTTP401/409을 검사했다. ledger ID는 DB 재연결에서도 유지된다. 역할/계정 권한 및 Core authority lease를 대신하지 않는다. 복제된 DB의 활성 권위는 기존 fencing 경로 책임이다.

실제 격리 Core/SQLite+dev proxy+Chrome desktop1440/mobile390에서 route.fetch로 서버200 저장까지 진행한 후 브라우저에 응답을 전달하지 않고 중단했다. 새로고침 후 신규 등록 버튼 비활성·복구 버튼 표시, 원본과 같은 POST2회/업무1건, 정상 응답 뒤 journal 제거를 확인했다. 화면 오류0·가로 넘침0·외부 공급자 호출0. 최종 build와 Core contract gate 통과. 모바일 스크린샷을 직접 확인했고 Paperclip의 명확한 상태·근처 오류 안내 원칙을 유지했다.

sessionStorage는 암호화 credential vault가 아니다. 이 기능은 사용자에게 화면에서 입력받은 구분/접수번호와 재생 본문을 동일 탭에 보존하며 비밀번호·OTP·토큰을 받지 않는다. 탭 종료/브라우저 세션 삭제 후 복구, 임의 외부 공급자 발신, 실제 취소/환불/민원 접수는 미완료다. 실제 계정·설치 EXE·운영 서비스·개인 F/cognition은 변경하지 않았다. 유료 모델/공급자 호출0, CPU/전력 비용 및 p50/p95는 미측정.

공식 인수60/100 유지. V3-077은 자연어 E/B/G·실제 공급자 확인·영수증 대사가 남았고 V3-040/041 전체의 모든 쓰기/불명 결과 복구를 이 좁은 기능으로 승격하지 않는다. 기존 증거는 덮어쓰지 않고 후속 기록으로 연결한다. 복원은 journal client와 context/store guard를 함께 되돌리는 범위이며 DB 업무·상태·요청 키를 삭제하지 않는다. 다음 작업은 생활 기록을 요구 계약/검증 결과에 연결하고 실제 연동 준비도와 미지원 경계를 표시하는 것이다.
`,{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-regression-final.txt','-browser-final.txt','-browser/report.json','-browser/desktop.png','-browser/mobile.png','-build-final.txt','-contract-final.txt'].map(s=>prefix+s);
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Acceptance changed');
for(const id of ['V3-040','V3-041','V3-077']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 생활기록 발신 전 session journal/새로고침 복원/DB identity guard·실제CoreSQLiteChrome2화면 응답손실후동일요청/중복0,65회귀/build/contract. 탭종료·외부공급자·일반Mission/자연어·설치본 미완료,인수60%유지.');}
doc.updatedAt=observedAt;await writeFile(path,JSON.stringify(doc,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-reload-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'생활 기록의 발신 전 journal과 DB binding을 유지하면 응답 손실 후 새로고침해도 다른 요청이나 DB로 바뀌지 않고 동일 로컬 효과를 재생할 수 있다.',lesson:'UI tab 재생과 server DB guard가 함께 필요하다. sessionStorage는 credential vault가 아니며 탭 종료는 여전히 별도 경계다. provider 완료로 승격하지 않는다.',limitations:'65합성검사/실제격리CoreSQLiteChrome2화면. 실제 공급자/자연어/E-B-G/설치EXE/탭종료복구 미완료. 비용/p50p95미측정,공식60%유지.'},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 생활 기록 발신 전sessionjournal/새로고침복원/DBidentity가드,실제CoreSQLiteChrome2화면응답손실후같은POST/중복0,65회귀/build/contract. 공식60/23/17 유지. 다음 자연어 요구계약·제공 상태 검증 경계 및 실연동 준비도. 탭 종료/브라우저 세션 삭제 복구는 별도 남음.\n`);
