export const wearableHudBrowserClientVersion = 'c-d-wearable-hud-browser-client-v1';
export const wearableHudFieldFrameVersion = 'c-d-wearable-field-frame-v1';

export const defaultWearableHudBrowserConfig = {
  bridgeUrl: 'http://127.0.0.1:17777',
  pollIntervalMs: 2500,
  requestTimeoutMs: 6000,
  maxLines: 5,
  maxCharsPerLine: 30,
  wakeWords: ['자비스', 'jarvis', 'hey jarvis']
};

export const wearableHudQuickCommands = Object.freeze([
  { id: 'record-meeting', label: '회의 녹음', command: '회의 녹음 시작', phrase: '자비스 회의 녹음 시작' },
  { id: 'capture-screen', label: '화면 캡처', command: '현재 화면 캡처', phrase: '자비스 현재 화면 캡처' },
  { id: 'save-voice-note', label: '음성 메모', command: '음성 메모 저장', phrase: '자비스 음성 메모 저장' },
  { id: 'show-approvals', label: '승인 확인', command: '승인 대기 보여줘', phrase: '자비스 승인 대기 보여줘' }
]);

export function createWearableHudBrowserConfig(options = {}) {
  return {
    configVersion: 'c-d-wearable-hud-browser-config-v1',
    ...defaultWearableHudBrowserConfig,
    ...options,
    bridgeUrl: String(options.bridgeUrl ?? defaultWearableHudBrowserConfig.bridgeUrl).replace(/\/$/, ''),
    privacy: {
      tokenStorage: 'memory-only',
      rawTranscriptStored: false,
      rawBridgeTokenStored: false,
      redactedPreviewOnly: true
    }
  };
}

export function createWearableHudBrowserState(options = {}) {
  const config = createWearableHudBrowserConfig(options);
  return {
    stateVersion: 'c-d-wearable-hud-browser-state-v1',
    config,
    connected: false,
    lastSyncAt: null,
    currentApproval: null,
    lastVoiceIntent: null,
    lastActionPlan: null,
    rawTranscriptStored: false,
    rawBridgeTokenStored: false
  };
}

export async function createWearableHudBrowserSnapshot({
  config = createWearableHudBrowserConfig(),
  fetchImpl = globalThis.fetch,
  tokenProvider = () => null,
  now = new Date()
} = {}) {
  const request = createBrowserBridgeRequester({ config, fetchImpl, tokenProvider });
  const [health, approvals, events, tasks] = await Promise.all([
    request('/health', { auth: false }),
    request('/approvals'),
    request('/events?eventType=task.status.changed'),
    request('/tasks')
  ]);
  const approvalItems = normalizeItems(approvals);
  const taskItems = normalizeItems(tasks);
  const approvalCard = approvalItems
    .slice()
    .sort(compareWearableApprovalPriority)[0] ?? null;
  const approvalState = approvalCard ? createWearableBrowserApprovalState({ card: approvalCard }) : null;
  const activeTask = taskItems.find((item) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(item.status)) ?? taskItems[0] ?? null;
  const connected = health.success !== false;
  const frame = createWearableBrowserFrame({
    mode: approvalState ? 'approval' : activeTask ? 'focus' : 'glance',
    connection: {
      connected,
      bridgeUrl: config.bridgeUrl,
      healthStatus: health.status ?? health.module ?? (connected ? 'ok' : 'offline')
    },
    approvalState,
    task: activeTask,
    notifications: {
      pendingApprovals: approvalItems.length,
      activeTasks: taskItems.length,
      eventCount: normalizeItems(events).length
    },
    now,
    limits: config
  });
  return {
    snapshotVersion: 'c-d-wearable-hud-browser-snapshot-v1',
    status: connected ? 'synced' : 'degraded',
    syncedAt: iso(now),
    frame,
    currentApproval: approvalState,
    counts: {
      pendingApprovals: approvalItems.length,
      activeTasks: taskItems.length,
      eventCount: normalizeItems(events).length
    },
    failures: [health, approvals, events, tasks]
      .filter((item) => item?.success === false)
      .map((item) => ({
        path: item.path,
        code: item.error?.code ?? 'WEARABLE_BRIDGE_REQUEST_FAILED',
        message: compactBrowserHudText(item.error?.message ?? 'Bridge request failed.', 64)
      })),
    privacy: {
      rawTranscriptStored: false,
      rawBridgeTokenStored: false
    }
  };
}

