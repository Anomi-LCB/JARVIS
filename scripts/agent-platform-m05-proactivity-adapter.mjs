import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; }
function envFor(evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M05_EVIDENCE_PATH: evidencePath });
  return env;
}
function rel(path) { return path.slice(root.length + 1).replaceAll('\\', '/'); }

export function runM05ProactivityAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relative = `${outputRoot}/M05-local-${runId}`;
  const directory = resolve(root, relative);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relative}/repetition-${repetition}`;
    const repDir = resolve(root, repRelative); mkdirSync(repDir, { recursive: true });
    const evidencePath = resolve(repDir, 'evidence.json'); const oraclePath = resolve(repDir, 'oracle.json');
    const logPath = resolve(repDir, 'proactivity-test.log');
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-m05-proactivity.test.js'], {
      cwd: root, env: envFor(evidencePath), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracle = null; let stopCode = child.error?.code ?? (child.status === 0 ? null : `M05_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode && existsSync(evidencePath)) try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: envFor(evidencePath), maxBuffer: 1024 * 1024
      });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      if (oracle.status !== 'passed') stopCode = 'M05_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'M05_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString(); const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const status = stopCode ? 'failed' : 'completed';
    measurements.push({ scenarioId: 'M05', adapterId: 'm05-local-deadline-blocker-proactivity',
      executionMode: 'local-personal-operations-core-worker-and-separate-process-oracle', repetition, startedAt, finishedAt, status,
      scenarioExecutionStatus: status, requirementResults: [
        { requirement: '임박한 미해결 commitment를 기한 안에서 한 번 통지한다.', status, oracleCheckIds: ['due_reminder_matches_the_open_commitment_and_horizon'] },
        { requirement: 'Mission blocker 변경·해제를 통지하고 동일 상태는 억제한다.', status, oracleCheckIds: ['unchanged_due_and_blocker_states_are_silent', 'blocker_initial_change_and_recovery_are_signaled_once_in_order'] },
        { requirement: '알림 payload에서 개인 objective·제목을 제외하고 외부 동작을 하지 않는다.', status, oracleCheckIds: ['event_identities_are_unique_and_personal_content_is_not_projected', 'no_external_actions_or_authority_were_used'] }
      ], evidencePaths: [rel(evidencePath), ...(oracle && existsSync(oraclePath) ? [rel(oraclePath)] : []), rel(logPath)],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence, resultPath: rel(oraclePath), checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M05', declaredFamily: 'muse',
    mode: 'public-scenario-local-proactivity-state-transition-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'local-personal-operations-core-worker-and-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'six Core scheduler ticks, SQLite operations, and separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['고정 합성 commitment와 Mission 상태를 로컬 Core scheduler에 넣은 시험이다. 캘린더·메일·모바일/OS 알림 실제 전달은 검증하지 않았다.',
      'outbox는 at-least-once이며 소비자는 안정 eventId를 사용해 중복 제거해야 한다.',
      '오라클은 분리 프로세스이나 같은 저장소 코드이며 독립 인간 평가가 아니다.', '실사용 UI 질문 수와 비용은 미측정이다.'],
    evidence: { report: `${relative}/report.json`, summary: `${relative}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# M05 선제 알림 상태 전이 검증\n\n관측: ${observedAt}\n\n- 결과: ${outcome} (${report.counts.completed}/3)\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms\n- 외부 요청·쓰기·provider 호출: 0; 비용 미측정\n\n| 반복 | 상태 | 지연 | 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM05ProactivityAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts, latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
