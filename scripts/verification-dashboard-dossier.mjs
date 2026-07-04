import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ActionType } from '../packages/shared/src/types.js';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export async function runVerificationDashboardDossier({
  jsonPath = 'dist/verification-dashboard-dossier.json',
  markdownPath = 'dist/verification-dashboard-dossier.md',
  csvPath = 'dist/verification-dashboard-dossier.csv',
  auditRoot = 'dist/verification-dashboard-runtime',
  clock = () => new Date(),
  failBelow = 0.95,
  scoreFailBelow = 85
} = {}) {
  const { policyRuntime, verificationRuntime } = createAgRuntime({ auditRoot, clock });
  const planFixture = verificationRuntime.simulationRunner.planFixture({
    taskId: 'task_g_dashboard_plan',
    actionType: ActionType.CREATE_FILE
  });
  const planReport = verificationRuntime.verifyPlan({
    verificationId: 'ver_g_dashboard_plan',
    taskId: 'task_g_dashboard_plan',
    target: planFixture
  });
  const goldenTrace = verificationRuntime.createGoldenTrace({
    traceId: 'golden_g_dashboard_plan',
    label: 'G dashboard plan verifier smoke',
    report: planReport
  });
  const baselineComparison = verificationRuntime.compareBaseline({
    traceId: 'golden_g_dashboard_plan',
    report: planReport
  });
  const approvedBaseline = verificationRuntime.approveBaselineUpdate({
    traceId: 'golden_g_dashboard_plan',
    report: planReport,
    approvedBy: 'verification_dashboard_dossier',
    reason: 'Release dossier baseline approval for the current G verification pack.'
  });
  const documentInvariantExtraction = verificationRuntime.runDocumentInvariantExtraction({ failBelow: 0.85 });
  const documentInvariantTrend = verificationRuntime.documentInvariantTrend();
  const planVerifierFixturePack = verificationRuntime.runPlanVerifierFixturePack({ failBelow });
  const planVerifierFixtureTrend = verificationRuntime.planVerifierFixtureTrend();
  const semanticInvariantDedupe = verificationRuntime.semanticInvariantDedupeClassifier({
    catalog: documentInvariantExtraction.catalog
  });
  const planDocumentDiffFixtureRun = verificationRuntime.runPlanDocumentDiffFixtures({ failBelow });
  const planRegressionVisualization = verificationRuntime.planRegressionVisualization({ limit: 20 });
  const planVerifierProductGate = verificationRuntime.planVerifierProductGate({ failBelow });
  const planVerifierCiAnnotation = planVerifierProductGate.ciAnnotation;
  const planVerifierArtifactSync = planVerifierProductGate.artifactSync;
  const fixtureMatrix = verificationRuntime.runFixtureMatrix({ failBelow });
  const policyComplianceFixturePack = verificationRuntime.runPolicyComplianceFixturePack({ failBelow });
  const policyComplianceSnapshot = verificationRuntime.policyComplianceSnapshot({
    report: policyComplianceFixturePack,
    policyStatus: policyRuntime.policyAsCodeStatus()
  });
  const policyComplianceMigrationMatrix = verificationRuntime.signedPolicyMigrationMatrix();
  const policyComplianceDriftDiff = verificationRuntime.policyComplianceDriftDiff({
    baseline: policyComplianceSnapshot,
    current: policyComplianceSnapshot
  });
  const policyComplianceTrend = verificationRuntime.policyComplianceTrend();
  const policyComplianceProductGate = verificationRuntime.policyComplianceProductGate({ failBelow });
  const bridgeSecurityProductDrill = verificationRuntime.bridgeSecurityProductDrill({ cycles: 3 });
  const bridgeSecurityReleaseDossier = verificationRuntime.bridgeSecurityReleaseDossier({
    cycles: 3,
    reason: 'verification_dashboard_bridge_security_release_dossier'
  });
  const executionVerifierCorpus = await verificationRuntime.runExecutionVerifierCorpus({ failBelow });
  const executionVerifierTrend = verificationRuntime.executionVerifierTrend();
  const executionExternalFixturePack = verificationRuntime.executionExternalAdapterFixturePack();
  const executionAdapterSoak = await verificationRuntime.runExecutionAdapterSoak({ cycles: 2, failBelow });
  const executionArtifactRetention = verificationRuntime.executionVerifierArtifactRetention({ keepLast: 50, dryRun: false });
  const executionFlakyQuarantine = verificationRuntime.executionFlakyFixtureQuarantine();
  const executionVerifierProductGate = await verificationRuntime.executionVerifierProductGate({
    cycles: 2,
    failBelow,
    artifactDryRun: false
  });
  const executionVerifierReleaseDossier = await verificationRuntime.executionVerifierReleaseDossier({
    cycles: 2,
    failBelow,
    artifactDryRun: false,
    reason: 'verification_dashboard_execution_release_dossier'
  });
  const learningVerifierProductGate = verificationRuntime.learningVerifierProductGate({
    failBelow,
    schedulerCycles: 3,
    artifactDryRun: false
  });
  const learningVerifierFixtures = learningVerifierProductGate.fixtureReport;
  const learningVerifierCiAnnotation = learningVerifierProductGate.ciAnnotation;
  const learningVerifierArtifactSync = learningVerifierProductGate.artifactSync;
  const approvalFlowVerifierCorpus = verificationRuntime.runApprovalFlowVerifierCorpus({ failBelow });
  const approvalFlowVerifierTrend = verificationRuntime.approvalFlowVerifierTrend();
  const approvalFlowDeviceSecuritySmoke = verificationRuntime.approvalFlowDeviceSecuritySmokeContract();
  const approvalFlowUxLatencyTrend = verificationRuntime.approvalFlowUxLatencyTrend({ cycles: 5 });
  const approvalFlowArtifactRetention = verificationRuntime.approvalFlowArtifactRetention({ keepLast: 50, dryRun: false });
  const approvalFlowProductGate = verificationRuntime.approvalFlowProductGate({
    failBelow,
    latencyCycles: 5,
    artifactDryRun: false
  });
  const approvalFlowReleaseDossier = verificationRuntime.approvalFlowReleaseDossier({
    failBelow,
    latencyCycles: 5,
    artifactDryRun: false,
    reason: 'verification_dashboard_approval_flow_release_dossier'
  });
  const redTeamCorpus = verificationRuntime.redTeamCorpus();
  const redTeam = verificationRuntime.runRedTeam();
  const redTeamTrend = verificationRuntime.redTeamTrend();
  const redTeamRetention = verificationRuntime.redTeamRetention({ keepLast: 50, dryRun: true });
  const redTeamQuarantine = verificationRuntime.redTeamQuarantine();
  const redTeamProductGate = verificationRuntime.redTeamProductGate({ failBelow, artifactDryRun: false });
  const policySecurityRedteam = policyRuntime.runSecurityRedteamCorpus({ failBelow });
  const policySecurityRedteamTrend = policyRuntime.securityRedteamTrend();
  const toolLeak = verificationRuntime.runToolPoisoningLeakSuite();
  const toolLeakReleaseDossier = verificationRuntime.toolPoisoningLeakReleaseDossier({
    reason: 'verification_dashboard_tool_leak_release_dossier'
  });
  const simulationCorpus = verificationRuntime.simulationCorpus();
  const simulationSuite = verificationRuntime.simulationRunner.run({ scenarioId: 'all' });
  const simulationExpandedScenarioPack = verificationRuntime.simulationExpandedScenarioPack();
  const simulationChaosSchedule = verificationRuntime.runSimulationChaosSchedule({ cycles: 2, failBelow });
  const simulationTrendRetention = verificationRuntime.simulationTrendRetention({ keepLast: 50, dryRun: true });
  const simulationReleaseDossier = verificationRuntime.simulationReleaseDossier({
    failBelow,
    chaosCycles: 2,
    keepLast: 50,
    retentionDryRun: true,
    reason: 'verification_dashboard_simulation_release_dossier'
  });
  const regression = verificationRuntime.runRegressionSuite({ failBelow });
  const releaseGate = verificationRuntime.operationalReleaseGate({ failBelow, scoreFailBelow });
  const dashboard = verificationRuntime.regressionDashboard({ limit: 10 });
  const regressionProductGate = verificationRuntime.regressionProductGate({
    failBelow,
    scoreFailBelow,
    scheduleCycles: 1,
    artifactDryRun: false
  });
  const regressionReleaseDossier = verificationRuntime.regressionReleaseDossier({
    failBelow,
    scoreFailBelow,
    scheduleCycles: 1,
    artifactDryRun: false,
    reason: 'verification_dashboard_regression_release_dossier'
  });
  const regressionExternalFixturePack = regressionProductGate.externalFixturePack;
  const releaseGateSchedule = regressionProductGate.schedule;
  const regressionArtifactStoreSync = regressionProductGate.artifactStoreSync;
  const reportIndex = verificationRuntime.listReports();
  const reportTrend = verificationRuntime.reportTrend();
  const reportRetention = verificationRuntime.reportRetention({ keepLast: 100 });
  const reportRetentionPolicyUi = verificationRuntime.reportRetentionPolicyUi({ keepLast: 100 });
  const reportLongTermTrend = verificationRuntime.reportLongTermTrendVisualization({ limit: 100 });
  const reportImmutableArtifactSync = verificationRuntime.syncReportArtifacts({ dryRun: false, keepLast: 100 });
  const reportCleanupApprovalWorkflow = verificationRuntime.reportCleanupApprovalWorkflow({
    keepLast: 100,
    requestedBy: 'verification_dashboard_dossier',
    reason: 'Release dossier cleanup approval preview.'
  });
  const reportStoreProductGate = verificationRuntime.reportStoreProductGate({
    keepLast: 100,
    artifactDryRun: false
  });
  const reportStoreReleaseDossier = verificationRuntime.reportStoreReleaseDossier({
    keepLast: 100,
    artifactDryRun: false,
    reason: 'verification_dashboard_report_store_release_dossier'
  });
  const scoreRubric = verificationRuntime.scoreRubric();
  const scoreGate = verificationRuntime.scoreGate({
    report: planReport,
    failBelow: scoreFailBelow,
    previousScore: planReport.score,
    maxRegression: 5
  });
  const scoreDocumentRubric = verificationRuntime.scoreDocumentRubric();
  const scoreDashboard = verificationRuntime.scoreDashboard({ limit: 20 });
  const scoreCiAnnotation = verificationRuntime.scoreCiAnnotation({
    report: planReport,
    failBelow: scoreFailBelow,
    previousScore: planReport.score,
    maxRegression: 5
  });
  const scoreProductGate = verificationRuntime.scoreProductGate({
    report: planReport,
    failBelow: scoreFailBelow,
    previousScore: planReport.score,
    maxRegression: 5,
    artifactDryRun: false
  });
  const goldenTraceReleaseDossier = verificationRuntime.goldenTraceReleaseDossier({
    traceId: 'golden_g_dashboard_plan',
    report: planReport,
    keepLast: 50,
    rotationDryRun: true,
    reason: 'verification_dashboard_golden_trace_release_dossier'
  });
  const baselineTrend = verificationRuntime.baselineTrend();
  const baselineApprovalDashboard = verificationRuntime.baselineApprovalDashboard({ limit: 10 });
  const goldenTraceRetention = verificationRuntime.goldenTraceRetention({
    keepLast: 50,
    maxAgeMs: 90 * 24 * 60 * 60 * 1000
  });
  const goldenTraceCiTrend = verificationRuntime.goldenTraceCiTrendVisualization({ limit: 10 });
  const checks = buildChecks({
    planReport,
    goldenTrace,
    baselineComparison,
    approvedBaseline,
    documentInvariantExtraction,
    documentInvariantTrend,
    planVerifierFixturePack,
    planVerifierFixtureTrend,
    semanticInvariantDedupe,
    planDocumentDiffFixtureRun,
    planRegressionVisualization,
    planVerifierProductGate,
    planVerifierCiAnnotation,
    planVerifierArtifactSync,
    fixtureMatrix,
    policyComplianceFixturePack,
    policyComplianceSnapshot,
    policyComplianceMigrationMatrix,
    policyComplianceDriftDiff,
    policyComplianceTrend,
    policyComplianceProductGate,
    bridgeSecurityProductDrill,
    bridgeSecurityReleaseDossier,
    executionVerifierCorpus,
    executionVerifierTrend,
    executionExternalFixturePack,
    executionAdapterSoak,
    executionArtifactRetention,
    executionFlakyQuarantine,
    executionVerifierProductGate,
    executionVerifierReleaseDossier,
    learningVerifierFixtures,
    learningVerifierProductGate,
    learningVerifierCiAnnotation,
    learningVerifierArtifactSync,
    approvalFlowVerifierCorpus,
    approvalFlowVerifierTrend,
    approvalFlowDeviceSecuritySmoke,
    approvalFlowUxLatencyTrend,
    approvalFlowArtifactRetention,
    approvalFlowProductGate,
    approvalFlowReleaseDossier,
    redTeamCorpus,
    redTeam,
    redTeamTrend,
    redTeamRetention,
    redTeamQuarantine,
    redTeamProductGate,
    policySecurityRedteam,
    policySecurityRedteamTrend,
    toolLeak,
    toolLeakReleaseDossier,
    simulationCorpus,
    simulationSuite,
    simulationExpandedScenarioPack,
    simulationChaosSchedule,
    simulationTrendRetention,
    simulationReleaseDossier,
    regression,
    releaseGate,
    dashboard,
    regressionProductGate,
    regressionReleaseDossier,
    regressionExternalFixturePack,
    releaseGateSchedule,
    regressionArtifactStoreSync,
    reportIndex,
    reportTrend,
    reportRetention,
    reportRetentionPolicyUi,
    reportLongTermTrend,
    reportImmutableArtifactSync,
    reportCleanupApprovalWorkflow,
    reportStoreProductGate,
    reportStoreReleaseDossier,
    scoreRubric,
    scoreGate,
    scoreDocumentRubric,
    scoreDashboard,
    scoreCiAnnotation,
    scoreProductGate,
    goldenTraceReleaseDossier,
    baselineTrend,
    baselineApprovalDashboard,
    goldenTraceRetention,
    goldenTraceCiTrend
  });
  const failed = checks.filter((check) => check.status === 'failed');
  const report = {
    reportVersion: 'g-verification-dashboard-dossier-v1',
    dossierId: 'g-verification-dashboard-release-dossier',
    status: failed.length ? 'failed' : 'passed',
    generatedAt: clock().toISOString(),
    checks,
    summary: {
      planScore: planReport.score,
      fixtureMatrixPassRate: fixtureMatrix.passRate,
      executionVerifierPassRate: executionVerifierCorpus.passRate,
      executionVerifierProductGateStatus: executionVerifierProductGate.status,
      executionVerifierReleaseDossierStatus: executionVerifierReleaseDossier.status,
      executionAdapterSoakPassRate: executionAdapterSoak.passRate,
      learningVerifierPassRate: learningVerifierFixtures.passRate,
      learningSchedulerRegressionStatus: learningVerifierFixtures.schedulerRegression.status,
      learningVerifierProductGateStatus: learningVerifierProductGate.status,
      learningVerifierCiAnnotationStatus: learningVerifierCiAnnotation.status,
      learningVerifierArtifactSyncStatus: learningVerifierArtifactSync.status,
      approvalFlowVerifierPassRate: approvalFlowVerifierCorpus.passRate,
      approvalFlowProductGateStatus: approvalFlowProductGate.status,
      approvalFlowLatencyStatus: approvalFlowUxLatencyTrend.status,
      approvalFlowReleaseDossierStatus: approvalFlowReleaseDossier.status,
      redTeamPassRate: redTeam.passRate,
      redTeamTrendStatus: redTeamTrend.status,
      redTeamRetentionStatus: redTeamRetention.status,
      redTeamQuarantineStatus: redTeamQuarantine.status,
      redTeamProductGateStatus: redTeamProductGate.status,
      policySecurityRedteamPassRate: policySecurityRedteam.passRate,
      toolLeakFailed: toolLeak.failed,
      toolLeakPassRate: toolLeak.passRate,
      toolLeakFixtureCount: toolLeak.coverage.totalCases,
      toolLeakDomDiffStatus: toolLeak.domDiffReport?.status,
      toolLeakRetentionPolicy: toolLeak.retentionPolicy?.policyVersion,
      toolLeakReleaseDossierStatus: toolLeakReleaseDossier.status,
      simulationPassRate: simulationSuite.passRate,
      simulationScenarioCount: simulationCorpus.scenarios.length,
      simulationChaosPassRate: simulationChaosSchedule.passRate,
      simulationRetentionStatus: simulationTrendRetention.status,
      simulationReleaseDossierStatus: simulationReleaseDossier.status,
      regressionStatus: regression.status,
      regressionProductGateStatus: regressionProductGate.status,
      regressionReleaseDossierStatus: regressionReleaseDossier.status,
      regressionExternalFixtureCount: regressionExternalFixturePack.combinedFixtureCount,
      releaseGateScheduleStatus: releaseGateSchedule.status,
      regressionArtifactStoreStatus: regressionArtifactStoreSync.status,
      releaseGateStatus: releaseGate.status,
      dashboardRuns: dashboard.totalRuns,
      reportStoreItems: reportIndex.items.length,
      reportStoreProductGateStatus: reportStoreProductGate.status,
      reportStoreReleaseDossierStatus: reportStoreReleaseDossier.status,
      reportImmutableArtifactSyncStatus: reportImmutableArtifactSync.status,
      reportLongTermTrendStatus: reportLongTermTrend.status,
      reportCleanupApprovalStatus: reportCleanupApprovalWorkflow.status,
      scoreGateStatus: scoreGate.status,
      scoreDashboardStatus: scoreDashboard.status,
      scoreDocumentRubricStatus: scoreDocumentRubric.status,
      scoreCiAnnotationStatus: scoreCiAnnotation.status,
      scoreProductGateStatus: scoreProductGate.status,
      baselineTraceCount: baselineTrend.traceCount,
      approvedBaselineTraceCount: baselineTrend.approvedTraceCount,
      baselineApprovalDashboardStatus: baselineApprovalDashboard.status,
      goldenTraceRetentionStatus: goldenTraceRetention.status,
      goldenTraceCiTrendStatus: goldenTraceCiTrend.status,
      goldenTraceReleaseDossierStatus: goldenTraceReleaseDossier.status,
      documentInvariantCount: documentInvariantExtraction.invariantCount,
      documentInvariantCoverageRate: documentInvariantExtraction.fixtureCoverage.coverageRate,
      planVerifierFixturePassRate: planVerifierFixturePack.passRate,
      planDocumentDiffFixturePassRate: planDocumentDiffFixtureRun.passRate,
      planRegressionVisualizationStatus: planRegressionVisualization.status,
      planVerifierProductGateStatus: planVerifierProductGate.status,
      planVerifierCiAnnotationStatus: planVerifierCiAnnotation.status,
      planVerifierArtifactSyncStatus: planVerifierArtifactSync.status,
      policyCompliancePassRate: policyComplianceFixturePack.passRate,
      policyComplianceProductGateStatus: policyComplianceProductGate.status,
      bridgeSecurityProductDrillStatus: bridgeSecurityProductDrill.status,
      bridgeSecurityReleaseDossierStatus: bridgeSecurityReleaseDossier.status
    },
    evidence: {
      planReport: pickPlanReport(planReport),
      documentInvariants: {
        extractionVersion: documentInvariantExtraction.extractionVersion,
        status: documentInvariantExtraction.status,
        foundDocuments: documentInvariantExtraction.foundDocuments,
        documentCount: documentInvariantExtraction.documentCount,
        invariantCount: documentInvariantExtraction.invariantCount,
        fixtureCoverage: documentInvariantExtraction.fixtureCoverage,
        trend: documentInvariantTrend
      },
      planVerifierFixtures: {
        corpusVersion: planVerifierFixturePack.corpusVersion,
        fixturePackId: planVerifierFixturePack.fixturePackId,
        status: planVerifierFixturePack.status,
        passRate: planVerifierFixturePack.passRate,
        fixtureCount: planVerifierFixturePack.fixtureCount,
        trend: planVerifierFixtureTrend,
        semanticDedupe: semanticInvariantDedupe,
        documentDiffFixtureRun: planDocumentDiffFixtureRun,
        regressionVisualization: planRegressionVisualization,
        ciAnnotation: planVerifierCiAnnotation,
        artifactSync: planVerifierArtifactSync,
        productGate: planVerifierProductGate
      },
      fixtureMatrix: {
        matrixId: fixtureMatrix.matrixId,
        status: fixtureMatrix.status,
        thresholdStatus: fixtureMatrix.thresholdStatus,
        passRate: fixtureMatrix.passRate,
        domains: fixtureMatrix.domains,
        fixtureCount: fixtureMatrix.items.length
      },
      policyCompliance: {
        reportVersion: policyComplianceFixturePack.reportVersion,
        status: policyComplianceFixturePack.status,
        fixturePackId: policyComplianceFixturePack.fixturePackId,
        fixtureSha256: policyComplianceFixturePack.fixtureSha256,
        passRate: policyComplianceFixturePack.passRate,
        fixtureCount: policyComplianceFixturePack.fixtureCount,
        snapshot: policyComplianceSnapshot,
        migrationMatrix: policyComplianceMigrationMatrix,
        driftDiff: policyComplianceDriftDiff,
        trend: policyComplianceTrend,
        productGate: policyComplianceProductGate,
        ciAnnotation: policyComplianceProductGate.ciAnnotation,
        migrationApprovalArtifact: policyComplianceProductGate.migrationApprovalArtifact
      },
      bridgeSecurity: {
        productDrill: bridgeSecurityProductDrill,
        releaseDossier: bridgeSecurityReleaseDossier
      },
      executionVerifier: {
        corpusVersion: executionVerifierCorpus.corpusVersion,
        status: executionVerifierCorpus.status,
        passRate: executionVerifierCorpus.passRate,
        fixtureCount: executionVerifierCorpus.fixtureCount,
        trend: executionVerifierTrend,
        externalFixturePack: executionExternalFixturePack,
        adapterSoak: executionAdapterSoak,
        artifactRetention: executionArtifactRetention,
        flakyQuarantine: executionFlakyQuarantine,
        productGate: executionVerifierProductGate,
        releaseDossier: executionVerifierReleaseDossier
      },
      learningVerifier: {
        reportVersion: learningVerifierFixtures.reportVersion,
        fixturePackVersion: learningVerifierFixtures.fixturePackVersion,
        fixturePackId: learningVerifierFixtures.fixturePackId,
        fixtureSha256: learningVerifierFixtures.fixtureSha256,
        status: learningVerifierFixtures.status,
        passRate: learningVerifierFixtures.passRate,
        fixtureCount: learningVerifierFixtures.fixtureCount,
        schedulerRegression: learningVerifierFixtures.schedulerRegression,
        ciAnnotation: learningVerifierCiAnnotation,
        artifactSync: learningVerifierArtifactSync,
        productGate: learningVerifierProductGate
      },
      approvalFlowVerifier: {
        corpusVersion: approvalFlowVerifierCorpus.corpusVersion,
        status: approvalFlowVerifierCorpus.status,
        passRate: approvalFlowVerifierCorpus.passRate,
        fixtureCount: approvalFlowVerifierCorpus.fixtureCount,
        trend: approvalFlowVerifierTrend,
        deviceSecuritySmoke: approvalFlowDeviceSecuritySmoke,
        uxLatencyTrend: approvalFlowUxLatencyTrend,
        artifactRetention: approvalFlowArtifactRetention,
        productGate: approvalFlowProductGate,
        releaseDossier: approvalFlowReleaseDossier
      },
      redTeam: {
        suiteId: redTeam.suiteId,
        fixturePackVersion: redTeam.fixturePackVersion,
        fixturePackId: redTeam.fixturePackId,
        fixtureSha256: redTeam.fixtureSha256,
        externalJsonFixturePack: redTeam.externalJsonFixturePack,
        status: redTeam.status,
        passRate: redTeam.passRate,
        failed: redTeam.failed,
        coverage: redTeam.coverage,
        artifact: redTeam.artifact,
        retentionPolicy: redTeam.retentionPolicy,
        trend: redTeamTrend,
        retention: redTeamRetention,
        quarantine: redTeamQuarantine,
        productGate: redTeamProductGate
      },
      policySecurityRedteam: {
        corpusVersion: policySecurityRedteam.corpusVersion,
        status: policySecurityRedteam.status,
        passRate: policySecurityRedteam.passRate,
        fixtureCount: policySecurityRedteam.fixtureCount,
        calibration: policySecurityRedteam.calibration,
        coverage: policySecurityRedteam.coverage,
        trend: policySecurityRedteamTrend
      },
      toolPoisoningLeak: {
        suiteId: toolLeak.suiteId,
        fixturePackId: toolLeak.fixturePackId,
        status: toolLeak.status,
        failed: toolLeak.failed,
        coverage: toolLeak.coverage,
        fixtureSha256: toolLeak.fixtureSha256,
        diffReport: toolLeak.diffReport,
        domDiffReport: toolLeak.domDiffReport,
        retentionPolicy: toolLeak.retentionPolicy,
        releaseDossier: toolLeakReleaseDossier
      },
      simulation: {
        suiteId: simulationCorpus.suiteId,
        fixturePackId: simulationCorpus.fixturePackId,
        status: simulationSuite.status,
        passRate: simulationSuite.passRate,
        scenarioCount: simulationCorpus.scenarios.length,
        threshold: simulationSuite.threshold,
        coverage: simulationSuite.coverage,
        expandedScenarioPack: simulationExpandedScenarioPack,
        chaosSchedule: {
          scheduleVersion: simulationChaosSchedule.scheduleVersion,
          status: simulationChaosSchedule.status,
          passRate: simulationChaosSchedule.passRate,
          totalRuns: simulationChaosSchedule.totalRuns,
          faultCoverage: simulationChaosSchedule.faultCoverage,
          noSideEffects: simulationChaosSchedule.noSideEffects
        },
        trendRetention: simulationTrendRetention,
        releaseDossier: simulationReleaseDossier
      },
      regression: {
        runId: regression.runId,
        suiteId: regression.suiteId,
        status: regression.status,
        failed: regression.failed,
        threshold: regression.threshold,
        components: regression.components,
        externalFixturePack: regressionExternalFixturePack,
        productGate: regressionProductGate,
        releaseDossier: regressionReleaseDossier,
        releaseGateSchedule,
        artifactStoreSync: regressionArtifactStoreSync,
        triageArtifact: regression.artifacts?.triage
      },
      releaseGate: {
        gateVersion: releaseGate.gateVersion,
        gateId: releaseGate.gateId,
        status: releaseGate.status,
        scoreGate: releaseGate.scoreGate,
        triageCount: releaseGate.triage.length
      },
      dashboard,
      reportStore: {
        indexVersion: reportIndex.indexVersion,
        trendVersion: reportTrend.trendVersion,
        retentionVersion: reportRetention.dashboardVersion,
        retentionPolicyUi: reportRetentionPolicyUi,
        longTermTrend: reportLongTermTrend,
        immutableArtifactSync: reportImmutableArtifactSync,
        cleanupApprovalWorkflow: reportCleanupApprovalWorkflow,
        productGate: reportStoreProductGate,
        releaseDossier: reportStoreReleaseDossier,
        totalReports: reportIndex.items.length,
        retentionStatus: reportRetention.status
      },
      score: {
        rubricVersion: scoreRubric.rubricVersion,
        dimensionCount: scoreRubric.dimensions.length,
        scoreGate,
        documentRubric: scoreDocumentRubric,
        dashboard: scoreDashboard,
        ciAnnotation: scoreCiAnnotation,
        productGate: scoreProductGate
      },
      baseline: {
        goldenTrace,
        baselineComparison,
        approvedBaseline,
        baselineTrend,
        baselineApprovalDashboard,
        goldenTraceRetention,
        goldenTraceCiTrend,
        releaseDossier: goldenTraceReleaseDossier
      }
    },
    artifactManifest: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      csvPath: resolve(csvPath),
      auditRoot: resolve(auditRoot),
      runtimeArtifacts: [
        planReport.evidence?.reportJsonPath,
        planReport.evidence?.reportHtmlPath,
        planRegressionVisualization.artifact?.htmlPath,
        planVerifierArtifactSync.manifestPath,
        toolLeak.diffReport?.htmlPath,
        executionArtifactRetention.artifact?.htmlPath,
        executionVerifierProductGate.retention?.artifact?.htmlPath,
        approvalFlowArtifactRetention.artifact?.htmlPath,
        approvalFlowProductGate.retention?.artifact?.htmlPath,
        toolLeak.domDiffReport?.artifact?.htmlPath,
        regression.artifacts?.triage?.htmlPath,
        ...(regressionReleaseDossier.artifactManifest?.artifacts ?? []).map((artifact) => artifact.path),
        reportLongTermTrend.artifact?.htmlPath,
        reportImmutableArtifactSync.manifestPath,
        scoreProductGate.trendArtifact?.artifactPath,
        baselineComparison.artifact?.htmlPath,
        goldenTraceCiTrend.artifact?.htmlPath
      ].filter(Boolean)
    },
    recommendations: failed.length
      ? failed.map((check) => `Fix G dashboard dossier check: ${check.checkId}`)
      : [
          'Run this dossier in CI before product promotion.',
          'Keep the document invariant catalog in sync with A-G document revisions.',
          'Attach the JSON, Markdown, CSV, G-03 execution release dossier, G-05 approval-flow release dossier, G-06 bridge-security release dossier, G-08 tool leak release dossier, G-09 simulation release dossier, G-10 regression release dossier, G-11 report-store release dossier, G-13 golden-trace release dossier, regression triage HTML, tool leak diff HTML, DOM diff HTML, baseline diff HTML, and golden trace CI trend HTML to release evidence.',
          'Expand redteam, leak, and simulation fixture packs with every production failure or review finding.'
        ]
  };
  const dashboardReleaseDossier = buildDashboardReleaseDossier(report, {
    jsonPath,
    markdownPath,
    csvPath,
    auditRoot
  });
  report.dashboardReleaseDossier = dashboardReleaseDossier;
  report.summary.dashboardReleaseDossierStatus = dashboardReleaseDossier.status;
  report.summary.dashboardReleaseHash = dashboardReleaseDossier.releaseHash;
  report.artifactManifest.dashboardReleaseDossier = {
    dossierVersion: dashboardReleaseDossier.dossierVersion,
    manifestVersion: dashboardReleaseDossier.artifactManifest.manifestVersion,
    workflowVersion: dashboardReleaseDossier.releaseWorkflow.workflowVersion,
    status: dashboardReleaseDossier.status,
    releaseHash: dashboardReleaseDossier.releaseHash,
    rawLeakCheck: dashboardReleaseDossier.artifactManifest.rawLeakCheck
  };
  report.checks.push({
    checkId: 'verification_dashboard_release_dossier_ready',
    status: dashboardReleaseDossier.status === 'passed' ? 'passed' : 'failed',
    detail: {
      dossierVersion: dashboardReleaseDossier.dossierVersion,
      manifestVersion: dashboardReleaseDossier.artifactManifest.manifestVersion,
      releaseHash: dashboardReleaseDossier.releaseHash,
      rawLeakDetected: dashboardReleaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected
    }
  });
  report.status = report.checks.some((check) => check.status === 'failed') ? 'failed' : 'passed';

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  return report;
}

