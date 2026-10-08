import { randomBytes } from 'node:crypto';
import { ActionType, stableId, TaskStatus } from '../../../shared/src/types.js';

export const PersonalOwnerGrant = Object.freeze({
  READ_ONLY: 'read_only',
  LOCAL_REVERSIBLE: 'local_reversible',
  HIGH_IMPACT: 'high_impact'
});

const acceptedGrants = new Set(Object.values(PersonalOwnerGrant));
const defaultGrants = Object.freeze(Object.values(PersonalOwnerGrant));
const alwaysPerActionActions = new Set([
  ActionType.DELETE_FILE,
  ActionType.UPLOAD_FILE,
  ActionType.SEND_EMAIL,
  ActionType.MAKE_PAYMENT,
  ActionType.CHANGE_SYSTEM_SETTING,
  ActionType.READ_SECRET
]);

export class PersonalOwnerSessionManager {
  constructor({
    clock = () => new Date(),
    eventBus = null,
    maxTtlMs = 60 * 60 * 1000,
    minTtlMs = 5 * 60 * 1000,
    auditLimit = 50
  } = {}) {
    this.clock = clock;
    this.eventBus = eventBus;
    this.maxTtlMs = maxTtlMs;
    this.minTtlMs = minTtlMs;
    this.auditLimit = auditLimit;
    this.session = null;
    this.audit = [];
  }

  activate({ durationMinutes = 30, requestedBy = 'local-owner', grants = defaultGrants } = {}) {
    const ttlMs = Number(durationMinutes) * 60 * 1000;
    if (!Number.isFinite(ttlMs) || ttlMs < this.minTtlMs || ttlMs > this.maxTtlMs) {
      return failure('A_OWNER_SESSION_TTL_INVALID', '소유자 모드는 5분에서 60분 사이로 활성화해야 합니다.');
    }
    const normalizedGrants = normalizeGrants(grants);
    if (normalizedGrants.length === 0) {
      return failure('A_OWNER_SESSION_GRANTS_REQUIRED', '소유자 모드에는 하나 이상의 로컬 권한이 필요합니다.');
    }
    const now = this.clock().toISOString();
    if (this.currentSession()) this.revoke({ reason: 'replaced-by-new-session', revokedBy: requestedBy });
    this.session = {
      sessionVersion: 'a-personal-owner-session-v1',
      sessionId: stableId('owner_session', randomBytes(18).toString('hex'), now),
      mode: 'personal_owner',
      status: 'active',
      grants: normalizedGrants,
      requestedBy: cleanIdentity(requestedBy),
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      revokedAt: null,
      revokeReason: null,
      protections: ownerProtections()
    };
    this.record('owner_session.activated', {
      sessionId: this.session.sessionId,
      grants: this.session.grants,
      expiresAt: this.session.expiresAt,
      requestedBy: this.session.requestedBy
    });
    return { success: true, ...this.status() };
  }

  revoke({ reason = 'owner-requested', revokedBy = 'local-owner' } = {}) {
    const current = this.currentSession();
    if (!current) {
      return { success: true, reason: 'no-active-session', ...this.status() };
    }
    const revokedAt = this.clock().toISOString();
    current.status = 'revoked';
    current.revokedAt = revokedAt;
    current.revokeReason = String(reason || 'owner-requested').slice(0, 160);
    this.record('owner_session.revoked', {
      sessionId: current.sessionId,
      revokedAt,
      revokedBy: cleanIdentity(revokedBy),
      reason: current.revokeReason
    });
    return { success: true, ...this.status() };
  }

  status() {
    const current = this.currentSession();
    const nowMs = Date.parse(this.clock().toISOString());
    const expiresAtMs = Date.parse(current?.expiresAt ?? '');
    return {
      statusVersion: 'a-personal-owner-session-status-v1',
      active: Boolean(current),
      mode: current?.mode ?? 'supervised',
      session: current ? publicSession(current, nowMs, expiresAtMs) : null,
      protections: ownerProtections(),
      recentAudit: this.audit.slice(0, 10)
    };
  }

  authorizeTask({ sessionId, task, remoteAddress = null } = {}) {
    const base = this.validateSession({ sessionId, remoteAddress });
    if (!base.allowed) return this.taskDecision(task, base);
    if (!task || task.status !== TaskStatus.WAITING_APPROVAL) {
      return this.taskDecision(task, denied('A_OWNER_TASK_NOT_WAITING', '승인 대기 중인 작업만 소유자 세션으로 승인할 수 있습니다.'));
    }
    const actionType = task.plan?.action?.actionType ?? null;
    const toolName = task.plan?.action?.toolName ?? null;
    const riskTier = Number(task.policy?.risk?.tier ?? task.approvalCard?.riskTier ?? 1);
    if (task.policy?.decision === 'block' || riskTier < 3) {
      return this.taskDecision(task, denied('A_OWNER_TASK_RISK_BLOCKED', '차단 또는 Tier 1-2 작업은 행동별 확인이 필요합니다.'));
    }
    if (alwaysPerActionActions.has(actionType) || task.policy?.constraints?.allowExternalTransfer === true) {
      return this.taskDecision(task, denied('A_OWNER_TASK_PER_ACTION_REQUIRED', '외부 전송, 삭제, 결제, 시스템 설정, 비밀 접근은 행동별 확인이 필요합니다.'));
    }
    if (task.policy?.constraints?.allowAdminPrivilege === true) {
      return this.taskDecision(task, denied('A_OWNER_TASK_ELEVATION_REQUIRED', '운영체제 관리자 권한 상승은 별도 확인이 필요합니다.'));
    }
    const requiredGrant = grantForTask(task);
    if (!base.session.grants.includes(requiredGrant)) {
      return this.taskDecision(task, denied('A_OWNER_TASK_GRANT_MISSING', `소유자 세션에 ${requiredGrant} 권한이 없습니다.`), { requiredGrant });
    }
    return this.taskDecision(task, {
      allowed: true,
      code: 'A_OWNER_TASK_AUTHORIZED',
      reason: 'active-personal-owner-session',
      session: base.session,
      requiredGrant,
      actionType,
      toolName,
      riskTier
    });
  }

