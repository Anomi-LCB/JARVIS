import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/effect-event-order-20261007', observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const log = read(`${prefix}-final.txt`);
for (const pattern of [/tests 97\b/u, /pass 97\b/u, /fail 0\b/u, /skipped 0\b/u,
  /two real Core processes race/u, /clockRollbackAfterRejectedTransaction/u,
  /reverseOrderAcknowledgements/u, /actual routine process kill at file-effect/u,
  /stale completed cannot overwrite/u, /old claimant is fenced before B/u]) assert.match(log, pattern);
const acceptancePath = 'docs/universal-control-v3-acceptance.json';
const acceptance = JSON.parse(read(acceptancePath)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 48);
const gate = gates.find(gate => gate.id === 'V3-045'); assert.equal(gate.status, 'in_progress');
const requirementsSha256 = hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement }))));
const audit = [
  { clause: '두 worker 경합', evidence: ['tests/mission-execution-authority.test.js', 'tests/mission-effect-coordinator.test.js', 'tests/effect-event-order-process.test.js'],
    observation: '서로 다른 실제 PID에서 동일 SQL authority/effect 경합, 승자1·패자실행거부. 동일 파일 대소문자별칭 자원경합도 실제 Core/파일1회.' },
  { clause: '만료된 worker 복귀', evidence: ['tests/mission-effect-coordinator.test.js', 'tests/worker-core-authority.test.js', 'tests/effect-event-order-process.test.js'],
    observation: '대기했던 실제 Core의 지연 복귀와 B 내부 fence에서 실행거부. 신규 별도 SQL worker도 만료 후 dispatch/늦은receipt 거부.' },
  { clause: '중복 이벤트', evidence: ['tests/pc-outbound-command-mailbox.test.js', 'tests/durable-routine-process-recovery.test.js', 'tests/effect-event-order-process.test.js'],
    observation: '중복command/ACK exact-match, 충돌receipt 거부, 동일효과 후속event1건, ACK 반복replayed. 실제예약 재시작 파일1/기억1/추가알림0.' },
  { clause: '역순 이벤트', evidence: ['tests/durable-routine-stale-dispatch.test.js', 'tests/durable-routine-mission-recovery.test.js', 'tests/effect-event-order-process.test.js'],
    observation: '예약 소유권/attempt 변경 후 오래된 completed/exception 결과가 현재상태·알림을 덮어쓰지 않음. 별도worker가 B후속을 먼저 ACK한 뒤 낡은 A snapshot CAS거부·A pending유지, 현재COMPLETED보존.' },
  { clause: '시계 변경', evidence: ['tests/mission-execution-authority.test.js', 'tests/pc-outbound-command-mailbox.test.js', 'tests/effect-event-order-process.test.js'],
    observation: '만료를 관측한 거절transaction 후 clockrollback도 persisted high-water 유지. 재시작/다른 SQL 연결에서도 stale fence 또는 uncertain 유지·redelivery0.' }
];
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, acceptanceId: gate.id, originalRequirement: gate.requirement,
  originalRequirementsSha256: requirementsSha256, audit, tests: { files: 8, total: 97, passed: 97, failed: 0, skipped: 0, durationMs: 55552.5489 },
  actualChildProcesses: true, actualSqlite: true, actualCorePcGFileRegression: true, syntheticPlannerAndTrust: true,
  externalProviderCalls: 0, measuredCost: null, cost: '미측정', runtimeCodeChanged: false, operatingServicesUpdated: false,
  completedAcceptanceIds: ['V3-045'], verified: 49 }, null, 2), { flag: 'wx' });
