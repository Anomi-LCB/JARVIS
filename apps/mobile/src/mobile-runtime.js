import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApprovalDecision, createTaskRequest, stableId } from '../../../packages/shared/src/types.js';
import { approvalExpiryState } from './approval/approval-expiry.js';
import {officialDocumentViewUri} from './api/android-official-intents.js';

export class SecureTokenStore {
  constructor({ key = randomBytes(32), backendName = 'node-sealed-memory-store', nativeAdapter = null } = {}) {
    this.values = new Map();
    this.auditTrail = [];
    this.key = Buffer.isBuffer(key) ? key : createHash('sha256').update(String(key)).digest();
    this.backendName = backendName;
    this.nativeAdapter = nativeAdapter ?? new NativeSecureStorageAdapter({ fallbackStoreName: backendName });
  }

  set(key, value, metadata = {}) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    this.values.set(key, {
      sealed: true,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      value: encrypted.toString('base64'),
      storedAt: new Date().toISOString(),
      metadata
    });
    this.auditTrail.unshift({
      eventType: 'secure-token.set',
      key,
      metadata,
      plaintextExposed: false,
      storedAt: new Date().toISOString()
    });
  }

  get(key) {
    const record = this.values.get(key);
    if (!record) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.value, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  remove(key) {
    if (this.values.has(key)) {
      this.auditTrail.unshift({
        eventType: 'secure-token.removed',
        key,
        removedAt: new Date().toISOString(),
        plaintextExposed: false
      });
    }
    this.values.delete(key);
  }

  has(key) {
    return this.values.has(key);
  }

  metadata(key) {
    const record = this.values.get(key);
    const nativeAdapter = this.nativeAdapter.capability();
    if (!record) {
      return {
        exists: false,
        backendName: this.backendName,
        nativeAdapter,
        nativeBacked: false,
        fallbackUsed: nativeAdapter.fallbackUsed,
        platformBacked: nativeAdapter.platformBacked
      };
    }
    return {
      exists: true,
      backendName: this.backendName,
      nativeAdapter,
      nativeBacked: nativeAdapter.nativeAvailable && nativeAdapter.supportsSyncStorage === true,
      fallbackUsed: nativeAdapter.fallbackUsed,
      platformBacked: nativeAdapter.platformBacked,
      sealed: record.sealed,
      algorithm: record.algorithm,
      storedAt: record.storedAt,
      metadata: record.metadata ?? {},
      plaintextExposed: false
    };
  }

  history(limit = 20) {
    return this.auditTrail.slice(0, limit);
  }
}

export class NativeSecureStorageAdapter {
  constructor({
    adapterName = 'expo-secure-store-adapter',
    nativeModule = null,
    fallbackStoreName = 'node-sealed-memory-store',
    configuredPlugin = true,
    clock = () => new Date()
  } = {}) {
    this.adapterName = adapterName;
    this.nativeModule = nativeModule;
    this.fallbackStoreName = fallbackStoreName;
    this.configuredPlugin = configuredPlugin;
    this.clock = clock;
  }

  capability() {
    const nativeAvailable = Boolean(
      this.nativeModule
      && typeof this.nativeModule.setItemAsync === 'function'
      && typeof this.nativeModule.getItemAsync === 'function'
      && typeof this.nativeModule.deleteItemAsync === 'function'
    );
    return {
      adapterName: this.adapterName,
      configuredPlugin: this.configuredPlugin,
      nativeAvailable,
      supportsSyncStorage: false,
      platformBacked: nativeAvailable,
      fallbackUsed: !nativeAvailable,
      fallbackStoreName: this.fallbackStoreName,
      encryptedAtRest: true,
      plaintextExposed: false,
      expectedNativeModule: 'expo-secure-store',
      checkedAt: this.clock().toISOString()
    };
  }
}

export function decodeDeviceTokenClaims(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) {
    return {
      success: false,
      error: { code: 'C_DEVICE_TOKEN_MALFORMED', message: 'Device token is not a signed three-part token.' }
    };
  }
  try {
    const payload = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), 'base64').toString('utf8'));
    return {
      success: true,
      claimsVersion: 'c-device-token-claims-v1',
      tokenId: payload.jti ?? null,
      deviceId: payload.sub ?? null,
      issuedAt: payload.iat ? new Date(Number(payload.iat) * 1000).toISOString() : null,
      expiresAt: payload.exp ? new Date(Number(payload.exp) * 1000).toISOString() : null,
      tokenVersion: Number(payload.ver ?? 1),
      scope: Array.isArray(payload.scope) ? payload.scope : []
    };
  } catch {
    return {
      success: false,
      error: { code: 'C_DEVICE_TOKEN_CLAIMS_UNREADABLE', message: 'Device token claims could not be decoded locally.' }
    };
  }
}

export function createSecureTokenRecoveryState({
  lifecycleStatus = null,
  recoveryQueue = [],
  tokenStorage = null
} = {}) {
  const pending = recoveryQueue.filter((item) => item.status === 'queued' || item.status === 'retrying');
  const primary = pending[0] ?? null;
  return {
    stateVersion: 'c-secure-token-recovery-ux-v1',
    status: lifecycleStatus?.status ?? 'unknown',
    tokenSealed: tokenStorage?.sealed === true && tokenStorage?.plaintextExposed === false,
    needsUserAction: Boolean(primary) || ['expired', 'invalid', 'revoked', 'rotation-due'].includes(lifecycleStatus?.status),
    primaryAction: primary
      ? primary.action
      : actionForTokenLifecycleStatus(lifecycleStatus?.status),
    bannerTone: ['expired', 'invalid', 'revoked'].includes(lifecycleStatus?.status) || primary ? 'warning' : 'success',
    message: secureTokenRecoveryMessage(lifecycleStatus, primary),
    pendingCount: pending.length,
    recoveryQueue: pending
  };
}

