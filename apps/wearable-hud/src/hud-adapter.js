import { createHash } from 'node:crypto';
import { BridgeClient } from '../../mobile/src/api/BridgeClient.js';
import { ApprovalDecision } from '../../../packages/shared/src/types.js';

export const wearableHudAdapterVersion = 'c-d-wearable-hud-adapter-v1';
export const wearableHudFrameVersion = 'c-d-wearable-hud-frame-v1';
export const wearableHudVoiceIntentVersion = 'c-d-wearable-voice-intent-v1';

export const defaultWearableHudLimits = {
  maxLines: 5,
  maxCharsPerLine: 30,
  glanceVisibleMs: 5000,
  focusVisibleMs: 15000,
  approvalVisibleMs: 12000,
  emergencyVisibleMs: 30000
};

export function createWearableHudDeviceProfile({
  deviceId = 'jarvis-glasses-local',
  modelName = 'monochrome-green-ai-glasses',
  displayMode = 'monochrome-green-vr',
  voiceInput = true,
  boneConductionAudio = true,
  maxLines = defaultWearableHudLimits.maxLines,
  maxCharsPerLine = defaultWearableHudLimits.maxCharsPerLine
} = {}) {
  return {
    profileVersion: 'c-d-wearable-hud-device-profile-v1',
    deviceId,
    modelName,
    displayMode,
    voiceInput,
    boneConductionAudio,
    palette: {
      mode: 'monochrome-green',
      foreground: '#00ff66',
      dim: '#37a86b',
      background: '#000400',
      alertPattern: 'blink-outline'
    },
    limits: {
      maxLines,
      maxCharsPerLine,
      maxVisibleMs: defaultWearableHudLimits.emergencyVisibleMs
    },
    ergonomics: {
      defaultDensity: 'glance',
      avoidsPersistentOcclusion: true,
      safeAreaInsetPct: 8,
      oneHandFallback: false
    },
    privacy: {
      rawTranscriptStored: false,
      rawBridgeTokenStored: false,
      rawSecretMaterialStored: false,
      redactedPreviewOnly: true
    }
  };
}

export function createInitialWearableHudState({
  deviceProfile = createWearableHudDeviceProfile(),
  bridgeUrl = 'http://127.0.0.1:17777'
} = {}) {
  return {
    stateVersion: 'c-d-wearable-hud-state-v1',
    deviceProfile,
    connection: {
      bridgeUrl,
      connected: false,
      latencyMs: null,
      lastSyncAt: null,
      error: null
    },
    voice: {
      listening: false,
      wakeWord: 'jarvis',
      lastIntent: null,
      rawTranscriptStored: false
    },
    display: {
      mode: 'glance',
      density: 'glance',
      currentFrame: null,
      autoHideAt: null,
      occlusionGuard: true
    },
    approvals: {
      pendingCount: 0,
      highestRiskTier: 0,
      current: null
    },
    task: {
      current: null
    },
    privacy: {
      sensitiveMode: true,
      redactionCount: 0,
      rawBridgeTokenStored: false
    }
  };
}

export class WearableHudAdapter {
  constructor({
    bridgeClient = null,
    bridgeUrl = 'http://127.0.0.1:17777',
    tokenProvider = () => null,
    fetchImpl = fetch,
    deviceProfile = createWearableHudDeviceProfile()
  } = {}) {
    this.deviceProfile = deviceProfile;
    this.bridgeClient = bridgeClient ?? new BridgeClient({
      bridgeUrl,
      tokenProvider,
      fetchImpl,
      timeoutMs: 8000,
      retries: 1
    });
  }

  parseVoice(transcript, options = {}) {
    return createWearableVoiceIntent({ transcript, ...options });
  }

  createFrame(snapshot = {}) {
    return createWearableHudFrame({
      deviceProfile: this.deviceProfile,
      ...snapshot
    });
  }

  bridgeSyncPlan(options = {}) {
    return createWearableBridgeSyncPlan({
      bridgeUrl: this.bridgeClient.bridgeUrl,
      ...options
    });
  }

