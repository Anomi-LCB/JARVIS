import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = resolve(root, 'artifacts/agent-platform-20260929');
const reportPath = resolve(artifactRoot, 'local-proxy-evaluation.json');
const logPath = resolve(artifactRoot, 'local-proxy-evaluation-tests.log');
const runId = `${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomUUID()}`;
const runRoot = resolve(artifactRoot, 'local-proxy-runs', runId);
const immutableReportPath = resolve(runRoot, 'report.json');
const immutableMarkdownPath = resolve(runRoot, 'report.md');
const immutableLogPath = resolve(runRoot, 'tests.log');
const oracleRoot = resolve(runRoot, 'oracle');
const relativeEvidence = path => path.replace(`${root}\\`, '').replaceAll('\\', '/');
const oracleScript = resolve(root, 'scripts/agent-platform-independent-oracle.mjs');

// Fixed allowlist: these tests exercise local recovery properties only. They do
// not execute any of the public-provider scenarios in the integration corpus.
const proxies = [
  {
    id: 'G08',
    testFile: 'tests/mission-runtime.test.js',
    testName: 'G08 Core cancellation preserves a completed draft and fences a late planner wave',
    requirements: [
      { label: 'Core API로 취소가 전달되어 Mission이 취소 상태가 된다', oracleCheckIds: ['scenario_identity_and_original_command', 'authenticated_core_cancel_returns_cancelled_mission'] },
      { label: '늦게 도착한 계획 결과가 후속 웨이브나 파일 변경을 만들지 않는다', oracleCheckIds: ['in_flight_planner_result_after_cancel_cannot_start_another_wave', 'cancelled_followup_has_no_filesystem_effect'] },
      { label: '취소 전에 생성된 파일과 검증된 실행 효과는 구분해 보존한다', oracleCheckIds: ['completed_pre_cancel_action_remains_verified_and_distinguishable', 'prior_artifact_bytes_and_hash_are_recomputable', 'cancellation_event_precedes_terminal_run_event'] }
    ]
  },
  {
    id: 'G09',
    testFile: 'tests/mission-runtime.test.js',
    testName: 'G09 a reduced Mission grant blocks the planned write while the still-authorized read completes',
    requirements: [
      { label: '권한 축소 revision과 남은 권한을 반영한다', oracleCheckIds: ['scenario_identity_and_fixed_request', 'grant_revision_increments_and_only_read_remains'] },
      { label: '철회된 쓰기를 실행 전에 차단하고 현재 정책 결정을 기록한다', oracleCheckIds: ['revoked_write_is_never_dispatched_or_published', 'authorization_deny_decision_binds_current_revision_and_grants', 'policy_event_follows_revocation_before_completion'] },
      { label: '허용된 읽기는 새 revision에서 검증하며 입력 파일을 보존한다', oracleCheckIds: ['allowed_read_runs_under_reduced_revision_and_G_verification', 'allowed_input_file_bytes_and_digest_are_recomputable', 'planner_fixture_has_no_external_effect'] }
    ]
  },
  {
    id: 'G10',
    testFile: 'tests/agent-platform-g10-injection.test.js',
    testName: 'G10 untrusted web instructions are quarantined, official facts stay in the report, and egress is stopped',
    requirements: [
      { label: '오염된 웹 자료는 신뢰되지 않은 상태로 유지되고 악성 지시는 격리된다', oracleCheckIds: ['scenario_identity_and_synthetic_limit', 'web_material_remains_untrusted_and_injection_is_redacted'] },
      { label: '출처 사실과 인용은 G 검증된 로컬 보고서에 보존된다', oracleCheckIds: ['official_metadata_and_fixed_claim_are_preserved', 'report_action_is_g_verified', 'report_retains_claim_quote_and_citation_without_attack'] },
      { label: '금지된 외부 전송은 실행 경계에서 차단되고 완료로 오인되지 않는다', oracleCheckIds: ['prohibited_egress_is_recorded_and_never_executed', 'observed_worker_boundary_has_no_external_dispatch', 'runtime_does_not_report_false_completion_or_extra_files'] }
    ]
  },
  {
    id: 'G10B',
    testFile: 'tests/mission-observation-prompt-injection.test.js',
    testName: 'publisher article title, claim, and quote remain untrusted fields during planning',
    requirements: [
      { label: '기사 메타데이터 공격 문자열이 모델 계획 입력으로 유출되지 않는다', oracleCheckIds: ['scenario_identity_and_attack_fingerprint', 'metadata_attack_is_absent_from_prompt', 'article_title_is_quarantined'] },
      { label: '계약에 없는 주장·인용 필드를 제거하면서 정상 본문과 출처는 보존한다', oracleCheckIds: ['unrecognized_claim_and_quote_fields_are_not_projected', 'safe_article_body_and_provenance_survive', 'metadata_projection_is_bounded_and_closed'] }
    ]
  },
  {
    id: 'G03',
    testFile: 'tests/durable-routines.test.js',
    testName: 'G03 local product proxy schedules one Mission, writes and verifies its file, and stays complete after SQLite restart',
    requirements: [
      { label: '한국어 일정 표현이 지정 시간대의 정확한 시각으로 변환된다', oracleCheckIds: ['korean_time_resolves_to_exact_timezone_instant'] },
      { label: '예약 시각에 Mission 하나가 완료되고 검증 조건을 충족한다', oracleCheckIds: ['one_mission_completed_and_routine_is_terminal', 'verified_requirement_is_satisfied_by_mission_evidence'] },
      { label: 'SQLite 재시작 뒤 완료 상태를 유지하고 누락 예약은 늦게 실행하지 않는다', oracleCheckIds: ['artifact_bytes_match_expected_and_digest', 'sqlite_restart_does_not_dispatch_duplicate_work', 'offline_due_routine_is_reported_missed_without_execution'] }
    ]
  },
  {
    id: 'G12',
    testFile: 'tests/mission-runtime.test.js',
    testName: 'a failed researcher session is handed off to editor and verifier using the same Mission and G-verified artifact',
    requirements: [
      { label: 'same Mission is handed off', oracleCheckIds: ['same_mission_completed', 'durable_mission_matches_runtime_result'] },
      { label: 'verified artifact is reused', oracleCheckIds: ['every_action_has_G_verified_observation', 'report_artifact_matches_expected_content'] },
      { label: 'failed researcher handoff is preserved for successor roles', oracleCheckIds: ['failed_researcher_handoff_is_durable', 'shared_collaboration_scope'] }
    ]
  },
  {
    id: 'G01',
    testFile: 'tests/agent-platform-g01-role-source.test.js',
    testName: 'G01 local Mission divides public-source reads by role, rejects editor source access, and verifies one cited report',
    requirements: [
      { label: 'fixed source snapshots and exact report are preserved', oracleCheckIds: ['source_snapshots_hash_and_content', 'single_report_cites_each_fixed_source', 'artifact_bytes_match_expected_report'] },
      { label: 'researcher, editor, verifier actions remain role scoped and G verified', oracleCheckIds: ['role_handoff_order_tools_and_paths', 'each_action_has_verified_observation', 'durable_mission_matches_runtime'] },
      { label: 'editor source read is denied before tool execution', oracleCheckIds: ['denied_editor_read_is_durable_and_never_executed'] }
    ]
  },
  {
    id: 'G02X',
    testFile: 'tests/agent-platform-g02-cross-process-conflict.test.js',
    testName: 'G02 separate processes cannot both overwrite the same baseline revision',
    requirements: [
      { label: '별도 프로세스가 서로 다른 PID와 동일한 영속 잠금 범위를 사용한다', oracleCheckIds: ['scenario_identity_and_two_processes', 'both_processes_share_exact_baseline'] },
      { label: '하나의 writer만 게시되고 다른 writer는 revision 충돌로 변경 없이 차단된다', oracleCheckIds: ['exactly_one_published_revision', 'losing_writer_conflict_binds_current_and_proposed_hashes'] },
      { label: '최종 파일과 undo 기록이 단일 게시 결과에 대응한다', oracleCheckIds: ['final_content_is_published_winner', 'undo_entry_count_matches_single_mutation'] }
    ]
  },
  {
    id: 'S10',
    testFile: 'tests/agent-platform-s10-capability-catalog.test.js',
    testName: 'S10 Core capability catalog distinguishes region limits, API direction, and a partial local alternative',
    requirements: [
      { label: '한국 지역·한국어에서 지원되지 않는 Gemini 사용자 지정 앱을 사용 가능하다고 표시하지 않는다', oracleCheckIds: ['scenario_identity_and_fixed_korean_request', 'regional_and_language_limits_are_not_reported_as_supported'] },
      { label: 'Gemini가 JARVIS를 호출하는 방향과 JARVIS가 Gemini API를 호출하는 방향을 구분한다', oracleCheckIds: ['official_offer_direction_is_provider_calls_jarvis', 'inverse_api_request_is_explicitly_marked_as_direction_mismatch'] },
      { label: '현재 Core에 등록된 부분 대안만 제시하고 외부 실행 권한을 부여하지 않는다', oracleCheckIds: ['only_registered_local_workflow_is_suggested_as_partial_assistance', 'catalog_never_authorizes_or_performs_external_execution'] }
    ]
  },
  {
    id: 'G02',
    testFile: 'tests/agent-platform-g02-artifact-conflict.test.js',
    testName: 'G02 same-revision concurrent editors serialize and preserve the winner while reporting the losing proposal',
    requirements: [
      { label: 'concurrent proposals are bound to the same exact baseline', oracleCheckIds: ['same_baseline_revision_and_distinct_proposals'] },
      { label: 'one writer publishes and the other is reported without mutation', oracleCheckIds: ['one_writer_wins_and_one_conflict_is_blocked', 'final_bytes_are_exactly_the_winning_revision', 'losing_write_has_no_mutation_receipt'] },
      { label: 'conflict and rollback evidence identify the exact revisions', oracleCheckIds: ['conflict_evidence_binds_expected_current_and_proposed_hashes', 'exactly_one_undo_record_tracks_the_published_writer'] }
    ]
  }
];
const repetitionsPerConfiguration = 3;
const configurationId = 'jarvis-local-node-test-proxy';

