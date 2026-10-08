import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { integrationCredentialSchemaError, redactIntegrationConnection } from './integration-security.js';

// API keys may cross the same narrowly scoped one-use ingress used by OAuth callbacks.
// The registered connector still constrains the method and exact scope set.
const handoffMethods = new Set(['oauth2', 'oidc', 'api-key']);
const defaultTtlMs = 120_000;
const maximumTtlMs = 360_000;
const maximumPending = 32;
const maximumOutcomeReceipts = 256;

/**
 * In-memory, short-lived, one-use credential handoffs. The Core admin bearer is not shared with
 * an interactive credential helper; the helper receives only a ticket bound to one connector,
 * registered method and exact scope set. Tickets expire on process restart and never appear in
 * status/list responses.
 */
export class IntegrationCredentialHandoffs {
  constructor({ registry, vault, clock = () => new Date(), randomBytesImpl = randomBytes, ttlMs = defaultTtlMs, blockedConnectorIds = [] } = {}) {
    if (!registry?.get || !vault?.save) throw new TypeError('IntegrationCredentialHandoffs requires a connector registry and credential vault.');
    this.registry = registry;
    this.vault = vault;
    this.blockedConnectorIds = new Set(blockedConnectorIds);
    this.clock = clock;
    this.randomBytes = randomBytesImpl;
    this.ttlMs = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, maximumTtlMs) : defaultTtlMs;
    this.pepper = this.randomBytes(32);
    this.pending = new Map();
    this.outcomes = new Map();
  }

  issue({ connectorId, authMethod, scopes = [], ttlMs } = {}) {
    if (this.blockedConnectorIds.has(connectorId)) throw handoffError('A_INTEGRATION_EXTERNAL_CREDENTIAL_STORE_REQUIRED');
    this.#pruneExpired();
    this.#pruneOutcomes();
    if (this.pending.size >= maximumPending) throw handoffError('A_INTEGRATION_HANDOFF_CAPACITY');
    const connector = this.registry.get(connectorId);
    if (!connector) throw handoffError('A_INTEGRATION_CONNECTOR_UNAVAILABLE');
    if (!handoffMethods.has(authMethod) || !connector.authMethods.includes(authMethod)) throw handoffError('A_INTEGRATION_HANDOFF_METHOD_INVALID');
    const ticketTtlMs = ttlMs === undefined ? this.ttlMs : ttlMs;
    if (!Number.isSafeInteger(ticketTtlMs) || ticketTtlMs < 1_000 || ticketTtlMs > maximumTtlMs) throw handoffError('A_INTEGRATION_HANDOFF_TTL_INVALID');
    if (!Array.isArray(scopes) || scopes.length > 200 || scopes.some(scope => typeof scope !== 'string'
      || !scope.trim() || scope.length > 200 || !connector.scopes.includes(scope))) {
      throw handoffError('A_INTEGRATION_HANDOFF_SCOPE_INVALID');
    }
    const normalizedScopes = [...new Set(scopes)].sort();
    const handoffId = randomUUID();
    this.outcomes.delete(handoffId);
    const ticket = this.randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.clock().getTime() + ticketTtlMs).toISOString();
    this.pending.set(handoffId, {
      handoffId,
      connectorId,
      authMethod,
      scopes: normalizedScopes,
      ticketDigest: this.#digest(ticket),
      expiresAt
    });
    return {
      handoffId,
      ticket,
      expiresAt,
      connector: this.registry.describe(connectorId),
      scopes: normalizedScopes,
      providerVerified: false,
      executionAuthorized: false
    };
  }

  complete(handoffId, ticket, { providerAccountId, label = '', credentials, expiresAt = null } = {}) {
    const pending = this.pending.get(handoffId);
    if (!pending) throw handoffError('A_INTEGRATION_HANDOFF_NOT_FOUND');
    if (Date.parse(pending.expiresAt) <= this.clock().getTime()) {
      this.pending.delete(handoffId);
      throw handoffError('A_INTEGRATION_HANDOFF_EXPIRED');
    }
    if (typeof ticket !== 'string' || !ticket || !safeDigestEqual(this.#digest(ticket), pending.ticketDigest)) {
      throw handoffError('A_INTEGRATION_HANDOFF_TICKET_INVALID');
    }
    // Consume before persistence. A storage error requires a fresh, user-visible authorization
    // attempt and can never make the same OAuth callback replayable.
    this.pending.delete(handoffId);
    const connector = this.registry.get(pending.connectorId);
    if (!connector || !connector.authMethods.includes(pending.authMethod)
      || pending.scopes.some(scope => !connector.scopes.includes(scope))) {
      throw handoffError('A_INTEGRATION_CONNECTOR_CHANGED');
    }
    const credentialError = integrationCredentialSchemaError(connector, credentials);
    if (credentialError) throw handoffError(credentialError);
    try {
      const connection = this.vault.save({
        connectorId: pending.connectorId,
        providerAccountId,
        label,
        authMethod: pending.authMethod,
        scopes: pending.scopes,
        grants: [],
        credentials,
        expiresAt
      });
      this.#pruneOutcomes();
      while (this.outcomes.size >= maximumOutcomeReceipts) this.outcomes.delete(this.outcomes.keys().next().value);
      this.outcomes.set(handoffId, { status: 'credentials-stored-unverified', expiresAt: pending.expiresAt });
      return { connection: redactIntegrationConnection(connection), providerVerified: false, executionAuthorized: false };
    } catch (error) {
      if (/^A_INTEGRATION_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
      throw handoffError('A_INTEGRATION_CREDENTIAL_SAVE_FAILED');
    }
  }

  cancel(handoffId) {
    return { cancelled: this.pending.delete(handoffId) };
  }

  /** Internal, credential-free reconciliation receipt for a helper whose HTTP response was lost. */
  getOutcome(handoffId) {
    this.#pruneOutcomes();
    const outcome = this.outcomes.get(handoffId);
    return outcome ? { status: outcome.status } : null;
  }

  recordOutcome(handoffId, status) {
    this.#pruneOutcomes();
    const current = this.outcomes.get(handoffId);
    if (!current || !['provider-verified', 'credentials-stored-unverified'].includes(status)) return null;
    // Verification may be downgraded after an activation failure, never upgraded by a caller
    // without an existing successful handoff receipt.
    current.status = status;
    return { status: current.status };
  }

  status() {
    this.#pruneExpired();
    return { pendingCount: this.pending.size, maximumPending, ttlMs: this.ttlMs, storesPlaintextTickets: false };
  }

  #digest(ticket) {
    return createHash('sha256').update(this.pepper).update('\0').update(ticket).digest();
  }

  #pruneExpired() {
    const now = this.clock().getTime();
    for (const [id, entry] of this.pending) if (Date.parse(entry.expiresAt) <= now) this.pending.delete(id);
  }

  #pruneOutcomes() {
    const now = this.clock().getTime();
    for (const [id, outcome] of this.outcomes) if (Date.parse(outcome.expiresAt) <= now) this.outcomes.delete(id);
  }
}

function safeDigestEqual(left, right) {
  return Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

function handoffError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
