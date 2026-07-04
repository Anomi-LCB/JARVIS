import { ModuleId, PermissionLevel, createWorkflowStep, clamp } from './models.js';
import { SecurityGateway } from './security.js';
import { GrowthMemory } from './memory.js';
import { LocalPcController } from './local-control.js';
import { DeviceBridge } from './bridge.js';
import { SimulationHarness } from './simulation.js';
import { DocumentStreamRegistry } from './document-streams.js';
import { ReleaseReadiness } from './readiness.js';
import { ActionPlanner } from './action-planner.js';
import { PcConfirmationConsole } from './pc-console.js';

export function createJarvisSystem() {
  const security = new SecurityGateway();
  const memory = new GrowthMemory([
    { title: '팀 회의는 회의실 A 선호', tags: ['schedule', 'meeting'], weight: 3, createdAt: '2026-06-07T08:00:00.000Z' },
    { title: '회의 자료 분석은 승인 확인 후 요약', tags: ['workflow', 'security'], weight: 4, createdAt: '2026-06-07T08:10:00.000Z' },
    { title: '실시간 캡처 결과는 보안 저장소에 보관', tags: ['capture', 'security'], weight: 2, createdAt: '2026-06-07T08:20:00.000Z' }
  ]);
  const localPc = new LocalPcController();
  const bridge = new DeviceBridge([
    { name: '스마트폰', type: 'mobile', latencyMs: 64 },
    { name: '블루투스 이어폰', type: 'audio', latencyMs: 42 },
    { name: '클라우드', type: 'cloud', latencyMs: 210 },
    { name: '회사 네트워크', type: 'network', latencyMs: 88 }
  ]);
  const simulation = new SimulationHarness({
    scenarios: [
      {
        id: 'meeting-analysis',
        name: '회의 자료 분석 승인 워크플로우',
        checks: [
          { name: 'request-ingested', pass: true, weight: 2 },
          { name: 'permission-approved', pass: true, weight: 3 },
          { name: 'response-generated', pass: true, weight: 3 },
          { name: 'user-confirmation-handoff', pass: true, weight: 2 }
        ]
      },
      {
        id: 'live-capture',
        name: '화면 캡처 및 보안 저장',
        checks: [
          { name: 'capture-permission', pass: true, weight: 2 },
          { name: 'window-detected', pass: true, weight: 2 },
          { name: 'secure-store-ready', pass: true, weight: 3 },
          { name: 'mobile-preview-synced', pass: true, weight: 1 }
        ]
      },
      {
        id: 'voice-record',
        name: '음성 녹음 및 회의록 초안',
        checks: [
          { name: 'microphone-ready', pass: true, weight: 2 },
          { name: 'privacy-notice-visible', pass: true, weight: 3 },
          { name: 'transcript-buffering', pass: true, weight: 2 },
          { name: 'speaker-label-needs-review', pass: false, weight: 1 }
        ]
      },
      {
        id: 'quick-search',
        name: '검색 결과 랭킹 및 요약',
        checks: [
          { name: 'query-normalized', pass: true, weight: 2 },
          { name: 'local-memory-ranked', pass: true, weight: 2 },
          { name: 'remote-source-pending', pass: false, weight: 1 },
          { name: 'summary-ready', pass: true, weight: 3 }
        ]
      },
      {
        id: 'system-inspection',
        name: '로컬 설정 점검 및 관리자 승인',
        checks: [
          { name: 'local-scope-limited', pass: true, weight: 3 },
          { name: 'admin-approval-required', pass: true, weight: 3 },
          { name: 'dry-run-generated', pass: true, weight: 2 },
          { name: 'operator-confirmation-pending', pass: false, weight: 2 }
        ]
      },
      {
        id: 'restricted-command',
        name: '제한 명령 차단 정책',
        checks: [
          { name: 'destructive-term-detected', pass: true, weight: 3 },
          { name: 'allowlist-denied', pass: true, weight: 3 },
          { name: 'audit-event-ready', pass: true, weight: 2 },
          { name: 'safe-alternative-needed', pass: false, weight: 2 }
        ]
      }
    ]
  });

  const pcConsole = new PcConfirmationConsole();

  return new JarvisCoreEngine({ security, memory, localPc, bridge, simulation, pcConsole });
}

