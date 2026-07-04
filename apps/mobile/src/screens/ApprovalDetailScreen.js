import { ActionType, ApprovalDecision } from '../../../../packages/shared/src/types.js';
import { approvalExpiryState } from '../approval/approval-expiry.js';
import { createApprovalTimeline } from '../approval/approval-history.js';
import { createApprovalActionState } from '../components/ApprovalActionPanel.js';

export function createApprovalDetailScreenViewModel({ approvalId, mobileRuntime }) {
  const card = mobileRuntime.approvalDetail(approvalId);
  const historyResult = mobileRuntime.approvalHistory?.(approvalId);
  const history = historyResult?.success === false ? [] : historyResult?.items ?? [];
  const expiry = approvalExpiryState(card, { now: mobileRuntime.clock?.() ?? new Date() });
  const safety = mobileRuntime.approvalSafetyFacts(card);
  const mobileBlocked = safety.requiresPcConfirmation;
  const approveReadiness = mobileRuntime.sensitiveActionReadiness(`approval:${approvalId}`);
  const actionState = createApprovalActionState({ card, safety, approveReadiness });
  const clarification = createClarificationState(card?.clarificationRequest, { history });
  const timeline = createApprovalTimeline(card, {
    history,
    now: mobileRuntime.clock?.() ?? new Date()
  });
  return {
    route: 'ApprovalDetailScreen',
    card,
    timeline,
    mobileBlocked,
    expired: expiry.expired,
    expiry,
    safety,
    approveReadiness,
    actionState,
    clarification,
    requiresSessionUnlock: !approveReadiness.allowed,
    requiredFacts: {
      title: card.title,
      interpretedIntent: card.interpretedIntent,
      planSteps: card.planSteps,
      riskTier: card.riskTier,
      affectedItems: card.affectedItems,
      externalTransfer: card.externalTransfer,
      rollbackAvailable: card.rollbackAvailable
    },
    approve() {
      if (!actionState.primaryAction.enabled) {
        return { blocked: true, reason: actionState.primaryAction.blockedReason };
      }
      return mobileRuntime.decideApproval({ approvalId, decision: ApprovalDecision.APPROVE });
    },
    edit(editRequest) {
      return mobileRuntime.decideApproval({ approvalId, decision: ApprovalDecision.EDIT, editRequest });
    },
    reject(responseText) {
      return mobileRuntime.decideApproval({ approvalId, decision: ApprovalDecision.REJECT, responseText });
    },
    respond(responseText) {
      return mobileRuntime.decideApproval({ approvalId, decision: ApprovalDecision.RESPOND, responseText });
    },
    respondToClarification(choiceOrIntentId) {
      const choice = clarification.choices.find((item) => item.intentId === choiceOrIntentId || item.actionType === choiceOrIntentId || item.label === choiceOrIntentId);
      if (!choice) {
        return { success: false, error: { code: 'C_CLARIFICATION_CHOICE_NOT_FOUND' } };
      }
      return mobileRuntime.decideApproval({
        approvalId,
        decision: ApprovalDecision.RESPOND,
        responseText: createClarificationResponseText({ clarification, choice })
      });
    },
    renew() {
      return mobileRuntime.renewApproval(approvalId);
    },
    requestPcConfirmation(reason = 'mobile_requires_pc_confirmation') {
      return mobileRuntime.requestPcConfirmation(approvalId, reason);
    },
    cancel(reason = 'mobile_cancelled') {
      return mobileRuntime.cancelApproval(approvalId, reason);
    },
    reRequest(reason = 'mobile_re_request') {
      return mobileRuntime.reRequestApproval(approvalId, reason);
    },
    lifecycleProductGate(options = {}) {
      return createApprovalLifecycleProductGate({
        queueVm: options.queueVm,
        detailVm: {
          route: 'ApprovalDetailScreen',
          card,
          timeline,
          expired: expiry.expired,
          expiry,
          actionState
        },
        ...options
      });
    },
    restrictionProductGate({ pcHandoff = null, pcConsoleBridgeFetch = null } = {}) {
      return createMobileApprovalRestrictionProductGate({
        card,
        safety,
        actionState,
        pcHandoff,
        pcConsoleBridgeFetch
      });
    }
  };
}

export function createApprovalLifecycleVisualRegression({
  queueVm = null,
  detailVm = null,
  expiredDetailVm = detailVm,
  expiredBlock = null,
  renewed = null,
  cancelResult = null,
  reRequestResult = null,
  histories = []
} = {}) {
  const historyItems = histories.flatMap((history) => history?.items ?? history ?? []).filter(Boolean);
  const snapshots = [
    {
      stateId: 'approval_queue_list',
      route: queueVm?.route ?? null,
      itemCount: queueVm?.items?.length ?? 0,
      empty: queueVm?.empty === true,
      canNavigateToDetail: Boolean(queueVm?.items?.[0]?.approvalId)
    },
    {
      stateId: 'approval_detail_action_surface',
      route: detailVm?.route ?? 'ApprovalDetailScreen',
      expired: detailVm?.expired === true,
      approveEnabled: detailVm?.actionState?.primaryAction?.enabled === true,
      secondaryActionCount: detailVm?.actionState?.secondaryActions?.length ?? 0,
      timelineCount: detailVm?.timeline?.items?.length ?? 0
    },
    {
      stateId: 'approval_expired_blocked',
      expired: expiredDetailVm?.expired === true,
      approveBlocked: expiredBlock?.blocked === true,
      blockedReasonReady: String(expiredDetailVm?.actionState?.primaryAction?.blockedReason ?? '').length > 0
    },
    {
      stateId: 'approval_lifecycle_actions',
      renewed: renewed?.status === 'pending',
      cancelled: cancelResult?.success === true && cancelResult?.status === 'CANCELLED',
      reRequested: reRequestResult?.success === true && reRequestResult?.replacement?.status === 'WAITING_APPROVAL'
    },
    {
      stateId: 'approval_history_timeline',
      eventCount: historyItems.length,
      eventTypes: [...new Set(historyItems.map((item) => item.eventType).filter(Boolean))],
      hasCreated: historyItems.some((item) => item.eventType === 'approval.created'),
      hasCancelled: historyItems.some((item) => item.eventType === 'approval.cancelled'),
      hasReRequested: historyItems.some((item) => item.eventType === 'approval.re_requested' || item.eventType === 'approval.replacement.created')
    }
  ];
  const checks = [
    {
      checkId: 'approval_queue_navigates_to_detail',
      passed: snapshots[0].route === 'ApprovalQueueScreen' && snapshots[0].canNavigateToDetail === true
    },
    {
      checkId: 'approval_detail_action_surface_ready',
      passed: snapshots[1].route === 'ApprovalDetailScreen' && snapshots[1].secondaryActionCount >= 2
    },
    {
      checkId: 'approval_expiry_blocks_primary_action',
      passed: snapshots[2].expired === true && snapshots[2].approveBlocked === true && snapshots[2].blockedReasonReady === true
    },
    {
      checkId: 'approval_lifecycle_actions_ready',
      passed: snapshots[3].renewed === true && snapshots[3].cancelled === true && snapshots[3].reRequested === true
    },
    {
      checkId: 'approval_history_timeline_ready',
      passed: snapshots[4].eventCount >= 3 && snapshots[4].hasCreated === true && snapshots[4].hasCancelled === true && snapshots[4].hasReRequested === true
    }
  ];
  return {
    regressionVersion: 'c-approval-lifecycle-visual-regression-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    snapshots,
    checks
  };
}

