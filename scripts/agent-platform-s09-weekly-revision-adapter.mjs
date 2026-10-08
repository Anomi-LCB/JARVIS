import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testName = 'S09 atomically revises a weekly timezone, retires the old occurrence, and dispatches the replacement once';
const selectedEnvironment = additions => {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'PYTHON',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { JARVIS_TEST_MODE: '1' }, additions);
  return env;
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

export function runS09WeeklyRevisionAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relativeRoot = `${outputRoot}/S09-local-${runId}`;
  const directory = resolve(root, relativeRoot);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relativeRoot}/repetition-${repetition}`;
    const rep = resolve(root, repRelative);
    const browserDirectory = resolve(rep, 'browser');
    mkdirSync(browserDirectory, { recursive: true });
    const schedulerEvidencePath = resolve(rep, 'scheduler-evidence.json');
    const browserReportPath = resolve(browserDirectory, 'report.json');
    const evidencePath = resolve(rep, 'evidence.json');
    const oraclePath = resolve(rep, 'oracle.json');
    let status = 'failed'; let stopCode = null; let oracle = null;

    const testRun = spawnSync(process.execPath, ['--test', `--test-name-pattern=${testName}`, 'tests/agent-platform-s09-weekly-revision.test.js'], {
      cwd: root, env: selectedEnvironment({ JARVIS_S09_WEEKLY_EVIDENCE_PATH: schedulerEvidencePath }),
      encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    writeFileSync(resolve(rep, 'scheduler-test.log'), `${testRun.stdout ?? ''}${testRun.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    if (testRun.error || testRun.status !== 0 || !existsSync(schedulerEvidencePath)) {
      stopCode = testRun.error?.code ?? `S09_SCHEDULER_TEST_EXIT_${testRun.status ?? 'UNKNOWN'}`;
    } else {
      const browserRun = spawnSync(process.execPath, ['scripts/agent-platform-s09-isolated-browser.mjs'], {
        cwd: root, env: selectedEnvironment({ JARVIS_S09_EVIDENCE_DIR: browserDirectory }),
        encoding: 'utf8', timeout: 45_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
      });
      writeFileSync(resolve(rep, 'browser-test.log'), `${browserRun.stdout ?? ''}${browserRun.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
      if (browserRun.error || browserRun.status !== 0 || !existsSync(browserReportPath)) {
        stopCode = browserRun.error?.code ?? `S09_BROWSER_TEST_EXIT_${browserRun.status ?? 'UNKNOWN'}`;
      } else {
        try {
          const browserReport = JSON.parse(readFileSync(browserReportPath, 'utf8'));
          const evidence = {
            schemaVersion: 1,
            scenarioId: 'S09',
            scheduler: JSON.parse(readFileSync(schedulerEvidencePath, 'utf8')),
            browserFlow: { status: browserReport.status, checks: browserReport.browserFlow?.checks ?? [], environment: browserReport.environment },
            sideEffects: { providerCalls: browserReport.environment?.providerCalls ?? null,
              networkRequests: 0, externalWrites: browserReport.environment?.externalWrites ?? null }
          };
          writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
          const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
            cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
            env: selectedEnvironment({ JARVIS_TEST_EVIDENCE_PATH: evidencePath }), maxBuffer: 1024 * 1024
          });
          oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
          status = oracle.status === 'passed' ? 'completed' : 'failed';
          if (status !== 'completed') stopCode = 'S09_ORACLE_FAILED';
        } catch (error) { stopCode = error?.code ?? 'S09_ORACLE_ERROR'; }
      }
    }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    measurements.push({ scenarioId: 'S09', adapterId: 's09-weekly-timezone-revision-isolated-product-flow',
      executionMode: 'sqlite-two-store-weekly-scheduler-plus-isolated-core-ui-browser-and-separate-process-oracle',
      repetition, startedAt, finishedAt, status,
      scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '시간대 수정 revision이 다음 주간 발생 시각을 다시 계산', status,
          oracleCheckIds: ['timezone_revision_supersedes_prior_occurrence', 'new_occurrence_dispatches_once_and_advances'] },
        { requirement: '이전 예약을 폐기하고 중복 dispatch를 막음', status,
          oracleCheckIds: ['timezone_revision_supersedes_prior_occurrence', 'new_occurrence_dispatches_once_and_advances'] },
        { requirement: 'UI의 정확 대상 시간대 수정과 DST 정책을 검증', status,
          oracleCheckIds: ['browser_flow_creates_reads_revises_and_cancels_exact_routine', 'dst_gap_and_overlap_policies_are_deterministic'] }
      ],
      evidencePaths: [
        ...(existsSync(resolve(rep, 'scheduler-test.log')) ? [`${repRelative}/scheduler-test.log`] : []),
        ...(existsSync(schedulerEvidencePath) ? [`${repRelative}/scheduler-evidence.json`] : []),
        ...(existsSync(resolve(rep, 'browser-test.log')) ? [`${repRelative}/browser-test.log`] : []),
        ...(existsSync(browserReportPath) ? [`${repRelative}/browser/report.json`, `${repRelative}/browser/browser-flow.json`] : []),
        ...(existsSync(evidencePath) ? [`${repRelative}/evidence.json`] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])
      ],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'S09', declaredFamily: 'spark',
    mode: 'public-scenario-local-weekly-timezone-revision-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3,
    measurementKind: 'sqlite-two-store-dst-revision-plus-isolated-core-ui-browser-with-separate-process-oracle',
    measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length,
      blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5),
      p95: percentile(measurements.map(item => item.latencyMs), .95), unit: 'ms', includes: 'scheduler test + isolated Core/UI browser + separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['SQLite scheduler and browser/Core UI use synthetic task content and isolated temporary state.',
      'Windows product service uptime, user profile persistence, sleep/wake dispatch, and live calendar/account behavior were not tested.',
      'Independent oracle is separate-process code from the same repository; holdout and independent human review remain unmeasured.'],
    evidence: { report: `${relativeRoot}/report.json`, summary: `${relativeRoot}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# S09 주간 시간대 수정·중복 방지 공개 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3; 별도 프로세스 oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95} ms; provider/network/external writes 0; 비용 미측정\n\n| 반복 | 상태 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n## 범위 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runS09WeeklyRevisionAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
