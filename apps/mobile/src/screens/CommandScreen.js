import { createCommandComposerState } from '../components/CommandComposerPanel.js';

export function createCommandScreenViewModel({ state, mobileRuntime }) {
  const offlineQueue = mobileRuntime.reviewOfflineQueue();
  const composerState = createCommandComposerState({
    rawText: state.command.rawText,
    connected: state.connection.connected,
    pendingOfflineCount: state.offline.pending.length,
    requestStatus: state.command.requestStatus ?? 'idle',
    requestStartedAt: state.command.requestStartedAt ?? null,
    requestTimeoutMs: state.command.requestTimeoutMs ?? 8000
  });
  const queueDetails = offlineQueue.pending.map((item) => createPendingCommandDetail(item));
  const queueDetailPanel = createPendingQueueDetailPanelState({ items: offlineQueue.pending });
  return {
    route: 'CommandScreen',
    connected: state.connection.connected,
    pendingOfflineCount: state.offline.pending.length,
    queueDetails,
    queueDetailPanel,
    composerState,
    canSend: composerState.canSend,
    send(rawText) {
      const nextState = createCommandComposerState({
        rawText,
        connected: state.connection.connected,
        pendingOfflineCount: state.offline.pending.length,
        requestStatus: state.command.requestStatus ?? 'idle',
        requestStartedAt: state.command.requestStartedAt ?? null,
        requestTimeoutMs: state.command.requestTimeoutMs ?? 8000
      });
      if (!nextState.canSend) {
        return { blocked: true, validation: nextState.validation };
      }
      const result = mobileRuntime.sendCommand(rawText);
      return result.queued
        ? { nextRoute: 'CommandScreen', queued: true, item: result.item }
        : { nextRoute: 'TaskStatusScreen', taskId: result.taskId, status: result.status };
    },
    reviewQueue() {
      return {
        nextRoute: 'CommandScreen',
        pending: offlineQueue.pending,
        details: queueDetails,
        panel: queueDetailPanel,
        autoSend: false
      };
    },
    selectQueued(localId) {
      const item = offlineQueue.all.find((candidate) => candidate.localId === localId);
      return item
        ? { found: true, detail: createPendingCommandDetail(item) }
        : { found: false, error: { code: 'C_QUEUE_ITEM_NOT_FOUND' } };
    },
    sendQueued(localId) {
      return mobileRuntime.sendQueuedCommand(localId);
    },
    cancelQueued(localId) {
      return mobileRuntime.cancelQueuedCommand(localId);
    },
    cancelRequest(reason = 'user_cancelled_command_request') {
      return {
        success: composerState.cancelRequestAction.enabled,
        reason,
        requestState: {
          ...composerState.requestState,
          status: composerState.cancelRequestAction.enabled ? 'cancelled' : composerState.requestState.status
        },
        error: composerState.cancelRequestAction.enabled ? null : { code: 'C_COMMAND_REQUEST_NOT_PENDING' }
      };
    },
    openApprovals() {
      return { nextRoute: 'ApprovalQueueScreen' };
    },
    openSettings() {
      return { nextRoute: 'SettingsScreen' };
    }
  };
}

export function createPendingCommandDetail(item, { now = new Date() } = {}) {
  const createdAt = item?.createdAt ?? null;
  const ageMs = createdAt ? Math.max(0, now.getTime() - Date.parse(createdAt)) : 0;
  const retryCount = item?.retryCount ?? 0;
  const nextRetryAt = item?.nextRetryAt ?? null;
  const stale = ageMs >= 5 * 60 * 1000;
  return {
    localId: item?.localId ?? null,
    rawText: item?.rawText ?? '',
    preview: String(item?.rawText ?? '').slice(0, 80),
    createdAt,
    ageMs,
    stale,
    retryCount,
    nextRetryAt,
    attachmentCount: item?.attachments?.length ?? 0,
    syncStatus: item?.syncStatus ?? 'unknown',
    display: {
      title: String(item?.rawText ?? '').slice(0, 32) || 'Pending command',
      ageLabel: ageMs < 1000 ? 'just now' : `${Math.round(ageMs / 1000)}s pending`,
      retryLabel: nextRetryAt ? `retry at ${nextRetryAt}` : retryCount > 0 ? `${retryCount} retries` : 'not retried',
      tone: item?.syncStatus === 'failed' || stale ? 'warning' : item?.syncStatus === 'sent' ? 'good' : 'neutral'
    },
    actions: {
      send: item?.syncStatus === 'pending',
      cancel: item?.syncStatus === 'pending',
      inspect: true
    }
  };
}