function buildDashboardReleaseDossier(report, {
  jsonPath,
  markdownPath,
  csvPath,
  auditRoot
}) {
  const componentReleaseStatuses = Object.fromEntries(
    Object.entries(report.summary)
      .filter(([key]) => key.endsWith('ReleaseDossierStatus'))
  );
  const releaseWorkflow = {
    workflowVersion: 'g-verification-dashboard-release-workflow-v1',
    reportVersion: report.reportVersion,
    dossierId: report.dossierId,
    checksPassed: report.checks.every((check) => check.status === 'passed'),
    releaseGateReady: report.summary.releaseGateStatus === 'passed',
    regressionReady: report.summary.regressionStatus === 'passed',
    scoreGateReady: report.summary.scoreGateStatus === 'passed',
    componentReleaseDossiersReady: Object.values(componentReleaseStatuses).every((status) => status === 'passed'),
    runtimeArtifactCount: report.artifactManifest.runtimeArtifacts.length,
    promotionStatus: 'pending_checks'
  };
  const artifactManifest = {
    manifestVersion: 'g-verification-dashboard-release-artifact-manifest-v1',
    generatedAt: report.generatedAt,
    rawDashboardPayloadStored: false,
    rawEvidencePayloadStored: false,
    rawRuntimeArtifactPathsStored: false,
    rawReportArtifactPathsStored: false,
    reportOutputPathHashes: {
      jsonPathHash: sha256Hex(resolve(jsonPath)),
      markdownPathHash: sha256Hex(resolve(markdownPath)),
      csvPathHash: sha256Hex(resolve(csvPath)),
      auditRootHash: sha256Hex(resolve(auditRoot))
    },
    checksHash: sha256Json(report.checks.map((check) => ({
      checkId: check.checkId,
      status: check.status
    }))),
    summaryHash: sha256Json(report.summary),
    evidenceHash: sha256Json({
      planVerifier: report.evidence.planVerifierFixtures?.productGate?.productGateVersion,
      policyCompliance: report.evidence.policyCompliance?.productGate?.productGateVersion,
      executionRelease: report.evidence.executionVerifier?.releaseDossier?.dossierSha256,
      approvalFlowRelease: report.evidence.approvalFlowVerifier?.releaseDossier?.dossierSha256,
      bridgeSecurityRelease: report.evidence.bridgeSecurity?.releaseDossier?.dossierSha256,
      toolLeakRelease: report.evidence.toolPoisoningLeak?.releaseDossier?.dossierSha256,
      simulationRelease: report.evidence.simulation?.releaseDossier?.dossierSha256,
      regressionRelease: report.evidence.regression?.releaseDossier?.dossierSha256,
      reportStoreRelease: report.evidence.reportStore?.releaseDossier?.dossierSha256,
      goldenTraceRelease: report.evidence.baseline?.releaseDossier?.dossierSha256
    }),
    runtimeArtifactInventoryHash: sha256Json(report.artifactManifest.runtimeArtifacts.map((artifactPath) => ({
      pathHash: sha256Hex(resolve(artifactPath))
    }))),
    runtimeArtifactCount: report.artifactManifest.runtimeArtifacts.length,
    componentReleaseStatuses,
    wormArchive: {
      archiveContractVersion: 'g-verification-dashboard-worm-release-archive-v1',
      storageMode: 'hash_only_dashboard_release_manifest',
      required: true,
      includedArtifactHashes: [
        sha256Json(report.checks.map((check) => ({ checkId: check.checkId, status: check.status }))),
        sha256Json(report.summary),
        ...report.artifactManifest.runtimeArtifacts.map((artifactPath) => sha256Hex(resolve(artifactPath)))
      ]
    }
  };
  const candidate = {
    dossierVersion: 'g-verification-dashboard-release-dossier-v1',
    generatedAt: report.generatedAt,
    releaseWorkflow,
    artifactManifest
  };
  const rawNeedles = [
    JSON.stringify(report.evidence),
    resolve(jsonPath),
    resolve(markdownPath),
    resolve(csvPath),
    resolve(auditRoot),
    ...report.artifactManifest.runtimeArtifacts.map((artifactPath) => resolve(artifactPath))
  ].filter((needle) => typeof needle === 'string' && needle.length >= 8);
  const rawLeakDetected = rawNeedles.some((needle) => JSON.stringify(candidate).includes(needle));
  const checks = [
    { checkId: 'dashboard_checks_passed', passed: releaseWorkflow.checksPassed === true },
    { checkId: 'dashboard_release_gate_ready', passed: releaseWorkflow.releaseGateReady === true && releaseWorkflow.regressionReady === true && releaseWorkflow.scoreGateReady === true },
    { checkId: 'component_release_dossiers_ready', passed: releaseWorkflow.componentReleaseDossiersReady === true },
    { checkId: 'runtime_artifact_inventory_hash_only', passed: artifactManifest.runtimeArtifactCount >= 10 && artifactManifest.rawRuntimeArtifactPathsStored === false },
    { checkId: 'dashboard_worm_archive_manifest_ready', passed: artifactManifest.wormArchive.required === true && artifactManifest.wormArchive.includedArtifactHashes.length >= 10 },
    {
      checkId: 'raw_dashboard_payload_not_stored',
      passed: artifactManifest.rawDashboardPayloadStored === false
        && artifactManifest.rawEvidencePayloadStored === false
        && artifactManifest.rawRuntimeArtifactPathsStored === false
        && artifactManifest.rawReportArtifactPathsStored === false
        && rawLeakDetected === false
    }
  ];
  const dossier = {
    ...candidate,
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks,
    releaseWorkflow: {
      ...releaseWorkflow,
      promotionStatus: checks.every((check) => check.passed) ? 'release_evidence_ready' : 'blocked'
    },
    artifactManifest: {
      ...artifactManifest,
      rawLeakCheck: {
        checkedNeedleCount: rawNeedles.length,
        rawLeakDetected
      }
    },
    recommendedReleaseAction: checks.every((check) => check.passed)
      ? 'attach_verification_dashboard_release_dossier_and_hash_only_artifact_manifest'
      : 'block_verification_dashboard_release_until_hash_only_manifest_checks_pass'
  };
  return {
    ...dossier,
    releaseHash: sha256Json(dossier)
  };
}