  async syncOnce({ taskId = null } = {}) {
    const startedAt = Date.now();
    const [health, approvals, events, task] = await Promise.all([
      this.bridgeClient.getHealth(),
      this.bridgeClient.getApprovals(),
      this.bridgeClient.getEvents({ eventType: 'task.status.changed' }),
      taskId ? this.bridgeClient.getTaskStatus(taskId) : Promise.resolve(null)
    ]);
    return {
      syncVersion: 'c-d-wearable-hud-live-bridge-sync-v1',
      status: health?.success === false || approvals?.success === false || events?.success === false
        ? 'degraded'
        : 'synced',
      latencyMs: Date.now() - startedAt,
      bridgeUrl: this.bridgeClient.bridgeUrl,
      healthStatus: health?.status ?? health?.module ?? (health?.success === false ? 'error' : 'ok'),
      pendingApprovalCount: Array.isArray(approvals?.items) ? approvals.items.length : approvals?.count ?? null,
      eventCount: Array.isArray(events?.items) ? events.items.length : null,
      taskStatus: task?.status ?? null,
      rawBridgeTokenStored: false
    };
  }
}

export function createWearableVoiceIntent({
  transcript = '',
  locale = 'ko-KR',
  now = new Date(),
  wakeWords = ['자비스', 'jarvis', 'hey jarvis']
} = {}) {
  const text = String(transcript ?? '').trim();
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const redacted = redactHudText(text);
  const activationDetected = wakeWords.some((word) => normalized.includes(String(word).toLowerCase()));
  const cleaned = wakeWords.reduce(
    (value, word) => value.replace(new RegExp(escapeRegExp(String(word)), 'ig'), ''),
    text
  ).trim();
  const lower = cleaned.toLowerCase();
  const intentName = inferWearableIntent(lower);
  const approvalDecision = intentName === 'approve'
    ? ApprovalDecision.APPROVE
    : intentName === 'reject'
      ? ApprovalDecision.REJECT
      : null;
  const requiresExplicitConfirmation = ['approve', 'reject', 'execute_command'].includes(intentName);
  return {
    intentVersion: wearableHudVoiceIntentVersion,
    locale,
    capturedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    activationDetected,
    intentName,
    confidence: activationDetected ? 0.92 : 0.64,
    transcriptHash: sha256(text),
    redactedPreview: compactText(redacted.text || cleaned || text, 48),
    commandTextHash: cleaned ? sha256(cleaned) : null,
    approvalDecision,
    requiresExplicitConfirmation,
    bridgeAction: createBridgeActionForIntent({ intentName, cleaned }),
    privacy: {
      rawTranscriptStored: false,
      redactionCount: redacted.redactions.length,
      redactionTypes: redacted.redactions.map((item) => item.type)
    },
    safety: {
      noAutoExecute: true,
      noAutoApproveHighRisk: true,
      wearableApprovalRequiresFreshPrompt: approvalDecision !== null
    }
  };
}

function inferWearableIntent(lower) {
  if (/(승인|approve|confirm)/.test(lower)) return 'approve';
  if (/(거절|reject|deny|cancel)/.test(lower)) return 'reject';
  if (/(상태|status|진행|progress)/.test(lower)) return 'show_status';
  if (/(승인.*대기|approval|대기)/.test(lower)) return 'show_approvals';
  if (/(조용|숨겨|끄기|quiet|hide)/.test(lower)) return 'quiet_mode';
  if (/(다시|repeat|replay)/.test(lower)) return 'repeat_frame';
  if (/(메모|기록|note|memo)/.test(lower)) return 'dictate_note';
  if (lower.length > 0) return 'execute_command';
  return 'unknown';
}

