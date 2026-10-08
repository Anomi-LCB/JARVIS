import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testName = 'S04 compares complete synthetic travel quotes, refreshes price changes, and never claims booking';
const env = path => {
  const selected = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) selected[key] = process.env[key];
  }
  Object.assign(selected, { JARVIS_TEST_MODE: '1', JARVIS_S04_EVIDENCE_PATH: path });
  return selected;
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

export function runS04TravelSandboxAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relativeRoot = `${outputRoot}/S04-local-${runId}`;
  const directory = resolve(root, relativeRoot);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relativeRoot}/repetition-${repetition}`;
    const rep = resolve(root, repRelative);
    mkdirSync(rep, { recursive: true });
    const evidencePath = resolve(rep, 'evidence.json');
    const oraclePath = resolve(rep, 'oracle.json');
    const logPath = resolve(rep, 'sandbox-test.log');
    let status = 'failed'; let stopCode = null; let oracle = null;
    const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=${testName}`, 'tests/agent-platform-s04-travel-sandbox.test.js'], {
      cwd: root, env: env(evidencePath), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    if (child.error || child.status !== 0 || !existsSync(evidencePath)) stopCode = child.error?.code ?? `S04_TEST_EXIT_${child.status ?? 'UNKNOWN'}`;
    else {
      try {
        const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
          cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: env(evidencePath), maxBuffer: 1024 * 1024
        });
        oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
        status = oracle.status === 'passed' ? 'completed' : 'failed';
        if (status !== 'completed') stopCode = 'S04_ORACLE_FAILED';
      } catch (error) { stopCode = error?.code ?? 'S04_ORACLE_ERROR'; }
    }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    measurements.push({ scenarioId: 'S04', adapterId: 's04-synthetic-travel-quote-sandbox',
      executionMode: 'local-synthetic-quote-revision-and-separate-process-independent-oracle', repetition,
      startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [{ requirement: '합성 견적의 전체 수수료·환불 조건·현지 시간·가격 갱신을 보존해 재정렬', status,
        oracleCheckIds: ['initial_total_is_recomputed_from_every_fee', 'price_change_is_versioned_and_total_recomputed',
          'refreshed_ranking_uses_complete_totals', 'provider_conditions_and_offset_local_times_are_preserved'] },
      { requirement: '예약 불가와 외부 부작용 0을 정확히 표시', status,
        oracleCheckIds: ['sandbox_never_exposes_booking_or_external_effect'] }],
      evidencePaths: [`${repRelative}/sandbox-test.log`, ...(existsSync(evidencePath) ? [`${repRelative}/evidence.json`] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0, retries: 0,
      questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'S04', declaredFamily: 'travel',
    mode: 'public-scenario-local-travel-quote-sandbox-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3,
    measurementKind: 'synthetic-local-travel-quote-revision-test-with-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length,
      blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5),
      p95: percentile(measurements.map(item => item.latencyMs), .95), unit: 'ms', includes: 'sandbox test + separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['이 어댑터는 합성 오퍼만 사용하며 실제 항공사·철도·숙박 API나 현재 요금을 조회하지 않는다.',
      '예약·결제·취소를 실행할 수 없으며 bookingAvailable=false가 고정 계약이다.',
      '별도 oracle은 같은 저장소의 predicate이며 독립 인간 작성이 아니다. 비용·질문·승인 횟수는 미측정.'],
    evidence: { report: `${relativeRoot}/report.json`, summary: `${relativeRoot}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# S04 여행 견적 합성 샌드박스 공개 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3, 별도 프로세스 oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95} ms; 공급자 호출·네트워크·외부 쓰기 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runS04TravelSandboxAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