const startedAt = new Date();
await mkdir(artifactRoot, { recursive: true });
await mkdir(dirname(runRoot), { recursive: true });
await mkdir(runRoot, { recursive: false });
await mkdir(oracleRoot, { recursive: false });
const proxyResults = [];
const measurements = [];
const logChunks = [];
for (const proxy of proxies) {
  for (let repetition = 1; repetition <= repetitionsPerConfiguration; repetition += 1) {
    const capturePath = resolve(oracleRoot, `${proxy.id}-repetition-${repetition}-evidence.json`);
    const oracleResultPath = resolve(oracleRoot, `${proxy.id}-repetition-${repetition}-oracle.json`);
    const result = await runProxy(proxy, { oracleEvidencePath: capturePath });
    const oracle = result.status === 'passed'
      ? await runIndependentOracle(capturePath, oracleResultPath)
      : null;
    const measuredStatus = result.status === 'passed' && oracle?.status === 'passed' ? 'passed' : 'failed';
    proxyResults.push({ ...result, status: measuredStatus, testStatus: result.status, oracle });
    const finishedAt = new Date().toISOString();
    const oracleChecks = new Map((oracle?.checks ?? []).map(item => [item.id, item.status]));
    const measurement = {
      measurementKind: 'local-runtime-with-independent-programmatic-oracle',
      scenarioId: proxy.id,
      scenarioExecutionStatus: 'not-run',
      configurationId,
      repetition,
      startedAt: result.startedAt,
      finishedAt,
      status: measuredStatus === 'passed' ? 'completed' : 'failed',
      requirementResults: proxy.requirements.map(requirement => {
        const independentlyChecked = requirement.oracleCheckIds.length > 0;
        const checkStatuses = requirement.oracleCheckIds.map(id => oracleChecks.get(id));
        const status = independentlyChecked && checkStatuses.length > 0 && checkStatuses.every(value => value === 'passed')
          ? 'passed' : 'failed';
        return {
          requirement: requirement.label,
          status,
          verification: 'separate-process-programmatic-oracle',
          oracleCheckIds: requirement.oracleCheckIds,
          evidence: result.testName
        };
      }),
      evidencePaths: [relativeEvidence(immutableLogPath), ...(capturePath ? [relativeEvidence(capturePath)] : []),
        ...(oracleResultPath && oracle ? [relativeEvidence(oracleResultPath)] : [])],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle,
        independence: oracle.oracleIndependence, resultPath: relativeEvidence(oracleResultPath), durationMs: oracle.durationMs } : null,
      latencyMs: result.durationMs,
      providerCalls: 0,
      retries: 0,
      questions: null,
      approvals: null,
      costUsd: null,
      costMeasurement: 'unmeasured'
    };
    measurements.push(measurement);
    logChunks.push(`=== ${proxy.id} local evaluation repetition ${repetition}/${repetitionsPerConfiguration} ${measuredStatus} (${result.durationMs.toFixed(1)} ms) ===\n${result.output}${oracle ? `\nIndependent oracle: ${oracle.status}; ${JSON.stringify(oracle.checks)}` : ''}`);
  }
}
const finishedAt = new Date();
const report = {
  schemaVersion: 1,
  observedAt: finishedAt.toISOString(),
  runId,
  mode: 'local-recovery-proxy-evaluation',
  publicScenarioStatusesChanged: false,
  publicScenariosExecuted: 0,
  publicScenarioStatus: 'not-run',
  configurationId,
  repetitionsPerConfiguration,
  proxies: proxyResults,
  measurements,
  oracleIndependence: 'S10, G08, G09, G10, G10B, G03, G12, G01, G02, and G02X: separate process and separate deterministic predicate implementation; not independently authored by an external reviewer.',
  counts: {
    total: proxyResults.length,
    passed: proxyResults.filter(item => item.status === 'passed').length,
    failed: proxyResults.filter(item => item.status === 'failed').length,
    completedProxyMeasurements: measurements.filter(item => item.status === 'completed').length,
    independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length,
    failedIndependentOracles: measurements.filter(item => item.measurementKind.includes('independent-programmatic-oracle')
      && item.oracle?.status !== 'passed').length
  },
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  latencyMs: {
    p50: percentile(measurements.map(item => item.latencyMs), 0.5),
    p95: percentile(measurements.map(item => item.latencyMs), 0.95)
  },
  networkRequests: 0,
  externalCalls: 0,
  costUsd: null,
  evidence: {
    testLog: relativeEvidence(immutableLogPath),
    runReport: relativeEvidence(immutableReportPath),
    runner: 'scripts/agent-platform-local-proxy-evaluation.mjs',
    immutableRunDirectory: relativeEvidence(runRoot)
  },
  limitation: 'S10 and G08, G09, G10, G10B, G03, G12, G01, G02, and G02X are local runs whose captured state and outputs are checked by a separate-process deterministic oracle; the checker shares this repository and was not independently authored. S10 queries a read-only local catalog against one fixed Gemini custom-app availability entry and the registered local workflow package; it is not a live Google account check, a provider call, proof of feature equivalence, or a complete public-scenario execution. G08 uses the authenticated local Core API, temporary filesystem, and a planner fixture that returns late after cancellation; no real provider stream is involved. G09 reduces Mission grants while a local plan is held, then checks execution-time authorization decisions; it does not exercise remote account-scope revocation. G10 uses a synthetic offline W3C excerpt with adversarial text and verifies the local worker dispatch boundary; it does not prove resilience to every injection form, live web content, provider behavior, or network egress outside the observed worker. G10B is a prompt-projection unit run over fixed article metadata, not a provider request or end-to-end Mission. G03 is a fixed local task, not an external provider or chat/voice request. The earlier same-runtime M02 proxy is omitted because it cannot satisfy the strengthened public M02 distinct-process PID contract; the dedicated two-process M02 adapter is evaluated separately. G01 uses an offline W3C snapshot, not live pages. G02 retains its single-adapter-instance check; G02X tests two same-host processes sharing one persistent UndoJournal path, not separate machines, different journal paths, or network filesystems. None executes or passes the public provider integration scenarios or proves a live account, device, independent human oracle, or external cost.'
};

