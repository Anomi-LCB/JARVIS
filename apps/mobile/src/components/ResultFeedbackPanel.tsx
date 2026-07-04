import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';
import { createResultFeedbackState } from './ResultFeedbackPanel.js';

type Props = {
  result: unknown;
  feedbackText?: string;
  onFeedback?: (feedbackType: string) => void;
  onPreview?: (previewId: string, path: string) => void;
  onShare?: (previewId: string, path: string) => void;
  onRollback?: () => void;
};

export function ResultFeedbackPanel({ result, feedbackText = '', onFeedback, onPreview, onShare, onRollback }: Props) {
  const state = createResultFeedbackState({ result, feedbackText });
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{ color: colors.muted }}>검증: {state.verificationStatus}</Text>
      <Text style={{ color: colors.muted }}>산출물: {state.outputPaths.length}</Text>
      <View style={{ gap: spacing.xs }}>
        {state.filePreviews.map((preview) => (
          <View
            key={preview.previewId}
            style={{
              borderWidth: 1,
              borderColor: colors.line,
              padding: spacing.sm,
              gap: spacing.xs
            }}
          >
            <Text style={{ color: colors.text }}>{preview.name}</Text>
            <Text style={{ color: colors.muted }}>{preview.previewType} · {preview.mimeType}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              <TouchableOpacity
                disabled={!preview.actions.preview.enabled}
                onPress={() => onPreview?.(preview.previewId, preview.path)}
                style={{
                  paddingVertical: spacing.xs,
                  paddingHorizontal: spacing.sm,
                  borderWidth: 1,
                  borderColor: preview.actions.preview.enabled ? colors.accent : colors.line,
                  opacity: preview.actions.preview.enabled ? 1 : 0.55
                }}
              >
                <Text style={{ color: preview.actions.preview.enabled ? colors.text : colors.muted }}>{preview.actions.preview.label}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={!preview.actions.share.enabled}
                onPress={() => onShare?.(preview.previewId, preview.path)}
                style={{
                  paddingVertical: spacing.xs,
                  paddingHorizontal: spacing.sm,
                  borderWidth: 1,
                  borderColor: preview.actions.share.enabled ? colors.accent : colors.line,
                  opacity: preview.actions.share.enabled ? 1 : 0.55
                }}
              >
                <Text style={{ color: preview.actions.share.enabled ? colors.text : colors.muted }}>{preview.actions.share.label}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>
      <TouchableOpacity
        disabled={!state.rollbackAction.enabled}
        onPress={onRollback}
        style={{
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          borderWidth: 1,
          borderColor: state.rollbackAction.enabled ? colors.warning : colors.line,
          opacity: state.rollbackAction.enabled ? 1 : 0.55
        }}
      >
        <Text style={{ color: state.rollbackAction.enabled ? colors.text : colors.muted }}>{state.rollbackAction.label}</Text>
      </TouchableOpacity>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {state.feedbackActions.map((action) => (
          <TouchableOpacity
            key={action.feedbackType}
            disabled={!action.enabled}
            onPress={() => onFeedback?.(action.feedbackType)}
            style={{
              paddingVertical: spacing.sm,
              paddingHorizontal: spacing.md,
              borderWidth: 1,
              borderColor: action.enabled ? colors.accent : colors.line,
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
