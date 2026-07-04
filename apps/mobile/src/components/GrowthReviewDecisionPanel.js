export function createGrowthReviewDecisionState({
  review,
  pendingActions = {},
  actionErrors = {},
  latencyByAction = {},
  lastDecision = null
} = {}) {
  const preferenceCandidates = review?.preferenceCandidates ?? [];
  return {
    reviewId: review?.reviewId,
    hasCandidates: preferenceCandidates.length > 0,
    lastDecision,
    candidates: preferenceCandidates.map((candidate) => createPreferenceCandidateState({
      candidate,
      pendingActions,
      actionErrors,
      latencyByAction
    })),
    emptyMessage: preferenceCandidates.length ? null : '검토할 선호 후보가 없습니다.'
  };
}

export function createGrowthHygieneDecisionState({
  review,
  pendingActions = {},
  actionErrors = {},
  latencyByAction = {},
  lastDecision = null,
  selectedTargetIds = []
} = {}) {
  const hygiene = review?.hygiene ?? {};
  const reviewQueue = hygiene.reviewQueue ?? [];
  const decisionSummary = hygiene.decisionSummary ?? hygiene.decisionsSummary ?? {};
  const selected = selectHygieneBatchItems(reviewQueue, selectedTargetIds);
  const trendChart = createHygieneTrendChart({ hygiene, reviewQueue, decisionSummary });
  return {
    reviewId: review?.reviewId,
    hasItems: reviewQueue.length > 0,
    queueCount: reviewQueue.length,
    lastDecision,
    trendChart,
    trend: {
      queueCount: reviewQueue.length,
      sensitiveCount: reviewQueue.filter((item) => /sensitive|privacy|redact|민감/i.test(`${item.reason ?? ''} ${item.recommendedAction ?? ''}`)).length,
      staleCount: reviewQueue.filter((item) => /stale|old|retention|오래/i.test(String(item.reason ?? ''))).length,
      decisionSummary
    },
    items: reviewQueue.map((item) => createHygieneQueueItemState({
      item,
      pendingActions,
      actionErrors,
      latencyByAction
    })),
    batchSelection: createHygieneBatchSelectionState({
      reviewQueue,
      selectedTargetIds: selected.map((item) => item.targetId)
    }),
    emptyMessage: reviewQueue.length ? null : '검토할 기억 위생 항목이 없습니다.'
  };
}

export function createGrowthConflictResolutionState({
  review,
  selectedHypothesisId = null,
  acknowledgedHypothesisIds = []
} = {}) {
  const candidates = review?.preferenceCandidates ?? [];
  const conflicts = candidates
    .map((candidate) => createPreferenceCandidateState({
      candidate,
      pendingActions: {},
      actionErrors: {},
      latencyByAction: {}
    }))
    .filter((candidate) => candidate.contradiction.hasConflicts);
  const selected = conflicts.find((candidate) => candidate.hypothesisId === selectedHypothesisId) ?? conflicts[0] ?? null;
  const acknowledged = new Set(acknowledgedHypothesisIds);
  return {
    modalVersion: 'c-growth-conflict-resolution-modal-v1',
    explanationVersion: 'c-growth-preference-conflict-explanation-v1',
    reviewId: review?.reviewId,
    hasConflicts: conflicts.length > 0,
    conflictCount: conflicts.length,
    selectedHypothesisId: selected?.hypothesisId ?? null,
    selected,
    visible: Boolean(selected),
    confirmBlockedUntilAcknowledged: Boolean(selected) && !acknowledged.has(selected.hypothesisId),
    acknowledgement: selected
      ? {
          hypothesisId: selected.hypothesisId,
          required: true,
          acknowledged: acknowledged.has(selected.hypothesisId),
          label: '충돌 근거를 확인했습니다'
        }
      : null,
    explanationPanel: createPreferenceConflictExplanationState({ candidate: selected, review }),
    toleranceVisualization: createPreferenceToleranceVisualization(review?.preferenceToleranceProfile, selected),
    confidenceCalibration: review?.preferenceConfidenceCalibration
      ? {
          reportVersion: review.preferenceConfidenceCalibration.reportVersion,
          meanCalibrationError: review.preferenceConfidenceCalibration.meanCalibrationError,
          candidateCount: review.preferenceConfidenceCalibration.candidateCount,
          privacy: review.preferenceConfidenceCalibration.privacy
        }
      : null,
    resolutionOptions: selected?.contradiction.resolutionOptions ?? [],
    conflicts
  };
}

