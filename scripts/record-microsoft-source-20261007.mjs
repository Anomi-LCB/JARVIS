import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/microsoft-source-20261007', observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const log = read(`${prefix}-checked.txt`);
for (const pattern of [/tests 43\b/u, /pass 43\b/u, /fail 0\b/u, /skipped 0\b/u,
  /configured production Core factory/u, /real Core ADMIN route/u, /revoked or replaced credentials/u]) assert.match(log, pattern);
assert.match(read(`${prefix}-build-checked.txt`), /Built static JARVIS/u);
assert.match(read(`${prefix}-contract-checked.txt`), /gatePassed: true/u);
const acceptancePath = 'docs/universal-control-v3-acceptance.json';
const acceptance = JSON.parse(read(acceptancePath)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 49);
const gate = gates.find(gate => gate.id === 'V3-073'); assert.equal(gate.status, 'pending');
const requirementsSha256 = hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement }))));
const durationMs = Number(log.match(/duration_ms ([\d.]+)/u)[1]);
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, acceptanceId: gate.id, originalRequirement: gate.requirement,
  originalRequirementsSha256: requirementsSha256, tests: { files: 8, total: 43, passed: 43, failed: 0, skipped: 0, durationMs },
  actualCoreHttp: true, actualSqlite: true, actualConfiguredRuntimeFactory: true, syntheticGraphAndVault: true,
  externalProviderCalls: 0, actualOAuthLogin: false, realAccountVerified: false, metadataOnly: true,
  buildPassed: true, coreContractPassed: true, runtimeCodeChanged: true, operatingServicesUpdated: false,
  measuredCost: null, cost: '미측정', productLatencyPercentiles: null, completedAcceptanceIds: [], verified: 49,
  limitations: ['실제 Microsoft OAuth/실계정은 미검증', '본문·첨부·발송·증분 동기화·사용자 연결 화면 미구현', '위임/Mission/G 완료 계약의 전체 연결은 후속 작업'] }, null, 2), { flag: 'wx' });
const paths = ['packages/core/src/personal-operations/microsoft-source-reader.js', 'packages/core/src/personal-operations/integration-security.js',
  'packages/core/src/personal-operations/source-inbox.js', 'packages/core/src/main.mjs', 'scripts/core-service-runtime.mjs',
  'tests/microsoft-source-reader.test.js', 'docs/microsoft-source-adapters.md'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: paths.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# Outlook·Teams 후속 읽기 어댑터 구현

관측: ${observedAt}. 공식 인수 **49/100 유지**. V3-073은 pending→in_progress이며 원래 요구/분모를 유지했다.

## 실제로 연결한 동작

기존 Core connector registry·보호된 vault·PersonalSourceInbox를 재사용해 두 개의 별도 읽기 어댑터를 구성했다. Outlook은 Mail.ReadBasic으로 본인 메일 ID·제목 목록, Teams는 Chat.Read로 명시 채팅의 ID·제목·삭제 표시를 조회한다. Teams의 제목 없는 메시지는 목록용 표시일 뿐 본문 요약이 아니다. GET Graph 고정 경로와 다음 페이지 검사를 거쳐 실제 SQLite 페이지 transaction·cursor CAS·replay로 저장한다.

Core 생산 구성 함수에 reader를 연결했고 ADMIN 상태/페이지 API와 OpenAPI 계약을 추가했다. 조회 중 로컬 철회·보관 자격증명 변경은 결과를 폐기한다. 다른 호스트·계정·채팅의 페이지, 잘못된 scope·응답·중복 행을 거부한다. 비밀/본문은 결과에 포함하지 않으며 외부 문장의 지시는 검토할 자료로만 남긴다. 토큰 갱신/Graph 오류는 공개 상태 코드와 한국어 다음 조치로 반환한다.

## 실행 증거와 실패 수정

실제 Core HTTP·SQLite·생산 구성 함수와 합성 Graph/vault를 사용했다. 계정 분리, 두 제공자 페이지, replay, 권한 철회 및 credential rotation, 잘못된 nextLink와 응답, 기존 Google·자격증명 인계·모바일 gateway·Mission authority 회귀를 함께 실행해 **8파일43/43**, 실패/제외0, runner ${durationMs}ms. 빌드와 Core 계약 gate도 통과했다. 이 시간은 제품 p50/p95가 아니다.

처음 7건 실패는 기존 credential whitelist에 tenantId가 없어 connector 등록이 거부된 원인이었다. 새 connector가 필요로 하는 식별 필드를 추가하고 기존 connector별 exact schema 제약은 유지했다. 이후 생산 구성 검사는 테스트 vault가 save 인터페이스를 빠뜨려 1건 실패했다. fixture에 쓰기 금지 save 인터페이스를 추가해 생산 구성 조건을 맞췄다. 초기 실패와 수정 후 증거를 모두 보존했다.

## 미완료와 인수 판단

실제 Microsoft API 호출·OAuth 로그인·계정 신원 검증은 이번 실행에 없다. 로그인 helper/PKCE, 안전한 refresh token 교체 수명주기, 위임된 기간/자료 범위, 증분 수집, 본문·첨부·발송, 독립 결과 검증과 연결별 UI는 남았다. reader의 status는 realAccountVerified/automaticSync를 false로 표시한다. 수동 메타데이터 수집을 범용 메일/메신저 자율 업무 완료로 확대하지 않는다.

따라서 V3-073 전체 동일 실행 계약의 완료 증거는 아직 부족해 진행 중으로만 바꿨다. 운영 서비스/설치본은 교체하지 않았고 실제 사용자 기록/자격증명/원장은 시험에 쓰지 않았다. 외부 비용과 제품 지연은 미측정이다. 복원은 새 reader와 Core API/생산 구성 연결을 제거하는 범위이며 이미 저장된 수신함/Google/기억 자료는 유지한다. 소스 해시는 보존 검사이며 실험 결론의 독립 검증이 아니다.

공식 조건과 지원 범위는 [어댑터 설계서](../docs/microsoft-source-adapters.md)에 기록했다. 다음 작업은 공식 로그인·신원·토큰 수명주기와 위임/결과 계약 연결이다. 최소70% 인수 목표는 활성으로 유지한다.
`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-first.txt`,
  `${prefix}-second.txt`, `${prefix}-final.txt`, `${prefix}-final-proof.txt`, `${prefix}-checked.txt`, `${prefix}-build-checked.txt`, `${prefix}-contract-checked.txt`];
