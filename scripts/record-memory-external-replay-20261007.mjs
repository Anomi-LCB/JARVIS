import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/memory-external-replay-20261007', observedAt = new Date().toISOString();
const read = p => readFileSync(p, 'utf8').replace(/^\uFEFF/u, ''), hash = v => createHash('sha256').update(v).digest('hex');
const focused = read(`${prefix}-focused.txt`), broader = read(`${prefix}-final.txt`);
for (const p of [/tests 48\b/u, /pass 48\b/u, /fail 0\b/u, /skipped 0\b/u,
  /remote HTTP workflow fail-growth recovers/u, /remote HTTP workflow fail-work-false recovers/u,
  /remote HTTP workflow fail-episode recovers/u, /remote HTTP workflow fail-outcome recovers/u, /remote HTTP workflow fail-goal recovers/u]) assert.match(focused, p);
for (const p of [/tests 126\b/u, /pass 113\b/u, /fail 0\b/u, /skipped 13\b/u,
  /HTTP B receipt survives Core cognition failure and termination/u]) assert.match(broader, p);
const acceptancePath = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(acceptancePath)), gates = acceptance.stages.flatMap(s => s.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(g => g.status === 'verified').length, 49);
const gate = gates.find(g => g.id === 'V3-046'); assert.equal(gate.status, 'in_progress');
assert.equal(gate.requirement, 'F/cognition 저장 실패의 재처리가 외부 B 실행을 반복하지 않음을 확인한다.');
const originalRequirementsSha256 = hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement }))));
const audit = [
  { clause: 'F 저장 실패', proof: '성장 event 저장 throw·작업기억 throw/null. 원래 작업 수행 후 PAUSED, 실제Core kill, 새PID에서 같은 실패 반복도 B HTTP POST/파일효과1. 복구 뒤 성장/작업기억1.' },
  { clause: 'cognition 저장 실패', proof: 'episode·outcome·goal SQL trigger 실패. 별도HTTP B 복합작업 끝난 뒤 Core kill. trigger 유지한 새Core는 PAUSED, trigger복원 후 COMPLETED/episode1/B1. 별도B child 단일파일도 같은 조건 검사.' },
  { clause: '재처리', proof: '새Core PID 재복구/반복복구에서 원래 SQL intent·B receipt·현재 파일·G를 대조. metadata의 다른사용자/대화 덮어쓰기에도 원래 기억 scope 유지. 실행 endpoint 변경은 복구 보류.' },
  { clause: '외부 B 실행 미반복', proof: '실제 인증 loopbackHTTP POST와 workflow 실제 호출 각각1. 별도B/Core 프로세스 단일파일 및 외향 mTLS artifact채널 followup/F미저장ACK차단 회귀. 미지원 외향복합작업은 실행 전 차단.' }
];
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, acceptanceId: gate.id, originalRequirement: gate.requirement, originalRequirementsSha256, audit,
  focused: { files: 7, total: 48, passed: 48, failed: 0, skipped: 0, durationMs: Number(focused.match(/duration_ms ([\d.]+)/u)[1]) },
  broader: { files: 9, total: 126, passed: 113, failed: 0, skipped: 13, durationMs: Number(broader.match(/duration_ms ([\d.]+)/u)[1]),
    skippedReason: 'Linux 전용 OS 접근 거부·사용자 분리 반례. Windows에서 미실행이며 완료로 계산하지 않음.' },
  actualCoreProcessesKilled: true, actualExternalBHttp: true, actualSqlite: true, actualFiles: true, actualG: true,
  syntheticInputAndTrust: true, externalAccountCalls: 0, measuredCost: null, productLatencyPercentiles: null,
  runtimeCodeChanged: false, operatingServicesUpdated: false, completedAcceptanceIds: ['V3-046'], verified: 50 }, null, 2), { flag: 'wx' });
