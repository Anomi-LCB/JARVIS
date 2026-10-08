import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON || 'python';
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];

function selectedEnvironment(additions) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'PYTHON',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PYTHONUTF8: '1', JARVIS_TEST_MODE: '1' }, additions);
  return env;
}

export function runG11DesktopFixtureAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relativeRoot = `${outputRoot}/G11-local-${runId}`;
  const directory = resolve(root, relativeRoot);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relativeRoot}/repetition-${repetition}`;
    const rep = resolve(root, repRelative);
    const screenshotDir = resolve(rep, 'screenshots');
    mkdirSync(screenshotDir, { recursive: true });
    const evidencePath = resolve(rep, 'evidence.json');
    const oraclePath = resolve(rep, 'oracle.json');
    const browserLogPath = resolve(rep, 'browser-fixture.log');
    const pythonRun = spawnSync(python, ['scripts/agent-platform-g11-desktop-fixture.py'], { cwd: root,
      env: selectedEnvironment({ JARVIS_G11_ORACLE_EVIDENCE_PATH: evidencePath, JARVIS_G11_ARTIFACT_DIR: screenshotDir }),
      encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(browserLogPath, `${pythonRun.stdout ?? ''}${pythonRun.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let status = 'failed', stopCode = null, oracle = null;
    if (pythonRun.error || pythonRun.status !== 0 || !existsSync(evidencePath)) {
      stopCode = pythonRun.error?.code ?? `G11_BROWSER_EXIT_${pythonRun.status ?? 'UNKNOWN'}`;
    } else try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
        env: selectedEnvironment({ JARVIS_TEST_EVIDENCE_PATH: evidencePath }), maxBuffer: 1024 * 1024
      });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      status = oracle.status === 'passed' ? 'completed' : 'failed';
      if (status !== 'completed') stopCode = 'G11_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'G11_ORACLE_ERROR'; }
    const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
    const finishedAt = new Date().toISOString();
    measurements.push({ scenarioId: 'G11', adapterId: 'g11-accessible-settings-layout-change-fixture',
      executionMode: 'isolated-loopback-chromium-accessibility-locators-localStorage-and-screenshot-hash-oracle', repetition,
      startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '버튼 위치가 바뀌어도 접근성 이름으로 같은 설정을 찾음', status,
          oracleCheckIds: ['accessibility_locators_survive_layout_shift'] },
        { requirement: '요청한 설정만 변경하고 저장 상태를 다시 읽음', status,
          oracleCheckIds: ['only_requested_setting_changed_and_persisted', 'saved_state_re_read_after_layout_reload'] }
      ],
      evidencePaths: [`${repRelative}/browser-fixture.log`, ...(existsSync(evidencePath) ? [`${repRelative}/evidence.json`] : []),
        ...(evidence?.screenshotBeforePath ? [evidence.screenshotBeforePath] : []), ...(evidence?.screenshotAfterPath ? [evidence.screenshotAfterPath] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt), providerCalls: 0,
      networkRequests: evidence?.requests?.length ?? null, externalWrites: evidence?.externalWrites ?? null,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'G11', declaredFamily: 'grok',
    mode: 'public-scenario-local-desktop-fixture-browser-adapter', executionStatusChangedInCorpus: false, outcome,
    repetitionsPerConfiguration: 3, measurementKind: 'headless-installed-chromium-loopback-fixture-and-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.durationMs), .5),
      p95: percentile(measurements.map(item => item.durationMs), .95), unit: 'ms', includes: 'browser fixture launch, UI state assertions, screenshots, and separate process oracle' },
    providerCalls: 0, networkRequests: measurements.reduce((sum, item) => sum + (item.networkRequests ?? 0), 0),
    externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['실제 Windows native UI Automation·화면 인식·사용자 앱은 시험하지 않고, 격리된 Chromium fixture의 접근성 이름 기반 상호작용만 확인했다.',
      '브라우저는 headless이며 외부 네트워크/provider 호출은 없다.',
      'fixture와 fixed oracle은 같은 프로젝트에서 작성되어 독립 인간 검토가 아니다.'],
    evidence: { report: `${relativeRoot}/report.json`, summary: `${relativeRoot}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.durationMs}ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# G11 화면 배치 변경 UI fixture 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3; 별도 oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95}ms; provider calls 0; requests ${report.networkRequests} (loopback only); external writes 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runG11DesktopFixtureAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
  if (report.outcome !== 'completed') process.exitCode = 1;
}