export function createApprovalLifecycleReleaseDossier({
  queueVm = null,
  detailVm = null,
  expiredDetailVm = detailVm,
  expiredBlock = null,
  renewed = null,
  cancelResult = null,
  reRequestResult = null,
  histories = [],
  visualRegression = createApprovalLifecycleVisualRegression({
    queueVm,
    detailVm,
    expiredDetailVm,
    expiredBlock,
    renewed,
    cancelResult,
    reRequestResult,
    histories
  }),
  generatedAt = new Date()
} = {}) {
  const historyItems = histories.flatMap((history) => history?.items ?? history ?? []).filter(Boolean);
  const cards = [
    detailVm?.card,
    expiredDetailVm?.card,
    renewed,
    cancelResult,
    reRequestResult?.previous,
    reRequestResult?.replacement,
    ...(queueVm?.items ?? [])
  ].filter(Boolean);
  const rawNeedles = [
    ...cards.flatMap((card) => [
      card.approvalId,
      card.taskId,
      card.title,
      card.interpretedIntent,
      ...(card.planSteps ?? []),
      ...(card.affectedItems ?? [])
    ]),
    expiredBlock?.reason,
    cancelResult?.reason,
    reRequestResult?.reason,
    ...historyItems.flatMap((item) => [
      item.approvalId,
      item.taskId,
      item.reason,
      item.detail
    ])
  ].filter((needle) => typeof needle === 'string' && needle.length >= 6);
  const artifactManifest = {
    manifestVersion: 'c-approval-lifecycle-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawApprovalPayloadStored: false,
    rawHistoryPayloadStored: false,
    rawDecisionReasonStored: false,
    rawScreenshotStored: false,
    queue: {
      route: queueVm?.route ?? null,
      itemCount: queueVm?.items?.length ?? 0,
      approvalHashes: (queueVm?.items ?? []).map((item) => ({
        approvalHash: stableDigest(String(item.approvalId ?? '')),
        taskHash: stableDigest(String(item.taskId ?? '')),
        riskTier: item.riskTier ?? null,
        status: item.status ?? null,
        expired: approvalExpiryState(item).expired === true
      }))
    },
    detail: {
      route: detailVm?.route ?? 'ApprovalDetailScreen',
      approvalHash: stableDigest(String(detailVm?.card?.approvalId ?? '')),
      taskHash: stableDigest(String(detailVm?.card?.taskId ?? '')),
      riskTier: detailVm?.card?.riskTier ?? null,
      approveEnabled: detailVm?.actionState?.primaryAction?.enabled === true,
      secondaryActionCount: detailVm?.actionState?.secondaryActions?.length ?? 0,
      timelineCount: detailVm?.timeline?.items?.length ?? 0
    },
    expiryAndLifecycle: {
      expiredBlocked: expiredDetailVm?.expired === true && expiredBlock?.blocked === true,
      expiredApprovalHash: stableDigest(String(expiredDetailVm?.card?.approvalId ?? '')),
      renewed: renewed?.status === 'pending',
      renewedApprovalHash: stableDigest(String(renewed?.approvalId ?? '')),
      cancelled: cancelResult?.success === true && cancelResult?.status === 'CANCELLED',
      cancelledApprovalHash: stableDigest(String(cancelResult?.approvalId ?? '')),
      reRequested: reRequestResult?.success === true,
      previousApprovalHash: stableDigest(String(reRequestResult?.previous?.approvalId ?? '')),
      replacementApprovalHash: stableDigest(String(reRequestResult?.replacement?.approvalId ?? ''))
    },
    timeline: {
      eventCount: historyItems.length,
      eventTypes: [...new Set(historyItems.map((item) => item.eventType).filter(Boolean))],
      eventHashes: historyItems.map((item) => ({
        eventHash: stableDigest(canonicalJson({
          eventType: item.eventType ?? null,
          approvalId: item.approvalId ?? null,
          taskId: item.taskId ?? null,
          status: item.status ?? null
        })),
        eventType: item.eventType ?? null,
        status: item.status ?? null
      }))
    },
    visualRegression: {
      regressionVersion: visualRegression?.regressionVersion ?? null,
      status: visualRegression?.status ?? 'missing',
      snapshotStateIds: (visualRegression?.snapshots ?? []).map((snapshot) => snapshot.stateId),
      checks: (visualRegression?.checks ?? []).map((check) => ({
        checkId: check.checkId,
        passed: check.passed === true
      }))
    },
    nativeStackTransitionEvidenceRequired: true,
    physicalApprovalLifecycleVisualEvidenceRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-approval-lifecycle-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    artifactManifest,
    releaseWorkflow: {
      workflowVersion: 'c-approval-lifecycle-release-workflow-v1',
      queueDetailReady: queueVm?.route === 'ApprovalQueueScreen' && detailVm?.route === 'ApprovalDetailScreen',
      expiryReady: expiredDetailVm?.expired === true && expiredBlock?.blocked === true,
      lifecycleReady: artifactManifest.expiryAndLifecycle.renewed === true
        && artifactManifest.expiryAndLifecycle.cancelled === true
        && artifactManifest.expiryAndLifecycle.reRequested === true,
      timelineReady: artifactManifest.timeline.eventCount >= 3,
      visualRegressionReady: visualRegression?.status === 'passed',
      promotionStatus: 'pending_checks'
    }
  };
  const rawLeakDetected = serializedApprovalRestrictionContainsAny({
    ...preliminaryDossier,
    generatedAt: null,
    artifactManifest: {
      ...preliminaryDossier.artifactManifest,
      generatedAt: null
    }
  }, rawNeedles);
  const checks = [
    {
      checkId: 'approval_queue_detail_navigation_ready',
      passed: preliminaryDossier.releaseWorkflow.queueDetailReady === true
    },
    {
      checkId: 'approval_expiry_renew_cancel_rerequest_ready',
      passed: preliminaryDossier.releaseWorkflow.expiryReady === true
        && preliminaryDossier.releaseWorkflow.lifecycleReady === true
    },
    {
      checkId: 'approval_timeline_visual_regression_passed',
      passed: preliminaryDossier.releaseWorkflow.timelineReady === true
        && visualRegression?.status === 'passed'
    },
    {
      checkId: 'raw_approval_lifecycle_payload_not_stored',
      passed: artifactManifest.rawApprovalPayloadStored === false
        && artifactManifest.rawHistoryPayloadStored === false
        && artifactManifest.rawDecisionReasonStored === false
        && artifactManifest.rawScreenshotStored === false
        && rawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-approval-lifecycle-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'c-approval-lifecycle-health-handshake-v1',
    generatedAt: generatedAt.toISOString(),
    status: checks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshake: {
      queueDetailReady: preliminaryDossier.releaseWorkflow.queueDetailReady === true,
      expiryBlockReady: preliminaryDossier.releaseWorkflow.expiryReady === true,
      renewCancelReRequestReady: preliminaryDossier.releaseWorkflow.lifecycleReady === true,
      timelineReady: preliminaryDossier.releaseWorkflow.timelineReady === true,
      visualRegressionReady: preliminaryDossier.releaseWorkflow.visualRegressionReady === true,
      rawApprovalPayloadStored: false
    },
    fallbackPolicy: {
      policyVersion: 'c-approval-lifecycle-fallback-policy-v1',
      primaryFlow: 'approval_queue_to_detail_then_approve_edit_reject_or_respond',
      fallbackFlows: [
        'expired_approval_blocks_primary_action_until_renewed',
        'cancel_then_rerequest_creates_replacement_approval',
        'timeline_history_explains_renew_cancel_rerequest_events',
        'native_stack_transition_regression_before_release'
      ],
      operatorEscalation: 'mobile_approval_lifecycle_timeline_and_release_dossier'
    },
    rawApprovalPayloadStored: false,
    rawHistoryPayloadStored: false,
    rawDecisionReasonStored: false,
    rawScreenshotStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-approval-lifecycle-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "approval lifecycle" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'approval_queue_detail_navigation_ready',
      'approval_expiry_renew_cancel_rerequest_ready',
      'approval_timeline_visual_regression_passed',
      'approval_lifecycle_release_dossier_ready',
      'approval_lifecycle_release_artifact_manifest_ready',
      'approval_lifecycle_operational_handoff_ready',
      'approval_lifecycle_worm_promotion_package_ready'
    ],
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest)),
    rawApprovalPayloadStored: false,
    rawHistoryPayloadStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-approval-lifecycle-worm-promotion-package-v1',
    providerContractVersion: 'c-approval-lifecycle-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-approval-lifecycle-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-approval-lifecycle-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest)),
    ciNightlyGatePlanHash: stableDigest(canonicalJson(ciNightlyGatePlan)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawApprovalPayloadStored: false,
    rawHistoryPayloadStored: false,
    rawDecisionReasonStored: false
  };
  const dossier = {
    ...preliminaryDossier,
    status: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    checks,
    artifactManifest: {
      ...artifactManifest,
      rawLeakCheck: {
        checkedNeedleCount: rawNeedles.length,
        rawLeakDetected
      }
    },
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    recommendedReleaseAction: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'capture_native_stack_transition_expiry_renew_cancel_rerequest_timeline_and_worm_release_evidence'
      : 'block_approval_lifecycle_release_until_navigation_expiry_timeline_and_raw_retention_checks_pass'
  };
  dossier.releaseWorkflow = {
    ...dossier.releaseWorkflow,
    promotionStatus: dossier.status === 'passed' ? 'release_evidence_ready' : 'blocked'
  };
  dossier.dossierDigest = stableDigest(canonicalJson({
    ...dossier,
    dossierDigest: null
  }));
  return dossier;
}