function buildChecks(context) {
  const checks = [];
  const add = (checkId, pass, detail = {}) => checks.push({ checkId, status: pass ? 'passed' : 'failed', detail });
  add('plan_verifier_sample_passed', context.planReport.status === 'passed' && context.planReport.score >= 85, {
    status: context.planReport.status,
    score: context.planReport.score,
    checks: context.planReport.checks.length
  });
  add('document_invariant_catalog_extracted', context.documentInvariantExtraction.status === 'passed' && context.documentInvariantTrend.trendVersion === 'g-document-invariant-trend-v1', {
    foundDocuments: context.documentInvariantExtraction.foundDocuments,
    documentCount: context.documentInvariantExtraction.documentCount,
    invariantCount: context.documentInvariantExtraction.invariantCount,
    coverageRate: context.documentInvariantExtraction.fixtureCoverage.coverageRate
  });
  add('plan_verifier_fixture_pack_passed', context.planVerifierFixturePack.status === 'passed' && context.planVerifierFixtureTrend.trendVersion === 'g-plan-verifier-fixture-trend-v1', {
    fixturePackId: context.planVerifierFixturePack.fixturePackId,
    fixtureCount: context.planVerifierFixturePack.fixtureCount,
    passRate: context.planVerifierFixturePack.passRate,
    documentMappedFixtureCount: context.planVerifierFixtureTrend.documentMappedFixtureCount
  });
  add('semantic_invariant_dedupe_ready', context.semanticInvariantDedupe.classifierVersion === 'g-semantic-invariant-dedupe-classifier-v1'
    && context.semanticInvariantDedupe.status === 'passed'
    && context.semanticInvariantDedupe.uniqueInvariantCount >= 1, {
    invariantCount: context.semanticInvariantDedupe.invariantCount,
    uniqueInvariantCount: context.semanticInvariantDedupe.uniqueInvariantCount,
    duplicateCount: context.semanticInvariantDedupe.duplicateCount
  });
  add('plan_document_diff_fixtures_generated', context.planDocumentDiffFixtureRun.runVersion === 'g-plan-document-diff-generated-fixture-run-v1'
    && context.planDocumentDiffFixtureRun.status === 'passed'
    && context.planDocumentDiffFixtureRun.items.length >= 1, {
    fixturePackId: context.planDocumentDiffFixtureRun.fixturePack.fixturePackId,
    generatedFixtureCount: context.planDocumentDiffFixtureRun.items.length,
    passRate: context.planDocumentDiffFixtureRun.passRate
  });
  add('plan_regression_visualized', context.planRegressionVisualization.visualizationVersion === 'g-plan-regression-visualization-v1'
    && context.planRegressionVisualization.status === 'ready'
    && context.planRegressionVisualization.artifact?.artifactVersion === 'g-plan-regression-visualization-html-v1'
    && context.planRegressionVisualization.artifact?.written === true, {
    totalRuns: context.planRegressionVisualization.trend.totalRuns,
    artifact: context.planRegressionVisualization.artifact
  });
  add('plan_verifier_product_gate_passed', context.planVerifierProductGate.productGateVersion === 'g-plan-verifier-product-gate-v1'
    && context.planVerifierProductGate.status === 'passed'
    && context.planVerifierProductGate.checks.every((check) => check.passed), {
    checks: context.planVerifierProductGate.checks
  });
  add('plan_verifier_ci_annotation_ready', context.planVerifierCiAnnotation.annotationVersion === 'g-plan-verifier-ci-annotation-v1'
    && context.planVerifierCiAnnotation.status === 'passed'
    && context.planVerifierCiAnnotation.githubStepSummary.includes('JARVIS Plan Verifier Gate'), {
    annotationCount: context.planVerifierCiAnnotation.annotations.length,
    summary: context.planVerifierCiAnnotation.summary
  });
  add('plan_verifier_worm_artifact_synced', context.planVerifierArtifactSync.syncVersion === 'g-plan-verifier-worm-artifact-sync-v1'
    && context.planVerifierArtifactSync.status === 'synced'
    && context.planVerifierArtifactSync.artifactStore.storeVersion === 'g-plan-verifier-worm-artifact-store-v1'
    && context.planVerifierArtifactSync.artifactCount >= 3, {
    artifactCount: context.planVerifierArtifactSync.artifactCount,
    copiedCount: context.planVerifierArtifactSync.copiedCount,
    manifestPath: context.planVerifierArtifactSync.manifestPath
  });
  add('fixture_matrix_threshold_passed', context.fixtureMatrix.status === 'passed' && context.fixtureMatrix.thresholdStatus === 'passed', {
    passRate: context.fixtureMatrix.passRate,
    fixtureCount: context.fixtureMatrix.items.length
  });
  add('policy_compliance_fixture_pack_passed', context.policyComplianceFixturePack.reportVersion === 'g-policy-compliance-fixture-pack-report-v1' && context.policyComplianceFixturePack.status === 'passed' && context.policyComplianceSnapshot.snapshotVersion === 'g-policy-compliance-snapshot-v1', {
    fixturePackId: context.policyComplianceFixturePack.fixturePackId,
    fixtureSha256: context.policyComplianceFixturePack.fixtureSha256,
    passRate: context.policyComplianceFixturePack.passRate,
    fixtureCount: context.policyComplianceFixturePack.fixtureCount,
    snapshotHash: context.policyComplianceSnapshot.snapshotHash
  });
  add('policy_migration_matrix_signed', context.policyComplianceMigrationMatrix.matrixVersion === 'g-signed-policy-migration-matrix-v1' && context.policyComplianceMigrationMatrix.status === 'passed' && Boolean(context.policyComplianceMigrationMatrix.signature?.signatureValue), {
    fixturePackId: context.policyComplianceMigrationMatrix.fixturePackId,
    payloadHash: context.policyComplianceMigrationMatrix.payloadHash,
    migrationCount: context.policyComplianceMigrationMatrix.items.length
  });
  add('policy_drift_snapshot_diff_clean', context.policyComplianceDriftDiff.diffVersion === 'g-policy-compliance-drift-diff-v1' && context.policyComplianceDriftDiff.status === 'passed' && context.policyComplianceTrend.trendVersion === 'g-policy-compliance-trend-v1', {
    baselineHash: context.policyComplianceDriftDiff.baselineHash,
    currentHash: context.policyComplianceDriftDiff.currentHash,
    totalRuns: context.policyComplianceTrend.totalRuns
  });
  add('policy_compliance_product_gate_passed', context.policyComplianceProductGate.productGateVersion === 'g-policy-compliance-product-gate-v1'
    && context.policyComplianceProductGate.status === 'passed'
    && context.policyComplianceProductGate.ciAnnotation.annotationVersion === 'g-policy-compliance-ci-annotation-v1'
    && context.policyComplianceProductGate.migrationApprovalArtifact.artifactVersion === 'g-policy-migration-approval-artifact-v1', {
    checks: context.policyComplianceProductGate.checks,
    annotationStatus: context.policyComplianceProductGate.ciAnnotation.status,
    artifactHash: context.policyComplianceProductGate.migrationApprovalArtifact.artifactHash
  });
  add('bridge_security_product_chaos_drill_passed', context.bridgeSecurityProductDrill.drillVersion === 'g-bridge-security-product-chaos-drill-v1'
    && context.bridgeSecurityProductDrill.status === 'passed'
    && context.bridgeSecurityProductDrill.checks.every((check) => check.passed), {
    cycles: context.bridgeSecurityProductDrill.cycles,
    verifierCheckCount: context.bridgeSecurityProductDrill.verifierCheckCount,
    failedVerifierChecks: context.bridgeSecurityProductDrill.failedVerifierChecks
  });
  add('bridge_security_release_dossier_ready', context.bridgeSecurityReleaseDossier.dossierVersion === 'g-bridge-security-release-dossier-v1'
    && context.bridgeSecurityReleaseDossier.status === 'passed'
    && context.bridgeSecurityReleaseDossier.dossierSha256?.length === 64
    && context.bridgeSecurityReleaseDossier.artifactManifest?.rawNetworkPayloadStored === false
    && context.bridgeSecurityReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && context.bridgeSecurityReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.bridgeSecurityReleaseDossier.dossierSha256,
    artifactManifest: context.bridgeSecurityReleaseDossier.artifactManifest,
    checks: context.bridgeSecurityReleaseDossier.checks
  });
  add('execution_verifier_corpus_trend_passed', context.executionVerifierCorpus.status === 'passed' && context.executionVerifierTrend.trendVersion === 'g-execution-verifier-trend-v1' && context.executionVerifierTrend.partialFailureCoverage === true, {
    passRate: context.executionVerifierCorpus.passRate,
    fixtureCount: context.executionVerifierCorpus.fixtureCount,
    partialFailureCoverage: context.executionVerifierTrend.partialFailureCoverage
  });
  add('execution_external_adapter_fixture_pack_loaded', context.executionExternalFixturePack.fixturePackVersion === 'g-execution-external-adapter-fixture-pack-v1'
    && context.executionExternalFixturePack.status === 'passed'
    && context.executionExternalFixturePack.fixtureCount >= context.executionExternalFixturePack.minimumFixtureCount, {
    fixtureCount: context.executionExternalFixturePack.fixtureCount,
    minimumFixtureCount: context.executionExternalFixturePack.minimumFixtureCount,
    fixtureSha256: context.executionExternalFixturePack.fixtureSha256
  });
  add('execution_adapter_soak_retention_ready', context.executionAdapterSoak.soakVersion === 'g-execution-adapter-soak-trend-v1'
    && context.executionAdapterSoak.status === 'passed'
    && context.executionArtifactRetention.retentionVersion === 'g-execution-verifier-artifact-retention-v1'
    && context.executionArtifactRetention.artifact?.artifactVersion === 'g-execution-verifier-retention-html-v1'
    && context.executionArtifactRetention.artifact?.written === true, {
    soakPassRate: context.executionAdapterSoak.passRate,
    retainedRuns: context.executionArtifactRetention.retainedRuns,
    artifact: context.executionArtifactRetention.artifact
  });
  add('execution_flaky_quarantine_clean', context.executionFlakyQuarantine.quarantineVersion === 'g-execution-flaky-fixture-quarantine-v1'
    && context.executionFlakyQuarantine.status === 'clean', {
    candidateCount: context.executionFlakyQuarantine.candidateCount,
    policy: context.executionFlakyQuarantine.policy
  });
  add('execution_verifier_product_gate_passed', context.executionVerifierProductGate.productGateVersion === 'g-execution-verifier-product-gate-v1'
    && context.executionVerifierProductGate.status === 'passed'
    && context.executionVerifierProductGate.checks.every((check) => check.passed), {
    checks: context.executionVerifierProductGate.checks
  });
  add('execution_verifier_release_dossier_ready', context.executionVerifierReleaseDossier.dossierVersion === 'g-execution-verifier-release-dossier-v1'
    && context.executionVerifierReleaseDossier.status === 'passed'
    && context.executionVerifierReleaseDossier.dossierSha256?.length === 64
    && context.executionVerifierReleaseDossier.artifactManifest?.rawExecutionPayloadStored === false
    && context.executionVerifierReleaseDossier.artifactManifest?.rawCapabilityTokenStored === false
    && context.executionVerifierReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && context.executionVerifierReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.executionVerifierReleaseDossier.dossierSha256,
    artifactManifest: context.executionVerifierReleaseDossier.artifactManifest,
    checks: context.executionVerifierReleaseDossier.checks
  });
  add('learning_verifier_fixture_pack_passed', context.learningVerifierFixtures.reportVersion === 'g-learning-verifier-fixture-pack-report-v1'
    && context.learningVerifierFixtures.status === 'passed'
    && context.learningVerifierFixtures.schedulerRegression.regressionVersion === 'g-learning-scheduler-regression-corpus-v1'
    && context.learningVerifierFixtures.schedulerRegression.status === 'passed', {
    fixturePackId: context.learningVerifierFixtures.fixturePackId,
    fixtureSha256: context.learningVerifierFixtures.fixtureSha256,
    passRate: context.learningVerifierFixtures.passRate,
    fixtureCount: context.learningVerifierFixtures.fixtureCount,
    schedulerCycles: context.learningVerifierFixtures.schedulerRegression.cycles
  });
  add('learning_verifier_product_gate_passed', context.learningVerifierProductGate.productGateVersion === 'g-learning-verifier-product-gate-v1'
    && context.learningVerifierProductGate.status === 'passed'
    && context.learningVerifierProductGate.checks.every((check) => check.passed), {
    checks: context.learningVerifierProductGate.checks
  });
  add('learning_verifier_ci_annotation_ready', context.learningVerifierCiAnnotation.annotationVersion === 'g-learning-verifier-ci-annotation-v1'
    && context.learningVerifierCiAnnotation.status === 'passed'
    && context.learningVerifierCiAnnotation.githubStepSummary.includes('JARVIS Learning Verifier Gate'), {
    annotationCount: context.learningVerifierCiAnnotation.annotations.length,
    summary: context.learningVerifierCiAnnotation.summary
  });
  add('learning_verifier_worm_artifact_synced', context.learningVerifierArtifactSync.syncVersion === 'g-learning-verifier-worm-artifact-sync-v1'
    && context.learningVerifierArtifactSync.status === 'synced'
    && context.learningVerifierArtifactSync.artifactStore.storeVersion === 'g-learning-verifier-worm-artifact-store-v1'
    && context.learningVerifierArtifactSync.artifactStore.retentionPolicy.policyVersion === 'g-learning-verifier-artifact-retention-v1'
    && context.learningVerifierArtifactSync.artifactCount >= 3, {
    artifactCount: context.learningVerifierArtifactSync.artifactCount,
    copiedCount: context.learningVerifierArtifactSync.copiedCount,
    manifestPath: context.learningVerifierArtifactSync.manifestPath
  });
  add('approval_flow_verifier_corpus_trend_passed', context.approvalFlowVerifierCorpus.status === 'passed' && context.approvalFlowVerifierTrend.trendVersion === 'g-approval-flow-verifier-trend-v1' && context.approvalFlowVerifierTrend.highRiskBlockCoverage === true && context.approvalFlowVerifierTrend.nativeSecurityCoverage === true, {
    passRate: context.approvalFlowVerifierCorpus.passRate,
    fixtureCount: context.approvalFlowVerifierCorpus.fixtureCount,
    highRiskBlockCoverage: context.approvalFlowVerifierTrend.highRiskBlockCoverage,
    nativeSecurityCoverage: context.approvalFlowVerifierTrend.nativeSecurityCoverage
  });
  add('approval_device_security_smoke_contract_ready', context.approvalFlowDeviceSecuritySmoke.contractVersion === 'g-approval-flow-device-security-smoke-contract-v1'
    && context.approvalFlowDeviceSecuritySmoke.status === 'passed'
    && context.approvalFlowDeviceSecuritySmoke.items.every((item) => item.secureStoreProbe.required && item.biometricProbe.required), {
    platforms: context.approvalFlowDeviceSecuritySmoke.platforms,
    evidenceSchema: context.approvalFlowDeviceSecuritySmoke.evidenceSchema
  });
  add('approval_flow_latency_retention_ready', context.approvalFlowUxLatencyTrend.trendVersion === 'g-approval-flow-ux-latency-trend-v1'
    && context.approvalFlowUxLatencyTrend.status === 'passed'
    && context.approvalFlowArtifactRetention.retentionVersion === 'g-approval-flow-artifact-retention-v1'
    && context.approvalFlowArtifactRetention.artifact?.artifactVersion === 'g-approval-flow-retention-html-v1'
    && context.approvalFlowArtifactRetention.artifact?.written === true, {
    metrics: context.approvalFlowUxLatencyTrend.metrics,
    retainedRuns: context.approvalFlowArtifactRetention.retainedRuns,
    artifact: context.approvalFlowArtifactRetention.artifact
  });
  add('approval_flow_verifier_product_gate_passed', context.approvalFlowProductGate.productGateVersion === 'g-approval-flow-verifier-product-gate-v1'
    && context.approvalFlowProductGate.status === 'passed'
    && context.approvalFlowProductGate.checks.every((check) => check.passed), {
    checks: context.approvalFlowProductGate.checks
  });
  add('approval_flow_release_dossier_ready', context.approvalFlowReleaseDossier.dossierVersion === 'g-approval-flow-release-dossier-v1'
    && context.approvalFlowReleaseDossier.status === 'passed'
    && context.approvalFlowReleaseDossier.dossierSha256?.length === 64
    && context.approvalFlowReleaseDossier.artifactManifest?.rawApprovalPayloadStored === false
    && context.approvalFlowReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && context.approvalFlowReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.approvalFlowReleaseDossier.dossierSha256,
    artifactManifest: context.approvalFlowReleaseDossier.artifactManifest,
    checks: context.approvalFlowReleaseDossier.checks
  });
  add('redteam_corpus_threshold_passed', context.redTeam.fixturePackId === 'g-redteam-fixture-pack-v2' && context.redTeam.threshold.status === 'passed', {
    corpusCases: context.redTeamCorpus.coverage.totalCases,
    expandedCases: context.redTeam.coverage.totalCases,
    passRate: context.redTeam.passRate
  });
  add('redteam_external_fixture_trend_retention_ready', context.redTeam.externalJsonFixturePack === true
    && context.redTeam.fixturePackVersion === 'g-prompt-redteam-external-fixture-pack-v1'
    && context.redTeamTrend.trendVersion === 'g-redteam-ci-trend-dashboard-v1'
    && context.redTeamRetention.dashboardVersion === 'g-redteam-artifact-retention-dashboard-v1'
    && context.redTeamQuarantine.quarantineVersion === 'g-redteam-failure-quarantine-v1'
    && context.redTeam.artifact?.artifactVersion === 'g-redteam-run-html-artifact-v1', {
    fixturePackId: context.redTeam.fixturePackId,
    fixtureSha256: context.redTeam.fixtureSha256,
    trendStatus: context.redTeamTrend.status,
    retentionStatus: context.redTeamRetention.status,
    quarantineStatus: context.redTeamQuarantine.status,
    artifactPath: context.redTeam.artifact?.htmlPath
  });
  add('redteam_product_gate_passed', context.redTeamProductGate.productGateVersion === 'g-redteam-product-gate-v1'
    && context.redTeamProductGate.status === 'passed'
    && context.redTeamProductGate.checks.every((check) => check.passed), {
    productGateVersion: context.redTeamProductGate.productGateVersion,
    status: context.redTeamProductGate.status,
    passRate: context.redTeamProductGate.run.passRate,
    trendStatus: context.redTeamProductGate.trend.status,
    quarantineStatus: context.redTeamProductGate.quarantine.status
  });
  add('policy_security_redteam_corpus_passed', context.policySecurityRedteam.corpusVersion === 'e-security-redteam-corpus-v1' && context.policySecurityRedteam.status === 'passed' && context.policySecurityRedteamTrend.trendVersion === 'e-security-redteam-trend-v1', {
    passRate: context.policySecurityRedteam.passRate,
    fixtureCount: context.policySecurityRedteam.fixtureCount,
    domains: context.policySecurityRedteam.coverage.domains,
    calibration: context.policySecurityRedteam.calibration
  });
  add('tool_leak_suite_diff_artifact_written', context.toolLeak.status === 'passed' && context.toolLeak.diffReport?.written === true, {
    fixturePackId: context.toolLeak.fixturePackId,
    fixtureSha256: context.toolLeak.fixtureSha256,
    failed: context.toolLeak.failed,
    htmlPath: context.toolLeak.diffReport?.htmlPath
  });
  add('tool_leak_dom_diff_passed', context.toolLeak.status === 'passed' && context.toolLeak.domDiffReport?.status === 'passed' && context.toolLeak.domDiffReport?.artifact?.written === true, {
    reportVersion: context.toolLeak.domDiffReport?.reportVersion,
    checkedCases: context.toolLeak.domDiffReport?.checkedCases,
    leakCount: context.toolLeak.domDiffReport?.leakCount,
    activeScriptCount: context.toolLeak.domDiffReport?.activeScriptCount,
    htmlPath: context.toolLeak.domDiffReport?.artifact?.htmlPath
  });
  add('tool_leak_retention_policy_visible', context.toolLeak.retentionPolicy?.policyVersion === 'g-tool-leak-report-retention-v1' && context.toolLeak.retentionPolicy?.requiresRedaction === true, {
    keepLast: context.toolLeak.retentionPolicy?.keepLast,
    maxAgeDays: context.toolLeak.retentionPolicy?.maxAgeDays,
    artifactTypes: context.toolLeak.retentionPolicy?.artifactTypes,
    artifacts: context.toolLeak.retentionPolicy?.artifacts
  });
  add('tool_leak_release_dossier_ready', context.toolLeakReleaseDossier.dossierVersion === 'g-tool-poisoning-leak-release-dossier-v1'
    && context.toolLeakReleaseDossier.status === 'passed'
    && context.toolLeakReleaseDossier.dossierSha256?.length === 64
    && context.toolLeakReleaseDossier.artifactManifest?.rawToolOutputStored === false
    && context.toolLeakReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && context.toolLeakReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.toolLeakReleaseDossier.dossierSha256,
    artifactManifest: context.toolLeakReleaseDossier.artifactManifest,
    checks: context.toolLeakReleaseDossier.checks
  });
  add('simulation_suite_threshold_passed', context.simulationSuite.status === 'passed' && context.simulationSuite.threshold.status === 'passed', {
    fixturePackId: context.simulationCorpus.fixturePackId,
    passRate: context.simulationSuite.passRate,
    scenarioCount: context.simulationCorpus.scenarios.length,
    coverageDocs: context.simulationSuite.coverage?.docs
  });
  add('simulation_expanded_scenario_pack_loaded', context.simulationExpandedScenarioPack.status === 'passed' && context.simulationExpandedScenarioPack.totalScenarioCount >= context.simulationExpandedScenarioPack.minimumScenarioCount, {
    fixturePackId: context.simulationExpandedScenarioPack.fixturePackId,
    fixtureSha256: context.simulationExpandedScenarioPack.fixtureSha256,
    scenarioCount: context.simulationExpandedScenarioPack.scenarioCount,
    totalScenarioCount: context.simulationExpandedScenarioPack.totalScenarioCount,
    minimumScenarioCount: context.simulationExpandedScenarioPack.minimumScenarioCount
  });
  add('simulation_chaos_schedule_passed', context.simulationChaosSchedule.scheduleVersion === 'g-chaos-simulation-schedule-v1' && context.simulationChaosSchedule.status === 'passed' && context.simulationChaosSchedule.noSideEffects === true, {
    totalRuns: context.simulationChaosSchedule.totalRuns,
    passRate: context.simulationChaosSchedule.passRate,
    faultCoverage: context.simulationChaosSchedule.faultCoverage
  });
  add('simulation_trend_retention_visible', context.simulationTrendRetention.dashboardVersion === 'g-simulation-trend-retention-dashboard-v1' && context.simulationTrendRetention.retainedRuns >= 1, {
    status: context.simulationTrendRetention.status,
    totalRuns: context.simulationTrendRetention.totalRuns,
    retainedRuns: context.simulationTrendRetention.retainedRuns,
    keepLast: context.simulationTrendRetention.keepLast,
    artifactStore: context.simulationTrendRetention.artifactStore
  });
  add('simulation_release_dossier_ready', context.simulationReleaseDossier.dossierVersion === 'g-simulation-release-dossier-v1'
    && context.simulationReleaseDossier.status === 'passed'
    && context.simulationReleaseDossier.dossierSha256?.length === 64
    && context.simulationReleaseDossier.artifactManifest?.rawScenarioPayloadStored === false
    && context.simulationReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && context.simulationReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.simulationReleaseDossier.dossierSha256,
    artifactManifest: context.simulationReleaseDossier.artifactManifest,
    checks: context.simulationReleaseDossier.checks
  });
  add('regression_dashboard_current', context.dashboard.dashboardVersion === 'g-regression-dashboard-v1' && context.dashboard.latest?.runId === context.releaseGate.regression.runId, {
    totalRuns: context.dashboard.totalRuns,
    latestRunId: context.dashboard.latest?.runId
  });
  add('regression_external_fixture_pack_loaded', context.regressionExternalFixturePack.fixturePackVersion === 'g-regression-external-fixture-pack-v1'
    && context.regressionExternalFixturePack.status === 'passed'
    && context.regressionExternalFixturePack.combinedFixtureCount >= context.regressionExternalFixturePack.minimumCombinedFixtureCount, {
    combinedFixtureCount: context.regressionExternalFixturePack.combinedFixtureCount,
    sourceCounts: context.regressionExternalFixturePack.sourceCounts,
    fixtureSha256: context.regressionExternalFixturePack.fixtureSha256
  });
  add('release_gate_ci_schedule_passed', context.releaseGateSchedule.scheduleVersion === 'g-release-gate-ci-schedule-v1'
    && context.releaseGateSchedule.status === 'passed'
    && context.releaseGateSchedule.runs.every((run) => run.status === 'passed'), {
    cycles: context.releaseGateSchedule.cycles,
    endpoint: context.releaseGateSchedule.scheduler.endpoint,
    runs: context.releaseGateSchedule.runs
  });
  add('regression_artifact_store_synced', context.regressionArtifactStoreSync.syncVersion === 'g-regression-artifact-store-sync-v1'
    && context.regressionArtifactStoreSync.status === 'synced'
    && context.regressionArtifactStoreSync.artifactStore.storeVersion === 'g-regression-long-term-artifact-store-v1'
    && context.regressionArtifactStoreSync.artifactCount >= 1, {
    artifactCount: context.regressionArtifactStoreSync.artifactCount,
    copiedCount: context.regressionArtifactStoreSync.copiedCount,
    targetDir: context.regressionArtifactStoreSync.targetDir
  });
  add('regression_suite_product_gate_passed', context.regressionProductGate.productGateVersion === 'g-regression-suite-product-gate-v1'
    && context.regressionProductGate.status === 'passed', {
    checks: context.regressionProductGate.checks
  });
  add('regression_release_dossier_ready', context.regressionReleaseDossier.dossierVersion === 'g-regression-suite-release-dossier-v1'
    && context.regressionReleaseDossier.status === 'passed'
    && context.regressionReleaseDossier.dossierSha256?.length === 64
    && context.regressionReleaseDossier.artifactManifest?.rawExternalFixturesStored === false
    && context.regressionReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.regressionReleaseDossier.dossierSha256,
    artifactManifest: context.regressionReleaseDossier.artifactManifest,
    checks: context.regressionReleaseDossier.checks
  });
  add('operational_release_gate_passed', context.releaseGate.gateVersion === 'g-operational-release-gate-v1' && context.releaseGate.status === 'passed', {
    gateId: context.releaseGate.gateId,
    score: context.releaseGate.score.total,
    triageCount: context.releaseGate.triage.length
  });
  add('report_store_retention_visible', context.reportIndex.indexVersion === 'g-report-index-v1' && context.reportRetention.dashboardVersion === 'g-report-retention-dashboard-v1', {
    totalReports: context.reportIndex.items.length,
    retentionStatus: context.reportRetention.status,
    storageBytes: context.reportRetention.storageBytes
  });
  add('report_store_immutable_artifact_synced', context.reportImmutableArtifactSync.syncVersion === 'g-report-immutable-artifact-sync-v1'
    && context.reportImmutableArtifactSync.status === 'synced'
    && context.reportImmutableArtifactSync.artifactStore.storeVersion === 'g-report-worm-artifact-store-v1'
    && context.reportImmutableArtifactSync.artifactCount >= 1, {
    status: context.reportImmutableArtifactSync.status,
    artifactCount: context.reportImmutableArtifactSync.artifactCount,
    copiedCount: context.reportImmutableArtifactSync.copiedCount,
    manifestPath: context.reportImmutableArtifactSync.manifestPath
  });
  add('report_store_long_term_trend_visualized', context.reportLongTermTrend.visualizationVersion === 'g-report-long-term-trend-visualization-v1'
    && context.reportLongTermTrend.status === 'ready'
    && context.reportLongTermTrend.artifact?.artifactVersion === 'g-report-long-term-trend-html-v1'
    && context.reportLongTermTrend.artifact?.written === true, {
    reportCount: context.reportLongTermTrend.reportCount,
    artifact: context.reportLongTermTrend.artifact,
    retentionStatus: context.reportLongTermTrend.retention.status
  });
  add('report_store_cleanup_approval_ready', context.reportRetentionPolicyUi.uiContractVersion === 'g-report-retention-policy-ui-v1'
    && context.reportRetentionPolicyUi.approvalWorkflow.workflowVersion === 'g-report-cleanup-approval-workflow-v1'
    && context.reportCleanupApprovalWorkflow.workflowVersion === 'g-report-cleanup-approval-workflow-v1'
    && context.reportCleanupApprovalWorkflow.status === 'pending_approval', {
    uiStatus: context.reportRetentionPolicyUi.status,
    approvalId: context.reportCleanupApprovalWorkflow.approval.approvalId,
    removableCount: context.reportCleanupApprovalWorkflow.cleanupPreview.removableCount
  });
  add('report_store_product_gate_passed', context.reportStoreProductGate.productGateVersion === 'g-report-store-product-gate-v1'
    && context.reportStoreProductGate.status === 'passed'
    && context.reportStoreProductGate.checks.every((check) => check.passed), {
    checks: context.reportStoreProductGate.checks
  });
  add('report_store_release_dossier_ready', context.reportStoreReleaseDossier.dossierVersion === 'g-report-store-release-dossier-v1'
    && context.reportStoreReleaseDossier.status === 'passed'
    && context.reportStoreReleaseDossier.dossierSha256?.length === 64
    && context.reportStoreReleaseDossier.artifactManifest?.rawReportPayloadStored === false
    && context.reportStoreReleaseDossier.artifactManifest?.rawReportPathsStored === false
    && context.reportStoreReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && context.reportStoreReleaseDossier.artifactManifest?.externalWormPromotionPackage?.packageVersion === 'g-report-store-external-worm-promotion-package-v1'
    && context.reportStoreReleaseDossier.artifactManifest?.externalWormPromotionPackage?.providerContractVersion === 'g-report-store-external-worm-provider-contract-v1'
    && context.reportStoreReleaseDossier.checks.some((check) => check.checkId === 'external_worm_promotion_package_ready' && check.passed)
    && context.reportStoreReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.reportStoreReleaseDossier.dossierSha256,
    artifactManifest: context.reportStoreReleaseDossier.artifactManifest,
    checks: context.reportStoreReleaseDossier.checks
  });
  add('score_12d_gate_available', context.scoreRubric.rubricVersion === 'g-12d-rubric-v1' && context.scoreGate.gateVersion === 'g-12d-score-gate-v1' && context.scoreGate.status === 'passed', {
    dimensionCount: context.scoreRubric.dimensions.length,
    total: context.scoreGate.score.total
  });
  add('score_12d_dashboard_annotation_ready', context.scoreDocumentRubric.extractorVersion === 'g-12d-document-rubric-extractor-v1'
    && context.scoreDocumentRubric.status === 'passed'
    && context.scoreDashboard.dashboardVersion === 'g-12d-score-dashboard-v1'
    && context.scoreDashboard.status === 'ready'
    && context.scoreCiAnnotation.annotationVersion === 'g-12d-ci-annotation-v1'
    && context.scoreCiAnnotation.status === 'passed', {
    rubricCoverage: context.scoreDocumentRubric.coverageRate,
    totalReports: context.scoreDashboard.totalReports,
    annotationStatus: context.scoreCiAnnotation.status
  });
  add('score_12d_product_gate_passed', context.scoreProductGate.productGateVersion === 'g-12d-score-product-gate-v1'
    && context.scoreProductGate.status === 'passed'
    && context.scoreProductGate.checks.every((check) => check.passed), {
    checks: context.scoreProductGate.checks,
    artifact: context.scoreProductGate.trendArtifact
  });
  add('golden_trace_baseline_approved', context.goldenTrace.success === true && context.baselineComparison.status === 'passed' && context.approvedBaseline.success === true && context.baselineTrend.approvedTraceCount >= 1, {
    traceCount: context.baselineTrend.traceCount,
    approvedTraceCount: context.baselineTrend.approvedTraceCount,
    baselineDiffArtifact: context.baselineComparison.artifact
  });
  add('baseline_approval_dashboard_ready', context.baselineApprovalDashboard.dashboardVersion === 'g-baseline-approval-dashboard-v1'
    && context.baselineApprovalDashboard.status === 'ready'
    && context.baselineApprovalDashboard.approvalMetadataComplete === true
    && context.baselineApprovalDashboard.approvedTraceCount >= 1, {
    approvedTraceCount: context.baselineApprovalDashboard.approvedTraceCount,
    pendingApprovalCount: context.baselineApprovalDashboard.pendingApprovalCount,
    maxRevision: context.baselineApprovalDashboard.maxRevision
  });
  add('golden_trace_retention_policy_visible', context.goldenTraceRetention.dashboardVersion === 'g-golden-trace-retention-policy-v1'
    && context.goldenTraceRetention.totalTraceCount >= 1
    && context.goldenTraceRetention.policy.cleanupEndpoint === '/golden-traces/rotate', {
    status: context.goldenTraceRetention.status,
    keepLast: context.goldenTraceRetention.policy.keepLast,
    removableTraceCount: context.goldenTraceRetention.removableTraceCount
  });
  add('golden_trace_ci_trend_visualized', context.goldenTraceCiTrend.visualizationVersion === 'g-golden-trace-ci-trend-visualization-v1'
    && context.goldenTraceCiTrend.status === 'ready'
    && context.goldenTraceCiTrend.artifact?.artifactVersion === 'g-golden-trace-ci-trend-html-v1'
    && context.goldenTraceCiTrend.artifact?.written === true, {
    traceCount: context.goldenTraceCiTrend.current.traceCount,
    approvedTraceCount: context.goldenTraceCiTrend.current.approvedTraceCount,
    artifact: context.goldenTraceCiTrend.artifact
  });
  add('golden_trace_release_dossier_ready', context.goldenTraceReleaseDossier.dossierVersion === 'g-golden-trace-release-dossier-v1'
    && context.goldenTraceReleaseDossier.status === 'passed'
    && context.goldenTraceReleaseDossier.dossierSha256?.length === 64
    && context.goldenTraceReleaseDossier.artifactManifest?.rawTracePayloadStored === false
    && context.goldenTraceReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && context.goldenTraceReleaseDossier.checks.every((check) => check.passed), {
    dossierSha256: context.goldenTraceReleaseDossier.dossierSha256,
    artifactManifest: context.goldenTraceReleaseDossier.artifactManifest,
    checks: context.goldenTraceReleaseDossier.checks
  });
  return checks;
}