export function createBrowserBridgeRequester({
  config = createWearableHudBrowserConfig(),
  fetchImpl = globalThis.fetch,
  tokenProvider = () => null
} = {}) {
  return async function request(path, { method = 'GET', body = null, auth = true } = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), config.requestTimeoutMs) : null;
    const token = auth && typeof tokenProvider === 'function' ? tokenProvider() : null;
    try {
      if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
      const response = await fetchImpl(`${config.bridgeUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: ['Bearer', token].join(' ') } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        ...(controller ? { signal: controller.signal } : {})
      });
      if (timeout) clearTimeout(timeout);
      const text = typeof response.text === 'function' ? await response.text() : '';
      const payload = text ? JSON.parse(text) : {};
      if (response.ok === false || Number(response.status ?? 200) >= 400) {
        return createBrowserBridgeFailure(path, payload?.error?.message ?? `HTTP ${response.status}`, payload?.error?.code ?? `D_HTTP_${response.status}`);
      }
      return payload && typeof payload === 'object' ? payload : {};
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      return createBrowserBridgeFailure(path, error?.message ?? 'Bridge request failed.');
    }
  };
}

export function createWearableBrowserVoiceIntent({
  transcript = '',
  wakeWords = defaultWearableHudBrowserConfig.wakeWords,
  now = new Date()
} = {}) {
  const rawText = String(transcript ?? '').trim();
  const normalized = rawText.toLowerCase().replace(/\s+/g, ' ');
  const activationDetected = wakeWords.some((word) => normalized.includes(String(word).toLowerCase()));
  const commandText = wakeWords.reduce(
    (value, word) => value.replace(new RegExp(escapeRegExp(String(word)), 'ig'), ''),
    rawText
  ).trim();
  const redacted = redactBrowserHudText(commandText || rawText);
  const intentName = inferBrowserVoiceIntent(commandText.toLowerCase());
  return {
    intentVersion: 'c-d-wearable-browser-voice-intent-v1',
    capturedAt: iso(now),
    activationDetected,
    intentName,
    redactedCommandText: compactBrowserHudText(redacted.text, 180),
    redactedPreview: compactBrowserHudText(redacted.text, 48),
    privacy: {
      rawTranscriptStored: false,
      redactionCount: redacted.redactions.length,
      redactionTypes: redacted.redactions.map((item) => item.type)
    },
    safety: {
      noAutoExecute: true,
      noAutoApproveHighRisk: true,
      requiresFreshPrompt: ['approve', 'reject', 'execute_command'].includes(intentName)
    }
  };
}

export function createWearableVoiceActionPlan({
  intent,
  approvalState = null,
  rawTranscript = ''
} = {}) {
  if (!intent || intent.activationDetected !== true) {
    return {
      planVersion: 'c-d-wearable-voice-action-plan-v1',
      action: 'ignore',
      reason: 'wake-word-not-detected',
      rawTranscriptStored: false
    };
  }
  if (intent.intentName === 'show_status' || intent.intentName === 'show_approvals' || intent.intentName === 'repeat_frame') {
    return {
      planVersion: 'c-d-wearable-voice-action-plan-v1',
      action: 'sync',
      reason: intent.intentName,
      rawTranscriptStored: false
    };
  }
  if (intent.intentName === 'quiet_mode') {
    return {
      planVersion: 'c-d-wearable-voice-action-plan-v1',
      action: 'quiet',
      reason: 'voice-requested-quiet-mode',
      rawTranscriptStored: false
    };
  }
  if ((intent.intentName === 'approve' || intent.intentName === 'reject') && approvalState?.approvalId) {
    if (intent.intentName === 'approve' && approvalState.actions.approve.enabled !== true) {
      if (approvalState.actions.pcHandoff.enabled === true) {
        return {
          planVersion: 'c-d-wearable-voice-action-plan-v1',
          action: 'request_pc_confirmation',
          method: 'POST',
          path: `/approvals/${encodeURIComponent(approvalState.approvalId)}/pc-handoff`,
          body: { reason: 'wearable_high_risk_pc_confirmation' },
          reason: approvalState.actions.approve.blockedReason,
          rawTranscriptStored: false
        };
      }
      return {
        planVersion: 'c-d-wearable-voice-action-plan-v1',
        action: 'blocked',
        reason: approvalState.actions.approve.blockedReason,
        rawTranscriptStored: false
      };
    }
    return {
      planVersion: 'c-d-wearable-voice-action-plan-v1',
      action: 'approval_decision',
      method: 'POST',
      path: `/approvals/${encodeURIComponent(approvalState.approvalId)}/decision`,
      body: { decision: intent.intentName === 'approve' ? 'approve' : 'reject' },
      reason: 'wearable_explicit_approval_voice_decision',
      rawTranscriptStored: false
    };
  }
  if (intent.intentName === 'execute_command' || intent.intentName === 'dictate_note') {
    const redacted = redactBrowserHudText(rawTranscript);
    return {
      planVersion: 'c-d-wearable-voice-action-plan-v1',
      action: 'stage_task',
      method: 'POST',
      path: '/tasks',
      body: createWearableTaskStageBody({
        commandText: intent.redactedCommandText || redacted.text
      }),
      bodyPreview: compactBrowserHudText(intent.redactedCommandText || redacted.text, 48),
      requiresManualConfirm: true,
      rawTranscriptStored: false
    };
  }
  return {
    planVersion: 'c-d-wearable-voice-action-plan-v1',
    action: 'ignore',
    reason: 'unsupported-intent',
    rawTranscriptStored: false
  };
}

export function createWearableQuickCommandPlan({
  command,
  now = new Date()
} = {}) {
  const redacted = redactBrowserHudText(command);
  return {
    planVersion: 'c-d-wearable-quick-command-plan-v1',
    createdAt: iso(now),
    action: 'stage_task',
    method: 'POST',
    path: '/tasks',
    body: createWearableTaskStageBody({ commandText: redacted.text }),
    bodyPreview: compactBrowserHudText(redacted.text, 48),
    requiresManualConfirm: true,
    rawTranscriptStored: false,
    privacy: {
      rawCommandStored: false,
      redactionCount: redacted.redactions.length,
      redactionTypes: redacted.redactions.map((item) => item.type)
    }
  };
}

export function createWearablePairingConfirmBody({
  pairing,
  deviceId = 'wearable_hud_browser',
  deviceName = 'JARVIS Wearable HUD'
} = {}) {
  return {
    deviceId: sanitizeWearableDeviceId(deviceId),
    deviceName: compactBrowserHudText(deviceName, 120),
    pairingCode: String(pairing?.pairingCode ?? '').trim(),
    ...(pairing?.pairingId ? { pairingId: String(pairing.pairingId) } : {})
  };
}

export async function pairWearableHudBrowser({
  request,
  deviceId = 'wearable_hud_browser',
  deviceName = 'JARVIS Wearable HUD'
} = {}) {
  if (typeof request !== 'function') {
    return {
      pairingVersion: 'c-d-wearable-browser-pairing-v1',
      success: false,
      stage: 'request-unavailable',
      rawBridgeTokenStored: false
    };
  }
  const started = await request('/pairing/start', {
    method: 'POST',
    body: {},
    auth: false
  });
  if (started?.success === false || !started?.pairingCode) {
    return {
      pairingVersion: 'c-d-wearable-browser-pairing-v1',
      success: false,
      stage: 'start',
      error: started?.error ?? null,
      rawBridgeTokenStored: false
    };
  }
  const confirmBody = createWearablePairingConfirmBody({
    pairing: started,
    deviceId,
    deviceName
  });
  const confirmed = await request('/pairing/confirm', {
    method: 'POST',
    body: confirmBody,
    auth: false
  });
  if (confirmed?.success === false || !confirmed?.deviceToken) {
    return {
      pairingVersion: 'c-d-wearable-browser-pairing-v1',
      success: false,
      stage: 'confirm',
      pairingId: started.pairingId ?? null,
      error: confirmed?.error ?? null,
      rawBridgeTokenStored: false
    };
  }
  return {
    pairingVersion: 'c-d-wearable-browser-pairing-v1',
    success: true,
    stage: 'confirmed',
    deviceId: confirmed.deviceId ?? confirmBody.deviceId,
    expiresAt: confirmed.expiresAt ?? null,
    pairingId: confirmed.pairingId ?? started.pairingId ?? null,
    deviceToken: confirmed.deviceToken,
    rawBridgeTokenStored: false
  };
}

export async function executeWearableVoiceAction({
  plan,
  request,
  rawTranscript = ''
} = {}) {
  if (!plan || !['request_pc_confirmation', 'approval_decision', 'stage_task'].includes(plan.action)) {
    return {
      executionVersion: 'c-d-wearable-voice-action-execution-v1',
      status: 'not-sent',
      reason: plan?.reason ?? plan?.action ?? 'no-action',
      rawTranscriptStored: false
    };
  }
  if (typeof request !== 'function') {
    return {
      executionVersion: 'c-d-wearable-voice-action-execution-v1',
      status: 'failed',
      reason: 'request-unavailable',
      action: plan.action,
      path: plan.path,
      rawTranscriptStored: false,
      transcriptRedactionCount: redactBrowserHudText(rawTranscript).redactions.length
    };
  }
  const result = await request(plan.path, {
    method: plan.method,
    body: plan.body,
    auth: true
  });
  return {
    executionVersion: 'c-d-wearable-voice-action-execution-v1',
    status: result?.success === false ? 'failed' : 'sent',
    action: plan.action,
    path: plan.path,
    taskId: result?.taskId ?? null,
    resultStatus: result?.status ?? result?.success ?? null,
    errorCode: result?.success === false ? result.error?.code ?? 'WEARABLE_ACTION_FAILED' : null,
    errorMessage: result?.success === false ? compactBrowserHudText(result.error?.message ?? 'Wearable action failed.', 80) : null,
    rawTranscriptStored: false,
    transcriptRedactionCount: redactBrowserHudText(rawTranscript).redactions.length
  };
}

export function createWearableHudActionPlan({
  actionId = '',
  approvalState = null,
  command = '',
  now = new Date()
} = {}) {
  if (actionId === 'quiet') {
    return {
      planVersion: 'c-d-wearable-hud-action-plan-v1',
      action: 'quiet',
      reason: 'operator-action-quiet',
      rawTranscriptStored: false
    };
  }
  if (actionId === 'status' || actionId === 'repeat') {
    return {
      planVersion: 'c-d-wearable-hud-action-plan-v1',
      action: 'sync',
      reason: `operator-action-${actionId}`,
      rawTranscriptStored: false
    };
  }
  if ((actionId === 'pc-confirm' || actionId === 'approve' || actionId === 'reject') && approvalState?.approvalId) {
    const transcript = actionId === 'reject' ? '자비스 거절' : '자비스 승인';
    const intent = createWearableBrowserVoiceIntent({ transcript, now });
    return createWearableVoiceActionPlan({
      intent,
      approvalState,
      rawTranscript: transcript
    });
  }
  if (command) {
    return createWearableQuickCommandPlan({ command, now });
  }
  return {
    planVersion: 'c-d-wearable-hud-action-plan-v1',
    action: 'ignore',
    reason: 'operator-action-unsupported',
    rawTranscriptStored: false
  };
}

export function createWearableBrowserApprovalState({ card = {}, safety = {}, session = {} } = {}) {
  const riskTier = Number(card.riskTier ?? safety.riskTier ?? 0);
  const expired = card.expired === true || safety.expired === true || card.status === 'expired';
  const requiresPcConfirmation = safety.requiresPcConfirmation === true
    || card.requiresPcConfirmation === true
    || card.mobileApprovalAllowed === false
    || riskTier <= 3;
  const sessionUnlocked = session.locked !== true;
  const approveEnabled = !expired && sessionUnlocked && !requiresPcConfirmation;
  return {
    stateVersion: 'c-d-wearable-browser-approval-state-v1',
    approvalId: card.approvalId ?? card.id ?? null,
    taskId: card.taskId ?? null,
    riskTier,
    tone: expired ? 'expired' : requiresPcConfirmation ? 'pc-confirmation-required' : riskTier === 4 ? 'caution' : 'normal',
    summary: compactBrowserHudText(redactBrowserHudText(card.summary ?? card.title ?? 'Approval pending').text, 42),
    actions: {
      approve: {
        enabled: approveEnabled,
        blockedReason: approveEnabled
          ? null
          : expired
            ? 'approval-expired'
            : !sessionUnlocked
              ? 'session-locked'
              : requiresPcConfirmation
                ? 'pc-confirmation-required'
                : 'wearable-approval-disabled'
      },
      reject: {
        enabled: !expired && sessionUnlocked,
        blockedReason: expired ? 'approval-expired' : !sessionUnlocked ? 'session-locked' : null
      },
      pcHandoff: {
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

export function createWearableBrowserFrame({
  mode = 'glance',
  connection = {},
  approvalState = null,
  task = null,
  notifications = {},
  voiceIntent = null,
  limits = defaultWearableHudBrowserConfig,
  now = new Date()
} = {}) {
  const lines = [];
  const maxLines = Number(limits.maxLines ?? defaultWearableHudBrowserConfig.maxLines);
  const maxCharsPerLine = Number(limits.maxCharsPerLine ?? defaultWearableHudBrowserConfig.maxCharsPerLine);
  const redactions = [];
  const pushLine = (slot, text, priority = 1) => {
    if (lines.length >= maxLines) return;
    const redacted = redactBrowserHudText(text);
    redactions.push(...redacted.redactions);
    lines.push({
      slot,
      priority,
      text: compactBrowserHudText(redacted.text, maxCharsPerLine)
    });
  };
  const actionDeck = actionDeckForBrowserFrame({ mode, connection, approvalState, task, voiceIntent });
  const contextDeck = contextDeckForBrowserFrame({ mode, connection, approvalState, task, notifications, voiceIntent });
  pushLine('header', headerForBrowserFrame(mode, connection), 100);
  if (approvalState) {
    pushLine('approval-summary', approvalState.summary, 80);
    pushLine('approval-action', approvalState.actions.approve.enabled ? '말해요: 승인' : approvalState.actions.pcHandoff.enabled ? 'PC 확인 필요 · 말해요: PC 확인' : '말해요: 거절', 90);
    pushLine('approval-risk', `위험 T${approvalState.riskTier} ${toneLabelKo(approvalState.tone)}`, 70);
  } else if (task) {
    pushLine('task-title', task.title ?? task.command ?? task.taskId ?? '작업 진행 중', 70);
    pushLine('task-status', `${taskStatusLabelKo(task.status)} ${task.progressLabel ?? ''}`, 80);
    pushLine('task-action', '말해요: 상태 또는 조용히', 60);
  } else {
    pushLine('system', connection.connected ? '말하면 바로 작업 생성' : '페어링 후 바로 사용', 80);
    pushLine('queue', `말해요: 녹음 / 캡처 / 메모`, 70);
  }
  if (voiceIntent) pushLine('voice', `음성 ${intentLabelKo(voiceIntent.intentName)}`, 50);
  pushLine('footer', actionDeck[0]?.phrase ?? '자비스 상태', 10);
  const progress = progressForBrowserFrame({ mode, connection, approvalState, task });
  const primary = primaryForBrowserFrame({ mode, connection, approvalState, task });
  const metrics = metricsForBrowserFrame({ approvalState, notifications, task, voiceIntent });
  return {
    frameVersion: wearableHudFieldFrameVersion,
    generatedAt: iso(now),
    mode,
    primary,
    progress,
    metrics,
    actions: actionDeck,
    context: contextDeck,
    display: {
      palette: 'monochrome-green',
      foreground: '#00ff66',
      background: '#000400'
    },
    limits: {
      maxLines,
      maxCharsPerLine
    },
    lines,
    privacy: {
      rawTranscriptStored: false,
      rawBridgeTokenStored: false,
      redactionCount: redactions.length
    },
    layoutContract: {
      operatorFirst: true,
      hidesImplementationModules: true,
      quickActionsVisible: actionDeck.length >= 3,
      contextRowsVisible: contextDeck.length >= 2
    }
  };
}

export function renderBrowserHudFrame(frame, root) {
  if (!root) return;
  root.dataset.frameVersion = frame.frameVersion;
  root.dataset.mode = frame.mode;
  root.style.setProperty('--hud-progress-deg', `${Number(frame.progress?.value ?? 0) * 3.6}deg`);

  setText(root, '[data-primary-title]', frame.primary?.title ?? 'JARVIS');
  setText(root, '[data-primary-subtitle]', frame.primary?.subtitle ?? frame.mode.toUpperCase());
  setText(root, '[data-progress-value]', `${frame.progress?.value ?? 0}%`);
  setText(root, '[data-progress-label]', frame.progress?.label ?? '동기화');
  setText(root, '[data-progress-eta]', frame.progress?.eta ?? '대기');
  setText(root, '[data-hud-mode]', modeLabelKo(frame.mode));
  setText(root, '[data-hud-clock]', formatHudClock(frame.generatedAt));

  const metricRail = root.querySelector('[data-metric-rail]');
  if (metricRail) {
    metricRail.replaceChildren(...(frame.metrics ?? []).slice(0, 4).map((metric) => createMetricNode(root, metric)));
  }

  const lineHost = root.querySelector('[data-hud-lines]') ?? root;
  lineHost.replaceChildren(...frame.lines.slice(0, 5).map((line) => {
    const node = root.ownerDocument.createElement('div');
    node.className = `hud-line hud-${line.slot}`;
    node.dataset.slot = line.slot;
    node.textContent = line.text;
    return node;
  }));

  const leftPanel = root.querySelector('[data-left-panel]');
  if (leftPanel) {
    leftPanel.replaceChildren(...createActionRows(root, frame.actions ?? []));
  }

  const rightPanel = root.querySelector('[data-right-panel]');
  if (rightPanel) {
    rightPanel.replaceChildren(...createContextRows(root, frame.context ?? []));
  }

  const quickHost = root.querySelector('[data-action-deck]');
  if (quickHost) {
    quickHost.replaceChildren(...createQuickCommandRows(root, frame));
  }
}

export function installWearableHudBrowserApp({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  rootId = 'jarvis-wearable-hud-root',
  initialConfig = {}
} = {}) {
  if (!windowRef || !documentRef) return null;
  const root = documentRef.getElementById(rootId);
  if (!root) return null;
  let config = createWearableHudBrowserConfig({
    bridgeUrl: root.dataset.bridgeUrl || initialConfig.bridgeUrl,
    ...initialConfig
  });
  let memoryOnlyToken = '';
  let timer = null;
  let state = createWearableHudBrowserState(config);
  let currentFrame = createWearableBrowserFrame({ connection: { connected: false }, limits: config });
  root.innerHTML = browserHudMarkup(config);
  const bridgeInput = root.querySelector('[data-bridge-url]');
  const tokenInput = root.querySelector('[data-token]');
  const connectButton = root.querySelector('[data-connect]');
  const pairButton = root.querySelector('[data-pair]');
  const micButton = root.querySelector('[data-mic]');
  const quietButton = root.querySelector('[data-quiet]');
  const statusNode = root.querySelector('[data-hud-status]');
  const memoryDeviceId = createWearableDeviceId(windowRef);
  const request = (path, options) => createBrowserBridgeRequester({
    config,
    fetchImpl: windowRef.fetch?.bind(windowRef),
    tokenProvider: () => memoryOnlyToken
  })(path, options);
  const sync = async () => {
    config = createWearableHudBrowserConfig({
      ...config,
      bridgeUrl: bridgeInput?.value || config.bridgeUrl
    });
    const snapshot = await createWearableHudBrowserSnapshot({
      config,
      fetchImpl: windowRef.fetch?.bind(windowRef),
      tokenProvider: () => memoryOnlyToken
    });
    state = {
      ...state,
      connected: snapshot.status === 'synced',
      lastSyncAt: snapshot.syncedAt,
      currentApproval: snapshot.currentApproval
    };
    currentFrame = snapshot.frame;
    renderBrowserHudFrame(currentFrame, root);
    if (statusNode) statusNode.textContent = syncStatusLabelKo(snapshot.status);
    return snapshot;
  };
  const start = () => {
    stop();
    sync();
    timer = windowRef.setInterval(sync, config.pollIntervalMs);
  };
  const stop = () => {
    if (timer) windowRef.clearInterval(timer);
    timer = null;
  };
  const handleTranscript = async (transcript) => {
    const intent = createWearableBrowserVoiceIntent({ transcript });
    const plan = createWearableVoiceActionPlan({
      intent,
      approvalState: state.currentApproval,
      rawTranscript: transcript
    });
    state = {
      ...state,
      lastVoiceIntent: intent,
      lastActionPlan: plan
    };
    currentFrame = createWearableBrowserFrame({
      mode: currentFrame.mode,
      connection: { connected: state.connected },
      approvalState: state.currentApproval,
      voiceIntent: intent,
      limits: config
    });
    renderBrowserHudFrame(currentFrame, root);
    if (plan.action === 'quiet') root.dataset.controls = 'hidden';
    if (plan.action === 'sync') await sync();
    if (['approval_decision', 'request_pc_confirmation', 'stage_task'].includes(plan.action)) {
      const execution = await executeWearableVoiceAction({ plan, request, rawTranscript: transcript });
      if (statusNode) statusNode.textContent = execution.status === 'sent' ? '전송됨' : '전송 실패';
      await sync();
    }
    return { intent, plan };
  };
  const handleQuickCommand = async (command) => {
    const plan = createWearableQuickCommandPlan({ command });
    state = {
      ...state,
      lastActionPlan: plan
    };
    currentFrame = createWearableBrowserFrame({
      mode: 'focus',
      connection: { connected: state.connected },
      task: { title: plan.bodyPreview, status: 'CREATED' },
      limits: config
    });
    renderBrowserHudFrame(currentFrame, root);
    if (statusNode) statusNode.textContent = '전송 중';
    const execution = await executeWearableVoiceAction({ plan, request, rawTranscript: command });
    if (statusNode) statusNode.textContent = execution.status === 'sent' ? '전송됨' : '전송 실패';
    await sync();
    return { plan, execution };
  };
  const handleHudAction = async (trigger) => {
    const plan = createWearableHudActionPlan({
      actionId: trigger.dataset.hudAction,
      approvalState: state.currentApproval,
      command: trigger.dataset.actionCommand
    });
    if (plan.action === 'quiet') {
      root.dataset.controls = 'hidden';
      return { plan };
    }
    if (plan.action === 'sync') {
      return sync();
    }
    if (['approval_decision', 'request_pc_confirmation', 'stage_task'].includes(plan.action)) {
      const execution = await executeWearableVoiceAction({ plan, request, rawTranscript: trigger.dataset.actionCommand ?? '' });
      if (statusNode) statusNode.textContent = execution.status === 'sent' ? '전송됨' : '전송 실패';
      await sync();
      return { plan, execution };
    }
    return { plan };
  };
  const pair = async () => {
    config = createWearableHudBrowserConfig({
      ...config,
      bridgeUrl: bridgeInput?.value || config.bridgeUrl
    });
    if (statusNode) statusNode.textContent = '페어링 중';
    const result = await pairWearableHudBrowser({
      request,
      deviceId: memoryDeviceId,
      deviceName: 'JARVIS Wearable HUD'
    });
    if (result.success === true) {
      memoryOnlyToken = result.deviceToken;
      if (tokenInput) {
        tokenInput.value = '';
        tokenInput.placeholder = '페어링 완료';
      }
      if (statusNode) statusNode.textContent = '페어링 완료';
      await sync();
    } else if (statusNode) {
      statusNode.textContent = result.stage === 'start' ? '코드 실패' : '페어링 실패';
    }
    return {
      ...result,
      deviceToken: result.deviceToken ? '[MEMORY_ONLY]' : null,
      rawBridgeTokenStored: false
    };
  };
  connectButton?.addEventListener('click', start);
  pairButton?.addEventListener('click', () => {
    pair().catch(() => {
      if (statusNode) statusNode.textContent = '페어링 실패';
    });
  });
  root.addEventListener('click', (event) => {
    const actionTrigger = event.target?.closest?.('[data-hud-action]');
    if (actionTrigger) {
      handleHudAction(actionTrigger).catch(() => {
        if (statusNode) statusNode.textContent = '실행 실패';
      });
      return;
    }
    const trigger = event.target?.closest?.('[data-quick-command]');
    if (!trigger) return;
    handleQuickCommand(trigger.dataset.quickCommand).catch(() => {
      if (statusNode) statusNode.textContent = '전송 실패';
    });
  });
  quietButton?.addEventListener('click', () => {
    root.dataset.controls = root.dataset.controls === 'hidden' ? 'visible' : 'hidden';
  });
  tokenInput?.addEventListener('input', (event) => {
    memoryOnlyToken = event.target.value;
  });
  micButton?.addEventListener('click', () => startSpeechRecognition({ windowRef, onTranscript: handleTranscript, statusNode }));
  renderBrowserHudFrame(currentFrame, root);
  start();
  return {
    clientVersion: wearableHudBrowserClientVersion,
    sync,
    stop,
    start,
    handleTranscript,
    pair,
    setToken(token) {
      memoryOnlyToken = String(token ?? '');
    },
    state() {
      return {
        ...state,
        rawBridgeTokenStored: false,
        tokenLength: memoryOnlyToken.length
      };
    }
  };
}

function browserHudMarkup(config) {
  return `
    <div class="hud-status-bar">
      <div class="hud-brand">
        <strong>JARVIS</strong>
        <span aria-label="웨어러블 관제">웨어러블 실행</span>
      </div>
      <div class="hud-action-deck" data-action-deck aria-label="바로 실행"></div>
      <div class="hud-status-cluster">
        <span data-hud-status>부팅</span>
        <span data-hud-mode>부팅</span>
        <span data-hud-clock>--:--</span>
      </div>
    </div>
    <section class="hud-metric-rail" data-metric-rail></section>
    <section class="hud-cockpit">
      <aside class="hud-panel hud-panel-left">
        <div class="hud-panel-kicker">01  말할 수 있는 것</div>
        <div data-left-panel></div>
      </aside>
      <section class="hud-focus">
        <div class="hud-orbit" data-progress-ring>
          <div class="hud-orbit-core">
            <span data-progress-label>동기화</span>
            <strong data-progress-value>0%</strong>
            <small data-progress-eta>대기</small>
          </div>
        </div>
        <div class="hud-primary">
          <span>지금</span>
          <strong data-primary-title>JARVIS</strong>
          <small data-primary-subtitle>초기화 중</small>
        </div>
        <div class="hud-lines" data-hud-lines></div>
      </section>
      <aside class="hud-panel hud-panel-right">
        <div class="hud-panel-kicker">02  지금 필요한 판단</div>
        <div data-right-panel></div>
      </aside>
    </section>
    <form class="hud-control-dock" onsubmit="return false">
      <input data-bridge-url aria-label="브릿지 주소" value="${escapeHtml(config.bridgeUrl)}" />
      <input data-token aria-label="기기 토큰" type="password" autocomplete="off" placeholder="토큰" />
      <button type="button" data-connect>연결</button>
      <button type="button" data-pair>페어링</button>
      <button type="button" data-mic>음성</button>
      <button type="button" data-quiet>숨김</button>
    </form>
  `;
}

function metricsForBrowserFrame({ approvalState, notifications, task, voiceIntent }) {
  return [
    { label: '듣기', value: voiceIntent ? intentLabelKo(voiceIntent.intentName) : '대기', meta: '자비스 호출' },
    { label: '실행', value: taskStatusLabelKo(task?.status) ?? '준비', meta: taskTitleForHud(task) },
    { label: '승인', value: approvalState ? `T${approvalState.riskTier}` : `${notifications.pendingApprovals ?? 0}`, meta: approvalState ? toneLabelKo(approvalState.tone) : '대기 없음' },
    { label: '보안', value: '비식별', meta: voiceIntent?.redactedPreview ?? '원문 미저장' }
  ];
}

function primaryForBrowserFrame({ mode, connection, approvalState, task }) {
  if (approvalState) {
    return {
      title: approvalState.tone === 'pc-confirmation-required' ? '승인 보류' : '승인 검토',
      subtitle: approvalState.summary
    };
  }
  if (task) {
    return {
      title: task.title ?? task.command ?? task.taskId ?? '작업 진행',
      subtitle: taskStatusLabelKo(task.status) ?? '작업'
    };
  }
  return {
    title: '무엇을 도와드릴까요?',
    subtitle: connection.connected ? '말하거나 빠른 명령 선택' : '연결 후 말하거나 빠른 명령 선택'
  };
}

function actionDeckForBrowserFrame({ connection, approvalState, task, voiceIntent }) {
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
  return wearableHudQuickCommands.map((item) => ({
    id: item.id,
    label: item.label,
    phrase: item.phrase,
    command: item.command
  })).map((item, index) => (
    index === 0 && connection.connected === false
      ? { ...item, label: '페어링 후 녹음', phrase: '먼저 페어링' }
      : item
  ));
}

function contextDeckForBrowserFrame({ connection, approvalState, task, notifications, voiceIntent }) {
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

function progressForBrowserFrame({ mode, connection, approvalState, task }) {
  if (approvalState) {
    const value = approvalState.riskTier <= 3 ? 62 : approvalState.riskTier === 4 ? 74 : 88;
    return { value, label: '검토', eta: approvalState.actions.pcHandoff.enabled ? 'PC 확인' : '음성 승인 가능' };
  }
  if (task) {
    const table = {
      COMPLETED: 100,
      VERIFYING: 86,
      EXECUTING: 72,
      APPROVED: 58,
      WAITING_APPROVAL: 44,
      FAILED: 12,
      CANCELLED: 8
    };
    const value = table[task.status] ?? 52;
    return { value, label: taskStatusLabelKo(task.status) ?? '작업', eta: value >= 100 ? '완료' : '진행 중' };
  }
  if (mode === 'emergency') return { value: 38, label: '확인', eta: '연결 버튼' };
  return { value: 100, label: '대기', eta: '말하기' };
}

function createMetricNode(root, metric) {
  const node = root.ownerDocument.createElement('div');
  node.className = 'hud-metric';
  const label = root.ownerDocument.createElement('span');
  label.textContent = metric.label;
  const value = root.ownerDocument.createElement('strong');
  value.textContent = compactBrowserHudText(metric.value, 16);
  const meta = root.ownerDocument.createElement('small');
  meta.textContent = compactBrowserHudText(metric.meta, 18);
  node.append(label, value, meta);
  return node;
}

function createPanelRows(root, rows) {
  return rows.map(([label, value]) => {
    const node = root.ownerDocument.createElement('div');
    node.className = 'hud-panel-row';
    const labelNode = root.ownerDocument.createElement('span');
    labelNode.textContent = label;
    const valueNode = root.ownerDocument.createElement('strong');
    valueNode.textContent = compactBrowserHudText(value, 34);
    node.append(labelNode, valueNode);
    return node;
  });
}

function createActionRows(root, actions) {
  return actions.slice(0, 4).map((item) => {
    const node = root.ownerDocument.createElement('button');
    node.type = 'button';
    node.className = 'hud-panel-row hud-quick-command';
    node.dataset.hudAction = item.id ?? 'command';
    if (item.command) node.dataset.actionCommand = item.command;
    node.setAttribute('aria-label', `${item.label} 실행`);
    const labelNode = root.ownerDocument.createElement('span');
    labelNode.textContent = item.label;
    const valueNode = root.ownerDocument.createElement('strong');
    valueNode.textContent = compactBrowserHudText(item.phrase ?? item.command ?? item.label, 34);
    node.append(labelNode, valueNode);
    return node;
  });
}

function createContextRows(root, rows) {
  return rows.slice(0, 4).map(([label, value]) => {
    const node = root.ownerDocument.createElement('div');
    node.className = 'hud-panel-row';
    const labelNode = root.ownerDocument.createElement('span');
    labelNode.textContent = label;
    const valueNode = root.ownerDocument.createElement('strong');
    valueNode.textContent = compactBrowserHudText(value, 36);
    node.append(labelNode, valueNode);
    return node;
  });
}

function createQuickCommandRows(root, frame) {
  return wearableHudQuickCommands.map((item) => {
    const node = root.ownerDocument.createElement('button');
    node.type = 'button';
    node.className = 'hud-action-chip';
    node.dataset.quickCommand = item.command;
    node.setAttribute('aria-label', `${item.label} 빠른 명령`);
    node.textContent = item.id === 'show-approvals'
      ? compactBrowserHudText(frame.lines.find((line) => line.slot === 'approval-action')?.text ?? item.label, 14)
      : item.label;
    return node;
  });
}

function taskTitleForHud(task) {
  return compactBrowserHudText(task?.title ?? task?.command ?? task?.taskId ?? '작업 없음', 24);
}

function createWearableTaskStageBody({ commandText }) {
  return {
    rawText: compactBrowserHudText(commandText, 2000)
  };
}

function createWearableDeviceId(windowRef) {
  const randomId = windowRef?.crypto?.randomUUID?.()
    ?? `wearable-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return sanitizeWearableDeviceId(`wearable_${randomId}`);
}

function sanitizeWearableDeviceId(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}._:-]+/gu, '_')
    .slice(0, 120);
  return normalized || 'wearable_hud_browser';
}

