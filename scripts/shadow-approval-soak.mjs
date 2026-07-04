import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { runGoldenShadowCorpus } from '../apps/pc-agent/src/shadow/golden-shadow-runner.js';
import { loadPcAgentInstallConfig } from '../apps/pc-agent/src/install/service-planner.js';
import { createTrayApprovalDiffState } from '../apps/pc-agent/src/install/tray-runtime.js';
import { createApprovalDiffReviewState } from '../apps/mobile/src/components/ApprovalActionPanel.js';
import { ActionType } from '../packages/shared/src/types.js';

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function runShadowApprovalSoakReport({
  cycles = 3,
  jsonPath = 'dist/shadow-approval-soak-report.json',
  markdownPath = 'dist/shadow-approval-soak-report.md',
  csvPath = 'dist/shadow-approval-soak-report.csv'
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-shadow-approval-soak-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const { policyRuntime, pcAgent } = createAgRuntime({ allowedRoots: [workspaceRoot], auditRoot: root });
  const corpus = JSON.parse(await readFile('apps/pc-agent/fixtures/shadow-golden-corpus.json', 'utf8'));
  const cycleReports = [];
  for (let cycleIndex = 0; cycleIndex < Math.max(1, Number(cycles) || 1); cycleIndex += 1) {
    cycleReports.push(await runGoldenShadowCorpus({
      registry: pcAgent.registry,
      corpus,
      root: join(workspaceRoot, `cycle-${cycleIndex + 1}`),
      variables: {
        ministryReportTemplate: join(process.cwd(), 'apps', 'pc-agent', 'templates', 'excel', 'ministry-report.json')
      }
    }));
  }
  const approvalDiffs = cycleReports.flatMap((report) => report.results.map((result) => ({
    ...result.approvalDiff,
    diffId: `${result.fixtureId}:${result.toolName}`
  })));
  const mobileDiffStates = approvalDiffs.map((approvalDiff, index) => createApprovalDiffReviewState({
    approvalDiff,
    card: {
      approvalId: `approval_shadow_${index + 1}`,
      taskId: `task_shadow_${index + 1}`
    }
  }));
  const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
  const trayApprovalDiff = createTrayApprovalDiffState({
    daemonConfig,
    serviceManifest,
    approvalDiffs
  });
  const queueDrainSoak = await runShadowQueueDrainSoak({ pcAgent, policyRuntime, workspaceRoot, cycles: Math.max(1, Number(cycles) || 1) });
  const failedCycleReports = cycleReports.filter((report) => !report.passed);
  const status = failedCycleReports.length === 0
    && mobileDiffStates.every((state) => state.stateVersion === 'c-approval-diff-review-ui-v1')
    && trayApprovalDiff.panelVersion === 'b-tray-approval-diff-panel-v1'
    && queueDrainSoak.status === 'passed'
    ? 'passed'
    : 'failed';
  const artifactManifest = createShadowApprovalReleaseArtifactManifest({
    cycleReports,
    approvalDiffs,
    mobileDiffStates,
    trayApprovalDiff,
    queueDrainSoak,
    artifacts: { jsonPath, markdownPath, csvPath }
  });
  const operationalHandoffManifest = createShadowApprovalOperationalHandoffManifest({
    status,
    artifactManifest,
    approvalDiffs,
    queueDrainSoak,
    trayApprovalDiff,
    mobileDiffStates
  });
  const ciNightlyGatePlan = createShadowApprovalCiNightlyGatePlan({
    artifactManifest,
    operationalHandoffManifest
  });
  const externalWormPromotionPackage = createShadowApprovalWormPromotionPackage({
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan
  });
  const report = {
    reportVersion: 'b-shadow-approval-soak-report-v1',
    dossierVersion: 'b-shadow-approval-release-dossier-v1',
    status: status === 'passed' && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    cycles: cycleReports.length,
    fixtureCount: corpus.fixtures.length,
    itemCount: approvalDiffs.length,
    passedCount: cycleReports.reduce((sum, item) => sum + item.passedCount, 0),
    failedCount: cycleReports.reduce((sum, item) => sum + item.failedCount, 0),
    approvalDiffContract: {
      diffVersion: 'b-approval-diff-v1',
      allVersioned: approvalDiffs.every((item) => item.diffVersion === 'b-approval-diff-v1'),
      mobileStateVersion: 'c-approval-diff-review-ui-v1',
      trayPanelVersion: 'b-tray-approval-diff-panel-v1'
    },
    mobileDiffStates,
    trayApprovalDiff,
    queueDrainSoak,
    cycleReports,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    artifacts: { jsonPath: resolve(jsonPath), markdownPath: resolve(markdownPath), csvPath: resolve(csvPath) }
  };
  report.dossierSha256 = sha256Json(report);
  report.productGate = createShadowApprovalProductGate(report);
  await writeShadowApprovalSoakArtifacts(report, { jsonPath, markdownPath, csvPath });
  return report;
}

export function createShadowApprovalProductGate(report) {
  const cycleResults = (report.cycleReports ?? []).flatMap((cycle) => cycle.results ?? []);
  const browserReadOnlyFixture = cycleResults.find((item) => item.toolName === 'browser.search');
  const conflictFixture = cycleResults.find((item) => item.approvalDiff?.conflictCount > 0);
  const mutatingFixtures = cycleResults.filter((item) => item.approvalDiff?.mutatesSystem === true);
  const checks = [
    {
      checkId: 'shadow_golden_corpus_passed',
      passed: report.reportVersion === 'b-shadow-approval-soak-report-v1'
        && report.status === 'passed'
        && report.fixtureCount >= 1
        && report.failedCount === 0
        && (report.cycleReports ?? []).every((cycle) => cycle.passed === true),
      fixtureCount: report.fixtureCount,
      failedCount: report.failedCount
    },
    {
      checkId: 'approval_diff_contract_ready',
      passed: report.approvalDiffContract?.diffVersion === 'b-approval-diff-v1'
        && report.approvalDiffContract?.allVersioned === true
        && report.approvalDiffContract?.mobileStateVersion === 'c-approval-diff-review-ui-v1'
        && report.approvalDiffContract?.trayPanelVersion === 'b-tray-approval-diff-panel-v1'
        && report.itemCount === cycleResults.length,
      itemCount: report.itemCount
    },
    {
      checkId: 'shadow_prewrite_guard_ready',
      passed: cycleResults.length > 0
        && cycleResults.every((item) => item.shadow?.mode === 'shadow')
        && mutatingFixtures.length > 0
        && mutatingFixtures.every((item) => item.approvalDiff?.requiresUserApproval === true)
        && browserReadOnlyFixture?.approvalDiff?.readOnly === true
        && browserReadOnlyFixture?.approvalDiff?.safeToAutoApprove === true
        && Boolean(conflictFixture),
      mutatingFixtureCount: mutatingFixtures.length,
      conflictObserved: Boolean(conflictFixture),
      readOnlyFixtureObserved: Boolean(browserReadOnlyFixture)
    },
    {
      checkId: 'approval_review_surfaces_ready',
      passed: (report.mobileDiffStates ?? []).length === report.itemCount
        && (report.mobileDiffStates ?? []).every((state) => state.stateVersion === 'c-approval-diff-review-ui-v1')
        && report.trayApprovalDiff?.panelVersion === 'b-tray-approval-diff-panel-v1'
        && report.trayApprovalDiff?.count === report.itemCount,
      mobileStateCount: report.mobileDiffStates?.length ?? 0,
      trayCount: report.trayApprovalDiff?.count ?? 0
    },
    {
      checkId: 'shadow_queue_drain_soak_passed',
      passed: report.queueDrainSoak?.soakVersion === 'b-shadow-queue-drain-soak-v1'
        && report.queueDrainSoak?.status === 'passed'
        && report.queueDrainSoak?.processedTotal === report.queueDrainSoak?.cycles
        && report.queueDrainSoak?.finalQueueStatus?.quarantined === 0,
      processedTotal: report.queueDrainSoak?.processedTotal ?? 0,
      cycles: report.queueDrainSoak?.cycles ?? 0
    },
    {
      checkId: 'shadow_approval_release_dossier_ready',
      passed: report.dossierVersion === 'b-shadow-approval-release-dossier-v1'
        && report.status === 'passed'
        && typeof report.dossierSha256 === 'string'
        && report.dossierSha256.length === 64
    },
    {
      checkId: 'shadow_approval_release_artifact_manifest_ready',
      passed: report.artifactManifest?.artifactManifestVersion === 'b-shadow-approval-release-artifact-manifest-v1'
        && report.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        && report.artifactManifest.rawApprovalDiffPathStored === false
        && report.artifactManifest.rawPacketPayloadStored === false
    },
    {
      checkId: 'shadow_approval_operational_handoff_ready',
      passed: report.operationalHandoffManifest?.manifestVersion === 'b-shadow-approval-operational-handoff-manifest-v1'
        && report.operationalHandoffManifest?.healthHandshakeVersion === 'b-shadow-approval-health-handshake-v1'
        && report.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'b-shadow-approval-fallback-policy-v1'
        && report.operationalHandoffManifest?.status === 'ready'
    },
    {
      checkId: 'shadow_approval_worm_promotion_package_ready',
      passed: report.externalWormPromotionPackage?.packageVersion === 'b-shadow-approval-worm-promotion-package-v1'
        && report.externalWormPromotionPackage?.providerContractVersion === 'b-shadow-approval-worm-provider-contract-v1'
        && report.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-shadow-approval-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: report.dossierVersion,
      reportVersion: report.reportVersion,
      status: report.status,
      dossierSha256: report.dossierSha256
    }
  };
}

async function runShadowQueueDrainSoak({ pcAgent, policyRuntime, workspaceRoot, cycles }) {
  const drains = [];
  for (let index = 0; index < cycles; index += 1) {
    const outputPath = join(workspaceRoot, `shadow-queue-${index + 1}.txt`);
    const token = policyRuntime.capabilities.issue({
      taskId: `task_shadow_queue_${index + 1}`,
      planId: `plan_shadow_queue_${index + 1}`,
      approvalId: `appr_shadow_queue_${index + 1}`,
      action: { actionType: ActionType.CREATE_FILE, toolName: 'filesystem.createTextFile', skillId: 'jarvis.local.mvp' },
      allowedPaths: [workspaceRoot]
    });
    pcAgent.queueExecutionPacket({
      taskId: `task_shadow_queue_${index + 1}`,
      packetId: `packet_shadow_queue_${index + 1}`,
      capabilityToken: token,
      requestedMode: 'shadow',
      userConfirmation: { confirmed: true },
      action: {
        actionType: ActionType.CREATE_FILE,
        toolName: 'filesystem.createTextFile',
        arguments: { path: outputPath, content: 'shadow approval soak' }
      }
    });
    drains.push(await pcAgent.processExecutionQueue({ limit: 1 }));
  }
  return {
    soakVersion: 'b-shadow-queue-drain-soak-v1',
    status: drains.every((item) => item.processed === 1 && item.status.quarantined === 0) ? 'passed' : 'failed',
    cycles,
    processedTotal: drains.reduce((sum, item) => sum + item.processed, 0),
    finalQueueStatus: pcAgent.executionQueueStatus(),
    drains
  };
}

async function writeShadowApprovalSoakArtifacts(report, { jsonPath, markdownPath, csvPath }) {
  await mkdir(dirname(resolve(jsonPath)), { recursive: true });
  await mkdir(dirname(resolve(markdownPath)), { recursive: true });
  await mkdir(dirname(resolve(csvPath)), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderShadowApprovalSoakMarkdown(report), 'utf8');
  await writeFile(csvPath, renderShadowApprovalSoakCsv(report), 'utf8');
}

function renderShadowApprovalSoakMarkdown(report) {
  const lines = [
    '# JARVIS B Shadow Approval Soak',
    '',
    `Status: ${report.status}`,
    `Cycles: ${report.cycles}`,
    `Fixture count: ${report.fixtureCount}`,
    `Approval diff items: ${report.itemCount}`,
    `Queue drain soak: ${report.queueDrainSoak.status}`,
    `Tray panel: ${report.trayApprovalDiff.panelVersion}`,
    `Mobile state: ${report.approvalDiffContract.mobileStateVersion}`,
    `Operational handoff: ${report.operationalHandoffManifest.manifestVersion} / ${report.operationalHandoffManifest.status}`,
    `WORM promotion package: ${report.externalWormPromotionPackage.packageVersion} / ${report.externalWormPromotionPackage.status}`,
    `Product gate: ${report.productGate.productGateVersion} / ${report.productGate.status}`,
    `Release dossier: ${report.dossierVersion}`,
    '',
    '## Failed Fixtures'
  ];
  const failed = report.cycleReports.flatMap((cycle) => cycle.results.filter((item) => !item.passed).map((item) => item.fixtureId));
  if (!failed.length) lines.push('- none');
  for (const item of failed) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

function renderShadowApprovalSoakCsv(report) {
  const rows = [['cycle', 'fixtureId', 'toolName', 'passed', 'severity', 'requiresUserApproval']]
    .concat(report.cycleReports.flatMap((cycle, cycleIndex) => cycle.results.map((item) => [
      cycleIndex + 1,
      item.fixtureId,
      item.toolName,
      item.passed,
      item.approvalDiff?.severity,
      item.approvalDiff?.requiresUserApproval
    ])))
    .concat(report.productGate.checks.map((check) => [
      'product-gate',
      check.checkId,
      report.productGate.productGateVersion,
      check.passed,
      check.passed ? 'passed' : 'blocked',
      ''
    ]));
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createShadowApprovalReleaseArtifactManifest({
  cycleReports,
  approvalDiffs,
  mobileDiffStates,
  trayApprovalDiff,
  queueDrainSoak,
  artifacts
}) {
  const manifest = {
    artifactManifestVersion: 'b-shadow-approval-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    cycleReportHash: sha256Json((cycleReports ?? []).map((cycle) => ({
      passed: cycle.passed,
      fixtureCount: cycle.fixtureCount,
      passedCount: cycle.passedCount,
      failedCount: cycle.failedCount
    }))),
    approvalDiffHashes: (approvalDiffs ?? []).slice(0, 100).map((diff) => ({
      diffId: diff.diffId,
      diffVersion: diff.diffVersion,
      diffHash: sha256Json({
        diffVersion: diff.diffVersion,
        toolName: diff.toolName,
        mutatesSystem: diff.mutatesSystem,
        readOnly: diff.readOnly,
        requiresUserApproval: diff.requiresUserApproval,
        severity: diff.severity,
        conflictCount: diff.conflictCount
      })
    })),
    mobileStateHash: sha256Json((mobileDiffStates ?? []).map((state) => ({
      stateVersion: state.stateVersion,
      approvalId: state.approvalId,
      taskId: state.taskId,
      requiresUserApproval: state.requiresUserApproval
    }))),
    trayPanelHash: sha256Json({
      panelVersion: trayApprovalDiff?.panelVersion ?? null,
      count: trayApprovalDiff?.count ?? 0
    }),
    queueDrainSoakHash: sha256Json({
      soakVersion: queueDrainSoak?.soakVersion ?? null,
      status: queueDrainSoak?.status ?? null,
      cycles: queueDrainSoak?.cycles ?? 0,
      processedTotal: queueDrainSoak?.processedTotal ?? 0,
      quarantined: queueDrainSoak?.finalQueueStatus?.quarantined ?? null
    }),
    artifactPathHashes: {
      jsonPathHash: sha256Json(resolve(artifacts.jsonPath)),
      markdownPathHash: sha256Json(resolve(artifacts.markdownPath)),
      csvPathHash: sha256Json(resolve(artifacts.csvPath))
    },
    rawApprovalDiffPathStored: false,
    rawPacketPayloadStored: false,
    rawCapabilityTokenStored: false,
    rawWorkspacePathStored: false
  };
  manifest.rawLeakCheck = {
    checkVersion: 'b-shadow-approval-release-raw-leak-check-v1',
    rawLeakDetected: containsShadowApprovalRawLeak(manifest),
    checkedRawFields: [
      'rawApprovalDiffPathStored',
      'rawPacketPayloadStored',
      'rawCapabilityTokenStored',
      'rawWorkspacePathStored'
    ]
  };
  return manifest;
}

