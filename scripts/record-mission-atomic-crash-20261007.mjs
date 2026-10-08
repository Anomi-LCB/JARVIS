import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix='artifacts/mission-atomic-crash-20261007',observedAt=new Date().toISOString();
const read=path=>readFileSync(path,'utf8').replace(/^\uFEFF/u,'');
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const log=read(`${prefix}-final.txt`);
for(const [key,value] of [['tests',90],['pass',90],['fail',0],['skipped',0]])assert.equal(Number(log.match(new RegExp(`ℹ ${key} (\\d+)`))?.[1]),value);
const live=JSON.parse(read(`${prefix}-live.json`));assert.equal(live.passed,5);assert.equal(live.failed,0);
assert.deepEqual(live.cases.map(row=>row.point),['snapshot','reservation','effect','outbox','committed']);
for(const row of live.cases){assert.equal(row.platform,'win32');assert.equal(row.journalMode,'wal');assert.equal(row.partialCommit,false);
 const committed=row.point==='committed';assert.equal(row.transactionOpenAtCrash,!committed);assert.equal(row.reopenedRevision,committed?1:0);
 assert.deepEqual(Object.values(row.counts),[committed?1:0,committed?1:0,committed?1:0]);assert.equal(row.heldMinor,committed?30:0);
 assert.equal(row.actualSupplierCalled,false);if(committed)assert.equal(row.exitCode,0);else assert.notEqual(row.exitCode,0);
}
write('source.json',{observedAt,files:['tests/mission-atomic-crash.test.js','tests/fixtures/mission-atomic-crash-observation.mjs','tests/fixtures/mission-atomic-crash-child.mjs','scripts/observe-mission-atomic-crash-20261007.mjs','packages/core/src/mission/sqlite-mission-store.js','packages/core/src/mission/mission-effect-coordinator.js'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:90,passed:90,failed:0,skipped:0,testFiles:7,crashObservation:`${prefix}-live.json`,newCrashCases:5,
 actualChildProcesses:true,actualSqliteRecovery:true,sqliteWal:true,originalStageRequirementVerified:true,productionBackendChanged:false,
 providerSettlementVerified:false,realFinancialTransactions:false,powerLossTest:false,actualCost:null,productLatencyPercentiles:null});
write('report.md',`# Mission 의도·위임·예산·dispatch 원자적 저장 인수\n\n관측 ${observedAt}. V3-038의 원래 요구는 “실행 의도·위임 revision·예산 예약·dispatch outbox를 원자적으로 저장한다”다. 다른 adapter의 현장 권한/결제 성공이나 공급자 결과 정산039의 완료를 이 항목에 합치지 않는다.\n\n## 실제 저장 경계 검사\n\n기존 PersonalOperationsStore와 SqliteMissionStore는 동일 SQLite 연결의 BEGIN IMMEDIATE에서 Mission snapshot→위임/current revision→예약 savepoint→Effect intent→dispatch outbox를 기록하고 한 번 COMMIT한다. 현재 계정/자료/revision·요청/예약 scope 결속,동일 intent replay,예약 quota도 기존 코드를 재사용한다. 제품 저장 코드를 시험용 가짜 구현으로 교체하지 않았다.\n\n별도 Node 프로세스의 실제 SQLite TEMP trigger가 snapshot update/예산 reservation insert/Effect insert/outbox insert 각각 직후에 실행 프로세스 자신을 강제 종료했다. marker의 PID·transactionOpen=true와 종료를 확인한 뒤 새 SQLite 연결을 열었다. 네 반례 모두 snapshot revision0/빈Mission·Effect0·outbox0·reservation0·held금액0/호출0이었다. COMMIT까지 실행한 양성 대조는 revision1·3표각1·금액30·동일 operation/idempotency·요청의 위임revision·위임해시·예약ID와 reserved 상태가 함께 존재한다. JSON 관측과 고정 기대값을 대조했으며 파일 해시를 원자성 증거로 쓰지 않는다.\n\n실제5과정은 live.json. 관련7파일 **90/90**,실패0·건너뜀0. 이전 실제 quota 저장경계 종료/원장 revision 충돌/예산 scope/철회·만료·시계역행/두worker 경합/실제Core/E/B/G 로컬파일/응답유실/기억후속복구 회귀를 함께 실행했다. 첫5검사 중 정상만 통과했고 나머지는 harness가 “없는 Effect” API의 오류 계약을 null로 기대해 실패했다. 제품의 A_DURABLE_EFFECT_MISSING 계약을 직접 assert하도록 수정해 전후 로그를 보존했다.\n\n## 인수 판단과 한계\n\n원래038의 저장 단위는 실제 SQL 코드·정상/실패·별도 프로세스 종료·재열기·기존 Mission 통합으로 충족해 verified로 판정한다. 이 판단은 SQLite backend 경로에 한정하며 기존 file backend를 같은 원자성으로 표시하지 않는다. 운영 DB/설정/계정/서비스/개인 기억은 바꾸지 않았고 상시노드 이전이나 기존 설치본 활성화를 주장하지 않는다. 합성 위임/계정/금액을 사용했으며 실제 공급자/메일/결제/실기기/전원단절/fsync 장치 고장 검증이 아니다. 모든 adapter의 실제 권한 dispatch 경계는029/032,공급자 I/O/결과정산은039,응답불명 대사는041의 미완료 조건으로 유지한다.\n\n신규 구현은 반복 가능한 crash harness이고 현재 제품 저장 구현은 변경하지 않았다. 전체인수53→54/100. 기존100개 요구/분모를 보존한다. 실제 비용·제품p50/p95는 미측정이며 회귀총시간은 제품 지연이 아니다. 복원은 추가 fixture/test/관측 runner만 제거할 수 있고 공유 DB/원장·기억은 삭제하지 않는다. 다음은039의 공급자 I/O transaction 경계와 결과/정산/후속 이벤트 복구를 실제로 확인하는 작업이다.\n`);
const evidencePaths=['report.md','verification.json','source.json','live.json','first.txt','final.txt'].map(name=>`${prefix}-${name}`);
write('attempt.json',{id:'mission-atomic-crash-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'동일 SQLite 저장 transaction의 네 개 기록 지점에서 OS프로세스를 종료하면 의도·위임revision·예산예약·dispatchoutbox의 부분commit 여부를 실제로 검증할 수 있다.',
 lesson:'함수 예외 rollback과 실제프로세스 종료복구는 다르며 정상commit 대조와 누락Effect 오류 계약도 확인해야 한다.',
 limitations:'SQLite backend·동일Windows호스트·합성금액/위임. 실공급자/전원단절/결과정산039/모든adapter권한 미검증. 운영설정 변경 없음.'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates);
assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,53);
const gate=gates.find(g=>g.id==='V3-038');assert.equal(gate.status,'in_progress');assert.equal(gate.requirement,'실행 의도·위임 revision·예산 예약·dispatch outbox를 원자적으로 저장한다.');
gate.reviewHistory??=[];gate.reviewHistory.push({previousStatus:gate.status,previousReviewedAt:gate.reviewedAt,reviewedAt:observedAt,reason:'원래038 SQL 원자적 저장 조건을 실제4중간지점 강제종료+정상commit+재열기/기존Mission 통합90회귀로 검토. 공급자정산039/각adapter권한029/032는 승격하지 않음.'});
gate.status='verified';gate.reviewedAt=observedAt;gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07 최신: SQL 저장4지점 실제Node강제종료→재열기 부분0/정상commit 모두1·90통과로 원래038 인수. filebackend·운영이전·전원단절/실계정/결과정산039·모든adapter권한은 별도 미완료.');
a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: SQL intent/위임revision/예산/dispatch 네 저장지점 실제프로세스강제종료+정상commit5관측/90회귀. V3-038 verified·공식54/100. SQLitebackend만; 공급자I/O/결과정산039·모든adapter권한은 미완료. 다음039 종단 경계와정산복구.\n`);
console.log(JSON.stringify({verified:54,acceptanceId:gate.id,observedAt}));
