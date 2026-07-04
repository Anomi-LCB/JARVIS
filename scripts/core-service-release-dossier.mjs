import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeCoreServicePackage } from '../packages/core/src/install/core-service-packager.js';
import { runCoreServiceSmoke } from './core-service-smoke.mjs';
import { runCoreServiceSoak } from './core-service-soak.mjs';

export async function runCoreServiceReleaseDossier({
  jsonPath = 'dist/core-service-release-dossier.json',
  markdownPath = 'dist/core-service-release-dossier.md',
  csvPath = 'dist/core-service-release-dossier.csv',
  releaseRoot = 'dist/core-service-release-lab',
  adminToken = 'local-core-service-release-admin',
  taskCount = 3,
  intervalMs = 20,
  drainLimit = 1,
  durationMs = 500
} = {}) {
  const root = resolve(releaseRoot);
  const packageDir = join(root, 'package');
  const smokeRoot = join(root, 'smoke');
  const soakRoot = join(root, 'soak');
  const smokePath = join(root, 'core-service-smoke-report.json');
  const soakPath = join(root, 'core-service-soak-report.json');

  await mkdir(root, { recursive: true });
  const packageResult = await writeCoreServicePackage({
    cwd: process.cwd(),
    outputDir: packageDir,
    logs: {
      adminTokenHash: createHash('sha256').update(adminToken).digest('hex'),
      workerDaemonIntervalMs: intervalMs,
      workerDaemonDrainLimit: drainLimit
    }
  });
  const smokeReport = await runCoreServiceSmoke({
    reportPath: smokePath,
    smokeRoot,
    adminToken
  });
  const soakReport = await runCoreServiceSoak({
    reportPath: soakPath,
    soakRoot,
    adminToken,
    taskCount,
    intervalMs,
    drainLimit,
    durationMs
  });

  const releaseDossier = createCoreServiceReleaseDossier({
    packageResult,
    smokeReport,
    soakReport,
    root,
    packageDir,
    smokePath,
    soakPath
  });
  const productGate = createCoreServiceReleaseProductGate({ releaseDossier });
  const report = {
    reportVersion: 'a-core-service-release-dossier-report-v1',
    generatedAt: new Date().toISOString(),
    status: productGate.status,
    releaseDossier,
    productGate,
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      csvPath: resolve(csvPath),
      releaseRoot: root,
      packageDir,
      smokePath,
      soakPath
    }
  };

  await mkdir(dirname(resolve(jsonPath)), { recursive: true });
  await mkdir(dirname(resolve(markdownPath)), { recursive: true });
  await mkdir(dirname(resolve(csvPath)), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  return report;
}

