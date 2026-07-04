import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';
import { createCommandComposerState } from './CommandComposerPanel.js';

type Props = {
  rawText: string;
  connected: boolean;
  pendingOfflineCount: number;
  requestStatus?: 'idle' | 'pending' | 'success' | 'error' | 'timeout';
  requestStartedAt?: string | null;
  requestTimeoutMs?: number;
  onChangeText?: (value: string) => void;
  onSubmit?: () => void;
  onCancelRequest?: () => void;
  submitTestID?: string;
};

export function CommandComposerPanel({
  rawText,
  connected,
  pendingOfflineCount,
  requestStatus = 'idle',
  requestStartedAt = null,
  requestTimeoutMs = 8000,
  onChangeText,
  onSubmit,
  onCancelRequest,
  submitTestID
}: Props) {
  const state = createCommandComposerState({ rawText, connected, pendingOfflineCount, requestStatus, requestStartedAt, requestTimeoutMs });
  return (
    <View style={{ gap: spacing.sm }}>
      <TextInput
        value={rawText}
        onChangeText={onChangeText}
        placeholder="명령 입력"
        placeholderTextColor={colors.muted}
        multiline
        returnKeyType={state.keyboardSubmit.returnKeyType}
        blurOnSubmit={state.keyboardSubmit.blurOnSubmit}
        onSubmitEditing={state.keyboardSubmit.enabled ? onSubmit : undefined}
        style={{
          color: colors.text,
          borderColor: state.validation.message ? colors.warning : colors.line,
          borderWidth: 1,
          padding: spacing.md,
          minHeight: 96
        }}
      />
      {state.validation.message ? <Text style={{ color: colors.warning }}>{state.validation.message}</Text> : null}
      {state.requestState.message ? <Text testID="command-request-state" style={{ color: state.requestState.timedOut ? colors.warning : colors.muted }}>{state.requestState.message}</Text> : null}
      <TouchableOpacity
        testID={submitTestID}
        accessibilityRole="button"
        disabled={!state.primaryAction.enabled}
        onPress={onSubmit}
        style={{
          padding: spacing.md,
          borderColor: state.primaryAction.enabled ? colors.accent : colors.line,
          borderWidth: 1,
          opacity: state.primaryAction.enabled ? 1 : 0.55
        }}
      >
        <Text style={{ color: state.primaryAction.enabled ? colors.text : colors.muted }}>
          {state.primaryAction.label}
        </Text>
      </TouchableOpacity>
      {state.cancelRequestAction.enabled ? (
        <TouchableOpacity
          testID="command-cancel-request"
          accessibilityRole="button"
          onPress={onCancelRequest}
          style={{
            padding: spacing.sm,
            borderColor: colors.warning,
            borderWidth: 1
          }}
        >
          <Text style={{ color: colors.warning }}>{state.cancelRequestAction.label}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
