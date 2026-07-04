import {
  createPairingInputState,
  createPairingQrPayload,
  createPairingRecoveryState,
  createQrScannerPermissionState,
  parsePairingQrText
} from '../components/PairingQrPanel.js';

export function createPairingScreenViewModel({ mobileRuntime, bridgeRuntime }) {
  return {
    route: 'PairingScreen',
    start() {
      const session = bridgeRuntime.pairing.start();
      return {
        ...session,
        qrPayload: createPairingQrPayload(session),
        inputState: createPairingInputState(session)
      };
    },
    confirm(pairingCode, bridgeUrl) {
      const inputState = createPairingInputState({ pairingCode, bridgeUrl });
      if (!inputState.canConfirm) {
        return { success: false, validation: inputState.validation };
      }
      const result = mobileRuntime.pair({ pairingCode, bridgeUrl });
      return result.success
        ? {
            ...result,
            tokenStorage: mobileRuntime.tokenStorageStatus(),
            nextRoute: 'CommandScreen'
          }
        : result;
    },
    manualInput(pairingCode, bridgeUrl) {
      return createPairingInputState({ pairingCode, bridgeUrl });
    },
    scannerPermission(request = {}) {
      return createQrScannerPermissionState(request);
    },
    scan(qrText) {
      return parsePairingQrText(qrText);
    },
    recovery(request = {}) {
      return createPairingRecoveryState(request);
    },
    productGate(options = {}) {
      return createPairingScreenProductGate(options);
    },
    inventory() {
      return bridgeRuntime.registry.inventory();
    }
  };
}