function createBridgeActionForIntent({ intentName, cleaned }) {
  if (intentName === 'execute_command' || intentName === 'dictate_note') {
    return {
      actionVersion: 'c-d-wearable-bridge-command-action-v1',
      method: 'POST',
      path: '/tasks',
      commandHash: sha256(cleaned),
      safePreview: compactText(redactHudText(cleaned).text, 44),
      requiresUserConfirmation: true,
      rawPayloadStored: false
    };
  }
  if (intentName === 'show_approvals') {
    return { method: 'GET', path: '/approvals', rawPayloadStored: false };
  }
  if (intentName === 'show_status') {
    return { method: 'GET', path: '/tasks', rawPayloadStored: false };
  }
  return null;
}

export function createWearableApprovalState({
  card = {},
  safety = {},
  session = {}
} = {}) {
  const riskTier = Number(card.riskTier ?? safety.riskTier ?? 0);
  const requiresPcConfirmation = safety.requiresPcConfirmation === true
    || card.requiresPcConfirmation === true
    || safety.mobileApprovalAllowed === false
    || card.mobileApprovalAllowed === false
    || riskTier <= 3;
  const sessionUnlocked = session.locked !== true && session.sensitiveActionReady !== false;
  const expired = safety.expired === true || card.expired === true;
  const mobileApprovalAllowed = safety.mobileApprovalAllowed !== false && !requiresPcConfirmation;
  const wearableApproveEnabled = !expired && sessionUnlocked && mobileApprovalAllowed;
  return {
    stateVersion: 'c-d-wearable-approval-state-v1',
    approvalId: card.approvalId ?? null,
    taskId: card.taskId ?? null,
    riskTier,
    tone: expired
      ? 'expired'
      : requiresPcConfirmation
        ? 'pc-confirmation-required'
        : riskTier === 4
          ? 'caution'
          : 'normal',
    summary: compactText(redactHudText(card.summary ?? card.title ?? '승인 대기').text, 42),
    affectedItemCount: safety.affectedItemCount ?? card.affectedItemCount ?? 0,
    rollbackAvailable: safety.rollbackAvailable === true || card.rollbackAvailable === true,
    actions: {
      approve: {
        decision: ApprovalDecision.APPROVE,
        enabled: wearableApproveEnabled,
        blockedReason: wearableApproveEnabled
          ? null
          : expired
            ? 'approval-expired'
            : !sessionUnlocked
              ? 'session-locked'
              : requiresPcConfirmation
                ? 'pc-confirmation-required'
                : 'mobile-approval-disabled'
      },
      reject: {
        decision: ApprovalDecision.REJECT,
        enabled: !expired && sessionUnlocked,
        blockedReason: expired ? 'approval-expired' : !sessionUnlocked ? 'session-locked' : null
      },
      pcHandoff: {
        action: 'request_pc_confirmation',
        enabled: requiresPcConfirmation && !expired,
        blockedReason: requiresPcConfirmation ? null : 'not-required'
      }
    },
    privacy: {
      rawApprovalPayloadStored: false,
      redactedPreviewOnly: true
    }
  };
}

