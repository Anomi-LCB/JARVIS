import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/microsoft-mission-restart-20261008',observedAt=new Date().toISOString();
for(const [suffix,markers]of[['-verified.txt',['ℹ pass 190','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0']],['-build-final.txt',['Built static JARVIS']],['-contract-final.txt',['gatePassed: true']]]){
 const log=await readFile(prefix+suffix,'utf8');for(const marker of markers)if(!log.includes(marker))throw Error('EVIDENCE_REQUIRED:'+marker);
}
const paths=['packages/core/src/mission/microsoft-collection-task-receipts.js','packages/core/src/mission/mission-runtime.js','apps/runtime-compose/src/microsoft-collection-access.js','scripts/core-service-runtime.mjs','packages/core/src/main.mjs','tests/microsoft-mission-restart.test.js','tests/fixtures/microsoft-mission-core-restart.mjs','docs/microsoft-collection-mission.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
'# Microsoft 수집의 새 Core 프로세스 결과 회수',observedAt,'공식 '+JSON.stringify(counts)+'/100 유지.',
'## 구현',
'Microsoft 수집의 성공 action, 실제 task/G 검증, 현재 signed SQL commit을 대조한 뒤 별도 task receipt를 서명해 보존한다. 서명 body는 원문/요구/권한/선택 연결/dispatch의 결속 해시, task/action/observation/evidence/verification ID, 정규화 선택 인수와 결과 해시다. 메타데이터 문구·OAuth secret·refresh token은 새 historical task archive에 복제하지 않는다. 기존 inbox와 operation SQL receipt는 유지한다.',
'새 Core의 trusted task가 없으면 서명된 당시 G 증거를 통해 historicalAuthenticatedProof task를 구성한다. 이는 G를 새로 실행했다는 뜻이 아니다. 현재 보호키 purpose, 원래 Mission goal/operation/auth revision, observation과 signed effect/현재 SQL 결과를 다시 검사한다. 이전 owner 세션을 계승하지 않으며, 새 current owner read 권한과 COMPLETED Mission 조건을 만족하기 전에는 복구 결과를 materialize하지 않는다.',
'ADMIN 인증된 POST /missions/:missionId/verified-microsoft-collection에 정확히 ownerSessionId 하나만 받는 현재 읽기 인계를 추가했다. JSON/바이트 상한/범위 제한, 조회 전후 ADMIN 검사, no-store를 유지한다. old session·현재 연결 미준비·정정/철회·증거 누락 때 receipt를 공개하지 않는다. 회수는 재수집·발송·새 승인 실행이 아니다. 사용 안내는 docs/microsoft-collection-mission.md다.',
'## 실제 검증과 실패',
'최종190개 고유 검사 통과, 실패/skip/cancel0. build/Core contract gate 통과. 이 중 새26조건은 Outlook·Teams 각각13가지: 정상, 연결철회, 현재SQL삭제, task서명변조, taskarchive없음, operation서명변조, 원문정정, authrevision정정, verificationID정정, 중복task/action, 새owner철회, 과거owner재사용, 현재connectionmissing. 각 조건은 실제 Core 생성 프로세스와 종료 뒤 새 Core 복구 프로세스를 별도로 실행했다. 총52회 Core child launch, 각 create/recover PID가 다르고 parent와도 다름을 검사했다. SQLite 권위 token0→1 명시 전환과 DPAPI 보호 runtime key의 동일 root 재사용이다. 실제 SCM·서비스 계정·재부팅·강제 kill 시험은 아니다.',
'각 생성은 bounded 한국어 전체 Mission/합성 소유자 gate 승인/실제 CoreE/B/G/SQL/서명archive를 거쳐 COMPLETED, token+Graph합성2호출이었다. 새 Core에는 original task가 없으며 현재 원문과 archive를 대사했다. 정상2조건은 verified, 나머지24조건은 unverified/result없음. 무인증POST401, 잘못된 추가 인수400, 인증POST/no-store/current result 회수를 실제 localhost HTTP에서 확인했다. 모든 복구의 추가 OAuth/Graph 호출0. 공급자 요청은 fetch fixture이며 실제 계정 연결·실API·메일 발송이 아니다. 이전130/164/188검사를190에 더하지 않는다.',
'최초 fixture는 없는 task를 null로만 예상했으나 getTask가 undefined를 반환해 실패했다. 또 미준비 accountStatus에 지원하지 않는 disconnected 값을 넣어 초기190검사 중188통과/2실패였다. nullish 판정과 공식 registry 상태 missing으로 시험을 수정해 두 반례 및 전체를 재실행했다. 제품 권한이나 실패 오라클을 완화하지 않았다. 해당 before/final 로그를 보존한다.',
'## 인수 경계와 다음 작업',
'전체40개 미완료 인수의 상태를 확인했으며 이번 증거만으로 실계정·설치·장기 관측 항목을 승격하지 않았다. 공식60/100이다. 현재 제품UI의 독립 연결/수집/현재 읽기 인계, 설치 후보 및 실제 계정 OAuth/probe/운영계정/장기관측이 남아 있다. 영수증 없는 in_flight/uncertain의 운영 대사 해결 경로도 아직 미구현이다. 다음은 실제 연결 준비 조건과 UI를 연결하고 operation uncertainty 복구를 검증하는 것이다.',
'실제 유료API/외부 발송0, 비용·제품p50/p95 미측정. 실제 사용자 F/cognition·vault·프로필은 변경하지 않았다. 원장 snapshot 무결성을 독립 내용 검증이나 제품 활성화로 계산하지 않는다. 복원은 Microsoft 수집 Mission/결과 API 활성화를 중지하고 관련 계약을 함께 검토하며 기존 archive/operation/inbox를 삭제하거나 uncertain을 완료로 강제 바꾸지 않는다.'
].join('\n\n'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-regression.txt','-readiness-fixed.txt','-verified.txt','-build-final.txt','-contract-final.txt'].map(s=>prefix+s).concat('docs/microsoft-collection-mission.md');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'microsoft-mission-restart-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'현재 owner 읽기 인계와 signed historical G/operation/SQL 대사를 연결하면 새 Core 프로세스에서도 공급자 재호출 없이 검증된 결과를 회수할 수 있다.',lesson:'원래 task가 없는 재시작은 옛 세션을 부활시키지 않아야 하며, 서명된 과거 G 기록과 현재 저장 상태 검사는 별도의 증거다.',limitations:'190회귀/26재시작조건/52Core child launches/실SQLite DPAPI/localhostHTTP. OAuthGraph합성,실계정/SCM/serviceaccount/reboot/강제kill/UI/운영설치/미영수증uncertain해결/장기관측 미완료. 실제비용·제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-032','V3-033','V3-040','V3-073']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: Microsoft signed G task archive/새Core 현재owner읽기회수·OutlookTeams26조건/52launch/190회귀·build/contract. 실계정/SCM/UI/운영설치/미영수증uncertain해결 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md','\n최신 '+prefix+'-report.md: Microsoft signed G archive/새Core current owner result 회수·26조건/52launch/190검사/build/contract. 공식 '+counts.verified+'/100 유지. 다음 UI/실제 연결 준비/설치와 미영수증 uncertain 운영 대사.\n');
console.log(JSON.stringify({counts,passed:190}));
