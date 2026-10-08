import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/workflow-default-20261007';
const read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-runner.json`),log=read(`${prefix}-final.txt`);
assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
for(const [key,count]of [['tests',69],['pass',69],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const independent=json(`${prefix}-independent.json`),acceptanceReview=json(`${prefix}-acceptance.json`);
const comparison=json('artifacts/recovery-comparison/workflow-default-20261007.json');
const observedAt=new Date().toISOString();
const paths=['packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js',
 'tests/fixtures/workflow-cognition-process-child.mjs','tests/mission-workflow-effect-process.test.js'];
write('source.json',{observedAt,files:paths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;assert.equal(verified,60);
write('verification.json',{observedAt,tests:69,passed:69,failed:0,skipped:0,durationMs:runner.durationMs,
 defaultWorkflowEffectsEnabled:true,productionActivated:false,countQuotaRecovery:true,perEffectMonetaryRecovery:false,
 independentReview:independent.reviewVersion,acceptanceReview,
 comparisonDecision:comparison.comparison.decision,actualCost:null,externalProviderCalls:0,officialVerified:verified});
write('report.md',`# 로컬 복합 작업의 기본 실행·기억 문맥·횟수 예산 검증
관측 ${observedAt}. 공식 인수 ${verified}/100. 이번에는 SQLite와 신뢰된 로컬 실행기에서 지원하는 단일 workflow의 effect 기록을 소스 기본값으로 켰다. 운영 Core/PC 서비스나 설치 EXE는 재시작·교체하지 않았다.

기본값 변경의 최초 cognition 회귀는 27건 중25통과2실패였다. SQL effect가 있다는 이유로 원래 cognition intent의 누락·변조를 우회하는 결함이었다. 복구 시 원래 plan/approval/task/user/request/conversation/privacy 조건을 SQL 원문과 교차검사하도록 수정했고 동일27건이 전부 통과했다. 별도 독립 공격은 본문 hash를 재계산한7종 변조도 차단했다.

실제 프로세스 종료 후 prepared/published 복구와 반복 복구에서 maxCalls1의 원래 예약은1건이고 정산은 한 번이었다. 위임 만료·철회 사례는 실행 거절·목표파일 없음·미정산 원예약 보존을 확인했다. 첫13건 중2실패는 짧은 거절 응답의 waves를 읽는 fixture 오류였고, 두 번째2실패는 success 대신 ok를 검사한 fixture 오류였다. 두 실패 기록을 보존하고 제품 거절 응답을 정확히 관측하게 수정했다. 최종 공통69건 전부 통과·skip0, build/Core 계약 통과다. 테스트69건은 실생활69명령 성공률이 아니다.

횟수 예산과 금액 예산은 다르다. 이번 검증은 amount0/count1인 Mission quota이고 per-effect 돈 예약/과금 영수증 복구는 계속 제외한다. 원격 workflow, 일반 task graph, 실계정 거래·다른PC는 미검증이다. 실제 B adapter 완료 반환1건은 중간 종료 전 시작한 호출까지 합한 전체 호출1회라는 뜻이 아니다.

인수 검토는 실제 filesystem.moveFiles Mission이 파일을 이동하고 COMPLETED여도 effectId와 B 멱등키/SQL effect 기록이 없음을 재현했다. V3-040의 원문을 지원하는 두 유형으로 줄이지 않고 in_progress로 유지한다. 다음 구현은 moveFiles의 원본·목적지 자원 claim, 원래 operation/effect/key/요청해시/영수증 결속과 종료·응답손실 복구다. 설치나30일을 이 항목의 새 조건으로 추가하지 않았다.

고정 복구 비교기는 기존18사례를 양쪽 동일 current 구성으로 각각3회 검사했다. 판정 ${comparison.comparison.decision}, 제품 속도·품질 우위는 미측정이다. 외부 모델 호출0, 전체 로컬 비용null. 감시6곳 변화0. 후보52개와 기존 실패·증거 상태를 다시 읽었고 사용자 F/cognition은 격리 시험 외 변경하지 않았다.

설계 원문 재확인: [SQLite 트랜잭션](https://www.sqlite.org/lang_transaction.html)의 단일 동시 쓰기와 SAVEPOINT, [Temporal Activity](https://docs.temporal.io/activity-execution)의 실행 이력·타임아웃 재시도는 현재 원장/재시도 경계 검토에 참고했다. 외부 프레임워크를 설치하거나 논문 성능을 재현한 결과가 아니다.

복원은 기본 workflowEffectsEnabled를 false로 돌려 신규 workflow staging을 끄고 기존 SQL 기록·원래 cognition intent는 보존한다. 복구 중 작업은 상태 대사 후 처리한다. 기록 해시 무결성은 독립 제품 검증이 아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','baseline.txt','context.txt','quota.txt','quota-v2.txt','final.txt','final-runner.json','build.txt','contract.txt','independent.json','acceptance.json'].map(n=>`${prefix}-${n}`);
evidencePaths.push('artifacts/recovery-comparison/workflow-default-20261007.json');
write('attempt.json',{id:'workflow-default-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'지원하는 로컬 workflow SQL effect 기본 경로에서 원래 cognition intent를 교차 검증하고 Mission quota 예약을 재사용하면 종료 복구의 문맥과 횟수 한도를 보존한다.',
 lesson:'SQL effect가 원래 기억 의도를 대체하면 누락·변조가 우회된다. 거절 응답과 Mission 본문은 별도 계약이다. 횟수 정산 성공을 금액 정산 구현으로 확대하지 않는다.',
 limitations:'격리69회귀 및 독립 반증만. 운영/설치 활성화0, 금액 effect·원격workflow 미지원. moveFiles 실제effect/key누락 반례로 V3-040 부분/공식60 유지. 비용null.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 workflow 소스 기본true·원래cognition context 교차검증·maxCalls1 종료복구/철회/만료·69회귀. 실제moveFiles effect/key 미결속 반례로 전체부분 유지. 금액/원격workflow 제외·운영활성화0.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: workflow 소스 기본true/기억문맥 우회2결함 수정·횟수quota종료복구·69회귀/build/contract·독립검토. moveFiles 실effect/key누락 확인으로 V3-040부분/공식60 유지. 다음 moveFiles 공통effect 결속.\n`);
console.log(JSON.stringify({observedAt,tests:69,verified,attempt:`${prefix}-attempt.json`}));