export function createConfirmedPreferenceProductGateState({ review, productGate = review?.confirmedPreferenceProductGate } = {}) {
  const gate = productGate ?? {};
  const conflictDossier = gate.conflictDossier ?? {};
  const driftTrend = gate.driftTrend ?? {};
  const migrationReviewQueue = gate.migrationReviewQueue ?? {};
  const applicationPreview = gate.applicationPreview ?? {};
  const checks = gate.checks ?? [];
  return {
    gateVersion: 'c-confirmed-preference-product-gate-state-v1',
    productGateVersion: gate.productGateVersion ?? null,
    status: gate.status ?? 'unknown',
    passed: gate.status === 'passed',
    reviewId: review?.reviewId ?? null,
    summary: {
      confirmedPreferenceCount: applicationPreview.matchedCount ?? review?.confirmedPreferences?.length ?? 0,
      conflictCount: conflictDossier.conflictCount ?? 0,
      highSeverityConflictCount: conflictDossier.highSeverityCount ?? 0,
      migrationQueueCount: migrationReviewQueue.queueCount ?? 0,
      driftStatus: driftTrend.status ?? 'unknown',
      driftScore: driftTrend.driftScore ?? null
    },
    sections: [
      {
        sectionId: 'application-preview',
        title: '확정 선호 적용 미리보기',
        ready: applicationPreview.previewVersion === 'f-confirmed-preference-application-preview-v1',
        itemCount: applicationPreview.planningHints?.length ?? 0
      },
      {
        sectionId: 'conflict-dossier',
        title: '충돌 해결 근거',
        ready: conflictDossier.dossierVersion === 'f-confirmed-preference-conflict-resolution-dossier-v1',
        itemCount: conflictDossier.conflictCount ?? 0
      },
      {
        sectionId: 'drift-trend',
        title: '선호 변화 추세',
        ready: driftTrend.trendVersion === 'f-confirmed-preference-drift-trend-v1',
        itemCount: driftTrend.items?.length ?? 0
      },
      {
        sectionId: 'migration-review',
        title: '스코프 이전 검토',
        ready: migrationReviewQueue.queueVersion === 'f-confirmed-preference-scope-migration-review-queue-v1',
        itemCount: migrationReviewQueue.queueCount ?? 0
      }
    ],
    actions: ['approve_scope_migration', 'reject_scope_migration', 'defer'].map((action) => ({
      action,
      label: confirmedPreferenceGateActionLabel(action),
      enabled: gate.status === 'passed' && (migrationReviewQueue.queueCount ?? 0) > 0
    })),
    failedChecks: checks.filter((check) => check.passed === false).map((check) => check.checkId)
  };
}

export function createFailureGuardrailReviewState({ review, productGate = review?.failureMemoryProductGate } = {}) {
  const gate = productGate ?? {};
  const reviewQueue = gate.reviewQueue ?? {};
  const recurrenceVisualization = gate.recurrenceVisualization ?? {};
  const effectivenessTuning = gate.effectivenessTuning ?? {};
  const checks = gate.checks ?? [];
  return {
    stateVersion: 'c-failure-guardrail-review-state-v1',
    productGateVersion: gate.productGateVersion ?? null,
    status: gate.status ?? 'unknown',
    passed: gate.status === 'passed',
    reviewId: review?.reviewId ?? null,
    summary: {
      queueCount: reviewQueue.queueCount ?? 0,
      criticalCount: reviewQueue.criticalCount ?? 0,
      recurrenceStatus: recurrenceVisualization.status ?? 'unknown',
      averageEffectivenessScore: effectivenessTuning.averageEffectivenessScore ?? null,
      reviewedCount: effectivenessTuning.reviewedCount ?? 0
    },
    chart: {
      visualizationVersion: recurrenceVisualization.visualizationVersion ?? null,
      pointCount: recurrenceVisualization.points?.length ?? 0,
      chartContract: recurrenceVisualization.uiContract?.contractVersion ?? null
    },
    items: (reviewQueue.items ?? []).map((item) => ({
      ...item,
      tone: item.severity === 'critical' ? 'danger' : item.severity === 'high' ? 'warning' : 'attention',
      actions: (reviewQueue.uiContract?.decisionActions ?? ['keep', 'update', 'disable', 'defer']).map((action) => ({
        action,
        label: failureGuardrailActionLabel(action),
        recommended: action === item.recommendedAction || (action === 'update' && item.recommendedAction === 'update_guardrail'),
        enabled: true
      }))
    })),
    failedChecks: checks.filter((check) => check.passed === false).map((check) => check.checkId)
  };
}

