import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relative = path => path.slice(root.length + 1).replaceAll('\\', '/');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null; };
function envFor(evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M08_EVIDENCE_PATH: evidencePath });
  return env;
}

export function runM08BrowserHandoffAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/M08-local-${runId}`;
  const runDir = resolve(root, runRelative);
  mkdirSync(runDir, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition++) {
    const startedAt = new Date().toISOString();
    const repRelative = `${runRelative}/repetition-${repetition}`;
    const repDir = resolve(root, repRelative);
    mkdirSync(repDir, { recursive: true });
    const evidencePath = resolve(repDir, 'evidence.json');
    const oraclePath = resolve(repDir, 'oracle.json');
    const logPath = resolve(repDir, 'handoff-test.log');
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-m08-browser-handoff.test.js'], {
      cwd: root, env: envFor(evidencePath), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracle = null;
    let stopCode = child.error?.code ?? (child.status === 0 ? null : `M08_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode && existsSync(evidencePath)) try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: envFor(evidencePath), maxBuffer: 1024 * 1024 });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      if (oracle.status !== 'passed') stopCode = 'M08_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'M08_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const status = stopCode ? 'failed' : 'completed';
    measurements.push({ scenarioId: 'M08', adapterId: 'm08-local-browser-human-handoff-generation-gate',
      executionMode: 'synthetic-browser-driver-human-handoff-generation-and-origin-gate', repetition,
      startedAt, finishedAt, status, scenarioExecutionStatus: status,
      requirementResults: [
        { requirement: '인계 중 지연된 입력을 실행하지 않는다.', status, oracleCheckIds: ['delayed_input_is_fenced_when_handoff_begins'] },
        { requirement: '사용자 확인 후 현재 출처와 권한을 다시 검사한다.', status, oracleCheckIds: ['owner_confirmation_and_scope_reauthorization_are_required'] },
        { requirement: '이전 실행 티켓을 폐기하고 자격증명 입력을 금지한다.', status, oracleCheckIds: ['resume_rotates_generation_and_invalidates_old_ticket', 'credential_entry_is_never_an_agent_action'] }
      ], evidencePaths: [relative(evidencePath), ...(oracle && existsSync(oraclePath) ? [relative(oraclePath)] : []), relative(logPath)],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: relative(oraclePath), checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed' : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M08', declaredFamily: 'muse',
    mode: 'public-scenario-local-browser-human-handoff-generation-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'synthetic-driver-with-delayed-input-race-and-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'fixture startup, human-handoff gate, delayed action race and separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: [
      '이 실행은 합성 driver를 사용한다. 제품에 지속형 로그인 브라우저나 일반 browser.interact 경로가 연결됐다는 뜻이 아니다.',
      '인계 전에 이미 driver.click 내부에서 시작된 되돌릴 수 없는 UI 동작은 취소를 보장하지 않는다. 실제 driver는 취소 토큰·직렬화 경계를 제공해야 한다.',
      '실제 브라우저·로그인·OS 대화형 세션·계정 인증은 실행하지 않았다. 비밀번호·OTP·세션 토큰은 fixture 입력에도 넣지 않았다.',
      '오라클은 별도 프로세스지만 같은 저장소의 predicate이며 독립 인간 평가가 아니다. 비용은 미측정.'
    ], evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` } };
  writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runDir, 'report.md'), `# M08 브라우저 사용자 인계 게이트 평가\n\n관측: ${observedAt}\n\n- 결과: ${outcome} (${report.counts.completed}/3); 별도 프로세스 오라클 ${report.counts.independentOracleRuns}/3\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms\n- provider/network/external writes 0; 비용 미측정\n\n| 반복 | 상태 | 지연 | 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM08BrowserHandoffAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