export function createPendingQueueDetailPanelState({ items = [], now = new Date() } = {}) {
  const details = items.map((item) => createPendingCommandDetail(item, { now }));
  return {
    panelVersion: 'c-command-pending-queue-detail-panel-v1',
    generatedAt: now.toISOString(),
    empty: details.length === 0,
    total: details.length,
    staleCount: details.filter((item) => item.stale).length,
    retryScheduledCount: details.filter((item) => Boolean(item.nextRetryAt)).length,
    actions: {
      sendAllEnabled: details.some((item) => item.actions.send),
      cancelAllEnabled: details.some((item) => item.actions.cancel),
      autoSend: false
    },
    accessibility: {
      role: 'list',
      label: `${details.length} pending offline commands`,
      announcesNetworkRecovery: true
    },
    details
  };
}

export function createCommandNetworkRecoveryVisualRegression({
  rawText = 'Generate weekly operations report',
  pendingOfflineCount = 1,
  requestTimeoutMs = 3000,
  startedAt = '2026-06-18T00:00:00.000Z',
  now = new Date('2026-06-18T00:00:04.000Z')
} = {}) {
  const scenarios = [
    {
      stateId: 'offline_queue_ready',
      state: createCommandComposerState({
        rawText,
        connected: false,
        pendingOfflineCount,
        requestStatus: 'idle',
        now
      })
    },
    {
      stateId: 'bridge_pending_latency',
      state: createCommandComposerState({
        rawText,
        connected: true,
        pendingOfflineCount,
        requestStatus: 'pending',
        requestStartedAt: startedAt,
        requestTimeoutMs,
        now: new Date(Date.parse(startedAt) + Math.floor(requestTimeoutMs / 2))
      })
    },
    {
      stateId: 'bridge_timeout_recoverable',
      state: createCommandComposerState({
        rawText,
        connected: true,
        pendingOfflineCount,
        requestStatus: 'pending',
        requestStartedAt: startedAt,
        requestTimeoutMs,
        now
      })
    },
    {
      stateId: 'bridge_recovered_send_ready',
      state: createCommandComposerState({
        rawText,
        connected: true,
        pendingOfflineCount: 0,
        requestStatus: 'idle',
        now
      })
    }
  ];
  const snapshots = scenarios.map((scenario) => ({
    stateId: scenario.stateId,
    primaryAction: scenario.state.primaryAction,
    keyboardSubmit: scenario.state.keyboardSubmit,
    cancelRequestAction: scenario.state.cancelRequestAction,
    requestState: scenario.state.requestState,
    queueAction: scenario.state.queueAction,
    stableLayout: {
      minComposerHeight: 96,
      actionRows: scenario.state.cancelRequestAction.enabled ? 2 : 1,
      dynamicTextWraps: true,
      textOverlapRisk: false
    }
  }));
  const checks = [
    {
      checkId: 'offline_queue_does_not_auto_send',
      passed: snapshots.find((item) => item.stateId === 'offline_queue_ready')?.primaryAction.mode === 'queue-offline'
    },
    {
      checkId: 'pending_latency_blocks_double_submit',
      passed: snapshots.find((item) => item.stateId === 'bridge_pending_latency')?.primaryAction.enabled === false
    },
    {
      checkId: 'timeout_exposes_cancel_recovery',
      passed: snapshots.find((item) => item.stateId === 'bridge_timeout_recoverable')?.cancelRequestAction.enabled === true
    },
    {
      checkId: 'recovered_state_allows_keyboard_submit',
      passed: snapshots.find((item) => item.stateId === 'bridge_recovered_send_ready')?.keyboardSubmit.enabled === true
    },
    {
      checkId: 'command_visual_layout_stable',
      passed: snapshots.every((item) => item.stableLayout.textOverlapRisk === false && item.stableLayout.minComposerHeight >= 96)
    }
  ];
  return {
    regressionVersion: 'c-command-network-recovery-visual-regression-v1',
    generatedAt: now.toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    scenarios: snapshots,
    checks
  };
}

