import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/microsoft-mission-20261008',observedAt=new Date().toISOString();
for(const [suffix,markers]of[['-verified.txt',['ℹ pass 164','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0']],['-build-final.txt',['Built static JARVIS']],['-contract-final.txt',['gatePassed: true']]]){
 const log=await readFile(prefix+suffix,'utf8');for(const marker of markers)if(!log.includes(marker))throw Error('EVIDENCE_REQUIRED:'+marker);
}
const paths=['packages/core/src/mission/microsoft-collection-result.js','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/mission-requirement-coverage.js','apps/runtime-compose/src/microsoft-collection-access.js','apps/runtime-compose/src/create-runtime.js','packages/core/src/main.mjs','tests/microsoft-source-reader.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
'# Microsoft 한 페이지 수집의 자연어 Mission와 현재 최종 결과',observedAt,'공식 '+JSON.stringify(counts)+'/100 유지.',
'## 이번에 연결한 실제 동작',
'선택한 Microsoft 연결의 메타데이터를 한 페이지 수집해. 라는 제한된 한국어 요청과 host-selected provider/connection/chat/cursor를 원문 digest에 묶는다. 선택 정보는 credential이 아니며 OAuth secret을 Mission에 넣지 않는다. 기존 Mission 생성/operation/요구 coverage/승인/E/B/G/원장을 거쳐 동일 Mission이 COMPLETED까지 진행한다. 전체 목록·메일 발송·조건 추가를 생략해 부분 실행하지 않는다. 호출자가 추가한 다른 criterion/constraint도 해당 수집 경로에서 보류한다. 이 문법의 성공은 범용 자연어 성공이 아니다.',
'최종 criterion은 실제 succeeded action·operation dispatch·원문/권한 revision·COMPLETED trusted task·observation/evidence/verification ID·필수 Microsoft G check를 결합한다. 현재 계정 정책과 원래 owner session의 읽기 권한을 다시 확인하고, 실제 SQL signed commit 영수증을 다시 읽어 task receipt와 대조한다. 현재 SQL 결과가 바뀌거나 권한이 철회되면 최종 결과를 공개하지 않는다. 한 페이지 결과이며 allPages:false로 표시한다.',
'ADMIN 인증된 GET /missions/:missionId/verified-microsoft-collection을 추가했다. 인증을 조회 전후 재검사하고 no-store를 유지한다. unverified 응답에는 result/receipt를 넣지 않는다. OpenAPI에 같은 범위와 준비 조건을 명시했다. 일반 UI에 새 연결/수집 화면을 추가하거나 운영 설치본을 교체한 작업은 아니다.',
'## 재현·수정과 검증',
'첫 실행 WAITING_APPROVAL은 기존 로컬 수집의 비가역 효과 정책이 정상 작동한 결과다. 시험에서 합성 소유자가 해당 gate를 승인한 뒤 진행했다. 권한 정책을 약화하거나 시험 승인을 실제 사용자 승인으로 취급하지 않았다. 이후 실제 수집/G는 성공했지만 현재 결과 읽기에 irreversible_commit 실행 grant를 요구해 최종 Mission이 PAUSED되는 오류를 재현했다. 결과 대사는 새 실행이 아니므로 현재 읽기 grant를 요구하고, 계정 정책·원래 작업 범위·signed effect/SQL 검사를 그대로 유지했다. 실패 이유도 transient planner error로 감추지 않고 microsoft-collection-current-result-unavailable로 반환한다.',
'최종164개 고유 검사 통과, 실패/skip/cancel0; build/Core contract gate 통과. 이 중 새 configured Core 전체 Mission9조건: 정상, OAuth 철회, 원문 변경, auth revision 변경, receipt 변조, G 실패, 다른 action 삽입, owner session 철회, cancelled. 실제 보호키/SQLite/Core/E/B/G/Mission으로 실행했으며 OAuth/Graph는 합성 응답이다. 각 정상 초기 결과는 한 페이지 현재 영수증으로 확인되고 token+Graph2호출이었다. 최종 상태 변조와 SQL 삭제는 result 없이 unverified. 실제 localhost HTTP의 무인증401·인증200/no-store·변조 후 미공개도 확인했다. 추가 criterion은 새 외부 호출0/새 action0/PAUSED. 이전118/130/162검사를164에 합산하지 않는다.',
'## 준비 조건·남은 작업·복원',
'새 Core 재시작 뒤 trusted task/검증/owner authorization을 영속 archive와 연결하는 경로는 아직 없다. 이전 턴의 별도 PID signed SQL recovery는 전체 Mission 최종 결과 복원을 증명하지 않는다. 다음은 이 연결과 현재 읽기 인계를 추가하고 missing task/expiry/revocation/receipt mismatch 반례를 검증하는 것이다. 공급자 실계정 probe, Teams 전체 Mission 실증, cursor 다음 페이지 전체조회, 본문·첨부·발송, UI, 운영 패키지, 장기 관측은 미완료다.',
'공식 인수는60/100이다. 위 추가 증거는 부분 진척이며 전체 자연어 제어·90% 목표 달성·제품 활성화로 승격하지 않는다. 유료 실API 호출/외부 발송0, 실제 비용·제품p50/p95 미측정. F/cognition의 실제 업무 기억·실제 vault는 수정하지 않았다. 복원은 Microsoft 수집 Mission 등록을 중지하고 계약/coverage/결과 API를 함께 검토하며 기존 원장/자료는 삭제하지 않는다.'
].join('\n\n'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-approved.txt','-read-authorized.txt','-http.txt','-verified.txt','-build-final.txt','-contract-final.txt'].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'microsoft-mission-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'선택 계정과 원문을 고정한 수집 Mission의 최종 결과를 현재 signed SQL/G/task와 대조하면 부분 요구 누락 및 오래된 수집 완료 표시를 막을 수 있다.',lesson:'실행 승인과 저장 결과의 현재 읽기 권한은 서로 다른 계약이다. 현재 읽기를 새 비가역 실행으로 분류하면 정상 최종 완료가 막히지만 실행 권한 자체를 완화해서는 안 된다.',limitations:'164회귀/실제SQLite protected key/CoreEBG Mission/localhostHTTP. OAuthGraph합성,원래owner 세션. 새Core archive 복원/실계정/Teams 전체Mission/UI/운영설치/장기관측 미완료. 실제비용·제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-032','V3-033','V3-040','V3-073']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: Microsoft bounded 자연어 fullMission/현재signedSQL G criterion/API·164회귀. 새Core task archive/실계정/TeamsMission/UI/운영설치 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md','\n최신 '+prefix+'-report.md: bounded Microsoft 자연어 fullMission/현재signedSQL G criterion/인증 result API·164검사/build/contract. 공식 '+counts.verified+'/100 유지. 다음 새Core archive/owner 읽기 인계와 복원 반례·TeamsMission·실계정/UI.\n');
console.log(JSON.stringify({counts,passed:164}));
