import {
  createPoisonQueueActionState,
  createPoisonQueueNotificationUxSnapshot,
  createPoisonQueueOperationalEvidence,
  createPoisonQueueSummaryState,
  createPoisonQueueVisualRegressionReport
} from '../components/PoisonQueueActionPanel.js';
import { createPoisonQueueDelta } from '../mobile-runtime.js';

export function createPoisonQueueScreenViewModel({ mobileRuntime, includeIgnored = false } = {}) {
  const previousQueue = mobileRuntime.latestPoisonQueue ?? null;
  const poisonQueue = mobileRuntime.poisonQueue({ includeIgnored });
  const items = poisonQueue.items ?? [];
  const itemById = new Map(items.map((item) => [item.queueId, item]));
  const summaryState = createPoisonQueueSummaryState({
    queue: poisonQueue.queue ?? null,
    items,
    error: poisonQueue.error ?? null
  });
  const notificationUx = createPoisonQueueNotificationUxSnapshot({
    notificationStatus: mobileRuntime.notificationStatus(),
    summaryState
  });

  function actionState(queueId) {
    const item = itemById.get(queueId) ?? null;
    return createPoisonQueueActionState({
      item,
      readiness: mobileRuntime.sensitiveActionReadiness(`poison-packet:${queueId}`)
    });
  }

  return {
    route: 'PoisonQueueScreen',
    includeIgnored,
    queue: poisonQueue.queue ?? null,
    items,
    summaryState,
    visualRegression: summaryState.visualRegression,
    notificationUx,
    operationalEvidence: createPoisonQueueOperationalEvidence({
      before: summaryState,
      after: summaryState,
      notificationUx
    }),
    refreshState: {
      lastRefreshedAt: new Date().toISOString(),
      delta: createPoisonQueueDelta(previousQueue ?? poisonQueue, poisonQueue),
      visualSnapshot: summaryState.visualSnapshot
    },
    empty: items.length === 0,
    quarantinedCount: items.filter((item) => item.status === 'quarantined').length,
    ignoredCount: items.filter((item) => item.status === 'ignored').length,
    hasBlockingErrors: items.some((item) => item.error),
    select(queueId) {
      const item = itemById.get(queueId);
      if (!item) return { success: false, error: { code: 'C_POISON_PACKET_NOT_FOUND' } };
      return {
        nextRoute: 'PoisonQueueScreen',
        queueId,
        item,
        actionState: actionState(queueId)
      };
    },
    actionState,
    refresh(nextOptions = {}) {
      const before = mobileRuntime.latestPoisonQueue ?? poisonQueue;
      const refreshed = mobileRuntime.poisonQueue({
        includeIgnored: nextOptions.includeIgnored ?? includeIgnored
      });
      const refreshedItems = refreshed.items ?? [];
      const refreshedSummary = createPoisonQueueSummaryState({
        queue: refreshed.queue ?? null,
        items: refreshedItems,
        error: refreshed.error ?? null
      });
      return {
        ...refreshed,
        summaryState: refreshedSummary,
        visualRegression: createPoisonQueueVisualRegressionReport({
          snapshots: [summaryState.visualSnapshot, refreshedSummary.visualSnapshot]
        }),
        notificationUx: createPoisonQueueNotificationUxSnapshot({
          notificationStatus: mobileRuntime.notificationStatus(),
          summaryState: refreshedSummary
        }),
        refreshState: {
          lastRefreshedAt: new Date().toISOString(),
          delta: createPoisonQueueDelta(before, refreshed),
          visualSnapshot: refreshedSummary.visualSnapshot
        }
      };
    },
    async drainQueue({ limit = 10 } = {}) {
      const result = await mobileRuntime.drainPcAgentQueue({ limit, includeIgnored });
      return {
        ...result,
        visualRegression: createPoisonQueueVisualRegressionReport({
          snapshots: [
            createPoisonQueueSummaryState({
              queue: result.before?.queue ?? null,
              items: result.before?.items ?? [],
              error: result.before?.error ?? null
            }).visualSnapshot,
            createPoisonQueueSummaryState({
              queue: result.after?.queue ?? null,
              items: result.after?.items ?? [],
              error: result.after?.error ?? null
            }).visualSnapshot
          ]
        }),
        notificationUx: createPoisonQueueNotificationUxSnapshot({
          notificationStatus: mobileRuntime.notificationStatus(),
          summaryState: createPoisonQueueSummaryState({
            queue: result.after?.queue ?? null,
            items: result.after?.items ?? [],
            error: result.after?.error ?? null
          })
        }),
        refreshState: {
          lastRefreshedAt: new Date().toISOString(),
          delta: result.delta,
          visualSnapshot: createPoisonQueueSummaryState({
            queue: result.after?.queue ?? null,
            items: result.after?.items ?? [],
            error: result.after?.error ?? null
          }).visualSnapshot
        }
      };
    },
    async soakQueue(options = {}) {
      const result = await mobileRuntime.runPoisonQueueSoak({
        includeIgnored,
        ...options
      });
      const snapshots = result.results.flatMap((item) => [
        createPoisonQueueSummaryState({
          queue: item.before?.queue ?? null,
          items: item.before?.items ?? [],
          error: item.before?.error ?? null
        }).visualSnapshot,
        createPoisonQueueSummaryState({
          queue: item.after?.queue ?? null,
          items: item.after?.items ?? [],
          error: item.after?.error ?? null
        }).visualSnapshot
      ]);
      const latestSummary = createPoisonQueueSummaryState({
        queue: result.latest?.queue ?? null,
        items: result.latest?.items ?? [],
        error: result.latest?.error ?? null
      });
      const notificationUx = createPoisonQueueNotificationUxSnapshot({
        notificationStatus: mobileRuntime.notificationStatus(),
        summaryState: latestSummary,
        soak: result
      });
      const visualRegression = createPoisonQueueVisualRegressionReport({
        snapshots: [...snapshots, latestSummary.visualSnapshot]
      });
      return {
        ...result,
        visualRegression,
        notificationUx,
        operationalEvidence: createPoisonQueueOperationalEvidence({
          before: snapshots[0],
          after: latestSummary.visualSnapshot,
          soak: {
            ...result,
            visualSnapshot: latestSummary.visualSnapshot
          },
          notificationUx
        })
      };
    },
    review(queueId, note = '') {
      const state = actionState(queueId);
      if (!state.primaryAction.enabled) {
        return { success: false, error: { code: 'C_POISON_REVIEW_NOT_AVAILABLE', message: state.primaryAction.blockedReason } };
      }
      return mobileRuntime.reviewPoisonPacket({ queueId, note });
    },
    requeue(queueId, { patch = null, note = '' } = {}) {
      const state = actionState(queueId);
      if (!state.recoveryAction.enabled) {
        return { success: false, error: { code: 'C_POISON_REQUEUE_NOT_AVAILABLE', message: state.recoveryAction.blockedReason } };
      }
      return mobileRuntime.requeuePoisonPacket({ queueId, patch, note });
    },
    ignore(queueId, note = '') {
      const state = actionState(queueId);
      if (!state.destructiveAction.enabled) {
        return { success: false, error: { code: 'C_POISON_IGNORE_NOT_AVAILABLE', message: state.destructiveAction.blockedReason } };
      }
      return mobileRuntime.ignorePoisonPacket({ queueId, note });
    }
  };
}

