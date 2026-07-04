import { createResultFeedbackState, createRollbackProofModalState } from '../components/ResultFeedbackPanel.js';

export function createResultScreenViewModel({ taskId, mobileRuntime }) {
  const result = mobileRuntime.result(taskId);
  const feedbackState = createResultFeedbackState({ result, feedbackText: '' });
  const findPreview = (previewId) => feedbackState.filePreviews.find((item) => item.previewId === previewId);
  return {
    route: 'ResultScreen',
    result,
    outputPaths: result.executionResult?.outputPaths ?? [],
    filePreviews: feedbackState.filePreviews,
    rollbackAvailable: result.executionResult?.rollbackAvailable === true,
    rollbackAction: feedbackState.rollbackAction,
    rollbackConfirmation: feedbackState.rollbackAction.confirmation,
    feedbackState,
    feedbackOptions(feedbackText = '', options = {}) {
      return createResultFeedbackState({ result, feedbackText, ...options });
    },
    requestRollback(reason = 'mobile_result_rollback') {
      const state = createResultFeedbackState({
        result,
        rollbackConfirmation: { visible: true, reason }
      });
      return {
        action: state.rollbackAction,
        confirmation: state.rollbackAction.confirmation
      };
    },
    async previewFile(previewId) {
      const preview = findPreview(previewId);
      if (!preview || !preview.actions.preview.enabled) {
        return {
          success: false,
          error: { code: 'C_FILE_PREVIEW_NOT_AVAILABLE' },
          previewId
        };
      }
      const action = await mobileRuntime.previewOutputFile({ taskId, preview });
      return {
        ...action,
        state: createResultFeedbackState({
          result,
          fileAction: action
        })
      };
    },
    async shareFile(previewId) {
      const preview = findPreview(previewId);
      if (!preview || !preview.actions.share.enabled) {
        return {
          success: false,
          error: { code: 'C_FILE_SHARE_NOT_AVAILABLE' },
          previewId
        };
      }
      const action = await mobileRuntime.shareOutputFile({ taskId, preview });
      return {
        ...action,
        state: createResultFeedbackState({
          result,
          fileAction: action
        })
      };
    },
    feedback(feedbackType, text) {
      const pendingState = createResultFeedbackState({ result, feedbackText: text, pending: true });
      const state = createResultFeedbackState({ result, feedbackText: text });
      const action = state.feedbackActions.find((item) => item.feedbackType === feedbackType);
      if (action && !action.enabled) {
        return {
          stored: false,
          pendingState,
          state: createResultFeedbackState({
            result,
            feedbackText: text,
            error: { code: 'C_FEEDBACK_TEXT_REQUIRED' }
          }),
          error: { code: 'C_FEEDBACK_TEXT_REQUIRED' }
        };
      }
      const submitted = mobileRuntime.sendFeedback({ taskId, feedbackType, text });
      return {
        ...submitted,
        pendingState,
        state: createResultFeedbackState({
          result,
          feedbackText: text,
          error: submitted?.success === false ? submitted.error : null,
          lastSubmittedAt: submitted?.stored ? new Date().toISOString() : null
        })
      };
    },
    async rollback(reason = 'mobile_result_rollback', { confirmed = true } = {}) {
      if (!feedbackState.rollbackAction.enabled) {
        return {
          success: false,
          error: { code: 'C_ROLLBACK_NOT_AVAILABLE' },
          action: feedbackState.rollbackAction
        };
      }
      if (confirmed !== true) {
        const state = createResultFeedbackState({
          result,
          rollbackConfirmation: { visible: true, reason }
        });
        return {
          success: false,
          error: { code: 'C_ROLLBACK_CONFIRMATION_REQUIRED' },
          action: state.rollbackAction,
          confirmation: state.rollbackAction.confirmation
        };
      }
      const rollback = await mobileRuntime.rollbackResult({ taskId, reason });
      const proofModal = createRollbackProofModalState({
        result: rollback?.result?.executionResult ?? result.executionResult ?? result,
        rollback: rollback?.rollback,
        visible: rollback?.success === true
      });
      return {
        ...rollback,
        action: {
          ...feedbackState.rollbackAction,
          pending: false,
          completed: rollback?.success === true,
          error: rollback?.success === false ? rollback.error : null,
          proofModal
        },
        proofModal
      };
    },
    rollbackProofModal(rollback) {
      return createRollbackProofModalState({
        result: result.executionResult ?? result,
        rollback
      });
    },
    productGate({ pollingRegression = null, rollbackProofModal = null } = {}) {
      return createResultScreenProductGate({
        result,
        feedbackState,
        pollingRegression,
        rollbackProofModal
      });
    },
    openGrowthReview() {
      return { nextRoute: 'GrowthReviewScreen' };
    }
  };
}

