import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';
import { createPoisonQueueActionState, createPoisonQueueSummaryState } from './PoisonQueueActionPanel.js';

type PoisonQueueItem = {
  queueId: string;
  taskId?: string | null;
  packetId?: string | null;
  toolName?: string | null;
  status: string;
  reviewStatus?: string | null;
  reason?: string | null;
  attempts?: number;
  quarantinedAt?: string | null;
  error?: { code?: string; message?: string } | null;
};

type QueueSummary = {
  total?: number;
  queued?: number;
  retryScheduled?: number;
  running?: number;
  succeeded?: number;
  quarantined?: number;
  ignored?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  next?: PoisonQueueItem[];
  deadLetters?: PoisonQueueItem[];
};

type Props = {
  queue?: QueueSummary | null;
  items?: PoisonQueueItem[];
  selectedItem?: PoisonQueueItem | null;
  readiness?: unknown;
  loading?: boolean;
  error?: { code?: string; message?: string } | null;
  onAction?: (action: 'review' | 'requeue' | 'ignore', queueId: string) => void;
};

export function PoisonQueueActionPanel({
  queue = null,
  items = [],
  selectedItem = null,
  readiness,
  loading = false,
  error = null,
  onAction
}: Props) {
  const summary = createPoisonQueueSummaryState({ queue, items, loading, error });
  const item = selectedItem ?? items.find((candidate) => candidate.status === 'quarantined') ?? null;
  const state = createPoisonQueueActionState({ item, readiness });

  if (summary.loading) {
    return (
      <View testID="poison-queue-loading" style={{ padding: spacing.lg, borderWidth: 1, borderColor: colors.line }}>
        <Text style={{ color: colors.muted }}>격리 큐 불러오는 중</Text>
      </View>
    );
  }

  if (summary.error) {
    return (
      <View testID="poison-queue-error" style={{ padding: spacing.lg, borderWidth: 1, borderColor: colors.danger }}>
        <Text style={{ color: colors.danger }}>{summary.error.message ?? summary.error.code ?? '격리 큐 오류'}</Text>
      </View>
    );
  }

  if (summary.empty) {
    return (
      <View testID="poison-queue-empty" style={{ padding: spacing.lg, borderWidth: 1, borderColor: colors.line }}>
        <Text style={{ color: colors.muted }}>검토할 격리 패킷 없음</Text>
      </View>
    );
  }

  const actions = [state.primaryAction, state.recoveryAction, state.destructiveAction];
  const actionTestIds = {
    review: 'poison-action-review',
    requeue: 'poison-action-requeue',
    ignore: 'poison-action-ignore'
  };

  return (
    <View testID="poison-queue-action-panel" style={{ gap: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ gap: spacing.xs }}>
        <Text testID="poison-queue-status" style={{ color: summary.attentionRequired ? colors.warning : colors.accent }}>
          {summary.status}
        </Text>
        <Text style={{ color: colors.muted }}>
          총 {summary.metrics.total} · 격리 {summary.metrics.quarantined} · 재시도 {summary.metrics.retryScheduled}
        </Text>
        <Text style={{ color: colors.muted }}>
          정책 {summary.retryPolicy.maxAttempts ?? '-'}회 / {summary.retryPolicy.baseBackoffMs ?? '-'}ms
        </Text>
        <Text testID="poison-queue-visual-regression" style={{ color: summary.visualRegression.status === 'passed' ? colors.accent : colors.warning }}>
          Visual {summary.visualRegression.status} · {summary.visualSnapshot.accessibility.label}
        </Text>
      </View>

      {item ? (
        <View testID="poison-queue-selected-item" style={{ gap: spacing.xs, padding: spacing.sm, backgroundColor: colors.surface }}>
          <Text style={{ color: colors.text }}>{item.taskId ?? item.queueId}</Text>
          <Text style={{ color: colors.muted }}>{item.error?.code ?? item.reason ?? item.status}</Text>
          <Text style={{ color: colors.muted }}>시도 {item.attempts ?? 0}</Text>
        </View>
      ) : null}

      {state.blockedReason ? (
        <Text testID="poison-queue-blocked-reason" style={{ color: colors.warning }}>{state.blockedReason}</Text>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {actions.map((action) => (
          <TouchableOpacity
            key={action.action}
            testID={actionTestIds[action.action as keyof typeof actionTestIds]}
            disabled={!action.enabled || !state.queueId}
            onPress={() => state.queueId ? onAction?.(action.action, state.queueId) : undefined}
            style={{
              paddingVertical: spacing.sm,
              paddingHorizontal: spacing.md,
              borderWidth: 1,
              borderColor: action.enabled ? colors.accent : colors.line,
              backgroundColor: action.action === 'ignore' ? colors.surface : colors.surfaceMuted,
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
