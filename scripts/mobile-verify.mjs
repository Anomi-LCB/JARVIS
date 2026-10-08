import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { MobileAppRuntime } from '../apps/mobile/src/mobile-runtime.js';
import { createMobileAppShell, createMobileAppStructureProductGate } from '../apps/mobile/src/App.js';
import { BridgeClient } from '../apps/mobile/src/api/BridgeClient.js';
import {
  createPairingScreenProductGate,
  createPairingScreenViewModel
} from '../apps/mobile/src/screens/PairingScreen.js';
import {
  createCommandNetworkRecoveryVisualRegression,
  createCommandScreenProductGate,
  createCommandScreenViewModel,
  createPendingQueueDetailPanelState
} from '../apps/mobile/src/screens/CommandScreen.js';
import { createApprovalQueueScreenViewModel } from '../apps/mobile/src/screens/ApprovalQueueScreen.js';
import {
  createApprovalDetailScreenViewModel,
  createApprovalLifecycleProductGate
} from '../apps/mobile/src/screens/ApprovalDetailScreen.js';
import { createTaskStatusScreenViewModel } from '../apps/mobile/src/screens/TaskStatusScreen.js';
import { createResultScreenViewModel } from '../apps/mobile/src/screens/ResultScreen.js';
import { createSettingsScreenViewModel } from '../apps/mobile/src/screens/SettingsScreen.js';
import {
  createPoisonQueueProductGate,
  createPoisonQueueScreenViewModel
} from '../apps/mobile/src/screens/PoisonQueueScreen.js';
import { createGrowthReviewScreenViewModel } from '../apps/mobile/src/screens/GrowthReviewScreen.js';
import { createRiskAccessibility } from '../apps/mobile/src/accessibility/approval-accessibility.js';
import { ActionType, TaskStatus } from '../packages/shared/src/types.js';
import { createBridgeServer } from '../apps/bridge/src/main.mjs';
import {
  PcConfirmationConsoleBridgeClient,
  createPcConsoleVisualBaseline,
  createPcConsoleVisualSnapshot,
  diffPcConsoleVisualSnapshots
} from '../src/domain/pc-console.js';
import { validateNativeMobileConfig } from '../apps/mobile/src/native/nativeContracts.js';
import { validateMobileScreenContract } from '../apps/mobile/src/native/screenContracts.js';
import { runAndroidEmulatorReadiness } from './mobile-android-emulator.mjs';
import { runAndroidInstallVerification } from './mobile-android-install.mjs';
import { runAndroidSetup } from './mobile-android-setup.mjs';
import { runMobileReleasePreflight } from './mobile-release-preflight.mjs';
import {
  defaultMobileDeviceEvidenceRoot,
  deviceSmokeNextActions,
  reconcileMobileDeviceEvidence,
  runMobileDeviceSmoke,
  writeMobileDeviceSmokeArtifacts
} from './mobile-device-smoke.mjs';

