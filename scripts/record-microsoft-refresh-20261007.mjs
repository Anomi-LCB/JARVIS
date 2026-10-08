import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/microsoft-refresh-20261007', observedAt = new Date().toISOString();
const read = p => readFileSync(p, 'utf8').replace(/^\uFEFF/u, '');
const hash = v => createHash('sha256').update(v).digest('hex');
const before = read(`${prefix}-before-focused.txt`), log = read(`${prefix}-final.txt`);
assert.match(before, /fail 3\b/u);
for (const pattern of [/tests 51\b/u, /pass 51\b/u, /fail 0\b/u, /skipped 0\b/u, /actual Windows DPAPI/u, /same connection concurrent refresh/u]) assert.match(log, pattern);
assert.match(read(`${prefix}-build.txt`), /Built static JARVIS/u);
assert.match(read(`${prefix}-contract.txt`), /gatePassed: true/u);
const acceptancePath = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(acceptancePath));
const gates = acceptance.stages.flatMap(s => s.gates), gate = gates.find(g => g.id === 'V3-073');
assert.equal(gates.length, 100); assert.equal(gates.filter(g => g.status === 'verified').length, 49); assert.equal(gate.status, 'in_progress');
const requirementsSha256 = hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement }))));
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, acceptanceId: gate.id, originalRequirement: gate.requirement,
  originalRequirementsSha256: requirementsSha256, tests: { files: 9, passed: 51, failed: 0, skipped: 0, durationMs: Number(log.match(/duration_ms ([\d.]+)/u)[1]) },
  beforeFocusedFailed: 3, beforeBroadInterrupted: true, actualWindowsDpapi: true, actualIsolatedVaultReopening: true,
  syntheticTokenAndGraph: true, actualOAuthLogin: false, externalProviderCalls: 0, measuredCost: null,
  productLatencyPercentiles: null, buildPassed: true, coreContractPassed: true, operatingServicesUpdated: false,
  verified: 49, completedAcceptanceIds: [], limitation: '단일Core 동기 CAS·reader 내부 경쟁 제어. 다른 프로세스의 vault 동시 쓰기·실제Microsoft 인증·전체OAuth 수명주기는 미검증.' }, null, 2), { flag: 'wx' });
