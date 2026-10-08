import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultJsonPath = 'dist/product-completion-ledger.json';
const defaultMarkdownPath = 'dist/product-completion-ledger.md';

function workspacePath(workspaceRoot, path) {
  return resolve(workspaceRoot, path);
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path) {
  try {
    return decodeFileBuffer(await readFile(path));
  } catch {
    return '';
  }
}

async function readJson(path) {
  try {
    return JSON.parse((await readText(path)).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function decodeFileBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  const utf8 = buffer.toString('utf8');
  if (utf8.includes('\u0000')) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return utf8.replace(/^\uFEFF/, '');
}

async function readFirstJson(workspaceRoot, candidates) {
  for (const path of candidates) {
    const absolutePath = workspacePath(workspaceRoot, path);
    const data = await readJson(absolutePath);
    if (data) return { path, data, exists: true };
  }
  return { path: candidates[0], data: null, exists: false };
}

function statusIsPassed(status) {
  return ['pass', 'passed', 'passed-with-warnings'].includes(status);
}

function statusIsSynced(status) {
  return ['synced', 'already-synced'].includes(status);
}

export function mobileDeviceEvidencePassed(report = {}) {
  if (report.actualDeviceVerified !== true) return false;
  if (report.status === 'passed') return true;
  if (report.status !== 'passed-retained-evidence') return false;
  return report.evidenceSource === 'retained-last-passed'
    && report.retainedEvidence?.status === 'valid'
    && report.retainedEvidence?.fingerprintMatches === true
    && report.retainedEvidence?.screenshotIntegrity?.passed === true;
}

function check(checkId, passed, detail = {}, severity = 'blocking') {
  return {
    checkId,
    passed: Boolean(passed),
    severity,
    detail
  };
}

function reportEvidence(label, ref, status = ref?.data?.status ?? ref?.data?.packageId ?? (ref?.exists ? 'present' : 'missing')) {
  return {
    label,
    path: ref?.path ?? null,
    present: Boolean(ref?.exists),
    status
  };
}

function warningCount(report) {
  const explicit = Number(report?.warningCount ?? 0);
  const checkWarnings = Array.isArray(report?.checks)
    ? report.checks.filter((item) => item.status === 'warning').length
    : 0;
  return Math.max(explicit, checkWarnings);
}

function makeDomain({ domainId, title, docs, checks, evidence, nextActions = [], warningActions = [], excellenceActions = [] }) {
  const blockingChecks = checks.filter((item) => item.severity !== 'warning');
  const failedBlocking = blockingChecks.filter((item) => !item.passed);
  const failedWarnings = checks.filter((item) => item.severity === 'warning' && !item.passed);
  const reportWarnings = checks.filter((item) => item.passed && Number(item.detail?.warningCount ?? 0) > 0);
  const status = failedBlocking.length > 0
    ? 'blocked'
    : failedWarnings.length > 0 || reportWarnings.length > 0
      ? 'ready-with-warnings'
      : 'ready';
  const score = scoreDomain({ status, blockingChecks, failedWarnings, reportWarnings });
  return {
    domainId,
    title,
    docs,
    status,
    score,
    checks,
    evidence,
    blockingFailures: failedBlocking.map((item) => item.checkId),
    warnings: [...failedWarnings, ...reportWarnings].map((item) => item.checkId),
    nextActions: status === 'blocked' ? nextActions : [],
    warningActions: status === 'ready-with-warnings' ? warningActions : [],
    excellenceActions
  };
}

function scoreDomain({ status, blockingChecks, failedWarnings, reportWarnings }) {
  if (status === 'ready') return 100;
  const blockingTotal = Math.max(blockingChecks.length, 1);
  const blockingPassed = blockingChecks.filter((item) => item.passed).length;
  if (status === 'ready-with-warnings') {
    return Math.max(90, 100 - ((failedWarnings.length + reportWarnings.length) * 3));
  }
  return Math.round((blockingPassed / blockingTotal) * 80);
}

function buildOverall(domains) {
  const blocked = domains.filter((item) => item.status === 'blocked');
  const warning = domains.filter((item) => item.status === 'ready-with-warnings');
  const score = Math.round(domains.reduce((sum, item) => sum + item.score, 0) / Math.max(domains.length, 1));
  return {
    status: blocked.length > 0 ? 'blocked' : warning.length > 0 ? 'ready-with-warnings' : 'ready',
    score,
    domainCount: domains.length,
    blockedDomainCount: blocked.length,
    warningDomainCount: warning.length,
    blockingItems: blocked.flatMap((domain) => domain.blockingFailures.map((checkId) => ({
      domainId: domain.domainId,
      checkId
    })))
  };
}

function findValidation(handoff, id) {
  return (handoff?.externalValidation ?? []).find((item) => item.id === id);
}

function findLane(gateOrHandoff, laneId) {
  return (gateOrHandoff?.lanes ?? []).find((item) => item.laneId === laneId);
}

function findReportCheck(report, id) {
  return (report?.checks ?? []).find((item) => item.id === id || item.checkId === id);
}

function serviceHostHasRecoveryGuard(text) {
  return text.includes('child.Exited +=') && text.includes('Environment.Exit(exitCode)');
}

export async function runProductCompletionLedger({
  workspaceRoot = process.cwd(),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath)
} = {}) {
  const [
    productGate,
    handoff,
    preflight,
    finalGate,
    signoff,
    fieldKit,
    wormManifest,
    wormProof,
    wormTarget,
    mobileDevice,
    mobileLiveBridge,
    wearableHud,
    wearablePhysicalField,
    wearableChaos,
    securityRedteam,
    growthQuality,
    verificationDashboard,
    ciAnnotations,
    corePackage,
    coreVerification,
    coreSmoke,
    coreSoak,
    pcPackage,
    pcInstallRelease,
    pcReleaseGate,
    pcServiceSmoke,
    pcQueueSoak,
    pcSignature,
    pcProductionSigning,
    pcTrayState
  ] = await Promise.all([
    readFirstJson(workspaceRoot, ['dist/ag-product-readiness-gate.json']),
    readFirstJson(workspaceRoot, ['dist/ag-operator-handoff.json']),
    readFirstJson(workspaceRoot, ['dist/operator-preflight-report.json']),
    readFirstJson(workspaceRoot, ['dist/final-release-gate.json']),
    readFirstJson(workspaceRoot, ['dist/final-signoff-kit-report.json']),
    readFirstJson(workspaceRoot, ['dist/field-validation-kit-report.json']),
    readFirstJson(workspaceRoot, ['dist/worm-promotion/manifest.json']),
    readFirstJson(workspaceRoot, ['dist/worm-promotion/external-sync-proof.json']),
    readFirstJson(workspaceRoot, ['dist/worm-target-report.json']),
    readFirstJson(workspaceRoot, ['dist/mobile-device-smoke-report.json']),
    readFirstJson(workspaceRoot, ['dist/mobile-live-bridge-e2e-report.json']),
    readFirstJson(workspaceRoot, ['dist/wearable-hud-verification-report.json']),
    readFirstJson(workspaceRoot, ['dist/wearable-physical-field-gate.json']),
    readFirstJson(workspaceRoot, ['dist/wearable-field-chaos-report.json']),
    readFirstJson(workspaceRoot, ['dist/security-redteam-corpus-report.json']),
    readFirstJson(workspaceRoot, ['dist/growth-quality-corpus-report.json']),
    readFirstJson(workspaceRoot, ['dist/verification-dashboard-dossier.json']),
    readFirstJson(workspaceRoot, ['dist/ci-verification-annotations.json']),
    readFirstJson(workspaceRoot, ['dist/core-service-package/package-manifest.json', 'dist/field-validation/core/package-manifest.json']),
    readFirstJson(workspaceRoot, ['dist/core-service-package/installed-service-verification.json', 'dist/field-validation/core/installed-service-verification.json']),
    readFirstJson(workspaceRoot, ['dist/core-service-package/installed-service-smoke.json', 'dist/field-validation/core/installed-service-smoke.json']),
    readFirstJson(workspaceRoot, ['dist/core-service-package/installed-service-soak.json', 'dist/field-validation/core/installed-service-soak.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/package-manifest.json', 'dist/field-validation/pc-agent/package-manifest.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/install-release-report.json', 'dist/field-validation/pc-agent/install-release-report.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/release-gate-report.json', 'dist/field-validation/pc-agent/release-gate-report.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/service-smoke-report.json', 'dist/field-validation/pc-agent/service-smoke-report.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/queue-soak-report.json', 'dist/pc-agent-queue-soak-report.json', 'dist/field-validation/pc-agent/queue-soak-report.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/signature-verification-report.json', 'dist/field-validation/pc-agent/signature-verification-report.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/production-signing-report.json', 'dist/field-validation/pc-agent/production-signing-report.json']),
    readFirstJson(workspaceRoot, ['dist/pc-agent-installer/tray-state.json', 'dist/field-validation/pc-agent/tray-state.json'])
  ]);

  const [coreServiceHost, pcServiceHost] = await Promise.all([
    readText(workspacePath(workspaceRoot, 'dist/core-service-package/service-host.cs')),
    readText(workspacePath(workspaceRoot, 'dist/pc-agent-installer/service-host.cs'))
  ]);

  const coreValidation = findValidation(handoff.data, 'windows-core-service-admin-install');
  const pcValidation = findValidation(handoff.data, 'windows-pc-agent-admin-install');
  const mobileDeviceValidation = findValidation(handoff.data, 'mobile-physical-device-smoke');
  const mobileBridgeValidation = findValidation(handoff.data, 'mobile-live-bridge-e2e');
  const wormValidation = findValidation(handoff.data, 'ci-worm-promotion');
  const pcSignatureArtifactsCheck = findReportCheck(pcReleaseGate.data, 'signature-artifacts-signed');
  const pcTrustedSigningCheck = findReportCheck(pcReleaseGate.data, 'trusted-code-signing');
  const windowsLane = findLane(productGate.data, 'windows-service-lane');
  const mobileLane = findLane(productGate.data, 'mobile-device-lane');
  const growthLane = findLane(productGate.data, 'growth-quality-lane');
  const securityLane = findLane(productGate.data, 'security-redteam-lane');
  const verificationLane = findLane(productGate.data, 'verification-dashboard-lane');

  const rawSecretClean = preflight.data?.generatedArtifacts?.rawAdminTokenStored === false
    && preflight.data?.generatedArtifacts?.rawWormCredentialStored === false
    && preflight.data?.generatedArtifacts?.rawExternalCommandStored === false
    && signoff.data?.generatedArtifacts?.rawAdminTokenStored === false
    && signoff.data?.generatedArtifacts?.rawWormCredentialStored === false
    && signoff.data?.generatedArtifacts?.rawExternalCommandStored === false
    && wormProof.data?.rawCredentialsStored === false
    && wormProof.data?.rawCommandStored === false;

  const domains = [
    makeDomain({
      domainId: 'a-core-runtime',
      title: 'A Core runtime and Windows service',
      docs: ['A'],
      checks: [
        check('core_package_manifest_present', corePackage.exists, { path: corePackage.path }),
        check('core_service_host_recovery_guard_ready', serviceHostHasRecoveryGuard(coreServiceHost), { path: 'dist/core-service-package/service-host.cs' }),
        check('core_installed_service_verified', coreVerification.data?.status === 'passed', { status: coreVerification.data?.status ?? 'missing', warningCount: warningCount(coreVerification.data) }),
        check('core_installed_service_smoke_passed', coreSmoke.data?.status === 'passed', { status: coreSmoke.data?.status ?? 'missing', warningCount: warningCount(coreSmoke.data) }),
        check('core_installed_service_soak_passed', coreSoak.data?.status === 'passed', { status: coreSoak.data?.status ?? 'missing' }),
        check('core_field_validation_verified', fieldKit.data?.coreAdminEvidence?.status === 'verified' && coreValidation?.status === 'verified', {
          fieldKitStatus: fieldKit.data?.coreAdminEvidence?.status ?? 'missing',
          handoffStatus: coreValidation?.status ?? 'missing'
        }),
        check('core_admin_diagnostics_token_configured', warningCount(coreVerification.data) === 0 && warningCount(coreSmoke.data) === 0, {
          verificationWarnings: warningCount(coreVerification.data),
          smokeWarnings: warningCount(coreSmoke.data)
        }, 'warning')
      ],
      evidence: [
        reportEvidence('Core package manifest', corePackage),
        reportEvidence('Installed service verification', coreVerification),
        reportEvidence('Installed service smoke', coreSmoke),
        reportEvidence('Installed service soak', coreSoak),
        reportEvidence('Field validation kit', fieldKit)
      ],
      nextActions: [
        'Run the administrator field validation script again, then refresh ops:field-kit, ag:handoff, and ops:final-gate.',
        'Regenerate the Core service package if service-host.cs is missing the child exit recovery guard.'
      ],
      warningActions: [
        'Configure or pass the Core admin diagnostics token, rerun installed verification/smoke, then refresh ops:completion-ledger.'
      ],
      excellenceActions: [
        'Rotate and verify the hashed Core admin diagnostics token during each production reinstall.',
        'Keep recovery restart smoke evidence after future service host edits.'
      ]
    }),
    makeDomain({
      domainId: 'b-pc-agent',
      title: 'B PC Agent service, packet execution, and tray',
      docs: ['B'],
      checks: [
        check('pc_package_manifest_present', pcPackage.exists, { path: pcPackage.path }),
        check('pc_service_host_recovery_guard_ready', serviceHostHasRecoveryGuard(pcServiceHost), { path: 'dist/pc-agent-installer/service-host.cs' }),
        check('pc_install_release_passed', pcInstallRelease.data?.status === 'passed', { status: pcInstallRelease.data?.status ?? 'missing' }),
        check('pc_release_gate_passed', statusIsPassed(pcReleaseGate.data?.status), { status: pcReleaseGate.data?.status ?? 'missing' }),
        check('pc_installed_service_smoke_passed', pcServiceSmoke.data?.status === 'passed', { status: pcServiceSmoke.data?.status ?? 'missing' }),
        check('pc_queue_soak_passed', pcQueueSoak.data?.status === 'passed'
          && pcQueueSoak.data?.productGate?.status === 'passed'
          && pcQueueSoak.data?.summary?.finalQueue?.queued === 0
          && pcQueueSoak.data?.summary?.finalQueue?.retryScheduled === 0
          && pcQueueSoak.data?.summary?.finalQueue?.quarantined === 0
          && pcQueueSoak.data?.summary?.rawFilePathStored === false
          && pcQueueSoak.data?.summary?.rawFileContentStored === false
          && pcQueueSoak.data?.summary?.rawCapabilityTokenStored === false, {
          status: pcQueueSoak.data?.status ?? 'missing',
          packetCount: pcQueueSoak.data?.parameters?.packetCount ?? null,
          processed: pcQueueSoak.data?.summary?.processed ?? null,
          finalQueue: pcQueueSoak.data?.summary?.finalQueue ?? null
        }),
        check('pc_signature_artifacts_signed', statusIsPassed(pcSignature.data?.status)
          || pcSignatureArtifactsCheck?.status === 'pass'
          || (pcSignature.exists && Array.isArray(pcSignature.data?.results) && pcSignature.data.results.length > 0 && statusIsPassed(pcReleaseGate.data?.status)), {
          signatureReportStatus: pcSignature.data?.status ?? null,
          signatureResultCount: pcSignature.data?.results?.length ?? null,
          releaseGateSignatureStatus: pcSignatureArtifactsCheck?.status ?? null
        }),
        check('pc_trusted_code_signing_clean', pcTrustedSigningCheck?.status !== 'warning', {
          trustedCodeSigningStatus: pcTrustedSigningCheck?.status ?? 'not-reported',
          production: pcReleaseGate.data?.production ?? null
        }, 'warning'),
        check('pc_production_signing_policy_report_clean', ['not-required-local', 'passed', 'passed-with-warnings'].includes(pcProductionSigning.data?.status)
          && pcProductionSigning.data?.rawCertificateThumbprintStored === false
          && pcProductionSigning.data?.rawPrivateKeyMaterialStored === false, {
          status: pcProductionSigning.data?.status ?? 'missing',
          production: pcProductionSigning.data?.production ?? null,
          rawCertificateThumbprintStored: pcProductionSigning.data?.rawCertificateThumbprintStored ?? null,
          rawPrivateKeyMaterialStored: pcProductionSigning.data?.rawPrivateKeyMaterialStored ?? null
        }),
        check('pc_tray_state_present', pcTrayState.exists, { status: pcTrayState.data?.status ?? 'present' }),
        check('pc_field_validation_verified', fieldKit.data?.pcAgentAdminEvidence?.status === 'verified' && pcValidation?.status === 'verified', {
          fieldKitStatus: fieldKit.data?.pcAgentAdminEvidence?.status ?? 'missing',
          handoffStatus: pcValidation?.status ?? 'missing'
        })
      ],
      evidence: [
        reportEvidence('PC Agent package manifest', pcPackage),
        reportEvidence('Install release report', pcInstallRelease),
        reportEvidence('Release gate report', pcReleaseGate),
        reportEvidence('Installed service smoke', pcServiceSmoke),
        reportEvidence('Queue soak report', pcQueueSoak),
        reportEvidence('Production signing report', pcProductionSigning),
        reportEvidence('Tray state', pcTrayState)
      ],
      nextActions: [
        'Run dist/pc-agent-installer/install-verify-release.ps1 in Administrator PowerShell and refresh the field kit.',
        'Regenerate the PC Agent installer package if service-host.cs is missing recovery restart handling.'
      ],
      excellenceActions: [
        'Replace the local development signing trust with a production code-signing certificate before external distribution.',
        'Keep queue soak evidence refreshed on the operator PC after every adapter expansion.',
        'Promote signed release evidence to external WORM storage after installer changes.'
      ]
    }),
    makeDomain({
      domainId: 'c-d-mobile-bridge',
      title: 'C/D Mobile app and live bridge',
      docs: ['C', 'D'],
      checks: [
        check('mobile_lane_evidence_present', mobileLane?.status === 'evidence-present' && mobileLane?.missingArtifactCount === 0, {
          status: mobileLane?.status ?? 'missing',
          missingArtifactCount: mobileLane?.missingArtifactCount ?? null
        }),
        check('mobile_device_smoke_passed', mobileDeviceEvidencePassed(mobileDevice.data), {
          status: mobileDevice.data?.status ?? 'missing',
          actualDeviceVerified: mobileDevice.data?.actualDeviceVerified ?? null,
          evidenceSource: mobileDevice.data?.evidenceSource ?? null,
          retainedEvidenceStatus: mobileDevice.data?.retainedEvidence?.status ?? null,
          fingerprintMatches: mobileDevice.data?.retainedEvidence?.fingerprintMatches ?? null,
          screenshotIntegrityPassed: mobileDevice.data?.retainedEvidence?.screenshotIntegrity?.passed ?? null
        }),
        check('mobile_route_navigation_verified', (mobileDevice.data?.devices ?? []).every((device) => device.verified === true), {
          deviceCount: mobileDevice.data?.devices?.length ?? 0
        }),
        check('mobile_live_bridge_e2e_passed', mobileLiveBridge.data?.status === 'passed' && mobileLiveBridge.data?.liveBridgeVerified === true, {
          status: mobileLiveBridge.data?.status ?? 'missing',
          liveBridgeVerified: mobileLiveBridge.data?.liveBridgeVerified ?? null
        }),
        check('mobile_secure_store_and_revoke_verified', mobileLiveBridge.data?.secureStoreRestoreVerified === true
          && mobileLiveBridge.data?.deviceRevokeVerified === true
          && mobileLiveBridge.data?.secureStoreCleanupVerified === true, {
          secureStoreRestoreVerified: mobileLiveBridge.data?.secureStoreRestoreVerified ?? null,
          deviceRevokeVerified: mobileLiveBridge.data?.deviceRevokeVerified ?? null,
          secureStoreCleanupVerified: mobileLiveBridge.data?.secureStoreCleanupVerified ?? null
        }),
        check('wearable_hud_adapter_verified', wearableHud.data?.status === 'passed'
          && wearableHud.data?.productGate?.status === 'passed'
          && wearableHud.data?.summary?.displayPalette === 'monochrome-green'
          && wearableHud.data?.summary?.highRiskDirectApproveEnabled === false
          && wearableHud.data?.summary?.pcHandoffEnabled === true
          && wearableHud.data?.summary?.rawTranscriptStored === false
          && wearableHud.data?.summary?.rawBridgeTokenStored === false
          && wearableHud.data?.fieldKit?.status === 'passed', {
          status: wearableHud.data?.status ?? 'missing',
          productGateStatus: wearableHud.data?.productGate?.status ?? null,
          fieldKitStatus: wearableHud.data?.fieldKit?.status ?? null,
          displayPalette: wearableHud.data?.summary?.displayPalette ?? null,
          highRiskDirectApproveEnabled: wearableHud.data?.summary?.highRiskDirectApproveEnabled ?? null,
          pcHandoffEnabled: wearableHud.data?.summary?.pcHandoffEnabled ?? null
        }),
        check('wearable_voice_and_failure_chaos_verified', wearableChaos.data?.status === 'passed'
          && wearableChaos.data?.checks?.every((item) => item.status === 'passed')
          && wearableChaos.data?.summary?.voice2RecoveryPassed === true
          && wearableChaos.data?.summary?.rawTranscriptStored === false
          && wearableChaos.data?.rawLeakCheck?.rawLeakDetected === false, {
          status: wearableChaos.data?.status ?? 'missing',
          passed: wearableChaos.data?.summary?.passed ?? null,
          checks: wearableChaos.data?.summary?.checks ?? null,
          voice2RecoveryPassed: wearableChaos.data?.summary?.voice2RecoveryPassed ?? null,
          rawLeakDetected: wearableChaos.data?.rawLeakCheck?.rawLeakDetected ?? null
        }),
        check('wearable_physical_field_verified', wearablePhysicalField.data?.status === 'passed'
          && wearablePhysicalField.data?.physicalValidationPassed === true
          && wearablePhysicalField.data?.integrity?.passed === true
          && wearablePhysicalField.data?.evaluation?.status === 'passed', {
          status: wearablePhysicalField.data?.status ?? 'missing',
          physicalValidationPassed: wearablePhysicalField.data?.physicalValidationPassed ?? false,
          evidenceState: wearablePhysicalField.data?.evidence?.state ?? 'missing',
          integrityState: wearablePhysicalField.data?.integrity?.state ?? 'missing'
        }),
        check('mobile_external_validation_verified', mobileDeviceValidation?.status === 'verified' && mobileBridgeValidation?.status === 'verified', {
          mobileDeviceStatus: mobileDeviceValidation?.status ?? 'missing',
          liveBridgeStatus: mobileBridgeValidation?.status ?? 'missing'
        })
      ],
      evidence: [
        reportEvidence('Mobile device smoke', mobileDevice),
        reportEvidence('Mobile live bridge E2E', mobileLiveBridge),
        reportEvidence('Wearable HUD adapter', wearableHud),
        reportEvidence('Wearable physical field gate', wearablePhysicalField),
        reportEvidence('Wearable field chaos', wearableChaos),
        reportEvidence('Operator handoff', handoff)
      ],
      nextActions: [
        'Run npm run mobile:device and npm run mobile:live-bridge-e2e with a ready Android device or emulator.',
        'Open field-calibration.html on the target glasses, complete every measurement and scenario, then run npm run wearable:physical-gate.',
        'Refresh ag:handoff and ops:final-gate after mobile evidence is regenerated.'
      ],
      excellenceActions: [
        'Repeat the same smoke on a physical Android device, not only an emulator, before wider daily use.',
        'Repeat the wearable field lab after display firmware, microphone, browser, network, or thermal behavior changes.',
        'Add an iOS build/submission dry run when the Apple toolchain is available.'
      ]
    }),
    makeDomain({
      domainId: 'e-security-approval',
      title: 'E Permission, approval, and security controls',
      docs: ['E'],
      checks: [
        check('security_lane_evidence_present', securityLane?.status === 'evidence-present' && securityLane?.missingArtifactCount === 0, {
          status: securityLane?.status ?? 'missing',
          missingArtifactCount: securityLane?.missingArtifactCount ?? null
        }),
        check('security_redteam_corpus_passed', securityRedteam.data?.status === 'passed', { status: securityRedteam.data?.status ?? 'missing' }),
        check('field_validation_admin_evidence_verified', fieldKit.data?.status === 'field-evidence-verified', {
          status: fieldKit.data?.status ?? 'missing'
        }),
        check('no_raw_operator_secret_or_command_stored', rawSecretClean, {
          preflightRawAdminTokenStored: preflight.data?.generatedArtifacts?.rawAdminTokenStored ?? null,
          signoffRawAdminTokenStored: signoff.data?.generatedArtifacts?.rawAdminTokenStored ?? null,
          wormRawCredentialsStored: wormProof.data?.rawCredentialsStored ?? null,
          wormRawCommandStored: wormProof.data?.rawCommandStored ?? null
        })
      ],
      evidence: [
        reportEvidence('Security redteam corpus', securityRedteam),
        reportEvidence('Field validation kit', fieldKit),
        reportEvidence('Operator preflight', preflight),
        reportEvidence('Final signoff kit', signoff)
      ],
      nextActions: [
        'Run npm run security:redteam, ops:field-kit, ops:preflight, and ops:final-gate again after any security policy edit.',
        'Inspect generatedArtifacts in preflight/signoff if any raw secret storage check fails.'
      ],
      excellenceActions: [
        'Connect production reviewer identity and immutable audit storage before multi-user operation.',
        'Keep redteam miss cases as permanent fixtures instead of one-off manual notes.'
      ]
    }),
    makeDomain({
      domainId: 'f-growth-memory',
      title: 'F Growth memory and learning quality',
      docs: ['F'],
      checks: [
        check('growth_lane_evidence_present', growthLane?.status === 'evidence-present' && growthLane?.missingArtifactCount === 0, {
          status: growthLane?.status ?? 'missing',
          missingArtifactCount: growthLane?.missingArtifactCount ?? null,
          primaryGap: growthLane?.primaryGap?.id ?? null
        }),
        check('growth_quality_corpus_passed', growthQuality.data?.status === 'passed', { status: growthQuality.data?.status ?? 'missing' }),
        check('verification_learning_checks_available', verificationDashboard.data?.status === 'passed', { status: verificationDashboard.data?.status ?? 'missing' })
      ],
      evidence: [
        reportEvidence('Growth quality corpus', growthQuality),
        reportEvidence('Verification dashboard dossier', verificationDashboard),
        reportEvidence('Product readiness gate', productGate)
      ],
      nextActions: [
        'Run npm run growth:quality and npm run verification:dashboard after memory schema or policy changes.',
        'Refresh ag:product-gate when new learning requirements are added.'
      ],
      excellenceActions: [
        'Accumulate a real anonymized long-run MemoryEvent corpus, then lock it in WORM release evidence.',
        'Track failed recommendations as first-class learning fixtures.'
      ]
    }),
    makeDomain({
      domainId: 'g-verification-release',
      title: 'G Verification, simulation, and release evidence',
      docs: ['G'],
      checks: [
        check('verification_lane_evidence_present', verificationLane?.status === 'evidence-present' && verificationLane?.missingArtifactCount === 0, {
          status: verificationLane?.status ?? 'missing',
          missingArtifactCount: verificationLane?.missingArtifactCount ?? null
        }),
        check('verification_dashboard_dossier_passed', verificationDashboard.data?.status === 'passed', { status: verificationDashboard.data?.status ?? 'missing' }),
        check('product_gate_passed', productGate.data?.status === 'passed' && (productGate.data?.nextExecutionQueue?.length ?? 1) === 0, {
          status: productGate.data?.status ?? 'missing',
          strictScore: productGate.data?.overall?.strictScore ?? null,
          productReadinessScore: productGate.data?.overall?.productReadinessScore ?? null,
          nextExecutionQueueLength: productGate.data?.nextExecutionQueue?.length ?? null
        }),
        check('operator_handoff_no_pending_external_validation', handoff.data?.summary?.externalValidationPending === 0, {
          externalValidationPending: handoff.data?.summary?.externalValidationPending ?? null
        }),
        check('final_release_gate_passed', finalGate.data?.status === 'passed' && finalGate.data?.summary?.blockingCheckCount === 0, {
          status: finalGate.data?.status ?? 'missing',
          blockingCheckCount: finalGate.data?.summary?.blockingCheckCount ?? null
        }),
        check('final_signoff_ready', signoff.data?.status === 'ready-for-final-signoff', { status: signoff.data?.status ?? 'missing' })
      ],
      evidence: [
        reportEvidence('Verification dashboard dossier', verificationDashboard),
        reportEvidence('Product readiness gate', productGate),
        reportEvidence('Operator handoff', handoff),
        reportEvidence('Final release gate', finalGate),
        reportEvidence('Final signoff kit', signoff),
        reportEvidence('CI verification annotations', ciAnnotations)
      ],
      nextActions: [
        'Run npm run verification:dashboard, npm run ag:product-gate, npm run ag:handoff, and npm run ops:final-gate.',
        'Resolve every final-release-gate blocking item before treating the build as releasable.'
      ],
      excellenceActions: [
        'Run the final signoff command after every meaningful release package change.',
        'Keep CI verification annotations enabled as pull-request checks and GitHub step summaries.'
      ]
    }),
    makeDomain({
      domainId: 'release-worm-audit',
      title: 'Release packaging and WORM audit retention',
      docs: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      checks: [
        check('worm_manifest_ready', wormManifest.data?.status === 'ready-for-external-worm-promotion', {
          status: wormManifest.data?.status ?? 'missing',
          artifactCount: wormManifest.data?.artifactCount ?? null
        }),
        check('external_worm_sync_verified', statusIsSynced(wormProof.data?.status) && wormValidation?.status === 'verified', {
          proofStatus: wormProof.data?.status ?? 'missing',
          handoffStatus: wormValidation?.status ?? 'missing',
          provider: wormProof.data?.provider ?? null
        }),
        check('worm_target_ready', ['ready-for-worm-sync', 'synced', 'already-synced'].includes(wormTarget.data?.status), {
          status: wormTarget.data?.status ?? 'missing'
        }),
        check('worm_bundle_hash_consistent', Boolean(wormManifest.data?.bundleHash)
          && wormManifest.data?.bundleHash === wormProof.data?.bundleHash, {
          manifestHash: wormManifest.data?.bundleHash ?? null,
          proofHash: wormProof.data?.bundleHash ?? null
        }),
        check('worm_sync_no_raw_secret_or_command', wormProof.data?.rawCredentialsStored === false && wormProof.data?.rawCommandStored === false, {
          rawCredentialsStored: wormProof.data?.rawCredentialsStored ?? null,
          rawCommandStored: wormProof.data?.rawCommandStored ?? null
        })
      ],
      evidence: [
        reportEvidence('WORM promotion manifest', wormManifest),
        reportEvidence('External WORM sync proof', wormProof),
        reportEvidence('WORM target report', wormTarget)
      ],
      nextActions: [
        'Run npm run ops:worm-promotion, npm run ops:worm-target, and npm run ops:worm-sync.',
        'Use an append-only/object-lock target and rerun ops:preflight and ops:final-gate.'
      ],
      excellenceActions: [
        'Move from local append-only staging to managed object-lock storage before team or production usage.',
        'Retain the final manifest hash in release notes and CI artifacts.'
      ]
    })
  ];

  const overall = buildOverall(domains);
  const report = {
    reportVersion: 'jarvis-product-completion-ledger-v1',
    generatedAt: new Date().toISOString(),
    status: overall.status,
    score: overall.score,
    summary: {
      ...overall,
      strictScore: productGate.data?.overall?.strictScore ?? finalGate.data?.summary?.strictScore ?? null,
      productReadinessScore: productGate.data?.overall?.productReadinessScore ?? finalGate.data?.summary?.productReadinessScore ?? null,
      finalReleaseGateStatus: finalGate.data?.status ?? 'missing',
      finalSignoffStatus: signoff.data?.status ?? 'missing',
      externalValidationPending: handoff.data?.summary?.externalValidationPending ?? null
    },
    domains,
    recommendedActions: buildRecommendedActions(domains),
    excellenceBacklog: domains.flatMap((domain) => domain.excellenceActions.map((action) => ({
      domainId: domain.domainId,
      action
    }))),
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath)
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function buildRecommendedActions(domains) {
  const blocking = domains.flatMap((domain) => domain.nextActions.map((action) => ({
    domainId: domain.domainId,
    action
  })));
  if (blocking.length > 0) return blocking;
  const warning = domains.flatMap((domain) => (domain.warningActions ?? []).map((action) => ({
    domainId: domain.domainId,
    action
  })));
  const maintenance = {
    domainId: 'g-verification-release',
    action: warning.length > 0
      ? 'No blocking action remains. Resolve the warning actions below, then re-run npm run ops:completion-ledger.'
      : 'No blocking or warning action remains. Re-run npm run ops:completion-ledger after every code, installer, mobile, or release-evidence change.'
  };
  return [maintenance, ...warning];
}

function renderMarkdown(report) {
  return [
    '# JARVIS Product Completion Ledger',
    '',
    `Status: **${report.status}**`,
    `Completion score: **${report.score}%**`,
    `Strict implementation: ${report.summary.strictScore ?? 'n/a'}`,
    `Product readiness: ${report.summary.productReadinessScore ?? 'n/a'}`,
    `Final release gate: ${report.summary.finalReleaseGateStatus}`,
    `Final signoff: ${report.summary.finalSignoffStatus}`,
    `Pending external validation: ${report.summary.externalValidationPending ?? 'n/a'}`,
    '',
    '## Domain Status',
    '',
    '| Domain | Docs | Status | Score | Blocking | Warnings |',
    '| --- | --- | --- | ---: | ---: | ---: |',
    ...report.domains.map((domain) => `| ${escapeMd(domain.title)} | ${domain.docs.join(', ')} | ${domain.status} | ${domain.score} | ${domain.blockingFailures.length} | ${domain.warnings.length} |`),
    '',
    '## Evidence Map',
    '',
    ...report.domains.flatMap((domain) => [
      `### ${domain.title}`,
      '',
      ...domain.evidence.map((item) => `- ${item.present ? 'present' : 'missing'}: \`${item.path ?? item.label}\` (${item.status})`),
      ''
    ]),
    '## Recommended Actions',
    '',
    ...report.recommendedActions.map((item) => `- ${item.domainId}: ${item.action}`),
    '',
    '## Excellence Backlog',
    '',
    ...report.excellenceBacklog.map((item) => `- ${item.domainId}: ${item.action}`),
    ''
  ].join('\n');
}

function escapeMd(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProductCompletionLedger(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Product Completion Ledger');
  console.log(`Status: ${report.status}`);
  console.log(`Completion score: ${report.score}%`);
  console.log(`Blocked domains: ${report.summary.blockedDomainCount}`);
  console.log(`Warning domains: ${report.summary.warningDomainCount}`);
  console.log('Reports: dist/product-completion-ledger.json, dist/product-completion-ledger.md');
  if (report.status === 'blocked') process.exitCode = 1;
}