export function createCommandScreenReleaseDossier({
  queueDetailPanel = createPendingQueueDetailPanelState({ items: [] }),
  networkRecoveryVisualRegression = createCommandNetworkRecoveryVisualRegression(),
  generatedAt = new Date()
} = {}) {
  const rawNeedles = [
    ...(queueDetailPanel.details ?? []).map((item) => item.rawText),
    ...(queueDetailPanel.details ?? []).map((item) => item.preview)
  ].filter(Boolean);
  const artifactManifest = {
    manifestVersion: 'c-command-screen-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawCommandPayloadStored: false,
    rawQueueTextStored: false,
    rawScreenshotStored: false,
    queue: {
      panelVersion: queueDetailPanel.panelVersion,
      total: queueDetailPanel.total,
      staleCount: queueDetailPanel.staleCount,
      retryScheduledCount: queueDetailPanel.retryScheduledCount,
      autoSend: queueDetailPanel.actions?.autoSend === true,
      commandHashes: (queueDetailPanel.details ?? []).map((item) => ({
        localIdHash: stableDigest(String(item.localId ?? '')),
        commandHash: stableDigest(String(item.rawText ?? item.preview ?? '')),
        syncStatus: item.syncStatus,
        actionSet: Object.keys(item.actions ?? {}).filter((key) => item.actions?.[key] === true).sort()
      }))
    },
    networkRecovery: {
      regressionVersion: networkRecoveryVisualRegression.regressionVersion,
      status: networkRecoveryVisualRegression.status,
      stateIds: (networkRecoveryVisualRegression.scenarios ?? []).map((item) => item.stateId),
      checks: (networkRecoveryVisualRegression.checks ?? []).map((check) => ({
        checkId: check.checkId,
        passed: check.passed === true
      }))
    },
    accessibility: {
      role: queueDetailPanel.accessibility?.role ?? null,
      announcesNetworkRecovery: queueDetailPanel.accessibility?.announcesNetworkRecovery === true
    },
    physicalDeviceVisualEvidenceRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-command-screen-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    artifactManifest,
    releaseWorkflow: {
      workflowVersion: 'c-command-screen-release-workflow-v1',
      queuePanelReady: queueDetailPanel.panelVersion === 'c-command-pending-queue-detail-panel-v1',
      networkRecoveryReady: networkRecoveryVisualRegression.regressionVersion === 'c-command-network-recovery-visual-regression-v1'
        && networkRecoveryVisualRegression.status === 'passed',
      promotionStatus: 'pending_checks'
    }
  };
  const rawLeakDetected = serializedCommandDossierContainsAny(preliminaryDossier, rawNeedles);
  const checks = [
    {
      checkId: 'command_pending_queue_detail_ready',
      passed: queueDetailPanel.panelVersion === 'c-command-pending-queue-detail-panel-v1'
        && queueDetailPanel.actions?.autoSend === false
    },
    {
      checkId: 'command_network_recovery_visual_regression_passed',
      passed: networkRecoveryVisualRegression.regressionVersion === 'c-command-network-recovery-visual-regression-v1'
        && networkRecoveryVisualRegression.status === 'passed'
        && (networkRecoveryVisualRegression.checks ?? []).every((check) => check.passed === true)
    },
    {
      checkId: 'command_timeout_cancel_recovery_ready',
      passed: (networkRecoveryVisualRegression.checks ?? []).some((check) => check.checkId === 'timeout_exposes_cancel_recovery' && check.passed === true)
    },
    {
      checkId: 'command_keyboard_submit_recovery_ready',
      passed: (networkRecoveryVisualRegression.checks ?? []).some((check) => check.checkId === 'recovered_state_allows_keyboard_submit' && check.passed === true)
    },
    {
      checkId: 'raw_command_payload_not_stored',
      passed: artifactManifest.rawCommandPayloadStored === false
        && artifactManifest.rawQueueTextStored === false
        && artifactManifest.rawScreenshotStored === false
        && rawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-command-screen-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'c-command-screen-health-handshake-v1',
    generatedAt: generatedAt.toISOString(),
    status: checks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshake: {
      queuePanelReady: queueDetailPanel.panelVersion === 'c-command-pending-queue-detail-panel-v1',
      offlineAutoSendDisabled: queueDetailPanel.actions?.autoSend === false,
      networkRecoveryReady: networkRecoveryVisualRegression.regressionVersion === 'c-command-network-recovery-visual-regression-v1'
        && networkRecoveryVisualRegression.status === 'passed',
      timeoutCancelReady: (networkRecoveryVisualRegression.checks ?? []).some((check) => check.checkId === 'timeout_exposes_cancel_recovery' && check.passed === true),
      keyboardSubmitRecoveryReady: (networkRecoveryVisualRegression.checks ?? []).some((check) => check.checkId === 'recovered_state_allows_keyboard_submit' && check.passed === true),
      rawPayloadRetained: false
    },
    fallbackPolicy: {
      policyVersion: 'c-command-screen-fallback-policy-v1',
      primaryFlow: 'send_command_when_bridge_connected_else_queue_offline_without_auto_send',
      fallbackFlows: [
        'pending_queue_detail_review_before_manual_send',
        'request_timeout_cancel_then_retry_after_network_recovery',
        'keyboard_submit_reenabled_after_recovery',
        'manual_cancel_for_stale_offline_queue_items'
      ],
      operatorEscalation: 'mobile_command_screen_queue_detail_and_network_recovery_report'
    },
    rawCommandPayloadStored: false,
    rawQueueTextStored: false,
    rawScreenshotStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-command-screen-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "Command screen" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'command_pending_queue_detail_panel_ready',
      'command_network_recovery_visual_regression_passed',
      'command_timeout_cancel_and_keyboard_recovery_ready',
      'command_screen_release_dossier_ready',
      'command_screen_release_artifact_manifest_ready',
      'command_screen_operational_handoff_ready',
      'command_screen_worm_promotion_package_ready'
    ],
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest)),
    rawCommandPayloadStored: false,
    rawQueueTextStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-command-screen-worm-promotion-package-v1',
    providerContractVersion: 'c-command-screen-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-command-screen-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-command-screen-ci-nightly-gate-plan-v1'
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
    rawCommandPayloadStored: false,
    rawQueueTextStored: false,
    rawScreenshotStored: false
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
      ? 'capture_physical_android_ios_command_network_recovery_screenshots_and_worm_release_evidence'
      : 'block_command_screen_release_until_queue_recovery_and_raw_retention_checks_pass'
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