export function createCoreServiceReleaseDossier({
  packageResult,
  smokeReport,
  soakReport,
  root,
  packageDir,
  smokePath,
  soakPath
}) {
  const releaseChecks = [
    {
      checkId: 'core_service_package_release_artifacts_ready',
      passed: packageResult?.success === true
        && packageResult.manifest?.packageVersion === 'a-core-service-package-v1'
        && packageResult.manifest?.safety?.fullAgRuntimeEntry === true
        && packageResult.manifest?.files?.includes('install-all.ps1')
        && packageResult.manifest?.files?.includes('run-installed-service-smoke.ps1')
        && packageResult.manifest?.files?.includes('run-installed-service-soak.ps1'),
      packageVersion: packageResult?.manifest?.packageVersion ?? null,
      fileCount: packageResult?.files?.length ?? 0
    },
    {
      checkId: 'core_service_user_process_smoke_passed',
      passed: smokeReport?.reportVersion === 'a-core-service-smoke-report-v1'
        && smokeReport.status === 'passed'
        && smokeReport.task?.status === 'COMPLETED'
        && smokeReport.task?.executionVerification === 'passed'
        && smokeReport.task?.learningStored === true,
      taskId: smokeReport?.task?.taskId ?? null,
      daemonProcessed: smokeReport?.daemonTick?.drain?.processed ?? 0
    },
    {
      checkId: 'core_service_daemon_soak_passed',
      passed: soakReport?.reportVersion === 'a-core-service-soak-report-v1'
        && soakReport.status === 'passed'
        && soakReport.completedCount === soakReport.taskCount
        && soakReport.verifiedCount === soakReport.taskCount
        && soakReport.learnedCount === soakReport.taskCount
        && soakReport.daemon?.consecutiveFailures === 0,
      taskCount: soakReport?.taskCount ?? 0,
      completedCount: soakReport?.completedCount ?? 0,
      tickCount: soakReport?.daemon?.tickCount ?? 0
    },
    {
      checkId: 'core_service_durable_artifacts_ready',
      passed: Boolean(smokeReport?.artifacts?.eventLogPath)
        && Boolean(smokeReport?.artifacts?.workerQueueStorePath)
        && Boolean(smokeReport?.artifacts?.workerLeaseStorePath)
        && soakReport?.artifactSummary?.watchdogEventCount >= soakReport?.taskCount
        && soakReport?.artifactSummary?.tickEventCount >= soakReport?.taskCount,
      smokeEventLogPath: smokeReport?.artifacts?.eventLogPath ?? null,
      soakEventLogPath: soakReport?.artifacts?.eventLogPath ?? null,
      watchdogEventCount: soakReport?.artifactSummary?.watchdogEventCount ?? 0,
      tickEventCount: soakReport?.artifactSummary?.tickEventCount ?? 0
    },
    {
      checkId: 'core_service_installed_service_runbook_ready',
      passed: packageResult?.manifest?.safety?.actualServiceInstallRequiresAdministrator === true
        && packageResult.manifest?.files?.includes('verify-installed-core-service.ps1')
        && packageResult.manifest?.files?.includes('collect-core-logs.ps1'),
      serviceInstalledInThisRun: false,
      administratorRequired: true
    }
  ];
  const artifactManifest = createCoreServiceReleaseArtifactManifest({
    releaseChecks,
    packageResult,
    smokeReport,
    soakReport,
    root,
    packageDir,
    smokePath,
    soakPath
  });
  const ciNightlyGatePlan = createCoreServiceReleaseCiNightlyGatePlan({ artifactManifest });
  const externalWormPromotionPackage = createCoreServiceReleaseExternalWormPromotionPackage({
    artifactManifest,
    ciNightlyGatePlan,
    releaseChecks
  });
  const dossier = {
    dossierVersion: 'a-core-service-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status: releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    mode: 'user-process-release-lab-with-administrator-runbook',
    serviceInstalledInThisRun: false,
    administratorInstallRequired: true,
    package: {
      packageVersion: packageResult?.manifest?.packageVersion ?? null,
      packageId: packageResult?.manifest?.packageId ?? null,
      outputDir: packageResult?.outputDir ?? packageDir,
      runtimeEntry: packageResult?.manifest?.runtimeEntry ?? null,
      fileCount: packageResult?.files?.length ?? 0,
      signatureStatus: packageResult?.manifest?.signatureStatus ?? null,
      fullAgRuntimeEntry: packageResult?.manifest?.safety?.fullAgRuntimeEntry === true
    },
    smoke: {
      reportVersion: smokeReport?.reportVersion ?? null,
      status: smokeReport?.status ?? null,
      mode: smokeReport?.mode ?? null,
      serviceRuntimeVersion: smokeReport?.serviceRuntime?.runtimeVersion ?? null,
      taskStatus: smokeReport?.task?.status ?? null,
      executionVerification: smokeReport?.task?.executionVerification ?? null,
      learningStored: smokeReport?.task?.learningStored === true
    },
    soak: {
      reportVersion: soakReport?.reportVersion ?? null,
      status: soakReport?.status ?? null,
      mode: soakReport?.mode ?? null,
      taskCount: soakReport?.taskCount ?? 0,
      completedCount: soakReport?.completedCount ?? 0,
      verifiedCount: soakReport?.verifiedCount ?? 0,
      learnedCount: soakReport?.learnedCount ?? 0,
      daemonTickCount: soakReport?.daemon?.tickCount ?? 0,
      processedTotal: soakReport?.daemon?.processedTotal ?? 0,
      consecutiveFailures: soakReport?.daemon?.consecutiveFailures ?? null,
      watchdogEventCount: soakReport?.artifactSummary?.watchdogEventCount ?? 0,
      tickEventCount: soakReport?.artifactSummary?.tickEventCount ?? 0
    },
    artifacts: {
      releaseRootHash: sha256Text(root),
      packageDirHash: sha256Text(packageDir),
      smokePathHash: sha256Text(smokePath),
      soakPathHash: sha256Text(soakPath),
      packageManifestPathHash: sha256Text(join(packageDir, 'package-manifest.json')),
      rawArtifactPathsStored: false
    },
    releaseChecks,
    artifactManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'run_administrator_install_all_and_promote_hash_only_release_manifest_to_worm'
      : 'block_core_service_release_until_package_smoke_soak_and_worm_gate_pass'
  };
  dossier.dossierSha256 = createHash('sha256').update(canonicalJson(dossier)).digest('hex');
  return dossier;
}

