import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { createRiskAccessibility } from '../accessibility/approval-accessibility.js';

const labels: Record<number, string> = {
  5: 'Tier 5 / 낮음',
  4: 'Tier 4 / 주의',
  3: 'Tier 3 / 높음',
  2: 'Tier 2 / 매우 높음',
  1: 'Tier 1 / 치명적'
};

export function RiskBadge({ tier }: { tier: 1 | 2 | 3 | 4 | 5 }) {
  const high = tier <= 3;
  const accessibility = createRiskAccessibility(tier);
  return (
    <View
      testID={`risk-badge-tier-${tier}`}
      accessibilityRole="text"
      accessibilityLabel={accessibility.label}
      accessibilityHint={accessibility.hint}
      style={{ borderColor: high ? colors.danger : colors.accent, borderWidth: 1, padding: 6 }}
    >
      <Text style={{ color: high ? colors.danger : colors.accent }}>{labels[tier]}</Text>
    </View>
  );
}
