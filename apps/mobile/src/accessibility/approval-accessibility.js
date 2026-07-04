export const riskTierAccessibility = {
  5: {
    label: '위험도 Tier 5, 낮음',
    hint: '모바일 승인이 가능한 낮은 위험 작업입니다.',
    tone: 'safe'
  },
  4: {
    label: '위험도 Tier 4, 주의',
    hint: '모바일에서 검토 후 승인할 수 있는 주의 작업입니다.',
    tone: 'caution'
  },
  3: {
    label: '위험도 Tier 3, 높음',
    hint: '모바일 단독 승인이 차단되며 PC 확인이 필요합니다.',
    tone: 'high'
  },
  2: {
    label: '위험도 Tier 2, 매우 높음',
    hint: '외부 전송 또는 민감 영향 가능성이 있어 PC 직접 확인이 필요합니다.',
    tone: 'critical'
  },
  1: {
    label: '위험도 Tier 1, 치명적',
    hint: '되돌리기 어렵거나 치명적인 작업으로 PC에서만 확인해야 합니다.',
    tone: 'critical'
  }
};

export function createRiskAccessibility(tier) {
  return riskTierAccessibility[tier] ?? {
    label: `위험도 Tier ${tier ?? '알 수 없음'}`,
    hint: '위험도를 확인할 수 없어 PC 확인이 필요할 수 있습니다.',
    tone: 'unknown'
  };
}

export function createApprovalActionAccessibility(action, { safetyFacts = {} } = {}) {
  const enabled = action?.enabled === true;
  const decision = action?.decision ?? action?.action ?? 'unknown';
  const reason = action?.blockedReason ?? null;
  const highRisk = safetyFacts.requiresPcConfirmation === true;
  const expired = safetyFacts.expired === true;
  const labelSuffix = enabled
    ? '사용 가능'
    : expired
      ? '만료되어 사용할 수 없음'
      : highRisk
        ? 'PC 확인 필요로 사용할 수 없음'
        : reason
          ? `사용할 수 없음, ${reason}`
          : '사용할 수 없음';
  return {
    accessibilityLabel: `${action?.label ?? decision}, ${labelSuffix}`,
    accessibilityHint: enabled
      ? '이 작업을 선택하면 승인 의사가 D Bridge로 전달됩니다.'
      : reason ?? (highRisk ? 'PC 확인 요청을 사용하세요.' : '현재 상태에서 선택할 수 없습니다.'),
    accessibilityState: {
      disabled: !enabled
    }
  };
}

export function createApprovalActionVisualSnapshot(action, { safetyFacts = {} } = {}) {
  const enabled = action?.enabled === true;
  const highRisk = safetyFacts.requiresPcConfirmation === true;
  const expired = safetyFacts.expired === true;
  return {
    decision: action?.decision ?? action?.action ?? 'unknown',
    label: action?.label ?? null,
    enabled,
    disabledReason: enabled ? null : action?.blockedReason ?? null,
    tone: enabled
      ? 'active'
      : expired
        ? 'expired-disabled'
        : highRisk
          ? 'pc-confirmation-disabled'
          : 'disabled',
    opacity: enabled ? 1 : 0.55,
    borderRole: enabled ? 'accent' : 'line',
    textRole: enabled ? 'text' : 'muted',
    accessibility: createApprovalActionAccessibility(action, { safetyFacts })
  };
}
