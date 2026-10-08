import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/mcp-input-binding-20261007', observedAt = new Date().toISOString();
const read = p => readFileSync(p, 'utf8').replace(/^\uFEFF/u, ''), hash = v => createHash('sha256').update(v).digest('hex');
const log = read(`${prefix}-final.txt`);
for (const pattern of [/tests 69\b/u, /pass 69\b/u, /fail 0\b/u, /skipped 0\b/u, /real HTTP discovery-time mutation/u]) assert.match(log, pattern);
assert.match(read(`${prefix}-negative.txt`), /fail 2\b/u);
assert.match(read(`${prefix}-build.txt`), /Built static JARVIS/u);
assert.match(read(`${prefix}-contract.txt`), /gatePassed: true/u);
const path = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(path)), gates = acceptance.stages.flatMap(s => s.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(g => g.status === 'verified').length, 49);
const originalRequirementsSha256 = hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement }))));
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, acceptanceIds: ['V3-029', 'V3-031', 'V3-040'], originalRequirementsSha256,
  tests: { files: 8, passed: 69, failed: 0, skipped: 0, durationMs: Number(log.match(/duration_ms ([\d.]+)/u)[1]) },
  negativeControl: { snapshotIntentionallyDisabled: true, executed: 2, failed: 2 }, actualLoopbackHttp: true, actualSqlite: true,
  externalProviderCalls: 0, measuredCost: null, productLatencyPercentiles: null, buildPassed: true, coreContractPassed: true,
  completedAcceptanceIds: [], verified: 49, operatingServicesUpdated: false,
  limitations: ['MCP 입력/정책 인자의 동일성 보강이며 전체 자료 종류·목적의 클라우드 전송 정책 인수는 아님', '로컬 MCP 서버의 내부 외부 네트워크 행동은 이번 통제 범위가 아님'] }, null, 2), { flag: 'wx' });
const sources = ['packages/core/src/personal-operations/mcp-connections.js', 'tests/mcp-execution.test.js'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: sources.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# MCP 실행 입력·정책·기록 동일성 보강

관측 ${observedAt}. 공식 인수 **49/100 유지**. V3-029/031/040의 부분 증거를 보강했다.

## 발견과 수정

MCP call은 비동기 도구 probe/실행-session 조회 뒤 caller 입력 객체를 다시 사용했다. 조회나 정책 callback 동안 객체가 변경되면 검증한 인자, requestId, expectedText와 실제 tools/call이 달라질 수 있었다. 입력을 최초에 JSON 계약으로 검사하고 별도 깊은 불변 snapshot을 만든 뒤 모든 검사·정책·기록·전송에서 그 snapshot만 사용한다. 순환/비JSON/비유한수/접근자/과도한 크기·깊이·희소배열도 discovery 전에 거부한다.

두 권한 callback에 동일 arguments와 요청 ID·endpoint hash·arguments hash·명시 MCP 호출 목적을 제공한다. 원본 인자를 이력 DB에 저장하지 않고 hash로 대조한다. 이 callback이 자료 분류 정책 전체를 자동 구현하는 것은 아니다. 외부/불가역 capability와 최종 grant/permission revision/실행-session manifest 검사는 유지한다.

## 실행 증거

새 mutation·비정상JSON·실제HTTP mutation 시험3건을 추가했다. 실제 loopback HTTP server의 tools/list 응답 중 호출자 인자·ID를 변경해도 원래 선택한 2+3만 한 번 실행하며 원래 requestId와 journal hash가 유지됐다. 정책 hook에서 바꾼 caller 객체도 실행 인자에 영향을 주지 않았다. snapshot만 의도적으로 끈 반례 구성에서 두 mutation 시험 모두 실패해 검사의 판별력을 확인했다. 이는 정확한 이전 전체 빌드 재현이 아니라 명시적인 기능 제거 음성 대조다.

MCP 수동/검토된 문서·패키지·Mission·SQL 프로세스 복구 등 **8파일69/69**, 실패/제외0. 빌드와 Core 계약 gate 통과. 실제 HTTP/SQLite와 격리 fixture 자료이며 실계정/외부 제공자 호출·비용·제품 p50/p95는 미측정이다.

## 인수 한계·복원

전체 자료 종류/목적별 외부 전송 정책, 다른 계정/기기, MCP 서버 내부의 외부 통신, 모든 제공자 효과의 hash/영수증 인수는 남았다. MCP 입력 계약을 지켰다는 이유로 V3-031 전체를 승격하지 않았다. 운영 서비스/설치본을 변경하지 않았고 사용자 기억/비밀을 시험에 쓰지 않았다. 복원은 새 snapshot과 정책 인자 전달에 한정하되 이를 제거하면 음성 대조에서 드러난 입력 변경 위험이 돌아온다. 저장된 기존 원장·수신함·기억은 보존한다. 소스 hash는 보존 검사이며 결론의 독립 검증이 아니다.

최소70% 목표는 활성으로 유지한다. 다음은 실제 전송을 허용하는 각 경로의 자료 종류/목적 계약과 정책 결정을 연결하는 작업이다.
`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-first.txt`, `${prefix}-final.txt`,
  `${prefix}-negative.txt`, `${prefix}-no-snapshot.mjs`, `${prefix}-negative-test.mjs`, `${prefix}-build.txt`, `${prefix}-contract.txt`];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'mcp-input-binding-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test',
  reportedOutcome: 'passed', observedAt, evidencePaths, hypothesis: '비동기 도구 조회 전 불변 JSON snapshot을 만들면 검사·정책·전송·기록의 인자가 동일하게 유지된다.',
  lesson: '정책 callback에 실제 인자와 목적/대상 해시를 전달해야 한다. hash는 원문 저장을 대체할 수 있지만 전체 자료 분류 정책의 대체물은 아니다.',
  limitations: '실제loopbackHTTP/SQLite·격리69/69·snapshot제거 음성대조2실패. 실제계정/전체egress/서버내부망 미검증. 공식49/100·최소70목표활성.' }, null, 2), { flag: 'wx' });
for (const id of ['V3-029', 'V3-031', 'V3-040']) {
  const gate = gates.find(g => g.id === id); assert.equal(gate.status, 'in_progress');
  gate.reviewedAt = observedAt; gate.evidence.push(...evidencePaths.slice(0, 3));
  gate.limitations.push('2026-10-07 MCP caller 입력 불변snapshot·정책 인자/목적/hash·실제HTTP mutation·69/69. 전체 자료별egress/실계정/전체효과 인수 미완료.');
}
assert.equal(hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement })))), originalRequirementsSha256);
acceptance.updatedAt = observedAt; writeFileSync(path, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: MCP mutable caller 입력을 최초 불변snapshot에 고정·정책/실제전송/SQLhash 동일성·실제HTTP mutation 반례·69/69/build/contract. 공식49/100 유지, 전체egress 인수 별도, 최소70목표활성.\n`);
console.log(JSON.stringify({ verified: 49, evidenceBytes: evidencePaths.reduce((s, p) => s + readFileSync(p).length, 0) }));