export function createPoisonQueueReleaseDossier({
  queueState = {},
  reviewResult = null,
  requeueResult = null,
  drainResult = null,
  soakResult = null,
  visualRegression = soakResult?.visualRegression ?? queueState?.visualRegression ?? null,
  notificationUx = soakResult?.notificationUx ?? queueState?.notificationUx ?? null,
  operationalEvidence = soakResult?.operationalEvidence ?? queueState?.operationalEvidence ?? null,
  generatedAt = new Date()
} = {}) {
  const items = queueState.items ?? [];
  const rawNeedles = [
    queueState.queueId,
    ...(items.flatMap((item) => collectPoisonQueueRawNeedles(item))),
    ...collectPoisonQueueRawNeedles(reviewResult),
    ...collectPoisonQueueRawNeedles(requeueResult),
    ...collectPoisonQueueRawNeedles(drainResult),
    ...collectPoisonQueueRawNeedles(soakResult)
  ].filter((needle) => typeof needle === 'string' && needle.length >= 8);
  const snapshotStates = (visualRegression?.snapshots ?? []).map((snapshot) => ({
    stateHash: stablePoisonDigest(snapshot.status ?? snapshot.snapshotVersion ?? ''),
    tone: snapshot.tone ?? null,
    attentionPulse: snapshot.attentionPulse === true,
    actionBarEnabled: snapshot.actionBarEnabled === true,
    metricDigest: stablePoisonDigest(snapshot.metrics ?? {})
  }));
  const artifactManifest = {
    manifestVersion: 'c-poison-queue-release-artifact-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    rawPacketPayloadStored: false,
    rawQueueIdsStored: false,
    rawToolArgumentsStored: false,
    rawNotificationPayloadStored: false,
    rawScreenshotStored: false,
    queueSummary: {
      status: queueState.status ?? queueState.summaryState?.status ?? null,
      count: items.length,
      retryPolicyDigest: stablePoisonDigest(queueState.retryPolicy ?? queueState.summaryState?.retryPolicy ?? {}),
      metrics: {
        total: queueState.summaryState?.metrics?.total ?? queueState.queue?.total ?? items.length,
        queued: queueState.summaryState?.metrics?.queued ?? queueState.queue?.queued ?? 0,
        retryScheduled: queueState.summaryState?.metrics?.retryScheduled ?? queueState.queue?.retryScheduled ?? 0,
        quarantined: queueState.summaryState?.metrics?.quarantined ?? queueState.queue?.quarantined ?? 0,
        ignored: queueState.summaryState?.metrics?.ignored ?? queueState.queue?.ignored ?? 0
      }
    },
    itemEvidence: items.map((item) => ({
      queueHash: stablePoisonDigest(item.queueId ?? ''),
      taskHash: stablePoisonDigest(item.taskId ?? ''),
      packetHash: stablePoisonDigest(item.packetId ?? ''),
      toolHash: stablePoisonDigest(item.toolName ?? ''),
      status: item.status ?? null,
      reviewStatus: item.reviewStatus ?? null,
      attempts: item.attempts ?? 0,
      errorCode: item.error?.code ?? null
    })),
    actionEvidence: {
      review: {
        success: reviewResult?.success === true,
        itemHash: stablePoisonDigest(reviewResult?.item?.queueId ?? reviewResult?.queueId ?? ''),
        reviewStatus: reviewResult?.item?.reviewStatus ?? reviewResult?.reviewStatus ?? null
      },
      requeue: {
        success: requeueResult?.success === true,
        itemHash: stablePoisonDigest(requeueResult?.item?.queueId ?? requeueResult?.queueId ?? ''),
        status: requeueResult?.item?.status ?? requeueResult?.status ?? null
      },
      drain: {
        processed: drainResult?.processed ?? 0,
        statusDigest: stablePoisonDigest(drainResult?.status ?? {}),
        deltaDigest: stablePoisonDigest(drainResult?.delta ?? {})
      },
      soak: {
        success: soakResult?.success === true,
        cycles: soakResult?.cycles ?? 0,
        processed: soakResult?.processed ?? 0,
        stableClear: soakResult?.stableClear === true
      }
    },
    visualRegression: {
      reportVersion: visualRegression?.reportVersion ?? null,
      status: visualRegression?.status ?? 'missing',
      snapshotCount: visualRegression?.snapshots?.length ?? 0,
      snapshotStates,
      checks: (visualRegression?.checks ?? []).map((check) => ({
        checkId: check.id,
        passed: check.passed === true
      }))
    },
    notificationUx: {
      snapshotVersion: notificationUx?.snapshotVersion ?? null,
      passed: notificationUx?.passed === true,
      delivered: notificationUx?.delivered ?? 0,
      queued: notificationUx?.queued ?? 0,
      deliveryCount: notificationUx?.deliveryCount ?? 0,
      receiptCount: notificationUx?.receiptCount ?? 0,
      eventTypeHashes: (notificationUx?.eventTypes ?? []).map((eventType) => stablePoisonDigest(eventType))
    },
    operationalEvidence: {
      evidenceVersion: operationalEvidence?.evidenceVersion ?? null,
      passed: operationalEvidence?.passed === true,
      visualStatus: operationalEvidence?.visualRegression?.status ?? null,
      notificationPassed: operationalEvidence?.notificationUx?.passed === true,
      soak: operationalEvidence?.soak
        ? {
            success: operationalEvidence.soak.success === true,
            cycles: operationalEvidence.soak.cycles ?? 0,
            processed: operationalEvidence.soak.processed ?? 0,
            stableClear: operationalEvidence.soak.stableClear === true
          }
        : null
    },
    physicalMobileScreenshotEvidenceRequired: true,
    administratorWindowsServiceSoakEvidenceRequired: true
  };
  const preliminaryDossier = {
    dossierVersion: 'c-poison-queue-release-dossier-v1',
    generatedAt: generatedAt.toISOString(),
    artifactManifest,
    releaseWorkflow: {
      workflowVersion: 'c-poison-queue-release-workflow-v1',
      reviewReady: reviewResult?.success === true,
      requeueReady: requeueResult?.success === true,
      drainReady: (drainResult?.processed ?? 0) >= 1,
      soakReady: soakResult?.success === true,
      visualRegressionReady: visualRegression?.status === 'passed',
      notificationUxReady: notificationUx?.passed === true,
      promotionStatus: 'pending_checks'
    }
  };
  const rawLeakDetected = serializedPoisonDossierContainsAny({
    ...preliminaryDossier,
    generatedAt: null,
    artifactManifest: {
      ...preliminaryDossier.artifactManifest,
      generatedAt: null
    }
  }, rawNeedles);
  const checks = [
    {
      checkId: 'poison_queue_review_flow_verified',
      passed: reviewResult?.success === true && (reviewResult?.item?.reviewStatus ?? reviewResult?.reviewStatus) === 'reviewed'
    },
    {
      checkId: 'poison_queue_requeue_and_drain_verified',
      passed: requeueResult?.success === true
        && (requeueResult?.item?.status ?? requeueResult?.status) === 'queued'
        && (drainResult?.processed ?? 0) >= 1
    },
    {
      checkId: 'poison_queue_soak_visual_operational_evidence_passed',
      passed: soakResult?.success === true
        && visualRegression?.status === 'passed'
        && operationalEvidence?.passed === true
    },
    {
      checkId: 'poison_queue_notification_ux_verified',
      passed: notificationUx?.snapshotVersion === 'c-poison-queue-notification-ux-v1'
        && notificationUx?.passed === true
    },
    {
      checkId: 'raw_poison_queue_payload_not_stored',
      passed: artifactManifest.rawPacketPayloadStored === false
        && artifactManifest.rawQueueIdsStored === false
        && artifactManifest.rawToolArgumentsStored === false
        && artifactManifest.rawNotificationPayloadStored === false
        && artifactManifest.rawScreenshotStored === false
        && rawLeakDetected === false
    }
  ];
  const operationalHandoffManifest = {
    manifestVersion: 'c-poison-queue-operational-handoff-manifest-v1',
    generatedAt: generatedAt.toISOString(),
    owner: 'mobile-poison-queue-release-owner',
    scope: 'pc_agent_dead_letter_review_requeue_drain_soak_notification',
    status: checks.every((check) => check.passed) && rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'c-poison-queue-health-handshake-v1',
    healthHandshake: {
      reviewFlowVerified: reviewResult?.success === true,
      requeueAndDrainVerified: requeueResult?.success === true && (drainResult?.processed ?? 0) >= 1,
      soakOperationalEvidencePassed: soakResult?.success === true && operationalEvidence?.passed === true,
      visualRegressionPassed: visualRegression?.status === 'passed',
      notificationUxPassed: notificationUx?.passed === true,
      rawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'c-poison-queue-fallback-policy-v1',
      primaryFlow: 'review_pc_agent_dead_letters_then_requeue_drain_or_ignore_with_notification_evidence',
      fallbackFlows: [
        'block_review_actions_until_session_is_unlocked',
        'keep_quarantined_packet_when_requeue_patch_is_incomplete',
        'run_limited_drain_then_soak_before_release_promotion',
        'block_release_when_packet_payload_queue_id_or_tool_arguments_leak'
      ],
      operatorEscalation: 'mobile_poison_queue_release_and_pc_agent_dead_letter_report'
    },
    rawPacketPayloadStored: false,
    rawQueueIdsStored: false,
    rawToolArgumentsStored: false,
    rawNotificationPayloadStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'c-poison-queue-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "C mobile poison queue" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'poison_queue_review_flow_verified',
      'poison_queue_requeue_and_drain_verified',
      'poison_queue_soak_visual_operational_evidence_passed',
      'poison_queue_notification_ux_verified',
      'poison_queue_release_dossier_ready',
      'poison_queue_release_artifact_manifest_ready',
      'poison_queue_operational_handoff_ready',
      'poison_queue_worm_promotion_package_ready'
    ],
    artifactManifestHash: stablePoisonDigest(artifactManifest),
    operationalHandoffHash: stablePoisonDigest(operationalHandoffManifest),
    rawPacketPayloadStored: false,
    rawQueueIdsStored: false,
    rawToolArgumentsStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'c-poison-queue-worm-promotion-package-v1',
    providerContractVersion: 'c-poison-queue-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'c-poison-queue-release-artifact-manifest-v1'
      && rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'c-poison-queue-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: stablePoisonDigest(artifactManifest),
    operationalHandoffHash: stablePoisonDigest(operationalHandoffManifest),
    ciNightlyGatePlanHash: stablePoisonDigest(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPacketPayloadStored: false,
    rawQueueIdsStored: false,
    rawToolArgumentsStored: false,
    rawNotificationPayloadStored: false
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
      ? 'capture_physical_mobile_poison_queue_regression_and_administrator_service_soak_evidence'
      : 'block_poison_queue_release_until_review_requeue_soak_notification_and_raw_retention_checks_pass'
  };
  dossier.releaseWorkflow = {
    ...dossier.releaseWorkflow,
    promotionStatus: dossier.status === 'passed' ? 'release_evidence_ready' : 'blocked'
  };
  dossier.dossierDigest = stablePoisonDigest({
    ...dossier,
    dossierDigest: null
  });
  return dossier;
}

