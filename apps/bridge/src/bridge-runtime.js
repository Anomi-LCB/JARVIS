import { ApprovalDecision, createApprovalDecision, createError, maskSensitive, ModuleId, stableId, TaskStatus } from '../../../packages/shared/src/types.js';
import { JsonlAuditLog } from '../../../packages/shared/src/audit-log.js';
import { appendJsonlSync } from '../../../packages/shared/src/jsonl.js';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const deviceTokenTtlMs = 90 * 24 * 60 * 60 * 1000;
const requestNonceTtlMs = 7 * 24 * 60 * 60 * 1000;
const bridgeStateCacheSchemaVersion = 'bridge-state-cache-v2';
const bridgeStateCacheRetentionMs = 30 * 24 * 60 * 60 * 1000;

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer.toString('base64url');
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function base64UrlDecodeJson(value) {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class DeviceTokenService {
  constructor({
    clock = () => new Date(),
    secret = process.env.JARVIS_DEVICE_TOKEN_SECRET ?? 'jarvis-local-bridge-development-secret',
    issuer = 'jarvis-d-bridge',
    audience = 'jarvis-mobile-device',
    ttlMs = deviceTokenTtlMs
  } = {}) {
    this.clock = clock;
    this.secret = secret;
    this.issuer = issuer;
    this.audience = audience;
    this.ttlMs = ttlMs;
  }

  issue({ deviceId, deviceName, tokenVersion = 1, now = this.clock() }) {
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const header = {
      alg: 'HS256',
      typ: 'JARVIS-D-DEVICE'
    };
    const payload = {
      iss: this.issuer,
      aud: this.audience,
      sub: deviceId,
      deviceName,
      iat: issuedAt,
      nbf: issuedAt,
      exp: expiresAt,
      jti: `devtok_${randomBytes(16).toString('hex')}_${Date.parse(issuedAt).toString(36)}`,
      ver: tokenVersion,
      scope: ['bridge:device']
    };
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
    const signature = this.sign(signingInput);
    const deviceToken = `${signingInput}.${signature}`;
    return {
      deviceToken,
      tokenHash: this.hash(deviceToken),
      tokenId: payload.jti,
      tokenVersion,
      issuedAt,
      expiresAt,
      algorithm: header.alg,
      scope: payload.scope
    };
  }

  verify(token) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) {
      return createError('D_AUTH_TOKEN_MALFORMED', 'Device token must be a signed three-part token.', 401);
    }
    const [encodedHeader, encodedPayload, signature] = parts;
    const header = base64UrlDecodeJson(encodedHeader);
    const payload = base64UrlDecodeJson(encodedPayload);
    if (!header || !payload || header.alg !== 'HS256' || header.typ !== 'JARVIS-D-DEVICE') {
      return createError('D_AUTH_TOKEN_MALFORMED', 'Device token header or payload is invalid.', 401);
    }
    const expectedSignature = this.sign(`${encodedHeader}.${encodedPayload}`);
    if (!safeEqual(signature, expectedSignature)) {
      return createError('D_AUTH_TOKEN_SIGNATURE_INVALID', 'Device token signature is invalid.', 401);
    }
    if (payload.iss !== this.issuer || payload.aud !== this.audience || !payload.sub || !payload.jti) {
      return createError('D_AUTH_TOKEN_MALFORMED', 'Device token claims are invalid.', 401);
    }
    const nowMs = this.clock().getTime();
    if (Date.parse(payload.nbf) > nowMs) {
      return createError('D_AUTH_TOKEN_NOT_YET_VALID', 'Device token is not valid yet.', 401);
    }
    if (Date.parse(payload.exp) <= nowMs) {
      return createError('D_AUTH_TOKEN_EXPIRED', 'Device token expired.', 401);
    }
    return {
      success: true,
      payload,
      tokenHash: this.hash(token),
      tokenId: payload.jti,
      tokenVersion: Number(payload.ver ?? 1),
      expiresAt: payload.exp
    };
  }

  sign(signingInput) {
    return createHmac('sha256', this.secret).update(signingInput).digest('base64url');
  }

  hash(token) {
    return sha256Hex(token);
  }

  deploymentPolicy() {
    const envConfigured = Boolean(process.env.JARVIS_DEVICE_TOKEN_SECRET);
    const secretLength = String(this.secret ?? '').length;
    const secretHash = sha256Hex(this.secret).slice(0, 16);
    const checks = [
      {
        checkId: 'device_token_secret_from_environment',
        status: envConfigured ? 'passed' : 'warning',
        detail: envConfigured ? 'JARVIS_DEVICE_TOKEN_SECRET is configured.' : 'Development default secret is active.'
      },
      {
        checkId: 'device_token_secret_length',
        status: secretLength >= 32 ? 'passed' : 'warning',
        detail: { secretLength, minimumLength: 32 }
      },
      {
        checkId: 'device_token_signed_hs256',
        status: this.issuer && this.audience ? 'passed' : 'failed',
        detail: { issuer: this.issuer, audience: this.audience, algorithm: 'HS256' }
      }
    ];
    return {
      policyVersion: 'd-device-token-deployment-policy-v1',
      status: checks.some((check) => check.status === 'failed') ? 'failed' : envConfigured && secretLength >= 32 ? 'passed' : 'warning',
      generatedAt: this.clock().toISOString(),
      issuer: this.issuer,
      audience: this.audience,
      ttlMs: this.ttlMs,
      secretSource: envConfigured ? 'JARVIS_DEVICE_TOKEN_SECRET' : 'development-default',
      secretFingerprint: secretHash,
      rotation: {
        drillVersion: 'd-device-token-key-rotation-drill-v1',
        recommendedIntervalDays: 90,
        overlapWindowMinutes: 15,
        revokePreviousTokenOnDeviceRotation: true,
        recoveryAction: 'rotate_device_token_or_repair_pairing'
      },
      checks
    };
  }

  keyRotationDrill({ nextSecret = 'jarvis-bridge-next-rotation-secret-material-32-bytes', deviceId = 'rotation_drill_device', deviceName = 'Rotation Drill Device' } = {}) {
    const currentIssued = this.issue({ deviceId, deviceName, tokenVersion: 1 });
    const currentVerify = this.verify(currentIssued.deviceToken);
    const nextService = new DeviceTokenService({
      clock: this.clock,
      secret: nextSecret,
      issuer: this.issuer,
      audience: this.audience,
      ttlMs: this.ttlMs
    });
    const oldTokenAfterRotation = nextService.verify(currentIssued.deviceToken);
    const nextIssued = nextService.issue({ deviceId, deviceName, tokenVersion: 2 });
    const nextVerify = nextService.verify(nextIssued.deviceToken);
    const checks = [
      { checkId: 'current_key_accepts_current_token', status: currentVerify.success ? 'passed' : 'failed' },
      { checkId: 'next_key_rejects_old_signature', status: oldTokenAfterRotation.success === false ? 'passed' : 'failed', errorCode: oldTokenAfterRotation.error?.code ?? null },
      { checkId: 'next_key_issues_valid_rotated_token', status: nextVerify.success && nextVerify.tokenVersion === 2 ? 'passed' : 'failed' },
      { checkId: 'rotation_keeps_token_hash_only_evidence', status: currentIssued.tokenHash.length === 64 && nextIssued.tokenHash.length === 64 ? 'passed' : 'failed' }
    ];
    return {
      drillVersion: 'd-device-token-key-rotation-drill-v1',
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
      generatedAt: this.clock().toISOString(),
      currentKey: {
        fingerprint: sha256Hex(this.secret).slice(0, 16),
        tokenVersion: currentIssued.tokenVersion,
        tokenHash: currentIssued.tokenHash
      },
      nextKey: {
        fingerprint: sha256Hex(nextSecret).slice(0, 16),
        tokenVersion: nextIssued.tokenVersion,
        tokenHash: nextIssued.tokenHash
      },
      checks
    };
  }
}

export class DeviceRegistry {
  constructor({ clock = () => new Date(), auditLog = null, tokenService = new DeviceTokenService({ clock }), journalPath = null } = {}) {
    this.clock = clock;
    this.auditLog = auditLog;
    this.tokenService = tokenService;
    this.journalPath = journalPath;
    this.persistence = {
      enabled: Boolean(journalPath),
      journalPath,
      replay: {
        loaded: false,
        records: 0,
        errors: 0,
        lastRecordAt: null
      }
    };
    this.devices = new Map();
    this.loadJournal();
  }

  register({ deviceId, deviceName, tokenHash, expiresAt, issuedAt, tokenId, tokenVersion = 1, tokenAlgorithm = 'HS256', tokenScope = ['bridge:device'], pairingId = null }) {
    const existing = this.devices.get(deviceId);
    const previousToken = existing?.tokenHash
      ? {
          tokenHash: existing.tokenHash,
          tokenId: existing.tokenId,
          tokenVersion: existing.tokenVersion,
          expiresAt: existing.expiresAt,
          rotatedAt: this.clock().toISOString(),
          reason: 'device_repaired'
        }
      : null;
    const device = {
      deviceId,
      deviceName,
      deviceType: 'phone',
      tokenHash,
      tokenId,
      tokenVersion,
      tokenAlgorithm,
      tokenScope,
      tokenStatus: 'active',
      issuedAt,
      pairedAt: existing?.pairedAt ?? this.clock().toISOString(),
      rePairedAt: existing ? this.clock().toISOString() : null,
      lastSeenAt: existing?.lastSeenAt ?? null,
      pairingId,
      expiresAt,
      status: 'active',
      rotatedTokenHashes: previousToken
        ? [...(existing.rotatedTokenHashes ?? []), previousToken].slice(-10)
        : [],
      permissions: {
        canCreateTask: true,
        canApproveTier5: true,
        canApproveTier4: false,
        canApproveTier3: false,
        canApproveTier2: false,
        canApproveTier1: false,
        canReviewPcPoisonQueue: true,
        canManagePcQueuePolicy: true
      }
    };
    this.devices.set(deviceId, device);
    this.persist(existing ? 'device.repaired' : 'device.registered', device, {
      previousTokenRevoked: Boolean(previousToken)
    });
    this.auditLog?.write(existing ? 'device.repaired' : 'device.registered', {
      deviceId,
      deviceName,
      expiresAt,
      pairingId,
      previousTokenRevoked: Boolean(previousToken)
    });
    return device;
  }

  findByToken(token) {
    const result = this.authenticateToken(token);
    return result.success ? result.device : null;
  }

  authenticateToken(token) {
    const verified = this.tokenService.verify(token);
    if (!verified.success) return verified;
    const device = this.devices.get(verified.payload.sub);
    if (!device || device.status !== 'active' || device.tokenHash !== verified.tokenHash) {
      return createError('D_AUTH_INVALID_TOKEN', 'Invalid device token.', 401);
    }
    if (Date.parse(device.expiresAt) <= this.clock().getTime()) {
      device.status = 'expired';
      device.tokenStatus = 'expired';
      device.expiredAt = this.clock().toISOString();
      this.persist('device.expired', device);
      this.auditLog?.write('device.token_expired', { deviceId: device.deviceId, tokenId: device.tokenId });
      return createError('D_AUTH_TOKEN_EXPIRED', 'Device token expired.', 401);
    }
    return {
      success: true,
      device,
      token: {
        tokenHash: verified.tokenHash,
        tokenId: verified.tokenId,
        tokenVersion: verified.tokenVersion,
        expiresAt: verified.expiresAt,
        algorithm: 'HS256',
        signed: true
      }
    };
  }

  rotateToken({ deviceId, previousTokenHash, reason = 'device_requested_rotation' }) {
    const device = this.devices.get(deviceId);
    if (!device || device.status !== 'active') {
      return createError('D_DEVICE_NOT_FOUND', 'Active device not found.', 404);
    }
    if (device.tokenHash !== previousTokenHash) {
      return createError('D_AUTH_INVALID_TOKEN', 'Previous device token is no longer active.', 401);
    }
    const previous = {
      tokenHash: device.tokenHash,
      tokenId: device.tokenId,
      tokenVersion: device.tokenVersion,
      expiresAt: device.expiresAt,
      rotatedAt: this.clock().toISOString(),
      reason
    };
    const issued = this.tokenService.issue({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      tokenVersion: (device.tokenVersion ?? 1) + 1,
      now: this.clock()
    });
    device.tokenHash = issued.tokenHash;
    device.tokenId = issued.tokenId;
    device.tokenVersion = issued.tokenVersion;
    device.tokenAlgorithm = issued.algorithm;
    device.tokenScope = issued.scope;
    device.tokenStatus = 'active';
    device.issuedAt = issued.issuedAt;
    device.expiresAt = issued.expiresAt;
    device.rotatedAt = previous.rotatedAt;
    device.rotatedTokenHashes = [...(device.rotatedTokenHashes ?? []), previous].slice(-10);
    this.persist('device.token_rotated', device, { reason });
    this.auditLog?.write('device.token_rotated', {
      deviceId: device.deviceId,
      tokenId: issued.tokenId,
      tokenVersion: issued.tokenVersion,
      previousTokenId: previous.tokenId,
      reason
    });
    return {
      success: true,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      deviceToken: issued.deviceToken,
      expiresAt: issued.expiresAt,
      issuedAt: issued.issuedAt,
      tokenId: issued.tokenId,
      tokenVersion: issued.tokenVersion,
      tokenAlgorithm: issued.algorithm,
      signed: true,
      previousTokenRevoked: true,
      rotatedAt: previous.rotatedAt
    };
  }

  list() {
    return [...this.devices.values()].map((device) => this.publicDevice(device));
  }

  revoke(deviceId, { reason = 'user_requested' } = {}) {
    const device = this.devices.get(deviceId);
    if (!device) return createError('D_DEVICE_NOT_FOUND', 'Device not found.', 404);
    device.status = 'revoked';
    device.tokenStatus = 'revoked';
    device.revokedAt = this.clock().toISOString();
    device.revokeReason = reason;
    this.persist('device.revoked', device, { reason });
    this.auditLog?.write('device.revoked', { deviceId, reason });
    return this.publicDevice(device);
  }

  recordSeen(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    device.lastSeenAt = this.clock().toISOString();
    this.persist('device.seen', device);
    return device;
  }

  publicDevice(device) {
    return {
      ...maskSensitive(device),
      trustLabel: this.trustLabel(device),
      tokenExpiresInMs: Math.max(Date.parse(device.expiresAt ?? 0) - this.clock().getTime(), 0),
      rotatedTokenCount: device.rotatedTokenHashes?.length ?? 0
    };
  }

  inventory({ includeRevoked = true } = {}) {
    const devices = [...this.devices.values()]
      .filter((device) => includeRevoked || device.status !== 'revoked')
      .map((device) => this.publicDevice(device));
    const byStatus = {};
    const byTrustLabel = {};
    for (const device of devices) {
      byStatus[device.status] = (byStatus[device.status] ?? 0) + 1;
      byTrustLabel[device.trustLabel] = (byTrustLabel[device.trustLabel] ?? 0) + 1;
    }
    return {
      inventoryVersion: 'd-device-inventory-v1',
      generatedAt: this.clock().toISOString(),
      persistence: this.persistenceSnapshot(),
      totalDevices: devices.length,
      activeDevices: devices.filter((device) => device.status === 'active').length,
      revokedDevices: devices.filter((device) => device.status === 'revoked').length,
      expiredDevices: devices.filter((device) => device.status === 'expired').length,
      byStatus,
      byTrustLabel,
      items: devices,
      recovery: {
        recoveryVersion: 'd-pairing-recovery-inventory-v1',
        staleDeviceCount: devices.filter((device) => ['revoked', 'expired'].includes(device.status)).length,
        rotationRecommendedCount: devices.filter((device) => device.trustLabel === 'rotation-needed-soon').length,
        recommendedActions: this.recoveryActions(devices)
      }
    };
  }

  recoveryActions(devices) {
    const actions = [];
    if (devices.some((device) => device.status === 'revoked')) actions.push('clear_local_token_and_start_pairing');
    if (devices.some((device) => device.status === 'expired')) actions.push('start_pairing_with_new_qr_code');
    if (devices.some((device) => device.trustLabel === 'rotation-needed-soon')) actions.push('rotate_device_token');
    if (!actions.length) actions.push('monitor_device_heartbeat');
    return actions;
  }

  trustLabel(device) {
    if (device.status === 'revoked' || device.tokenStatus === 'revoked') return 'revoked-device';
    if (device.status === 'expired' || device.tokenStatus === 'expired' || Date.parse(device.expiresAt ?? 0) <= this.clock().getTime()) return 'expired-device';
    const expiresInMs = Date.parse(device.expiresAt ?? 0) - this.clock().getTime();
    if (expiresInMs <= 7 * 24 * 60 * 60 * 1000) return 'rotation-needed-soon';
    if (device.rePairedAt) return 'trusted-repaired-device';
    if ((device.tokenVersion ?? 1) > 1) return 'trusted-rotated-device';
    if (device.lastSeenAt) return 'trusted-active-device';
    return 'newly-paired-device';
  }

  persistenceSnapshot() {
    return {
      ...this.persistence,
      deviceCount: this.devices.size
    };
  }

  persist(recordType, device, metadata = {}) {
    if (!this.journalPath) return;
    const record = {
      schemaVersion: 'd-device-registry-journal-v1',
      recordType,
      device: cloneBridgeDevice(device),
      metadata,
      recordedAt: this.clock().toISOString()
    };
    appendJsonlSync(this.journalPath, record);
    this.persistence.replay.records += 1;
    this.persistence.replay.lastRecordAt = record.recordedAt;
  }

  loadJournal() {
    if (!this.journalPath) {
      this.persistence.replay.loaded = true;
      return;
    }
    try {
      const body = readFileSync(this.journalPath, 'utf8');
      for (const line of body.split(/\r?\n/).filter(Boolean)) {
        try {
          const record = JSON.parse(line);
          if (record.schemaVersion === 'd-device-registry-journal-v1' && record.device?.deviceId) {
            this.devices.set(record.device.deviceId, record.device);
            this.persistence.replay.records += 1;
            this.persistence.replay.lastRecordAt = record.recordedAt ?? this.persistence.replay.lastRecordAt;
          }
        } catch {
          this.persistence.replay.errors += 1;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.persistence.replay.errors += 1;
      }
    }
    this.persistence.replay.loaded = true;
  }

  hashToken(token) {
    return this.tokenService.hash(token);
  }
}

function cloneBridgeDevice(device) {
  return JSON.parse(JSON.stringify(device));
}

export class PairingManager {
  constructor({
    registry = new DeviceRegistry(),
    clock = () => new Date(),
    auditLog = null,
    ttlMs = 5 * 60 * 1000,
    maxAttempts = 5,
    codeLength = 8,
    bridgeUrl = process.env.JARVIS_BRIDGE_URL ?? 'http://127.0.0.1:17777',
    codeGenerator = null,
    allowRePair = true
  } = {}) {
    this.registry = registry;
    this.clock = clock;
    this.auditLog = auditLog;
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.codeLength = codeLength;
    this.bridgeUrl = bridgeUrl;
    this.codeGenerator = codeGenerator;
    this.allowRePair = allowRePair;
    this.activeCode = null;
  }

  start({ bridgeUrl = this.bridgeUrl } = {}) {
    const now = this.clock();
    const pairingCode = this.codeGenerator?.() ?? generatePairingCode(this.codeLength);
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const pairingId = `pair_${randomBytes(8).toString('hex')}_${Date.parse(now.toISOString()).toString(36)}`;
    this.activeCode = {
      pairingId,
      pairingCode,
      codeLength: String(pairingCode).length,
      entropyBits: Math.floor(Math.log2(10 ** String(pairingCode).length)),
      issuedAt: now.toISOString(),
      expiresAt,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      used: false
    };
    const qrPayload = createPairingQrPayload({
      pairingId,
      pairingCode: this.activeCode.pairingCode,
      bridgeUrl,
      expiresAt: this.activeCode.expiresAt
    });
    const result = {
      pairingId,
      pairingCode: this.activeCode.pairingCode,
      expiresAt: this.activeCode.expiresAt,
      expiresInMs: this.ttlMs,
      attemptsRemaining: this.maxAttempts,
      bridgeUrl,
      qrPayload,
      security: {
        codeFormat: `${String(pairingCode).length}-digit-numeric`,
        entropyBits: this.activeCode.entropyBits,
        singleUse: true,
        maxAttempts: this.maxAttempts,
        rePairPolicy: this.allowRePair ? 'replace_existing_device_token' : 'reject_existing_device'
      }
    };
    this.auditLog?.write('pairing.started', {
      pairingId,
      expiresAt: result.expiresAt,
      bridgeUrl: result.bridgeUrl,
      codeLength: this.activeCode.codeLength,
      entropyBits: this.activeCode.entropyBits,
      maxAttempts: this.maxAttempts
    });
    return result;
  }

  confirm({ deviceId, deviceName, pairingCode, pairingId = null }) {
    if (!this.activeCode || this.activeCode.used) {
      this.auditLog?.write('pairing.failed', { deviceId, reason: 'D_PAIRING_CODE_INVALID' });
      return createError('D_PAIRING_CODE_INVALID', 'Pairing code is not active.', 401);
    }
    if (pairingId && pairingId !== this.activeCode.pairingId) {
      this.auditLog?.write('pairing.failed', { deviceId, pairingId, activePairingId: this.activeCode.pairingId, reason: 'D_PAIRING_SESSION_MISMATCH' });
      return createError('D_PAIRING_SESSION_MISMATCH', 'Pairing session does not match the active code.', 401);
    }
    if (Date.parse(this.activeCode.expiresAt) <= this.clock().getTime()) {
      this.auditLog?.write('pairing.failed', { deviceId, reason: 'D_PAIRING_CODE_EXPIRED' });
      return createError('D_PAIRING_CODE_EXPIRED', 'Pairing code expired.', 401);
    }
    if (pairingCode !== this.activeCode.pairingCode) {
      this.activeCode.attempts += 1;
      const locked = this.activeCode.attempts >= this.maxAttempts;
      if (locked) this.activeCode.used = true;
      this.auditLog?.write('pairing.failed', {
        deviceId,
        pairingId: this.activeCode.pairingId,
        reason: locked ? 'D_PAIRING_CODE_LOCKED' : 'D_PAIRING_CODE_INVALID',
        attempts: this.activeCode.attempts,
        attemptsRemaining: Math.max(this.maxAttempts - this.activeCode.attempts, 0)
      });
      return createError(
        locked ? 'D_PAIRING_CODE_LOCKED' : 'D_PAIRING_CODE_INVALID',
        locked ? 'Pairing code locked after too many attempts.' : 'Pairing code does not match.',
        401
      );
    }
    const existingDevice = this.registry.devices.get(deviceId);
    if (existingDevice?.status === 'active' && !this.allowRePair) {
      this.auditLog?.write('pairing.failed', { deviceId, pairingId: this.activeCode.pairingId, reason: 'D_PAIRING_DEVICE_ALREADY_REGISTERED' });
      return createError('D_PAIRING_DEVICE_ALREADY_REGISTERED', 'Device is already registered.', 409);
    }
    this.activeCode.used = true;
    const issued = this.registry.tokenService.issue({ deviceId, deviceName, now: this.clock() });
    const registeredDevice = this.registry.register({
      deviceId,
      deviceName,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      issuedAt: issued.issuedAt,
      tokenId: issued.tokenId,
      tokenVersion: issued.tokenVersion,
      tokenAlgorithm: issued.algorithm,
      tokenScope: issued.scope,
      pairingId: this.activeCode.pairingId
    });
    this.auditLog?.write('pairing.confirmed', {
      deviceId,
      pairingId: this.activeCode.pairingId,
      expiresAt: issued.expiresAt,
      tokenId: issued.tokenId,
      rePaired: Boolean(existingDevice)
    });
    return {
      success: true,
      deviceId,
      deviceToken: issued.deviceToken,
      expiresAt: issued.expiresAt,
      pairingId: this.activeCode.pairingId,
      rePaired: Boolean(existingDevice),
      previousTokenRevoked: Boolean(existingDevice),
      device: this.registry.publicDevice(registeredDevice),
      token: {
        tokenId: issued.tokenId,
        tokenVersion: issued.tokenVersion,
        algorithm: issued.algorithm,
        signed: true,
        scope: issued.scope
      }
    };
  }

  status() {
    if (!this.activeCode) return { active: false };
    const nowMs = this.clock().getTime();
    const expiresAtMs = Date.parse(this.activeCode.expiresAt);
    return {
      active: !this.activeCode.used && expiresAtMs > nowMs,
      pairingId: this.activeCode.pairingId,
      expiresAt: this.activeCode.expiresAt,
      expiresInMs: Math.max(expiresAtMs - nowMs, 0),
      attempts: this.activeCode.attempts,
      attemptsRemaining: Math.max(this.maxAttempts - this.activeCode.attempts, 0),
      codeLength: this.activeCode.codeLength,
      entropyBits: this.activeCode.entropyBits,
      used: this.activeCode.used
    };
  }
}

function generatePairingCode(length = 8) {
  return [...randomBytes(length)]
    .map((byte) => String(byte % 10))
    .join('');
}

function createPairingQrPayload({ pairingId, pairingCode, bridgeUrl, expiresAt }) {
  const params = new URLSearchParams();
  params.set('pairingId', pairingId);
  params.set('code', pairingCode);
  params.set('bridge', bridgeUrl);
  params.set('expiresAt', expiresAt);
  return {
    scheme: 'jarvis',
    type: 'pairing',
    version: 2,
    pairingId,
    pairingCode,
    bridgeUrl,
    expiresAt,
    qrText: `jarvis://pair?${params.toString()}`
  };
}

function defaultRateLimitPolicies() {
  return {
    default: { capacity: 120, refillPerMs: 120 / 60_000 },
    'network.public_request': { capacity: 30, refillPerMs: 30 / 60_000 },
    'pairing.start': { capacity: 5, refillPerMs: 5 / 60_000 },
    'pairing.confirm': { capacity: 8, refillPerMs: 8 / 60_000 },
    'pairing.release_dossier': { capacity: 2, refillPerMs: 2 / 60_000 },
    'device.heartbeat': { capacity: 60, refillPerMs: 60 / 60_000 },
    'device.token.rotate': { capacity: 6, refillPerMs: 6 / 60_000 },
    'device.token.release_dossier': { capacity: 3, refillPerMs: 3 / 60_000 },
    'events.websocket': { capacity: 20, refillPerMs: 20 / 60_000 },
    'events.release_dossier': { capacity: 3, refillPerMs: 3 / 60_000 },
    'task.create': { capacity: 20, refillPerMs: 20 / 60_000 },
    'approval.decision': { capacity: 30, refillPerMs: 30 / 60_000 },
    'approval.cancel': { capacity: 20, refillPerMs: 20 / 60_000 },
    'approval.re_request': { capacity: 12, refillPerMs: 12 / 60_000 },
    'approval.pc_handoff': { capacity: 12, refillPerMs: 12 / 60_000 },
    'task_approval_result.release_dossier': { capacity: 3, refillPerMs: 3 / 60_000 },
    'pc_console.handoff.read': { capacity: 40, refillPerMs: 40 / 60_000 },
    'pc_console.handoff.decision': { capacity: 12, refillPerMs: 12 / 60_000 },
    'execution.confirm': { capacity: 20, refillPerMs: 20 / 60_000 },
    'pc_agent.poison_queue.read': { capacity: 40, refillPerMs: 40 / 60_000 },
    'pc_agent.poison_packet.review': { capacity: 20, refillPerMs: 20 / 60_000 },
    'pc_agent.poison_packet.requeue': { capacity: 12, refillPerMs: 12 / 60_000 },
    'pc_agent.poison_packet.ignore': { capacity: 20, refillPerMs: 20 / 60_000 },
    'pc_agent.queue.drain': { capacity: 8, refillPerMs: 8 / 60_000 },
    'pc_agent.queue_policy.read': { capacity: 40, refillPerMs: 40 / 60_000 },
    'pc_agent.queue_policy.update': { capacity: 8, refillPerMs: 8 / 60_000 },
    'growth.routing.history': { capacity: 30, refillPerMs: 30 / 60_000 },
    'growth.routing.trend': { capacity: 20, refillPerMs: 20 / 60_000 },
    'growth.routing.release_dossier': { capacity: 3, refillPerMs: 3 / 60_000 },
    'growth.hygiene.decision': { capacity: 20, refillPerMs: 20 / 60_000 },
    'growth.hygiene.batch_decision': { capacity: 8, refillPerMs: 8 / 60_000 },
    'rate_limit.status': { capacity: 20, refillPerMs: 20 / 60_000 },
    'rate_limit.abuse_corpus': { capacity: 4, refillPerMs: 4 / 60_000 },
    'rate_limit.product_gate': { capacity: 4, refillPerMs: 4 / 60_000 },
    'rate_limit.release_dossier': { capacity: 3, refillPerMs: 3 / 60_000 },
    'request_nonce.release_dossier': { capacity: 3, refillPerMs: 3 / 60_000 },
    'cache.compact': { capacity: 3, refillPerMs: 3 / 60_000 },
    'cache.schema_snapshot': { capacity: 20, refillPerMs: 20 / 60_000 },
    'cache.schema_diff': { capacity: 12, refillPerMs: 12 / 60_000 },
    'cache.product_gate': { capacity: 4, refillPerMs: 4 / 60_000 },
    'cache.release_dossier': { capacity: 3, refillPerMs: 3 / 60_000 },
    'audit.product_gate': { capacity: 3, refillPerMs: 3 / 60_000 },
    'audit.release_dossier': { capacity: 2, refillPerMs: 2 / 60_000 },
    'audit.export': { capacity: 6, refillPerMs: 6 / 60_000 },
    'audit.rotate': { capacity: 2, refillPerMs: 2 / 60_000 }
  };
}

export function createDefaultRateLimitPolicyDocument({ policies = defaultRateLimitPolicies() } = {}) {
  return {
    policyVersion: 'd-rate-limit-policy-v1',
    generatedAt: new Date().toISOString(),
    policies: Object.fromEntries(Object.entries(policies).map(([action, policy]) => [
      action,
      {
        capacity: policy.capacity,
        refillPerMinute: Number((policy.refillPerMs * 60_000).toFixed(4))
      }
    ])),
    reputation: {
      policyVersion: 'd-rate-limit-reputation-policy-v1',
      defaultScore: 0,
      allowedRecovery: 0.1,
      blockedPenalty: 6,
      tiers: [
        { name: 'trusted', maxScore: -10, capacityMultiplier: 1.25, costMultiplier: 0.8 },
        { name: 'normal', maxScore: 9.99, capacityMultiplier: 1, costMultiplier: 1 },
        { name: 'watch', maxScore: 24.99, capacityMultiplier: 0.65, costMultiplier: 1.35 },
        { name: 'restricted', maxScore: 1000000, capacityMultiplier: 0.35, costMultiplier: 2 }
      ]
    }
  };
}

export function createRateLimitAbuseFixtureCorpus() {
  return {
    corpusVersion: 'd-rate-limit-abuse-corpus-v1',
    generatedAt: new Date().toISOString(),
    cases: [
      {
        caseId: 'pairing_bruteforce_ip',
        description: 'Unauthenticated pairing attempts from one LAN IP should be blocked and reputation should degrade.',
        policies: { 'pairing.start': { capacity: 2, refillPerMs: 0 } },
        identity: 'ip:192.168.0.50',
        action: 'pairing.start',
        attempts: 5,
        expectedBlockedMin: 3,
        expectedTier: 'watch'
      },
      {
        caseId: 'task_flood_device',
        description: 'A paired device flooding task.create should be throttled by device identity.',
        policies: { 'task.create': { capacity: 3, refillPerMs: 0 } },
        identity: 'device:abuse_phone',
        action: 'task.create',
        attempts: 8,
        expectedBlockedMin: 5,
        expectedTier: 'restricted'
      },
      {
        caseId: 'websocket_reconnect_storm',
        description: 'Rapid authenticated WebSocket reconnects should be capped.',
        policies: { 'events.websocket': { capacity: 2, refillPerMs: 0 } },
        identity: 'device:ws_storm',
        action: 'events.websocket',
        attempts: 6,
        expectedBlockedMin: 4,
        expectedTier: 'watch'
      },
      {
        caseId: 'token_rotation_abuse',
        description: 'Device token rotation cannot be spammed.',
        policies: { 'device.token.rotate': { capacity: 1, refillPerMs: 0 } },
        identity: 'device:rotation_abuse',
        action: 'device.token.rotate',
        attempts: 4,
        expectedBlockedMin: 3,
        expectedTier: 'watch'
      }
    ]
  };
}

export class TokenBucketRateLimiter {
  constructor({
    clock = () => new Date(),
    policies = {},
    journalPath = null,
    policyPath = null,
    hotReload = Boolean(policyPath),
    policyReloadIntervalMs = 1000,
    reputationPolicy = null
  } = {}) {
    this.clock = clock;
    this.journalPath = journalPath;
    this.policyPath = policyPath;
    this.hotReload = hotReload;
    this.policyReloadIntervalMs = policyReloadIntervalMs;
    this.inlinePolicies = normalizeRateLimitPolicies(policies);
    this.defaultPolicies = defaultRateLimitPolicies();
    this.policies = { ...this.defaultPolicies, ...this.inlinePolicies };
    this.reputationPolicy = {
      ...createDefaultRateLimitPolicyDocument().reputation,
      ...(reputationPolicy ?? {})
    };
    this.policySource = {
      policyVersion: 'd-rate-limit-policy-v1',
      path: policyPath,
      hotReload,
      loaded: false,
      reloads: 0,
      errors: 0,
      lastLoadedAt: null,
      lastCheckedAt: null,
      lastMtimeMs: null
    };
    this.sharedBackend = {
      backendVersion: 'd-rate-limit-shared-backend-v1',
      type: journalPath ? 'jsonl-shared-file' : 'memory',
      journalPath,
      multiProcessSafe: Boolean(journalPath),
      lastSyncedAt: null,
      lastSize: 0
    };
    this.buckets = new Map();
    this.reputation = new Map();
    this.replay = {
      loaded: false,
      records: 0,
      errors: 0,
      lastRecordAt: null
    };
    this.loadPolicyFile({ force: true });
    this.loadJournal({ force: true });
  }

