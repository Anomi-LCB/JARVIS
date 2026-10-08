import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/microsoft-request-binding-20261007', observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''), hash = value => createHash('sha256').update(value).digest('hex');
const before = read(`${prefix}-before.txt`), after = read(`${prefix}-regression.txt`);
for (const pattern of [/tests 4\b/u, /fail 4\b/u, /actual: 'teams-chat'/u, /actual: 'outlook'/u, /CONNECTION_REQUIRED/u, /Missing expected rejection/u]) assert.match(before, pattern);
for (const pattern of [/tests 40\b/u, /pass 40\b/u, /fail 0\b/u, /skipped 0\b/u, /pins request provenance/u, /actual Windows DPAPI/u]) assert.match(after, pattern);
assert.match(read(`${prefix}-build.txt`), /Built static JARVIS/u);
assert.match(read(`${prefix}-contract.txt`), /gatePassed: true/u);
const sources = ['packages/core/src/personal-operations/microsoft-source-reader.js', 'tests/microsoft-source-reader.test.js',
  'tests/microsoft-refresh-lifecycle.test.js', 'packages/core/src/personal-operations/source-inbox.js', 'docs/microsoft-source-adapters.md'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: sources.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, reproducedFailures: 4, finalTests: 40, passed: 40, failed: 0, skipped: 0,
  durationMs: Number(after.match(/duration_ms ([\d.]+)/u)[1]), buildPassed: true, contractPassed: true,
  realCoreHttp: true, realSqlite: true, realWindowsDpapi: true, simulatedMicrosoftProvider: true,
  externalAccountCalls: 0, paidCalls: 0, measuredCost: null, productLatencyPercentiles: null, operatingServicesUpdated: false,
  acceptanceIds: ['V3-073'], status: 'in_progress', verified: 51 }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# Microsoft 요청 대상과 출처의 비동기 고정\n\n관측 ${observedAt}. 공식 인수율 **51/100 유지**, V3-073 진행 중.\n\n## 결함과 수정\n\n기존 reader는 조회 경로를 먼저 만들지만 비동기 작업 후의 connection 확인·provider/account/scope/cursor 반환·잠금 해제에는 호출자가 소유한 원래 job 객체를 다시 읽었다. Outlook 요청 도중 provider를 Teams로 바꾸면 Outlook에서 읽은 결과를 Teams 출처로 반환했고 반대도 가능했다. connectionId를 바꾸면 원래 연결 잠금이 해제되지 않는 경로가 있었다. getter가 있는 cursor도 실행됐다. 수정 전 신규4시험 모두 실패로 재현했다.\n\n이제 첫 await 전에 명시 JSON 데이터 필드를 복사·고정한다. 인증·요청·관측·출처·finally 잠금 해제가 같은 요청을 사용한다. accessor/숨김/상속/symbol/비문자열 필드는 제공자 호출 전에 거부한다. 호출자 객체 자체를 변경하지 않는다. 권한 철회·자격증명 교체는 기존의 현재상태 재조회로 계속 거부하며 snapshot을 권한 캐시로 사용하지 않는다.\n\n## 실행 증거\n\n최종6파일 **40/40 통과, 실패0, 미실행0**. 원래 OAuth 최소권한·pagination·철회·refresh rotation·동시 연결 거부·실제 Windows DPAPI 재열기·Core ADMIN HTTP·SQLite 수집·수집 revision 회귀 포함. 새 두 공급자 변형 시험은 바뀐 요청을 무시하고 원래 provider/account/chat scope의 SQLite stream hash와 항목을 대조한다. 실제 Microsoft 공급자 대신 합성 fetch를 사용했다. build와 Core contract gate 통과.\n\n초기 focused 로그18건은 reader와 inbox 검사만 실행됐다. 잘못 지정한 refresh-rotation 파일명은 증거로 세지 않고, 실제 microsoft-refresh-lifecycle 파일을 명시한 최종40건을 인수 증거로 사용했다. 시험 전/후 로그와 현행 소스를 보존한다. hash는 보존 검사이며 실계정 검증이 아니다.\n\n## 한계와 다음 행동\n\n실제 Microsoft OAuth 로그인·실계정·본문/첨부·발송·증분 수집·위임/Mission/G 전체 계약·독립 연결 UI는 남았다. 실제 비용·제품p50/p95 미측정. 운영 설치본/서비스/사용자 vault/기억을 변경하지 않았다. 복원은 snapshotJob와 새시험·문서·증거 연결을 검토하며 사용자 자료를 삭제하지 않는다. 다음은 제공자 신원 확인과 안전한 공식 로그인, 읽기 결과를 위임·Mission 검증에 연결하는 작업이다. 최소70% 목표는 활성으로 유지한다.\n`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-before.txt`, `${prefix}-regression.txt`, `${prefix}-build.txt`, `${prefix}-contract.txt`];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'microsoft-request-binding-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: '호출자가 보유한 요청 객체를 await 후 재사용하면 인증 대상과 관측 출처 및 잠금 해제가 서로 달라질 수 있다.',
  lesson: '권한의 현재상태는 재조회하되 요청 대상은 await 전에 고정해야 한다. 제공자 URL만 먼저 고정하면 provenance와 finally의 연결 식별자가 여전히 변한다.',
  limitations: '4실패 재현→최종40/40/build/contract. Graph 합성·Core HTTP/SQLite/Windows DPAPI 실제. 실계정/OAuth전체/Mission/화면 미완료, 공식51유지.' }, null, 2), { flag: 'wx' });
const path = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(path)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 51);
const gate = gates.find(gate => gate.id === 'V3-073'); assert.equal(gate.status, 'in_progress');
gate.evidence.push(...evidencePaths.slice(0, 3)); gate.limitations.push('2026-10-07 요청 대상/provider/account/chat/cursor 비동기 변조4실패 수정. 최종40/40·실제Core HTTP/SQL/DPAPI·build/contract. Graph 합성, 실계정/OAuth전체/Mission/G/연결UI 미완료.');
acceptance.updatedAt = observedAt; writeFileSync(path, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: Microsoft 요청 변조·잘못된 출처·연결잠금 결함4재현→40/40 수정, build/contract. 073부분·공식51유지, 실계정/Mission/UI 남음.\n`);
console.log(JSON.stringify({ verified: 51, status: gate.status, evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