export function createGenomeProductGateState({ review, productGate = review?.genomeProductGate } = {}) {
  const gate = productGate ?? {};
  const dashboard = gate.dashboard ?? {};
  const summary = dashboard.summary ?? {};
  const calibration = gate.calibration ?? dashboard.calibration ?? {};
  const drift = gate.driftDiff ?? dashboard.drift ?? {};
  const alerts = gate.alerts ?? dashboard.alerts ?? {};
  const checks = gate.checks ?? [];
  return {
    stateVersion: 'c-genome-product-gate-state-v1',
    productGateVersion: gate.productGateVersion ?? null,
    status: gate.status ?? 'unknown',
    passed: gate.status === 'passed',
    reviewId: review?.reviewId ?? null,
    summary: {
      schemaVersion: summary.schemaVersion ?? gate.genomes?.schemaVersion ?? null,
      workflowCount: summary.workflowCount ?? gate.genomes?.workflowGenome?.length ?? 0,
      preferenceCount: summary.preferenceCount ?? gate.genomes?.preferenceGenome?.length ?? 0,
      riskPosture: summary.riskPosture ?? gate.genomes?.riskCalibration?.posture ?? 'unknown',
      approvalRate: summary.approvalRate ?? gate.genomes?.decisionGenome?.approvalRate ?? null,
      alertCount: summary.alertCount ?? alerts.alerts?.length ?? 0
    },
    calibrationPanel: {
      profileVersion: calibration.profileVersion ?? null,
      uiContract: calibration.uiContract?.contractVersion ?? null,
      thresholds: calibration.thresholds ?? {}
    },
    driftPanel: {
      diffVersion: drift.diffVersion ?? null,
      status: drift.status ?? 'unknown',
      riskPostureChanged: drift.riskPostureChanged === true,
      approvalRateDrop: drift.approvalRateDrop === true,
      delta: drift.delta ?? {}
    },
    alertPanel: {
      alertVersion: alerts.alertVersion ?? null,
      status: alerts.status ?? 'unknown',
      items: alerts.alerts ?? []
    },
    tabs: dashboard.uiContract?.tabs ?? ['workflow', 'preference', 'decision', 'risk', 'drift'],
    failedChecks: checks.filter((check) => check.passed === false).map((check) => check.checkId)
  };
}

export function createPreferenceConflictExplanationState({ candidate = null, review = null } = {}) {
  const explanations = candidate?.conflictExplanations ?? [];
  const summary = candidate?.semanticConflictSummary ?? {};
  return {
    panelVersion: 'c-growth-preference-conflict-explanation-v1',
    reviewId: review?.reviewId,
    hypothesisId: candidate?.hypothesisId ?? null,
    visible: Boolean(candidate),
    status: summary.status ?? (explanations.length ? 'conflict_review' : 'clear'),
    highestSeverity: summary.highestSeverity ?? candidate?.contradiction?.severity ?? 'none',
    contradictionCount: summary.contradictionCount ?? explanations.length,
    relationships: summary.relationships ?? {},
    rows: explanations.map((item) => ({
      eventId: item.eventId,
      relationship: item.relationship,
      severity: item.severity,
      rationale: item.rationale,
      conflicts: (item.conflicts ?? []).map((conflict) => ({
        dimension: conflict.dimension,
        existing: conflict.existing,
        candidate: conflict.candidate,
        severity: conflict.severity,
        label: conflict.semanticLabel
      }))
    })),
    decisionGuidance: explanations.length
      ? 'review_conflict_before_confirm'
      : 'safe_to_confirm_if_support_is_sufficient',
    confirmRequiresAcknowledgement: explanations.length > 0
  };
}

