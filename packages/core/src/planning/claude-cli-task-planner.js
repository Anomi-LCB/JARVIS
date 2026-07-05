import { ActionType } from '../../../shared/src/types.js';
import { IntentParser } from '../intent/intent-parser.js';
import { SkillRouter } from '../routing/skill-router.js';
import {
  actionProfiles,
  createClaudeCliRunner,
  extractJsonObject
} from '../intent/claude-cli-intent-adapter.js';
import { TaskPlanner } from './task-planner.js';

// E RiskClassifier의 기본 riskByAction과 같은 등급표(낮을수록 위험).
// 복합 명령의 대표 액션을 "가장 위험한 조각"으로 승격할 때만 사용하므로
// 이 표가 실제 E 평가를 대체하지 않는다 — E는 승격된 대표 액션을 그대로 재평가한다.
const riskTierByAction = Object.freeze({
  [ActionType.CREATE_FILE]: 5,
  [ActionType.LIST_FILES]: 5,
  [ActionType.COPY_FILE]: 5,
  [ActionType.MOVE_FILE]: 5,
  [ActionType.BROWSER_SEARCH]: 4,
  [ActionType.UPLOAD_FILE]: 3,
  [ActionType.DELETE_FILE]: 2,
  [ActionType.MAKE_PAYMENT]: 1,
  [ActionType.CHANGE_SYSTEM_SETTING]: 1,
  [ActionType.READ_SECRET]: 1
});

export function buildPlanDecompositionPrompt(commandText) {
  const actionLines = Object.entries(actionProfiles)
    .map(([actionType, profile]) => `- ${actionType}: ${profile.label}`)
    .join('\n');
  return [
    '당신은 JARVIS 로컬 비서의 작업 계획 분해기입니다. 사용자 명령을 실행 순서대로 최대 5개의 하위 작업으로 분해하세요.',
    '각 하위 작업의 actionType은 아래 목록에서 정확히 하나를 선택합니다.',
    actionLines,
    '',
    '규칙:',
    '- 반드시 JSON 객체 하나만 출력한다. 설명 문장, 마크다운 코드펜스를 붙이지 않는다.',
    '- 단일 작업이면 parts를 1개만 만든다. 억지로 쪼개지 않는다.',
    '- text에는 해당 하위 작업에 해당하는 사용자 명령 조각을 담는다.',
    '- slots에는 명령에서 읽어낸 값만 채우고 없으면 null로 둔다.',
    '- 사용자가 요청하지 않은 작업을 추가하지 않는다.',
    '',
    '출력 형식:',
    '{"summary":"한 문장 계획 요약","parts":[{"actionType":"...","text":"명령 조각","description":"할 일 설명","slots":{"fileName":null,"outputFormat":null,"destination":null,"directoryHint":null,"query":null,"topic":null,"dateHint":null}}]}',
    '',
    `사용자 명령: ${commandText}`
  ].join('\n');
}

export class ClaudeCliTaskPlanner extends TaskPlanner {
  constructor({
    parser = new IntentParser(),
    skillRouter = new SkillRouter(),
    command = 'claude',
    model = null,
    timeoutMs = 45000,
    maxCommandLength = 2000,
    runner = null,
    clock = () => new Date(),
    adapterId = 'claude-cli-task-planner-v1'
  } = {}) {
    super();
    this.parser = parser;
    this.skillRouter = skillRouter;
    this.model = model;
    this.maxCommandLength = maxCommandLength;
    this.clock = clock;
    this.adapterId = adapterId;
    this.runner = runner ?? createClaudeCliRunner({ command, model, timeoutMs });
  }

  createPlan(taskRequest, intent, options = {}) {
    const decomposition = this.decomposeWithLlm(taskRequest.command.rawText, intent);
    if (!decomposition) {
      return super.createPlan(taskRequest, intent, options);
    }
    // 대표 액션을 가장 위험한 조각으로 승격한다. E evaluatePlan은 plan.action만 보므로
    // 이 승격이 있어야 복합 명령 속의 위험 조각(삭제/외부전송 등)이 정책 평가를 우회하지 못한다.
    const riskiest = [...decomposition.parts].sort(
      (a, b) => (riskTierByAction[a.actionType] ?? 4) - (riskTierByAction[b.actionType] ?? 4)
    )[0];
    const escalated = riskiest.actionType !== intent.actionType;
    const primaryIntent = escalated
      ? {
          ...intent,
          actionType: riskiest.actionType,
          category: actionProfiles[riskiest.actionType].category,
          riskHint: actionProfiles[riskiest.actionType].riskHint,
          slots: { ...intent.slots, ...riskiest.slots },
          reasons: [...(intent.reasons ?? []), `llm_plan_risk_escalation:${riskiest.actionType}`]
        }
      : intent;
    const route = escalated ? this.skillRouter.route(primaryIntent) : options.route;
    this.pendingDecomposition = decomposition;
    try {
      const plan = super.createPlan(taskRequest, primaryIntent, { ...options, route });
      return {
        ...plan,
        interpretedIntent: decomposition.summary
          ? `${decomposition.summary} (${decomposition.parts.length}단계)`
          : plan.interpretedIntent,
        riskNotes: [
          ...plan.riskNotes,
          ...(escalated
            ? [`[LLM 계획] 복합 명령에 더 위험한 하위 작업(${actionProfiles[riskiest.actionType].label})이 있어 대표 위험도를 승격했습니다.`]
            : []),
          ...decomposition.parts.map((part, index) => `[LLM 계획 ${index + 1}/${decomposition.parts.length}] ${actionProfiles[part.actionType].label}: ${part.description}`)
        ],
        llmPlanning: {
          adapterId: this.adapterId,
          model: this.model ?? 'cli-default',
          summary: decomposition.summary ?? null,
          latencyMs: decomposition.latencyMs,
          partCount: decomposition.parts.length,
          heterogeneous: new Set(decomposition.parts.map((part) => part.actionType)).size > 1,
          riskEscalated: escalated,
          externalService: 'anthropic-claude-cli',
          rawCommandSharedWithModel: true
        }
      };
    } finally {
      this.pendingDecomposition = null;
    }
  }