export class JarvisCoreEngine {
  constructor({ security, memory, localPc, bridge, simulation, pcConsole }) {
    this.modules = [
      ModuleId.CORE,
      ModuleId.LOCAL,
      ModuleId.MOBILE,
      ModuleId.BRIDGE,
      ModuleId.SECURITY,
      ModuleId.MEMORY,
      ModuleId.SIMULATION
    ];
    this.security = security;
    this.memory = memory;
    this.localPc = localPc;
    this.bridge = bridge;
    this.simulation = simulation;
    this.pcConsole = pcConsole;
    this.documentStreams = new DocumentStreamRegistry();
    this.readiness = new ReleaseReadiness();
    this.actionPlanner = new ActionPlanner();
    this.lastCommand = '회의 자료 분석';
    this.commandHistory = [];
    this.sequence = 0;
  }

  composeDashboardState(command = this.lastCommand, options = {}) {
    this.lastCommand = command;
    const profile = this.profileCommand(command);
    const approval = this.security.requestApproval({
      id: `approval-${profile.id}`,
      actor: '김대리',
      action: command,
      requiredLevel: profile.requiredLevel,
      autoApprove: options.autoApprove ?? profile.autoApprove
    });
    const canAssist = this.security.canExecute({
      approvalId: approval.id,
      userLevel: options.userLevel ?? PermissionLevel.CONTROL
    });
    const plan = this.localPc.plan(command);
    const canRun = canAssist && plan.executable;
    const bridgeRoute = this.bridge.routeMessage({ targetType: profile.targetType, payload: command });
    const simulationResult = this.simulation.runScenario(profile.scenarioId);
    const progress = clamp(canRun ? simulationResult.passRate - 12 : 15, 0, 100);
    const remembered = this.memory.remember({
      title: `${profile.title} 요청 처리`,
      tags: profile.tags,
      weight: canRun ? 2 : 1
    });
    const commandEvent = this.recordCommand({ command, profile, canAssist, canRun, progress, plan, bridgeRoute });
    const moduleTelemetry = this.createModuleTelemetry({ canAssist, progress, plan, bridgeRoute, simulationResult });
    const documentStreams = this.documentStreams.summarize({
      moduleTelemetry,
      canAssist,
      simulationResult
    });
    const readiness = this.readiness.evaluate({
      documentStreams,
      simulationResult,
      canAssist,
      commandProfile: profile,
      plan
    });
    const actionPlan = this.actionPlanner.plan({
      readiness,
      documentStreams,
      commandProfile: profile
    });

    return {
      brand: 'JARVIS',
      location: '서울 강남구 테헤란로',
      altitudeM: 32,
      command,
      commandProfile: profile,
      progress,
      eta: profile.eta,
      route: profile.route,
      plan,
      bridgeRoute,
      approval,
      approvalSummary: this.security.approvalSummary(),
      pcConsole: this.pcConsole.snapshot(),
      canAssist,
      canRun,
      modules: this.modules,
      moduleTelemetry,
      documentStreams,
      documentProgress: this.calculateDocumentProgress(documentStreams),
      readiness,
      actionPlan,
      memories: this.memory.recallByTag(profile.tags[0]),
      recentMemory: remembered,
      commandHistory: this.commandHistory,
      commandEvent,
      learnedProfile: this.memory.summarizeProfile(),
      workflow: this.createWorkflow({ canAssist, canRun, simulationResult, profile, plan }),
      approvals: [
        { title: '지출 결의서', requester: '김대리', time: '09:30' },
        { title: '마케팅 예산안', requester: '이과장', time: '09:25' },
        { title: '디자인 시안', requester: '박주임', time: '09:20' },
        { title: profile.title, requester: 'JARVIS', time: profile.reviewTime, status: approval.status, expiresAt: approval.expiresAt }
      ],
      schedule: [
        { time: '10:00', title: '팀 회의', place: '회의실 A' },
        { time: '11:30', title: '고객 인터뷰', place: '화상 회의' },
        { time: '14:00', title: '프로젝트 리뷰', place: '회의실 B' }
      ],
      nearby: [
        { icon: '●', label: '김대리', distance: '5m' },
        { icon: '◆', label: '회의실 A', distance: '12m' },
        { icon: '▣', label: '프린터', distance: '18m' },
        { icon: '◼', label: '커피 머신', distance: '21m' }
      ],
      connections: this.bridge.connectionSummary(),
      alerts: [
        canAssist ? profile.alert : `${profile.title} 권한 확인 대기 중`,
        bridgeRoute.delivered ? `${bridgeRoute.target} 동기화 ETA ${bridgeRoute.etaMs}ms` : '대상 디바이스 없음'
      ],
      commandSuggestions: ['회의 자료 분석', '현재 화면 캡처', '회의 녹음 시작', '프로젝트 자료 검색', '설정 점검', '메모 요약'],
      auditEvents: this.security.auditLog.slice(-4),
      simulationResult
    };
  }