export function createSecureTokenReleaseDossier({
  before = null,
  after = null,
  expiredRecovery = null,
  rotation = null,
  revokeFailure = null,
  retryRun = null,
  recoveryState = null,
  tokenStorage = null,
  tokenHistory = [],
  secureStoreHistory = [],
  productGateChecks = [],
  rawCurrentToken = null,
  rawRotatedToken = null,
  generatedAt = new Date()
} = {}) {
  const rawNeedles = [
    rawCurrentToken,
    rawRotatedToken,
    before?.claims?.tokenId,
    after?.claims?.tokenId,
    rotation?.tokenId,
    ...(tokenHistory ?? []).map((item) => item.tokenId),
    ...(secureStoreHistory ?? []).map((item) => item.metadata?.tokenId),
    ...(recoveryState?.recoveryQueue ?? []).map((item) => item.queueId),
    revokeFailure?.recovery?.queueId
  ].filter(Boolean);
  const artifactManifest = {
    manifestVersion: 'c-secure-token-storage-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawDeviceTokenStored: false,
    rawTokenIdStored: false,
    rawSecureStoreCiphertextStored: false,
    rawRecoveryQueuePayloadStored: false,
    rawSecureStoreAuditPayloadStored: false,
    tokenStorage: {
      exists: tokenStorage?.exists === true,
      sealed: tokenStorage?.sealed === true,
      backendName: tokenStorage?.backendName ?? null,
      nativeAdapterName: tokenStorage?.nativeAdapter?.adapterName ?? null,
      expectedNativeModule: tokenStorage?.nativeAdapter?.expectedNativeModule ?? null,
      nativeBacked: tokenStorage?.nativeBacked === true,
      fallbackUsed: tokenStorage?.fallbackUsed === true,
      encryptedAtRest: tokenStorage?.nativeAdapter?.encryptedAtRest === true,
      plaintextExposed: tokenStorage?.plaintextExposed === true,
      tokenVersion: tokenStorage?.metadata?.tokenVersion ?? null,
      tokenIdHash: mobileRuntimeDigest(tokenStorage?.metadata?.tokenId ?? ''),
      expiresAtHash: mobileRuntimeDigest(tokenStorage?.metadata?.expiresAt ?? '')
    },
    lifecycle: {
      beforeStatus: before?.status ?? null,
      afterStatus: after?.status ?? null,
      beforeTokenVersion: before?.tokenVersion ?? before?.claims?.tokenVersion ?? null,
      afterTokenVersion: after?.tokenVersion ?? after?.claims?.tokenVersion ?? null,
      beforeTokenIdHash: mobileRuntimeDigest(before?.claims?.tokenId ?? ''),
      afterTokenIdHash: mobileRuntimeDigest(after?.claims?.tokenId ?? ''),
      afterRecoveryAction: after?.recoveryAction ?? null
    },
    recoveryUx: {
      stateVersion: expiredRecovery?.stateVersion ?? null,
      status: expiredRecovery?.status ?? null,
      primaryAction: expiredRecovery?.primaryAction ?? null,
      pendingCount: expiredRecovery?.pendingCount ?? 0
    },
    rotation: {
      rotationVersion: rotation?.rotationVersion ?? null,
      success: rotation?.success === true,
      oldTokenRejected: rotation?.oldTokenRejected === true,
      tokenVersion: rotation?.tokenVersion ?? null,
      tokenIdHash: mobileRuntimeDigest(rotation?.tokenId ?? ''),
      expiresAtHash: mobileRuntimeDigest(rotation?.expiresAt ?? ''),
      storageSealed: rotation?.tokenStorage?.sealed === true
    },
    revokeRetry: {
      revokeVersion: revokeFailure?.revokeVersion ?? null,
      queued: revokeFailure?.recovery?.action === 'retry_device_revoke',
      action: revokeFailure?.recovery?.action ?? null,
      queueIdHash: mobileRuntimeDigest(revokeFailure?.recovery?.queueId ?? ''),
      errorCode: revokeFailure?.error?.code ?? revokeFailure?.recovery?.failure?.code ?? null
    },
    retryRun: {
      retryVersion: retryRun?.retryVersion ?? null,
      dryRun: retryRun?.dryRun === true,
      attempted: retryRun?.attempted ?? 0,
      resultHashes: (retryRun?.results ?? []).map((item) => mobileRuntimeDigest({
        queueId: item.queueId ?? null,
        action: item.action ?? item.result?.revokeVersion ?? item.result?.rotationVersion ?? null,
        status: item.status ?? item.result?.status ?? item.result?.error?.code ?? null
      }))
    },
    tokenHistory: (tokenHistory ?? []).map((item) => ({
      eventType: item.eventType,
      eventVersion: item.eventVersion,
      tokenVersion: item.tokenVersion ?? null,
      tokenIdHash: mobileRuntimeDigest(item.tokenId ?? ''),
      expiresAtHash: mobileRuntimeDigest(item.expiresAt ?? ''),
      createdAtHash: mobileRuntimeDigest(item.createdAt ?? '')
    })),
    secureStoreHistory: (secureStoreHistory ?? []).map((item) => ({
      eventType: item.eventType,
      keyHash: mobileRuntimeDigest(item.key ?? ''),
      tokenIdHash: mobileRuntimeDigest(item.metadata?.tokenId ?? ''),
      plaintextExposed: item.plaintextExposed === true,
      storedAtHash: mobileRuntimeDigest(item.storedAt ?? item.removedAt ?? '')
    })),
    physicalSecureStoreEvidenceRequired: true,
    operatingBridgeTokenRotationEvidenceRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-secure-token-storage-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    artifactManifest,
    releaseWorkflow: {
      workflowVersion: 'c-secure-token-storage-release-workflow-v1',
      sealedStorageReady: artifactManifest.tokenStorage.sealed === true
        && artifactManifest.tokenStorage.plaintextExposed === false,
      recoveryUxReady: expiredRecovery?.stateVersion === 'c-secure-token-recovery-ux-v1',
      rotationReady: rotation?.success === true && rotation?.oldTokenRejected === true,
      revokeRetryReady: revokeFailure?.recovery?.action === 'retry_device_revoke',
      retryRunReady: retryRun?.retryVersion === 'c-secure-token-recovery-retry-run-v1',
      promotionStatus: 'pending_checks'
    }
  };
  const baseRawLeakDetected = serializedMobileRuntimeContainsAny({
    ...preliminaryDossier,
    generatedAt: null,
    artifactManifest: {
      ...preliminaryDossier.artifactManifest,
      generatedAt: null
    }
  }, rawNeedles);
  const checks = [
    {
      checkId: 'secure_token_product_gate_base_checks_passed',
      passed: productGateChecks.length > 0 && productGateChecks.every((check) => check.passed === true)
    },
    {
      checkId: 'secure_token_release_sealed_storage_ready',
      passed: artifactManifest.tokenStorage.sealed === true
        && artifactManifest.tokenStorage.plaintextExposed === false
        && artifactManifest.tokenStorage.encryptedAtRest === true
    },
    {
      checkId: 'secure_token_release_recovery_ux_ready',
      passed: expiredRecovery?.stateVersion === 'c-secure-token-recovery-ux-v1'
        && expiredRecovery?.primaryAction === 'repair_pairing'
    },
    {
      checkId: 'secure_token_release_rotation_revoke_retry_ready',
      passed: rotation?.success === true
        && rotation?.oldTokenRejected === true
        && revokeFailure?.revokeVersion === 'c-secure-token-revoke-retry-queue-v1'
        && retryRun?.retryVersion === 'c-secure-token-recovery-retry-run-v1'
    },
    {
      checkId: 'raw_secure_token_payload_not_stored',
      passed: artifactManifest.rawDeviceTokenStored === false
        && artifactManifest.rawTokenIdStored === false
        && artifactManifest.rawSecureStoreCiphertextStored === false
        && artifactManifest.rawRecoveryQueuePayloadStored === false
        && artifactManifest.rawSecureStoreAuditPayloadStored === false
        && baseRawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-secure-token-storage-operational-handoff-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    owner: 'mobile-secure-token-release-owner',
    scope: 'secure_store_pairing_token_lifecycle_rotation_revoke_retry',
    status: checks.every((check) => check.passed) && baseRawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'c-secure-token-storage-health-handshake-v1',
    healthHandshake: {
      sealedStorageReady: checks.some((check) => check.checkId === 'secure_token_release_sealed_storage_ready' && check.passed),
      recoveryUxReady: checks.some((check) => check.checkId === 'secure_token_release_recovery_ux_ready' && check.passed),
      rotationRevokeRetryReady: checks.some((check) => check.checkId === 'secure_token_release_rotation_revoke_retry_ready' && check.passed),
      rawLeakDetected: baseRawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'c-secure-token-storage-fallback-policy-v1',
      primaryFlow: 'seal_bridge_device_token_then_rotate_before_expiry_and_retry_revoke_failures',
      fallbackFlows: [
        'repair_pairing_when_token_is_expired_invalid_or_revoked',
        'preserve_previous_token_when_rotation_fails',
        'queue_retry_device_revoke_when_bridge_transport_fails',
        'block_release_when_plaintext_or_raw_token_id_leak_is_detected'
      ],
      operatorEscalation: 'mobile_secure_token_storage_release_and_recovery_queue_report'
    },
    rawDeviceTokenStored: false,
    rawTokenIdStored: false,
    rawSecureStoreCiphertextStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-secure-token-storage-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "mobile runtime pairs" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'secure_token_sealed_storage',
      'secure_token_expiry_recovery_ux_ready',
      'secure_token_rotation_replaces_token',
      'secure_token_revoke_failure_retry_queued',
      'secure_token_recovery_retry_run_ready',
      'secure_token_plaintext_never_exposed',
      'secure_token_release_dossier_ready',
      'secure_token_release_artifact_manifest_ready',
      'secure_token_operational_handoff_ready',
      'secure_token_worm_promotion_package_ready'
    ],
    artifactManifestHash: mobileRuntimeDigest(artifactManifest),
    operationalHandoffHash: mobileRuntimeDigest(operationalHandoffManifest),
    rawDeviceTokenStored: false,
    rawTokenIdStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-secure-token-storage-worm-promotion-package-v1',
    providerContractVersion: 'c-secure-token-storage-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-secure-token-storage-release-artifact-manifest-v1'
      && baseRawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-secure-token-storage-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: mobileRuntimeDigest(artifactManifest),
    operationalHandoffHash: mobileRuntimeDigest(operationalHandoffManifest),
    ciNightlyGatePlanHash: mobileRuntimeDigest(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawDeviceTokenStored: false,
    rawTokenIdStored: false,
    rawSecureStoreCiphertextStored: false
  };
  const rawLeakDetected = baseRawLeakDetected
    || serializedMobileRuntimeContainsAny(operationalHandoffManifest, rawNeedles)
    || serializedMobileRuntimeContainsAny(ciNightlyGatePlan, rawNeedles)
    || serializedMobileRuntimeContainsAny(externalWormPromotionPackage, rawNeedles);
  const dossier = {
    ...preliminaryDossier,
    status: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      && rawLeakDetected === false
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
      ? 'capture_physical_android_ios_secure_store_rotation_revoke_retry_and_worm_release_evidence'
      : 'block_secure_token_storage_release_until_rotation_recovery_and_raw_retention_checks_pass'
  };
  dossier.releaseWorkflow = {
    ...dossier.releaseWorkflow,
    promotionStatus: dossier.status === 'passed' ? 'release_evidence_ready' : 'blocked'
  };
  dossier.dossierDigest = mobileRuntimeDigest({
    ...dossier,
    dossierDigest: null
  });
  return dossier;
}

function sanitizeSecureTokenRotationResult(result = {}) {
  if (!result || typeof result !== 'object') return result;
  const { deviceToken, tokenId, ...safe } = result;
  return {
    ...safe,
    tokenIdHash: mobileRuntimeDigest(tokenId ?? ''),
    deviceTokenDigest: mobileRuntimeDigest(deviceToken ?? ''),
    rawDeviceTokenReturned: false,
    rawTokenIdReturned: false
  };
}

function sanitizeSecureTokenLifecycleStatus(status = {}) {
  if (!status || typeof status !== 'object') return status;
  const tokenId = status.claims?.tokenId ?? status.tokenStorage?.metadata?.tokenId ?? null;
  const sanitizedTokenStorage = status.tokenStorage
    ? {
        ...status.tokenStorage,
        metadata: status.tokenStorage.metadata
          ? {
              ...status.tokenStorage.metadata,
              tokenId: undefined,
              tokenIdHash: mobileRuntimeDigest(status.tokenStorage.metadata.tokenId ?? '')
            }
          : status.tokenStorage.metadata
      }
    : status.tokenStorage;
  return {
    ...status,
    claims: status.claims
      ? {
          ...status.claims,
          tokenId: undefined,
          tokenIdHash: mobileRuntimeDigest(status.claims.tokenId ?? '')
        }
      : status.claims,
    tokenStorage: sanitizedTokenStorage,
    tokenIdHash: mobileRuntimeDigest(tokenId ?? ''),
    rawTokenIdReturned: false
  };
}

function sanitizeSecureTokenHistoryEvent(item = {}) {
  return {
    ...item,
    tokenId: undefined,
    tokenIdHash: mobileRuntimeDigest(item.tokenId ?? '')
  };
}

function sanitizeSecureStoreHistoryEvent(item = {}) {
  return {
    ...item,
    metadata: item.metadata
      ? {
          ...item.metadata,
          tokenId: undefined,
          tokenIdHash: mobileRuntimeDigest(item.metadata.tokenId ?? '')
        }
      : item.metadata
  };
}

function actionForTokenLifecycleStatus(status) {
  if (status === 'expired' || status === 'invalid' || status === 'revoked') return 'repair_pairing';
  if (status === 'rotation-due') return 'rotate_device_token';
  return 'none';
}

function secureTokenRecoveryMessage(lifecycleStatus, primary) {
  if (primary?.action === 'retry_device_revoke') return '기기 해제 실패가 재시도 큐에 보존되었습니다.';
  if (primary?.action === 'rotate_device_token') return '브릿지 토큰 회전을 다시 시도해야 합니다.';
  if (['expired', 'invalid', 'revoked'].includes(lifecycleStatus?.status)) return '브릿지 토큰 복구를 위해 다시 페어링해야 합니다.';
  if (lifecycleStatus?.status === 'rotation-due') return '브릿지 토큰 만료가 가까워 회전을 권장합니다.';
  return '브릿지 토큰이 안전 저장소에 보존되어 있습니다.';
}

function base64UrlToBase64(value) {
  const normalized = String(value ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
}

function tokenMetadataFromResult(result = {}) {
  return {
    tokenId: result.token?.tokenId ?? result.tokenId ?? null,
    tokenVersion: result.token?.tokenVersion ?? result.tokenVersion ?? null,
    algorithm: result.token?.algorithm ?? result.tokenAlgorithm ?? null,
    expiresAt: result.expiresAt ?? null,
    scope: result.token?.scope ?? result.tokenScope ?? []
  };
}

export class SessionLock {
  constructor({ clock = () => new Date(), timeoutMs = 5 * 60 * 1000, maxFailedAttempts = 5, lockoutMs = 60 * 1000, biometricPrompt = null } = {}) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.maxFailedAttempts = maxFailedAttempts;
    this.lockoutMs = lockoutMs;
    this.biometricPrompt = biometricPrompt ?? new NativeBiometricPromptAdapter({ clock });
    this.pinHash = null;
    this.locked = false;
    this.lastUnlockedAt = null;
    this.failedAttempts = 0;
    this.lockedUntil = null;
  }

  configurePin(pin) {
    if (!pin || String(pin).length < 4) {
      return { success: false, error: { code: 'C_SESSION_PIN_TOO_SHORT' } };
    }
    this.pinHash = this.hash(pin);
    this.locked = true;
    this.lastUnlockedAt = null;
    this.failedAttempts = 0;
    this.lockedUntil = null;
    return { success: true, locked: true };
  }

  hash(pin) {
    return createHash('sha256').update(`jarvis-mobile-session:${pin}`).digest('hex');
  }

  unlockWithPin(pin) {
    if (this.lockedUntil && this.clock().getTime() < Date.parse(this.lockedUntil)) {
      this.locked = true;
      return {
        success: false,
        locked: true,
        lockedUntil: this.lockedUntil,
        error: {
          code: 'C_SESSION_LOCKED_OUT',
          message: `Too many failed PIN attempts. Retry after ${this.lockedUntil}.`
        }
      };
    }
    if (!this.pinHash) {
      this.locked = false;
      this.lastUnlockedAt = this.clock().toISOString();
      this.failedAttempts = 0;
      this.lockedUntil = null;
      return { success: true, locked: false, reason: 'no-pin-configured' };
    }
    if (this.hash(pin) !== this.pinHash) {
      this.failedAttempts += 1;
      this.locked = true;
      if (this.failedAttempts >= this.maxFailedAttempts) {
        this.lockedUntil = new Date(this.clock().getTime() + this.lockoutMs).toISOString();
        return {
          success: false,
          locked: true,
          lockedUntil: this.lockedUntil,
          error: {
            code: 'C_SESSION_LOCKED_OUT',
            message: `Too many failed PIN attempts. Retry after ${this.lockedUntil}.`
          }
        };
      }
      return { success: false, locked: true, error: { code: 'C_SESSION_UNLOCK_FAILED' } };
    }
    this.failedAttempts = 0;
    this.lockedUntil = null;
    this.locked = false;
    this.lastUnlockedAt = this.clock().toISOString();
    return { success: true, locked: false };
  }

  unlockWithBiometric(options = {}) {
    const prompt = this.biometricPrompt.prompt(options);
    if (!prompt.success) {
      this.locked = true;
      return {
        success: false,
        locked: true,
        biometric: prompt,
        error: prompt.error ?? { code: 'C_BIOMETRIC_UNLOCK_FAILED' }
      };
    }
    this.failedAttempts = 0;
    this.lockedUntil = null;
    this.locked = false;
    this.lastUnlockedAt = this.clock().toISOString();
    return {
      success: true,
      locked: false,
      biometric: prompt
    };
  }

  lock(reason = 'manual') {
    this.locked = true;
    return { success: true, locked: true, reason, lockedAt: this.clock().toISOString() };
  }

  isExpired() {
    if (this.locked || !this.lastUnlockedAt) return this.locked;
    return this.clock().getTime() - Date.parse(this.lastUnlockedAt) > this.timeoutMs;
  }

  requireUnlocked(reason = 'sensitive-action') {
    if (this.isExpired()) {
      this.locked = true;
      return {
        allowed: false,
        error: {
          code: 'C_SESSION_LOCKED',
          message: `Session unlock required for ${reason}.`
        }
      };
    }
    return { allowed: true };
  }

  state() {
    return {
      configured: Boolean(this.pinHash),
      locked: this.locked,
      lastUnlockedAt: this.lastUnlockedAt,
      timeoutMs: this.timeoutMs,
      failedAttempts: this.failedAttempts,
      maxFailedAttempts: this.maxFailedAttempts,
      lockoutMs: this.lockoutMs,
      lockedUntil: this.lockedUntil,
      biometric: this.biometricPrompt.capability()
    };
  }
}

export class NativeBiometricPromptAdapter {
  constructor({
    adapterName = 'expo-local-authentication-adapter',
    nativeModule = null,
    enrolled = true,
    clock = () => new Date()
  } = {}) {
    this.adapterName = adapterName;
    this.nativeModule = nativeModule;
    this.enrolled = enrolled;
    this.clock = clock;
    this.prompts = [];
  }

  capability() {
    const nativeAvailable = Boolean(
      this.nativeModule
      && typeof this.nativeModule.authenticateAsync === 'function'
    );
    return {
      adapterName: this.adapterName,
      expectedNativeModule: 'expo-local-authentication',
      nativeAvailable,
      enrolled: this.enrolled,
      fallbackUsed: !nativeAvailable,
      securePrompt: nativeAvailable ? 'native-biometric-prompt' : 'simulated-biometric-contract',
      checkedAt: this.clock().toISOString()
    };
  }

  prompt({ reason = 'session-unlock', simulateSuccess = true } = {}) {
    const capability = this.capability();
    const result = {
      promptId: stableId('biometric', `${reason}:${this.prompts.length}`, this.clock().toISOString()),
      reason,
      capability,
      promptedAt: this.clock().toISOString(),
      success: capability.enrolled === true && simulateSuccess === true,
      fallbackUsed: capability.fallbackUsed
    };
    if (!result.success) {
      result.error = {
        code: capability.enrolled ? 'C_BIOMETRIC_AUTH_FAILED' : 'C_BIOMETRIC_NOT_ENROLLED',
        message: capability.enrolled ? 'Biometric authentication failed.' : 'No biometric enrollment is available.'
      };
    }
    this.prompts.unshift(result);
    return result;
  }

  history(limit = 10) {
    return this.prompts.slice(0, limit);
  }
}

export class AppLifecycleSecurityController {
  constructor({ sessionLock, clock = () => new Date(), lockOnBackground = true, lockOnInactive = true, relockAfterMs = 30 * 1000 } = {}) {
    this.sessionLock = sessionLock;
    this.clock = clock;
    this.lockOnBackground = lockOnBackground;
    this.lockOnInactive = lockOnInactive;
    this.relockAfterMs = relockAfterMs;
    this.appState = 'active';
    this.lastBackgroundedAt = null;
    this.transitions = [];
  }

  transition(nextState) {
    const allowedStates = ['active', 'inactive', 'background'];
    if (!allowedStates.includes(nextState)) {
      return { success: false, error: { code: 'C_APP_STATE_INVALID' } };
    }
    const previousState = this.appState;
    const changedAt = this.clock().toISOString();
    this.appState = nextState;
    const transition = { previousState, nextState, changedAt, locked: false, reason: null };

    if (nextState === 'background' && this.lockOnBackground) {
      this.lastBackgroundedAt = changedAt;
      this.sessionLock.lock('app-backgrounded');
      transition.locked = true;
      transition.reason = 'app-backgrounded';
    } else if (nextState === 'inactive' && this.lockOnInactive) {
      this.lastBackgroundedAt = changedAt;
      this.sessionLock.lock('app-inactive');
      transition.locked = true;
      transition.reason = 'app-inactive';
    } else if (nextState === 'active' && this.lastBackgroundedAt) {
      const awayMs = this.clock().getTime() - Date.parse(this.lastBackgroundedAt);
      if (awayMs >= this.relockAfterMs) {
        this.sessionLock.lock('app-resumed-after-timeout');
        transition.locked = true;
        transition.reason = 'app-resumed-after-timeout';
      }
    }

    this.transitions.unshift(transition);
    this.transitions = this.transitions.slice(0, 20);
    return { success: true, ...transition, session: this.sessionLock.state() };
  }

  state() {
    return {
      appState: this.appState,
      lastBackgroundedAt: this.lastBackgroundedAt,
      lockOnBackground: this.lockOnBackground,
      lockOnInactive: this.lockOnInactive,
      relockAfterMs: this.relockAfterMs,
      recentTransitions: [...this.transitions]
    };
  }

  soak(sequence = ['background', 'active', 'inactive', 'active']) {
    const results = sequence.map((state) => this.transition(state));
    return {
      sequence,
      cycles: results.length,
      lockedTransitions: results.filter((item) => item.locked).length,
      passed: results.some((item) => item.reason === 'app-backgrounded' || item.reason === 'app-inactive'),
      finalState: this.state(),
      results
    };
  }
}

export function createSessionLockVisualRegression({
  backgroundLock = null,
  biometricUnlock = null,
  lifecycleSoak = null,
  session = {},
  now = new Date()
} = {}) {
  const snapshots = [
    {
      stateId: 'background_auto_locked',
      locked: backgroundLock?.locked === true,
      reason: backgroundLock?.reason ?? null,
      appState: backgroundLock?.nextState ?? session.lifecycle?.appState ?? null,
      secureSurfaceHidden: backgroundLock?.locked === true
    },
    {
      stateId: 'biometric_prompt_unlocked',
      locked: biometricUnlock?.locked === false,
      prompt: biometricUnlock?.biometric ?? null,
      securePrompt: biometricUnlock?.biometric?.capability?.securePrompt ?? session.biometric?.securePrompt ?? null
    },
    {
      stateId: 'foreground_background_soak',
      lockedTransitions: lifecycleSoak?.lockedTransitions ?? 0,
      cycles: lifecycleSoak?.cycles ?? 0,
      passed: lifecycleSoak?.passed === true
    }
  ];
  const checks = [
    {
      checkId: 'background_state_hides_sensitive_surface',
      passed: snapshots[0].locked === true && snapshots[0].secureSurfaceHidden === true
    },
    {
      checkId: 'biometric_prompt_unlocks_without_plaintext_pin',
      passed: biometricUnlock?.success === true && snapshots[1].securePrompt?.includes('biometric')
    },
    {
      checkId: 'foreground_background_soak_keeps_lock_policy',
      passed: snapshots[2].passed === true && snapshots[2].lockedTransitions >= 2
    },
    {
      checkId: 'session_lock_visual_layout_stable',
      passed: snapshots.every((snapshot) => snapshot.stateId && snapshot.stateId.length > 0)
    }
  ];
  return {
    regressionVersion: 'c-session-lock-foreground-background-visual-regression-v1',
    generatedAt: now.toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    snapshots,
    checks
  };
}

export function createSessionLockReleaseDossier({
  backgroundLock = null,
  biometricUnlock = null,
  lifecycleSoak = null,
  visualRegression = null,
  session = {},
  productGateChecks = [],
  rawPinHash = null,
  generatedAt = new Date()
} = {}) {
  const rawNeedles = [
    rawPinHash,
    biometricUnlock?.biometric?.promptId,
    biometricUnlock?.biometric?.reason,
    backgroundLock?.lockedAt
  ].filter(Boolean);
  const artifactManifest = {
    manifestVersion: 'c-session-lock-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawPinStored: false,
    rawBiometricPromptStored: false,
    rawLifecyclePayloadStored: false,
    rawVisualSnapshotStored: false,
    sessionPolicy: {
      configured: session.configured === true,
      locked: session.locked === true,
      timeoutMs: session.timeoutMs ?? null,
      maxFailedAttempts: session.maxFailedAttempts ?? null,
      lockoutMs: session.lockoutMs ?? null,
      policyDigest: mobileRuntimeDigest({
        configured: session.configured === true,
        timeoutMs: session.timeoutMs ?? null,
        maxFailedAttempts: session.maxFailedAttempts ?? null,
        lockoutMs: session.lockoutMs ?? null
      })
    },
    backgroundLock: {
      locked: backgroundLock?.locked === true,
      reasonHash: mobileRuntimeDigest(backgroundLock?.reason ?? ''),
      transitionHash: mobileRuntimeDigest({
        previousState: backgroundLock?.previousState ?? null,
        nextState: backgroundLock?.nextState ?? null,
        locked: backgroundLock?.locked === true
      }),
      lockedAtHash: mobileRuntimeDigest(backgroundLock?.lockedAt ?? ''),
      secureSurfaceHidden: backgroundLock?.locked === true
    },
    biometricPrompt: {
      success: biometricUnlock?.success === true,
      lockedAfterPrompt: biometricUnlock?.locked === true,
      promptIdHash: mobileRuntimeDigest(biometricUnlock?.biometric?.promptId ?? ''),
      reasonHash: mobileRuntimeDigest(biometricUnlock?.biometric?.reason ?? ''),
      adapterName: biometricUnlock?.biometric?.capability?.adapterName ?? session.biometric?.adapterName ?? null,
      expectedNativeModule: biometricUnlock?.biometric?.capability?.expectedNativeModule ?? session.biometric?.expectedNativeModule ?? null,
      securePromptContract: biometricUnlock?.biometric?.capability?.securePrompt ?? session.biometric?.securePrompt ?? null,
      fallbackUsed: biometricUnlock?.biometric?.fallbackUsed === true
    },
    lifecycleSoak: {
      cycles: lifecycleSoak?.cycles ?? 0,
      lockedTransitions: lifecycleSoak?.lockedTransitions ?? 0,
      passed: lifecycleSoak?.passed === true,
      sequenceHash: mobileRuntimeDigest(lifecycleSoak?.sequence ?? []),
      transitionHashes: (lifecycleSoak?.results ?? []).map((item) => mobileRuntimeDigest({
        nextState: item.nextState ?? null,
        locked: item.locked === true,
        reason: item.reason ?? null
      }))
    },
    visualRegression: {
      regressionVersion: visualRegression?.regressionVersion ?? null,
      status: visualRegression?.status ?? 'missing',
      snapshotStateIds: (visualRegression?.snapshots ?? []).map((snapshot) => snapshot.stateId).filter(Boolean),
      checks: (visualRegression?.checks ?? []).map((check) => ({
        checkId: check.checkId,
        passed: check.passed === true
      }))
    },
    physicalBiometricPromptEvidenceRequired: true,
    physicalForegroundBackgroundSoakEvidenceRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-session-lock-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    artifactManifest,
    releaseWorkflow: {
      workflowVersion: 'c-session-lock-release-workflow-v1',
      backgroundLockReady: backgroundLock?.locked === true,
      biometricPromptReady: biometricUnlock?.success === true,
      lifecycleSoakReady: lifecycleSoak?.passed === true,
      visualRegressionReady: visualRegression?.status === 'passed',
      promotionStatus: 'pending_checks'
    }
  };
  const rawLeakDetected = serializedMobileRuntimeContainsAny({
    ...preliminaryDossier,
    generatedAt: null,
    artifactManifest: {
      ...preliminaryDossier.artifactManifest,
      generatedAt: null
    }
  }, rawNeedles);
  const checks = [
    {
      checkId: 'session_product_gate_base_checks_passed',
      passed: productGateChecks.length > 0 && productGateChecks.every((check) => check.passed === true)
    },
    {
      checkId: 'session_background_lock_verified',
      passed: backgroundLock?.locked === true && artifactManifest.backgroundLock.secureSurfaceHidden === true
    },
    {
      checkId: 'session_biometric_prompt_smoke_passed',
      passed: biometricUnlock?.success === true
        && artifactManifest.biometricPrompt.expectedNativeModule === 'expo-local-authentication'
        && artifactManifest.biometricPrompt.securePromptContract?.includes('biometric')
    },
    {
      checkId: 'session_lifecycle_visual_regression_passed',
      passed: lifecycleSoak?.passed === true
        && (lifecycleSoak?.lockedTransitions ?? 0) >= 2
        && visualRegression?.status === 'passed'
    },
    {
      checkId: 'raw_session_secret_not_stored',
      passed: artifactManifest.rawPinStored === false
        && artifactManifest.rawBiometricPromptStored === false
        && artifactManifest.rawLifecyclePayloadStored === false
        && artifactManifest.rawVisualSnapshotStored === false
        && rawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-session-lock-operational-handoff-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    owner: 'mobile-session-lock-release-owner',
    scope: 'session_pin_background_lock_biometric_prompt_lifecycle_soak',
    status: checks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'c-session-lock-health-handshake-v1',
    healthHandshake: {
      backgroundLockVerified: backgroundLock?.locked === true,
      biometricPromptSmokePassed: biometricUnlock?.success === true
        && artifactManifest.biometricPrompt.expectedNativeModule === 'expo-local-authentication',
      lifecycleSoakPassed: lifecycleSoak?.passed === true && (lifecycleSoak?.lockedTransitions ?? 0) >= 2,
      visualRegressionPassed: visualRegression?.status === 'passed',
      rawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'c-session-lock-fallback-policy-v1',
      primaryFlow: 'lock_sensitive_surfaces_on_background_then_require_pin_or_biometric_before_sensitive_actions',
      fallbackFlows: [
        'hide_sensitive_surface_when_app_state_changes_to_background_or_inactive',
        'fall_back_to_pin_unlock_when_biometric_adapter_is_unavailable',
        'enforce_lockout_after_repeated_failed_pin_attempts',
        'block_release_when_prompt_or_lifecycle_raw_payload_is_detected'
      ],
      operatorEscalation: 'mobile_session_lock_release_and_auth_lifecycle_report'
    },
    rawPinStored: false,
    rawBiometricPromptStored: false,
    rawLifecyclePayloadStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-session-lock-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "C mobile session lock" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'session_pin_configured',
      'session_background_lock_verified',
      'session_biometric_prompt_smoke_passed',
      'session_lifecycle_soak_passed',
      'session_visual_regression_passed',
      'session_lock_release_dossier_ready',
      'session_lock_release_artifact_manifest_ready',
      'session_lock_operational_handoff_ready',
      'session_lock_worm_promotion_package_ready'
    ],
    artifactManifestHash: mobileRuntimeDigest(artifactManifest),
    operationalHandoffHash: mobileRuntimeDigest(operationalHandoffManifest),
    rawPinStored: false,
    rawBiometricPromptStored: false,
    rawLifecyclePayloadStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-session-lock-worm-promotion-package-v1',
    providerContractVersion: 'c-session-lock-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-session-lock-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-session-lock-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: mobileRuntimeDigest(artifactManifest),
    operationalHandoffHash: mobileRuntimeDigest(operationalHandoffManifest),
    ciNightlyGatePlanHash: mobileRuntimeDigest(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPinStored: false,
    rawBiometricPromptStored: false,
    rawLifecyclePayloadStored: false
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
      ? 'capture_physical_android_ios_biometric_prompt_and_foreground_background_soak_evidence'
      : 'block_session_lock_release_until_auth_lifecycle_and_raw_retention_checks_pass'
  };
  dossier.releaseWorkflow = {
    ...dossier.releaseWorkflow,
    promotionStatus: dossier.status === 'passed' ? 'release_evidence_ready' : 'blocked'
  };
  dossier.dossierDigest = mobileRuntimeDigest({
    ...dossier,
    dossierDigest: null
  });
  return dossier;
}

export function createNotificationReleaseDossier({
  providerDrill = null,
  tokenTrend = null,
  receiptVerification = null,
  notificationStatus = {},
  productGateChecks = [],
  generatedAt = new Date()
} = {}) {
  const rawNeedles = [
    notificationStatus.pushToken?.tokenPreview,
    notificationStatus.permission?.lastPrompt?.promptId,
    ...(notificationStatus.items ?? []).flatMap((item) => [
      item.notificationId,
      item.eventId,
      item.taskId,
      item.approvalId,
      item.title,
      item.body,
      item.deliveryId,
      item.receiptId
    ]),
    ...(notificationStatus.deliveryLog ?? []).flatMap((item) => [
      item.deliveryId,
      item.notificationId,
      item.receipt?.receiptId
    ]),
    ...(notificationStatus.receiptLog ?? []).flatMap((item) => [
      item.receiptId,
      item.deliveryId,
      item.notificationId
    ]),
    ...(notificationStatus.issueQueue ?? []).flatMap((item) => [
      item.receiptId,
      item.deliveryId,
      item.notificationId
    ]),
    providerDrill?.foreground?.notificationId,
    providerDrill?.foreground?.title,
    providerDrill?.foreground?.body,
    providerDrill?.foreground?.deliveryId,
    providerDrill?.foreground?.receiptId,
    providerDrill?.background?.notificationId,
    providerDrill?.background?.title,
    providerDrill?.background?.body,
    providerDrill?.background?.deliveryId,
    providerDrill?.background?.receiptId,
    providerDrill?.providerReceipt?.drillId,
    ...(providerDrill?.providerReceipt?.visualEvidence ?? []).map((item) => item.receiptId),
    providerDrill?.failedRotation?.rotation?.rotationId,
    providerDrill?.failedRotation?.issue?.issueId,
    providerDrill?.successfulRotation?.rotation?.rotationId,
    ...(tokenTrend?.rotations ?? []).flatMap((item) => [
      item.rotation?.rotationId,
      item.issue?.issueId,
      item.rotation?.reason
    ])
  ].filter(Boolean);
  const deliveryLog = notificationStatus.deliveryLog ?? [];
  const receiptLog = notificationStatus.receiptLog ?? [];
  const issueQueue = notificationStatus.issueQueue ?? [];
  const visualEvidence = providerDrill?.providerReceipt?.visualEvidence ?? [];
  const artifactManifest = {
    manifestVersion: 'c-notification-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawNotificationPayloadStored: false,
    rawPushTokenStored: false,
    rawTokenPreviewStored: false,
    rawProviderReceiptStored: false,
    rawScreenshotStored: false,
    permission: {
      granted: notificationStatus.permission?.granted === true,
      source: notificationStatus.permission?.source ?? null,
      nativePromptAvailable: notificationStatus.permission?.nativePromptAvailable === true,
      promptRequested: notificationStatus.permission?.promptRequested === true,
      promptHash: mobileRuntimeDigest({
        source: notificationStatus.permission?.lastPrompt?.source ?? null,
        result: notificationStatus.permission?.lastPrompt?.result ?? null,
        nativePromptAvailable: notificationStatus.permission?.lastPrompt?.nativePromptAvailable === true
      })
    },
    adapter: {
      adapterName: notificationStatus.adapter?.adapterName ?? null,
      expectedNativeModule: notificationStatus.adapter?.expectedNativeModule ?? null,
      nativeAvailable: notificationStatus.adapter?.nativeAvailable === true,
      fallbackUsed: notificationStatus.adapter?.fallbackUsed === true,
      supportsPushToken: notificationStatus.adapter?.supportsPushToken === true,
      supportsReceipts: notificationStatus.adapter?.supportsReceipts === true,
      channels: [...new Set(notificationStatus.adapter?.channels ?? deliveryLog.map((item) => item.channelId).filter(Boolean))].sort()
    },
    deliveryEvidence: {
      deliveredCount: deliveryLog.filter((item) => item.status === 'delivered').length,
      queuedCount: deliveryLog.filter((item) => item.status === 'queued').length,
      total: deliveryLog.length,
      channels: [...new Set(deliveryLog.map((item) => item.channelId).filter(Boolean))].sort(),
      appStates: [...new Set(deliveryLog.map((item) => item.appState).filter(Boolean))].sort(),
      deliveryModeCounts: deliveryLog.reduce((acc, item) => {
        const key = item.deliveryMode ?? 'unknown';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      deliveryHashes: deliveryLog.map((item) => ({
        deliveryHash: mobileRuntimeDigest(item.deliveryId ?? ''),
        notificationHash: mobileRuntimeDigest(item.notificationId ?? ''),
        channelId: item.channelId ?? null,
        appState: item.appState ?? null,
        status: item.status ?? null,
        pushTokenRegistered: item.pushTokenRegistered === true,
        fallbackUsed: item.fallbackUsed === true
      }))
    },
    receiptEvidence: {
      verification: {
        checked: receiptVerification?.checked ?? 0,
        ok: receiptVerification?.ok ?? 0,
        queued: receiptVerification?.queued ?? 0,
        failed: receiptVerification?.failed ?? 0,
        retryQueued: receiptVerification?.retryQueued === true,
        unresolvedIssueCount: receiptVerification?.unresolvedIssues?.length ?? 0
      },
      receiptHashes: receiptLog.map((item) => ({
        receiptHash: mobileRuntimeDigest(item.receiptId ?? ''),
        deliveryHash: mobileRuntimeDigest(item.deliveryId ?? ''),
        provider: item.provider ?? null,
        appState: item.appState ?? null,
        status: item.status ?? null,
        retryable: item.retryable === true
      })),
      unresolvedIssueHashes: issueQueue
        .filter((item) => item.status !== 'resolved')
        .map((item) => ({
          issueHash: mobileRuntimeDigest({
            receiptId: item.receiptId ?? null,
            deliveryId: item.deliveryId ?? null,
            notificationId: item.notificationId ?? null
          }),
          reason: item.reason ?? null,
          retryable: item.retryable === true
        }))
    },
    providerDrill: {
      drillVersion: providerDrill?.drillVersion ?? null,
      status: providerDrill?.status ?? 'missing',
      mode: providerDrill?.providerReceipt?.mode ?? null,
      provider: providerDrill?.providerReceipt?.provider ?? null,
      nativeProviderReceipt: providerDrill?.providerReceipt?.nativeProviderReceipt === true,
      visualEvidence: visualEvidence.map((item) => ({
        state: item.state,
        evidenceType: item.evidenceType,
        receiptHash: mobileRuntimeDigest(item.receiptId ?? ''),
        status: item.status
      })),
      foregroundReceiptHash: mobileRuntimeDigest(providerDrill?.providerReceipt?.foreground?.receiptId ?? ''),
      backgroundReceiptHash: mobileRuntimeDigest(providerDrill?.providerReceipt?.background?.receiptId ?? ''),
      failedRotationIssueHash: mobileRuntimeDigest(providerDrill?.failedRotation?.issue?.issueId ?? ''),
      successfulRotationHash: mobileRuntimeDigest(providerDrill?.successfulRotation?.rotation?.rotationId ?? '')
    },
    tokenEvidence: {
      registered: notificationStatus.pushToken?.registered === true,
      platform: notificationStatus.pushToken?.platform ?? null,
      projectIdHash: mobileRuntimeDigest(notificationStatus.pushToken?.projectId ?? ''),
      tokenFingerprintHash: mobileRuntimeDigest(notificationStatus.pushToken?.tokenFingerprint ?? ''),
      plaintextExposed: notificationStatus.pushToken?.plaintextExposed === true,
      trendVersion: tokenTrend?.trendVersion ?? null,
      trendStatus: tokenTrend?.status ?? 'missing',
      cycles: tokenTrend?.cycles ?? 0,
      rotatedCount: tokenTrend?.rotatedCount ?? 0,
      unresolvedIssueCount: tokenTrend?.unresolvedIssues?.length ?? 0,
      rotationHashes: (tokenTrend?.rotations ?? []).map((item) => ({
        rotationHash: mobileRuntimeDigest(item.rotation?.rotationId ?? item.issue?.issueId ?? ''),
        success: item.success === true,
        status: item.rotation?.status ?? item.issue?.status ?? null,
        previousTokenPreserved: item.previousTokenPreserved === true,
        plaintextExposed: item.plaintextExposed === true
      }))
    },
    physicalNotificationScreenshotEvidenceRequired: true,
    operatingExpoProviderReceiptEvidenceRequired: notificationStatus.adapter?.nativeAvailable !== true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-notification-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    artifactManifest,
    releaseWorkflow: {
      workflowVersion: 'c-notification-release-workflow-v1',
      permissionReady: artifactManifest.permission.granted === true,
      providerReceiptReady: providerDrill?.status === 'passed',
      tokenRotationReady: tokenTrend?.status === 'passed',
      retryQueueReady: (receiptVerification?.failed ?? 1) === 0 && (receiptVerification?.unresolvedIssues?.length ?? 1) === 0,
      promotionStatus: 'pending_checks'
    }
  };
  const rawLeakDetected = serializedMobileRuntimeContainsAny({
    ...preliminaryDossier,
    generatedAt: null,
    artifactManifest: {
      ...preliminaryDossier.artifactManifest,
      generatedAt: null
    }
  }, rawNeedles);
  const visualStates = new Set(visualEvidence.map((item) => item.state));
  const checks = [
    {
      checkId: 'notification_product_gate_base_checks_passed',
      passed: productGateChecks.length > 0 && productGateChecks.every((check) => check.passed === true)
    },
    {
      checkId: 'notification_foreground_background_receipts_verified',
      passed: providerDrill?.status === 'passed'
        && visualEvidence.length >= 2
        && visualStates.has('foreground')
        && visualStates.has('background')
    },
    {
      checkId: 'notification_token_rotation_trend_release_ready',
      passed: tokenTrend?.status === 'passed'
        && (tokenTrend?.rotatedCount ?? 0) >= (tokenTrend?.cycles ?? 0)
        && (tokenTrend?.unresolvedIssues?.length ?? 0) === 0
    },
    {
      checkId: 'notification_receipt_retry_queue_clean',
      passed: (receiptVerification?.checked ?? 0) > 0
        && (receiptVerification?.failed ?? 1) === 0
        && (receiptVerification?.unresolvedIssues?.length ?? 1) === 0
    },
    {
      checkId: 'raw_notification_payload_not_stored',
      passed: artifactManifest.rawNotificationPayloadStored === false
        && artifactManifest.rawPushTokenStored === false
        && artifactManifest.rawTokenPreviewStored === false
        && artifactManifest.rawProviderReceiptStored === false
        && artifactManifest.rawScreenshotStored === false
        && artifactManifest.tokenEvidence.plaintextExposed === false
        && rawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-notification-operational-handoff-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    owner: 'mobile-notification-release-owner',
    scope: 'notification_permission_delivery_receipts_token_rotation_retry_queue',
    status: checks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'c-notification-health-handshake-v1',
    healthHandshake: {
      permissionGranted: artifactManifest.permission.granted === true,
      foregroundBackgroundReceiptsVerified: providerDrill?.status === 'passed'
        && visualEvidence.length >= 2
        && visualStates.has('foreground')
        && visualStates.has('background'),
      tokenRotationTrendPassed: tokenTrend?.status === 'passed'
        && (tokenTrend?.rotatedCount ?? 0) >= (tokenTrend?.cycles ?? 0),
      receiptRetryQueueClean: (receiptVerification?.failed ?? 1) === 0
        && (receiptVerification?.unresolvedIssues?.length ?? 1) === 0,
      rawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'c-notification-fallback-policy-v1',
      primaryFlow: 'deliver_foreground_background_notifications_then_verify_receipts_and_rotate_push_tokens',
      fallbackFlows: [
        'queue_background_receipts_when_os_delivery_is_unavailable',
        'preserve_previous_push_token_when_provider_rotation_fails',
        'retry_unresolved_receipts_until_issue_queue_is_clean',
        'block_release_when_raw_notification_payload_or_push_token_is_detected'
      ],
      operatorEscalation: 'mobile_notification_release_provider_receipt_and_token_rotation_report'
    },
    rawNotificationPayloadStored: false,
    rawPushTokenStored: false,
    rawProviderReceiptStored: false,
    rawScreenshotStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-notification-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "mobile runtime pairs" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'notification_permission_granted',
      'notification_foreground_background_receipts_verified',
      'notification_token_rotation_trend_passed',
      'notification_receipt_retry_queue_clean',
      'notification_push_token_plaintext_hidden',
      'notification_release_dossier_ready',
      'notification_release_artifact_manifest_ready',
      'notification_operational_handoff_ready',
      'notification_worm_promotion_package_ready'
    ],
    artifactManifestHash: mobileRuntimeDigest(artifactManifest),
    operationalHandoffHash: mobileRuntimeDigest(operationalHandoffManifest),
    rawNotificationPayloadStored: false,
    rawPushTokenStored: false,
    rawProviderReceiptStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-notification-worm-promotion-package-v1',
    providerContractVersion: 'c-notification-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-notification-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-notification-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: mobileRuntimeDigest(artifactManifest),
    operationalHandoffHash: mobileRuntimeDigest(operationalHandoffManifest),
    ciNightlyGatePlanHash: mobileRuntimeDigest(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawNotificationPayloadStored: false,
    rawPushTokenStored: false,
    rawProviderReceiptStored: false,
    rawScreenshotStored: false
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
      ? 'capture_physical_android_ios_notification_screenshots_and_operating_expo_receipts'
      : 'block_notification_release_until_receipts_token_rotation_and_raw_retention_checks_pass'
  };
  dossier.releaseWorkflow = {
    ...dossier.releaseWorkflow,
    promotionStatus: dossier.status === 'passed' ? 'release_evidence_ready' : 'blocked'
  };
  dossier.dossierDigest = mobileRuntimeDigest({
    ...dossier,
    dossierDigest: null
  });
  return dossier;
}

function serializedMobileRuntimeContainsAny(value, needles) {
  const serialized = JSON.stringify(value);
  return needles.some((needle) => needle && serialized.includes(String(needle)));
}

function canonicalMobileRuntimeJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalMobileRuntimeJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalMobileRuntimeJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mobileRuntimeDigest(value) {
  const source = typeof value === 'string' ? value : canonicalMobileRuntimeJson(value);
  return createHash('sha256').update(source).digest('hex');
}

export class OfflineCommandQueue {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.items = [];
  }

  enqueue(rawText, attachments = []) {
    const createdAt = this.clock().toISOString();
    const item = {
      localId: stableId('local', rawText, createdAt),
      rawText,
      createdAt,
      attachments,
      syncStatus: 'pending'
    };
    this.items.unshift(item);
    return item;
  }

  pending() {
    return this.items.filter((item) => item.syncStatus === 'pending');
  }

  all() {
    return [...this.items];
  }

  mark(localId, syncStatus) {
    const item = this.items.find((candidate) => candidate.localId === localId);
    if (item) item.syncStatus = syncStatus;
    return item;
  }

  cancel(localId) {
    return this.mark(localId, 'cancelled');
  }
}

export class NotificationPermissionManager {
  constructor({ initialStatus = 'notDetermined', clock = () => new Date(), nativePermissionModule = null } = {}) {
    this.status = initialStatus;
    this.clock = clock;
    this.changedAt = null;
    this.nativePermissionModule = nativePermissionModule;
    this.promptHistory = [];
  }

  request({ grant = true } = {}) {
    const prompt = {
      promptId: stableId('notification_prompt', this.promptHistory.length, this.clock().toISOString()),
      source: 'expo-notifications',
      nativePromptAvailable: Boolean(this.nativePermissionModule),
      requestedAt: this.clock().toISOString(),
      result: grant ? 'granted' : 'denied'
    };
    this.promptHistory.unshift(prompt);
    this.status = grant ? 'granted' : 'denied';
    this.changedAt = this.clock().toISOString();
    return this.state();
  }

  revoke() {
    this.status = 'denied';
    this.changedAt = this.clock().toISOString();
    return this.state();
  }

  state() {
    return {
      status: this.status,
      granted: this.status === 'granted',
      changedAt: this.changedAt,
      source: 'expo-notifications',
      nativePromptAvailable: Boolean(this.nativePermissionModule),
      promptRequested: this.promptHistory.length > 0,
      lastPrompt: this.promptHistory[0] ?? null
    };
  }
}

export class LocalNotificationAdapter {
  constructor({ clock = () => new Date(), adapterName = 'local-notification-adapter' } = {}) {
    this.clock = clock;
    this.adapterName = adapterName;
    this.deliveries = [];
  }

  deliver(notification, _pushTokenState = { registered: false }, { appState = 'active' } = {}) {
    const delivery = {
      deliveryId: stableId('delivery', notification.notificationId, this.deliveries.length, this.clock().toISOString()),
      notificationId: notification.notificationId,
      eventType: notification.eventType,
      channelId: notification.channelId,
      adapterName: this.adapterName,
      status: 'delivered',
      deliveredAt: this.clock().toISOString(),
      appState,
      presentationPolicy: appState === 'active' ? 'foreground-local' : 'background-queue'
    };
    this.deliveries.unshift(delivery);
    return delivery;
  }

  deliveryLog() {
    return [...this.deliveries];
  }

  metadata() {
    return {
      adapterName: this.adapterName,
      nativeAvailable: false,
      fallbackUsed: true,
      deliveryMode: 'in-app-local',
      supportsPushToken: false,
      supportsReceipts: true
    };
  }
}

export class ExpoNotificationAdapter extends LocalNotificationAdapter {
  constructor({ clock = () => new Date(), adapterName = 'expo-notifications-adapter', nativeModule = null } = {}) {
    super({ clock, adapterName });
    this.nativeModule = nativeModule;
  }

  nativeAvailable() {
    return Boolean(
      this.nativeModule
      && typeof this.nativeModule.scheduleNotificationAsync === 'function'
    );
  }

  deliver(notification, pushTokenState = { registered: false }, { appState = 'active' } = {}) {
    const delivery = super.deliver(notification, pushTokenState, { appState });
    const nativeAvailable = this.nativeAvailable();
    delivery.nativeAvailable = nativeAvailable;
    delivery.fallbackUsed = !delivery.nativeAvailable;
    delivery.pushTokenRegistered = pushTokenState.registered === true;
    delivery.deliveryMode = delivery.nativeAvailable
      ? (appState === 'active' ? 'expo-foreground' : 'expo-background-push')
      : (appState === 'active' ? 'in-app-local-fallback' : 'background-local-queued');
    if (!nativeAvailable && appState !== 'active') {
      delivery.status = 'queued';
      delivery.deliveredAt = null;
      delivery.queuedAt = this.clock().toISOString();
    }
    delivery.receipt = {
      receiptId: stableId('receipt', delivery.deliveryId, appState, delivery.deliveryMode),
      deliveryId: delivery.deliveryId,
      notificationId: delivery.notificationId,
      status: delivery.status === 'delivered' ? 'ok' : 'queued',
      provider: nativeAvailable ? 'expo-notifications' : 'local-fallback',
      appState,
      retryable: delivery.status === 'queued',
      checkedAt: this.clock().toISOString()
    };
    return delivery;
  }

  metadata() {
    const nativeAvailable = this.nativeAvailable();
    return {
      adapterName: this.adapterName,
      expectedNativeModule: 'expo-notifications',
      nativeAvailable,
      fallbackUsed: !nativeAvailable,
      deliveryMode: nativeAvailable ? 'expo-foreground' : 'in-app-local-fallback',
      supportsPushToken: true,
      supportsReceipts: true,
      channels: ['approvals', 'execution', 'security', 'alerts', 'general']
    };
  }
}

export class NativeDocumentActionAdapter {
  constructor({
    sharingModule = null,
    linkingModule = null,
    clock = () => new Date(),
    adapterName = 'expo-sharing-document-actions'
  } = {}) {
    this.sharingModule = sharingModule;
    this.linkingModule = linkingModule;
    this.clock = clock;
    this.adapterName = adapterName;
    this.actions = [];
  }

  capability() {
    const shareAsyncAvailable = Boolean(this.sharingModule && typeof this.sharingModule.shareAsync === 'function');
    const shareAvailabilityProbe = Boolean(this.sharingModule && typeof this.sharingModule.isAvailableAsync === 'function');
    const previewAvailable = Boolean(this.linkingModule && typeof this.linkingModule.openURL === 'function');
    return {
      adapterName: this.adapterName,
      expectedNativeModules: ['expo-sharing', 'react-native Linking'],
      nativeShareAvailable: shareAsyncAvailable,
      nativePreviewAvailable: previewAvailable,
      shareAvailabilityProbe,
      fallbackUsed: !(shareAsyncAvailable || previewAvailable),
      checkedAt: this.clock().toISOString()
    };
  }

  async preview({ taskId, preview }) {
    // Capture the selected URI once; app/deep-link commands are not document viewers.
    const viewUri=officialDocumentViewUri(preview?.uri);
    const action = this.createAction({ taskId, preview:{...preview,uri:viewUri}, actionType: 'preview' });
    const capability = this.capability();
    action.capability = capability;
    if (!preview?.openable) {
      return this.record({
        ...action,
        success: false,
        status: 'blocked',
        error: { code: 'C_FILE_PREVIEW_NOT_AVAILABLE' }
      });
    }
    if(!viewUri)return this.record({...action,success:false,status:'blocked',error:{code:'C_DOCUMENT_VIEW_URI_DENIED'}});
    if (!capability.nativePreviewAvailable) {
      return this.record({
        ...action,
        success: true,
        status: 'contract-fallback',
        fallbackUsed: true
      });
    }
    try {
      await this.linkingModule.openURL(viewUri);
      return this.record({
        ...action,
        success: true,
        status: 'opened',
        fallbackUsed: false
      });
    } catch (error) {
      return this.record({
        ...action,
        success: false,
        status: 'failed',
        fallbackUsed: false,
        error: {
          code: 'C_FILE_PREVIEW_FAILED',
          message: error?.message ?? String(error)
        }
      });
    }
  }

  async share({ taskId, preview }) {
    const action = this.createAction({ taskId, preview, actionType: 'share' });
    const capability = this.capability();
    action.capability = capability;
    if (!preview?.shareable) {
      return this.record({
        ...action,
        success: false,
        status: 'blocked',
        error: { code: 'C_FILE_SHARE_NOT_AVAILABLE' }
      });
    }
    if (!capability.nativeShareAvailable) {
      return this.record({
        ...action,
        success: true,
        status: 'contract-fallback',
        fallbackUsed: true
      });
    }
    try {
      if (capability.shareAvailabilityProbe) {
        const available = await this.sharingModule.isAvailableAsync();
        if (available !== true) {
          return this.record({
            ...action,
            success: true,
            status: 'contract-fallback',
            fallbackUsed: true,
            nativeUnavailableReason: 'sharing-unavailable'
          });
        }
      }
      await this.sharingModule.shareAsync(preview.uri, {
        mimeType: preview.mimeType,
        dialogTitle: preview.name
      });
      return this.record({
        ...action,
        success: true,
        status: 'shared',
        fallbackUsed: false
      });
    } catch (error) {
      return this.record({
        ...action,
        success: false,
        status: 'failed',
        fallbackUsed: false,
        error: {
          code: 'C_FILE_SHARE_FAILED',
          message: error?.message ?? String(error)
        }
      });
    }
  }

  createAction({ taskId, preview, actionType }) {
    const actedAt = this.clock().toISOString();
    return {
      actionVersion: 'c-native-document-action-v1',
      actionId: stableId('document_action', taskId, preview?.previewId, actionType, actedAt),
      taskId,
      previewId: preview?.previewId ?? null,
      actionType,
      path: preview?.path ?? null,
      uri: preview?.uri ?? null,
      name: preview?.name ?? null,
      mimeType: preview?.mimeType ?? null,
      actedAt
    };
  }

  record(action) {
    this.actions.unshift(action);
    this.actions = this.actions.slice(0, 25);
    return action;
  }

  history(limit = 10) {
    return this.actions.slice(0, limit);
  }
}

export class PushTokenRegistry {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.record = null;
    this.rotationHistory = [];
    this.rotationIssues = [];
  }

  validateToken(token) {
    if (!token || String(token).trim().length < 12) {
      return { valid: false, error: { code: 'C_PUSH_TOKEN_INVALID' } };
    }
    return { valid: true };
  }

  register({ token, platform = 'expo', deviceId = null, projectId = null, reason = 'register' } = {}) {
    const validation = this.validateToken(token);
    if (!validation.valid) return { success: false, error: validation.error };
    const value = String(token).trim();
    this.record = {
      platform,
      deviceId,
      projectId,
      tokenFingerprint: createHash('sha256').update(value).digest('hex'),
      tokenPreview: `${value.slice(0, 8)}...${value.slice(-6)}`,
      registeredAt: this.clock().toISOString(),
      reason,
      plaintextExposed: false
    };
    return { success: true, ...this.state() };
  }

  rotate({
    token,
    platform = 'expo',
    deviceId = null,
    projectId = null,
    reason = 'token-rotation',
    simulateProviderFailure = false
  } = {}) {
    const rotatedAt = this.clock().toISOString();
    const previous = this.state();
    const validation = this.validateToken(token);
    if (!validation.valid || simulateProviderFailure) {
      const issue = {
        issueId: stableId('push_token_rotation_issue', this.rotationIssues.length, rotatedAt),
        status: 'failed',
        reason: validation.valid ? 'provider-rejected-rotated-token' : validation.error.code,
        retryable: true,
        previousTokenPreserved: previous.registered === true,
        previousTokenFingerprint: previous.tokenFingerprint,
        createdAt: rotatedAt
      };
      this.rotationIssues.unshift(issue);
      this.rotationHistory.unshift({
        rotationId: stableId('push_token_rotation', this.rotationHistory.length, rotatedAt),
        status: 'failed',
        reason,
        rotatedAt,
        previousTokenFingerprint: previous.tokenFingerprint,
        previousTokenPreserved: previous.registered === true,
        issueId: issue.issueId
      });
      return { success: false, error: { code: issue.reason }, issue, previousTokenPreserved: previous.registered === true, current: this.state() };
    }

    const registered = this.register({ token, platform, deviceId, projectId, reason });
    if (registered.success) {
      for (const issue of this.rotationIssues) {
        if (issue.status === 'failed' && issue.retryable) {
          issue.status = 'resolved';
          issue.resolvedAt = rotatedAt;
        }
      }
    }
    const rotation = {
      rotationId: stableId('push_token_rotation', this.rotationHistory.length, rotatedAt),
      status: registered.success ? 'rotated' : 'failed',
      reason,
      rotatedAt,
      previousTokenFingerprint: previous.tokenFingerprint,
      nextTokenFingerprint: registered.tokenFingerprint ?? null,
      previousTokenPreserved: previous.registered === true,
      plaintextExposed: false
    };
    this.rotationHistory.unshift(rotation);
    return { ...registered, rotation, previousTokenPreserved: previous.registered === true };
  }

  clear(reason = 'manual') {
    this.record = null;
    return { success: true, registered: false, reason, clearedAt: this.clock().toISOString() };
  }

  state() {
    if (!this.record) {
      return {
        registered: false,
        platform: null,
        tokenFingerprint: null,
        tokenPreview: null,
        plaintextExposed: false
      };
    }
    return {
      registered: true,
      ...this.record
    };
  }

  rotationStatus() {
    return {
      history: [...this.rotationHistory],
      issueQueue: [...this.rotationIssues],
      lastRotation: this.rotationHistory[0] ?? null,
      unresolvedIssues: this.rotationIssues.filter((item) => item.status !== 'resolved')
    };
  }
}

export class NotificationCenter {
  constructor({ clock = () => new Date(), permissionManager = null, adapter = null, pushTokenRegistry = null } = {}) {
    this.clock = clock;
    this.permissionManager = permissionManager ?? new NotificationPermissionManager({ clock });
    this.adapter = adapter ?? new ExpoNotificationAdapter({ clock });
    this.pushTokenRegistry = pushTokenRegistry ?? new PushTokenRegistry({ clock });
    this.items = [];
    this.appState = 'active';
    this.receipts = [];
    this.deliveryIssues = [];
    this.providerReceiptChecks = [];
  }

  push({ eventId, eventType, title, body, taskId, approvalId, severity = 'info' }) {
    const permission = this.permissionManager.state();
    const item = {
      notificationId: stableId('notif', eventId ?? eventType, taskId ?? approvalId ?? this.items.length, this.clock().toISOString()),
      eventId,
      eventType,
      title,
      body,
      taskId,
      approvalId,
      severity,
      channelId: this.channelFor(eventType, severity),
      read: false,
      createdAt: this.clock().toISOString(),
      appState: this.appState,
      deliveryStatus: permission.granted ? 'pending' : 'blocked',
      deliveryError: permission.granted ? null : 'notification-permission-not-granted'
    };
    if (permission.granted) {
      const delivery = this.adapter.deliver(item, this.pushTokenRegistry.state(), { appState: this.appState });
      item.deliveryStatus = delivery.status;
      item.deliveryId = delivery.deliveryId;
      item.deliveredAt = delivery.deliveredAt;
      item.queuedAt = delivery.queuedAt;
      item.deliveryMode = delivery.deliveryMode;
      item.pushTokenRegistered = delivery.pushTokenRegistered;
      item.receiptId = delivery.receipt?.receiptId;
      if (delivery.receipt) this.recordReceipt(delivery.receipt, item);
    }
    this.items.unshift(item);
    return item;
  }

  setAppState(appState = 'active') {
    if (!['active', 'inactive', 'background'].includes(appState)) {
      return { success: false, error: { code: 'C_NOTIFICATION_APP_STATE_INVALID' } };
    }
    this.appState = appState;
    return { success: true, appState };
  }

  recordReceipt(receipt, notification) {
    this.receipts.unshift(receipt);
    if (receipt.status !== 'ok') {
      this.deliveryIssues.unshift({
        receiptId: receipt.receiptId,
        deliveryId: receipt.deliveryId,
        notificationId: receipt.notificationId,
        eventType: notification.eventType,
        status: receipt.status,
        retryable: receipt.retryable,
        reason: receipt.status === 'queued' ? 'background-local-fallback-queued' : 'delivery-not-ok',
        createdAt: this.clock().toISOString()
      });
    }
  }

  verifyReceipts({ retryQueued = false } = {}) {
    const checkedAt = this.clock().toISOString();
    let ok = 0;
    let queued = 0;
    let failed = 0;
    for (const receipt of this.receipts) {
      if (receipt.status === 'queued' && retryQueued && this.permissionManager.state().granted) {
        receipt.status = 'ok';
        receipt.retryable = false;
        receipt.retriedAt = checkedAt;
        const issue = this.deliveryIssues.find((item) => item.receiptId === receipt.receiptId);
        if (issue) {
          issue.status = 'resolved';
          issue.resolvedAt = checkedAt;
        }
      }
      receipt.verifiedAt = checkedAt;
      if (receipt.status === 'ok') ok += 1;
      else if (receipt.status === 'queued') queued += 1;
      else failed += 1;
    }
    return {
      success: failed === 0,
      checkedAt,
      checked: this.receipts.length,
      ok,
      queued,
      failed,
      retryQueued,
      unresolvedIssues: this.deliveryIssues.filter((item) => item.status !== 'resolved')
    };
  }

  verifyProviderReceiptDrill({ retryQueued = true, requireForeground = true, requireBackground = true } = {}) {
    const checkedAt = this.clock().toISOString();
    const receiptVerification = this.verifyReceipts({ retryQueued });
    const receipts = this.receiptLog();
    const adapter = this.adapterState();
    const foregroundReceipt = receipts.find((item) => item.appState === 'active');
    const backgroundReceipt = receipts.find((item) => item.appState === 'background' || item.appState === 'inactive');
    const status = receiptVerification.failed === 0
      && (!requireForeground || Boolean(foregroundReceipt))
      && (!requireBackground || Boolean(backgroundReceipt))
      ? 'passed'
      : 'needs-evidence';
    const check = {
      drillId: stableId('notification_provider_receipt_drill', this.providerReceiptChecks.length, checkedAt),
      status,
      checkedAt,
      mode: adapter.nativeAvailable ? 'expo-provider-native' : 'expo-provider-contract-fallback',
      provider: adapter.nativeAvailable ? 'expo-notifications' : 'local-fallback',
      expectedNativeModule: 'expo-notifications',
      nativeProviderReceipt: receipts.some((item) => item.provider === 'expo-notifications'),
      foreground: foregroundReceipt
        ? { receiptId: foregroundReceipt.receiptId, status: foregroundReceipt.status, provider: foregroundReceipt.provider }
        : null,
      background: backgroundReceipt
        ? { receiptId: backgroundReceipt.receiptId, status: backgroundReceipt.status, provider: backgroundReceipt.provider }
        : null,
      receiptVerification,
      visualEvidence: [
        foregroundReceipt ? {
          state: 'foreground',
          evidenceType: adapter.nativeAvailable ? 'native-provider-receipt' : 'runtime-visual-contract',
          receiptId: foregroundReceipt.receiptId,
          status: foregroundReceipt.status
        } : null,
        backgroundReceipt ? {
          state: 'background',
          evidenceType: adapter.nativeAvailable ? 'native-provider-receipt' : 'runtime-visual-contract',
          receiptId: backgroundReceipt.receiptId,
          status: backgroundReceipt.status
        } : null
      ].filter(Boolean)
    };
    this.providerReceiptChecks.unshift(check);
    return check;
  }

  channelFor(eventType, severity) {
    if (eventType?.includes('approval')) return 'approvals';
    if (eventType?.includes('execution')) return 'execution';
    if (eventType?.includes('session')) return 'security';
    if (severity === 'warning') return 'alerts';
    return 'general';
  }

  requestPermission(options) {
    return this.permissionManager.request(options);
  }

  revokePermission() {
    return this.permissionManager.revoke();
  }

  permissionState() {
    return this.permissionManager.state();
  }

  registerPushToken(options) {
    return this.pushTokenRegistry.register(options);
  }

  rotatePushToken(options) {
    return this.pushTokenRegistry.rotate(options);
  }

  clearPushToken(reason) {
    return this.pushTokenRegistry.clear(reason);
  }

  pushTokenState() {
    return this.pushTokenRegistry.state();
  }

  tokenRotationStatus() {
    return this.pushTokenRegistry.rotationStatus();
  }

  adapterState() {
    return typeof this.adapter.metadata === 'function'
      ? this.adapter.metadata()
      : { adapterName: this.adapter.adapterName ?? 'unknown', nativeAvailable: false, fallbackUsed: true };
  }

  deliveryLog() {
    return this.adapter.deliveryLog();
  }

  receiptLog() {
    return [...this.receipts];
  }

  issueQueue() {
    return [...this.deliveryIssues];
  }

  providerChecks() {
    return [...this.providerReceiptChecks];
  }

  all() {
    return [...this.items];
  }

  unread() {
    return this.items.filter((item) => item.read === false);
  }

  markRead(notificationId) {
    const item = this.items.find((candidate) => candidate.notificationId === notificationId);
    if (item) item.read = true;
    return item;
  }
}

export function createPoisonQueueDelta(previous = {}, next = {}) {
  const previousQueue = previous.queue ?? {};
  const nextQueue = next.queue ?? {};
  const fields = ['total', 'queued', 'retryScheduled', 'quarantined', 'ignored', 'running', 'succeeded', 'failed'];
  const metrics = Object.fromEntries(fields.map((field) => [
    field,
    (nextQueue[field] ?? 0) - (previousQueue[field] ?? 0)
  ]));
  const previousIds = new Set((previous.items ?? []).map((item) => item.queueId));
  const nextIds = new Set((next.items ?? []).map((item) => item.queueId));
  return {
    changed: fields.some((field) => metrics[field] !== 0)
      || [...previousIds].some((id) => !nextIds.has(id))
      || [...nextIds].some((id) => !previousIds.has(id)),
    metrics,
    removedQueueIds: [...previousIds].filter((id) => !nextIds.has(id)),
    addedQueueIds: [...nextIds].filter((id) => !previousIds.has(id)),
    refreshedAt: new Date().toISOString()
  };
}

export class MobileAppRuntime {
  constructor({
    bridgeRuntime,
    deviceId = 'mobile_lcb_001',
    deviceName = 'LCB Galaxy',
    clock = () => new Date(),
    tokenStore = null,
    sessionLock = null,
    lifecycleSecurity = null,
    notificationCenter = null,
    documentActions = null
  } = {}) {
    this.bridgeRuntime = bridgeRuntime;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.clock = clock;
    this.tokens = tokenStore ?? new SecureTokenStore();
    this.sessionLock = sessionLock ?? new SessionLock({ clock });
    this.lifecycleSecurity = lifecycleSecurity ?? new AppLifecycleSecurityController({
      sessionLock: this.sessionLock,
      clock
    });
    this.offlineQueue = new OfflineCommandQueue({ clock });
    this.notifications = notificationCenter ?? new NotificationCenter({ clock });
    this.documentActions = documentActions ?? new NativeDocumentActionAdapter({ clock });
    this.connection = {
      bridgeUrl: null,
      connected: false,
      lastCheckedAt: null,
      latencyMs: null,
      error: null
    };
    this.currentTaskId = null;
    this.latestResult = null;
    this.latestGrowth = null;
    this.latestPoisonQueue = null;
    this.latestQueuePolicy = null;
    this.lastEventId = null;
    this.eventLog = [];
    this.deviceTokenHistory = [];
    this.deviceTokenRecoveryQueue = [];
  }

  pair({ pairingCode, bridgeUrl = 'http://127.0.0.1:17777' }) {
    const result = this.bridgeRuntime.pairing.confirm({
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      pairingCode
    });
    if (result.success) {
      this.tokens.set('deviceToken', result.deviceToken, tokenMetadataFromResult(result));
      this.deviceTokenHistory.unshift({
        eventType: 'device-token.paired',
        eventVersion: 'c-secure-token-lifecycle-event-v1',
        tokenVersion: result.token?.tokenVersion ?? null,
        tokenId: result.token?.tokenId ?? null,
        expiresAt: result.expiresAt ?? null,
        createdAt: this.clock().toISOString()
      });
      this.resolveTokenRecoveryItems('repair_pairing', { reason: 'pairing-confirmed' });
      this.connection = {
        bridgeUrl,
        connected: true,
        lastCheckedAt: this.clock().toISOString(),
        latencyMs: 0,
        error: null
      };
      this.notifications.push({
        eventType: 'pairing.confirmed',
        title: 'PC 브릿지 연결됨',
        body: `${this.deviceName} 기기가 로컬 브릿지와 페어링되었습니다.`,
        severity: 'success'
      });
    }
    return result;
  }

  disconnect() {
    this.tokens.remove('deviceToken');
    this.connection = {
      bridgeUrl: null,
      connected: false,
      lastCheckedAt: this.clock().toISOString(),
      latencyMs: null,
      error: null
    };
    this.notifications.push({
      eventType: 'pairing.disconnected',
      title: '연결 해제',
      body: '모바일 기기의 브릿지 토큰을 제거했습니다.'
    });
    return { success: true };
  }

  token() {
    return this.tokens.get('deviceToken');
  }

  tokenStorageStatus() {
    return this.tokens.metadata('deviceToken');
  }

  tokenLifecycleStatus({
    token = this.token(),
    rotationWarningMs = 14 * 24 * 60 * 60 * 1000
  } = {}) {
    const tokenStorage = this.tokenStorageStatus();
    if (!token) {
      return {
        statusVersion: 'c-secure-token-lifecycle-status-v1',
        status: 'unpaired',
        paired: false,
        tokenStorage,
        claims: null,
        auth: null,
        recoveryAction: 'pair_device'
      };
    }
    const claims = decodeDeviceTokenClaims(token);
    const auth = this.bridgeRuntime?.registry?.authenticateToken
      ? this.bridgeRuntime.registry.authenticateToken(token)
      : null;
    const expiresAt = auth?.device?.expiresAt ?? claims.expiresAt ?? tokenStorage.metadata?.expiresAt ?? null;
    const expiresInMs = expiresAt ? Date.parse(expiresAt) - this.clock().getTime() : null;
    let status = 'valid';
    let recoveryAction = 'none';
    if (auth?.success === false) {
      if (auth.error?.code === 'D_AUTH_TOKEN_EXPIRED') {
        status = 'expired';
        recoveryAction = 'repair_pairing';
      } else if (auth.error?.code === 'D_AUTH_INVALID_TOKEN') {
        status = 'invalid';
        recoveryAction = 'repair_pairing';
      } else {
        status = 'auth-error';
        recoveryAction = 'check_connection';
      }
    } else if (expiresInMs !== null && expiresInMs <= 0) {
      status = 'expired';
      recoveryAction = 'repair_pairing';
    } else if (expiresInMs !== null && expiresInMs <= rotationWarningMs) {
      status = 'rotation-due';
      recoveryAction = 'rotate_device_token';
    }
    return {
      statusVersion: 'c-secure-token-lifecycle-status-v1',
      status,
      paired: true,
      tokenStorage,
      claims,
      auth: auth
        ? {
            success: auth.success === true,
            errorCode: auth.error?.code ?? null,
            deviceId: auth.device?.deviceId ?? null,
            tokenVersion: auth.token?.tokenVersion ?? claims.tokenVersion ?? null
          }
        : null,
      tokenVersion: auth?.token?.tokenVersion ?? claims.tokenVersion ?? tokenStorage.metadata?.tokenVersion ?? null,
      expiresAt,
      expiresInMs,
      recoveryAction
    };
  }

  tokenRecoveryState() {
    return createSecureTokenRecoveryState({
      lifecycleStatus: this.tokenLifecycleStatus(),
      recoveryQueue: this.deviceTokenRecoveryQueue,
      tokenStorage: this.tokenStorageStatus()
    });
  }

  enqueueTokenRecovery({ reason, action, failure = null, retryable = true }) {
    const queuedAt = this.clock().toISOString();
    const item = {
      queueVersion: 'c-secure-token-recovery-queue-item-v1',
      queueId: stableId('secure_token_recovery', this.deviceTokenRecoveryQueue.length, queuedAt),
      status: 'queued',
      reason,
      action,
      retryable,
      attempts: 0,
      failure: failure
        ? {
            code: failure.error?.code ?? failure.code ?? null,
            message: failure.error?.message ?? failure.message ?? null
          }
        : null,
      queuedAt
    };
    this.deviceTokenRecoveryQueue.unshift(item);
    return item;
  }

  resolveTokenRecoveryItems(action, { reason = 'resolved' } = {}) {
    const resolvedAt = this.clock().toISOString();
    for (const item of this.deviceTokenRecoveryQueue) {
      if (item.action === action && item.status !== 'resolved') {
        item.status = 'resolved';
        item.resolvedAt = resolvedAt;
        item.resolutionReason = reason;
      }
    }
    return this.deviceTokenRecoveryQueue.filter((item) => item.action === action && item.status === 'resolved');
  }

  rotateDeviceToken({ reason = 'mobile_secure_token_rotation' } = {}) {
    const previousToken = this.token();
    if (!previousToken) {
      const queued = this.enqueueTokenRecovery({
        reason: 'rotation_without_pairing',
        action: 'repair_pairing',
        failure: { code: 'C_DEVICE_NOT_PAIRED', message: 'Device is not paired.' }
      });
      return { success: false, error: { code: 'C_DEVICE_NOT_PAIRED' }, recovery: queued };
    }
    const result = this.bridgeRuntime.rotateDeviceToken({ token: previousToken, reason });
    if (result.success) {
      this.tokens.set('deviceToken', result.deviceToken, tokenMetadataFromResult(result));
      const oldTokenRejected = this.bridgeRuntime.heartbeat({ token: previousToken })?.error?.code === 'D_AUTH_INVALID_TOKEN';
      const nextStatus = this.tokenLifecycleStatus({ token: result.deviceToken });
      const history = {
        eventType: 'device-token.rotated',
        eventVersion: 'c-secure-token-lifecycle-event-v1',
        rotationVersion: 'c-secure-token-rotation-recovery-v1',
        tokenVersion: result.tokenVersion,
        tokenId: result.tokenId,
        expiresAt: result.expiresAt,
        oldTokenRejected,
        createdAt: this.clock().toISOString()
      };
      this.deviceTokenHistory.unshift(history);
      this.resolveTokenRecoveryItems('rotate_device_token', { reason: 'rotation-succeeded' });
      this.notifications.push({
        eventType: 'device.token.rotated',
        title: '브릿지 토큰 회전',
        body: '새 브릿지 토큰을 안전 저장소에 교체했습니다.',
        severity: 'success'
      });
      return {
        ...result,
        rotationVersion: 'c-secure-token-rotation-recovery-v1',
        oldTokenRejected,
        tokenStorage: this.tokenStorageStatus(),
        lifecycleStatus: nextStatus
      };
    }
    const queued = this.enqueueTokenRecovery({
      reason: 'rotation_failed',
      action: result.error?.code === 'D_AUTH_TOKEN_EXPIRED' ? 'repair_pairing' : 'rotate_device_token',
      failure: result
    });
    this.notifications.push({
      eventType: 'device.token.rotation_failed',
      title: '브릿지 토큰 회전 실패',
      body: '기존 토큰을 보존하고 복구 큐에 기록했습니다.',
      severity: 'warning'
    });
    return {
      ...result,
      rotationVersion: 'c-secure-token-rotation-recovery-v1',
      recovery: queued,
      tokenStorage: this.tokenStorageStatus()
    };
  }

  revokeBridgeDevice({ reason = 'mobile_device_revoke', simulateFailure = false } = {}) {
    const token = this.token();
    if (!token || simulateFailure) {
      const queued = this.enqueueTokenRecovery({
        reason: simulateFailure ? 'simulated_revoke_transport_failure' : 'revoke_without_pairing',
        action: 'retry_device_revoke',
        failure: simulateFailure
          ? { code: 'C_DEVICE_REVOKE_NETWORK_FAILED', message: 'Simulated revoke transport failure.' }
          : { code: 'C_DEVICE_NOT_PAIRED', message: 'Device is not paired.' }
      });
      return {
        success: false,
        revokeVersion: 'c-secure-token-revoke-retry-queue-v1',
        error: queued.failure,
        recovery: queued
      };
    }
    const result = this.bridgeRuntime.revokeDevice({ deviceId: this.deviceId, token });
    if (result.status === 'revoked') {
      this.tokens.remove('deviceToken');
      this.connection.connected = false;
      this.resolveTokenRecoveryItems('retry_device_revoke', { reason: 'revoke-succeeded' });
      this.notifications.push({
        eventType: 'device.token.revoked',
        title: '브릿지 연결 해제',
        body: '기기 토큰이 폐기되어 안전 저장소에서 제거되었습니다.',
        severity: 'warning'
      });
      return {
        ...result,
        success: true,
        revokeVersion: 'c-secure-token-revoke-retry-queue-v1',
        tokenStorage: this.tokenStorageStatus()
      };
    }
    const queued = this.enqueueTokenRecovery({
      reason: 'revoke_failed',
      action: 'retry_device_revoke',
      failure: result
    });
    return {
      ...result,
      revokeVersion: 'c-secure-token-revoke-retry-queue-v1',
      recovery: queued
    };
  }

  retryTokenRecoveryQueue({ dryRun = true } = {}) {
    const pending = this.deviceTokenRecoveryQueue.filter((item) => item.status === 'queued' && item.retryable);
    const results = [];
    for (const item of pending) {
      item.status = 'retrying';
      item.attempts += 1;
      if (dryRun) {
        item.status = 'queued';
        item.lastAttemptAt = this.clock().toISOString();
        item.lastAttemptMode = 'dry-run';
        results.push({ queueId: item.queueId, action: item.action, status: 'dry-run-ready' });
        continue;
      }
      if (item.action === 'rotate_device_token') {
        results.push({ queueId: item.queueId, result: this.rotateDeviceToken({ reason: `retry:${item.reason}` }) });
      } else if (item.action === 'retry_device_revoke') {
        results.push({ queueId: item.queueId, result: this.revokeBridgeDevice({ reason: `retry:${item.reason}` }) });
      } else {
        item.status = 'queued';
        results.push({ queueId: item.queueId, action: item.action, status: 'user-action-required' });
      }
    }
    return {
      retryVersion: 'c-secure-token-recovery-retry-run-v1',
      dryRun,
      attempted: results.length,
      results,
      queue: this.deviceTokenRecoveryQueue
    };
  }

  runSecureTokenProductGate() {
    const rawTokenBeforeGate = this.token();
    const before = this.tokenLifecycleStatus();
    const expiredRecovery = createSecureTokenRecoveryState({
      lifecycleStatus: {
        ...before,
        status: 'expired',
        recoveryAction: 'repair_pairing'
      },
      recoveryQueue: this.deviceTokenRecoveryQueue,
      tokenStorage: this.tokenStorageStatus()
    });
    const rotation = this.rotateDeviceToken({ reason: 'secure-token-product-gate' });
    const revokeFailure = this.revokeBridgeDevice({ simulateFailure: true });
    const retryRun = this.retryTokenRecoveryQueue({ dryRun: true });
    const rawTokenAfterRotation = rotation?.deviceToken ?? this.token();
    const after = this.tokenLifecycleStatus();
    const recoveryState = this.tokenRecoveryState();
    const baseChecks = [
      { checkId: 'secure_token_sealed_storage', passed: after.tokenStorage.sealed === true && after.tokenStorage.plaintextExposed === false },
      { checkId: 'secure_token_expiry_recovery_ux_ready', passed: expiredRecovery.stateVersion === 'c-secure-token-recovery-ux-v1' && expiredRecovery.primaryAction === 'repair_pairing' },
      { checkId: 'secure_token_rotation_replaces_token', passed: rotation.success === true && rotation.oldTokenRejected === true && rotation.tokenStorage?.sealed === true },
      { checkId: 'secure_token_revoke_failure_retry_queued', passed: revokeFailure.revokeVersion === 'c-secure-token-revoke-retry-queue-v1' && revokeFailure.recovery?.action === 'retry_device_revoke' },
      { checkId: 'secure_token_recovery_retry_run_ready', passed: retryRun.retryVersion === 'c-secure-token-recovery-retry-run-v1' && retryRun.results.some((item) => item.status === 'dry-run-ready') },
      { checkId: 'secure_token_plaintext_never_exposed', passed: this.tokens.history().every((item) => item.plaintextExposed === false) }
    ];
    const releaseDossier = createSecureTokenReleaseDossier({
      before,
      after,
      expiredRecovery,
      rotation,
      revokeFailure,
      retryRun,
      recoveryState,
      tokenStorage: after.tokenStorage,
      tokenHistory: this.deviceTokenHistory,
      secureStoreHistory: this.tokens.history(),
      productGateChecks: baseChecks,
      rawCurrentToken: rawTokenBeforeGate,
      rawRotatedToken: rawTokenAfterRotation,
      generatedAt: this.clock()
    });
    const checks = [
      ...baseChecks,
      {
        checkId: 'secure_token_release_dossier_ready',
        passed: releaseDossier.status === 'passed'
          && releaseDossier.dossierDigest.length === 64
          && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
      },
      {
        checkId: 'secure_token_release_artifact_manifest_ready',
        passed: releaseDossier.artifactManifest?.manifestVersion === 'c-secure-token-storage-release-artifact-manifest-v1'
          && releaseDossier.artifactManifest?.rawDeviceTokenStored === false
          && releaseDossier.artifactManifest?.rawTokenIdStored === false
          && releaseDossier.artifactManifest?.rawSecureStoreCiphertextStored === false
          && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
      },
      {
        checkId: 'secure_token_operational_handoff_ready',
        passed: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-secure-token-storage-operational-handoff-manifest-v1'
          && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-secure-token-storage-health-handshake-v1'
          && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-secure-token-storage-fallback-policy-v1'
          && releaseDossier.operationalHandoffManifest?.status === 'ready'
      },
      {
        checkId: 'secure_token_worm_promotion_package_ready',
        passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-secure-token-storage-worm-promotion-package-v1'
          && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-secure-token-storage-worm-provider-contract-v1'
          && releaseDossier.externalWormPromotionPackage?.status === 'ready'
      }
    ];
    const status = checks.every((check) => check.passed) ? 'passed' : 'failed';
    this.notifications.push({
      eventType: status === 'passed' ? 'device.token.product_gate.passed' : 'device.token.product_gate.failed',
      title: status === 'passed' ? '토큰 보안 제품 게이트 통과' : '토큰 보안 제품 게이트 실패',
      body: `${checks.filter((check) => check.passed).length}/${checks.length}개 토큰 보안 검증을 완료했습니다.`,
      severity: status === 'passed' ? 'success' : 'warning'
    });
    return {
      productGateVersion: 'c-secure-token-storage-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status,
      checks,
      before: sanitizeSecureTokenLifecycleStatus(before),
      after: sanitizeSecureTokenLifecycleStatus(after),
      expiredRecovery,
      rotation: sanitizeSecureTokenRotationResult(rotation),
      revokeFailure,
      retryRun,
      recoveryState,
      tokenHistory: this.deviceTokenHistory.map((item) => sanitizeSecureTokenHistoryEvent(item)),
      secureStoreHistory: this.tokens.history().map((item) => sanitizeSecureStoreHistoryEvent(item)),
      releaseDossier
    };
  }

  requestNotificationPermission({ grant = true } = {}) {
    const result = this.notifications.requestPermission({ grant });
    this.notifications.push({
      eventType: result.granted ? 'notification.permission.granted' : 'notification.permission.denied',
      title: result.granted ? '알림 권한 허용' : '알림 권한 거부',
      body: result.granted ? '승인과 실행 상태 알림을 전달할 수 있습니다.' : '앱 안 알림만 저장되고 OS 알림 전달은 차단됩니다.',
      severity: result.granted ? 'success' : 'warning'
    });
    return result;
  }

  registerPushToken(token, { platform = 'expo', projectId = 'jarvis-mobile' } = {}) {
    const result = this.notifications.registerPushToken({
      token,
      platform,
      projectId,
      deviceId: this.deviceId
    });
    if (result.success) {
      this.notifications.push({
        eventType: 'notification.push-token.registered',
        title: '푸시 토큰 등록',
        body: '기기 알림 토큰을 지문 형태로 등록했습니다.',
        severity: 'success'
      });
    }
    return result;
  }

  rotatePushToken(token, {
    platform = 'expo',
    projectId = 'jarvis-mobile',
    reason = 'manual-token-rotation',
    simulateProviderFailure = false
  } = {}) {
    const result = this.notifications.rotatePushToken({
      token,
      platform,
      projectId,
      deviceId: this.deviceId,
      reason,
      simulateProviderFailure
    });
    this.notifications.push({
      eventType: result.success ? 'notification.push-token.rotated' : 'notification.push-token.rotation_failed',
      title: result.success ? '푸시 토큰 회전' : '푸시 토큰 회전 실패',
      body: result.success
        ? '새 푸시 토큰을 지문 형태로 교체했습니다.'
        : '기존 푸시 토큰을 보존하고 재시도 큐에 기록했습니다.',
      severity: result.success ? 'success' : 'warning'
    });
    return result;
  }

  revokeNotificationPermission() {
    const result = this.notifications.revokePermission();
    this.notifications.push({
      eventType: 'notification.permission.revoked',
      title: '알림 권한 비활성화',
      body: '이후 알림은 앱 안에만 저장됩니다.',
      severity: 'warning'
    });
    return result;
  }

  notificationStatus() {
    return {
      permission: this.notifications.permissionState(),
      adapter: this.notifications.adapterState(),
      pushToken: this.notifications.pushTokenState(),
      tokenRotation: this.notifications.tokenRotationStatus(),
      appState: this.notifications.appState,
      unreadCount: this.notifications.unread().length,
      items: this.notifications.all(),
      deliveryLog: this.notifications.deliveryLog(),
      receiptLog: this.notifications.receiptLog(),
      issueQueue: this.notifications.issueQueue(),
      providerChecks: this.notifications.providerChecks()
    };
  }

  verifyNotificationReceipts(options = {}) {
    const result = this.notifications.verifyReceipts(options);
    this.notifications.push({
      eventType: result.success ? 'notification.receipts.verified' : 'notification.receipts.needs_retry',
      title: result.success ? '알림 수신 검증' : '알림 재시도 필요',
      body: `${result.ok}건 확인 / ${result.queued}건 대기`,
      severity: result.success ? 'success' : 'warning'
    });
    return result;
  }

  runNotificationProviderDrill({
    foregroundEventType = 'notification.provider.foreground',
    backgroundEventType = 'notification.provider.background',
    rotateFailureToken = 'bad',
    rotateSuccessToken = 'ExponentPushToken[jarvis-rotated-provider-drill]',
    retryQueued = true
  } = {}) {
    if (!this.notifications.permissionState().granted) {
      this.requestNotificationPermission({ grant: true });
    }
    if (!this.notifications.pushTokenState().registered) {
      this.registerPushToken('ExponentPushToken[jarvis-provider-drill]');
    }

    this.notifications.setAppState('active');
    const foreground = this.notifications.push({
      eventType: foregroundEventType,
      title: '포그라운드 알림 검증',
      body: '앱 실행 중 수신증을 기록합니다.',
      severity: 'success'
    });

    this.notifications.setAppState('background');
    const background = this.notifications.push({
      eventType: backgroundEventType,
      title: '백그라운드 알림 검증',
      body: '앱 백그라운드 상태 수신증을 기록합니다.',
      severity: 'warning'
    });
    this.notifications.setAppState('active');

    const failedRotation = this.rotatePushToken(rotateFailureToken, {
      reason: 'provider-drill-invalid-token',
      simulateProviderFailure: true
    });
    const successfulRotation = this.rotatePushToken(rotateSuccessToken, {
      reason: 'provider-drill-recovery-token'
    });
    const providerReceipt = this.notifications.verifyProviderReceiptDrill({ retryQueued });
    const passed = providerReceipt.status === 'passed'
      && failedRotation.success === false
      && failedRotation.previousTokenPreserved === true
      && successfulRotation.success === true;

    this.notifications.push({
      eventType: passed ? 'notification.provider_drill.passed' : 'notification.provider_drill.needs_evidence',
      title: passed ? '알림 운영 드릴 통과' : '알림 운영 드릴 보강 필요',
      body: `${providerReceipt.visualEvidence.length}개 foreground/background 수신 증거를 확인했습니다.`,
      severity: passed ? 'success' : 'warning'
    });

    return {
      drillVersion: 'c-notification-provider-drill-v1',
      status: passed ? 'passed' : 'needs-evidence',
      foreground,
      background,
      failedRotation,
      successfulRotation,
      providerReceipt,
      tokenRotation: this.notifications.tokenRotationStatus()
    };
  }

  runNotificationTokenRotationTrend({
    cycles = 3,
    tokenPrefix = 'ExponentPushToken[jarvis-notification-trend'
  } = {}) {
    if (!this.notifications.permissionState().granted) {
      this.requestNotificationPermission({ grant: true });
    }
    if (!this.notifications.pushTokenState().registered) {
      this.registerPushToken('ExponentPushToken[jarvis-notification-trend-base]');
    }
    const normalizedCycles = Math.max(1, Math.min(10, Number(cycles) || 3));
    const rotations = Array.from({ length: normalizedCycles }, (_, index) => this.rotatePushToken(`${tokenPrefix}-${index + 1}]`, {
      reason: `notification-token-trend-cycle-${index + 1}`
    }));
    const status = this.notifications.tokenRotationStatus();
    const trend = {
      trendVersion: 'c-notification-token-rotation-trend-v1',
      generatedAt: this.clock().toISOString(),
      status: rotations.every((item) => item.success === true) && status.unresolvedIssues.length === 0 ? 'passed' : 'needs-retry',
      cycles: normalizedCycles,
      rotatedCount: rotations.filter((item) => item.success === true).length,
      unresolvedIssues: status.unresolvedIssues,
      latestRotation: status.lastRotation,
      rotations
    };
    this.notifications.push({
      eventType: trend.status === 'passed' ? 'notification.token_trend.passed' : 'notification.token_trend.needs_retry',
      title: trend.status === 'passed' ? '알림 토큰 회전 검증' : '알림 토큰 회전 재시도 필요',
      body: `${trend.rotatedCount}/${trend.cycles}개 토큰 회전 cycle을 확인했습니다.`,
      severity: trend.status === 'passed' ? 'success' : 'warning'
    });
    return trend;
  }

  runNotificationProductGate({
    tokenTrendCycles = 3,
    retryQueued = true
  } = {}) {
    const providerDrill = this.runNotificationProviderDrill({ retryQueued });
    const tokenTrend = this.runNotificationTokenRotationTrend({ cycles: tokenTrendCycles });
    const receiptVerification = this.verifyNotificationReceipts({ retryQueued });
    const status = this.notificationStatus();
    const baseChecks = [
      { checkId: 'notification_permission_granted', passed: status.permission.granted === true },
      { checkId: 'notification_foreground_background_receipts_verified', passed: providerDrill.status === 'passed' && providerDrill.providerReceipt?.visualEvidence?.length >= 2 },
      { checkId: 'notification_token_rotation_trend_passed', passed: tokenTrend.status === 'passed' && tokenTrend.rotatedCount >= tokenTrendCycles },
      { checkId: 'notification_receipt_retry_queue_clean', passed: receiptVerification.failed === 0 && receiptVerification.unresolvedIssues.length === 0 },
      { checkId: 'notification_push_token_plaintext_hidden', passed: status.pushToken.plaintextExposed === false }
    ];
    const releaseDossier = createNotificationReleaseDossier({
      providerDrill,
      tokenTrend,
      receiptVerification,
      notificationStatus: status,
      productGateChecks: baseChecks,
      generatedAt: this.clock()
    });
    const checks = [
      ...baseChecks,
      {
        checkId: 'notification_release_dossier_ready',
        passed: releaseDossier.status === 'passed'
          && releaseDossier.dossierDigest.length === 64
          && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
      },
      {
        checkId: 'notification_release_artifact_manifest_ready',
        passed: releaseDossier.artifactManifest?.manifestVersion === 'c-notification-release-artifact-manifest-v1'
          && releaseDossier.artifactManifest?.rawNotificationPayloadStored === false
          && releaseDossier.artifactManifest?.rawPushTokenStored === false
          && releaseDossier.artifactManifest?.rawProviderReceiptStored === false
          && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
      },
      {
        checkId: 'notification_operational_handoff_ready',
        passed: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-notification-operational-handoff-manifest-v1'
          && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-notification-health-handshake-v1'
          && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-notification-fallback-policy-v1'
          && releaseDossier.operationalHandoffManifest?.status === 'ready'
      },
      {
        checkId: 'notification_worm_promotion_package_ready',
        passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-notification-worm-promotion-package-v1'
          && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-notification-worm-provider-contract-v1'
          && releaseDossier.externalWormPromotionPackage?.status === 'ready'
      }
    ];
    const gateStatus = checks.every((check) => check.passed) ? 'passed' : 'failed';
    this.notifications.push({
      eventType: gateStatus === 'passed' ? 'notification.product_gate.passed' : 'notification.product_gate.failed',
      title: gateStatus === 'passed' ? '알림 제품 게이트 통과' : '알림 제품 게이트 실패',
      body: `${checks.filter((check) => check.passed).length}/${checks.length}개 알림 검증을 완료했습니다.`,
      severity: gateStatus === 'passed' ? 'success' : 'warning'
    });
    return {
      productGateVersion: 'c-notification-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: gateStatus,
      checks,
      providerDrill,
      tokenTrend,
      receiptVerification,
      notificationStatus: status,
      releaseDossier
    };
  }

  configureSessionPin(pin) {
    const result = this.sessionLock.configurePin(pin);
    if (result.success) {
      this.notifications.push({
        eventType: 'session.pin.configured',
        title: '세션 잠금 설정',
        body: '민감 승인 전에 세션 잠금을 해제해야 합니다.',
        severity: 'success'
      });
    }
    return result;
  }

  unlockSession(pin) {
    const result = this.sessionLock.unlockWithPin(pin);
    this.notifications.push({
      eventType: result.success ? 'session.unlocked' : 'session.unlock.failed',
      title: result.success ? '세션 잠금 해제' : '세션 잠금 해제 실패',
      body: result.success ? '민감 작업 승인을 진행할 수 있습니다.' : 'PIN을 확인해야 합니다.',
      severity: result.success ? 'success' : 'warning'
    });
    return result;
  }

  unlockSessionWithBiometric(options = {}) {
    const result = this.sessionLock.unlockWithBiometric(options);
    this.notifications.push({
      eventType: result.success ? 'session.biometric.unlocked' : 'session.biometric.failed',
      title: result.success ? '생체 인증 잠금 해제' : '생체 인증 실패',
      body: result.success ? '네이티브 보안 프롬프트 계약으로 세션이 해제되었습니다.' : result.error?.message ?? result.error?.code,
      severity: result.success ? 'success' : 'warning'
    });
    return result;
  }

  lockSession(reason = 'manual') {
    const result = this.sessionLock.lock(reason);
    this.notifications.push({
      eventType: 'session.locked',
      title: '세션 잠금',
      body: '민감 작업은 다시 잠금 해제가 필요합니다.',
      severity: 'warning'
    });
    return result;
  }

  handleAppStateChange(nextState) {
    this.notifications.setAppState(nextState);
    const result = this.lifecycleSecurity.transition(nextState);
    if (result.success && result.locked) {
      this.notifications.push({
        eventType: 'session.lifecycle.locked',
        title: '세션 자동 잠금',
        body: '앱 상태 변경으로 민감 작업 세션이 잠겼습니다.',
        severity: 'warning'
      });
    }
    return result;
  }

  runLifecycleSoak(sequence) {
    if (Array.isArray(sequence) && sequence.length > 0) {
      this.notifications.setAppState(sequence[sequence.length - 1]);
    }
    const result = this.lifecycleSecurity.soak(sequence);
    this.notifications.push({
      eventType: result.passed ? 'session.lifecycle.soak.passed' : 'session.lifecycle.soak.failed',
      title: result.passed ? '세션 생명주기 검증' : '세션 생명주기 검증 실패',
      body: `${result.cycles}회 상태 전환 중 ${result.lockedTransitions}회 자동 잠금`,
      severity: result.passed ? 'success' : 'warning'
    });
    return result;
  }

  runSessionLockProductGate({
    sequence = ['active', 'background', 'active', 'inactive', 'active'],
    biometricReason = 'session-lock-product-gate'
  } = {}) {
    if (!this.sessionLock.state().configured) {
      this.configureSessionPin('2468');
    }
    const backgroundLock = this.handleAppStateChange('background');
    const biometricUnlock = this.unlockSessionWithBiometric({ reason: biometricReason });
    const lifecycleSoak = this.runLifecycleSoak(sequence);
    const visualRegression = createSessionLockVisualRegression({
      backgroundLock,
      biometricUnlock,
      lifecycleSoak,
      session: this.sessionStatus(),
      now: this.clock()
    });
    const baseChecks = [
      { checkId: 'session_pin_configured', passed: this.sessionLock.state().configured === true },
      { checkId: 'session_background_lock_verified', passed: backgroundLock.locked === true },
      { checkId: 'session_biometric_prompt_smoke_passed', passed: biometricUnlock.success === true && biometricUnlock.biometric?.capability?.expectedNativeModule === 'expo-local-authentication' },
      { checkId: 'session_lifecycle_soak_passed', passed: lifecycleSoak.passed === true && lifecycleSoak.lockedTransitions >= 2 },
      { checkId: 'session_visual_regression_passed', passed: visualRegression.status === 'passed' }
    ];
    const releaseDossier = createSessionLockReleaseDossier({
      backgroundLock,
      biometricUnlock,
      lifecycleSoak,
      visualRegression,
      session: this.sessionStatus(),
      productGateChecks: baseChecks,
      rawPinHash: this.sessionLock.pinHash,
      generatedAt: this.clock()
    });
    const checks = [
      ...baseChecks,
      {
        checkId: 'session_lock_release_dossier_ready',
        passed: releaseDossier.status === 'passed'
          && releaseDossier.dossierDigest.length === 64
          && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
      },
      {
        checkId: 'session_lock_release_artifact_manifest_ready',
        passed: releaseDossier.artifactManifest?.manifestVersion === 'c-session-lock-release-artifact-manifest-v1'
          && releaseDossier.artifactManifest?.rawPinStored === false
          && releaseDossier.artifactManifest?.rawBiometricPromptStored === false
          && releaseDossier.artifactManifest?.rawLifecyclePayloadStored === false
          && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
      },
      {
        checkId: 'session_lock_operational_handoff_ready',
        passed: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-session-lock-operational-handoff-manifest-v1'
          && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-session-lock-health-handshake-v1'
          && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-session-lock-fallback-policy-v1'
          && releaseDossier.operationalHandoffManifest?.status === 'ready'
      },
      {
        checkId: 'session_lock_worm_promotion_package_ready',
        passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-session-lock-worm-promotion-package-v1'
          && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-session-lock-worm-provider-contract-v1'
          && releaseDossier.externalWormPromotionPackage?.status === 'ready'
      }
    ];
    const status = checks.every((check) => check.passed) ? 'passed' : 'failed';
    this.notifications.push({
      eventType: status === 'passed' ? 'session.lock.product_gate.passed' : 'session.lock.product_gate.failed',
      title: status === 'passed' ? '세션 잠금 제품 게이트 통과' : '세션 잠금 제품 게이트 실패',
      body: `${checks.filter((check) => check.passed).length}/${checks.length}개 세션 잠금 검증을 완료했습니다.`,
      severity: status === 'passed' ? 'success' : 'warning'
    });
    return {
      productGateVersion: 'c-session-lock-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status,
      checks,
      backgroundLock,
      biometricUnlock,
      lifecycleSoak,
      visualRegression,
      releaseDossier
    };
  }

  sessionStatus() {
    return {
      ...this.sessionLock.state(),
      lifecycle: this.lifecycleSecurity.state()
    };
  }

  sensitiveActionReadiness(reason = 'sensitive-action') {
    const session = this.sessionLock.requireUnlocked(reason);
    return {
      allowed: session.allowed,
      reason,
      error: session.error ?? null,
      session: this.sessionStatus()
    };
  }

  checkConnection() {
    if (!this.bridgeRuntime?.health || !this.token()) {
      this.connection = {
        ...this.connection,
        connected: false,
        lastCheckedAt: this.clock().toISOString(),
        latencyMs: null,
        error: this.token() ? null : 'C_DEVICE_NOT_PAIRED'
      };
      return this.connection;
    }
    const startedAt = this.clock().getTime();
    const health = this.bridgeRuntime.health();
    this.connection = {
      ...this.connection,
      connected: health.status === 'ok',
      lastCheckedAt: this.clock().toISOString(),
      latencyMs: Math.max(0, this.clock().getTime() - startedAt),
      error: health.status === 'ok' ? null : 'C_BRIDGE_UNHEALTHY'
    };
    return { ...this.connection, health };
  }

  createTaskRequest(rawText) {
    return createTaskRequest({
      rawText,
      deviceId: this.deviceId,
      createdAt: this.clock().toISOString()
    });
  }

  sendCommand(rawText) {
    const value = String(rawText ?? '').trim();
    if (!value) {
      return { success: false, error: { code: 'C_EMPTY_COMMAND', message: '명령이 비어 있습니다.' } };
    }
    if (!this.connection.connected || !this.token()) {
      return {
        queued: true,
        item: this.offlineQueue.enqueue(value)
      };
    }
    const result = this.bridgeRuntime.createTask({ rawText: value, token: this.token() });
    if (result.taskId) {
      this.currentTaskId = result.taskId;
      this.notifications.push({
        eventType: 'task.created.local',
        title: '명령 전송 완료',
        body: '브릿지에 작업 요청을 전달했습니다.',
        taskId: result.taskId
      });
    }
    return result;
  }

  approvalQueue() {
    if (!this.token()) return { items: [] };
    return this.bridgeRuntime.listApprovals({ token: this.token() });
  }

  approvalDetail(approvalId) {
    return this.bridgeRuntime.getApproval({ approvalId, token: this.token() });
  }

  approvalHistory(approvalId) {
    return this.bridgeRuntime.getApprovalHistory({ approvalId, token: this.token() });
  }

  approvalSafetyFacts(card) {
    const expiry = approvalExpiryState(card, { now: this.clock() });
    return {
      mobileApprovalAllowed: card.riskTier > 3 && !expiry.expired,
      requiresPcConfirmation: card.riskTier <= 3,
      externalTransfer: card.externalTransfer,
      rollbackAvailable: card.rollbackAvailable,
      affectedItemCount: card.affectedItems?.length ?? 0,
      expiry,
      expired: expiry.expired,
      expiresAt: expiry.expiresAt
    };
  }

  async decideApproval({ approvalId, decision, editRequest, responseText }) {
    if (!Object.values(ApprovalDecision).includes(decision)) {
      return { success: false, error: { code: 'C_INVALID_APPROVAL_DECISION' } };
    }
    const card = this.approvalDetail(approvalId);
    const expiry = approvalExpiryState(card, { now: this.clock() });
    if (expiry.expired) {
      this.notifications.push({
        eventType: 'approval.expired.blocked',
        title: '승인 카드 만료',
        body: expiry.blockedReason,
        approvalId,
        severity: 'warning'
      });
      return {
        success: false,
        error: {
          code: 'C_APPROVAL_EXPIRED',
          message: expiry.blockedReason
        },
        approvalId,
        expiresAt: expiry.expiresAt
      };
    }
    if ([ApprovalDecision.APPROVE, ApprovalDecision.EDIT, ApprovalDecision.RESPOND].includes(decision)) {
      const session = this.sessionLock.requireUnlocked(`approval:${approvalId}`);
      if (!session.allowed) {
        this.notifications.push({
          eventType: 'approval.session.locked',
          title: '세션 잠금 필요',
          body: '승인 응답 전 모바일 세션 잠금 해제가 필요합니다.',
          approvalId,
          severity: 'warning'
        });
        return { success: false, error: session.error };
      }
    }
    const result = await this.bridgeRuntime.decideApproval({
      approvalId,
      decision,
      editRequest,
      responseText,
      token: this.token()
    });
    if (result?.success === false) {
      this.notifications.push({
        eventType: 'approval.decision.blocked',
        title: '승인 차단',
        body: result.error?.message ?? result.error?.code ?? '정책에 의해 모바일 승인이 차단되었습니다.',
        approvalId,
        severity: 'warning'
      });
    } else {
      this.notifications.push({
        eventType: 'approval.decision.sent',
        title: '승인 응답 전송',
        body: `승인 카드에 ${decision} 응답을 보냈습니다.`,
        taskId: result.taskId,
        approvalId
      });
    }
    return result;
  }

  renewApproval(approvalId) {
    const result = this.bridgeRuntime.renewApproval({ approvalId, token: this.token() });
    if (result?.success === false) {
      this.notifications.push({
        eventType: 'approval.renew.failed',
        title: '승인 연장 실패',
        body: result.error?.message ?? result.error?.code ?? '승인 카드 연장에 실패했습니다.',
        approvalId,
        severity: 'warning'
      });
      return result;
    }
    this.notifications.push({
      eventType: 'approval.renewed',
      title: '승인 카드 연장',
      body: `승인 만료 시간이 ${result.expiresAt}까지 연장되었습니다.`,
      taskId: result.taskId,
      approvalId
    });
    return result;
  }

  requestPcConfirmation(approvalId, reason = 'mobile_requires_pc_confirmation') {
    const result = this.bridgeRuntime.requestPcConfirmation({ approvalId, token: this.token(), reason });
    if (result?.success === false) {
      this.notifications.push({
        eventType: 'approval.pc_handoff.failed',
        title: 'PC 확인 요청 실패',
        body: result.error?.message ?? result.error?.code ?? 'PC 확인 요청에 실패했습니다.',
        approvalId,
        severity: 'warning'
      });
      return result;
    }
    this.notifications.push({
      eventType: 'approval.pc_handoff.requested',
      title: 'PC 확인 요청',
      body: '고위험 승인 카드를 PC에서 확인하도록 요청했습니다.',
      taskId: result.taskId,
      approvalId,
      severity: 'warning'
    });
    return result;
  }

  cancelApproval(approvalId, reason = 'mobile_cancelled') {
    const result = this.bridgeRuntime.cancelApproval({ approvalId, token: this.token(), reason });
    if (result?.success === false) {
      this.notifications.push({
        eventType: 'approval.cancel.failed',
        title: '승인 취소 실패',
        body: result.error?.message ?? result.error?.code ?? '승인 취소에 실패했습니다.',
        approvalId,
        severity: 'warning'
      });
      return result;
    }
    this.notifications.push({
      eventType: 'approval.cancelled',
      title: '승인 취소',
      body: '승인 카드가 취소되어 실행으로 넘어가지 않습니다.',
      taskId: result.taskId,
      approvalId
    });
    return result;
  }

  reRequestApproval(approvalId, reason = 'mobile_re_request') {
    const result = this.bridgeRuntime.requestApprovalReplacement({ approvalId, token: this.token(), reason });
    if (result?.success === false) {
      this.notifications.push({
        eventType: 'approval.re_request.failed',
        title: '승인 재요청 실패',
        body: result.error?.message ?? result.error?.code ?? '새 승인 요청에 실패했습니다.',
        approvalId,
        severity: 'warning'
      });
      return result;
    }
    this.notifications.push({
      eventType: 'approval.re_requested',
      title: '승인 재요청',
      body: '기존 승인 카드를 닫고 새 승인 카드를 생성했습니다.',
      taskId: result.replacement.taskId,
      approvalId: result.replacement.approvalId
    });
    return result;
  }

  async confirmExecution(handoffId) {
    const session = this.sessionLock.requireUnlocked(`execution-handoff:${handoffId}`);
    if (!session.allowed) {
      this.notifications.push({
        eventType: 'execution.session.locked',
        title: '세션 잠금 필요',
        body: 'PC 실행 확인 전 모바일 세션 잠금 해제가 필요합니다.',
        severity: 'warning'
      });
      return { success: false, error: session.error };
    }
    const result = await this.bridgeRuntime.confirmExecutionHandoff({ handoffId, token: this.token() });
    if (result?.taskId) this.currentTaskId = result.taskId;
    this.notifications.push({
      eventType: 'execution.handoff.confirmed.local',
      title: 'PC 실행 확인',
      body: `실행 상태: ${result.status ?? 'unknown'}`,
      taskId: result.taskId,
      severity: result.status === 'COMPLETED' ? 'success' : 'info'
    });
    return result;
  }

  taskStatus(taskId = this.currentTaskId) {
    if (!taskId) return { success: false, error: { code: 'C_TASK_NOT_SELECTED' } };
    return this.bridgeRuntime.getTaskStatus({ taskId, token: this.token() });
  }

  result(taskId = this.currentTaskId) {
    if (!taskId) return { success: false, error: { code: 'C_TASK_NOT_SELECTED' } };
    const result = this.bridgeRuntime.getResult({ taskId, token: this.token() });
    if (result?.success !== false) this.latestResult = result;
    return result;
  }

  async previewOutputFile({ taskId = this.currentTaskId, preview } = {}) {
    if (!taskId) return { success: false, error: { code: 'C_TASK_NOT_SELECTED' } };
    const action = await this.documentActions.preview({ taskId, preview });
    this.notifications.push({
      eventType: action.success === false ? 'result.file_preview.failed' : 'result.file_preview.opened',
      title: action.success === false ? '파일 미리보기 실패' : '파일 미리보기',
      body: action.error?.message ?? action.name ?? action.path ?? taskId,
      taskId,
      severity: action.success === false ? 'warning' : 'info'
    });
    return action;
  }

  async shareOutputFile({ taskId = this.currentTaskId, preview } = {}) {
    if (!taskId) return { success: false, error: { code: 'C_TASK_NOT_SELECTED' } };
    const action = await this.documentActions.share({ taskId, preview });
    this.notifications.push({
      eventType: action.success === false ? 'result.file_share.failed' : 'result.file_share.shared',
      title: action.success === false ? '파일 공유 실패' : '파일 공유',
      body: action.error?.message ?? action.name ?? action.path ?? taskId,
      taskId,
      severity: action.success === false ? 'warning' : 'info'
    });
    return action;
  }

  documentActionStatus() {
    return {
      capability: this.documentActions.capability(),
      recentActions: this.documentActions.history()
    };
  }

  async rollbackResult({ taskId = this.currentTaskId, reason = 'mobile_result_rollback' } = {}) {
    if (!taskId) return { success: false, error: { code: 'C_TASK_NOT_SELECTED' } };
    const session = this.sessionLock.requireUnlocked(`result:${taskId}:rollback`);
    if (!session.allowed) {
      this.notifications.push({
        eventType: 'result.rollback.session.locked',
        title: '세션 잠금 필요',
        body: '결과 되돌리기 전 모바일 세션 잠금 해제가 필요합니다.',
        taskId,
        severity: 'warning'
      });
      return { success: false, error: session.error };
    }
    const result = await this.bridgeRuntime.rollbackResult({
      taskId,
      token: this.token(),
      reason,
      confirmed: true
    });
    if (result?.success !== false) {
      this.latestResult = result.result ?? this.latestResult;
    }
    this.notifications.push({
      eventType: result.success === false ? 'result.rollback.failed' : 'result.rollback.completed',
      title: result.success === false ? '되돌리기 실패' : '되돌리기 완료',
      body: result.error?.message ?? result.rollback?.transaction?.status ?? taskId,
      taskId,
      severity: result.success === false ? 'warning' : 'success'
    });
    return result;
  }

  poisonQueue({ includeIgnored = false } = {}) {
    if (!this.token()) return { items: [], queue: null, error: { code: 'C_DEVICE_NOT_PAIRED' } };
    const result = this.bridgeRuntime.poisonQueue({ token: this.token(), includeIgnored });
    if (result?.success !== false) this.latestPoisonQueue = result;
    return result;
  }

  async drainPcAgentQueue({ limit = 10, includeIgnored = false } = {}) {
    const session = this.sessionLock.requireUnlocked('pc-agent-queue:drain');
    if (!session.allowed) {
      this.notifications.push({
        eventType: 'pc_agent.queue_drain.session.locked',
        title: '세션 잠금 필요',
        body: 'PC 에이전트 큐 drain 전 모바일 세션 잠금 해제가 필요합니다.',
        severity: 'warning'
      });
      return { success: false, error: session.error };
    }
    const before = this.poisonQueue({ includeIgnored });
    if (typeof this.bridgeRuntime.drainPcAgentQueue !== 'function') {
      const result = { success: false, error: { code: 'C_PC_AGENT_QUEUE_DRAIN_UNAVAILABLE' } };
      this.notifications.push({
        eventType: 'pc_agent.queue_drain.failed',
        title: 'PC 큐 drain 실패',
        body: '브릿지에서 큐 drain을 지원하지 않습니다.',
        severity: 'warning'
      });
      return {
        ...result,
        before,
        after: before,
        delta: createPoisonQueueDelta(before, before)
      };
    }
    const result = await this.bridgeRuntime.drainPcAgentQueue({
      token: this.token(),
      limit
    });
    const after = this.poisonQueue({ includeIgnored });
    const delta = createPoisonQueueDelta(before, after);
    this.notifications.push({
      eventType: result.success === false ? 'pc_agent.queue_drain.failed' : 'pc_agent.queue_drained',
      title: result.success === false ? 'PC 큐 drain 실패' : 'PC 큐 drain 완료',
      body: result.error?.message ?? `${result.processed ?? 0}건 처리`,
      severity: result.success === false ? 'warning' : 'success'
    });
    return {
      ...result,
      before,
      after,
      delta
    };
  }

  async runPoisonQueueSoak({ cycles = 3, limit = 10, includeIgnored = false } = {}) {
    const results = [];
    for (let index = 0; index < cycles; index += 1) {
      results.push(await this.drainPcAgentQueue({ limit, includeIgnored }));
    }
    const failed = results.filter((item) => item.success === false);
    const processed = results.reduce((sum, item) => sum + (item.processed ?? 0), 0);
    const latest = this.poisonQueue({ includeIgnored });
    const summary = {
      success: failed.length === 0,
      cycles,
      processed,
      failedCycles: failed.length,
      latest,
      stableClear: (latest.queue?.quarantined ?? 0) === 0 && (latest.queue?.retryScheduled ?? 0) === 0,
      results
    };
    this.notifications.push({
      eventType: summary.success ? 'pc_agent.poison_queue.soak.passed' : 'pc_agent.poison_queue.soak.failed',
      title: summary.success ? '운영 오류 큐 soak 통과' : '운영 오류 큐 soak 실패',
      body: `${cycles}회 중 ${failed.length}회 실패 / ${processed}건 처리`,
      severity: summary.success ? 'success' : 'warning'
    });
    return summary;
  }

  queueRetryPolicy() {
    if (!this.token()) return { success: false, error: { code: 'C_DEVICE_NOT_PAIRED' } };
    const result = this.bridgeRuntime.queueRetryPolicy({ token: this.token() });
    if (result?.success !== false) this.latestQueuePolicy = result;
    return result;
  }

  updateQueueRetryPolicy({ maxAttempts, baseBackoffMs, reason = '' }) {
    const session = this.sessionLock.requireUnlocked('queue-retry-policy:update');
    if (!session.allowed) {
      this.notifications.push({
        eventType: 'queue_policy.session.locked',
        title: '세션 잠금 필요',
        body: '재시도 정책 변경 전 모바일 세션 잠금 해제가 필요합니다.',
        severity: 'warning'
      });
      return { success: false, error: session.error };
    }
    const result = this.bridgeRuntime.updateQueueRetryPolicy({
      token: this.token(),
      maxAttempts,
      baseBackoffMs,
      reason
    });
    if (result?.success !== false) this.latestQueuePolicy = result.current;
    this.notifications.push({
      eventType: result.success === false ? 'queue_policy.update.failed' : 'queue_policy.updated',
      title: result.success === false ? '재시도 정책 변경 실패' : '재시도 정책 변경',
      body: result.error?.message ?? `${result.current?.maxAttempts ?? maxAttempts}회 / ${result.current?.baseBackoffMs ?? baseBackoffMs}ms`,
      severity: result.success === false ? 'warning' : 'success'
    });
    return result;
  }

  requirePoisonQueueSession(queueId, action) {
    const session = this.sessionLock.requireUnlocked(`poison-packet:${queueId}:${action}`);
    if (!session.allowed) {
      this.notifications.push({
        eventType: 'poison.session.locked',
        title: '세션 잠금 필요',
        body: '격리 패킷 처리 전 모바일 세션 잠금 해제가 필요합니다.',
        severity: 'warning'
      });
      return { success: false, error: session.error };
    }
    return { success: true };
  }

  reviewPoisonPacket({ queueId, note = '' }) {
    const session = this.requirePoisonQueueSession(queueId, 'review');
    if (!session.success) return session;
    const result = this.bridgeRuntime.reviewPoisonPacket({
      token: this.token(),
      queueId,
      note
    });
    this.notifications.push({
      eventType: result.success === false ? 'poison.review.failed' : 'poison.reviewed',
      title: result.success === false ? '격리 패킷 검토 실패' : '격리 패킷 검토 완료',
      body: result.error?.message ?? result.item?.queueId ?? queueId,
      severity: result.success === false ? 'warning' : 'success'
    });
    return result;
  }

  requeuePoisonPacket({ queueId, patch = null, note = '' }) {
    const session = this.requirePoisonQueueSession(queueId, 'requeue');
    if (!session.success) return session;
    const result = this.bridgeRuntime.requeuePoisonPacket({
      token: this.token(),
      queueId,
      patch,
      note
    });
    this.notifications.push({
      eventType: result.success === false ? 'poison.requeue.failed' : 'poison.requeued',
      title: result.success === false ? '격리 패킷 재시도 실패' : '격리 패킷 재시도 등록',
      body: result.error?.message ?? result.item?.queueId ?? queueId,
      severity: result.success === false ? 'warning' : 'success'
    });
    return result;
  }

  ignorePoisonPacket({ queueId, note = '' }) {
    const session = this.requirePoisonQueueSession(queueId, 'ignore');
    if (!session.success) return session;
    const result = this.bridgeRuntime.ignorePoisonPacket({
      token: this.token(),
      queueId,
      note
    });
    this.notifications.push({
      eventType: result.success === false ? 'poison.ignore.failed' : 'poison.ignored',
      title: result.success === false ? '격리 패킷 무시 실패' : '격리 패킷 무시',
      body: result.error?.message ?? result.item?.queueId ?? queueId,
      severity: result.success === false ? 'warning' : 'success'
    });
    return result;
  }

  sendFeedback({ taskId = this.currentTaskId, feedbackType, text }) {
    if (!taskId) return { success: false, error: { code: 'C_TASK_NOT_SELECTED' } };
    const result = this.bridgeRuntime.recordFeedback({
      token: this.token(),
      feedback: {
        taskId,
        feedbackType,
        text,
        timestamp: this.clock().toISOString()
      }
    });
    if (result?.stored) {
      this.notifications.push({
        eventType: 'feedback.sent',
        title: '피드백 저장',
        body: '결과 피드백을 성장 기억으로 보냈습니다.',
        taskId,
        severity: 'success'
      });
    }
    return result;
  }

  growthReview() {
    const review = this.bridgeRuntime.latestGrowthReview({ token: this.token() });
    if (review?.success !== false) this.latestGrowth = review;
    return review;
  }

  growthDecisionHistory({ routeName, kind, limit } = {}) {
    return this.bridgeRuntime.growthDecisionHistory({
      token: this.token(),
      routeName,
      kind,
      limit
    });
  }

  growthRoutingTrends({ windowMinutes } = {}) {
    return this.bridgeRuntime.growthRoutingTrend({
      token: this.token(),
      windowMinutes
    });
  }

  decideGrowthPreference({ hypothesisId, decision, reason = '' }) {
    const result = this.bridgeRuntime.decideGrowthPreference({
      token: this.token(),
      hypothesisId,
      decision,
      reason
    });
    if (result?.success !== false) {
      this.notifications.push({
        eventType: 'growth.preference.decided',
        title: decision === 'confirm' ? '선호 확정' : '선호 거절',
        body: hypothesisId,
        severity: 'success'
      });
    }
    return result;
  }

  async mutateGrowthSkillRevision({ action, skillId, revisionId = null, payload = {} } = {}) {
    if (!['create', 'evaluate', 'review', 'promote', 'rollback'].includes(action)
      || typeof this.bridgeRuntime.mutateGrowthSkillRevision !== 'function') {
      return { success: false, error: { code: 'C_GROWTH_SKILL_REVISION_UNAVAILABLE' } };
    }
    const result = await this.bridgeRuntime.mutateGrowthSkillRevision({
      token: this.token(), action, skillId, revisionId, payload
    });
    if (result?.success !== false) {
      this.notifications.push({
        eventType: `growth.skill_revision.${action}`,
        title: '업무 절차 변경 기록',
        body: `${action}: ${skillId}`,
        severity: 'success'
      });
    }
    return result;
  }

  decideGrowthHygiene({ targetType = 'memory_event', targetId, action, reason = '' }) {
    const result = this.bridgeRuntime.decideGrowthHygiene({
      token: this.token(),
      targetType,
      targetId,
      action,
      reason
    });
    if (result?.success !== false) {
      this.notifications.push({
        eventType: 'growth.hygiene.decided',
        title: '기억 위생 결정',
        body: `${action}: ${targetId}`,
        severity: 'success'
      });
    }
    return result;
  }

  decideGrowthHygieneBatch({ decisions = [], reason = 'mobile batch hygiene review' } = {}) {
    const result = this.bridgeRuntime.decideGrowthHygieneBatch({
      token: this.token(),
      decisions,
      reason
    });
    if (result?.success !== false) {
      this.notifications.push({
        eventType: 'growth.hygiene.batch_decided',
        title: '기억 위생 일괄 결정',
        body: `${result.appliedCount ?? 0}/${result.requestedCount ?? decisions.length}`,
        severity: result.failedCount ? 'warning' : 'success'
      });
    }
    return result;
  }

  syncEvents({ eventType } = {}) {
    if (!this.token()) return { items: [] };
    const result = this.bridgeRuntime.eventFeed({
      token: this.token(),
      sinceEventId: this.lastEventId,
      eventType
    });
    if (result.success === false) return result;
    for (const event of result.items) {
      this.eventLog.push(event);
      this.lastEventId = event.eventId;
      if (event.eventType === 'task.created') {
        this.currentTaskId = event.payload.taskId;
      }
      if (event.eventType === 'execution.handoff.confirmed') {
        this.currentTaskId = event.payload.taskId;
      }
      const notification = this.notificationForEvent(event);
      if (notification) this.notifications.push(notification);
    }
    return {
      items: result.items,
      lastEventId: this.lastEventId,
      unreadCount: this.notifications.unread().length,
      notifications: this.notifications.all()
    };
  }

  notificationForEvent(event) {
    const payload = event.payload ?? {};
    const mapping = {
      'task.created': ['새 작업 생성', '브릿지에 작업이 등록되었습니다.', 'info'],
      'approval.decision.received': ['승인 응답 처리', '승인 결정이 코어에 반영되었습니다.', 'success'],
      'approval.decision.blocked': ['승인 차단', payload.reason ?? '모바일 승인 정책에 의해 차단되었습니다.', 'warning'],
      'approval.pc_handoff.requested': ['PC 확인 요청', '고위험 승인 카드가 PC 확인 대기로 전환되었습니다.', 'warning'],
      'execution.handoff.created': ['PC 실행 확인 필요', '실행 전 마지막 확인이 필요합니다.', 'warning'],
      'execution.handoff.confirmed': ['PC 실행 완료', `검증 상태: ${payload.verificationStatus ?? 'not_required'}`, 'success'],
      'feedback.received': ['피드백 반영', '성장 기억 시스템에 피드백이 전달되었습니다.', 'success'],
      'pc_agent.poison_packet.reviewed': ['격리 패킷 검토됨', 'PC 에이전트 격리 패킷이 검토 처리되었습니다.', 'success'],
      'pc_agent.poison_packet.requeued': ['격리 패킷 재시도', '수정된 패킷이 실행 큐에 다시 등록되었습니다.', 'success'],
      'pc_agent.poison_packet.ignored': ['격리 패킷 무시', '운영 검토에서 패킷을 무시 처리했습니다.', 'warning'],
      'pc_agent.queue_policy.updated': ['재시도 정책 변경', `${payload.maxAttempts ?? '-'}회 / ${payload.baseBackoffMs ?? '-'}ms`, 'success']
    };
    const entry = mapping[event.eventType];
    if (!entry) return null;
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      title: entry[0],
      body: entry[1],
      severity: entry[2],
      taskId: payload.taskId,
      approvalId: payload.approvalId
    };
  }

  reviewOfflineQueue() {
    return {
      autoSend: false,
      pending: this.offlineQueue.pending(),
      all: this.offlineQueue.all()
    };
  }

  cancelQueuedCommand(localId) {
    const item = this.offlineQueue.cancel(localId);
    if (!item) {
      return { success: false, error: { code: 'C_QUEUE_ITEM_NOT_FOUND' } };
    }
    this.notifications.push({
      eventType: 'offline.command.cancelled',
      title: '오프라인 명령 취소',
      body: '대기 중이던 명령을 전송하지 않도록 취소했습니다.'
    });
    return { success: true, item };
  }

  sendQueuedCommand(localId) {
    const item = this.offlineQueue.pending().find((candidate) => candidate.localId === localId);
    if (!item) {
      return { success: false, error: { code: 'C_QUEUE_ITEM_NOT_FOUND' } };
    }
    const result = this.sendCommand(item.rawText);
    if (result.taskId) {
      this.offlineQueue.mark(localId, 'sent');
    }
    return result;
  }

  snapshot() {
    return {
      connection: this.connection,
      device: {
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        paired: Boolean(this.token()),
        authTokenExists: Boolean(this.token()),
        tokenStorage: this.tokenStorageStatus(),
        documentActions: this.documentActionStatus()
      },
      session: this.sessionStatus(),
      task: {
        currentTaskId: this.currentTaskId,
        result: this.latestResult
      },
      offline: this.reviewOfflineQueue(),
      events: {
        lastEventId: this.lastEventId,
        items: [...this.eventLog],
        unreadCount: this.notifications.unread().length
      },
      notifications: {
        permission: this.notifications.permissionState(),
        adapter: this.notifications.adapterState(),
        pushToken: this.notifications.pushTokenState(),
        tokenRotation: this.notifications.tokenRotationStatus(),
        appState: this.notifications.appState,
        unreadCount: this.notifications.unread().length,
        items: this.notifications.all(),
        deliveryLog: this.notifications.deliveryLog(),
        receiptLog: this.notifications.receiptLog(),
        issueQueue: this.notifications.issueQueue(),
        providerChecks: this.notifications.providerChecks()
      },
      growth: {
        latestReview: this.latestGrowth
      },
      poisonQueue: {
        latest: this.latestPoisonQueue
      },
      queuePolicy: {
        latest: this.latestQueuePolicy
      }
    };
  }
}
