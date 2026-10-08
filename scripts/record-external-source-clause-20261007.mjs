import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/external-source-clause-20261007';
const pilotPath='artifacts/recipient-source-mission-20261007-zfadgL/result.json',inventoryPath='artifacts/external-source-inventory-20261007-bVXbir/result.json';
const beforeClausePath='artifacts/recipient-source-mission-20261007-U4lJEj/result.json',beforeHandoffPath='artifacts/recipient-source-mission-20261007-0NNsji/result.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/u,''));
const pilot=json(pilotPath),inventory=json(inventoryPath),clause=json(beforeClausePath),handoff=json(beforeHandoffPath);
assert.equal(clause.records.find(r=>r.id==='embedded-read-step').requests,1);
assert.equal(handoff.records.find(r=>r.id==='late-dispatch-address-drift').requests,1);
assert.equal(pilot.records.length,13);
for(const row of pilot.records){assert.equal(row.requests,row.expectedCalls);assert.equal(row.canaryReceipts.length,row.expectedCalls);
 assert.equal(row.sourcePreserved,true);assert.equal(row.independentReadCompleted,true);assert.equal(row.status,row.expectedCalls?'COMPLETED':'PAUSED');}
assert.equal(inventory.rows.length,27);assert.deepEqual(inventory.rows.filter(r=>r.scope==='external').map(r=>r.toolName),['email.send']);
for(const [path,count] of [[`${prefix}-current-tests.txt`,330],[`${prefix}-default-final.txt`,6],[`${prefix}-boundaries.txt`,49]]){
 const output=readFileSync(path,'utf8');assert.match(output,new RegExp(`tests ${count}`));assert.match(output,/fail 0/);assert.match(output,/skipped 0/);
}
assert.match(readFileSync(`${prefix}-current-build.txt`,'utf8'),/Built static/);
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
const gate=gates.find(g=>g.id==='V3-018');assert.equal(gates.length,100);assert.equal(gate.status,'in_progress');
assert.equal(gate.requirement,'미지원 단계·모호한 대상을 조용히 삭제한 부분 계획의 외부 쓰기를 방지한다.');
const originalRequirementsSha256=hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))))),observedAt=new Date().toISOString();
const times=pilot.records.map(r=>r.durationMs).sort((a,b)=>a-b),percentile=p=>times[Math.ceil(times.length*p)-1];
const audit={observedAt,pilotObservedAt:pilot.observedAt,gateId:gate.id,originalRequirement:gate.requirement,originalRequirementsSha256,decision:'verified',
 before:{verified:gates.filter(g=>g.status==='verified').length,clauseCanaryUnexpectedCalls:1,handoffCanaryUnexpectedCalls:1},
 current:{completed:2,paused:11,unexpectedDispatches:0,canaryCalls:2,approvalCount:pilot.records.reduce((sum,r)=>sum+r.approvals,0),sourcePreserved:true,
 p50Ms:percentile(.5),p95Ms:percentile(.95),sharedRegressionCases:330,finalDefaultCriteriaCases:6,externalModelCalls:0,cost:'미측정'},
 boundaryAudit:[
 {entry:'email.send',proof:'exact original clause/full prerequisite file grammar/recipient/attachment hash + planning/dispatch/pre-worker/final-PC-packet checks',evidence:pilotPath},
 {entry:'registered MCP read',proof:'whole-request reviewed local binding + current tool contract + actual owned HTTP execution + independent result receipt',evidence:`${prefix}-boundaries.txt`},
 {entry:'registered MCP write/external-effect',proof:'package activation rejected A_MCP_CAPABILITY_EFFECT_NOT_SUPPORTED before provider call; no reconciliation/compensation contract claimed',evidence:`${prefix}-boundaries.txt`},
 {entry:'opaque shell/UI/API/agent/Android/payment/message',proof:'unknown/mutating effect contracts denied before E or worker; inferred readOnly cannot replace installed contract',evidence:`${prefix}-boundaries.txt`},
 {entry:'local structured/compiled operations',proof:'known local adapters or validated local workflow; unknown/process workflow remains opaque; local-only binding does not authorize email or MCP',evidence:`${prefix}-current-tests.txt`}
 ],
 scope:'original unsupported/ambiguous partial-plan external-admission safeguard, not implementation or usability of all natural-language tasks',
 limitations:['loopback transport/synthetic readiness; no actual mail account or SMTP delivery','opaque/unknown writes remain blocked rather than implemented','future adapter activation requires new reviewed effect/source/result contract','other acceptance gates retain real account, device and long-duration requirements']};
