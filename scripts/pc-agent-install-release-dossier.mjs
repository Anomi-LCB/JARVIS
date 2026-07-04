import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeInstallerPackage } from '../apps/pc-agent/src/install/installer-packager.js';
import { loadPcAgentInstallConfig } from '../apps/pc-agent/src/install/service-planner.js';
import { verifyPcAgentServiceReadiness } from '../apps/pc-agent/src/install/service-verifier.js';
import { runPcAgentDaemonSmoke } from './pc-agent-daemon-smoke.mjs';
import { runPcAgentQueueSoak } from './pc-agent-queue-soak.mjs';

function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashString(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function containsInstallReleaseRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"releaseRoot"\s*:|"packageDir"\s*:|"daemonSmokePath"\s*:|"packageManifestPath"\s*:|"releaseManifestPath"\s*:|"commands"\s*:|"script"\s*:|"fileContent"\s*:|"certificateThumbprint"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

export async function runPcAgentInstallReleaseDossier({
  jsonPath = 'dist/pc-agent-install-release-dossier.json',
  markdownPath = 'dist/pc-agent-install-release-dossier.md',
  csvPath = 'dist/pc-agent-install-release-dossier.csv',
  releaseRoot = 'dist/pc-agent-install-release-lab',
  packageDir = 'dist/pc-agent-installer',
  daemonSmokePath = 'dist/pc-agent-daemon-smoke-report.json',
  queueSoakPath = 'dist/pc-agent-queue-soak-report.json',
  queueSoakPacketCount = 12
} = {}) {
  const root = resolve(releaseRoot);
  const resolvedPackageDir = resolve(packageDir);
  const resolvedDaemonSmokePath = resolve(daemonSmokePath);
  await mkdir(root, { recursive: true });

  const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
  const packageResult = await writeInstallerPackage({
    daemonConfig,
    serviceManifest,
    cwd: process.cwd(),
    outputDir: resolvedPackageDir
  });
  const readiness = await verifyPcAgentServiceReadiness({
    daemonConfig,
    serviceManifest,
    cwd: process.cwd(),
    packageDir: resolvedPackageDir,
    osPlatform: 'win32',
    isAdministrator: true
  });
  const daemonSmoke = await runPcAgentDaemonSmoke({ reportPath: resolvedDaemonSmokePath });
  const queueSoak = await runPcAgentQueueSoak({
    reportPath: resolve(queueSoakPath),
    labRoot: join(root, 'queue-soak-lab'),
    packetCount: queueSoakPacketCount,
    batchLimit: Math.min(6, Math.max(1, queueSoakPacketCount))
  });
  const releaseManifest = JSON.parse(await readFile(join(resolvedPackageDir, 'release-manifest.json'), 'utf8'));
  const releaseDossier = createPcAgentInstallReleaseDossier({
    packageResult,
    readiness,
    daemonSmoke,
    queueSoak,
    releaseManifest,
    root,
    packageDir: resolvedPackageDir,
    daemonSmokePath: resolvedDaemonSmokePath,
    queueSoakPath: resolve(queueSoakPath)
  });
  const productGate = createPcAgentInstallReleaseProductGate({ releaseDossier });
  const report = {
    reportVersion: 'b-pc-agent-install-release-dossier-report-v1',
    generatedAt: new Date().toISOString(),
    status: productGate.status,
    releaseDossier,
    productGate,
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      csvPath: resolve(csvPath),
      releaseRoot: root,
      packageDir: resolvedPackageDir,
      daemonSmokePath: resolvedDaemonSmokePath,
      queueSoakPath: resolve(queueSoakPath)
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

export function createPcAgentInstallReleaseDossier({
  packageResult,
  readiness,
  daemonSmoke,
  queueSoak,
  releaseManifest,
  root,
  packageDir,
  daemonSmokePath,
  queueSoakPath
}) {
  const manifest = packageResult?.manifest ?? {};
  const files = manifest.files ?? [];
  const releaseChecks = [
    {
      checkId: 'pc_agent_installer_package_ready',
      passed: packageResult?.success === true
        && manifest.packageId === 'jarvis-pc-agent-windows-service'
        && files.includes('package-manifest.json')
        && files.includes('verify-package.ps1')
        && Object.keys(manifest.fileIntegrity ?? {}).length >= 27
        && manifest.signature?.digest?.length === 64,
      fileCount: files.length,
      integrityFileCount: Object.keys(manifest.fileIntegrity ?? {}).length
    },
    {
      checkId: 'pc_agent_service_readiness_ready',
      passed: readiness?.status === 'ready'
        && (readiness.checks ?? []).every((check) => check.status !== 'fail')
        && (readiness.checks ?? []).some((check) => check.id === 'package-manifest' && check.status === 'pass'),
      readinessStatus: readiness?.status ?? null
    },
    {
      checkId: 'pc_agent_user_process_daemon_smoke_passed',
      passed: daemonSmoke?.reportId === 'b-pc-agent-daemon-smoke-v1'
        && daemonSmoke.status === 'passed'
        && daemonSmoke.serviceInstalled === false
        && daemonSmoke.evidence?.productGate?.productGateVersion === 'b-execution-evidence-product-gate-v1'
        && daemonSmoke.evidence?.productGate?.status === 'passed',
      mode: daemonSmoke?.mode ?? null,
      serviceInstalled: daemonSmoke?.serviceInstalled ?? null
    },
    {
      checkId: 'pc_agent_queue_soak_passed',
      passed: queueSoak?.reportVersion === 'b-pc-agent-queue-soak-v1'
        && queueSoak.status === 'passed'
        && queueSoak.summary?.finalQueue?.queued === 0
        && queueSoak.summary?.finalQueue?.retryScheduled === 0
        && queueSoak.summary?.finalQueue?.quarantined === 0
        && queueSoak.summary?.restoredQueue?.succeeded === queueSoak.parameters?.packetCount
        && queueSoak.productGate?.status === 'passed'
        && queueSoak.summary?.rawFilePathStored === false
        && queueSoak.summary?.rawFileContentStored === false
        && queueSoak.summary?.rawCapabilityTokenStored === false,
      packetCount: queueSoak?.parameters?.packetCount ?? null,
      processed: queueSoak?.summary?.processed ?? null,
      finalQueue: queueSoak?.summary?.finalQueue ?? null
    },
    {
      checkId: 'pc_agent_tray_release_assets_ready',
      passed: files.includes('tray-agent.ps1')
        && files.includes('tray-agent.cs')
        && files.includes('launch-tray.ps1')
        && files.includes('build-tray-exe.ps1')
        && files.includes('install-tray-shortcut.ps1')
        && packageResult?.trayState?.appId === 'jarvis-pc-agent-tray',
      trayAppId: packageResult?.trayState?.appId ?? null
    },
    {
      checkId: 'pc_agent_release_runbook_ready',
      passed: files.includes('install-all.ps1')
        && files.includes('install-verify-release.ps1')
        && files.includes('verify-installed-service.ps1')
        && files.includes('verify-release-gate.ps1')
        && files.includes('build-release-evidence.ps1')
        && files.includes('README-install.md'),
      administratorRequired: true
    },
    {
      checkId: 'pc_agent_signing_and_installer_scripts_ready',
      passed: files.includes('sign-artifacts.ps1')
        && files.includes('verify-signatures.ps1')
        && files.includes('verify-production-signing.ps1')
        && files.includes('production-signing-policy.json')
        && files.includes('create-dev-signing-cert.ps1')
        && files.includes('installer.nsi')
        && files.includes('build-nsis-installer.ps1')
        && (releaseManifest?.signableArtifacts ?? []).includes('JARVIS-PC-Agent-Setup.exe'),
      signableArtifacts: releaseManifest?.signableArtifacts ?? []
    },
    {
      checkId: 'pc_agent_production_signing_policy_ready',
      passed: files.includes('production-signing-policy.json')
        && files.includes('verify-production-signing.ps1')
        && (releaseManifest?.requiredReleaseSteps ?? []).includes('verify-production-signing.ps1')
        && (releaseManifest?.reports ?? []).includes('production-signing-report.json'),
      externalDistributionRequired: true
    },
    {
      checkId: 'pc_agent_installed_service_runbook_ready',
      passed: manifest.safety?.executeRequiresAdminShell === true
        && files.includes('install-service.ps1')
        && files.includes('start-service.ps1')
        && files.includes('verify-installed-service.ps1')
        && files.includes('install-verify-release.ps1'),
      serviceInstalledInThisRun: false,
      administratorRequired: true
    }
  ];
  const artifactManifest = {
    manifestVersion: 'b-pc-agent-install-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    packageManifestHash: hashJson({
      packageId: manifest.packageId ?? null,
      serviceName: manifest.serviceName ?? null,
      fileCount: files.length,
      integrityFileCount: Object.keys(manifest.fileIntegrity ?? {}).length,
      signatureStatus: manifest.signatureStatus ?? null,
      signatureDigest: manifest.signature?.digest ?? null,
      localOnly: manifest.localOnly === true,
      bindsTo: manifest.safety?.bindsTo ?? null
    }),
    packageFileIntegrityHash: hashJson({
      files: Object.entries(manifest.fileIntegrity ?? {})
        .map(([fileName, integrity]) => ({
          fileName,
          sha256: integrity.sha256,
          size: integrity.size ?? null
        }))
        .sort((left, right) => left.fileName.localeCompare(right.fileName))
    }),
    serviceReadinessHash: hashJson({
      status: readiness?.status ?? null,
      failedChecks: (readiness?.checks ?? []).filter((check) => check.status === 'fail').map((check) => check.id).sort(),
      warningChecks: (readiness?.checks ?? []).filter((check) => check.status === 'warning').map((check) => check.id).sort(),
      passCount: (readiness?.checks ?? []).filter((check) => check.status === 'pass').length
    }),
    daemonSmokeHash: hashJson({
      reportId: daemonSmoke?.reportId ?? null,
      status: daemonSmoke?.status ?? null,
      mode: daemonSmoke?.mode ?? null,
      serviceInstalled: daemonSmoke?.serviceInstalled === true,
      evidenceProductGate: daemonSmoke?.evidence?.productGate?.status ?? null,
      passCount: (daemonSmoke?.checks ?? []).filter((check) => check.status === 'pass').length
    }),
    queueSoakHash: hashJson({
      reportVersion: queueSoak?.reportVersion ?? null,
      status: queueSoak?.status ?? null,
      mode: queueSoak?.mode ?? null,
      packetCount: queueSoak?.parameters?.packetCount ?? null,
      processed: queueSoak?.summary?.processed ?? null,
      finalQueue: queueSoak?.summary?.finalQueue ?? null,
      restoredQueue: queueSoak?.summary?.restoredQueue ?? null,
      productGateStatus: queueSoak?.productGate?.status ?? null,
      rawFilePathStored: queueSoak?.summary?.rawFilePathStored ?? null,
      rawFileContentStored: queueSoak?.summary?.rawFileContentStored ?? null,
      rawCapabilityTokenStored: queueSoak?.summary?.rawCapabilityTokenStored ?? null
    }),
    trayAssetsHash: hashJson({
      trayAppId: packageResult?.trayState?.appId ?? null,
      requiredFilesPresent: [
        'tray-agent.ps1',
        'tray-agent.cs',
        'launch-tray.ps1',
        'build-tray-exe.ps1',
        'install-tray-shortcut.ps1'
      ].every((fileName) => files.includes(fileName))
    }),
    signingInstallerHash: hashJson({
      signableArtifacts: releaseManifest?.signableArtifacts ?? [],
      signingScriptsPresent: ['sign-artifacts.ps1', 'verify-signatures.ps1', 'verify-production-signing.ps1', 'create-dev-signing-cert.ps1']
        .every((fileName) => files.includes(fileName)),
      productionSigningPolicyPresent: files.includes('production-signing-policy.json'),
      productionSigningReportListed: (releaseManifest?.reports ?? []).includes('production-signing-report.json'),
      nsisScriptsPresent: ['installer.nsi', 'build-nsis-installer.ps1']
        .every((fileName) => files.includes(fileName))
    }),
    runbookHash: hashJson({
      administratorRequired: true,
      installVerifyRelease: files.includes('install-verify-release.ps1'),
      verifyInstalledService: files.includes('verify-installed-service.ps1'),
      buildReleaseEvidence: files.includes('build-release-evidence.ps1')
    }),
    artifactPathHashes: {
      releaseRootHash: hashString(root),
      packageDirHash: hashString(packageDir),
      daemonSmokePathHash: hashString(daemonSmokePath),
      queueSoakPathHash: hashString(queueSoakPath),
      packageManifestPathHash: hashString(join(packageDir, 'package-manifest.json')),
      releaseManifestPathHash: hashString(join(packageDir, 'release-manifest.json'))
    },
    rawArtifactPathStored: false,
    rawServiceCommandStored: false,
    rawPackageFileContentStored: false,
    rawSigningCertificateStored: false
  };
  artifactManifest.rawLeakCheck = {
    checkVersion: 'b-pc-agent-install-release-raw-leak-check-v1',
    rawLeakDetected: containsInstallReleaseRawLeak(artifactManifest),
    checkedRawFields: [
      'rawArtifactPathStored',
      'rawServiceCommandStored',
      'rawPackageFileContentStored',
      'rawSigningCertificateStored'
    ]
  };
  const operationalHandoffManifest = {
    manifestVersion: 'b-pc-agent-install-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'b-pc-agent-install-health-handshake-v1',
    generatedAt: new Date().toISOString(),
    status: releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      ? 'ready'
      : 'blocked',
    healthHandshake: {
      installerPackageReady: releaseChecks.some((check) => check.checkId === 'pc_agent_installer_package_ready' && check.passed),
      serviceReadinessReady: releaseChecks.some((check) => check.checkId === 'pc_agent_service_readiness_ready' && check.passed),
      daemonSmokeReady: releaseChecks.some((check) => check.checkId === 'pc_agent_user_process_daemon_smoke_passed' && check.passed),
      queueSoakReady: releaseChecks.some((check) => check.checkId === 'pc_agent_queue_soak_passed' && check.passed),
      trayAssetsReady: releaseChecks.some((check) => check.checkId === 'pc_agent_tray_release_assets_ready' && check.passed),
      signingInstallerScriptsReady: releaseChecks.some((check) => check.checkId === 'pc_agent_signing_and_installer_scripts_ready' && check.passed),
      productionSigningPolicyReady: releaseChecks.some((check) => check.checkId === 'pc_agent_production_signing_policy_ready' && check.passed),
      administratorRunbookReady: releaseChecks.some((check) => check.checkId === 'pc_agent_installed_service_runbook_ready' && check.passed),
      serviceInstalledInThisRun: false
    },
    fallbackPolicy: {
      policyVersion: 'b-pc-agent-install-fallback-policy-v1',
      primaryFlow: 'administrator_install_verify_release_powershell_runbook',
      fallbackFlows: [
        'user_process_daemon_smoke_before_admin_install',
        'queue_soak_with_hash_only_evidence_after_adapter_changes',
        'package_manifest_integrity_verification_before_service_start',
        'trusted_code_signing_warning_blocks_production_release',
        'tray_shortcut_install_can_be_replayed_after_service_install'
      ],
      operatorEscalation: 'pc_agent_install_release_dossier_and_service_verification_report'
    },
    rawArtifactPathStored: false,
    rawServiceCommandStored: false,
    rawPackageFileContentStored: false,
    rawSigningCertificateStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'b-pc-agent-install-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "pc-agent installer package" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'pc_agent_install_release_dossier_ready',
      'pc_agent_package_readiness_daemon_smoke_ready',
      'pc_agent_queue_soak_ready',
      'pc_agent_tray_release_assets_ready',
      'pc_agent_production_signing_policy_ready',
      'pc_agent_installed_service_runbook_ready',
      'pc_agent_install_release_artifact_manifest_ready',
      'pc_agent_install_operational_handoff_ready',
      'pc_agent_install_worm_promotion_package_ready'
    ],
    artifactManifestHash: hashJson(artifactManifest),
    operationalHandoffHash: hashJson(operationalHandoffManifest),
    rawArtifactPathStored: false,
    rawServiceCommandStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'b-pc-agent-install-worm-promotion-package-v1',
    providerContractVersion: 'b-pc-agent-install-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'b-pc-agent-install-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'b-pc-agent-install-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: hashJson(artifactManifest),
    operationalHandoffHash: hashJson(operationalHandoffManifest),
    ciNightlyGatePlanHash: hashJson(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawArtifactPathStored: false,
    rawServiceCommandStored: false,
    rawSigningCertificateStored: false
  };
  const dossier = {
    dossierVersion: 'b-pc-agent-install-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    mode: 'user-process-install-release-lab-with-administrator-runbook',
    serviceInstalledInThisRun: false,
    administratorInstallRequired: true,
    package: {
      packageId: manifest.packageId ?? null,
      serviceName: manifest.serviceName ?? null,
      outputDir: packageResult?.outputDir ?? packageDir,
      fileCount: files.length,
      integrityFileCount: Object.keys(manifest.fileIntegrity ?? {}).length,
      signatureStatus: manifest.signatureStatus ?? null,
      signatureDigest: manifest.signature?.digest ?? null,
      localOnly: manifest.localOnly === true,
      bindsTo: manifest.safety?.bindsTo ?? null
    },
    readiness: {
      status: readiness?.status ?? null,
      serviceName: readiness?.serviceName ?? null,
      endpoint: readiness?.endpoint ?? null,
      failedChecks: (readiness?.checks ?? []).filter((check) => check.status === 'fail').map((check) => check.id),
      warningChecks: (readiness?.checks ?? []).filter((check) => check.status === 'warning').map((check) => check.id)
    },
    daemonSmoke: {
      reportId: daemonSmoke?.reportId ?? null,
      status: daemonSmoke?.status ?? null,
      mode: daemonSmoke?.mode ?? null,
      serviceInstalled: daemonSmoke?.serviceInstalled === true,
      failedChecks: (daemonSmoke?.checks ?? []).filter((check) => check.status === 'fail').map((check) => check.id),
      evidenceProductGate: daemonSmoke?.evidence?.productGate?.status ?? null
    },
    queueSoak: {
      reportVersion: queueSoak?.reportVersion ?? null,
      status: queueSoak?.status ?? null,
      mode: queueSoak?.mode ?? null,
      packetCount: queueSoak?.parameters?.packetCount ?? null,
      processed: queueSoak?.summary?.processed ?? null,
      failedChecks: (queueSoak?.checks ?? []).filter((check) => check.status === 'fail').map((check) => check.checkId),
      productGateStatus: queueSoak?.productGate?.status ?? null
    },
    tray: {
      appId: packageResult?.trayState?.appId ?? null,
      menuCount: packageResult?.trayState?.menu?.length ?? 0,
      notifications: packageResult?.trayState?.notifications?.length ?? 0
    },
    releaseManifest: {
      releaseId: releaseManifest?.releaseId ?? null,
      signableArtifacts: releaseManifest?.signableArtifacts ?? [],
      requiredReleaseSteps: releaseManifest?.requiredReleaseSteps ?? [],
      reports: releaseManifest?.reports ?? []
    },
    artifacts: {
      releaseRoot: root,
      packageDir,
      daemonSmokePath,
      queueSoakPath,
      packageManifestPath: join(packageDir, 'package-manifest.json'),
      releaseManifestPath: join(packageDir, 'release-manifest.json')
    },
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    releaseChecks,
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'run_install_verify_release_from_administrator_powershell_and_attach_service_smoke_signature_reports_and_worm_release_package'
      : 'block_pc_agent_install_release_until_package_readiness_daemon_smoke_and_runbook_pass'
  };
  dossier.dossierSha256 = hashJson(dossier);
  return dossier;
}

export function createPcAgentInstallReleaseProductGate({ releaseDossier }) {
  const checks = [
    {
      checkId: 'pc_agent_install_release_dossier_ready',
      passed: releaseDossier?.dossierVersion === 'b-pc-agent-install-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    },
    {
      checkId: 'pc_agent_package_readiness_daemon_smoke_ready',
      passed: releaseDossier?.releaseChecks?.filter((check) => [
        'pc_agent_installer_package_ready',
        'pc_agent_service_readiness_ready',
        'pc_agent_user_process_daemon_smoke_passed',
        'pc_agent_queue_soak_passed'
      ].includes(check.checkId)).every((check) => check.passed) === true
    },
    {
      checkId: 'pc_agent_queue_soak_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'pc_agent_queue_soak_passed' && check.passed) === true
        && releaseDossier?.queueSoak?.status === 'passed'
        && releaseDossier?.queueSoak?.processed === releaseDossier?.queueSoak?.packetCount
    },
    {
      checkId: 'pc_agent_tray_release_assets_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'pc_agent_tray_release_assets_ready' && check.passed) === true
    },
    {
      checkId: 'pc_agent_production_signing_policy_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'pc_agent_production_signing_policy_ready' && check.passed) === true
    },
    {
      checkId: 'pc_agent_installed_service_runbook_ready',
      passed: releaseDossier?.administratorInstallRequired === true
        && releaseDossier?.serviceInstalledInThisRun === false
        && releaseDossier?.releaseChecks?.some((check) => check.checkId === 'pc_agent_installed_service_runbook_ready' && check.passed) === true
    },
    {
      checkId: 'pc_agent_install_release_artifact_manifest_ready',
      passed: releaseDossier?.artifactManifest?.manifestVersion === 'b-pc-agent-install-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawArtifactPathStored === false
        && releaseDossier.artifactManifest?.rawServiceCommandStored === false
    },
    {
      checkId: 'pc_agent_install_operational_handoff_ready',
      passed: releaseDossier?.operationalHandoffManifest?.manifestVersion === 'b-pc-agent-install-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'b-pc-agent-install-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'b-pc-agent-install-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
    },
    {
      checkId: 'pc_agent_install_worm_promotion_package_ready',
      passed: releaseDossier?.externalWormPromotionPackage?.packageVersion === 'b-pc-agent-install-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-pc-agent-install-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-pc-agent-install-release-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier?.dossierVersion ?? null,
      status: releaseDossier?.status ?? null,
      dossierSha256: releaseDossier?.dossierSha256 ?? null
    }
  };
}

function renderMarkdown(report) {
  return [
    '# PC Agent Install Release Dossier',
    '',
    `Report version: ${report.reportVersion}`,
    `Status: ${report.status}`,
    `Dossier: ${report.releaseDossier.dossierVersion}`,
    `Product gate: ${report.productGate.productGateVersion} / ${report.productGate.status}`,
    `Package files: ${report.releaseDossier.package.fileCount}`,
    `Readiness: ${report.releaseDossier.readiness.status}`,
    `Daemon smoke: ${report.releaseDossier.daemonSmoke.status}`,
    `Queue soak: ${report.releaseDossier.queueSoak.status} / ${report.releaseDossier.queueSoak.processed}/${report.releaseDossier.queueSoak.packetCount}`,
    `Administrator install required: ${report.releaseDossier.administratorInstallRequired}`,
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
  const rows = [['domain', 'check_id', 'status', 'detail']]
    .concat(report.releaseDossier.releaseChecks.map((check) => [
      'release-dossier',
      check.checkId,
      check.passed ? 'passed' : 'blocked',
      report.releaseDossier.dossierVersion
    ]))
    .concat(report.productGate.checks.map((check) => [
      'product-gate',
      check.checkId,
      check.passed ? 'passed' : 'blocked',
      report.productGate.productGateVersion
    ]));
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.jsonPath = argv[++index];
    else if (arg === '--md') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
    else if (arg === '--release-root') args.releaseRoot = argv[++index];
    else if (arg === '--package-dir') args.packageDir = argv[++index];
    else if (arg === '--daemon-smoke') args.daemonSmokePath = argv[++index];
    else if (arg === '--queue-soak') args.queueSoakPath = argv[++index];
    else if (arg === '--queue-soak-packets') args.queueSoakPacketCount = Number(argv[++index]);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runPcAgentInstallReleaseDossier(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS B PC Agent Install Release Dossier');
  console.log(`Status: ${report.status}`);
  console.log(`Product gate: ${report.productGate.productGateVersion} / ${report.productGate.status}`);
  console.log(`Report: ${report.artifacts.jsonPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
