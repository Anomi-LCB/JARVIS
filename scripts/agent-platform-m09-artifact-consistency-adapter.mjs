import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relative = path => path.slice(root.length + 1).replaceAll('\\', '/');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null; };
function envFor(evidencePath, missionEvidencePath, missionOraclePath, missionWorkspaceRoot) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M09_EVIDENCE_PATH: evidencePath,
    JARVIS_M09_MISSION_EVIDENCE_PATH: missionEvidencePath, JARVIS_M09_MISSION_ORACLE_PATH: missionOraclePath,
    JARVIS_M09_MISSION_WORKSPACE_ROOT: missionWorkspaceRoot });
  return env;
}

export function runM09ArtifactConsistencyAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/M09-local-${runId}`;
  const runDir = resolve(root, runRelative);
  mkdirSync(runDir, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition++) {
    const startedAt = new Date().toISOString();
    const repRelative = `${runRelative}/repetition-${repetition}`;
    const repDir = resolve(root, repRelative);
    mkdirSync(repDir, { recursive: true });
    const evidencePath = resolve(repDir, 'evidence.json');
    const missionEvidencePath = resolve(repDir, 'mission-evidence.json');
    const oraclePath = resolve(repDir, 'oracle.json');
    const missionOraclePath = resolve(repDir, 'mission-oracle.json');
    const missionWorkspaceRoot = resolve(repDir, 'workspace');
    const logPath = resolve(repDir, 'consistency-test.log');
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-m09-artifact-consistency.test.js', 'tests/mission-criteria-evidence.test.js'], {
      cwd: root, env: envFor(evidencePath, missionEvidencePath, missionOraclePath, missionWorkspaceRoot), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracle = null;
    let stopCode = child.error?.code ?? (child.status === 0 ? null : `M09_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode && existsSync(evidencePath)) try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: envFor(evidencePath, missionEvidencePath, missionOraclePath, missionWorkspaceRoot), maxBuffer: 1024 * 1024 });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      if (oracle.status !== 'passed') stopCode = 'M09_ORACLE_FAILED';
      if (!stopCode && existsSync(missionEvidencePath) && existsSync(missionOraclePath)) {
        const missionOracle = JSON.parse(readFileSync(missionOraclePath, 'utf8'));
        oracle.mission = missionOracle;
        if (missionOracle.status !== 'passed') stopCode = 'M09_MISSION_ORACLE_FAILED';
      } else if (!stopCode) stopCode = 'M09_MISSION_EVIDENCE_MISSING';
    } catch (error) { stopCode = error?.code ?? 'M09_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const status = stopCode ? 'failed' : 'completed';
    measurements.push({ scenarioId: 'M09', adapterId: 'm09-mission-workflow-shared-source-artifact-facts',
      executionMode: 'isolated-mission-inline-workflow-and-separate-process-oracles', repetition, startedAt, finishedAt,
      status, scenarioExecutionStatus: status,
      requirementResults: [
        { requirement: '실제 Mission workflow가 원본 JSON 하나에서 source/report/table/card 네 파일을 파생한다.', status,
          oracleCheckIds: ['four_created_files_are_reopened_and_digest_bound_to_G', 'one_workflow_action_G_bound_all_four_output_files'] },
        { requirement: '보고서·표·카드가 하나의 source ID·revision·digest와 typed facts를 보존한다.', status,
          oracleCheckIds: ['report_table_and_card_match_source_identity_revision_and_facts'] },
        { requirement: '잘못된 수치·이전 revision·G 증거 누락은 완료를 차단한다.', status,
          oracleCheckIds: ['source_digest_and_expected_facts_match', 'all_typed_numeric_facts_match_the_source'] }
      ], evidencePaths: [relative(evidencePath), ...(existsSync(missionEvidencePath) ? [relative(missionEvidencePath)] : []),
        ...(oracle && existsSync(oraclePath) ? [relative(oraclePath)] : []), ...(oracle?.mission && existsSync(missionOraclePath) ? [relative(missionOraclePath)] : []), relative(logPath)],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: relative(oraclePath), checks: oracle.checks,
        mission: oracle.mission ? { status: oracle.mission.status, name: oracle.mission.oracle,
          independence: oracle.mission.oracleIndependence, resultPath: relative(missionOraclePath), checks: oracle.mission.checks } : null } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed' : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M09', declaredFamily: 'muse',
    mode: 'public-scenario-local-artifact-consistency-adapter', executionStatusChangedInCorpus: false,
    outcome, repetitionsPerConfiguration: 3, measurementKind: 'mission-inline-source-workflow-with-bounded-fact-and-stale-projection-controls', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed' && item.oracle.mission?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'fixture startup, consistency checks, stale projection checks and separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: [
      '고정 합성 facts로 외부 뉴스 자료·보고서 자연어 의미·실제 Excel 렌더링·카드 이미지 픽셀 의미를 검증하지 않는다.',
      '두 오라클은 별도 프로세스에서 실행되지만 같은 저장소 코드이며 독립 인간 평가가 아니다. 비용은 미측정.'
    ], evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` } };
  writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} / ${item.oracle?.mission?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runDir, 'report.md'), `# M09 산출물 출처·수치 일관성 평가\n\n관측: ${observedAt}\n\n- 결과: ${outcome} (${report.counts.completed}/3); 기본/Mission 별도 프로세스 오라클 ${report.counts.independentOracleRuns}/3\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms\n- provider/network/external writes 0; 비용 미측정\n\n| 반복 | 상태 | 지연 | 기본 / Mission 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM09ArtifactConsistencyAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