writeFileSync(`${prefix}-acceptance-audit.json`,JSON.stringify(audit,null,2),{flag:'wx'});
const sourcePaths=['packages/core/src/mission/external-source-clause.js','packages/core/src/mission/mission-requirement-coverage.js','packages/core/src/mission/mission-effect-scope.js',
 'packages/core/src/mission/mission-runtime.js','packages/core/src/mission/read-send-default-criteria.js','packages/core/src/capabilities/mcp-capability-package.js',
 'packages/core/src/capabilities/mcp-intent-binding.js','tests/external-source-clause.test.js','tests/mcp-mission-integration.test.js','tests/mission-opaque-effects.test.js',
 'scripts/recipient-source-mission-pilot.mjs','scripts/external-source-inventory-20261007.mjs'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,sources:sourcePaths.map(path=>{const bytes=readFileSync(path);return {path,sha256:hash(bytes),content:bytes.toString('utf8')};})},null,2),{flag:'wx'});
const report=`# V3-018 부분 계획의 외부 쓰기 방지 인수\n\n원래 요구: ${gate.requirement}\n\n## 결론\n\n현재 등록 경로와 미지원 외부 경로의 진입 경계를 감사하여 V3-018을 verified로 승격한다. 전체46/100. 기능을 모두 구현한 비율이나 모든 자연어 성공률이 아니다. 요구100개와 원래 문구는 유지했다.\n\n## 새 결함 재현 및 수정\n\n첫 재현 U4lJEj: 권한을 늘린 뒤 파일을 읽고 보내라는 원문에서 읽기만 성공해도 whole requirement로 인정하여 격리 canary1회가 실행됐다. 원문 정확한 span을 재해석하고 파일 작업 절의 모든 글자를 소비하는 문법을 별도 적용했다. 미지원 선행 행동·여러 대상·원문/메타데이터 불일치는 단일 파일 G 영수증으로 충족되지 않는다. 독립 읽기는 계속하고 발송은 보류한다.\n\n둘째 재현0NNsji: 마지막 비동기 연결 확인에서 주소를 바꿨을 때 이전 source 검사만으로 canary1회가 실행됐다. 마지막 await 뒤 worker 인계 직전과 PC 실행 패킷 직전 원문·현재 인수·등록 계약을 재대조한다. 준비 때 검사를 통과한 주소가 최종 실행 권한을 대신하지 않는다.\n\n실제 이메일은 발송하지 않았다. 두 재현은 소유 loopback HTTP canary와 주입 SMTP transport였다. assert 실패 후 Node Windows cleanup assertion도 남았으며 보고/결과는 보존했다. 현재 실행은 정상 종료했다.\n\n## 현재 실행\n\n최종13건: 정상 명시 주소와 self 요청2건 COMPLETED, 잘못된/누락 주소·self override·미지원 절·발송 절/선행 읽기 절의 미지원 행동·모호한 사람·정정·첫 dispatch/late dispatch/PC packet 변경11건 PAUSED. 정상canary2호출, 잘못된발송0. 독립 읽기와 원본SHA 보존13건. 보류11건을 업무 성공으로 계산하지 않았다. 실제 공급자·계정 준비도는 합성이며 SMTP 전달/받은편지함 도착/상대 열람 미검증.\n\n등록 어댑터27개를 실제 런타임 프로필로 검사했다. empty arguments 분류는 보수적인 경계 감사이며 도구 사용 성공의 증거가 아니다. email.send만 external로 분류, shell/UI/불명 workflow는 opaque. MCP 읽기는 reviewed whole-request resolver와 actual owned HTTP 결과 오라클로 확인했고, write/external-effect 계약은 보상·대사 미구현으로 설치 전 거절했다. 알 수 없는 API/agent/Android/payment/message는0 worker handoff. 로컬 구조화/검증된 local workflow는 외부 권한의 대체가 아니다.\n\n공유330회귀 통과·실패0·skip0. 마지막 default criteria 선행절 보강 후 별도6검사와 최종13파일럿 통과. 최종 code의 packet/source checks는 공유회귀 시점에 포함됐다. build 성공. 외부 모델0,비용미측정.13건 혼합 지연 p50 ${audit.current.p50Ms.toFixed(2)}ms/p95 ${audit.current.p95Ms.toFixed(2)}ms; 운영 지연 지표가 아니다. 합성승인 ${audit.current.approvalCount}회, 실제 위임 범위 변경 없음.\n\n## 인수 범위와 남은 작업\n\n이 항목은 부분 계획으로 외부 쓰기를 우회하지 못하도록 하는 실패 차단 계약이다. 미지원 기능을 가능하게 만드는 항목은 별도다. 새 외부 adapter는 전체 원문/대상/효과/검증/복구 계약 검토를 거쳐야 하며 이번 결과가 미래 연결까지 자동 승격시키지 않는다. 실계정 메일/일정, 다른PC, 모바일/웨어러블, 장기 평가 등 기존 기준 유지. 다음 작업은 V3-020의 독립 읽기·모아서 묻기 실제 인수 종료다.\n\n복원은 source snapshot과 gate reviewHistory로 이번 수정만 검토한다. 사용자 Word PID34724는 유지했고 서비스/운영 연결/메일 권한/클라우드를 변경하지 않았다. 전체 reset 금지.\n`;
writeFileSync(`${prefix}-report.md`,report,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-acceptance-audit.json`,`${prefix}-source.json`,`${prefix}-current-tests.txt`,`${prefix}-current-build.txt`,`${prefix}-default-final.txt`,
 pilotPath,inventoryPath,beforeClausePath,beforeHandoffPath,`${prefix}-boundaries.txt`,`${prefix}-focused.txt`,`${prefix}-focused-fixed.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'external-source-clause-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',observedAt:pilot.observedAt,
 hypothesis:'파일 G 영수증과 부분 문법을 분리하고 마지막 비동기 단계 후 원문을 재대조하면 미지원 선행 요구와 바뀐 주소는 외부 dispatch 전에 차단된다.',reportedOutcome:'passed',evidencePaths,
 lesson:'하나의 읽기 영수증은 선행 절 전체를 증명하지 않는다. source coverage는 계획/dispatch뿐 아니라 worker와 final packet 인계에도 현재 인수를 대조해야 한다.',
 limitations:'실제Core/E/B/G와 합성준비도/transport→owned loopback13건. 실제계정/SMTP전달·모든 자연어 실행·장기관측 미검증. 원래 인수V3-018 종료46/100,미지원쓰기 차단이지 기능 구현 완료가 아니다. 비용미측정.'},null,2),{flag:'wx'});