export function createPoisonQueueProductGate(options = {}) {
  const releaseDossier = createPoisonQueueReleaseDossier(options);
  const checks = [
    {
      checkId: 'poison_queue_review_flow_verified',
      status: releaseDossier.checks.find((check) => check.checkId === 'poison_queue_review_flow_verified')?.passed ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'poison_queue_requeue_and_drain_verified',
      status: releaseDossier.checks.find((check) => check.checkId === 'poison_queue_requeue_and_drain_verified')?.passed ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'poison_queue_soak_visual_operational_evidence_passed',
      status: releaseDossier.checks.find((check) => check.checkId === 'poison_queue_soak_visual_operational_evidence_passed')?.passed ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'poison_queue_notification_ux_verified',
      status: releaseDossier.checks.find((check) => check.checkId === 'poison_queue_notification_ux_verified')?.passed ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'poison_queue_release_dossier_ready',
      status: releaseDossier.status === 'passed'
        && releaseDossier.dossierDigest.length === 64
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion,
      dossierDigest: releaseDossier.dossierDigest
    },
    {
      checkId: 'poison_queue_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'c-poison-queue-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawPacketPayloadStored === false
        && releaseDossier.artifactManifest?.rawQueueIdsStored === false
        && releaseDossier.artifactManifest?.rawToolArgumentsStored === false
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'poison_queue_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'c-poison-queue-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'c-poison-queue-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'c-poison-queue-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'poison_queue_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'c-poison-queue-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'c-poison-queue-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    }
  ];
  return {
    productGateVersion: 'c-poison-queue-product-gate-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    checks,
    releaseDossier,
    evidence: {
      dossierVersion: releaseDossier.dossierVersion,
      dossierDigest: releaseDossier.dossierDigest,
      artifactManifest: releaseDossier.artifactManifest
    }
  };
}

function collectPoisonQueueRawNeedles(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  const directKeys = [
    'queueId',
    'taskId',
    'packetId',
    'toolName',
    'reviewedBy',
    'note',
    'path',
    'content',
    'notificationId',
    'deliveryId',
    'receiptId',
    'title',
    'body'
  ];
  const direct = directKeys.map((key) => value[key]).filter((item) => typeof item === 'string');
  if (Array.isArray(value)) return [...direct, ...value.flatMap((item) => collectPoisonQueueRawNeedles(item))];
  return [
    ...direct,
    ...collectPoisonQueueRawNeedles(value.item),
    ...collectPoisonQueueRawNeedles(value.packet),
    ...collectPoisonQueueRawNeedles(value.action),
    ...collectPoisonQueueRawNeedles(value.before),
    ...collectPoisonQueueRawNeedles(value.after),
    ...collectPoisonQueueRawNeedles(value.latest),
    ...collectPoisonQueueRawNeedles(value.results)
  ];
}

function serializedPoisonDossierContainsAny(value, needles) {
  const serialized = JSON.stringify(value);
  return needles.some((needle) => needle && serialized.includes(String(needle)));
}

function canonicalPoisonJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalPoisonJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPoisonJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stablePoisonDigest(value) {
  const source = typeof value === 'string' ? value : canonicalPoisonJson(value);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }).join('').repeat(2).slice(0, 64);
}
