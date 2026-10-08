import { createHash, randomUUID } from 'node:crypto';
import { normalizeMissionRoleAssignment } from './mission-role-scope.js';

const VERSION = 'a-managed-agent-session-broker-v4';
const PREVIOUS_VERSIONS = new Set(['a-managed-agent-session-broker-v2', 'a-managed-agent-session-broker-v3']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value)) fail(`A_MANAGED_AGENT_${name}_INVALID`);
  return value.trim();
};
const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  fail('A_MANAGED_AGENT_JSON_INVALID');
}

/**
 * Durable correlation ledger for an optional managed Agents API session.
 * It stores no API key and grants no execution authority. The dispatch callback
 * must route through JARVIS policy, B execution, and G verification.
 */
export class ManagedAgentSessionBroker {
  constructor({ db, provider, dispatchVerifiedTool, allowedToolNames = [], clock = () => new Date(), ownerId = randomUUID(),
    callLeaseTtlMs = 30_000, workerRole = null, authorizeSessionCreate = null, restoreLocalMissionSnapshot = null } = {}) {
    if (!db?.prepare || typeof db.exec !== 'function') fail('A_MANAGED_AGENT_DATABASE_REQUIRED');
    if (!provider || typeof provider.retrieveSession !== 'function' || typeof provider.submitToolResult !== 'function') fail('A_MANAGED_AGENT_PROVIDER_INVALID');
    if (typeof dispatchVerifiedTool !== 'function' || typeof clock !== 'function') fail('A_MANAGED_AGENT_DISPATCHER_INVALID');
    if (!Array.isArray(allowedToolNames) || allowedToolNames.length === 0) fail('A_MANAGED_AGENT_TOOL_ALLOWLIST_REQUIRED');
    if (!Number.isSafeInteger(callLeaseTtlMs) || callLeaseTtlMs < 1_000 || callLeaseTtlMs > 300_000) fail('A_MANAGED_AGENT_CALL_LEASE_INVALID');
    if (workerRole !== null && !['researcher', 'editor', 'verifier'].includes(workerRole)) fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID');
    this.ownerId = id(ownerId, 'OWNER_ID');
    this.callLeaseTtlMs = callLeaseTtlMs;
    this.allowedToolNames = new Set(allowedToolNames.map(name => id(name, 'TOOL_NAME')));
    this.db = db;
    this.provider = provider;
    this.dispatchVerifiedTool = dispatchVerifiedTool;
    this.validateToolResult = dispatchVerifiedTool.validateToolResult ?? null;
    if (this.allowedToolNames.has('jarvis.mission.read_text') && typeof this.validateToolResult !== 'function') {
      fail('A_MANAGED_AGENT_EGRESS_RESUBMISSION_VERIFIER_REQUIRED');
    }
    this.clock = clock;
    this.workerRole = workerRole;
    this.authorizeSessionCreate = authorizeSessionCreate;
    if (restoreLocalMissionSnapshot !== null && typeof restoreLocalMissionSnapshot !== 'function') fail('A_MANAGED_AGENT_LOCAL_RECOVERY_INVALID');
    this.restoreLocalMissionSnapshot = restoreLocalMissionSnapshot;
    db.exec(`
      CREATE TABLE IF NOT EXISTS managed_agent_broker_meta(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL);
      INSERT OR IGNORE INTO managed_agent_broker_meta VALUES(1,'${VERSION}');
      CREATE TABLE IF NOT EXISTS managed_agent_session_bindings(
        mission_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, bound_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_agent_session_provisions(
        mission_id TEXT PRIMARY KEY, provisioning_id TEXT NOT NULL UNIQUE,
        worker_role TEXT, collaboration_group_id TEXT, request_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('creating','denied','uncertain','created','bound')),
        session_id TEXT UNIQUE, remote_status TEXT, error_code TEXT, claim_owner TEXT, claim_expires_ms INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS managed_agent_binding_pair_idx ON managed_agent_session_bindings(mission_id,session_id);
      CREATE TABLE IF NOT EXISTS managed_agent_tool_calls(
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, arguments_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','awaiting_approval','uncertain','result_ready','submitted')),
        claim_owner TEXT, claim_expires_ms INTEGER,
        result_json TEXT, verification_id TEXT, evidence_ref TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,turn_id,call_id),
        FOREIGN KEY(session_id) REFERENCES managed_agent_session_bindings(session_id)
      );
      CREATE TABLE IF NOT EXISTS managed_agent_session_events(
        event_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, session_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('message','cancel')),
        event_key TEXT NOT NULL, target_turn_id TEXT, payload_json TEXT, payload_sha256 TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('ready','submitting','submitted')),
        claim_owner TEXT, claim_expires_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(session_id,event_type,event_key),
        FOREIGN KEY(mission_id,session_id) REFERENCES managed_agent_session_bindings(mission_id,session_id)
      );
    `);
    const schemaVersion = db.prepare('SELECT version FROM managed_agent_broker_meta WHERE id=1').get()?.version;
    if (PREVIOUS_VERSIONS.has(schemaVersion)) {
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE managed_agent_tool_calls RENAME TO managed_agent_tool_calls_v3;
        CREATE TABLE managed_agent_tool_calls(
          session_id TEXT NOT NULL, turn_id TEXT NOT NULL, call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL, arguments_sha256 TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('claimed','awaiting_approval','uncertain','result_ready','submitted')),
          claim_owner TEXT, claim_expires_ms INTEGER,
          result_json TEXT, verification_id TEXT, evidence_ref TEXT, updated_at TEXT NOT NULL,
          PRIMARY KEY(session_id,turn_id,call_id),
          FOREIGN KEY(session_id) REFERENCES managed_agent_session_bindings(session_id)
        );
        INSERT INTO managed_agent_tool_calls(session_id,turn_id,call_id,tool_name,arguments_sha256,state,claim_owner,claim_expires_ms,result_json,verification_id,evidence_ref,updated_at)
          SELECT session_id,turn_id,call_id,tool_name,arguments_sha256,state,claim_owner,claim_expires_ms,result_json,verification_id,evidence_ref,updated_at
          FROM managed_agent_tool_calls_v3;
        DROP TABLE managed_agent_tool_calls_v3;
        UPDATE managed_agent_broker_meta SET version='${VERSION}' WHERE id=1;
        COMMIT;`);
    } else if (schemaVersion !== VERSION) fail('A_MANAGED_AGENT_SCHEMA_UNSUPPORTED');
  }

  setLocalSnapshotRecoveryIfAbsent(recovery) {
    if (typeof recovery !== 'function') fail('A_MANAGED_AGENT_LOCAL_RECOVERY_INVALID');
    if (this.restoreLocalMissionSnapshot === null) this.restoreLocalMissionSnapshot = recovery;
  }

  bindSession({ missionId, sessionId, workerRole = null, collaborationGroupId = null }) {
    missionId = id(missionId, 'MISSION_ID'); sessionId = id(sessionId, 'SESSION_ID');
    const roleAssignment = this._normalizeRoleAssignment({ workerRole, collaborationGroupId });
    const prior = this.db.prepare('SELECT * FROM managed_agent_session_bindings WHERE mission_id=? OR session_id=?').get(missionId, sessionId);
    if (prior) {
      if (prior.mission_id !== missionId || prior.session_id !== sessionId) fail('A_MANAGED_AGENT_SESSION_BINDING_CONFLICT');
      return { missionId, sessionId, replayed: true, ...(roleAssignment ?? {}), executionAuthority: false };
    }
    this.db.prepare('INSERT INTO managed_agent_session_bindings VALUES(?,?,?)').run(missionId, sessionId, this._now());
    return { missionId, sessionId, replayed: false, ...(roleAssignment ?? {}), executionAuthority: false };
  }

  /** Provision a blank remote session, durably bind it locally, and never
   * repeat a create request whose remote outcome is unknown. First user input
   * must be sent later through sendMissionMessage's durable outbox. */
  async provisionSession({ missionId, sessionConfig, authorization = null, workerRole = null, collaborationGroupId = null } = {}) {
    missionId = id(missionId, 'MISSION_ID');
    const roleAssignment = this._normalizeRoleAssignment({ workerRole, collaborationGroupId });
    if (typeof this.provider.createSession !== 'function') fail('A_MANAGED_AGENT_PROVIDER_CREATE_UNAVAILABLE');
    if (typeof this.authorizeSessionCreate !== 'function') fail('A_MANAGED_AGENT_SESSION_CREATE_AUTHORIZER_REQUIRED');
    if (!sessionConfig || typeof sessionConfig !== 'object' || Array.isArray(sessionConfig)) fail('A_MANAGED_AGENT_SESSION_CONFIG_INVALID');
    const metadata = sessionConfig.metadata && typeof sessionConfig.metadata === 'object' && !Array.isArray(sessionConfig.metadata)
      ? sessionConfig.metadata : {};
    const config = { ...sessionConfig, metadata: { ...metadata } };
    if (Object.hasOwn(config.metadata, 'jarvisProvisioningId')) fail('A_MANAGED_AGENT_SESSION_METADATA_RESERVED');
    let requestSha256;
    try { requestSha256 = digest(canonical(config)); } catch { fail('A_MANAGED_AGENT_SESSION_CONFIG_INVALID'); }
    const assignmentValues = roleAssignment ?? {};
    const existingProvision = this.db.prepare('SELECT * FROM managed_agent_session_provisions WHERE mission_id=?').get(missionId);
    if (existingProvision) {
      if (existingProvision.request_sha256 !== requestSha256
        || existingProvision.worker_role !== (assignmentValues.workerRole ?? null)
        || existingProvision.collaboration_group_id !== (assignmentValues.collaborationGroupId ?? null)) {
        fail('A_MANAGED_AGENT_SESSION_PROVISION_CONFLICT');
      }
      if (existingProvision.state === 'denied') {
        this.db.prepare(`UPDATE managed_agent_session_provisions SET state='creating',error_code=NULL,claim_owner=?,claim_expires_ms=?,updated_at=?
          WHERE mission_id=? AND state='denied'`)
          .run(this.ownerId, Date.parse(this._now()) + 300_000, this._now(), missionId);
      } else if (existingProvision.state === 'creating' && existingProvision.claim_expires_ms > Date.parse(this._now())) {
        return { missionId, provisioningId: existingProvision.provisioning_id, sessionId: existingProvision.session_id ?? null,
          status: 'pending', reason: 'session-create-in-progress', automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };
      } else if (existingProvision.state === 'uncertain' || existingProvision.state === 'creating') {
        if (existingProvision.state === 'creating') this.db.prepare(`UPDATE managed_agent_session_provisions SET state='uncertain',claim_owner=NULL,
          claim_expires_ms=NULL,error_code='A_MANAGED_AGENT_SESSION_CREATE_OWNER_EXPIRED',updated_at=? WHERE mission_id=? AND state='creating'`)
          .run(this._now(), missionId);
        return { missionId, provisioningId: existingProvision.provisioning_id, sessionId: existingProvision.session_id ?? null,
          status: 'blocked', reason: 'session-create-outcome-uncertain', automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };
      } else if (existingProvision.state === 'bound') {
        return { missionId, provisioningId: existingProvision.provisioning_id, sessionId: existingProvision.session_id,
          remoteStatus: existingProvision.remote_status, status: 'bound', replayed: true, ...(roleAssignment ?? {}), executionAuthority: false };
      }
    } else {
      const priorBinding = this.db.prepare('SELECT session_id FROM managed_agent_session_bindings WHERE mission_id=?').get(missionId);
      if (priorBinding) return { missionId, sessionId: priorBinding.session_id, status: 'bound', replayed: true,
        ...(roleAssignment ?? {}), executionAuthority: false };
      const startedAt = this._now();
      const provisioningId = randomUUID();
      this.db.prepare(`INSERT INTO managed_agent_session_provisions(mission_id,provisioning_id,worker_role,collaboration_group_id,
        request_sha256,state,claim_owner,claim_expires_ms,created_at,updated_at) VALUES(?,?,?,?,?,'creating',?,?,?,?)`)
        .run(missionId, provisioningId, assignmentValues.workerRole ?? null, assignmentValues.collaborationGroupId ?? null,
          requestSha256, this.ownerId, Date.parse(startedAt) + 300_000, startedAt, startedAt);
    }

    let provision = this.db.prepare('SELECT * FROM managed_agent_session_provisions WHERE mission_id=?').get(missionId);
    if (provision.state === 'created' && provision.session_id) {
      const binding = this.bindSession({ missionId, sessionId: provision.session_id, ...(roleAssignment ?? {}) });
      this.db.prepare(`UPDATE managed_agent_session_provisions SET state='bound',updated_at=? WHERE mission_id=? AND state='created'`)
        .run(this._now(), missionId);
      return { ...binding, provisioningId: provision.provisioning_id, remoteStatus: provision.remote_status,
        status: 'bound', replayed: true, executionAuthority: false };
    }

    const provisioningMetadata = { ...config.metadata, jarvisProvisioningId: provision.provisioning_id };
    try {
      const session = await this.provider.createSession({ ...config, metadata: provisioningMetadata }, {
        authorizeSessionCreate: request => this.authorizeSessionCreate({ ...request, missionId,
          ...(roleAssignment ?? {}), provisioningId: provision.provisioning_id, authorization })
      });
      if (typeof session?.id !== 'string' || !session.id.trim()) fail('A_MANAGED_AGENT_SESSION_RESPONSE_INVALID');
      this.db.prepare(`UPDATE managed_agent_session_provisions SET state='created',session_id=?,remote_status=?,error_code=NULL,claim_owner=NULL,claim_expires_ms=NULL,updated_at=?
        WHERE mission_id=? AND provisioning_id=? AND state='creating'`)
        .run(session.id, session.status ?? null, this._now(), missionId, provision.provisioning_id);
      provision = this.db.prepare('SELECT * FROM managed_agent_session_provisions WHERE mission_id=?').get(missionId);
      const binding = this.bindSession({ missionId, sessionId: session.id, ...(roleAssignment ?? {}) });
      this.db.prepare(`UPDATE managed_agent_session_provisions SET state='bound',updated_at=? WHERE mission_id=? AND provisioning_id=? AND state='created'`)
        .run(this._now(), missionId, provision.provisioning_id);
      return { ...binding, provisioningId: provision.provisioning_id, remoteStatus: session.status ?? null,
        status: 'bound', replayed: false, executionAuthority: false };
    } catch (error) {
      const denied = error?.code === 'A_OPENAI_AGENTS_SESSION_CREATE_UNAUTHORIZED';
      this.db.prepare(`UPDATE managed_agent_session_provisions SET state=?,error_code=?,claim_owner=NULL,claim_expires_ms=NULL,updated_at=?
        WHERE mission_id=? AND provisioning_id=? AND state='creating'`)
        .run(denied ? 'denied' : 'uncertain', error?.code ?? 'A_MANAGED_AGENT_SESSION_CREATE_OUTCOME_UNKNOWN', this._now(), missionId, provision.provisioning_id);
      if (denied) return { missionId, provisioningId: provision.provisioning_id, status: 'blocked', reason: 'session-create-not-authorized',
        automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };
      return { missionId, provisioningId: provision.provisioning_id, status: 'blocked', reason: 'session-create-outcome-uncertain',
        automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };
    }
  }

  sessionProvision(missionId) {
    missionId = id(missionId, 'MISSION_ID');
    const row = this.db.prepare('SELECT mission_id,provisioning_id,worker_role,collaboration_group_id,state,session_id,remote_status,error_code,created_at,updated_at FROM managed_agent_session_provisions WHERE mission_id=?').get(missionId);
    return row ? { missionId: row.mission_id, provisioningId: row.provisioning_id, workerRole: row.worker_role,
      collaborationGroupId: row.collaboration_group_id, state: row.state, sessionId: row.session_id,
      remoteStatus: row.remote_status, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  /** Reconcile a timed-out create by opaque metadata correlation. This is a
   * bounded read-only lookup; it never submits a second create request. */
  async reconcileSessionProvision(missionId, options = {}) {
    if (missionId && typeof missionId === 'object' && !Array.isArray(missionId)) {
      options = missionId;
      missionId = options.missionId;
    }
    const { maxPages = 5, workerRole = null, collaborationGroupId = null } = options ?? {};
    missionId = id(missionId, 'MISSION_ID');
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10) fail('A_MANAGED_AGENT_SESSION_RECONCILE_LIMIT_INVALID');
    let row = this.db.prepare('SELECT * FROM managed_agent_session_provisions WHERE mission_id=?').get(missionId);
    if (!row) fail('A_MANAGED_AGENT_SESSION_PROVISION_NOT_FOUND');
    const roleAssignment = this._normalizeRoleAssignment({ workerRole: row.worker_role, collaborationGroupId: row.collaboration_group_id });
    if (workerRole !== null || collaborationGroupId !== null) {
      const requestedAssignment = this._normalizeRoleAssignment({ workerRole, collaborationGroupId });
      if (requestedAssignment?.workerRole !== roleAssignment?.workerRole
        || requestedAssignment?.collaborationGroupId !== roleAssignment?.collaborationGroupId) fail('A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT');
    }
    if (row.state === 'bound') return { missionId, provisioningId: row.provisioning_id, sessionId: row.session_id,
      remoteStatus: row.remote_status, status: 'bound', replayed: true, ...(roleAssignment ?? {}), executionAuthority: false };
    if (row.state === 'denied') return { missionId, provisioningId: row.provisioning_id, status: 'blocked', reason: 'session-create-not-authorized',
      automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };
    if (row.state === 'creating') {
      if (row.claim_expires_ms > Date.parse(this._now())) return { missionId, provisioningId: row.provisioning_id, status: 'pending',
        reason: 'session-create-in-progress', automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };
      this.db.prepare(`UPDATE managed_agent_session_provisions SET state='uncertain',claim_owner=NULL,claim_expires_ms=NULL,
        error_code='A_MANAGED_AGENT_SESSION_CREATE_OWNER_EXPIRED',updated_at=? WHERE mission_id=? AND state='creating'`)
        .run(this._now(), missionId);
      row = this.db.prepare('SELECT * FROM managed_agent_session_provisions WHERE mission_id=?').get(missionId);
    }
    if (row.state === 'created' && row.session_id) return this._bindProvisionedSession(row, roleAssignment);
    if (row.state !== 'uncertain') fail('A_MANAGED_AGENT_SESSION_PROVISION_STATE_INVALID');
    if (typeof this.provider.listSessions !== 'function') return { missionId, provisioningId: row.provisioning_id, status: 'blocked',
      reason: 'provider-session-list-unavailable', automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };

    const matches = [];
    let after = null;
    let pagesScanned = 0;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const page = await this.provider.listSessions({ limit: 100, order: 'desc', ...(after ? { after } : {}) });
      pagesScanned++;
      for (const session of page.data) {
        if (session.metadata?.jarvisProvisioningId === row.provisioning_id) matches.push(session);
      }
      if (!page.has_more || page.data.length === 0) break;
      const next = page.data.at(-1)?.id;
      if (!next || next === after) fail('A_MANAGED_AGENT_SESSION_LIST_CURSOR_INVALID');
      after = next;
    }
    if (matches.length !== 1) return { missionId, provisioningId: row.provisioning_id, status: 'blocked',
      reason: matches.length > 1 ? 'duplicate-remote-sessions-found' : 'session-create-outcome-unresolved',
      matchingSessions: matches.length, pagesScanned, automaticRetry: false, ...(roleAssignment ?? {}), executionAuthority: false };

    const session = matches[0];
    this.db.prepare(`UPDATE managed_agent_session_provisions SET state='created',session_id=?,remote_status=?,error_code=NULL,updated_at=?
      WHERE mission_id=? AND provisioning_id=? AND state='uncertain'`)
      .run(session.id, session.status, this._now(), missionId, row.provisioning_id);
    row = this.db.prepare('SELECT * FROM managed_agent_session_provisions WHERE mission_id=?').get(missionId);
    return this._bindProvisionedSession(row, roleAssignment);
  }

  _bindProvisionedSession(row, roleAssignment) {
    const binding = this.bindSession({ missionId: row.mission_id, sessionId: row.session_id, ...(roleAssignment ?? {}) });
    this.db.prepare(`UPDATE managed_agent_session_provisions SET state='bound',updated_at=? WHERE mission_id=? AND provisioning_id=? AND state='created'`)
      .run(this._now(), row.mission_id, row.provisioning_id);
    return { ...binding, provisioningId: row.provisioning_id, remoteStatus: row.remote_status,
      status: 'bound', replayed: true, executionAuthority: false };
  }

  async reconcileMission(missionId, roleAssignment = null) {
    missionId = id(missionId, 'MISSION_ID');
    const scopedRole = this._normalizeRoleAssignment(roleAssignment ?? {});
    const binding = this.db.prepare('SELECT * FROM managed_agent_session_bindings WHERE mission_id=?').get(missionId);
    if (!binding) fail('A_MANAGED_AGENT_SESSION_NOT_BOUND');
    let session;
    try {
      session = await this.provider.retrieveSession(binding.session_id);
    } catch (error) {
      // A missing hosted session is not evidence that its Mission or artifacts
      // completed. Preserve the local binding and return a resumable blocked
      // result; recreating the remote session requires a new explicit provision.
      if (error?.status === 404 || error?.code === 'A_OPENAI_AGENTS_SESSION_NOT_FOUND') {
        let recovery = { status: 'unavailable', snapshotSha256: null, missingArtifactIds: [] };
        if (this.restoreLocalMissionSnapshot) {
          try {
            const restored = await this.restoreLocalMissionSnapshot({ missionId, sessionId: binding.session_id });
            if (restored?.status === 'restored' && /^[a-f0-9]{64}$/u.test(restored.snapshotSha256)
              && Array.isArray(restored.missingArtifactIds) && restored.missingArtifactIds.length <= 100
              && restored.missingArtifactIds.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) {
              recovery = { status: 'restored', snapshotSha256: restored.snapshotSha256,
                missingArtifactIds: [...new Set(restored.missingArtifactIds)] };
            } else recovery = { status: 'failed', snapshotSha256: null, missingArtifactIds: [] };
          } catch { recovery = { status: 'failed', snapshotSha256: null, missingArtifactIds: [] }; }
        }
        return { missionId, sessionId: binding.session_id, status: 'blocked', taskVerified: false,
          remoteEnvironmentStatus: 'unavailable', reason: 'remote-session-not-found', httpStatus: error?.status ?? 404,
          localBindingPreserved: true, automaticRecreation: false, remoteTurnComplete: false,
          localRecoveryStatus: recovery.status,
          localSnapshot: recovery.status === 'restored' ? { digest: recovery.snapshotSha256, restored: true } : null,
          lostRemoteArtifacts: recovery.missingArtifactIds,
          ...(scopedRole ?? {}), executionAuthority: false };
      }
      throw error;
    }
    if (session?.id !== binding.session_id || !Array.isArray(session.required_actions)) fail('A_MANAGED_AGENT_SESSION_RESPONSE_INVALID');
    const pendingResults = this.db.prepare("SELECT turn_id,call_id,result_json FROM managed_agent_tool_calls WHERE session_id=? AND state='result_ready' ORDER BY updated_at,turn_id,call_id")
      .all(binding.session_id);
    for (const pending of pendingResults) await this._submitSavedResult(binding.session_id, pending.turn_id, pending.call_id, JSON.parse(pending.result_json));
    const outcomes = [];
    for (const action of session.required_actions) {
      if (action?.type !== 'function_call') {
        outcomes.push({ status: 'blocked', reason: 'unsupported-required-action', type: action?.type ?? null });
        continue;
      }
      outcomes.push(await this._handleFunctionCall(binding, missionId, action, scopedRole));
    }
    return { missionId, sessionId: binding.session_id, remoteStatus: session.status ?? 'unknown', outcomes,
      remoteTurnComplete: false, taskVerified: false, ...(scopedRole ?? {}), executionAuthority: false };
  }

  /** Queue a user message durably before network I/O. The caller supplies a
   * stable messageId so retries after restart replay the same payload/key. */
  async sendMissionMessage({ missionId, messageId, text, workerRole = null, collaborationGroupId = null }) {
    missionId = id(missionId, 'MISSION_ID'); messageId = id(messageId, 'MESSAGE_ID');
    this._normalizeRoleAssignment({ workerRole, collaborationGroupId });
    if (typeof text !== 'string' || !text.trim() || text.length > 32_000) fail('A_MANAGED_AGENT_MESSAGE_INVALID');
    if (typeof this.provider.submitMessage !== 'function') fail('A_MANAGED_AGENT_PROVIDER_MESSAGE_UNAVAILABLE');
    const binding = this._binding(missionId), payload = { text }, payloadJson = canonical(payload);
    const payloadSha256 = digest(payloadJson), eventId = digest(`${binding.session_id}\nmessage\n${messageId}`);
    const idempotencyKey = digest(`${eventId}\n${payloadSha256}`), now = this._now();
    this._enqueueEvent({ eventId, missionId, sessionId: binding.session_id, eventType: 'message', eventKey: messageId,
      targetTurnId: null, payloadJson, payloadSha256, idempotencyKey, now });
    return this._submitEvent(eventId);
  }

  /** The provider cancels the session's current turn; cancellationId identifies
   * this local request but cannot target a provider turn ID. Unknown outcomes
   * are fenced because replay could cancel a later turn. */
  async cancelMissionTurn({ missionId, cancellationId, workerRole = null, collaborationGroupId = null }) {
    missionId = id(missionId, 'MISSION_ID'); cancellationId = id(cancellationId, 'CANCELLATION_ID');
    this._normalizeRoleAssignment({ workerRole, collaborationGroupId });
    if (typeof this.provider.cancelTurn !== 'function') fail('A_MANAGED_AGENT_PROVIDER_CANCEL_UNAVAILABLE');
    const binding = this._binding(missionId), eventId = digest(`${binding.session_id}\ncancel\n${cancellationId}`), now = this._now();
    const payload = { cancellationId }, payloadJson = canonical(payload), payloadSha256 = digest(payloadJson);
    const idempotencyKey = digest(`${eventId}\n${payloadSha256}`);
    this._enqueueEvent({ eventId, missionId, sessionId: binding.session_id, eventType: 'cancel', eventKey: cancellationId,
      targetTurnId: null, payloadJson, payloadSha256, idempotencyKey, now });
    const result = await this._submitEvent(eventId);
    return { ...result, remoteTurnCancelled: false, missionCompleted: false,
      ...(result.status === 'blocked' ? { cancellationOutcomeUncertain: true } : {}) };
  }

  _binding(missionId) {
    const binding = this.db.prepare('SELECT * FROM managed_agent_session_bindings WHERE mission_id=?').get(missionId);
    if (!binding) fail('A_MANAGED_AGENT_SESSION_NOT_BOUND');
    return binding;
  }

  _normalizeRoleAssignment(input = {}) {
    const normalized = normalizeMissionRoleAssignment(input);
    if (!normalized.valid) fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID');
    const assignment = normalized.assignment;
    if (this.workerRole === null && assignment) fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_UNSUPPORTED');
    if (this.workerRole !== null && (!assignment || assignment.workerRole !== this.workerRole)) {
      fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_MISMATCH');
    }
    return assignment;
  }

  _enqueueEvent(event) {
    const prior = this.db.prepare('SELECT * FROM managed_agent_session_events WHERE session_id=? AND event_type=? AND event_key=?')
      .get(event.sessionId, event.eventType, event.eventKey);
    if (prior) {
      if (prior.event_id !== event.eventId || prior.payload_sha256 !== event.payloadSha256) fail('A_MANAGED_AGENT_EVENT_ID_REUSED');
      return prior;
    }
    const inserted = this.db.prepare(`INSERT INTO managed_agent_session_events(event_id,mission_id,session_id,event_type,event_key,target_turn_id,payload_json,payload_sha256,
      idempotency_key,state,claim_owner,claim_expires_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'ready',NULL,NULL,?,?)
      ON CONFLICT(session_id,event_type,event_key) DO NOTHING`)
      .run(event.eventId, event.missionId, event.sessionId, event.eventType, event.eventKey, event.targetTurnId, event.payloadJson,
        event.payloadSha256, event.idempotencyKey, event.now, event.now);
    if (!inserted.changes) {
      const raced = this.db.prepare('SELECT * FROM managed_agent_session_events WHERE session_id=? AND event_type=? AND event_key=?')
        .get(event.sessionId, event.eventType, event.eventKey);
      if (!raced || raced.event_id !== event.eventId || raced.payload_sha256 !== event.payloadSha256) fail('A_MANAGED_AGENT_EVENT_ID_REUSED');
      return raced;
    }
  }

  async _submitEvent(eventId) {
    let row = this.db.prepare('SELECT * FROM managed_agent_session_events WHERE event_id=?').get(eventId);
    if (!row) fail('A_MANAGED_AGENT_EVENT_MISSING');
    if (row.state === 'submitted') return { status: 'already-submitted', eventId, replayed: true, accepted: true };
    if (row.state === 'submitting' && row.claim_owner === null) {
      return { status: 'blocked', eventId, replayed: true, accepted: false, reason: 'cancel-outcome-uncertain', automaticRetry: false };
    }
    const nowMs = Date.parse(this._now());
    if (row.state === 'submitting' && Number.isSafeInteger(row.claim_expires_ms) && row.claim_expires_ms > nowMs) {
      return { status: 'pending', eventId, replayed: true, accepted: false };
    }
    const claimUntil = nowMs + this.callLeaseTtlMs;
    const claim = this.db.prepare(`UPDATE managed_agent_session_events SET state='submitting',claim_owner=?,claim_expires_ms=?,updated_at=?
      WHERE event_id=? AND (state='ready' OR state='submitting' AND claim_expires_ms<=?)`).run(this.ownerId, claimUntil,
      new Date(nowMs).toISOString(), eventId, nowMs);
    if (!claim.changes) return { status: 'pending', eventId, replayed: true, accepted: false };
    row = this.db.prepare('SELECT * FROM managed_agent_session_events WHERE event_id=?').get(eventId);
    const payload = JSON.parse(row.payload_json);
    try {
      const response = row.event_type === 'message'
        ? await this.provider.submitMessage(row.session_id, payload.text, { idempotencyKey: row.idempotency_key })
        : await this.provider.cancelTurn(row.session_id, { idempotencyKey: row.idempotency_key });
      const marked = this.db.prepare(`UPDATE managed_agent_session_events SET state='submitted',payload_json=NULL,claim_owner=NULL,claim_expires_ms=NULL,updated_at=?
        WHERE event_id=? AND state='submitting' AND claim_owner=?`).run(this._now(), eventId, this.ownerId);
      if (!marked.changes) return { status: 'pending', eventId, replayed: true, accepted: false };
      // A 202 only acknowledges receipt by the API. It is never local task success.
      return { status: 'accepted', eventId, replayed: false, accepted: true, providerStatus: response?.status ?? null };
    } catch (error) {
      const uncertainCancel = row.event_type === 'cancel';
      this.db.prepare(`UPDATE managed_agent_session_events SET state=?,claim_owner=NULL,claim_expires_ms=NULL,updated_at=?
        WHERE event_id=? AND state='submitting' AND claim_owner=?`).run(uncertainCancel ? 'submitting' : 'ready', this._now(), eventId, this.ownerId);
      if (uncertainCancel) return { status: 'blocked', eventId, replayed: false, accepted: false,
        reason: 'cancel-outcome-uncertain', automaticRetry: false, errorCode: error?.code ?? 'provider-error' };
      throw error;
    }
  }

  async _handleFunctionCall(binding, missionId, action, roleAssignment = null) {
    const turnId = id(action.turn_id, 'TURN_ID'), callId = id(action.call_id, 'CALL_ID'), toolName = id(action.name, 'TOOL_NAME');
    if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) fail('A_MANAGED_AGENT_ARGUMENTS_INVALID');
    const argsJson = canonical(action.arguments), argumentsSha256 = digest(argsJson);
    const existing = this.db.prepare('SELECT * FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?')
      .get(binding.session_id, turnId, callId);
    if (existing) {
      if (existing.tool_name !== toolName || existing.arguments_sha256 !== argumentsSha256) fail('A_MANAGED_AGENT_CALL_ID_REUSED');
      if (existing.state === 'claimed') {
        if (Number.isSafeInteger(existing.claim_expires_ms) && existing.claim_expires_ms > Date.parse(this._now())) {
          return { callId, status: 'blocked', reason: 'dispatch-in-progress', automaticRetry: false };
        }
        const now = Date.parse(this._now());
        const expired = this.db.prepare("UPDATE managed_agent_tool_calls SET state='uncertain',claim_owner=NULL,claim_expires_ms=NULL,updated_at=? WHERE session_id=? AND turn_id=? AND call_id=? AND state='claimed' AND claim_expires_ms<=?")
          .run(new Date(now).toISOString(), binding.session_id, turnId, callId, now);
        return { callId, status: 'blocked', reason: expired.changes ? 'execution-outcome-uncertain' : 'dispatch-in-progress', automaticRetry: false };
      }
      if (existing.state === 'uncertain') return { callId, status: 'blocked', reason: 'execution-outcome-uncertain', automaticRetry: false };
      if (existing.state !== 'awaiting_approval') {
        const saved = JSON.parse(existing.result_json);
        if (existing.state === 'submitted') return { callId, status: 'already-submitted', replayed: true };
        await this._submitSavedResult(binding.session_id, turnId, callId, saved);
        return { callId, status: 'result-submitted', replayed: true };
      }
    }

    const claimStartedAt = this._now(), claimExpiresMs = Date.parse(claimStartedAt) + this.callLeaseTtlMs;
    const resumedApproval = existing?.state === 'awaiting_approval';
    const inserted = resumedApproval
      ? this.db.prepare(`UPDATE managed_agent_tool_calls SET state='claimed',claim_owner=?,claim_expires_ms=?,updated_at=?
          WHERE session_id=? AND turn_id=? AND call_id=? AND state='awaiting_approval'`)
        .run(this.ownerId, claimExpiresMs, claimStartedAt, binding.session_id, turnId, callId)
      : this.db.prepare(`INSERT INTO managed_agent_tool_calls(session_id,turn_id,call_id,tool_name,arguments_sha256,state,claim_owner,claim_expires_ms,updated_at)
          VALUES(?,?,?,?,?,'claimed',?,?,?) ON CONFLICT(session_id,turn_id,call_id) DO NOTHING`)
        .run(binding.session_id, turnId, callId, toolName, argumentsSha256, this.ownerId, claimExpiresMs, claimStartedAt);
    if (!inserted.changes) {
      const raced = this.db.prepare('SELECT * FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?')
        .get(binding.session_id, turnId, callId);
      if (!raced || raced.tool_name !== toolName || raced.arguments_sha256 !== argumentsSha256) fail('A_MANAGED_AGENT_CALL_ID_REUSED');
      if (raced.state === 'claimed') return { callId, status: 'blocked', reason: 'dispatch-in-progress', automaticRetry: false };
      if (raced.state === 'uncertain') return { callId, status: 'blocked', reason: 'execution-outcome-uncertain', automaticRetry: false };
      if (raced.state === 'submitted') return { callId, status: 'already-submitted', replayed: true };
      await this._submitSavedResult(binding.session_id, turnId, callId, JSON.parse(raced.result_json));
      return { callId, status: 'result-submitted', replayed: true };
    }
    if (!this.allowedToolNames.has(toolName)) {
      const denied = { success: false, error: `Tool '${toolName}' is not enabled for this JARVIS session.` };
      this.db.prepare(`UPDATE managed_agent_tool_calls SET state='result_ready',claim_owner=NULL,claim_expires_ms=NULL,result_json=?,verification_id='policy-denied',evidence_ref='policy:tool-allowlist',updated_at=?
        WHERE session_id=? AND turn_id=? AND call_id=? AND state='claimed' AND claim_owner=?`)
        .run(canonical(denied), this._now(), binding.session_id, turnId, callId, this.ownerId);
      await this._submitSavedResult(binding.session_id, turnId, callId, denied);
      return { callId, status: 'result-submitted', verified: false, blocked: 'tool-not-allowlisted' };
    }
    let saved;
    const heartbeat = setInterval(() => {
      try {
        const expires = Date.parse(this._now()) + this.callLeaseTtlMs;
        this.db.prepare("UPDATE managed_agent_tool_calls SET claim_expires_ms=?,updated_at=? WHERE session_id=? AND turn_id=? AND call_id=? AND state='claimed' AND claim_owner=?")
          .run(expires, this._now(), binding.session_id, turnId, callId, this.ownerId);
      } catch { clearInterval(heartbeat); }
    }, Math.max(250, Math.floor(this.callLeaseTtlMs / 3)));
    heartbeat.unref?.();
    try {
      const dispatch = await this.dispatchVerifiedTool({ missionId, sessionId: binding.session_id, turnId, callId, toolName,
        argumentsSha256,
        ...(roleAssignment ?? {}),
        arguments: JSON.parse(argsJson), idempotencyKey: digest(`${binding.session_id}\n${turnId}\n${callId}`) });
      if (dispatch?.status === 'pending_approval' && typeof dispatch.gateId === 'string' && dispatch.gateId.trim()) {
        const pending = this.db.prepare(`UPDATE managed_agent_tool_calls SET state='awaiting_approval',claim_owner=NULL,claim_expires_ms=NULL,
          result_json=NULL,verification_id='approval-pending',evidence_ref=?,updated_at=?
          WHERE session_id=? AND turn_id=? AND call_id=? AND state='claimed' AND claim_owner=?`)
          .run(id(dispatch.gateId, 'GATE_ID'), this._now(), binding.session_id, turnId, callId, this.ownerId);
        return pending.changes
          ? { callId, status: 'approval-required', gateId: dispatch.gateId, replayed: false, submitted: false }
          : { callId, status: 'blocked', reason: 'approval-claim-lost', automaticRetry: false };
      }
      saved = this._normalizeDispatchResult(dispatch);
    } catch (error) {
      // A thrown dispatcher could have crossed B before the response was lost.
      this.db.prepare("UPDATE managed_agent_tool_calls SET state='uncertain',claim_owner=NULL,claim_expires_ms=NULL,updated_at=? WHERE session_id=? AND turn_id=? AND call_id=? AND state='claimed' AND claim_owner=?")
        .run(this._now(), binding.session_id, turnId, callId, this.ownerId);
      return { callId, status: 'blocked', reason: 'dispatch-outcome-uncertain', automaticRetry: false, errorCode: error?.code ?? 'dispatcher-error' };
    } finally {
      clearInterval(heartbeat);
    }
    const persisted = this.db.prepare(`UPDATE managed_agent_tool_calls SET state='result_ready',claim_owner=NULL,claim_expires_ms=NULL,result_json=?,verification_id=?,evidence_ref=?,updated_at=?
      WHERE session_id=? AND turn_id=? AND call_id=? AND state='claimed' AND claim_owner=?`)
      .run(canonical(saved.result), saved.verificationId, saved.evidenceRef, this._now(), binding.session_id, turnId, callId, this.ownerId);
    if (!persisted.changes) return { callId, status: 'blocked', reason: 'dispatch-claim-lost', automaticRetry: false };
    await this._submitSavedResult(binding.session_id, turnId, callId, saved.result);
    return { callId, status: 'result-submitted', verified: saved.verified, replayed: false };
  }

  _normalizeDispatchResult(dispatch) {
    if (dispatch?.status === 'blocked' && typeof dispatch.error === 'string' && dispatch.error.trim()) {
      return { verified: false, verificationId: 'policy-blocked', evidenceRef: 'policy:block', result: { success: false, error: dispatch.error.slice(0, 4000) } };
    }
    if (dispatch?.status !== 'verified' || dispatch.verification?.status !== 'passed'
      || typeof dispatch.verification.verificationId !== 'string' || !dispatch.verification.verificationId.trim()
      || typeof dispatch.verification.evidenceRef !== 'string' || !dispatch.verification.evidenceRef.trim()
      || typeof dispatch.output !== 'string' || dispatch.output.length > 64_000) fail('A_MANAGED_AGENT_G_VERIFICATION_REQUIRED');
    return { verified: true, verificationId: id(dispatch.verification.verificationId, 'VERIFICATION_ID'),
      evidenceRef: id(dispatch.verification.evidenceRef, 'EVIDENCE_REF'), result: { success: true, output: dispatch.output,
        ...(dispatch.egressAuthorization ? {egressAuthorization:dispatch.egressAuthorization} : {}) } };
  }

  async _submitSavedResult(sessionId, turnId, callId, result) {
    const idempotencyKey = digest(`${sessionId}\n${turnId}\n${callId}\ntool-result`);
    const row=this.db.prepare('SELECT * FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?').get(sessionId,turnId,callId);
    if(row?.state==='submitted')return;
    if(!row || row.state!=='result_ready' || canonical(result)!==row.result_json)fail('A_MANAGED_AGENT_TOOL_RESULT_STATE_INVALID');
    const sendOwner=`result-submit:${randomUUID()}`,now=Date.parse(this._now());
    const acquired=this.db.prepare(`UPDATE managed_agent_tool_calls SET claim_owner=?,claim_expires_ms=?,updated_at=?
      WHERE session_id=? AND turn_id=? AND call_id=? AND state='result_ready' AND result_json=?
      AND (claim_owner IS NULL OR claim_expires_ms<=?)`).run(sendOwner,now+this.callLeaseTtlMs,new Date(now).toISOString(),sessionId,turnId,callId,row.result_json,now);
    if(!acquired.changes)fail('A_MANAGED_AGENT_TOOL_RESULT_SUBMISSION_BUSY');
    const ownsSubmission=()=>{
      const current=this.db.prepare('SELECT state,claim_owner,claim_expires_ms FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?').get(sessionId,turnId,callId);
      return current?.state==='result_ready' && current.claim_owner===sendOwner && current.claim_expires_ms>Date.parse(this._now());
    };
    const heartbeat=setInterval(()=>{
      try{const renewedAt=this._now(),renewedMs=Date.parse(renewedAt);const renewed=this.db.prepare(`UPDATE managed_agent_tool_calls SET claim_expires_ms=?,updated_at=?
        WHERE session_id=? AND turn_id=? AND call_id=? AND state='result_ready' AND claim_owner=? AND claim_expires_ms>?`)
        .run(renewedMs+this.callLeaseTtlMs,renewedAt,sessionId,turnId,callId,sendOwner,renewedMs);if(!renewed.changes)clearInterval(heartbeat);}catch{clearInterval(heartbeat);}
    },Math.max(250,Math.floor(this.callLeaseTtlMs/3)));
    heartbeat.unref?.();
    try {
    if(result.success===true && row?.tool_name==='jarvis.mission.read_text') {
      const binding=this.db.prepare('SELECT mission_id FROM managed_agent_session_bindings WHERE session_id=?').get(sessionId);
      let permit;
      try {permit=await this.validateToolResult({missionId:binding?.mission_id,sessionId,turnId,callId,
        argumentsSha256:row.arguments_sha256,result:structuredClone(result)});}catch{}
      // No await between the final local fence and invocation of the provider.
      let current=false;
      try {current=permit?.authorized===true && typeof permit.commitCheck==='function' && permit.commitCheck()===true;}catch{}
      const latest=this.db.prepare('SELECT result_json FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?').get(sessionId,turnId,callId);
      if(!current || !latest || latest.result_json!==row.result_json || canonical(result)!==row.result_json) fail('A_MANAGED_AGENT_EGRESS_RESUBMISSION_DENIED');
    }
    const payload={type:'agent.session.input.tool_result',turn_id:turnId,call_id:callId,success:result.success,
      ...(result.success ? {output:result.output} : {error:result.error})};
    if(!ownsSubmission())fail('A_MANAGED_AGENT_TOOL_RESULT_SUBMISSION_BUSY');
    await this.provider.submitToolResult(sessionId, payload, { idempotencyKey });
    const committed=this.db.prepare("UPDATE managed_agent_tool_calls SET state='submitted',claim_owner=NULL,claim_expires_ms=NULL,updated_at=? WHERE session_id=? AND turn_id=? AND call_id=? AND state='result_ready' AND claim_owner=?")
      .run(this._now(), sessionId, turnId, callId,sendOwner);
    if(!committed.changes)fail('A_MANAGED_AGENT_TOOL_RESULT_SUBMISSION_OWNER_LOST');
    }finally{
      clearInterval(heartbeat);
      this.db.prepare("UPDATE managed_agent_tool_calls SET claim_owner=NULL,claim_expires_ms=NULL WHERE session_id=? AND turn_id=? AND call_id=? AND state='result_ready' AND claim_owner=?")
        .run(sessionId,turnId,callId,sendOwner);
    }
  }

  callState({ sessionId, turnId, callId }) {
    const row = this.db.prepare('SELECT * FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?')
      .get(id(sessionId, 'SESSION_ID'), id(turnId, 'TURN_ID'), id(callId, 'CALL_ID'));
    return row ? { ...row, result: row.result_json ? JSON.parse(row.result_json) : null, result_json: undefined, executionAuthority: false } : null;
  }

  /**
   * Bind a separately reconciled durable Mission/B receipt and fresh G result
   * to a call that was left uncertain. This releases the saved tool result only;
   * it never redispatches the original side effect.
   */
  async reconcileUncertain({ sessionId, turnId, callId, result, verification }) {
    sessionId = id(sessionId, 'SESSION_ID'); turnId = id(turnId, 'TURN_ID'); callId = id(callId, 'CALL_ID');
    if (verification?.status !== 'passed' || typeof verification.verificationId !== 'string'
      || typeof verification.evidenceRef !== 'string' || !verification.verificationId.trim() || !verification.evidenceRef.trim()
      || !result || typeof result.success !== 'boolean'
      || (result.success && (typeof result.output !== 'string' || result.output.length > 64_000))
      || (!result.success && (typeof result.error !== 'string' || !result.error.trim()))) fail('A_MANAGED_AGENT_RECONCILIATION_INVALID');
    const row = this.db.prepare('SELECT * FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?').get(sessionId, turnId, callId);
    if (!row || row.state !== 'uncertain') fail('A_MANAGED_AGENT_CALL_NOT_UNCERTAIN');
    if (result.success && verification.sideEffectReceiptVerified !== true) fail('A_MANAGED_AGENT_EFFECT_RECEIPT_REQUIRED');
    this.db.prepare("UPDATE managed_agent_tool_calls SET state='result_ready',claim_owner=NULL,claim_expires_ms=NULL,result_json=?,verification_id=?,evidence_ref=?,updated_at=? WHERE session_id=? AND turn_id=? AND call_id=? AND state='uncertain'")
      .run(canonical(result), id(verification.verificationId, 'VERIFICATION_ID'), id(verification.evidenceRef, 'EVIDENCE_REF'),
        this._now(), sessionId, turnId, callId);
    await this._submitSavedResult(sessionId, turnId, callId, result);
    return { callId, status: 'result-submitted-after-reconciliation', replayed: true, executionAuthority: false };
  }

  _now() {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('A_MANAGED_AGENT_CLOCK_INVALID');
    return value.toISOString();
  }
}
