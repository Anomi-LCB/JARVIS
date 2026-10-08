import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/durable-budget-scope-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=x=>createHash('sha256').update(x).digest('hex');
const counts=path=>{const log=read(path),get=k=>Number(log.match(new RegExp(`(?:ℹ |# )${k} (\\d+)`))?.[1]);return {tests:get('tests'),passed:get('pass'),failed:get('fail'),skipped:get('skipped')};};
const focused=counts(`${prefix}-focused.txt`),recheck=counts(`${prefix}-recheck.txt`);
assert.equal(focused.tests,56);for(const r of [focused,recheck]){assert.ok(r.tests>=30);assert.equal(r.passed+r.skipped,r.tests);assert.equal(r.failed,0);}
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/u);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/u);
const files=['packages/core/src/mission/sqlite-mission-store.js','tests/durable-budget-scope-binding.test.js','docs/durable-budget-scope-binding.md'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-verification.json`,JSON.stringify({observedAt,focused,recheck,focusedFiles:6,recheckFiles:5,actualSqlite:true,actualCoreEBGRegression:true,syntheticAmounts:true,realPayment:false,externalServiceCalls:0,actualCost:null,latencyPercentiles:null,verified:51},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 예산 예약과 실행 의도의 계정·자료·위임 버전 일치\n\n관측 ${observedAt}. 공식 인수 **51/100 유지**.\n\n원장의 예산 바인딩은 행동/대상/통화/금액만 대조해 accountRef/dataRefs/mandateRevision이 다른 실제 실행 의도를 저장했다. 신규8시험 중 정상1개는 통과하고7개가 실패했다. 6개는 잘못된 범위의 효과 저장을 허용했고, scope-added는 이미 예산 규칙에서 차단되지만 더 늦은/다른 오류였다.\n\n이제 명시 범위를 정규화해 accountRef/dataRefs/mandateRevision 값과 존재 여부를 같게 요구한다. 자료 순서는 정규화해 비교하고 원래 실행 의도/요청해시는 보존한다. 달라진 범위는 Mission snapshot/예산예약/effect/outbox 동일 transaction 안에서 거부하여 부분 예약과 실행 대기열0을 확인했다. 동일한 정상 요청은30 예약→20 합성 정산→재저장에서도1회만 소비하며 이후 계정 정정은 effect conflict로 거부한다.\n\n집중6파일 **${focused.passed}/${focused.tests}**, 공유 실행 경로5파일 **${recheck.passed}/${recheck.tests}**, 실패0. 집중 미실행0, 공유 회귀의 Linux 전용 OS 격리13건은 Windows에서 미실행. 두 검사에는 겹친 파일이 있어 합산 고유시험수로 표현하지 않는다. 실제 SQLite·Core/E/B/G 로컬 파일·프로세스 종료/경합·원격 HTTP·기억 실패 복구 회귀이며 실제 외부 계정과 결제가 아니다. build/contract 통과.\n\n이 persistence 계층은 명시된 구조화 범위를 연결한다. 중첩 adapter 인자에서 실제계정/자료를 추측하거나 모든 제공자의 청구/영수증을 검증하지 않는다. 전체 monetary dispatch/개인정보egress/실계정은 남아032/038/039를 완료로 올리지 않는다. 실제비용/p50/p95 미측정. 운영서비스/설치본/사용자자료·계정·기억 변경 없음. 복원은 범위 대조와 새시험·문서만 검토하고 원장을 삭제하지 않는다.\n`,{flag:'wx'});
const evidencePaths=['report.md','verification.json','source.json','before.txt','focused.txt','recheck.txt','build.txt','contract.txt'].map(x=>`${prefix}-${x}`);
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'durable-budget-scope-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'금액뿐 아니라 계정·자료·위임revision을 같은 영속 예산 계약에 묶으면 다른 scope의 효과가 허용된 예약을 재사용하는 것을 막을 수 있다.',lesson:'같은 금액과 행동이라도 계정/자료/위임revision이 다르면 같은 실행 의도가 아니다. 범위의 누락도 권한 상속으로 취급해서는 안 된다.',limitations:`합성금액 실제SQLite·${focused.passed}/${focused.tests}+${recheck.passed}/${recheck.tests} 회귀(겹침있음). 실제계정/결제/모든adapter binding 미완료, 공식51유지.`},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates);
assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,51);
for(const id of ['V3-032','V3-038','V3-039']){const g=gates.find(g=>g.id===id);assert.equal(g.status,'in_progress');g.evidence.push(...evidencePaths.slice(0,3));g.reviewedAt=observedAt;g.limitations.push(`2026-10-07 effect/예산 account/data/revision 대조·잘못된범위 부분예약0·${focused.passed}/${focused.tests}+${recheck.passed}/${recheck.tests}(겹침)/build/contract. 실제계정/결제/모든adapter binding 미완료.`);}
a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 영속금액/계정/자료/위임revision 바인딩·잘못된예약0·공식51유지. 실제계정/모든adapter binding 남음.\n`);
console.log(JSON.stringify({verified:51,focused,recheck,observedAt}));

