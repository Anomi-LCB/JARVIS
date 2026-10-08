import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/google-page-account-20261007', observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''), hash = value => createHash('sha256').update(value).digest('hex');
const before = read(`${prefix}-before.txt`), after = read(`${prefix}-recheck.txt`);
assert.match(before, /fail 2\b/u);
for (const pattern of [/tests 71\b/u, /pass 71\b/u, /fail 0\b/u, /skipped 0\b/u, /account switch between sync identity/u, /account switch during content/u]) assert.match(after, pattern);
assert.match(read(`${prefix}-build-final.txt`), /Built static JARVIS/u); assert.match(read(`${prefix}-contract.txt`), /gatePassed: true/u);
const files = ['packages/core/src/personal-operations/google-client.js', 'packages/core/src/personal-operations/google-operation-broker.js',
  'packages/core/src/personal-operations/google-sync.js', 'tests/google-operation-broker.test.js', 'docs/google-operation-broker.md'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: files.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, reproducedFailures: 2, finalTests: 71, passed: 71, failed: 0, skipped: 0,
  durationMs: Number(after.match(/duration_ms ([\d.]+)/u)[1]), realSqlite: true, realPowerShellHandoff: true, realLoopbackHttp: true,
  simulatedGoogleProvider: true, externalAccountCalls: 0, cost: null, latencyPercentiles: null, verified: 51 }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# Google 페이지의 계정 출처 결합\n\n관측 ${observedAt}. 공식 **51/100 유지**. 최소70% 목표 활성.\n\n## 결함\n\n수집기에서 account를 먼저 조회한 뒤 연결이 다른 계정으로 전환되면, Core broker facade가 page 요청에서 account를 제거해 새 계정의 자료를 이전 account의 SQLite stream에 넣을 수 있었다. 수정 전2시험이 실패했다. 기존 연결 ID/revision 검사는 하나의 API 요청 내 변경은 다루지만 서로 다른 account/page 요청 사이의 전환을 완전히 대체하지 못했다.\n\n## 수정과 실제 결과\n\n수집 원래 account를 broker까지 전달하고 요청 형식/길이/권한을 검증한다. 공통 GoogleReadClient가 account 지정 페이지 전후에 공급자 profile과 대조한다. 시작 시 불일치는 내용 API 호출0, 도중 불일치는 결과 반환/수집0이다. SQLite 원래 작업의 cursor와 complete는 그대로 보류한다. 원래 계정 복원 후 새 runner가 기존 작업을 이어 메일/일정2항목을 정상 저장한다. 오류에는 계정 연결 확인과 재실행이라는 다음 조치를 표시한다. 계정 값/토큰을 오류 문자열에 넣지 않는다. 요청을 await 전에 복사해 조회 중 대상 변화를 방지한다.\n\n최종10파일 **71/71 통과, 실패0, 미실행0**. 계정 혼합 반례3건, 현재성7건, 수집 checkpoint/위임/HTTP mTLS broker/취소/실제 Windows PowerShell 인계/DPAPI 회귀 포함. Google 공급자는 합성 응답이며 SQLite·loopback HTTP·PowerShell은 실제 실행이다. 최종 build 및 Core API 계약 검사 통과.\n\n## 한계와 복원\n\n특정 수집 계정 결합은 account 필드가 있는 요청에서 적용한다. account 없는 기존 명시 페이지는 연결 ID/revision 범위이며 계정 결합 증거로 세지 않는다. Calendar 계정 대조에도 Gmail profile 권한이 필요하므로 수집기의 두 읽기 scope 조건을 유지한다. profile 추가조회로 비용·지연이 늘 수 있으며 p50/p95·실제비용 미측정, 속도 개선 주장 없음. 실계정 OAuth/증분 history/sync-token/삭제/취소/30일 인수 미완료. 운영 설치본·서비스·실제 vault/F/cognition 변경 없음. 복원은 account 전달/대조/안내·시험·증거에 한정하고 저장된 사용자 원장은 유지한다.\n`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-before.txt`, `${prefix}-recheck.txt`, `${prefix}-build-final.txt`, `${prefix}-contract.txt`];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'google-page-account-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: 'account/page가 별개 요청이면 연결revision이 유효해도 다른 계정의 자료가 이전 stream에 저장될 수 있다.',
  lesson: '최초 수집 계정의 신원을 페이지 계약에 보존하고 조회 전후 대조해야 한다. 원래 checkpoint는 보류하고 복원 뒤 같은 작업을 이어야 한다.',
  limitations: '2실패 재현→71/71/build/contract. 실제SQL/HTTP/PowerShell·Google합성. 실OAuth/증분/장기미완료. 추가조회 속도·비용 미측정, 공식51유지.' }, null, 2), { flag: 'wx' });
const path = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(path)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 51);
for (const id of ['V3-029', 'V3-070']) { const gate = gates.find(gate => gate.id === id); gate.evidence.push(...evidencePaths.slice(0, 3));
  gate.limitations.push('2026-10-07 Google account/page 사이 출처 혼합2실패 수정. 페이지 전후 신원 대조·계정불일치 수집/커서0·복원 후2항목완료.71/71/build/contract, 실제공급자/증분/전체인수 미완료.'); }
acceptance.updatedAt = observedAt; writeFileSync(path, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: Google 계정 혼합 결함 수정·71/71·build/contract. 원래계정/페이지계약/복구 연결, 공식51유지·실계정/증분남음.\n`);
console.log(JSON.stringify({ verified: 51, evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