const paths = ['tests/effect-event-order-process.test.js', 'tests/fixtures/effect-event-worker.mjs', 'tests/mission-execution-authority.test.js',
  'tests/mission-effect-coordinator.test.js', 'tests/worker-core-authority.test.js', 'tests/pc-outbound-command-mailbox.test.js',
  'tests/durable-routine-stale-dispatch.test.js', 'tests/durable-routine-process-recovery.test.js', 'tests/durable-routine-mission-recovery.test.js',
  'packages/core/src/mission/sqlite-mission-store.js'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: paths.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# 실행 경합·중복/역순 사건·시계 변경 인수 감사

원래 V3-045의 다섯 명시 시험 조건을 현재 소스와 실제 실행으로 대조했다. **공식 인수율 48→49/100**. 요구/분모를 바꾸지 않았고 전체 시스템이나 모든 미래 분산 상황의 성공률로 환산하지 않는다.

## 이번에 추가한 증거

별도 실제 Node 프로세스2개가 같은 SQL effect를 경합해 한 작업자만 lease를 얻었다. 같은 resource의 다른effect도 대기했다. 승자가 만료된 시각에서 dispatch를 거절당한 후 시계를 과거로 돌려도 lease가 살아나지 않았다. 다른 프로세스의 복구에서 uncertain이 유지됐고 늦은 receipt2회와 다시claim을 해도 재dispatch는 없었다.

두 effect가 순차 완료한 뒤 늦게 온 동일receipt는 replay로만 확인되고 다른receipt는 충돌로 거부됐다. 완료 뒤 uncertain으로 되돌리려는 사건은 거절됐다. 최신 B후속event를 먼저 ACK해 COMPLETED snapshot을 저장한 후, 낡은 A후속event의 RUNNING snapshot을 적용하면 SQL CAS에서 거부되고 A event는 pending으로 남았다. 상태 갱신 없는 ACK로 처리한 뒤 재ACK도 replay이며 현재COMPLETED/후속event수는 유지됐다. 이 두 신규 시험은 raw SQL 계약의 경계 검사이며 그 자체를 모델 의미 평가나 독립 G로 주장하지 않는다.

## 원래 요구와 실제 실행 대응

${audit.map(item => `- **${item.clause}**: ${item.observation}`).join('\n')}

위 신규 경계와 기존 실제 Core→E→B→G→F 파일/예약/프로세스강제종료 검사를 묶어 실행했다. **8파일97/97**, 실패·취소·제외0, 전체runner55552.5489ms. Windows case-alias 실제두Core 검사도 이번 실행에서 건너뛰지 않았다. 준비·파일효과·B영수증·G 및 기억 저장 뒤 종료/복구에서는 실제 파일 호출1회를 대조하고 영수증이 없는 효과는 PAUSED/uncertain으로 유지했다. 유효한 양성 실행과 실패 차단을 모두 포함했다.

## 인수 판단과 한계

V3-045는 경합·만료복귀·중복·역순·시계변경의 **시험을 수행하는 항목**이다. 위 다섯 조건의 실제 프로세스/SQL/파일 및 기존 실행 경로 증거를 모두 확인해 verified로 승격했다. 예전 보고서의 부분 증거와 미확인 이력은 reviewHistory에 보존했다. 과거의 '모든 분산/역순 상황'이라는 미확인 범위를 무한한 미래 상황의 보증으로 바꾸지 않는다.

V3-042의 모든 실행 경로에 대한 중복 제어, V3-043의 실제 장치 연결, V3-047 Windows서비스/재부팅, V3-070~088 실제 계정/기기, V3-098 장기 실사용과 분리한다. 클라우드 호스트의 실제 시계/네트워크 장애, 실메일·결제 영수증, 모든 공급자 동작은 이번 시험이 아니다. 시험 계획기와 trust key는 격리 합성 값이며 사용자 기억과 비밀을 쓰지 않았다. 실제비용/제품p50/p95는 미측정이다.

이번에는 제품 runtime을 수정하지 않고 부족했던 경계 시험과 인수 대응을 추가했다. 따라서 새 제품 기능·설치 활성화로 보고하지 않는다. 모든 시험 프로세스는 종료됐고 운영 서비스를 교체하지 않았다. 복원은 신규 fixture/시험 및 감사 기록에 한정하며 기존 사용자 파일·원장·기억을 유지한다. source 해시는 보존용이지 실행/의미 검증의 대체물이 아니다.

다음은 기존 단일Core 연결과 영속 실행의 남은 제품 경로를 이어 검증한다. 상위70%목표는 활성으로 유지한다.
`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-first.txt`, `${prefix}-final.txt`];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'effect-event-order-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: '기존 SQL fence/CAS/후속event를 실제 두프로세스의 지연·중복·역순·clockrollback에 대조하면 원래 V3-045 명시 시험 조건의 누락 여부를 판정할 수 있다.',
  lesson: '시험 범위는 원래 요구의 명시 조건에 대응시켜 감사해야 한다. SQL 단계의 replay와 실제 B/G 단회 완료를 구분하고 늦은 snapshot 실패가 ACK까지 rollback되는지 확인해야 한다.',
  limitations: '97/97·실제프로세스/SQL/로컬파일, 합성planner/trust. runtime변경없음. 클라우드/실계정/실기기/장기관측 별도. 공식49/100·70목표활성.' }, null, 2), { flag: 'wx' });
gate.reviewHistory ??= [];
gate.reviewHistory.push({ status: gate.status, evidence: [...gate.evidence], limitations: [...gate.limitations], reviewedAt: gate.reviewedAt ?? null, supersededAt: observedAt });
gate.status = 'verified'; gate.reviewedAt = observedAt; gate.evidence.push(...evidencePaths.slice(0, 3));
gate.limitations.push('2026-10-07 원래 5명시시험조건의 현재 소스/실제프로세스·SQL/실제Core E/B/G/F 파일 증거 감사 완료. 신규 역순receipt/snapshot·clockrollback2건 포함97/97. 임의미래분산·클라우드·실계정/기기·장기관측은 별도 인수.');
assert.equal(gates.filter(item => item.status === 'verified').length, 49);
assert.equal(hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement })))), requirementsSha256);
acceptance.updatedAt = observedAt; writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 원래V3-045 5명시조건 인수감사·실제2프로세스 역순snapshot/receipt·clockrollback 신규2건+Core E/B/G/F 파일/OSkill 기존회귀97/97. 공식49/100. 클라우드/실기기/실계정/장기관측 별도,70목표활성.\n`);
console.log(JSON.stringify({ verified: 49, evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