export function createCoreServiceReleaseProductGate({ releaseDossier }) {
  const checks = [
    {
      checkId: 'core_service_release_dossier_ready',
      passed: releaseDossier?.dossierVersion === 'a-core-service-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    },
    {
      checkId: 'core_service_package_smoke_soak_ready',
      passed: releaseDossier?.releaseChecks?.every((check) => check.passed) === true
    },
    {
      checkId: 'core_service_release_artifact_manifest_ready',
      passed: releaseDossier?.artifactManifest?.artifactManifestVersion === 'a-core-service-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
    },
    {
      checkId: 'core_service_installed_handoff_ready',
      passed: releaseDossier?.artifactManifest?.installedServiceHandoffManifest?.manifestVersion === 'a-core-installed-service-handoff-manifest-v1'
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.healthHandshakeVersion === 'a-core-installed-service-health-handshake-v1'
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.fallbackPolicy?.policyVersion === 'a-core-service-release-fallback-policy-v1'
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.installAllScriptPresent === true
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.installedVerificationScriptPresent === true
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.installedSmokeScriptPresent === true
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.installedSoakScriptPresent === true
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.rawScriptBodiesStored === false
        && releaseDossier.artifactManifest.installedServiceHandoffManifest?.rawAdminTokenStored === false
    },
    {
      checkId: 'core_service_worm_promotion_package_ready',
      passed: releaseDossier?.externalWormPromotionPackage?.packageVersion === 'a-core-service-release-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'a-core-service-release-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    },
    {
      checkId: 'core_service_administrator_runbook_ready',
      passed: releaseDossier?.administratorInstallRequired === true
        && releaseDossier?.package?.fullAgRuntimeEntry === true
        && releaseDossier?.serviceInstalledInThisRun === false
    }
  ];
  return {
    productGateVersion: 'a-core-service-release-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier?.dossierVersion ?? null,
      status: releaseDossier?.status ?? null,
      dossierSha256: releaseDossier?.dossierSha256 ?? null
    }
  };
}