  decidePcConsoleHandoff(handoffId, decision, options = {}) {
    const result = this.pcConsole.decide(handoffId, decision, options);
    this.security.audit(result.success ? 'pc_console.handoff_decided' : 'pc_console.handoff_decision_failed', {
      handoffId,
      decision,
      result: result.success ? result.handoff.status : result.error.code
    });
    return result;
  }

  replacePcConsoleHandoffs(handoffs = []) {
    const snapshot = this.pcConsole.replace(handoffs);
    this.security.audit('pc_console.handoff_synced', {
      count: snapshot.items.length,
      pending: snapshot.pending
    });
    return snapshot;
  }

  profileCommand(command) {
    const normalized = command.toLowerCase();
    if (['삭제', '초기화', '포맷', 'format', 'delete', 'shutdown', 'restart'].some((term) => normalized.includes(term))) {
      return {
        id: 'restricted-command',
        title: '제한 명령 차단',
        requiredLevel: PermissionLevel.ASSIST,
        autoApprove: true,
        scenarioId: 'restricted-command',
        targetType: 'network',
        tags: ['local-control', 'security', 'workflow'],
        eta: '차단됨',
        reviewTime: '09:39',
        route: { distanceM: 0, instruction: 'allowlist 밖 명령 차단' },
        alert: '파괴적 로컬 명령은 실행 전 차단되었습니다'
      };
    }
    if (normalized.includes('캡처') || normalized.includes('capture')) {
      return {
        id: 'live-capture',
        title: '화면 캡처',
        requiredLevel: PermissionLevel.CONTROL,
        autoApprove: true,
        scenarioId: 'live-capture',
        targetType: 'mobile',
        tags: ['capture', 'security', 'workflow'],
        eta: '00:08',
        reviewTime: '09:35',
        route: { distanceM: 18, instruction: '보안 저장소로 전송' },
        alert: '캡처 미리보기를 모바일에 동기화했습니다'
      };
    }
    if (normalized.includes('녹음') || normalized.includes('record')) {
      return {
        id: 'voice-record',
        title: '음성 녹음',
        requiredLevel: PermissionLevel.CONTROL,
        autoApprove: true,
        scenarioId: 'voice-record',
        targetType: 'audio',
        tags: ['record', 'meeting', 'workflow'],
        eta: '진행 중',
        reviewTime: '09:36',
        route: { distanceM: 42, instruction: '이어폰 마이크 연결 확인' },
        alert: '개인정보 고지 후 회의록 초안을 생성합니다'
      };
    }
    if (normalized.includes('검색') || normalized.includes('search')) {
      return {
        id: 'quick-search',
        title: '자료 검색',
        requiredLevel: PermissionLevel.ASSIST,
        autoApprove: true,
        scenarioId: 'quick-search',
        targetType: 'cloud',
        tags: ['search', 'memory', 'workflow'],
        eta: '00:22',
        reviewTime: '09:37',
        route: { distanceM: 120, instruction: '로컬 메모리 우선 검색' },
        alert: '로컬 기억과 원격 후보를 함께 정렬했습니다'
      };
    }
    if (normalized.includes('설정') || normalized.includes('권한') || normalized.includes('system')) {
      return {
        id: 'system-inspection',
        title: '시스템 설정 점검',
        requiredLevel: PermissionLevel.ADMIN,
        autoApprove: false,
        scenarioId: 'system-inspection',
        targetType: 'network',
        tags: ['security', 'local-control', 'workflow'],
        eta: '승인 대기',
        reviewTime: '09:38',
        route: { distanceM: 4, instruction: '관리자 승인 후 dry-run 실행' },
        alert: '관리자 승인 없이는 실제 설정 변경을 차단합니다'
      };
    }
    return {
      id: 'meeting-analysis',
      title: '회의 자료 분석',
      requiredLevel: PermissionLevel.ASSIST,
      autoApprove: true,
      scenarioId: 'meeting-analysis',
      targetType: 'cloud',
      tags: ['workflow', 'meeting', 'security'],
      eta: '12:45',
      reviewTime: '09:34',
      route: { distanceM: 120, instruction: '우회전 후 직진' },
      alert: '오늘 미세먼지 나쁨 · 마스크 착용 권장'
    };
  }

