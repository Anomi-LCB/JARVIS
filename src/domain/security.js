import { PermissionLevel } from './models.js';

const permissionRank = {
  [PermissionLevel.OBSERVE]: 1,
  [PermissionLevel.ASSIST]: 2,
  [PermissionLevel.CONTROL]: 3,
  [PermissionLevel.ADMIN]: 4
};

export class SecurityGateway {
  constructor({ approvals = [], defaultTtlMs = 5 * 60 * 1000 } = {}) {
    this.approvals = new Map(approvals.map((approval) => [approval.id, approval]));
    this.auditLog = [];
    this.defaultTtlMs = defaultTtlMs;
  }

  requestApproval(request) {
    const createdAt = request.createdAt ?? new Date().toISOString();
    const expiresAt = request.expiresAt ?? new Date(new Date(createdAt).getTime() + (request.ttlMs ?? this.defaultTtlMs)).toISOString();
    const approval = {
      id: request.id,
      actor: request.actor,
      action: request.action,
      requiredLevel: request.requiredLevel,
      status: request.autoApprove ? 'approved' : 'pending',
      createdAt,
      expiresAt,
      renewalCount: request.renewalCount ?? 0
    };
    this.approvals.set(approval.id, approval);
    this.audit('approval.requested', approval);
    return approval;
  }

  canExecute({ approvalId, userLevel, at = new Date().toISOString() }) {
    const approval = this.approvals.get(approvalId);
    const expired = approval ? this.isExpired(approval, at) : false;
    if (approval && expired && approval.status !== 'expired') {
      approval.status = 'expired';
      this.audit('approval.expired', { approvalId, at, expiresAt: approval.expiresAt });
    }
    const allowed = Boolean(
      approval &&
        approval.status === 'approved' &&
        !expired &&
        permissionRank[userLevel] >= permissionRank[approval.requiredLevel]
    );
    this.audit('permission.checked', { approvalId, userLevel, allowed, expired });
    return allowed;
  }

  renewApproval({ approvalId, actor, ttlMs = this.defaultTtlMs, autoApprove = false, at = new Date().toISOString() }) {
    const previous = this.approvals.get(approvalId);
    if (!previous) {
      this.audit('approval.renewal_failed', { approvalId, reason: 'not-found', at });
      return null;
    }
    const renewed = {
      ...previous,
      actor: actor ?? previous.actor,
      status: autoApprove ? 'approved' : 'pending',
      createdAt: at,
      expiresAt: new Date(new Date(at).getTime() + ttlMs).toISOString(),
      renewalCount: previous.renewalCount + 1
    };
    this.approvals.set(approvalId, renewed);
    this.audit('approval.renewed', renewed);
    return renewed;
  }

  isExpired(approval, at = new Date().toISOString()) {
    return Boolean(approval.expiresAt && new Date(at).getTime() > new Date(approval.expiresAt).getTime());
  }

  approvalSummary(at = new Date().toISOString()) {
    return [...this.approvals.values()].map((approval) => ({
      id: approval.id,
      action: approval.action,
      requiredLevel: approval.requiredLevel,
      status: this.isExpired(approval, at) ? 'expired' : approval.status,
      expiresAt: approval.expiresAt,
      renewalCount: approval.renewalCount
    }));
  }

  audit(event, payload) {
    this.auditLog.push({ event, payload, at: new Date().toISOString() });
  }
}
