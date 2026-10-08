import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeStrictIsoInstant } from '../../../shared/src/strict-iso-instant.js';

export const CoreAdminScope = Object.freeze({
  READ_DIAGNOSTICS: 'core:diagnostics:read',
  READ_SELECTED_SOURCE: 'core:selected-source:read',
  CONTROL_WORKER_DAEMON: 'core:worker-daemon:control',
  MANAGE_RUNTIME_TRUST: 'core:runtime-trust:manage',
  MANAGE_INTEGRATION_HANDOFFS: 'core:integrations:handoff',
  AUTHORIZE_GROWTH_SKILL_REVIEW: 'core:growth-skills:review-authorize',
  AUTHORIZE_CAPABILITY_PACKAGE_REVIEW: 'core:capability-packages:review-authorize',
  MANAGE_CAPABILITY_PACKAGES: 'core:capability-packages:manage',
  ADMIN: 'core:admin'
});

export class CoreAdminAuthProvider {
  constructor({
    tokens = [],
    tokenHashes = [],
    clock = () => new Date()
  } = {}) {
    this.clock = clock;
    this.records = [
      ...tokens.filter(Boolean).map((record) => this.normalizeTokenRecord(record)),
      ...tokenHashes.filter(Boolean).map((record) => this.normalizeHashRecord(record))
    ];
    this.audit = [];
  }

  verifyBearer(token, {
    requiredScope = CoreAdminScope.ADMIN,
    requiredSource,
    route = 'unknown',
    method = 'UNKNOWN'
  } = {}) {
    const checkedAt = this.clock().toISOString();
    if (!token) {
      return this.recordAudit({
        allowed: false,
        reason: 'missing-bearer-token',
        error: { code: 'A_ADMIN_TOKEN_REQUIRED', message: 'Admin bearer token is required.' },
        requiredScope,
        route,
        method,
        checkedAt
      });
    }
    const tokenHash = sha256(token);
    const matched = this.records.find((record) => secureEqual(record.tokenHash, tokenHash));
    if (!matched) {
      return this.recordAudit({
        allowed: false,
        reason: 'invalid-bearer-token',
        error: { code: 'A_ADMIN_TOKEN_INVALID', message: 'Admin bearer token is invalid.' },
        requiredScope,
        route,
        method,
        tokenHashPreview: previewHash(tokenHash),
        checkedAt
      });
    }
    if (!this.hasScope(matched, requiredScope)) {
      return this.recordAudit({
        allowed: false,
        reason: 'scope-denied',
        error: { code: 'A_ADMIN_SCOPE_DENIED', message: `Admin token is missing required scope: ${requiredScope}` },
        requiredScope,
        route,
        method,
        tokenId: matched.tokenId,
        role: matched.role,
        tokenHashPreview: previewHash(tokenHash),
        checkedAt
      });
    }
    // A dedicated worker credential is both time- and resource-bounded. The
    // route first authenticates transport, then binds the parsed request before
    // and after SQL observation. Existing explicit administrators retain access.
    if (requiredScope === CoreAdminScope.READ_SELECTED_SOURCE
      && !matched.scopes.includes('*') && !matched.scopes.includes(CoreAdminScope.ADMIN)) {
      const bindings = matched.selectedSourceBindings;
      const valid = matched.expiresAt && Date.parse(checkedAt) < Date.parse(matched.expiresAt)
        && bindings?.length > 0
        && (requiredSource === undefined || bindings.some(binding =>
          binding.provider === requiredSource?.provider && binding.streamRef === requiredSource?.streamRef));
      if (!valid) return this.recordAudit({
        allowed: false, reason: 'selected-source-boundary-denied',
        error: { code: 'A_ADMIN_SOURCE_SCOPE_DENIED', message: 'Selected source credential is expired or outside its resource boundary.' },
        requiredScope, route, method, tokenId: matched.tokenId, role: matched.role, checkedAt
      });
    }
    return this.recordAudit({
      allowed: true,
      reason: 'authorized',
      requiredScope,
      route,
      method,
      tokenId: matched.tokenId,
      role: matched.role,
      tokenHashPreview: previewHash(tokenHash),
      checkedAt
    });
  }

