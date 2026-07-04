const historyLabels = {
  'approval.created': '승인 카드 생성',
  'approval.renewed': '만료 시간 연장',
  'approval.expired': '승인 카드 만료',
  'approval.expired.blocked': '만료 결정 차단',
  'approval.decision.blocked': '모바일 결정 차단',
  'approval.pc_handoff.requested': 'PC 확인 요청',
  'approval.decision.sent': '승인 결정 전송',
  'approval.decision.received': '승인 결정 수신',
  'approval.cancelled': '승인 카드 취소',
  'approval.re_requested': '새 승인 재요청',
  'approval.replacement.created': '대체 승인 카드 생성'
};

export function createApprovalHistoryEvent({
  approvalId,
  taskId,
  eventType,
  label,
  status = null,
  actor = 'C_MOBILE',
  detail = null,
  reason = null,
  createdAt = new Date().toISOString(),
  metadata = {}
}) {
  return {
    eventId: `hist_${String(approvalId ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_')}_${String(eventType ?? 'event').replace(/[^a-zA-Z0-9_]/g, '_')}_${Date.parse(createdAt) || Date.now()}`,
    approvalId,
    taskId,
    eventType,
    label: label ?? historyLabels[eventType] ?? eventType,
    status,
    actor,
    detail,
    reason,
    createdAt,
    metadata
  };
}

export function appendApprovalHistory(historyById = {}, approvalId, events = []) {
  const incoming = Array.isArray(events) ? events : [events];
  const current = Array.isArray(historyById?.[approvalId]) ? historyById[approvalId] : [];
  return {
    ...historyById,
    [approvalId]: mergeApprovalHistoryItems([...current, ...incoming]).slice(-40)
  };
}

export function createApprovalTimeline(card, { history = [], lastDecision = null, now = new Date() } = {}) {
  if (!card) return [];
  const derived = [];
  const baselineAt = card.createdAt ?? card.issuedAt ?? card.expiresAt ?? toIso(now);
  derived.push(createApprovalHistoryEvent({
    approvalId: card.approvalId,
    taskId: card.taskId,
    eventType: 'approval.created',
    status: card.status ?? 'pending',
    actor: 'A_CORE',
    detail: card.interpretedIntent,
    createdAt: baselineAt
  }));

  if (card.cancelledAt || card.status === 'cancelled') {
    derived.push(createApprovalHistoryEvent({
      approvalId: card.approvalId,
      taskId: card.taskId,
      eventType: 'approval.cancelled',
      status: 'cancelled',
      actor: 'C_MOBILE',
      reason: card.cancelReason ?? null,
      createdAt: card.cancelledAt ?? toIso(now)
    }));
  }

  if (card.status === 'expired') {
    derived.push(createApprovalHistoryEvent({
      approvalId: card.approvalId,
      taskId: card.taskId,
      eventType: 'approval.expired',
      status: 'expired',
      actor: 'E_POLICY',
      createdAt: toIso(now)
    }));
  }

  if (lastDecision?.approvalId === card.approvalId) {
    derived.push(createApprovalHistoryEvent({
      approvalId: card.approvalId,
      taskId: card.taskId,
      eventType: lastDecision.blocked ? 'approval.decision.blocked' : 'approval.decision.sent',
      status: lastDecision.blocked ? 'blocked' : lastDecision.decision,
      actor: 'C_MOBILE',
      detail: lastDecision.decision,
      reason: lastDecision.reason ?? null,
      createdAt: lastDecision.decidedAt ?? toIso(now),
      metadata: {
        replacementApprovalId: lastDecision.replacementApprovalId ?? null
      }
    }));
  }

  return mergeApprovalHistoryItems([
    ...history.map((item, index) => normalizeApprovalHistoryItem(item, index, card)),
    ...derived
  ]);
}

export function mergeApprovalHistoryItems(items = []) {
  const byKey = new Map();
  for (const item of items.filter(Boolean)) {
    const key = item.eventId ?? `${item.approvalId}:${item.eventType}:${item.createdAt}:${item.status ?? ''}`;
    byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => {
    const left = Date.parse(a.createdAt ?? '') || 0;
    const right = Date.parse(b.createdAt ?? '') || 0;
    if (left !== right) return left - right;
    return String(a.eventId ?? '').localeCompare(String(b.eventId ?? ''));
  });
}

export function approvalHistoryTone(item) {
  if (item.eventType?.includes('blocked') || item.status === 'blocked') return 'warning';
  if (item.eventType?.includes('cancel') || item.status === 'cancelled') return 'danger';
  if (item.eventType?.includes('pc_handoff')) return 'warning';
  if (item.eventType?.includes('renew') || item.eventType?.includes('created')) return 'good';
  return 'neutral';
}

function normalizeApprovalHistoryItem(item, index, card) {
  const eventType = item.eventType ?? item.type ?? 'approval.event';
  return {
    eventId: item.eventId ?? `hist_${card?.approvalId ?? item.approvalId ?? 'unknown'}_${index}`,
    approvalId: item.approvalId ?? card?.approvalId ?? null,
    taskId: item.taskId ?? card?.taskId ?? null,
    eventType,
    label: item.label ?? historyLabels[eventType] ?? eventType,
    status: item.status ?? null,
    actor: item.actor ?? item.source ?? null,
    detail: item.detail ?? item.decision ?? null,
    reason: item.reason ?? null,
    createdAt: item.createdAt ?? item.recordedAt ?? toIso(new Date()),
    metadata: item.metadata ?? {}
  };
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