function setText(root, selector, value) {
  const node = root.querySelector(selector);
  if (node) node.textContent = String(value ?? '');
}

function formatHudClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function startSpeechRecognition({ windowRef, onTranscript, statusNode }) {
  const SpeechRecognition = windowRef.SpeechRecognition ?? windowRef.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    if (statusNode) statusNode.textContent = '음성 없음';
    return null;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'ko-KR';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.onstart = () => {
    if (statusNode) statusNode.textContent = '듣는 중';
  };
  recognition.onerror = () => {
    if (statusNode) statusNode.textContent = '음성 오류';
  };
  recognition.onend = () => {
    if (statusNode) statusNode.textContent = '준비';
  };
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results ?? [])
      .map((result) => result?.[0]?.transcript ?? '')
      .join(' ')
      .trim();
    if (transcript) onTranscript(transcript);
  };
  recognition.start();
  return recognition;
}

function normalizeItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.tasks)) return payload.tasks;
  if (Array.isArray(payload?.approvals)) return payload.approvals;
  if (Array.isArray(payload)) return payload;
  return [];
}

function compareWearableApprovalPriority(left, right) {
  return wearableApprovalPriorityScore(right) - wearableApprovalPriorityScore(left);
}

function wearableApprovalPriorityScore(card = {}) {
  const riskTier = Number(card.riskTier ?? 5);
  const requiresPcConfirmation = card.requiresPcConfirmation === true
    || card.mobileApprovalAllowed === false
    || card.externalTransfer === true
    || riskTier <= 3;
  if (requiresPcConfirmation) return 100 + (6 - Math.max(1, riskTier));
  if (riskTier === 4) return 60;
  return 20;
}