const sourcePaths = ['packages/core/src/personal-operations/integration-security.js', 'packages/core/src/personal-operations/microsoft-source-reader.js',
  'packages/core/src/main.mjs', 'tests/microsoft-refresh-lifecycle.test.js', 'docs/microsoft-source-adapters.md'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: sourcePaths.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# Microsoft 갱신 토큰 수명주기 보강

관측 ${observedAt}. 공식 인수 **49/100 유지**, V3-073 진행 중.

기존 reader는 새 refresh token을 보관하지 않았다. Microsoft 공식 OAuth 문서의 갱신 토큰 교체 조건과 대조해 보호된 vault에 새 토큰을 저장하도록 연결했다. Graph 호출 전에 공개 연결 상태와 기존 전체 자격증명을 비교한다. 동일 시각에 변경된 비밀/권한도 거부하고 계정·scope·grants는 수정하지 않는다. 보호된 쓰기 실패는 이전 파일을 유지하고 Graph를 호출하지 않는다. 저장 후 Graph가 실패해도 새 토큰은 보존하며 자동 재시도하지 않는다.

동일 reader/연결의 중첩 갱신을 409로 거부하고 성공/실패 후 잠금을 해제한다. 서로 다른 연결을 전역 직렬화하지 않는다. bearer token은 JWT로 해석하지 않으며 합법적인 불투명 토큰 문자와 trailing padding을 허용하고 CR/LF 삽입·과도한 길이·다른 token_type을 거부한다. 새 refresh token도 형식을 확인하며 원본 토큰을 결과/로그에 반환하지 않는다.

## 재현·검증

앞선 보존 snapshot에서 old reader를 복원해 새토큰/Graph실패/DPAPI재열기 3개 양성 조건을 검사하면 3건 실패했다. 이 재현은 호환 bearer 값으로 바꿔 token 문자 검사를 통과시켰다. fixture가 Graph 진입 시 이전 토큰 보관을 발견해 실패했고 old reader의 네트워크 오류 정규화로 A_MICROSOFT_NETWORK_UNAVAILABLE로 표시됐다. 전체 old 검사에서는 동시성 반례가 중첩 요청을 정지시켜 도구 handle을 중단했고 로그를 보존했다. 이후 범위를 명시한 3건만 재현했다. 중단 결과를 시험 통과로 계산하지 않는다.

최종 새 수명주기 8건과 기존 8파일 회귀를 합쳐 **9파일51/51**, 실패/제외0. 실제 Windows DPAPI와 격리 vault 파일·새 vault 인스턴스 복호화를 검사했다. 기존 Core HTTP/SQLite/생산구성·Google·보관함 인계·모바일 gateway 회귀도 포함했다. API/build gate 통과. 합성 토큰/Graph 응답이며 실제 Microsoft 로그인 또는 provider 호출은 없다. 실제 비용·제품 p50/p95는 미측정.

## 한계와 복원

vault 교체는 단일 Core의 동기 비교·보호된 파일 쓰기다. 여러 OS 프로세스가 같은 vault를 동시에 변경하는 분산 잠금의 보증이 아니다. 전체 OAuth 로그인/PKCE·실계정 신원·토큰 철회·연결 화면·본문/발송/증분 수집·위임/Mission/G 전체계약은 남아 인수 승격하지 않았다. 운영 서비스·사용자 자격증명을 교체하지 않았다. 복원 시 reader의 새토큰 처리와 신규 vault 메서드를 함께 되돌리되 저장된 신형 토큰을 구형으로 되감지 않는다. 기존 사용자 원장·기억·scope/grants는 보존한다.

공식 근거: [Microsoft OAuth](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow). 저장 snapshot/hash는 보존 증거이며 실제 동작 검증의 대체물이 아니다. 최소70% 목표는 활성으로 유지한다.
`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-before.txt`, `${prefix}-before-focused.txt`,
  `${prefix}-before-reader.mjs`, `${prefix}-before-test.mjs`, `${prefix}-first.txt`, `${prefix}-final.txt`, `${prefix}-build.txt`, `${prefix}-contract.txt`];
assert.ok(evidencePaths.reduce((s, p) => s + readFileSync(p).length, 0) < 4 * 1024 * 1024);
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'microsoft-refresh-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'runtime-connection',
  reportedOutcome: 'passed', observedAt, evidencePaths, hypothesis: '새refresh token을 보호 저장하고 동일 연결 경쟁을 제어하면 구형token 재사용과 갱신 충돌을 막을 수 있다.',
  lesson: '단일Core에서 비밀값과 권한을 비교한 뒤 보호 저장하며 Graph 실패에도 갱신token을 유지해야 한다. 파일 재조회와 실제DPAPI 증거를 분리한다.',
  limitations: '51/51·실제DPAPI/격리vault·합성Graph. 실제OAuth/분산vault쓰기/전체Mission 계약 미완료. 공식49/100, 최소70목표활성.' }, null, 2), { flag: 'wx' });
gate.reviewedAt = observedAt; gate.evidence.push(...evidencePaths.slice(0, 3));
gate.limitations.push('2026-10-07 refresh token 보호 교체·동일reader 경쟁 거부·scope/비밀 동일시각 CAS·실제DPAPI 재열기·51/51. 실계정/OAuth전체/다중프로세스 vault 쓰기/전체Mission 계약 미완료.');
assert.equal(hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement })))), requirementsSha256);
acceptance.updatedAt = observedAt; writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: Microsoft 새refresh token 보호 저장/경합 차단/실제DPAPI 새vault 복원·51/51/build/contract. 원래073진행중·공식49/100 유지. 실OAuth·전체계약 별도, 최소70목표활성.\n`);
console.log(JSON.stringify({ verified: 49, evidenceBytes: evidencePaths.reduce((s, p) => s + readFileSync(p).length, 0) }));