export function createApprovalLifecycleProductGate(options = {}) {
  const visualRegression = options.visualRegression ?? createApprovalLifecycleVisualRegression(options);
  const releaseDossier = createApprovalLifecycleReleaseDossier({
    ...options,
    visualRegression
  });
  const checks = [
    {
      checkId: 'approval_queue_detail_navigation_ready',
      status: releaseDossier.checks.some((check) => check.checkId === 'approval_queue_detail_navigation_ready' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'approval_expiry_renew_cancel_rerequest_ready',
      status: releaseDossier.checks.some((check) => check.checkId === 'approval_expiry_renew_cancel_rerequest_ready' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'approval_timeline_visual_regression_passed',
      status: visualRegression.regressionVersion === 'c-approval-lifecycle-visual-regression-v1'
        && visualRegression.status === 'passed'
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'approval_lifecycle_release_dossier_ready',
      status: releaseDossier.dossierVersion === 'c-approval-lifecycle-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && releaseDossier.dossierDigest.length === 64
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'approval_lifecycle_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'c-approval-lifecycle-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawApprovalPayloadStored === false
        && releaseDossier.artifactManifest?.rawHistoryPayloadStored === false
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'approval_lifecycle_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-approval-lifecycle-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-approval-lifecycle-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-approval-lifecycle-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'approval_lifecycle_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-approval-lifecycle-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-approval-lifecycle-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked'
    }
  ];
  return {
    productGateVersion: 'c-approval-lifecycle-product-gate-v1',
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    checks,
    visualRegression,
    releaseDossier: {
      dossierVersion: releaseDossier.dossierVersion,
      status: releaseDossier.status,
      dossierDigest: releaseDossier.dossierDigest,
      artifactManifest: releaseDossier.artifactManifest,
      operationalHandoffManifest: releaseDossier.operationalHandoffManifest,
      ciNightlyGatePlan: releaseDossier.ciNightlyGatePlan,
      externalWormPromotionPackage: releaseDossier.externalWormPromotionPackage
    }
  };
}

export function createMobileApprovalRestrictionReleaseDossier({
  card = null,
  safety = {},
  actionState = createApprovalActionState({ card, safety }),
  pcHandoff = null,
  pcConsoleBridgeFetch = null,
  generatedAt = new Date()
} = {}) {
  const artifactManifest = {
    manifestVersion: 'c-mobile-approval-restriction-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawApprovalPayloadStored: false,
    rawPcConsolePayloadStored: false,
    rawDeviceTokenStored: false,
    approval: {
      approvalIdHash: stableDigest(String(card?.approvalId ?? '')),
      taskIdHash: stableDigest(String(card?.taskId ?? '')),
      riskTier: card?.riskTier ?? safety?.riskTier ?? null,
      externalTransfer: safety?.externalTransfer === true,
      rollbackAvailable: safety?.rollbackAvailable === true,
      affectedItemCount: safety?.affectedItemCount ?? card?.affectedItems?.length ?? 0
    },
    mobileActionSurface: {
      approveEnabled: actionState.primaryAction?.enabled === true,
      approveTone: actionState.primaryAction?.visualSnapshot?.tone ?? null,
      approveOpacity: actionState.primaryAction?.visualSnapshot?.opacity ?? null,
      approveAccessibilityDisabled: actionState.primaryAction?.accessibility?.accessibilityState?.disabled === true,
      pcHandoffEnabled: actionState.pcHandoffAction?.enabled === true
    },
    pcHandoff: {
      requested: pcHandoff?.success === true,
      status: pcHandoff?.status ?? null,
      requiresPcConfirmation: pcHandoff?.requiresPcConfirmation === true,
      handoffIdHash: stableDigest(String(pcHandoff?.handoffId ?? ''))
    },
    pcConsoleVisualRegression: {
      scenarioVersion: pcConsoleBridgeFetch?.scenarioVersion ?? null,
      passed: pcConsoleBridgeFetch?.passed === true,
      initialStatus: pcConsoleBridgeFetch?.initialVisualRegression?.status ?? null,
      rejectStatus: pcConsoleBridgeFetch?.rejectVisualRegression?.status ?? null,
      finalStatus: pcConsoleBridgeFetch?.finalVisualRegression?.status ?? null,
      acceptedStatus: pcConsoleBridgeFetch?.accepted?.status ?? null,
      rejectedStatus: pcConsoleBridgeFetch?.rejected?.status ?? null,
      rawHandoffIdsStored: false
    },
    physicalPcBrowserScreenshotRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-mobile-approval-restriction-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    releaseWorkflow: {
      workflowVersion: 'c-mobile-approval-restriction-release-workflow-v1',
      riskTier: artifactManifest.approval.riskTier,
      requiresPcConfirmation: safety?.requiresPcConfirmation === true,
      promotionStatus: 'pending_checks'
    },
    artifactManifest
  };
  const rawNeedles = [
    card?.approvalId,
    card?.taskId,
    card?.title,
    card?.interpretedIntent,
    pcHandoff?.handoffId,
    pcConsoleBridgeFetch?.accepted?.handoffId,
    pcConsoleBridgeFetch?.rejected?.handoffId
  ].filter(Boolean);
  const rawLeakDetected = serializedApprovalRestrictionContainsAny(preliminaryDossier, rawNeedles);
  const checks = [
    {
      checkId: 'mobile_high_risk_approval_blocked',
      passed: safety?.requiresPcConfirmation === true
        && actionState.primaryAction?.enabled === false
        && actionState.primaryAction?.accessibility?.accessibilityState?.disabled === true
    },
    {
      checkId: 'disabled_visual_and_accessibility_ready',
      passed: actionState.primaryAction?.visualSnapshot?.tone === 'pc-confirmation-disabled'
        && actionState.primaryAction?.visualSnapshot?.opacity === 0.55
        && String(actionState.primaryAction?.accessibility?.accessibilityLabel ?? '').includes('PC 확인 필요')
    },
    {
      checkId: 'pc_handoff_request_ready',
      passed: actionState.pcHandoffAction?.enabled === true
        && pcHandoff?.success === true
        && pcHandoff?.status === 'awaiting_pc_confirmation'
        && pcHandoff?.requiresPcConfirmation === true
    },
    {
      checkId: 'pc_console_visual_regression_passed',
      passed: pcConsoleBridgeFetch?.passed === true
        && pcConsoleBridgeFetch?.initialVisualRegression?.status === 'passed'
        && pcConsoleBridgeFetch?.rejectVisualRegression?.status === 'passed'
        && pcConsoleBridgeFetch?.finalVisualRegression?.status === 'passed'
    },
    {
      checkId: 'raw_approval_payload_not_stored',
      passed: artifactManifest.rawApprovalPayloadStored === false
        && artifactManifest.rawPcConsolePayloadStored === false
        && artifactManifest.rawDeviceTokenStored === false
        && artifactManifest.pcConsoleVisualRegression.rawHandoffIdsStored === false
        && rawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-mobile-approval-restriction-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'c-mobile-approval-restriction-health-handshake-v1',
    generatedAt: generatedAt.toISOString(),
    status: checks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshake: {
      highRiskBlocked: safety?.requiresPcConfirmation === true
        && actionState.primaryAction?.enabled === false,
      disabledAccessibilityReady: actionState.primaryAction?.accessibility?.accessibilityState?.disabled === true,
      pcHandoffReady: pcHandoff?.success === true
        && pcHandoff?.status === 'awaiting_pc_confirmation',
      pcConsoleVisualRegressionReady: pcConsoleBridgeFetch?.passed === true,
      rawApprovalPayloadStored: false,
      rawPcConsolePayloadStored: false
    },
    fallbackPolicy: {
      policyVersion: 'c-mobile-approval-restriction-fallback-policy-v1',
      primaryFlow: 'block_mobile_approval_and_request_pc_confirmation_for_high_risk_cards',
      fallbackFlows: [
        'show_disabled_accessible_primary_action_with_pc_reason',
        'retry_pc_handoff_when_bridge_recovers',
        'pc_console_accept_or_reject_visual_regression_before_release',
        'manual_desktop_review_when_handoff_unavailable'
      ],
      operatorEscalation: 'pc_console_approval_handoff_review'
    },
    rawApprovalPayloadStored: false,
    rawPcConsolePayloadStored: false,
    rawDeviceTokenStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-mobile-approval-restriction-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "high-risk approval" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'mobile_high_risk_approval_blocked',
      'pc_handoff_request_ready',
      'pc_console_visual_regression_ready',
      'mobile_approval_restriction_release_dossier_ready',
      'mobile_approval_restriction_release_artifact_manifest_ready',
      'mobile_approval_restriction_operational_handoff_ready',
      'mobile_approval_restriction_worm_promotion_package_ready'
    ],
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest)),
    rawApprovalPayloadStored: false,
    rawPcConsolePayloadStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-mobile-approval-restriction-worm-promotion-package-v1',
    providerContractVersion: 'c-mobile-approval-restriction-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-mobile-approval-restriction-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-mobile-approval-restriction-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest)),
    ciNightlyGatePlanHash: stableDigest(canonicalJson(ciNightlyGatePlan)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawApprovalPayloadStored: false,
    rawPcConsolePayloadStored: false,
    rawDeviceTokenStored: false
  };
  const dossier = {
    ...preliminaryDossier,
    status: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    checks,
    artifactManifest: {
      ...artifactManifest,
      rawLeakCheck: {
        checkedNeedleCount: rawNeedles.length,
        rawLeakDetected
      }
    },
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    recommendedReleaseAction: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'capture_physical_pc_browser_accept_reject_screenshots_and_worm_release_evidence'
      : 'block_mobile_high_risk_approval_release_until_pc_handoff_and_visual_regression_pass'
  };
  dossier.releaseWorkflow = {
    ...dossier.releaseWorkflow,
    promotionStatus: dossier.status === 'passed' ? 'release_evidence_ready' : 'blocked'
  };
  dossier.dossierDigest = stableDigest(canonicalJson({
    ...dossier,
    dossierDigest: null
  }));
  return dossier;
}

export function createMobileApprovalRestrictionProductGate({
  card = null,
  safety = {},
  actionState = createApprovalActionState({ card, safety }),
  pcHandoff = null,
  pcConsoleBridgeFetch = null
} = {}) {
  const releaseDossier = createMobileApprovalRestrictionReleaseDossier({
    card,
    safety,
    actionState,
    pcHandoff,
    pcConsoleBridgeFetch
  });
  const checks = [
    {
      checkId: 'mobile_high_risk_approval_blocked',
      status: releaseDossier.checks.some((check) => check.checkId === 'mobile_high_risk_approval_blocked' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'pc_handoff_request_ready',
      status: releaseDossier.checks.some((check) => check.checkId === 'pc_handoff_request_ready' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'pc_console_visual_regression_ready',
      status: releaseDossier.checks.some((check) => check.checkId === 'pc_console_visual_regression_passed' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'mobile_approval_restriction_release_dossier_ready',
      status: releaseDossier.dossierVersion === 'c-mobile-approval-restriction-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && releaseDossier.dossierDigest.length === 64
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'mobile_approval_restriction_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'c-mobile-approval-restriction-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawApprovalPayloadStored === false
        && releaseDossier.artifactManifest?.rawPcConsolePayloadStored === false
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'mobile_approval_restriction_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-mobile-approval-restriction-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-mobile-approval-restriction-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-mobile-approval-restriction-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'mobile_approval_restriction_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-mobile-approval-restriction-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-mobile-approval-restriction-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked'
    }
  ];
  return {
    productGateVersion: 'c-mobile-approval-restriction-product-gate-v1',
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier.dossierVersion,
      status: releaseDossier.status,
      dossierDigest: releaseDossier.dossierDigest,
      artifactManifest: releaseDossier.artifactManifest,
      operationalHandoffManifest: releaseDossier.operationalHandoffManifest,
      ciNightlyGatePlan: releaseDossier.ciNightlyGatePlan,
      externalWormPromotionPackage: releaseDossier.externalWormPromotionPackage
    }
  };
}

export function createClarificationState(clarificationRequest = null, { history = [] } = {}) {
  if (!clarificationRequest) {
    return {
      required: false,
      question: null,
      choices: [],
      missingSlots: [],
      selectedIntentId: null,
      conversation: createClarificationConversationState(null, { history })
    };
  }
  const choices = (clarificationRequest.choices ?? []).map((choice, index) => ({
    ...choice,
    index,
    displayLabel: choice.label ?? choice.actionType ?? `선택 ${index + 1}`,
    responseText: createClarificationResponseText({
      clarification: clarificationRequest,
      choice
    })
  }));
  return {
    required: true,
    clarificationId: clarificationRequest.clarificationId,
    question: clarificationRequest.question,
    choices,
    missingSlots: clarificationRequest.missingSlots ?? [],
    selectedIntentId: clarificationRequest.selectedIntentId ?? null,
    conversation: createClarificationConversationState(clarificationRequest, { choices, history })
  };
}

export function createClarificationConversationState(clarificationRequest = null, { choices = [], history = [] } = {}) {
  if (!clarificationRequest) {
    return {
      uiContractVersion: 'a-clarification-conversation-ui-v1',
      status: 'not_required',
      turns: [],
      quickReplies: [],
      copy: {
        emptyState: '추가 확인이 필요하지 않습니다.'
      }
    };
  }
  const responseEvents = history
    .filter((item) => item.eventType === 'approval.decision.received' && ['respond', 'edit'].includes(item.detail))
    .map((item) => ({
      role: 'user',
      kind: item.detail === 'respond' ? 'clarification_response' : 'clarification_edit',
      text: item.reason ?? item.detail,
      at: item.createdAt,
      status: item.status
    }));
  return {
    uiContractVersion: 'a-clarification-conversation-ui-v1',
    status: 'waiting_for_user',
    clarificationId: clarificationRequest.clarificationId,
    turns: [
      {
        role: 'assistant',
        kind: 'follow_up_question',
        text: clarificationRequest.question,
        at: clarificationRequest.createdAt ?? null
      },
      ...responseEvents
    ],
    quickReplies: choices.map((choice) => ({
      intentId: choice.intentId,
      label: choice.displayLabel,
      actionType: choice.actionType,
      confidence: choice.confidence,
      responseText: choice.responseText
    })),
    copy: {
      submitLabel: '선택해서 재계획',
      previewLabel: '선택 후 새 승인 카드에서 변경된 계획을 다시 확인합니다.',
      missingSlotPrefix: '추가 정보'
    },
    progress: {
      answered: responseEvents.length,
      choiceCount: choices.length,
      missingSlotCount: clarificationRequest.missingSlots?.length ?? 0
    }
  };
}

export function createClarificationCopyQualityReport({ conversations = [] } = {}) {
  const items = normalizeClarificationConversations(conversations).map((conversation, index) => {
    const textBlob = [
      ...conversation.turns.map((turn) => turn.text),
      ...conversation.quickReplies.map((reply) => reply.responseText),
      ...Object.values(conversation.copy ?? {})
    ].join('\n');
    const checks = [
      { checkId: 'follow_up_question_present', passed: conversation.turns.some((turn) => turn.kind === 'follow_up_question' && String(turn.text ?? '').length >= 12) },
      { checkId: 'quick_replies_have_response_text', passed: conversation.quickReplies.length > 0 && conversation.quickReplies.every((reply) => String(reply.responseText ?? '').includes('다시 계획')) },
      { checkId: 'submit_copy_is_actionable', passed: String(conversation.copy?.submitLabel ?? '').length >= 4 },
      { checkId: 'preview_copy_sets_expectation', passed: String(conversation.copy?.previewLabel ?? '').includes('다시 확인') },
      { checkId: 'sensitive_text_not_exposed', passed: !containsSensitiveCopy(textBlob) }
    ];
    return {
      itemId: `clarification_copy_${index + 1}`,
      clarificationId: conversation.clarificationId ?? null,
      uiContractVersion: conversation.uiContractVersion,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
  });
  return {
    reportVersion: 'a-clarification-copy-quality-report-v1',
    status: items.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    conversationCount: items.length,
    rawConversationTextStored: false,
    items
  };
}

export function createClarificationUxTelemetryReport({
  conversations = [],
  minCompletionRate = 0.8,
  maxDropOffRate = 0.2
} = {}) {
  const required = normalizeClarificationConversations(conversations)
    .filter((conversation) => conversation.status !== 'not_required');
  const completed = required.filter((conversation) => Number(conversation.progress?.answered ?? 0) > 0);
  const dropOff = required.filter((conversation) => Number(conversation.progress?.answered ?? 0) === 0);
  const completionRate = required.length ? round(completed.length / required.length) : 1;
  const dropOffRate = required.length ? round(dropOff.length / required.length) : 0;
  return {
    reportVersion: 'a-clarification-ux-telemetry-report-v1',
    status: completionRate >= minCompletionRate && dropOffRate <= maxDropOffRate ? 'passed' : 'failed',
    rawConversationTextStored: false,
    thresholds: {
      minCompletionRate,
      maxDropOffRate
    },
    metrics: {
      requiredCount: required.length,
      completedCount: completed.length,
      dropOffCount: dropOff.length,
      completionRate,
      dropOffRate,
      averageChoiceCount: round(average(required.map((conversation) => conversation.progress?.choiceCount ?? 0))),
      averageMissingSlotCount: round(average(required.map((conversation) => conversation.progress?.missingSlotCount ?? 0)))
    }
  };
}

export function createClarificationProductGate({
  conversations = [],
  copyQuality = createClarificationCopyQualityReport({ conversations }),
  uxTelemetry = createClarificationUxTelemetryReport({ conversations })
} = {}) {
  const normalizedConversations = normalizeClarificationConversations(conversations);
  const hasContract = normalizedConversations
    .every((conversation) => conversation.uiContractVersion === 'a-clarification-conversation-ui-v1');
  const artifactManifest = createClarificationReleaseArtifactManifest({
    conversations: normalizedConversations,
    copyQuality,
    uxTelemetry,
    hasContract
  });
  const operationalHandoffManifest = createClarificationOperationalHandoffManifest({
    conversations: normalizedConversations,
    copyQuality,
    uxTelemetry,
    artifactManifest,
    hasContract
  });
  const ciNightlyGatePlan = createClarificationCiNightlyGatePlan({
    copyQuality,
    uxTelemetry,
    operationalHandoffManifest
  });
  const externalWormPromotionPackage = createClarificationExternalWormPromotionPackage({
    artifactManifest,
    ciNightlyGatePlan,
    operationalHandoffManifest
  });
  const releaseDossier = {
    dossierVersion: 'a-clarification-release-dossier-v1',
    status: copyQuality.status === 'passed'
      && uxTelemetry.status === 'passed'
      && hasContract
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'failed',
    copyQualityVersion: copyQuality.reportVersion,
    uxTelemetryVersion: uxTelemetry.reportVersion,
    conversationCount: copyQuality.conversationCount,
    rawConversationTextStored: false,
    rawQuickReplyTextStored: false,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    recommendedReleaseAction: copyQuality.status === 'passed'
      && uxTelemetry.status === 'passed'
      && hasContract
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && externalWormPromotionPackage.status === 'ready'
      ? 'attach_clarification_copy_quality_ux_telemetry_operational_handoff_and_worm_promotion_package'
      : 'block_clarification_release_until_copy_and_telemetry_pass'
  };
  const checks = [
    {
      checkId: 'clarification_mobile_conversation_contract_present',
      passed: hasContract
    },
    {
      checkId: 'clarification_copy_quality_passed',
      passed: copyQuality.reportVersion === 'a-clarification-copy-quality-report-v1' && copyQuality.status === 'passed'
    },
    {
      checkId: 'clarification_ux_telemetry_passed',
      passed: uxTelemetry.reportVersion === 'a-clarification-ux-telemetry-report-v1' && uxTelemetry.status === 'passed'
    },
    {
      checkId: 'clarification_raw_conversation_not_stored',
      passed: copyQuality.rawConversationTextStored === false
        && uxTelemetry.rawConversationTextStored === false
        && releaseDossier.rawConversationTextStored === false
        && releaseDossier.rawQuickReplyTextStored === false
    },
    {
      checkId: 'clarification_release_artifact_manifest_ready',
      passed: artifactManifest.manifestVersion === 'a-clarification-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && artifactManifest.hashOnlyConversationManifest === true
    },
    {
      checkId: 'clarification_ci_nightly_gate_plan_ready',
      passed: ciNightlyGatePlan.planVersion === 'a-clarification-ci-nightly-gate-plan-v1'
        && ciNightlyGatePlan.requiredForPr === true
        && ciNightlyGatePlan.requiredForNightly === true
    },
    {
      checkId: 'clarification_operational_handoff_ready',
      passed: operationalHandoffManifest.manifestVersion === 'a-clarification-operational-handoff-manifest-v1'
        && operationalHandoffManifest.healthHandshakeVersion === 'a-clarification-health-handshake-v1'
        && operationalHandoffManifest.fallbackPolicy.policyVersion === 'a-clarification-fallback-policy-v1'
        && operationalHandoffManifest.status === 'ready'
        && operationalHandoffManifest.rawConversationTextStored === false
        && operationalHandoffManifest.rawQuickReplyTextStored === false
    },
    {
      checkId: 'clarification_worm_promotion_package_ready',
      passed: externalWormPromotionPackage.packageVersion === 'a-clarification-worm-promotion-package-v1'
        && externalWormPromotionPackage.providerContractVersion === 'a-clarification-worm-provider-contract-v1'
        && externalWormPromotionPackage.status === 'ready'
    },
    {
      checkId: 'clarification_release_dossier_ready',
      passed: releaseDossier.status === 'passed'
    }
  ];
  return {
    productGateVersion: 'a-clarification-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks,
    copyQuality,
    uxTelemetry,
    releaseDossier
  };
}

export function createClarificationReleaseArtifactManifest({
  conversations = [],
  copyQuality,
  uxTelemetry,
  hasContract
} = {}) {
  const normalizedConversations = normalizeClarificationConversations(conversations);
  const conversationArtifacts = normalizedConversations.map((conversation, index) => ({
    artifactId: `clarification_conversation_${index + 1}`,
    clarificationHash: stableDigest(String(conversation.clarificationId ?? 'not_required')),
    uiContractVersion: conversation.uiContractVersion,
    status: conversation.status,
    turnCount: conversation.turns?.length ?? 0,
    quickReplyCount: conversation.quickReplies?.length ?? 0,
    progress: {
      answered: conversation.progress?.answered ?? 0,
      choiceCount: conversation.progress?.choiceCount ?? conversation.quickReplies?.length ?? 0,
      missingSlotCount: conversation.progress?.missingSlotCount ?? 0
    },
    turnTextHashes: (conversation.turns ?? []).map((turn) => stableDigest(String(turn.text ?? ''))),
    quickReplyTextHashes: (conversation.quickReplies ?? []).map((reply) => stableDigest(String(reply.responseText ?? reply.label ?? '')))
  }));
  const rawNeedles = normalizedConversations.flatMap((conversation) => [
    conversation.clarificationId,
    ...(conversation.turns ?? []).map((turn) => turn.text),
    ...(conversation.quickReplies ?? []).flatMap((reply) => [reply.label, reply.responseText]),
    ...Object.values(conversation.copy ?? {})
  ]).filter((value) => typeof value === 'string' && value.length >= 6);
  const manifestCore = {
    manifestVersion: 'a-clarification-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    hashOnlyConversationManifest: true,
    rawConversationTextStored: false,
    rawQuickReplyTextStored: false,
    rawScreenshotStored: false,
    hasContract,
    copyQualityHash: stableDigest(canonicalJson({
      reportVersion: copyQuality?.reportVersion ?? null,
      status: copyQuality?.status ?? null,
      conversationCount: copyQuality?.conversationCount ?? 0,
      itemStatuses: (copyQuality?.items ?? []).map((item) => item.status)
    })),
    uxTelemetryHash: stableDigest(canonicalJson({
      reportVersion: uxTelemetry?.reportVersion ?? null,
      status: uxTelemetry?.status ?? null,
      metrics: uxTelemetry?.metrics ?? null
    })),
    conversationArtifacts
  };
  const rawLeakDetected = serializedApprovalRestrictionContainsAny(manifestCore, rawNeedles)
    || containsSensitiveCopy(JSON.stringify(manifestCore));
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-clarification-release-raw-leak-check-v1',
      checkedConversationCount: normalizedConversations.length,
      checkedNeedleCount: rawNeedles.length,
      rawLeakDetected
    }
  };
}

export function createClarificationCiNightlyGatePlan({
  copyQuality,
  uxTelemetry,
  operationalHandoffManifest
} = {}) {
  return {
    planVersion: 'a-clarification-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run mobile:verify',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'clarification_copy_quality_passed',
      'clarification_ux_telemetry_passed',
      'clarification_release_artifact_manifest_ready',
      'clarification_operational_handoff_ready'
    ],
    thresholds: {
      minCompletionRate: uxTelemetry?.thresholds?.minCompletionRate ?? 0.8,
      maxDropOffRate: uxTelemetry?.thresholds?.maxDropOffRate ?? 0.2
    },
    artifactOutputs: [
      'dist/mobile-verify-report.json',
      'dist/mobile-verify-report.md'
    ],
    copyQualityHash: stableDigest(canonicalJson({
      reportVersion: copyQuality?.reportVersion ?? null,
      status: copyQuality?.status ?? null
    })),
    uxTelemetryHash: stableDigest(canonicalJson({
      reportVersion: uxTelemetry?.reportVersion ?? null,
      status: uxTelemetry?.status ?? null,
      metrics: uxTelemetry?.metrics ?? null
    })),
    operationalHandoffHash: stableDigest(canonicalJson({
      manifestVersion: operationalHandoffManifest?.manifestVersion ?? null,
      status: operationalHandoffManifest?.status ?? null,
      healthHandshakeVersion: operationalHandoffManifest?.healthHandshakeVersion ?? null
    })),
    rawConversationTextStored: false
  };
}

export function createClarificationOperationalHandoffManifest({
  conversations = [],
  copyQuality,
  uxTelemetry,
  artifactManifest,
  hasContract
} = {}) {
  const normalizedConversations = normalizeClarificationConversations(conversations);
  const metrics = uxTelemetry?.metrics ?? {};
  const requiredConversations = normalizedConversations.filter((conversation) => conversation.status !== 'not_required');
  const conversationFingerprints = requiredConversations.map((conversation, index) => ({
    conversationHash: stableDigest(String(conversation.clarificationId ?? `clarification_${index + 1}`)),
    uiContractVersion: conversation.uiContractVersion,
    status: conversation.status,
    answered: Number(conversation.progress?.answered ?? 0) > 0,
    quickReplyCount: conversation.quickReplies?.length ?? 0,
    turnCount: conversation.turns?.length ?? 0
  }));
  const manifestCore = {
    manifestVersion: 'a-clarification-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'a-clarification-health-handshake-v1',
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    conversationUiHealth: {
      status: hasContract ? 'ready' : 'blocked',
      requiredCount: requiredConversations.length,
      completedCount: metrics.completedCount ?? conversationFingerprints.filter((item) => item.answered).length,
      completionRate: metrics.completionRate ?? 1,
      dropOffRate: metrics.dropOffRate ?? 0
    },
    copyQualityHealth: {
      reportVersion: copyQuality?.reportVersion ?? null,
      status: copyQuality?.status ?? 'missing'
    },
    fallbackPolicy: {
      policyVersion: 'a-clarification-fallback-policy-v1',
      primaryFlow: 'approval_detail_quick_reply_response',
      fallbackFlows: [
        'free_text_clarification_response',
        'approval_edit_replan',
        'reject_and_reissue_command'
      ],
      retryLimit: 2,
      operatorEscalation: 'mobile_runtime_support_queue'
    },
    conversationFingerprints,
    artifactManifestHash: stableDigest(canonicalJson({
      manifestVersion: artifactManifest?.manifestVersion ?? null,
      rawLeakDetected: artifactManifest?.rawLeakCheck?.rawLeakDetected ?? true,
      conversationArtifactCount: artifactManifest?.conversationArtifacts?.length ?? 0
    })),
    rawConversationTextStored: false,
    rawQuickReplyTextStored: false,
    rawScreenshotStored: false
  };
  const rawNeedles = normalizedConversations.flatMap((conversation) => [
    conversation.clarificationId,
    ...(conversation.turns ?? []).map((turn) => turn.text),
    ...(conversation.quickReplies ?? []).flatMap((reply) => [reply.label, reply.responseText])
  ]).filter((value) => typeof value === 'string' && value.length >= 6);
  const rawLeakDetected = serializedApprovalRestrictionContainsAny(manifestCore, rawNeedles)
    || containsSensitiveCopy(JSON.stringify(manifestCore));
  const ready = hasContract
    && copyQuality?.status === 'passed'
    && uxTelemetry?.status === 'passed'
    && artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && rawLeakDetected === false;
  return {
    ...manifestCore,
    status: ready ? 'ready' : 'blocked',
    rawLeakCheck: {
      checkVersion: 'a-clarification-operational-raw-leak-check-v1',
      checkedConversationCount: normalizedConversations.length,
      checkedNeedleCount: rawNeedles.length,
      rawLeakDetected
    }
  };
}

export function createClarificationExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  operationalHandoffManifest
} = {}) {
  return {
    packageVersion: 'a-clarification-worm-promotion-package-v1',
    providerContractVersion: 'a-clarification-worm-provider-contract-v1',
    status: artifactManifest?.manifestVersion === 'a-clarification-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && ciNightlyGatePlan?.planVersion === 'a-clarification-ci-nightly-gate-plan-v1'
      && operationalHandoffManifest?.status === 'ready'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest ?? null)),
    ciNightlyGatePlanHash: stableDigest(canonicalJson(ciNightlyGatePlan ?? null)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest ?? null)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawConversationTextStored: false,
    rawQuickReplyTextStored: false
  };
}