function inferBrowserVoiceIntent(lower) {
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

function headerForBrowserFrame(mode, connection) {
  if (mode === 'approval') return 'JARVIS 승인 확인';
  if (mode === 'emergency') return connection.connected ? 'JARVIS 주의 필요' : 'JARVIS 앱 연결 필요';
  if (mode === 'focus') return 'JARVIS 작업 집중';
  return 'JARVIS 음성 대기';
}

function modeLabelKo(mode) {
  const table = {
    approval: '승인',
    emergency: '경고',
    focus: '집중',
    glance: '요약'
  };
  return table[mode] ?? String(mode ?? '모드');
}

function syncStatusLabelKo(status) {
  const table = {
    synced: '동기화',
    degraded: '저하',
    blocked: '차단',
    passed: '통과'
  };
  return table[status] ?? String(status ?? '상태');
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

export function redactBrowserHudText(value) {
  let text = String(value ?? '');
  const redactions = [];
  const apply = (type, pattern, replacement) => {
    text = text.replace(pattern, (match) => {
      redactions.push({ type, length: match.length });
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

export function compactBrowserHudText(value, maxChars = defaultWearableHudBrowserConfig.maxCharsPerLine) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function createBrowserBridgeFailure(path, message, code = 'WEARABLE_BRIDGE_REQUEST_FAILED') {
  return {
    success: false,
    path,
    error: {
      code,
      message: compactBrowserHudText(message, 96)
    }
  };
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.JarvisWearableHud = {
    installWearableHudBrowserApp,
    createWearableBrowserVoiceIntent,
    createWearableVoiceActionPlan,
    createWearableQuickCommandPlan,
    pairWearableHudBrowser,
    createWearableHudBrowserSnapshot
  };
  document.addEventListener('DOMContentLoaded', () => {
    installWearableHudBrowserApp();
  }, { once: true });
}
