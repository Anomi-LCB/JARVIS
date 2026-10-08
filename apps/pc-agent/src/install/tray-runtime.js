export class PcAgentTrayRuntime {
  constructor({ daemonConfig, serviceManifest, clock = () => new Date() } = {}) {
    this.daemonConfig = daemonConfig;
    this.serviceManifest = serviceManifest;
    this.clock = clock;
  }

  state({ service = {}, health = {}, lastExecution = null, warnings = [], queue = null, poisonQueue = null, serviceRuntime = null, approvalDiffs = [] } = {}) {
    const endpoint = `http://${this.daemonConfig.host}:${this.daemonConfig.port}`;
    const serviceState = service.status ?? 'unknown';
    const healthState = health.status ?? (serviceState === 'running' ? 'unknown' : 'offline');
    const connected = serviceState === 'running' && ['ok', 'healthy'].includes(healthState);
    const queueSummary = queueSummaryFor({ queue, poisonQueue, serviceRuntime });
    const poisonReview = poisonReviewFor({ endpoint, poisonQueue });
    const approvalDiffReview = approvalDiffReviewFor({ endpoint, approvalDiffs });
    const riskLevel = poisonReview.required ? 'warning' : connected ? 'normal' : serviceState === 'stopped' ? 'attention' : 'warning';
    return {
      appId: 'jarvis-pc-agent-tray',
      serviceName: this.serviceManifest.serviceName,
      displayName: this.serviceManifest.displayName,
      endpoint,
      connected,
      riskLevel,
      iconState: connected ? 'active' : serviceState === 'stopped' ? 'paused' : 'attention',
      service: {
        status: serviceState,
        pid: service.pid ?? null,
        startType: service.startType ?? this.serviceManifest.startType,
        account: this.serviceManifest.account
      },
      health: {
        status: healthState,
        localOnly: health.localOnly ?? this.daemonConfig.safety.localOnly,
        version: health.version ?? null,
        checkedAt: this.clock().toISOString()
      },
      safety: {
        localOnly: this.daemonConfig.safety.localOnly === true,
        requiresCapabilityToken: this.daemonConfig.safety.requiresCapabilityToken === true,
        requiresUserConfirmation: this.daemonConfig.safety.requiresUserConfirmation === true,
        denyDestructiveActions: this.daemonConfig.safety.denyDestructiveActions === true
      },
      queue: queueSummary,
      poisonReview,
      approvalDiffReview,
      serviceRuntime: serviceRuntime ? {
        status: serviceRuntime.status,
        running: serviceRuntime.running,
        processedTotal: serviceRuntime.processedTotal,
        consecutiveFailures: serviceRuntime.consecutiveFailures,
        lastDrain: serviceRuntime.lastDrain ?? null,
        watchdog: serviceRuntime.watchdog ?? null
      } : null,
      lastExecution,
      warnings,
      surface: {
        type: 'native_windows_form',
        locale: 'ko-KR',
        opensFromTrayClick: true,
        backgroundScriptsHidden: true,
        liveStatusRefresh: true
      },
      menu: this.menu({ connected, poisonReview, approvalDiffReview }),
      notifications: this.notifications({ connected, warnings, poisonReview, queueSummary, approvalDiffReview })
    };
  }

  menu({ connected, poisonReview, approvalDiffReview }) {
    return [
      { id: 'open-panel', label: 'PC 에이전트 제어 패널 열기', enabled: true, action: 'show_window', target: 'JarvisPcAgentTray.exe --show' },
      { id: 'open-console', label: 'JARVIS 제어 센터 열기', enabled: true, action: 'open_url', target: './dist/index.html' },
      { id: 'open-health', label: 'PC 에이전트 상태 열기', enabled: true, action: 'open_url', target: `http://${this.daemonConfig.host}:${this.daemonConfig.port}/health` },
      { id: 'open-queue', label: '실행 대기열 열기', enabled: connected, action: 'open_url', target: `http://${this.daemonConfig.host}:${this.daemonConfig.port}/execution-packets/queue` },
      { id: 'review-approval-diff', label: `승인 변경 내용 검토 (${approvalDiffReview.count})`, enabled: connected && approvalDiffReview.required, action: 'open_url', target: approvalDiffReview.reviewUrl },
      { id: 'review-poison-queue', label: `격리된 작업 검토 (${poisonReview.count})`, enabled: connected && poisonReview.required, action: 'open_url', target: poisonReview.reviewUrl },
      { id: 'start-service', label: '로컬 에이전트 시작', enabled: !connected, action: 'run_script', target: 'start-service.ps1', requiresElevation: true },
      { id: 'stop-service', label: '로컬 에이전트 중지', enabled: connected, action: 'run_script', target: 'stop-service.ps1', requiresElevation: true },
      { id: 'restart-service', label: '로컬 에이전트 다시 시작', enabled: connected, action: 'run_script', target: 'restart-service.ps1', requiresElevation: true },
      { id: 'update-service', label: '로컬 에이전트 업데이트', enabled: true, action: 'run_script', target: 'update-service.ps1', requiresElevation: true },
      { id: 'collect-logs', label: '진단 기록 수집', enabled: true, action: 'run_script', target: 'collect-logs.ps1' },
      { id: 'verify-package', label: '설치 패키지 검증', enabled: true, action: 'run_script', target: 'verify-package.ps1' },
      { id: 'copy-endpoint', label: '로컬 접속 주소 복사', enabled: true, action: 'copy_text', target: `http://${this.daemonConfig.host}:${this.daemonConfig.port}` }
    ];
  }

  notifications({ connected, warnings, poisonReview, queueSummary, approvalDiffReview }) {
    const items = [];
    if (!connected) {
      items.push({
        level: 'warning',
        title: 'PC 에이전트 연결 끊김',
        body: '서비스가 실행될 때까지 로컬 작업이 대기열에 보관됩니다.'
      });
    }
    if (poisonReview.required) {
      items.push({
        level: 'warning',
        title: '격리된 작업 검토 필요',
        body: `격리된 작업 ${poisonReview.count}건을 검토해야 합니다.`
      });
    }
    if (approvalDiffReview.required) {
      items.push({
        level: approvalDiffReview.conflictCount > 0 ? 'warning' : 'info',
        title: '승인 변경 내용 검토 가능',
        body: `대기 중인 승인 변경 내용 ${approvalDiffReview.count}건을 검토할 수 있습니다.`
      });
    }
    if (queueSummary.retryScheduled > 0) {
      items.push({
        level: 'info',
        title: '작업 재시도 예약됨',
        body: `작업 ${queueSummary.retryScheduled}건이 재시도 시점을 기다리고 있습니다.`
      });
    }
    for (const warning of warnings) {
      items.push({ level: 'info', title: 'PC 에이전트 알림', body: warning });
    }
    return items;
  }
}