export function createGrowthReviewVisualSnapshot({
  review,
  hygieneDecisionState = createGrowthHygieneDecisionState({ review }),
  conflictResolutionState = createGrowthConflictResolutionState({ review })
} = {}) {
  const decisionState = createGrowthReviewDecisionState({ review });
  const checks = [
    {
      id: 'preference-actions-rendered',
      passed: !decisionState.hasCandidates || decisionState.candidates.every((candidate) => candidate.actions.length >= 2),
      actual: decisionState.candidates.map((candidate) => ({ hypothesisId: candidate.hypothesisId, actions: candidate.actions.length }))
    },
    {
      id: 'hygiene-trend-chart-rendered',
      passed: hygieneDecisionState.trendChart.chartVersion === 'c-growth-hygiene-trend-chart-v1' && hygieneDecisionState.trendChart.points.length >= 3,
      actual: hygieneDecisionState.trendChart
    },
    {
      id: 'batch-selection-contract-rendered',
      passed: hygieneDecisionState.batchSelection.selectionVersion === 'c-growth-hygiene-batch-selection-v1',
      actual: hygieneDecisionState.batchSelection
    },
    {
      id: 'conflict-modal-contract-rendered',
      passed: conflictResolutionState.modalVersion === 'c-growth-conflict-resolution-modal-v1'
        && (!conflictResolutionState.hasConflicts || conflictResolutionState.confirmBlockedUntilAcknowledged === true),
      actual: {
        conflictCount: conflictResolutionState.conflictCount,
        visible: conflictResolutionState.visible,
        confirmBlockedUntilAcknowledged: conflictResolutionState.confirmBlockedUntilAcknowledged
      }
    }
  ];
  return {
    snapshotVersion: 'c-growth-review-visual-snapshot-v1',
    surface: 'GrowthReviewScreen',
    preferenceCandidateCount: decisionState.candidates.length,
    hygieneQueueCount: hygieneDecisionState.queueCount,
    selectedBatchCount: hygieneDecisionState.batchSelection.selectedCount,
    conflictCount: conflictResolutionState.conflictCount,
    checks,
    passed: checks.every((check) => check.passed)
  };
}

export function createGrowthMaturityReviewState({ review } = {}) {
  const score = review?.maturityScore ?? null;
  const alerts = score?.thresholdAlerts ?? [];
  const trend = score?.trend ?? {};
  const latest = trend.latest ?? null;
  const previous = trend.previous ?? null;
  const verification = score?.learningVerification ?? {};
  const total = score?.total ?? 0;
  return {
    hasScore: Boolean(score),
    total,
    level: score?.level ?? 'unknown',
    levelLabel: maturityLevelLabel(score?.level),
    thresholdStatus: score?.thresholdStatus ?? 'unknown',
    tone: alerts.some((alert) => alert.severity === 'critical' || alert.severity === 'high')
      ? 'warning'
      : total >= 80
        ? 'good'
        : 'neutral',
    dimensions: score?.dimensions ?? {},
    learningVerification: {
      linked: verification.linked === true,
      verifierId: verification.verifierId ?? 'G.LearningVerifier',
      status: verification.status ?? 'not_configured',
      passRatePercent: Number.isFinite(verification.passRate) ? Math.round(verification.passRate * 100) : null,
      failed: verification.failed ?? 0,
      criticalFailed: verification.criticalFailed ?? 0
    },
    alerts: alerts.map((alert) => ({
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      threshold: alert.threshold,
      actual: alert.actual
    })),
    trend: {
      latestTotal: latest?.total ?? total,
      previousTotal: previous?.total ?? null,
      deltaTotal: trend.delta?.total ?? null,
      historyCount: trend.history?.length ?? 0,
      verificationStatus: latest?.verificationStatus ?? verification.status ?? 'not_configured'
    },
    nextActions: score?.nextActions ?? []
  };
}

export function createMaturityProductGateState({ review, productGate = review?.maturityProductGate } = {}) {
  const gate = productGate ?? {};
  const dashboard = gate.dashboard ?? {};
  const profile = gate.thresholdProfile ?? dashboard.thresholdProfile ?? {};
  const migrationDiff = gate.migrationDiff ?? {};
  const score = gate.score ?? dashboard.score ?? review?.maturityScore ?? {};
  const checks = gate.checks ?? [];
  return {
    stateVersion: 'c-maturity-product-gate-state-v1',
    productGateVersion: gate.productGateVersion ?? null,
    status: gate.status ?? 'unknown',
    passed: gate.status === 'passed',
    reviewId: review?.reviewId ?? null,
    score: {
      total: score.total ?? 0,
      level: score.level ?? 'unknown',
      thresholdStatus: score.thresholdStatus ?? 'unknown',
      dimensions: score.dimensions ?? {}
    },
    thresholdProfile: {
      profileVersion: profile.profileVersion ?? null,
      uiContract: profile.uiContract?.contractVersion ?? null,
      thresholds: profile.thresholds ?? {}
    },
    migration: {
      diffVersion: migrationDiff.diffVersion ?? null,
      migrationRequired: migrationDiff.migrationRequired === true,
      changedFields: migrationDiff.changedFields ?? []
    },
    dashboard: {
      dashboardVersion: dashboard.dashboardVersion ?? null,
      uiContract: dashboard.uiContract?.contractVersion ?? null,
      panels: dashboard.uiContract?.panels ?? []
    },
    failedChecks: checks.filter((check) => check.passed === false).map((check) => check.checkId)
  };
}