assert.ok(evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) < 4 * 1024 * 1024);
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'microsoft-source-20261007', candidateId: 'agent-platform-observed-scenario-status',
  kind: 'runtime-connection', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: '기존 보호된 vault와 원자적 inbox 페이지 계약에 공식 Microsoft 읽기 어댑터를 연결하면 계정/페이지 범위를 유지하며 자료를 실행 권한 없이 수집할 수 있다.',
  lesson: '생산 구성 함수까지 연결해 확인해야 하며 provider scope/경로/철회/비밀 경계와 metadata-only 범위를 명시해야 한다. 준비된 fixture 성공은 실제 OAuth 연결 성공이 아니다.',
  limitations: '실제Core HTTP/SQLite·합성Graph/vault43/43. OAuth/실계정/본문/발송/증분/위임 전체계약 미완료. V3-073진행중, 공식49/100, 최소70목표활성. 비용/제품p50/p95미측정.' }, null, 2), { flag: 'wx' });
gate.status = 'in_progress'; gate.reviewedAt = observedAt; gate.evidence.push(...evidencePaths.slice(0, 3));
gate.limitations.push('2026-10-07 Outlook/Teams 명시 metadata-only 읽기 어댑터·생산Core HTTP/SQL 연결43/43. 실제OAuth·본문/첨부/발송·증분·위임/Mission/G 전체계약·연결UI는 미완료.');
assert.equal(gates.filter(item => item.status === 'verified').length, 49);
assert.equal(hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement })))), requirementsSha256);
acceptance.updatedAt = observedAt; writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: Outlook/Teams metadata-only reader를 기존vault/생산Core/SQLite inbox 연결·43/43, 빌드/계약통과. V3-073 pending→in_progress, 공식49/100. 실제OAuth·전체위임/결과계약·본문/발송/연결UI별도, 최소70목표활성.\n`);
console.log(JSON.stringify({ verified: 49, inProgress: gates.filter(item => item.status === 'in_progress').length,
  pending: gates.filter(item => item.status === 'pending').length, evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
