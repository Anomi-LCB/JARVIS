import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/approval-task-restoration-20261007';
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex');
const check=(suffix,count)=>{const text=read(`${prefix}-${suffix}.txt`);assert.match(text,new RegExp(`tests ${count}\\b`));assert.match(text,new RegExp(`pass ${count}\\b`));assert.match(text,/fail 0\b/);assert.match(text,/skipped 0\b/);return {tests:count,pass:count,fail:0,skip:0,durationMs:Number(/duration_ms ([\d.]+)/u.exec(text)[1])};};
const recovery=check('final-regression',105),boundaries=check('shared-boundaries',69),memoryRequired=check('memory-required',9);
assert.match(read(`${prefix}-current-build.txt`),/Built static/);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(acceptancePath)),gates=acceptance.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-029');
assert.equal(gates.length,100);assert.equal(gate.status,'in_progress');
const requirementsHash=hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));
const verification={observedAt,gateId:gate.id,requirement:gate.requirement,status:'in_progress',verified:gates.filter(g=>g.status==='verified').length,originalRequirementsSha256:requirementsHash,
 regressions:{recovery,boundaries,memoryRequired,uniqueFinalCases:175,note:'105 recovery + 69 disjoint boundary tests; memoryRequired reruns 8 existing cases and adds one. Runner durations are not product p50/p95.'},
 initialBroad:{tests:1056,pass:1031,fail:11,skip:14,note:'Preserved failed run. All eleven failing assertions are covered in final recovery regression; the entire 119-file campaign was not repeated. Linux OS boundary tests remain skipped.'},
 scenarios:['fresh approval after missing Core Task restart','revision change on normal restart recovery','attempted/rejected/tampered gates never reauthorized','cancel during real HTTP tools/list prevents tools/call','goal revision drains previous approved write without canceling it','remote lost response reconciles original G evidence with cognition without B replay','tampered remote output remains paused','durable SQL workflow stores growth event and original source provenance','missing persistent growth stays paused with no repeated workflow'],
 externalModelCalls:0,cost:'미측정',scope:'isolated local HTTP MCP and configured Core/PC service, real temporary files/SQLite, synthetic accounts and fixed data; no real account delivery or deployment',
 remaining:'Remote MCP/account bindings and final remote effect authority checks, cross-process/provider dispatch race, physical/live account acceptance; missing persistent growth is detected after local publication and remains paused.'};
