import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oracleUrl = new URL('./agent-platform-independent-oracle.mjs', import.meta.url);
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; }
function safeEnv(evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_G06_EVIDENCE_PATH: evidencePath });
  return env;
}
function rel(path) { return path.slice(root.length + 1).replaceAll('\\', '/'); }

export function runG06SkillRollbackAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relative = `${outputRoot}/G06-local-${runId}`;
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
    const logPath = resolve(repDir, 'adapter-test.log');
    let status = 'failed';
    let stopCode = null;
    let oracle = null;
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-g06-skill-rollback.test.js'], {
      cwd: root, env: safeEnv(evidencePath), encoding: 'utf8', timeout: 30_000,
      windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    if (child.error || child.status !== 0) stopCode = child.error?.code ?? `G06_TEST_EXIT_${child.status ?? 'UNKNOWN'}`;
    else try {
      const output = execFileSync(process.execPath, [fileURLToPath(oracleUrl), evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
        env: safeEnv(evidencePath), maxBuffer: 1024 * 1024
      });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      status = oracle.status === 'passed' ? 'completed' : 'failed';
      if (status !== 'completed') stopCode = 'G06_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'G06_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    measurements.push({ scenarioId: 'G06', adapterId: 'g06-local-skill-revision-rollback',
      executionMode: 'local-growth-skill-registry-rollback-with-separate-process-oracle', repetition,
      startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '절차 회귀를 실패 산출물로 분리하고 성공으로 표시하지 않는다.', status,
          oracleCheckIds: ['regressed_output_is_quarantined_and_not_claimed_as_success'] },
        { requirement: '이전 승인 revision으로 되돌리고 활성 포인터·이력을 보존한다.', status,
          oracleCheckIds: ['regression_keeps_previous_revision_active', 'rollback_event_and_parent_chain_are_preserved', 'active_procedure_matches_restored_baseline'] }
      ],
      evidencePaths: [...(existsSync(evidencePath) ? [rel(evidencePath)] : []), ...(existsSync(oraclePath) ? [rel(oraclePath)] : []), rel(logPath)],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: rel(oraclePath), checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'G06', declaredFamily: 'grok',
    mode: 'public-scenario-local-skill-revision-rollback-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'local-growth-skill-registry-with-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'local registry lifecycle test plus separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['합성 revision 상태전이와 사전에 지정한 잘못된 결과만 시험했다. 새 자료에서의 실제 회귀 탐지 품질·사람 검토 품질은 검증하지 않았다.',
      '오라클은 별도 프로세스로 실행되지만 같은 저장소 코드이며 독립 인간 저자가 아니다.',
      '비용과 UI 질문·승인 횟수는 측정하지 않았다.'],
    evidence: { report: `${relative}/report.json`, summary: `${relative}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# G06 Skill revision 롤백 공개 시나리오\n\n관측: ${observedAt}\n\n- 결과: ${outcome}, ${report.counts.completed}/3\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms; provider/network/외부 쓰기 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | 별도 프로세스 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runG06SkillRollbackAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