function createShadowApprovalOperationalHandoffManifest({
  status,
  artifactManifest,
  approvalDiffs,
  queueDrainSoak,
  trayApprovalDiff,
  mobileDiffStates
}) {
  return {
    manifestVersion: 'b-shadow-approval-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'b-shadow-approval-health-handshake-v1',
    generatedAt: new Date().toISOString(),
    status: status === 'passed' && artifactManifest?.rawLeakCheck?.rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshake: {
      approvalDiffCount: approvalDiffs?.length ?? 0,
      allDiffsVersioned: (approvalDiffs ?? []).every((diff) => diff.diffVersion === 'b-approval-diff-v1'),
      mobileStateReady: (mobileDiffStates ?? []).every((state) => state.stateVersion === 'c-approval-diff-review-ui-v1'),
      trayPanelVersion: trayApprovalDiff?.panelVersion ?? null,
      queueDrainStatus: queueDrainSoak?.status ?? null,
      queueDrainProcessedTotal: queueDrainSoak?.processedTotal ?? 0
    },
    fallbackPolicy: {
      policyVersion: 'b-shadow-approval-fallback-policy-v1',
      primaryFlow: 'shadow_preview_then_mobile_or_tray_approval_diff_review',
      fallbackFlows: [
        'queue_drain_soak_retry',
        'poison_queue_review_before_execute',
        'block_mutating_adapter_without_approval_diff'
      ],
      operatorEscalation: 'pc_agent_tray_shadow_approval_panel'
    },
    artifactManifestHash: sha256Json(artifactManifest),
    rawApprovalDiffPathStored: false,
    rawPacketPayloadStored: false
  };
}

