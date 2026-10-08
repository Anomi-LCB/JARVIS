import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relative = path => path.slice(root.length + 1).replaceAll('\\', '/');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null; };
function envFor(evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M11_EVIDENCE_PATH: evidencePath });
  return env;
}

export function runM11TransportAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/M11-local-${runId}`; const runDir = resolve(root, runRelative); mkdirSync(runDir, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition++) {
    const startedAt = new Date().toISOString(); const repRelative = `${runRelative}/repetition-${repetition}`;
    const repDir = resolve(root, repRelative); mkdirSync(repDir, { recursive: true });
    const evidencePath = resolve(repDir, 'evidence.json'); const oraclePath = resolve(repDir, 'oracle.json'); const logPath = resolve(repDir, 'transport-test.log');
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-m11-transport.test.js'], { cwd: root,
      env: envFor(evidencePath), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracle = null; let stopCode = child.error?.code ?? (child.status === 0 ? null : `M11_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode && existsSync(evidencePath)) try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: envFor(evidencePath), maxBuffer: 1024 * 1024 });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1)); if (oracle.status !== 'passed') stopCode = 'M11_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'M11_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString(); const durationMs = Date.parse(finishedAt) - Date.parse(startedAt); const status = stopCode ? 'failed' : 'completed';
    measurements.push({ scenarioId: 'M11', adapterId: 'm11-meta-bounded-retry-usage-null', executionMode: 'local-mission-planner-mocked-provider-and-separate-process-oracle',
      repetition, startedAt, finishedAt, status, scenarioExecutionStatus: status, requirementResults: [
        { requirement: '고정된 planner 예산에 지정한 수만큼만 요청한다.', status, oracleCheckIds: ['bounded_retry_count_and_request_receipts'] },
        { requirement: 'usage가 없는 응답은 사용량과 비용을 모른다고 유지한다.', status, oracleCheckIds: ['missing_usage_cost_remain_null'] },
        { requirement: '실패와 성공 요청을 요청별로 구분해 기록한다.', status, oracleCheckIds: ['attempts_are_separately_accounted'] }
      ], evidencePaths: [relative(evidencePath), ...(oracle && existsSync(oraclePath) ? [relative(oraclePath)] : []), relative(logPath)],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence, resultPath: relative(oraclePath), checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, mockedProviderRequests: 2, networkRequests: 0, externalWrites: 0, retries: 1, questions: null, approvals: null,
      costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed' : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M11', declaredFamily: 'muse', mode: 'public-scenario-local-model-transport-adapter',
    executionStatusChangedInCorpus: false, outcome, repetitionsPerConfiguration: 3, measurementKind: 'mocked-meta-provider-429-then-no-usage', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length, failed: measurements.filter(item => item.status === 'failed').length,
      blocked: measurements.filter(item => item.status === 'blocked').length, independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95), unit: 'ms',
      includes: 'one 429 response, one successful response without usage, assertions and separate-process oracle' }, providerCalls: 0, networkRequests: 0, externalWrites: 0,
    mockedProviderRequests: measurements.reduce((sum, item) => sum + item.mockedProviderRequests, 0),
    costUsd: null, costMeasurement: 'unmeasured', limitations: ['외부 provider 호출은 0이고 mocked provider fetch는 반복당 2회(전체 6회)다. 실제 Meta API·지연·rate limit·비용은 검증하지 않았다.',
      'Meta API 내부에서 발생하는 시도는 로컬 provider receipts에 포함되지 않는다.', '오라클은 별도 프로세스지만 같은 저장소 코드이며 독립 인간 평가가 아니다.'],
    evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` } };
  writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runDir, 'report.md'), `# M11 모델 수송·비용 계측 검증\n\n관측: ${observedAt}\n\n- 결과: ${outcome} (${report.counts.completed}/3)\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms\n- 실제 provider 호출·네트워크·외부 쓰기: 0; 비용 미측정\n\n| 반복 | 상태 | 지연 | 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM11TransportAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts, latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
