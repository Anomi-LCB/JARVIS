import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';
import {
  createGrowthConflictResolutionState,
  createGrowthHygieneDecisionState,
  createGrowthReviewDecisionState,
  createGrowthReviewVisualSnapshot
} from './GrowthReviewDecisionPanel.js';

type Props = {
  review: unknown;
  onDecision?: (hypothesisId: string, decision: string) => void;
};

const resolutionLabel: Record<string, string> = {
  confirm_after_review: '검토 후 확정',
  reject_candidate: '후보 거절',
  collect_more_evidence: '근거 더 수집',
  keep_existing_preference: '기존 선호 유지',
  replace_existing_preference: '기존 선호 교체'
};

export function GrowthReviewDecisionPanel({ review, onDecision }: Props) {
  const state = createGrowthReviewDecisionState({ review });
  const hygieneState = createGrowthHygieneDecisionState({ review });
  const conflictState = createGrowthConflictResolutionState({ review });
  const visualSnapshot = createGrowthReviewVisualSnapshot({
    review,
    hygieneDecisionState: hygieneState,
    conflictResolutionState: conflictState
  });
  return (
    <View style={{ gap: spacing.md }} testID="growth-review-visual-contract">
      <View style={{ gap: spacing.xs }}>
        <Text style={{ color: visualSnapshot.passed ? colors.accent : colors.warning }}>
          화면 구성 검증 {visualSnapshot.passed ? '통과' : '검토 필요'}
        </Text>
        <Text style={{ color: colors.muted }}>
          후보 {visualSnapshot.preferenceCandidateCount}건 · 위생 {visualSnapshot.hygieneQueueCount}건 · 충돌 {visualSnapshot.conflictCount}건
        </Text>
      </View>

      {state.hasCandidates ? (
        state.candidates.map((candidate) => (
          <View key={candidate.hypothesisId} style={{ gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface }}>
            <Text style={{ color: colors.text }}>{candidate.statement}</Text>
            <Text style={{ color: colors.muted }}>
              신뢰도 {candidate.confidencePercent}% · {candidate.confidenceLabel}
            </Text>
            <Text style={{ color: colors.muted }}>{candidate.confidenceExplanation.summary}</Text>
            {candidate.contradiction.hasConflicts ? (
              <Text style={{ color: colors.warning }}>
                충돌 근거 {candidate.contradiction.count}건
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              {candidate.actions.map((action) => (
                <TouchableOpacity
                  key={action.decision}
                  disabled={!action.enabled}
                  onPress={() => onDecision?.(candidate.hypothesisId, action.decision)}
                  style={{
                    padding: spacing.sm,
                    borderWidth: 1,
                    borderColor: action.enabled ? colors.accent : colors.line,
                    opacity: action.enabled ? 1 : 0.55
                  }}
                >
                  <Text style={{ color: colors.text }}>{action.pending ? '처리 중' : action.label}</Text>
                  {action.requiresConflictAcknowledgement ? <Text style={{ color: colors.warning }}>충돌 확인 필요</Text> : null}
                  {action.error ? <Text style={{ color: colors.warning }}>{action.error.code}</Text> : null}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))
      ) : (
        <Text style={{ color: colors.muted }}>{state.emptyMessage}</Text>
      )}

      {conflictState.visible && conflictState.selected ? (
        <View testID="growth-conflict-resolution-modal" style={{ gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.warning }}>
          <Text style={{ color: colors.warning }}>충돌 검토</Text>
          <Text style={{ color: colors.text }}>{conflictState.selected.statement}</Text>
          <Text style={{ color: colors.muted }}>
            충돌 근거 {conflictState.selected.contradiction.count}건 · 확인 전 확정 차단 {conflictState.confirmBlockedUntilAcknowledged ? '예' : '아니오'}
          </Text>
          <Text style={{ color: colors.muted }}>
            선택지: {conflictState.resolutionOptions.map((option) => resolutionLabel[option] ?? option).join(', ')}
          </Text>
        </View>
      ) : null}

      <View testID="growth-hygiene-trend-chart" style={{ gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface }}>
        <Text style={{ color: colors.text }}>기억 위생 추이</Text>
        <Text style={{ color: colors.muted }}>{hygieneState.trendChart.summary}</Text>
        {hygieneState.trendChart.points.map((point) => (
          <View key={point.key} style={{ gap: spacing.xs }}>
            <Text style={{ color: colors.muted }}>{point.label}: {point.value}</Text>
            <View style={{ height: 6, backgroundColor: colors.line }}>
              <View
                style={{
                  height: 6,
                  width: `${Math.max(4, Math.round(point.ratio * 100))}%`,
                  backgroundColor: point.tone === 'danger'
                    ? colors.danger
                    : point.tone === 'warning'
                      ? colors.warning
                      : colors.accent
                }}
              />
            </View>
          </View>
        ))}
      </View>

      <View testID="growth-hygiene-batch-selection" style={{ gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.line }}>
        <Text style={{ color: colors.text }}>일괄 선택</Text>
        <Text style={{ color: colors.muted }}>
          선택 {hygieneState.batchSelection.selectedCount}/{hygieneState.batchSelection.availableCount}건
        </Text>
        <Text style={{ color: colors.muted }}>
          {hygieneState.batchSelection.decisions.map((item) => `${item.targetId}:${item.action}`).join(', ') || hygieneState.batchSelection.emptyMessage}
        </Text>
      </View>
    </View>
  );
}
