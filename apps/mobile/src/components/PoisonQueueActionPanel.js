export function createPoisonQueueActionState({ item, readiness } = {}) {
  const exists = Boolean(item?.queueId);
  const sessionLocked = readiness?.allowed === false;
  const actionable = item?.status === 'quarantined';
  const alreadyReviewed = item?.reviewStatus === 'reviewed';
  const blockedReason = !exists
    ? '검토할 패킷을 선택해야 합니다.'
    : !actionable
      ? '격리 상태의 패킷만 처리할 수 있습니다.'
      : sessionLocked
        ? '모바일 세션 잠금 해제가 필요합니다.'
        : null;

  return {
    queueId: item?.queueId ?? null,
    taskId: item?.taskId ?? null,
    packetId: item?.packetId ?? null,
    status: item?.status ?? 'not_selected',
    reviewStatus: item?.reviewStatus ?? null,
    reason: item?.reason ?? null,
    errorCode: item?.error?.code ?? null,
    quarantinedAt: item?.quarantinedAt ?? null,
    blockedReason,
    primaryAction: {
      action: 'review',
      label: alreadyReviewed ? '검토됨' : '검토 완료',
      enabled: exists && actionable && !sessionLocked && !alreadyReviewed,
      blockedReason: alreadyReviewed ? '이미 검토 완료 상태입니다.' : blockedReason
    },
    recoveryAction: {
      action: 'requeue',
      label: '수정 후 재시도',
      enabled: exists && actionable && !sessionLocked,
      blockedReason
    },
    destructiveAction: {
      action: 'ignore',
      label: '무시',
      enabled: exists && actionable && !sessionLocked,
      blockedReason
    },
    facts: {
      attempts: item?.attempts ?? 0,
      toolName: item?.toolName ?? null,
      hasError: Boolean(item?.error),
      needsReview: item?.reviewStatus === 'needs_review',
      sessionReady: readiness?.allowed !== false
    }
  };
}

export function createPoisonQueueSummaryState({ queue = null, items = [], loading = false, error = null } = {}) {
  const quarantined = queue?.quarantined ?? items.filter((item) => item.status === 'quarantined').length;
  const ignored = queue?.ignored ?? items.filter((item) => item.status === 'ignored').length;
  const queued = queue?.queued ?? items.filter((item) => item.status === 'queued').length;
  const retryScheduled = queue?.retryScheduled ?? items.filter((item) => item.status === 'retry_scheduled').length;
  const status = error
    ? 'error'
    : loading
      ? 'loading'
      : quarantined > 0
        ? 'needs_review'
        : retryScheduled > 0
          ? 'retry_scheduled'
          : 'clear';
  return {
    status,
    loading,
    error,
    empty: !loading && !error && items.length === 0,
    attentionRequired: status === 'needs_review',
    visualSnapshot: createPoisonQueueVisualSnapshot({ status, queue, items, error, loading }),
    visualRegression: createPoisonQueueVisualRegressionReport({
      snapshots: [createPoisonQueueVisualSnapshot({ status, queue, items, error, loading })]
    }),
    metrics: {
      total: queue?.total ?? items.length,
      queued,
      retryScheduled,
      quarantined,
      ignored,
      running: queue?.running ?? items.filter((item) => item.status === 'running').length,
      succeeded: queue?.succeeded ?? items.filter((item) => item.status === 'succeeded').length
    },
    retryPolicy: {
      maxAttempts: queue?.maxAttempts ?? null,
      baseBackoffMs: queue?.baseBackoffMs ?? null
    },
    nextQueueIds: (queue?.next ?? []).map((item) => item.queueId).filter(Boolean),
    deadLetterQueueIds: (queue?.deadLetters ?? items.filter((item) => item.status === 'quarantined'))
      .map((item) => item.queueId)
      .filter(Boolean)
  };
}

export function createPoisonQueueVisualSnapshot({ status, queue = null, items = [], error = null, loading = false } = {}) {
  const quarantined = queue?.quarantined ?? items.filter((item) => item.status === 'quarantined').length;
  const retryScheduled = queue?.retryScheduled ?? items.filter((item) => item.status === 'retry_scheduled').length;
  const ignored = queue?.ignored ?? items.filter((item) => item.status === 'ignored').length;
  const total = queue?.total ?? items.length;
  const tone = error ? 'danger' : loading ? 'muted' : quarantined > 0 ? 'warning' : retryScheduled > 0 ? 'info' : 'clear';
  const badgeLabel = error ? '오류' : loading ? '갱신 중' : quarantined > 0 ? `${quarantined}건 검토` : retryScheduled > 0 ? `${retryScheduled}건 재시도` : '정상';
  return {
    snapshotVersion: 'c-poison-queue-visual-snapshot-v1',
    surface: 'PoisonQueueScreen',
    status,
    tone,
    badgeLabel,
    attentionPulse: quarantined > 0,
    progressRole: loading ? 'indeterminate' : 'static',
    emptyStateVisible: !loading && !error && items.length === 0,
    actionBarEnabled: !loading && !error,
    metrics: {
      total,
      quarantined,
      retryScheduled,
      ignored
    },
    stableLayout: {
      summaryBand: true,
      selectedItemPanel: items.length > 0,
      actionBar: !loading && !error,
      minTouchTargetDp: 44
    },
    accessibility: {
      liveRegion: quarantined > 0 ? 'polite' : 'none',
      label: `운영 오류 큐 ${badgeLabel}`,
      actionHint: quarantined > 0 ? '검토 완료, 수정 후 재시도, 무시 중 하나를 선택합니다.' : '격리 패킷이 없으면 대기합니다.'
    }
  };
}