const requiredMobileFiles = [
  'apps/mobile/app.json',
  'apps/mobile/eas.json',
  'apps/mobile/package.json',
  'apps/mobile/src/App.tsx',
  'apps/mobile/src/App.js',
  'apps/mobile/src/native/nativeContracts.js',
  'apps/mobile/src/native/screenContracts.js',
  'apps/mobile/src/navigation/routes.js',
  'apps/mobile/src/api/BridgeClient.js',
  'apps/mobile/src/api/apiTypes.ts',
  'apps/mobile/src/screens/PairingScreen.js',
  'apps/mobile/src/screens/CommandScreen.js',
  'apps/mobile/src/screens/ApprovalQueueScreen.js',
  'apps/mobile/src/screens/ApprovalDetailScreen.js',
  'apps/mobile/src/screens/TaskStatusScreen.js',
  'apps/mobile/src/screens/ResultScreen.js',
  'apps/mobile/src/screens/SettingsScreen.js',
  'apps/mobile/src/screens/GrowthReviewScreen.js',
  'apps/mobile/src/screens/PoisonQueueScreen.js',
  'apps/mobile/src/components/ApprovalCardView.tsx',
  'apps/mobile/src/components/ApprovalActionPanel.js',
  'apps/mobile/src/components/ApprovalActionPanel.tsx',
  'apps/mobile/src/accessibility/approval-accessibility.js',
  'apps/mobile/src/components/PairingQrPanel.js',
  'apps/mobile/src/components/PairingQrPanel.tsx',
  'apps/mobile/src/components/ConnectionStatusBar.tsx',
  'apps/mobile/src/components/CommandComposerPanel.js',
  'apps/mobile/src/components/CommandComposerPanel.tsx',
  'apps/mobile/src/components/ResultSummaryCard.tsx',
  'apps/mobile/src/components/ResultFeedbackPanel.js',
  'apps/mobile/src/components/ResultFeedbackPanel.tsx',
  'apps/mobile/src/components/GrowthReviewDecisionPanel.js',
  'apps/mobile/src/components/GrowthReviewDecisionPanel.tsx',
  'apps/mobile/src/components/PoisonQueueActionPanel.js',
  'apps/mobile/src/components/PoisonQueueActionPanel.tsx',
  'apps/mobile/src/components/RetryPolicySettingsPanel.js',
  'apps/mobile/src/components/RetryPolicySettingsPanel.tsx',
  'apps/mobile/src/components/NativeRuntimeProbe.tsx'
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withEphemeralBridgeServer(bridgeRuntime, run) {
  const server = createBridgeServer(bridgeRuntime);
  const address = await listenOnFetchSafePort(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function check(checks, id, title, passed, evidence, severity = 'required') {
  checks.push({ id, title, passed: Boolean(passed), evidence, severity });
}

function approvalHistoryItems(history) {
  return Array.isArray(history?.items) ? history.items : [];
}

function deterministicVerificationRuntimeOptions(options = {}) {
  return {
    ...options,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      JARVIS_LLM_INTENT: '0',
      JARVIS_LLM_PLANNER: '0',
      JARVIS_LLM_CONTENT: '0'
    }
  };
}

async function runPcConsoleBridgeFetchScenario({ bridgeRuntime, token, existingHandoffId }) {
  return withEphemeralBridgeServer(bridgeRuntime, async (baseUrl) => {
    const tokenProvider = () => token;
    const pcConsoleClient = new PcConfirmationConsoleBridgeClient({
      bridgeUrl: baseUrl,
      tokenProvider,
      fetchImpl: fetch,
      timeoutMs: 5000
    });
    const bridgeClient = new BridgeClient({
      bridgeUrl: baseUrl,
      tokenProvider,
      fetchImpl: fetch,
      timeoutMs: 60000,
      retries: 0
    });
    const initialQueue = await pcConsoleClient.list({ status: 'awaiting_pc_confirmation' });
    const initialVisualSnapshot = createPcConsoleVisualSnapshot(initialQueue);
    const initialVisualRegression = diffPcConsoleVisualSnapshots(createPcConsoleVisualBaseline(), initialVisualSnapshot);
    const target = initialQueue.items?.find((item) => item.handoffId === existingHandoffId) ?? initialQueue.items?.[0];
    const accepted = target
      ? await pcConsoleClient.decide(target.handoffId, {
          decision: 'approve',
          operatorId: 'mobile-verify-pc-console'
        })
      : { success: false, error: { code: 'C_PC_CONSOLE_TARGET_MISSING' } };
    const rejectTask = await bridgeClient.createTask({
      requestId: 'req_mobile_verify_pc_console_reject',
      rawText: '밴드에 전송해 PC 콘솔 거절 검증'
    });
    const rejectHandoff = rejectTask.approvalId
      ? await bridgeClient.requestPcConfirmation(rejectTask.approvalId, {
          reason: 'mobile-verify-pc-console-reject'
        })
      : {
          success: false,
          error: {
            code: rejectTask.error?.code ?? 'C_REJECT_TASK_APPROVAL_MISSING',
            message: rejectTask.error?.message ?? 'Reject scenario task did not return an approval id.'
          }
        };
    const rejectQueue = await pcConsoleClient.list({ status: 'awaiting_pc_confirmation' });
    const rejectVisualSnapshot = createPcConsoleVisualSnapshot(rejectQueue);
    const rejectVisualRegression = diffPcConsoleVisualSnapshots(createPcConsoleVisualBaseline(), rejectVisualSnapshot);
    const rejected = await pcConsoleClient.decide(rejectHandoff.handoffId, {
      decision: 'reject',
      operatorId: 'mobile-verify-pc-console',
      note: 'recipient verification failed in product scenario'
    });
    const acceptedHistory = target
      ? await bridgeClient.getApprovalHistory(target.approvalId)
      : { items: [] };
    const rejectedHistory = await bridgeClient.getApprovalHistory(rejectTask.approvalId);
    const finalQueue = await pcConsoleClient.list();
    const finalVisualRegression = diffPcConsoleVisualSnapshots(
      createPcConsoleVisualBaseline({ minAwaitingRows: 0 }),
      createPcConsoleVisualSnapshot(finalQueue)
    );
    const acceptedHistoryItems = approvalHistoryItems(acceptedHistory);
    const rejectedHistoryItems = approvalHistoryItems(rejectedHistory);
    const acceptedHistoryRecorded = acceptedHistoryItems.some((item) => item.eventType === 'approval.pc_handoff.accepted');
    const rejectedHistoryRecorded = rejectedHistoryItems.some((item) => item.eventType === 'approval.pc_handoff.rejected');
    const passed = initialQueue.clientContract === 'c-pc-console-bridge-fetch-v1'
      && initialVisualRegression.status === 'passed'
      && accepted.success === true
      && accepted.handoff?.status === 'accepted'
      && rejectHandoff.success === true
      && rejectVisualRegression.status === 'passed'
      && rejected.success === true
      && rejected.handoff?.status === 'rejected'
      && acceptedHistoryRecorded
      && rejectedHistoryRecorded
      && finalVisualRegression.status === 'passed';
    return {
      scenarioVersion: 'c-pc-console-bridge-fetch-visual-scenario-v1',
      baseUrl,
      passed,
      initialQueue: {
        fetched: initialQueue.clientContract === 'c-pc-console-bridge-fetch-v1',
        count: initialQueue.items?.length ?? 0,
        counts: initialQueue.counts ?? null
      },
      initialVisualRegression,
      accepted: {
        success: accepted.success === true,
        handoffId: target?.handoffId ?? null,
        status: accepted.handoff?.status ?? null,
        historyRecorded: acceptedHistoryRecorded,
        historyStatus: acceptedHistory.success === false ? acceptedHistory.error?.code ?? 'failed' : 'ok'
      },
      rejectSetup: {
        taskCreated: Boolean(rejectTask.taskId),
        taskId: rejectTask.taskId ?? null,
        approvalId: rejectTask.approvalId ?? null,
        taskError: rejectTask.success === false ? rejectTask.error?.code ?? 'failed' : null,
        handoffRequested: rejectHandoff.success === true,
        handoffError: rejectHandoff.success === false ? rejectHandoff.error?.code ?? 'failed' : null
      },
      rejected: {
        success: rejected.success === true,
        handoffId: rejectHandoff.handoffId,
        status: rejected.handoff?.status ?? null,
        historyRecorded: rejectedHistoryRecorded,
        historyStatus: rejectedHistory.success === false ? rejectedHistory.error?.code ?? 'failed' : 'ok'
      },
      rejectVisualRegression,
      finalVisualRegression
    };
  });
}

function runApprovalLifecycleProductGateScenario() {
  let current = new Date('2026-06-07T00:00:00.000Z');
  const clock = () => current;
  const { bridgeRuntime } = createAgRuntime(deterministicVerificationRuntimeOptions({ clock }));
  const mobileRuntime = new MobileAppRuntime({ bridgeRuntime, clock });
  const pairing = bridgeRuntime.pairing.start();
  mobileRuntime.pair({ pairingCode: pairing.pairingCode });

  const expiredTask = mobileRuntime.sendCommand('모바일 승인 만료 lifecycle 검증');
  const expiredApproval = mobileRuntime.approvalQueue().items.find((item) => item.taskId === expiredTask.taskId);
  const queueVm = createApprovalQueueScreenViewModel({ mobileRuntime });
  current = new Date('2026-06-07T00:31:00.000Z');
  const expiredDetailVm = createApprovalDetailScreenViewModel({
    approvalId: expiredApproval.approvalId,
    mobileRuntime
  });
  const expiredBlock = expiredDetailVm.approve();
  const renewed = expiredDetailVm.renew();

  current = new Date('2026-06-07T00:00:00.000Z');
  const cancellableTask = mobileRuntime.sendCommand('모바일 승인 취소 lifecycle 검증');
  const cancelApproval = mobileRuntime.approvalQueue().items.find((item) => item.taskId === cancellableTask.taskId);
  const cancelResult = mobileRuntime.cancelApproval(cancelApproval.approvalId, 'mobile_lifecycle_cancelled');
  const cancelHistory = mobileRuntime.approvalHistory(cancelApproval.approvalId);

  const reRequestTask = mobileRuntime.sendCommand('모바일 승인 재요청 lifecycle 검증');
  const reRequestApproval = mobileRuntime.approvalQueue().items.find((item) => item.taskId === reRequestTask.taskId);
  current = new Date('2026-06-07T00:31:00.000Z');
  const reRequestDetailVm = createApprovalDetailScreenViewModel({
    approvalId: reRequestApproval.approvalId,
    mobileRuntime
  });
  const reRequestResult = reRequestDetailVm.reRequest('mobile_lifecycle_rerequest');
  const previousHistory = mobileRuntime.approvalHistory(reRequestApproval.approvalId);
  const replacementHistory = mobileRuntime.approvalHistory(reRequestResult.replacement.approvalId);
  const productGate = createApprovalLifecycleProductGate({
    queueVm,
    detailVm: expiredDetailVm,
    expiredDetailVm,
    expiredBlock,
    renewed,
    cancelResult,
    reRequestResult,
    histories: [
      expiredDetailVm.timeline?.items ?? [],
      cancelHistory.items ?? [],
      previousHistory.items ?? [],
      replacementHistory.items ?? []
    ]
  });
  return {
    productGate,
    releaseDossier: productGate.releaseDossier,
    visualRegression: productGate.visualRegression,
    expiredBlocked: expiredBlock.blocked === true,
    renewedStatus: renewed.status,
    cancelStatus: cancelResult.status,
    reRequestStatus: reRequestResult.replacement?.status
  };
}

async function runMobileRuntimeScenario() {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-mobile-verify-'));
  try {
    const { bridgeRuntime, pcAgent, growthRuntime } = createAgRuntime(deterministicVerificationRuntimeOptions({
      allowedRoots: [dir],
      auditRoot: dir,
      outputPath: join(dir, 'mobile-verify-output.txt')
    }));
    const mobileRuntime = new MobileAppRuntime({ bridgeRuntime });
    const shell = createMobileAppShell();
    const pairingVm = createPairingScreenViewModel({ mobileRuntime, bridgeRuntime });
    const pairing = pairingVm.start();
    const scannerPermission = pairingVm.scannerPermission({ cameraPermission: 'granted' });
    const scannedPairing = pairingVm.scan(pairing.qrPayload.qrText);
    const pairingRecovery = pairingVm.recovery({ errorCode: 'D_AUTH_INVALID_TOKEN' });
    const paired = pairingVm.confirm(pairing.pairingCode, pairing.bridgeUrl);
    const deviceInventory = pairingVm.inventory();
    const pairingProductGate = createPairingScreenProductGate({
      pairing,
      scannerPermission,
      scannedPairing,
      recovery: pairingRecovery,
      paired,
      deviceInventory,
      tokenStorage: mobileRuntime.tokenStorageStatus()
    });
    const settingsVm = createSettingsScreenViewModel({ mobileRuntime });
    const notificationPermission = settingsVm.requestNotifications({ grant: true });
    const pushToken = settingsVm.registerPushToken('ExponentPushToken[jarvis-mobile-verify]');
    const sessionPin = settingsVm.configureSessionPin('2468');
    settingsVm.unlockSession('2468');
    const retryPolicyBefore = settingsVm.retryPolicy;
    const retryPolicyUpdate = settingsVm.saveRetryPolicy({
      maxAttempts: 4,
      baseBackoffMs: 1800,
      reason: 'mobile verification tuning'
    });

    const commandVm = createCommandScreenViewModel({ state: shell.initialState, mobileRuntime });
    const sent = commandVm.send('모바일 검증용 엑셀 만들어');
    const commandPendingQueueDetailPanel = createPendingQueueDetailPanelState({
      items: [{
        localId: 'local_mobile_verify_pending_001',
        rawText: '네트워크 복구 후 다시 전송',
        createdAt: '2026-06-18T00:00:00.000Z',
        syncStatus: 'pending',
        retryCount: 1,
        nextRetryAt: '2026-06-18T00:01:00.000Z'
      }],
      now: new Date('2026-06-18T00:02:00.000Z')
    });
    const commandNetworkRecovery = createCommandNetworkRecoveryVisualRegression({
      rawText: '모바일 검증용 엑셀 만들어',
      pendingOfflineCount: commandPendingQueueDetailPanel.total
    });
    const commandProductGate = createCommandScreenProductGate({
      queueDetailPanel: commandPendingQueueDetailPanel,
      networkRecoveryVisualRegression: commandNetworkRecovery
    });
    const queueVm = createApprovalQueueScreenViewModel({ mobileRuntime });
    const selected = queueVm.select(queueVm.items[0].approvalId);
    const detailVm = createApprovalDetailScreenViewModel({
      approvalId: selected.approvalId,
      mobileRuntime
    });
    const approved = await detailVm.approve();
    const statusVm = createTaskStatusScreenViewModel({ taskId: sent.taskId, mobileRuntime });
    const longPollingRegression = statusVm.longPollingVisualRegression([
      { status: TaskStatus.WAITING_APPROVAL, latencyMs: 42, changed: false },
      { status: 'EXECUTING', latencyMs: 2800, changed: true },
      { status: TaskStatus.COMPLETED, latencyMs: 136, changed: true }
    ]);
    const executed = await mobileRuntime.confirmExecution(approved.handoffId);
    const resultVm = createResultScreenViewModel({ taskId: sent.taskId, mobileRuntime });
    const previewAction = await resultVm.previewFile(resultVm.filePreviews[0].previewId);
    const shareAction = await resultVm.shareFile(resultVm.filePreviews[0].previewId);
    const rollbackConfirmation = await resultVm.rollback('mobile verification unconfirmed rollback', { confirmed: false });
    const rollbackProof = await resultVm.rollback('mobile verification confirmed rollback', { confirmed: true });
    const resultProductGate = resultVm.productGate({
      pollingRegression: longPollingRegression,
      rollbackProofModal: rollbackProof.proofModal
    });
    const risky = mobileRuntime.sendCommand('밴드에 전송해');
    const riskyApproval = mobileRuntime.approvalQueue().items.find((item) => item.taskId === risky.taskId);
    const riskyDetailVm = createApprovalDetailScreenViewModel({
      approvalId: riskyApproval.approvalId,
      mobileRuntime
    });
    const riskyAccessibility = createRiskAccessibility(riskyApproval.riskTier);
    const pcHandoff = riskyDetailVm.requestPcConfirmation('mobile verification pc confirmation');
    const pcConsoleBridgeFetch = await runPcConsoleBridgeFetchScenario({
      bridgeRuntime,
      token: mobileRuntime.token(),
      existingHandoffId: pcHandoff.handoffId
    });
    const mobileApprovalRestrictionProductGate = riskyDetailVm.restrictionProductGate({
      pcHandoff,
      pcConsoleBridgeFetch
    });
    const approvalLifecycleProductGate = runApprovalLifecycleProductGateScenario();
    for (let index = 0; index < 3; index += 1) {
      growthRuntime.ingestor.ingest({
        eventId: `evt_mobile_verify_growth_pref_${index + 1}`,
        eventType: 'approval.edited',
        taskId: `task_mobile_verify_growth_pref_${index + 1}`,
        payload: { editRequest: '제목을 짧게 정리해줘' },
        learningFlags: { canBeUsedForPreference: true, doNotRemember: false },
        trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
      });
    }
    growthRuntime.ingestor.ingest({
      eventId: 'evt_mobile_verify_growth_pref_conflict',
      eventType: 'approval.edited',
      taskId: 'task_mobile_verify_growth_pref_conflict',
      payload: { editRequest: '제목을 길고 자세하게 풀어줘' },
      learningFlags: { canBeUsedForPreference: true, doNotRemember: false },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
    growthRuntime.ingestor.ingest({
      eventId: 'evt_mobile_verify_growth_hygiene_sensitive',
      eventType: 'execution.completed',
      taskId: 'task_mobile_verify_growth_hygiene_sensitive',
      payload: { rawText: 'token=mobile-verify-secret 010-1111-2222' },
      learningFlags: {
        canBeUsedForPreference: true,
        canBeUsedForWorkflow: true,
        canBeUsedForAutonomy: false,
        containsSensitiveData: true,
        doNotRemember: false
      },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
    growthRuntime.ingestor.ingest({
      eventId: 'evt_mobile_verify_growth_hygiene_private',
      eventType: 'execution.completed',
      taskId: 'task_mobile_verify_growth_hygiene_private',
      payload: { rawText: '기억하지 마 모바일 검증 개인 메모' },
      learningFlags: {
        canBeUsedForPreference: true,
        canBeUsedForWorkflow: true,
        canBeUsedForAutonomy: false,
        containsSensitiveData: true,
        doNotRemember: true
      },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
    const growthReviewVm = createGrowthReviewScreenViewModel({ mobileRuntime });
    const growthReviewProductGate = growthReviewVm.productGate();
    const poison = pcAgent.queueExecutionPacket({
      taskId: 'task_mobile_verify_poison',
      action: { actionType: ActionType.CREATE_FILE }
    });
    const poisonVm = createPoisonQueueScreenViewModel({ mobileRuntime });
    const poisonReview = poisonVm.review(poison.queueId, 'mobile verification review');
    const poisonForDrain = pcAgent.queueExecutionPacket({
      taskId: 'task_mobile_verify_poison_drain',
      action: { actionType: ActionType.CREATE_FILE }
    });
    const poisonRequeue = createPoisonQueueScreenViewModel({ mobileRuntime }).requeue(poisonForDrain.queueId, {
      note: 'mobile verification restored packet',
      patch: {
        packetId: 'packet_mobile_verify_poison_drain_fixed',
        capabilityToken: { tokenId: 'cap_mobile_verify_poison_drain' },
        userConfirmation: { confirmed: true },
        action: {
          actionType: ActionType.CREATE_FILE,
          toolName: 'filesystem.createTextFile',
          arguments: {
            path: join(dir, 'mobile-verify-poison-drain.txt'),
            content: 'mobile verification drain'
          }
        }
      }
    });
    const poisonDrain = await createPoisonQueueScreenViewModel({ mobileRuntime }).drainQueue({ limit: 2 });
    const poisonSoak = await createPoisonQueueScreenViewModel({ mobileRuntime }).soakQueue({ cycles: 2, limit: 2, includeIgnored: true });
    const poisonQueueProductGate = createPoisonQueueProductGate({
      queueState: poisonVm,
      reviewResult: poisonReview,
      requeueResult: poisonRequeue,
      drainResult: poisonDrain,
      soakResult: poisonSoak
    });
    const lifecycleLock = mobileRuntime.handleAppStateChange('background');
    const biometricUnlock = settingsVm.unlockSessionWithBiometric({ reason: 'mobile-verification' });
    const lifecycleSoak = settingsVm.runLifecycleSoak(['active', 'background', 'active', 'inactive', 'active']);
    const receiptVerification = settingsVm.verifyNotificationReceipts({ retryQueued: true });
    const providerDrill = settingsVm.runNotificationProviderDrill();
    const sessionLockProductGate = settingsVm.runSessionLockProductGate();
    const notificationProductGate = settingsVm.runNotificationProductGate({ tokenTrendCycles: 2 });
    const secureTokenProductGate = settingsVm.runSecureTokenProductGate();
    const snapshot = mobileRuntime.snapshot();

    return {
      passed: paired.nextRoute === 'CommandScreen'
        && pairingProductGate.status === 'passed'
        && sent.nextRoute === 'TaskStatusScreen'
        && commandPendingQueueDetailPanel.panelVersion === 'c-command-pending-queue-detail-panel-v1'
        && commandPendingQueueDetailPanel.actions.autoSend === false
        && commandNetworkRecovery.status === 'passed'
        && commandProductGate.status === 'passed'
        && approved.requiresUserConfirmation === true
        && longPollingRegression.status === 'passed'
        && executed.status === TaskStatus.COMPLETED
        && resultVm.rollbackAvailable === true
        && previewAction.success === true
        && shareAction.success === true
        && rollbackConfirmation.error?.code === 'C_ROLLBACK_CONFIRMATION_REQUIRED'
        && rollbackProof.success === true
        && rollbackProof.proofModal?.status === 'verified'
        && resultProductGate.status === 'passed'
        && riskyDetailVm.actionState.primaryAction.accessibility.accessibilityState.disabled === true
        && riskyDetailVm.actionState.primaryAction.visualSnapshot.tone === 'pc-confirmation-disabled'
        && pcHandoff.success === true
        && pcConsoleBridgeFetch.passed === true
        && mobileApprovalRestrictionProductGate.status === 'passed'
        && approvalLifecycleProductGate.productGate.status === 'passed'
        && growthReviewVm.visualSnapshot.passed === true
        && growthReviewVm.hygieneDecisionState.batchSelection.selectionVersion === 'c-growth-hygiene-batch-selection-v1'
        && growthReviewVm.conflictResolutionState.modalVersion === 'c-growth-conflict-resolution-modal-v1'
        && growthReviewProductGate.status === 'passed'
        && poisonVm.items.some((item) => item.queueId === poison.queueId)
        && poisonReview.success === true
        && poisonRequeue.success === true
        && poisonDrain.processed >= 1
        && poisonSoak.success === true
        && poisonSoak.visualRegression?.status === 'passed'
        && poisonSoak.notificationUx?.passed === true
        && poisonSoak.operationalEvidence?.passed === true
        && poisonQueueProductGate.status === 'passed'
        && retryPolicyUpdate.success === true
        && lifecycleLock.locked === true
        && biometricUnlock.success === true
        && lifecycleSoak.passed === true
        && sessionLockProductGate.status === 'passed'
        && sessionLockProductGate.releaseDossier?.status === 'passed'
        && snapshot.notifications.deliveryLog.length > 0
        && receiptVerification.checked > 0
        && receiptVerification.failed === 0
        && providerDrill.status === 'passed'
        && notificationProductGate.status === 'passed'
        && notificationProductGate.releaseDossier?.status === 'passed'
        && secureTokenProductGate.status === 'passed',
      routes: shell.routes,
      pairing: {
        nextRoute: paired.nextRoute,
        connected: mobileRuntime.connection.connected,
        scannerPermission,
        scannedPairing,
        recovery: pairingRecovery,
        deviceInventory,
        productGate: pairingProductGate,
        releaseDossier: pairingProductGate.releaseDossier
      },
      command: {
        nextRoute: sent.nextRoute,
        taskId: sent.taskId,
        statusBeforeExecution: statusVm.status.status,
        pendingQueueDetailPanel: commandPendingQueueDetailPanel,
        networkRecoveryVisualRegression: commandNetworkRecovery,
        productGate: commandProductGate,
        releaseDossier: commandProductGate.releaseDossier
      },
      approval: {
        approvalId: selected.approvalId,
        mobileBlocked: detailVm.mobileBlocked,
        requiresSessionUnlock: detailVm.requiresSessionUnlock,
        requiresUserConfirmation: approved.requiresUserConfirmation,
        lifecycleProductGate: approvalLifecycleProductGate.productGate,
        lifecycleReleaseDossier: approvalLifecycleProductGate.releaseDossier,
        lifecycleVisualRegression: approvalLifecycleProductGate.visualRegression,
        risky: {
          approvalId: riskyApproval.approvalId,
          riskTier: riskyApproval.riskTier,
          riskAccessibility: riskyAccessibility,
          approveAccessibility: riskyDetailVm.actionState.primaryAction.accessibility,
          approveVisualSnapshot: riskyDetailVm.actionState.primaryAction.visualSnapshot,
          pcHandoffAction: riskyDetailVm.actionState.pcHandoffAction,
          pcHandoffStatus: pcHandoff.status,
          pcConsoleBridgeFetch,
          productGate: mobileApprovalRestrictionProductGate,
          releaseDossier: mobileApprovalRestrictionProductGate.releaseDossier,
          historyContainsPcHandoff: mobileRuntime.approvalHistory(riskyApproval.approvalId).items.some((item) => item.eventType === 'approval.pc_handoff.requested')
        }
      },
      growthReview: {
        visualSnapshot: growthReviewVm.visualSnapshot,
        hygieneTrendChart: growthReviewVm.hygieneDecisionState.trendChart,
        batchSelection: growthReviewVm.hygieneDecisionState.batchSelection,
        conflictResolution: growthReviewVm.conflictResolutionState,
        productGate: growthReviewProductGate,
        releaseDossier: growthReviewProductGate.releaseDossier
      },
      execution: {
        status: executed.status,
        verificationStatus: executed.verification?.status,
        documentActions: {
          preview: { status: previewAction.status, fallbackUsed: previewAction.fallbackUsed },
          share: { status: shareAction.status, fallbackUsed: shareAction.fallbackUsed },
          capability: mobileRuntime.documentActionStatus().capability,
          recentCount: mobileRuntime.documentActionStatus().recentActions.length,
          longPollingRegression,
          rollbackConfirmation: rollbackConfirmation.confirmation,
          rollbackProofModal: rollbackProof.proofModal,
          resultProductGate
        }
      },
      poisonQueue: {
        queueId: poison.queueId,
        count: poisonVm.items.length,
        status: poisonVm.summaryState.status,
        retryPolicy: poisonVm.summaryState.retryPolicy,
        reviewStatus: poisonReview.item?.reviewStatus ?? null,
        reviewedBy: poisonReview.item?.reviewedBy ?? null,
        requeueStatus: poisonRequeue.item?.status ?? null,
        drainProcessed: poisonDrain.processed ?? 0,
        drainDelta: poisonDrain.delta,
        visualRegression: poisonSoak.visualRegression,
        notificationUx: poisonSoak.notificationUx,
        operationalEvidence: poisonSoak.operationalEvidence,
        productGate: poisonQueueProductGate,
        releaseDossier: poisonQueueProductGate.releaseDossier,
        soak: {
          success: poisonSoak.success,
          cycles: poisonSoak.cycles,
          processed: poisonSoak.processed,
          stableClear: poisonSoak.stableClear,
          visualStatus: poisonSoak.visualRegression?.status,
          notificationStatus: poisonSoak.notificationUx?.passed === true ? 'passed' : 'failed'
        }
      },
      queuePolicy: {
        before: retryPolicyBefore,
        update: retryPolicyUpdate.current ?? null
      },
      security: {
        tokenSealed: snapshot.device.tokenStorage.sealed === true,
        tokenNativeBacked: snapshot.device.tokenStorage.nativeBacked === true,
        tokenFallbackUsed: snapshot.device.tokenStorage.fallbackUsed === true,
        tokenAdapter: snapshot.device.tokenStorage.nativeAdapter,
        tokenLifecycle: mobileRuntime.tokenLifecycleStatus(),
        tokenRecovery: mobileRuntime.tokenRecoveryState(),
        secureTokenProductGate,
        sessionConfigured: snapshot.session.configured,
        lifecycleLock: lifecycleLock.reason,
        biometricUnlock,
        lifecycleSoak,
        sessionLockProductGate
      },
      notifications: {
        permission: notificationPermission,
        adapter: snapshot.notifications.adapter,
        pushToken,
        pushTokenRegistered: snapshot.notifications.pushToken.registered === true,
        deliveredCount: snapshot.notifications.deliveryLog.length,
        receiptVerification,
        providerDrill,
        notificationProductGate,
        providerChecks: snapshot.notifications.providerChecks,
        tokenRotation: snapshot.notifications.tokenRotation,
        receiptCount: snapshot.notifications.receiptLog.length,
        queuedReceipts: snapshot.notifications.receiptLog.filter((item) => item.status === 'queued').length,
        issueQueue: snapshot.notifications.issueQueue,
        channels: [...new Set(snapshot.notifications.deliveryLog.map((item) => item.channelId))],
        fallbackDeliveries: snapshot.notifications.deliveryLog.filter((item) => item.fallbackUsed === true).length
      },
      sessionPinConfigured: sessionPin.success === true
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function renderMarkdown(report) {
  const lines = [
    '# JARVIS Mobile Verification Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Score: ${report.score}`,
    `Actual device verified: ${report.deviceProbe.actualDeviceVerified}`,
    ''
  ];
  lines.push('## Checks');
  for (const item of report.checks) {
    lines.push(`- [${item.passed ? 'x' : ' '}] ${item.id}: ${item.title} (${item.severity})`);
  }
  lines.push('');
  lines.push('## Runtime Scenario');
  lines.push(`- Passed: ${report.runtimeScenario.passed}`);
  lines.push(`- Routes: ${report.runtimeScenario.routes.join(', ')}`);
  lines.push(`- Pairing scanner/recovery/inventory: ${report.runtimeScenario.pairing.scannerPermission.canScan ? 'scanner-ready' : 'scanner-blocked'} / ${report.runtimeScenario.pairing.recovery.recommendedAction} / ${report.runtimeScenario.pairing.deviceInventory.inventoryVersion}`);
  lines.push(`- Execution: ${report.runtimeScenario.execution.status}`);
  lines.push(`- Poison queue review: ${report.runtimeScenario.poisonQueue.reviewStatus}`);
  lines.push(`- Poison queue drain: ${report.runtimeScenario.poisonQueue.drainProcessed} processed`);
  lines.push(`- Poison queue soak: ${report.runtimeScenario.poisonQueue.soak.cycles} cycles / ${report.runtimeScenario.poisonQueue.soak.success ? 'passed' : 'failed'}`);
  lines.push(`- Poison queue visual regression: ${report.runtimeScenario.poisonQueue.visualRegression.status}`);
  lines.push(`- PC console bridge fetch: ${report.runtimeScenario.approval.risky.pcConsoleBridgeFetch.passed ? 'passed' : 'failed'}`);
  lines.push(`- Growth review visual contract: ${report.runtimeScenario.growthReview.visualSnapshot.passed ? 'passed' : 'failed'}`);
  lines.push(`- Retry policy: ${report.runtimeScenario.queuePolicy.update?.maxAttempts ?? '-'} attempts`);
  lines.push(`- Notification channels: ${report.runtimeScenario.notifications.channels.join(', ')}`);
  lines.push(`- Notification receipts: ${report.runtimeScenario.notifications.receiptVerification.checked} checked / ${report.runtimeScenario.notifications.receiptVerification.queued} queued`);
  lines.push(`- Notification provider drill: ${report.runtimeScenario.notifications.providerDrill.status}`);
  lines.push(`- Push token rotation issues: ${report.runtimeScenario.notifications.tokenRotation.unresolvedIssues.length}`);
  lines.push(`- Secure token gate: ${report.runtimeScenario.security.secureTokenProductGate.status}`);
  lines.push(`- Secure token recovery queue: ${report.runtimeScenario.security.tokenRecovery.pendingCount} pending`);
  lines.push('');
  lines.push('## Native Readiness');
  lines.push(`- Status: ${report.nativeReadiness.status}`);
  lines.push(`- Passed checks: ${report.nativeReadiness.passed}/${report.nativeReadiness.total}`);
  lines.push('');
  lines.push('## Screen Contract');
  lines.push(`- Status: ${report.screenReadiness.status}`);
  lines.push(`- Passed checks: ${report.screenReadiness.passed}/${report.screenReadiness.total}`);
  lines.push('');
  lines.push('## Device Probe');
  lines.push(`- Tool available: ${report.deviceProbe.available}`);
  lines.push(`- Devices: ${report.deviceProbe.devices.length}`);
  lines.push(`- Device smoke: ${report.deviceSmoke.status}`);
  lines.push('');
  lines.push('## Android Platform Tools');
  lines.push(`- Status: ${report.androidSetup.status}`);
  lines.push(`- ADB available: ${report.androidSetup.adbProbe.available}`);
  lines.push(`- ADB command: ${report.androidSetup.adbProbe.command}`);
  lines.push(`- Setup report: ${report.androidSetup.artifacts.markdownPath}`);
  lines.push('');
  lines.push('## Android Emulator');
  lines.push(`- Status: ${report.androidEmulator.status}`);
  lines.push(`- Selected AVD: ${report.androidEmulator.selectedAvd}`);
  lines.push(`- Emulator available: ${report.androidEmulator.tools.emulator.available}`);
  lines.push(`- Running devices: ${report.androidEmulator.adb.devices.length}`);
  lines.push(`- Emulator report: ${report.androidEmulator.artifacts.markdownPath}`);
  lines.push('');
  lines.push('## Android Install');
  lines.push(`- Status: ${report.androidInstall.status}`);
  lines.push(`- APK exists: ${report.androidInstall.apk.exists}`);
  lines.push(`- Package installed: ${report.androidInstall.packageProbe.installed}`);
  lines.push(`- Install report: ${report.androidInstall.artifacts.markdownPath}`);
  lines.push('');
  lines.push('## Release Preflight');
  lines.push(`- Status: ${report.releasePreflight.status}`);
  lines.push(`- Local status: ${report.releasePreflight.localStatus}`);
  lines.push(`- Credential status: ${report.releasePreflight.credentialStatus}`);
  lines.push(`- Device evidence status: ${report.releasePreflight.deviceEvidenceStatus}`);
  lines.push(`- Preflight report: ${report.releasePreflight.artifacts.markdownPath}`);
  lines.push('');
  lines.push('## Product Matrix');
  lines.push(`- Android package: ${report.productMatrix.packageName}`);
  lines.push(`- Build profile: ${report.productMatrix.buildProfile}`);
  lines.push(`- Planned commands: ${report.productMatrix.commands.length}`);
  lines.push(`- Product blockers: ${report.productMatrix.blockers.length}`);
  if (report.deviceProbe.error) lines.push(`- Error: ${report.deviceProbe.error}`);
  return `${lines.join('\n')}\n`;
}

function renderHtml(report) {
  const checks = report.checks.map((item) => `<li>${item.passed ? 'PASS' : 'FAIL'} ${item.id}: ${item.title}</li>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS Mobile Verification</title></head>
<body>
  <h1>JARVIS Mobile Verification</h1>
  <p>Status: ${report.status}</p>
  <p>Score: ${report.score}</p>
  <p>Actual device verified: ${report.deviceProbe.actualDeviceVerified}</p>
  <h2>Checks</h2>
  <ul>${checks}</ul>
  <h2>Runtime Scenario</h2>
  <pre>${JSON.stringify(report.runtimeScenario, null, 2)}</pre>
  <h2>Native Readiness</h2>
  <pre>${JSON.stringify(report.nativeReadiness, null, 2)}</pre>
  <h2>Screen Contract</h2>
  <pre>${JSON.stringify(report.screenReadiness, null, 2)}</pre>
  <h2>Device Probe</h2>
  <pre>${JSON.stringify(report.deviceProbe, null, 2)}</pre>
  <h2>Device Smoke</h2>
  <pre>${JSON.stringify(report.deviceSmoke, null, 2)}</pre>
  <h2>Android Platform Tools</h2>
  <pre>${JSON.stringify(report.androidSetup, null, 2)}</pre>
  <h2>Android Emulator</h2>
  <pre>${JSON.stringify(report.androidEmulator, null, 2)}</pre>
  <h2>Android Install</h2>
  <pre>${JSON.stringify(report.androidInstall, null, 2)}</pre>
  <h2>Release Preflight</h2>
  <pre>${JSON.stringify(report.releasePreflight, null, 2)}</pre>
  <h2>Product Matrix</h2>
  <pre>${JSON.stringify(report.productMatrix, null, 2)}</pre>
</body>
</html>
`;
}

export function createMobileProductMatrix({ appJson, packageJson, nativeReadiness, screenReadiness, deviceSmoke, androidSetup, androidEmulator, androidInstall, releasePreflight }) {
  const expo = appJson.expo ?? {};
  const packageName = expo.android?.package;
  const bundleIdentifier = expo.ios?.bundleIdentifier;
  const dependencies = packageJson.dependencies ?? {};
  const requiredNativeModules = ['expo-secure-store', 'expo-notifications'];
  const nativeRuntimeExpectations = [
    {
      id: 'secure-store-native-backed',
      module: 'expo-secure-store',
      expected: 'Token storage uses native SecureStore on device and records fallback usage when unavailable.',
      configured: Boolean(dependencies['expo-secure-store'])
    },
    {
      id: 'notifications-permission-channel',
      module: 'expo-notifications',
      expected: 'Notification permission, channel routing, push token registry, and local delivery logs are available.',
      configured: Boolean(dependencies['expo-notifications'])
    },
    {
      id: 'biometric-or-pin-session-lock',
      module: 'expo-secure-store',
      expected: 'Sensitive approvals and execution handoff stay gated by PIN/session lifecycle lock.',
      configured: expo.android?.permissions?.includes('USE_BIOMETRIC') === true
    },
    {
      id: 'installed-package-and-home-runtime-evidence',
      module: 'expo-secure-store/expo-notifications/expo-speech-recognition',
      expected: 'Installed package capabilities and the practical home command, voice, and restored pairing surface are verified through ADB.',
      configured: true
    }
  ];
  const commands = [
    { id: 'android-platform-tools-setup', command: 'npm run mobile:setup-android -- --install', expected: 'Android SDK Platform Tools are installed or resolved into the JARVIS local tools cache.' },
    { id: 'android-emulator-readiness', command: 'npm run mobile:emulator', expected: 'Android Emulator, AVD, Java, ADB, and running-device readiness are recorded.' },
    { id: 'android-emulator-start', command: 'npm run mobile:emulator -- --start --wait', expected: 'A configured Android Virtual Device starts and reaches boot completion.' },
    { id: 'android-gradle-install', command: 'npm run mobile:android-install -- --build --install --variant release', expected: `${packageName} release APK builds, installs, and carries the embedded JS bundle on a ready Android device/emulator.` },
    { id: 'mobile-release-preflight', command: 'npm run mobile:release-preflight', expected: 'EAS production profile, store identifiers, release signing policy, credentials, and device evidence are checked.' },
    { id: 'expo-doctor', command: 'npx expo-doctor', expected: 'Expo project configuration passes dependency/version checks.' },
    { id: 'expo-prebuild-android', command: 'npx expo prebuild --platform android --no-install', expected: 'Android native project can be generated from app.json.' },
    { id: 'expo-run-android', command: 'npx expo run:android --device', expected: `${packageName} installs and launches on a ready Android device/emulator.` },
    { id: 'adb-home-surface-contract', command: `adb shell am start -W -n ${packageName}/.MainActivity && adb shell uiautomator dump /sdcard/jarvis-window.xml`, expected: 'UI dump contains the practical Jarvis command, execution, voice, and pairing-or-connected home surface.' },
    { id: 'adb-installed-package-capabilities', command: `adb shell dumpsys package ${packageName}`, expected: 'Installed APK declares microphone, notification, and biometric capabilities.' }
  ];
  const blockers = [];
  if (!packageName) blockers.push('android-package-missing');
  if (!bundleIdentifier) blockers.push('ios-bundle-identifier-missing');
  if (nativeReadiness.status !== 'passed') blockers.push('native-contract-failed');
  if (screenReadiness.status !== 'passed') blockers.push('screen-contract-failed');
  if (androidSetup && androidSetup.adbProbe?.available !== true) blockers.push('android-platform-tools-not-ready');
  if (androidEmulator && !['running-device', 'ready-to-start', 'starting'].includes(androidEmulator.status)) blockers.push('android-emulator-not-ready');
  if (androidInstall && !['installed', 'apk-ready', 'ready-to-build'].includes(androidInstall.status)) blockers.push('android-install-not-ready');
  if (androidInstall && androidInstall.packageProbe?.installed !== true) blockers.push('android-package-not-installed');
  if (releasePreflight && releasePreflight.localStatus !== 'passed') blockers.push('mobile-release-local-preflight-failed');
  if (releasePreflight && releasePreflight.status !== 'passed') blockers.push('mobile-release-external-preflight-blocked');
  if (!deviceSmoke.actualDeviceVerified) blockers.push(deviceSmoke.reason ?? 'actual-device-not-verified');
  return {
    buildProfile: 'expo-local-device-verification',
    packageName,
    bundleIdentifier,
    expoVersion: dependencies.expo,
    requiredNativeModules,
    nativeRuntimeExpectations,
    commands,
    artifactManifest: {
      expectedReports: [
        'dist/mobile-verification-report.json',
        'dist/mobile-verification-report.md',
        'dist/mobile-verification-report.html',
        'dist/mobile-product-verification-manifest.json',
        'dist/mobile-android-setup-report.json',
        'dist/mobile-android-setup-report.md',
        'dist/mobile-android-setup-report.html',
        'dist/mobile-android-emulator-report.json',
        'dist/mobile-android-emulator-report.md',
        'dist/mobile-android-emulator-report.html',
        'dist/mobile-android-install-report.json',
        'dist/mobile-android-install-report.md',
        'dist/mobile-android-install-report.html',
        'dist/mobile-release-preflight-report.json',
        'dist/mobile-release-preflight-report.md',
        'dist/mobile-release-preflight-report.html',
        'dist/mobile-device-smoke-report.json',
        'dist/mobile-device-smoke-report.md',
        'dist/mobile-device-smoke-report.html'
      ],
      deviceArtifacts: ['dist/mobile-device/<serial>-screen.png', 'dist/mobile-device/<serial>-window.xml'],
      appEvidence: {
        packageName,
        bundleIdentifier,
        screenRootTestId: 'jarvis-mobile-root',
        titleText: 'Jarvis',
        homeSurfaceContractVersion: 'c-mobile-physical-home-surface-v1',
        homeSurfaceTestIds: ['home-command-input', 'home-submit-button', 'home-conversation-button'],
        installedPackageCapabilityContractVersion: 'c-mobile-installed-package-capabilities-v1'
      }
    },
    readiness: blockers.length === 0 ? 'device-verified' : 'product-readiness-blocked',
    blockers
  };
}

export async function runMobileVerification({
  jsonPath = 'dist/mobile-verification-report.json',
  markdownPath = 'dist/mobile-verification-report.md',
  htmlPath = 'dist/mobile-verification-report.html',
  probeExternalDevices = process.env.JARVIS_EXTERNAL_DEVICE_PROBES !== '0',
  deviceEvidenceRoot = defaultMobileDeviceEvidenceRoot
} = {}) {
  const checks = [];
  const appJson = JSON.parse(await readFile('apps/mobile/app.json', 'utf8'));
  const packageJson = JSON.parse(await readFile('apps/mobile/package.json', 'utf8'));
  const appTsx = await readFile('apps/mobile/src/App.tsx', 'utf8');
  const appScreenSource = appTsx;
  const routesModule = await import('../apps/mobile/src/navigation/routes.js');

  const mobileFileChecks = [];
  for (const file of requiredMobileFiles) {
    const present = await exists(file);
    mobileFileChecks.push({ file, passed: present });
    check(checks, `file:${file}`, `Required mobile file exists: ${file}`, present, file);
  }
  check(checks, 'expo:slug', 'Expo slug is jarvis-mobile', appJson.expo?.slug === 'jarvis-mobile', appJson.expo?.slug);
  check(checks, 'expo:android-package', 'Android package is configured', Boolean(appJson.expo?.android?.package), appJson.expo?.android?.package);
  check(checks, 'expo:ios-bundle', 'iOS bundle identifier is configured', Boolean(appJson.expo?.ios?.bundleIdentifier), appJson.expo?.ios?.bundleIdentifier);
  check(checks, 'expo:scheme', 'Deep-link scheme is configured', appJson.expo?.scheme === 'jarvis', appJson.expo?.scheme);
  check(checks, 'dependency:expo', 'Expo dependency is declared', packageJson.dependencies?.expo?.startsWith('^53.'), packageJson.dependencies?.expo);
  check(checks, 'dependency:secure-store', 'Expo SecureStore dependency is declared', Boolean(packageJson.dependencies?.['expo-secure-store']), packageJson.dependencies?.['expo-secure-store']);
  check(checks, 'dependency:notifications', 'Expo Notifications dependency is declared', Boolean(packageJson.dependencies?.['expo-notifications']), packageJson.dependencies?.['expo-notifications']);
  check(checks, 'dependency:sharing', 'Expo Sharing dependency is declared for native file share sheet', Boolean(packageJson.dependencies?.['expo-sharing']), packageJson.dependencies?.['expo-sharing']);
  check(checks, 'app:production-home-shell', 'App exposes the practical Jarvis command home as its primary surface', appTsx.includes('return renderHomeScreen();') && appTsx.includes('const isHome = true;'), 'apps/mobile/src/App.tsx');
  check(checks, 'app:home-approval-safety', 'Home flow exposes explicit approve and reject controls', appTsx.includes('home-approve-button') && appTsx.includes('home-reject-button'), 'apps/mobile/src/App.tsx');

  const nativeContract = validateNativeMobileConfig({
    appJson,
    packageJson,
    routes: Object.values(routesModule.MobileRoutes ?? {})
  });
  for (const item of nativeContract.checks) {
    check(checks, item.id, `Native contract: ${item.expected}`, item.passed, item.actual);
  }
  const screenContract = validateMobileScreenContract({
    appSource: appScreenSource,
    routes: Object.values(routesModule.MobileRoutes ?? {})
  });
  for (const item of screenContract.checks) {
    check(checks, item.id, `Screen contract: ${item.expected}`, item.passed, item.actual);
  }

  const runtimeScenario = await runMobileRuntimeScenario();
  check(checks, 'runtime:scenario', 'Pairing-command-approval-execution mobile scenario passes', runtimeScenario.passed, runtimeScenario.execution.status);
  check(checks, 'runtime:pairing-scanner-recovery-inventory', 'Pairing QR scanner permission, recovery UX, and persistent device inventory are verified', runtimeScenario.pairing.scannerPermission?.canScan === true && runtimeScenario.pairing.scannedPairing?.success === true && runtimeScenario.pairing.recovery?.canClearToken === true && runtimeScenario.pairing.deviceInventory?.inventoryVersion === 'd-device-inventory-v1', runtimeScenario.pairing);
  check(checks, 'runtime:pairing-screen-product-gate', 'Pairing scanner, QR parse, recovery, inventory, sealed token, and hash-only release dossier product gate passes', runtimeScenario.pairing.productGate?.productGateVersion === 'c-pairing-screen-product-gate-v1' && runtimeScenario.pairing.productGate?.status === 'passed', runtimeScenario.pairing.productGate);
  check(checks, 'runtime:command-pending-queue-detail-panel', 'Command pending queue detail panel is verified without auto-send', runtimeScenario.command.pendingQueueDetailPanel?.panelVersion === 'c-command-pending-queue-detail-panel-v1' && runtimeScenario.command.pendingQueueDetailPanel?.actions?.autoSend === false, runtimeScenario.command.pendingQueueDetailPanel);
  check(checks, 'runtime:command-network-recovery-visual-regression', 'Command network latency, timeout, cancel, and recovery visual states are stable', runtimeScenario.command.networkRecoveryVisualRegression?.status === 'passed', runtimeScenario.command.networkRecoveryVisualRegression);
  check(checks, 'runtime:command-screen-product-gate', 'Command queue detail, timeout recovery, keyboard submit, and hash-only release dossier product gate passes', runtimeScenario.command.productGate?.productGateVersion === 'c-command-screen-product-gate-v1' && runtimeScenario.command.productGate?.status === 'passed', runtimeScenario.command.productGate);
  check(checks, 'runtime:approval-accessibility', 'Risk tier and disabled approval accessibility labels are verified', runtimeScenario.approval.risky.riskAccessibility.hint.includes('PC') && runtimeScenario.approval.risky.approveAccessibility.accessibilityState.disabled === true, runtimeScenario.approval.risky);
  check(checks, 'runtime:approval-lifecycle-product-gate', 'Approval queue/detail navigation, expiry renewal, cancellation, re-request, timeline, and hash-only release dossier product gate passes', runtimeScenario.approval.lifecycleProductGate?.productGateVersion === 'c-approval-lifecycle-product-gate-v1' && runtimeScenario.approval.lifecycleProductGate?.status === 'passed', runtimeScenario.approval.lifecycleProductGate);
  check(checks, 'runtime:approval-disabled-visual', 'Disabled high-risk approval button visual state is verified', runtimeScenario.approval.risky.approveVisualSnapshot.tone === 'pc-confirmation-disabled' && runtimeScenario.approval.risky.approveVisualSnapshot.opacity === 0.55, runtimeScenario.approval.risky.approveVisualSnapshot);
  check(checks, 'runtime:pc-console-bridge-fetch', 'PC console fetches and decides handoffs through live Bridge API', runtimeScenario.approval.risky.pcConsoleBridgeFetch?.passed === true && runtimeScenario.approval.risky.pcConsoleBridgeFetch?.accepted?.historyRecorded === true && runtimeScenario.approval.risky.pcConsoleBridgeFetch?.rejected?.historyRecorded === true, runtimeScenario.approval.risky.pcConsoleBridgeFetch);
  check(checks, 'runtime:pc-console-visual-regression', 'PC console accept/reject surface visual regression is verified', runtimeScenario.approval.risky.pcConsoleBridgeFetch?.initialVisualRegression?.status === 'passed' && runtimeScenario.approval.risky.pcConsoleBridgeFetch?.rejectVisualRegression?.status === 'passed' && runtimeScenario.approval.risky.pcConsoleBridgeFetch?.finalVisualRegression?.status === 'passed', runtimeScenario.approval.risky.pcConsoleBridgeFetch);
  check(checks, 'runtime:mobile-approval-restriction-product-gate', 'High-risk mobile approval block, PC handoff, visual regression, and hash-only release dossier product gate passes', runtimeScenario.approval.risky.productGate?.productGateVersion === 'c-mobile-approval-restriction-product-gate-v1' && runtimeScenario.approval.risky.productGate?.status === 'passed', runtimeScenario.approval.risky.productGate);
  check(checks, 'runtime:growth-review-visual-contract', 'Growth Review screen visual contract covers preference, hygiene, batch, and conflict states', runtimeScenario.growthReview?.visualSnapshot?.passed === true, runtimeScenario.growthReview);
  check(checks, 'runtime:growth-hygiene-trend-batch', 'Growth hygiene trend chart and batch selection contracts are verified', runtimeScenario.growthReview?.hygieneTrendChart?.chartVersion === 'c-growth-hygiene-trend-chart-v1' && runtimeScenario.growthReview?.batchSelection?.selectionVersion === 'c-growth-hygiene-batch-selection-v1' && runtimeScenario.growthReview?.batchSelection?.selectedCount >= 1, runtimeScenario.growthReview);
  check(checks, 'runtime:growth-conflict-resolution-modal', 'Growth preference conflict resolution modal contract blocks confirmation until acknowledgement', runtimeScenario.growthReview?.conflictResolution?.modalVersion === 'c-growth-conflict-resolution-modal-v1' && runtimeScenario.growthReview?.conflictResolution?.confirmBlockedUntilAcknowledged === true, runtimeScenario.growthReview?.conflictResolution);
  check(checks, 'runtime:growth-review-product-gate', 'Growth Review visual snapshot, hygiene trend/batch, conflict modal, and hash-only release dossier product gate passes', runtimeScenario.growthReview?.productGate?.productGateVersion === 'c-growth-review-product-gate-v1' && runtimeScenario.growthReview?.productGate?.status === 'passed', runtimeScenario.growthReview?.productGate);
  check(checks, 'runtime:notification-delivery', 'Notification permission and local delivery log are verified', runtimeScenario.notifications.deliveredCount > 0, runtimeScenario.notifications);
  check(checks, 'runtime:notification-receipts', 'Foreground/background notification receipts are verified', runtimeScenario.notifications.receiptVerification.checked > 0 && runtimeScenario.notifications.receiptVerification.failed === 0, runtimeScenario.notifications.receiptVerification);
  check(checks, 'runtime:notification-provider-drill', 'Foreground/background provider receipt drill is verified', runtimeScenario.notifications.providerDrill?.status === 'passed' && runtimeScenario.notifications.providerDrill?.providerReceipt?.visualEvidence?.length >= 2, runtimeScenario.notifications.providerDrill);
  check(checks, 'runtime:notification-token-rotation-drill', 'Push token rotation failure preserves the previous token and recovery rotation succeeds', runtimeScenario.notifications.providerDrill?.failedRotation?.previousTokenPreserved === true && runtimeScenario.notifications.providerDrill?.successfulRotation?.success === true, runtimeScenario.notifications.tokenRotation);
  check(checks, 'runtime:notification-product-gate', 'Notification foreground/background receipt and token rotation product gate passes', runtimeScenario.notifications.notificationProductGate?.productGateVersion === 'c-notification-product-gate-v1' && runtimeScenario.notifications.notificationProductGate?.status === 'passed', runtimeScenario.notifications.notificationProductGate);
  check(checks, 'runtime:notification-release-dossier', 'Notification release dossier hashes provider receipts, token rotation, and delivery evidence without raw notification payloads', runtimeScenario.notifications.notificationProductGate?.releaseDossier?.dossierVersion === 'c-notification-release-dossier-v1' && runtimeScenario.notifications.notificationProductGate?.releaseDossier?.status === 'passed' && runtimeScenario.notifications.notificationProductGate?.releaseDossier?.artifactManifest?.rawLeakCheck?.rawLeakDetected === false, runtimeScenario.notifications.notificationProductGate?.releaseDossier);
  check(checks, 'runtime:document-preview-share', 'Result screen opens preview/share document actions through native adapter contract', runtimeScenario.execution.documentActions?.preview?.status && runtimeScenario.execution.documentActions?.share?.status && runtimeScenario.execution.documentActions?.recentCount >= 2, runtimeScenario.execution.documentActions);
  check(checks, 'runtime:task-status-long-polling-visual-regression', 'Task status long-polling latency and visual states are regression checked', runtimeScenario.execution.documentActions?.longPollingRegression?.status === 'passed', runtimeScenario.execution.documentActions?.longPollingRegression);
  check(checks, 'runtime:rollback-confirmation', 'Result rollback requires explicit confirmation before execution', runtimeScenario.execution.documentActions?.rollbackConfirmation?.confirmationVersion === 'c-result-rollback-confirmation-v1', runtimeScenario.execution.documentActions?.rollbackConfirmation);
  check(checks, 'runtime:rollback-proof-modal', 'Confirmed rollback exposes verified proof modal evidence', runtimeScenario.execution.documentActions?.rollbackProofModal?.modalVersion === 'c-result-rollback-proof-modal-v1' && runtimeScenario.execution.documentActions?.rollbackProofModal?.status === 'verified', runtimeScenario.execution.documentActions?.rollbackProofModal);
  check(checks, 'runtime:result-feedback-product-gate', 'Result feedback, preview/share, rollback proof, and polling contracts pass as a product gate', runtimeScenario.execution.documentActions?.resultProductGate?.productGateVersion === 'c-result-feedback-product-gate-v1' && runtimeScenario.execution.documentActions?.resultProductGate?.status === 'passed', runtimeScenario.execution.documentActions?.resultProductGate);
  check(checks, 'runtime:secure-token-lifecycle-status', 'Secure token lifecycle status decodes signed expiry/version without exposing plaintext', runtimeScenario.security.tokenLifecycle?.statusVersion === 'c-secure-token-lifecycle-status-v1' && runtimeScenario.security.tokenLifecycle?.tokenStorage?.plaintextExposed === false, runtimeScenario.security.tokenLifecycle);
  check(checks, 'runtime:secure-token-recovery-ux', 'Expired or invalid bridge tokens expose repair-pairing recovery UX', runtimeScenario.security.secureTokenProductGate?.expiredRecovery?.stateVersion === 'c-secure-token-recovery-ux-v1' && runtimeScenario.security.secureTokenProductGate?.expiredRecovery?.primaryAction === 'repair_pairing', runtimeScenario.security.secureTokenProductGate?.expiredRecovery);
  check(checks, 'runtime:secure-token-release-dossier', 'Secure token release dossier hashes storage, rotation, revoke retry, and recovery evidence without raw bridge tokens', runtimeScenario.security.secureTokenProductGate?.releaseDossier?.dossierVersion === 'c-secure-token-storage-release-dossier-v1' && runtimeScenario.security.secureTokenProductGate?.releaseDossier?.status === 'passed' && runtimeScenario.security.secureTokenProductGate?.releaseDossier?.artifactManifest?.rawLeakCheck?.rawLeakDetected === false, runtimeScenario.security.secureTokenProductGate?.releaseDossier);
  check(checks, 'runtime:secure-token-product-gate', 'Secure token storage rotation and revoke retry queue product gate passes', runtimeScenario.security.secureTokenProductGate?.productGateVersion === 'c-secure-token-storage-product-gate-v1' && runtimeScenario.security.secureTokenProductGate?.status === 'passed', runtimeScenario.security.secureTokenProductGate);
  check(checks, 'runtime:lifecycle-lock', 'Background lifecycle lock is verified', runtimeScenario.security.lifecycleLock === 'app-backgrounded', runtimeScenario.security);
  check(checks, 'runtime:biometric-unlock', 'Biometric/native secure prompt contract unlock is verified', runtimeScenario.security.biometricUnlock?.success === true && runtimeScenario.security.biometricUnlock?.biometric?.capability?.expectedNativeModule === 'expo-local-authentication', runtimeScenario.security.biometricUnlock);
  check(checks, 'runtime:lifecycle-soak', 'Foreground/background lifecycle soak keeps session lock policy active', runtimeScenario.security.lifecycleSoak?.passed === true && runtimeScenario.security.lifecycleSoak?.lockedTransitions >= 2, runtimeScenario.security.lifecycleSoak);
  check(checks, 'runtime:session-lock-product-gate', 'Session lock biometric prompt and foreground/background visual regression product gate passes', runtimeScenario.security.sessionLockProductGate?.productGateVersion === 'c-session-lock-product-gate-v1' && runtimeScenario.security.sessionLockProductGate?.status === 'passed', runtimeScenario.security.sessionLockProductGate);
  check(checks, 'runtime:session-lock-release-dossier', 'Session lock release dossier hashes biometric and lifecycle evidence without storing raw secrets', runtimeScenario.security.sessionLockProductGate?.releaseDossier?.dossierVersion === 'c-session-lock-release-dossier-v1' && runtimeScenario.security.sessionLockProductGate?.releaseDossier?.status === 'passed' && runtimeScenario.security.sessionLockProductGate?.releaseDossier?.artifactManifest?.rawLeakCheck?.rawLeakDetected === false, runtimeScenario.security.sessionLockProductGate?.releaseDossier);
  check(checks, 'runtime:poison-queue-review', 'Mobile poison queue review flow is verified', runtimeScenario.poisonQueue.reviewStatus === 'reviewed', runtimeScenario.poisonQueue);
  check(checks, 'runtime:poison-queue-drain-soak', 'Mobile poison queue drain and soak refresh are verified', runtimeScenario.poisonQueue.drainProcessed >= 1 && runtimeScenario.poisonQueue.soak?.success === true, runtimeScenario.poisonQueue);
  check(checks, 'runtime:poison-queue-visual-regression', 'Poison queue visual regression remains stable across drain and soak cycles', runtimeScenario.poisonQueue.visualRegression?.status === 'passed' && runtimeScenario.poisonQueue.operationalEvidence?.passed === true, runtimeScenario.poisonQueue);
  check(checks, 'runtime:poison-queue-notification-ux', 'Poison queue foreground/background notification UX is captured and recoverable', runtimeScenario.poisonQueue.notificationUx?.snapshotVersion === 'c-poison-queue-notification-ux-v1' && runtimeScenario.poisonQueue.notificationUx?.passed === true, runtimeScenario.poisonQueue.notificationUx);
  check(checks, 'runtime:poison-queue-release-dossier', 'Poison queue release dossier hashes dead-letter review, requeue, drain, soak, and notification evidence', runtimeScenario.poisonQueue.releaseDossier?.dossierVersion === 'c-poison-queue-release-dossier-v1' && runtimeScenario.poisonQueue.releaseDossier?.status === 'passed' && runtimeScenario.poisonQueue.releaseDossier?.artifactManifest?.rawLeakCheck?.rawLeakDetected === false, runtimeScenario.poisonQueue.releaseDossier);
  check(checks, 'runtime:poison-queue-product-gate', 'Poison queue review, requeue, drain, soak, notification UX, and hash-only release dossier product gate passes', runtimeScenario.poisonQueue.productGate?.productGateVersion === 'c-poison-queue-product-gate-v1' && runtimeScenario.poisonQueue.productGate?.status === 'passed', runtimeScenario.poisonQueue.productGate);
  check(checks, 'runtime:retry-policy-update', 'Mobile queue retry policy update flow is verified', runtimeScenario.queuePolicy.update?.maxAttempts === 4, runtimeScenario.queuePolicy);

  const deviceSmokeAttempt = await runMobileDeviceSmoke({
    packageName: appJson.expo?.android?.package,
    probeDevices: probeExternalDevices
  });
  const persistentDeviceEvidenceEnabled = probeExternalDevices && Boolean(deviceEvidenceRoot);
  const deviceSmoke = persistentDeviceEvidenceEnabled
    ? await reconcileMobileDeviceEvidence(deviceSmokeAttempt, { evidenceRoot: deviceEvidenceRoot })
    : {
        ...deviceSmokeAttempt,
        evidenceSource: 'external-probe-disabled',
        retainedEvidence: {
          status: 'not-evaluated',
          reason: 'external-device-probe-disabled'
        }
      };
  const deviceSmokeArtifacts = await writeMobileDeviceSmokeArtifacts(deviceSmoke, {
    jsonPath: join(dirname(jsonPath), 'mobile-device-smoke-report.json'),
    markdownPath: join(dirname(markdownPath), 'mobile-device-smoke-report.md'),
    htmlPath: join(dirname(htmlPath), 'mobile-device-smoke-report.html'),
    attemptReport: deviceSmokeAttempt,
    evidenceRoot: persistentDeviceEvidenceEnabled ? deviceEvidenceRoot : null
  });
  const androidSetup = await runAndroidSetup({
    install: false,
    jsonPath: join(dirname(jsonPath), 'mobile-android-setup-report.json'),
    markdownPath: join(dirname(markdownPath), 'mobile-android-setup-report.md'),
    htmlPath: join(dirname(htmlPath), 'mobile-android-setup-report.html')
  });
  const androidEmulator = await runAndroidEmulatorReadiness({
    start: false,
    jsonPath: join(dirname(jsonPath), 'mobile-android-emulator-report.json'),
    markdownPath: join(dirname(markdownPath), 'mobile-android-emulator-report.md'),
    htmlPath: join(dirname(htmlPath), 'mobile-android-emulator-report.html')
  });
  const androidInstall = await runAndroidInstallVerification({
    build: false,
    install: false,
    jsonPath: join(dirname(jsonPath), 'mobile-android-install-report.json'),
    markdownPath: join(dirname(markdownPath), 'mobile-android-install-report.md'),
    htmlPath: join(dirname(htmlPath), 'mobile-android-install-report.html')
  });
  const releasePreflight = await runMobileReleasePreflight({
    outputDir: dirname(jsonPath),
    jsonPath: join(dirname(jsonPath), 'mobile-release-preflight-report.json'),
    markdownPath: join(dirname(markdownPath), 'mobile-release-preflight-report.md'),
    htmlPath: join(dirname(htmlPath), 'mobile-release-preflight-report.html')
  });
  const deviceProbe = {
    ...deviceSmoke.probe,
    currentDeviceConnected: deviceSmoke.probe?.devices?.some((device) => device.state === 'device') ?? false,
    actualDeviceVerified: deviceSmoke.actualDeviceVerified,
    evidenceSource: deviceSmoke.evidenceSource
  };
  const productMatrix = createMobileProductMatrix({
    appJson,
    packageJson,
    nativeReadiness: nativeContract,
    screenReadiness: screenContract,
    deviceSmoke,
    androidSetup,
    androidEmulator,
    androidInstall,
    releasePreflight
  });
  const appShell = createMobileAppShell();
  const mobileAppStructureProductGate = createMobileAppStructureProductGate({
    shell: appShell,
    nativeReadiness: nativeContract,
    screenReadiness: screenContract,
    productMatrix,
    fileChecks: mobileFileChecks
  });
  check(checks, 'product:mobile-app-structure-product-gate', 'Mobile app shell, bootstrap, native contract, screen contract, and artifact manifest product gate passes', mobileAppStructureProductGate.status === 'passed', mobileAppStructureProductGate);
  check(checks, 'product:android-package-matches-device-smoke', 'Device smoke uses the app.json Android package name', deviceSmoke.plan.packageName === appJson.expo?.android?.package, {
    appJsonPackage: appJson.expo?.android?.package,
    smokePackage: deviceSmoke.plan.packageName
  });
  check(checks, 'product:build-command-plan', 'Expo doctor/prebuild/run Android command plan is recorded', productMatrix.commands.length >= 4, productMatrix.commands);
  check(checks, 'product:android-platform-tools-setup', 'Android Platform Tools setup/report command plan is recorded', productMatrix.commands.some((item) => item.id === 'android-platform-tools-setup'), productMatrix.commands);
  check(checks, 'product:android-setup-report', 'Android Platform Tools setup report is generated', Boolean(androidSetup.artifacts?.jsonPath), androidSetup.artifacts);
  check(checks, 'product:android-emulator-readiness', 'Android Emulator readiness command plan is recorded', productMatrix.commands.some((item) => item.id === 'android-emulator-readiness'), productMatrix.commands);
  check(checks, 'product:android-emulator-report', 'Android Emulator readiness report is generated', Boolean(androidEmulator.artifacts?.jsonPath), androidEmulator.artifacts);
  check(checks, 'product:android-gradle-install', 'Android Gradle build/install command plan is recorded', productMatrix.commands.some((item) => item.id === 'android-gradle-install'), productMatrix.commands);
  check(checks, 'product:android-install-report', 'Android install/build report is generated', Boolean(androidInstall.artifacts?.jsonPath), androidInstall.artifacts);
  check(checks, 'product:mobile-release-preflight-plan', 'Mobile release preflight command plan is recorded', productMatrix.commands.some((item) => item.id === 'mobile-release-preflight'), productMatrix.commands);
  check(checks, 'product:mobile-release-preflight-report', 'Mobile release preflight report is generated', Boolean(releasePreflight.artifacts?.jsonPath), releasePreflight.artifacts);
  check(checks, 'product:mobile-release-local-contract', 'Mobile release local preflight contract passes', releasePreflight.localStatus === 'passed', {
    status: releasePreflight.status,
    blockers: releasePreflight.blockers
  });
  check(checks, 'product:mobile-release-external-gate', 'Mobile release credentials and physical evidence are tracked as a product-readiness gate', releasePreflight.status === 'passed', {
    status: releasePreflight.status,
    credentialStatus: releasePreflight.credentialStatus,
    deviceEvidenceStatus: releasePreflight.deviceEvidenceStatus,
    blockers: releasePreflight.blockers
  }, 'product-readiness');
  check(checks, 'product:native-runtime-expectations', 'Native SecureStore/Notifications runtime expectations are recorded', productMatrix.nativeRuntimeExpectations.every((item) => item.configured), productMatrix.nativeRuntimeExpectations);
  check(checks, 'product:home-surface-contract', 'App source exposes the practical command, execution, voice, and pairing home contract', screenContract.status === 'passed' && appScreenSource.includes('home-command-input') && appScreenSource.includes('home-submit-button') && appScreenSource.includes('home-conversation-button'), 'apps/mobile/src/App.tsx');
  check(checks, 'device:adb-probe', 'ADB/emulator probe executed when available', true, deviceProbe, 'informational');
  check(checks, 'device:current-device-connected', 'Current Android device/emulator connection state is recorded separately from retained evidence', true, deviceProbe, 'informational');
  check(checks, 'device:actual-device', 'Current-code-matching physical Android device evidence is available', deviceProbe.actualDeviceVerified, deviceProbe, 'product-readiness');
  check(checks, 'device:install-launch-screen', 'Installed mobile app launch and production home contract have current-code-matching device evidence', deviceSmoke.actualDeviceVerified, deviceSmoke, 'product-readiness');

  const requiredChecks = checks.filter((item) => item.severity === 'required');
  const passedRequired = requiredChecks.filter((item) => item.passed).length;
  const score = Math.round((passedRequired / requiredChecks.length) * 1000) / 10;
  const report = {
    generatedAt: new Date().toISOString(),
    status: passedRequired === requiredChecks.length ? 'passed' : 'failed',
    score,
    project: {
      name: appJson.expo?.name,
      slug: appJson.expo?.slug,
      androidPackage: appJson.expo?.android?.package,
      expoVersion: packageJson.dependencies?.expo
    },
    checks,
    nativeReadiness: {
      status: nativeContract.status,
      passed: nativeContract.checks.filter((item) => item.passed).length,
      total: nativeContract.checks.length,
      checks: nativeContract.checks
    },
    screenReadiness: {
      status: screenContract.status,
      passed: screenContract.checks.filter((item) => item.passed).length,
      total: screenContract.checks.length,
      checks: screenContract.checks
    },
    runtimeScenario,
    deviceProbe,
    deviceSmoke: {
      ...deviceSmoke,
      artifacts: deviceSmokeArtifacts,
      nextActions: deviceSmokeNextActions(deviceSmoke)
    },
    androidSetup,
    androidEmulator,
    androidInstall,
    releasePreflight,
    mobileAppStructureProductGate,
    productMatrix
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(htmlPath, renderHtml(report), 'utf8');
  await writeFile('dist/mobile-product-verification-manifest.json', JSON.stringify(productMatrix, null, 2), 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runMobileVerification();
  console.log('# JARVIS Mobile Verification');
  console.log(`Status: ${report.status}`);
  console.log(`Score: ${report.score}`);
  console.log(`Actual device verified: ${report.deviceProbe.actualDeviceVerified}`);
  console.log('Reports: dist/mobile-verification-report.json, dist/mobile-verification-report.md, dist/mobile-verification-report.html, dist/mobile-product-verification-manifest.json, dist/mobile-android-setup-report.*, dist/mobile-android-emulator-report.*, dist/mobile-android-install-report.*, dist/mobile-release-preflight-report.*, dist/mobile-device-smoke-report.*');
  if (report.status !== 'passed') process.exitCode = 1;
}
