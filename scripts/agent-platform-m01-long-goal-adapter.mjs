import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oracle = fileURLToPath(new URL('./agent-platform-independent-oracle.mjs', import.meta.url));
const rel = path => path.slice(root.length + 1).replaceAll('\\', '/');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null; };
const adversarialTestPattern = '(a saved replacement retains raw revision history, is idempotent and rejects stale CAS or reused payload keys|an uncertain old worker outcome stays blocked across revision and cannot dispatch a replacement effect|a planner that proposes an already completed retained write is blocked before another worker handoff|revision arriving during the planning availability await discards the old prepared action|revision arriving during the dispatch availability await discards the old prepared action|revision at the actual SQL prepared boundary cancels only the undispatched intent and runs the replacement once)';

export function runM01LongGoalAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/M01-local-${runId}`;
  const runDirectory = resolve(root, runRelative); mkdirSync(runDirectory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repetitionRelative = `${runRelative}/repetition-${repetition}`;
    const repetitionDirectory = resolve(root, repetitionRelative); mkdirSync(repetitionDirectory, { recursive: true });
    const evidencePath = resolve(repetitionDirectory, 'evidence.json');
    const oraclePath = resolve(repetitionDirectory, 'oracle.json');
    const logPath = resolve(repetitionDirectory, 'adapter-test.log');
    const adversarialLogPath = resolve(repetitionDirectory, 'adversarial-test.log');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M01_EVIDENCE_PATH: evidencePath });
    const child = spawnSync(process.execPath, ['--test', '--test-name-pattern=revised multi-phase local goal', 'tests/mission-goal-revision.test.js'], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    const adversarial = child.status === 0 ? spawnSync(process.execPath,
      ['--test', `--test-name-pattern=${adversarialTestPattern}`, 'tests/mission-goal-revision.test.js'], {
        cwd: root, env, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
      }) : null;
    if (adversarial) writeFileSync(adversarialLogPath,
      `${adversarial.stdout ?? ''}${adversarial.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracleResult = null; let status = 'failed';
    let stopCode = child.error?.code ?? (child.status === 0 ? null : `M01_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode && adversarial) {
      const log = `${adversarial.stdout ?? ''}${adversarial.stderr ?? ''}`;
      const summary = log.match(/ℹ tests (\d+)\s+ℹ suites (\d+)\s+ℹ pass (\d+)\s+ℹ fail (\d+)/u);
      if (adversarial.error || adversarial.status !== 0) stopCode = adversarial.error?.code ?? `M01_ADVERSARIAL_TEST_EXIT_${adversarial.status ?? 'UNKNOWN'}`;
      else if (!summary || Number(summary[1]) !== 6 || Number(summary[3]) !== 6 || Number(summary[4]) !== 0) stopCode = 'M01_ADVERSARIAL_TEST_COVERAGE_MISMATCH';
    }
    if (!stopCode && existsSync(evidencePath)) {
      try {
        const output = execFileSync(process.execPath, [oracle, evidencePath, oraclePath], {
          cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env, maxBuffer: 1_000_000
        });
        oracleResult = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
        status = oracleResult.status === 'passed' ? 'completed' : 'failed';
        if (status !== 'completed') stopCode = 'M01_INDEPENDENT_ORACLE_FAILED';
      } catch (error) { stopCode = error?.code ?? 'M01_ORACLE_ERROR'; }
    } else if (!stopCode) stopCode = 'M01_EVIDENCE_MISSING';
    const finishedAt = new Date().toISOString(); const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    measurements.push({ scenarioId: 'M01', adapterId: 'm01-local-long-goal-revision',
      executionMode: 'local-sqlite-mission-goal-revision-with-priority-change-and-separate-process-oracle',
      repetition, startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '명시 기한과 단계 요구를 보존하고 재계획한다.', status, oracleCheckIds: ['deadline_is_parsed_and_requirements_remain_explicit', 'replan_keeps_dependency_order_and_excludes_superseded_phase'] },
        { requirement: '이전 목표와 우선순위 변경 이유를 revision 이력에 보존한다.', status, oracleCheckIds: ['revision_history_preserves_original_goal_and_reason'] },
        { requirement: '실제 완료 산출물과 실행 권한 경계를 확인한다.', status, oracleCheckIds: ['expected_outputs_exist_and_goal_contract_does_not_grant_authority'] }
      ], adversarialChecks: ['revision idempotency and stale compare-and-set', 'uncertain worker outcome blocks replacement dispatch',
        'completed effect replay is blocked before handoff', 'revision during planning availability discards stale plan',
        'revision during dispatch availability discards stale plan', 'prepared-boundary revision cancels undispatched intent'],
      adversarialTestStatus: adversarial && !stopCode ? 'passed' : 'failed',
      evidencePaths: [...(existsSync(evidencePath) ? [rel(evidencePath)] : []), ...(existsSync(oraclePath) ? [rel(oraclePath)] : []), rel(logPath),
        ...(existsSync(adversarialLogPath) ? [rel(adversarialLogPath)] : [])],
      oracle: oracleResult ? { status: oracleResult.status, name: oracleResult.oracle, independence: oracleResult.oracleIndependence,
        resultPath: rel(oraclePath), checks: oracleResult.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: 0, approvals: 0, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M01', declaredFamily: 'muse',
    mode: 'public-scenario-local-long-goal-revision-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'sqlite-backed-local-mission-revision-with-deterministic-dependency-replan', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'SQLite-backed mission test and separate process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['합성 로컬 파일 2단계 계획과 우선순위 변경, 저장소 내 취소·불확실 효과·revision 경계 회귀 사례만 평가했다. 자동 milestone 생성, calendar-based critical path, missed-deadline 운영, 불확실한 일정 예측이나 실제 장기 프로젝트 관리 품질은 검증하지 않았다.',
      'SQLite 영속 store를 사용했으나 제품 프로세스 kill 후 재시작 회복은 이 시나리오에서 별도 실행하지 않았다.',
      'oracle은 별도 프로세스의 동일 저장소 코드이며 독립 인간 저자가 아니다. 실제 UI·provider·외부 계정은 사용하지 않았고 비용은 미측정이다.'],
    evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` } };
  writeFileSync(resolve(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runDirectory, 'report.md'), `# M01 장기 목표 revision 공개 시나리오\n\n관측: ${observedAt}\n\n- 결과: ${outcome}, ${report.counts.completed}/3\n- 각 반복에서 정상 재계획 1건과 적대적 revision 경계 회귀 6건을 실행했다.\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms; provider/network/외부 쓰기 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | 별도 프로세스 오라클 | 적대적 경계 회귀 |\n|---:|---|---:|---|---|\n${measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} | ${item.adversarialTestStatus} |`).join('\n')}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM01LongGoalAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