export function createWearableHudFrame({
  deviceProfile = createWearableHudDeviceProfile(),
  mode = 'glance',
  density = mode === 'approval' ? 'approval' : 'glance',
  connection = {},
  task = null,
  approval = null,
  notifications = {},
  voiceIntent = null,
  now = new Date()
} = {}) {
  const generatedAt = now instanceof Date ? now : new Date(now);
  const limits = deviceProfile.limits ?? defaultWearableHudLimits;
  const ttlMs = ttlForMode(mode);
  const redactionAccumulator = [];
  const lines = [];
  let currentApprovalState = null;
  const pushLine = (slot, text, priority = 1) => {
    if (lines.length >= limits.maxLines) return;
    const redacted = redactHudText(text);
    redactionAccumulator.push(...redacted.redactions);
    lines.push({
      slot,
      priority,
      text: compactText(redacted.text, limits.maxCharsPerLine),
      visibleUntil: new Date(generatedAt.getTime() + ttlMs).toISOString()
    });
  };

  pushLine('header', headerForMode(mode, connection), 100);
  if (approval) {
    currentApprovalState = approval.stateVersion === 'c-d-wearable-approval-state-v1'
      ? approval
      : createWearableApprovalState({ card: approval.card ?? approval, safety: approval.safety, session: approval.session });
    pushLine('approval-summary', currentApprovalState.summary, 80);
    pushLine('approval-action', approvalActionLine(currentApprovalState), 90);
    pushLine('approval-risk', `위험 T${currentApprovalState.riskTier} ${toneLabelKo(currentApprovalState.tone)}`, 70);
  } else if (task) {
    pushLine('task-title', task.title ?? task.command ?? task.taskId ?? '활성 작업 없음', 70);
    pushLine('task-status', `${taskStatusLabelKo(task.status) ?? '작업'} ${task.progressLabel ?? task.progress?.label ?? ''}`, 80);
    pushLine('task-action', '말해요: 상태 또는 조용히', 60);
  } else {
    pushLine('system', connection.connected ? '말하면 바로 작업 생성' : '페어링 후 바로 사용', 80);
    pushLine('queue', '말해요: 녹음 / 캡처 / 메모', 60);
  }
  if (voiceIntent) {
    pushLine('voice', `음성 ${intentLabelKo(voiceIntent.intentName)}`, 50);
  }
  const actionDeck = actionDeckForHudFrame({ mode, connection, approvalState: currentApprovalState, task, voiceIntent });
  const contextDeck = contextDeckForHudFrame({ mode, connection, approvalState: currentApprovalState, task, notifications, voiceIntent });
  pushLine('footer', actionDeck[0]?.phrase ?? footerForMode(mode), 10);

  return {
    frameVersion: wearableHudFrameVersion,
    generatedAt: generatedAt.toISOString(),
    mode,
    density,
    display: {
      palette: 'monochrome-green',
      foreground: deviceProfile.palette?.foreground ?? '#00ff66',
      background: deviceProfile.palette?.background ?? '#000400',
      occlusionGuard: true
    },
    limits: {
      maxLines: limits.maxLines,
      maxCharsPerLine: limits.maxCharsPerLine,
      ttlMs
    },
    lines,
    actions: actionDeck,
    context: contextDeck,
    voiceActions: frameVoiceActions({ mode, approval }),
    privacy: {
      rawTranscriptStored: false,
      rawBridgeTokenStored: false,
      redactedPreviewOnly: true,
      redactionCount: redactionAccumulator.length
    },
    layoutContract: {
      noCardsInsideCards: true,
      noFullTextDump: true,
      oneToTwoSecondGlanceReadable: density === 'glance',
      stableLineGrid: true,
      operatorFirst: true,
      hidesImplementationModules: true,
      quickActionsVisible: actionDeck.length >= 3,
      contextRowsVisible: contextDeck.length >= 2
    }
  };
}

function actionDeckForHudFrame({ mode, connection, approvalState, task, voiceIntent }) {
  if (approvalState) {
    return [
      {
        id: 'pc-confirm',
        label: approvalState.actions.pcHandoff.enabled ? 'PC 확인 요청' : '승인',
        phrase: approvalState.actions.pcHandoff.enabled ? '자비스 PC 확인' : '자비스 승인',
        command: approvalState.actions.pcHandoff.enabled ? '승인 PC 확인 요청' : '승인'
      },
      { id: 'reject', label: '거절', phrase: '자비스 거절', command: '승인 거절' },
      { id: 'repeat', label: '다시 듣기', phrase: '자비스 다시', command: '현재 승인 다시 읽기' },
      { id: 'quiet', label: '숨김', phrase: '자비스 조용히', command: '조용히' }
    ];
  }
  if (task) {
    return [
      { id: 'status', label: '진행 확인', phrase: '자비스 상태', command: '작업 상태 보여줘' },
      { id: 'capture-screen', label: '화면 캡처', phrase: '자비스 현재 화면 캡처', command: '현재 화면 캡처' },
      { id: 'save-voice-note', label: '메모 추가', phrase: '자비스 음성 메모 저장', command: '음성 메모 저장' },
      { id: 'quiet', label: '숨김', phrase: '자비스 조용히', command: '조용히' }
    ];
  }
  return [
    { id: 'record-meeting', label: connection.connected === false ? '페어링 후 녹음' : '회의 녹음', phrase: connection.connected === false ? '먼저 페어링' : '자비스 회의 녹음 시작', command: '회의 녹음 시작' },
    { id: 'capture-screen', label: '화면 캡처', phrase: '자비스 현재 화면 캡처', command: '현재 화면 캡처' },
    { id: 'save-voice-note', label: '음성 메모', phrase: '자비스 음성 메모 저장', command: '음성 메모 저장' },
    { id: 'show-approvals', label: '승인 확인', phrase: '자비스 승인 대기 보여줘', command: '승인 대기 보여줘' }
  ];
}

