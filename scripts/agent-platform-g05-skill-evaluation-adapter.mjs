import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oracle = fileURLToPath(new URL('./agent-platform-independent-oracle.mjs', import.meta.url));
const rel = path => path.slice(root.length + 1).replaceAll('\\', '/');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null; };

export function runG05SkillEvaluationAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/G05-local-${runId}`;
  const runDirectory = resolve(root, runRelative);
  mkdirSync(runDirectory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repetitionRelative = `${runRelative}/repetition-${repetition}`;
    const repetitionDirectory = resolve(root, repetitionRelative);
    mkdirSync(repetitionDirectory, { recursive: true });
    const evidencePath = resolve(repetitionDirectory, 'evidence.json');
    const oraclePath = resolve(repetitionDirectory, 'oracle.json');
    const logPath = resolve(repetitionDirectory, 'adapter-test.log');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_G05_EVIDENCE_PATH: evidencePath });
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-g05-skill-evaluation.test.js'], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracleResult = null;
    let stopCode = child.error?.code ?? (child.status === 0 ? null : `G05_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    let status = 'failed';
    if (!stopCode && existsSync(evidencePath)) {
      try {
        const output = execFileSync(process.execPath, [oracle, evidencePath, oraclePath], {
          cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env, maxBuffer: 1_000_000
        });
        oracleResult = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
        status = oracleResult.status === 'passed' ? 'completed' : 'failed';
        if (status !== 'completed') stopCode = 'G05_INDEPENDENT_ORACLE_FAILED';
      } catch (error) { stopCode = error?.code ?? 'G05_ORACLE_ERROR'; }
    } else if (!stopCode) stopCode = 'G05_EVIDENCE_MISSING';
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    measurements.push({ scenarioId: 'G05', adapterId: 'g05-local-skill-cross-material-evaluation',
      executionMode: 'local-skill-registry-synthetic-demonstration-and-renamed-header-holdout-with-separate-process-oracle',
      repetition, startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '초안은 새 자료 평가 전까지 검토·승격될 수 없다.', status, oracleCheckIds: ['failed_alias_trial_stays_unpromoted'] },
        { requirement: '변경된 열 이름의 별도 holdout에서 정답과 대조하고 성공 뒤에도 명시 검토가 필요하다.', status,
          oracleCheckIds: ['demonstration_and_distinct_holdout_both_pass', 'renamed_headers_are_explicit_and_bounded',
            'successful_trial_requires_owner_review_and_keeps_default_execution_off'] },
        { requirement: '원자료 행을 registry에 저장하지 않는다.', status, oracleCheckIds: ['raw_holdout_rows_are_not_persisted'] }
      ],
      evidencePaths: [...(existsSync(evidencePath) ? [rel(evidencePath)] : []), ...(existsSync(oraclePath) ? [rel(oraclePath)] : []), rel(logPath)],
      oracle: oracleResult ? { status: oracleResult.status, name: oracleResult.oracle,
        independence: oracleResult.oracleIndependence, resultPath: rel(oraclePath), checks: oracleResult.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: 0, approvals: 1, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'G05', declaredFamily: 'grok',
    mode: 'public-scenario-local-skill-cross-material-evaluation-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'synthetic-local-skill-revision-trials-with-separate-process-oracle', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'local registry test and separate process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['고정 synthetic 표 자료와 deterministic tabular-group-sum 절차만 평가했다. 자연어로 시범을 해석하거나 일반 문서 업무의 의미 품질을 학습하지 않는다.',
      '별도 프로세스 오라클은 같은 저장소 코드이며 독립 인간 저자가 아니다. UI, 외부 provider, 계정, 실제 업무 데이터는 검증하지 않았다.',
      '승격된 절차도 executableByDefault=false 및 policy review 조건을 유지한다. 비용은 미측정이며 외부 호출은 0이다.'],
    evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` } };
  writeFileSync(resolve(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runDirectory, 'report.md'), `# G05 교차 자료 skill 평가 공개 시나리오\n\n관측: ${observedAt}\n\n- 결과: ${outcome}, ${report.counts.completed}/3\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms; 외부 호출 0; 비용 미측정\n- UI 승인은 반복당 1회로 설정된 시험 시나리오이며 실제 사용자 UI 관측은 아님\n\n| 반복 | 결과 | 지연 | 별도 프로세스 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runG05SkillEvaluationAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
