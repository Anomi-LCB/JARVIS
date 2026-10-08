import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oracle = fileURLToPath(new URL('./agent-platform-independent-oracle.mjs', import.meta.url));
const rel = path => path.slice(root.length + 1).replaceAll('\\', '/');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null; };
const testPattern = '(M12 executes the exact candidate adapter artifact in the restricted container and applies a host oracle|M12 runs a real isolated candidate evaluation through stage, review, promotion and rollback|M12 keeps expected outputs outside the candidate mount and rejects a contract mismatch)';

export function runM12CapabilityPromotionAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/M12-local-${runId}`;
  const runDirectory = resolve(root, runRelative);
  mkdirSync(runDirectory, { recursive: true });
  const measurements = [];

  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const repetitionDirectory = resolve(runDirectory, `repetition-${repetition}`);
    mkdirSync(repetitionDirectory, { recursive: true });
    const isolatedPath = resolve(repetitionDirectory, 'isolated.json');
    const lifecyclePath = resolve(repetitionDirectory, 'lifecycle.json');
    const negativePath = resolve(repetitionDirectory, 'negative.json');
    const evidencePath = resolve(repetitionDirectory, 'evidence.json');
    const oraclePath = resolve(repetitionDirectory, 'oracle.json');
    const logPath = resolve(repetitionDirectory, 'adapter-test.log');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M12_EVIDENCE_PATH: isolatedPath,
      JARVIS_M12_E2E_EVIDENCE_PATH: lifecyclePath, JARVIS_M12_NEGATIVE_EVIDENCE_PATH: negativePath });
    const startedAt = new Date().toISOString();
    const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=${testPattern}`,
      'tests/capability-package-container-evaluator.test.js'], {
      cwd: root, env, encoding: 'utf8', timeout: 90_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
    });
    const log = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    writeFileSync(logPath, log, { encoding: 'utf8', flag: 'wx' });
    const summary = log.match(/ℹ tests (\d+)\s+ℹ suites (\d+)\s+ℹ pass (\d+)\s+ℹ fail (\d+)/u);
    let stopCode = child.error?.code ?? (child.status === 0 ? null : `M12_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode && (!summary || Number(summary[1]) !== 3 || Number(summary[3]) !== 3 || Number(summary[4]) !== 0)) {
      stopCode = 'M12_TEST_COVERAGE_MISMATCH';
    }

    let oracleResult = null;
    if (!stopCode && [isolatedPath, lifecyclePath, negativePath].every(existsSync)) {
      const evidence = { schemaVersion: 1, scenarioId: 'M12',
        isolated: JSON.parse(readFileSync(isolatedPath, 'utf8')),
        lifecycle: JSON.parse(readFileSync(lifecyclePath, 'utf8')),
        negative: JSON.parse(readFileSync(negativePath, 'utf8')) };
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      try {
        const output = execFileSync(process.execPath, [oracle, evidencePath, oraclePath], {
          cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env, maxBuffer: 1_000_000
        });
        oracleResult = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
        if (oracleResult.status !== 'passed') stopCode = 'M12_INDEPENDENT_ORACLE_FAILED';
      } catch (error) { stopCode = error?.code ?? 'M12_ORACLE_ERROR'; }
    } else if (!stopCode) stopCode = 'M12_EVIDENCE_MISSING';

    const finishedAt = new Date().toISOString();
    measurements.push({ scenarioId: 'M12', adapterId: 'm12-local-capability-promotion',
      executionMode: 'restricted-docker-container-evaluation-stage-review-promote-rollback-and-negative-contract-check',
      repetition, startedAt, finishedAt,
      status: stopCode ? 'failed' : 'completed', scenarioExecutionStatus: stopCode ? 'not-run' : 'completed',
      requirementResults: [
        { requirement: '후보 도구는 네트워크 차단·읽기전용 rootfs 컨테이너에서 시험한다.', status: stopCode ? 'failed' : 'completed', oracleCheckIds: ['candidate_runs_in_restricted_container'] },
        { requirement: '실격리 평가와 명시 검토 뒤에만 교체하고 rollback으로 이전 버전을 복원한다.', status: stopCode ? 'failed' : 'completed', oracleCheckIds: ['activation_waits_for_evaluation_and_explicit_review', 'rollback_restores_prior_active_package'] },
        { requirement: '계약 불일치 산출물은 거부하고 기대값을 후보 컨테이너에 노출하지 않는다.', status: stopCode ? 'failed' : 'completed', oracleCheckIds: ['contract_mismatch_fails_without_exposing_expected_output'] }
      ], evidencePaths: [isolatedPath, lifecyclePath, negativePath, ...(existsSync(evidencePath) ? [evidencePath] : []),
        ...(existsSync(oraclePath) ? [oraclePath] : []), logPath].map(rel),
      oracle: oracleResult ? { status: oracleResult.status, name: oracleResult.oracle,
        independence: oracleResult.oracleIndependence, resultPath: rel(oraclePath), checks: oracleResult.checks } : null,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt), providerCalls: 0, networkRequests: 0,
      externalWrites: 0, retries: 0, questions: 0, approvals: 0, costUsd: null,
      costMeasurement: 'unmeasured', stopCode });
  }

  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M12', declaredFamily: 'muse',
    mode: 'public-scenario-local-capability-promotion-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'restricted-container-evaluation-and-explicit-review-promotion-rollback',
    measurements, counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.durationMs), .5),
      p95: percentile(measurements.map(item => item.durationMs), .95), unit: 'ms',
      includes: 'three selected lifecycle test cases and a separate process oracle per repetition' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['Docker Desktop의 Linux 컨테이너 격리와 합성 adapter fixture를 시험했다. 별도 관리 하드닝 VM이나 Docker daemon 탈출 불가를 입증하지 않는다.',
      '실제 사용자 도구·실계정·운영 Core 서비스에 패키지를 설치하거나 승격하지 않았다. 검증된 시험은 전용 임시 registry를 사용한다.',
      'Oracle은 별도 프로세스와 별도 predicate이나 같은 저장소 코드다. 독립 인간 평가·장기 운영·비용은 미측정이다.'],
    evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` } };
  writeFileSync(resolve(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.durationMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runDirectory, 'report.md'), `# M12 Capability 도구 격리 평가·승격·복원 공개 시나리오\n\n관측: ${observedAt}\n\n- 결과: ${outcome}, ${report.counts.completed}/3; 별도 프로세스 오라클 ${report.counts.independentOracleRuns}/3\n- provider/network/외부 쓰기 0; 비용 미측정\n\n| 반복 | 결과 | 지연 | 별도 프로세스 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM12CapabilityPromotionAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    evidence: report.evidence }, null, 2));
}