  authorizeMission({ sessionId, requestedGrants = defaultGrants, remoteAddress = null } = {}) {
    const base = this.validateSession({ sessionId, remoteAddress });
    if (!base.allowed) return this.missionDecision(base);
    const grants = normalizeGrants(requestedGrants).filter((grant) => base.session.grants.includes(grant));
    if (grants.length === 0) {
      return this.missionDecision(denied('A_OWNER_MISSION_GRANTS_DENIED', '활성 소유자 세션과 일치하는 미션 권한이 없습니다.'));
    }
    return this.missionDecision({
      allowed: true,
      code: 'A_OWNER_MISSION_AUTHORIZED',
      reason: 'active-personal-owner-session',
      session: base.session,
      grants
    });
  }

  authorizeGrowthSkillReview({ action, deviceId } = {}) {
    const allowedActions = new Set(['review', 'promote', 'rollback']);
    const current = this.currentSession();
    const allowed = Boolean(current && allowedActions.has(action)
      && current.grants.includes(PersonalOwnerGrant.HIGH_IMPACT));
    const decision = {
      authorizationVersion: 'a-owner-growth-skill-review-v1',
      allowed,
      code: allowed ? 'A_OWNER_GROWTH_SKILL_REVIEW_AUTHORIZED' : 'A_OWNER_GROWTH_SKILL_REVIEW_DENIED',
      reason: allowed ? 'active-owner-session-high-impact-grant' : current ? 'owner-session-grant-or-action-missing' : 'owner-session-inactive',
      sessionId: current?.sessionId ?? null,
      expiresAt: current?.expiresAt ?? null,
      action: allowedActions.has(action) ? action : null,
      deviceId: cleanIdentity(deviceId ?? 'unknown-device'),
      evaluatedAt: this.clock().toISOString()
    };
    this.record(allowed ? 'owner_session.growth_skill_review_authorized' : 'owner_session.growth_skill_review_denied', decision);
    return decision;
  }

  authorizeCapabilityPackageReview({
    action,
    sessionId,
    packageDigest,
    artifactSha256,
    deviceId,
    remoteAddress = null
  } = {}) {
    const allowedActions = new Set(['review', 'promote', 'rollback']);
    const session = this.validateSession({ sessionId, remoteAddress });
    const digestsValid = /^[a-f0-9]{64}$/iu.test(String(packageDigest ?? ''))
      && /^[a-f0-9]{64}$/iu.test(String(artifactSha256 ?? ''));
    const allowed = Boolean(session.allowed
      && allowedActions.has(action)
      && digestsValid
      && session.session.grants.includes(PersonalOwnerGrant.HIGH_IMPACT));
    const decision = {
      authorizationVersion: 'a-owner-capability-package-review-v1',
      allowed,
      code: allowed ? 'A_OWNER_CAPABILITY_PACKAGE_AUTHORIZED' : 'A_OWNER_CAPABILITY_PACKAGE_DENIED',
      reason: allowed
        ? 'active-owner-session-high-impact-grant'
        : !session.allowed
          ? session.code
          : !allowedActions.has(action)
            ? 'package-action-missing'
            : !digestsValid
              ? 'package-digest-invalid'
              : 'owner-session-high-impact-grant-missing',
      sessionId: allowed ? session.session.sessionId : null,
      reviewerId: allowed ? `owner-session:${session.session.sessionId.slice(-8)}` : null,
      action: allowedActions.has(action) ? action : null,
      packageDigest: digestsValid ? String(packageDigest).toLowerCase() : null,
      artifactSha256: digestsValid ? String(artifactSha256).toLowerCase() : null,
      deviceId: cleanIdentity(deviceId ?? 'unknown-device'),
      evaluatedAt: this.clock().toISOString()
    };
    this.record(allowed ? 'owner_session.capability_package_authorized' : 'owner_session.capability_package_denied', decision);
    return decision;
  }

