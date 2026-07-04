const defaultPolicy = {
  capabilities: ['capture', 'memo', 'search', 'record', 'inspect'],
  confirmationRequired: ['capture', 'record', 'inspect'],
  destructiveTerms: ['삭제', '초기화', '포맷', 'format', 'delete', 'shutdown', 'restart'],
  dryRunOnly: ['inspect']
};

export class LocalPcController {
  constructor(policy = defaultPolicy) {
    const normalizedPolicy = Array.isArray(policy) ? { ...defaultPolicy, capabilities: policy } : { ...defaultPolicy, ...policy };
    this.capabilities = new Set(normalizedPolicy.capabilities);
    this.confirmationRequired = new Set(normalizedPolicy.confirmationRequired);
    this.destructiveTerms = normalizedPolicy.destructiveTerms;
    this.dryRunOnly = new Set(normalizedPolicy.dryRunOnly);
  }

  plan(command) {
    const normalized = command.toLowerCase();
    if (this.destructiveTerms.some((term) => normalized.includes(term))) {
      return this.createBlockedPlan('restricted-system-control', 'destructive-command-blocked');
    }
    if (normalized.includes('capture') || normalized.includes('캡처')) {
      return this.createPlan('capture', ['active-window', 'store-securely']);
    }
    if (normalized.includes('memo') || normalized.includes('메모')) {
      return this.createPlan('memo', ['open-note', 'draft-summary']);
    }
    if (normalized.includes('record') || normalized.includes('녹음')) {
      return this.createPlan('record', ['check-microphone', 'start-session']);
    }
    if (normalized.includes('설정') || normalized.includes('권한') || normalized.includes('system')) {
      return this.createPlan('inspect', ['scan-local-permissions', 'prepare-admin-approval', 'dry-run-only']);
    }
    return this.createPlan('search', ['parse-query', 'rank-results']);
  }

  createPlan(capability, steps) {
    if (!this.capabilities.has(capability)) {
      return this.createBlockedPlan(capability, 'capability-disabled');
    }
    return {
      capability,
      executable: true,
      steps,
      mode: this.dryRunOnly.has(capability) ? 'dry-run' : 'ready',
      requiresConfirmation: this.confirmationRequired.has(capability),
      risk: this.riskFor(capability),
      guardrails: this.guardrailsFor(capability)
    };
  }

  createBlockedPlan(capability, reason) {
    return {
      capability,
      executable: false,
      steps: [],
      mode: 'blocked',
      requiresConfirmation: true,
      risk: 'critical',
      reason,
      guardrails: ['deny-by-default', 'audit-required']
    };
  }

  riskFor(capability) {
    return {
      capture: 'medium',
      memo: 'low',
      search: 'low',
      record: 'high',
      inspect: 'high'
    }[capability] ?? 'medium';
  }

  guardrailsFor(capability) {
    const common = ['allowlist-match', 'audit-log'];
    if (this.confirmationRequired.has(capability)) common.push('user-confirmation');
    if (this.dryRunOnly.has(capability)) common.push('dry-run-only');
    return common;
  }
}
