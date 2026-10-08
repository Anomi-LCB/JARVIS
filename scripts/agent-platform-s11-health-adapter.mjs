import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFile = 'tests/agent-platform-s11-health-summary.test.js';
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

export function runS11HealthAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relative = `${outputRoot}/S11-local-${runId}`;
  const directory = resolve(root, relative);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relative}/repetition-${repetition}`;
    const rep = resolve(root, repRelative);
    mkdirSync(rep, { recursive: true });
    const evidencePath = resolve(rep, 'evidence.json');
    const oraclePath = resolve(rep, 'oracle.json');
    const logPath = resolve(rep, 'summary-test.log');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_S11_ORACLE_EVIDENCE_PATH: evidencePath });
    const child = spawnSync(process.execPath, ['--test', testFile], { cwd: root, env, encoding: 'utf8', timeout: 30_000,
      windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let status = 'failed';
    let stopCode = null;
    let oracle = null;
    if (child.error || child.status !== 0) stopCode = child.error?.code ?? `S11_TEST_EXIT_${child.status ?? 'UNKNOWN'}`;
    else try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env, maxBuffer: 1024 * 1024
      });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      status = oracle.status === 'passed' ? 'completed' : 'failed';
      if (status !== 'completed') stopCode = 'S11_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'S11_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString();
    measurements.push({ scenarioId: 'S11', adapterId: 's11-synthetic-health-record-summary',
      executionMode: 'local-synthetic-health-fixture-no-device-or-account', repetition, startedAt, finishedAt, status,
      scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '누락 구간·원본 단위·측정 시각을 보존하고 단위가 다른 지원 측정만 정규화', status,
          oracleCheckIds: ['requested_range_and_missing_days_preserved', 'original_units_and_timestamps_retained', 'mixed_supported_units_normalized_without_losing_originals'] },
        { requirement: '오래된 자료를 표시하고 의료 진단·치료 판단을 생성하지 않음', status,
          oracleCheckIds: ['stale_measurement_is_marked_without_health_judgment', 'no_diagnosis_or_treatment_recommendation'] }
      ],
      evidencePaths: [`${repRelative}/summary-test.log`, ...(existsSync(evidencePath) ? [`${repRelative}/evidence.json`] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt), providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'S11', declaredFamily: 'spark',
    mode: 'public-scenario-local-synthetic-health-record-adapter', executionStatusChangedInCorpus: false, outcome,
    repetitionsPerConfiguration: 3, measurementKind: 'synthetic-health-summary-and-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.durationMs), .5),
      p95: percentile(measurements.map(item => item.durationMs), .95), unit: 'ms', includes: 'synthetic fixture test and separate process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['합성 기록만 사용했으며 Health Connect·사용자 계정·웨어러블 기기를 연결하지 않았다.',
      '별도 oracle은 같은 프로젝트의 고정 fixture 판정이며 독립 인간 저자 검토가 아니다.',
      '측정값의 진위·센서 정확도·의학적 의미·실사용 품질은 평가하지 않는다.'],
    evidence: { report: `${relative}/report.json`, summary: `${relative}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.durationMs}ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# S11 합성 웨어러블 기록 공개 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3; 별도 oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95}ms; provider/network/external writes 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runS11HealthAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
  if (report.outcome !== 'completed') process.exitCode = 1;
}