  createWorkflow({ canAssist, canRun, simulationResult, profile, plan }) {
    return [
      createWorkflowStep('요청 수신', 'done'),
      createWorkflowStep('권한 확인', canAssist ? 'done' : 'active'),
      createWorkflowStep('실행 계획', canAssist ? (plan.executable ? 'done' : 'active') : 'pending'),
      createWorkflowStep(profile.title, canRun ? 'done' : 'pending'),
      createWorkflowStep(simulationResult.failedChecks.length === 0 ? '검증 통과' : '사용자 확인', canRun ? 'active' : 'pending'),
      createWorkflowStep('작업 완료', simulationResult.failedChecks.length === 0 && canRun ? 'done' : 'pending')
    ];
  }

  recordCommand({ command, profile, canAssist, canRun, progress, plan, bridgeRoute }) {
    const event = {
      id: `${++this.sequence}`.padStart(3, '0'),
      command,
      title: profile.title,
      status: canRun ? 'running' : canAssist ? 'local-blocked' : 'approval-required',
      progress,
      capability: plan.capability,
      target: bridgeRoute.target ?? 'none',
      at: new Date().toISOString()
    };
    this.commandHistory = [event, ...this.commandHistory].slice(0, 6);
    return event;
  }

  createModuleTelemetry({ canAssist, progress, plan, bridgeRoute, simulationResult }) {
    return [
      { id: ModuleId.CORE, label: 'Core', status: progress > 60 ? 'stable' : 'watch', metric: `${progress}%` },
      {
        id: ModuleId.LOCAL,
        label: 'Local PC',
        status: plan.executable ? (plan.requiresConfirmation ? 'confirm' : 'ready') : 'blocked',
        metric: `${plan.capability}:${plan.mode}`
      },
      { id: ModuleId.MOBILE, label: 'Mobile', status: bridgeRoute.delivered ? 'synced' : 'idle', metric: bridgeRoute.target ?? 'none' },
      { id: ModuleId.BRIDGE, label: 'Bridge', status: bridgeRoute.delivered ? 'online' : 'route-miss', metric: bridgeRoute.etaMs ? `${bridgeRoute.etaMs}ms` : 'n/a' },
      { id: ModuleId.SECURITY, label: 'Security', status: canAssist ? 'cleared' : 'pending', metric: canAssist ? 'approved' : 'hold' },
      { id: ModuleId.MEMORY, label: 'Memory', status: 'learning', metric: `${this.memory.memories.length}` },
      { id: ModuleId.SIMULATION, label: 'Sim', status: simulationResult.failedChecks.length ? 'review' : 'pass', metric: `${simulationResult.passRate}%` }
    ];
  }

  calculateDocumentProgress(documentStreams) {
    const total = documentStreams.reduce((sum, stream) => sum + stream.progress, 0);
    return Math.round(total / documentStreams.length);
  }
}
