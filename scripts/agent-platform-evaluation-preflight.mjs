import { readFileSync, mkdirSync, writeFileSync, realpathSync, statSync, readdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateG01LivePublicSourceEvidence, evaluateG02ArtifactConflictEvidence, evaluateG03DurableRoutineEvidence, evaluateG05SkillEvaluationEvidence, evaluateM01LongGoalEvidence, evaluateG06SkillRollbackEvidence, evaluateG08CancellationEvidence, evaluateG09RevocationEvidence, evaluateG10InjectionEvidence, evaluateG11DesktopFixtureEvidence, evaluateG12HandoffEvidence, evaluateM02RecoveryEvidence, evaluateM03MemoryRetractionEvidence, evaluateM04PreferenceRevisionEvidence, evaluateM05ProactivityEvidence, evaluateM06ContainerSandboxEvidence, evaluateM07RemoteEnvironmentRecoveryEvidence, evaluateM08BrowserHandoffEvidence, evaluateM09ArtifactConsistencyEvidence, evaluateM09MissionConsistencyEvidence, evaluateM11TransportEvidence, evaluateS10CapabilityCatalogEvidence, evaluateS11HealthSummaryEvidence, evaluateS12DeviceSimulatorEvidence, evaluateS03LatestRevisionPublicationEvidence, evaluateM10EgressEvidence, evaluateM12CapabilityPromotionEvidence, evaluateS05NodePartitionEvidence, evaluateS04TravelQuoteEvidence, evaluateS08DualBrowserEvidence, evaluateS09WeeklyTimezoneRevisionEvidence } from './agent-platform-independent-oracle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(readFileSync(resolve(root, 'config/agent-platform-evaluation.json'), 'utf8'));
const bindings = JSON.parse(readFileSync(resolve(root, 'config/agent-platform-evaluation-bindings.json'), 'utf8'));
const adapterSource = JSON.parse(readFileSync(resolve(root, 'config/agent-platform-adapters.json'), 'utf8'));
const validStates = new Set(['available-local', 'blocked', 'unimplemented']);