export function createResultScreenProductGate({
  result,
  feedbackState = createResultFeedbackState({ result }),
  pollingRegression = null,
  rollbackProofModal = null
} = {}) {
  const releaseDossier = createResultScreenReleaseDossier({
    result,
    feedbackState,
    pollingRegression,
    rollbackProofModal
  });
  const checks = [
    {
      checkId: 'long_polling_visual_regression_passed',
      status: pollingRegression?.reportVersion === 'c-task-status-long-polling-latency-visual-regression-v1' && pollingRegression.status === 'passed' ? 'passed' : 'blocked',
      p95LatencyMs: pollingRegression?.p95LatencyMs ?? null
    },
    {
      checkId: 'file_preview_share_contract_available',
      status: feedbackState.filePreviews.every((preview) => preview.actions.preview.enabled && preview.actions.share.enabled) ? 'passed' : 'blocked',
      filePreviewCount: feedbackState.filePreviews.length
    },
    {
      checkId: 'rollback_confirmation_required',
      status: feedbackState.rollbackAction.confirmation?.confirmationVersion === 'c-result-rollback-confirmation-v1' && feedbackState.rollbackAction.requiresConfirmation === true ? 'passed' : 'blocked'
    },
    {
      checkId: 'rollback_proof_modal_available',
      status: rollbackProofModal?.modalVersion === 'c-result-rollback-proof-modal-v1' ? 'passed' : 'blocked',
      transactionStatus: rollbackProofModal?.transactionStatus ?? null
    },
    {
      checkId: 'feedback_growth_review_route_available',
      status: feedbackState.growthReviewAction.nextRoute === 'GrowthReviewScreen' ? 'passed' : 'blocked'
    },
    {
      checkId: 'result_feedback_release_dossier_ready',
      status: releaseDossier.status === 'passed'
        && releaseDossier.dossierDigest.length === 64
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'result_feedback_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'c-result-feedback-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawOutputPathsStored === false
        && releaseDossier.artifactManifest?.rawRollbackProofPathsStored === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'result_feedback_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-result-feedback-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-result-feedback-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-result-feedback-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'result_feedback_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-result-feedback-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-result-feedback-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    }
  ];
  return {
    productGateVersion: 'c-result-feedback-product-gate-v1',
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

export function createResultScreenReleaseDossier({
  result,
  feedbackState = createResultFeedbackState({ result }),
  pollingRegression = null,
  rollbackProofModal = null
} = {}) {
  const releaseChecks = [
    {
      checkId: 'result_long_polling_regression_ready',
      passed: pollingRegression?.reportVersion === 'c-task-status-long-polling-latency-visual-regression-v1'
        && pollingRegression.status === 'passed',
      p95LatencyMs: pollingRegression?.p95LatencyMs ?? null
    },
    {
      checkId: 'result_preview_share_contract_ready',
      passed: feedbackState.filePreviews.length > 0
        && feedbackState.filePreviews.every((preview) => preview.actions.preview.enabled && preview.actions.share.enabled)
        && feedbackState.filePreviews.every((preview) => preview.actions.share.nativeAdapter === 'expo-sharing'),
      filePreviewCount: feedbackState.filePreviews.length
    },
    {
      checkId: 'result_rollback_confirmation_ready',
      passed: feedbackState.rollbackAction.requiresConfirmation === true
        && feedbackState.rollbackAction.confirmation?.confirmationVersion === 'c-result-rollback-confirmation-v1',
      rollbackAvailable: feedbackState.rollbackAvailable === true
    },
    {
      checkId: 'result_rollback_proof_modal_ready',
      passed: rollbackProofModal?.modalVersion === 'c-result-rollback-proof-modal-v1'
        && ['verified', 'needs_review'].includes(rollbackProofModal.status),
      modalStatus: rollbackProofModal?.status ?? null
    },
    {
      checkId: 'result_growth_review_route_ready',
      passed: feedbackState.growthReviewAction.enabled === true
        && feedbackState.growthReviewAction.nextRoute === 'GrowthReviewScreen'
    }
  ];
  const taskId = result?.taskId ?? result?.executionResult?.taskId ?? null;
  const resultStatus = result?.executionResult?.status ?? result?.status ?? null;
  const verificationStatus = result?.verification?.status ?? result?.verificationStatus ?? null;
  const outputPaths = result?.executionResult?.outputPaths ?? result?.outputPaths ?? [];
  const proofRows = rollbackProofModal?.proofRows ?? [];
  const rawNeedles = [
    ...outputPaths,
    ...proofRows.map((row) => row.path),
    ...feedbackState.filePreviews.map((preview) => preview.path),
    ...feedbackState.filePreviews.map((preview) => preview.uri)
  ].filter((needle) => typeof needle === 'string' && needle.length > 0);
  const preliminaryDossier = {
    dossierVersion: 'c-result-feedback-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    taskId,
    resultStatus,
    verificationStatus,
    filePreviews: feedbackState.filePreviews.map((preview) => ({
      previewId: preview.previewId,
      previewType: preview.previewType,
      mimeType: preview.mimeType,
      previewEnabled: preview.actions.preview.enabled,
      shareEnabled: preview.actions.share.enabled
    })),
    rollback: {
      available: feedbackState.rollbackAvailable === true,
      confirmationVersion: feedbackState.rollbackAction.confirmation?.confirmationVersion ?? null,
      proofModalVersion: rollbackProofModal?.modalVersion ?? null,
      proofModalStatus: rollbackProofModal?.status ?? null
    },
    pollingRegression: {
      reportVersion: pollingRegression?.reportVersion ?? null,
      status: pollingRegression?.status ?? null,
      p95LatencyMs: pollingRegression?.p95LatencyMs ?? null
    },
    releaseWorkflow: {
      workflowVersion: 'c-result-feedback-release-workflow-v1',
      requiredEvidence: [
        'task_status_long_polling_visual_regression',
        'native_preview_share_contract',
        'rollback_confirmation_and_proof_modal',
        'growth_review_route',
        'hash_only_release_artifact_manifest',
        'operational_handoff_manifest',
        'external_worm_promotion_package'
      ],
      promotionStatus: 'pending'
    },
    releaseChecks
  };
  const artifactManifest = {
    manifestVersion: 'c-result-feedback-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    artifactScope: 'mobile_result_status_feedback_rollback_release',
    taskStatusPollingRegression: {
      reportVersion: pollingRegression?.reportVersion ?? null,
      status: pollingRegression?.status ?? null,
      p95LatencyMs: pollingRegression?.p95LatencyMs ?? null
    },
    previewShareContract: {
      filePreviewCount: feedbackState.filePreviews.length,
      previewAdapter: 'react-native-linking',
      shareAdapter: 'expo-sharing',
      contractFallbackAllowed: true
    },
    outputPathFingerprints: outputPaths.map((path, index) => {
      const value = String(path ?? '');
      const name = value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
      const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
      return {
        previewId: `file_preview_${index + 1}`,
        pathDigest: stableDigest(canonicalJson({ index, path: value })),
        extension,
        mimeType: feedbackState.filePreviews[index]?.mimeType ?? 'application/octet-stream'
      };
    }),
    rollbackProof: {
      modalVersion: rollbackProofModal?.modalVersion ?? null,
      status: rollbackProofModal?.status ?? null,
      transactionStatus: rollbackProofModal?.transactionStatus ?? null,
      proofRowFingerprints: proofRows.map((row) => ({
        rowId: row.rowId,
        status: row.status,
        pathDigest: row.path ? stableDigest(canonicalJson({ rowId: row.rowId, path: row.path })) : null,
        action: row.action ?? null,
        reason: row.reason ?? null
      }))
    },
    releaseCheckDigest: stableDigest(canonicalJson(releaseChecks)),
    rawOutputPathsStored: false,
    rawRollbackProofPathsStored: false,
    rawFeedbackTextStored: false,
    rawFileUrisStored: false
  };
  const rawLeakDetected = serializedResultDossierContainsAny(preliminaryDossier, rawNeedles)
    || serializedResultDossierContainsAny(artifactManifest, rawNeedles);
  const operationalHandoffManifest = {
    manifestVersion: 'c-result-feedback-operational-handoff-manifest-v1',
    generatedAt: new Date().toISOString(),
    owner: 'mobile-result-feedback-release-owner',
    scope: 'task_status_result_feedback_preview_share_rollback',
    status: releaseChecks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'c-result-feedback-health-handshake-v1',
    healthHandshake: {
      pollingRegressionPassed: pollingRegression?.status === 'passed',
      previewShareContractReady: feedbackState.filePreviews.length > 0
        && feedbackState.filePreviews.every((preview) => preview.actions.preview.enabled && preview.actions.share.enabled),
      rollbackProofModalReady: rollbackProofModal?.modalVersion === 'c-result-rollback-proof-modal-v1',
      growthReviewRouteReady: feedbackState.growthReviewAction.nextRoute === 'GrowthReviewScreen',
      rawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'c-result-feedback-fallback-policy-v1',
      primaryFlow: 'poll_task_status_then_show_result_preview_share_feedback_and_confirmed_rollback',
      fallbackFlows: [
        'show_contract_fallback_when_native_preview_or_share_adapter_is_unavailable',
        'block_rollback_until_confirmation_and_proof_modal_are_available',
        'route_feedback_to_growth_review_when_learning_context_requires_user_review',
        'hold_release_when_long_polling_latency_visual_regression_fails'
      ],
      operatorEscalation: 'mobile_result_screen_release_and_rollback_evidence_review'
    },
    rawOutputPathsStored: false,
    rawRollbackProofPathsStored: false,
    rawFeedbackTextStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-result-feedback-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "mobile runtime pairs" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'long_polling_visual_regression_passed',
      'file_preview_share_contract_available',
      'rollback_confirmation_required',
      'rollback_proof_modal_available',
      'feedback_growth_review_route_available',
      'result_feedback_release_dossier_ready',
      'result_feedback_release_artifact_manifest_ready',
      'result_feedback_operational_handoff_ready',
      'result_feedback_worm_promotion_package_ready'
    ],
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest)),
    rawOutputPathsStored: false,
    rawRollbackProofPathsStored: false,
    rawFeedbackTextStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-result-feedback-worm-promotion-package-v1',
    providerContractVersion: 'c-result-feedback-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-result-feedback-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-result-feedback-ci-nightly-gate-plan-v1'
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
    rawOutputPathsStored: false,
    rawRollbackProofPathsStored: false,
    rawFeedbackTextStored: false
  };
  const dossier = {
    ...preliminaryDossier,
    status: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
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
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'capture_physical_device_preview_share_and_rollback_proof_visual_regression'
      : 'block_result_screen_release_until_polling_preview_share_and_rollback_contracts_pass'
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

function serializedResultDossierContainsAny(value, needles) {
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