  decomposeWithLlm(rawText, intent) {
    const text = String(rawText ?? '').trim().slice(0, this.maxCommandLength);
    if (!text) return null;
    // 단순 명령은 LLM 왕복 지연을 만들지 않는다. 접속어/복수 액션이 감지된 복합 명령만 분해한다.
    if (intent?.complexity?.needsPlanDecomposition !== true) return null;
    const startedAt = Date.now();
    let stdout;
    try {
      stdout = this.runner(buildPlanDecompositionPrompt(text));
    } catch {
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    const rawParts = Array.isArray(payload?.parts) ? payload.parts.slice(0, 5) : [];
    const parts = rawParts
      .filter((part) => actionProfiles[part?.actionType])
      .map((part, index) => ({
        actionType: part.actionType,
        text: typeof part.text === 'string' && part.text.trim() ? part.text.trim().slice(0, 400) : text,
        description: typeof part.description === 'string' && part.description.trim()
          ? part.description.trim().slice(0, 200)
          : `${actionProfiles[part.actionType].label} 실행`,
        slots: this.sanitizeSlots(part.slots),
        sequenceIndex: index
      }));
    if (parts.length === 0 || parts.length !== rawParts.length) return null;
    return {
      parts,
      summary: typeof payload.summary === 'string' ? payload.summary.trim().slice(0, 300) : null,
      latencyMs: Date.now() - startedAt
    };
  }

  sanitizeSlots(slots) {
    const sanitized = {};
    for (const key of ['fileName', 'outputFormat', 'destination', 'directoryHint', 'query', 'topic', 'dateHint']) {
      const value = slots?.[key];
      if (typeof value === 'string' && value.trim()) sanitized[key] = value.trim().slice(0, 200);
    }
    return sanitized;
  }

  decomposeActions(rawText, intent) {
    if (!this.pendingDecomposition) return super.decomposeActions(rawText, intent);
    return this.pendingDecomposition.parts.map((part) => ({
      text: part.text,
      description: part.description
    }));
  }

  actionNodesFor({ taskRequest, intent, action, affectedItems, skill }) {
    if (!this.pendingDecomposition) {
      return super.actionNodesFor({ taskRequest, intent, action, affectedItems, skill });
    }
    return this.pendingDecomposition.parts.map((part, index) => {
      const partIntent = {
        actionType: part.actionType,
        label: actionProfiles[part.actionType].label,
        title: part.description,
        category: actionProfiles[part.actionType].category,
        riskHint: actionProfiles[part.actionType].riskHint,
        slots: { ...this.parser.extractSlots(part.text, part.actionType), ...part.slots }
      };
      const partRoute = part.actionType === action.actionType
        ? { skill: { skillId: action.skillId, toolName: action.toolName, version: action.skillVersion } }
        : this.skillRouter.route(partIntent);
      const partSkill = partRoute?.skill ?? skill;
      const partArguments = this.argumentsFor(partIntent, taskRequest, null);
      const partAffected = this.affectedItemsFor(partIntent, partArguments);
      return {
        nodeId: `action_${index + 1}`,
        order: 100 + index + 1,
        module: partSkill.module ?? 'B_PC_AGENT',
        actionType: part.actionType,
        toolName: partSkill.toolName ?? action.toolName,
        skillId: partSkill.skillId ?? action.skillId,
        description: part.description,
        llmPlanned: true,
        arguments: {
          ...partArguments,
          rawText: part.text,
          sequenceIndex: index
        },
        affectedItems: partAffected,
        preconditions: ['ApprovalDecision.approved', 'CapabilityToken.valid'],
        postconditions: ['ExecutionEvidence.available'],
        compensationRef: part.actionType === ActionType.BROWSER_SEARCH || part.actionType === ActionType.LIST_FILES
          ? null
          : `compensate_action_${index + 1}`
      };
    });
  }
}

export function createTaskPlannerFromEnv({ env = process.env, runner = null, clock = () => new Date() } = {}) {
  const enabled = env.JARVIS_LLM_PLANNER === '1' || env.JARVIS_LLM_PLANNER === 'true';
  if (!enabled) return null;
  return new ClaudeCliTaskPlanner({
    command: env.JARVIS_LLM_PLANNER_COMMAND ?? env.JARVIS_LLM_INTENT_COMMAND ?? 'claude',
    model: env.JARVIS_LLM_PLANNER_MODEL ?? env.JARVIS_LLM_INTENT_MODEL ?? 'haiku',
    timeoutMs: Number(env.JARVIS_LLM_PLANNER_TIMEOUT_MS ?? 45000),
    runner,
    clock
  });
}
