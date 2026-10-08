import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/microsoft-collection-effects-20261008',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-regression.txt','utf8');
for(const text of ['ℹ pass 130','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0'])if(!final.includes(text))throw Error('REGRESSION_REQUIRED');
for(const [suffix,marker]of[['-build-release.txt','Built static JARVIS'],['-contract-release.txt','gatePassed: true']])if(!(await readFile(prefix+suffix,'utf8')).includes(marker))throw Error('GATE_REQUIRED');
const paths=['packages/core/src/personal-operations/microsoft-collection-effects.js','packages/core/src/personal-operations/microsoft-source-reader.js','packages/core/src/mission/sqlite-mission-store.js','apps/runtime-compose/src/microsoft-collection-access.js','apps/runtime-compose/src/microsoft-collection-capability-package.js','scripts/core-service-runtime.mjs','tests/microsoft-collection-effects.test.js','tests/fixtures/microsoft-effects-reopen.mjs','tests/microsoft-source-reader.test.js','tests/sqlite-mission-store.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
'# Microsoft 메타데이터 수집의 영속 SQL 영수증과 재호출 방지',observedAt,'공식 인수 '+JSON.stringify(counts)+'/100 유지.',
'## 구현과 실제 관측',
'실제 inbox와 같은 SQLite 연결에 operation ID·Mission ID·action/task ID·요구/권한 revision·정규화 인수를 묶은 수집 원장을 추가했다. 공급자 호출 전 in_flight를 claim하며, inbox 결과와 서명 영수증은 동일 트랜잭션에서 함께 commit한다. 서명 실패·권한 철회 때 결과 저장을 rollback한다. 완료 응답 손실 뒤 동일 operation은 현재 권한·서명·SQL 내용을 대조하고 공급자 토큰/Graph를 재호출하지 않는다. 서명 변조·현재 SQL 삭제·binding 정정은 복구 성공으로 표시하지 않는다.',
'in_flight/uncertain은 같은 자료의 새 operation도 보류한다. Core의 정상 실행 권위 취득·해제에도 이 원장의 미대사 상태를 검사한다. recovery-only 취득을 허용하지만 이는 자동 대사 해결이나 일반 실행 허가가 아니다. 아직 영수증 없는 uncertain을 사용자가 해결하는 UI/자동 대사 절차는 미구현이다.',
'운영 factory는 실제 host Mission action의 operation/dispatch/revision에서만 binding을 만든다. 모델 JSON의 주장이나 별도 준비 task만으로 영수증 권위를 만들지 않는다. 시험은 host가 넣은 합성 Mission context의 prepared task를 실제 Core/E/B/G와 보호된 runtime signer/SQLite로 실행했다. 자연어 전체 Mission 생성·최종 완료·새 Core의 자동 복원까지 성공했다는 뜻은 아니다.',
'## 재현 결함과 수정',
'새 factory 검사는 먼저 test mode의 보호키 부재를 드러냈다. 격리 root에서 일반 protected runtime을 사용한 뒤 SQL commit 중 중첩 BEGIN으로 정상 실행이 차단되는 결함을 재현했다. 공통 Core authority 검사는 host-owned 트랜잭션 안에서도 동일 fence·만료·clock 검사를 수행하도록 수정했다. 임시 수집 전용 authority 조건은 제거해 공통 검사 한 곳만 유지한다. outer rollback 뒤 시계 역전으로 만료 lease가 되살아나지 않도록 이미 관측한 최대 시각도 _now에 포함했다. 유효 lease/잘못된 token/만료/rollback/시계 역전 반례를 추가했다.',
'## 검증 범위',
'최종 130개 고유 검사 모두 통과, 실패·skip·cancel 0; build/Core contract gate 통과. Microsoft 두 공급자 각각 8조건(정상·commit 뒤 응답 손실·서명 실패·공급자 실패·철회·서명 변조·SQL 변조·binding 변경)을 검사했다. 네 별도 실제 PID가 저장된 SQLite 서명 증거와 현재 결과를 읽어 검증했으며 추가 공급자 호출 0이었다. 이 자식 프로세스는 전체 Core 복원/실계정이 아니다. 나머지는 Microsoft 기존 검증과 Mission SQLite·Core authority·worker·multi-device·자료 위임 회귀다. 이전 검사 숫자를 더하지 않는다. 최종 전체 검사 시간 29.6초는 제품 p50/p95가 아니다.',
'OAuth/Graph 응답과 계정 준비 관측은 합성이다. 실계정/API 유료 호출·메일 발송 0. 실제 비용·제품 지연 미측정. 기본 F/cognition·개인 자료·실제 credential vault를 변경하지 않았다. 문서/UI/운영 설치본에 모든 기능이 활성화됐다는 결론은 아니다.',
'## 연구 확인과 다음 작업',
'research:watch → ledger sync → status 순서 실행: 6출처 중 raw hash 변화3, unchanged3, 오류0, 후보54. 변경은 모두 OpenAI 문서이며 공식 원문을 다시 조회했다. 변화만으로 새 출시/기술 채택/진행률을 올리지 않았다. 현재 결함은 추가 외부 실행 환경보다 로컬 SQL 증거와 authority 경계의 연결이 우선이었다. Node24.8의 database.isTransaction 지원을 공식 문서에서 확인했다: https://nodejs.org/download/release/v24.8.0/docs/api/sqlite.html#databaseistransaction .',
'다음은 bounded 자연어 Mission 요구 계약→operation→현재 요구별 결과→새 Core 재시작 대사까지 연결하고 unresolved 상태의 복구 경로를 구현하는 것이다. 실계정 OAuth·현재 probe·본문/첨부·발송·30일 실사용은 별도 준비/검증이 필요하다. 인수 항목 증거만 추가하며 상태는 유지한다. 복원은 해당 도구 활성화를 중지하고 코드 계약을 함께 복원하되 저장된 자료/원장을 삭제하거나 unresolved를 committed로 강제 변경하지 않는다.'
].join('\n\n'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-regression.txt','-configured-protected.txt','-configured-fixed.txt','-build-release.txt','-contract-release.txt','-watch.txt','-sync.txt'].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'microsoft-collection-effects-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'동일 SQL 트랜잭션의 서명 commit 증거와 현재 operation/권한을 대사하면 응답 손실 후 수집 재호출 및 허위 복구를 차단할 수 있다.',lesson:'수집 성공 응답과 영속 commit은 다르며 authority 검사는 원장 트랜잭션과 결합되어도 같은 fencing을 유지해야 한다.',limitations:'130회귀/실제SQL/별도PID4/운영factory합성Mission preparedtask. Graph합성,전체자연어Mission/새Core자동복구/실계정/운영설치/UI/영수증없는uncertain해결 미완료. 비용·제품p50/p95 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-032','V3-033','V3-040','V3-073']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: Microsoft operation绑定 영속SQL서명·응답손실대사·별도PID4·130회귀. 전체자연어Mission/새Core자동복구/실계정/미영수증uncertain해결 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md','\n최신 '+prefix+'-report.md: operation-bound Microsoft SQL atomic receipt/replay·authority 중첩 transaction/rollback clock 수정·130검사/build/contract. 공식 '+counts.verified+'/100 유지. 다음 bounded 자연어Mission/현재 최종 결과/새Core 복원 및 unresolved 복구.\n');
console.log(JSON.stringify({counts,passed:130}));