export function createPoisonQueueVisualBaseline() {
  return {
    baselineVersion: 'c-poison-queue-visual-baseline-v1',
    surface: 'PoisonQueueScreen',
    requiredSnapshotVersion: 'c-poison-queue-visual-snapshot-v1',
    requiredStates: ['needs_review', 'clear'],
    invariants: [
      'needs_review state must expose warning tone and attention pulse',
      'clear state must expose clear tone and no attention pulse',
      'action bar remains stable outside loading/error states',
      'accessibility label names the operational queue status'
    ]
  };
}

export function createPoisonQueueVisualRegressionReport({
  baseline = createPoisonQueueVisualBaseline(),
  snapshots = []
} = {}) {
  const normalized = snapshots.filter(Boolean);
  const checks = [
    {
      id: 'snapshot-version-present',
      passed: normalized.every((snapshot) => snapshot.snapshotVersion === baseline.requiredSnapshotVersion),
      actual: normalized.map((snapshot) => snapshot.snapshotVersion)
    },
    {
      id: 'needs-review-warning-contract',
      passed: normalized
        .filter((snapshot) => snapshot.status === 'needs_review')
        .every((snapshot) => snapshot.tone === 'warning' && snapshot.attentionPulse === true && snapshot.metrics.quarantined > 0),
      actual: normalized.map((snapshot) => ({ status: snapshot.status, tone: snapshot.tone, attentionPulse: snapshot.attentionPulse, quarantined: snapshot.metrics?.quarantined }))
    },
    {
      id: 'clear-state-contract',
      passed: normalized
        .filter((snapshot) => snapshot.status === 'clear')
        .every((snapshot) => snapshot.tone === 'clear' && snapshot.attentionPulse === false),
      actual: normalized.map((snapshot) => ({ status: snapshot.status, tone: snapshot.tone, attentionPulse: snapshot.attentionPulse }))
    },
    {
      id: 'stable-action-layout',
      passed: normalized.every((snapshot) => snapshot.stableLayout?.minTouchTargetDp >= 44 && snapshot.stableLayout?.actionBar === snapshot.actionBarEnabled),
      actual: normalized.map((snapshot) => snapshot.stableLayout)
    },
    {
      id: 'accessibility-label-present',
      passed: normalized.every((snapshot) => String(snapshot.accessibility?.label ?? '').includes('운영 오류 큐')),
      actual: normalized.map((snapshot) => snapshot.accessibility?.label)
    }
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id);
  return {
    reportVersion: 'c-poison-queue-visual-regression-v1',
    surface: baseline.surface,
    status: failedChecks.length === 0 ? 'passed' : 'failed',
    snapshots: normalized,
    checks,
    failedChecks
  };
}

export function createPoisonQueueNotificationUxSnapshot({ notificationStatus = {}, summaryState = null, soak = null } = {}) {
  const items = notificationStatus.items ?? [];
  const poisonItems = items.filter((item) => /^poison\.|^pc_agent\.(queue|poison_queue)/.test(item.eventType ?? ''));
  const deliveryLog = notificationStatus.deliveryLog ?? [];
  const receiptLog = notificationStatus.receiptLog ?? [];
  const queued = poisonItems.filter((item) => item.deliveryStatus === 'queued').length;
  const delivered = poisonItems.filter((item) => item.deliveryStatus !== 'blocked').length;
  const checks = [
    {
      id: 'poison-notification-events-present',
      passed: poisonItems.length > 0,
      actual: poisonItems.map((item) => item.eventType)
    },
    {
      id: 'queued-background-receipts-recoverable',
      passed: (notificationStatus.issueQueue ?? []).length === 0 || receiptLog.some((item) => item.status === 'ok'),
      actual: { issueQueue: notificationStatus.issueQueue ?? [], receiptCount: receiptLog.length }
    },
    {
      id: 'soak-notification-linked',
      passed: !soak || poisonItems.some((item) => item.eventType === 'pc_agent.poison_queue.soak.passed' || item.eventType === 'pc_agent.poison_queue.soak.failed'),
      actual: { soakSuccess: soak?.success ?? null, eventTypes: poisonItems.map((item) => item.eventType) }
    }
  ];
  return {
    snapshotVersion: 'c-poison-queue-notification-ux-v1',
    queueStatus: summaryState?.status ?? null,
    delivered,
    queued,
    deliveryCount: deliveryLog.length,
    receiptCount: receiptLog.length,
    eventTypes: [...new Set(poisonItems.map((item) => item.eventType))],
    checks,
    passed: checks.every((check) => check.passed)
  };
}

export function createPoisonQueueOperationalEvidence({ before, after, soak, notificationUx } = {}) {
  const snapshots = [
    before?.visualSnapshot ?? before,
    after?.visualSnapshot ?? after,
    soak?.visualSnapshot
  ].filter(Boolean);
  const visualRegression = createPoisonQueueVisualRegressionReport({ snapshots });
  return {
    evidenceVersion: 'c-poison-queue-operational-evidence-v1',
    visualRegression,
    notificationUx,
    soak: soak
      ? {
          success: soak.success,
          cycles: soak.cycles,
          processed: soak.processed,
          stableClear: soak.stableClear
        }
      : null,
    passed: visualRegression.status === 'passed' && (notificationUx?.passed ?? true) && (soak ? soak.success === true : true)
  };
}
