import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/google-vault-currentness-20261007', observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''), hash = value => createHash('sha256').update(value).digest('hex');
const before = read(`${prefix}-before.txt`), after = read(`${prefix}-recheck.txt`);
for (const pattern of [/tests 7\b/u, /fail 7\b/u]) assert.match(before, pattern);
for (const pattern of [/tests 60\b/u, /pass 60\b/u, /fail 0\b/u, /skipped 0\b/u, /same-timestamp Google/u, /revocation while parsing/u, /real Windows PowerShell/u]) assert.match(after, pattern);
assert.match(read(`${prefix}-build.txt`), /Built static JARVIS/u); assert.match(read(`${prefix}-contract.txt`), /gatePassed: true/u);
const sources = ['packages/core/src/personal-operations/google-vault-client.js', 'tests/google-vault-currentness.test.js',
  'tests/personal-google-connect-service.integration.test.js', 'packages/core/src/personal-operations/google-client.js'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: sources.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, reproducedFailures: 7, finalTests: 60, passed: 60, failed: 0, skipped: 0,
  durationMs: Number(after.match(/duration_ms ([\d.]+)/u)[1]), buildPassed: true, contractPassed: true,
  realPowerShellHandoff: true, realLoopbackHttp: true, realSqlite: true, realWindowsDpapi: true, simulatedGoogleProvider: true,
  externalAccountCalls: 0, paidCalls: 0, measuredCost: null, productLatencyPercentiles: null, operatingServicesUpdated: false, verified: 51 }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# Google 보관함 연결 현재성·요청 고정 및 인계 시험 복구\n\n관측 ${observedAt}. 공식 **51/100 유지**. 최소70% 목표 활성.\n\n## 재현과 수정\n\n신규7시험은 수정 전 모두 실패했다. updatedAt이 그대로여도 refreshToken이 교체되면 이전 token/cache를 사용했고, token 응답 중 철회·scope축소·자격증명교체·close가 발생해도 profile 요청이 나갔다. profile JSON parsing 중 철회돼도 연결 확인 기록을 남겼다. vault await 중 job의 provider/시각이 바뀌면 다른 API/조회기간을 사용했다.\n\n이제 보호된 자격증명의 내용 해시와 공개 연결 전체를 대조해 cache를 선택한다. 매 fetch 전후와 결과 parsing 뒤 현재 연결·scope·자격증명을 확인하며 close는 기존 진행 요청도 무효화한다. hash는 내부 비교에만 사용하고 토큰/원문 자격증명을 결과로 내보내지 않는다. 요청은 await 전에 일반 JSON 데이터 필드로 고정한다. 공유 저수준 GoogleReadClient의 네트워크 오류 정규화는 유지하며 facade가 최종 현재성 검사를 통해 정확한 연결 변경 원인을 반환한다.\n\n## 시험 유실 원인도 수정\n\n첫 확대 검사는57통과/3미실행이었다. 3건은 Linux 제외가 아니라 Windows PowerShell loopback probe 시간초과였으며 초기 commentary를 바로 정정했다. 실제 원인은 같은 Node 프로세스의 HTTP 서버를 spawnSync 대기가 막아 스스로 응답하지 못한 시험 deadlock이었다. HTTP 호출이 없는 DPAPI 준비는 동기 실행을 유지하고 probe 및 인계 wrapper는 비동기 child 대기로 고쳤다. 검증 불가를 skip으로 감추지 않고 Windows probe 실패는 assertion 실패로 처리한다. 성공/재시작/응답유실을 실제 PowerShell로 실행한4개 검사가 통과했다.\n\n최종7파일 **60/60 통과, 실패0, 미실행0**. 실제 PowerShell·DPAPI·HTTP 인계/SQL 및 Google 수집·권한·응답손실·broker 회귀를 포함하며 실제 Google 계정/API는 합성 대역이다. build와 Core contract gate 통과. 처음 현재성 patch의4실패는 동작 차단은 됐으나 공유client가 연결변경을 TOKEN_NETWORK로 덮은 오류분류 문제였고 facade 최종 재검사로 수정했다. 이전 실패·미실행 로그를 보존한다.\n\n## 한계·복원\n\n실제 OAuth 동의·계정 연결·Google history/sync-token 증분 동기화·계정 삭제/취소 인수는 미완료다. 매 요청의 vault 재대조는 추가 처리비용이 있으므로 속도 개선이나 무감소 성능을 주장하지 않는다. p50/p95·실제비용은 미측정이다. 동시 원격 다중 vault writer 및 OS 수준 원자적 철회는 이번 보장이 아니다. 운영 서비스/설치본/사용자 보관함·F/cognition은 변경하지 않았다. 복원은 facade 현재성·신규시험·비동기 시험 helper·증거연결에 한정한다.\n`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-before.txt`, `${prefix}-first.txt`, `${prefix}-final.txt`, `${prefix}-helper-repair.txt`, `${prefix}-recheck.txt`, `${prefix}-build.txt`, `${prefix}-contract.txt`];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'google-vault-currentness-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: 'updatedAt 캐시와 async 원본 job 재사용만으로는 동시 철회/동일시각 자격증명 교체/요청 retarget을 방지하지 못한다.',
  lesson: '요청은 고정하되 권한과 비밀의 현재성은 fetch와 결과 경계에서 재대조한다. 같은 프로세스 HTTP 시험을 spawnSync로 기다리면 가짜 환경 차단과 skip이 발생한다.',
  limitations: '7실패 재현→60/60/build/contract. 실제 PowerShell/DPAPI/HTTP·Google 합성. 실OAuth·계정·증분·장기 미완료. 성능/비용 미측정, 공식51유지.' }, null, 2), { flag: 'wx' });
const path = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(path)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 51);
for (const id of ['V3-029', 'V3-070']) {
  const gate = gates.find(gate => gate.id === id); gate.evidence.push(...evidencePaths.slice(0, 3));
  gate.limitations.push('2026-10-07 Google vault 요청/현재성7실패 수정 및 PowerShell 동기 대기 false-skip 복구. 최종60/60·build/contract. 실계정/OAuth·증분·전체 실행/장기 미완료, 인수율51유지.');
}
acceptance.updatedAt = observedAt; writeFileSync(path, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: Google vault 현재성7결함과 PowerShell 시험 deadlock 수정,60/60/build/contract. 공식51유지·실계정/증분 인수 남음.\n`);
console.log(JSON.stringify({ verified: 51, evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
