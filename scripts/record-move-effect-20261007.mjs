import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/move-effect-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-verified-runner.json`),log=read(`${prefix}-verified.txt`);
assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
for(const [key,count]of [['tests',60],['pass',60],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-verified-compat.txt`),/ℹ pass 1/);assert.match(read(`${prefix}-verified-compat.txt`),/ℹ fail 0/);
assert.match(read(`${prefix}-verified-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-verified-contract.txt`),/gatePassed: true/);
const review=json(`${prefix}-independent-v2.json`),observedAt=new Date().toISOString();
const sources=['packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js',
 'packages/core/src/orchestration/core-orchestration-worker.js','apps/pc-agent/src/pc-agent-runtime.js',
 'tests/fixtures/move-effect-process-child.mjs','tests/mission-move-effect-process.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;assert.equal(verified,60);
write('verification.json',{observedAt,tests:61,passed:61,failed:0,skipped:0,primaryRunnerTests:60,legacyDirectTests:1,
 primaryRunnerDurationMs:runner.durationMs,processKillBoundaries:['prepared','b-receipt','receipt-persisted','partial'],
 sameOperationAndEffectAndKeyAndReceipt:true,completedClaimsReleased:true,partialMoveRedispatched:false,
 changedArtifactRecoveryBlocked:true,activeSqlCoreAuthorityActualMove:true,independentReview:review,
 productionActivated:false,officialVerified:verified,externalProviderCalls:0,actualCost:null});
write('report.md',`# 실제 파일 이동의 공통 효과 기록과 종료 복구

관측 ${observedAt}. 공식 ${verified}/100. 이전 독립 인수 검사에서 실제 filesystem.moveFiles Mission은 파일을 이동하고 G/F를 통과했지만 effectId·SQL effect·원래 operation에 묶인 B 키가 없었다. 이번 변경은 이 실제 활성 경로를 공통 계약에 연결한다.

Core는 기존 operationId로 effectId와 공급자 멱등키를 연결하고 원래 task/action/권한 루트/요청 해시/기억 문맥을 SQL에 저장한다. 로컬 pre-stage shadow의 실제 이동 계획(from/to/action)을 SQL 요청에 보존하며 B 재검사와 달라지면 private fence로 차단한다. 파일 이동은 원본·목적지 양쪽의 기존 B 물리파일 claim을 재사용하고 mkdir/copy/rename 전 현재 E/Core/lease 조건을 확인한다. 완료 packet receipt는 즉시 영속화한다.

독립 검사에서 새 claim이 기존 direct move packet을 거절하는 회귀가 드러났다. 기존 로컬 packet이 생략하던 plan/approval ID와 인자 binding의 호환을 보존하면서 서명된 scope·현재 토큰·물리 경로는 계속 검사한다. Mission operation의 엄격한 plan/approval/인자 binding은 그대로다. packet JSON은 private Core fence나 movePlan 검사를 만들 수 없다.

다른 독립 반례는 B 완료 영수증 후 강제 종료하면 원본/목적지 claim4개가 남는 문제였다. 원래 fingerprint/key/task의 실제 완료 packet을 조회하고 changedItems와 output/claim 자원을 대조한 뒤 claim을 완료한다. SQL/G/F 복구만 성공해도 B 잠금이 정리됐다고 추정하지 않고 테스트에서 claim0을 직접 검사한다.

동일 바이트를 가진 다른 목적지 영수증으로 바꾸는 공격도 발견했다. 복구는 SQL의 movePlan과 변경 항목·출력·동작 유형을 대조하고 copy 외 원본의 부재도 확인한다. 잘못된 영수증은 G/F 성공 전에 거절한다. 작업자 capability 및 Core-authority wrapper가 private assertMovePlan을 잃는 두 경로도 수정했다. 해당 메서드가 없는 Mission 이동은 B가 명시적으로 거절한다.

최종 공통60회귀와 기존 direct 이동1건, 총61건 전부 통과·skip0. 실제 SIGKILL은 이동 전 prepared, B 완료영수증, SQL 영수증, 두 파일 중 첫 파일 이동 후 네 경계다. 앞의 세 경계와 반복 복구는 원래 effect/operation/key/receipt를 보존했고 완료 adapter 반환은1건이다. 이것은 중간 종료 전 시작한 총 adapter 호출 수1이라는 뜻이 아니다. 일부만 이동되고 영수증이 없는 경우는 원본/목적지 상태를 남기고 PAUSED/uncertain으로 보류하며 자동 재실행하지 않는다. 완료 파일 내용이 달라진 경우도 PAUSED다. 실제 SQL Core authority가 활성인 경로에서 두 파일 이동/G 완료 및 claim0을 추가 관측했다.

첫 process5건 통과만으로 전체 안전을 판단하지 않았다. 초기 호환 회귀1건, 독립 claim 잔존·다른목표 영수증·wrapper 손실 반례를 보존했다. 독립 최종 검토는 별도로 기록하며 그 숫자를61에 더하지 않는다. build와 Core 계약도 통과했다. 합성 입력·명시 시계·임시 OS 파일/SQLite·실제 PID를 사용했고 실계정/외부 발송/다른PC는 실행하지 않았다. 외부 모델 호출0, 전체 로컬 비용null이다.

V3-040은 현재 등록된 다른 쓰기 경로(excel.createWorkbook/exportPdf, 문서·압축·배포와 공급자 effect 계약)의 감사/연결이 남아 진행중을 유지한다. 전체 인수 범위를 파일 이동으로 줄이지 않는다. 운영 Core/PC 서비스·Windows 설치본에는 이번 소스를 아직 활성화하지 않았다. 다음은 현재 활성 쓰기 능력별 effect 계약/경로 목록을 고정하고 Excel 제작 등 실제 다음 누락을 재현·연결하는 것이다.

복원은 새 move support와 movePlan/private hook 경로를 검토해 이전 source로 되돌리되 원래 SQL/B 기록과 사용자 기억은 삭제하지 않는다. 이미 이동된 파일의 uncertain 상태는 영수증/현재 파일 대사 없이 새 실행으로 대체하지 않는다. 임의 OS 프로그램의 모든 rename 경쟁과 모든 복합 이동 정책을 무결함으로 입증한 시험은 아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','process-first.txt','compat-first.txt','verified.txt','verified-runner.json',
 'verified-compat.txt','verified-build.txt','verified-contract.txt','independent.json','independent-v2.json'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'move-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'현재 실제 등록된 로컬 파일 이동을 원래 operation/effect/요청/멱등키/영수증 및 양쪽 자원 claim에 연결하면 종료 뒤 중복 이동 없이 완료 결과를 복구한다.',
 lesson:'G/F 완료와 B claim 해제는 독립 관측이다. self-consistent 영수증도 원래 from/to/action과 결속해야 한다. private 함수의 부가 검증은 wrapper를 통과할 때 명시적으로 보존해야 한다.',
 limitations:'격리61회귀, 실제SIGKILL4경계와Core SQL authority만. partial 이동은 자동재실행하지않음. 다른쓰기능력/원격/실계정미검증·운영활성화0·V3-040부분/공식60·비용null.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 실제local moveFiles 공통effect/key/영수증·from/to Bclaim·SIGKILL4경계·movePlan복구결속/wrapper 보존·61회귀/build/contract. 다른 활성쓰기의 전체계약 감사가 남아 부분 유지·운영활성화0.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 파일이동 실제common effect/key/receipt·양쪽claim·종료복구/partial보류·movePlan/wrapper 결함 수정·61회귀/build/contract. 공식60 유지. 다음 다른 활성쓰기능력 공통effect 감사·Excel 제작 경로.\n`);
console.log(JSON.stringify({observedAt,tests:61,verified,attempt:`${prefix}-attempt.json`}));
