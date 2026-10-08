import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  hardenWindowsSecretFile,
  protectWithWindowsDpapi,
  unprotectWithWindowsDpapi
} from '../../../shared/src/product-runtime-secrets.js';

const vaultVersion = 1;
const providerName = 'windows-dpapi-current-user';
const idPattern = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const allowedCredentialFields = new Set([
  'accessToken', 'refreshToken', 'clientId', 'clientSecret', 'tenantId', 'apiKey', 'subjectToken', 'deviceRefreshToken',
  'ap2CheckoutMandate', 'ap2PaymentMandate', 'ap2OpenCheckoutMandate', 'ap2OpenPaymentMandate', 'ap2AgentKey'
]);
const allowedRiskTiers = new Set(['read', 'write', 'external-action', 'financial', 'physical-control']);

export const integrationCredentialPath = (env = process.env) => {
  const configured = env.JARVIS_CORE_INTEGRATION_VAULT;
  if (configured) {
    const expanded = configured.replace(/%([^%]+)%/gu, (match, name) => env[name] ?? match);
    if (/%[^%]+%/u.test(expanded)) {
      const error = new Error('The configured integration vault path contains an unresolved environment variable.');
      error.code = 'A_INTEGRATION_VAULT_PATH_ENV_UNRESOLVED';
      throw error;
    }
    return resolve(expanded);
  }
  return join(env.LOCALAPPDATA || join(homedir(), '.jarvis'), 'JARVIS', 'integrations', 'credentials.dpapi.json');
};

/** Registry entries are trusted, bundled adapter declarations, never user-loaded executable code. */
export class IntegrationConnectorRegistry {
  #connectors = new Map();

