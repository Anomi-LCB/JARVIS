import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const prefix = 'artifacts/local-publication-lock-20261007';
const read = path => readFileSync(path, 'utf8'), json = path => JSON.parse(read(path));
const write = (name, value) => writeFileSync(`${prefix}-${name}`, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', flush: true });
const runner = json(`${prefix}-final-runner.json`), log = read(`${prefix}-final.txt`);
assert.equal(runner.status, 'passed'); assert.equal(runner.exitCode, 0);
const total = Number(log.match(/ℹ tests (\d+)/)?.[1]), passed = Number(log.match(/ℹ pass (\d+)/)?.[1]);
const skipped = Number(log.match(/ℹ skipped (\d+)/)?.[1]);
assert.ok(passed > 80); assert.equal(total, passed + skipped);
assert.equal(skipped, 13); // Linux root/UID isolation cases cannot run on this Windows host.
assert.match(log, /ℹ fail 0(?:\r?\n|$)/);
assert.match(read(`${prefix}-baseline-v2.txt`), /Missing expected rejection/);
assert.match(read(`${prefix}-build.txt`), /Built static JARVIS/);
assert.match(read(`${prefix}-contract.txt`), /gatePassed: true/);
const comparison = json('artifacts/recovery-comparison/heartbeat-20261007.json');
assert.equal(comparison.sourcesUnchangedDuringRun, true);
assert.equal(comparison.comparison.regressionCaseIds.length, 0);
const observedAt = new Date().toISOString();
const sources = ['apps/pc-agent/src/pc-agent-runtime.js', 'tests/workflow-publication-claim.test.js'];
write('source.json', { observedAt, files: sources.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), content: read(path) })) });
const acceptancePath = 'docs/universal-control-v3-acceptance.json', acceptance = json(acceptancePath);
const gates = acceptance.stages.flatMap(stage => stage.gates), verified = gates.filter(gate => gate.status === 'verified').length;
assert.equal(verified, 60);
write('verification.json', { observedAt, tests: total, passed, failed: 0, skipped, skippedReason: '13 Linux root/UID OS isolation cases on Windows', durationMs: runner.durationMs,
  beforeFixActualOverlappingFileObserved: true, afterFixBothClaimDirectionsTested: true,
  differentSingleFileTargetCompleted: true, originalOperationReceiptPreserved: true,
  independentReview: `${prefix}-independent.json`, fixedRecoverySuite: { cases: comparison.suite.caseCount,
    repetitions: comparison.protocol.repetitions, decision: comparison.comparison.decision,
    regressions: comparison.comparison.regressionCaseIds, purpose: 'unchanged-current-path measurement, not lock candidate superiority' },
  productionActivated: false, unfinishedWorkflowPublicationResumeComplete: false,
  defaultWorkflowEffectsEnabled: false, officialVerified: verified, actualCost: null, externalProviderCalls: 0 });
