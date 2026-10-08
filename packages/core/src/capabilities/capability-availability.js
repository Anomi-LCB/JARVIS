import { createHash } from 'node:crypto';

const levels = ['unverified', 'synthetic', 'sandbox', 'live-probe', 'live-execution', 'repeated-live'];
const accountStates = ['not-required', 'unknown', 'connected', 'expired', 'revoked', 'missing'];
const deviceStates = ['not-required', 'unknown', 'online', 'offline'];
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const defaultFreshnessMs = 60_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function reference(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !referencePattern.test(value)) fail('A_AVAILABILITY_REFERENCE_INVALID');
  return value;
}

function scopes(value = []) {
  if (!Array.isArray(value) || value.length > 200 || value.some(item =>
    typeof item !== 'string' || !item || item.length > 200 || /[\s\u0000-\u001f?#]/u.test(item))) {
    fail('A_AVAILABILITY_SCOPE_INVALID');
  }
  return [...new Set(value)].sort();
}

function identity(input) {
  return {
    capabilityId: reference(input?.capabilityId),
    providerId: reference(input?.providerId),
    accountRef: reference(input?.accountRef, { optional: true }),
    deviceRef: reference(input?.deviceRef, { optional: true }),
    scopes: scopes(input?.scopes)
  };
}

function keyOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function instant(value, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('A_AVAILABILITY_TIME_INVALID');
  return new Date(value).toISOString();
}

function permissionKey(value) {
  // Revocation of an account applies across its capabilities and scope subsets.
  return keyOf([value.providerId, value.accountRef]);
}

function deviceKey(value) {
  return keyOf([value.providerId, value.deviceRef]);
}

/** Prerequisite observations only. This registry never issues an execution grant. */
export class CapabilityAvailabilityRegistry {
  #records = new Map();
  #permissions = new Map();
  #devices = new Map();

  constructor({ clock = () => new Date(), freshnessMs = defaultFreshnessMs } = {}) {
    if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) fail('A_AVAILABILITY_FRESHNESS_INVALID');
    this.clock = clock;
    this.freshnessMs = freshnessMs;
  }

  recordObservation(input) {
    const binding = identity(input);
    const observedAt = instant(input.observedAt);
    const now = this.clock().getTime();
    if (Date.parse(observedAt) > now) fail('A_AVAILABILITY_FUTURE_OBSERVATION');
    const accountStatus = input.accountStatus ?? (binding.accountRef ? 'unknown' : 'not-required');
    const deviceStatus = input.deviceStatus ?? (binding.deviceRef ? 'unknown' : 'not-required');
    const verificationLevel = input.verificationLevel ?? 'unverified';
    if (!accountStates.includes(accountStatus) || !deviceStates.includes(deviceStatus)
      || !levels.includes(verificationLevel)) fail('A_AVAILABILITY_STATE_INVALID');
    if ((binding.accountRef && accountStatus === 'not-required')
      || (!binding.accountRef && accountStatus !== 'not-required')
      || (binding.deviceRef && deviceStatus === 'not-required')
      || (!binding.deviceRef && deviceStatus !== 'not-required')) fail('A_AVAILABILITY_BINDING_INVALID');
    const ttlMs = input.freshnessMs ?? this.freshnessMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > this.freshnessMs) fail('A_AVAILABILITY_FRESHNESS_INVALID');
    const record = {
      ...binding,
      codeVersion: reference(input.codeVersion),
      permissionRevision: reference(input.permissionRevision, { optional: true }),
      observedAt,
      expiresAt: instant(input.expiresAt, true),
      freshUntil: new Date(Date.parse(observedAt) + ttlMs).toISOString(),
      accountStatus,
      deviceStatus,
      observedAccountRef: reference(input.observedAccountRef, { optional: true }),
      observedDeviceRef: reference(input.observedDeviceRef, { optional: true }),
      grantedScopes: scopes(input.grantedScopes),
      verificationLevel,
      evidenceRef: reference(input.evidenceRef, { optional: true }),
      source: input.source === 'connection-metadata' ? 'connection-metadata' : 'trusted-probe'
    };
    if (levels.indexOf(verificationLevel) >= levels.indexOf('live-probe') && !record.evidenceRef) {
      fail('A_AVAILABILITY_EVIDENCE_REQUIRED');
    }
    const key = keyOf(binding);
    const preceding = [this.#records.get(key), binding.accountRef && this.#permissions.get(permissionKey(binding)),
      binding.deviceRef && this.#devices.get(deviceKey(binding))].filter(Boolean);
    if (preceding.some(item => Date.parse(item.observedAt) > Date.parse(observedAt))) {
      fail('A_AVAILABILITY_OLDER_OBSERVATION');
    }
    if (preceding.some(item => item.observedAt === observedAt && (
      (binding.accountRef && item.accountRef === binding.accountRef && (
        item.permissionRevision !== record.permissionRevision || item.accountStatus !== record.accountStatus
        || item.observedAccountRef !== record.observedAccountRef || JSON.stringify(item.grantedScopes) !== JSON.stringify(record.grantedScopes)))
      || (binding.deviceRef && item.deviceRef === binding.deviceRef && (
        item.deviceStatus !== record.deviceStatus || item.observedDeviceRef !== record.observedDeviceRef))))) {
      fail('A_AVAILABILITY_CONFLICTING_OBSERVATION');
    }
    // Construct a closed projection: provider error text, labels and credentials are never retained.
    this.#records.set(key, record);
    if (binding.accountRef) this.#permissions.set(permissionKey(binding), record);
    if (binding.deviceRef) this.#devices.set(deviceKey(binding), record);
    return this.evaluate(binding, { codeVersion: record.codeVersion });
  }
  forgetObservation(input,{expectedEvidenceRef}={}){
    const binding=identity(input),expected=reference(expectedEvidenceRef),key=keyOf(binding);
    const record=this.#records.get(key);
    if(!record||record.evidenceRef!==expected)return false;
    // Remove only this observer's exact receipt. Never fabricate a provider revocation
    // or overwrite a newer observation recorded by another source.
    return this.#records.delete(key);
  }

  /** Reuses IntegrationCredentialVault.list() and IntegrationConnectorRegistry.get().
   * Stored credentials show configuration, never a live API verification.
   */
  recordConnection({ capabilityId, providerId, connection = null, connectorRegistry, codeVersion, observedAt }) {
    const connector = connectorRegistry?.get(providerId);
    const capability = connector?.capabilities.find(item => item.id === capabilityId);
    if (!capability) fail('A_AVAILABILITY_CONNECTOR_CAPABILITY_UNKNOWN');
    if (connection && connection.connectorId !== providerId) fail('A_AVAILABILITY_PROVIDER_MISMATCH');
    if (!connection) fail('A_AVAILABILITY_CONNECTION_REQUIRED');
    return this.recordObservation({
      capabilityId, providerId, accountRef: connection.connectionId,
      scopes: capability.scopes ?? [], codeVersion, observedAt,
      permissionRevision: connection.updatedAt ? `connection:${Date.parse(instant(connection.updatedAt))}` : null,
      expiresAt: connection.expiresAt,
      grantedScopes: connection.scopes,
      accountStatus: ['connected', 'expired', 'revoked', 'missing'].includes(connection.status) ? connection.status : 'unknown',
      verificationLevel: 'unverified', source: 'connection-metadata'
    });
  }

  evaluate(input, { codeReady = true, codeVersion = null, permissionRevision = null, minimumVerification = 'live-probe' } = {}) {
    const binding = identity(input);
    if (!['live-probe', 'live-execution', 'repeated-live'].includes(minimumVerification)
      || typeof codeReady !== 'boolean') fail('A_AVAILABILITY_STATE_INVALID');
    const record = this.#records.get(keyOf(binding));
    const reasons = [];
    const add = (code, nextAction) => reasons.push({ code, nextAction });
    const now = this.clock().getTime();
    const permission = binding.accountRef ? this.#permissions.get(permissionKey(binding)) : null;
    const device = binding.deviceRef ? this.#devices.get(deviceKey(binding)) : null;
    if (!codeReady) add('code-not-ready', '도구 구현과 실행 어댑터를 준비하세요.');
    if (!record) {
      const sameCapability = [...this.#records.values()].filter(item => item.capabilityId === binding.capabilityId && item.providerId === binding.providerId);
      if (sameCapability.some(item => item.accountRef !== binding.accountRef)) add('account-not-observed', '요청한 계정으로 연결 상태를 확인하세요.');
      else if (sameCapability.some(item => item.deviceRef !== binding.deviceRef)) add('device-not-observed', '요청한 기기에서 연결 상태를 확인하세요.');
      else add('availability-not-observed', '이 기능과 권한 범위의 준비 상태를 확인하세요.');
    } else {
      if (codeVersion && record.codeVersion !== codeVersion) add('code-version-changed', '현재 도구 버전으로 연결 상태를 다시 확인하세요.');
      if (Date.parse(record.freshUntil) <= now) add('observation-stale', '연결 상태를 새로 확인하세요.');
      if (record.expiresAt && Date.parse(record.expiresAt) <= now) add('connection-expired', '공식 인증 화면에서 연결을 갱신하세요.');
      if (binding.accountRef) {
        if (permission?.accountStatus !== 'connected') add(`account-${permission?.accountStatus ?? 'unknown'}`, '요청한 계정의 공식 연결을 확인하세요.');
        if (permission?.expiresAt && Date.parse(permission.expiresAt) <= now && !reasons.some(item => item.code === 'connection-expired')) add('connection-expired', '공식 인증 화면에서 연결을 갱신하세요.');
        if (!record.permissionRevision || (permissionRevision && permissionRevision !== record.permissionRevision)
          || permission?.permissionRevision !== record.permissionRevision) add('permission-revision-changed', '현재 권한으로 해당 기능의 상태를 다시 확인하세요.');
        if (record.observedAccountRef !== binding.accountRef || permission?.observedAccountRef !== binding.accountRef) add('account-identity-unverified', '연결된 계정이 요청한 계정인지 읽기 검사로 확인하세요.');
        if (binding.scopes.some(scope => !permission?.grantedScopes.includes(scope))) add('scope-not-granted', '필요한 권한만 공식 인증 화면에서 연결하세요.');
      }
      if (binding.deviceRef) {
        if (device?.deviceStatus !== 'online') add(`device-${device?.deviceStatus ?? 'unknown'}`, '요청한 기기의 연결과 전원을 확인하세요.');
        if (record.observedDeviceRef !== binding.deviceRef || device?.observedDeviceRef !== binding.deviceRef) add('device-identity-unverified', '연결된 기기가 요청한 기기인지 확인하세요.');
      }
      if (levels.indexOf(record.verificationLevel) < levels.indexOf(minimumVerification)) {
        add('execution-unverified', '이 연결에서 허용된 읽기 또는 격리 검사를 실행하세요.');
      }
    }
    return {
      availabilityVersion: 'a-capability-availability-v1', key: keyOf(binding), ...binding,
      available: reasons.length === 0,
      status: reasons.length === 0 ? 'available' : !record ? 'unknown' : reasons.every(item => ['execution-unverified', 'account-identity-unverified', 'device-identity-unverified'].includes(item.code)) ? 'unverified' : 'blocked',
      codeReady: codeReady === true,
      codeVersion: codeVersion ?? record?.codeVersion ?? null,
      observedCodeVersion: record?.codeVersion ?? null,
      permissionRevision: permission?.permissionRevision ?? record?.permissionRevision ?? null,
      observedAt: record?.observedAt ?? null,
      evaluatedAt: new Date(now).toISOString(),
      freshness: !record ? 'unknown' : Date.parse(record.freshUntil) <= now ? 'stale' : 'fresh',
      freshUntil: record?.freshUntil ?? null,
      expiresAt: permission?.expiresAt ?? record?.expiresAt ?? null,
      accountStatus: binding.accountRef && (permission?.expiresAt ?? record?.expiresAt)
        && Date.parse(permission?.expiresAt ?? record?.expiresAt) <= now
        && (permission?.accountStatus ?? record?.accountStatus) === 'connected'
        ? 'expired' : permission?.accountStatus ?? record?.accountStatus ?? (binding.accountRef ? 'unknown' : 'not-required'),
      deviceStatus: device?.deviceStatus ?? record?.deviceStatus ?? (binding.deviceRef ? 'unknown' : 'not-required'),
      verificationLevel: record?.verificationLevel ?? 'unverified',
      observationSource: record?.source ?? null,
      evidenceRef: record?.evidenceRef ?? null,
      reasons,
      nextAction: reasons[0]?.nextAction ?? null,
      executionAuthorized: false,
      requiresPolicyCheck: true
    };
  }

  status({ codeContext = () => ({}) } = {}) {
    const items = [...this.#records.values()].map(record => this.evaluate(record, codeContext(record.capabilityId)))
      .sort((a, b) => a.key.localeCompare(b.key));
    return {
      availabilityVersion: 'a-capability-availability-registry-v1',
      observationCount: items.length,
      liveAvailableCount: items.filter(item => item.available && levels.indexOf(item.verificationLevel) >= levels.indexOf('live-probe')).length,
      liveExecutionVerifiedCount: items.filter(item => item.available && levels.indexOf(item.verificationLevel) >= levels.indexOf('live-execution')).length,
      availableMeaning: 'fresh-prerequisites-only-not-execution-authorization',
      items
    };
  }
}