export function createSkillDraftReviewState({
  review,
  pendingActions = {},
  actionErrors = {},
  lastDecision = null
} = {}) {
  const drafts = review?.skillDistillations ?? review?.skillRegistry?.drafts ?? [];
  const registryEntries = review?.skillRegistry?.registryEntries ?? [];
  return {
    stateVersion: 'c-skill-draft-review-ui-v1',
    reviewId: review?.reviewId,
    hasDrafts: drafts.length > 0,
    draftCount: drafts.length,
    approvedCount: registryEntries.length,
    lastDecision,
    drafts: drafts.map((draft) => ({
      draftId: draft.distilledSkillId,
      title: draft.title,
      status: draft.status,
      confidencePercent: Math.round((draft.confidence ?? 0) * 100),
      evidenceCount: draft.evidenceEventIds?.length ?? 0,
      safetyConstraints: draft.safetyConstraints ?? [],
      policy: {
        executableByDefault: false,
        requiresUserReview: true,
        requiresPolicyCheck: true
      },
      actions: [
        {
          actionKey: 'approve_skill_draft',
          label: '승인',
          enabled: !pendingActions[draft.distilledSkillId],
          payload: { draftId: draft.distilledSkillId, decision: 'approve' }
        },
        {
          actionKey: 'reject_skill_draft',
          label: '거절',
          enabled: !pendingActions[draft.distilledSkillId],
          payload: { draftId: draft.distilledSkillId, decision: 'reject' }
        }
      ],
      pending: Boolean(pendingActions[draft.distilledSkillId]),
      error: actionErrors[draft.distilledSkillId] ?? null
    })),
    registryEntries,
    usefulnessReport: review?.skillRegistry?.usefulnessReport ?? null,
    emptyMessage: drafts.length ? null : '검토할 스킬 초안이 없습니다.'
  };
}

export function createAutonomyCandidateReviewState({
  review,
  lifecycle = null,
  pendingActions = {},
  actionErrors = {},
  lastDecision = null
} = {}) {
  const source = lifecycle ?? review?.autonomyLifecycle ?? {};
  const candidates = source.items ?? review?.autonomyCandidates ?? [];
  return {
    stateVersion: 'c-autonomy-candidate-review-ui-v1',
    reviewId: review?.reviewId,
    lifecycleVersion: source.lifecycleVersion ?? 'f-autonomy-candidate-lifecycle-v2',
    hasCandidates: candidates.length > 0,
    candidateCount: candidates.length,
    trend: source.trend ?? null,
    lastDecision,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      title: candidate.title,
      status: candidate.status,
      readinessPercent: candidate.readinessScore ?? 0,
      riskTier: candidate.riskTier,
      expiresAt: candidate.expiresAt,
      evidence: candidate.evidence,
      policyDecision: candidate.policyDecision ?? candidate.lifecycle?.policyDecision ?? null,
      reviewRequired: !['user_approved', 'user_rejected', 'expired'].includes(candidate.status),
      actions: [
        {
          actionKey: 'submit_autonomy_to_policy',
          label: '정책 심사',
          enabled: candidate.status === 'candidate_requires_policy_review' && !pendingActions[candidate.candidateId],
          payload: { candidateId: candidate.candidateId }
        },
        {
          actionKey: 'approve_autonomy_candidate',
          label: '승인',
          enabled: candidate.status === 'policy_approved_pending_user_review' && !pendingActions[candidate.candidateId],
          payload: { candidateId: candidate.candidateId, decision: 'approve' }
        },
        {
          actionKey: 'reject_autonomy_candidate',
          label: '거절',
          enabled: !['user_approved', 'user_rejected', 'expired'].includes(candidate.status) && !pendingActions[candidate.candidateId],
          payload: { candidateId: candidate.candidateId, decision: 'reject' }
        }
      ],
      pending: Boolean(pendingActions[candidate.candidateId]),
      error: actionErrors[candidate.candidateId] ?? null
    })),
    emptyMessage: candidates.length ? null : '검토할 자동화 후보가 없습니다.'
  };
}

