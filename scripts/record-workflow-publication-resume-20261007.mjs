import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix='artifacts/workflow-publication-resume-20261007', read=p=>readFileSync(p,'utf8'), json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-fenced-final-runner.json`),log=read(`${prefix}-fenced-final.txt`);
assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
for(const [key,count]of [['tests',71],['pass',71],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-fenced-build.txt`),/Built static JARVIS/);
assert.match(read(`${prefix}-fenced-contract.txt`),/gatePassed: true/);
const independent=json(`${prefix}-independent.json`),observedAt=new Date().toISOString();
const sources=['packages/core/src/mission/sqlite-mission-store.js','packages/core/src/mission/mission-effect-coordinator.js',
 'packages/core/src/mission/mission-runtime.js','apps/pc-agent/src/pc-agent-runtime.js',
 'apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js','tests/fixtures/workflow-cognition-process-child.mjs','tests/mission-workflow-effect-process.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;assert.equal(verified,60);
write('verification.json',{observedAt,tests:71,passed:71,failed:0,skipped:0,durationMs:runner.durationMs,
 actualProcessKillBoundaries:['prepared','b-receipt','receipt-persisted','publication-prepared','publication-published'],
 publicationRecoveredWithSameEffectAndOperation:true,expiredFenceReplaced:true,repeatReceiptPreserved:true,
 sameOriginalSpecAndStagedRecipe:true,successfulAdapterReturnsPerPositiveScenario:1,
 adapterInvocationCountMeaning:'initial interrupted adapter and resume adapter are distinct invocations; completed returns are not total invocations',
 recoveryRejections:['grant-revoked','authorization-revision-changed','cancelled','capability-token-revoked'],
 lateAuthorityChecks:['before-mkdir','before-temporary-write','after-manifest'],
 independentReview:`${prefix}-independent.json`,independentReviewVersion:independent.reviewVersion??independent.version??null,
 budgetedPublicationRecovery:false,remotePublicationEffectRecovery:false,defaultWorkflowEffectsEnabled:false,
 productionActivated:false,officialVerified:verified,actualCost:null,externalProviderCalls:0});
write('report.md',`# 미완료 복합 게시 작업의 권한·잠금 보존 재개

관측 ${observedAt}. 공식 인수 ${verified}/100, 목표 최소90/100 유지. 이번 작업은 기존 Core/E/B/G/F 복구 경로의 로컬 격리 구현과 검증이다. 설치본·운영 서비스 활성화나 전체 인수 승격은 수행하지 않았다.

이전 실험에서 mission_op 키를 쓰는 미완료 workflow 재개가 B의 private Core fence 부재로 차단됐다. 원래 승인 source와 spec 해시는 이전 수정대로 보존하고, 현재 E 판단/새 서명 토큰·Core 실행권위·목표/승인 버전·owner/위임/준비도·시간 조건·새 SQL lease를 재개 경로에 연결했다. 원래 effectId/operationId/요청해시/멱등키를 변경하지 않는다.

SQL의 새 claimWorkflowPublicationRecovery는 uncertain 상태의 이미 결속된 pc-local workflow만 새 fence로 획득한다. 일반 claimEffect는 uncertain 작업을 재발송하지 않는다. 예산 예약이나 원격 effect는 지원이 끝나기 전 null 차단한다. Core는 재개 승인과 원래 task/plan/action/request 결속을 다시 확인하며 private 함수만 B에 넘긴다. B는 이미 저장된 publication intent와 staged recipe를 사용한다. 영수증 저장 뒤 G 재조회와 F/cognition 복구로 이어진다.

실제 프로세스 SIGKILL은 prepared/B영수증/SQL영수증/게시prepared/게시published 다섯 경계에서 실행했다. 새 PID 복구·반복 복구에서 원래 effectId/operationId/영수증을 보존했고, 두 게시 경계에서는 더 큰 fence를 관측했다. 성공 adapter 반환은 각 시나리오1건이다. 종료 전에 시작한 adapter와 재개 adapter는 서로 다른 호출이므로 이 수치를 총 호출1회라고 표현하지 않는다.

재개 claim 뒤 grant 철회·승인 revision 변경·취소·B 토큰 철회 네 반례는 성공0·목표파일0이다. 토큰 철회는 adapter가 실패 결과1건을 반환할 수 있어 총 adapter 호출0과 구분했다. 독립 반증은 task/action/spec 변조·오래된 fence·예산/원격 scope 제외도 검사했다. 추가 검토에서 resume의 mkdir/temp 쓰기 직전 current fence 공백을 찾아 보강했다. stage read 뒤 철회는 디렉터리/목표/temp 모두 없고, temp read 뒤 철회는 이미 철회 전에 만든 디렉터리는 남지만 추가 temp/목표 쓰기는 없다. 무조건 모든 잔여 파일0으로 확대하지 않는다.

최종 ${71}개 회귀 전부 통과·실패0·skip0, build/Core 계약 통과. 테스트71건은 자연어 실사용71건이나 독립 의미 평가71건이 아니다. 별도 독립 반증 숫자는 합산하지 않는다. 실제 OS/파일/SQLite와 합성 권한·명시 시계를 사용했다. 유료 모델 호출0·전체 로컬 비용 미측정(null).

남은 일은 예산 예약의 현재 위임과 uncertain 정산을 보존한 재개, 기본 workflow effect 활성화에 필요한 기존 cognition 실패/복구 회귀, 경합 거절 이후 Core 상세 사유와 안전 재시도, 원격 경로·다른 장치 실증이다. workflowEffectsEnabled=false 기본값은 유지하며 이 격리 결과만으로 V3-040을 verified로 바꾸지 않는다. 복원은 이번 dedicated claim/hook 연결을 검토해 되돌리되 원래 SQL/승인 source/사용자 기억을 삭제하지 않는다. 장부 해시 무결성은 독립 결론 검증이 아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','first.txt','authority.txt','authority-v2.txt',
 'fenced-final.txt','fenced-final-runner.json','fenced-build.txt','fenced-contract.txt','independent.json','independent.md'].map(name=>`${prefix}-${name}`);
write('attempt.json',{id:'workflow-publication-resume-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'원래 publication 승인과 effect/key를 유지하고 현재 권한·새 Core lease를 private B 재개 hook에 연결하면 중간 종료 뒤 파일 게시를 안전하게 이어갈 수 있다.',
 lesson:'미완료 재개는 일반 재발송과 달라야 한다. 완료 영수증 복구와 staged publication 재개를 분리하고, 디렉터리/temp 쓰기 전에도 current fence가 필요하다. adapter 실패 반환과 성공/전체 호출은 다른 측정이다.',
 limitations:'71개 격리 회귀, 합성권한·명시시계·실제SIGKILL5경계. 예산예약/원격 publication 미지원, workflow 기본false·운영활성화0. 공식60/100 유지·실계정/다른PC/전체자연어 미입증·비용null.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 미완료 로컬publication fresh Core/E/fence 연결, 실제5경계SIGKILL/4권한음성/71회귀/build/contract. mkdir/temp current fence 보강. 예산예약·원격재개/기본guard 제거 인수 잔여로 defaultfalse·진행중 유지.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 로컬 미완료publication 원래승인·key/새Core fence로 실제재개, SIGKILL5경계/권한음성4/71회귀. mkdir/temp fence 보강·독립반증. 예산예약/원격재개·defaultguard 제거 미완료·공식60 유지.\n`);
console.log(JSON.stringify({observedAt,tests:71,verified,attempt:`${prefix}-attempt.json`}));