function createCoreServiceReleaseArtifactManifest({
  releaseChecks,
  packageResult,
  smokeReport,
  soakReport,
  root,
  packageDir,
  smokePath,
  soakPath
}) {
  const manifestCore = {
    artifactManifestVersion: 'a-core-service-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    installedServiceHandoffManifest: {
      manifestVersion: 'a-core-installed-service-handoff-manifest-v1',
      healthHandshakeVersion: 'a-core-installed-service-health-handshake-v1',
      serviceInstalledInThisRun: false,
      administratorInstallRequired: true,
      packageVersion: packageResult?.manifest?.packageVersion ?? null,
      fullAgRuntimeEntry: packageResult?.manifest?.safety?.fullAgRuntimeEntry === true,
      installAllScriptPresent: packageResult?.manifest?.files?.includes('install-all.ps1') === true,
      installedVerificationScriptPresent: packageResult?.manifest?.files?.includes('verify-installed-core-service.ps1') === true,
      installedSmokeScriptPresent: packageResult?.manifest?.files?.includes('run-installed-service-smoke.ps1') === true,
      installedSoakScriptPresent: packageResult?.manifest?.files?.includes('run-installed-service-soak.ps1') === true,
      healthHandshake: {
        servicePlanCommand: 'node packages/core/src/cli/service-plan.mjs status',
        statusEndpoint: '/runtime/service-plan',
        smokeScript: 'run-installed-service-smoke.ps1',
        soakScript: 'run-installed-service-soak.ps1',
        verificationScript: 'verify-installed-core-service.ps1',
        expectedEvidenceFiles: [
          'installed-service-verification.json',
          'installed-service-smoke.json',
          'installed-service-soak.json'
        ]
      },
      fallbackPolicy: {
        policyVersion: 'a-core-service-release-fallback-policy-v1',
        primaryFlow: 'administrator_install_all_then_verify_installed_service',
        fallbackFlows: [
          'user_process_core_service_runtime_smoke',
          'dry_run_service_plan_validation',
          'manual_service_recovery_runbook'
        ],
        rollbackCommand: 'uninstall-core-service.ps1',
        operatorEscalation: 'core_service_admin_console'
      },
      rawScriptBodiesStored: false,
      rawAdminTokenStored: false
    },
    releaseEvidenceHashes: {
      releaseChecksHash: sha256Json(releaseChecks.map((check) => ({
        checkId: check.checkId,
        passed: check.passed
      }))),
      packageManifestHash: sha256Json({
        packageVersion: packageResult?.manifest?.packageVersion ?? null,
        packageId: packageResult?.manifest?.packageId ?? null,
        fileCount: packageResult?.files?.length ?? 0,
        signatureStatus: packageResult?.manifest?.signatureStatus ?? null,
        fullAgRuntimeEntry: packageResult?.manifest?.safety?.fullAgRuntimeEntry === true
      }),
      packageFileListHash: sha256Json(packageResult?.manifest?.files ?? []),
      smokeReportHash: sha256Json({
        reportVersion: smokeReport?.reportVersion ?? null,
        status: smokeReport?.status ?? null,
        mode: smokeReport?.mode ?? null,
        serviceRuntimeVersion: smokeReport?.serviceRuntime?.runtimeVersion ?? null,
        taskStatus: smokeReport?.task?.status ?? null,
        executionVerification: smokeReport?.task?.executionVerification ?? null,
        learningStored: smokeReport?.task?.learningStored === true
      }),
      soakReportHash: sha256Json({
        reportVersion: soakReport?.reportVersion ?? null,
        status: soakReport?.status ?? null,
        taskCount: soakReport?.taskCount ?? 0,
        completedCount: soakReport?.completedCount ?? 0,
        verifiedCount: soakReport?.verifiedCount ?? 0,
        learnedCount: soakReport?.learnedCount ?? 0,
        tickEventCount: soakReport?.artifactSummary?.tickEventCount ?? 0,
        watchdogEventCount: soakReport?.artifactSummary?.watchdogEventCount ?? 0
      })
    },
    releaseRootHash: sha256Text(root),
    packageDirHash: sha256Text(packageDir),
    smokePathHash: sha256Text(smokePath),
    soakPathHash: sha256Text(soakPath),
    rawArtifactPathsStored: false,
    rawPackageScriptBodiesStored: false,
    rawAdminTokenStored: false,
    rawTaskPayloadStored: false,
    rawEventLogPayloadStored: false
  };
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-core-service-release-raw-leak-check-v1',
      rawLeakDetected: containsCoreServiceReleaseRawLeak(JSON.stringify(manifestCore)),
      checkedHashCount: Object.keys(manifestCore.releaseEvidenceHashes).length,
      checkedRawPayloadFlags: [
        'rawArtifactPathsStored',
        'rawPackageScriptBodiesStored',
        'rawAdminTokenStored',
        'rawTaskPayloadStored',
        'rawEventLogPayloadStored'
      ]
    }
  };
}

function createCoreServiceReleaseCiNightlyGatePlan({ artifactManifest }) {
  return {
    planVersion: 'a-core-service-release-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run core:service-release',
    requiredForPullRequests: true,
    requiredForNightly: true,
    requiredChecks: [
      'core_service_release_dossier_ready',
      'core_service_package_smoke_soak_ready',
      'core_service_release_artifact_manifest_ready',
      'core_service_installed_handoff_ready',
      'core_service_worm_promotion_package_ready',
      'core_service_administrator_runbook_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    retentionPolicy: {
      keepLatestPerBranch: 20,
      keepNightlyDays: 90,
      promotePassedReleaseDossierToWorm: true
    },
    rawArtifactPathsStored: false,
    rawAdminTokenStored: false,
    rawPackageScriptBodiesStored: false
  };
}

function createCoreServiceReleaseExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  releaseChecks
}) {
  const status = artifactManifest?.artifactManifestVersion === 'a-core-service-release-artifact-manifest-v1'
    && artifactManifest.rawLeakCheck?.rawLeakDetected === false
    && artifactManifest.installedServiceHandoffManifest?.healthHandshakeVersion === 'a-core-installed-service-health-handshake-v1'
    && artifactManifest.installedServiceHandoffManifest?.fallbackPolicy?.policyVersion === 'a-core-service-release-fallback-policy-v1'
    && ciNightlyGatePlan?.planVersion === 'a-core-service-release-ci-nightly-gate-plan-v1'
    && releaseChecks.every((check) => check.passed)
    ? 'ready'
    : 'blocked';
  return {
    packageVersion: 'a-core-service-release-worm-promotion-package-v1',
    providerContractVersion: 'a-core-service-release-worm-provider-contract-v1',
    status,
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    installedServiceHandoffHash: sha256Json(artifactManifest?.installedServiceHandoffManifest ?? null),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    releaseChecksHash: sha256Json(releaseChecks.map((check) => ({
      checkId: check.checkId,
      passed: check.passed
    }))),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawArtifactPathsStored: false,
    rawAdminTokenStored: false,
    rawPackageScriptBodiesStored: false,
    rawTaskPayloadStored: false,
    rawEventLogPayloadStored: false
  };
}

