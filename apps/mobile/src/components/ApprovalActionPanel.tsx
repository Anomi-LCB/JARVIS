import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';
import { createApprovalActionState } from './ApprovalActionPanel.js';

type Props = {
  card: unknown;
  safety: unknown;
  approveReadiness: unknown;
  onDecision?: (decision: string) => void;
};

export function ApprovalActionPanel({ card, safety, approveReadiness, onDecision }: Props) {
  const state = createApprovalActionState({ card, safety, approveReadiness });
  const actions = [state.primaryAction, ...state.secondaryActions];
  return (
    <View style={{ gap: spacing.sm }}>
      {state.expiry.expired ? (
        <Text testID="approval-expiry-warning" style={{ color: colors.warning }}>{state.expiry.blockedReason}</Text>
      ) : null}
      {state.primaryAction.blockedReason && !state.expiry.expired ? (
        <Text style={{ color: colors.warning }}>{state.primaryAction.blockedReason}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {actions.map((action) => (
          <TouchableOpacity
            key={action.decision}
            testID={`approval-action-${action.decision}`}
            accessibilityRole="button"
            accessibilityLabel={action.accessibility.accessibilityLabel}
            accessibilityHint={action.accessibility.accessibilityHint}
            accessibilityState={action.accessibility.accessibilityState}
            disabled={!action.enabled}
            onPress={() => onDecision?.(action.decision)}
            style={{
              paddingVertical: spacing.sm,
              paddingHorizontal: spacing.md,
              borderWidth: 1,
              borderColor: action.enabled ? colors.accent : colors.line,
              backgroundColor: action.enabled ? colors.surfaceMuted : colors.surface,
              opacity: action.enabled ? 1 : 0.55
            }}
          >
            <Text style={{ color: action.enabled ? colors.text : colors.muted }}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}
