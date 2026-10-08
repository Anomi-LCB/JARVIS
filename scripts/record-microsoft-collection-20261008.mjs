import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/microsoft-collection-20261008',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-final-current.txt','utf8'),passed=Number(log.match(/ℹ pass (\d+)/u)?.[1]);
if(!(passed>=60)||!log.includes('ℹ fail 0')||!log.includes('ℹ skipped 0')||!log.includes('ℹ cancelled 0'))throw Error('PASS_REQUIRED');
for(const [suffix,marker] of [['-build-current-final.txt','Built static JARVIS'],['-contract-current-final.txt','gatePassed: true']])if(!(await readFile(prefix+suffix,'utf8')).includes(marker))throw Error('BUILD_REQUIRED');
const paths=['apps/runtime-compose/src/microsoft-collection-capability-package.js','apps/runtime-compose/src/microsoft-collection-access.js','apps/runtime-compose/src/create-runtime.js','packages/core/src/personal-operations/microsoft-source-reader.js','packages/core/src/orchestration/core-orchestration-worker.js','packages/core/src/planning/task-planner.js','packages/core/src/planning/claude-cli-task-planner.js','apps/verification/src/verification-runtime.js','scripts/core-service-runtime.mjs','tests/microsoft-collection-capability.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
'# Microsoft 직접 수집의 Core/E/B/G 연결',observedAt,'공식 인수 '+JSON.stringify(counts)+'/100 유지.',
'## 구현',
'source.collectMicrosoftMetadata 패키지와 host-owned access를 추가했다. 조회 대상은 Outlook 연결 또는 Teams 연결+선택 chat와 한 페이지 cursor로 제한한다. 자격증명·HTTP 호스트·SQL 경로·검증기를 모델 JSON에서 받지 않는다. 로컬 수집 원장을 변경하므로 readOnly=false/mutatesSystem=true/writesLocalFiles=true와 비롤백 변경 항목을 명시한다. 범용 read-only tool로 위장하지 않았다.',
'Core prepared Mission action task→E availability/권한→B host-local 실행→private Microsoft page proof→SQL commit oracle→G 현재 SQL 및 현재 작업/권한 검증까지 연결했다. remote PC executor로 수집 자격증명을 보내지 않는다. 원문 외 인수 sequenceIndex를 폐쇄된 새 도구 스키마에 넣지 않도록 두 계획기 경로를 반영했다.',
'운영 Core factory는 기존 동일 Integration vault와 inbox를 사용해 도구를 등록한다. 저장된 credential만으로 연결을 정상 처리하지 않는다. 해당 Microsoft 연결의 실제 readiness observation과 현재 credential revision·scope·account/permission 상태가 일치해야 실행된다. probe/연결 UI 자체는 이번에 완료하지 않았다. 권위가 설정된 Core는 현재 SQL authority도 검사한다. 종료/시작 실패는 private receipt cache를 해제한다.',
'reader.verifyCommittedPage는 원래 page의 비공개 proof·현재 OAuth 권한과 실제 SQL 페이지를 다시 검사한다. JSON 복제 페이지를 원래 공급자 proof로 취급하지 않는다. host는 제한128건의 private provenance cache를 유지하고 캐시 부재 시 실패한다. 영속 새PID 회수는 아직 지원하지 않는다.',
'## 발견한 실패와 수정',
'first: 정상2건이 비롤백 목표상태 검사 누락으로 실패했다. 실제 SQL oracle 재조회 결과에 기반한 B verification을 추가했다. 초기58회귀 통과 후 changed-before-g 반례2건을 추가하니 잘못된 성공이 재현됐다. 새 도구가 G package 호출 대상에서 빠졌고 기존 일반 판정만으로 통과했다. g-final/complete 실패 로그를 보존했다. G 호출 목록 및 package fingerprint/digest 결속·현재 SQL proof critical check를 모두 추가했다. 기준을 완화하거나 readOnly로 바꾸지 않았다.',
'## 현재 실행 증거',
'G 검증 연결 뒤 정상2건이 실패한 verified/proof-final/diagnostic/oracle 로그도 보존했다. B 수명 실행 fence를 G 시점까지 재사용하지 않도록 원래 페이지 provenance는 현재 trusted task/connection 정책에 결속하고 실행 전후/commit에는 B fence를 유지했다. 또한 evidence privacy redactor가 contentImported 플래그를 [redacted]로 바꿔 receipt 해시가 달라졌다. privacy redactor를 완화하지 않고 내부 플래그를 비공개 원문에 유지하고 공개 receipt에서는 제외했다. 본문·첨부는 공개하지 않는다.',
'최종 '+passed+'개 고유 검사, 실패/skip/cancel0. 신규10개는 Outlook/Teams 각각 정상·토큰 직후 철회·B SQL누락·연결 미준비·B 성공 후 G 직전 SQL누락을 검사한다. 정상 각각 실제 SQLite1행/Graph 합성2호출/G passed, 철회는 토큰1호출/Graph0/SQL0, 미준비는 호출0. G 직전 누락은 실행 성공 응답 뒤에도 최종 failed로 판정한다. 나머지는 기존 Microsoft/refresh/selected source/Core authority 회귀이며 중복 앞선58/45 재실행을 합산하지 않았다. build/Core contract gate 통과.',
'## 한계와 다음 작업',
'공급자 OAuth/Graph 응답은 합성이고 실행 Core/E/B/G·SQL는 실제 로컬 코드다. 실계정 연결/전체 본문·첨부·발송/증분 동기화/자동 예약/30일 실사용 미완료다. 이 prepared action task의 성공을 자유 자연어 전체 Mission 계약·계획 coverage·자료 위임·operation/effect 영속 연결·최종 결과 UI/새PID 복원 완료로 확대하지 않는다.',
'다음은 선택 연결 fresh 수집의 요구 계약과 quota 자료 scope, operation/effect receipt를 같은 Mission에 결속하고 정정·취소·재시작 반례를 검사하는 것이다. 연결 준비도 probe는 최소 권한 실계정이 제공된 뒤 별도 실증한다. 이번 증거는 V3-029/040/073의 부분 구현이며 공식 인수율은 올리지 않는다. F/cognition·개인 자료·기존 운영 서비스 변경0, 유료 호출0, 제품 p50/p95 및 실제 비용 미측정. 복원은 host의 microsoftCollectionAccess 활성화를 제거해 새 도구를 비활성화하며 이미 수집한 자료를 임의 삭제하지 않는다.'
].join('\n\n'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-final.txt','-configured.txt','-g-final.txt','-complete.txt','-verified.txt','-proof-final.txt','-diagnostic.txt','-oracle.txt','-final-current.txt','-build-current-final.txt','-contract-current-final.txt'].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'microsoft-collection-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'직접 수집을 host-owned capability로 연결하고 private provider proof 및 G의 현재 SQL 오라클을 필수로 요구하면 범위/권한 변경과 저장누락을 완료로 오인하지 않는다.',lesson:'등록된 verifier 함수만으로 G가 호출한다는 보장은 없다. B 정상 성공 뒤 SQL을 변조하는 반례와 G critical proof를 함께 검사해야 한다.',limitations:'prepared action task/CoreEBG·실SQL·Graph합성. 실계정/OAuth/probe/전체Mission자료위임/effect영속/UI/새PID 미완료. 비용·제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-029','V3-040','V3-073']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: Microsoft 직접 수집 prepared task CoreE/B/G/실SQL, G호출 누락 거짓완료 수정. 실계정/probe/전체Mission scope/effect/UI/재시작 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md','\n최신 '+prefix+'-report.md: Microsoft fresh 수집 prepared task/실SQL/G 변조반례 수정·'+passed+'검사/build/contract. 공식'+counts.verified+'/100 유지. 다음 bounded Mission 요구·quota 자료범위·영속 effect/결과 계약과 실제 연결 probe.\n');
console.log(JSON.stringify({counts,passed}));
