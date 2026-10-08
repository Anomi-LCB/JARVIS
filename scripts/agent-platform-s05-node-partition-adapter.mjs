import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = 'public-scenario-local-logical-node-pc-partition-mission-adapter';
const pct = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; };
const envFor = evidencePath => {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0',
    JARVIS_LLM_CONTENT: '0', JARVIS_S05_EVIDENCE_PATH: evidencePath });
  return env;
};

export function runS05NodePartitionAdapter({ outputRoot = 'artifacts/agent-platform-20260930/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const relative = `${outputRoot}/S05-local-${runId}`;
  const directory = resolve(root, relative);
  mkdirSync(directory, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repRelative = `${relative}/repetition-${repetition}`;
    const rep = resolve(root, repRelative);
    mkdirSync(rep, { recursive: true });
    const fixtureRoot = resolve(rep, 'fixture');
    const evidence = resolve(rep, 'evidence.json');
    const oraclePath = resolve(rep, 'oracle.json');
    const logPath = resolve(rep, 'product-processes.log');
    let status = 'failed'; let stopCode = null; let oracle = null; let output = '';
    try {
      for (const phase of ['node-phase', 'pc-resume']) {
        const result = spawnSync(process.execPath, ['scripts/agent-platform-s05-node-partition-fixture.mjs', phase,
          fixtureRoot, ...(phase === 'pc-resume' ? [evidence] : [])], { cwd: root, env: envFor(evidence),
          encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
        output += `\n$ ${phase}\n${result.stdout ?? ''}${result.stderr ?? ''}`;
        if (result.error || result.status !== 0) throw Object.assign(new Error(`${phase} exited ${result.status}`),
          { code: result.error?.code ?? `S05_${phase.toUpperCase().replaceAll('-', '_')}_EXIT_${result.status ?? 'UNKNOWN'}` });
      }
      if (!existsSync(evidence)) throw Object.assign(new Error('S05 evidence missing after product-process phases.'), { code: 'S05_EVIDENCE_MISSING' });
      const oracleText = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidence, oraclePath],
        { cwd: root, env: envFor(evidence), encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      oracle = JSON.parse(oracleText.trim().split(/\r?\n/u).at(-1));
      status = oracle.status === 'passed' ? 'completed' : 'failed';
      if (status !== 'completed') stopCode = 'S05_ORACLE_FAILED';
    } catch (error) {
      stopCode = error?.code ?? 'S05_ADAPTER_ERROR';
    }
    writeFileSync(logPath, output, { encoding: 'utf8', flag: 'wx' });
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const oracleChecks = oracle?.checks?.map(item => item.id) ?? [];
    measurements.push({ scenarioId: 'S05', adapterId: 's05-local-logical-node-pc-partition', executionMode: mode,
      repetition, startedAt, finishedAt, status, scenarioExecutionStatus: status === 'completed' ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: 'PC 오프라인 중 상시 노드 작업을 수행하고 PC 작업은 대기', status,
          oracleCheckIds: ['offline_pc_is_paused_without_attempt_or_side_effect'] },
        { requirement: 'PC 복귀 뒤 같은 Mission에서 최신 가용성을 확인해 작업하고 G 증거로 완료', status,
          oracleCheckIds: ['separate_runtime_processes_and_restart_boundary', 'pc_resume_completes_one_verified_mission_action',
            'both_actual_mission_actions_have_passed_g_evidence'] },
        { requirement: '공급자·네트워크 없이 결과 및 실증 한계를 명시', status,
          oracleCheckIds: ['node_and_pc_artifacts_are_exact_and_hash_bound', 'no_external_provider_network_or_external_write',
            'physical_deployment_boundary_is_not_overclaimed'] }
      ], evidencePaths: [`${repRelative}/product-processes.log`, ...(existsSync(evidence) ? [`${repRelative}/evidence.json`] : []),
        ...(existsSync(oraclePath) ? [`${repRelative}/oracle.json`] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repRelative}/oracle.json`, checks: oracleChecks.map(id => ({ id,
          status: oracle.checks.find(item => item.id === id)?.status })) } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0,
      retries: 0, questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed'
    : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'S05', declaredFamily: 'spark', mode,
    executionStatusChangedInCorpus: false, outcome, repetitionsPerConfiguration: 3,
    measurementKind: 'real-local-jarvis-mission-in-separate-node-processes-with-synthetic-capability-probes',
    measurements, counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length,
      blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: pct(measurements.map(item => item.latencyMs), .5), p95: pct(measurements.map(item => item.latencyMs), .95),
      unit: 'ms', includes: 'two JARVIS product processes and separate-process evidence oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['상시 노드와 사용자 PC를 논리 capability로 분리했지만 같은 OS 호스트와 같은 파일시스템을 사용했다.',
      '실제 원격 서비스 identity, 네트워크 transport, 다른 PC 재연결, PC 절전·서비스 운영은 검증하지 않았다.',
      '가용성 관측은 합성 probe다. 공개 자료 내용도 고정 합성 텍스트이며 실제 웹 리서치 품질을 시험하지 않았다.',
      'oracle은 별도 프로세스의 구조화 증거 검사이며 같은 저장소의 predicate로 독립 인간 평가는 아니다.',
      '공급자 호출·네트워크·외부 쓰기 없음. 사용자 질문·승인 횟수 해당 없음, API 비용은 미측정.'],
    evidence: { report: `${relative}/report.json`, summary: `${relative}/report.md` } };
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(directory, 'report.md'), `# S05 상시 노드·PC 분할 업무 공개 평가\n\n관측 ${observedAt}\n\n`
    + `- 결과 **${outcome}**: ${report.counts.completed}/3, 별도 프로세스 oracle ${report.counts.independentOracleRuns}/3\n`
    + `- p50/p95 ${report.latencyMs.p50}/${report.latencyMs.p95}ms; provider/network/external writes 0; 비용 미측정\n\n`
    + `| 반복 | 결과 | 전체 지연(ms) | oracle |\n|---:|---|---:|---|\n${rows}\n\n`
    + `${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runS05NodePartitionAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
    latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
  if (report.outcome !== 'completed') process.exitCode = 1;
}