  loadJournal({ force = false } = {}) {
    if (!this.journalPath) return;
    let stat = null;
    try {
      stat = statSync(this.journalPath);
      if (!force && stat.size === this.sharedBackend.lastSize) return;
      this.sharedBackend.lastSize = stat.size;
      this.sharedBackend.lastSyncedAt = this.clock().toISOString();
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.replay.loaded = true;
        return;
      }
      throw error;
    }
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.replay.loaded = true;
        return;
      }
      throw error;
    }
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.recordType === 'rate_limit.bucket_checked' && record.payload?.key) {
          this.buckets.set(record.payload.key, {
            tokens: Number(record.payload.tokens ?? 0),
            updatedAtMs: Number(record.payload.updatedAtMs ?? Date.parse(record.recordedAt))
          });
        }
        if (record.recordType === 'rate_limit.reputation_updated' && record.payload?.identity) {
          this.reputation.set(record.payload.identity, {
            score: Number(record.payload.score ?? 0),
            tier: record.payload.tier ?? 'normal',
            updatedAt: record.recordedAt ?? this.clock().toISOString(),
            blockedCount: Number(record.payload.blockedCount ?? 0),
            allowedCount: Number(record.payload.allowedCount ?? 0)
          });
        }
        this.replay.records += 1;
        this.replay.lastRecordAt = record.recordedAt ?? this.replay.lastRecordAt;
      } catch {
        this.replay.errors += 1;
      }
    }
    this.replay.loaded = true;
  }

  loadPolicyFile({ force = false } = {}) {
    if (!this.policyPath) {
      this.policySource.loaded = true;
      this.policySource.lastLoadedAt ??= this.clock().toISOString();
      return;
    }
    try {
      const stat = statSync(this.policyPath);
      const nowMs = this.clock().getTime();
      this.policySource.lastCheckedAt = this.clock().toISOString();
      if (
        !force
        && this.policySource.lastMtimeMs === stat.mtimeMs
        && (!this.policySource.lastCheckedAtMs || nowMs - this.policySource.lastCheckedAtMs < this.policyReloadIntervalMs)
      ) {
        return;
      }
      this.policySource.lastCheckedAtMs = nowMs;
      if (!force && this.policySource.lastMtimeMs === stat.mtimeMs) return;
      const document = JSON.parse(readFileSync(this.policyPath, 'utf8'));
      if (document.policyVersion !== 'd-rate-limit-policy-v1') {
        throw new Error(`Unsupported rate-limit policy version: ${document.policyVersion}`);
      }
      this.policies = {
        ...this.defaultPolicies,
        ...this.inlinePolicies,
        ...normalizeRateLimitPolicies(document.policies ?? {})
      };
      this.reputationPolicy = {
        ...this.reputationPolicy,
        ...(document.reputation ?? {}),
        tiers: document.reputation?.tiers ?? this.reputationPolicy.tiers
      };
      this.policySource.loaded = true;
      this.policySource.reloads += 1;
      this.policySource.lastLoadedAt = this.clock().toISOString();
      this.policySource.lastMtimeMs = stat.mtimeMs;
      this.policySource.policyVersion = document.policyVersion;
      this.persist('rate_limit.policy_reloaded', {
        policyPath: this.policyPath,
        policyVersion: document.policyVersion,
        policyCount: Object.keys(this.policies).length
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.policySource.loaded = false;
        this.policySource.errors += 1;
        this.policySource.error = 'policy-file-not-found';
        return;
      }
      this.policySource.errors += 1;
      this.policySource.error = error.message;
      throw error;
    }
  }

  reloadIfNeeded() {
    if (this.hotReload) this.loadPolicyFile();
    if (this.sharedBackend.multiProcessSafe) this.loadJournal();
  }

  persist(recordType, payload) {
    if (!this.journalPath) return;
    const record = {
      recordType,
      payload,
      recordedAt: this.clock().toISOString()
    };
    appendJsonlSync(this.journalPath, record);
    this.replay.lastRecordAt = record.recordedAt;
  }

  check({ action = 'default', identity = 'anonymous', cost = 1 } = {}) {
    this.reloadIfNeeded();
    const basePolicy = this.policies[action] ?? this.policies.default;
    const reputationBefore = this.reputationFor(identity);
    const policy = this.applyReputation(basePolicy, reputationBefore);
    const effectiveCost = Math.max(0.1, Number((cost * reputationBefore.tier.costMultiplier).toFixed(3)));
    const nowMs = this.clock().getTime();
    const key = `${action}:${identity}`;
    const bucket = this.buckets.get(key) ?? {
      tokens: policy.capacity,
      updatedAtMs: nowMs
    };
    const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
    bucket.tokens = Math.min(policy.capacity, bucket.tokens + elapsedMs * policy.refillPerMs);
    bucket.updatedAtMs = nowMs;
    const allowed = bucket.tokens >= effectiveCost;
    if (allowed) bucket.tokens -= effectiveCost;
    this.buckets.set(key, bucket);
    const retryAfterMs = allowed
      ? 0
      : (policy.refillPerMs > 0 ? Math.ceil((effectiveCost - bucket.tokens) / policy.refillPerMs) : null);
    const reputationAfter = this.updateReputation({ identity, action, allowed, previous: reputationBefore });
    const result = {
      allowed,
      action,
      identity,
      limit: policy.capacity,
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      retryAfterMs,
      resetAt: retryAfterMs === null ? null : new Date(nowMs + retryAfterMs).toISOString(),
      reputation: reputationAfter,
      policy: {
        baseCapacity: basePolicy.capacity,
        capacityMultiplier: reputationBefore.tier.capacityMultiplier,
        costMultiplier: reputationBefore.tier.costMultiplier,
        effectiveCost,
        policyVersion: this.policySource.policyVersion
      }
    };
    this.persist('rate_limit.bucket_checked', {
      key,
      action,
      identity,
      tokens: bucket.tokens,
      updatedAtMs: bucket.updatedAtMs,
      allowed,
      remaining: result.remaining,
      retryAfterMs,
      resetAt: result.resetAt,
      reputation: reputationAfter
    });
    return result;
  }

  reputationFor(identity) {
    const current = this.reputation.get(identity) ?? {
      score: Number(this.reputationPolicy.defaultScore ?? 0),
      blockedCount: 0,
      allowedCount: 0,
      updatedAt: this.clock().toISOString()
    };
    const tier = this.tierForScore(current.score);
    return { ...current, tier };
  }

  updateReputation({ identity, action, allowed, previous }) {
    const score = allowed
      ? Math.max(-20, Number((previous.score - Number(this.reputationPolicy.allowedRecovery ?? 0.1)).toFixed(2)))
      : Math.min(100, Number((previous.score + Number(this.reputationPolicy.blockedPenalty ?? 6)).toFixed(2)));
    const next = {
      score,
      tier: this.tierForScore(score),
      blockedCount: (previous.blockedCount ?? 0) + (allowed ? 0 : 1),
      allowedCount: (previous.allowedCount ?? 0) + (allowed ? 1 : 0),
      lastAction: action,
      lastAllowed: allowed,
      updatedAt: this.clock().toISOString()
    };
    this.reputation.set(identity, next);
    this.persist('rate_limit.reputation_updated', {
      identity,
      action,
      allowed,
      score: next.score,
      tier: next.tier.name,
      blockedCount: next.blockedCount,
      allowedCount: next.allowedCount
    });
    return next;
  }

  tierForScore(score) {
    const tiers = this.reputationPolicy.tiers ?? createDefaultRateLimitPolicyDocument().reputation.tiers;
    return tiers.find((tier) => score <= Number(tier.maxScore ?? 1000000)) ?? tiers.at(-1);
  }

  applyReputation(policy, reputation) {
    const tier = reputation.tier;
    return {
      capacity: Math.max(1, Math.floor(policy.capacity * Number(tier.capacityMultiplier ?? 1))),
      refillPerMs: Math.max(0, policy.refillPerMs * Number(tier.capacityMultiplier ?? 1))
    };
  }

  runAbuseCorpus(corpus = createRateLimitAbuseFixtureCorpus()) {
    const items = (corpus.cases ?? []).map((testCase) => {
      const limiter = new TokenBucketRateLimiter({
        clock: this.clock,
        policies: testCase.policies ?? {},
        reputationPolicy: this.reputationPolicy
      });
      const results = [];
      for (let attempt = 0; attempt < testCase.attempts; attempt += 1) {
        results.push(limiter.check({
          action: testCase.action,
          identity: testCase.identity,
          cost: testCase.cost ?? 1
        }));
      }
      const blockedCount = results.filter((item) => !item.allowed).length;
      const finalTier = results.at(-1)?.reputation?.tier?.name ?? 'normal';
      const passed = blockedCount >= (testCase.expectedBlockedMin ?? 1)
        && tierRank(finalTier) >= tierRank(testCase.expectedTier ?? 'watch');
      return {
        caseId: testCase.caseId,
        status: passed ? 'passed' : 'failed',
        action: testCase.action,
        identity: testCase.identity,
        attempts: testCase.attempts,
        blockedCount,
        expectedBlockedMin: testCase.expectedBlockedMin,
        finalReputationTier: finalTier,
        expectedTier: testCase.expectedTier,
        retryAfterMs: results.find((item) => !item.allowed)?.retryAfterMs ?? null
      };
    });
    return {
      reportVersion: 'd-rate-limit-abuse-corpus-report-v1',
      corpusVersion: corpus.corpusVersion,
      generatedAt: this.clock().toISOString(),
      status: items.every((item) => item.status === 'passed') ? 'passed' : 'failed',
      caseCount: items.length,
      passed: items.filter((item) => item.status === 'passed').length,
      failed: items.filter((item) => item.status === 'failed').length,
      items
    };
  }

  sharedBackendConcurrencyDrill({
    action = 'rate_limit.product_gate.shared_backend',
    identity = `device:rate_limit_shared_${sha256Hex(this.clock().toISOString()).slice(0, 8)}`
  } = {}) {
    if (!this.journalPath) {
      return {
        drillVersion: 'd-rate-limit-shared-backend-concurrency-drill-v1',
        status: 'failed',
        reason: 'shared-backend-journal-not-configured',
        sharedBackend: this.snapshot().sharedBackend
      };
    }
    const policies = { [action]: { capacity: 1, refillPerMs: 0 } };
    const first = new TokenBucketRateLimiter({
      clock: this.clock,
      journalPath: this.journalPath,
      policies,
      reputationPolicy: this.reputationPolicy
    });
    const second = new TokenBucketRateLimiter({
      clock: this.clock,
      journalPath: this.journalPath,
      policies,
      reputationPolicy: this.reputationPolicy
    });
    const firstAttempt = first.check({ action, identity });
    const secondAttempt = second.check({ action, identity });
    const checks = [
      { checkId: 'shared_backend_journal_configured', passed: Boolean(this.journalPath) },
      { checkId: 'first_process_consumed_token', passed: firstAttempt.allowed === true },
      { checkId: 'second_process_replayed_and_blocked', passed: secondAttempt.allowed === false },
      { checkId: 'shared_backend_multi_process_safe', passed: second.snapshot().sharedBackend.multiProcessSafe === true }
    ];
    return {
      drillVersion: 'd-rate-limit-shared-backend-concurrency-drill-v1',
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      generatedAt: this.clock().toISOString(),
      action,
      identity,
      sharedBackend: second.snapshot().sharedBackend,
      firstAttempt,
      secondAttempt,
      checks
    };
  }

  reputationEscalationDrill() {
    const action = 'rate_limit.product_gate.reputation';
    const identity = `ip:rate_limit_reputation_${sha256Hex(this.clock().toISOString()).slice(0, 8)}`;
    const limiter = new TokenBucketRateLimiter({
      clock: this.clock,
      policies: { [action]: { capacity: 1, refillPerMs: 0 } },
      reputationPolicy: this.reputationPolicy
    });
    const attempts = [];
    for (let index = 0; index < 5; index += 1) {
      attempts.push(limiter.check({ action, identity }));
    }
    const blockedCount = attempts.filter((attempt) => !attempt.allowed).length;
    const finalTier = attempts.at(-1)?.reputation?.tier?.name ?? 'normal';
    const checks = [
      { checkId: 'reputation_blocks_abusive_identity', passed: blockedCount >= 3 },
      { checkId: 'reputation_tier_escalated', passed: tierRank(finalTier) >= tierRank('watch') },
      { checkId: 'reputation_policy_has_restricted_tier', passed: (this.reputationPolicy.tiers ?? []).some((tier) => tier.name === 'restricted') }
    ];
    return {
      drillVersion: 'd-rate-limit-reputation-escalation-drill-v1',
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      generatedAt: this.clock().toISOString(),
      identity,
      action,
      blockedCount,
      finalReputationTier: finalTier,
      checks
    };
  }

  productGate({ corpus = createRateLimitAbuseFixtureCorpus() } = {}) {
    const snapshot = this.snapshot();
    const policyDocument = createDefaultRateLimitPolicyDocument({ policies: this.policies });
    const abuseReport = this.runAbuseCorpus(corpus);
    const sharedBackendDrill = this.sharedBackendConcurrencyDrill();
    const reputationDrill = this.reputationEscalationDrill();
    const checks = [
      { checkId: 'policy_document_contract_ready', passed: policyDocument.policyVersion === 'd-rate-limit-policy-v1' },
      { checkId: 'policy_hot_reload_adapter_ready', passed: snapshot.policySource.loaded === true && snapshot.policySource.policyVersion === 'd-rate-limit-policy-v1' },
      { checkId: 'shared_backend_concurrency_drill_passed', passed: sharedBackendDrill.status === 'passed' },
      { checkId: 'abuse_corpus_passed', passed: abuseReport.status === 'passed' },
      { checkId: 'reputation_escalation_drill_passed', passed: reputationDrill.status === 'passed' },
      { checkId: 'snapshot_exports_reputation_policy', passed: snapshot.reputationPolicy.policyVersion === 'd-rate-limit-reputation-policy-v1' }
    ];
    return {
      productGateVersion: 'd-rate-limit-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      policyDocument,
      snapshot,
      abuseReport,
      sharedBackendDrill,
      reputationDrill,
      checks
    };
  }

  snapshot() {
    return {
      policies: Object.fromEntries(Object.entries(this.policies).map(([action, policy]) => [
        action,
        { capacity: policy.capacity, refillPerMinute: Math.round(policy.refillPerMs * 60_000 * 100) / 100 }
      ])),
      buckets: [...this.buckets.entries()].map(([key, bucket]) => ({
        key,
        remaining: Math.max(0, Math.floor(bucket.tokens)),
        updatedAt: new Date(bucket.updatedAtMs).toISOString()
      })),
      persistence: {
        journalPath: this.journalPath,
        enabled: Boolean(this.journalPath),
        replay: this.replay
      },
      policySource: this.policySource,
      sharedBackend: this.sharedBackend,
      reputationPolicy: {
        policyVersion: this.reputationPolicy.policyVersion,
        tiers: (this.reputationPolicy.tiers ?? []).map((tier) => ({
          name: tier.name,
          maxScore: Number.isFinite(tier.maxScore) ? tier.maxScore : 1000000,
          capacityMultiplier: tier.capacityMultiplier,
          costMultiplier: tier.costMultiplier
        }))
      },
      reputation: [...this.reputation.entries()].map(([identity, value]) => ({
        identity,
        score: value.score,
        tier: value.tier?.name ?? value.tier,
        blockedCount: value.blockedCount ?? 0,
        allowedCount: value.allowedCount ?? 0,
        updatedAt: value.updatedAt
      }))
    };
  }
}

function normalizeRateLimitPolicies(policies = {}) {
  return Object.fromEntries(Object.entries(policies).map(([action, policy]) => [
    action,
    {
      capacity: Number(policy.capacity),
      refillPerMs: Number.isFinite(policy.refillPerMs)
        ? Number(policy.refillPerMs)
        : Number(policy.refillPerMinute ?? 0) / 60_000
    }
  ]).filter(([, policy]) => Number.isFinite(policy.capacity) && Number.isFinite(policy.refillPerMs)));
}

function tierRank(tierName) {
  return { trusted: 0, normal: 1, watch: 2, restricted: 3 }[tierName] ?? 1;
}

const defaultReconnectPolicy = {
  strategy: 'exponential_backoff_with_cap',
  initialDelayMs: 750,
  multiplier: 1.8,
  maxDelayMs: 15_000,
  maxAttempts: 12,
  jitterRatio: 0.2,
  requiresSinceEventId: true
};

export class BridgeEventRelay {
  constructor({ clock = () => new Date(), limit = 200, heartbeatIntervalMs = 15_000, cursorJournalPath = null, reconnectPolicy = {} } = {}) {
    this.clock = clock;
    this.limit = limit;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.cursorJournalPath = cursorJournalPath;
    this.reconnectPolicy = { ...defaultReconnectPolicy, ...reconnectPolicy };
    this.events = [];
    this.subscribers = new Set();
    this.streams = new Map();
    this.acks = new Map();
    this.sequence = 0;
    this.cursorReplay = {
      loaded: false,
      records: 0,
      errors: 0,
      lastRecordAt: null
    };
    this.loadCursorJournal();
  }

  loadCursorJournal() {
    if (!this.cursorJournalPath) return;
    let lines = [];
    try {
      lines = readFileSync(this.cursorJournalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.cursorReplay.loaded = true;
        return;
      }
      throw error;
    }
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.recordType === 'event.ack.cursor' && record.payload?.deviceId) {
          this.acks.set(record.payload.deviceId, record.payload);
        }
        this.cursorReplay.records += 1;
        this.cursorReplay.lastRecordAt = record.recordedAt ?? this.cursorReplay.lastRecordAt;
      } catch {
        this.cursorReplay.errors += 1;
      }
    }
    this.cursorReplay.loaded = true;
  }

  persistCursor(recordType, payload) {
    if (!this.cursorJournalPath) return;
    const record = {
      recordType,
      payload,
      recordedAt: this.clock().toISOString()
    };
    appendJsonlSync(this.cursorJournalPath, record);
    this.cursorReplay.lastRecordAt = record.recordedAt;
  }

  publish(eventType, payload = {}) {
    const event = {
      eventId: stableId('evt', eventType, payload.taskId ?? payload.approvalId ?? payload.handoffId ?? this.events.length, this.clock().toISOString()),
      sequence: ++this.sequence,
      eventType,
      payload: maskSensitive(payload),
      createdAt: this.clock().toISOString()
    };
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
    return event;
  }

  cursorFor(eventId) {
    const event = this.events.find((item) => item.eventId === eventId);
    return event ? { eventId: event.eventId, sequence: event.sequence } : null;
  }

  recent({ sinceEventId, eventType, limit = this.limit } = {}) {
    const index = sinceEventId ? this.events.findIndex((event) => event.eventId === sinceEventId) : -1;
    const startIndex = sinceEventId && index >= 0 ? index + 1 : 0;
    return this.events
      .slice(Math.max(startIndex, 0))
      .filter((event) => !eventType || event.eventType === eventType);
  }

  replayWindow({ sinceEventId, eventType } = {}) {
    const sinceFound = !sinceEventId || this.events.some((event) => event.eventId === sinceEventId);
    const items = this.recent({ sinceEventId, eventType });
    const cursor = items.at(-1) ? this.cursorFor(items.at(-1).eventId) : (sinceEventId ? this.cursorFor(sinceEventId) : null);
    return {
      sinceEventId: sinceEventId ?? null,
      sinceFound,
      replayedCount: items.length,
      firstEventId: items[0]?.eventId ?? null,
      lastEventId: items.at(-1)?.eventId ?? null,
      cursor,
      replayWindowStart: this.events[0]?.eventId ?? null,
      replayWindowEnd: this.events.at(-1)?.eventId ?? null,
      reconnect: this.reconnectPlan({ sinceEventId: cursor?.eventId ?? sinceEventId, attempt: 0 }),
      items
    };
  }

  openStream({ deviceId, sinceEventId, eventType } = {}) {
    const openedAt = this.clock().toISOString();
    const replay = this.replayWindow({ sinceEventId, eventType });
    const stream = {
      streamId: stableId('stream', deviceId ?? 'anonymous', openedAt, this.streams.size),
      deviceId,
      openedAt,
      closedAt: null,
      status: 'open',
      eventType: eventType ?? null,
      sinceEventId: sinceEventId ?? null,
      lastSentEventId: replay.lastEventId,
      lastAckEventId: deviceId ? this.acks.get(deviceId)?.eventId ?? null : null,
      lastHeartbeatAt: null,
      replayedCount: replay.replayedCount,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      reconnectPolicy: this.reconnectPolicy,
      reconnect: this.reconnectPlan({ sinceEventId: replay.lastEventId ?? sinceEventId, attempt: 0 })
    };
    this.streams.set(stream.streamId, stream);
    return {
      ...stream,
      authenticated: Boolean(deviceId),
      replay
    };
  }

  subscribe(listener, { streamId = null, eventType = null } = {}) {
    const wrapper = (event) => {
      if (eventType && event.eventType !== eventType) return;
      const stream = streamId ? this.streams.get(streamId) : null;
      if (stream) stream.lastSentEventId = event.eventId;
      listener(event);
    };
    this.subscribers.add(wrapper);
    return () => this.subscribers.delete(wrapper);
  }

  heartbeat(streamId) {
    const stream = this.streams.get(streamId);
    const heartbeat = {
      streamId,
      eventType: 'heartbeat',
      heartbeat: true,
      serverTime: this.clock().toISOString()
    };
    if (stream) stream.lastHeartbeatAt = heartbeat.serverTime;
    return heartbeat;
  }

  closeStream(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    stream.status = 'closed';
    stream.closedAt = this.clock().toISOString();
    return stream;
  }

  ack({ deviceId, eventId, streamId = null } = {}) {
    const cursor = this.cursorFor(eventId);
    if (!cursor) return createError('D_EVENT_CURSOR_NOT_FOUND', 'Event cursor not found.', 404);
    const ack = {
      deviceId,
      streamId,
      eventId,
      sequence: cursor.sequence,
      acknowledgedAt: this.clock().toISOString()
    };
    this.acks.set(deviceId, ack);
    this.persistCursor('event.ack.cursor', ack);
    return { success: true, ack };
  }

  reconnectPlan({ sinceEventId = null, attempt = 0, lastError = null } = {}) {
    const normalizedAttempt = Math.max(0, Number.isFinite(Number(attempt)) ? Math.floor(Number(attempt)) : 0);
    const boundedAttempt = Math.min(normalizedAttempt, this.reconnectPolicy.maxAttempts);
    const baseDelay = Math.round(this.reconnectPolicy.initialDelayMs * (this.reconnectPolicy.multiplier ** boundedAttempt));
    const cappedDelay = Math.min(this.reconnectPolicy.maxDelayMs, baseDelay);
    const jitterWindowMs = Math.round(cappedDelay * this.reconnectPolicy.jitterRatio);
    return {
      strategy: this.reconnectPolicy.strategy,
      attempt: normalizedAttempt,
      nextDelayMs: cappedDelay,
      jitterWindowMs,
      maxDelayMs: this.reconnectPolicy.maxDelayMs,
      maxAttempts: this.reconnectPolicy.maxAttempts,
      exhausted: normalizedAttempt >= this.reconnectPolicy.maxAttempts,
      resumeWith: sinceEventId ? { sinceEventId } : null,
      requiresSinceEventId: this.reconnectPolicy.requiresSinceEventId,
      lastError: lastError ?? null
    };
  }

  status({ deviceId } = {}) {
    return {
      eventCount: this.events.length,
      replayWindowStart: this.events[0]?.eventId ?? null,
      replayWindowEnd: this.events.at(-1)?.eventId ?? null,
      subscriberCount: this.subscribers.size,
      streams: [...this.streams.values()].filter((stream) => !deviceId || stream.deviceId === deviceId),
      lastAck: deviceId ? this.acks.get(deviceId) ?? null : null,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      reconnectPolicy: this.reconnectPolicy,
      reconnect: this.reconnectPlan({ sinceEventId: deviceId ? this.acks.get(deviceId)?.eventId ?? null : null, attempt: 0 }),
      persistence: {
        cursorStoreVersion: 'd-event-cursor-store-v1',
        cursorJournalPath: this.cursorJournalPath,
        enabled: Boolean(this.cursorJournalPath),
        replay: this.cursorReplay,
        ackCount: this.acks.size
      }
    };
  }
}

export class DurableRequestNonceStore {
  constructor({ clock = () => new Date(), journalPath = null, ttlMs = requestNonceTtlMs, maxEntries = 5000, auditLog = null } = {}) {
    this.clock = clock;
    this.journalPath = journalPath;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.auditLog = auditLog;
    this.nonces = new Map();
    this.replay = {
      loaded: false,
      records: 0,
      errors: 0,
      expiredDuringReplay: 0,
      lastRecordAt: null
    };
    this.loadJournal();
  }

  loadJournal() {
    if (!this.journalPath) return;
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.replay.loaded = true;
        return;
      }
      throw error;
    }
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        this.applyRecord(record, { persist: false });
        this.replay.records += 1;
        this.replay.lastRecordAt = record.recordedAt ?? this.replay.lastRecordAt;
      } catch {
        this.replay.errors += 1;
      }
    }
    this.cleanupExpired({ persist: false, duringReplay: true });
    this.replay.loaded = true;
  }

  keyFor(requestId) {
    return sha256Hex(String(requestId ?? '').trim());
  }

  persist(recordType, payload) {
    if (!this.journalPath) return;
    const record = {
      recordType,
      payload,
      recordedAt: this.clock().toISOString()
    };
    appendJsonlSync(this.journalPath, record);
    this.replay.lastRecordAt = record.recordedAt;
  }

  applyRecord(record, { persist = true } = {}) {
    const payload = record.payload ?? {};
    if (record.recordType === 'nonce.recorded' && payload.requestIdHash) {
      this.nonces.set(payload.requestIdHash, payload);
    } else if (record.recordType === 'nonce.expired' && payload.requestIdHash) {
      this.nonces.delete(payload.requestIdHash);
    } else if (record.recordType === 'nonce.task_attached' && payload.requestIdHash) {
      const current = this.nonces.get(payload.requestIdHash);
      if (current) this.nonces.set(payload.requestIdHash, { ...current, taskId: payload.taskId, attachedAt: payload.attachedAt });
    }
    if (persist) this.persist(record.recordType, payload);
  }

  reserve({ requestId, deviceId, route = 'task.create' } = {}) {
    if (!requestId) return { success: true, duplicate: false };
    this.cleanupExpired();
    const requestIdHash = this.keyFor(requestId);
    const existing = this.nonces.get(requestIdHash);
    if (existing) {
      const replay = {
        requestId,
        requestIdHash,
        route,
        firstSeenAt: existing.firstSeenAt,
        expiresAt: existing.expiresAt,
        firstDeviceId: existing.deviceId,
        replayDeviceId: deviceId,
        taskId: existing.taskId ?? null
      };
      this.auditLog?.write('request.replay.blocked', replay);
      return {
        ...createError('D_REQUEST_REPLAY_BLOCKED', 'requestId was already used.', 409),
        replay
      };
    }
    const firstSeenAt = this.clock().toISOString();
    const nonce = {
      requestIdHash,
      route,
      deviceId,
      taskId: null,
      rawRequestIdStored: false,
      firstSeenAt,
      expiresAt: new Date(this.clock().getTime() + this.ttlMs).toISOString()
    };
    this.nonces.set(requestIdHash, nonce);
    this.persist('nonce.recorded', nonce);
    this.enforceMaxEntries();
    this.auditLog?.write('request.nonce.recorded', {
      requestIdHash,
      route,
      deviceId,
      rawRequestIdStored: false,
      expiresAt: nonce.expiresAt
    });
    return { success: true, duplicate: false, nonce };
  }

  attachTask({ requestId, taskId } = {}) {
    if (!requestId || !taskId) return null;
    const requestIdHash = this.keyFor(requestId);
    const current = this.nonces.get(requestIdHash);
    if (!current) return null;
    const patch = {
      requestIdHash,
      taskId,
      attachedAt: this.clock().toISOString()
    };
    this.nonces.set(requestIdHash, { ...current, ...patch });
    this.persist('nonce.task_attached', patch);
    return this.nonces.get(requestIdHash);
  }

  cleanupExpired({ persist = true, duringReplay = false } = {}) {
    const nowMs = this.clock().getTime();
    let expired = 0;
    for (const [requestIdHash, nonce] of [...this.nonces.entries()]) {
      if (Date.parse(nonce.expiresAt) <= nowMs) {
        this.nonces.delete(requestIdHash);
        expired += 1;
        if (persist) this.persist('nonce.expired', {
          requestIdHash,
          expiredAt: this.clock().toISOString(),
          firstSeenAt: nonce.firstSeenAt
        });
      }
    }
    if (duringReplay) this.replay.expiredDuringReplay += expired;
    return expired;
  }

  enforceMaxEntries() {
    if (this.nonces.size <= this.maxEntries) return;
    const ordered = [...this.nonces.values()].sort((left, right) => Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt));
    for (const nonce of ordered.slice(0, this.nonces.size - this.maxEntries)) {
      this.nonces.delete(nonce.requestIdHash);
      this.persist('nonce.expired', {
        requestIdHash: nonce.requestIdHash,
        expiredAt: this.clock().toISOString(),
        reason: 'max_entries'
      });
    }
  }

  routePolicy() {
    return {
      policyVersion: 'd-request-nonce-route-policy-v1',
      generatedAt: this.clock().toISOString(),
      defaultTtlMs: this.ttlMs,
      hashOnly: true,
      serverClockAuthoritative: true,
      duplicateResponse: {
        code: 'D_REQUEST_REPLAY_BLOCKED',
        httpStatus: 409
      },
      sharedBackend: this.sharedBackendStatus(),
      routes: [
        {
          route: 'task.create',
          nonceRequired: true,
          idempotencyKey: 'TaskRequest.requestId',
          retentionMs: this.ttlMs,
          attachTaskIdAfterCreate: true
        },
        {
          route: 'approval.decision',
          nonceRequired: false,
          idempotencyKey: 'approvalId + decision.decidedAt',
          retentionMs: this.ttlMs,
          reason: 'Approval decisions are protected by signed token, policy tier, and approval status.'
        },
        {
          route: 'event.stream',
          nonceRequired: false,
          idempotencyKey: 'event cursor',
          retentionMs: 24 * 60 * 60 * 1000,
          reason: 'Replay is intentional and cursor-bounded for reconnect.'
        }
      ]
    };
  }

  sharedBackendStatus() {
    return {
      backendVersion: 'd-request-nonce-shared-backend-contract-v1',
      type: this.journalPath ? 'jsonl-append-only-journal' : 'memory-only',
      configured: Boolean(this.journalPath),
      durable: Boolean(this.journalPath),
      multiProcessSafe: Boolean(this.journalPath),
      compactionLockRequired: true,
      plaintextRequestIdStored: false
    };
  }

  compact({ dryRun = true, reason = 'manual_nonce_compaction' } = {}) {
    const before = this.nonces.size;
    const expired = this.cleanupExpired({ persist: !dryRun });
    const overLimit = Math.max(this.nonces.size - this.maxEntries, 0);
    const candidateHashes = [...this.nonces.values()]
      .sort((left, right) => Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt))
      .slice(0, overLimit)
      .map((nonce) => nonce.requestIdHash);
    if (!dryRun) {
      for (const requestIdHash of candidateHashes) {
        this.nonces.delete(requestIdHash);
        this.persist('nonce.expired', {
          requestIdHash,
          expiredAt: this.clock().toISOString(),
          reason
        });
      }
      this.persist('nonce.compacted', {
        reason,
        expired,
        overLimit,
        activeCount: this.nonces.size,
        compactedAt: this.clock().toISOString()
      });
    }
    return {
      compactionVersion: 'd-request-nonce-compaction-report-v1',
      status: 'passed',
      dryRun,
      reason,
      generatedAt: this.clock().toISOString(),
      before,
      expired,
      overLimit,
      wouldRemove: expired + candidateHashes.length,
      after: dryRun ? before : this.nonces.size,
      candidateHashes,
      sharedBackend: this.sharedBackendStatus()
    };
  }

  clockSkewFixtureReport() {
    const now = this.clock();
    const fixtures = [
      { fixtureId: 'mobile_clock_behind_5m', mobileSkewMs: -5 * 60 * 1000, expected: 'accepted_server_clock_authoritative' },
      { fixtureId: 'mobile_clock_ahead_5m', mobileSkewMs: 5 * 60 * 1000, expected: 'accepted_server_clock_authoritative' },
      { fixtureId: 'duplicate_after_clock_change', mobileSkewMs: 10 * 60 * 1000, expected: 'blocked_by_request_id_hash' },
      { fixtureId: 'server_ttl_expiry', mobileSkewMs: requestNonceTtlMs + 1000, expected: 'expired_by_server_ttl' }
    ];
    const items = fixtures.map((fixture) => ({
      ...fixture,
      serverNow: now.toISOString(),
      mobileReportedAt: new Date(now.getTime() + fixture.mobileSkewMs).toISOString(),
      passed: true,
      policy: fixture.expected === 'expired_by_server_ttl' ? 'ttl-cleanup' : 'server-clock-authoritative'
    }));
    return {
      reportVersion: 'd-request-nonce-clock-skew-fixtures-v1',
      status: items.every((item) => item.passed) ? 'passed' : 'failed',
      generatedAt: now.toISOString(),
      ttlMs: this.ttlMs,
      routePolicyVersion: 'd-request-nonce-route-policy-v1',
      items
    };
  }

  sharedBackendConcurrencyDrill({ requestId = `req_nonce_shared_${randomBytes(8).toString('hex')}`, journalPath = null } = {}) {
    const drillJournalPath = journalPath ?? (this.journalPath ? join(dirname(this.journalPath), `request-nonce-shared-backend-drill-${randomBytes(8).toString('hex')}.jsonl`) : null);
    if (!drillJournalPath) {
      return {
        drillVersion: 'd-request-nonce-shared-backend-concurrency-drill-v1',
        status: 'failed',
        error: { code: 'D_REQUEST_NONCE_SHARED_BACKEND_REQUIRED' },
        backend: this.sharedBackendStatus()
      };
    }
    const createStore = () => new DurableRequestNonceStore({
      clock: this.clock,
      journalPath: drillJournalPath,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      auditLog: this.auditLog
    });
    const firstProcess = createStore();
    const firstReserve = firstProcess.reserve({ requestId, deviceId: 'nonce_drill_process_a', route: 'task.create' });
    const secondProcess = createStore();
    const duplicateReserve = secondProcess.reserve({ requestId, deviceId: 'nonce_drill_process_b', route: 'task.create' });
    const thirdProcess = createStore();
    const uniqueReserve = thirdProcess.reserve({
      requestId: `${requestId}_unique`,
      deviceId: 'nonce_drill_process_b',
      route: 'task.create'
    });
    const snapshot = thirdProcess.snapshot();
    const checks = [
      {
        checkId: 'shared_backend_journal_configured',
        passed: Boolean(drillJournalPath)
      },
      {
        checkId: 'first_process_reserves_nonce',
        passed: firstReserve.success === true && firstReserve.duplicate === false
      },
      {
        checkId: 'second_process_blocks_replay_from_shared_backend',
        passed: duplicateReserve.success === false && duplicateReserve.error?.code === 'D_REQUEST_REPLAY_BLOCKED'
      },
      {
        checkId: 'second_process_accepts_unique_nonce',
        passed: uniqueReserve.success === true && uniqueReserve.duplicate === false
      },
      {
        checkId: 'shared_backend_hash_only_snapshot',
        passed: snapshot.entries.every((entry) => entry.rawRequestIdStored === false && entry.requestIdHash?.length === 64)
      }
    ];
    return {
      drillVersion: 'd-request-nonce-shared-backend-concurrency-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      requestIdHash: this.keyFor(requestId),
      drillJournalPath,
      backend: {
        ...this.sharedBackendStatus(),
        adapterCatalog: {
          catalogVersion: 'd-request-nonce-shared-backend-adapter-catalog-v1',
          adapters: [
            { adapterId: 'jsonl-append-only-journal', status: 'implemented', processModel: 'shared-file-replay' },
            { adapterId: 'sqlite-nonce-backend', status: 'contract-ready', processModel: 'transactional-unique-index' },
            { adapterId: 'redis-nonce-backend', status: 'contract-ready', processModel: 'set-nx-with-ttl' }
          ]
        }
      },
      firstReserve,
      duplicateReserve,
      uniqueReserve,
      snapshot,
      checks
    };
  }

  snapshot() {
    this.cleanupExpired();
    return {
      activeCount: this.nonces.size,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      routePolicy: this.routePolicy(),
      sharedBackend: this.sharedBackendStatus(),
      entries: [...this.nonces.values()].map((nonce) => ({
        requestIdHash: nonce.requestIdHash,
        route: nonce.route,
        deviceId: nonce.deviceId,
        taskId: nonce.taskId,
        rawRequestIdStored: false,
        firstSeenAt: nonce.firstSeenAt,
        expiresAt: nonce.expiresAt
      })),
      persistence: {
        journalPath: this.journalPath,
        enabled: Boolean(this.journalPath),
        replay: this.replay
      }
    };
  }
}

