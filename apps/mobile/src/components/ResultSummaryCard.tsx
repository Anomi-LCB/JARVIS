import React from 'react';
import { Text, View } from 'react-native';
import type { ExecutionResultView } from '../api/apiTypes';
import { colors } from '../theme/colors';
import { ResultFeedbackPanel } from './ResultFeedbackPanel';

const verificationLabel: Record<string, string> = {
  not_required: '검증 불필요',
  pending: '검증 대기',
  passed: '통과',
  failed: '실패'
};

export function ResultSummaryCard({
  result,
  feedbackText,
  onFeedback,
  onPreview,
  onShare,
  onRollback
}: {
  result: ExecutionResultView;
  feedbackText?: string;
  onFeedback?: (feedbackType: string) => void;
  onPreview?: (previewId: string, path: string) => void;
  onShare?: (previewId: string, path: string) => void;
  onRollback?: () => void;
}) {
  return (
    <View style={{ padding: 16, backgroundColor: colors.surface }}>
      <Text style={{ color: colors.text }}>{result.summary}</Text>
      <Text style={{ color: colors.muted }}>검증: {verificationLabel[result.verificationStatus ?? 'not_required'] ?? '상태 확인'}</Text>
      <Text style={{ color: colors.muted }}>되돌리기: {result.rollbackAvailable ? '가능' : '불가'}</Text>
      <ResultFeedbackPanel
        result={result}
        feedbackText={feedbackText}
        onFeedback={onFeedback}
        onPreview={onPreview}
        onShare={onShare}
        onRollback={onRollback}
      />
    </View>
  );
}
