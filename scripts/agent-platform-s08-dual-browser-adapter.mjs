import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFor = evidencePath => {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_S08_EVIDENCE_PATH: evidencePath });
  return env;
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

export function runS08DualBrowserAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relativeRoot = `${outputRoot}/S08-local-${runId}`;
  const directory = resolve(root, relativeRoot);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relativeRoot}/repetition-${repetition}`;
    const rep = resolve(root, repRelative); mkdirSync(rep, { recursive: true });
    const evidencePath = resolve(rep, 'evidence.json'); const oraclePath = resolve(rep, 'oracle.json'); const logPath = resolve(rep, 'dual-context-test.log');
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-s08-dual-browser-contexts.test.js'], {
      cwd: root, env: envFor(evidencePath), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracle = null; let stopCode = child.error?.code ?? (child.status === 0 && existsSync(evidencePath) ? null : `S08_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode) {
      try {
        const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
          cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: envFor(evidencePath), maxBuffer: 1024 * 1024 });
        oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
        if (oracle.status !== 'passed') stopCode = 'S08_ORACLE_FAILED';
      } catch (error) { stopCode = error?.code ?? 'S08_ORACLE_ERROR'; }
    }
    const finishedAt = new Date().toISOString(); const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const status = stopCode ? 'failed' : 'completed';
    measurements.push({ scenarioId: 'S08', adapterId: 's08-dual-browser-context-account-binding',
      executionMode: 'two-synthetic-browser-drivers-with-context-and-account-binding-plus-separate-process-oracle',
      repetition, startedAt, finishedAt, status, scenarioExecutionStatus: status,
      requirementResults: [
        { requirement: '환경과 계정 식별자가 각 브라우저 세션에 고정된다.', status, oracleCheckIds: ['two_sessions_have_distinct_contexts_and_account_bindings'] },
        { requirement: '다른 context를 재사용하거나 교차 binding한 작업을 거부한다.', status, oracleCheckIds: ['wrong_environment_and_account_are_blocked_before_actions', 'allowed_actions_stay_in_the_selected_context'] },
        { requirement: '필요한 환경으로 사용자 인계 후 같은 세션 범위에서 재개한다.', status, oracleCheckIds: ['handoff_pauses_remote_session_and_scoped_resume_keeps_binding'] }
      ], evidencePaths: [`${repRelative}/dual-context-test.log`, ...(existsSync(evidencePath) ? [`${repRelative}/evidence.json`] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0, retries: 0,
      questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed' : 'failed';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'S08', declaredFamily: 'spark',
    mode: 'public-scenario-local-dual-browser-binding-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'synthetic-dual-context-test-with-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: 0,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'synthetic browser context test + separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['두 드라이버는 synthetic in-memory session이며 실제 브라우저 engine·쿠키 저장소·서비스 계정은 실행하지 않았다.',
      'same-origin two-account distinction is represented by opaque account hashes; the system does not inspect a website to prove who is logged in.',
      'handoff manager is not yet wired to an always-running product browser runtime. Oracle is same-repository code; human holdout and cost are unmeasured.'],
    evidence: { report: `${relativeRoot}/report.json`, summary: `${relativeRoot}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# S08 이중 브라우저 binding 합성 공개 평가\n\n관측: ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3; oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95} ms; network/provider/external writes 0; 비용 미측정\n\n| 반복 | 상태 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runS08DualBrowserAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
