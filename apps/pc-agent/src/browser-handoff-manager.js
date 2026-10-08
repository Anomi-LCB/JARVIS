import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_SESSIONS = 32;
const MAX_TTL_MS = 30 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest();

/**
 * Serializes automation around a persistent, locally owned browser session.
 * The manager never accepts credentials and exposes only bounded inspection/click actions.
 */
export class BrowserHandoffManager {
  constructor({ clock = () => new Date(), randomBytesImpl = randomBytes,
    confirmOwner = async () => false, reauthorize = async () => false } = {}) {
    this.clock = clock;
    this.randomBytes = randomBytesImpl;
    this.confirmOwner = confirmOwner;
    this.reauthorize = reauthorize;
    this.pepper = this.randomBytes(32);
    this.sessions = new Map();
    this.audit = [];
  }

  register({ sessionId = randomUUID(), driver, allowedOrigins, ttlMs = 10 * 60 * 1000,
    environmentId = 'default', accountBindingHash = null, contextId = null } = {}) {
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) throw handoffError('B_BROWSER_HANDOFF_CAPACITY');
    if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(sessionId) || this.sessions.has(sessionId)) throw handoffError('B_BROWSER_SESSION_ID_INVALID');
    if (!driver || typeof driver.currentUrl !== 'function' || typeof driver.click !== 'function') throw handoffError('B_BROWSER_INTERACTION_DRIVER_REQUIRED');
    if (typeof environmentId !== 'string' || !/^[a-z0-9_-]{1,40}$/u.test(environmentId)) throw handoffError('B_BROWSER_ENVIRONMENT_INVALID');
    if (accountBindingHash !== null && (typeof accountBindingHash !== 'string' || !/^[a-f0-9]{64}$/u.test(accountBindingHash))) {
      throw handoffError('B_BROWSER_ACCOUNT_BINDING_INVALID');
    }
    const resolvedContextId = contextId ?? driver.contextId ?? null;
    if (resolvedContextId !== null && (typeof resolvedContextId !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/u.test(resolvedContextId))) {
      throw handoffError('B_BROWSER_CONTEXT_ID_INVALID');
    }
    if (resolvedContextId && [...this.sessions.values()].some(item => item.contextId === resolvedContextId)) {
      throw handoffError('B_BROWSER_CONTEXT_SHARED');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw handoffError('B_BROWSER_HANDOFF_TTL_INVALID');
    const origins = normalizeOrigins(allowedOrigins);
    const createdAt = this.clock().getTime();
    const session = { sessionId, driver, allowedOrigins: origins, environmentId, accountBindingHash,
      contextId: resolvedContextId, status: 'active', generation: 1,
      expiresAt: new Date(createdAt + ttlMs).toISOString(), ticketDigest: null, handoff: null,
      issuedAt: new Date(createdAt).toISOString(), reason: null };
    const ticket = this.issueTicket(session);
    this.sessions.set(sessionId, session);
    this.record(session, 'browser.session.registered');
    return { sessionId, status: session.status, generation: session.generation, ticket, expiresAt: session.expiresAt };
  }

  beginHandoff({ sessionId, reason = 'user-login-required' } = {}) {
    const session = this.getActive(sessionId);
    if (typeof reason !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(reason)) throw handoffError('B_BROWSER_HANDOFF_REASON_INVALID');
    const handoffId = randomUUID();
    const confirmationToken = this.randomBytes(32).toString('base64url');
    session.status = 'human_handoff';
    session.reason = reason;
    session.generation += 1;
    session.ticketDigest = null;
    session.handoff = { handoffId, confirmationDigest: this.digest(confirmationToken), startedAt: this.clock().toISOString() };
    try { session.driver.pauseAutomation?.(); } catch { /* the state gate remains authoritative even if a UI hint fails */ }
    this.record(session, 'browser.handoff.started', { handoffId });
    return { handoffId, confirmationToken, status: session.status, generation: session.generation,
      allowedOrigins: [...session.allowedOrigins], automationPaused: true };
  }

  async completeHandoff({ sessionId, handoffId, confirmationToken } = {}) {
    this.prune();
    const session = this.sessions.get(sessionId);
    const pending = session?.handoff;
    if (!session || session.status !== 'human_handoff' || !pending || pending.handoffId !== handoffId) throw handoffError('B_BROWSER_HANDOFF_NOT_FOUND');
    if (!safeEqual(this.digest(confirmationToken), pending.confirmationDigest)) throw handoffError('B_BROWSER_HANDOFF_CONFIRMATION_INVALID');
    pending.confirmationDigest = null;
    let ownerConfirmed = false;
    try { ownerConfirmed = await this.confirmOwner({ sessionId, handoffId, confirmationToken }) === true; } catch { ownerConfirmed = false; }
    if (!ownerConfirmed) throw handoffError('B_BROWSER_OWNER_CONFIRMATION_REQUIRED');

    const generation = session.generation;
    const currentUrl = await session.driver.currentUrl();
    if (this.sessions.get(sessionId) !== session || session.status !== 'human_handoff' || session.generation !== generation) {
      throw handoffError('B_BROWSER_HANDOFF_STATE_CHANGED');
    }
    const origin = safeOrigin(currentUrl);
    if (!origin || !session.allowedOrigins.includes(origin)) {
      this.record(session, 'browser.handoff.origin_rejected', { handoffId });
      throw handoffError('B_BROWSER_HANDOFF_ORIGIN_OUT_OF_SCOPE');
    }
    let scopeAuthorized = false;
    try { scopeAuthorized = await this.reauthorize({ sessionId, handoffId, origin, allowedOrigins: [...session.allowedOrigins] }) === true; }
    catch { scopeAuthorized = false; }
    if (this.sessions.get(sessionId) !== session || session.status !== 'human_handoff' || session.generation !== generation) {
      throw handoffError('B_BROWSER_HANDOFF_STATE_CHANGED');
    }
    if (!scopeAuthorized) {
      this.record(session, 'browser.handoff.scope_rejected', { handoffId, origin });
      throw handoffError('B_BROWSER_HANDOFF_SCOPE_REAUTHORIZATION_REQUIRED');
    }
    session.status = 'active';
    session.reason = null;
    session.handoff = null;
    session.generation += 1;
    const ticket = this.issueTicket(session);
    this.record(session, 'browser.handoff.resumed', { handoffId, origin });
    return { sessionId, status: session.status, generation: session.generation, ticket, origin, automationPaused: false };
  }

  async dispatch({ sessionId, ticket, action, expectedEnvironmentId, expectedAccountBindingHash } = {}) {
    this.prune();
    const session = this.sessions.get(sessionId);
    const ticketDigest = this.digest(ticket);
    if (!session || session.status !== 'active' || !safeEqual(ticketDigest, session.ticketDigest)) {
      this.record(session, 'browser.action.rejected', { reason: session?.status === 'human_handoff' ? 'handoff-paused' : 'stale-or-invalid-ticket' });
      return { status: 'blocked', code: session?.status === 'human_handoff' ? 'B_BROWSER_AUTOMATION_PAUSED_FOR_HUMAN' : 'B_BROWSER_ACTION_TICKET_STALE' };
    }
    if (expectedEnvironmentId !== undefined && expectedEnvironmentId !== session.environmentId
      || expectedAccountBindingHash !== undefined && expectedAccountBindingHash !== session.accountBindingHash) {
      this.record(session, 'browser.action.rejected', { reason: 'environment-or-account-binding-mismatch' });
      return { status: 'blocked', code: 'B_BROWSER_SESSION_BINDING_MISMATCH' };
    }
    const generation = session.generation;
    const normalized = validateAction(action);
    let origin = safeOrigin(await session.driver.currentUrl());
    if (this.sessions.get(sessionId) !== session || session.status !== 'active' || session.generation !== generation
      || !safeEqual(ticketDigest, session.ticketDigest)) {
      this.record(session, 'browser.action.rejected', { reason: 'handoff-or-generation-changed' });
      return { status: 'blocked', code: 'B_BROWSER_AUTOMATION_PAUSED_FOR_HUMAN' };
    }
    if (!origin || !session.allowedOrigins.includes(origin)) {
      this.record(session, 'browser.action.rejected', { reason: 'origin-out-of-scope' });
      return { status: 'blocked', code: 'B_BROWSER_ACTION_ORIGIN_OUT_OF_SCOPE' };
    }
    if (normalized.type === 'click') await session.driver.click({ selector: normalized.selector });
    else return { status: 'blocked', code: 'B_BROWSER_ACTION_UNSUPPORTED' };
    if (this.sessions.get(sessionId) !== session || session.status !== 'active' || session.generation !== generation) {
      this.record(session, 'browser.action.completed-after-handoff', { origin });
      return { status: 'blocked', code: 'B_BROWSER_ACTION_COMPLETED_DURING_HANDOFF' };
    }
    this.record(session, 'browser.action.completed', { origin, actionType: normalized.type });
    return { status: 'completed', actionType: normalized.type, origin, generation };
  }

  status(sessionId) {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'missing' };
    return { sessionId, status: session.status, generation: session.generation, expiresAt: session.expiresAt,
      reason: session.reason, automationPaused: session.status === 'human_handoff', handoffId: session.handoff?.handoffId ?? null,
      environmentId: session.environmentId, accountBindingHash: session.accountBindingHash,
      contextBindingHash: session.contextId ? this.digest(session.contextId).toString('hex') : null,
      allowedOriginCount: session.allowedOrigins.length, credentialValuesExposed: false };
  }

  restartHandoff({ sessionId, reason = 'scope-reconfirmation-required' } = {}) {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'human_handoff' || !session.handoff) throw handoffError('B_BROWSER_HANDOFF_NOT_FOUND');
    if (typeof reason !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(reason)) throw handoffError('B_BROWSER_HANDOFF_REASON_INVALID');
    const previousHandoffId = session.handoff.handoffId;
    const handoffId = randomUUID();
    const confirmationToken = this.randomBytes(32).toString('base64url');
    session.reason = reason;
    session.generation += 1;
    session.handoff = { handoffId, confirmationDigest: this.digest(confirmationToken), startedAt: this.clock().toISOString() };
    try { session.driver.pauseAutomation?.(); } catch { /* fail closed in the state gate */ }
    this.record(session, 'browser.handoff.restarted', { previousHandoffId, handoffId });
    return { handoffId, confirmationToken, status: session.status, generation: session.generation, automationPaused: true };
  }

  auditLog() { return this.audit.map(item => ({ ...item })); }

  prune() {
    const now = this.clock().getTime();
    for (const [id, session] of this.sessions) if (Date.parse(session.expiresAt) <= now) {
      session.status = 'expired'; session.ticketDigest = null; session.handoff = null;
      this.sessions.delete(id);
      this.record(session, 'browser.session.expired');
    }
  }

  issueTicket(session) {
    const ticket = this.randomBytes(32).toString('base64url');
    session.ticketDigest = this.digest(ticket);
    return ticket;
  }
  digest(ticket) { return createHash('sha256').update(this.pepper).update('\0').update(String(ticket ?? '')).digest(); }
  record(session, event, extra = {}) {
    this.audit.push({ event, at: this.clock().toISOString(), sessionIdHash: this.digest(session?.sessionId ?? 'missing').toString('hex'),
      generation: session?.generation ?? null, status: session?.status ?? 'missing', ...extra });
    if (this.audit.length > 1000) this.audit.splice(0, this.audit.length - 1000);
  }
  getActive(sessionId) {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') throw handoffError('B_BROWSER_SESSION_NOT_ACTIVE');
    return session;
  }
}

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).some(key => !['type', 'selector'].includes(key))
    || action.type !== 'click' || typeof action.selector !== 'string' || !action.selector.trim() || action.selector.length > 300) {
    throw handoffError('B_BROWSER_ACTION_INVALID');
  }
  return { type: 'click', selector: action.selector.trim() };
}

function normalizeOrigins(origins) {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 20) throw handoffError('B_BROWSER_ORIGIN_SCOPE_INVALID');
  const normalized = [...new Set(origins.map(value => safeOrigin(value)))].filter(Boolean).sort();
  if (normalized.length !== new Set(origins).size) throw handoffError('B_BROWSER_ORIGIN_SCOPE_INVALID');
  return normalized;
}

function safeOrigin(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.origin;
  } catch { return null; }
}

function safeEqual(left, right) {
  return Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

function handoffError(code) { return Object.assign(new Error(code), { code }); }