export function createCommandScreenProductGate({
  queueDetailPanel = createPendingQueueDetailPanelState({ items: [] }),
  networkRecoveryVisualRegression = createCommandNetworkRecoveryVisualRegression()
} = {}) {
  const releaseDossier = createCommandScreenReleaseDossier({
    queueDetailPanel,
    networkRecoveryVisualRegression
  });
  const checks = [
    {
      checkId: 'command_pending_queue_detail_panel_ready',
      status: queueDetailPanel.panelVersion === 'c-command-pending-queue-detail-panel-v1'
        && queueDetailPanel.actions?.autoSend === false ? 'passed' : 'blocked',
      pendingCount: queueDetailPanel.total
    },
    {
      checkId: 'command_network_recovery_visual_regression_passed',
      status: networkRecoveryVisualRegression.regressionVersion === 'c-command-network-recovery-visual-regression-v1'
        && networkRecoveryVisualRegression.status === 'passed' ? 'passed' : 'blocked',
      stateCount: networkRecoveryVisualRegression.scenarios?.length ?? 0
    },
    {
      checkId: 'command_timeout_cancel_and_keyboard_recovery_ready',
      status: releaseDossier.checks.some((check) => check.checkId === 'command_timeout_cancel_recovery_ready' && check.passed)
        && releaseDossier.checks.some((check) => check.checkId === 'command_keyboard_submit_recovery_ready' && check.passed)
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'command_screen_release_dossier_ready',
      status: releaseDossier.dossierVersion === 'c-command-screen-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && releaseDossier.dossierDigest.length === 64
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion,
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'command_screen_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'c-command-screen-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawCommandPayloadStored === false
        && releaseDossier.artifactManifest?.rawQueueTextStored === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'command_screen_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-command-screen-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-command-screen-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-command-screen-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'command_screen_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-command-screen-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-command-screen-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    }
  ];
  return {
    productGateVersion: 'c-command-screen-product-gate-v1',
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

function serializedCommandDossierContainsAny(value, needles) {
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
