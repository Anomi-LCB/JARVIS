import {
  createGrowthDecisionSubmissionState,
  createGrowthConflictResolutionState,
  createGrowthHygieneDecisionState,
  createGrowthMaturityReviewState,
  createGrowthReviewDecisionActionKey,
  createGrowthReviewDecisionState,
  createGrowthReviewVisualSnapshot,
  createPatternClusterReviewState
} from '../components/GrowthReviewDecisionPanel.js';

export function createGrowthReviewScreenViewModel({ mobileRuntime }) {
  const review = mobileRuntime.growthReview();
  const decisionState = createGrowthReviewDecisionState({ review });
  const hygieneDecisionState = createGrowthHygieneDecisionState({ review });
  const maturityState = createGrowthMaturityReviewState({ review });
  const patternClusterReviewState = createPatternClusterReviewState({ review });
  const conflictResolutionState = createGrowthConflictResolutionState({ review });
  const visualSnapshot = createGrowthReviewVisualSnapshot({
    review,
    hygieneDecisionState,
    conflictResolutionState
  });
  return {
    route: 'GrowthReviewScreen',
    review,
    decisionState,
    hygieneDecisionState,
    maturityState,
    patternClusterReviewState,
    conflictResolutionState,
    visualSnapshot,
    repeatedTasks: review.repeatedTasks ?? [],
    preferenceCandidates: review.preferenceCandidates ?? [],
    failureLessons: review.failureLessons ?? [],
    patternClusterReview: review.patternClusterReview ?? null,
    hygiene: review.hygiene ?? null,
    hygieneQueue: hygieneDecisionState.items,
    patternReviewQueue: patternClusterReviewState.items,
    recommendations: review.recommendations ?? [],
    empty: (review.repeatedTasks ?? []).length === 0
      && (review.preferenceCandidates ?? []).length === 0
      && (review.failureLessons ?? []).length === 0
      && (review.hygiene?.reviewQueue ?? []).length === 0
      && (review.patternClusterReview?.items ?? []).length === 0
      && (review.recommendations ?? []).length === 0,
    refresh() {
      return mobileRuntime.growthReview();
    },
    decidePreference(hypothesisId, decision, reason = '') {
      const startedAt = Date.now();
      const actionKey = createGrowthReviewDecisionActionKey(hypothesisId, decision);
      const action = decisionState.candidates
        .find((candidate) => candidate.hypothesisId === hypothesisId)
        ?.actions.find((item) => item.decision === decision);
      if (!action?.enabled) {
        const error = { code: 'C_GROWTH_DECISION_NOT_AVAILABLE' };
        return {
          success: false,
          error,
          submission: createGrowthDecisionSubmissionState({
            actionKey,
            error,
            latencyMs: Date.now() - startedAt
          }),
          decisionState: createGrowthReviewDecisionState({
            review,
            actionErrors: { [actionKey]: error }
          })
        };
      }
      const result = mobileRuntime.decideGrowthPreference({ hypothesisId, decision, reason });
      const latencyMs = Date.now() - startedAt;
      const error = result?.success === false ? result.error : null;
      return {
        ...result,
        submission: createGrowthDecisionSubmissionState({
          actionKey,
          success: result?.success !== false,
          error,
          latencyMs
        }),
        decisionState: createGrowthReviewDecisionState({
          review: result?.success === false ? review : mobileRuntime.growthReview(),
          actionErrors: error ? { [actionKey]: error } : {},
          latencyByAction: { [actionKey]: latencyMs },
          lastDecision: {
            kind: 'preference',
            hypothesisId,
            decision,
            success: result?.success !== false,
            latencyMs
          }
        })
      };
    },
    decideHygiene(targetId, action, reason = '') {
      const startedAt = Date.now();
      const actionKey = createGrowthReviewDecisionActionKey(targetId, action);
      const item = hygieneDecisionState.items.find((candidate) => candidate.targetId === targetId);
      if (!item) {
        const error = { code: 'C_GROWTH_HYGIENE_ITEM_NOT_AVAILABLE' };
        return {
          success: false,
          error,
          submission: createGrowthDecisionSubmissionState({
            actionKey,
            error,
            latencyMs: Date.now() - startedAt
          }),
          hygieneDecisionState: createGrowthHygieneDecisionState({
            review,
            actionErrors: { [actionKey]: error }
          })
        };
      }
      if (!['keep', 'delete', 'redact', 'defer'].includes(action)) {
        const error = { code: 'C_GROWTH_HYGIENE_ACTION_INVALID' };
        return {
          success: false,
          error,
          submission: createGrowthDecisionSubmissionState({
            actionKey,
            error,
            latencyMs: Date.now() - startedAt
          }),
          hygieneDecisionState: createGrowthHygieneDecisionState({
            review,
            actionErrors: { [actionKey]: error }
          })
        };
      }
      const result = mobileRuntime.decideGrowthHygiene({
        targetType: item.targetType,
        targetId,
        action,
        reason
      });
      const latencyMs = Date.now() - startedAt;
      const error = result?.success === false ? result.error : null;
      return {
        ...result,
        submission: createGrowthDecisionSubmissionState({
          actionKey,
          success: result?.success !== false,
          error,
          latencyMs
        }),
        hygieneDecisionState: createGrowthHygieneDecisionState({
          review: result?.success === false ? review : mobileRuntime.growthReview(),
          actionErrors: error ? { [actionKey]: error } : {},
          latencyByAction: { [actionKey]: latencyMs },
          lastDecision: {
            kind: 'hygiene',
            targetId,
            action,
            success: result?.success !== false,
            latencyMs
          }
        })
      };
    },
    decideHygieneBatch(targetIds = hygieneDecisionState.batchSelection.selectedTargetIds, reason = 'mobile hygiene batch review') {
      const startedAt = Date.now();
      const selected = createGrowthHygieneDecisionState({
        review,
        selectedTargetIds: targetIds
      }).batchSelection;
      if (!selected.canSubmit) {
        const error = { code: 'C_GROWTH_HYGIENE_BATCH_EMPTY' };
        return {
          success: false,
          error,
          submission: createGrowthDecisionSubmissionState({
            actionKey: 'hygiene-batch',
            error,
            latencyMs: Date.now() - startedAt
          }),
          hygieneDecisionState
        };
      }
      const result = mobileRuntime.decideGrowthHygieneBatch({
        decisions: selected.decisions,
        reason
      });
      const latencyMs = Date.now() - startedAt;
      const error = result?.success === false ? result.error : null;
      const nextReview = result?.success === false ? review : mobileRuntime.growthReview();
      const nextHygieneDecisionState = createGrowthHygieneDecisionState({
        review: nextReview,
        lastDecision: {
          kind: 'hygiene_batch',
          targetIds: selected.selectedTargetIds,
          appliedCount: result?.appliedCount ?? 0,
          failedCount: result?.failedCount ?? 0,
          success: result?.success !== false,
          latencyMs
        }
      });
      return {
        ...result,
        batchSelection: selected,
        submission: createGrowthDecisionSubmissionState({
          actionKey: 'hygiene-batch',
          success: result?.success !== false,
          error,
          latencyMs
        }),
        hygieneDecisionState: nextHygieneDecisionState,
        visualSnapshot: createGrowthReviewVisualSnapshot({
          review: nextReview,
          hygieneDecisionState: nextHygieneDecisionState,
          conflictResolutionState: createGrowthConflictResolutionState({ review: nextReview })
        })
      };
    },
    productGate() {
      return createGrowthReviewProductGate({
        review,
        visualSnapshot,
        hygieneDecisionState,
        conflictResolutionState
      });
    }
  };
}