export function createPatternClusterReviewState({
  review,
  pendingActions = {},
  actionErrors = {},
  latencyByAction = {},
  lastDecision = null
} = {}) {
  const clusterReview = review?.patternClusterReview ?? {};
  const items = clusterReview.items ?? [];
  const reviewActions = clusterReview.reviewActions ?? ['approve_merge', 'split_cluster', 'keep_separate', 'defer'];
  return {
    reviewId: review?.reviewId,
    reportVersion: clusterReview.reportVersion ?? null,
    status: clusterReview.status ?? 'not_available',
    hasItems: items.length > 0,
    queueCount: items.length,
    mergeCandidateCount: clusterReview.mergeCandidates?.length ?? 0,
    splitCandidateCount: clusterReview.splitCandidates?.length ?? 0,
    corpusSummary: clusterReview.corpusSummary ?? null,
    uiContract: clusterReview.uiContract ?? null,
    lastDecision,
    items: items.map((item) => createPatternClusterReviewItemState({
      item,
      reviewActions,
      pendingActions,
      actionErrors,
      latencyByAction
    })),
    emptyMessage: items.length ? null : '검토할 패턴 cluster 항목이 없습니다.'
  };
}

export function createGrowthDecisionSubmissionState({
  actionKey,
  success = false,
  error = null,
  latencyMs = 0
} = {}) {
  return {
    actionKey,
    success,
    pending: false,
    error,
    latencyMs,
    completedAt: new Date().toISOString()
  };
}

export function createHygieneBatchSelectionState({ reviewQueue = [], selectedTargetIds = [] } = {}) {
  const selectedSet = new Set(selectedTargetIds);
  const selectedItems = reviewQueue.filter((item) => selectedSet.has(item.targetId));
  const decisions = selectedItems.map((item) => ({
    targetType: item.targetType ?? 'memory_event',
    targetId: item.targetId,
    action: item.recommendedAction ?? 'keep'
  }));
  const actionSummary = decisions.reduce((summary, item) => ({
    ...summary,
    [item.action]: (summary[item.action] ?? 0) + 1
  }), {});
  return {
    selectionVersion: 'c-growth-hygiene-batch-selection-v1',
    availableCount: reviewQueue.length,
    selectedCount: selectedItems.length,
    selectedTargetIds: selectedItems.map((item) => item.targetId),
    decisions,
    actionSummary,
    selectionEvent: {
      eventVersion: 'c-growth-hygiene-batch-selection-event-v1',
      routeName: 'growth.hygiene.batch_decision',
      selectedCount: selectedItems.length,
      selectedTargetIds: selectedItems.map((item) => item.targetId),
      actionSummary,
      payloadPreview: {
        decisions,
        reason: 'mobile hygiene batch review'
      }
    },
    canSubmit: decisions.length > 0,
    emptyMessage: reviewQueue.length ? null : '일괄 처리할 위생 항목이 없습니다.'
  };
}

export function createGrowthReviewDecisionActionKey(targetId, decision) {
  return `${targetId}:${decision}`;
}

function createPreferenceCandidateState({ candidate, pendingActions, actionErrors, latencyByAction }) {
  const evidenceEventIds = candidate.evidenceEventIds ?? [];
  const contradictingEventIds = candidate.contradictingEventIds ?? [];
  const contradiction = createContradictionState(candidate);
  return {
    hypothesisId: candidate.hypothesisId,
    statement: candidate.statement,
    confidence: candidate.confidence,
    confidencePercent: Math.round((candidate.confidence ?? 0) * 100),
    confidenceLabel: confidenceLabel(candidate.confidence),
    confidenceExplanation: createConfidenceExplanation(candidate),
    status: candidate.status,
    reviewStatus: contradiction.hasConflicts ? 'needs_conflict_review' : candidate.status,
    evidenceEventIds,
    evidenceSummary: {
      supportCount: evidenceEventIds.length,
      contradictionCount: contradictingEventIds.length,
      supportingEventIds: evidenceEventIds,
      contradictingEventIds
    },
    semanticConflictSummary: candidate.semanticConflictSummary ?? null,
    conflictExplanations: candidate.conflictExplanations ?? [],
    contradiction,
    conflictProfile: candidate.conflictProfile ?? null,
    actions: ['confirm', 'reject'].map((decision) => createPreferenceActionState({
      candidate,
      decision,
      pendingActions,
      actionErrors,
      latencyByAction,
      contradiction
    }))
  };
}