function contextDeckForHudFrame({ connection, approvalState, task, notifications, voiceIntent }) {
  if (approvalState) {
    return [
      ['판단', approvalState.summary],
      ['위험', `T${approvalState.riskTier} · ${toneLabelKo(approvalState.tone)}`],
      ['허용', approvalState.actions.approve.enabled ? '안경 승인 가능' : 'PC 확인 필요'],
      ['대안', approvalState.actions.reject.enabled ? '거절 가능' : '만료됨']
    ];
  }
  if (task) {
    return [
      ['현재 작업', taskTitleForHud(task)],
      ['상태', taskStatusLabelKo(task.status) ?? '진행 중'],
      ['다음', task.status === 'WAITING_APPROVAL' ? '승인 확인' : '완료까지 대기'],
      ['음성', voiceIntent ? intentLabelKo(voiceIntent.intentName) : '상태 요청 가능']
    ];
  }
  return [
    ['준비', connection.connected ? '바로 말하기 가능' : '페어링 또는 토큰 필요'],
    ['추천', '회의 녹음 / 화면 캡처'],
    ['승인', `${notifications.pendingApprovals ?? 0}건 대기`],
    ['보안', '원문/토큰 미저장']
  ];
}

function taskTitleForHud(task) {
  return compactText(task?.title ?? task?.command ?? task?.taskId ?? '작업 없음', 24);
}

function headerForMode(mode, connection) {
  if (mode === 'approval') return 'JARVIS 승인 확인';
  if (mode === 'emergency') return connection.connected ? 'JARVIS 주의 필요' : 'JARVIS 앱 연결 필요';
  if (mode === 'focus') return 'JARVIS 작업 집중';
  return 'JARVIS 음성 대기';
}

function footerForMode(mode) {
  if (mode === 'approval') return '승인 / PC 확인';
  if (mode === 'emergency') return '연결 / 숨김';
  return '말하기 / 캡처 / 녹음';
}

function approvalActionLine(approvalState) {
  if (approvalState.actions.approve.enabled) return '말해요: 승인';
  if (approvalState.actions.pcHandoff.enabled) return 'PC 확인 필요 · 말해요: PC 확인';
  if (approvalState.actions.reject.enabled) return '말해요: 거절';
  return `차단 ${blockedReasonKo(approvalState.actions.approve.blockedReason)}`;
}

function toneLabelKo(tone) {
  const table = {
    normal: '정상',
    caution: '주의',
    expired: '만료',
    'pc-confirmation-required': 'PC확인'
  };
  return table[tone] ?? String(tone ?? '정상');
}

function taskStatusLabelKo(status) {
  if (!status) return null;
  const table = {
    CREATED: '생성',
    PLANNING: '계획',
    WAITING_APPROVAL: '승인 대기',
    APPROVED: '승인됨',
    EXECUTING: '실행 중',
    VERIFYING: '검증 중',
    RETRYING: '재시도',
    COMPENSATING: '보정 중',
    COMPENSATED: '보정됨',
    COMPLETED: '완료',
    FAILED: '실패',
    EXPIRED: '만료',
    BLOCKED: '차단',
    CANCELLED: '취소'
  };
  return table[status] ?? String(status);
}

function intentLabelKo(intentName) {
  const table = {
    approve: '승인',
    reject: '거절',
    show_status: '상태',
    show_approvals: '승인 대기',
    quiet_mode: '조용히',
    repeat_frame: '반복',
    dictate_note: '메모',
    execute_command: '명령',
    unknown: '알 수 없음'
  };
  return table[intentName] ?? String(intentName ?? '음성');
}