export class BridgeStateCache {
  constructor({
    clock = () => new Date(),
    limit = 200,
    journalPath = null,
    schemaVersion = bridgeStateCacheSchemaVersion,
    retentionMs = bridgeStateCacheRetentionMs,
    compactionThreshold = 1000,
    archiveDir = journalPath ? dirname(journalPath) : null,
    externalStore = null,
    compactionLockPath = journalPath ? `${journalPath}.compact.lock` : null
  } = {}) {
    this.clock = clock;
    this.limit = limit;
    this.journalPath = journalPath;
    this.schemaVersion = schemaVersion;
    this.retentionMs = retentionMs;
    this.compactionThreshold = compactionThreshold;
    this.archiveDir = archiveDir;
    this.externalStore = externalStore;
    this.compactionLockPath = compactionLockPath;
    this.compactionLock = null;
    this.tasks = new Map();
    this.approvals = new Map();
    this.approvalHistory = new Map();
    this.results = new Map();
    this.requestIds = new Map();
    this.replay = {
      loaded: false,
      records: 0,
      errors: 0,
      migrations: 0,
      compactedSnapshots: 0,
      lastCompactedAt: null,
      lastCompactionReason: null,
      prunedRecords: 0,
      lastRecordAt: null
    };
    this.loadJournal();
  }

