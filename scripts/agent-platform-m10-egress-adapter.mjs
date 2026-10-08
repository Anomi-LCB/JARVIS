import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testName = 'M10 captures only minimized provider payload and proves high-sensitivity source is withheld';
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; }
function childEnvironment(evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, JARVIS_TEST_MODE: '1', JARVIS_M10_ORACLE_EVIDENCE_PATH: evidencePath };
}

export function runM10EgressAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relativeRoot = `${outputRoot}/M10-local-${runId}`;
  const runRoot = resolve(root, relativeRoot);
  mkdirSync(runRoot, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const relativeDir = `${relativeRoot}/repetition-${repetition}`;
    const directory = resolve(root, relativeDir);
    mkdirSync(directory, { recursive: true });
    const evidencePath = resolve(directory, 'evidence.json');
    const oraclePath = resolve(directory, 'oracle.json');
    const logPath = resolve(directory, 'dispatcher-test.log');
    const test = spawnSync(process.execPath, ['--test', `--test-name-pattern=${testName}`, 'tests/managed-agent-mission-tool-dispatcher.test.js'], {
      cwd: root, env: childEnvironment(evidencePath), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    writeFileSync(logPath, `${test.stdout ?? ''}${test.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let status = 'failed', stopCode = test.error?.code ?? (test.status === 0 ? null : `M10_TEST_EXIT_${test.status ?? 'UNKNOWN'}`), oracle = null;
    if (!stopCode && existsSync(evidencePath)) {
      try {
        const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
          cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: childEnvironment(evidencePath), maxBuffer: 1024 * 1024
        });
        oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
        status = oracle.status === 'passed' ? 'completed' : 'failed';
        if (status !== 'completed') stopCode = 'M10_ORACLE_FAILED';
      } catch (error) { stopCode = error?.code ?? 'M10_ORACLE_ERROR'; }
    } else if (!stopCode) stopCode = 'M10_EVIDENCE_MISSING';
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    measurements.push({ scenarioId: 'M10', adapterId: 'm10-local-minimized-egress-payload', executionMode: 'local-managed-agent-dispatcher-with-mocked-provider-and-separate-process-oracle',
      repetition, startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '혼합 자료 중 공개·개인정보를 분류하고 공개 부분만 최소화', status, oracleCheckIds: ['public_and_personal_content_is_classified_then_minimized'] },
        { requirement: '실제 dispatcher가 제출한 payload의 경계 확인', status, oracleCheckIds: ['exact_minimized_bytes_are_the_verified_provider_tool_payload'] },
        { requirement: '고위험 원문이 외부 승인·전송 전에 차단되고 이력이 남음', status, oracleCheckIds: ['high_sensitivity_content_is_stopped_before_egress_policy', 'transfer_and_cost_measurements_are_truthfully_bounded'] }
      ], evidencePaths: [`${relativeDir}/dispatcher-test.log`, ...(existsSync(evidencePath) ? [`${relativeDir}/evidence.json`] : []), ...(existsSync(oraclePath) ? [`${relativeDir}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence, resultPath: `${relativeDir}/oracle.json`, checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0, retries: 0, questions: null, approvals: null,
      costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed' : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M10', declaredFamily: 'muse', mode: 'public-scenario-local-minimized-egress-payload-adapter',
    executionStatusChangedInCorpus: false, outcome, repetitionsPerConfiguration: 3,
    measurementKind: 'local-product-managed-agent-dispatcher-with-mocked-provider-submit-and-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), 0.5), p95: percentile(measurements.map(item => item.latencyMs), 0.95),
      unit: 'ms', includes: 'product dispatcher test + separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['실제 managed-agent provider session/network 호출은 하지 않았다. “송신 payload”는 제품 dispatcher가 mock provider submit에 건넨 실제 출력이다.',
      '개인정보 마스킹과 D3 withholding은 로컬 기본 PolicySecurityRuntime classifier의 합성 입력 사례에만 적용된다. 분류기 오탐·미탐, 다국어/문서 변형 전반은 검증하지 않았다.',
      '별도 process oracle은 같은 프로젝트의 predicate이며 독립 인간 저자가 아니다. 실계정 권한, provider 비용, 사용자 승인 횟수는 미측정.'],
    evidence: { report: `${relativeRoot}/report.json`, summary: `${relativeRoot}/report.md` } };
  writeFileSync(resolve(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs}ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runRoot, 'report.md'), `# M10 개인정보 최소화·외부 전송 경계 공개 평가\n\n관측 ${observedAt}\n\n- 결과 ${outcome}: ${report.counts.completed}/3, 별도 oracle ${report.counts.independentOracleRuns}/3\n- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95}ms; provider/network/external writes 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | oracle |\n|---:|---|---:|---|\n${rows}\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM10EgressAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts, latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