function createShadowApprovalCiNightlyGatePlan({ artifactManifest, operationalHandoffManifest }) {
  return {
    planVersion: 'b-shadow-approval-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run shadow:approval-soak',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'shadow_golden_corpus_passed',
      'approval_diff_contract_ready',
      'shadow_prewrite_guard_ready',
      'approval_review_surfaces_ready',
      'shadow_queue_drain_soak_passed',
      'shadow_approval_release_artifact_manifest_ready',
      'shadow_approval_operational_handoff_ready',
      'shadow_approval_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    operationalHandoffHash: sha256Json(operationalHandoffManifest),
    rawPacketPayloadStored: false
  };
}

function createShadowApprovalWormPromotionPackage({
  artifactManifest,
  operationalHandoffManifest,
  ciNightlyGatePlan
}) {
  return {
    packageVersion: 'b-shadow-approval-worm-promotion-package-v1',
    providerContractVersion: 'b-shadow-approval-worm-provider-contract-v1',
    status: artifactManifest?.artifactManifestVersion === 'b-shadow-approval-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && operationalHandoffManifest?.status === 'ready'
      && ciNightlyGatePlan?.planVersion === 'b-shadow-approval-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    operationalHandoffHash: sha256Json(operationalHandoffManifest),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPacketPayloadStored: false,
    rawCapabilityTokenStored: false
  };
}

function containsShadowApprovalRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"path"\s*:|"outputPath"\s*:|"capabilityToken"\s*:|"arguments"\s*:|"workspaceRoot"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cycles') options.cycles = Number(argv[index + 1]);
    if (arg === '--json') options.jsonPath = argv[index + 1];
    if (arg === '--md') options.markdownPath = argv[index + 1];
    if (arg === '--csv') options.csvPath = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runShadowApprovalSoakReport(cliOptions(process.argv.slice(2)));
  console.log('# JARVIS B Shadow Approval Soak');
  console.log(`Status: ${report.status}`);
  console.log(`Cycles: ${report.cycles}`);
  console.log(`Reports: ${report.artifacts.jsonPath}, ${report.artifacts.markdownPath}, ${report.artifacts.csvPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
