import { realpathSync } from 'node:fs';
import { normalizeMissionRoleAssignment } from './mission-role-scope.js';

const ROLE_METHODS = ['bindSession', 'sendMissionMessage', 'cancelMissionTurn', 'reconcileMission'];
const fail = code => { throw Object.assign(new Error(code), { code }); };

function durableDatabasePath(db) {
  try {
    const main = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
    if (typeof main?.file !== 'string' || !main.file) return null;
    return realpathSync.native(main.file).toLowerCase();
  } catch { return null; }
}

/**
 * Routes managed sessions by an explicit Mission role. Configure a distinct
 * durable broker/database and role-specific tool dispatcher for each role.
 * The pool does not reuse the primary broker when a role broker is unavailable.
 */
export class MissionRoleAgentSessionPool {
  constructor({ db = null, primary = null, roles = {}, authorizeRoleMessage = null, clock = () => new Date() } = {}) {
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) fail('A_MANAGED_AGENT_ROLE_BROKERS_INVALID');
    const entries = Object.entries(roles);
    if (entries.some(([role, broker]) => !['researcher', 'editor', 'verifier'].includes(role)
      || !broker || ROLE_METHODS.some(method => typeof broker[method] !== 'function'))) {
      fail('A_MANAGED_AGENT_ROLE_BROKER_INVALID');
    }
    if (primary && ROLE_METHODS.some(method => typeof primary[method] !== 'function')) fail('A_MANAGED_AGENT_PRIMARY_BROKER_INVALID');
    if (primary?.workerRole) fail('A_MANAGED_AGENT_PRIMARY_BROKER_MISMATCH');
    const brokers = [primary, ...entries.map(([, broker]) => broker)].filter(Boolean);
    if (new Set(brokers).size !== brokers.length) fail('A_MANAGED_AGENT_ROLE_BROKER_REUSED');
    if (entries.some(([role, broker]) => broker.workerRole !== role)) fail('A_MANAGED_AGENT_ROLE_BROKER_MISMATCH');
    const databases = brokers.map(broker => broker.db).filter(Boolean);
    if (new Set(databases).size !== databases.length) fail('A_MANAGED_AGENT_ROLE_DATABASE_REUSED');
    const durableDatabasePaths = brokers.map(broker => durableDatabasePath(broker.db)).filter(Boolean);
    if (new Set(durableDatabasePaths).size !== durableDatabasePaths.length) fail('A_MANAGED_AGENT_ROLE_DATABASE_FILE_REUSED');
    const registryPath = entries.length ? durableDatabasePath(db) : null;
    if (registryPath && durableDatabasePaths.includes(registryPath)) fail('A_MANAGED_AGENT_ROLE_REGISTRY_DATABASE_REUSED');
    if (entries.length && (!db?.prepare || typeof db.exec !== 'function')) fail('A_MANAGED_AGENT_ROLE_REGISTRY_DATABASE_REQUIRED');
    if (entries.length && typeof authorizeRoleMessage !== 'function') fail('A_MANAGED_AGENT_ROLE_MESSAGE_AUTHORIZER_REQUIRED');
    if (typeof clock !== 'function') fail('A_MANAGED_AGENT_ROLE_REGISTRY_CLOCK_INVALID');
    if (entries.length) db.exec(`
      CREATE TABLE IF NOT EXISTS managed_agent_role_session_assignments(
        mission_id TEXT NOT NULL, worker_role TEXT NOT NULL CHECK(worker_role IN ('researcher','editor','verifier')),
        collaboration_group_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, assigned_at TEXT NOT NULL,
        PRIMARY KEY(mission_id,worker_role)
      )
    `);
    this.db = db;
    this.clock = clock;
    this.primary = primary;
    this.roles = new Map(entries);
    this.authorizeRoleMessage = authorizeRoleMessage;
    this.supportsRoleScopedSessions = true;
  }

  setLocalSnapshotRecoveryIfAbsent(recovery) {
    if (typeof recovery !== 'function') fail('A_MANAGED_AGENT_LOCAL_RECOVERY_INVALID');
    for (const broker of [this.primary, ...this.roles.values()].filter(Boolean)) {
      broker.setLocalSnapshotRecoveryIfAbsent?.(recovery);
    }
  }

  _target({ missionId, workerRole = null, collaborationGroupId = null } = {}) {
    const normalized = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!normalized.valid) fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID');
    if (!normalized.assignment) {
      if (!this.primary) fail('A_MANAGED_AGENT_PRIMARY_BROKER_UNAVAILABLE');
      return { broker: this.primary, assignment: null };
    }
    const broker = this.roles.get(normalized.assignment.workerRole);
    if (!broker) fail('A_MANAGED_AGENT_ROLE_BROKER_UNAVAILABLE');
    const prior = this.db.prepare(`SELECT collaboration_group_id FROM managed_agent_role_session_assignments
      WHERE mission_id=? AND worker_role=?`).get(missionId, normalized.assignment.workerRole);
    if (!prior || prior.collaboration_group_id !== normalized.assignment.collaborationGroupId) {
      fail('A_MANAGED_AGENT_ROLE_SESSION_NOT_BOUND');
    }
    return { broker, assignment: normalized.assignment };
  }

  bindSession({ missionId, sessionId, workerRole = null, collaborationGroupId = null } = {}) {
    const normalized = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!normalized.valid) fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID');
    const assignment = normalized.assignment;
    const broker = assignment ? this.roles.get(assignment.workerRole) : this.primary;
    if (!broker) fail(assignment ? 'A_MANAGED_AGENT_ROLE_BROKER_UNAVAILABLE' : 'A_MANAGED_AGENT_PRIMARY_BROKER_UNAVAILABLE');
    const prior = assignment && this.db.prepare(`SELECT * FROM managed_agent_role_session_assignments
      WHERE mission_id=? AND worker_role=?`).get(missionId, assignment.workerRole);
    if (prior && (prior.collaboration_group_id !== assignment.collaborationGroupId || prior.session_id !== sessionId)) {
      fail('A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT');
    }
    const sessionOwner = assignment && this.db.prepare(`SELECT mission_id,worker_role,collaboration_group_id FROM managed_agent_role_session_assignments
      WHERE session_id=?`).get(sessionId);
    if (sessionOwner && (!prior || sessionOwner.mission_id !== missionId || sessionOwner.worker_role !== assignment.workerRole
      || sessionOwner.collaboration_group_id !== assignment.collaborationGroupId)) {
      fail('A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT');
    }
    const binding = broker.bindSession({ missionId, sessionId, ...(assignment ?? {}) });
    if (assignment && !prior) {
      const value = this.clock();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('A_MANAGED_AGENT_ROLE_REGISTRY_CLOCK_INVALID');
      this.db.prepare(`INSERT INTO managed_agent_role_session_assignments(mission_id,worker_role,collaboration_group_id,session_id,assigned_at)
        VALUES(?,?,?,?,?)`).run(missionId, assignment.workerRole, assignment.collaborationGroupId, sessionId, value.toISOString());
    }
    return { ...binding, ...(assignment ?? {}), executionAuthority: false };
  }

  /** Provision through the role's dedicated broker, then reconcile its session
   * into the separate role registry. If registry persistence fails, the broker
   * keeps the created/bound session so a repeated call can repair the registry
   * without creating another remote session. */
  async provisionSession({ missionId, sessionConfig, authorization = null, workerRole = null, collaborationGroupId = null } = {}) {
    const normalized = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!normalized.valid) fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID');
    const assignment = normalized.assignment;
    const broker = assignment ? this.roles.get(assignment.workerRole) : this.primary;
    if (!broker) fail(assignment ? 'A_MANAGED_AGENT_ROLE_BROKER_UNAVAILABLE' : 'A_MANAGED_AGENT_PRIMARY_BROKER_UNAVAILABLE');
    if (typeof broker.provisionSession !== 'function') fail('A_MANAGED_AGENT_ROLE_SESSION_PROVISION_UNAVAILABLE');
    if (assignment) {
      const prior = this.db.prepare(`SELECT collaboration_group_id,session_id FROM managed_agent_role_session_assignments
        WHERE mission_id=? AND worker_role=?`).get(missionId, assignment.workerRole);
      if (prior && prior.collaboration_group_id !== assignment.collaborationGroupId) fail('A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT');
    }
    const result = await broker.provisionSession({ missionId, sessionConfig, authorization, ...(assignment ?? {}) });
    if (result?.status !== 'bound' || typeof result.sessionId !== 'string') {
      return { ...result, ...(assignment ?? {}), executionAuthority: false };
    }
    const registryBinding = this.bindSession({ missionId, sessionId: result.sessionId, ...(assignment ?? {}) });
    return { ...result, ...registryBinding, ...(assignment ?? {}), executionAuthority: false };
  }

  /** Recover a previously uncertain create through its original role broker.
   * A uniquely matched remote session is then repaired into the role registry. */
  async reconcileSessionProvision({ missionId, workerRole = null, collaborationGroupId = null, maxPages = 5 } = {}) {
    const normalized = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!normalized.valid) fail('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID');
    const assignment = normalized.assignment;
    const broker = assignment ? this.roles.get(assignment.workerRole) : this.primary;
    if (!broker) fail(assignment ? 'A_MANAGED_AGENT_ROLE_BROKER_UNAVAILABLE' : 'A_MANAGED_AGENT_PRIMARY_BROKER_UNAVAILABLE');
    if (typeof broker.reconcileSessionProvision !== 'function') fail('A_MANAGED_AGENT_SESSION_PROVISION_RECONCILE_UNAVAILABLE');
    if (assignment) {
      const prior = this.db.prepare(`SELECT collaboration_group_id,session_id FROM managed_agent_role_session_assignments
        WHERE mission_id=? AND worker_role=?`).get(missionId, assignment.workerRole);
      if (prior && prior.collaboration_group_id !== assignment.collaborationGroupId) fail('A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT');
    }
    const result = await broker.reconcileSessionProvision(missionId, { maxPages, ...(assignment ?? {}) });
    if (result?.status !== 'bound' || typeof result.sessionId !== 'string') {
      return { ...result, ...(assignment ?? {}), executionAuthority: false };
    }
    const registryBinding = this.bindSession({ missionId, sessionId: result.sessionId, ...(assignment ?? {}) });
    return { ...result, ...registryBinding, ...(assignment ?? {}), executionAuthority: false };
  }

  async sendMissionMessage({ missionId, messageId, text, workerRole = null, collaborationGroupId = null,
    messageAuthorization = null } = {}) {
    const { broker, assignment } = this._target({ missionId, workerRole, collaborationGroupId });
    if (assignment) {
      let authorized = false;
      try {
        authorized = await this.authorizeRoleMessage({ missionId, messageId, text, roleAssignment: assignment,
          authorization: messageAuthorization }) === true;
      } catch { authorized = false; }
      if (!authorized) return { status: 'blocked', accepted: false, reason: 'role-message-egress-not-authorized', executionAuthority: false };
    }
    return { ...await broker.sendMissionMessage({ missionId, messageId, text, ...(assignment ?? {}) }), ...(assignment ?? {}), executionAuthority: false };
  }

  async cancelMissionTurn({ missionId, cancellationId, workerRole = null, collaborationGroupId = null } = {}) {
    const { broker, assignment } = this._target({ missionId, workerRole, collaborationGroupId });
    return { ...await broker.cancelMissionTurn({ missionId, cancellationId, ...(assignment ?? {}) }), ...(assignment ?? {}), executionAuthority: false };
  }

  async reconcileMission(missionId, roleAssignment = null) {
    const { broker, assignment } = this._target({ missionId, ...(roleAssignment ?? {}) });
    return { ...await broker.reconcileMission(missionId, assignment), ...(assignment ?? {}), executionAuthority: false };
  }
}