export function createPairingScreenReleaseDossier({
  pairing = null,
  scannerPermission = null,
  scannedPairing = null,
  recovery = null,
  paired = null,
  deviceInventory = null,
  tokenStorage = null,
  generatedAt = new Date()
} = {}) {
  const rawNeedles = [
    pairing?.pairingId,
    pairing?.pairingCode,
    pairing?.bridgeUrl,
    pairing?.qrPayload?.qrText,
    pairing?.qrPayload?.pairingCode,
    pairing?.qrPayload?.bridgeUrl,
    scannedPairing?.pairingId,
    scannedPairing?.pairingCode,
    scannedPairing?.bridgeUrl,
    paired?.deviceToken,
    paired?.token?.tokenId,
    paired?.deviceId,
    paired?.deviceName,
    tokenStorage?.tokenPreview,
    ...(deviceInventory?.items ?? []).flatMap((item) => [
      item.deviceId,
      item.deviceName,
      item.tokenId,
      item.tokenFingerprint
    ])
  ].filter((needle) => typeof needle === 'string' && needle.length >= 6);
  const artifactManifest = {
    manifestVersion: 'c-pairing-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawPairingCodeStored: false,
    rawDeviceTokenStored: false,
    rawQrPayloadStored: false,
    rawBridgeUrlStored: false,
    rawCameraFrameStored: false,
    scanner: {
      scannerContractVersion: scannerPermission?.scannerContractVersion ?? null,
      platform: scannerPermission?.platform ?? null,
      cameraPermission: scannerPermission?.cameraPermission ?? null,
      scannerAvailable: scannerPermission?.scannerAvailable === true,
      canScan: scannerPermission?.canScan === true,
      needsPermission: scannerPermission?.needsPermission === true,
      primaryAction: scannerPermission?.primaryAction ?? null,
      fallbackAction: scannerPermission?.fallbackAction ?? null
    },
    qrPayload: {
      version: pairing?.qrPayload?.version ?? pairing?.version ?? null,
      pairingIdHash: stablePairingDigest(pairing?.pairingId ?? pairing?.qrPayload?.pairingId ?? ''),
      pairingCodeHash: stablePairingDigest(pairing?.pairingCode ?? pairing?.qrPayload?.pairingCode ?? ''),
      bridgeUrlHash: stablePairingDigest(pairing?.bridgeUrl ?? pairing?.qrPayload?.bridgeUrl ?? ''),
      expiresAtHash: stablePairingDigest(pairing?.expiresAt ?? pairing?.qrPayload?.expiresAt ?? ''),
      qrTextHash: stablePairingDigest(pairing?.qrPayload?.qrText ?? ''),
      inputCanConfirm: pairing?.inputState?.canConfirm === true
    },
    scannedPairing: {
      scannerContractVersion: scannedPairing?.scannerContractVersion ?? null,
      success: scannedPairing?.success === true,
      pairingIdHash: stablePairingDigest(scannedPairing?.pairingId ?? ''),
      pairingCodeHash: stablePairingDigest(scannedPairing?.pairingCode ?? ''),
      bridgeUrlHash: stablePairingDigest(scannedPairing?.bridgeUrl ?? ''),
      expiresAtHash: stablePairingDigest(scannedPairing?.expiresAt ?? ''),
      inputCanConfirm: scannedPairing?.inputState?.canConfirm === true,
      validBridge: scannedPairing?.inputState?.validBridge === true
    },
    recovery: {
      recoveryVersion: recovery?.recoveryVersion ?? null,
      pairingStatus: recovery?.pairingStatus ?? null,
      errorCode: recovery?.errorCode ?? null,
      tokenStatus: recovery?.tokenStatus ?? null,
      canRestartPairing: recovery?.canRestartPairing === true,
      canClearToken: recovery?.canClearToken === true,
      canRetryCode: recovery?.canRetryCode === true,
      recommendedAction: recovery?.recommendedAction ?? null
    },
    confirmation: {
      success: paired?.success === true,
      nextRoute: paired?.nextRoute ?? null,
      tokenSealed: tokenStorage?.sealed === true || paired?.tokenStorage?.sealed === true,
      tokenNativeBacked: tokenStorage?.nativeBacked === true || paired?.tokenStorage?.nativeBacked === true,
      tokenFallbackUsed: tokenStorage?.fallbackUsed === true || paired?.tokenStorage?.fallbackUsed === true,
      plaintextExposed: tokenStorage?.plaintextExposed === true || paired?.tokenStorage?.plaintextExposed === true,
      deviceHash: stablePairingDigest({
        deviceId: paired?.deviceId ?? null,
        deviceName: paired?.deviceName ?? null
      })
    },
    deviceInventory: {
      inventoryVersion: deviceInventory?.inventoryVersion ?? null,
      deviceCount: deviceInventory?.items?.length ?? 0,
      trustedCount: (deviceInventory?.items ?? []).filter((item) => String(item.trustLabel ?? '').includes('trusted')).length,
      recoveryActions: deviceInventory?.recovery?.recommendedActions ?? [],
      deviceHashes: (deviceInventory?.items ?? []).map((item) => ({
        deviceHash: stablePairingDigest(item.deviceId ?? ''),
        tokenHash: stablePairingDigest(item.tokenId ?? item.tokenFingerprint ?? ''),
        trustLabel: item.trustLabel ?? null,
        revoked: item.revoked === true
      }))
    },
    physicalQrScannerEvidenceRequired: true,
    tokenRotationRecoveryVisualEvidenceRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-pairing-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    artifactManifest,
    releaseWorkflow: {
      workflowVersion: 'c-pairing-release-workflow-v1',
      scannerReady: scannerPermission?.canScan === true,
      qrParseReady: scannedPairing?.success === true,
      recoveryReady: recovery?.recoveryVersion === 'c-pairing-recovery-state-v1',
      inventoryReady: deviceInventory?.inventoryVersion === 'd-device-inventory-v1',
      tokenSealed: artifactManifest.confirmation.tokenSealed === true,
      promotionStatus: 'pending_checks'
    }
  };
  const rawLeakDetected = serializedPairingDossierContainsAny({
    ...preliminaryDossier,
    generatedAt: null,
    artifactManifest: {
      ...preliminaryDossier.artifactManifest,
      generatedAt: null
    }
  }, rawNeedles);
  const checks = [
    {
      checkId: 'pairing_qr_scanner_permission_and_parse_ready',
      passed: scannerPermission?.scannerContractVersion === 'c-native-qr-scanner-contract-v1'
        && scannerPermission?.canScan === true
        && scannedPairing?.scannerContractVersion === 'c-native-qr-scanner-contract-v1'
        && scannedPairing?.success === true
    },
    {
      checkId: 'pairing_confirmation_token_sealed',
      passed: paired?.success === true
        && paired?.nextRoute === 'CommandScreen'
        && artifactManifest.confirmation.tokenSealed === true
        && artifactManifest.confirmation.plaintextExposed === false
    },
    {
      checkId: 'pairing_recovery_inventory_ready',
      passed: recovery?.recoveryVersion === 'c-pairing-recovery-state-v1'
        && recovery?.canClearToken === true
        && deviceInventory?.inventoryVersion === 'd-device-inventory-v1'
    },
    {
      checkId: 'raw_pairing_payload_not_stored',
      passed: artifactManifest.rawPairingCodeStored === false
        && artifactManifest.rawDeviceTokenStored === false
        && artifactManifest.rawQrPayloadStored === false
        && artifactManifest.rawBridgeUrlStored === false
        && artifactManifest.rawCameraFrameStored === false
        && rawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-pairing-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'c-pairing-health-handshake-v1',
    generatedAt: generatedAt.toISOString(),
    status: checks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshake: {
      scannerReady: scannerPermission?.scannerContractVersion === 'c-native-qr-scanner-contract-v1'
        && scannerPermission?.canScan === true,
      qrParseReady: scannedPairing?.scannerContractVersion === 'c-native-qr-scanner-contract-v1'
        && scannedPairing?.success === true,
      manualInputReady: pairing?.inputState?.canConfirm === true || scannedPairing?.inputState?.canConfirm === true,
      tokenSealed: artifactManifest.confirmation.tokenSealed === true,
      tokenPlaintextExposed: artifactManifest.confirmation.plaintextExposed === true,
      recoveryReady: recovery?.recoveryVersion === 'c-pairing-recovery-state-v1'
        && recovery?.canClearToken === true,
      inventoryReady: deviceInventory?.inventoryVersion === 'd-device-inventory-v1'
    },
    fallbackPolicy: {
      policyVersion: 'c-pairing-fallback-policy-v1',
      primaryFlow: 'native_qr_scan_then_sealed_token_confirmation',
      fallbackFlows: [
        'manual_pairing_code_entry_when_camera_unavailable',
        'clear_token_and_start_pairing_when_token_revoked_or_expired',
        'device_inventory_review_after_relaunch_restore',
        'local_bridge_url_validation_before_confirm'
      ],
      operatorEscalation: 'mobile_pairing_screen_recovery_and_device_inventory'
    },
    rawPairingCodeStored: false,
    rawDeviceTokenStored: false,
    rawQrPayloadStored: false,
    rawBridgeUrlStored: false,
    rawCameraFrameStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-pairing-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "mobile pairing" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'pairing_qr_scanner_permission_and_parse_ready',
      'pairing_confirmation_token_sealed',
      'pairing_recovery_inventory_ready',
      'raw_pairing_payload_not_stored',
      'pairing_release_dossier_ready',
      'pairing_release_artifact_manifest_ready',
      'pairing_operational_handoff_ready',
      'pairing_worm_promotion_package_ready'
    ],
    artifactManifestHash: stablePairingDigest(artifactManifest),
    operationalHandoffHash: stablePairingDigest(operationalHandoffManifest),
    rawPairingCodeStored: false,
    rawDeviceTokenStored: false,
    rawQrPayloadStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-pairing-worm-promotion-package-v1',
    providerContractVersion: 'c-pairing-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-pairing-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-pairing-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: stablePairingDigest(artifactManifest),
    operationalHandoffHash: stablePairingDigest(operationalHandoffManifest),
    ciNightlyGatePlanHash: stablePairingDigest(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPairingCodeStored: false,
    rawDeviceTokenStored: false,
    rawQrPayloadStored: false
  };
  const dossier = {
    ...preliminaryDossier,
    status: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    checks,
    artifactManifest: {
      ...artifactManifest,
      rawLeakCheck: {
        checkedNeedleCount: rawNeedles.length,
        rawLeakDetected
      }
    },
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    recommendedReleaseAction: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'capture_physical_qr_scanner_permission_scan_token_recovery_and_worm_release_evidence'
      : 'block_pairing_release_until_scanner_recovery_inventory_and_raw_retention_checks_pass'
  };
  dossier.releaseWorkflow = {
    ...dossier.releaseWorkflow,
    promotionStatus: dossier.status === 'passed' ? 'release_evidence_ready' : 'blocked'
  };
  dossier.dossierDigest = stablePairingDigest({
    ...dossier,
    dossierDigest: null
  });
  return dossier;
}

export function createPairingScreenProductGate(options = {}) {
  const releaseDossier = createPairingScreenReleaseDossier(options);
  const checks = [
    {
      checkId: 'pairing_qr_scanner_permission_and_parse_ready',
      status: releaseDossier.checks.find((check) => check.checkId === 'pairing_qr_scanner_permission_and_parse_ready')?.passed ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'pairing_confirmation_token_sealed',
      status: releaseDossier.checks.find((check) => check.checkId === 'pairing_confirmation_token_sealed')?.passed ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'pairing_recovery_inventory_ready',
      status: releaseDossier.checks.find((check) => check.checkId === 'pairing_recovery_inventory_ready')?.passed ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'pairing_release_dossier_ready',
      status: releaseDossier.status === 'passed'
        && releaseDossier.dossierDigest.length === 64
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion,
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'pairing_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'c-pairing-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawPairingCodeStored === false
        && releaseDossier.artifactManifest?.rawDeviceTokenStored === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'pairing_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-pairing-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-pairing-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-pairing-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'pairing_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-pairing-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-pairing-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    }
  ];
  return {
    productGateVersion: 'c-pairing-screen-product-gate-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    checks,
    releaseDossier,
    evidence: {
      dossierVersion: releaseDossier.dossierVersion,
      dossierDigest: releaseDossier.dossierDigest,
      artifactManifest: releaseDossier.artifactManifest
    }
  };
}

function serializedPairingDossierContainsAny(value, needles) {
  const serialized = JSON.stringify(value);
  return needles.some((needle) => needle && serialized.includes(String(needle)));
}

function canonicalPairingJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalPairingJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPairingJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stablePairingDigest(value) {
  const source = typeof value === 'string' ? value : canonicalPairingJson(value);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }).join('').repeat(2).slice(0, 64);
}