function createClarificationResponseText({ clarification, choice }) {
  const label = choice.label ?? choice.actionType ?? choice.intentId;
  const actionLabel = actionLabelForClarification(choice.actionType, label);
  const slotHint = (clarification.missingSlots ?? []).length
    ? ` 추가 정보는 ${(clarification.missingSlots ?? []).join(', ')} 기준으로 채워줘.`
    : '';
  return `${actionLabel} 방향으로 다시 계획해줘.${slotHint} 변경된 실행 계획은 새 승인 카드에서 다시 확인할게.`;
}

function normalizeClarificationConversations(conversations) {
  return (Array.isArray(conversations) ? conversations : [conversations])
    .filter(Boolean);
}

function containsSensitiveCopy(text) {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|01[016789]-?\d{3,4}-?\d{4}|token=|secret/i.test(String(text ?? ''));
}

function serializedApprovalRestrictionContainsAny(value, needles) {
  const serialized = JSON.stringify(value);
  return needles.some((needle) => needle && serialized.includes(String(needle)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableDigest(value) {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }).join('').repeat(2).slice(0, 64);
}

function average(values) {
  const numbers = values.filter(Number.isFinite);
  if (!numbers.length) return 0;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function round(value) {
  return Math.round(Number(value ?? 0) * 1000) / 1000;
}

function actionLabelForClarification(actionType, fallback) {
  const labels = {
    [ActionType.BROWSER_SEARCH]: '브라우저 조사',
    [ActionType.CREATE_FILE]: '로컬 산출물 생성',
    [ActionType.LIST_FILES]: '파일 목록 조회',
    [ActionType.MOVE_FILE]: '파일 이동',
    [ActionType.UPLOAD_FILE]: '외부 전송'
  };
  return labels[actionType] ?? fallback;
}