  register(definition) {
    const id = definition?.id;
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('A_INTEGRATION_ID_INVALID');
    if (this.#connectors.has(id)) throw new Error('A_INTEGRATION_ALREADY_REGISTERED');
    if (!Array.isArray(definition.authMethods) || !definition.authMethods.length
      || definition.authMethods.some(value => !['oauth2', 'oidc', 'device-pairing', 'os-broker', 'api-key'].includes(value))) {
      throw new Error('A_INTEGRATION_AUTH_METHOD_INVALID');
    }
    if (!Array.isArray(definition.scopes) || definition.scopes.some(scope => typeof scope !== 'string' || scope.length > 200)) {
      throw new Error('A_INTEGRATION_SCOPES_INVALID');
    }
    const credentialSchemaDeclared = Object.hasOwn(definition, 'credentialFields')
      || Object.hasOwn(definition, 'requiredCredentialFields');
    const credentialFields = definition.credentialFields;
    const requiredCredentialFields = definition.requiredCredentialFields ?? [];
    if (credentialSchemaDeclared && (!Array.isArray(credentialFields) || !credentialFields.length
      || credentialFields.some(field => !allowedCredentialFields.has(field))
      || !Array.isArray(requiredCredentialFields)
      || requiredCredentialFields.some(field => !credentialFields.includes(field)))) {
      throw new Error('A_INTEGRATION_CREDENTIAL_SCHEMA_INVALID');
    }
    if (!Array.isArray(definition.capabilities) || definition.capabilities.some(capability =>
      !capability || typeof capability.id !== 'string' || !idPattern.test(capability.id)
      || !allowedRiskTiers.has(capability.riskTier))) throw new Error('A_INTEGRATION_CAPABILITIES_INVALID');
    this.#connectors.set(id, Object.freeze({
      id,
      displayName: String(definition.displayName ?? id).slice(0, 100),
      category: String(definition.category ?? 'other').slice(0, 64),
      authMethods: [...new Set(definition.authMethods)],
      scopes: [...new Set(definition.scopes)],
      ...(credentialFields ? {
        credentialFields: [...new Set(credentialFields)],
        requiredCredentialFields: [...new Set(requiredCredentialFields)]
      } : {}),
      capabilities: definition.capabilities.map(capability => Object.freeze({ ...capability })),
      adapter: definition.adapter
    }));
    return this.describe(id);
  }

  get(id) { return this.#connectors.get(id) ?? null; }

  describe(id) {
    const item = this.get(id);
    if (!item) return null;
    return {
      id: item.id,
      displayName: item.displayName,
      category: item.category,
      authMethods: [...item.authMethods],
      scopes: [...item.scopes],
      capabilities: item.capabilities.map(({ id: capabilityId, riskTier }) => ({ id: capabilityId, riskTier }))
    };
  }

  list() { return [...this.#connectors.keys()].map(id => this.describe(id)); }

  authorize({ connectorId, grantedScopes = [], capabilityId, providerAuthorized = false, jarvisAuthorized = false }) {
    const connector = this.get(connectorId);
    if (!connector) return { allowed: false, reason: 'connector-unavailable' };
    const capability = connector.capabilities.find(item => item.id === capabilityId);
    if (!capability) return { allowed: false, reason: 'capability-unavailable' };
    if (!providerAuthorized || !jarvisAuthorized) return { allowed: false, reason: 'authorization-required' };
    if (grantedScopes.some(scope => !connector.scopes.includes(scope))) return { allowed: false, reason: 'scope-not-registered' };
    if (capability.scopes?.some(scope => !grantedScopes.includes(scope))) return { allowed: false, reason: 'scope-not-granted' };
    return { allowed: true, riskTier: capability.riskTier, requiresFreshApproval: capability.riskTier !== 'read' };
  }
}

/** Returns a safe error code when a connector-specific credential contract is violated. */
export function integrationCredentialSchemaError(connector, credentials) {
  if (!connector?.credentialFields) return null;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return 'A_INTEGRATION_CREDENTIAL_FIELDS_INVALID';
  }
  const keys = Object.keys(credentials);
  if (keys.some(key => !connector.credentialFields.includes(key))
    || connector.requiredCredentialFields?.some(key => typeof credentials[key] !== 'string' || !credentials[key])) {
    return 'A_INTEGRATION_CREDENTIAL_FIELDS_INVALID';
  }
  return null;
}

/**
 * Provider credentials are encrypted as one per-Windows-user vault. There is intentionally no API
 * that lists or returns secrets; callers use them only inside a scoped callback.
 */
export class IntegrationCredentialVault {
  #metadataCache = null;
  constructor({
    path = integrationCredentialPath(),
    storageLocation = process.env.JARVIS_CORE_INTEGRATION_VAULT ? 'configured-service-data-directory' : 'per-user-app-data',
    platform = process.platform,
    protect = protectWithWindowsDpapi,
    unprotect = unprotectWithWindowsDpapi,
    harden = hardenWindowsSecretFile,
    randomBytesImpl = randomBytes,
    clock = () => new Date()
  } = {}) {
    this.path = path;
    this.storageLocation = storageLocation;
    this.platform = platform;
    this.protect = protect;
    this.unprotect = unprotect;
    this.harden = harden;
    this.randomBytes = randomBytesImpl;
    this.clock = clock;
  }

  status() {
    const filePresent = this.platform === 'win32' && existsSync(this.path);
    return {
      configured: filePresent,
      state: this.platform !== 'win32' ? 'unsupported' : filePresent ? 'present-not-probed' : 'empty',
      provider: this.platform === 'win32' ? providerName : 'unavailable',
      protectedByOs: this.platform === 'win32',
      storageLocation: this.storageLocation,
      verificationState: 'not-probed',
      storesPlaintextCredentials: false
    };
  }

  list() {
    if (this.platform !== 'win32') return [];
    return this.#metadataSnapshot().connections.map(({ connectionId, connectorId, label, authMethod, scopes, grants, createdAt, updatedAt, expiresAt, providerVerification }) => {
      const expired = expiresAt && Date.parse(expiresAt) <= this.clock().getTime();
      const providerVerified = providerVerification?.providerVerified === true;
      return {
        connectionId, connectorId, label, authMethod, scopes: [...scopes], grants: [...grants], createdAt, updatedAt,
        expiresAt: expiresAt ?? null,
        status: expired ? 'expired' : providerVerified ? 'credentials-stored-provider-verified' : 'credentials-stored-unverified',
        verificationState: expired ? 'expired' : providerVerified ? 'provider-verified' : 'unverified',
        ...(providerVerification ? { providerVerification: { ...providerVerification } } : {})
      };
    });
  }

  /** providerAccountId is used transiently to derive a vault-keyed reference and is never persisted. */
  save({ connectorId, providerAccountId, label = '', authMethod, scopes = [], grants = [], credentials, expiresAt = null }) {
    this.#assertPlatform();
    if (typeof connectorId !== 'string' || !idPattern.test(connectorId)) throw new Error('A_INTEGRATION_ID_INVALID');
    if (typeof providerAccountId !== 'string' || !providerAccountId.trim() || providerAccountId.length > 512) throw new Error('A_INTEGRATION_ACCOUNT_INVALID');
    if (!['oauth2', 'oidc', 'device-pairing', 'os-broker', 'api-key'].includes(authMethod)) throw new Error('A_INTEGRATION_AUTH_METHOD_INVALID');
    validateStringList(scopes, 'A_INTEGRATION_SCOPES_INVALID');
    validateStringList(grants, 'A_INTEGRATION_GRANTS_INVALID');
    validateCredentials(credentials);
    if (typeof label !== 'string' || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) throw new Error('A_INTEGRATION_LABEL_INVALID');
    if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)))) throw new Error('A_INTEGRATION_EXPIRY_INVALID');

    const payload = this.#read();
    const accountRef = createHmac('sha256', Buffer.from(payload.indexKey, 'base64url'))
      .update(`${connectorId}\0${providerAccountId.trim()}`)
      .digest('base64url');
    const now = this.clock().toISOString();
    const existing = payload.connections.find(item => item.connectorId === connectorId && item.accountRef === accountRef);
    const record = {
      connectionId: existing?.connectionId ?? randomUUID(), connectorId, accountRef, label, authMethod,
      scopes: [...new Set(scopes)], grants: [...new Set(grants)], credentials: { ...credentials },
      createdAt: existing?.createdAt ?? now, updatedAt: now, ...(expiresAt ? { expiresAt } : {})
    };
    if (existing) payload.connections[payload.connections.indexOf(existing)] = record;
    else payload.connections.push(record);
    this.#write(payload);
    return this.list().find(item => item.connectionId === record.connectionId);
  }

  /** Stores a bounded provider-side credential check without changing the connector's JARVIS grants. */
  recordProviderVerification(connectionId, result, { expectedUpdatedAt = null } = {}) {
    this.#assertPlatform();
    const statuses = new Set(['verified', 'authentication-rejected', 'authorization-rejected', 'rate-limited', 'provider-unavailable', 'invalid-response', 'model-unavailable']);
    if (!statuses.has(result?.status) || typeof result?.providerVerified !== 'boolean'
      || typeof result?.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt))) {
      throw new Error('A_INTEGRATION_PROVIDER_VERIFICATION_INVALID');
    }
    const payload = this.#read();
    const connection = payload.connections.find(item => item.connectionId === connectionId);
    if (!connection) throw new Error('A_INTEGRATION_CONNECTION_NOT_FOUND');
    if (expectedUpdatedAt !== null && connection.updatedAt !== expectedUpdatedAt) {
      throw new Error('A_INTEGRATION_PROVIDER_VERIFICATION_STALE');
    }
    connection.providerVerification = {
      status: result.status,
      providerVerified: result.providerVerified,
      checkedAt: new Date(result.checkedAt).toISOString(),
      modelCount: Number.isSafeInteger(result.modelCount) ? Math.max(0, Math.min(result.modelCount, 10_000)) : 0,
      ...(typeof result.modelId === 'string' ? { modelId: result.modelId.slice(0, 200) } : {}),
      ...(typeof result.requestedModelAvailable === 'boolean' ? { requestedModelAvailable: result.requestedModelAvailable } : {}),
      ...(typeof result.errorCode === 'string' ? { errorCode: result.errorCode.slice(0, 80) } : {})
    };
    connection.updatedAt = this.clock().toISOString();
    this.#write(payload);
    return this.list().find(item => item.connectionId === connectionId);
  }

  /** Opaque, vault-keyed snapshot for trusted commit fences; never returns secrets. */
  credentialRevision(connectionId) {
    const snapshot = this.#metadataSnapshot();
    const record = snapshot.connections.find(item => item.connectionId === connectionId);
    if (!record || (record.expiresAt && Date.parse(record.expiresAt) <= this.clock().getTime()))
      throw new Error('A_INTEGRATION_CONNECTION_NOT_FOUND');
    return snapshot.revisions.get(connectionId);
  }

  async withCredentials(connectionId, operation) {
    if (typeof operation !== 'function') throw new Error('A_INTEGRATION_CALLBACK_REQUIRED');
    const record = this.#read().connections.find(item => item.connectionId === connectionId);
    if (!record) throw new Error('A_INTEGRATION_CONNECTION_NOT_FOUND');
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.clock().getTime()) throw new Error('A_INTEGRATION_CREDENTIAL_EXPIRED');
    return operation(Object.freeze({ ...record.credentials }), Object.freeze({
      connectorId: record.connectorId, connectionId: record.connectionId,
      scopes: [...record.scopes], grants: [...record.grants], authMethod: record.authMethod, updatedAt: record.updatedAt
    }));
  }

  /** Trusted single-Core OAuth refresh only. Never changes identity, scope or execution grants. */
  rotateOAuthRefreshToken(connectionId, { expectedConnection, expectedCredentials, refreshToken } = {}) {
    this.#assertPlatform();
    validateCredentials(expectedCredentials);
    validateCredentials({ refreshToken });
    const payload = this.#read();
    const record = payload.connections.find(item => item.connectionId === connectionId);
    const current = this.list().find(item => item.connectionId === connectionId);
    if (!record || record.authMethod !== 'oauth2' || !current || current.status === 'expired'
      || JSON.stringify(current) !== JSON.stringify(expectedConnection)
      || Object.keys(record.credentials).length !== Object.keys(expectedCredentials).length
      || Object.entries(record.credentials).some(([key, value]) => expectedCredentials[key] !== value)) {
      throw new Error('A_INTEGRATION_OAUTH_REFRESH_STALE');
    }
    record.credentials = { ...record.credentials, refreshToken };
    record.updatedAt = this.clock().toISOString();
    this.#write(payload);
    return this.list().find(item => item.connectionId === connectionId);
  }

  /** Removes local credentials only; it makes no claim that a provider-side OAuth grant was revoked. */
  remove(connectionId) {
    this.#assertPlatform();
    const payload = this.#read();
    const index = payload.connections.findIndex(item => item.connectionId === connectionId);
    if (index < 0) return { removed: false, remoteGrantRevoked: false };
    payload.connections.splice(index, 1);
    this.#write(payload);
    return { removed: true, remoteGrantRevoked: false };
  }

  #assertPlatform() {
    if (this.platform !== 'win32') throw new Error('A_INTEGRATION_DPAPI_UNAVAILABLE');
  }

  // Cache only the existing public projection and opaque HMAC revisions, never the payload,
  // credentials or vault key. Read and compare the complete encrypted file on every access.
  #metadataSnapshot() {
    this.#assertPlatform();
    if (!existsSync(this.path)) { this.#metadataCache = null; return { connections: [], revisions: new Map() }; }
    let raw;
    try { raw = readFileSync(this.path, 'utf8'); } catch { this.#metadataCache = null; throw new Error('A_INTEGRATION_VAULT_UNREADABLE'); }
    if (this.#metadataCache?.raw === raw) return this.#metadataCache;
    this.#metadataCache = null;
    const payload = this.#decode(raw);
    const connections = payload.connections.map(({ connectionId, connectorId, label, authMethod, scopes, grants, createdAt, updatedAt, expiresAt, providerVerification }) =>
      ({ connectionId, connectorId, label, authMethod, scopes: [...scopes], grants: [...grants], createdAt, updatedAt, expiresAt,
        ...(providerVerification ? { providerVerification: { ...providerVerification } } : {}) }));
    const revisions = new Map(payload.connections.map(record => [record.connectionId,
      createHmac('sha256', Buffer.from(payload.indexKey, 'base64url'))
        .update('integration-credential-revision-v1\0' + JSON.stringify(record)).digest('hex')]));
    this.#metadataCache = { raw, connections, revisions };
    return this.#metadataCache;
  }

  #read() {
    this.#assertPlatform();
    if (!existsSync(this.path)) return { indexKey: this.randomBytes(32).toString('base64url'), connections: [] };
    let raw;try { raw = readFileSync(this.path, 'utf8'); } catch { throw new Error('A_INTEGRATION_VAULT_UNREADABLE'); }
    return this.#decode(raw);
  }

  #decode(raw) {
    try {
      const envelope = JSON.parse(raw);
      if (envelope.version !== vaultVersion || envelope.provider !== providerName || typeof envelope.encrypted !== 'string') throw new Error('metadata');
      const payload = JSON.parse(Buffer.from(this.unprotect(envelope.encrypted), 'base64').toString('utf8'));
      if (typeof payload.indexKey !== 'string' || !Array.isArray(payload.connections)) throw new Error('payload');
      return payload;
    } catch {
      throw new Error('A_INTEGRATION_VAULT_UNREADABLE');
    }
  }

  #write(payload) {
    const cleartext = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const envelope = JSON.stringify({ version: vaultVersion, provider: providerName, encrypted: this.protect(cleartext) });
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, envelope, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.harden(temporary);
      // Verify the newly protected payload before replacing the prior usable vault.
      const verified = JSON.parse(Buffer.from(this.unprotect(JSON.parse(readFileSync(temporary, 'utf8')).encrypted), 'base64').toString('utf8'));
      if (verified.connections.length !== payload.connections.length) throw new Error('verification');
      renameSync(temporary, this.path);
      this.harden(this.path);
    } catch {
      try { rmSync(temporary, { force: true }); } catch { /* preserve original write error */ }
      throw new Error('A_INTEGRATION_VAULT_WRITE_FAILED');
    }
  }
}