export function createGrowthReviewReleaseDossier({
  review = null,
  visualSnapshot = createGrowthReviewVisualSnapshot({ review }),
  hygieneDecisionState = createGrowthHygieneDecisionState({ review }),
  conflictResolutionState = createGrowthConflictResolutionState({ review }),
  generatedAt = new Date()
} = {}) {
  const artifactManifest = {
    manifestVersion: 'c-growth-review-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawPreferencePayloadStored: false,
    rawMemoryPayloadStored: false,
    rawConflictEvidenceStored: false,
    review: {
      reviewIdHash: stableDigest(String(review?.reviewId ?? '')),
      preferenceCandidateCount: visualSnapshot.preferenceCandidateCount,
      hygieneQueueCount: visualSnapshot.hygieneQueueCount,
      conflictCount: visualSnapshot.conflictCount,
      recommendationCount: review?.recommendations?.length ?? 0
    },
    visualSnapshot: {
      snapshotVersion: visualSnapshot.snapshotVersion,
      surface: visualSnapshot.surface,
      passed: visualSnapshot.passed === true,
      checkIds: (visualSnapshot.checks ?? []).map((check) => check.id)
    },
    hygiene: {
      trendChartVersion: hygieneDecisionState.trendChart?.chartVersion ?? null,
      trendPointCount: hygieneDecisionState.trendChart?.points?.length ?? 0,
      batchSelectionVersion: hygieneDecisionState.batchSelection?.selectionVersion ?? null,
      selectedCount: hygieneDecisionState.batchSelection?.selectedCount ?? 0,
      selectedTargetHashes: (hygieneDecisionState.batchSelection?.selectedTargetIds ?? [])
        .map((targetId) => stableDigest(String(targetId)))
    },
    conflictResolution: {
      modalVersion: conflictResolutionState.modalVersion,
      explanationVersion: conflictResolutionState.explanationVersion,
      conflictCount: conflictResolutionState.conflictCount,
      visible: conflictResolutionState.visible === true,
      confirmBlockedUntilAcknowledged: conflictResolutionState.confirmBlockedUntilAcknowledged === true,
      selectedHypothesisHash: stableDigest(String(conflictResolutionState.selectedHypothesisId ?? ''))
    },
    physicalDeviceVisualEvidenceRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-growth-review-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    releaseWorkflow: {
      workflowVersion: 'c-growth-review-release-workflow-v1',
      visualSnapshotPassed: visualSnapshot.passed === true,
      hygieneBatchReady: hygieneDecisionState.batchSelection?.selectionVersion === 'c-growth-hygiene-batch-selection-v1',
      conflictModalReady: conflictResolutionState.modalVersion === 'c-growth-conflict-resolution-modal-v1',
      promotionStatus: 'pending_checks'
    },
    artifactManifest
  };
  const rawNeedles = [
    review?.reviewId,
    ...(review?.preferenceCandidates ?? []).map((candidate) => candidate.hypothesisId),
    ...(review?.hygiene?.reviewQueue ?? []).map((item) => item.targetId),
    conflictResolutionState.selectedHypothesisId
  ].filter(Boolean);
  const baseRawLeakDetected = serializedGrowthReviewContainsAny(preliminaryDossier, rawNeedles);
  const checks = [
    {
      checkId: 'growth_review_visual_snapshot_passed',
      passed: visualSnapshot.snapshotVersion === 'c-growth-review-visual-snapshot-v1'
        && visualSnapshot.passed === true
    },
    {
      checkId: 'growth_hygiene_trend_batch_ready',
      passed: hygieneDecisionState.trendChart?.chartVersion === 'c-growth-hygiene-trend-chart-v1'
        && (hygieneDecisionState.trendChart?.points?.length ?? 0) >= 3
        && hygieneDecisionState.batchSelection?.selectionVersion === 'c-growth-hygiene-batch-selection-v1'
    },
    {
      checkId: 'growth_conflict_modal_blocks_until_acknowledged',
      passed: conflictResolutionState.modalVersion === 'c-growth-conflict-resolution-modal-v1'
        && (!conflictResolutionState.hasConflicts || conflictResolutionState.confirmBlockedUntilAcknowledged === true)
    },
    {
      checkId: 'growth_decision_actions_ready',
      passed: !visualSnapshot.checks?.length
        ? false
        : visualSnapshot.checks.every((check) => check.passed === true)
    },
    {
      checkId: 'raw_growth_review_payload_not_stored',
      passed: artifactManifest.rawPreferencePayloadStored === false
        && artifactManifest.rawMemoryPayloadStored === false
        && artifactManifest.rawConflictEvidenceStored === false
        && baseRawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-growth-review-operational-handoff-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    owner: 'mobile-growth-review-release-owner',
    scope: 'growth_review_preferences_hygiene_conflicts_maturity',
    status: checks.every((check) => check.passed) && baseRawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'c-growth-review-health-handshake-v1',
    healthHandshake: {
      visualSnapshotPassed: visualSnapshot.snapshotVersion === 'c-growth-review-visual-snapshot-v1'
        && visualSnapshot.passed === true,
      hygieneTrendReady: hygieneDecisionState.trendChart?.chartVersion === 'c-growth-hygiene-trend-chart-v1'
        && (hygieneDecisionState.trendChart?.points?.length ?? 0) >= 3,
      hygieneBatchReady: hygieneDecisionState.batchSelection?.selectionVersion === 'c-growth-hygiene-batch-selection-v1',
      conflictModalReady: conflictResolutionState.modalVersion === 'c-growth-conflict-resolution-modal-v1'
        && (!conflictResolutionState.hasConflicts || conflictResolutionState.confirmBlockedUntilAcknowledged === true),
      rawLeakDetected: baseRawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'c-growth-review-fallback-policy-v1',
      primaryFlow: 'review_growth_preferences_hygiene_batch_and_conflicts_before_memory_promotion',
      fallbackFlows: [
        'block_conflict_confirmation_until_acknowledgement',
        'defer_hygiene_batch_when_selection_is_empty_or_partial',
        'route_low_confidence_preferences_to_manual_review',
        'hold_release_when_visual_snapshot_or_raw_retention_check_fails'
      ],
      operatorEscalation: 'mobile_growth_review_release_and_learning_handoff_report'
    },
    rawPreferencePayloadStored: false,
    rawMemoryPayloadStored: false,
    rawConflictEvidenceStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-growth-review-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "mobile Growth Review" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'growth_review_visual_snapshot_passed',
      'growth_hygiene_trend_batch_ready',
      'growth_conflict_modal_contract_ready',
      'growth_review_release_dossier_ready',
      'growth_review_release_artifact_manifest_ready',
      'growth_review_operational_handoff_ready',
      'growth_review_worm_promotion_package_ready'
    ],
    artifactManifestHash: stableDigest(canonicalJson(artifactManifest)),
    operationalHandoffHash: stableDigest(canonicalJson(operationalHandoffManifest)),
    rawPreferencePayloadStored: false,
    rawMemoryPayloadStored: false,
    rawConflictEvidenceStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-growth-review-worm-promotion-package-v1',
    providerContractVersion: 'c-growth-review-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-growth-review-release-artifact-manifest-v1'
      && baseRawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-growth-review-ci-nightly-gate-plan-v1'
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
    rawPreferencePayloadStored: false,
    rawMemoryPayloadStored: false,
    rawConflictEvidenceStored: false
  };
  const rawLeakDetected = baseRawLeakDetected
    || serializedGrowthReviewContainsAny(operationalHandoffManifest, rawNeedles)
    || serializedGrowthReviewContainsAny(ciNightlyGatePlan, rawNeedles)
    || serializedGrowthReviewContainsAny(externalWormPromotionPackage, rawNeedles);
  const dossier = {
    ...preliminaryDossier,
    status: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      && rawLeakDetected === false
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
      ? 'capture_physical_growth_review_trend_batch_conflict_screenshots'
      : 'block_growth_review_release_until_visual_hygiene_and_conflict_contracts_pass'
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

export function createGrowthReviewProductGate({
  review = null,
  visualSnapshot = createGrowthReviewVisualSnapshot({ review }),
  hygieneDecisionState = createGrowthHygieneDecisionState({ review }),
  conflictResolutionState = createGrowthConflictResolutionState({ review })
} = {}) {
  const releaseDossier = createGrowthReviewReleaseDossier({
    review,
    visualSnapshot,
    hygieneDecisionState,
    conflictResolutionState
  });
  const checks = [
    {
      checkId: 'growth_review_visual_snapshot_passed',
      status: releaseDossier.checks.some((check) => check.checkId === 'growth_review_visual_snapshot_passed' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'growth_hygiene_trend_batch_ready',
      status: releaseDossier.checks.some((check) => check.checkId === 'growth_hygiene_trend_batch_ready' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'growth_conflict_modal_contract_ready',
      status: releaseDossier.checks.some((check) => check.checkId === 'growth_conflict_modal_blocks_until_acknowledged' && check.passed) ? 'passed' : 'blocked'
    },
    {
      checkId: 'growth_review_release_dossier_ready',
      status: releaseDossier.dossierVersion === 'c-growth-review-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && releaseDossier.dossierDigest.length === 64
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'growth_review_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'c-growth-review-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawPreferencePayloadStored === false
        && releaseDossier.artifactManifest?.rawMemoryPayloadStored === false
        && releaseDossier.artifactManifest?.rawConflictEvidenceStored === false
        ? 'passed'
        : 'blocked',
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'growth_review_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-growth-review-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-growth-review-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-growth-review-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'growth_review_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-growth-review-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-growth-review-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierDigest: releaseDossier.dossierDigest
    }
  ];
  return {
    productGateVersion: 'c-growth-review-product-gate-v1',
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

function serializedGrowthReviewContainsAny(value, needles) {
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
