import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFile = 'tests/agent-platform-s12-isolated-device.test.js';
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

export function runS12DeviceAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relative = `${outputRoot}/S12-local-${runId}`;
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
    const logPath = resolve(rep, 'simulator-test.log');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_S12_ORACLE_EVIDENCE_PATH: evidencePath });
    const child = spawnSync(process.execPath, ['--test', testFile], { cwd: root, env, encoding: 'utf8', timeout: 30_000,
      windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let status = 'failed';
    let stopCode = null;
    let oracle = null;
    if (child.error || child.status !== 0) stopCode = child.error?.code ?? `S12_TEST_EXIT_${child.status ?? 'UNKNOWN'}`;
    else try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env, maxBuffer: 1024 * 1024
      });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      status = oracle.status === 'passed' ? 'completed' : 'failed';
      if (status !== 'completed') stopCode = 'S12_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'S12_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString();
    measurements.push({ scenarioId: 'S12', adapterId: 's12-isolated-device-action-reconciliation',
      executionMode: 'in-memory-no-network-simulator-no-physical-device', repetition, startedAt, finishedAt, status,
      scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '응답 유실 후 상태를 다시 조회하고 중복 요청을 억제', status,
          oracleCheckIds: ['uncertain_result_reconciled_by_fresh_read', 'idempotent_retry_did_not_duplicate_effect'] },
        { requirement: '조명만 허용하고 온도조절기·도어락은 차단하며 충돌 시 복원을 거부', status,
          oracleCheckIds: ['only_allowlisted_reversible_light_command_was_restored', 'thermostat_and_lock_remained_unchanged', 'unsafe_device_commands_denied'] }
      ],
      evidencePaths: [`${repRelative}/simulator-test.log`, ...(existsSync(evidencePath) ? [`${repRelative}/evidence.json`] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt), providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'S12', declaredFamily: 'spark',
    mode: 'public-scenario-local-isolated-device-reconciliation-adapter', executionStatusChangedInCorpus: false, outcome,
    repetitionsPerConfiguration: 3, measurementKind: 'simulator tests and separate-process fixed-predicate oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.durationMs), .5),
      p95: percentile(measurements.map(item => item.durationMs), .95), unit: 'ms', includes: 'simulator tests and separate process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['메모리 내 합성 시뮬레이터만 시험했으며 실제 스마트홈 앱·계정·기기는 연결하지 않았다.',
      '별도 oracle은 같은 프로젝트에서 작성된 고정 판정이며 독립 인간 저자 검토가 아니다.',
      '실제 기기의 경합·부분 성공·허브 장애·물리 안전성은 평가하지 않았다.'],
    evidence: { report: `${relative}/report.json`, summary: `${relative}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.durationMs}ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# S12 격리 기기 동작 복구 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3; 별도 oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95}ms; provider/network/external writes 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runS12DeviceAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
  if (report.outcome !== 'completed') process.exitCode = 1;
}