  validateSession({ sessionId, remoteAddress = null } = {}) {
    if (remoteAddress && !isLoopbackAddress(remoteAddress)) {
      return denied('A_OWNER_SESSION_LOCAL_ONLY', '소유자 모드는 이 PC의 로컬 연결에서만 사용할 수 있습니다.');
    }
    const current = this.currentSession();
    if (!current) return denied('A_OWNER_SESSION_INACTIVE', '활성 소유자 세션이 없습니다.');
    if (!sessionId || sessionId !== current.sessionId) {
      return denied('A_OWNER_SESSION_MISMATCH', '소유자 세션 참조가 현재 활성 세션과 일치하지 않습니다.');
    }
    return { allowed: true, session: current };
  }

  currentSession() {
    if (!this.session || this.session.status !== 'active') return null;
    const now = Date.parse(this.clock().toISOString());
    if (Date.parse(this.session.expiresAt) > now) return this.session;
    this.session.status = 'expired';
    this.record('owner_session.expired', {
      sessionId: this.session.sessionId,
      expiresAt: this.session.expiresAt
    });
    return null;
  }

  taskDecision(task, result, extra = {}) {
    const decision = {
      authorizationVersion: 'a-personal-owner-task-authorization-v1',
      allowed: result.allowed === true,
      code: result.code,
      reason: result.reason,
      sessionId: result.session?.sessionId ?? null,
      expiresAt: result.session?.expiresAt ?? null,
      taskId: task?.taskId ?? null,
      actionType: result.actionType ?? task?.plan?.action?.actionType ?? null,
      toolName: result.toolName ?? task?.plan?.action?.toolName ?? null,
      riskTier: result.riskTier ?? task?.policy?.risk?.tier ?? null,
      requiredGrant: result.requiredGrant ?? extra.requiredGrant ?? null,
      standingApproval: result.allowed === true,
      externalTransferAuthorized: false,
      irreversibleActionAuthorized: false,
      evaluatedAt: this.clock().toISOString()
    };
    this.record(result.allowed ? 'owner_session.task_authorized' : 'owner_session.task_denied', decision);
    return decision;
  }

  missionDecision(result) {
    const decision = {
      authorizationVersion: 'a-personal-owner-mission-authorization-v1',
      allowed: result.allowed === true,
      code: result.code,
      reason: result.reason,
      sessionId: result.session?.sessionId ?? null,
      expiresAt: result.session?.expiresAt ?? null,
      grants: result.grants ?? [],
      standingApproval: result.allowed === true,
      externalCommitRequiresPerActionApproval: true,
      irreversibleCommitRequiresPerActionApproval: true,
      evaluatedAt: this.clock().toISOString()
    };
    this.record(result.allowed ? 'owner_session.mission_authorized' : 'owner_session.mission_denied', decision);
    return decision;
  }

  record(eventType, payload) {
    const entry = {
      auditVersion: 'a-personal-owner-session-audit-v1',
      eventType,
      at: this.clock().toISOString(),
      ...payload
    };
    this.audit.unshift(entry);
    this.audit = this.audit.slice(0, this.auditLimit);
    this.eventBus?.publish?.(eventType, payload);
    return entry;
  }
}

export function isLoopbackAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  if (!value) return false;
  if (value === '::1' || value === 'localhost') return true;
  const ipv4 = value.startsWith('::ffff:') ? value.slice(7) : value;
  return ipv4 === '127.0.0.1' || ipv4.startsWith('127.');
}

function grantForTask(task) {
  const toolName = task.plan?.action?.toolName ?? null;
  const capability = task.plan?.action?.capability ?? task.route?.requiredCapability ?? {};
  const riskTier = Number(task.policy?.risk?.tier ?? task.approvalCard?.riskTier ?? 1);
  if (riskTier <= 3 || ['desktop.control', 'shell.execute'].includes(toolName)) return PersonalOwnerGrant.HIGH_IMPACT;
  if (capability.writesLocalFiles === true) return PersonalOwnerGrant.LOCAL_REVERSIBLE;
  return PersonalOwnerGrant.READ_ONLY;
}

function normalizeGrants(grants) {
  const values = Array.isArray(grants) ? grants : [grants];
  return [...new Set(values.filter((grant) => acceptedGrants.has(grant)))];
}

function publicSession(session, nowMs, expiresAtMs) {
  return {
    sessionVersion: session.sessionVersion,
    sessionId: session.sessionId,
    mode: session.mode,
    status: session.status,
    grants: [...session.grants],
    requestedBy: session.requestedBy,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    remainingMs: Math.max(0, expiresAtMs - nowMs),
    protections: session.protections
  };
}

function ownerProtections() {
  return {
    sessionPersistsAcrossRestart: false,
    loopbackOnly: true,
    maximumDurationMinutes: 60,
    externalCommitRequiresPerActionApproval: true,
    irreversibleCommitRequiresPerActionApproval: true,
    osElevationRequiresNativeConsent: true,
    legalOrProviderRestrictionsBypassed: false,
    auditEnabled: true
  };
}

function cleanIdentity(value) {
  return String(value ?? 'local-owner').trim().slice(0, 120) || 'local-owner';
}

function denied(code, reason) {
  return { allowed: false, code, reason };
}

function failure(code, message) {
  return { success: false, error: { code, message } };
}