const sources = ['tests/workflow-memory-remote.test.js', 'tests/fixtures/workflow-cognition-process-child.mjs', 'tests/workflow-memory-followup.test.js',
  'tests/workflow-cognition-process.test.js', 'tests/remote-mission-effect.test.js', 'tests/outbound-operation-artifact.test.js',
  'packages/core/src/mission/mission-effect-coordinator.js', 'packages/core/src/mission/mission-action-recovery.js',
  'packages/core/src/mission/workflow-cognition-intent-store.js', 'packages/core/src/mission/recovered-memory-scope.js'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: sources.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# F/cognition 재처리와 외부 B 단회 실행 인수 감사

관측 ${observedAt}. 원래 V3-046 요구의 네 명시 부분을 소스와 실제 실행으로 대조해 **공식49→50/100**으로 승격한다. 전체 자연어/모든 미래 제공자 성공률의 숫자가 아니다.

## 부족했던 시험과 추가 관측

기존 실제 HTTP B/F/work-memory 실패 시험에 cognition episode/outcome/goal 저장 경계3건을 추가했다. 각각 SQL trigger로 실패시킨 뒤 Core를 실제 강제종료했다. 새Core가 동일 trigger를 유지하면 PAUSED, trigger를 복원하면 원래 Mission이 완료되고 외부 B 호출1/episode1/성장event1/작업기억1을 유지했다. 성장기억/작업기억 throw/null 실패도 새Core에서 반복 실패를 유지하는 경계를 보강했다. 회복이 끝나기 전 완료를 표시하지 않았고 복구를 다시 반복해도 B 실행이 늘지 않았다.

실제 JSON 읽기·개수 확인·저장 복합작업과 인증된 별도HTTP B를 사용했다. 호출 POST와 실제 workflow execute를 각각 세어1로 대조했다. 새Core의 metadata 사용자/대화가 달라도 원래 SQL intent와 task scope로 기억을 복구했다. 다른 endpoint로의 재지정은 보류했다. 합성 자료/신원/권한이며 실제 사용자 기억이나 공급자 계정은 사용하지 않았다.

## 원래 요구의 감사

${audit.map(a => `- **${a.clause}**: ${a.proof}`).join('\n')}

필수 집중 **7파일48/48, 제외0**. 더 넓은 단일파일·B child 종료·응답유실·외향 artifact·G·기억 회귀는 **9파일126건 중113통과/13미실행/실패0**. 13건은 Linux 전용 OS 사용자/파일 접근 분리 검사로 Windows에서 제외되며 통과로 세지 않는다. 그 조건의 완료 증거는 이번 감사에 포함하지 않는다. 별도 Core/B child의 cognition 실패 및 기존 단일파일 증거는 실제 실행돼 통과했다.

현재 product runtime 코드는 이 작업에서 수정하지 않았다. 부족했던 원격 복합작업 실패/지속 실패 시험과 인수 증거를 추가했다. 실행 가능한 기존 경로에서 원래 요구를 충족한 증거로 판정하고, 기존 reviewHistory에 이전 부분 증거와 미확인 이력을 보존했다. 소스 hash는 보존 검사이며 결론/의미 검증의 대체물이 아니다.

## 한계·복원

실메일·결제·다른물리PC·Windows서비스 재부팅·클라우드 Linux 격리·30일 관측은 이번 시험이 아니며 다른 인수항목으로 남는다. 미지원 외향 복합workflow는 준비도 단계에서 실행하지 않으며 활성화됐다고 표시하지 않는다. 임의 미래의 모든 B/공급자 장애를 보증하지 않는다. 실제비용/제품p50/p95는 미측정이다. 테스트 child는 모두 종료했고 운영 서비스/설치본을 바꾸지 않았다. 복원은 새 시험/fixture모드/인수감사에 한정하며 사용자 원장·기억·파일을 유지한다.

최소70% 목표는 활성으로 유지한다.
`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-first.txt`, `${prefix}-focused.txt`, `${prefix}-final.txt`];
assert.ok(evidencePaths.reduce((s, p) => s + readFileSync(p).length, 0) < 4 * 1024 * 1024);
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'memory-external-replay-20261007', candidateId: 'agent-platform-observed-scenario-status',
  kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: '원래F/cognition 저장 실패 조건을 실제 외부HTTP B·Core kill·반복실패/복구로 대조하면 기억 재처리가 B를 반복하는지 확인할 수 있다.',
  lesson: '기억 완료는 실행 성공과 별개다. 원래 SQL intent/receipt/G로 복구하며 실패가 지속되면 완료/재실행 대신 보류하고 실행 호출수를 직접 대조해야 한다.',
  limitations: '필수48/48. 확대113통과13Linux전용미실행0실패. 실제Core/B HTTP·합성자료. 실제계정/장기관측/모든미래채널 별도. 공식50/100·70목표활성.' }, null, 2), { flag: 'wx' });
gate.reviewHistory ??= []; gate.reviewHistory.push({ status: gate.status, evidence: [...gate.evidence], limitations: [...gate.limitations], reviewedAt: gate.reviewedAt ?? null, supersededAt: observedAt });
gate.status = 'verified'; gate.reviewedAt = observedAt; gate.evidence.push(...evidencePaths.slice(0, 3));
gate.limitations = ['2026-10-07 원래 F/cognition 재처리·외부B 미반복 요구를 실제HTTP/SQL/Core kill·persistent failure·단일/복합파일/G로 감사. 필수48/48·확대113통과13Linux전용미실행. 실제계정/다른PC/미지원외향복합 활성화/서비스재부팅/장기관측·임의미래채널 보증은 별도.'];
assert.equal(gates.filter(g => g.status === 'verified').length, 50);
assert.equal(hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement })))), originalRequirementsSha256);
acceptance.updatedAt = observedAt; writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 원래046 F/cognition 저장 실패/지속 실패·실제 외부HTTP B·Core kill·기억복구 단회감사. 필수48/48,확대113통과13Linux미실행. 공식49→50/100. 실제계정/미지원채널/장기관측 별도·최소70목표활성.\n`);
console.log(JSON.stringify({ verified: 50, evidenceBytes: evidencePaths.reduce((s, p) => s + readFileSync(p).length, 0) }));