function createHygieneTrendChart({ hygiene = {}, reviewQueue = [], decisionSummary = {} } = {}) {
  const queueCount = reviewQueue.length;
  const sensitiveCount = reviewQueue.filter((item) => /sensitive|privacy|redact|민감|token|phone/i.test(`${item.reason ?? ''} ${item.safePreview ?? ''} ${item.summary ?? ''}`)).length;
  const staleCount = reviewQueue.filter((item) => /stale|old|retention|오래/i.test(String(item.reason ?? ''))).length;
  const decisions = hygiene.decisions ?? [];
  const appliedCount = decisions.length || Object.values(decisionSummary).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const max = Math.max(queueCount, sensitiveCount, staleCount, appliedCount, 1);
  const points = [
    { key: 'queue', label: '검토 대기', value: queueCount, ratio: queueCount / max, tone: queueCount ? 'warning' : 'good' },
    { key: 'sensitive', label: '민감 후보', value: sensitiveCount, ratio: sensitiveCount / max, tone: sensitiveCount ? 'danger' : 'good' },
    { key: 'stale', label: '보존 점검', value: staleCount, ratio: staleCount / max, tone: staleCount ? 'attention' : 'neutral' },
    { key: 'applied', label: '처리 완료', value: appliedCount, ratio: appliedCount / max, tone: appliedCount ? 'good' : 'neutral' }
  ];
  return {
    chartVersion: 'c-growth-hygiene-trend-chart-v1',
    windowLabel: hygiene.trend?.windowLabel ?? '최근 학습 기억',
    max,
    points,
    summary: `${queueCount}건 대기 / ${sensitiveCount}건 민감 / ${appliedCount}건 처리`
  };
}

function selectHygieneBatchItems(reviewQueue, selectedTargetIds) {
  if (selectedTargetIds.length > 0) {
    const selected = new Set(selectedTargetIds);
    return reviewQueue.filter((item) => selected.has(item.targetId));
  }
  return reviewQueue
    .filter((item) => ['redact', 'delete', 'defer'].includes(item.recommendedAction))
    .slice(0, 3);
}

function createPreferenceActionState({ candidate, decision, pendingActions, actionErrors, latencyByAction, contradiction }) {
  const actionKey = createGrowthReviewDecisionActionKey(candidate.hypothesisId, decision);
  const pending = pendingActions[actionKey] === true;
  const actionable = ['candidate', 'conflict_review'].includes(candidate.status);
  return {
    actionKey,
    decision,
    label: decision === 'confirm' ? '확정' : '거절',
    enabled: actionable && !pending,
    pending,
    error: actionErrors[actionKey] ?? null,
    latencyMs: latencyByAction[actionKey] ?? null,
    requiresConflictAcknowledgement: decision === 'confirm' && contradiction.hasConflicts,
    disabledReason: actionable ? null : 'candidate-not-actionable'
  };
}

function createHygieneQueueItemState({ item, pendingActions, actionErrors, latencyByAction }) {
  return {
    ...item,
    explanation: {
      reason: item.reason ?? 'review_required',
      recommendedAction: item.recommendedAction ?? 'keep',
      evidenceEventIds: item.evidenceEventIds ?? [],
      safePreview: item.safePreview ?? item.summary ?? item.targetId
    },
    actions: ['keep', 'delete', 'redact', 'defer'].map((action) => {
      const actionKey = createGrowthReviewDecisionActionKey(item.targetId, action);
      const pending = pendingActions[actionKey] === true;
      return {
        actionKey,
        action,
        label: hygieneActionLabel(action),
        recommended: action === item.recommendedAction,
        enabled: !pending,
        pending,
        error: actionErrors[actionKey] ?? null,
        latencyMs: latencyByAction[actionKey] ?? null
      };
    })
  };
}