/** Closed public projection: provider secrets, raw account IDs, HMAC references and future vault
 * implementation fields never escape through a write response. */
export function redactIntegrationConnection(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const output = {};
  for (const key of ['connectionId', 'connectorId', 'label', 'authMethod', 'createdAt', 'updatedAt', 'expiresAt', 'status', 'verificationState']) {
    if (typeof record[key] === 'string' || record[key] === null) output[key] = record[key];
  }
  for (const key of ['scopes', 'grants']) {
    if (Array.isArray(record[key]) && record[key].every(value => typeof value === 'string')) output[key] = [...record[key]];
  }
  if (record.providerVerification && typeof record.providerVerification === 'object') {
    const { status, providerVerified, checkedAt, modelCount, modelId, requestedModelAvailable, errorCode } = record.providerVerification;
    if (typeof status === 'string' && typeof providerVerified === 'boolean' && typeof checkedAt === 'string') {
      output.providerVerification = {
        status, providerVerified, checkedAt,
        ...(Number.isSafeInteger(modelCount) ? { modelCount } : {}),
        ...(typeof modelId === 'string' ? { modelId } : {}),
        ...(typeof requestedModelAvailable === 'boolean' ? { requestedModelAvailable } : {}),
        ...(typeof errorCode === 'string' ? { errorCode } : {})
      };
    }
  }
  return output;
}

function validateStringList(value, code) {
  if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) throw new Error(code);
}

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('A_INTEGRATION_CREDENTIALS_INVALID');
  for (const [key, value] of Object.entries(credentials)) {
    if (!allowedCredentialFields.has(key) || typeof value !== 'string' || !value || value.length > 16384) {
      throw new Error('A_INTEGRATION_CREDENTIAL_FIELD_DENIED');
    }
  }
  if (!Object.keys(credentials).length) throw new Error('A_INTEGRATION_CREDENTIALS_INVALID');
}
