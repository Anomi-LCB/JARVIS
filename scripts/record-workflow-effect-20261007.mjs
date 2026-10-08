import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/workflow-effect-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString(),runner=json(`${prefix}-checkpoint-final-runner.json`),log=read(`${prefix}-checkpoint-final.txt`);
assert.equal(runner.status,'passed');assert.equal(runner.exitCode,0);
for(const [key,count] of [['tests',92],['pass',92],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-process-v3.txt`),/ℹ pass 3(?:\r?\n|$)/);
assert.match(read(`${prefix}-checkpoint-build.txt`),/Built static JARVIS/);
assert.match(read(`${prefix}-checkpoint-contract.txt`),/gatePassed: true/);
const paths=['packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-runtime.js',
 'packages/core/src/mission/mission-action-recovery.js','packages/core/src/mission/workflow-resume-checkpoint.js',
 'tests/mission-workflow-effect.test.js','tests/mission-workflow-effect-process.test.js','tests/workflow-resume-checkpoint.test.js','tests/fixtures/workflow-cognition-process-child.mjs'];
write('source.json',{observedAt,files:paths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;assert.equal(verified,60);
write('verification.json',{observedAt,tests:92,passed:92,failed:0,skipped:0,durationMs:runner.durationMs,
 actualCoreProcessKills:3,processBoundaries:['prepared','b-receipt','receipt-persisted'],
 realLocalWorkflowSqlEffect:true,originalOperationKeyPreserved:true,completedReceiptRecovery:true,
 actualSqlCheckpointSourcePreserved:true,defaultWorkflowEffectsEnabled:false,productionActivated:false,
 commonUnfinishedPublicationResumeComplete:false,standaloneFileOverlapVerified:false,
 officialVerified:verified,targetVerified:90,externalProviderCalls:0,actualCost:null});
write('report.md',`# 복합 작업 실행 기록 실험과 SQL 재개 원문 보존

관측 ${observedAt}. 목표90/100, 공식${verified}/100 유지. 제품 전체 완료나 새 인수 승격이 아니다.

Microsoft 도중 권한철회 수정은 별도97회귀와 장부 기록을 완료했다. 이번에는 실제 로컬 workflow.execute를 Core SQL EffectRecord와 기존 operationId·요청해시·B 멱등키·원래영수증으로 연결했다. 실제 파일 출력과 재조회,SQL reopen,현재 권한철회 후 출력 차단을 검사했다. Core PID를 prepared/B영수증/SQL영수증 세 경계에서 실제 SIGKILL하고 새 PID로 복구했다. 각경우 B실행은1회이며 원래operationId·영수증과 기억을 보존한다. 시간 만료는 fixture의 SQL과 runtime에 동일한 명시시계를 사용하며 실제장기운영이 아니다.

독립 반증은 미완료 publication 재개에 세 공백을 확인했다. SQL 객체키 정렬로 원래 spec 및 재개 승인 해시가 달라지고, 새 mission_op 키의 B 재개에는 Core private fence가 없었다. 원래승인 source문자열 보존·해시+내용 비교,publication진단의 원래workflowSpecSource 사용을 추가했다. 레거시 source미보존 기록은 기존해시가 실제 일치할 때만 인정한다. 새 source를 만들어 과거 승인을 추정하지 않는다. 신규 재개 fence와 standalone 파일 겹침 증거는 아직 남아 있다.

이를 감추지 않고 workflowEffectsEnabled=false를 기본값으로 유지했다. 새SQL복합효과는 격리 인수fixture에서만 true다. 운영 Core/설치본을 재시작하거나 활성화하지 않았고 사용자 계정·F/cognition 자료를 수정하지 않았다. 새 원문 보존 개선은 source 경로에 구현됐으나 전체publication 재개 성공을 뜻하지 않는다. 현재재개절차를 약화하거나 operationId를 버려 통과시키지 않는다.

최종공통92/92·실패0·skip0, build/Core계약 통과. 초기2개실패 중1개는 testfixture의 없는execute 메서드 오류,1개는 실제EffectRecord누락이었다. 이 구분을 보존한다. 초기실험의 광범위 회귀에는 cognition 실패 후 기대상태가 달라진 반례도 보존했고,기본guard 복원 뒤89/89및원문보존추가뒤92/92를 확인했다. 92개는새자연어미션92건이 아니다. 비용은미측정null,외부유료0.

다음은 원래명세·현행E권한·Core lease를 보존한 명시적publication재개 fence를 구현하고,중간publication 종료/취소/만료/파일겹침을 종단반증한 뒤기본guard 제거 여부를 판단하는 것이다. V3-040은진행중이다. 복원은이번coordinator실험부분을검토해제거하되원래SQL승인문자열과spec원문검증은보존한다. 증거무결성은결론독립검증이아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','baseline.txt','first.txt','process-v3.txt','guarded-final.txt',
 'checkpoint-final.txt','checkpoint-final-runner.json','checkpoint-build.txt','checkpoint-contract.txt'].map(s=>`${prefix}-${s}`);
evidencePaths.push('artifacts/workflow-effect-code-refutation-20261007.json','artifacts/workflow-effect-code-refutation-proof-20261007.txt');
evidencePaths.push('artifacts/workflow-effect-serialization-closure-proof-20261007.txt');
write('attempt.json',{id:'workflow-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'inconclusive',observedAt,evidencePaths,
 hypothesis:'기존 workflow B영수증을 Core operation/effect 원장에 결속하고 원래재개직렬화를 보존하면 재시작 후 복합효과 중복없이 회복할 수 있다.',
 lesson:'완료영수증 복구와 미완료publication 재개는 다르다. 일반키를mission키로 바꾸면 기존 private fence 계약도 연결해야 한다. SQL키정렬은 원문문자열해시와 별도로 다룬다.',
 limitations:'92개개발회귀/실제로컬HTTP가아닌Core/E/B/G/SQL·3프로세스종료. 새효과기본false·미완료publication fence/독립파일겹침미완료. 공식60/목표90·실계정/운영활성화0·비용미측정.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 후속: 격리local workflow effect SQL/B operation key/원래영수증·실제3경계PID종료 복구 연결.92회귀/build/contract. 원래재개승인과spec source보존 수정. 미완료publication private fence·standalone overlap미완료로workflowEffectsEnabled=false 기본유지,진행중.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제 격리workflow operation/effect/영수증·3PID종료복구와SQL재개source보존,92회귀. 기본guard=false·미완료publication fence/독립파일겹침잔여. 공식60/목표90 유지.\n`);
console.log(JSON.stringify({observedAt,verified,target:90,tests:92,evidenceCount:evidencePaths.length}));