function createPatternClusterReviewItemState({ item, reviewActions, pendingActions, actionErrors, latencyByAction }) {
  const title = item.type === 'merge_candidate'
    ? '패턴 병합 후보'
    : item.type === 'split_candidate'
      ? '패턴 분리 후보'
      : '패턴 검토 항목';
  return {
    ...item,
    title,
    tone: item.severity === 'high' ? 'warning' : item.severity === 'medium' ? 'attention' : 'neutral',
    evidenceSummary: {
      patternIds: item.patternIds ?? [],
      rationale: item.rationale,
      severity: item.severity
    },
    actions: reviewActions.map((action) => {
      const actionKey = createGrowthReviewDecisionActionKey(item.reviewItemId, action);
      const pending = pendingActions[actionKey] === true;
      return {
        actionKey,
        action,
        label: patternClusterActionLabel(action),
        recommended: action === item.recommendedAction,
        enabled: !pending,
        pending,
        error: actionErrors[actionKey] ?? null,
        latencyMs: latencyByAction[actionKey] ?? null
      };
    })
  };
}

function createConfidenceExplanation(candidate) {
  const explanation = candidate.explanation ?? {};
  return {
    source: explanation.source ?? 'unknown',
    supportCount: explanation.supportCount ?? (candidate.evidenceEventIds ?? []).length,
    contradictionCount: explanation.contradictionCount ?? (candidate.contradictingEventIds ?? []).length,
    normalizedSignals: explanation.normalizedSignals ?? candidate.conflictProfile?.signals ?? {},
    summary: `${explanation.supportCount ?? (candidate.evidenceEventIds ?? []).length}개 근거 / ${explanation.contradictionCount ?? (candidate.contradictingEventIds ?? []).length}개 충돌`
  };
}

function createContradictionState(candidate) {
  const eventIds = candidate.contradictingEventIds ?? [];
  const summary = candidate.semanticConflictSummary ?? {};
  const explanations = candidate.conflictExplanations ?? [];
  const resolutionOptions = [...new Set(explanations.flatMap((item) => item.resolutionOptions ?? []))];
  return {
    hasConflicts: eventIds.length > 0,
    count: eventIds.length,
    eventIds,
    severity: summary.highestSeverity ?? (eventIds.length > 0 ? 'needs_review' : 'none'),
    classifierId: summary.classifierId ?? null,
    relationships: summary.relationships ?? {},
    resolutionOptions: eventIds.length > 0
      ? [...new Set(['confirm_after_review', 'reject_candidate', 'collect_more_evidence', ...resolutionOptions])]
      : []
  };
}

function createPreferenceToleranceVisualization(profile = null, selected = null) {
  const dimensions = profile?.dimensions ?? [];
  const selectedDimensions = new Set((selected?.conflictExplanations ?? [])
    .flatMap((item) => item.conflicts ?? [])
    .map((item) => item.dimension));
  return {
    visualizationVersion: profile?.visualizationVersion ?? 'f-preference-tolerance-visualization-v1',
    profileVersion: profile?.profileVersion ?? null,
    hasProfile: Boolean(profile),
    averageTolerance: profile?.summary?.averageTolerance ?? null,
    policy: profile?.policy ?? null,
    bars: dimensions.map((item) => ({
      dimension: item.dimension,
      value: item.toleranceScore,
      percent: Math.round((item.toleranceScore ?? 0) * 100),
      posture: item.posture,
      conflictCount: item.conflictCount,
      highlighted: selectedDimensions.has(item.dimension),
      tone: item.posture === 'strict_review' ? 'warning' : item.posture === 'review_before_apply' ? 'attention' : 'good'
    }))
  };
}

function confidenceLabel(confidence = 0) {
  if (confidence >= 0.8) return '높음';
  if (confidence >= 0.6) return '중간';
  return '낮음';
}

function patternClusterActionLabel(action) {
  return {
    approve_merge: '병합 승인',
    split_cluster: '분리',
    keep_separate: '별도 유지',
    defer: '나중에'
  }[action] ?? action;
}

function hygieneActionLabel(action) {
  return {
    keep: '유지',
    delete: '삭제',
    redact: '수정 보관',
    defer: '나중에'
  }[action] ?? action;
}

function confirmedPreferenceGateActionLabel(action) {
  return {
    approve_scope_migration: '스코프 이전 승인',
    reject_scope_migration: '스코프 이전 거절',
    defer: '나중에'
  }[action] ?? action;
}

function failureGuardrailActionLabel(action) {
  return {
    keep: '유지',
    update: '강화',
    disable: '비활성화',
    defer: '나중에'
  }[action] ?? action;
}

function maturityLevelLabel(level) {
  return {
    mature: '성숙',
    developing: '성장 중',
    early: '초기',
    seed: '시작',
    unknown: '알 수 없음'
  }[level] ?? level;
}