export function buildPreflight(evaluation, bindingCatalog, observedAt = new Date().toISOString(), workspaceRoot = root,
  adapterCatalog = adapterSource, executionHistory = []) {
  if (!Array.isArray(evaluation.scenarios) || evaluation.scenarios.length !== 36) {
    throw new Error(`expected 36 public scenarios; got ${evaluation.scenarios?.length ?? 'invalid'}`);
  }
  const ids = new Set();
  const usedRequirements = new Set();
  const adaptersByScenario = new Map();
  const latestRuns = new Map();
  if (!Array.isArray(executionHistory)) throw new Error('execution history must be an array');
  for (const run of executionHistory) {
    if (!run || typeof run.scenarioId !== 'string' || !['completed', 'failed', 'blocked'].includes(run.outcome)
        || !Number.isFinite(Date.parse(run.observedAt))) throw new Error('invalid public scenario run record');
    const current = latestRuns.get(run.scenarioId);
    if (!current || Date.parse(run.observedAt) > Date.parse(current.observedAt)) latestRuns.set(run.scenarioId, run);
  }
  if (!Array.isArray(adapterCatalog.adapters)) throw new Error('adapter catalog must contain an adapter array');
  for (const adapter of adapterCatalog.adapters) {
    if (!adapter.id || adapter.state !== 'implemented' || !Array.isArray(adapter.scenarioIds)
        || !adapter.scenarioIds.length || typeof adapter.entrypoint !== 'string') {
      throw new Error(`invalid scenario adapter: ${adapter.id ?? 'unknown'}`);
    }
    const target = resolve(workspaceRoot, adapter.entrypoint);
    const relativeTarget = relative(resolve(workspaceRoot), target);
    if (isAbsolute(adapter.entrypoint) || !relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)
        || !statSync(realpathSync(target)).isFile()) throw new Error(`adapter entrypoint is missing or outside workspace: ${adapter.id}`);
    for (const scenarioId of adapter.scenarioIds) {
      if (adaptersByScenario.has(scenarioId)) throw new Error(`multiple adapters for scenario: ${scenarioId}`);
      adaptersByScenario.set(scenarioId, adapter);
    }
  }
  const scenarios = evaluation.scenarios.map(scenario => {
    if (!scenario.id || ids.has(scenario.id)) throw new Error(`missing or duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!Array.isArray(scenario.requires) || scenario.requires.length === 0) throw new Error(`${scenario.id} has no requirements`);
    const requirements = scenario.requires.map(id => {
      usedRequirements.add(id);
      const binding = bindingCatalog.requirements?.[id];
      if (!binding || !validStates.has(binding.state) || !binding.nextAction) throw new Error(`invalid or missing binding: ${id}`);
      if (binding.state === 'available-local') {
        if (!Array.isArray(binding.evidence) || binding.evidence.length === 0) throw new Error(`available binding has no evidence: ${id}`);
        for (const evidencePath of binding.evidence) {
          if (typeof evidencePath !== 'string' || isAbsolute(evidencePath)) throw new Error(`invalid evidence path for ${id}`);
          const candidatePath = resolve(workspaceRoot, evidencePath);
          const candidateRelative = relative(resolve(workspaceRoot), candidatePath);
          if (!candidateRelative || candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`)) throw new Error(`evidence path escapes workspace: ${id}`);
          const actualPath = realpathSync(candidatePath);
          const actualRelative = relative(realpathSync(workspaceRoot), actualPath);
          if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || !statSync(actualPath).isFile()) {
            throw new Error(`available binding evidence is not a workspace file: ${id}`);
          }
        }
      }
      return { id, ...binding };
    });
    const blockers = requirements.filter(item => item.state === 'blocked');
    const gaps = requirements.filter(item => item.state === 'unimplemented');
    const readiness = gaps.length ? 'unimplemented' : blockers.length ? 'blocked' : 'requirements-ready';
    const adapter = adaptersByScenario.get(scenario.id) ?? null;
    const adapterStatus = adapter ? 'available' : 'missing';
    const scenarioExecutionEligible = readiness === 'requirements-ready' && adapterStatus === 'available';
    const latestRun = latestRuns.get(scenario.id) ?? null;
    const currentExecutionStatus = latestRun?.outcome ?? 'not-run';
    return {
      id: scenario.id,
      family: scenario.family,
      declaredExecutionStatus: scenario.status,
      currentExecutionStatus,
      latestRun: latestRun ? { runId: latestRun.runId ?? null, observedAt: latestRun.observedAt, outcome: latestRun.outcome,
        repetitions: latestRun.repetitions ?? null, oraclePasses: latestRun.oraclePasses ?? null } : null,
      readiness,
      adapterStatus,
      adapterId: adapter?.id ?? null,
      adapterMode: adapter?.executionMode ?? null,
      scenarioExecutionEligible,
      executed: currentExecutionStatus !== 'not-run',
      requirements,
      nextActions: [...new Set([...gaps, ...blockers].map(item => item.nextAction))],
      note: latestRun
        ? `최근 실제 어댑터 실행은 ${latestRun.outcome}이다. 원래 코퍼스 선언값(${scenario.status})은 실행 기록과 분리해 보존한다.`
        : scenarioExecutionEligible
        ? '실행 어댑터와 정적 준비 조건은 확인했지만 이 사전점검은 실행하지 않으므로 실행 결과는 원래 선언 상태를 유지한다.'
        : readiness === 'requirements-ready'
          ? '필수조건의 로컬 증거는 있으나 이 공개 시나리오 전용 실행 어댑터가 없어 실행 결과는 not-run이다.'
        : '준비도 분류일 뿐 실행·성공 증거가 아니다.'
    };
  });
  const unusedBindings = Object.keys(bindingCatalog.requirements ?? {}).filter(id => !usedRequirements.has(id));
  if (unusedBindings.length) throw new Error(`unused bindings: ${unusedBindings.join(', ')}`);
  return {
    schemaVersion: 1,
    observedAt,
    mode: 'read-only-preflight-no-scenario-execution',
    source: 'config/agent-platform-evaluation.json',
    bindingSource: 'config/agent-platform-evaluation-bindings.json',
    executionStatusChanged: false,
    networkRequests: 0,
    scenarios,
    counts: {
      total: scenarios.length,
      executionStatusNotRun: scenarios.filter(item => item.currentExecutionStatus === 'not-run').length,
      executionStatusCompleted: scenarios.filter(item => item.currentExecutionStatus === 'completed').length,
      executionStatusFailed: scenarios.filter(item => item.currentExecutionStatus === 'failed').length,
      executionStatusBlocked: scenarios.filter(item => item.currentExecutionStatus === 'blocked').length,
      scenarioAdaptersAvailable: scenarios.filter(item => item.adapterStatus === 'available').length,
      scenarioExecutionEligible: scenarios.filter(item => item.scenarioExecutionEligible).length,
      readiness: Object.fromEntries(['requirements-ready', 'blocked', 'unimplemented'].map(state => [state, scenarios.filter(item => item.readiness === state).length])),
      byFamily: Object.fromEntries([...new Set(scenarios.map(item => item.family))].map(family => [family, {
        total: scenarios.filter(item => item.family === family).length,
        readiness: Object.fromEntries(['requirements-ready', 'blocked', 'unimplemented'].map(state => [state, scenarios.filter(item => item.family === family && item.readiness === state).length]))
      }])),
      executed: scenarios.filter(item => item.executed).length
    },
    holdout: { ...evaluation.holdout, executedCount: 0 },
    adapterCatalog: 'config/agent-platform-adapters.json',
    limitation: '사전점검은 실제 공급자·계정·기기·독립 오라클 실행을 수행하지 않는다. requirements-ready도 시나리오 통과가 아니다.'
  };
}