  hasScope(record, requiredScope) {
    return record.scopes.includes('*')
      || record.scopes.includes(CoreAdminScope.ADMIN)
      || record.scopes.includes(requiredScope);
  }

  status() {
    return {
      authVersion: 'a-core-admin-auth-v1',
      configuredTokenCount: this.records.length,
      roles: [...new Set(this.records.map((record) => record.role))].sort(),
      scopes: [...new Set(this.records.flatMap((record) => record.scopes))].sort(),
      tokenRecords: this.records.map((record) => ({
        tokenId: record.tokenId,
        role: record.role,
        scopes: record.scopes,
        tokenHashPreview: previewHash(record.tokenHash)
      })),
      recentAudit: this.audit.slice(0, 20)
    };
  }

  recordAudit(entry) {
    const record = {
      authEventVersion: 'a-core-admin-auth-event-v1',
      ...entry
    };
    this.audit.unshift(record);
    this.audit = this.audit.slice(0, 100);
    return record;
  }

  normalizeTokenRecord(record) {
    const token = typeof record === 'string' ? record : record.token;
    if (!token) {
      throw new Error('CoreAdminAuthProvider token records require token.');
    }
    return this.normalizeHashRecord({
      ...record,
      tokenHash: sha256(token),
      tokenId: record.tokenId ?? `core_admin_${sha256(token).slice(0, 12)}`
    });
  }

  normalizeHashRecord(record) {
    const tokenHash = typeof record === 'string' ? record : record.tokenHash;
    if (!tokenHash) {
      throw new Error('CoreAdminAuthProvider hash records require tokenHash.');
    }
    return {
      tokenId: record.tokenId ?? `core_admin_${String(tokenHash).slice(0, 12)}`,
      role: record.role ?? 'admin',
      scopes: normalizeScopes(record.scopes),
      selectedSourceBindings: normalizeSourceBindings(record.selectedSourceBindings),
      expiresAt: normalizeStrictIsoInstant(record.expiresAt),
      tokenHash: String(tokenHash).replace(/^sha256:/, '')
    };
  }
}

function normalizeSourceBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 256) return null;
  if (bindings.some(binding => !binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).length !== 2 || !Object.hasOwn(binding, 'provider') || !Object.hasOwn(binding, 'streamRef')
    || !['gmail', 'google-calendar', 'outlook', 'teams-chat'].includes(binding.provider)
    || typeof binding.streamRef !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.streamRef))) return null;
  return bindings.map(({ provider, streamRef }) => ({ provider, streamRef }));
}

export function createCoreAdminAuthProvider(options = {}) {
  const envTokenHash = normalizeSha256Hash(process.env.JARVIS_CORE_ADMIN_TOKEN_SHA256);
  const {
    adminToken = process.env.JARVIS_CORE_ADMIN_TOKEN
      ?? (envTokenHash ? null : process.env.JARVIS_TEST_MODE === '1' ? 'local-core-admin' : null),
    adminTokenHash = envTokenHash,
    adminTokens = [],
    adminTokenHashes = [],
    clock = () => new Date()
  } = options;
  const normalizedAdminTokenHash = normalizeSha256Hash(adminTokenHash);
  const tokens = [
    adminToken ? {
      token: adminToken,
      tokenId: 'local-core-admin',
      role: 'admin',
      scopes: ['*']
    } : null,
    ...adminTokens
  ].filter(Boolean);
  const tokenHashes = [normalizedAdminTokenHash ? {
    tokenHash: normalizedAdminTokenHash,
    tokenId: 'env-core-admin-hash',
    role: 'admin',
    scopes: ['*']
  } : null, ...adminTokenHashes].filter(Boolean);
  return new CoreAdminAuthProvider({ tokens, tokenHashes, clock });
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return [];
  return [...new Set(scopes.filter((scope) => (
    typeof scope === 'string'
    && scope.length > 0
    && scope === scope.trim()
  )))].sort();
}

function normalizeSha256Hash(value) {
  const normalized = String(value ?? '').replace(/^sha256:/, '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'hex');
  const rightBuffer = Buffer.from(String(right), 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function previewHash(hash) {
  return `sha256:${String(hash).slice(0, 12)}...`;
}