write('report.md', `# 로컬 단일 파일과 복합 작업의 공유 실행 잠금

관측 ${observedAt}. 공식 인수 ${verified}/100 유지. 이번 변경은 소스 구현과 격리 실행 검증이며 설치본·운영 서비스를 활성화하지 않았다.

실제 Core/E/B/G와 임시 SQLite·파일에서 복합 작업의 게시 잠금을 잡아 둔 사이 별도 로컬 단일파일 명령을 실행했다. 변경 전 해당 목표 파일이 실제 생성되어 경합을 재현했다(baseline-v2). 원격 HTTP 파일 경로는 이미 B의 파일 잠금을 사용했지만 로컬 경로는 Core 파일 lease만 검사해 서로 다른 잠금 공간을 사용했다.

로컬 Mission 단일파일 쓰기를 기존 B prepare/claim/영수증 경로로 연결했다. 원래 Core fence를 먼저 확보해 유지하고 B의 현재 서명 권한·ticket·generation·물리 파일 identity 검사와 합성한다. 비공개 Symbol은 재귀 방지용이며 JSON packet이나 HTTP 필드가 잠금/권한을 부여하지 않는다. 기존 operationId·B 멱등키·공급자 영수증과 Core EffectRecord를 그대로 사용한다.

복합 작업→단일파일, 단일파일→복합 작업 두 순서에서 실제 목표 파일이 없는 상태로 B가 B_OPERATION_RESOURCE_UNRESOLVED를 반환했다. 다른 단일파일 목표는 정상 완료했고 원래 소유 작업의 파일·영수증이 보존됐다. 전체 ${total}건 중 ${passed}통과·실패0·Linux root/UID OS 격리13건은 Windows 환경에서 skip, build/Core 계약 통과. 독립 반증의 별도 경합 1건과 Core 회귀36건은 이 숫자에 합산하지 않는다. 실제 PID 종료·권한 철회·lease 만료·두 Core·Windows 대소문자 별칭·F/cognition 복구가 포함되나 실계정·다른 PC 전체를 입증하지 않는다.

초기 route가 Core fence를 B preflight 뒤에 획득해 기존 lease 반례가 실패했으며, Core fence를 먼저 확보하는 수정 후 최종 회귀를 통과했다. 초기 테스트의 B 사유를 Mission JSON에서 찾는 기대도 틀렸다. B 직접 반환과 파일 상태를 검증하도록 관측점을 수정했다. 또한 실패한 복합 효과가 workspace 단위 uncertain 잠금을 유지하므로 같은 workspace의 다른 복합 작업까지 자동 성공하는 것으로 보고하지 않는다. 양성 대조는 다른 단일파일 명령이다. 실패 기록은 보존했다.

고정 복구 비교기는 기존 Mission 복구/G 경로의 18사례를 구성별3회 실행했다. 회귀 없음·원문/소스 해시 고정. 같은 current 구성을 비교한 관측으로 새 잠금의 속도 개선이나 외부 제품 우위를 주장하지 않는다. 외부 모델 호출0·로컬 비용 미측정(null). 감시6곳은 변화0이며 후보 정의/증거 변경과 이전 실패는 별도 연구 장부 상태로 유지한다.

트랜잭션 기반 기존 claim을 재사용하는 근거로 [SQLite 공식 트랜잭션 문서](https://www.sqlite.org/lang_transaction.html)를 다시 확인했다. SQLite 원장의 원자성을 OS 파일 쓰기 전체의 원자성으로 확대하지 않는다.

남은 일: 경합 거절의 B 상세 원인을 Core 화면에 보존하고, 실행 전 거절임을 독립 확인한 뒤 안전하게 다시 진행하는 경로; 중단된 복합 publication의 현재 Core/E 권한과 새 fence를 연결한 재개. workflowEffectsEnabled=false는 유지한다. V3-040 전체 승격은 보류한다. 복원은 이번 로컬 B routing 및 합성 fence만 이전 경로로 되돌리는 검토가 필요하며, 기존 SQL/영수증·사용자 업무 기억을 삭제하지 않는다.
`);
const evidencePaths = ['report.md','verification.json','source.json','baseline-v2.txt','final.txt','final-runner.json',
  'build.txt','contract.txt','independent.json','independent.md'].map(name => `${prefix}-${name}`);
evidencePaths.push('artifacts/recovery-comparison/heartbeat-20261007.json');
write('attempt.json', { id: 'local-publication-lock-20261007', candidateId: 'agent-platform-observed-scenario-status',
  kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: '로컬 단일파일 실행도 기존 B 물리파일 claim을 사용하고 원래 Core fence를 합성하면 복합 게시 작업과의 경합을 차단할 수 있다.',
  lesson: 'Core와 B의 서로 다른 잠금 공간은 실제 동일 파일을 보호하지 못한다. 기존 B claim 재사용 시 Core fence 획득 순서도 보존해야 한다. B 직접 차단과 Core의 uncertain 투영은 별도 관측이다.',
  limitations: '격리 Core/E/B/G/SQL/파일 회귀만. 운영 활성화0, workflow 기본false, 미완료 publication 재개/경합 거절 후 자동 복구 미완료. 공식60/100 유지. 다른 PC/실계정/OS transaction 미입증. 고정 비교기는 same-current 비교, 속도 우위 미측정. 비용null.' });
const gate = gates.find(gate => gate.id === 'V3-040'); assert.equal(gate.status, 'in_progress');
gate.evidence.push(...evidencePaths);
gate.limitations.push(`2026-10-07 로컬 단일파일/B workflow 공유 물리파일 claim 경합 수정. ${passed}통과/13 Linux 전용skip/build/contract 및 독립 반증. B 거절 뒤 Core 상세 사유/안전 재개, 미완료 workflow publication fence 잔여. 기본 workflow=false·운영 활성화0, 전체 승격 보류.`);
acceptance.updatedAt = observedAt; writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`);
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 실제 로컬파일/복합게시 경합 재현·B 공유claim/Core fence 순서 수정, ${passed}통과/13 Linux 전용skip/build/contract. 양방향차단·다른단일파일양성·독립반증. 기본workflow=false/미완료publication·경합거절 안전재개 잔여, 공식60 유지.\n`);
console.log(JSON.stringify({ observedAt, tests: total, passed, skipped, verified, recordedAttempt: `${prefix}-attempt.json` }));

