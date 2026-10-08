import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/multi-worker-fencing-20261007', observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const logs = ['focused', 'broader'].map(name => {
  const path = `${prefix}-${name}.txt`, content = read(path);
  const count = field => Number(content.match(new RegExp(`(?:ℹ |# )${field} (\\d+)`))?.[1]);
  const total = count('tests'), passed = count('pass'), failed = count('fail'), skipped = count('skipped');
  assert.ok(total > 0); assert.equal(passed, total); assert.equal(failed, 0); assert.equal(skipped, 0);
  return { path, total, passed, failed, skipped, durationMs: Number(content.match(/duration_ms ([\d.]+)/u)?.[1]) };
});
assert.match(read(logs[0].path), /partial overlap across real processes blocks the loser/u);
assert.match(read(logs[0].path), /actual HTTP workflow publication prevents an overlapping workflow/u);
assert.match(read(logs[0].path), /two actual Core processes cannot redispatch/u);
const path = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(path)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 50);
const gate = gates.find(gate => gate.id === 'V3-042'); assert.equal(gate.status, 'in_progress');
assert.equal(gate.requirement, '자원 lease·SQL CAS·fencing으로 다중 worker의 중복 실행을 제어한다.');
const requirementsHash = hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement }))));
const audit = [
  { clause: '자원 lease', evidence: 'Core SQL 자원 lease와 authority lease의 단일 소유·만료·clock high-water; 실제 두 Core와 Windows 파일 case alias 경합.' },
  { clause: 'SQL CAS', evidence: 'SQL BEGIN IMMEDIATE와 expected token/state/generation 비교. 실제 IPC 두 B의 서로 다른 primary·공통 secondary 자원 경합에서 한 claim만 획득, 패자 부분 claim 0.' },
  { clause: 'fencing', evidence: 'Core/B async 경계·파일 adapter 최종 fence. 실제 살아 있는 이전 B child는 복구 뒤 파일 append 전 STALE_FENCE, 파일효과1 유지.' },
  { clause: '다중 worker 중복 실행 제어', evidence: '실제 두 Core/B process, 별도 인증 HTTP B의 겹친 workflow/단일파일, 단회 outbound mailbox·역순ACK·응답손실 회귀. 완료·미확정 효과는 재dispatch하지 않음.' }
];
const sources = ['tests/remote-operation-multi-resource.test.js', 'tests/workflow-publication-claim.test.js', 'tests/mission-effect-coordinator.test.js',
  'tests/mission-execution-authority.test.js', 'tests/worker-core-authority.test.js', 'tests/effect-event-order-process.test.js', 'tests/pc-outbound-command-mailbox.test.js',
  'apps/pc-agent/src/remote-operation-store.js', 'packages/core/src/mission/sqlite-mission-store.js', 'packages/core/src/mission/mission-effect-coordinator.js', 'packages/core/src/mission/mission-execution-authority.js'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: sources.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, acceptanceId: gate.id, requirement: gate.requirement, requirementsHash, audit, logs,
  actualProcesses: true, actualFiles: true, actualSqlite: true, actualHttpWorkflow: true, syntheticDataAndAuthority: true,
  runtimeCodeChanged: false, externalAccountCalls: 0, cost: null, productLatencyPercentiles: null, verified: 51 }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# 다중 작업자 자원 lease·SQL CAS·fencing 인수 감사\n\n관측 ${observedAt}. 원래 V3-042를 유지하고 명시 조건을 감사해 공식 **50→51/100**으로 갱신한다.\n\n${audit.map(item => `- **${item.clause}**: ${item.evidence}`).join('\n')}\n\n새 반례는 다른 주 파일과 공통 보조 파일을 가진 두 실제 B 프로세스를 사용한다. 승자만 자원을 확보하고 실제 파일을 한 번 기록한다. 새 B 장부 복구 뒤 기존 프로세스를 종료하지 않고 다시 실행시켜 STALE_FENCE를 확인했고 파일 내용은 그대로였다. 불확실한 두 자원 claim은 유지하고 무관한 자원 작업은 허용했다. 저수준 child는 모델·E·G를 대신하지 않으며 기존 실제 Mission/E/B/G/HTTP 시험을 별도로 함께 실행했다.\n\n${logs.map(log => `${log.path}: **${log.passed}/${log.total} 통과**, 실패${log.failed}, 미실행${log.skipped}, ${log.durationMs}ms.`).join('\n\n')}\n\n제품 실행 코드는 이번에 수정하지 않았다. 빠졌던 실제 부분 겹침과 살아 있는 이전 B의 효과 차단 반례 및 인수 감사를 보강했다. 모든 원래 100개 요구 문구를 보존했다. hash는 증거 보존용이며 독립 의미 검증이 아니다.\n\n## 한계와 복원\n\n현재 연결된 로컬·인증 loopback HTTP·정해진 outbound 계약의 실행 경로에 대한 판정이다. 실제 외부계정·서로 다른 물리 PC·클라우드 설치·Linux OS 격리·모든 미래 공급자의 exactly-once를 입증한 것이 아니다. 생성 workflow의 새 파일은 create-only 게시를 사용하며 기존 파일 교체는 임의 OS 외부 작성자에 대한 조건부 원자 교체를 보장하지 않는다. 불확실한 claim 유지 때문에 안전한 보류가 발생할 수 있다. 실제 비용·제품 p50/p95 미측정. 운영 서비스·설치본·사용자 기억은 변경하지 않았다. 복원은 새 시험과 인수감사에 한정하며 기존 사용자 자료를 보존한다. 최소70% 목표는 계속 활성이다.\n`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, ...logs.map(log => log.path)];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'multi-worker-fencing-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: 'SQL 다중 자원 claim과 마지막 fence는 다른 primary/공통 secondary 경합 및 살아 있는 이전 프로세스의 재실행도 제어해야 한다.',
  lesson: '주 자원만 대조하면 보조 파일 충돌을 놓친다. 모든 자원을 한 transaction에서 확보하고 복구 후에도 이전 프로세스의 최종 효과 직전 fence를 확인해야 한다.',
  limitations: '실제 로컬 프로세스/SQL/파일 및 인증 HTTP 합성 업무. 실계정·물리 다중장치·모든 미래 제공자 보증은 별도. 제품 runtime 변경 없음.' }, null, 2), { flag: 'wx' });
gate.reviewHistory ??= []; gate.reviewHistory.push({ status: gate.status, evidence: [...gate.evidence], limitations: [...gate.limitations], reviewedAt: gate.reviewedAt ?? null, supersededAt: observedAt });
gate.status = 'verified'; gate.reviewedAt = observedAt; gate.evidence.push(...evidencePaths.slice(0, 3));
gate.limitations = ['2026-10-07 원래 lease·SQL CAS·fencing·다중 worker 요구를 실제 Core/B 프로세스와 부분 자원 경합·살아 있는 이전 B·HTTP workflow로 감사. 실계정·물리 다중장치·클라우드·모든 미래 공급자 보증은 별도.'];
assert.equal(gates.filter(gate => gate.status === 'verified').length, 51);
assert.equal(hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement })))), requirementsHash);
acceptance.updatedAt = observedAt; writeFileSync(path, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: V3-042 실제 다중 Core/B 자원 경합과 최종 fence 감사. 공식50→51/100. 실계정/다중물리기기/장기관측 별도, 최소70목표활성.\n`);
console.log(JSON.stringify({ verified: 51, logs, evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