export function writePreflightReport(report, outputPath = 'artifacts/agent-platform-20260928/evaluation-preflight.json') {
  const destination = resolve(root, outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  const markdownPath = destination.replace(/\.json$/i, '.md');
  const rows = report.scenarios.map(item => `| ${item.id} | ${item.family} | ${item.readiness} | ${item.adapterStatus} | ${item.declaredExecutionStatus} | ${item.currentExecutionStatus} | ${item.latestRun?.observedAt ?? '—'} | ${item.requirements.map(requirement => requirement.id).join(', ')} |`).join('\n');
  const familyRows = Object.entries(report.counts.byFamily).map(([family, item]) => `| ${family} | ${item.total} | ${item.readiness['requirements-ready']} | ${item.readiness.blocked} | ${item.readiness.unimplemented} |`).join('\n');
  const summary = `# 통합 시나리오 준비도 사전점검\n\n관측 시각: ${report.observedAt}\n\n이 문서는 준비도와 기존 실행 이력을 함께 보여 주는 읽기 전용 요약이며, 이 명령이 시나리오를 실행하지는 않았다(새 실행 0건, 네트워크 요청 ${report.networkRequests}건). 원본 공개 코퍼스 상태는 변경하지 않았다. 최근 실행 기록 없음 ${report.counts.executionStatusNotRun}개, 완료 ${report.counts.executionStatusCompleted}개, 실패 ${report.counts.executionStatusFailed}개, 차단 ${report.counts.executionStatusBlocked}개. 실행 어댑터 ${report.counts.scenarioAdaptersAvailable}개, 실행 가능 시나리오 ${report.counts.scenarioExecutionEligible}개. 홀드아웃 실행 ${report.holdout.executedCount}/${report.holdout.requiredCount}.\n\n- 필수조건 준비: ${report.counts.readiness['requirements-ready']}\n- 외부 조건 차단: ${report.counts.readiness.blocked}\n- 구현 공백: ${report.counts.readiness.unimplemented}\n\n| 계열 | 전체 | 필수조건 준비 | 외부 조건 차단 | 구현 공백 |\n|---|---:|---:|---:|---:|\n${familyRows}\n\n| ID | 계열 | 준비도 | 실행 어댑터 | 원본 선언 상태 | 최근 실행 상태 | 최근 실행 관측시각 | 명시 요구조건 |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n${report.limitation}\n`;
  const snapshotId = `${report.observedAt.replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}-${randomUUID()}`;
  const snapshotDirectory = join(dirname(destination), 'preflight-runs', snapshotId);
  mkdirSync(snapshotDirectory, { recursive: true });
  const snapshotJsonPath = join(snapshotDirectory, 'evaluation-preflight.json');
  const snapshotMarkdownPath = join(snapshotDirectory, 'evaluation-preflight.md');
  const artifactManifest = {
    latestJson: relative(root, destination).replaceAll('\\', '/'),
    latestMarkdown: relative(root, markdownPath).replaceAll('\\', '/'),
    immutableJson: relative(root, snapshotJsonPath).replaceAll('\\', '/'),
    immutableMarkdown: relative(root, snapshotMarkdownPath).replaceAll('\\', '/')
  };
  const storedReport = { ...report, artifactManifest };
  // Create the immutable evidence first. A failed snapshot write must never leave
  // a new mutable "latest" pointer that has no corresponding durable record.
  writeFileSync(snapshotJsonPath, `${JSON.stringify(storedReport, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(snapshotMarkdownPath, summary, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(destination, `${JSON.stringify(storedReport, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, summary, 'utf8');
  return { latest: destination, immutable: snapshotJsonPath, immutableMarkdown: snapshotMarkdownPath };
}

export function loadPublicScenarioRunHistory(workspaceRoot = root) {
  let runRoots;
  try { runRoots = readdirSync(resolve(workspaceRoot, 'artifacts'), { withFileTypes: true })
    .filter(item => item.isDirectory() && /^agent-platform-\d{8}$/u.test(item.name))
    .map(item => resolve(workspaceRoot, 'artifacts', item.name, 'public-scenarios'))
    .filter(path => existsSync(path)); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const history = [];
  for (const runRoot of runRoots) {
  let entries;
  try { entries = readdirSync(runRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(?:G(?:01-live|02-local|03-local|05-local|06-local|08-local|09-local|10-local|11-local|12-local)|M01-local|M02-local|M03-local|M04-local|M05-local|M06-local|M07-local|M08-local|M09-local|M11-local|S03-local|S04-local|S05-local|S08-local|S09-local|S10-local|S11-local|S12-local|M10-local|M12-local)-[0-9]{8}T[0-9]{6}Z-[0-9a-f-]{36}$/u.test(entry.name)) continue;
    const path = resolve(runRoot, entry.name, 'report.json');
    // Adapters create an evidence directory before the report is atomically
    // finalized. Concurrent status/preflight reads must ignore that in-flight run.
    if (!existsSync(path)) continue;
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const expectedMode = report?.scenarioId === 'G01' ? 'public-scenario-live-source-local-mission-adapter'
      : report?.scenarioId === 'G02' ? 'public-scenario-local-artifact-conflict-adapter'
      : report?.scenarioId === 'G03' ? 'public-scenario-local-durable-routine-adapter'
      : report?.scenarioId === 'M01' ? 'public-scenario-local-long-goal-revision-adapter'
      : report?.scenarioId === 'G05' ? 'public-scenario-local-skill-cross-material-evaluation-adapter'
      : report?.scenarioId === 'G06' ? 'public-scenario-local-skill-revision-rollback-adapter'
      : report?.scenarioId === 'G08' ? 'public-scenario-local-cancellation-mission-adapter'
      : report?.scenarioId === 'G09' ? 'public-scenario-local-revocation-mission-adapter'
      : report?.scenarioId === 'G10' ? 'public-scenario-local-web-injection-egress-adapter'
      : report?.scenarioId === 'G11' ? 'public-scenario-local-desktop-fixture-browser-adapter'
      : report?.scenarioId === 'M02' ? 'public-scenario-separate-product-process-recovery-adapter'
      : report?.scenarioId === 'M03' ? 'public-scenario-local-memory-retraction-adapter'
      : report?.scenarioId === 'M04' ? 'public-scenario-local-preference-revision-adapter'
      : report?.scenarioId === 'M05' ? 'public-scenario-local-proactivity-state-transition-adapter'
      : report?.scenarioId === 'M06' ? 'public-scenario-local-os-container-isolation'
      : report?.scenarioId === 'M07' ? 'public-scenario-local-managed-environment-loss-recovery-adapter'
      : report?.scenarioId === 'M08' ? 'public-scenario-local-browser-human-handoff-generation-adapter'
      : report?.scenarioId === 'M09' ? 'public-scenario-local-artifact-consistency-adapter'
      : report?.scenarioId === 'M11' ? 'public-scenario-local-model-transport-adapter'
      : report?.scenarioId === 'S10' ? 'public-scenario-local-capability-region-direction-adapter'
      : report?.scenarioId === 'S11' ? 'public-scenario-local-synthetic-health-record-adapter'
      : report?.scenarioId === 'S12' ? 'public-scenario-local-isolated-device-reconciliation-adapter'
      : report?.scenarioId === 'S03' ? 'public-scenario-local-latest-source-revision-publication-adapter'
      : report?.scenarioId === 'S04' ? 'public-scenario-local-travel-quote-sandbox-adapter'
      : report?.scenarioId === 'S08' ? 'public-scenario-local-dual-browser-binding-adapter'
      : report?.scenarioId === 'S09' ? 'public-scenario-local-weekly-timezone-revision-adapter'
      : report?.scenarioId === 'S05' ? 'public-scenario-local-logical-node-pc-partition-mission-adapter'
      : report?.scenarioId === 'M10' ? 'public-scenario-local-minimized-egress-payload-adapter'
      : report?.scenarioId === 'M12' ? 'public-scenario-local-capability-promotion-adapter'
      : report?.scenarioId === 'G12' ? 'public-scenario-local-role-handoff-mission-adapter' : null;
    if (!expectedMode || report?.mode !== expectedMode
        || report.runId !== entry.name.replace(/^(?:G01-live|G02-local|G03-local|G05-local|G06-local|G08-local|G09-local|G10-local|G11-local|G12-local|M01-local|M02-local|M03-local|M04-local|M05-local|M06-local|M07-local|M08-local|M09-local|M11-local|S03-local|S04-local|S05-local|S08-local|S09-local|S10-local|S11-local|S12-local|M10-local|M12-local)-/u, '')
        || !['completed', 'failed', 'blocked'].includes(report.outcome)
        || !Array.isArray(report.measurements) || report.measurements.length !== 3
        || report.measurements.some(item => item.scenarioId !== report.scenarioId)) {
      throw new Error(`invalid public scenario run report: ${entry.name}`);
    }
    const oraclePasses = report.measurements.filter(item => item.oracle?.status === 'passed').length;
    if (report.outcome === 'completed') {
      if (report.counts?.completed !== report.measurements.length || oraclePasses !== report.measurements.length
          || report.counts?.independentOracleRuns !== report.measurements.length) {
        throw new Error(`completed scenario run has incomplete oracle coverage: ${entry.name}`);
      }
      for (const measurement of report.measurements) {
        const expectedEvidenceName = 'evidence.json';
        const evidenceRelative = measurement.evidencePaths?.find(value => value.endsWith(`/${expectedEvidenceName}`));
        const oracleRelative = measurement.oracle?.resultPath;
        if (!evidenceRelative || !oracleRelative || isAbsolute(evidenceRelative) || isAbsolute(oracleRelative)) {
          throw new Error(`completed scenario run is missing bound evidence: ${entry.name}`);
        }
        const evidencePath = resolve(workspaceRoot, evidenceRelative);
        const oraclePath = resolve(workspaceRoot, oracleRelative);
        for (const target of [evidencePath, oraclePath]) {
          const targetRelative = relative(resolve(workspaceRoot), target);
          if (!targetRelative || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)
              || !statSync(realpathSync(target)).isFile()) throw new Error(`completed scenario evidence escapes workspace or is missing: ${entry.name}`);
        }
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
        const storedOracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
        const recomputed = report.scenarioId === 'G11' ? evaluateG11DesktopFixtureEvidence(evidence)
          : report.scenarioId === 'M07' ? evaluateM07RemoteEnvironmentRecoveryEvidence(evidence)
          : report.scenarioId === 'S12' ? evaluateS12DeviceSimulatorEvidence(evidence)
          : report.scenarioId === 'S11' ? evaluateS11HealthSummaryEvidence(evidence)
          : report.scenarioId === 'G01' ? evaluateG01LivePublicSourceEvidence(evidence)
          : report.scenarioId === 'S05' ? evaluateS05NodePartitionEvidence(evidence)
          : report.scenarioId === 'S04' ? evaluateS04TravelQuoteEvidence(evidence)
          : report.scenarioId === 'S08' ? evaluateS08DualBrowserEvidence(evidence)
          : report.scenarioId === 'S09' ? evaluateS09WeeklyTimezoneRevisionEvidence(evidence)
          : report.scenarioId === 'M12' ? evaluateM12CapabilityPromotionEvidence(evidence)
          : report.scenarioId === 'M02' ? evaluateM02RecoveryEvidence(evidence)
          : report.scenarioId === 'M03' ? evaluateM03MemoryRetractionEvidence(evidence)
          : report.scenarioId === 'M04' ? evaluateM04PreferenceRevisionEvidence(evidence)
          : report.scenarioId === 'M05' ? evaluateM05ProactivityEvidence(evidence)
          : report.scenarioId === 'M06' ? evaluateM06ContainerSandboxEvidence(evidence)
          : report.scenarioId === 'M08' ? evaluateM08BrowserHandoffEvidence(evidence)
          : report.scenarioId === 'M09' ? evaluateM09ArtifactConsistencyEvidence(evidence)
          : report.scenarioId === 'M11' ? evaluateM11TransportEvidence(evidence)
          : report.scenarioId === 'G02' ? evaluateG02ArtifactConflictEvidence(evidence)
          : report.scenarioId === 'G06' ? evaluateG06SkillRollbackEvidence(evidence)
          : report.scenarioId === 'G05' ? evaluateG05SkillEvaluationEvidence(evidence)
          : report.scenarioId === 'M01' ? evaluateM01LongGoalEvidence(evidence)
          : report.scenarioId === 'G03' ? evaluateG03DurableRoutineEvidence(evidence)
          : report.scenarioId === 'G08' ? evaluateG08CancellationEvidence(evidence)
          : report.scenarioId === 'G09' ? evaluateG09RevocationEvidence(evidence)
          : report.scenarioId === 'G10' ? evaluateG10InjectionEvidence(evidence)
          : report.scenarioId === 'S10' ? evaluateS10CapabilityCatalogEvidence(evidence)
          : report.scenarioId === 'S03' ? evaluateS03LatestRevisionPublicationEvidence(evidence)
          : report.scenarioId === 'M10' ? evaluateM10EgressEvidence(evidence) : evaluateG12HandoffEvidence(evidence);
        let missionConsistency = null;
        if (report.scenarioId === 'M09') {
          const missionEvidenceRelative = measurement.evidencePaths?.find(value => value.endsWith('/mission-evidence.json'));
          const missionOracleRelative = measurement.oracle?.mission?.resultPath;
          if (!missionEvidenceRelative || !missionOracleRelative || isAbsolute(missionEvidenceRelative) || isAbsolute(missionOracleRelative)) {
            history.push({ scenarioId: report.scenarioId, runId: report.runId, observedAt: report.observedAt,
              outcome: 'failed', repetitions: report.measurements.length, oraclePasses: 0,
              validationIssue: 'mission-bound-evidence-contract-missing' });
            continue;
          }
          const missionEvidencePath = resolve(workspaceRoot, missionEvidenceRelative);
          const missionOraclePath = resolve(workspaceRoot, missionOracleRelative);
          for (const target of [missionEvidencePath, missionOraclePath]) {
            const targetRelative = relative(resolve(workspaceRoot), target);
            if (!targetRelative || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)
                || !statSync(realpathSync(target)).isFile()) {
              missionConsistency = { status: 'failed', checks: [] };
              break;
            }
          }
          if (!missionConsistency) {
          missionConsistency = evaluateM09MissionConsistencyEvidence(JSON.parse(readFileSync(missionEvidencePath, 'utf8')));
          const storedMissionOracle = JSON.parse(readFileSync(missionOraclePath, 'utf8'));
          if (missionConsistency.status !== 'passed' || storedMissionOracle.status !== missionConsistency.status
              || JSON.stringify(storedMissionOracle.checks) !== JSON.stringify(missionConsistency.checks)) {
            missionConsistency = { status: 'failed', checks: [] };
          }
          }
          if (missionConsistency.status !== 'passed') {
            history.push({ scenarioId: report.scenarioId, runId: report.runId, observedAt: report.observedAt,
              outcome: 'failed', repetitions: report.measurements.length, oraclePasses: 0,
              validationIssue: 'mission-bound-oracle-revalidation-failed' });
            continue;
          }
        }
        const verified = recomputed;
        const m02ProcessBoundary = recomputed.checks.find(item => item.id === 'process_restart_is_separate');
        if (report.scenarioId === 'M02' && m02ProcessBoundary?.status !== 'passed') {
          // Earlier immutable M02 runs predating PID-bound process-restart evidence are retained,
          // but no longer count as completed under the strengthened public-scenario contract.
          history.push({ scenarioId: report.scenarioId, runId: report.runId, observedAt: report.observedAt,
            outcome: 'failed', repetitions: report.measurements.length, oraclePasses: 0 });
          continue;
        }
        if (verified.status !== 'passed' || storedOracle.status !== 'passed'
            || JSON.stringify(storedOracle.checks) !== JSON.stringify(verified.checks)
            || measurement.oracle.status !== verified.status) {
          if (report.scenarioId === 'M11' || report.scenarioId === 'M06' || report.scenarioId === 'M08' || report.scenarioId === 'M09' || report.scenarioId === 'S03') {
            // Preserve the immutable run, but do not count a completed claim whose
            // stored result was generated under an unbound oracle revision.
            history.push({ scenarioId: report.scenarioId, runId: report.runId, observedAt: report.observedAt,
              outcome: 'failed', repetitions: report.measurements.length, oraclePasses: 0,
              validationIssue: 'stored-oracle-contract-did-not-match-recomputed-result' });
            continue;
          }
          throw new Error(`completed scenario run oracle revalidation failed: ${entry.name}`);
        }
      }
    }
    history.push({ scenarioId: report.scenarioId, runId: report.runId, observedAt: report.observedAt,
      outcome: report.outcome, repetitions: report.measurements.length, oraclePasses });
  }
  }
  return history;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = buildPreflight(source, bindings, new Date().toISOString(), root, adapterSource, loadPublicScenarioRunHistory(root));
  const artifacts = writePreflightReport(report, process.argv[2]);
  console.log(JSON.stringify({ report: artifacts.latest, immutableEvidence: artifacts.immutable,
    immutableSummary: artifacts.immutableMarkdown, counts: report.counts, holdout: report.holdout,
    networkRequests: report.networkRequests }, null, 2));
}