function blockedReasonKo(reason) {
  const table = {
    'approval-expired': '승인 만료',
    'session-locked': '세션 잠김',
    'pc-confirmation-required': 'PC 확인 필요',
    'mobile-approval-disabled': '모바일 승인 차단'
  };
  return table[reason] ?? String(reason ?? '차단');
}

function ttlForMode(mode) {
  if (mode === 'approval') return defaultWearableHudLimits.approvalVisibleMs;
  if (mode === 'emergency') return defaultWearableHudLimits.emergencyVisibleMs;
  if (mode === 'focus') return defaultWearableHudLimits.focusVisibleMs;
  return defaultWearableHudLimits.glanceVisibleMs;
}

function frameVoiceActions({ mode, approval }) {
  const base = [
    { phrase: 'status', intentName: 'show_status', destructive: false },
    { phrase: 'quiet', intentName: 'quiet_mode', destructive: false }
  ];
  if (mode !== 'approval' || !approval) return base;
  const approvalState = approval.stateVersion === 'c-d-wearable-approval-state-v1'
    ? approval
    : createWearableApprovalState({ card: approval.card ?? approval, safety: approval.safety, session: approval.session });
  return [
    ...base,
    { phrase: 'approve', intentName: 'approve', enabled: approvalState.actions.approve.enabled, destructive: false },
    { phrase: 'reject', intentName: 'reject', enabled: approvalState.actions.reject.enabled, destructive: false },
    { phrase: 'pc confirm', intentName: 'request_pc_confirmation', enabled: approvalState.actions.pcHandoff.enabled, destructive: false }
  ];
}

export function createWearableBridgeSyncPlan({
  bridgeUrl = 'http://127.0.0.1:17777',
  eventCursor = null,
  taskId = null,
  reconnectAttempt = 0
} = {}) {
  return {
    planVersion: 'c-d-wearable-bridge-sync-plan-v1',
    bridgeUrl,
    transport: {
      preferred: 'sse',
      fallback: 'polling',
      reconnectBackoffMs: Math.min(30000, 1000 * (2 ** reconnectAttempt))
    },
    endpoints: [
      { id: 'health', method: 'GET', path: '/health', auth: false },
      { id: 'approvals', method: 'GET', path: '/approvals', auth: true },
      { id: 'events', method: 'GET', path: eventCursor ? `/events?sinceEventId=${encodeURIComponent(eventCursor)}` : '/events', auth: true },
      { id: 'task-status', method: 'GET', path: taskId ? `/tasks/${encodeURIComponent(taskId)}` : '/tasks', auth: true }
    ],
    privacy: {
      rawBridgeTokenStored: false,
      queryContainsSecret: false
    }
  };
}

