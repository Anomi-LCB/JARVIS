import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFile = 'tests/agent-platform-m07-remote-unavailable.test.js';
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

export function runM07EnvironmentRecoveryAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relative = `${outputRoot}/M07-local-${runId}`;
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
    const logPath = resolve(rep, 'recovery-test.log');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M07_ORACLE_EVIDENCE_PATH: evidencePath });
    const child = spawnSync(process.execPath, ['--test', testFile], { cwd: root, env, encoding: 'utf8', timeout: 30_000,
      windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let status = 'failed', stopCode = null, oracle = null;
    if (child.error || child.status !== 0) stopCode = child.error?.code ?? `M07_TEST_EXIT_${child.status ?? 'UNKNOWN'}`;
    else try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env, maxBuffer: 1024 * 1024
      });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      status = oracle.status === 'passed' ? 'completed' : 'failed';
      if (status !== 'completed') stopCode = 'M07_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'M07_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString();
    measurements.push({ scenarioId: 'M07', adapterId: 'm07-local-managed-environment-loss-recovery',
      executionMode: 'sqlite-session-binding-with-simulated-remote-404-and-local-snapshot-restorer', repetition, startedAt, finishedAt,
      status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '원격 환경 삭제/404를 unavailable로 감지', status, oracleCheckIds: ['remote_404_classified_as_unavailable'] },
        { requirement: '로컬 snapshot만 복원하고 원격 전용 결과 손실은 완료로 위장하지 않음', status,
          oracleCheckIds: ['local_snapshot_restored_and_binding_preserved', 'missing_remote_output_not_claimed_as_restored', 'never_reports_completion_or_recreates_automatically'] }
      ],
      evidencePaths: [`${repRelative}/recovery-test.log`, ...(existsSync(evidencePath) ? [`${repRelative}/evidence.json`] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt), providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M07', declaredFamily: 'muse',
    mode: 'public-scenario-local-managed-environment-loss-recovery-adapter', executionStatusChangedInCorpus: false, outcome,
    repetitionsPerConfiguration: 3, measurementKind: 'simulated-404-and-local-recovery-callback-with-separate-process-fixed-predicate-oracle',
    measurements, counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.durationMs), .5),
      p95: percentile(measurements.map(item => item.durationMs), .95), unit: 'ms', includes: 'SQLite broker simulation, test assertions, and separate process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['원격 404와 local snapshot restore는 합성 callback으로 시뮬레이션했다. 실제 제공자·클라우드 세션 삭제는 호출하지 않았다.',
      '별도 oracle은 같은 프로젝트의 고정 predicate이며 독립 인간 저자 평가가 아니다.',
      '제품 Mission store의 운영 백업·복원 및 원격 파일 보존은 별도 검증이 필요하다.'],
    evidence: { report: `${relative}/report.json`, summary: `${relative}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.durationMs}ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# M07 원격 실행환경 손실 복구 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3; 별도 oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95}ms; provider/network/external writes 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM07EnvironmentRecoveryAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
  if (report.outcome !== 'completed') process.exitCode = 1;
}