await writeFile(logPath, `${logChunks.join('\n\n')}\n`, 'utf8');
await writeFile(immutableLogPath, `${logChunks.join('\n\n')}\n`, { encoding: 'utf8', flag: 'wx' });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const markdown = `# JARVIS 로컬 복구·권한·주입 차단 평가\n\n관측 시각: ${report.observedAt}\n\n공개 통합 시나리오 실행: 0건 (상태 ${report.publicScenarioStatus}, 상태 변경 없음). 로컬 평가 ${report.counts.passed}/${report.counts.total} 반복 완료; 구성당 ${report.repetitionsPerConfiguration}회. 별도 프로세스 오라클 ${report.counts.independentOracleRuns}/${report.counts.total} 통과 (G08 취소, G09 권한 축소, G10 주입·egress, G10B 기사 메타데이터 필드 격리, G03 일정·재시작, G12 역할 인계, G01 공개 자료 역할분담, G02 동일 인스턴스 revision 충돌, G02X 다중 프로세스 revision 충돌).\n\n| 시나리오 | 반복 | 평가 결과 | 공개 시나리오 실행 | 별도 오라클 | 지연 |\n|---|---:|---|---|---|---:|\n${measurements.map(item => `| ${item.scenarioId} | ${item.repetition} | ${item.status} | ${item.scenarioExecutionStatus} | ${item.oracle?.status ?? '미실행'} | ${item.latencyMs.toFixed(1)} ms |`).join('\n')}\n\np50 ${report.latencyMs.p50.toFixed(1)} ms / p95 ${report.latencyMs.p95.toFixed(1)} ms (테스트 프로세스 시간; 별도 오라클 처리 시간 제외). 질문·승인 횟수는 미측정이며 null; 공급자 호출은 0; 비용은 미측정(null).\n\n네트워크 요청: ${report.networkRequests}; 외부 호출: ${report.externalCalls}.\n\n${report.limitation}\n\n원시 로그: \`${report.evidence.testLog}\`.\n`;
await writeFile(resolve(artifactRoot, 'local-proxy-evaluation.md'), markdown, 'utf8');
await writeFile(immutableMarkdownPath, markdown, { encoding: 'utf8', flag: 'wx' });
await writeFile(immutableReportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ report: immutableReportPath, counts: report.counts, publicScenariosExecuted: report.publicScenariosExecuted, durationMs: report.durationMs }, null, 2));
if (report.counts.failed > 0) process.exitCode = 1;

