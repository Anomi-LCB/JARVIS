import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/durable-budget-dispatch-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=x=>createHash('sha256').update(x).digest('hex');
const log=read(`${prefix}-recheck.txt`),count=k=>Number(log.match(new RegExp(`(?:ℹ |# )${k} (\\d+)`))?.[1]);
assert.equal(count('tests'),63);assert.equal(count('pass'),63);assert.equal(count('fail'),0);assert.equal(count('skipped'),0);
assert.match(log,/separate OS worker observes monetary mandate revocation after claim: true/u);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/u);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/u);
const files=['packages/core/src/mission/sqlite-mission-store.js','tests/durable-budget-dispatch-currentness.test.js','tests/fixtures/sqlite-mission-worker.mjs','docs/durable-budget-scope-binding.md'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-verification.json`,JSON.stringify({observedAt,tests:63,passed:63,failed:0,skipped:0,testFiles:7,actualChildProcess:true,actualLocalFile:true,actualSqlite:true,syntheticAmounts:true,realPayment:false,externalServiceCalls:0,actualCost:null,latencyPercentiles:null,verified:51},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# claim 이후 금액 위임의 실행 직전 재검사\n\n관측 ${observedAt}. 공식 인수 **51/100 유지**.\n\n기존 claimEffect는 위임과 예약을 확인했지만 assertEffectDispatch는 per-effect 금액 위임을 다시 확인하지 않았다. 작업을 맡은 뒤 위임이 철회/만료되거나 예산 예약을 이미 정산해도 같은 lease/request hash로 dispatch가 허용됐다. 최초5시험 중 정상1개 통과,4반례 실패를 보존했다.\n\n이제 dispatch guard가 위임 해시·예약mandate ID/in_flight 상태와 현재 위임을 확인한다. 위임 평가는 영속 단조 시각을 사용한다. 만료를 관측한 검사에서 오류가 나도 단조 시각은 business rollback과 별도로 보존해 시계 역행·새 원장 인스턴스 뒤에도 권한을 되살리지 않는다. 거부한 in-flight 예약은 임의로 해제/0정산하지 않는다. 실제 실행 뒤 철회된 위임의 영수증과 합성 금액 정산은 계속 기록하여 이미 일어난 효과를 숨기지 않는다.\n\n별도 OS worker가 실제 SQLite에서 claim한 뒤 부모 프로세스가 위임을 철회하는 반례와 정상 양성 대조를 실행했다. 정상 파일1개, 철회 파일0개 및30원 합성 예약 유지. 최종 실제7파일 **63/63, 실패0·미실행0**. 기존 원장 atomic rollback·fencing·프로세스 종료·예산 scope·Mission quota·Core/E/B/G 로컬 실행 회귀 포함. build/contract 통과.\n\n실제 공급자/결제/계정이 아니다. 실제 외부효과 직전 각 adapter가 이 guard를 호출하는 전체 연결은 남아 있다. guard 반환과 OS/원격효과 사이의 완전 원자적 철회는 주장하지 않는다. 금액은 시험 값이고 실제 비용/제품p50/p95는 미측정이다. 운영서비스/설치본/사용자 자료·계정·기억 변경 없음. 복원은 guard·새시험/fixture분기·문서/원장증거 연결만 대상으로 검토한다.\n`,{flag:'wx'});
const evidencePaths=['report.md','verification.json','source.json','before.txt','focused.txt','recheck.txt','build.txt','contract.txt'].map(x=>`${prefix}-${x}`);
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'durable-budget-dispatch-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'claim 이후에도 금액 위임과 예약을 단조 시각으로 재평가하면 철회/만료/선행정산된 권한으로 새 효과를 실행하는 것을 막을 수 있다.',lesson:'작업 소유권 lease는 금액 위임의 유효성을 대체하지 않는다. 새로운 dispatch와 이미 발생한 효과의 정산을 구분해야 한다.',limitations:'실제별도PID/SQLite/파일·63통과. 합성금액이며 실제계정/결제/모든adapter binding·OS원자철회 미완료. 공식51유지.'},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates);
assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,51);
for(const id of ['V3-029','V3-032','V3-038','V3-039']){const g=gates.find(g=>g.id===id);assert.equal(g.status,'in_progress');g.evidence.push(...evidencePaths.slice(0,3));g.reviewedAt=observedAt;g.limitations.push('2026-10-07 claim 이후 금액 위임 만료/철회/선행정산 dispatch 차단·단조시계/재열기·별도OSworker 정상파일1/철회0·63/63/build/contract. 실제계정/모든adapter/OS원자철회 미완료.');}
a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: claim이후 금액위임 재검사·별도OSworker·63통과·공식51유지. 실제계정/모든adapter binding 남음.\n`);
console.log(JSON.stringify({verified:51,tests:63,observedAt}));

