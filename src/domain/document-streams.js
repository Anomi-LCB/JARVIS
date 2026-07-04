import { ModuleId } from './models.js';

export const DocumentStage = Object.freeze({
  READY: 'ready',
  BUILDING: 'building',
  VERIFYING: 'verifying',
  BLOCKED: 'blocked',
  COMPLETE: 'complete'
});

const baseStreams = [
  {
    id: 'A',
    title: '공통 코어 엔진',
    moduleId: ModuleId.CORE,
    stage: DocumentStage.COMPLETE,
    objective: '명령 수신, 계약 검증, lifecycle, 권한 판단, 메모리 회상, 실행 계획, 검증 결과를 하나의 코어 상태로 합성',
    deliverables: ['EventBus', 'TaskStateMachine', 'TaskLifecycle', 'ContractRegistry', 'IntentParser', 'TaskPlanner', 'CoreFacade'],
    nextAction: 'CoreFacade 상태를 장기 저장소와 JSONL trace로 지속화',
    risk: 'medium'
  },
  {
    id: 'B',
    title: '로컬 PC 제어 프로그램',
    moduleId: ModuleId.LOCAL,
    stage: DocumentStage.COMPLETE,
    objective: '자연어 명령을 allowlist 기반 capability, shadow run, user-confirmed handoff, ToolAdapter 실행으로 연결',
    deliverables: ['capture/memo/search/record/inspect 플래너', 'allowlist 정책', 'destructive command 차단', 'ExecutionHandoff', 'UndoJournal'],
    nextAction: '실제 Local API와 adapter별 감사 로그를 파일 JSONL로 지속화',
    risk: 'medium'
  },
  {
    id: 'C',
    title: '모바일/태블릿 앱',
    moduleId: ModuleId.MOBILE,
    stage: DocumentStage.COMPLETE,
    objective: '모바일에서 명령 입력, pairing, 승인 카드 확인, handoff 확인, 오프라인 큐, Expo 화면 골격을 담당',
    deliverables: ['Expo app config', 'MobileAppRuntime', 'BridgeClient', 'SecureTokenStore', 'OfflineCommandQueue', 'Pairing/Command/Approval/Task/Result/Settings view-models', 'ApprovalCard UI components'],
    nextAction: '실제 Expo 런타임 설치 후 기기/에뮬레이터에서 화면 렌더링 검증',
    risk: 'medium'
  },
  {
    id: 'D',
    title: 'PC/모바일 통신 브릿지',
    moduleId: ModuleId.BRIDGE,
    stage: DocumentStage.COMPLETE,
    objective: 'C와 A/B/E/F/G 사이에서 pairing, 인증, task, approval, handoff, result, feedback API를 중계',
    deliverables: ['GET /health', 'POST /pairing/*', 'POST/GET /tasks', 'GET/POST /approvals', 'GET /results', 'POST /feedback'],
    nextAction: 'SSE /events/stream과 route audit JSONL을 추가',
    risk: 'medium'
  },
  {
    id: 'E',
    title: '권한/승인/보안 시스템',
    moduleId: ModuleId.SECURITY,
    stage: DocumentStage.COMPLETE,
    objective: '위험도, 모바일 승인 제한, 승인 만료/재승인, 단일 사용 Capability Token으로 실행 권한을 통제',
    deliverables: ['RiskClassifier', 'ApprovalPolicyEngine', 'CapabilityTokenService', 'ApprovalExpiryManager', 'Tier Guard'],
    nextAction: '정책 판단과 capability 사용 이력을 JSONL 감사 로그로 지속화',
    risk: 'medium'
  },
  {
    id: 'F',
    title: '성장형 메모리/학습 시스템',
    moduleId: ModuleId.MEMORY,
    stage: DocumentStage.COMPLETE,
    objective: 'MemoryEvent를 SQLite에 저장하고 doNotRemember, 중복 제거, 반복 패턴, 선호 후보, 실패 기억, 감쇠, GrowthReview JSON 산출물을 관리',
    deliverables: ['SqliteMemoryStore', 'MemoryEventIngestor', 'PatternMiner', 'PreferenceHypothesisEngine', 'FailureMemoryBuilder', 'MemoryHygieneManager', 'GrowthReview JSON'],
    nextAction: 'AutonomyCandidate 생성과 E 정책 제출 API를 실제 후보 저장소에 연결',
    risk: 'medium'
  },
  {
    id: 'G',
    title: '테스트/검증 시뮬레이션',
    moduleId: ModuleId.SIMULATION,
    stage: DocumentStage.COMPLETE,
    objective: '계획, 승인, 정책, 실행 결과, 학습 위생, 시뮬레이션, 회귀 테스트를 HTTP API로 검증',
    deliverables: ['POST /verify/plan', 'POST /verify/policy', 'POST /verify/execution', 'POST /verify/learning', 'POST /simulate', 'POST /regression/run'],
    nextAction: '검증 리포트를 파일 JSON/HTML 산출물로 저장',
    risk: 'low'
  }
];

const stageRank = {
  [DocumentStage.COMPLETE]: 100,
  [DocumentStage.VERIFYING]: 78,
  [DocumentStage.BUILDING]: 62,
  [DocumentStage.READY]: 36,
  [DocumentStage.BLOCKED]: 15
};

export class DocumentStreamRegistry {
  constructor(streams = baseStreams) {
    this.streams = streams.map((stream) => ({ ...stream }));
  }

  summarize({ moduleTelemetry = [], canAssist = true, simulationResult } = {}) {
    const telemetryByModule = new Map(moduleTelemetry.map((item) => [item.id, item]));
    return this.streams.map((stream) => {
      const telemetry = telemetryByModule.get(stream.moduleId);
      const blockedBySecurity = stream.id === 'E' && !canAssist;
      const simulationReview = stream.id === 'G' && simulationResult?.failedChecks?.length > 0;
      const stage = blockedBySecurity ? DocumentStage.BLOCKED : stream.stage;
      return {
        ...stream,
        stage,
        progress: this.progressFor(stage, { telemetry, simulationReview }),
        health: this.healthFor(stage, stream.risk, telemetry),
        telemetryStatus: telemetry?.status ?? 'pending',
        telemetryMetric: telemetry?.metric ?? 'n/a',
        evidence: this.evidenceFor(stream, telemetry, simulationResult)
      };
    });
  }

  progressFor(stage, { telemetry, simulationReview } = {}) {
    const base = stageRank[stage] ?? 0;
    const telemetryBonus = ['stable', 'ready', 'synced', 'online', 'cleared', 'learning', 'pass'].includes(telemetry?.status) ? 8 : 0;
    const reviewPenalty = simulationReview ? 10 : 0;
    return Math.max(0, Math.min(100, base + telemetryBonus - reviewPenalty));
  }

  healthFor(stage, risk, telemetry) {
    if (stage === DocumentStage.BLOCKED || telemetry?.status === 'blocked') return 'blocked';
    if (risk === 'high' && ['pending', 'review', 'watch'].includes(telemetry?.status)) return 'watch';
    if (stage === DocumentStage.VERIFYING) return 'verify';
    return 'active';
  }

  evidenceFor(stream, telemetry, simulationResult) {
    if (stream.id === 'G' && simulationResult) {
      return `${simulationResult.name} ${simulationResult.passRate}%`;
    }
    if (telemetry) {
      return `${telemetry.status} · ${telemetry.metric}`;
    }
    return stream.deliverables[0];
  }
}
