import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/mission-result-crash-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),write=(name,v)=>writeFileSync(`${prefix}-${name}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const log=read(`${prefix}-final.txt`),counts=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`ℹ ${key} (\\d+)`))?.[1])]));
assert.ok(counts.tests>=60);assert.equal(counts.pass,counts.tests);assert.equal(counts.fail,0);assert.equal(counts.skipped,0);
assert.match(log,/✔ actual Core\/E\/B\/G provider adapter runs outside SQLite transaction and permits an independent writer/u);
assert.match(log,/"phase":"before-actual-B","transactionOpen":false,"independentWriterCommitted":true/u);
const live=JSON.parse(read(`${prefix}-live.json`));assert.equal(live.passed,7);assert.equal(live.failed,0);
assert.deepEqual(live.cases.map(r=>r.point),['snapshot','settlement','effect','outbox','followup','lease','committed']);
for(const row of live.cases){const committed=row.point==='committed';assert.equal(row.actualHttpRequests,1);assert.equal(row.independentWriterCommitted,true);
 assert.equal(row.partialCommit,false);assert.equal(row.transactionOpenAtCrash,!committed);assert.equal(row.effectState,committed?'succeeded':'in_flight');
 assert.equal(row.reservationState,committed?'settled':'in_flight');assert.equal(row.actualMinor,committed?20:null);assert.equal(row.followupRows,committed?1:0);
 assert.equal(row.dispatchRows,committed?0:1);assert.equal(row.recoveryState,committed?'succeeded':'uncertain');assert.equal(row.replayedProviderRequests,0);
}
const files=['tests/mission-result-crash.test.js','tests/fixtures/mission-result-crash-observation.mjs','tests/fixtures/mission-result-crash-child.mjs','tests/fixtures/local-mission-effect-child.mjs','tests/mission-effect-coordinator.test.js','packages/core/src/mission/sqlite-mission-store.js'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,...counts,testFiles:4,resultCrashCases:7,actualIndependentHttp:true,actualCoreEBGFileAdapter:true,
 coreAdapterTransactionOpen:false,independentWriterCommitted:true,realProvider:false,realAccount:false,productionConfigurationChanged:false,actualCost:null,productLatencyPercentiles:null});
write('report.md',`# 공급자 I/O와 결과 정산의 transaction 경계\n\n관측 ${observedAt}. V3-039 원래 요구 “공급자 호출은 DB transaction 밖에서 실행하고 결과·예산 정산·후속 이벤트를 원자적으로 반영한다”를 검토했다.\n\n## 실행 증거\n\n기존 실제 Core/E/B/G 파일 adapter의 execute 직전/직후에 중앙 SQLite isTransaction=false를 관측했다. 호출 직전 같은 DB를 여는 독립 연결이 BEGIN IMMEDIATE/쓰기/COMMIT에 성공했다. 실제 파일1회·Effect succeeded·검증/기억후속 처리 완료를 대조했다. 실제 adapter를 성공응답 모의로 교체하지 않았고 관측 분기는 격리fixture에만 있다.\n\n별도 OS프로세스와 실제 loopback HTTP 시험 공급자로 준비→claim→dispatch검사→HTTP I/O→completeEffect를 실행했다. HTTP처리 중 부모프로세스도 같은DB 쓰기에 성공했다. 서버는 합성 제공자이며 이 실행을 실메일/은행/공식API 성공으로 계산하지 않는다.\n\n공급자 응답후 결과 snapshot/예산 settlement/Effect결과/outbox삭제/followup삽입/lease해제 여섯 실제SQLite trigger 지점에서 실행프로세스를 강제 종료했다. 모든 반례는 저장 전 READY/revision1·in_flight예약·actual금액null·receipt없음·dispatch1·followup0으로 복원됐다. 이미 공급자가 응답한 효과는 lease만료후 uncertain으로 대사대기를 유지하고 새workerclaim불가·요청1회를 확인했다. COMMIT 양성 대조는 COMPLETED/revision2·succeeded·정산20·영수증·dispatch0·followup1로 함께 남았다. 이 금액은 합성이며 실제 청구·환불 검증이 아니다.\n\n관련4파일 **${counts.pass}/${counts.tests}**,실패0·건너뜀0. 실제 종료/재시작·권한 철회·fencing·원래영수증/파일/G·기억후속 재시도 회귀를 포함한다. 신규7관측은 live.json,기존localAdapter 실제I/O 경계는 final.txt 진단행에 보존했다. 제품코드는 변경하지 않았고 검사/관측 경로를 추가했다.\n\n## 완료와 한계\n\n원래039의 SQL실행 경계와 원자적 결과 반영을 현재 지원된 로컬B 경로·범용SQL budget정산 경로에서 실제 관측해 verified로 판정했다. 원래100개 요구는 유지하며 공식54→55/100. 기존 file backend나 미구현/미연결 adapter가 이 계약을 자동 충족한다고 확대하지 않는다. 실제 외부 제공자의 결제금액/메일전송/계정/취소/환불 대사·모든 원격 adapter·클라우드/장치는 별도 인수다. 공급자 영수증만으로 G가 검증한 것으로 표시하지 않는다.\n\n운영서비스/설치본/개인기억/실계정 변경없음. 비용과 제품p50/p95는 미측정. SQL atomic 결과기록의 인수와 실제외부 계정 파일럿을 구분한다. 복원은 추가fixture분기와 신규test/runner만 검토하며 기존 uncertain재실행차단·fence·예산보호를 완화하지 않는다. 다음은 남은 effect식별/불명응답 대사와 각연결의 실제 준비 조건이다.\n`);
const evidencePaths=['report.md','verification.json','source.json','live.json','first.txt','final.txt'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'mission-result-crash-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'실제B 호출의 DB 상태/독립쓰기와 결과정산 여섯지점의 OS강제종료를 함께 관측하면 공급자I/O를 SQL transaction 밖에 두는 계약과 결과 원자성을 검증할 수 있다.',
 lesson:'공급자응답후 중간저장이 사라져도 이미발생한효과를 재호출하지 않는다. uncertain은 실패0·성공으로 숨길 상태가 아니며 대사가 필요하다.',
 limitations:'실제localB+합성HTTP공급자/금액/동일Windows. 공식제공자/실계정/실거래/모든adapter/전원단절 미검증. 비용·제품지연미측정.'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates);assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,54);
const gate=gates.find(g=>g.id==='V3-039');assert.equal(gate.status,'in_progress');assert.equal(gate.requirement,'공급자 호출은 DB transaction 밖에서 실행하고 결과·예산 정산·후속 이벤트를 원자적으로 반영한다.');
gate.reviewHistory??=[];gate.reviewHistory.push({previousStatus:gate.status,previousReviewedAt:gate.reviewedAt,reviewedAt:observedAt,reason:'실제Core/E/B/G I/O transaction 상태·독립쓰기와 결과저장6지점강제종료/정상commit을 관측. 실제제공자/모든adapter 인수와 분리.'});
gate.status='verified';gate.reviewedAt=observedAt;gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07 최신: actualB DB transaction밖/독립쓰기+합성HTTP 결과정산6지점강제종료/정상commit7관측·관련회귀통과로 원래039 SQL 경계 인수. 실계정/청구진위/모든adapter/전원단절은 별도 미완료.');
a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제Core/E/B/G I/O SQL밖/독립write·합성HTTP 결과정산6지점강제종료+commit7관측/${counts.pass}회귀. V3-039 verified·공식55/100. 실제공급자/계정/거래/전체adapter는 미완료.\n`);
console.log(JSON.stringify({verified:55,tests:counts.tests,acceptanceId:gate.id,observedAt}));