function pickPlanReport(report) {
  return {
    verificationId: report.verificationId,
    status: report.status,
    score: report.score,
    checkCount: report.checks.length,
    failedChecks: report.checks.filter((check) => check.status === 'failed').map((check) => check.checkId),
    evidence: report.evidence
  };
}

function renderMarkdown(report) {
  const lines = [
    '# JARVIS G Verification Dashboard Dossier',
    '',
    `Status: **${report.status}**`,
    `Dossier: \`${report.dossierId}\``,
    `Dashboard release dossier: **${report.summary.dashboardReleaseDossierStatus}**`,
    `Release hash: \`${report.summary.dashboardReleaseHash}\``,
    `Release gate: **${report.summary.releaseGateStatus}**`,
    `Regression: **${report.summary.regressionStatus}**`,
    `12D score gate: **${report.summary.scoreGateStatus}**`,
    '',
    '## Checks',
    '',
    '| Check | Status |',
    '| --- | --- |',
    ...report.checks.map((check) => `| ${check.checkId} | ${check.status} |`),
    '',
    '## Evidence Summary',
    '',
    `- Plan score: ${report.summary.planScore}`,
    `- Document invariants: ${report.summary.documentInvariantCount}`,
    `- Document invariant coverage: ${report.summary.documentInvariantCoverageRate}`,
    `- Plan fixture pass rate: ${report.summary.planVerifierFixturePassRate}`,
    `- Plan document-diff fixture pass rate: ${report.summary.planDocumentDiffFixturePassRate}`,
    `- Plan regression visualization: ${report.summary.planRegressionVisualizationStatus}`,
    `- Plan verifier product gate: ${report.summary.planVerifierProductGateStatus}`,
    `- Plan verifier CI annotation: ${report.summary.planVerifierCiAnnotationStatus}`,
    `- Plan verifier artifact sync: ${report.summary.planVerifierArtifactSyncStatus}`,
    `- Fixture matrix pass rate: ${report.summary.fixtureMatrixPassRate}`,
    `- Execution verifier product gate: ${report.summary.executionVerifierProductGateStatus}`,
    `- Execution verifier release dossier: ${report.summary.executionVerifierReleaseDossierStatus}`,
    `- Execution adapter soak pass rate: ${report.summary.executionAdapterSoakPassRate}`,
    `- Policy compliance pass rate: ${report.summary.policyCompliancePassRate}`,
    `- Bridge security product drill: ${report.summary.bridgeSecurityProductDrillStatus}`,
    `- Learning verifier pass rate: ${report.summary.learningVerifierPassRate}`,
    `- Learning scheduler regression: ${report.summary.learningSchedulerRegressionStatus}`,
    `- Learning verifier product gate: ${report.summary.learningVerifierProductGateStatus}`,
    `- Learning verifier CI annotation: ${report.summary.learningVerifierCiAnnotationStatus}`,
    `- Learning verifier artifact sync: ${report.summary.learningVerifierArtifactSyncStatus}`,
    `- Approval-flow product gate: ${report.summary.approvalFlowProductGateStatus}`,
    `- Approval-flow latency: ${report.summary.approvalFlowLatencyStatus}`,
    `- Redteam pass rate: ${report.summary.redTeamPassRate}`,
    `- E security redteam pass rate: ${report.summary.policySecurityRedteamPassRate}`,
    `- Policy compliance product gate: ${report.summary.policyComplianceProductGateStatus}`,
    `- Simulation pass rate: ${report.summary.simulationPassRate}`,
    `- Simulation scenarios: ${report.summary.simulationScenarioCount}`,
    `- Simulation chaos pass rate: ${report.summary.simulationChaosPassRate}`,
    `- Simulation trend retention: ${report.summary.simulationRetentionStatus}`,
    `- Tool leak failed cases: ${report.summary.toolLeakFailed}`,
    `- Tool leak pass rate: ${report.summary.toolLeakPassRate}`,
    `- Tool leak fixture count: ${report.summary.toolLeakFixtureCount}`,
    `- Tool leak DOM diff: ${report.summary.toolLeakDomDiffStatus}`,
    `- Tool leak retention policy: ${report.summary.toolLeakRetentionPolicy}`,
    `- Dashboard runs: ${report.summary.dashboardRuns}`,
    `- Report store items: ${report.summary.reportStoreItems}`,
    `- Report store product gate: ${report.summary.reportStoreProductGateStatus}`,
    `- Report immutable sync: ${report.summary.reportImmutableArtifactSyncStatus}`,
    `- Report long-term trend: ${report.summary.reportLongTermTrendStatus}`,
    `- Report cleanup approval: ${report.summary.reportCleanupApprovalStatus}`,
    `- 12D score dashboard: ${report.summary.scoreDashboardStatus}`,
    `- 12D document rubric: ${report.summary.scoreDocumentRubricStatus}`,
    `- 12D CI annotation: ${report.summary.scoreCiAnnotationStatus}`,
    `- 12D product gate: ${report.summary.scoreProductGateStatus}`,
    `- Approved baseline traces: ${report.summary.approvedBaselineTraceCount}`,
    `- Baseline approval dashboard: ${report.summary.baselineApprovalDashboardStatus}`,
    `- Golden trace retention: ${report.summary.goldenTraceRetentionStatus}`,
    `- Golden trace CI trend: ${report.summary.goldenTraceCiTrendStatus}`,
    `- Dashboard release dossier: ${report.summary.dashboardReleaseDossierStatus}`,
    '',
    '## Artifacts',
    '',
    ...report.artifactManifest.runtimeArtifacts.map((item) => `- \`${item}\``),
    '',
    '## Recommendations',
    '',
    ...report.recommendations.map((item) => `- ${item}`)
  ];
  return `${lines.join('\n')}\n`;
}

function renderCsv(report) {
  const rows = [['check_id', 'status', 'detail'].join(',')];
  for (const check of report.checks) {
    rows.push([check.checkId, check.status, csv(JSON.stringify(check.detail))].join(','));
  }
  return `${rows.join('\n')}\n`;
}

function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
    else if (arg === '--audit-root') args.auditRoot = argv[++index];
    else if (arg === '--fail-below') args.failBelow = Number(argv[++index]);
    else if (arg === '--score-fail-below') args.scoreFailBelow = Number(argv[++index]);
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runVerificationDashboardDossier(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS G Verification Dashboard Dossier');
  console.log(`Status: ${report.status}`);
  console.log(`Release gate: ${report.summary.releaseGateStatus}`);
  console.log(`Regression: ${report.summary.regressionStatus}`);
  console.log(`Redteam pass rate: ${report.summary.redTeamPassRate}`);
  console.log(`Simulation pass rate: ${report.summary.simulationPassRate}`);
  console.log(`Dashboard release dossier: ${report.summary.dashboardReleaseDossierStatus}`);
  console.log(`Report: ${report.artifactManifest.jsonPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
