import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/durable-memory-prerequisite-20261007';
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex');
const final=read(`${prefix}-verified.txt`);for(const pattern of [/tests 215\b/,/pass 215\b/,/fail 0\b/,/skipped 0\b/])assert.match(final,pattern);
assert.match(read(`${prefix}-final-build.txt`),/Built static/);
const observedAt=new Date().toISOString(),path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(path)),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.length,100);const originalRequirementsSha256=hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));
const verification={observedAt,verified:gates.filter(g=>g.status==='verified').length,acceptanceIds:['V3-029','V3-046'],originalRequirementsSha256,
 regression:{tests:215,pass:215,fail:0,skip:0,durationMs:Number(/duration_ms ([\d.]+)/u.exec(final)[1])},
 actualPaths:['SQL Mission + missing growth -> PAUSED/output absent/read0/shadow0/executedActions0/immutable intent0','Repeated missing store -> no workflow execution','Fresh runtime + persistent growth + current owner authorization -> same Mission COMPLETED/output42/execution1/growthEvent1','Distinct actual Core OS processes and loopback HTTP B survive cognition/growth/work-memory failures without duplicate workflow execution'],
 unitBoundaries:['ready persistent store','missing store','volatile in-memory SQLite','closed SQLite','restore generation conflict','query-only SQLite','JSON key reordering keeps same request','different path/op/array order/task/receipt rejects in planner and goal completion'],
 externalModelCalls:0,cost:'미측정',scope:'actual isolated temporary files/SQLite/OS-process and authenticated loopback HTTP tests; synthetic user/data; unit boundary claims separate from actual execution',
 remaining:'Read probe cannot guarantee later disk writes. Late storage failure still requires original receipt recovery. Live accounts, outbound workflow, other provider effect lifecycles, full format rendering and long observation remain outside this slice.'};
