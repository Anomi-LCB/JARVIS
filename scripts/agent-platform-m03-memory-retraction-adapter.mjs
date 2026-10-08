import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; }
function safeEnv(evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M03_EVIDENCE_PATH: evidencePath });
  return env;
}
function rel(path) { return path.slice(root.length + 1).replaceAll('\\', '/'); }

export function runM03MemoryRetractionAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relative = `${outputRoot}/M03-local-${runId}`;
  const directory = resolve(root, relative);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relative}/repetition-${repetition}`;
    const repDir = resolve(root, repRelative);
    mkdirSync(repDir, { recursive: true });
    const evidencePath = resolve(repDir, 'evidence.json');
    const oraclePath = resolve(repDir, 'oracle.json');
    const logPath = resolve(repDir, 'memory-test.log');
    let status = 'failed';
    let stopCode = null;
    let oracle = null;
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-m03-memory-retraction.test.js'], {
      cwd: root, env: safeEnv(evidencePath), encoding: 'utf8', timeout: 30_000,
      windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    if (child.error || child.status !== 0) stopCode = child.error?.code ?? `M03_TEST_EXIT_${child.status ?? 'UNKNOWN'}`;
    else try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
        env: safeEnv(evidencePath), maxBuffer: 1024 * 1024
      });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      status = oracle.status === 'passed' ? 'completed' : 'failed';
      if (status !== 'completed') stopCode = 'M03_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'M03_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    measurements.push({ scenarioId: 'M03', adapterId: 'm03-local-memory-source-retraction',
      executionMode: 'local-growth-memory-source-retraction-sqlite-reopen-with-separate-process-oracle', repetition,
      startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '삭제된 출처에서 파생된 기억을 현재 recall에서 철회하고 재시작 뒤에도 복원하지 않는다.', status,
          oracleCheckIds: ['source_memory_is_recalled_before_explicit_deletion', 'derived_memory_is_removed_from_recall_before_and_after_reopen'] },
        { requirement: '철회 이유와 owner scope를 보존하고 물리 삭제를 과장하지 않는다.', status,
          oracleCheckIds: ['derived_preference_is_inactive_and_source_is_marked_do_not_remember', 'decision_reason_is_retained_as_historical_metadata_only', 'deleted_owner_memory_does_not_leak_to_another_scope', 'external_actions_are_absent_and_storage_erasure_is_not_overclaimed'] }
      ],
      evidencePaths: [...(existsSync(evidencePath) ? [rel(evidencePath)] : []), ...(existsSync(oraclePath) ? [rel(oraclePath)] : []), rel(logPath)],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: rel(oraclePath), checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M03', declaredFamily: 'muse',
    mode: 'public-scenario-local-memory-retraction-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'local-growth-memory-source-retraction-sqlite-reopen-with-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'local SQLite retraction/reopen test plus separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['합성 파생 선호의 recall 철회만 검사했다. 이벤트 원문과 DB/WAL/백업에서의 물리 삭제나 키 폐기는 수행하지 않았다.',
      '철회와 source_review_required 상태는 기억 조회 차단을 보여 주며 물리적 삭제 완료를 의미하지 않는다.',
      '오라클은 별도 프로세스지만 같은 저장소 코드이며 독립 인간 저자가 아니다. 비용과 실제 UI 개입은 미측정이다.'],
    evidence: { report: `${relative}/report.json`, summary: `${relative}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# M03 Growth Memory source retraction\n\n관측: ${observedAt}\n\n- 결과: ${outcome}, ${report.counts.completed}/3\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms; provider/network/외부 쓰기 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | 별도 프로세스 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM03MemoryRetractionAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