export function createWearableHudProductGate({
  frame,
  voiceIntent,
  approvalState,
  bridgeSyncPlan,
  html = ''
} = {}) {
  const checks = [
    {
      checkId: 'mono_green_frame_contract',
      passed: frame?.frameVersion === wearableHudFrameVersion
        && frame.display?.palette === 'monochrome-green'
        && frame.lines?.length <= frame.limits?.maxLines
        && frame.lines?.every((line) => line.text.length <= frame.limits.maxCharsPerLine)
    },
    {
      checkId: 'voice_intent_privacy_contract',
      passed: voiceIntent?.intentVersion === wearableHudVoiceIntentVersion
        && voiceIntent.privacy?.rawTranscriptStored === false
        && Boolean(voiceIntent.transcriptHash)
    },
    {
      checkId: 'high_risk_approval_not_directly_enabled',
      passed: !approvalState
        || approvalState.riskTier > 3
        || approvalState.actions?.approve?.enabled === false
    },
    {
      checkId: 'bridge_sync_contract_ready',
      passed: bridgeSyncPlan?.planVersion === 'c-d-wearable-bridge-sync-plan-v1'
        && bridgeSyncPlan.endpoints?.some((item) => item.path === '/approvals')
        && bridgeSyncPlan.privacy?.rawBridgeTokenStored === false
    },
    {
      checkId: 'green_hud_html_contract',
      passed: typeof html === 'string'
        && html.includes('jarvis-wearable-hud-root')
        && html.includes('#00ff66')
        && !html.includes('Bearer ')
    },
    {
      checkId: 'operator_first_action_contract',
      passed: frame?.layoutContract?.operatorFirst === true
        && frame?.layoutContract?.hidesImplementationModules === true
        && Array.isArray(frame?.actions)
        && frame.actions.length >= 3
        && frame.actions.every((item) => item.label && item.phrase)
        && Array.isArray(frame?.context)
        && frame.context.length >= 2
    }
  ];
  const releaseDossier = createWearableHudReleaseDossier({ frame, voiceIntent, approvalState, bridgeSyncPlan, checks });
  return {
    productGateVersion: 'c-d-wearable-hud-product-gate-v1',
    status: checks.every((item) => item.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier.dossierVersion,
      status: releaseDossier.status,
      dossierSha256: releaseDossier.dossierSha256
    }
  };
}

export function createWearableHudReleaseDossier({
  frame,
  voiceIntent,
  approvalState,
  bridgeSyncPlan,
  checks = []
} = {}) {
  const artifactManifest = {
    manifestVersion: 'c-d-wearable-hud-release-artifact-manifest-v1',
    frameVersion: frame?.frameVersion ?? null,
    voiceIntentVersion: voiceIntent?.intentVersion ?? null,
    bridgeSyncPlanVersion: bridgeSyncPlan?.planVersion ?? null,
    rawTranscriptStored: false,
    rawBridgeTokenStored: false,
    rawApprovalPayloadStored: false,
    rawSecretMaterialStored: false,
    redactionCount: (frame?.privacy?.redactionCount ?? 0) + (voiceIntent?.privacy?.redactionCount ?? 0)
  };
  const dossier = {
    dossierVersion: 'c-d-wearable-hud-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((item) => item.passed) ? 'passed' : 'blocked',
    display: {
      palette: frame?.display?.palette ?? null,
      lineCount: frame?.lines?.length ?? 0,
      maxCharsPerLine: frame?.limits?.maxCharsPerLine ?? null
    },
    voice: {
      intentName: voiceIntent?.intentName ?? null,
      transcriptHash: voiceIntent?.transcriptHash ?? null,
      rawTranscriptStored: false
    },
    approvalSafety: {
      riskTier: approvalState?.riskTier ?? null,
      directApproveEnabled: approvalState?.actions?.approve?.enabled ?? null,
      pcHandoffEnabled: approvalState?.actions?.pcHandoff?.enabled ?? null
    },
    bridgeSync: {
      endpointCount: bridgeSyncPlan?.endpoints?.length ?? 0,
      rawBridgeTokenStored: false
    },
    artifactManifest,
    checks: checks.map((item) => ({
      checkId: item.checkId,
      passed: item.passed
    }))
  };
  dossier.dossierSha256 = sha256(stableJson(dossier));
  return dossier;
}

export function redactHudText(value) {
  let text = String(value ?? '');
  const redactions = [];
  const apply = (type, pattern, replacement) => {
    text = text.replace(pattern, (match) => {
      redactions.push({ type, hash: sha256(match) });
      return replacement;
    });
  };
  apply('email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
  apply('url', /\bhttps?:\/\/[^\s]+/gi, '[URL]');
  apply('windows-path', /\b[A-Z]:[\\/][^\s]+/gi, '[PATH]');
  apply('token', /\b(?:bearer|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, '[SECRET]');
  apply('long-secret', /\b[A-Fa-f0-9]{32,}\b/g, '[HASH]');
  apply('phone', /\b(?:\+?\d[\d -]{8,}\d)\b/g, '[PHONE]');
  return { text, redactions };
}

export function compactText(value, maxChars = defaultWearableHudLimits.maxCharsPerLine) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