async function runProxy(proxy, { oracleEvidencePath = null } = {}) {
  const startedAt = new Date();
  const started = performance.now();
  const args = [
    '--test',
    `--test-name-pattern=${proxy.testName}`,
    resolve(root, proxy.testFile)
  ];
  const env = {
    ...process.env,
    JARVIS_LLM_INTENT: '0',
    JARVIS_LLM_PLANNER: '0',
    JARVIS_LLM_CONTENT: '0',
    JARVIS_ANTHROPIC_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    JARVIS_OPENAI_API_KEY: '',
    OPENAI_API_KEY: '',
    JARVIS_XAI_API_KEY: '',
    JARVIS_META_API_KEY: '',
    JARVIS_GEMINI_API_KEY: '',
    JARVIS_EXTERNAL_DEVICE_PROBES: '0',
    JARVIS_TEST_MODE: '1',
    ...(oracleEvidencePath ? {
      [`JARVIS_${proxy.id}_ORACLE_EVIDENCE_PATH`]: oracleEvidencePath
    } : {})
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const exit = await new Promise(resolveExit => {
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    child.once('error', error => { clearTimeout(timer); resolveExit({ code: 1, signal: null, error: error.message }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code: code ?? 1, signal, error: null }); });
  });
  const durationMs = performance.now() - started;
  const match = output.match(/ℹ tests (\d+)\s+ℹ suites (\d+)\s+ℹ pass (\d+)\s+ℹ fail (\d+)/u);
  const testsExpected = 1;
  const testsPassed = match ? Number(match[3]) : 0;
  const status = exit.code === 0 && testsPassed === testsExpected && output.includes(`✔ ${proxy.testName}`)
    ? 'passed' : 'failed';
  return {
    id: proxy.id,
    status,
    startedAt: startedAt.toISOString(),
    testFile: proxy.testFile,
    testName: proxy.testName,
    testsExpected,
    testsPassed,
    durationMs,
    exitCode: exit.code,
    signal: exit.signal,
    error: exit.error,
    output
  };
}

async function runIndependentOracle(evidencePath, outputPath) {
  const started = performance.now();
  const child = spawn(process.execPath, [oracleScript, evidencePath, outputPath], {
    cwd: root,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exit = await new Promise(resolveExit => {
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.once('error', error => { clearTimeout(timer); resolveExit({ code: 1, error: error.message }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code: code ?? 1, signal, error: null }); });
  });
  const durationMs = performance.now() - started;
  try {
    const output = JSON.parse((await readFile(outputPath, 'utf8')));
    return { ...output, durationMs, exitCode: exit.code,
      status: exit.code === 0 && output.status === 'passed' ? 'passed' : 'failed', diagnostic: stderr || null };
  } catch {
    return { oracle: 'jarvis-independent-mission-recovery-oracle-v1', status: 'failed', durationMs,
      exitCode: exit.code, diagnostic: exit.error ?? stderr ?? stdout ?? 'ORACLE_RESULT_UNAVAILABLE' };
  }
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}