writeFileSync(`${prefix}-verification.json`,JSON.stringify(verification,null,2),{flag:'wx'});
const files=['packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/natural-workflow-mission-plan.js','packages/core/src/mission/workflow-natural-compiler.js','packages/core/src/mission/mission-requirement-coverage.js','tests/workflow-mandate-data-scope.test.js','tests/natural-workflow-snapshot-identity.test.js','tests/durable-memory-prerequisite.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 영속 기억 사전 확인과 SQL 작업 계획 복원

공식 인수율 **${verification.verified}/100 유지**. V3-029와 V3-046의 실제 불완전 경로를 보강했다. 원래 100개 요구·분모·인수 조건은 바꾸지 않았다.

## 실제 문제와 개선

이전에는 SQL Mission을 만들고 성장 기억 저장소를 누락하면 파일이 생성된 뒤 A_MISSION_EFFECT_GROWTH_NOT_PERSISTED로 중단됐다. 이제 SQL workflow의 최초 staging 전에 호스트가 영속 SQLite 성장 기억 저장소·열린 DB·현재 복원 세대·query_only 상태를 확인한다. 없다면 PAUSED/durable-memory-unavailable과 한국어 다음 조치를 반환하며 파일 생성·읽기·shadow·실행 횟수가 모두0이다. 인지 intent도 만들지 않으므로 실제 준비 조건을 갖춘 새 runtime에서 같은 Mission을 계속할 수 있다. staging 이후 비동기 권한 검사 동안 저장소가 바뀌는 경우를 위해 B handoff 직전에도 같은 검사를 한다. 읽기 목록 등 이 영속 workflow 계약과 무관한 도구를 새 조건으로 막지 않는다.

처음 추가한 재시작 양성 시험은 실패했다(${prefix}-restart.txt). SQL이 Mission 객체의 JSON 키를 정렬해 저장하기 때문에 기존 planner와 goal completion이 의미가 같은 spec도 원래 컴파일된 JSON 바이트 해시와 다르다고 거절했다. 처음 planner 수정 뒤에는 completion guard가 같은 오류를 유지해 verification-incomplete가 됐다(${prefix}-completion-diagnostic.txt). 두 경로 모두 수정했다.

수정은 배열 순서를 유지한 전체 구조 동등성으로 원문 계획을 대조하고, 실제 dispatch 때 저장한 workflowSpecSource의 정확한 바이트 해시를 G 관찰과 대조한다. 단순히 receipt hash 검사를 제거하지 않았다. workflowId·node count·taskId와 원래 요구 절·현재 산출물 검증도 유지한다. dispatch checkpoint는 WeakMap에 호스트 소유 문맥으로 보존하며 모델 prompt JSON에는 넣지 않는다. workspace 정규화용 context 파생에도 private binding을 이어 준다.

## 검증

최종22개 파일 **215/215 통과·실패0·제외0**, 전체 runner ${verification.regression.durationMs}ms. 빌드 성공. 이 시간은 실제 업무 p50/p95가 아니다. 앞선93·공유122·별도6을 중복 합산하지 않았다.

실제 로컬 파일/SQL 시험에서 저장소 미준비로 두 번 요청해도 출력이 생기지 않았고, 영속 저장소를 연결한 새 runtime와 현재 본인 권한으로 같은 Mission이 COMPLETED가 됐다. 값42·실행1회·성장 사건1개를 확인했다. 이미 실제 실행된 뒤 F/cognition 저장이 실패하는 별도 사례는 실제 Core kill/new PID와 인증된 loopback HTTP B에서 원래 영수증으로 복구하며 실행1회를 유지했다. 원격 endpoint를 바꾸거나 파일·intent를 변조하면 완료로 올리지 않는다.

저장소6상태와 계획6변형은 단위 경계 검사다. JSON 키만 정렬한 경우는 통과하지만 경로·operation·배열 순서·taskId·receipt 해시 변경은 planner와 goal completion 모두 거절한다. 이 단위 사례를 실계정 동작 증거로 표현하지 않는다. 외부 모델 호출0·비용미측정. 운영 서비스/사용자 계정/설치본 변경 없음. 기존 Word PID34724의 시작 시각과 생존 상태를 확인했고 종료하지 않았다.

## 한계와 다음 작업

${verification.remaining} 사전 읽기 검사가 성공해도 실제 디스크 부족·쓰기 오류를 예방한다고 보장하지 않는다. 그 경우 기존 영수증 기반 복구가 필요하다. missing store를 임의로 생성하거나 사용자 기억 DB를 교체하지 않았다.

V3-029/046은 미완료 제공자 경로 때문에 진행 중이다. 다음 구현 묶음은 V3-061의 Word·HWP/HWPX·PPT·PDF 구조와 렌더링을 현재 형식별 증거 및 실제 앱으로 대조하는 것이다. 기존 Word/PPT/PDF 자료를 재사용하고 HWP/HWPX의 실제 렌더링 부족부터 해결한다. 70% 목표는 활성 상태다.

변경 파일8개의 내용과 SHA를 source snapshot으로 보존했다. SHA는 무결성 자료일 뿐 행동 검증이나 제품 활성화 증거가 아니다. 복원은 이번 좁은 수정만 검토하여 되돌리고, 이전 사용자 작업·개인 기억·다른 변경은 보존한다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-restart.txt`,`${prefix}-restart-diagnostic.txt`,`${prefix}-completion-diagnostic.txt`,`${prefix}-verified.txt`,`${prefix}-identity-final.txt`,`${prefix}-final-build.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'durable-memory-prerequisite-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'영속 workflow 기억을 실행 전에 확인하고 실제 dispatch bytes와 원문 spec 구조를 각각 검증하면 미준비 부작용과 SQL key-order 복원 실패를 줄인다.',
 lesson:'원문 의미의 구조 동일성과 실행 영수증의 바이트 해시는 다른 검증이다. missing prerequisite에는 immutable intent를 만들지 않아야 새 runtime에서 같은 업무를 안전하게 이어갈 수 있다.',limitations:verification.remaining+' 215회귀/build; 전체46/100,실계정 미검증,비용미측정.'},null,2),{flag:'wx'});
for(const id of verification.acceptanceIds){const gate=gates.find(g=>g.id===id);assert.equal(gate.status,'in_progress');for(const p of evidencePaths.slice(0,3))if(!gate.evidence.includes(p))gate.evidence.push(p);gate.limitations.push('2026-10-07 SQL workflow 영속기억 사전조건/파일쓰기0·DB연결새runtime 동일Mission완료·JSON key-order 원문/receipt 이중검증.215회귀/build. 전체제공자·실계정·장기 인수 미완료.');}
acceptance.updatedAt=observedAt;assert.equal(hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))),originalRequirementsSha256);writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: SQL workflow 영속기억 미준비시 실행0/intent0·연결후새runtime동일Mission완료. SQL key-order 복구 실패의 planner/goalcompletion 이중수정·private context/byte receipt 보존·215회귀/build. 전체46/100,70%목표활성. 다음 V3-061 형식별 구조·렌더링 실제 검증(기존Word/PPT/PDF재사용,HWP/HWPX부족 우선).\n`);
console.log(JSON.stringify({verified:verification.verified,tests:215,evidenceBytes:evidencePaths.reduce((n,p)=>n+readFileSync(p).length,0)}));