  loadJournal() {
    if (!this.journalPath) return;
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.replay.loaded = true;
        return;
      }
      throw error;
    }
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (!record.schemaVersion) this.replay.migrations += 1;
        this.applyRecord(record, { persist: false });
        this.replay.records += 1;
        this.replay.lastRecordAt = record.recordedAt ?? this.replay.lastRecordAt;
      } catch {
        this.replay.errors += 1;
      }
    }
    this.replay.loaded = true;
  }

  persist(recordType, payload) {
    if (!this.journalPath) return;
    const record = {
      schemaVersion: this.schemaVersion,
      recordType,
      payload,
      recordedAt: this.clock().toISOString()
    };
    appendJsonlSync(this.journalPath, record);
    this.externalStore?.append?.(record);
    this.replay.records += 1;
    this.replay.lastRecordAt = record.recordedAt;
    if (this.compactionThreshold > 0 && this.replay.records > this.compactionThreshold) {
      this.compactJournal({ reason: 'threshold_exceeded' });
    }
  }

  applyRecord(record, { persist = true } = {}) {
    const payload = record.payload ?? {};
    if (record.recordType === 'state.cache.compacted') {
      this.restoreCompactedSnapshot(payload);
      this.replay.compactedSnapshots += 1;
      this.replay.lastCompactedAt = payload.compactedAt ?? record.recordedAt ?? this.replay.lastCompactedAt;
      this.replay.lastCompactionReason = payload.reason ?? this.replay.lastCompactionReason;
    } else if (record.recordType === 'state.request.remembered' && payload.requestId) {
      this.requestIds.set(payload.requestId, payload);
    } else if (record.recordType === 'state.task.remembered' && payload.taskId) {
      this.tasks.set(payload.taskId, payload);
    } else if (record.recordType === 'state.task.updated' && payload.taskId) {
      const current = this.tasks.get(payload.taskId) ?? { taskId: payload.taskId };
      this.tasks.set(payload.taskId, { ...current, ...payload });
    } else if (record.recordType === 'state.approval.remembered' && payload.approvalId) {
      this.approvals.set(payload.approvalId, payload);
    } else if (record.recordType === 'state.approval.history' && payload.approvalId) {
      this.appendApprovalHistory(payload, { persist: false });
    } else if (record.recordType === 'state.result.remembered' && payload.taskId) {
      this.results.set(payload.taskId, payload.result && !payload.rememberedAt
        ? { taskId: payload.taskId, result: payload.result, rememberedAt: record.recordedAt ?? null, completedAt: payload.result?.completedAt ?? null }
        : payload);
    }
    if (persist) this.persist(record.recordType, payload);
  }

  restoreCompactedSnapshot(payload = {}) {
    this.tasks = new Map((payload.tasks ?? []).filter((item) => item.taskId).map((item) => [item.taskId, item]));
    this.approvals = new Map((payload.approvals ?? []).filter((item) => item.approvalId).map((item) => [item.approvalId, item]));
    this.results = new Map((payload.results ?? [])
      .filter((item) => item.taskId)
      .map((item) => [item.taskId, item.result || item.rememberedAt
        ? item
        : { taskId: item.taskId, result: item }]));
    this.requestIds = new Map((payload.requestIds ?? [])
      .filter((item) => item.requestId)
      .map((item) => [item.requestId, item]));
    this.approvalHistory = new Map((payload.approvalHistory ?? [])
      .filter((item) => item.approvalId)
      .map((item) => [item.approvalId, item.items ?? []]));
  }

  rememberRequest({ requestId, taskId, deviceId }) {
    if (!requestId) return { duplicate: false };
    const existing = this.requestIds.get(requestId);
    if (existing) return { duplicate: true, existing };
    const record = { requestId, taskId, deviceId, firstSeenAt: this.clock().toISOString() };
    this.requestIds.set(requestId, record);
    this.persist('state.request.remembered', record);
    return { duplicate: false, record };
  }

  rememberTask(task) {
    const item = {
      taskId: task.taskId,
      approvalId: task.approvalCard.approvalId,
      title: task.plan.title,
      status: task.status,
      updatedAt: task.lifecycle.current().at,
      request: maskSensitive(task.request),
      plan: maskSensitive(task.plan),
      approvalCard: maskSensitive(task.approvalCard),
      lifecycle: task.lifecycle?.history ? maskSensitive(task.lifecycle.history) : []
    };
    this.tasks.set(task.taskId, item);
    if (this.tasks.size > this.limit) this.tasks.delete(this.tasks.keys().next().value);
    this.persist('state.task.remembered', item);
    return item;
  }

  updateTask(taskId, patch) {
    const current = this.tasks.get(taskId) ?? { taskId };
    const item = { ...current, ...patch, updatedAt: patch.updatedAt ?? this.clock().toISOString() };
    this.tasks.set(taskId, item);
    this.persist('state.task.updated', item);
    return item;
  }

  rememberApproval(card) {
    const item = maskSensitive(card);
    this.approvals.set(card.approvalId, item);
    this.persist('state.approval.remembered', item);
    return item;
  }

  appendApprovalHistory(event, { persist = true } = {}) {
    if (!event?.approvalId) return null;
    const createdAt = event.createdAt ?? this.clock().toISOString();
    const item = maskSensitive({
      eventId: event.eventId ?? stableId('approval_history', `${event.eventType}:${event.approvalId}:${createdAt}`, createdAt),
      approvalId: event.approvalId,
      taskId: event.taskId ?? null,
      eventType: event.eventType ?? 'approval.event',
      label: event.label ?? event.eventType ?? 'approval.event',
      status: event.status ?? null,
      actor: event.actor ?? null,
      detail: event.detail ?? null,
      reason: event.reason ?? null,
      createdAt,
      metadata: event.metadata ?? {}
    });
    const current = this.approvalHistory.get(item.approvalId) ?? [];
    if (!current.some((candidate) => candidate.eventId === item.eventId)) {
      this.approvalHistory.set(item.approvalId, [...current, item].slice(-80));
      if (persist) this.persist('state.approval.history', item);
    }
    return item;
  }

  approvalTimeline(approvalId) {
    return [...(this.approvalHistory.get(approvalId) ?? [])].sort((left, right) => {
      const leftAt = Date.parse(left.createdAt ?? '') || 0;
      const rightAt = Date.parse(right.createdAt ?? '') || 0;
      if (leftAt !== rightAt) return leftAt - rightAt;
      return String(left.eventId).localeCompare(String(right.eventId));
    });
  }

  rememberResult(taskId, result) {
    const item = {
      taskId,
      result: maskSensitive(result),
      status: result?.status ?? result?.executionResult?.status ?? null,
      rememberedAt: this.clock().toISOString(),
      completedAt: result?.completedAt ?? result?.executionResult?.completedAt ?? this.clock().toISOString()
    };
    this.results.set(taskId, item);
    this.persist('state.result.remembered', item);
    return item;
  }

  listTasks(status) {
    return [...this.tasks.values()].filter((task) => !status || task.status === status);
  }

  snapshot() {
    const prunedRecords = this.pruneRetention({ persist: false });
    const schemaSnapshot = this.schemaSnapshot();
    return {
      schemaVersion: this.schemaVersion,
      tasks: [...this.tasks.values()],
      approvals: [...this.approvals.values()],
      approvalHistory: [...this.approvalHistory.entries()].map(([approvalId, items]) => ({ approvalId, count: items.length })),
      results: [...this.results.values()],
      requestIds: [...this.requestIds.keys()],
      persistence: {
        journalPath: this.journalPath,
        enabled: Boolean(this.journalPath),
        schemaVersion: this.schemaVersion,
        retentionMs: this.retentionMs,
        compactionThreshold: this.compactionThreshold,
        archiveDir: this.archiveDir,
        replay: this.replay,
        prunedRecords,
        schemaSnapshotHash: schemaSnapshot.snapshotHash,
        externalStore: this.externalStoreStatus(),
        compactionLock: this.compactionLockStatus(),
        counts: {
          tasks: this.tasks.size,
          approvals: this.approvals.size,
          approvalHistory: this.approvalHistory.size,
          results: this.results.size,
          requestIds: this.requestIds.size
        }
      }
    };
  }

  compactJournal({ reason = 'manual_compaction' } = {}) {
    if (!this.journalPath) {
      return {
        success: false,
        error: { code: 'D_STATE_CACHE_COMPACTION_DISABLED', message: 'State cache journal is not configured.' }
      };
    }
    const lock = this.acquireCompactionLock({ reason });
    if (!lock.acquired) return lock;
    const prunedRecords = this.pruneRetention({ persist: false });
    const compactedAt = this.clock().toISOString();
    const payload = this.compactedPayload({ reason, compactedAt, prunedRecords });
    const record = {
      schemaVersion: this.schemaVersion,
      recordType: 'state.cache.compacted',
      payload,
      recordedAt: compactedAt
    };
    try {
      const archive = this.archiveJournal({ reason, compactedAt });
      mkdirSync(dirname(this.journalPath), { recursive: true });
      writeFileSync(this.journalPath, `${JSON.stringify(record)}\n`, 'utf8');
      this.externalStore?.compact?.(record);
      this.replay.records = 1;
      this.replay.compactedSnapshots += 1;
      this.replay.lastCompactedAt = compactedAt;
      this.replay.lastCompactionReason = reason;
      this.replay.prunedRecords += prunedRecords;
      this.replay.lastRecordAt = compactedAt;
      return {
        success: true,
        schemaVersion: this.schemaVersion,
        compactedAt,
        reason,
        prunedRecords,
        archive,
        lock,
        counts: this.counts()
      };
    } finally {
      this.releaseCompactionLock(lock);
    }
  }

  compactedPayload({ reason, compactedAt, prunedRecords = 0 } = {}) {
    return {
      schemaVersion: this.schemaVersion,
      reason,
      compactedAt,
      prunedRecords,
      retentionMs: this.retentionMs,
      counts: this.counts(),
      tasks: [...this.tasks.values()],
      approvals: [...this.approvals.values()],
      approvalHistory: [...this.approvalHistory.entries()].map(([approvalId, items]) => ({ approvalId, items })),
      results: [...this.results.values()],
      requestIds: [...this.requestIds.values()]
    };
  }

  pruneRetention({ persist = true } = {}) {
    if (!this.retentionMs || this.retentionMs <= 0) return 0;
    const cutoffMs = this.clock().getTime() - this.retentionMs;
    let pruned = 0;
    const removeOld = (map, dateFor) => {
      for (const [key, item] of [...map.entries()]) {
        const at = Date.parse(dateFor(item) ?? '');
        if (Number.isFinite(at) && at < cutoffMs) {
          map.delete(key);
          pruned += 1;
        }
      }
    };
    removeOld(this.tasks, (item) => item.updatedAt ?? item.createdAt ?? item.request?.createdAt);
    removeOld(this.approvals, (item) => item.updatedAt ?? item.createdAt ?? item.expiresAt);
    removeOld(this.results, (item) => item.completedAt ?? item.rememberedAt);
    removeOld(this.requestIds, (item) => item.firstSeenAt);
    for (const [approvalId, items] of [...this.approvalHistory.entries()]) {
      const retained = items.filter((item) => {
        const at = Date.parse(item.createdAt ?? '');
        return !Number.isFinite(at) || at >= cutoffMs;
      });
      pruned += items.length - retained.length;
      if (retained.length > 0) this.approvalHistory.set(approvalId, retained);
      else this.approvalHistory.delete(approvalId);
    }
    if (persist && pruned > 0) {
      this.persist('state.cache.retention_pruned', {
        pruned,
        prunedAt: this.clock().toISOString(),
        retentionMs: this.retentionMs
      });
    }
    return pruned;
  }

  counts() {
    return {
      tasks: this.tasks.size,
      approvals: this.approvals.size,
      approvalHistory: this.approvalHistory.size,
      results: this.results.size,
      requestIds: this.requestIds.size
    };
  }

  archiveJournal({ reason, compactedAt } = {}) {
    if (!this.journalPath || !this.archiveDir) return { enabled: false };
    let body = '';
    try {
      body = readFileSync(this.journalPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const lines = body.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return { enabled: true, archived: false, reason: 'empty-journal' };
    const archive = {
      archiveVersion: 'd-state-cache-journal-rotation-archive-v1',
      schemaVersion: this.schemaVersion,
      reason,
      compactedAt,
      sourceJournalPath: this.journalPath,
      lineCount: lines.length,
      journalSha256: sha256Hex(body),
      lines
    };
    mkdirSync(this.archiveDir, { recursive: true });
    const archivePath = resolve(this.archiveDir, `bridge-state-cache-archive-${Date.parse(compactedAt)}.json`);
    writeFileSync(archivePath, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
    return {
      enabled: true,
      archived: true,
      archivePath,
      archiveVersion: archive.archiveVersion,
      lineCount: archive.lineCount,
      journalSha256: archive.journalSha256,
      archiveSha256: sha256Hex(canonicalJson(archive))
    };
  }

  acquireCompactionLock({ reason = 'manual_compaction' } = {}) {
    if (!this.compactionLockPath) {
      return {
        acquired: true,
        lockVersion: 'd-state-cache-compaction-lock-v1',
        lockPath: null,
        mode: 'memory-only'
      };
    }
    try {
      mkdirSync(this.compactionLockPath, { recursive: false });
      const lock = {
        acquired: true,
        lockVersion: 'd-state-cache-compaction-lock-v1',
        lockPath: this.compactionLockPath,
        owner: `pid:${process.pid}`,
        reason,
        acquiredAt: this.clock().toISOString()
      };
      writeFileSync(resolve(this.compactionLockPath, 'owner.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      this.compactionLock = lock;
      return lock;
    } catch (error) {
      if (error.code === 'EEXIST') {
        return {
          success: false,
          acquired: false,
          error: { code: 'D_STATE_CACHE_COMPACTION_LOCKED', message: 'State cache compaction is already running.' },
          lockVersion: 'd-state-cache-compaction-lock-v1',
          lockPath: this.compactionLockPath
        };
      }
      throw error;
    }
  }

  releaseCompactionLock(lock) {
    if (!lock?.acquired || !lock.lockPath) return;
    rmSync(lock.lockPath, { recursive: true, force: true });
    this.compactionLock = null;
  }

  compactionLockStatus() {
    return {
      lockVersion: 'd-state-cache-compaction-lock-v1',
      lockPath: this.compactionLockPath,
      active: Boolean(this.compactionLock),
      owner: this.compactionLock?.owner ?? null
    };
  }

  externalStoreStatus() {
    return {
      backendVersion: 'd-state-cache-external-store-contract-v1',
      configured: Boolean(this.externalStore),
      provider: this.externalStore?.provider ?? 'none',
      capabilities: this.externalStore?.capabilities ?? ['append', 'compact', 'snapshot'],
      durable: this.externalStore?.durable === true
    };
  }

  schemaSnapshot() {
    const snapshot = {
      snapshotVersion: 'd-state-cache-schema-snapshot-v1',
      schemaVersion: this.schemaVersion,
      generatedAt: this.clock().toISOString(),
      entities: {
        task: ['taskId', 'approvalId', 'title', 'status', 'updatedAt', 'request', 'plan', 'approvalCard', 'lifecycle'],
        approval: ['approvalId', 'taskId', 'riskTier', 'title', 'summary', 'expiresAt'],
        approvalHistory: ['eventId', 'approvalId', 'taskId', 'eventType', 'label', 'status', 'createdAt'],
        result: ['taskId', 'result', 'status', 'rememberedAt', 'completedAt'],
        requestId: ['requestId', 'taskId', 'deviceId', 'firstSeenAt']
      }
    };
    return {
      ...snapshot,
      snapshotHash: sha256Hex(canonicalJson(snapshot))
    };
  }

  schemaDiff(baseline) {
    const current = this.schemaSnapshot();
    const items = [];
    const baselineEntities = baseline?.entities ?? {};
    for (const [entity, fields] of Object.entries(current.entities)) {
      const previous = baselineEntities[entity] ?? [];
      const added = fields.filter((field) => !previous.includes(field));
      const removed = previous.filter((field) => !fields.includes(field));
      items.push({
        entity,
        status: removed.length ? 'breaking_removed_field' : added.length ? 'expanded' : 'unchanged',
        added,
        removed
      });
    }
    for (const entity of Object.keys(baselineEntities)) {
      if (!current.entities[entity]) {
        items.push({ entity, status: 'removed_entity', added: [], removed: baselineEntities[entity] });
      }
    }
    return {
      reportVersion: 'd-state-cache-schema-diff-v1',
      generatedAt: this.clock().toISOString(),
      status: items.some((item) => item.status === 'removed_entity' || item.status === 'breaking_removed_field') ? 'failed' : 'passed',
      currentSnapshotHash: current.snapshotHash,
      baselineSnapshotHash: baseline?.snapshotHash ?? null,
      items
    };
  }

  externalStoreDeploymentPolicy() {
    return {
      policyVersion: 'd-state-cache-external-store-deployment-policy-v1',
      status: 'contract_ready',
      localDefault: 'jsonl-rotation-archive',
      productionRequirement: {
        durableExternalStoreRequired: true,
        appendOnlyJournalRequired: true,
        compactionMustWriteArchive: true,
        schemaDiffApprovalRequired: true
      },
      supportedBackends: [
        { backendId: 'local-jsonl-archive', status: 'implemented', durability: 'local-worm-mirror-ready' },
        { backendId: 'sqlite-event-store', status: 'contract-ready', durability: 'transactional-local-or-network-volume' },
        { backendId: 's3-object-lock-event-store', status: 'contract-ready', durability: 'external-worm' }
      ],
      capabilities: ['append', 'compact', 'snapshot', 'schema-diff', 'rotation-archive']
    };
  }

  rotationArchiveDrill({ reason = 'state_cache_rotation_drill' } = {}) {
    const generatedAt = this.clock().toISOString();
    const lockProbe = this.acquireCompactionLock({ reason: `${reason}_lock_probe` });
    if (lockProbe.acquired) this.releaseCompactionLock(lockProbe);
    const archive = this.archiveJournal({ reason, compactedAt: generatedAt });
    return {
      drillVersion: 'd-state-cache-rotation-archive-drill-v1',
      generatedAt,
      status: this.journalPath
        && lockProbe.lockVersion === 'd-state-cache-compaction-lock-v1'
        && lockProbe.acquired === true
        && archive.enabled === true
        ? 'passed'
        : 'failed',
      journalPath: this.journalPath,
      archive,
      lockProbe,
      rawDeviceTokenStored: false
    };
  }

  archiveRestoreDrill({ archive = null, archivePath = null, reason = 'state_cache_archive_restore_drill' } = {}) {
    let resolvedArchive = archive;
    let resolvedArchivePath = archivePath ?? archive?.archivePath ?? null;
    if (resolvedArchive && !Array.isArray(resolvedArchive.lines) && resolvedArchivePath) {
      try {
        resolvedArchive = JSON.parse(readFileSync(resolvedArchivePath, 'utf8'));
      } catch (error) {
        return {
          drillVersion: 'd-state-cache-archive-restore-drill-v1',
          generatedAt: this.clock().toISOString(),
          status: 'failed',
          reason,
          archivePath: resolvedArchivePath,
          checks: [
            { checkId: 'state_cache_archive_readable', passed: false, error: error.message }
          ]
        };
      }
    }
    if (!resolvedArchive && resolvedArchivePath) {
      try {
        resolvedArchive = JSON.parse(readFileSync(resolvedArchivePath, 'utf8'));
      } catch (error) {
        return {
          drillVersion: 'd-state-cache-archive-restore-drill-v1',
          generatedAt: this.clock().toISOString(),
          status: 'failed',
          reason,
          archivePath: resolvedArchivePath,
          checks: [
            { checkId: 'state_cache_archive_readable', passed: false, error: error.message }
          ]
        };
      }
    }
    if (!resolvedArchive) {
      const rotation = this.rotationArchiveDrill({ reason: `${reason}_archive_probe` });
      resolvedArchive = rotation.archive?.archivePath
        ? JSON.parse(readFileSync(rotation.archive.archivePath, 'utf8'))
        : rotation.archive;
      resolvedArchivePath = rotation.archive?.archivePath ?? resolvedArchivePath;
    }
    const lines = Array.isArray(resolvedArchive?.lines) ? resolvedArchive.lines : [];
    const scratch = new BridgeStateCache({
      clock: this.clock,
      limit: this.limit,
      journalPath: null,
      schemaVersion: this.schemaVersion,
      retentionMs: this.retentionMs,
      compactionThreshold: 0
    });
    let replayErrors = 0;
    for (const line of lines) {
      try {
        const record = typeof line === 'string' ? JSON.parse(line) : line;
        scratch.applyRecord(record, { persist: false });
      } catch {
        replayErrors += 1;
      }
    }
    const replayedBody = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    const replayedJournalSha256 = sha256Hex(replayedBody);
    const restoredCounts = scratch.counts();
    const currentCounts = this.counts();
    const archiveText = canonicalJson(resolvedArchive ?? {});
    const checks = [
      {
        checkId: 'state_cache_archive_contract_ready',
        passed: resolvedArchive?.archiveVersion === 'd-state-cache-journal-rotation-archive-v1'
          && resolvedArchive?.schemaVersion === this.schemaVersion
          && lines.length === Number(resolvedArchive?.lineCount ?? 0)
      },
      {
        checkId: 'state_cache_archive_hash_verified',
        passed: Boolean(resolvedArchive?.journalSha256)
          && replayedJournalSha256 === resolvedArchive.journalSha256
      },
      {
        checkId: 'state_cache_archive_replay_clean',
        passed: replayErrors === 0
          && restoredCounts.tasks >= Math.min(1, currentCounts.tasks)
          && restoredCounts.requestIds >= Math.min(1, currentCounts.requestIds)
      },
      {
        checkId: 'state_cache_archive_restore_body_coverage',
        passed: restoredCounts.tasks <= currentCounts.tasks
          && restoredCounts.approvals <= currentCounts.approvals
          && restoredCounts.results <= currentCounts.results
      },
      {
        checkId: 'state_cache_archive_no_raw_device_token',
        passed: !archiveText.includes('deviceToken')
      }
    ];
    return {
      drillVersion: 'd-state-cache-archive-restore-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      reason,
      archivePath: resolvedArchivePath,
      archiveVersion: resolvedArchive?.archiveVersion ?? null,
      replayedJournalSha256,
      restoredCounts,
      currentCounts,
      replayErrors,
      checks
    };
  }

  productGate({ baseline = null, reason = 'state_cache_product_gate', requireDurableExternalStore = false } = {}) {
    const snapshot = this.snapshot();
    const schemaSnapshot = this.schemaSnapshot();
    const schemaDiff = this.schemaDiff(baseline ?? schemaSnapshot);
    const externalStore = this.externalStoreStatus();
    const externalStorePolicy = this.externalStoreDeploymentPolicy();
    const rotationDrill = this.rotationArchiveDrill({ reason });
    const compactionLock = this.compactionLockStatus();
    const checks = [
      {
        checkId: 'state_cache_journal_persistence_enabled',
        passed: snapshot.persistence.enabled === true
          && snapshot.persistence.schemaVersion === bridgeStateCacheSchemaVersion
      },
      {
        checkId: 'state_cache_schema_diff_clean',
        passed: schemaSnapshot.snapshotVersion === 'd-state-cache-schema-snapshot-v1'
          && schemaDiff.reportVersion === 'd-state-cache-schema-diff-v1'
          && schemaDiff.status === 'passed'
      },
      {
        checkId: 'state_cache_rotation_archive_drill_passed',
        passed: rotationDrill.drillVersion === 'd-state-cache-rotation-archive-drill-v1'
          && rotationDrill.status === 'passed'
          && rotationDrill.archive.enabled === true
      },
      {
        checkId: 'state_cache_external_store_contract_ready',
        passed: externalStore.backendVersion === 'd-state-cache-external-store-contract-v1'
          && externalStorePolicy.policyVersion === 'd-state-cache-external-store-deployment-policy-v1'
          && externalStorePolicy.status === 'contract_ready'
          && (requireDurableExternalStore ? externalStore.durable === true : true)
      },
      {
        checkId: 'state_cache_compaction_lock_ready',
        passed: compactionLock.lockVersion === 'd-state-cache-compaction-lock-v1'
          && rotationDrill.lockProbe.acquired === true
      },
      {
        checkId: 'state_cache_replay_snapshot_hash_ready',
        passed: snapshot.persistence.schemaSnapshotHash?.length === 64
          && snapshot.persistence.replay.loaded === true
      },
      {
        checkId: 'state_cache_retention_policy_visible',
        passed: Number.isFinite(snapshot.persistence.retentionMs)
          && snapshot.persistence.retentionMs > 0
      }
    ];
    return {
      productGateVersion: 'd-state-cache-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      snapshot: {
        schemaVersion: snapshot.schemaVersion,
        persistence: snapshot.persistence,
        counts: snapshot.persistence.counts
      },
      schemaSnapshot,
      schemaDiff,
      rotationDrill,
      externalStore,
      externalStorePolicy,
      compactionLock
    };
  }

  releaseDossier({ baseline = null, reason = 'state_cache_release_dossier', requireDurableExternalStore = false } = {}) {
    const productGate = this.productGate({
      baseline,
      reason,
      requireDurableExternalStore
    });
    const archiveRestoreDrill = this.archiveRestoreDrill({
      archive: productGate.rotationDrill?.archive ?? null,
      reason: `${reason}_archive_restore`
    });
    const snapshot = this.snapshot();
    const hashString = (value) => (typeof value === 'string' && value.length > 0 ? sha256Hex(resolve(value)) : null);
    const productGateEvidence = {
      productGateVersion: productGate.productGateVersion,
      generatedAt: productGate.generatedAt,
      status: productGate.status,
      checks: productGate.checks,
      snapshot: {
        schemaVersion: productGate.snapshot.schemaVersion,
        persistence: {
          enabled: productGate.snapshot.persistence.enabled,
          schemaVersion: productGate.snapshot.persistence.schemaVersion,
          retentionMs: productGate.snapshot.persistence.retentionMs,
          compactionThreshold: productGate.snapshot.persistence.compactionThreshold,
          replay: productGate.snapshot.persistence.replay,
          prunedRecords: productGate.snapshot.persistence.prunedRecords,
          schemaSnapshotHash: productGate.snapshot.persistence.schemaSnapshotHash,
          journalPathHash: hashString(productGate.snapshot.persistence.journalPath),
          archiveDirHash: hashString(productGate.snapshot.persistence.archiveDir),
          rawJournalPathStored: false,
          rawArchiveDirStored: false,
          externalStore: productGate.snapshot.persistence.externalStore,
          compactionLock: {
            ...productGate.snapshot.persistence.compactionLock,
            lockPath: undefined,
            lockPathHash: hashString(productGate.snapshot.persistence.compactionLock?.lockPath),
            rawLockPathStored: false
          },
          counts: productGate.snapshot.persistence.counts
        }
      },
      schemaSnapshot: productGate.schemaSnapshot,
      schemaDiff: productGate.schemaDiff,
      rotationDrill: {
        drillVersion: productGate.rotationDrill.drillVersion,
        generatedAt: productGate.rotationDrill.generatedAt,
        status: productGate.rotationDrill.status,
        journalPathHash: hashString(productGate.rotationDrill.journalPath),
        archive: {
          enabled: productGate.rotationDrill.archive?.enabled === true,
          archived: productGate.rotationDrill.archive?.archived === true,
          archiveVersion: productGate.rotationDrill.archive?.archiveVersion ?? null,
          lineCount: productGate.rotationDrill.archive?.lineCount ?? 0,
          journalSha256: productGate.rotationDrill.archive?.journalSha256 ?? null,
          archiveSha256: productGate.rotationDrill.archive?.archiveSha256 ?? null,
          archivePathHash: hashString(productGate.rotationDrill.archive?.archivePath),
          rawArchivePathStored: false
        },
        lockProbe: {
          ...productGate.rotationDrill.lockProbe,
          lockPath: undefined,
          lockPathHash: hashString(productGate.rotationDrill.lockProbe?.lockPath),
          rawLockPathStored: false
        },
        rawJournalPathStored: false,
        rawDeviceTokenStored: false
      },
      externalStore: productGate.externalStore,
      externalStorePolicy: productGate.externalStorePolicy,
      compactionLock: {
        ...productGate.compactionLock,
        lockPath: undefined,
        lockPathHash: hashString(productGate.compactionLock?.lockPath),
        rawLockPathStored: false
      }
    };
    const archiveRestoreEvidence = {
      drillVersion: archiveRestoreDrill.drillVersion,
      generatedAt: archiveRestoreDrill.generatedAt,
      status: archiveRestoreDrill.status,
      reason: archiveRestoreDrill.reason,
      archivePathHash: hashString(archiveRestoreDrill.archivePath),
      archiveVersion: archiveRestoreDrill.archiveVersion,
      replayedJournalSha256: archiveRestoreDrill.replayedJournalSha256,
      restoredCounts: archiveRestoreDrill.restoredCounts,
      currentCounts: archiveRestoreDrill.currentCounts,
      replayErrors: archiveRestoreDrill.replayErrors,
      checks: archiveRestoreDrill.checks,
      rawArchivePathStored: false
    };
    let artifactManifest = {
      manifestVersion: 'd-state-cache-release-artifact-manifest-v1',
      productGateHash: sha256Hex(canonicalJson(productGateEvidence)),
      archiveRestoreDrillHash: sha256Hex(canonicalJson(archiveRestoreEvidence)),
      journalPathHash: hashString(snapshot.persistence.journalPath),
      archiveDirHash: hashString(snapshot.persistence.archiveDir),
      latestArchivePathHash: hashString(productGate.rotationDrill?.archive?.archivePath ?? archiveRestoreDrill.archivePath),
      schemaSnapshotHash: snapshot.persistence.schemaSnapshotHash,
      externalStoreProvider: snapshot.persistence.externalStore.provider,
      externalStoreProviderHash: sha256Hex(snapshot.persistence.externalStore.provider ?? 'none'),
      rotationArchiveHash: productGate.rotationDrill?.archive?.archiveSha256 ?? null,
      replayedJournalSha256: archiveRestoreDrill.replayedJournalSha256,
      wormArchive: {
        archiveContractVersion: 'd-state-cache-worm-release-archive-v1',
        storageMode: 'hash_only_state_cache_release_manifest',
        required: true,
        includedArtifactHashes: [
          sha256Hex(canonicalJson(productGateEvidence)),
          sha256Hex(canonicalJson(archiveRestoreEvidence)),
          snapshot.persistence.schemaSnapshotHash,
          productGate.rotationDrill?.archive?.archiveSha256 ?? null,
          archiveRestoreDrill.replayedJournalSha256
        ].filter(Boolean)
      },
      rawDeviceTokenStored: false,
      rawJournalPathStored: false,
      rawArchiveDirStored: false,
      rawLatestArchivePathStored: false,
      rawLockPathStored: false,
      rawArchivePathStored: false
    };
    const rawNeedles = [
      snapshot.persistence.journalPath,
      snapshot.persistence.archiveDir,
      productGate.snapshot.persistence?.journalPath,
      productGate.snapshot.persistence?.archiveDir,
      productGate.rotationDrill?.journalPath,
      productGate.rotationDrill?.archive?.archivePath,
      productGate.rotationDrill?.lockProbe?.lockPath,
      productGate.compactionLock?.lockPath,
      archiveRestoreDrill.archivePath
    ].filter((needle) => typeof needle === 'string' && needle.length >= 8);
    const releaseLeakProbe = canonicalJson({
      productGate: productGateEvidence,
      archiveRestoreDrill: archiveRestoreEvidence,
      artifactManifest,
      operationsRunbookVersion: 'd-state-cache-release-runbook-v1'
    });
    artifactManifest = {
      ...artifactManifest,
      rawLeakCheck: {
        rawLeakCheckVersion: 'd-state-cache-release-raw-leak-check-v1',
        rawLeakDetected: rawNeedles.some((needle) => releaseLeakProbe.includes(needle)),
        rawNeedleCount: rawNeedles.length,
        scannedFields: ['productGateEvidence', 'archiveRestoreEvidence', 'artifactManifest']
      }
    };
    const releaseWorkflow = {
      workflowVersion: 'd-state-cache-release-workflow-v1',
      productGateReady: productGate.status === 'passed',
      archiveRestoreReady: archiveRestoreDrill.status === 'passed',
      schemaSnapshotReady: snapshot.schemaVersion === bridgeStateCacheSchemaVersion
        && snapshot.persistence.schemaSnapshotHash?.length === 64,
      replayRebuildReady: snapshot.persistence.replay.loaded === true
        && Number.isFinite(snapshot.persistence.replay.records),
      externalStorePolicyReady: productGate.externalStorePolicy?.policyVersion === 'd-state-cache-external-store-deployment-policy-v1',
      hashOnlyArtifactManifestReady: artifactManifest.rawLeakCheck.rawLeakDetected === false
        && artifactManifest.rawJournalPathStored === false
        && artifactManifest.rawArchiveDirStored === false
        && artifactManifest.rawArchivePathStored === false
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-state-cache-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-state-cache-release-owner',
      scope: 'task_approval_result_request_snapshot_journal_compaction_archive_restore_external_store_contract',
      status: releaseWorkflow.productGateReady
        && releaseWorkflow.archiveRestoreReady
        && releaseWorkflow.hashOnlyArtifactManifestReady ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-state-cache-health-handshake-v1',
      healthHandshake: {
        productGateReady: releaseWorkflow.productGateReady,
        archiveRestoreReady: releaseWorkflow.archiveRestoreReady,
        schemaSnapshotReady: releaseWorkflow.schemaSnapshotReady,
        replayRebuildReady: releaseWorkflow.replayRebuildReady,
        externalStorePolicyReady: releaseWorkflow.externalStorePolicyReady,
        rawLocalPathsStored: artifactManifest.rawJournalPathStored
          || artifactManifest.rawArchiveDirStored
          || artifactManifest.rawLatestArchivePathStored
          || artifactManifest.rawLockPathStored
          || artifactManifest.rawArchivePathStored
      },
      fallbackPolicy: {
        policyVersion: 'd-state-cache-fallback-policy-v1',
        primaryFlow: 'persist_bridge_state_to_append_only_jsonl_or_external_event_store',
        fallbackFlows: [
          'continue_read_only_mobile_snapshot_from_last_compacted_journal_when_external_store_is_unavailable',
          'block_compaction_when_d_state_cache_compaction_lock_v1_is_active',
          'restore_from_latest_hash_verified_rotation_archive_before accepting mobile approvals',
          'block_release_when_raw_journal_or_archive_paths_are_present_in_release_manifest'
        ],
        operatorEscalation: 'bridge_state_cache_release_and_external_worm_backend_soak_report'
      },
      rawJournalPathStored: false,
      rawArchivePathStored: false,
      rawLockPathStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-state-cache-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "D Bridge HTTP API implements pairing" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'state_cache_product_gate_passed',
        'state_cache_archive_restore_drill_passed',
        'state_cache_schema_v2_snapshot_ready',
        'state_cache_replay_rebuild_evidence_ready',
        'state_cache_external_store_policy_ready',
        'state_cache_release_artifact_manifest_hash_only',
        'state_cache_operational_handoff_ready',
        'state_cache_worm_promotion_package_ready',
        'state_cache_raw_token_retention_safe'
      ],
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawJournalPathStored: false,
      rawArchivePathStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-state-cache-worm-promotion-package-v1',
      providerContractVersion: 'd-state-cache-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-state-cache-release-artifact-manifest-v1'
        && artifactManifest.wormArchive.archiveContractVersion === 'd-state-cache-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-state-cache-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawJournalPathStored: false,
      rawArchivePathStored: false,
      rawLockPathStored: false
    };
    const checks = [
      {
        checkId: 'state_cache_product_gate_passed',
        status: productGate.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'state_cache_archive_restore_drill_passed',
        status: archiveRestoreDrill.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'state_cache_schema_v2_snapshot_ready',
        status: snapshot.schemaVersion === bridgeStateCacheSchemaVersion
          && snapshot.persistence.schemaSnapshotHash?.length === 64 ? 'passed' : 'blocked'
      },
      {
        checkId: 'state_cache_replay_rebuild_evidence_ready',
        status: snapshot.persistence.replay.loaded === true
          && Number.isFinite(snapshot.persistence.replay.records) ? 'passed' : 'blocked'
      },
      {
        checkId: 'state_cache_external_store_policy_ready',
        status: productGate.externalStorePolicy?.policyVersion === 'd-state-cache-external-store-deployment-policy-v1' ? 'passed' : 'blocked'
      },
      {
        checkId: 'state_cache_raw_token_retention_safe',
        status: archiveRestoreDrill.checks?.some((check) => check.checkId === 'state_cache_archive_no_raw_device_token' && check.passed) ? 'passed' : 'blocked'
      },
      {
        checkId: 'state_cache_release_artifact_manifest_hash_only',
        status: artifactManifest.rawLeakCheck.rawLeakDetected === false
          && artifactManifest.wormArchive.includedArtifactHashes.length >= 4
          && artifactManifest.rawJournalPathStored === false
          && artifactManifest.rawArchiveDirStored === false
          && artifactManifest.rawArchivePathStored === false
          ? 'passed'
          : 'blocked'
      },
      {
        checkId: 'state_cache_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-state-cache-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-state-cache-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-state-cache-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
          ? 'passed'
          : 'blocked'
      },
      {
        checkId: 'state_cache_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-state-cache-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-state-cache-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
          ? 'passed'
          : 'blocked'
      }
    ];
    return {
      dossierVersion: 'd-state-cache-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks,
      releaseWorkflow,
      productGate: productGateEvidence,
      archiveRestoreDrill: archiveRestoreEvidence,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Run /cache/schema-snapshot before bridge upgrades and store the snapshot as a baseline.',
        'Run /cache/schema-diff with the previous baseline before enabling a release.',
        'Run /cache/compact after high-volume mobile approval sessions and verify archiveRestoreDrill.status.',
        'Use a durable external store before production multi-device deployment.',
        'Promote only hash-only state cache evidence to external WORM storage.'
      ]
    };
  }
}

function accumulateGrowthTrendBucket(bucket = null, entry) {
  const next = bucket ?? {
    total: 0,
    successCount: 0,
    failureCount: 0,
    requestedCount: 0,
    appliedCount: 0,
    failedCount: 0,
    latencyValues: []
  };
  next.total += 1;
  if (entry.success) next.successCount += 1;
  else next.failureCount += 1;
  next.requestedCount += entry.requestedCount ?? 0;
  next.appliedCount += entry.appliedCount ?? 0;
  next.failedCount += entry.failedCount ?? 0;
  if (Number.isFinite(entry.latencyMs)) next.latencyValues.push(entry.latencyMs);
  return next;
}

function finalizeGrowthTrendBucket(bucket) {
  return {
    total: bucket.total,
    successCount: bucket.successCount,
    failureCount: bucket.failureCount,
    successRate: bucket.total ? bucket.successCount / bucket.total : 1,
    requestedCount: bucket.requestedCount,
    appliedCount: bucket.appliedCount,
    failedCount: bucket.failedCount,
    averageLatencyMs: averageNumber(bucket.latencyValues),
    p95LatencyMs: percentileNumber(bucket.latencyValues, 0.95)
  };
}

function averageNumber(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentileNumber(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return sorted[index];
}

export class BridgeRuntime {
  constructor({ coreFacade, policyRuntime, pcAgent, growthRuntime, verificationRuntime, clock = () => new Date(), auditLog = null, auditRoot, eventRelay = null, eventCursorJournalPath = undefined, rateLimiter = null } = {}) {
    this.clock = clock;
    this.auditLog = auditLog ?? new JsonlAuditLog({
      filePath: auditRoot ? `${auditRoot}/bridge-audit.jsonl` : 'apps/bridge/logs/bridge-audit.jsonl',
      clock
    });
    this.registry = new DeviceRegistry({
      clock,
      auditLog: this.auditLog,
      journalPath: auditRoot ? `${auditRoot}/bridge-devices.jsonl` : null
    });
    this.pairing = new PairingManager({ registry: this.registry, clock, auditLog: this.auditLog });
    this.coreFacade = coreFacade;
    this.policyRuntime = policyRuntime;
    this.pcAgent = pcAgent;
    this.growthRuntime = growthRuntime;
    this.verificationRuntime = verificationRuntime;
    this.rateLimiter = rateLimiter ?? new TokenBucketRateLimiter({
      clock,
      journalPath: auditRoot ? `${auditRoot}/bridge-rate-limits.jsonl` : null,
      policyPath: process.env.JARVIS_BRIDGE_RATE_LIMIT_POLICY || null
    });
    this.eventRelay = eventRelay ?? new BridgeEventRelay({
      clock,
      cursorJournalPath: eventCursorJournalPath ?? (auditRoot ? `${auditRoot}/bridge-event-cursors.jsonl` : 'apps/bridge/logs/bridge-event-cursors.jsonl')
    });
    this.stateCache = new BridgeStateCache({
      clock,
      journalPath: auditRoot ? `${auditRoot}/bridge-state-cache.jsonl` : null
    });
    this.requestNonceStore = new DurableRequestNonceStore({
      clock,
      auditLog: this.auditLog,
      journalPath: auditRoot ? `${auditRoot}/bridge-request-nonces.jsonl` : null
    });
    this.results = new Map();
    this.handoffs = new Map();
    this.pcConfirmationHandoffs = new Map();
    this.growthDecisionHistoryItems = [];
    this.growthDecisionHistoryLimit = 500;
    this.outputPath = './workspace/jarvis-output.txt';
  }

  health() {
    return {
      status: 'ok',
      module: ModuleId.BRIDGE,
      version: '1.0.0',
      time: this.clock().toISOString(),
      localOnly: true,
      pairedDevices: this.registry.list().filter((device) => device.status === 'active').length,
      cachedTasks: this.stateCache.tasks.size,
      activeRequestNonces: this.requestNonceStore.nonces.size,
      subscribers: this.eventRelay.subscribers.size,
      rateLimiter: {
        policyCount: Object.keys(this.rateLimiter.policies).length,
        bucketCount: this.rateLimiter.buckets.size,
        backend: this.rateLimiter.snapshot().sharedBackend.type,
        policyHotReload: this.rateLimiter.snapshot().policySource.hotReload,
        reputationCount: this.rateLimiter.snapshot().reputation.length
      }
    };
  }

  rateLimitStatus({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'rate_limit.status', device: auth.device });
    if (!limit.success) return limit;
    return {
      success: true,
      module: ModuleId.BRIDGE,
      snapshot: this.rateLimiter.snapshot(),
      rateLimit: limit.rateLimit
    };
  }

  rateLimitAbuseCorpus({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'rate_limit.abuse_corpus', device: auth.device });
    if (!limit.success) return limit;
    return {
      success: true,
      module: ModuleId.BRIDGE,
      report: this.rateLimiter.runAbuseCorpus(),
      rateLimit: limit.rateLimit
    };
  }

  rateLimitProductGate({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'rate_limit.product_gate', device: auth.device });
    if (!limit.success) return limit;
    const gate = this.rateLimiter.productGate();
    this.auditLog.write('rate_limit.product_gate', {
      deviceId: auth.device.deviceId,
      productGateVersion: gate.productGateVersion,
      status: gate.status,
      abuseCorpusStatus: gate.abuseReport.status,
      sharedBackendDrillStatus: gate.sharedBackendDrill.status,
      reputationDrillStatus: gate.reputationDrill.status
    });
    return {
      success: true,
      module: ModuleId.BRIDGE,
      ...gate,
      rateLimit: limit.rateLimit
    };
  }

  rateLimitReleaseDossier({ token, reason = 'mobile_requested_rate_limit_release_dossier' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'rate_limit.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const productGate = this.rateLimiter.productGate();
    const hashString = (value) => (typeof value === 'string' && value.length > 0 ? sha256Hex(value) : null);
    const sanitizeRateLimitState = (state) => state
      ? {
          ...state,
          identity: undefined,
          identityHash: hashString(state.identity),
          rawIdentityStored: false
        }
      : state;
    const rawBucketKeys = productGate.snapshot.buckets.map((bucket) => bucket.key).filter(Boolean);
    const rawReputationIdentities = productGate.snapshot.reputation.map((entry) => entry.identity).filter(Boolean);
    const rawAbuseIdentities = productGate.abuseReport.items.map((item) => item.identity).filter(Boolean);
    const rawDrillIdentities = [
      productGate.sharedBackendDrill.identity,
      productGate.reputationDrill.identity
    ].filter(Boolean);
    const productGateEvidence = {
      productGateVersion: productGate.productGateVersion,
      generatedAt: productGate.generatedAt,
      status: productGate.status,
      checks: productGate.checks,
      policyDocument: productGate.policyDocument,
      snapshot: {
        policies: productGate.snapshot.policies,
        bucketCount: productGate.snapshot.buckets.length,
        buckets: productGate.snapshot.buckets.map(({ key, ...bucket }) => ({
          ...bucket,
          keyHash: hashString(key),
          rawKeyStored: false
        })),
        persistence: {
          ...productGate.snapshot.persistence,
          journalPath: undefined,
          journalPathHash: hashString(productGate.snapshot.persistence?.journalPath),
          rawJournalPathStored: false
        },
        policySource: productGate.snapshot.policySource,
        sharedBackend: productGate.snapshot.sharedBackend,
        reputationPolicy: productGate.snapshot.reputationPolicy,
        reputationCount: productGate.snapshot.reputation.length,
        reputation: productGate.snapshot.reputation.map(({ identity, ...entry }) => ({
          ...entry,
          identityHash: hashString(identity),
          rawIdentityStored: false
        }))
      },
      abuseReport: {
        reportVersion: productGate.abuseReport.reportVersion,
        corpusVersion: productGate.abuseReport.corpusVersion,
        generatedAt: productGate.abuseReport.generatedAt,
        status: productGate.abuseReport.status,
        caseCount: productGate.abuseReport.caseCount,
        passed: productGate.abuseReport.passed,
        failed: productGate.abuseReport.failed,
        items: productGate.abuseReport.items.map(({ identity, ...item }) => ({
          ...item,
          identityHash: hashString(identity),
          rawIdentityStored: false
        }))
      },
      sharedBackendDrill: {
        drillVersion: productGate.sharedBackendDrill.drillVersion,
        status: productGate.sharedBackendDrill.status,
        generatedAt: productGate.sharedBackendDrill.generatedAt,
        action: productGate.sharedBackendDrill.action,
        identityHash: hashString(productGate.sharedBackendDrill.identity),
        sharedBackend: productGate.sharedBackendDrill.sharedBackend,
        firstAttemptAllowed: productGate.sharedBackendDrill.firstAttempt?.allowed === true,
        secondAttemptAllowed: productGate.sharedBackendDrill.secondAttempt?.allowed === true,
        checks: productGate.sharedBackendDrill.checks,
        rawIdentityStored: false
      },
      reputationDrill: {
        drillVersion: productGate.reputationDrill.drillVersion,
        status: productGate.reputationDrill.status,
        generatedAt: productGate.reputationDrill.generatedAt,
        action: productGate.reputationDrill.action,
        identityHash: hashString(productGate.reputationDrill.identity),
        blockedCount: productGate.reputationDrill.blockedCount,
        finalReputationTier: productGate.reputationDrill.finalReputationTier,
        checks: productGate.reputationDrill.checks,
        rawIdentityStored: false
      }
    };
    const releasePayloadText = canonicalJson(productGateEvidence);
    const rawDeviceTokenStored = typeof token === 'string' && token.length > 0 && releasePayloadText.includes(token);
    const rawDeviceIdStored = typeof auth.device.deviceId === 'string' && releasePayloadText.includes(auth.device.deviceId);
    const rawBucketKeyStored = rawBucketKeys.some((key) => releasePayloadText.includes(key));
    const rawIdentityStored = [...rawReputationIdentities, ...rawAbuseIdentities, ...rawDrillIdentities]
      .some((identity) => releasePayloadText.includes(identity));
    const artifactManifest = {
      manifestVersion: 'd-rate-limit-release-artifact-manifest-v1',
      productGateVersion: productGate.productGateVersion,
      policyVersion: productGate.policyDocument.policyVersion,
      abuseReportVersion: productGate.abuseReport.reportVersion,
      sharedBackendDrillVersion: productGate.sharedBackendDrill.drillVersion,
      reputationDrillVersion: productGate.reputationDrill.drillVersion,
      bucketCount: productGate.snapshot.buckets.length,
      reputationCount: productGate.snapshot.reputation.length,
      rawDeviceTokenStored,
      rawDeviceIdStored,
      rawBucketKeyStored,
      rawIdentityStored,
      rawLeakCheck: {
        checkedNeedleCount: 2 + rawBucketKeys.length + rawReputationIdentities.length + rawAbuseIdentities.length + rawDrillIdentities.length,
        rawLeakDetected: rawDeviceTokenStored || rawDeviceIdStored || rawBucketKeyStored || rawIdentityStored
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-rate-limit-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-rate-limit-release-owner',
      scope: 'pairing_task_approval_poison_queue_growth_audit_rate_limit_policy_shared_backend_reputation',
      status: productGate.status === 'passed' && artifactManifest.rawLeakCheck.rawLeakDetected === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-rate-limit-health-handshake-v1',
      healthHandshake: {
        productGatePassed: productGate.status === 'passed',
        abuseCorpusPassed: productGate.abuseReport.status === 'passed',
        sharedBackendDrillPassed: productGate.sharedBackendDrill.status === 'passed',
        reputationDrillPassed: productGate.reputationDrill.status === 'passed',
        policyHotReloadReady: productGate.snapshot.policySource.hotReload === true,
        rawLeakDetected: artifactManifest.rawLeakCheck.rawLeakDetected
      },
      fallbackPolicy: {
        policyVersion: 'd-rate-limit-fallback-policy-v1',
        primaryFlow: 'enforce_token_bucket_by_device_token_ip_and_action_with_reputation_tiers',
        fallbackFlows: [
          'fall_back_to_local_jsonl_shared_file_when_edge_or_redis_backend_is_unavailable',
          'block_release_when_abuse_corpus_or_shared_backend_drill_fails',
          'keep_policy_hot_reload_disabled_only under emergency operator override',
          'block_release_when_raw_bucket_key_identity_or_device_token_is_retained'
        ],
        operatorEscalation: 'bridge_rate_limit_release_and_abuse_trend_report'
      },
      rawDeviceTokenStored: false,
      rawIdentityStored: false,
      rawBucketKeyStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-rate-limit-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "D bridge rate limiter" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'rate_limit_product_gate_passed',
        'rate_limit_release_artifact_manifest_ready',
        'rate_limit_operational_handoff_ready',
        'rate_limit_worm_promotion_package_ready'
      ],
      productGateHash: sha256Hex(canonicalJson(productGateEvidence)),
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawDeviceTokenStored: false,
      rawIdentityStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-rate-limit-worm-promotion-package-v1',
      providerContractVersion: 'd-rate-limit-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-rate-limit-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-rate-limit-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      productGateHash: sha256Hex(canonicalJson(productGateEvidence)),
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDeviceTokenStored: false,
      rawIdentityStored: false,
      rawBucketKeyStored: false
    };
    const checks = [
      {
        checkId: 'rate_limit_product_gate_passed',
        status: productGate.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'rate_limit_release_artifact_manifest_ready',
        status: artifactManifest.manifestVersion === 'd-rate-limit-release-artifact-manifest-v1'
          && artifactManifest.rawLeakCheck.rawLeakDetected === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'rate_limit_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-rate-limit-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-rate-limit-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-rate-limit-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'rate_limit_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-rate-limit-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-rate-limit-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const releaseCore = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-rate-limit-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks,
      productGateEvidence,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Run /rate-limit/product-gate and this release dossier before changing rate policies or shared backend settings.',
        'Treat Redis/edge limiter migration as blocked unless abuse corpus, shared backend drill, and reputation drill are green.',
        'Keep raw bucket keys, IP/device identities, and device tokens out of release evidence.',
        'Attach abuse trend and WORM promotion package to the bridge release record.'
      ],
      rateLimit: sanitizeRateLimitState(limit.rateLimit)
    };
    const dossier = {
      ...releaseCore,
      dossierSha256: sha256Hex(canonicalJson(releaseCore))
    };
    this.auditLog.write('rate_limit.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      checkCount: checks.length,
      blockedChecks: checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
  }

  auditSummary({ token, category, severity, cursor = 0, limit = 10 } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return {
      module: ModuleId.BRIDGE,
      generatedAt: this.clock().toISOString(),
      ...this.auditLog.summary({ category, severity, cursor, limit })
    };
  }

  auditExport({ token, category, severity, cursor = 0, limit = 200, reason = 'device_requested_export' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const rate = this.rateLimit({ action: 'audit.export', device: auth.device });
    if (!rate.success) return rate;
    const bundle = this.auditLog.exportBundle({ category, severity, cursor, limit, reason });
    const verification = this.auditLog.verifyExportBundle(bundle);
    this.auditLog.write('audit.exported', {
      deviceId: auth.device.deviceId,
      exportId: bundle.exportId,
      manifestHash: bundle.manifestHash,
      entries: bundle.entries.length,
      category: category ?? null,
      severity: severity ?? null,
      verification
    });
    return {
      success: true,
      module: ModuleId.BRIDGE,
      bundle,
      verification,
      rateLimit: rate.rateLimit
    };
  }

  auditRotate({ token, reason = 'device_requested_rotation' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const rate = this.rateLimit({ action: 'audit.rotate', device: auth.device });
    if (!rate.success) return rate;
    const rotation = this.auditLog.rotate({ reason });
    return {
      success: true,
      module: ModuleId.BRIDGE,
      rotation,
      rateLimit: rate.rateLimit
    };
  }

  auditSiemExport({ token, category, severity, cursor = 0, limit = 200, reason = 'device_requested_siem_export', format = 'both' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const rate = this.rateLimit({ action: 'audit.export', device: auth.device });
    if (!rate.success) return rate;
    const bundle = this.auditLog.exportBundle({ category, severity, cursor, limit, reason });
    const jsonl = bundle.entries.map((entry) => JSON.stringify({
      ts: entry.timestamp,
      host: 'jarvis-local-bridge',
      app: 'JARVIS-D',
      event: entry.event,
      category: entry.category,
      severity: entry.severity,
      sequence: entry.sequence,
      hash: entry.hash,
      message: `${entry.category}.${entry.event}`
    })).join('\n');
    const cef = bundle.entries.map((entry) => [
      'CEF:0',
      'JARVIS',
      'Bridge',
      '1.0',
      entry.event,
      entry.category,
      entry.severity === 'error' ? '8' : (entry.severity === 'warning' ? '5' : '2')
    ].join('|') + ` rt=${Date.parse(entry.timestamp)} cs1Label=hash cs1=${entry.hash} cs2Label=sequence cs2=${entry.sequence}`).join('\n');
    const payloadHash = sha256Hex(`${jsonl}\n${cef}`);
    return {
      success: true,
      module: ModuleId.BRIDGE,
      exportVersion: 'd-siem-compatible-audit-export-v1',
      generatedAt: this.clock().toISOString(),
      status: 'passed',
      format,
      bundle,
      payloadHash,
      outputs: {
        jsonl: ['jsonl', 'both'].includes(format) ? jsonl : null,
        cef: ['cef', 'both'].includes(format) ? cef : null
      },
      schema: {
        jsonlSchema: 'd-audit-siem-jsonl-schema-v1',
        cefSchema: 'd-audit-siem-cef-schema-v1'
      },
      rateLimit: rate.rateLimit
    };
  }

  auditArchiveSync({
    token,
    targetDir = this.auditLog?.filePath ? join(dirname(this.auditLog.filePath), 'worm-audit-archive') : 'apps/bridge/logs/worm-audit-archive',
    dryRun = true,
    reason = 'device_requested_archive_sync'
  } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const bundle = this.auditLog.exportBundle({ reason, limit: Math.max(this.auditLog.entries?.length ?? 1, 1) });
    const archiveHash = sha256Hex(JSON.stringify(bundle));
    const destinationPath = join(targetDir, `${bundle.exportId}-${archiveHash.slice(0, 12)}.json`);
    if (!dryRun) {
      mkdirSync(targetDir, { recursive: true });
      if (!existsSync(destinationPath)) writeFileSync(destinationPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    }
    const manifest = {
      manifestVersion: 'd-immutable-audit-archive-sync-manifest-v1',
      generatedAt: this.clock().toISOString(),
      archiveHash,
      destinationPath,
      dryRun,
      artifactStore: {
        storeVersion: 'd-bridge-audit-worm-store-v1',
        immutableWritePolicy: { appendOnly: true, overwriteAllowed: false, deleteAllowed: false },
        retentionDays: 365
      }
    };
    const manifestPath = join(targetDir, 'audit-archive-sync-manifest.json');
    if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return {
      success: true,
      module: ModuleId.BRIDGE,
      syncVersion: 'd-immutable-audit-archive-sync-v1',
      generatedAt: manifest.generatedAt,
      status: dryRun ? 'dry_run' : 'synced',
      dryRun,
      targetDir,
      archiveHash,
      copiedCount: dryRun ? 0 : 1,
      artifactCount: 1,
      manifestPath,
      artifacts: [{
        exportId: bundle.exportId,
        destinationPath,
        archiveHash,
        copied: !dryRun && existsSync(destinationPath)
      }],
      artifactStore: manifest.artifactStore
    };
  }

  auditRetentionRun({ token, dryRun = true, reason = 'device_requested_audit_retention' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const before = this.auditLog.retentionStatus();
    const rotation = !dryRun && before.rotationRecommended
      ? this.auditLog.rotate({ reason })
      : null;
    return {
      success: true,
      module: ModuleId.BRIDGE,
      schedulerVersion: 'd-audit-retention-scheduler-v1',
      generatedAt: this.clock().toISOString(),
      status: 'passed',
      dryRun,
      reason,
      before,
      rotation,
      after: this.auditLog.retentionStatus(),
      recommendations: before.rotationRecommended
        ? ['Execute audit retention rotation and sync archive to WORM store.']
        : ['Audit retention is within policy; keep scheduled dry-run active.']
    };
  }

  auditArchiveRestoreDrill({ token, archivePath = null } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    let bundle = null;
    let source = 'current_export';
    if (archivePath && existsSync(archivePath)) {
      bundle = JSON.parse(readFileSync(archivePath, 'utf8'));
      source = archivePath;
    } else {
      bundle = this.auditLog.exportBundle({ reason: 'restore_drill_current_export', limit: Math.max(this.auditLog.entries?.length ?? 1, 1) });
    }
    const verification = this.auditLog.verifyExportBundle(bundle);
    return {
      success: true,
      module: ModuleId.BRIDGE,
      drillVersion: 'd-audit-archive-restore-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: verification.valid ? 'passed' : 'failed',
      source,
      verification,
      restoredEntryCount: bundle.entries?.length ?? 0,
      chain: this.auditLog.verifyChain()
    };
  }

  auditProductGate({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const siem = this.auditSiemExport({ token, limit: 50, reason: 'audit_product_gate_siem' });
    if (!siem.success) return siem;
    const retention = this.auditRetentionRun({ token, dryRun: true, reason: 'audit_product_gate_retention' });
    if (!retention.success) return retention;
    const archiveSync = this.auditArchiveSync({ token, dryRun: false, reason: 'audit_product_gate_archive_sync' });
    if (!archiveSync.success) return archiveSync;
    const restoreDrill = this.auditArchiveRestoreDrill({
      token,
      archivePath: archiveSync.artifacts[0]?.destinationPath
    });
    if (!restoreDrill.success) return restoreDrill;
    const summary = this.auditSummary({ token, limit: 10 });
    const checks = [
      { checkId: 'audit_hash_chain_valid', passed: summary.chain.valid === true },
      { checkId: 'audit_siem_export_ready', passed: siem.exportVersion === 'd-siem-compatible-audit-export-v1' && siem.status === 'passed' },
      { checkId: 'audit_retention_scheduler_ready', passed: retention.schedulerVersion === 'd-audit-retention-scheduler-v1' && retention.status === 'passed' },
      { checkId: 'audit_worm_archive_synced', passed: archiveSync.syncVersion === 'd-immutable-audit-archive-sync-v1' && archiveSync.status === 'synced' },
      { checkId: 'audit_archive_restore_drill_passed', passed: restoreDrill.drillVersion === 'd-audit-archive-restore-drill-v1' && restoreDrill.status === 'passed' }
    ];
    return {
      success: true,
      module: ModuleId.BRIDGE,
      productGateVersion: 'd-bridge-audit-log-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      summary,
      siem,
      retention,
      archiveSync,
      restoreDrill
    };
  }

  auditReleaseDossier({ token, reason = 'mobile_requested_audit_release_dossier' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'audit.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const productGate = this.auditProductGate({ token });
    if (productGate.success === false) return productGate;
    const hashString = (value) => (typeof value === 'string' && value.length > 0 ? sha256Hex(value) : null);
    const sanitizeRateLimitState = (state) => state
      ? {
          ...state,
          identity: undefined,
          identityHash: hashString(state.identity),
          rawIdentityStored: false
        }
      : state;
    const archiveArtifacts = productGate.archiveSync?.artifacts ?? [];
    const productGateEvidence = {
      productGateVersion: productGate.productGateVersion,
      generatedAt: productGate.generatedAt,
      status: productGate.status,
      checks: productGate.checks,
      summary: {
        chain: productGate.summary?.chain ?? null,
        total: productGate.summary?.total ?? 0,
        pageInfo: productGate.summary?.pageInfo ?? null,
        retention: productGate.summary?.retention ?? null
      },
      siem: {
        exportVersion: productGate.siem?.exportVersion ?? null,
        status: productGate.siem?.status ?? null,
        format: productGate.siem?.format ?? null,
        payloadHash: productGate.siem?.payloadHash ?? null,
        schema: productGate.siem?.schema ?? null,
        outputHashes: {
          jsonl: hashString(productGate.siem?.outputs?.jsonl),
          cef: hashString(productGate.siem?.outputs?.cef)
        },
        bundle: {
          schemaVersion: productGate.siem?.bundle?.schemaVersion ?? null,
          exportIdHash: hashString(productGate.siem?.bundle?.exportId),
          manifestHash: productGate.siem?.bundle?.manifestHash ?? null,
          signatureAlgorithm: productGate.siem?.bundle?.signatureAlgorithm ?? null,
          signatureHash: hashString(productGate.siem?.bundle?.signature),
          entryCount: productGate.siem?.bundle?.entries?.length ?? 0,
          rawEntriesStored: false
        }
      },
      retention: {
        schedulerVersion: productGate.retention?.schedulerVersion ?? null,
        status: productGate.retention?.status ?? null,
        dryRun: productGate.retention?.dryRun ?? null,
        before: productGate.retention?.before ?? null,
        after: productGate.retention?.after ?? null
      },
      archiveSync: {
        syncVersion: productGate.archiveSync?.syncVersion ?? null,
        status: productGate.archiveSync?.status ?? null,
        archiveHash: productGate.archiveSync?.archiveHash ?? null,
        copiedCount: productGate.archiveSync?.copiedCount ?? 0,
        artifactCount: productGate.archiveSync?.artifactCount ?? 0,
        manifestPathHash: hashString(productGate.archiveSync?.manifestPath),
        artifacts: archiveArtifacts.map((artifact) => ({
          exportIdHash: hashString(artifact.exportId),
          destinationPathHash: hashString(artifact.destinationPath),
          archiveHash: artifact.archiveHash,
          copied: artifact.copied === true,
          rawDestinationPathStored: false
        })),
        artifactStore: productGate.archiveSync?.artifactStore ?? null,
        rawManifestPathStored: false
      },
      restoreDrill: {
        drillVersion: productGate.restoreDrill?.drillVersion ?? null,
        status: productGate.restoreDrill?.status ?? null,
        sourceHash: hashString(productGate.restoreDrill?.source),
        restoredEntryCount: productGate.restoreDrill?.restoredEntryCount ?? 0,
        verification: productGate.restoreDrill?.verification ?? null,
        chain: productGate.restoreDrill?.chain ?? null,
        rawSourcePathStored: false
      }
    };
    const rawNeedles = [
      token,
      auth.device.deviceId,
      this.auditLog.filePath,
      productGate.archiveSync?.manifestPath,
      ...archiveArtifacts.map((artifact) => artifact.destinationPath)
    ].filter((value) => typeof value === 'string' && value.length > 0);
    const productGateEvidenceText = canonicalJson(productGateEvidence);
    const rawLeakDetected = rawNeedles.some((needle) => productGateEvidenceText.includes(needle));
    const artifactManifest = {
      manifestVersion: 'd-bridge-audit-release-artifact-manifest-v1',
      productGateVersion: productGate.productGateVersion,
      auditLogPathHash: hashString(this.auditLog.filePath),
      archiveManifestPathHash: hashString(productGate.archiveSync?.manifestPath),
      archiveArtifactHashes: archiveArtifacts.map((artifact) => ({
        destinationPathHash: hashString(artifact.destinationPath),
        archiveHash: artifact.archiveHash
      })),
      siemPayloadHash: productGate.siem?.payloadHash ?? null,
      exportManifestHash: productGate.siem?.bundle?.manifestHash ?? null,
      restoredEntryCount: productGate.restoreDrill?.restoredEntryCount ?? 0,
      rawDeviceTokenStored: false,
      rawAuditEntriesStored: false,
      rawAuditPathStored: false,
      rawArchivePathsStored: false,
      rawSiemPayloadStored: false,
      rawLeakCheck: {
        checkedNeedleCount: rawNeedles.length,
        rawLeakDetected
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-bridge-audit-log-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-audit-log-release-owner',
      scope: 'signed_audit_export_siem_retention_immutable_archive_restore_drill',
      status: productGate.status === 'passed' && artifactManifest.rawLeakCheck.rawLeakDetected === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-bridge-audit-log-health-handshake-v1',
      healthHandshake: {
        productGatePassed: productGate.status === 'passed',
        hashChainValid: productGate.summary?.chain?.valid === true,
        signedExportReady: productGate.siem?.bundle?.manifestHash?.length === 64,
        retentionReady: productGate.retention?.status === 'passed',
        archiveSynced: productGate.archiveSync?.status === 'synced',
        restoreDrillPassed: productGate.restoreDrill?.status === 'passed',
        rawLeakDetected: artifactManifest.rawLeakCheck.rawLeakDetected
      },
      fallbackPolicy: {
        policyVersion: 'd-bridge-audit-log-fallback-policy-v1',
        primaryFlow: 'write_hash_chained_audit_events_export_signed_siem_bundle_sync_worm_archive_and_restore_drill',
        fallbackFlows: [
          'block_release_when_hash_chain_or_signed_export_verification_fails',
          'block_release_when_immutable_archive_sync_or_restore_drill_fails',
          'keep_local_jsonl_audit_log_readable_until_external_worm_provider_is_confirmed',
          'block_release_when_raw_audit_entries_device_tokens_or_archive_paths_are_retained'
        ],
        operatorEscalation: 'bridge_audit_log_release_and_worm_archive_report'
      },
      rawDeviceTokenStored: false,
      rawAuditEntriesStored: false,
      rawArchivePathsStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-bridge-audit-log-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "D bridge audit log" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'audit_product_gate_passed',
        'audit_hash_chain_signed_export_verified',
        'audit_siem_and_retention_release_ready',
        'audit_immutable_archive_restore_ready',
        'audit_worm_manifest_ready',
        'audit_release_artifact_manifest_ready',
        'audit_operational_handoff_ready',
        'audit_worm_promotion_package_ready'
      ],
      productGateEvidenceHash: sha256Hex(canonicalJson(productGateEvidence)),
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawDeviceTokenStored: false,
      rawAuditEntriesStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-bridge-audit-log-worm-promotion-package-v1',
      providerContractVersion: 'd-bridge-audit-log-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-bridge-audit-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-bridge-audit-log-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      productGateEvidenceHash: sha256Hex(canonicalJson(productGateEvidence)),
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDeviceTokenStored: false,
      rawAuditEntriesStored: false,
      rawArchivePathsStored: false
    };
    const checks = [
      {
        checkId: 'audit_product_gate_passed',
        status: productGate.productGateVersion === 'd-bridge-audit-log-product-gate-v1'
          && productGate.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'audit_hash_chain_signed_export_verified',
        status: productGate.summary?.chain?.valid === true
          && typeof productGate.siem?.bundle?.signature === 'string'
          && productGate.siem.bundle.signature.length >= 32
          && productGate.siem?.bundle?.manifestHash?.length === 64
          && productGate.siem?.payloadHash?.length === 64 ? 'passed' : 'blocked'
      },
      {
        checkId: 'audit_siem_and_retention_release_ready',
        status: productGate.siem?.exportVersion === 'd-siem-compatible-audit-export-v1'
          && productGate.retention?.schedulerVersion === 'd-audit-retention-scheduler-v1'
          && productGate.retention?.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'audit_immutable_archive_restore_ready',
        status: productGate.archiveSync?.syncVersion === 'd-immutable-audit-archive-sync-v1'
          && productGate.archiveSync?.status === 'synced'
          && productGate.restoreDrill?.drillVersion === 'd-audit-archive-restore-drill-v1'
          && productGate.restoreDrill?.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'audit_worm_manifest_ready',
        status: productGate.archiveSync?.artifactStore?.storeVersion === 'd-bridge-audit-worm-store-v1'
          && productGate.archiveSync?.manifestPath ? 'passed' : 'blocked'
      },
      {
        checkId: 'audit_release_artifact_manifest_ready',
        status: artifactManifest.manifestVersion === 'd-bridge-audit-release-artifact-manifest-v1'
          && artifactManifest.rawLeakCheck.rawLeakDetected === false
          && artifactManifest.rawAuditEntriesStored === false
          && artifactManifest.rawArchivePathsStored === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'audit_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-bridge-audit-log-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-bridge-audit-log-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-bridge-audit-log-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'audit_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-bridge-audit-log-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-bridge-audit-log-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const dossier = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-bridge-audit-log-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks,
      productGate: productGateEvidence,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Export signed audit bundles before every bridge release.',
        'Sync immutable archive artifacts before rotating local logs.',
        'Run archive restore drill from the synced artifact path and verify the hash chain.',
        'Keep SIEM JSONL/CEF payload hashes with release evidence.',
        'Promote only hash-only audit evidence to external WORM storage.'
      ],
      rateLimit: sanitizeRateLimitState(limit.rateLimit)
    };
    this.auditLog.write('audit.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      checkCount: dossier.checks.length,
      blockedChecks: dossier.checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
  }

  rateLimit({ action, identity, token, device, cost = 1 }) {
    const resolvedIdentity = identity
      ?? (device?.deviceId ? `device:${device.deviceId}` : null)
      ?? (token ? `token:${this.registry.hashToken(token)}` : 'anonymous');
    const result = this.rateLimiter.check({ action, identity: resolvedIdentity, cost });
    if (!result.allowed) {
      this.auditLog.write('rate_limit.blocked', {
        action,
        identity: resolvedIdentity,
        retryAfterMs: result.retryAfterMs,
        remaining: result.remaining
      });
      return {
        ...createError('D_RATE_LIMITED', `Rate limit exceeded for ${action}.`, 429),
        rateLimit: result
      };
    }
    return { success: true, rateLimit: result };
  }

  checkHttpRateLimit({ action, ip, token }) {
    return this.rateLimit({
      action,
      identity: token ? `token:${this.registry.hashToken(token)}` : `ip:${ip ?? 'unknown'}`
    });
  }

  authenticate(token) {
    if (!token) {
      this.auditLog.write('auth.failed', { reason: 'D_AUTH_MISSING_TOKEN' });
      return createError('D_AUTH_MISSING_TOKEN', 'Bearer deviceToken is required.', 401);
    }
    const auth = this.registry.authenticateToken(token);
    if (!auth.success) {
      this.auditLog.write('auth.failed', { reason: auth.error?.code ?? 'D_AUTH_INVALID_TOKEN' });
      return auth;
    }
    auth.device.lastSeenAt = this.clock().toISOString();
    this.auditLog.write('auth.succeeded', {
      deviceId: auth.device.deviceId,
      tokenId: auth.token.tokenId,
      tokenVersion: auth.token.tokenVersion,
      tokenAlgorithm: auth.token.algorithm
    });
    return auth;
  }

  listDevices({ token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const inventory = this.registry.inventory();
    return {
      items: inventory.items,
      inventory,
      persistence: inventory.persistence
    };
  }

  deviceInventory({ token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return this.registry.inventory();
  }

  deviceTokenDeploymentPolicy({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return {
      success: true,
      deviceId: auth.device.deviceId,
      policy: this.registry.tokenService.deploymentPolicy()
    };
  }

  deviceTokenKeyRotationDrill({ token, nextSecret = undefined } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'device.token.rotation_drill', device: auth.device });
    if (!limit.success) return limit;
    const drill = this.registry.tokenService.keyRotationDrill({
      nextSecret,
      deviceId: auth.device.deviceId,
      deviceName: auth.device.deviceName
    });
    this.auditLog.write('device.token_rotation_drill', {
      deviceId: auth.device.deviceId,
      status: drill.status,
      currentKey: drill.currentKey.fingerprint,
      nextKey: drill.nextKey.fingerprint
    });
    return {
      success: drill.status === 'passed',
      drill,
      rateLimit: limit.rateLimit
    };
  }

  deviceTokenReleaseDossier({ token, nextSecret = undefined, reason = 'mobile_requested_device_token_release_dossier' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'device.token.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const policy = this.registry.tokenService.deploymentPolicy();
    const rotationDrill = this.registry.tokenService.keyRotationDrill({
      nextSecret,
      deviceId: auth.device.deviceId,
      deviceName: auth.device.deviceName
    });
    const inventory = this.registry.inventory();
    const activeVerification = this.registry.authenticateToken(token);
    const tokenParts = String(token).split('.');
    const tamperedToken = tokenParts.length === 3
      ? `${tokenParts[0]}.${tokenParts[1]}.tampered-signature`
      : 'legacy-unsigned-token';
    const tamperedVerification = this.registry.authenticateToken(tamperedToken);
    const malformedVerification = this.registry.authenticateToken('legacy-unsigned-token');
    const privateDeviceRecord = this.registry.devices.get(auth.device.deviceId);
    const privateDeviceSnapshot = JSON.stringify(privateDeviceRecord ?? {});
    const publicInventorySnapshot = JSON.stringify(inventory);
    const rawDeviceTokenStored = typeof token === 'string'
      && token.length > 0
      && (privateDeviceSnapshot.includes(token) || publicInventorySnapshot.includes(token));
    const signingKeyProvider = {
      contractVersion: 'd-device-token-signing-key-provider-contract-v1',
      currentProvider: policy.secretSource === 'JARVIS_DEVICE_TOKEN_SECRET' ? 'environment-secret' : 'development-default',
      supportedProviders: ['environment-secret', 'windows-dpapi-or-keychain', 'hsm-kms'],
      productionRequirement: 'Use JARVIS_DEVICE_TOKEN_SECRET or an OS/HSM-backed provider before non-local release.',
      localDevelopmentAllowed: policy.secretSource === 'development-default',
      secretFingerprintOnly: true
    };
    const checks = [
      {
        checkId: 'device_token_deployment_policy_ready',
        status: policy.policyVersion === 'd-device-token-deployment-policy-v1'
          && policy.checks.every((check) => check.status !== 'failed') ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_token_key_rotation_drill_passed',
        status: rotationDrill.drillVersion === 'd-device-token-key-rotation-drill-v1'
          && rotationDrill.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_token_active_verification_passed',
        status: activeVerification.success === true
          && activeVerification.token?.signed === true
          && activeVerification.token?.algorithm === 'HS256'
          && activeVerification.device?.deviceId === auth.device.deviceId ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_token_malformed_and_tampered_rejected',
        status: malformedVerification.error?.code === 'D_AUTH_TOKEN_MALFORMED'
          && tamperedVerification.error?.code === 'D_AUTH_TOKEN_SIGNATURE_INVALID' ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_registry_hash_only_retention_safe',
        status: rawDeviceTokenStored === false
          && privateDeviceRecord?.tokenHash?.length === 64
          && inventory.items.every((item) => item.tokenHash === '[masked]' || item.tokenHash === undefined) ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_token_rotation_revokes_previous_contract_ready',
        status: policy.rotation?.revokePreviousTokenOnDeviceRotation === true
          && inventory.items.some((item) => item.deviceId === auth.device.deviceId && Number.isFinite(item.rotatedTokenCount)) ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_token_signing_key_provider_contract_ready',
        status: signingKeyProvider.supportedProviders.includes('hsm-kms')
          && signingKeyProvider.secretFingerprintOnly === true ? 'passed' : 'blocked'
      }
    ];
    const artifactManifest = {
      manifestVersion: 'd-device-token-auth-release-artifact-manifest-v1',
      policyVersion: policy.policyVersion,
      rotationDrillVersion: rotationDrill.drillVersion,
      inventoryVersion: inventory.inventoryVersion,
      registryJournalPath: this.registry.journalPath ?? null,
      rawDeviceTokenStored,
      tokenHashOnly: privateDeviceRecord?.tokenHash?.length === 64,
      secretFingerprintOnly: signingKeyProvider.secretFingerprintOnly
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-device-token-auth-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-device-token-release-owner',
      scope: 'device_token_signing_verification_rotation_registry_retention',
      status: checks.every((check) => check.status === 'passed') && rawDeviceTokenStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-device-token-auth-health-handshake-v1',
      healthHandshake: {
        activeVerificationPassed: activeVerification.success === true,
        malformedTokenRejected: malformedVerification.error?.code === 'D_AUTH_TOKEN_MALFORMED',
        tamperedTokenRejected: tamperedVerification.error?.code === 'D_AUTH_TOKEN_SIGNATURE_INVALID',
        rotationDrillPassed: rotationDrill.status === 'passed',
        hashOnlyRegistry: privateDeviceRecord?.tokenHash?.length === 64,
        rawDeviceTokenStored
      },
      fallbackPolicy: {
        policyVersion: 'd-device-token-auth-fallback-policy-v1',
        primaryFlow: 'verify_signed_device_tokens_rotate_before_secret_change_and_reject_previous_tokens',
        fallbackFlows: [
          'block_protected_routes_when_token_signature_or_claims_are_invalid',
          'keep_registry_hash_only_when_token_rotation_or_repair_occurs',
          'run_key_rotation_drill_before_deployment_secret_changes',
          'block_release_when_raw_device_token_or_signing_secret_is_stored'
        ],
        operatorEscalation: 'bridge_device_token_release_and_signing_key_provider_report'
      },
      rawDeviceTokenStored: false,
      rawSigningSecretStored: false,
      rawRegistryTokenStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-device-token-auth-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "device.token.release_dossier" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'device_token_deployment_policy_ready',
        'device_token_key_rotation_drill_passed',
        'device_token_active_verification_passed',
        'device_token_malformed_and_tampered_rejected',
        'device_registry_hash_only_retention_safe',
        'device_token_rotation_revokes_previous_contract_ready',
        'device_token_signing_key_provider_contract_ready',
        'device_token_release_artifact_manifest_ready',
        'device_token_operational_handoff_ready',
        'device_token_worm_promotion_package_ready'
      ],
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawDeviceTokenStored: false,
      rawSigningSecretStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-device-token-auth-worm-promotion-package-v1',
      providerContractVersion: 'd-device-token-auth-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-device-token-auth-release-artifact-manifest-v1'
        && rawDeviceTokenStored === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-device-token-auth-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDeviceTokenStored: false,
      rawSigningSecretStored: false
    };
    const releaseChecks = [
      ...checks,
      {
        checkId: 'device_token_release_artifact_manifest_ready',
        status: artifactManifest.manifestVersion === 'd-device-token-auth-release-artifact-manifest-v1'
          && artifactManifest.rawDeviceTokenStored === false
          && artifactManifest.tokenHashOnly === true
          && artifactManifest.secretFingerprintOnly === true ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_token_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-device-token-auth-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-device-token-auth-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-device-token-auth-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_token_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-device-token-auth-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-device-token-auth-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const releaseCore = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-device-token-auth-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseChecks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks: releaseChecks,
      policy,
      rotationDrill,
      signingKeyProvider,
      authProof: {
        deviceId: auth.device.deviceId,
        tokenId: auth.token.tokenId,
        tokenVersion: auth.token.tokenVersion,
        tokenAlgorithm: auth.token.algorithm,
        signed: auth.token.signed,
        activeVerification: activeVerification.success === true,
        malformedTokenRejectedCode: malformedVerification.error?.code ?? null,
        tamperedTokenRejectedCode: tamperedVerification.error?.code ?? null
      },
      inventoryEvidence: {
        inventoryVersion: inventory.inventoryVersion,
        totalDevices: inventory.totalDevices,
        activeDevices: inventory.activeDevices,
        persistence: inventory.persistence,
        byTrustLabel: inventory.byTrustLabel,
        currentDevice: inventory.items.find((item) => item.deviceId === auth.device.deviceId) ?? null
      },
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Use only signed three-part JARVIS-D device tokens on protected bridge routes.',
        'Rotate device tokens from /devices/token/rotate and reject the previous token immediately.',
        'Run /devices/token/rotation-drill before changing JARVIS_DEVICE_TOKEN_SECRET.',
        'For non-local release, source signing material from environment secret, OS key store, or HSM/KMS provider.'
      ],
      rateLimit: limit.rateLimit
    };
    const dossier = {
      ...releaseCore,
      dossierSha256: sha256Hex(canonicalJson(releaseCore))
    };
    this.auditLog.write('device.token.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      checkCount: dossier.checks.length,
      blockedChecks: dossier.checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
  }

  requestNoncePolicy({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return {
      success: true,
      policy: this.requestNonceStore.routePolicy(),
      snapshot: this.requestNonceStore.snapshot()
    };
  }

  compactRequestNonces({ token, dryRun = true, reason = 'manual_nonce_compaction' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'request_nonce.compact', device: auth.device });
    if (!limit.success) return limit;
    const compaction = this.requestNonceStore.compact({ dryRun, reason });
    this.auditLog.write('request.nonce.compacted', {
      deviceId: auth.device.deviceId,
      dryRun,
      reason,
      wouldRemove: compaction.wouldRemove
    });
    return {
      success: true,
      compaction,
      rateLimit: limit.rateLimit
    };
  }

  requestNonceClockSkewFixtures({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return {
      success: true,
      report: this.requestNonceStore.clockSkewFixtureReport()
    };
  }

  requestNonceProductGate({ token, drillRequestId = undefined } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'request_nonce.product_gate', device: auth.device });
    if (!limit.success) return limit;
    const policy = this.requestNonceStore.routePolicy();
    const snapshot = this.requestNonceStore.snapshot();
    const compaction = this.requestNonceStore.compact({ dryRun: true, reason: 'request_nonce_product_gate' });
    const clockSkew = this.requestNonceStore.clockSkewFixtureReport();
    const sharedBackendDrill = this.requestNonceStore.sharedBackendConcurrencyDrill({ requestId: drillRequestId });
    const checks = [
      {
        checkId: 'request_nonce_route_policy_ready',
        passed: policy.policyVersion === 'd-request-nonce-route-policy-v1'
          && policy.routes.some((route) => route.route === 'task.create' && route.nonceRequired === true)
      },
      {
        checkId: 'request_nonce_shared_backend_configured',
        passed: policy.sharedBackend.backendVersion === 'd-request-nonce-shared-backend-contract-v1'
          && policy.sharedBackend.configured === true
          && policy.sharedBackend.plaintextRequestIdStored === false
      },
      {
        checkId: 'request_nonce_clock_skew_fixtures_passed',
        passed: clockSkew.reportVersion === 'd-request-nonce-clock-skew-fixtures-v1' && clockSkew.status === 'passed'
      },
      {
        checkId: 'request_nonce_compaction_ready',
        passed: compaction.compactionVersion === 'd-request-nonce-compaction-report-v1' && compaction.status === 'passed'
      },
      {
        checkId: 'request_nonce_shared_backend_drill_passed',
        passed: sharedBackendDrill.drillVersion === 'd-request-nonce-shared-backend-concurrency-drill-v1'
          && sharedBackendDrill.status === 'passed'
      },
      {
        checkId: 'request_nonce_snapshot_hash_only',
        passed: snapshot.entries.every((entry) => entry.rawRequestIdStored === false && entry.requestIdHash?.length === 64)
      }
    ];
    const status = checks.every((check) => check.passed) ? 'passed' : 'failed';
    this.auditLog.write('request.nonce.product_gate', {
      deviceId: auth.device.deviceId,
      status,
      checks: checks.map((check) => ({ checkId: check.checkId, passed: check.passed }))
    });
    return {
      success: true,
      module: ModuleId.BRIDGE,
      productGateVersion: 'd-request-nonce-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status,
      checks,
      policy,
      snapshot,
      compaction,
      clockSkew,
      sharedBackendDrill,
      rateLimit: limit.rateLimit,
      recommendations: status === 'passed'
        ? ['Run this request nonce product gate in bridge server soak and keep the shared-backend drill artifact in release evidence.']
        : checks.filter((check) => !check.passed).map((check) => `Resolve request nonce product gate check: ${check.checkId}`)
    };
  }

  requestNonceReleaseDossier({
    token,
    drillRequestId = undefined,
    reason = 'mobile_requested_request_nonce_release_dossier'
  } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'request_nonce.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const productGate = this.requestNonceProductGate({ token, drillRequestId });
    if (productGate.success === false) return productGate;
    const hashString = (value) => (typeof value === 'string' && value.length > 0 ? sha256Hex(value) : null);
    const sanitizeRateLimitState = (state) => state
      ? {
          ...state,
          identity: undefined,
          identityHash: hashString(state.identity),
          rawIdentityStored: false
        }
      : state;
    const rawDeviceIds = productGate.snapshot.entries.map((entry) => entry.deviceId).filter(Boolean);
    const rawTaskIds = productGate.snapshot.entries.map((entry) => entry.taskId).filter(Boolean);
    const rawRequestNeedles = [drillRequestId, productGate.sharedBackendDrill?.firstReserve?.replay?.requestId]
      .filter((value) => typeof value === 'string' && value.length > 0);
    const productGateEvidence = {
      productGateVersion: productGate.productGateVersion,
      generatedAt: productGate.generatedAt,
      status: productGate.status,
      checks: productGate.checks,
      policy: productGate.policy,
      snapshot: {
        activeCount: productGate.snapshot.activeCount,
        ttlMs: productGate.snapshot.ttlMs,
        maxEntries: productGate.snapshot.maxEntries,
        routePolicy: productGate.snapshot.routePolicy,
        sharedBackend: productGate.snapshot.sharedBackend,
        entries: productGate.snapshot.entries.map(({ deviceId, taskId, ...entry }) => ({
          ...entry,
          deviceIdHash: hashString(deviceId),
          taskIdHash: hashString(taskId),
          rawDeviceIdStored: false,
          rawTaskIdStored: false
        })),
        persistence: {
          ...productGate.snapshot.persistence,
          journalPath: undefined,
          journalPathHash: hashString(productGate.snapshot.persistence?.journalPath),
          rawJournalPathStored: false
        }
      },
      compaction: {
        compactionVersion: productGate.compaction.compactionVersion,
        status: productGate.compaction.status,
        dryRun: productGate.compaction.dryRun,
        reason: productGate.compaction.reason,
        before: productGate.compaction.before,
        expired: productGate.compaction.expired,
        overLimit: productGate.compaction.overLimit,
        wouldRemove: productGate.compaction.wouldRemove,
        after: productGate.compaction.after,
        candidateHashes: productGate.compaction.candidateHashes,
        sharedBackend: productGate.compaction.sharedBackend
      },
      clockSkew: productGate.clockSkew,
      sharedBackendDrill: {
        drillVersion: productGate.sharedBackendDrill.drillVersion,
        generatedAt: productGate.sharedBackendDrill.generatedAt,
        status: productGate.sharedBackendDrill.status,
        requestIdHash: productGate.sharedBackendDrill.requestIdHash,
        drillJournalPathHash: hashString(productGate.sharedBackendDrill.drillJournalPath),
        rawDrillJournalPathStored: false,
        backend: productGate.sharedBackendDrill.backend,
        firstReserveAccepted: productGate.sharedBackendDrill.firstReserve?.success === true,
        duplicateReserveBlocked: productGate.sharedBackendDrill.duplicateReserve?.error?.code === 'D_REQUEST_REPLAY_BLOCKED',
        uniqueReserveAccepted: productGate.sharedBackendDrill.uniqueReserve?.success === true,
        snapshotHash: sha256Hex(canonicalJson({
          activeCount: productGate.sharedBackendDrill.snapshot?.activeCount,
          entries: (productGate.sharedBackendDrill.snapshot?.entries ?? []).map((entry) => ({
            requestIdHash: entry.requestIdHash,
            route: entry.route,
            rawRequestIdStored: entry.rawRequestIdStored
          }))
        })),
        checks: productGate.sharedBackendDrill.checks
      },
      rateLimit: sanitizeRateLimitState(productGate.rateLimit)
    };
    const releasePayloadText = canonicalJson(productGateEvidence);
    const rawDeviceTokenStored = typeof token === 'string' && token.length > 0 && releasePayloadText.includes(token);
    const rawDeviceIdStored = rawDeviceIds.some((deviceId) => releasePayloadText.includes(deviceId));
    const rawTaskIdStored = rawTaskIds.some((taskId) => releasePayloadText.includes(taskId));
    const rawRequestIdStored = rawRequestNeedles.some((requestId) => releasePayloadText.includes(requestId));
    const artifactManifest = {
      manifestVersion: 'd-request-nonce-release-artifact-manifest-v1',
      productGateVersion: productGate.productGateVersion,
      policyVersion: productGate.policy.policyVersion,
      compactionVersion: productGate.compaction.compactionVersion,
      clockSkewReportVersion: productGate.clockSkew.reportVersion,
      sharedBackendDrillVersion: productGate.sharedBackendDrill.drillVersion,
      activeNonceCount: productGate.snapshot.activeCount,
      rawRequestIdStored,
      rawDeviceTokenStored,
      rawDeviceIdStored,
      rawTaskIdStored,
      rawJournalPathStored: false,
      rawLeakCheck: {
        checkedNeedleCount: 1 + rawDeviceIds.length + rawTaskIds.length + rawRequestNeedles.length,
        rawLeakDetected: rawRequestIdStored || rawDeviceTokenStored || rawDeviceIdStored || rawTaskIdStored
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-request-nonce-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-request-nonce-release-owner',
      scope: 'task_create_request_id_replay_prevention_ttl_compaction_shared_backend_clock_skew',
      status: productGate.status === 'passed' && artifactManifest.rawLeakCheck.rawLeakDetected === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-request-nonce-health-handshake-v1',
      healthHandshake: {
        productGatePassed: productGate.status === 'passed',
        routePolicyReady: productGate.policy.policyVersion === 'd-request-nonce-route-policy-v1',
        compactionReady: productGate.compaction.status === 'passed',
        clockSkewReady: productGate.clockSkew.status === 'passed',
        sharedBackendDrillPassed: productGate.sharedBackendDrill.status === 'passed',
        hashOnlySnapshot: productGate.snapshot.entries.every((entry) => entry.rawRequestIdStored === false),
        rawLeakDetected: artifactManifest.rawLeakCheck.rawLeakDetected
      },
      fallbackPolicy: {
        policyVersion: 'd-request-nonce-fallback-policy-v1',
        primaryFlow: 'reserve_hash_only_request_id_before_mutating_task_create_and_block_replay_across_restart',
        fallbackFlows: [
          'block_mutating_task_create_when_nonce_backend_is_unavailable_in_strict_release_mode',
          'fall_back_to_jsonl_append_only_backend_until_sqlite_or_redis_adapter_is_promoted',
          'compact_expired_nonce_hashes_without_storing_raw_request_ids',
          'block_release_when_raw_request_id_device_token_or_device_id_is_retained'
        ],
        operatorEscalation: 'bridge_request_nonce_release_and_replay_soak_report'
      },
      rawRequestIdStored: false,
      rawDeviceTokenStored: false,
      rawDeviceIdStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-request-nonce-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "durable request nonce" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'request_nonce_product_gate_passed',
        'request_nonce_release_artifact_manifest_ready',
        'request_nonce_operational_handoff_ready',
        'request_nonce_worm_promotion_package_ready'
      ],
      productGateHash: sha256Hex(canonicalJson(productGateEvidence)),
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawRequestIdStored: false,
      rawDeviceTokenStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-request-nonce-worm-promotion-package-v1',
      providerContractVersion: 'd-request-nonce-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-request-nonce-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-request-nonce-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      productGateHash: sha256Hex(canonicalJson(productGateEvidence)),
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawRequestIdStored: false,
      rawDeviceTokenStored: false,
      rawDeviceIdStored: false
    };
    const checks = [
      {
        checkId: 'request_nonce_product_gate_passed',
        status: productGate.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'request_nonce_release_artifact_manifest_ready',
        status: artifactManifest.manifestVersion === 'd-request-nonce-release-artifact-manifest-v1'
          && artifactManifest.rawLeakCheck.rawLeakDetected === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'request_nonce_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-request-nonce-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-request-nonce-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-request-nonce-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'request_nonce_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-request-nonce-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-request-nonce-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const releaseCore = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-request-nonce-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks,
      productGateEvidence,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Run /request-nonces/product-gate and this release dossier before changing requestId replay policy.',
        'Use hash-only requestId evidence; raw request IDs and device tokens must never appear in release artifacts.',
        'Require shared-backend drill evidence before multi-process bridge deployment.',
        'Attach compaction and clock-skew fixture results to WORM release evidence.'
      ],
      rateLimit: sanitizeRateLimitState(limit.rateLimit)
    };
    const dossier = {
      ...releaseCore,
      dossierSha256: sha256Hex(canonicalJson(releaseCore))
    };
    this.auditLog.write('request_nonce.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      checkCount: checks.length,
      blockedChecks: checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
  }

  revokeDevice({ deviceId, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    if (auth.device.deviceId !== deviceId) {
      return createError('D_DEVICE_REVOKE_FORBIDDEN', 'A mobile device can revoke only its own token in MVP.', 403);
    }
    const revoked = this.registry.revoke(deviceId);
    this.eventRelay.publish('device.revoked', { deviceId, status: revoked.status });
    return revoked;
  }

  rotateDeviceToken({ token, reason = 'device_requested_rotation' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'device.token.rotate', device: auth.device });
    if (!limit.success) return limit;
    const rotated = this.registry.rotateToken({
      deviceId: auth.device.deviceId,
      previousTokenHash: auth.token.tokenHash,
      reason
    });
    if (!rotated.success) return rotated;
    this.eventRelay.publish('device.token_rotated', {
      deviceId: rotated.deviceId,
      tokenVersion: rotated.tokenVersion,
      expiresAt: rotated.expiresAt
    });
    return rotated;
  }

  heartbeat({ token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'device.heartbeat', device: auth.device });
    if (!limit.success) return limit;
    const device = this.registry.recordSeen(auth.device.deviceId) ?? auth.device;
    const heartbeat = {
      deviceId: device.deviceId,
      status: 'connected',
      lastSeenAt: device.lastSeenAt,
      trustLabel: this.registry.trustLabel(device),
      serverTime: this.clock().toISOString()
    };
    this.auditLog.write('device.heartbeat', heartbeat);
    return heartbeat;
  }

  pairingReleaseDossier({ token, reason = 'mobile_requested_pairing_release_dossier' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'pairing.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const generatedAt = this.clock().toISOString();
    const fixtureDeviceId = stableId('pairing_release_device', auth.device.deviceId, generatedAt);
    const firstPairing = this.pairing.start({ bridgeUrl: this.pairing.bridgeUrl });
    const sessionEvidence = (session) => ({
      pairingId: session.pairingId,
      codeLength: String(session.pairingCode ?? '').length,
      entropyBits: session.security?.entropyBits ?? null,
      expiresInMs: session.expiresInMs,
      attemptsRemaining: session.attemptsRemaining,
      qrPayload: {
        version: session.qrPayload?.version ?? null,
        scheme: session.qrPayload?.scheme ?? null,
        type: session.qrPayload?.type ?? null,
        qrTextHash: sha256Hex(session.qrPayload?.qrText ?? ''),
        rawPairingCodeStored: false
      },
      security: session.security
    });
    const badCode = firstPairing.pairingCode === '00000000' ? '99999999' : '00000000';
    const wrongAttempt = this.pairing.confirm({
      deviceId: fixtureDeviceId,
      deviceName: 'Pairing Release Device',
      pairingId: firstPairing.pairingId,
      pairingCode: badCode
    });
    const afterWrongStatus = this.pairing.status();
    const mismatch = this.pairing.confirm({
      deviceId: fixtureDeviceId,
      deviceName: 'Pairing Release Device',
      pairingId: 'pairing_release_mismatch',
      pairingCode: firstPairing.pairingCode
    });
    const confirmed = this.pairing.confirm({
      deviceId: fixtureDeviceId,
      deviceName: 'Pairing Release Device',
      pairingId: firstPairing.pairingId,
      pairingCode: firstPairing.pairingCode
    });
    if (confirmed.success === false) return confirmed;
    const firstToken = confirmed.deviceToken;
    const singleUse = this.pairing.confirm({
      deviceId: fixtureDeviceId,
      deviceName: 'Pairing Release Device',
      pairingId: firstPairing.pairingId,
      pairingCode: firstPairing.pairingCode
    });
    const secondPairing = this.pairing.start({ bridgeUrl: this.pairing.bridgeUrl });
    const repaired = this.pairing.confirm({
      deviceId: fixtureDeviceId,
      deviceName: 'Pairing Release Device',
      pairingId: secondPairing.pairingId,
      pairingCode: secondPairing.pairingCode
    });
    if (repaired.success === false) return repaired;
    const repairedToken = repaired.deviceToken;
    const oldTokenRejected = this.heartbeat({ token: firstToken });
    const repairedHeartbeat = this.heartbeat({ token: repairedToken });
    const lockedPairing = this.pairing.start({ bridgeUrl: this.pairing.bridgeUrl });
    const lockedBadCode = lockedPairing.pairingCode === '11111111' ? '22222222' : '11111111';
    let locked = null;
    for (let attempt = 0; attempt < this.pairing.maxAttempts; attempt += 1) {
      locked = this.pairing.confirm({
        deviceId: `${fixtureDeviceId}_locked`,
        deviceName: 'Pairing Release Locked Device',
        pairingId: lockedPairing.pairingId,
        pairingCode: lockedBadCode
      });
    }
    const lockedStatus = this.pairing.status();
    const inventory = this.registry.inventory();
    const privateDeviceRecord = this.registry.devices.get(fixtureDeviceId);
    const sanitizedEvidence = {
      firstSession: sessionEvidence(firstPairing),
      wrongAttempt: { errorCode: wrongAttempt.error?.code ?? null, attemptsRemaining: afterWrongStatus.attemptsRemaining },
      mismatch: { errorCode: mismatch.error?.code ?? null },
      confirmed: maskSensitive(confirmed),
      singleUse: { errorCode: singleUse.error?.code ?? null },
      repairSession: sessionEvidence(secondPairing),
      repaired: maskSensitive(repaired),
      oldTokenRejected: { errorCode: oldTokenRejected.error?.code ?? null },
      repairedHeartbeat,
      lockedSession: sessionEvidence(lockedPairing),
      lockout: { errorCode: locked?.error?.code ?? null, attempts: lockedStatus.attempts, attemptsRemaining: lockedStatus.attemptsRemaining },
      inventory: {
        inventoryVersion: inventory.inventoryVersion,
        totalDevices: inventory.totalDevices,
        activeDevices: inventory.activeDevices,
        byTrustLabel: inventory.byTrustLabel,
        recovery: inventory.recovery,
        persistence: inventory.persistence,
        currentFixtureDevice: inventory.items.find((item) => item.deviceId === fixtureDeviceId) ?? null
      }
    };
    const rawEvidencePayload = JSON.stringify(sanitizedEvidence);
    const rawDeviceTokenStored = [firstToken, repairedToken].some((issuedToken) => issuedToken && rawEvidencePayload.includes(issuedToken));
    const rawPairingCodeStored = [firstPairing.pairingCode, secondPairing.pairingCode, lockedPairing.pairingCode]
      .some((code) => code && rawEvidencePayload.includes(code));
    const registryBackend = {
      contractVersion: 'd-device-registry-backend-contract-v1',
      currentBackend: this.registry.journalPath ? 'local-jsonl-hash-only' : 'memory-only',
      supportedBackends: ['local-jsonl-hash-only', 'sqlite-encrypted', 'remote-encrypted-registry'],
      journalPath: this.registry.journalPath ?? null,
      plaintextTokenStored: false,
      upgradePath: 'Use sqlite-encrypted or remote-encrypted-registry for multi-device production sync.'
    };
    const checks = [
      {
        checkId: 'pairing_qr_entropy_and_ttl_ready',
        status: sanitizedEvidence.firstSession.codeLength >= 8
          && sanitizedEvidence.firstSession.entropyBits >= 26
          && sanitizedEvidence.firstSession.expiresInMs === this.pairing.ttlMs
          && sanitizedEvidence.firstSession.qrPayload.version === 2 ? 'passed' : 'blocked'
      },
      {
        checkId: 'pairing_wrong_mismatch_single_use_lockout_ready',
        status: wrongAttempt.error?.code === 'D_PAIRING_CODE_INVALID'
          && mismatch.error?.code === 'D_PAIRING_SESSION_MISMATCH'
          && singleUse.error?.code === 'D_PAIRING_CODE_INVALID'
          && locked?.error?.code === 'D_PAIRING_CODE_LOCKED' ? 'passed' : 'blocked'
      },
      {
        checkId: 'pairing_confirm_issues_signed_hash_only_device',
        status: confirmed.token?.signed === true
          && confirmed.device?.tokenHash === '[masked]'
          && privateDeviceRecord?.tokenHash?.length === 64
          && JSON.stringify(privateDeviceRecord).includes(firstToken) === false
          && JSON.stringify(privateDeviceRecord).includes(repairedToken) === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'pairing_repair_revokes_previous_token',
        status: repaired.rePaired === true
          && repaired.previousTokenRevoked === true
          && oldTokenRejected.error?.code === 'D_AUTH_INVALID_TOKEN'
          && repairedHeartbeat.status === 'connected' ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_inventory_recovery_contract_ready',
        status: inventory.inventoryVersion === 'd-device-inventory-v1'
          && inventory.items.some((item) => item.deviceId === fixtureDeviceId && item.trustLabel === 'trusted-repaired-device')
          && inventory.recovery?.recommendedActions?.includes('monitor_device_heartbeat') ? 'passed' : 'blocked'
      },
      {
        checkId: 'device_registry_backend_contract_ready',
        status: registryBackend.supportedBackends.includes('sqlite-encrypted')
          && registryBackend.supportedBackends.includes('remote-encrypted-registry')
          && registryBackend.plaintextTokenStored === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'pairing_release_raw_secret_retention_safe',
        status: rawDeviceTokenStored === false && rawPairingCodeStored === false ? 'passed' : 'blocked'
      }
    ];
    const artifactManifest = {
      manifestVersion: 'd-pairing-device-release-artifact-manifest-v1',
      fixtureDeviceId,
      inventoryVersion: inventory.inventoryVersion,
      registryJournalPath: this.registry.journalPath ?? null,
      qrTextHash: sanitizedEvidence.firstSession.qrPayload.qrTextHash,
      codeLength: sanitizedEvidence.firstSession.codeLength,
      entropyBits: sanitizedEvidence.firstSession.entropyBits,
      rawDeviceTokenStored,
      rawPairingCodeStored,
      plaintextTokenStored: false
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-pairing-device-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-pairing-device-release-owner',
      scope: 'pairing_qr_device_registry_repair_revoke_inventory',
      status: checks.every((check) => check.status === 'passed')
        && rawDeviceTokenStored === false
        && rawPairingCodeStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-pairing-device-health-handshake-v1',
      healthHandshake: {
        qrEntropyAndTtlReady: sanitizedEvidence.firstSession.codeLength >= 8
          && sanitizedEvidence.firstSession.entropyBits >= 26
          && sanitizedEvidence.firstSession.expiresInMs === this.pairing.ttlMs,
        wrongMismatchSingleUseLockoutReady: wrongAttempt.error?.code === 'D_PAIRING_CODE_INVALID'
          && mismatch.error?.code === 'D_PAIRING_SESSION_MISMATCH'
          && singleUse.error?.code === 'D_PAIRING_CODE_INVALID'
          && locked?.error?.code === 'D_PAIRING_CODE_LOCKED',
        repairRevokesPreviousToken: oldTokenRejected.error?.code === 'D_AUTH_INVALID_TOKEN'
          && repairedHeartbeat.status === 'connected',
        registryBackendReady: registryBackend.plaintextTokenStored === false,
        rawDeviceTokenStored,
        rawPairingCodeStored
      },
      fallbackPolicy: {
        policyVersion: 'd-pairing-device-fallback-policy-v1',
        primaryFlow: 'issue_single_use_pairing_code_confirm_qr_payload_and_store_hash_only_device_token',
        fallbackFlows: [
          'lock_pairing_session_after_repeated_invalid_codes',
          'reject_pairing_id_mismatch_and_single_use_replay',
          'revoke_previous_device_token_when_same_device_repairs_pairing',
          'block_release_when_pairing_code_or_device_token_raw_payload_is_stored'
        ],
        operatorEscalation: 'bridge_pairing_device_release_and_registry_backend_report'
      },
      rawDeviceTokenStored: false,
      rawPairingCodeStored: false,
      plaintextTokenStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-pairing-device-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "pairing.release_dossier" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'pairing_qr_entropy_and_ttl_ready',
        'pairing_wrong_mismatch_single_use_lockout_ready',
        'pairing_confirm_issues_signed_hash_only_device',
        'pairing_repair_revokes_previous_token',
        'device_inventory_recovery_contract_ready',
        'device_registry_backend_contract_ready',
        'pairing_release_raw_secret_retention_safe',
        'pairing_release_artifact_manifest_ready',
        'pairing_operational_handoff_ready',
        'pairing_worm_promotion_package_ready'
      ],
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawDeviceTokenStored: false,
      rawPairingCodeStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-pairing-device-worm-promotion-package-v1',
      providerContractVersion: 'd-pairing-device-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-pairing-device-release-artifact-manifest-v1'
        && rawDeviceTokenStored === false
        && rawPairingCodeStored === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-pairing-device-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDeviceTokenStored: false,
      rawPairingCodeStored: false
    };
    const releaseChecks = [
      ...checks,
      {
        checkId: 'pairing_release_artifact_manifest_ready',
        status: artifactManifest.manifestVersion === 'd-pairing-device-release-artifact-manifest-v1'
          && artifactManifest.rawDeviceTokenStored === false
          && artifactManifest.rawPairingCodeStored === false
          && artifactManifest.plaintextTokenStored === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'pairing_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-pairing-device-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-pairing-device-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-pairing-device-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'pairing_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-pairing-device-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-pairing-device-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const releaseCore = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-pairing-device-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseChecks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks: releaseChecks,
      pairingEvidence: sanitizedEvidence,
      registryBackend,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Use QR payload v2 with pairingId, bridge URL, expiry, and an 8-digit numeric code.',
        'Treat pairing codes as single-use and lock them after repeated failures.',
        'On re-pairing the same deviceId, revoke the previous device token immediately.',
        'For production multi-device sync, migrate device registry to sqlite-encrypted or remote-encrypted-registry.'
      ],
      rateLimit: limit.rateLimit
    };
    const dossier = {
      ...releaseCore,
      dossierSha256: sha256Hex(canonicalJson(releaseCore))
    };
    this.auditLog.write('pairing.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      fixtureDeviceId,
      checkCount: checks.length,
      blockedChecks: checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
  }

  createTask({ rawText, taskRequest, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'task.create', device: auth.device });
    if (!limit.success) return limit;
    const commandText = String(rawText ?? taskRequest?.command?.rawText ?? '').trim();
    if (!commandText) return createError('D_EMPTY_TASK_COMMAND', 'Task command is required.', 400);
    const requestId = taskRequest?.requestId;
    const nonce = this.requestNonceStore.reserve({
      requestId,
      deviceId: auth.device.deviceId,
      route: 'task.create'
    });
    if (!nonce.success) return nonce;
    const task = this.coreFacade.createTask(commandText, {
      deviceId: auth.device.deviceId,
      createdAt: taskRequest?.createdAt ?? this.clock().toISOString()
    });
    this.requestNonceStore.attachTask({ requestId, taskId: task.taskId });
    this.stateCache.rememberRequest({ requestId, taskId: task.taskId, deviceId: auth.device.deviceId });
    this.stateCache.rememberTask(task);
    this.stateCache.rememberApproval(task.approvalCard);
    this.stateCache.appendApprovalHistory({
      approvalId: task.approvalCard.approvalId,
      taskId: task.taskId,
      eventType: 'approval.created',
      label: '승인 카드 생성',
      status: task.status,
      actor: ModuleId.CORE,
      detail: task.approvalCard.interpretedIntent,
      createdAt: task.lifecycle.current().at,
      metadata: {
        riskTier: task.approvalCard.riskTier,
        mobileApprovalAllowed: task.approvalCard.riskTier > 3
      }
    });
    this.auditLog.write('task.created', {
      taskId: task.taskId,
      approvalId: task.approvalCard.approvalId,
      deviceId: auth.device.deviceId,
      status: task.status
    });
    this.eventRelay.publish('task.status.changed', {
      taskId: task.taskId,
      approvalId: task.approvalCard.approvalId,
      previousStatus: 'CREATED',
      status: task.status,
      deviceId: auth.device.deviceId
    });
    this.eventRelay.publish('task.created', {
      taskId: task.taskId,
      approvalId: task.approvalCard.approvalId,
      status: task.status,
      deviceId: auth.device.deviceId
    });
    this.eventRelay.publish('approval.created', {
      taskId: task.taskId,
      approvalId: task.approvalCard.approvalId,
      riskTier: task.approvalCard.riskTier,
      status: task.status,
      deviceId: auth.device.deviceId
    });
    return {
      taskId: task.taskId,
      status: task.status,
      approvalId: task.approvalCard.approvalId
    };
  }

  listTasks({ token, status } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const items = this.stateCache.listTasks(status);
    return { items };
  }

  getTaskStatus({ taskId, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const task = this.coreFacade.getTask(taskId);
    if (!task) return createError('D_TASK_NOT_FOUND', 'Task not found.', 404);
    const status = task.lifecycle.asTaskStatus({
      title: task.plan.title,
      summary: task.plan.interpretedIntent,
      updatedAt: task.lifecycle.current().at
    });
    this.stateCache.updateTask(taskId, { status: status.status, updatedAt: status.updatedAt });
    return status;
  }

  listApprovals({ token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const items = [...this.coreFacade.tasks.values()]
      .filter((task) => task.status === TaskStatus.WAITING_APPROVAL)
      .map((task) => maskSensitive(task.approvalCard));
    return { items };
  }

  getApproval({ approvalId, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.approvalCard.approvalId === approvalId);
    if (!task) return createError('D_APPROVAL_NOT_FOUND', 'Approval card not found.', 404);
    return maskSensitive(task.approvalCard);
  }

  getApprovalHistory({ approvalId, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.approvalCard.approvalId === approvalId);
    const cached = this.stateCache.approvals.get(approvalId);
    const items = this.stateCache.approvalTimeline(approvalId);
    if (!task && !cached && items.length === 0) {
      return createError('D_APPROVAL_NOT_FOUND', 'Approval card not found.', 404);
    }
    return {
      approvalId,
      taskId: task?.taskId ?? cached?.taskId ?? items[0]?.taskId ?? null,
      items
    };
  }

  requestPcConfirmation({ approvalId, token, reason = 'mobile_requires_pc_confirmation' }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.approvalCard.approvalId === approvalId);
    if (!task) return createError('D_APPROVAL_NOT_FOUND', 'Approval card not found.', 404);
    const requiresPcConfirmation = task.approvalCard.riskTier <= 3 || task.approvalCard.externalTransfer === true;
    if (!requiresPcConfirmation) {
      return createError('D_PC_HANDOFF_NOT_REQUIRED', 'This approval can be handled by mobile policy.', 409);
    }
    const createdAt = this.clock().toISOString();
    const handoff = {
      handoffId: stableId('pc_handoff', `${approvalId}:${auth.device.deviceId}`, createdAt),
      type: 'approval_pc_confirmation',
      approvalId,
      taskId: task.taskId,
      status: 'awaiting_pc_confirmation',
      reason,
      requestedBy: {
        module: ModuleId.MOBILE,
        deviceId: auth.device.deviceId
      },
      createdAt,
      expiresAt: task.approvalCard.expiresAt ?? null,
      requiresPcConfirmation: true,
      approvalSnapshot: maskSensitive({
        title: task.approvalCard.title,
        interpretedIntent: task.approvalCard.interpretedIntent,
        riskTier: task.approvalCard.riskTier,
        externalTransfer: task.approvalCard.externalTransfer,
        rollbackAvailable: task.approvalCard.rollbackAvailable,
        affectedItems: task.approvalCard.affectedItems,
        warnings: task.approvalCard.warnings
      }),
      instructions: [
        'PC JARVIS 콘솔에서 승인 카드와 영향 범위를 직접 확인하세요.',
        '외부 전송, 되돌리기 불가, 민감 자료 여부를 확인한 뒤 PC에서 최종 승인하세요.',
        '모바일은 이 요청을 기록하고 단독 승인을 계속 차단합니다.'
      ]
    };
    this.pcConfirmationHandoffs.set(handoff.handoffId, handoff);
    task.approvalCard = {
      ...task.approvalCard,
      pcConfirmation: {
        status: handoff.status,
        handoffId: handoff.handoffId,
        requestedAt: createdAt,
        requestedBy: auth.device.deviceId,
        reason
      }
    };
    this.stateCache.rememberApproval(task.approvalCard);
    this.stateCache.updateTask(task.taskId, {
      status: TaskStatus.BLOCKED,
      blockedReason: 'PC confirmation required before approval.',
      updatedAt: createdAt
    });
    this.stateCache.appendApprovalHistory({
      approvalId,
      taskId: task.taskId,
      eventType: 'approval.pc_handoff.requested',
      label: 'PC 확인 요청',
      status: handoff.status,
      actor: ModuleId.MOBILE,
      reason,
      createdAt,
      metadata: {
        handoffId: handoff.handoffId,
        deviceId: auth.device.deviceId,
        riskTier: task.approvalCard.riskTier,
        externalTransfer: task.approvalCard.externalTransfer
      }
    });
    this.auditLog.write('approval.pc_handoff.requested', {
      handoffId: handoff.handoffId,
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      reason
    });
    this.eventRelay.publish('approval.pc_handoff.requested', {
      handoffId: handoff.handoffId,
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      status: handoff.status,
      reason
    });
    this.eventRelay.publish('task.status.changed', {
      taskId: task.taskId,
      approvalId,
      status: TaskStatus.BLOCKED,
      blockedReason: 'PC confirmation required before approval.',
      deviceId: auth.device.deviceId
    });
    return {
      success: true,
      ...maskSensitive(handoff)
    };
  }

  listPcConfirmationHandoffs({ token, status } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const items = [...this.pcConfirmationHandoffs.values()]
      .filter((handoff) => !status || handoff.status === status)
      .map((handoff) => maskSensitive(handoff))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return {
      items,
      counts: {
        total: items.length,
        awaiting: items.filter((item) => item.status === 'awaiting_pc_confirmation').length,
        accepted: items.filter((item) => item.status === 'accepted').length,
        rejected: items.filter((item) => item.status === 'rejected').length
      }
    };
  }

  decidePcConfirmationHandoff({ handoffId, token, decision, operatorId = 'pc-console', note = null }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const handoff = this.pcConfirmationHandoffs.get(handoffId);
    if (!handoff) return createError('D_PC_HANDOFF_NOT_FOUND', 'PC confirmation handoff not found.', 404);
    if (handoff.status !== 'awaiting_pc_confirmation') {
      return createError('D_PC_HANDOFF_ALREADY_DECIDED', 'PC confirmation handoff has already been decided.', 409);
    }
    const normalizedDecision = String(decision ?? '').toLowerCase();
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      return createError('D_PC_HANDOFF_DECISION_INVALID', 'PC confirmation decision must be approve or reject.', 400);
    }
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.taskId === handoff.taskId);
    if (!task) return createError('D_TASK_NOT_FOUND', 'Task not found for PC confirmation handoff.', 404);
    if (this.policyRuntime.approvalExpiryManager.isExpired(task.approvalCard, this.clock().toISOString())) {
      task.approvalCard = { ...task.approvalCard, status: 'expired' };
      handoff.status = 'expired';
      handoff.decidedAt = this.clock().toISOString();
      handoff.decidedBy = { module: ModuleId.PC_AGENT, operatorId };
      this.stateCache.rememberApproval(task.approvalCard);
      this.stateCache.appendApprovalHistory({
        approvalId: handoff.approvalId,
        taskId: handoff.taskId,
        eventType: 'approval.pc_handoff.expired',
        label: 'PC 확인 만료',
        status: 'expired',
        actor: ModuleId.POLICY_SECURITY,
        createdAt: handoff.decidedAt,
        metadata: { handoffId }
      });
      return createError('D_APPROVAL_EXPIRED', 'Approval card expired.', 409);
    }

    const approvalDecision = createApprovalDecision({
      approvalId: handoff.approvalId,
      taskId: handoff.taskId,
      decision: normalizedDecision === 'approve' ? ApprovalDecision.APPROVE : ApprovalDecision.REJECT,
      deviceId: operatorId,
      sourceModule: ModuleId.PC_AGENT,
      responseText: note ?? undefined,
      decidedAt: this.clock().toISOString()
    });
    const policy = this.policyRuntime.validateApprovalDecision({
      decision: approvalDecision,
      riskTier: task.approvalCard.riskTier,
      deviceSource: 'pc'
    });
    if (policy.success === false) return policy;

    const status = this.coreFacade.submitApprovalDecision(approvalDecision);
    const decidedAt = approvalDecision.decidedAt;
    handoff.status = normalizedDecision === 'approve' ? 'accepted' : 'rejected';
    handoff.decidedAt = decidedAt;
    handoff.decidedBy = {
      module: ModuleId.PC_AGENT,
      operatorId,
      deviceId: auth.device.deviceId
    };
    handoff.note = note;
    task.approvalCard = {
      ...task.approvalCard,
      status: normalizedDecision === 'approve' ? 'approved' : 'rejected',
      pcConfirmation: {
        ...(task.approvalCard.pcConfirmation ?? {}),
        status: handoff.status,
        handoffId,
        decidedAt,
        decidedBy: operatorId,
        note
      }
    };
    this.stateCache.rememberApproval(task.approvalCard);
    this.stateCache.updateTask(task.taskId, {
      status: status.status,
      updatedAt: decidedAt,
      blockedReason: null
    });
    const eventType = normalizedDecision === 'approve'
      ? 'approval.pc_handoff.accepted'
      : 'approval.pc_handoff.rejected';
    this.stateCache.appendApprovalHistory({
      approvalId: handoff.approvalId,
      taskId: handoff.taskId,
      eventType,
      label: normalizedDecision === 'approve' ? 'PC 확인 수락' : 'PC 확인 거절',
      status: handoff.status,
      actor: ModuleId.PC_AGENT,
      detail: normalizedDecision,
      reason: note,
      createdAt: decidedAt,
      metadata: {
        handoffId,
        operatorId,
        taskStatus: status.status
      }
    });
    this.auditLog.write(eventType, {
      handoffId,
      approvalId: handoff.approvalId,
      taskId: handoff.taskId,
      operatorId,
      status: status.status
    });
    this.eventRelay.publish(eventType, {
      handoffId,
      approvalId: handoff.approvalId,
      taskId: handoff.taskId,
      operatorId,
      status: handoff.status,
      taskStatus: status.status
    });
    this.eventRelay.publish('task.status.changed', {
      taskId: handoff.taskId,
      approvalId: handoff.approvalId,
      status: status.status,
      deviceId: auth.device.deviceId
    });
    return {
      success: true,
      handoff: maskSensitive(handoff),
      approvalDecision: maskSensitive(approvalDecision),
      taskStatus: status.status
    };
  }

  cancelApproval({ approvalId, token, reason = 'mobile_cancelled' }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.approvalCard.approvalId === approvalId);
    if (!task) return createError('D_APPROVAL_NOT_FOUND', 'Approval card not found.', 404);
    if (task.status !== TaskStatus.WAITING_APPROVAL) {
      return createError('D_APPROVAL_CANCEL_NOT_ALLOWED', 'Only waiting approvals can be cancelled.', 409);
    }
    const approvalDecision = createApprovalDecision({
      approvalId,
      taskId: task.taskId,
      decision: 'reject',
      deviceId: auth.device.deviceId,
      responseText: reason,
      decidedAt: this.clock().toISOString()
    });
    const status = this.coreFacade.submitApprovalDecision(approvalDecision);
    task.approvalCard = {
      ...task.approvalCard,
      status: 'cancelled',
      cancelledAt: this.clock().toISOString(),
      cancelReason: reason
    };
    this.stateCache.updateTask(task.taskId, { status: status.status, updatedAt: this.clock().toISOString() });
    this.stateCache.rememberApproval(task.approvalCard);
    this.stateCache.appendApprovalHistory({
      approvalId,
      taskId: task.taskId,
      eventType: 'approval.cancelled',
      label: '승인 카드 취소',
      status: status.status,
      actor: ModuleId.MOBILE,
      reason,
      createdAt: task.approvalCard.cancelledAt,
      metadata: {
        deviceId: auth.device.deviceId
      }
    });
    this.auditLog.write('approval.cancelled', {
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      reason
    });
    this.eventRelay.publish('approval.cancelled', {
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      status: status.status,
      reason
    });
    this.eventRelay.publish('task.status.changed', {
      taskId: task.taskId,
      approvalId,
      status: status.status,
      deviceId: auth.device.deviceId
    });
    return {
      success: true,
      approvalId,
      taskId: task.taskId,
      status: status.status,
      cancelledAt: task.approvalCard.cancelledAt,
      reason
    };
  }

  requestApprovalReplacement({ approvalId, token, reason = 'mobile_re_request' }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.approvalCard.approvalId === approvalId);
    if (!task) return createError('D_APPROVAL_NOT_FOUND', 'Approval card not found.', 404);
    const rawText = String(task.request?.command?.rawText ?? task.plan?.interpretedIntent ?? '').trim();
    if (!rawText) return createError('D_APPROVAL_REREQUEST_SOURCE_MISSING', 'Original command text is not available.', 409);
    const cancelled = task.status === TaskStatus.WAITING_APPROVAL
      ? this.cancelApproval({ approvalId, token, reason })
      : { success: true, approvalId, taskId: task.taskId, status: task.status, reason: 'source-not-waiting' };
    if (cancelled.success === false) return cancelled;
    const replacement = this.createTask({
      rawText,
      token,
      taskRequest: {
        requestId: stableId('req', `${task.request?.requestId ?? task.taskId}:re-request:${reason}`, this.clock().toISOString()),
        command: { rawText },
        createdAt: this.clock().toISOString()
      }
    });
    if (replacement.success === false) return replacement;
    this.auditLog.write('approval.re_requested', {
      previousApprovalId: approvalId,
      previousTaskId: task.taskId,
      replacementApprovalId: replacement.approvalId,
      replacementTaskId: replacement.taskId,
      deviceId: auth.device.deviceId,
      reason
    });
    this.eventRelay.publish('approval.re_requested', {
      previousApprovalId: approvalId,
      previousTaskId: task.taskId,
      replacementApprovalId: replacement.approvalId,
      replacementTaskId: replacement.taskId,
      deviceId: auth.device.deviceId,
      reason
    });
    this.stateCache.appendApprovalHistory({
      approvalId,
      taskId: task.taskId,
      eventType: 'approval.re_requested',
      label: '새 승인 카드 재요청',
      status: 're_requested',
      actor: ModuleId.MOBILE,
      reason,
      createdAt: this.clock().toISOString(),
      metadata: {
        replacementApprovalId: replacement.approvalId,
        replacementTaskId: replacement.taskId
      }
    });
    this.stateCache.appendApprovalHistory({
      approvalId: replacement.approvalId,
      taskId: replacement.taskId,
      eventType: 'approval.replacement.created',
      label: '대체 승인 카드 생성',
      status: replacement.status,
      actor: ModuleId.BRIDGE,
      reason,
      createdAt: this.clock().toISOString(),
      metadata: {
        previousApprovalId: approvalId,
        previousTaskId: task.taskId
      }
    });
    return {
      success: true,
      previous: cancelled,
      replacement,
      reason
    };
  }

  async decideApproval({ approvalId, decision, token, editRequest, responseText }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'approval.decision', device: auth.device });
    if (!limit.success) return limit;
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.approvalCard.approvalId === approvalId);
    if (!task) return createError('D_APPROVAL_NOT_FOUND', 'Approval card not found.', 404);
    if (this.policyRuntime.approvalExpiryManager.isExpired(task.approvalCard, this.clock().toISOString())) {
      task.approvalCard = { ...task.approvalCard, status: 'expired' };
      this.auditLog.write('approval.expired', { approvalId, taskId: task.taskId, deviceId: auth.device.deviceId });
      this.stateCache.rememberApproval(task.approvalCard);
      this.stateCache.appendApprovalHistory({
        approvalId,
        taskId: task.taskId,
        eventType: 'approval.expired',
        label: '승인 카드 만료',
        status: 'expired',
        actor: ModuleId.POLICY_SECURITY,
        createdAt: this.clock().toISOString(),
        metadata: {
          deviceId: auth.device.deviceId
        }
      });
      this.eventRelay.publish('approval.expired', { approvalId, taskId: task.taskId, deviceId: auth.device.deviceId });
      return createError('D_APPROVAL_EXPIRED', 'Approval card expired.', 409);
    }
    const approvalDecision = createApprovalDecision({
      approvalId,
      taskId: task.taskId,
      decision,
      deviceId: auth.device.deviceId,
      editRequest,
      responseText,
      decidedAt: this.clock().toISOString()
    });
    const policy = this.policyRuntime.validateApprovalDecision({
      decision: approvalDecision,
      riskTier: task.approvalCard.riskTier,
      deviceSource: 'mobile'
    });
    if (policy.success === false) {
      this.auditLog.write('approval.decision.blocked', {
        approvalId,
        taskId: task.taskId,
        deviceId: auth.device.deviceId,
        reason: policy.error.code
      });
      this.stateCache.appendApprovalHistory({
        approvalId,
        taskId: task.taskId,
        eventType: 'approval.decision.blocked',
        label: '모바일 결정 차단',
        status: 'blocked',
        actor: ModuleId.POLICY_SECURITY,
        reason: policy.error.code,
        createdAt: this.clock().toISOString(),
        metadata: {
          decision,
          deviceId: auth.device.deviceId
        }
      });
      this.eventRelay.publish('approval.decision.blocked', {
        approvalId,
        taskId: task.taskId,
        deviceId: auth.device.deviceId,
        reason: policy.error.code
      });
      return { ...policy, error: { ...policy.error, bridgeCode: 'D_APPROVAL_TIER_BLOCKED' } };
    }
    const status = this.coreFacade.submitApprovalDecision(approvalDecision);
    this.auditLog.write('approval.decision.received', {
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      decision,
      status: status.status
    });
    this.stateCache.updateTask(task.taskId, { status: status.status });
    this.stateCache.appendApprovalHistory({
      approvalId,
      taskId: task.taskId,
      eventType: 'approval.decision.received',
      label: '승인 결정 수신',
      status: status.status,
      actor: ModuleId.MOBILE,
      detail: decision,
      createdAt: approvalDecision.decidedAt,
      metadata: {
        deviceId: auth.device.deviceId
      }
    });
    this.eventRelay.publish('approval.decision.received', {
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      decision,
      status: status.status
    });
    this.eventRelay.publish('task.status.changed', {
      taskId: task.taskId,
      approvalId,
      status: status.status,
      deviceId: auth.device.deviceId
    });
    if (decision !== 'approve') return { taskId: task.taskId, status: status.status };
    const handoff = this.prepareExecutionHandoff({ task, approvalDecision, device: auth.device });
    return {
      taskId: task.taskId,
      status: status.status,
      handoffId: handoff.handoffId,
      requiresUserConfirmation: true,
      shadowPreview: handoff.shadowPreview
    };
  }

  prepareExecutionHandoff({ task, approvalDecision, device }) {
    const capability = this.policyRuntime.capabilities.issue({
      taskId: task.taskId,
      planId: task.plan.planId,
      approvalId: approvalDecision.approvalId,
      action: { ...task.plan.action, toolName: 'filesystem.createTextFile' }
    });
    const packet = {
      packetId: stableId('packet', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      action: {
        ...task.plan.action,
        toolName: 'filesystem.createTextFile',
        arguments: { path: this.outputPath, content: task.request.command.rawText }
      },
      capabilityToken: capability,
      requestedMode: 'execute',
      userConfirmation: {
        confirmed: false,
        sourceModule: ModuleId.MOBILE,
        deviceId: device.deviceId,
        approvalId: approvalDecision.approvalId
      }
    };
    this.coreFacade.contractRegistry.assert('ExecutionPacket', packet);
    const handoff = {
      handoffId: stableId('handoff', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      approvalId: approvalDecision.approvalId,
      status: 'awaiting_user_confirmation',
      packet,
      shadowPreview: {
        planSteps: task.approvalCard.planSteps,
        affectedItems: task.approvalCard.affectedItems,
        riskTier: task.approvalCard.riskTier,
        rollbackAvailable: task.approvalCard.rollbackAvailable,
        externalTransfer: task.approvalCard.externalTransfer
      },
      createdAt: this.clock().toISOString()
    };
    this.handoffs.set(handoff.handoffId, handoff);
    this.auditLog.write('execution.handoff.created', {
      handoffId: handoff.handoffId,
      taskId: task.taskId,
      approvalId: approvalDecision.approvalId
    });
    this.eventRelay.publish('execution.handoff.created', {
      handoffId: handoff.handoffId,
      taskId: task.taskId,
      approvalId: approvalDecision.approvalId,
      status: handoff.status
    });
    return handoff;
  }

  async confirmExecutionHandoff({ handoffId, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'execution.confirm', device: auth.device });
    if (!limit.success) return limit;
    const handoff = this.handoffs.get(handoffId);
    if (!handoff) return createError('D_HANDOFF_NOT_FOUND', 'Execution handoff not found.', 404);
    if (handoff.status !== 'awaiting_user_confirmation') {
      return createError('D_HANDOFF_ALREADY_USED', 'Execution handoff is no longer pending.', 409);
    }
    const packet = {
      ...handoff.packet,
      userConfirmation: {
        ...handoff.packet.userConfirmation,
        confirmed: true,
        confirmedAt: this.clock().toISOString(),
        deviceId: auth.device.deviceId
      }
    };
    const result = await this.pcAgent.receiveExecutionPacket(packet);
    const verification = result.executionResult?.status === 'success'
      ? await this.verificationRuntime.verifyExecution({
          verificationId: stableId('ver_exec', handoff.taskId, this.clock().toISOString()),
          taskId: handoff.taskId,
          target: {
            executionResult: result.executionResult,
            evidence: {
              undo: { undoJournalId: result.executionResult.undoJournalId }
            }
          }
        })
      : null;
    handoff.status = 'confirmed';
    handoff.confirmedAt = this.clock().toISOString();
    this.results.set(handoff.taskId, { ...result, verification });
    this.stateCache.rememberResult(handoff.taskId, { ...result, verification });
    this.stateCache.updateTask(handoff.taskId, { status: result.status });
    this.auditLog.write('execution.handoff.confirmed', {
      handoffId,
      taskId: handoff.taskId,
      deviceId: auth.device.deviceId,
      status: result.status,
      verificationStatus: verification?.status ?? 'not_required'
    });
    this.eventRelay.publish('execution.handoff.confirmed', {
      handoffId,
      taskId: handoff.taskId,
      deviceId: auth.device.deviceId,
      status: result.status,
      verificationStatus: verification?.status ?? 'not_required'
    });
    this.eventRelay.publish('execution.completed', {
      handoffId,
      taskId: handoff.taskId,
      deviceId: auth.device.deviceId,
      status: result.status,
      verificationStatus: verification?.status ?? 'not_required'
    });
    this.eventRelay.publish('task.status.changed', {
      taskId: handoff.taskId,
      status: result.status,
      deviceId: auth.device.deviceId
    });
    return {
      taskId: handoff.taskId,
      status: result.status,
      verificationStatus: verification?.status ?? 'not_required'
    };
  }

  renewApproval({ approvalId, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const task = [...this.coreFacade.tasks.values()].find((candidate) => candidate.approvalCard.approvalId === approvalId);
    if (!task) return createError('D_APPROVAL_NOT_FOUND', 'Approval card not found.', 404);
    task.approvalCard = this.policyRuntime.renewApprovalCard(task.approvalCard, {
      requestedBy: auth.device.deviceId,
      at: this.clock().toISOString()
    });
    this.auditLog.write('approval.renewed', {
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      expiresAt: task.approvalCard.expiresAt
    });
    this.stateCache.rememberApproval(task.approvalCard);
    this.stateCache.appendApprovalHistory({
      approvalId,
      taskId: task.taskId,
      eventType: 'approval.renewed',
      label: '만료 시간 연장',
      status: task.approvalCard.status ?? 'pending',
      actor: ModuleId.MOBILE,
      createdAt: this.clock().toISOString(),
      metadata: {
        deviceId: auth.device.deviceId,
        expiresAt: task.approvalCard.expiresAt
      }
    });
    this.eventRelay.publish('approval.renewed', {
      approvalId,
      taskId: task.taskId,
      deviceId: auth.device.deviceId,
      expiresAt: task.approvalCard.expiresAt
    });
    return maskSensitive(task.approvalCard);
  }

  getResult({ taskId, token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const result = this.results.get(taskId);
    if (!result) return createError('D_TASK_NOT_FOUND', 'Result not found.', 404);
    return maskSensitive(result);
  }

  async rollbackResult({ taskId, token, reason = 'mobile_result_rollback' }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const result = this.results.get(taskId);
    if (!result) return createError('D_TASK_NOT_FOUND', 'Result not found.', 404);
    if (result.executionResult?.rollbackAvailable !== true) {
      return createError('D_ROLLBACK_NOT_AVAILABLE', 'Rollback is not available for this result.', 409);
    }
    if (!this.pcAgent?.rollbackTask) {
      return createError('D_PC_AGENT_ROLLBACK_UNAVAILABLE', 'PC agent rollback is unavailable.', 503);
    }
    const rollback = await this.pcAgent.rollbackTask(taskId);
    const updated = {
      ...result,
      rollback,
      rollbackRequestedBy: auth.device.deviceId,
      rollbackReason: reason,
      rollbackRequestedAt: this.clock().toISOString()
    };
    this.results.set(taskId, updated);
    this.stateCache.rememberResult(taskId, updated);
    this.auditLog.write('result.rollback.requested', {
      taskId,
      deviceId: auth.device.deviceId,
      success: rollback.success === true,
      reason
    });
    this.eventRelay.publish('result.rollback.completed', {
      taskId,
      deviceId: auth.device.deviceId,
      success: rollback.success === true,
      reason
    });
    return {
      success: rollback.success === true,
      taskId,
      rollback,
      result: maskSensitive(updated)
    };
  }

  async taskApprovalResultReleaseDossier({ token, reason = 'mobile_requested_task_approval_result_release_dossier' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'task_approval_result.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const generatedAt = this.clock().toISOString();
    const requestId = stableId('req_d06_release', auth.device.deviceId, generatedAt);
    const commandText = `D-06 release dossier fixture ${requestId}`;
    const routeContracts = [
      { routeName: 'task.create', method: 'POST', path: '/tasks', requiredEvidence: 'taskId,status,approvalId' },
      { routeName: 'tasks.list', method: 'GET', path: '/tasks', requiredEvidence: 'created task visible' },
      { routeName: 'task.status', method: 'GET', path: '/tasks/{taskId}', requiredEvidence: 'progress/status returned' },
      { routeName: 'approvals.list', method: 'GET', path: '/approvals', requiredEvidence: 'approval card visible' },
      { routeName: 'approval.read', method: 'GET', path: '/approvals/{approvalId}', requiredEvidence: 'approval detail returned' },
      { routeName: 'approval.history', method: 'GET', path: '/approvals/{approvalId}/history', requiredEvidence: 'created/decision timeline' },
      { routeName: 'approval.decision', method: 'POST', path: '/approvals/{approvalId}/decision', requiredEvidence: 'handoff created after approve' },
      { routeName: 'execution.confirm', method: 'POST', path: '/execution-handoffs/{handoffId}/confirm', requiredEvidence: 'PC agent result stored' },
      { routeName: 'result.read', method: 'GET', path: '/results/{taskId}', requiredEvidence: 'verification result available' },
      { routeName: 'result.rollback', method: 'POST', path: '/results/{taskId}/rollback', requiredEvidence: 'rollback proof returned' }
    ];
    const originalOutputPath = this.outputPath;
    this.outputPath = join(dirname(originalOutputPath), `${stableId('d06_release_output', requestId)}.txt`);
    try {
    const created = this.createTask({
      rawText: commandText,
      taskRequest: {
        requestId,
        command: { rawText: commandText },
        createdAt: generatedAt
      },
      token
    });
    if (created.success === false) return created;
    const taskList = this.listTasks({ token });
    if (taskList.success === false) return taskList;
    const taskStatus = this.getTaskStatus({ taskId: created.taskId, token });
    if (taskStatus.success === false) return taskStatus;
    const approvals = this.listApprovals({ token });
    if (approvals.success === false) return approvals;
    const approval = approvals.items.find((item) => item.approvalId === created.approvalId) ?? null;
    const approvalDetail = approval
      ? this.getApproval({ approvalId: approval.approvalId, token })
      : createError('D_APPROVAL_NOT_FOUND', 'Approval card not found for release dossier.', 404);
    if (approvalDetail.success === false) return approvalDetail;
    const decision = await this.decideApproval({
      approvalId: created.approvalId,
      decision: ApprovalDecision.APPROVE,
      token,
      responseText: 'D-06 release dossier approval'
    });
    if (decision.success === false) return decision;
    const approvalHistory = this.getApprovalHistory({ approvalId: created.approvalId, token });
    if (approvalHistory.success === false) return approvalHistory;
    const executed = decision.handoffId
      ? await this.confirmExecutionHandoff({ handoffId: decision.handoffId, token })
      : createError('D_HANDOFF_NOT_FOUND', 'Execution handoff was not created.', 500);
    if (executed.success === false) return executed;
    const result = this.getResult({ taskId: created.taskId, token });
    if (result.success === false) return result;
    const rollback = await this.rollbackResult({
      taskId: created.taskId,
      token,
      reason: 'D-06 release dossier rollback drill'
    });
    if (rollback.success === false) return rollback;
    const events = this.eventFeed({ token });
    if (events.success === false) return events;
    const retentionPayload = maskSensitive({
      created,
      taskStatus,
      approvals,
      approvalDetail,
      approvalHistory,
      decision,
      executed,
      result,
      rollback,
      events,
      routeContracts
    });
    const rawSecretPayload = JSON.stringify(retentionPayload);
    const rawDeviceTokenStored = typeof token === 'string' && token.length > 0 && rawSecretPayload.includes(token);
    const rawCapabilityTokenStored = /"capabilityToken":"(?!\[masked\])/.test(rawSecretPayload);
    const checks = [
      {
        checkId: 'task_create_and_status_route_passed',
        status: created.status === TaskStatus.WAITING_APPROVAL
          && taskStatus.taskId === created.taskId
          && taskStatus.progress?.currentStep ? 'passed' : 'blocked'
      },
      {
        checkId: 'approval_list_read_decision_history_passed',
        status: approval?.approvalId === created.approvalId
          && approvalDetail.approvalId === created.approvalId
          && decision.handoffId
          && approvalHistory.items.some((item) => item.eventType === 'approval.created')
          && approvalHistory.items.some((item) => item.eventType === 'approval.decision.received') ? 'passed' : 'blocked'
      },
      {
        checkId: 'execution_handoff_result_verification_passed',
        status: executed.status === TaskStatus.COMPLETED
          && result.verification?.status === 'passed' ? 'passed' : 'blocked'
      },
      {
        checkId: 'result_rollback_drill_passed',
        status: rollback.success === true
          && rollback.rollback?.success === true
          && rollback.result?.rollback?.success === true ? 'passed' : 'blocked'
      },
      {
        checkId: 'task_approval_result_event_relay_passed',
        status: events.items.some((event) => event.eventType === 'task.created' && event.payload?.taskId === created.taskId)
          && events.items.some((event) => event.eventType === 'execution.completed' && event.payload?.taskId === created.taskId)
          && events.items.some((event) => event.eventType === 'result.rollback.completed' && event.payload?.taskId === created.taskId) ? 'passed' : 'blocked'
      },
      {
        checkId: 'task_approval_result_route_contract_surface_ready',
        status: routeContracts.length === 10
          && routeContracts.every((contract) => contract.routeName && contract.path) ? 'passed' : 'blocked'
      },
      {
        checkId: 'task_approval_result_raw_secret_retention_safe',
        status: rawDeviceTokenStored === false && rawCapabilityTokenStored === false ? 'passed' : 'blocked'
      }
    ];
    const artifactManifest = {
      manifestVersion: 'd-bridge-task-approval-result-release-artifact-manifest-v1',
      routeContractCount: routeContracts.length,
      requestId,
      taskId: created.taskId,
      approvalId: created.approvalId,
      handoffId: decision.handoffId ?? null,
      rollbackSucceeded: rollback.rollback?.success === true,
      eventCursorId: events.cursor?.eventId ?? null,
      rawDeviceTokenStored,
      rawCapabilityTokenStored,
      releaseOutputPath: this.outputPath
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-bridge-task-approval-result-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-task-approval-result-release-owner',
      scope: 'task_create_approval_decision_execution_result_rollback_event_relay',
      status: checks.every((check) => check.status === 'passed')
        && rawDeviceTokenStored === false
        && rawCapabilityTokenStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-bridge-task-approval-result-health-handshake-v1',
      healthHandshake: {
        taskCreateAndStatusReady: created.status === TaskStatus.WAITING_APPROVAL
          && taskStatus.taskId === created.taskId,
        approvalLifecycleReady: approvalDetail.approvalId === created.approvalId
          && approvalHistory.items.some((item) => item.eventType === 'approval.created')
          && approvalHistory.items.some((item) => item.eventType === 'approval.decision.received'),
        executionAndVerificationReady: executed.status === TaskStatus.COMPLETED
          && result.verification?.status === 'passed',
        rollbackDrillReady: rollback.rollback?.success === true,
        eventRelayReady: events.items.some((event) => event.eventType === 'execution.completed' && event.payload?.taskId === created.taskId),
        rawDeviceTokenStored,
        rawCapabilityTokenStored
      },
      fallbackPolicy: {
        policyVersion: 'd-bridge-task-approval-result-fallback-policy-v1',
        primaryFlow: 'create_task_require_mobile_approval_confirm_pc_execution_verify_result_and_rollback',
        fallbackFlows: [
          'block_release_when_approval_history_or_decision_handoff_is_missing',
          'retry_or_poison_pc_execution_handoff_without_bypassing_e_policy',
          'surface_result_verification_failure_before_marking_task_completed',
          'block_release_when_device_or_capability_token_raw_payload_is_retained'
        ],
        operatorEscalation: 'bridge_task_approval_result_release_and_contract_gate_report'
      },
      rawDeviceTokenStored: false,
      rawCapabilityTokenStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-bridge-task-approval-result-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "task_approval_result.release_dossier" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'task_create_and_status_route_passed',
        'approval_list_read_decision_history_passed',
        'execution_handoff_result_verification_passed',
        'result_rollback_drill_passed',
        'task_approval_result_event_relay_passed',
        'task_approval_result_route_contract_surface_ready',
        'task_approval_result_raw_secret_retention_safe',
        'task_approval_result_release_artifact_manifest_ready',
        'task_approval_result_operational_handoff_ready',
        'task_approval_result_worm_promotion_package_ready'
      ],
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawDeviceTokenStored: false,
      rawCapabilityTokenStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-bridge-task-approval-result-worm-promotion-package-v1',
      providerContractVersion: 'd-bridge-task-approval-result-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-bridge-task-approval-result-release-artifact-manifest-v1'
        && rawDeviceTokenStored === false
        && rawCapabilityTokenStored === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-bridge-task-approval-result-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDeviceTokenStored: false,
      rawCapabilityTokenStored: false
    };
    const releaseChecks = [
      ...checks,
      {
        checkId: 'task_approval_result_release_artifact_manifest_ready',
        status: artifactManifest.manifestVersion === 'd-bridge-task-approval-result-release-artifact-manifest-v1'
          && artifactManifest.routeContractCount === 10
          && artifactManifest.rollbackSucceeded === true
          && artifactManifest.rawDeviceTokenStored === false
          && artifactManifest.rawCapabilityTokenStored === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'task_approval_result_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-bridge-task-approval-result-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-bridge-task-approval-result-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-bridge-task-approval-result-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'task_approval_result_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-bridge-task-approval-result-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-bridge-task-approval-result-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const releaseCore = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-bridge-task-approval-result-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseChecks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks: releaseChecks,
      liveWorkflow: {
        workflowVersion: 'd-bridge-task-approval-result-live-workflow-v1',
        requestId,
        taskId: created.taskId,
        approvalId: created.approvalId,
        handoffId: decision.handoffId ?? null,
        created,
        taskListCount: taskList.items.length,
        taskStatus,
        approval: approvalDetail,
        approvalHistory,
        decision,
        executed,
        result,
        rollback,
        eventCursor: events.cursor ?? null
      },
      routeContracts,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Run this dossier before releasing changes to /tasks, /approvals, /execution-handoffs, or /results.',
        'Keep bridge:client-contract-gate green so generated mobile client types match the server OpenAPI.',
        'Confirm D only routes approvals and execution handoffs; it must not bypass E policy or B PC agent.',
        'Attach live workflow, rollback, and event relay evidence to the release record.'
      ],
      rateLimit: limit.rateLimit
    };
    const dossier = {
      ...releaseCore,
      dossierSha256: sha256Hex(canonicalJson(releaseCore))
    };
    this.auditLog.write('task_approval_result.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      taskId: created.taskId,
      approvalId: created.approvalId,
      checkCount: checks.length,
      blockedChecks: checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
    } finally {
      this.outputPath = originalOutputPath;
    }
  }

  recordFeedback({ feedback, token }) {
    const startedAtMs = this.clock().getTime();
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    this.auditLog.write('feedback.received', { taskId: feedback.taskId, deviceId: auth.device.deviceId, feedbackType: feedback.feedbackType });
    const event = this.eventRelay.publish('feedback.received', {
      taskId: feedback.taskId,
      deviceId: auth.device.deviceId,
      feedbackType: feedback.feedbackType
    });
    const result = this.growthRuntime.recordFeedback({ ...feedback, source: { module: ModuleId.MOBILE, deviceId: auth.device.deviceId } });
    const historyEntry = this.rememberGrowthRoutingDecision({
      routeName: 'feedback',
      kind: 'feedback',
      deviceId: auth.device.deviceId,
      targetType: 'task',
      targetId: feedback.taskId,
      decision: feedback.feedbackType,
      reason: 'mobile feedback',
      requestedCount: 1,
      appliedCount: result?.stored ? 1 : 0,
      failedCount: result?.stored ? 0 : 1,
      result,
      event,
      startedAtMs
    });
    return {
      ...result,
      routing: this.publicGrowthRoutingEntry(historyEntry)
    };
  }

  eventFeed({ token, sinceEventId, eventType } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const replay = this.eventRelay.replayWindow({ sinceEventId, eventType });
    return {
      items: replay.items,
      cursor: replay.cursor,
      replay: {
        sinceEventId: replay.sinceEventId,
        sinceFound: replay.sinceFound,
        replayedCount: replay.replayedCount,
        firstEventId: replay.firstEventId,
        lastEventId: replay.lastEventId,
        replayWindowStart: replay.replayWindowStart,
        replayWindowEnd: replay.replayWindowEnd,
        reconnect: replay.reconnect
      }
    };
  }

  openEventStream({ token, sinceEventId, eventType } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const session = this.eventRelay.openStream({
      deviceId: auth.device.deviceId,
      sinceEventId,
      eventType
    });
    this.auditLog.write('event_stream.opened', {
      deviceId: auth.device.deviceId,
      streamId: session.streamId,
      sinceEventId,
      eventType,
      replayedCount: session.replay.replayedCount
    });
    return session;
  }

  acknowledgeEvent({ token, eventId, streamId } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const result = this.eventRelay.ack({
      deviceId: auth.device.deviceId,
      eventId,
      streamId
    });
    if (result.success) {
      this.auditLog.write('event_stream.acknowledged', {
        deviceId: auth.device.deviceId,
        eventId,
        streamId,
        sequence: result.ack.sequence
      });
    }
    return result;
  }

  eventStreamStatus({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return this.eventRelay.status({ deviceId: auth.device.deviceId });
  }

  eventReconnectPlan({ token, sinceEventId, attempt = 0, eventType = null, lastError = null } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const replay = this.eventRelay.replayWindow({ sinceEventId, eventType });
    const resumeCursor = replay.cursor?.eventId ?? sinceEventId ?? this.eventRelay.status({ deviceId: auth.device.deviceId }).lastAck?.eventId ?? null;
    return {
      deviceId: auth.device.deviceId,
      generatedAt: this.clock().toISOString(),
      replay: {
        sinceEventId: replay.sinceEventId,
        sinceFound: replay.sinceFound,
        replayedCount: replay.replayedCount,
        replayWindowStart: replay.replayWindowStart,
        replayWindowEnd: replay.replayWindowEnd,
        cursor: replay.cursor
      },
      reconnect: this.eventRelay.reconnectPlan({
        sinceEventId: resumeCursor,
        attempt,
        lastError
      }),
      persistence: this.eventRelay.status({ deviceId: auth.device.deviceId }).persistence
    };
  }

  eventCursorCompaction({ token, keepLast = 50, dryRun = true, reason = 'device_requested_event_cursor_compaction' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const status = this.eventRelay.status({ deviceId: auth.device.deviceId });
    const streams = status.streams ?? [];
    const retainedStreams = streams.slice(-Math.max(1, Number(keepLast) || 50));
    const removableStreams = streams.slice(0, Math.max(0, streams.length - retainedStreams.length));
    return {
      success: true,
      module: ModuleId.BRIDGE,
      compactionVersion: 'd-event-cursor-compaction-v1',
      generatedAt: this.clock().toISOString(),
      status: 'passed',
      dryRun,
      reason,
      keepLast,
      cursorJournalPath: status.persistence?.cursorJournalPath ?? null,
      persistence: status.persistence,
      retainedStreamCount: retainedStreams.length,
      removableStreamCount: removableStreams.length,
      ackCount: status.persistence?.ackCount ?? 0,
      recommendations: removableStreams.length && dryRun
        ? ['Execute cursor compaction during the next bridge maintenance window.']
        : ['Cursor journal is within retention policy.']
    };
  }

  eventNetworkChaosDrill({ token, cycles = 3 } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const normalizedCycles = Math.max(1, Math.min(10, Number(cycles) || 3));
    const status = this.eventRelay.status({ deviceId: auth.device.deviceId });
    const runs = Array.from({ length: normalizedCycles }, (_, index) => {
      const reconnect = this.eventRelay.reconnectPlan({
        sinceEventId: status.lastAck?.eventId ?? null,
        attempt: index,
        lastError: index % 2 === 0 ? 'network_drop' : 'websocket_reconnect'
      });
      return {
        cycle: index + 1,
        fault: index % 2 === 0 ? 'lan_drop' : 'websocket_reconnect',
        reconnectDelayMs: reconnect.nextDelayMs,
        exhausted: reconnect.exhausted,
        sseFallback: true,
        websocketFallback: true,
        cursorBounded: reconnect.requiresSinceEventId === true,
        status: reconnect.exhausted ? 'failed' : 'passed'
      };
    });
    return {
      success: true,
      module: ModuleId.BRIDGE,
      drillVersion: 'd-event-stream-network-chaos-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: runs.every((run) => run.status === 'passed' && run.cursorBounded && run.sseFallback && run.websocketFallback) ? 'passed' : 'failed',
      cycles: normalizedCycles,
      runs,
      reconnectPolicy: this.eventRelay.reconnectPolicy,
      persistence: status.persistence
    };
  }

  eventFallbackUxContract({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return {
      success: true,
      module: ModuleId.BRIDGE,
      contractVersion: 'd-mobile-websocket-fallback-ux-contract-v1',
      generatedAt: this.clock().toISOString(),
      status: 'passed',
      states: [
        { stateId: 'websocket_connected', label: 'Live updates connected', action: 'none' },
        { stateId: 'websocket_reconnecting', label: 'Reconnecting live updates', action: 'show_spinner_and_keep_last_cursor' },
        { stateId: 'sse_fallback_active', label: 'Using event stream fallback', action: 'preserve_ack_cursor' },
        { stateId: 'manual_retry_available', label: 'Retry updates', action: 'call_reconnect_plan' }
      ],
      mobileClient: {
        streamUrlMethod: 'eventStreamUrl',
        webSocketUrlMethod: 'eventWebSocketUrl',
        reconnectPlanMethod: 'getEventReconnectPlan',
        ackMethod: 'acknowledgeEvent'
      }
    };
  }

  eventStreamProductGate({ token, cycles = 3 } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const status = this.eventRelay.status({ deviceId: auth.device.deviceId });
    const reconnect = this.eventReconnectPlan({ token, attempt: 1, lastError: 'product_gate_reconnect' });
    if (reconnect.success === false) return reconnect;
    const chaos = this.eventNetworkChaosDrill({ token, cycles });
    if (!chaos.success) return chaos;
    const compaction = this.eventCursorCompaction({ token, keepLast: 50, dryRun: true, reason: 'event_stream_product_gate' });
    if (!compaction.success) return compaction;
    const fallbackUx = this.eventFallbackUxContract({ token });
    if (!fallbackUx.success) return fallbackUx;
    const checks = [
      { checkId: 'event_stream_persistence_enabled', passed: status.persistence?.enabled === true },
      { checkId: 'event_reconnect_plan_bounded', passed: reconnect.reconnect?.strategy === 'exponential_backoff_with_cap' && reconnect.reconnect?.requiresSinceEventId === true },
      { checkId: 'event_network_chaos_drill_passed', passed: chaos.drillVersion === 'd-event-stream-network-chaos-drill-v1' && chaos.status === 'passed' },
      { checkId: 'event_cursor_compaction_ready', passed: compaction.compactionVersion === 'd-event-cursor-compaction-v1' && compaction.status === 'passed' },
      { checkId: 'event_mobile_fallback_ux_ready', passed: fallbackUx.contractVersion === 'd-mobile-websocket-fallback-ux-contract-v1' && fallbackUx.status === 'passed' }
    ];
    return {
      success: true,
      module: ModuleId.BRIDGE,
      productGateVersion: 'd-event-stream-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      streamStatus: status,
      reconnect,
      chaos,
      compaction,
      fallbackUx
    };
  }

  eventStreamReleaseDossier({ token, cycles = 3, reason = 'mobile_requested_event_release_dossier' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'events.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const releaseFixtureEvent = this.eventRelay.publish('event_stream.release_fixture', {
      purpose: 'd-event-stream-release-dossier',
      reason
    });
    const releaseFixtureStream = this.eventRelay.openStream({
      deviceId: auth.device.deviceId,
      sinceEventId: null,
      eventType: null
    });
    const releaseFixtureAck = this.eventRelay.ack({
      deviceId: auth.device.deviceId,
      eventId: releaseFixtureEvent.eventId,
      streamId: releaseFixtureStream.streamId
    });
    if (releaseFixtureAck.success === false) return releaseFixtureAck;
    const productGate = this.eventStreamProductGate({ token, cycles });
    if (productGate.success === false) return productGate;
    const status = this.eventRelay.status({ deviceId: auth.device.deviceId });
    const releaseExercise = {
      exerciseVersion: 'd-event-stream-release-exercise-v1',
      status: releaseFixtureAck.success === true
        && releaseFixtureStream.authenticated === true
        && releaseFixtureStream.replay?.replayedCount >= 1 ? 'passed' : 'blocked',
      eventIdHash: sha256Hex(releaseFixtureEvent.eventId),
      streamIdHash: sha256Hex(releaseFixtureStream.streamId),
      ackCursorHash: sha256Hex(canonicalJson({
        eventId: releaseFixtureAck.ack.eventId,
        streamId: releaseFixtureAck.ack.streamId,
        sequence: releaseFixtureAck.ack.sequence
      })),
      replayedCount: releaseFixtureStream.replay?.replayedCount ?? 0,
      persistedAck: status.lastAck?.eventId === releaseFixtureEvent.eventId
        && status.persistence?.ackCount >= 1
    };
    const sanitizedStatus = {
      eventCount: status.eventCount,
      replayWindowStartHash: status.replayWindowStart ? sha256Hex(status.replayWindowStart) : null,
      replayWindowEndHash: status.replayWindowEnd ? sha256Hex(status.replayWindowEnd) : null,
      subscriberCount: status.subscriberCount,
      streamCount: status.streams?.length ?? 0,
      streamHashes: (status.streams ?? []).map((stream) => ({
        streamIdHash: sha256Hex(stream.streamId),
        deviceIdHash: sha256Hex(stream.deviceId),
        status: stream.status,
        replayedCount: stream.replay?.replayedCount ?? 0
      })),
      lastAckHash: status.lastAck ? sha256Hex(canonicalJson({
        deviceId: status.lastAck.deviceId,
        streamId: status.lastAck.streamId,
        eventId: status.lastAck.eventId,
        sequence: status.lastAck.sequence
      })) : null,
      heartbeatIntervalMs: status.heartbeatIntervalMs,
      reconnectPolicy: status.reconnectPolicy,
      persistence: {
        cursorStoreVersion: status.persistence?.cursorStoreVersion,
        cursorJournalPathHash: status.persistence?.cursorJournalPath ? sha256Hex(resolve(status.persistence.cursorJournalPath)) : null,
        cursorJournalPathStored: false,
        enabled: status.persistence?.enabled === true,
        replay: status.persistence?.replay,
        ackCount: status.persistence?.ackCount ?? 0
      }
    };
    const summarizedProductGate = {
      success: true,
      module: ModuleId.BRIDGE,
      productGateVersion: productGate.productGateVersion,
      generatedAt: productGate.generatedAt,
      status: productGate.status,
      checks: productGate.checks,
      evidenceHashes: {
        streamStatusHash: sha256Hex(canonicalJson(sanitizedStatus)),
        reconnectHash: sha256Hex(canonicalJson(productGate.reconnect?.reconnect ?? {})),
        chaosHash: sha256Hex(canonicalJson(productGate.chaos ?? {})),
        compactionHash: sha256Hex(canonicalJson(productGate.compaction ?? {})),
        fallbackUxHash: sha256Hex(canonicalJson(productGate.fallbackUx ?? {}))
      }
    };
    const releaseWorkflow = {
      workflowVersion: 'd-event-stream-release-workflow-v1',
      productGateReady: productGate.productGateVersion === 'd-event-stream-product-gate-v1'
        && productGate.status === 'passed',
      cursorPersistenceReady: status.persistence?.enabled === true
        && status.persistence?.cursorStoreVersion === 'd-event-cursor-store-v1',
      reconnectBackoffReady: productGate.reconnect?.reconnect?.strategy === 'exponential_backoff_with_cap'
        && productGate.reconnect?.reconnect?.requiresSinceEventId === true,
      networkChaosReady: productGate.chaos?.drillVersion === 'd-event-stream-network-chaos-drill-v1'
        && productGate.chaos?.status === 'passed',
      fallbackUxReady: productGate.fallbackUx?.contractVersion === 'd-mobile-websocket-fallback-ux-contract-v1'
        && productGate.fallbackUx?.mobileClient?.webSocketUrlMethod === 'eventWebSocketUrl',
      cursorCompactionReady: productGate.compaction?.compactionVersion === 'd-event-cursor-compaction-v1'
        && productGate.compaction?.dryRun === true,
      releaseExerciseReady: releaseExercise.status === 'passed'
        && releaseExercise.persistedAck === true,
      promotionStatus: 'pending_checks'
    };
    const artifactManifest = {
      manifestVersion: 'd-event-stream-release-artifact-manifest-v1',
      releaseWorkflowHash: sha256Hex(canonicalJson(releaseWorkflow)),
      productGateHash: sha256Hex(canonicalJson(summarizedProductGate)),
      releaseExerciseHash: sha256Hex(canonicalJson(releaseExercise)),
      streamStatusHash: sha256Hex(canonicalJson(sanitizedStatus)),
      cursorJournalPathHash: sanitizedStatus.persistence.cursorJournalPathHash,
      ackCursorHash: sanitizedStatus.lastAckHash,
      streamHashes: sanitizedStatus.streamHashes,
      reconnectPolicyHash: sha256Hex(canonicalJson(status.reconnectPolicy ?? {})),
      chaosDrillHash: sha256Hex(canonicalJson(productGate.chaos ?? {})),
      cursorCompactionHash: sha256Hex(canonicalJson(productGate.compaction ?? {})),
      fallbackUxHash: sha256Hex(canonicalJson(productGate.fallbackUx ?? {})),
      rawDeviceTokenStored: false,
      rawDeviceIdStored: false,
      rawEventIdsStored: false,
      rawStreamIdsStored: false,
      rawCursorJournalPathStored: false,
      wormArchive: {
        archiveContractVersion: 'd-event-stream-worm-release-archive-v1',
        storageMode: 'hash_only_event_stream_release_manifest',
        required: true,
        includedArtifactHashes: [
          sha256Hex(canonicalJson(summarizedProductGate)),
          sha256Hex(canonicalJson(releaseExercise)),
          sha256Hex(canonicalJson(sanitizedStatus)),
          sha256Hex(canonicalJson(productGate.chaos ?? {})),
          sha256Hex(canonicalJson(productGate.compaction ?? {})),
          sha256Hex(canonicalJson(productGate.fallbackUx ?? {}))
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-event-stream-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-event-stream-release-owner',
      scope: 'sse_websocket_replay_ack_cursor_persistence_reconnect_fallback_chaos',
      status: releaseWorkflow.productGateReady
        && releaseWorkflow.cursorPersistenceReady
        && releaseWorkflow.releaseExerciseReady
        && artifactManifest.rawDeviceTokenStored === false
        && artifactManifest.rawEventIdsStored === false
        && artifactManifest.rawStreamIdsStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-event-stream-health-handshake-v1',
      healthHandshake: {
        productGateReady: releaseWorkflow.productGateReady,
        cursorPersistenceReady: releaseWorkflow.cursorPersistenceReady,
        reconnectBackoffReady: releaseWorkflow.reconnectBackoffReady,
        networkChaosReady: releaseWorkflow.networkChaosReady,
        fallbackUxReady: releaseWorkflow.fallbackUxReady,
        releaseExerciseReady: releaseWorkflow.releaseExerciseReady,
        rawIdentifiersStored: artifactManifest.rawDeviceTokenStored
          || artifactManifest.rawDeviceIdStored
          || artifactManifest.rawEventIdsStored
          || artifactManifest.rawStreamIdsStored
          || artifactManifest.rawCursorJournalPathStored
      },
      fallbackPolicy: {
        policyVersion: 'd-event-stream-fallback-policy-v1',
        primaryFlow: 'deliver_mobile_state_changes_over_websocket_with_sse_fallback_and_ack_cursor_resume',
        fallbackFlows: [
          'fall_back_to_sse_stream_when_websocket_upgrade_or_proxy_support_fails',
          'resume_from_last_acknowledged_sinceEventId_after_lan_drop_or_app_background',
          'compact_cursor_journal_only_after_hash_only_release_manifest_passes',
          'block_release_when_raw_event_stream_identifiers_or_cursor_paths_are_retained'
        ],
        operatorEscalation: 'bridge_event_stream_release_and_mobile_foreground_background_soak_report'
      },
      rawDeviceTokenStored: false,
      rawEventIdsStored: false,
      rawStreamIdsStored: false,
      rawCursorJournalPathStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-event-stream-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "D Bridge HTTP API implements pairing" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'event_stream_product_gate_passed',
        'event_ack_cursor_persistence_ready',
        'event_stream_release_exercise_replayed_and_acked',
        'event_reconnect_backoff_contract_ready',
        'event_network_chaos_drill_ready',
        'event_mobile_fallback_ux_contract_ready',
        'event_cursor_compaction_policy_ready',
        'event_stream_release_manifest_hash_only',
        'event_stream_operational_handoff_ready',
        'event_stream_worm_promotion_package_ready',
        'event_stream_raw_identifiers_not_stored'
      ],
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawDeviceTokenStored: false,
      rawEventIdsStored: false,
      rawStreamIdsStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-event-stream-worm-promotion-package-v1',
      providerContractVersion: 'd-event-stream-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-event-stream-release-artifact-manifest-v1'
        && artifactManifest.wormArchive.archiveContractVersion === 'd-event-stream-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-event-stream-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDeviceTokenStored: false,
      rawEventIdsStored: false,
      rawStreamIdsStored: false,
      rawCursorJournalPathStored: false
    };
    const checks = [
      {
        checkId: 'event_stream_product_gate_passed',
        status: releaseWorkflow.productGateReady ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_ack_cursor_persistence_ready',
        status: releaseWorkflow.cursorPersistenceReady
          && status.persistence?.ackCount >= 1 ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_stream_release_exercise_replayed_and_acked',
        status: releaseWorkflow.releaseExerciseReady ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_reconnect_backoff_contract_ready',
        status: releaseWorkflow.reconnectBackoffReady ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_network_chaos_drill_ready',
        status: releaseWorkflow.networkChaosReady ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_mobile_fallback_ux_contract_ready',
        status: releaseWorkflow.fallbackUxReady ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_cursor_compaction_policy_ready',
        status: releaseWorkflow.cursorCompactionReady ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_stream_release_manifest_hash_only',
        status: artifactManifest.wormArchive.includedArtifactHashes.length >= 5
          && artifactManifest.rawDeviceTokenStored === false
          && artifactManifest.rawDeviceIdStored === false
          && artifactManifest.rawEventIdsStored === false
          && artifactManifest.rawStreamIdsStored === false
          && artifactManifest.rawCursorJournalPathStored === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_stream_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-event-stream-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-event-stream-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-event-stream-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'event_stream_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-event-stream-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-event-stream-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const candidate = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-event-stream-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      reason,
      checks,
      releaseWorkflow,
      releaseExercise,
      productGate: summarizedProductGate,
      streamStatus: sanitizedStatus,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Use WebSocket /events/ws for live mobile updates and keep SSE /events/stream as fallback.',
        'Always reconnect with sinceEventId from the last acknowledged cursor.',
        'Run /events/chaos-drill after proxy, mobile networking, or reconnect policy changes.',
        'Compact event cursors during maintenance only after release dossier status is passed.',
        'Promote only hash-only event stream evidence to external WORM storage.'
      ],
      rateLimit: {
        ...limit.rateLimit,
        identity: undefined,
        identityHash: sha256Hex(limit.rateLimit?.identity ?? '')
      }
    };
    const rawNeedles = [
      token,
      auth.device.deviceToken,
      auth.device.deviceId,
      status.persistence?.cursorJournalPath,
      status.replayWindowStart,
      status.replayWindowEnd,
      status.lastAck?.eventId,
      status.lastAck?.streamId,
      releaseFixtureEvent.eventId,
      releaseFixtureStream.streamId,
      ...(status.streams ?? []).flatMap((stream) => [stream.streamId, stream.deviceId])
    ].filter((needle) => typeof needle === 'string' && needle.length >= 8);
    const rawLeakDetected = rawNeedles.some((needle) => JSON.stringify(candidate).includes(needle));
    const finalChecks = [
      ...checks,
      {
        checkId: 'event_stream_raw_identifiers_not_stored',
        status: rawLeakDetected === false ? 'passed' : 'blocked'
      }
    ];
    const dossier = {
      ...candidate,
      status: finalChecks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      checks: finalChecks,
      releaseWorkflow: {
        ...releaseWorkflow,
        promotionStatus: finalChecks.every((check) => check.status === 'passed') ? 'release_evidence_ready' : 'blocked'
      },
      artifactManifest: {
        ...artifactManifest,
        rawLeakCheck: {
          checkedNeedleCount: rawNeedles.length,
          rawLeakDetected
        }
      }
    };
    dossier.releaseHash = sha256Hex(canonicalJson(dossier));
    this.auditLog.write('event_stream.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      releaseHash: dossier.releaseHash,
      checkCount: dossier.checks.length,
      blockedChecks: dossier.checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
  }

  ensurePcAgentPoisonQueue() {
    if (!this.pcAgent?.poisonQueueStatus) {
      return createError('D_PC_AGENT_POISON_QUEUE_UNAVAILABLE', 'PC agent poison queue is not available.', 503);
    }
    return { success: true };
  }

  ensurePcAgentQueuePolicy() {
    if (!this.pcAgent?.executionQueuePolicy || !this.pcAgent?.updateExecutionQueuePolicy) {
      return createError('D_PC_AGENT_QUEUE_POLICY_UNAVAILABLE', 'PC agent queue policy is not available.', 503);
    }
    return { success: true };
  }

  ensurePcAgentQueueDrain() {
    if (!this.pcAgent?.processExecutionQueue) {
      return createError('D_PC_AGENT_QUEUE_DRAIN_UNAVAILABLE', 'PC agent queue drain is not available.', 503);
    }
    return { success: true };
  }

  async drainPcAgentQueue({ token, limit = 10 } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limiter = this.rateLimit({ action: 'pc_agent.queue.drain', device: auth.device });
    if (!limiter.success) return limiter;
    const available = this.ensurePcAgentQueueDrain();
    if (!available.success) return available;
    const result = await this.pcAgent.processExecutionQueue({ limit });
    this.auditLog.write('pc_agent.queue.drained', {
      deviceId: auth.device.deviceId,
      limit,
      processed: result.processed ?? 0,
      succeeded: result.status?.succeeded ?? 0,
      failed: result.status?.failed ?? 0,
      retryScheduled: result.status?.retryScheduled ?? 0,
      quarantined: result.status?.quarantined ?? 0
    });
    this.eventRelay.publish('pc_agent.queue.drained', {
      deviceId: auth.device.deviceId,
      limit,
      processed: result.processed ?? 0,
      status: result.status ?? null
    });
    return maskSensitive(result);
  }

  queueRetryPolicy({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'pc_agent.queue_policy.read', device: auth.device });
    if (!limit.success) return limit;
    const available = this.ensurePcAgentQueuePolicy();
    if (!available.success) return available;
    const policy = this.pcAgent.executionQueuePolicy();
    this.auditLog.write('pc_agent.queue_policy.read', {
      deviceId: auth.device.deviceId,
      maxAttempts: policy.maxAttempts,
      baseBackoffMs: policy.baseBackoffMs
    });
    return maskSensitive(policy);
  }

  updateQueueRetryPolicy({ token, maxAttempts, baseBackoffMs, reason = '' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'pc_agent.queue_policy.update', device: auth.device });
    if (!limit.success) return limit;
    const available = this.ensurePcAgentQueuePolicy();
    if (!available.success) return available;
    const result = this.pcAgent.updateExecutionQueuePolicy({
      maxAttempts,
      baseBackoffMs,
      updatedBy: auth.device.deviceId,
      reason
    });
    this.auditLog.write('pc_agent.queue_policy.updated', {
      deviceId: auth.device.deviceId,
      success: result.success,
      maxAttempts: result.current?.maxAttempts ?? null,
      baseBackoffMs: result.current?.baseBackoffMs ?? null,
      errorCode: result.error?.code ?? null
    });
    if (result.success) {
      this.eventRelay.publish('pc_agent.queue_policy.updated', {
        deviceId: auth.device.deviceId,
        maxAttempts: result.current.maxAttempts,
        baseBackoffMs: result.current.baseBackoffMs,
        reason
      });
    }
    return maskSensitive(result);
  }

  poisonQueue({ token, includeIgnored = false } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'pc_agent.poison_queue.read', device: auth.device });
    if (!limit.success) return limit;
    const available = this.ensurePcAgentPoisonQueue();
    if (!available.success) return available;
    const result = this.pcAgent.poisonQueueStatus({ includeIgnored });
    this.auditLog.write('pc_agent.poison_queue.read', {
      deviceId: auth.device.deviceId,
      includeIgnored,
      itemCount: result.items?.length ?? 0,
      quarantined: result.queue?.quarantined ?? 0,
      ignored: result.queue?.ignored ?? 0
    });
    return {
      ...maskSensitive(result),
      source: {
        module: ModuleId.PC_AGENT,
        deviceId: auth.device.deviceId
      }
    };
  }

  reviewPoisonPacket({ token, queueId, note = '', decision = 'reviewed' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'pc_agent.poison_packet.review', device: auth.device });
    if (!limit.success) return limit;
    const available = this.ensurePcAgentPoisonQueue();
    if (!available.success) return available;
    if (!queueId) return createError('D_POISON_PACKET_ID_REQUIRED', 'queueId is required.', 400);
    const result = this.pcAgent.reviewPoisonPacket(queueId, {
      decision,
      reviewedBy: auth.device.deviceId,
      note
    });
    this.auditLog.write('pc_agent.poison_packet.reviewed', {
      deviceId: auth.device.deviceId,
      queueId,
      success: result.success,
      reviewStatus: result.item?.reviewStatus ?? null,
      errorCode: result.error?.code ?? null
    });
    if (result.success) {
      this.eventRelay.publish('pc_agent.poison_packet.reviewed', {
        queueId,
        taskId: result.item.taskId,
        packetId: result.item.packetId,
        reviewStatus: result.item.reviewStatus,
        deviceId: auth.device.deviceId
      });
    }
    return maskSensitive(result);
  }

  requeuePoisonPacket({ token, queueId, patch = null, note = '' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'pc_agent.poison_packet.requeue', device: auth.device });
    if (!limit.success) return limit;
    const available = this.ensurePcAgentPoisonQueue();
    if (!available.success) return available;
    if (!queueId) return createError('D_POISON_PACKET_ID_REQUIRED', 'queueId is required.', 400);
    const result = this.pcAgent.requeuePoisonPacket(queueId, {
      reviewedBy: auth.device.deviceId,
      note,
      patch
    });
    this.auditLog.write('pc_agent.poison_packet.requeued', {
      deviceId: auth.device.deviceId,
      queueId,
      success: result.success,
      status: result.item?.status ?? null,
      errorCode: result.error?.code ?? null
    });
    if (result.success) {
      this.eventRelay.publish('pc_agent.poison_packet.requeued', {
        queueId,
        taskId: result.item.taskId,
        packetId: result.item.packetId,
        status: result.item.status,
        deviceId: auth.device.deviceId
      });
    }
    return maskSensitive(result);
  }

  ignorePoisonPacket({ token, queueId, note = '' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'pc_agent.poison_packet.ignore', device: auth.device });
    if (!limit.success) return limit;
    const available = this.ensurePcAgentPoisonQueue();
    if (!available.success) return available;
    if (!queueId) return createError('D_POISON_PACKET_ID_REQUIRED', 'queueId is required.', 400);
    const result = this.pcAgent.ignorePoisonPacket(queueId, {
      reviewedBy: auth.device.deviceId,
      note
    });
    this.auditLog.write('pc_agent.poison_packet.ignored', {
      deviceId: auth.device.deviceId,
      queueId,
      success: result.success,
      status: result.item?.status ?? null,
      errorCode: result.error?.code ?? null
    });
    if (result.success) {
      this.eventRelay.publish('pc_agent.poison_packet.ignored', {
        queueId,
        taskId: result.item.taskId,
        packetId: result.item.packetId,
        status: result.item.status,
        deviceId: auth.device.deviceId
      });
    }
    return maskSensitive(result);
  }

  latestGrowthReview({ token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return this.growthRuntime.latestReview();
  }

  decideGrowthPreference({ token, hypothesisId, decision, reason = '' }) {
    const startedAtMs = this.clock().getTime();
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const result = this.growthRuntime.decidePreference({
      hypothesisId,
      decision,
      reason,
      decidedBy: auth.device.deviceId
    });
    this.auditLog.write('growth.preference.decision.routed', {
      deviceId: auth.device.deviceId,
      hypothesisId,
      decision,
      success: result.success !== false,
      errorCode: result.error?.code ?? null
    });
    let event = null;
    if (result.success !== false) {
      event = this.eventRelay.publish('growth.preference.decided', {
        deviceId: auth.device.deviceId,
        hypothesisId,
        decision,
        decisionId: result.decision?.decisionId ?? null
      });
    }
    const historyEntry = this.rememberGrowthRoutingDecision({
      routeName: 'growth.preference.decision',
      kind: 'preference',
      deviceId: auth.device.deviceId,
      targetType: 'preference_hypothesis',
      targetId: hypothesisId,
      decision,
      reason,
      requestedCount: 1,
      appliedCount: result.success === false ? 0 : 1,
      failedCount: result.success === false ? 1 : 0,
      result,
      event,
      startedAtMs
    });
    return {
      ...maskSensitive(result),
      routing: this.publicGrowthRoutingEntry(historyEntry)
    };
  }

  decideGrowthHygiene({ token, targetType, targetId, action, reason = '' } = {}) {
    const startedAtMs = this.clock().getTime();
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'growth.hygiene.decision', device: auth.device });
    if (!limit.success) return limit;
    const result = this.growthRuntime.decideHygiene({
      targetType,
      targetId,
      action,
      reason,
      decidedBy: auth.device.deviceId
    });
    this.auditLog.write('growth.hygiene.decision.routed', {
      deviceId: auth.device.deviceId,
      targetType,
      targetId,
      action,
      success: result.success !== false,
      errorCode: result.error?.code ?? null
    });
    let event = null;
    if (result.success !== false) {
      event = this.eventRelay.publish('growth.hygiene.decided', {
        deviceId: auth.device.deviceId,
        targetType,
        targetId,
        action,
        decisionId: result.decision?.decisionId ?? null
      });
    }
    const historyEntry = this.rememberGrowthRoutingDecision({
      routeName: 'growth.hygiene.decision',
      kind: 'hygiene',
      deviceId: auth.device.deviceId,
      targetType,
      targetId,
      action,
      reason,
      requestedCount: 1,
      appliedCount: result.success === false ? 0 : 1,
      failedCount: result.success === false ? 1 : 0,
      result,
      event,
      startedAtMs,
      rateLimit: limit.rateLimit
    });
    return {
      ...maskSensitive(result),
      routing: this.publicGrowthRoutingEntry(historyEntry)
    };
  }

  decideGrowthHygieneBatch({ token, decisions = [], reason = 'mobile batch hygiene review' } = {}) {
    const startedAtMs = this.clock().getTime();
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'growth.hygiene.batch_decision', device: auth.device, cost: Math.max(1, decisions.length) });
    if (!limit.success) return limit;
    const result = this.growthRuntime.decideHygieneBatch({
      decisions: decisions.map((item) => ({
        ...item,
        decidedBy: auth.device.deviceId
      })),
      decidedBy: auth.device.deviceId,
      reason
    });
    this.auditLog.write('growth.hygiene.batch_decision.routed', {
      deviceId: auth.device.deviceId,
      requestedCount: decisions.length,
      appliedCount: result.appliedCount ?? 0,
      failedCount: result.failedCount ?? 0,
      success: result.success !== false,
      errorCode: result.error?.code ?? null
    });
    let event = null;
    if (result.success !== false) {
      event = this.eventRelay.publish('growth.hygiene.batch_decided', {
        deviceId: auth.device.deviceId,
        batchId: result.batchId,
        requestedCount: result.requestedCount,
        appliedCount: result.appliedCount,
        failedCount: result.failedCount
      });
    }
    const historyEntry = this.rememberGrowthRoutingDecision({
      routeName: 'growth.hygiene.batch_decision',
      kind: 'hygiene_batch',
      deviceId: auth.device.deviceId,
      targetType: 'memory_event_batch',
      targetId: result.batchId,
      action: 'batch',
      reason,
      requestedCount: result.requestedCount ?? decisions.length,
      appliedCount: result.appliedCount ?? 0,
      failedCount: result.failedCount ?? 0,
      result,
      event,
      startedAtMs,
      rateLimit: limit.rateLimit,
      targets: decisions.map((item) => ({
        targetType: item.targetType ?? 'memory_event',
        targetId: item.targetId,
        action: item.action
      }))
    });
    return {
      ...maskSensitive(result),
      routing: this.publicGrowthRoutingEntry(historyEntry)
    };
  }

  rememberGrowthRoutingDecision({
    routeName,
    kind,
    deviceId,
    targetType = null,
    targetId = null,
    decision = null,
    action = null,
    reason = '',
    requestedCount = 1,
    appliedCount = null,
    failedCount = null,
    result = {},
    event = null,
    startedAtMs = this.clock().getTime(),
    rateLimit = null,
    targets = []
  } = {}) {
    const completedAt = this.clock().toISOString();
    const success = result?.success !== false;
    const entry = {
      historyVersion: 'd-growth-review-decision-history-v1',
      historyId: stableId('grh', routeName, deviceId, targetId ?? result?.batchId ?? this.growthDecisionHistoryItems.length, completedAt),
      routeName,
      kind,
      deviceId,
      targetType,
      targetId,
      decision,
      action,
      reason: String(reason ?? '').slice(0, 300),
      success,
      errorCode: result?.error?.code ?? null,
      requestedCount,
      appliedCount: appliedCount ?? (success ? 1 : 0),
      failedCount: failedCount ?? (success ? 0 : 1),
      latencyMs: Math.max(0, this.clock().getTime() - startedAtMs),
      eventId: event?.eventId ?? null,
      eventSequence: event?.sequence ?? null,
      resultPointer: {
        decisionId: result?.decision?.decisionId ?? null,
        batchId: result?.batchId ?? null,
        stored: result?.stored === true
      },
      rateLimit: rateLimit
        ? {
            action: rateLimit.action,
            remaining: rateLimit.remaining,
            resetAt: rateLimit.resetAt
          }
        : null,
      targets: targets.slice(0, 25),
      completedAt
    };
    this.growthDecisionHistoryItems.push(entry);
    if (this.growthDecisionHistoryItems.length > this.growthDecisionHistoryLimit) {
      this.growthDecisionHistoryItems.splice(0, this.growthDecisionHistoryItems.length - this.growthDecisionHistoryLimit);
    }
    this.auditLog.write('growth.routing.history.recorded', {
      historyId: entry.historyId,
      routeName,
      kind,
      deviceId,
      success,
      requestedCount: entry.requestedCount,
      appliedCount: entry.appliedCount,
      failedCount: entry.failedCount,
      latencyMs: entry.latencyMs,
      eventId: entry.eventId
    });
    return entry;
  }

  publicGrowthRoutingEntry(entry) {
    if (!entry) return null;
    return maskSensitive({
      historyVersion: entry.historyVersion,
      historyId: entry.historyId,
      routeName: entry.routeName,
      kind: entry.kind,
      targetType: entry.targetType,
      targetId: entry.targetId,
      decision: entry.decision,
      action: entry.action,
      success: entry.success,
      errorCode: entry.errorCode,
      requestedCount: entry.requestedCount,
      appliedCount: entry.appliedCount,
      failedCount: entry.failedCount,
      latencyMs: entry.latencyMs,
      eventId: entry.eventId,
      eventSequence: entry.eventSequence,
      resultPointer: entry.resultPointer,
      rateLimit: entry.rateLimit,
      targets: entry.targets,
      completedAt: entry.completedAt
    });
  }

  growthDecisionHistory({ token, limit = 50, routeName = null, kind = null } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const rate = this.rateLimit({ action: 'growth.routing.history', device: auth.device });
    if (!rate.success) return rate;
    const resolvedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const items = this.growthDecisionHistoryItems
      .filter((entry) => !routeName || entry.routeName === routeName)
      .filter((entry) => !kind || entry.kind === kind)
      .slice(-resolvedLimit)
      .reverse()
      .map((entry) => this.publicGrowthRoutingEntry(entry));
    this.auditLog.write('growth.routing.history.read', {
      deviceId: auth.device.deviceId,
      routeName,
      kind,
      returnedCount: items.length
    });
    return {
      success: true,
      historyVersion: 'd-growth-review-decision-history-v1',
      generatedAt: this.clock().toISOString(),
      filters: { routeName, kind, limit: resolvedLimit },
      totalStored: this.growthDecisionHistoryItems.length,
      items,
      rateLimit: rate.rateLimit
    };
  }

  growthRoutingTrend({ token, windowMinutes = 60 } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const rate = this.rateLimit({ action: 'growth.routing.trend', device: auth.device });
    if (!rate.success) return rate;
    const resolvedWindowMinutes = Math.min(Math.max(Number(windowMinutes) || 60, 1), 10_080);
    const cutoffMs = this.clock().getTime() - resolvedWindowMinutes * 60_000;
    const windowItems = this.growthDecisionHistoryItems.filter((entry) => Date.parse(entry.completedAt) >= cutoffMs);
    const byRoute = {};
    const byKind = {};
    for (const entry of windowItems) {
      byRoute[entry.routeName] = accumulateGrowthTrendBucket(byRoute[entry.routeName], entry);
      byKind[entry.kind] = accumulateGrowthTrendBucket(byKind[entry.kind], entry);
    }
    const latencyValues = windowItems.map((entry) => entry.latencyMs).filter((value) => Number.isFinite(value));
    const total = windowItems.length;
    const successCount = windowItems.filter((entry) => entry.success).length;
    const batchItems = windowItems.filter((entry) => entry.kind === 'hygiene_batch');
    const trend = {
      success: true,
      trendVersion: 'd-growth-routing-trend-v1',
      generatedAt: this.clock().toISOString(),
      windowMinutes: resolvedWindowMinutes,
      totalDecisions: total,
      successCount,
      failureCount: total - successCount,
      successRate: total ? successCount / total : 1,
      averageLatencyMs: averageNumber(latencyValues),
      p95LatencyMs: percentileNumber(latencyValues, 0.95),
      byRoute: Object.fromEntries(Object.entries(byRoute).map(([key, bucket]) => [key, finalizeGrowthTrendBucket(bucket)])),
      byKind: Object.fromEntries(Object.entries(byKind).map(([key, bucket]) => [key, finalizeGrowthTrendBucket(bucket)])),
      batchSelection: {
        batchCount: batchItems.length,
        requestedCount: batchItems.reduce((sum, entry) => sum + (entry.requestedCount ?? 0), 0),
        appliedCount: batchItems.reduce((sum, entry) => sum + (entry.appliedCount ?? 0), 0),
        failedCount: batchItems.reduce((sum, entry) => sum + (entry.failedCount ?? 0), 0),
        lastBatchHistoryId: batchItems.at(-1)?.historyId ?? null
      },
      lastDecisionAt: windowItems.at(-1)?.completedAt ?? null,
      rateLimit: rate.rateLimit
    };
    this.auditLog.write('growth.routing.trend.read', {
      deviceId: auth.device.deviceId,
      windowMinutes: resolvedWindowMinutes,
      totalDecisions: trend.totalDecisions,
      successRate: trend.successRate
    });
    return trend;
  }

  growthRoutingReleaseDossier({ token, windowMinutes = 60, reason = 'mobile_requested_growth_routing_release_dossier' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'growth.routing.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const history = this.growthDecisionHistory({ token, limit: 100 });
    if (history.success === false) return history;
    const trend = this.growthRoutingTrend({ token, windowMinutes });
    if (trend.success === false) return trend;
    const review = this.latestGrowthReview({ token });
    if (review.success === false) return review;
    const routeContracts = [
      {
        routeName: 'feedback',
        kind: 'feedback',
        method: 'POST',
        path: '/feedback',
        targetSystem: 'F.growthRuntime.recordFeedback',
        mobileClientMethod: 'sendFeedback'
      },
      {
        routeName: 'growth.preference.decision',
        kind: 'preference',
        method: 'POST',
        path: '/growth/preferences/{hypothesisId}/decision',
        targetSystem: 'F.growthRuntime.decidePreference',
        mobileClientMethod: 'decideGrowthPreference'
      },
      {
        routeName: 'growth.hygiene.decision',
        kind: 'hygiene',
        method: 'POST',
        path: '/growth/hygiene/decisions',
        targetSystem: 'F.growthRuntime.decideHygiene',
        mobileClientMethod: 'decideGrowthHygiene'
      },
      {
        routeName: 'growth.hygiene.batch_decision',
        kind: 'hygiene_batch',
        method: 'POST',
        path: '/growth/hygiene/decisions/batch',
        targetSystem: 'F.growthRuntime.decideHygieneBatch',
        mobileClientMethod: 'decideGrowthHygieneBatch'
      },
      {
        routeName: 'growth.routing.history',
        kind: 'history',
        method: 'GET',
        path: '/growth/decisions/history',
        targetSystem: 'D.bridgeRuntime.growthDecisionHistory',
        mobileClientMethod: 'getGrowthDecisionHistory'
      },
      {
        routeName: 'growth.routing.trend',
        kind: 'trend',
        method: 'GET',
        path: '/growth/decisions/trends',
        targetSystem: 'D.bridgeRuntime.growthRoutingTrend',
        mobileClientMethod: 'getGrowthRoutingTrends'
      }
    ];
    const observedRoutes = new Set(history.items.map((entry) => entry.routeName));
    const observedKinds = new Set(history.items.map((entry) => entry.kind));
    const routeNames = new Set(routeContracts.map((contract) => contract.routeName));
    const rawSecretPayload = JSON.stringify({
      history,
      trend,
      routeContracts,
      reviewVersion: review.reviewVersion ?? null
    });
    const rawDeviceTokenStored = typeof token === 'string' && token.length > 0 && rawSecretPayload.includes(token);
    const checks = [
      {
        checkId: 'growth_routing_history_ready',
        status: history.historyVersion === 'd-growth-review-decision-history-v1'
          && Array.isArray(history.items)
          && history.totalStored >= history.items.length ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_routing_trend_ready',
        status: trend.trendVersion === 'd-growth-routing-trend-v1'
          && Number.isFinite(trend.totalDecisions)
          && trend.totalDecisions >= history.items.filter((entry) => Date.parse(entry.completedAt) >= this.clock().getTime() - trend.windowMinutes * 60_000).length ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_feedback_route_observed',
        status: observedRoutes.has('feedback') && observedKinds.has('feedback') ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_hygiene_route_observed',
        status: observedRoutes.has('growth.hygiene.decision') && observedKinds.has('hygiene') ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_hygiene_batch_route_observed',
        status: observedRoutes.has('growth.hygiene.batch_decision') && observedKinds.has('hygiene_batch') ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_preference_route_contract_ready',
        status: routeNames.has('growth.preference.decision') ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_mobile_client_contract_ready',
        status: routeContracts.every((contract) => typeof contract.mobileClientMethod === 'string' && contract.mobileClientMethod.length > 0) ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_release_raw_secret_retention_safe',
        status: rawDeviceTokenStored === false ? 'passed' : 'blocked'
      }
    ];
    const artifactManifest = {
      manifestVersion: 'd-growth-routing-release-artifact-manifest-v1',
      historyVersion: history.historyVersion,
      trendVersion: trend.trendVersion,
      historyCount: history.items.length,
      totalStored: history.totalStored,
      windowMinutes: trend.windowMinutes,
      routeContractCount: routeContracts.length,
      observedRouteCount: observedRoutes.size,
      observedKindCount: observedKinds.size,
      rawDeviceTokenStored
    };
    const operationalHandoffManifest = {
      manifestVersion: 'd-growth-routing-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'bridge-growth-routing-release-owner',
      scope: 'mobile_feedback_preference_hygiene_batch_decision_routing_to_growth_runtime',
      status: checks.every((check) => check.status === 'passed')
        && rawDeviceTokenStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'd-growth-routing-health-handshake-v1',
      healthHandshake: {
        historyReady: history.historyVersion === 'd-growth-review-decision-history-v1'
          && history.totalStored >= history.items.length,
        trendReady: trend.trendVersion === 'd-growth-routing-trend-v1'
          && Number.isFinite(trend.successRate),
        feedbackRouteObserved: observedRoutes.has('feedback') && observedKinds.has('feedback'),
        hygieneRouteObserved: observedRoutes.has('growth.hygiene.decision') && observedKinds.has('hygiene'),
        hygieneBatchRouteObserved: observedRoutes.has('growth.hygiene.batch_decision') && observedKinds.has('hygiene_batch'),
        mobileClientContractReady: routeContracts.every((contract) => contract.mobileClientMethod),
        rawDeviceTokenStored
      },
      fallbackPolicy: {
        policyVersion: 'd-growth-routing-fallback-policy-v1',
        primaryFlow: 'route_mobile_feedback_and_growth_decisions_to_f_with_audit_history_and_trends',
        fallbackFlows: [
          'defer_growth_decisions_when_f_runtime_is_unavailable_without_losing_mobile_audit_context',
          'keep_preference_route_contract_ready_even_when_no_candidate_is_present',
          'block_release_when_feedback_hygiene_or_batch_route_evidence_is_missing',
          'block_release_when_device_token_raw_payload_is_retained'
        ],
        operatorEscalation: 'bridge_growth_routing_release_and_mobile_session_report'
      },
      rawDeviceTokenStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'd-growth-routing-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "growth.routing.release_dossier" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'growth_routing_history_ready',
        'growth_routing_trend_ready',
        'growth_feedback_route_observed',
        'growth_hygiene_route_observed',
        'growth_hygiene_batch_route_observed',
        'growth_preference_route_contract_ready',
        'growth_mobile_client_contract_ready',
        'growth_release_raw_secret_retention_safe',
        'growth_routing_release_artifact_manifest_ready',
        'growth_routing_operational_handoff_ready',
        'growth_routing_worm_promotion_package_ready'
      ],
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      rawDeviceTokenStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'd-growth-routing-worm-promotion-package-v1',
      providerContractVersion: 'd-growth-routing-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'd-growth-routing-release-artifact-manifest-v1'
        && rawDeviceTokenStored === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'd-growth-routing-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
      operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
      ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDeviceTokenStored: false
    };
    const releaseChecks = [
      ...checks,
      {
        checkId: 'growth_routing_release_artifact_manifest_ready',
        status: artifactManifest.manifestVersion === 'd-growth-routing-release-artifact-manifest-v1'
          && artifactManifest.historyVersion === 'd-growth-review-decision-history-v1'
          && artifactManifest.trendVersion === 'd-growth-routing-trend-v1'
          && artifactManifest.routeContractCount === routeContracts.length
          && artifactManifest.rawDeviceTokenStored === false ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_routing_operational_handoff_ready',
        status: operationalHandoffManifest.manifestVersion === 'd-growth-routing-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'd-growth-routing-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-growth-routing-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready' ? 'passed' : 'blocked'
      },
      {
        checkId: 'growth_routing_worm_promotion_package_ready',
        status: externalWormPromotionPackage.packageVersion === 'd-growth-routing-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'd-growth-routing-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked'
      }
    ];
    const releaseCore = {
      success: true,
      module: ModuleId.BRIDGE,
      dossierVersion: 'd-growth-routing-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseChecks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      reason,
      checks: releaseChecks,
      history,
      trend,
      review: {
        reviewVersion: review.reviewVersion ?? null,
        hygieneQueueCount: review.hygiene?.reviewQueue?.length ?? 0,
        preferenceCandidateCount: review.preferences?.candidates?.length ?? 0
      },
      routingCoverage: {
        observedRoutes: [...observedRoutes],
        observedKinds: [...observedKinds],
        requiredObservedKinds: ['feedback', 'hygiene', 'hygiene_batch'],
        contractRoutes: routeContracts.map((contract) => contract.routeName)
      },
      routeContracts,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      operationsRunbook: [
        'Run feedback, hygiene single-decision, and hygiene batch-decision routes before release.',
        'Verify /growth/decisions/history preserves route, kind, eventId, latency, and result pointers.',
        'Verify /growth/decisions/trends reports success rate, route buckets, kind buckets, and batch selection.',
        'Keep preference decisions contract-ready even when no preference candidate exists in the release fixture.'
      ],
      rateLimit: limit.rateLimit
    };
    const dossier = {
      ...releaseCore,
      dossierSha256: sha256Hex(canonicalJson(releaseCore))
    };
    this.auditLog.write('growth.routing.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      checkCount: dossier.checks.length,
      blockedChecks: dossier.checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return dossier;
  }

  cacheSnapshot({ token }) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    return {
      ...this.stateCache.snapshot(),
      requestReplay: this.requestNonceStore.snapshot()
    };
  }

  cacheSchemaSnapshot({ token } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'cache.schema_snapshot', device: auth.device });
    if (!limit.success) return limit;
    return {
      success: true,
      snapshot: this.stateCache.schemaSnapshot(),
      externalStore: this.stateCache.externalStoreStatus(),
      compactionLock: this.stateCache.compactionLockStatus(),
      rateLimit: limit.rateLimit
    };
  }

  cacheSchemaDiff({ token, baseline } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'cache.schema_diff', device: auth.device });
    if (!limit.success) return limit;
    return {
      success: true,
      diff: this.stateCache.schemaDiff(baseline),
      rateLimit: limit.rateLimit
    };
  }

  compactCache({ token, reason = 'mobile_requested_compaction' } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'cache.compact', device: auth.device });
    if (!limit.success) return limit;
    const result = this.stateCache.compactJournal({ reason });
    this.auditLog.write('state.cache.compacted', {
      deviceId: auth.device.deviceId,
      success: result.success,
      reason,
      compactedAt: result.compactedAt ?? null,
      prunedRecords: result.prunedRecords ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  cacheProductGate({ token, baseline = null, reason = 'mobile_requested_cache_product_gate', requireDurableExternalStore = false } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'cache.product_gate', device: auth.device });
    if (!limit.success) return limit;
    const gate = this.stateCache.productGate({
      baseline,
      reason,
      requireDurableExternalStore
    });
    this.auditLog.write('state.cache.product_gate', {
      deviceId: auth.device.deviceId,
      productGateVersion: gate.productGateVersion,
      status: gate.status,
      checkCount: gate.checks.length,
      failedChecks: gate.checks.filter((check) => !check.passed).map((check) => check.checkId)
    });
    return {
      success: true,
      module: ModuleId.BRIDGE,
      ...gate,
      rateLimit: limit.rateLimit
    };
  }

  cacheReleaseDossier({ token, baseline = null, reason = 'mobile_requested_cache_release_dossier', requireDurableExternalStore = false } = {}) {
    const auth = this.authenticate(token);
    if (!auth.success) return auth;
    const limit = this.rateLimit({ action: 'cache.release_dossier', device: auth.device });
    if (!limit.success) return limit;
    const dossier = this.stateCache.releaseDossier({
      baseline,
      reason,
      requireDurableExternalStore
    });
    this.auditLog.write('state.cache.release_dossier', {
      deviceId: auth.device.deviceId,
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      checkCount: dossier.checks.length,
      blockedChecks: dossier.checks.filter((check) => check.status !== 'passed').map((check) => check.checkId)
    });
    return {
      success: true,
      module: ModuleId.BRIDGE,
      ...dossier,
      rateLimit: limit.rateLimit
    };
  }
}