writeFileSync(`${prefix}-verification.json`,JSON.stringify(verification,null,2),{flag:'wx'});
const files=['packages/core/src/mission/mission-runtime.js','packages/core/src/orchestration/core-orchestration-worker.js','apps/pc-agent/src/pc-agent-runtime.js','packages/core/src/capabilities/mcp-capability-package.js','apps/verification/src/remote-artifact-verifier.js','tests/mcp-mission-integration.test.js','tests/mission-document-contract.test.js','tests/workflow-mandate-data-scope.test.js','tests/mission-mandate-final-fence.test.js','tests/mission-source-provenance-restart.test.js','tests/sqlite-mission-store.test.js','tests/mission-goal-adversarial.test.js','tests/mission-task-reservation.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`, `# 승인 복원·최종 MCP 취소·원격 결과 복구

공식 인수율 **46/100 유지**. V3-029 원래 요구는 “${gate.requirement}”. 이번 작업은 다음 재현 결함을 수정한 것이며 전체 계정·기기 검증 완료를 뜻하지 않는다.

## 제품 수정

1. Core Task가 사라진 재시작에서, 미실행·미거절·원문 해시 일치·불확실 효과 없음 조건의 pending 승인만 복구한다. 과거 gate는 취소하고 정상 Core/E 경로로 현재 Task와 새 승인 gate를 만든다. 이전 승인을 자동 이전하지 않는다. 실행 시도·거절·gate 해시 변조는 복구 대상에서 제외한다. 권한이 변하면 정상 resume 경로에서 차단한다.
2. 실제 HTTP MCP discovery 중 Mission을 취소했는데 tools/call 한 번이 실행되는 결함을 재현했다. B의 호스트 소유 trusted fence를 adapter의 최종 authorize에 전달하고 async discovery 뒤에도 취소 신호·현재 Task·권한을 확인한다. 외부 MCP 출력이나 HTTP packet은 fence 함수를 주입하지 못한다. 수정 후 CANCELLED/calls0이다.
3. 처음에는 계획 수정용 controller를 실행 취소에도 사용해 기존 목표 정정 검사 두 건이 실패했다. 실행용 controller를 분리해 사용자 취소·종료만 실제 실행을 중단하고, 목표 정정은 이미 승인된 실행을 배수하는 기존 의미를 유지했다. 두 실제 파일/HTTP 검사 모두 복구했다.
4. 원격 G 결과의 taskId 누락으로 파일 검증 후 cognition이 original request와 결과를 연결하지 못했다. G가 검증한 원래 taskId를 결과에 보존했다. 실제 configured service 응답 손실은 같은 Mission/Effect에서 B 실행1회로 COMPLETED가 되었고, 변조된 파일은 PAUSED로 남았다.

## 회귀 실패와 시험 구성 수정

초기 119개 파일 확대 검사는 1056건 중 통과1031·실패11·제외14였다. 원본 로그를 보존했다. 최종 검사에 모든 실패 항목을 포함했다. Word 단위 검사 두 건은 현재 resultReadGuard 메서드를 빠뜨린 prototype fixture였다. SQL workflow 양성 네 건은 SQL Mission만 제공하고 성장 기억은 비영속 메모리에 둬 영속 저장 완료 조건에 걸렸다. 실제 SQLite 성장 기억 저장소를 연결했고, 파일 내용·G·원본 출처·재시작 완료 오라클은 유지했다. 저장소가 없을 때의 PAUSED/재실행0을 별도 양성 경계로 보존했다. 이 설정 오류를 제품의 기억 저장 조건을 낮춰 해결하지 않았다.

외부 발송 coverage fixture는 원문 objective와 명시 본인 수신 요구를 포함하지 않아 현재 source-bound 검사를 통과하지 못했다. 원문을 실제 Mission 계약과 일치시켰다. 잘못된 읽기·저장·첨부·실제 dispatch 대상 반례는 계속 거절한다. 검색 root fixture는 새 다중 디렉터리 계약의 명시 child/sibling 경로를 home으로 기대하던 오래된 단정이었다. 정확한 directory가 root로 잘못 접히지 않는지 검증하며 B의 허용 경로 검사를 그대로 둔다.

최종 복구 회귀105/105, 서로 다른 공유 경계69/69, 추가 영속 기억 검사9/9(앞선8건 중복·신규1건)이다. 고유 최종 사례는175건이다. 전체 1056건이 모두 통과했다고 표현하지 않는다. 빌드 성공. 시험 runner 시간은 복구${recovery.durationMs}ms·공유${boundaries.durationMs}ms·기억${memoryRequired.durationMs}ms이며 제품 p50/p95가 아니다. 외부 모델 호출0, 실제 비용은 미측정이다.

## 한계·복원·다음 작업

${verification.remaining} 실제 개인 계정/메일 전달/물리 기기/설치 업데이트는 이번 범위에 포함하지 않았다. 사용자 Word PID34724는 종료하지 않았고 마지막 관측에서 시작 시각과 생존 상태가 유지됐다. 운영 서비스는 재시작하지 않았다.

소스 snapshot은 변경 파일13개의 UTF-8 내용과 SHA를 보존한다. SHA는 무결성 자료이며 행동의 독립 검증이 아니다. 복원은 이 변경만 검토하여 적용하며 다른 작업·개인 DB·사용자 앱을 덮어쓰지 않는다. 다음 우선순위는 원격 실행의 최종 권한 검사와 준비도 인수의 미완료 연결을 기존 큐에서 이어 처리하는 것이다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-regression.txt`,`${prefix}-final-regression.txt`,`${prefix}-shared-boundaries.txt`,`${prefix}-memory-required.txt`,`${prefix}-current-build.txt`,'artifacts/mcp-local-cancel-fence-20261007-before.txt',`${prefix}-recovery-fixed.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'approval-task-restoration-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'현재 권한으로 미실행 승인 gate를 재생성하고 MCP discovery 뒤 취소를 재검사하면 재시작·취소 경계가 정상 실행과 분리된다.',
 lesson:'목표 수정의 drain과 사용자 취소는 다른 실행 의미다. 검증 report는 원래 taskId를 보존해야 기억 복구가 된다. SQL 원장만으로 영속 성장 기억을 대신할 수 없다.',limitations:verification.remaining+' 최종175고유 사례/build; 이전1056전체 재실행 없음; 실제계정 미검증; 전체46/100.'},null,2),{flag:'wx'});
for(const p of evidencePaths.slice(0,3))if(!gate.evidence.includes(p))gate.evidence.push(p);
gate.limitations.push('2026-10-07 승인 task 복원·MCP discovery 후 최종취소·원격G taskId 기억 복구 구현. 최종175고유 사례/build. 원격실제계정/프로세스원자 dispatch 인수 남음.');
acceptance.updatedAt=observedAt;assert.equal(hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))),requirementsHash);writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: pending 미실행 승인 Task 현재정책 재생성·HTTP MCP discovery후cancel calls0·원격 G taskId 보존/응답손실B1회 복구. 초기1056/11실패 보존→해당전체105회귀+공유69+기억delta1/빌드. 전체46/100/V3-029진행중; 원격실제연결 최종권한/다중프로세스 dispatch와 영속기억 미준비 사전안내가 남음.\n`);
console.log(JSON.stringify({verified:verification.verified,uniqueFinalCases:175,evidenceBytes:evidencePaths.reduce((n,p)=>n+readFileSync(p).length,0)}));