function renderMarkdown(report) {
  return [
    '# Core Service Release Dossier',
    '',
    `Report version: ${report.reportVersion}`,
    `Status: ${report.status}`,
    `Dossier: ${report.releaseDossier.dossierVersion}`,
    `Product gate: ${report.productGate.productGateVersion} / ${report.productGate.status}`,
    `Package: ${report.releaseDossier.package.packageVersion} (${report.releaseDossier.package.fileCount} files)`,
    `Smoke: ${report.releaseDossier.smoke.status}`,
    `Soak: ${report.releaseDossier.soak.completedCount}/${report.releaseDossier.soak.taskCount} completed`,
    `Administrator install required: ${report.releaseDossier.administratorInstallRequired}`,
    `Artifact manifest: ${report.releaseDossier.artifactManifest.artifactManifestVersion}`,
    `Installed service handoff: ${report.releaseDossier.artifactManifest.installedServiceHandoffManifest.manifestVersion} / ${report.releaseDossier.artifactManifest.installedServiceHandoffManifest.healthHandshakeVersion}`,
    `WORM promotion package: ${report.releaseDossier.externalWormPromotionPackage.packageVersion} (${report.releaseDossier.externalWormPromotionPackage.status})`,
    '',
    '## Release Checks',
    '',
    ...report.releaseDossier.releaseChecks.map((check) => `- ${check.checkId}: ${check.passed ? 'passed' : 'blocked'}`),
    '',
    '## Next',
    '',
    report.releaseDossier.recommendedReleaseAction
  ].join('\n');
}

function renderCsv(report) {
  const rows = [['kind', 'id', 'status', 'detail'].join(',')];
  rows.push(['report', report.reportVersion, report.status, report.releaseDossier.dossierSha256].map(csv).join(','));
  rows.push(['product_gate', report.productGate.productGateVersion, report.productGate.status, report.releaseDossier.dossierVersion].map(csv).join(','));
  for (const check of report.releaseDossier.releaseChecks) {
    rows.push(['release_check', check.checkId, check.passed ? 'passed' : 'blocked', report.releaseDossier.dossierVersion].map(csv).join(','));
  }
  for (const check of report.productGate.checks) {
    rows.push(['product_gate_check', check.checkId, check.passed ? 'passed' : 'blocked', report.productGate.productGateVersion].map(csv).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function csv(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256Json(value) {
  return sha256Text(canonicalJson(value ?? null));
}

function containsCoreServiceReleaseRawLeak(value) {
  const text = String(value ?? '');
  return /"releaseRoot"\s*:|"packageDir"\s*:|"smokePath"\s*:|"soakPath"\s*:|"adminToken"\s*:|"scriptBody"\s*:|JARVIS_CORE_ADMIN_TOKEN\s*=|Bearer\s+[A-Za-z0-9._~+/-]+=*|[A-Za-z]:\\\\Users\\\\/i.test(text);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runCoreServiceReleaseDossier({
    jsonPath: readFlag('--output') ?? readFlag('--report') ?? 'dist/core-service-release-dossier.json',
    markdownPath: readFlag('--markdown') ?? 'dist/core-service-release-dossier.md',
    csvPath: readFlag('--csv') ?? 'dist/core-service-release-dossier.csv',
    releaseRoot: readFlag('--release-root') ?? 'dist/core-service-release-lab',
    adminToken: readFlag('--admin-token') ?? 'local-core-service-release-admin',
    taskCount: Number(readFlag('--task-count') ?? 3),
    intervalMs: Number(readFlag('--interval-ms') ?? 20),
    drainLimit: Number(readFlag('--drain-limit') ?? 1),
    durationMs: Number(readFlag('--duration-ms') ?? 500)
  });
  console.log(`Core service release dossier: ${report.status}`);
  console.log(`Product gate: ${report.productGate.status}`);
  console.log(`Report: ${report.artifacts.jsonPath}`);
  if (report.productGate.status !== 'passed') process.exitCode = 1;
}