gate.reviewHistory??=[];gate.reviewHistory.push({status:gate.status,evidence:[...gate.evidence],limitations:[...gate.limitations],reviewedAt:gate.reviewedAt??null,supersededAt:observedAt});
gate.status='verified';gate.reviewedAt=observedAt;
for(const path of [`${prefix}-report.md`,`${prefix}-acceptance-audit.json`,pilotPath,inventoryPath,`${prefix}-current-tests.txt`])if(!gate.evidence.includes(path))gate.evidence.push(path);
gate.limitations=['현재 외부 실행 경계의 부분 계획 방지 계약을 인수했다. 알 수 없는 쓰기/MCP 쓰기는 차단되며 기능 구현·모든 자연어 성공을 의미하지 않는다.',
 'actual local Core/E/B/G + injected transport/owned loopback13건·330회귀/최종6집중. 실제 계정 SMTP 전달/일정/물리기기·장기인수는 별도 기준 유지.',
 '새 adapter/contract는 source/effect/result/복구 재검토 전 자동 활성화하지 않는다. 이전 실패 및 기존 부분 이력은 reviewHistory/evidence에 보존한다.'];
acceptance.updatedAt=observedAt;assert.equal(hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))))),originalRequirementsSha256);
writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 미지원 선행 읽기 절/canary1회와 late dispatch 주소변경/canary1회 재현 후 차단. 최종13건 완료2·보류11·오발송0,27등록profile 감사/MCP 쓰기 활성화거절/330회귀+최종6집중/build. V3-018 원래 부분계획 외부쓰기방지 요구 인수→전체46/100. 실제계정 전달·모든자연어 기능·기기/장기관측 별도 유지. 다음 V3-020 독립읽기·질문묶음 인수. 상위70%목표 활성 유지.\n`);
console.log(JSON.stringify({verified:gates.filter(g=>g.status==='verified').length,evidenceFiles:evidencePaths.length,evidenceBytes:evidencePaths.reduce((sum,path)=>sum+readFileSync(path).length,0)}));
