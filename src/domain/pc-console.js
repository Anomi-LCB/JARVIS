export class PcConfirmationConsole {
  constructor({ handoffs = defaultPcConsoleHandoffs(), clock = () => new Date() } = {}) {
    this.clock = clock;
    this.handoffs = new Map(handoffs
      .map(normalizePcConsoleHandoff)
      .map((handoff) => [handoff.handoffId, handoff]));
    this.decisions = [];
  }

  list({ status } = {}) {
    return [...this.handoffs.values()]
      .filter((handoff) => !status || handoff.status === status)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  replace(handoffs = []) {
    this.handoffs = new Map(handoffs
      .map(normalizePcConsoleHandoff)
      .map((handoff) => [handoff.handoffId, handoff]));
    return this.snapshot();
  }

  merge(handoffs = []) {
    for (const handoff of handoffs.map(normalizePcConsoleHandoff)) {
      this.handoffs.set(handoff.handoffId, {
        ...this.handoffs.get(handoff.handoffId),
        ...handoff
      });
    }
    return this.snapshot();
  }

  decide(handoffId, decision, { operatorId = 'pc-console', note = null } = {}) {
    const handoff = this.handoffs.get(handoffId);
    if (!handoff) {
      return { success: false, error: { code: 'PC_HANDOFF_NOT_FOUND' } };
    }
    if (handoff.status !== 'awaiting_pc_confirmation') {
      return { success: false, error: { code: 'PC_HANDOFF_ALREADY_DECIDED' }, handoff };
    }
    if (!['approve', 'reject'].includes(decision)) {
      return { success: false, error: { code: 'PC_HANDOFF_DECISION_INVALID' }, handoff };
    }
    const decidedAt = this.clock().toISOString();
    const next = {
      ...handoff,
      status: decision === 'approve' ? 'accepted' : 'rejected',
      decidedAt,
      decidedBy: operatorId,
      note
    };
    this.handoffs.set(handoffId, next);
    const event = {
      eventId: `pc_console_${this.decisions.length + 1}`,
      handoffId,
      approvalId: handoff.approvalId,
      taskId: handoff.taskId,
      decision,
      operatorId,
      note,
      decidedAt
    };
    this.decisions = [event, ...this.decisions].slice(0, 8);
    return { success: true, handoff: next, event };
  }

  snapshot() {
    const items = this.list();
    return {
      items,
      pending: items.filter((item) => item.status === 'awaiting_pc_confirmation').length,
      accepted: items.filter((item) => item.status === 'accepted').length,
      rejected: items.filter((item) => item.status === 'rejected').length,
      decisions: this.decisions,
      lastDecision: this.decisions[0] ?? null
    };
  }
}

export class PcConfirmationConsoleBridgeClient {
  constructor({
    bridgeUrl = 'http://127.0.0.1:17777',
    tokenProvider = () => null,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    timeoutMs = 30000
  } = {}) {
    this.bridgeUrl = bridgeUrl.replace(/\/$/, '');
    this.tokenProvider = typeof tokenProvider === 'function'
      ? tokenProvider
      : () => tokenProvider;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, auth = true, timeoutMs = this.timeoutMs } = {}) {
    if (!this.fetchImpl) {
      return createPcConsoleBridgeFailure('C_PC_CONSOLE_FETCH_UNAVAILABLE', 'Fetch API is not available for PC console bridge integration.', {
        path,
        method
      });
    }
    const controller = typeof AbortController !== 'undefined' && timeoutMs > 0
      ? new AbortController()
      : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const startedAt = Date.now();
    const token = this.tokenProvider();
    try {
      const response = await this.fetchImpl(`${this.bridgeUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(auth && token ? { authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        ...(controller ? { signal: controller.signal } : {})
      });
      if (timeout) clearTimeout(timeout);
      const payload = await readPcConsoleJson(response);
      if (!response.ok) {
        return createPcConsoleBridgeFailure('C_PC_CONSOLE_BRIDGE_HTTP_ERROR', 'PC console bridge request failed.', {
          path,
          method,
          status: response.status,
          payload,
          latencyMs: Date.now() - startedAt
        });
      }
      return payload;
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      return createPcConsoleBridgeFailure(error?.name === 'AbortError' ? 'C_PC_CONSOLE_BRIDGE_TIMEOUT' : 'C_PC_CONSOLE_BRIDGE_NETWORK_ERROR', error?.message ?? 'PC console bridge request failed.', {
        path,
        method,
        latencyMs: Date.now() - startedAt
      });
    }
  }

  async list({ status = undefined } = {}) {
    const path = status
      ? `/pc-console/approval-handoffs?status=${encodeURIComponent(status)}`
      : '/pc-console/approval-handoffs';
    const response = await this.request(path);
    if (response?.items) {
      return {
        ...response,
        clientContract: 'c-pc-console-bridge-fetch-v1',
        items: response.items.map(normalizePcConsoleHandoff)
      };
    }
    return response;
  }

  async decide(handoffId, { decision, operatorId = 'pc-console', note = null } = {}) {
    const body = {
      decision,
      operatorId,
      ...(note == null ? {} : { note })
    };
    const response = await this.request(`/pc-console/approval-handoffs/${encodeURIComponent(handoffId)}/decision`, {
      method: 'POST',
      body
    });
    if (response?.handoff) {
      return {
        ...response,
        clientContract: 'c-pc-console-bridge-fetch-v1',
        handoff: normalizePcConsoleHandoff(response.handoff)
      };
    }
    return response;
  }

  async runVisualRegression({ status = 'awaiting_pc_confirmation', baseline = createPcConsoleVisualBaseline() } = {}) {
    const queue = await this.list({ status });
    const visualSnapshot = createPcConsoleVisualSnapshot(queue);
    const visualRegression = diffPcConsoleVisualSnapshots(baseline, visualSnapshot);
    return {
      scenarioVersion: 'c-pc-console-bridge-fetch-visual-v1',
      bridgeUrl: this.bridgeUrl,
      path: status
        ? `/pc-console/approval-handoffs?status=${encodeURIComponent(status)}`
        : '/pc-console/approval-handoffs',
      fetched: queue?.clientContract === 'c-pc-console-bridge-fetch-v1',
      queue,
      visualSnapshot,
      visualRegression,
      passed: queue?.clientContract === 'c-pc-console-bridge-fetch-v1' && visualRegression.status === 'passed'
    };
  }
}

export function normalizePcConsoleHandoff(handoff = {}) {
  const approvalSnapshot = handoff.approvalSnapshot ?? {};
  const requestedBy = typeof handoff.requestedBy === 'object' && handoff.requestedBy !== null
    ? handoff.requestedBy.deviceId ?? handoff.requestedBy.module ?? 'unknown'
    : handoff.requestedBy ?? 'unknown';
  const decidedBy = typeof handoff.decidedBy === 'object' && handoff.decidedBy !== null
    ? handoff.decidedBy.operatorId ?? handoff.decidedBy.module ?? null
    : handoff.decidedBy ?? null;
  return {
    handoffId: String(handoff.handoffId ?? handoff.id ?? ''),
    approvalId: String(handoff.approvalId ?? approvalSnapshot.approvalId ?? ''),
    taskId: String(handoff.taskId ?? approvalSnapshot.taskId ?? ''),
    title: String(handoff.title ?? approvalSnapshot.title ?? 'PC 확인 승인 요청'),
    interpretedIntent: String(handoff.interpretedIntent ?? approvalSnapshot.interpretedIntent ?? handoff.reason ?? ''),
    riskTier: Number(handoff.riskTier ?? approvalSnapshot.riskTier ?? 5),
    externalTransfer: Boolean(handoff.externalTransfer ?? approvalSnapshot.externalTransfer ?? false),
    rollbackAvailable: Boolean(handoff.rollbackAvailable ?? approvalSnapshot.rollbackAvailable ?? false),
    affectedItems: Array.isArray(handoff.affectedItems)
      ? handoff.affectedItems
      : Array.isArray(approvalSnapshot.affectedItems)
        ? approvalSnapshot.affectedItems
        : [],
    warnings: Array.isArray(handoff.warnings)
      ? handoff.warnings
      : Array.isArray(approvalSnapshot.warnings)
        ? approvalSnapshot.warnings
        : [],
    status: String(handoff.status ?? 'awaiting_pc_confirmation'),
    reason: handoff.reason ?? null,
    requestedBy,
    decidedBy,
    note: handoff.note ?? null,
    createdAt: handoff.createdAt ?? new Date(0).toISOString(),
    expiresAt: handoff.expiresAt ?? null,
    decidedAt: handoff.decidedAt ?? null,
    requiresPcConfirmation: handoff.requiresPcConfirmation ?? true,
    instructions: Array.isArray(handoff.instructions)
      ? handoff.instructions
      : [
          'PC JARVIS 콘솔에서 영향 범위를 확인',
          '수락 또는 거절 버튼으로 최종 결정',
          '결정 결과를 approval history에 기록'
        ]
  };
}

export function createPcConsoleVisualBaseline({
  minAwaitingRows = 1,
  maxRows = 3,
  requiredActions = ['approve', 'reject']
} = {}) {
  return {
    baselineVersion: 'c-pc-console-visual-baseline-v1',
    surface: 'pc-hud-approval-console',
    minAwaitingRows,
    maxRows,
    requiredActions,
    requiredLabels: ['Tier', 'PC 확인 대기', '수락', '거절'],
    invariants: [
      'awaiting rows expose accept and reject controls',
      'risk tier and external-transfer badges remain visible',
      'decided rows do not expose live decision controls'
    ]
  };
}

export function createPcConsoleVisualSnapshot(consoleState = {}, {
  maxRows = 3,
  viewport = 'desktop'
} = {}) {
  const items = Array.isArray(consoleState.items)
    ? consoleState.items.map(normalizePcConsoleHandoff)
    : Array.isArray(consoleState)
      ? consoleState.map(normalizePcConsoleHandoff)
      : [];
  const rows = items.slice(0, maxRows).map((item, index) => createPcConsoleVisualRow(item, index));
  const counts = {
    total: items.length,
    pending: Number(consoleState.pending ?? consoleState.counts?.awaiting ?? items.filter((item) => item.status === 'awaiting_pc_confirmation').length),
    accepted: Number(consoleState.accepted ?? consoleState.counts?.accepted ?? items.filter((item) => item.status === 'accepted').length),
    rejected: Number(consoleState.rejected ?? consoleState.counts?.rejected ?? items.filter((item) => item.status === 'rejected').length)
  };
  const checks = createPcConsoleVisualChecks({ rows, counts });
  return {
    snapshotVersion: 'c-pc-console-visual-snapshot-v1',
    surface: 'pc-hud-approval-console',
    viewport,
    ariaLabel: 'PC 확인 수락 거절 콘솔',
    rowLimit: maxRows,
    counts,
    layout: {
      panelClass: 'pc-console',
      rowCount: rows.length,
      awaitingRows: rows.filter((row) => row.status === 'awaiting_pc_confirmation').length,
      acceptRejectPairs: rows.filter((row) => row.actionButtons.some((button) => button.decision === 'approve') && row.actionButtons.some((button) => button.decision === 'reject')).length,
      statusCountersVisible: true
    },
    rows,
    checks,
    passed: checks.every((check) => check.passed)
  };
}

export function diffPcConsoleVisualSnapshots(baseline = createPcConsoleVisualBaseline(), actual = createPcConsoleVisualSnapshot()) {
  const checks = [
    ...actual.checks,
    {
      id: 'baseline-awaiting-row-floor',
      passed: actual.layout.awaitingRows >= baseline.minAwaitingRows || actual.counts.pending === 0,
      expected: `awaiting rows >= ${baseline.minAwaitingRows} or no pending handoffs`,
      actual: actual.layout.awaitingRows
    },
    {
      id: 'baseline-required-actions-visible',
      passed: actual.rows
        .filter((row) => row.status === 'awaiting_pc_confirmation')
        .every((row) => baseline.requiredActions.every((decision) => row.actionButtons.some((button) => button.decision === decision && button.enabled))),
      expected: baseline.requiredActions,
      actual: actual.rows.map((row) => ({ handoffId: row.handoffId, actions: row.actionButtons.map((button) => button.decision) }))
    },
    {
      id: 'baseline-labels-stable',
      passed: actual.rows.every((row) => row.riskTierLabel.startsWith('Tier '))
        && actual.rows
          .filter((row) => row.status === 'awaiting_pc_confirmation')
          .every((row) => row.statusLabel === 'PC 확인 대기'),
      expected: baseline.requiredLabels,
      actual: actual.rows.map((row) => ({ handoffId: row.handoffId, riskTierLabel: row.riskTierLabel, statusLabel: row.statusLabel }))
    }
  ];
  const failed = checks.filter((check) => !check.passed);
  return {
    reportVersion: 'c-pc-console-visual-regression-v1',
    surface: baseline.surface,
    status: failed.length === 0 ? 'passed' : 'failed',
    baselineHash: checksum(stableStringify(baseline)),
    actualHash: checksum(stableStringify({
      counts: actual.counts,
      layout: actual.layout,
      rows: actual.rows.map((row) => ({
        status: row.status,
        riskTierLabel: row.riskTierLabel,
        actionButtons: row.actionButtons.map((button) => button.decision)
      }))
    })),
    checks,
    failedChecks: failed.map((check) => check.id)
  };
}

export const diffPcConsoleVisualSnapshot = diffPcConsoleVisualSnapshots;

function createPcConsoleVisualRow(item, index) {
  const awaiting = item.status === 'awaiting_pc_confirmation';
  return {
    rowIndex: index,
    handoffId: item.handoffId,
    approvalId: item.approvalId,
    taskId: item.taskId,
    status: item.status,
    statusLabel: pcHandoffStatusLabel(item.status),
    title: item.title,
    intentPreview: item.interpretedIntent,
    riskTier: item.riskTier,
    riskTierLabel: `Tier ${item.riskTier}`,
    badges: [
      item.externalTransfer ? 'external-transfer' : 'local-review',
      item.rollbackAvailable ? 'rollback-available' : 'rollback-unavailable',
      item.warnings.length > 0 ? 'warnings-present' : 'warnings-clear'
    ],
    actionButtons: awaiting
      ? [
          {
            decision: 'approve',
            label: '수락',
            enabled: true,
            role: 'primary',
            testId: `pc-console-${item.handoffId}-approve`
          },
          {
            decision: 'reject',
            label: '거절',
            enabled: true,
            role: 'danger',
            testId: `pc-console-${item.handoffId}-reject`
          }
        ]
      : [],
    lockedDecisionLabel: awaiting ? null : pcHandoffStatusLabel(item.status),
    visualTone: item.status === 'rejected'
      ? 'danger'
      : awaiting
        ? 'warning'
        : 'confirmed'
  };
}

function createPcConsoleVisualChecks({ rows, counts }) {
  return [
    {
      id: 'status-counters-visible',
      passed: Number.isFinite(counts.pending) && Number.isFinite(counts.accepted) && Number.isFinite(counts.rejected),
      expected: ['pending', 'accepted', 'rejected'],
      actual: counts
    },
    {
      id: 'accept-reject-actions-visible',
      passed: rows
        .filter((row) => row.status === 'awaiting_pc_confirmation')
        .every((row) => row.actionButtons.length === 2
          && row.actionButtons.some((button) => button.decision === 'approve' && button.enabled)
          && row.actionButtons.some((button) => button.decision === 'reject' && button.enabled)),
      expected: 'all awaiting rows expose enabled approve/reject buttons',
      actual: rows.map((row) => ({ handoffId: row.handoffId, status: row.status, actionCount: row.actionButtons.length }))
    },
    {
      id: 'risk-and-transfer-context-visible',
      passed: rows.every((row) => row.riskTierLabel.startsWith('Tier ') && row.badges.length >= 2),
      expected: 'risk tier and transfer/rollback badges',
      actual: rows.map((row) => ({ handoffId: row.handoffId, riskTierLabel: row.riskTierLabel, badges: row.badges }))
    },
    {
      id: 'decided-rows-hide-live-actions',
      passed: rows
        .filter((row) => row.status !== 'awaiting_pc_confirmation')
        .every((row) => row.actionButtons.length === 0 && Boolean(row.lockedDecisionLabel)),
      expected: 'accepted/rejected rows are locked',
      actual: rows.map((row) => ({ handoffId: row.handoffId, status: row.status, actionCount: row.actionButtons.length }))
    }
  ];
}

function pcHandoffStatusLabel(status) {
  return {
    awaiting_pc_confirmation: 'PC 확인 대기',
    accepted: '수락됨',
    rejected: '거절됨',
    expired: '만료됨'
  }[status] ?? status;
}

async function readPcConsoleJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return createPcConsoleBridgeFailure('C_PC_CONSOLE_BRIDGE_INVALID_JSON', 'Bridge returned invalid JSON.', {
      status: response.status,
      bodyPreview: text.slice(0, 140)
    });
  }
}

function createPcConsoleBridgeFailure(code, message, metadata = {}) {
  return {
    success: false,
    error: { code, message },
    metadata
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(input) {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function defaultPcConsoleHandoffs() {
  return [
    {
      handoffId: 'pc_handoff_demo_001',
      approvalId: 'appr_pc_demo_001',
      taskId: 'task_pc_demo_001',
      title: '외부 발송 포함 안내문 배포',
      interpretedIntent: '모바일에서 차단된 외부 발송 후보를 PC에서 영향 범위와 수신 대상을 직접 확인합니다.',
      riskTier: 2,
      externalTransfer: true,
      rollbackAvailable: false,
      status: 'awaiting_pc_confirmation',
      requestedBy: 'mobile_lcb_001',
      createdAt: '2026-06-18T08:00:00.000Z',
      expiresAt: '2026-06-18T08:03:00.000Z',
      instructions: [
        '외부 전송 대상과 본문을 PC 화면에서 직접 확인',
        '되돌리기 불가 항목이면 거절 또는 수정 요청',
        '승인 시 B 로컬 실행 전 마지막 확인으로 넘김'
      ]
    },
    {
      handoffId: 'pc_handoff_demo_002',
      approvalId: 'appr_pc_demo_002',
      taskId: 'task_pc_demo_002',
      title: '시스템 설정 점검',
      interpretedIntent: '관리자 권한이 필요한 로컬 설정 점검을 PC 콘솔에서 승인하거나 거절합니다.',
      riskTier: 3,
      externalTransfer: false,
      rollbackAvailable: true,
      status: 'awaiting_pc_confirmation',
      requestedBy: 'mobile_lcb_001',
      createdAt: '2026-06-18T08:01:00.000Z',
      expiresAt: '2026-06-18T08:06:00.000Z',
      instructions: [
        '변경 전 dry-run 결과 확인',
        '허용 루트와 rollback 가능 여부 확인',
        '관리자 권한이 필요한 경우 PC에서만 최종 결정'
      ]
    }
  ];
}