function queueSummaryFor({ queue, poisonQueue, serviceRuntime }) {
  const source = queue ?? poisonQueue?.queue ?? {};
  return {
    total: source.total ?? 0,
    queued: source.queued ?? 0,
    retryScheduled: source.retryScheduled ?? 0,
    running: source.running ?? 0,
    succeeded: source.succeeded ?? 0,
    quarantined: source.quarantined ?? 0,
    ignored: source.ignored ?? 0,
    poisonReviewRequired: poisonQueue?.items?.filter((item) => item.status === 'quarantined').length ?? source.quarantined ?? 0,
    supervisorStatus: serviceRuntime?.status ?? null,
    lastDrainAt: serviceRuntime?.lastDrain?.at ?? null
  };
}

function poisonReviewFor({ endpoint, poisonQueue }) {
  const items = (poisonQueue?.items ?? []).filter((item) => item.status === 'quarantined');
  return {
    required: items.length > 0,
    count: items.length,
    reviewUrl: `${endpoint}/execution-packets/queue/poison`,
    items: items.slice(0, 5).map((item) => ({
      queueId: item.queueId,
      taskId: item.taskId,
      packetId: item.packetId,
      toolName: item.toolName,
      reason: item.reason,
      error: item.error,
      quarantinedAt: item.quarantinedAt,
      reviewStatus: item.reviewStatus,
      actions: {
        review: `${endpoint}/execution-packets/queue/poison/${encodeURIComponent(item.queueId)}/review`,
        requeue: `${endpoint}/execution-packets/queue/poison/${encodeURIComponent(item.queueId)}/requeue`,
        ignore: `${endpoint}/execution-packets/queue/poison/${encodeURIComponent(item.queueId)}/ignore`
      }
    }))
  };
}

function approvalDiffReviewFor({ endpoint, approvalDiffs = [] }) {
  const items = (approvalDiffs ?? []).filter(Boolean);
  const conflictCount = items.filter((item) => Number(item.conflictCount ?? 0) > 0).length;
  const warningCount = items.reduce((sum, item) => sum + (item.warnings?.length ?? 0), 0);
  return {
    panelVersion: 'b-tray-approval-diff-panel-v1',
    required: items.length > 0,
    count: items.length,
    conflictCount,
    warningCount,
    reviewUrl: `${endpoint}/execution-packets/queue`,
    summary: items.length
      ? `승인 변경 ${items.length}건, 충돌 ${conflictCount}건, 주의 ${warningCount}건`
      : '대기 중인 승인 변경 내용이 없습니다.',
    items: items.slice(0, 5).map((item, index) => ({
      diffId: item.diffId ?? `approval-diff-${index + 1}`,
      diffVersion: item.diffVersion ?? 'b-approval-diff-v1',
      toolName: item.toolName,
      severity: item.severity,
      expectedChangesCount: item.expectedChangesCount ?? 0,
      affectedPathCount: item.affectedPaths?.length ?? 0,
      affectedPaths: item.affectedPaths?.slice(0, 5) ?? [],
      requiresUserApproval: item.requiresUserApproval === true,
      safeToAutoApprove: item.safeToAutoApprove === true,
      summary: item.summary
    }))
  };
}

export function createTrayState(options) {
  return new PcAgentTrayRuntime(options).state(options);
}

export function createTrayApprovalDiffState({ daemonConfig, serviceManifest, approvalDiffs = [], service = { status: 'running' }, health = { status: 'ok' } } = {}) {
  return new PcAgentTrayRuntime({ daemonConfig, serviceManifest }).state({
    service,
    health,
    approvalDiffs
  }).approvalDiffReview;
}
