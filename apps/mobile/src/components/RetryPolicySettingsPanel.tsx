import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';
import { createRetryPolicySettingsState } from './RetryPolicySettingsPanel.js';

type RetryPolicy = {
  maxAttempts: number;
  baseBackoffMs: number;
  updatedAt?: string | null;
  queuePath?: string | null;
};

type Props = {
  policy?: RetryPolicy | null;
  readiness?: unknown;
  draft?: {
    maxAttempts?: number;
    baseBackoffMs?: number;
    reason?: string;
  };
  onSave?: (draft: { maxAttempts: number; baseBackoffMs: number; reason: string }) => void;
  onReset?: () => void;
};

export function RetryPolicySettingsPanel({ policy = null, readiness, draft = {}, onSave, onReset }: Props) {
  const state = createRetryPolicySettingsState({ policy, readiness, draft });
  return (
    <View testID="retry-policy-settings-panel" style={{ gap: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ gap: spacing.xs }}>
        <Text style={{ color: colors.text }}>실행 대기열 재시도 정책</Text>
        <Text testID="retry-policy-max-attempts" style={{ color: colors.muted }}>시도 {state.draft.maxAttempts}회</Text>
        <Text testID="retry-policy-backoff" style={{ color: colors.muted }}>기본 대기 {state.draft.baseBackoffMs}ms</Text>
        {state.facts.updatedAt ? (
          <Text style={{ color: colors.muted }}>변경 {state.facts.updatedAt}</Text>
        ) : null}
      </View>

      {state.blockedReason ? (
        <Text testID="retry-policy-blocked-reason" style={{ color: colors.warning }}>{state.blockedReason}</Text>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <TouchableOpacity
          testID="retry-policy-save"
          disabled={!state.saveAction.enabled}
          onPress={() => onSave?.(state.draft)}
          style={{
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            borderWidth: 1,
            borderColor: state.saveAction.enabled ? colors.accent : colors.line,
            backgroundColor: colors.surfaceMuted,
            opacity: state.saveAction.enabled ? 1 : 0.55
          }}
        >
          <Text style={{ color: state.saveAction.enabled ? colors.text : colors.muted }}>{state.saveAction.label}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="retry-policy-reset"
          disabled={!state.resetAction.enabled}
          onPress={() => onReset?.()}
          style={{
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            borderWidth: 1,
            borderColor: state.resetAction.enabled ? colors.accent : colors.line,
            opacity: state.resetAction.enabled ? 1 : 0.55
          }}
        >
          <Text style={{ color: state.resetAction.enabled ? colors.text : colors.muted }}>{state.resetAction.label}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
