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

function preferenceSection(preferenceHints) {
  if (!preferenceHints?.length) return [];
  return [
    '',
    '사용자가 확정한 선호 (문서/계획에 반영하되, 아래 규칙과 충돌하면 규칙이 우선):',
    ...preferenceHints.map((hint) => `- ${hint.statement}`)
  ];
}

export function buildPlanDecompositionPrompt(commandText, { preferenceHints = [] } = {}) {
  const actionLines = Object.entries(actionProfiles)
    .map(([actionType, profile]) => `- ${actionType}: ${profile.label}`)
    .join('\n');
  return [
    '당신은 JARVIS 로컬 비서의 작업 계획 분해기입니다. 사용자 명령을 실행 순서대로 최대 5개의 하위 작업으로 분해하세요.',
    '각 하위 작업의 actionType은 아래 목록에서 정확히 하나를 선택합니다.',
    actionLines,
    ...preferenceSection(preferenceHints),
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

// 명령에 "실제로 채워 넣을 내용/주제"가 있는지 판별한다.
// "메모 만들어"처럼 생성 동사와 파일 종류만 있는 명령은 LLM이 만들어봐야
// 플레이스홀더 템플릿뿐이므로, 로컬 기본 템플릿으로 즉시 처리하고 CLI 왕복(수십 초)을 건너뛴다.
// 구체 주제·수치·항목이 담긴 명령만 콘텐츠 LLM을 태운다.
const contentStopWords = new Set([
  '메모', '문서', '파일', '엑셀', '시트', '표', '보고서', '회의록', '노트', '텍스트',
  '만들어', '만들어줘', '만들기', '생성', '생성해', '생성해줘', '작성', '작성해', '작성해줘',
  '해줘', '해', '줘', '좀', '하나', '새', '새로', '새로운', 'please', '만들', '적어', '적어줘',
  '기록', '기록해', '남겨', '남겨줘', 'txt', 'xlsx', 'csv'
]);

export function commandHasDraftableContent(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  // 수치·기간·비율 등 구체 데이터가 있으면 내용이 있다고 본다.
  if (/\d/.test(raw)) return true;
  const tokens = raw
    .replace(/[.,!?~…()[\]{}'"'"「」·:/\\-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/(으로|로|를|을|이|가|는|은|의|에|와|과|도|만)$/u, ''))
    .filter(Boolean)
    .filter((token) => !contentStopWords.has(token) && !contentStopWords.has(token.toLowerCase()));
  // 생성어/파일종류어를 걷어낸 뒤 남는 유의미 토큰이 있으면 구체 주제가 있는 것.
  return tokens.some((token) => token.length >= 2);
}

export function buildSearchCriteriaPrompt({ text }) {
  return [
    '사용자의 파일 찾기 요청을 검색 조건 JSON으로 변환하세요.',
    '- query: 파일명에 포함될 핵심 단어(공백 구분, 없으면 빈 문자열)',
    '- extensions: 확장자 배열(예 ["xlsx","pdf"]). 특정 안 하면 빈 배열',
    '- modifiedWithinDays: "어제/최근/이번주" 같은 표현을 일수로(없으면 null)',
    '- contentQuery: 파일 "내용"에서 찾아야 하면 그 문자열(파일명 검색이면 빈 문자열)',
    '- scope: "home"(사용자 폴더 전체) | "desktop" | "documents" | "downloads" 중 하나(모르면 "home")',
    '',
    'JSON 객체 하나만 출력한다. 설명/코드펜스 금지.',
    '형식: {"query":"","extensions":[],"modifiedWithinDays":null,"contentQuery":"","scope":"home"}',
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

export function buildEmailPrompt({ text }) {
  return [
    '사용자의 메일 전송 요청을 JSON으로 변환하세요. 실제 발송은 사용자 승인 후에만 이뤄집니다.',
    '- to: 수신자 이메일 주소(요청에 있으면). 이름만 있으면 name에 넣고 to는 빈 문자열',
    '- name: 수신자 이름(있으면)',
    '- subject: 제목(추론해서 자연스럽게)',
    '- body: 본문(요청 맥락에 맞는 정중한 한국어 본문. 서명은 넣지 않는다)',
    '- attachmentQuery: 첨부할 파일을 찾을 이름 키워드(첨부 언급 없으면 빈 문자열)',
    '',
    'JSON 객체 하나만 출력한다. 설명/코드펜스 금지.',
    '형식: {"to":"","name":"","subject":"","body":"","attachmentQuery":""}',
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

export function buildDocumentEditPrompt({ text }) {
  return [
    '사용자의 문서 수정 요청을 JSON으로 변환하세요. 지금은 엑셀(xlsx) 편집만 지원합니다.',
    '- targetQuery: 수정할 파일을 찾을 이름 키워드',
    '- sheet: 시트명(모르면 null → 첫 시트)',
    '- edits: [{"cell":"B2","value":"새 값"}] 형태의 셀 편집 배열. 셀 주소를 모르면',
    '  [{"findText":"찾을 기존값","value":"바꿀 값"}] 형태로 대체 지시',
    '',
    'JSON 객체 하나만 출력한다. 설명/코드펜스 금지.',
    '형식: {"targetQuery":"","sheet":null,"edits":[]}',
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

export function buildShellCommandPrompt({ text, locale = 'ko-KR' }) {
  return [
    '당신은 사용자의 자연어 요청을 Windows PowerShell 명령으로 정확히 번역하는 어시스턴트입니다.',
    '반드시 실행 가능한 PowerShell 명령 한 줄만 만듭니다.',
    '',
    '안전 규칙(엄격히 준수):',
    '- 삭제(Remove-Item, rm, del), 포맷, 디스크 초기화, 시스템 종료/재시작, 레지스트리 삭제,',
    '  권한 변경(icacls/takeown), 계정 변경, 외부 전송(업로드/메일/ftp)은 절대 만들지 않는다.',
    '- 요청이 위 금지 항목이면 command를 빈 문자열로 둔다.',
    '- 조회·검색·목록·정보 확인·프로그램 실행 위주로 만든다.',
    '- 경로가 필요하면 $HOME, $env:USERPROFILE 등 표준 변수를 쓴다.',
    '- 여러 단계가 필요해도 세미콜론으로 한 줄에 담고, 파괴적 연산은 넣지 않는다.',
    '',
    '출력 규칙:',
    '- JSON 객체 하나만 출력한다: {"command":"<powershell 한 줄>"}',
    '- 설명, 마크다운, 코드펜스 금지.',
    `- 응답 언어 기준: ${locale}`,
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

export function buildContentDraftPrompt({ text, outputFormat, fileName, locale = 'ko-KR', preferenceHints = [] }) {
  const format = outputFormat === 'xlsx' ? 'xlsx' : 'txt';
  return [
    '당신은 실무 문서를 작성하는 전문 어시스턴트입니다. 사용자 명령이 요구하는 문서를 실제 업무에 바로 쓸 수 있는 프로 수준으로 완성하세요.',
    '초안이 아니라 완성본을 목표로 합니다. 형식적이거나 뼈대만 있는 결과는 금지합니다.',
    ...preferenceSection(preferenceHints),
    '',
    '품질 기준:',
    '- 실무에서 통용되는 구조와 항목을 갖춘다(적절한 섹션, 표 머리글, 요약/합계, 단위 표기 등).',
    '- 사용자가 명시하지 않았어도 그 문서 유형에서 일반적으로 포함되는 표준 항목·행/열을 충실히 채운다.',
    '- 다만 사용자만 아는 사실(고유명사, 실제 수치, 개인정보)은 지어내지 않고 채울 자리(빈 값 또는 "(입력)" 같은 안내)로 남긴다.',
    '- 날짜가 필요하면 오늘 기준으로 계산해 실제 날짜를 넣는다.',
    '- 분량은 실제로 쓸 만하게. 형식만 보여주는 1~2줄은 금지하되, 과하게 방대하지 않게 핵심을 채운다(표는 대략 10~30행 권장).',
    '',
    '출력 규칙:',
    '- 반드시 JSON 객체 하나만 출력한다. 설명 문장, 마크다운 코드펜스를 붙이지 않는다.',
    `- 문서 언어는 ${locale.startsWith('ko') ? '한국어' : locale}를 기본으로 한다.`,
    format === 'xlsx'
      ? '- xlsx 형식: {"kind":"xlsx","sheetName":"시트명","columns":["열1","열2"],"rows":[["값","값"]]} — 열 최대 20개, 행은 보통 10~30개(최대 200). 합계/소계 행이 자연스러우면 포함한다.'
      : '- txt 형식: {"kind":"txt","content":"문서 본문"} — 제목·섹션 구분·항목을 갖춘 완성된 본문. 최대 20000자.',
    '',
    `요청 형식: ${format}`,
    `오늘 날짜: ${new Date().toISOString().slice(0, 10)}`,
    fileName ? `파일명 힌트: ${fileName}` : null,
    `사용자 명령: ${text}`
  ].filter((line) => line !== null).join('\n');
}

export class ClaudeCliTaskPlanner extends TaskPlanner {
  constructor({
    parser = new IntentParser(),
    skillRouter = new SkillRouter(),
    command = 'claude',
    model = null,
    timeoutMs = 45000,
    maxCommandLength = 2000,
    contentEnabled = false,
    contentModel = 'haiku',
    contentTimeoutMs = 90000,
    contentSmartSkip = true,
    clarifyEnabled = true,
    clarifyConfidenceThreshold = 0.7,
    runner = null,
    contentRunner = null,
    clock = () => new Date(),
    adapterId = 'claude-cli-task-planner-v1'
  } = {}) {
    super();
    this.parser = parser;
    this.skillRouter = skillRouter;
    this.model = model;
    this.contentModel = contentModel;
    this.maxCommandLength = maxCommandLength;
    this.contentEnabled = contentEnabled;
    this.contentSmartSkip = contentSmartSkip;
    this.clarifyEnabled = clarifyEnabled;
    this.clarifyConfidenceThreshold = clarifyConfidenceThreshold;
    this.clock = clock;
    this.adapterId = adapterId;
    this.runner = runner ?? createClaudeCliRunner({ command, model, timeoutMs });
    // 콘텐츠 작성은 프로 품질을 위해 더 강한 모델(기본 sonnet)과 긴 타임아웃을 쓴다.
    this.contentRunner = contentRunner ?? runner ?? createClaudeCliRunner({ command, model: contentModel, timeoutMs: contentTimeoutMs });
    this.contentDraftCache = new Map();
  }

  createPlan(taskRequest, intent, options = {}) {
    this.pendingPreferenceHints = this.preferenceHintsFrom(options.planningContext);
    try {
      const plan = this.createPlanWithLlm(taskRequest, intent, options);
      return this.attachClarification(plan, taskRequest, intent);
    } finally {
      this.pendingPreferenceHints = null;
    }
  }

  // 계획을 어떻게 세웠는지 사람이 읽을 설명 + 애매하면 물어볼 질문을 붙인다.
  attachClarification(plan, taskRequest, intent) {
    const partCount = plan.planGraph?.nodes?.filter((node) => node.nodeId?.startsWith('action_')).length ?? 1;
    const planExplanation = plan.llmPlanning?.summary
      ? `명령을 "${plan.llmPlanning.summary}"(으)로 이해하고 ${partCount}단계로 계획했습니다.`
      : `명령을 "${intent.title ?? intent.label}" 작업으로 이해하고 ${partCount}단계로 계획했습니다.`;
    const ambiguous = intent.unknown === true
      || Number(intent.confidence ?? 1) < this.clarifyConfidenceThreshold
      || (Array.isArray(intent.missingSlots) && intent.missingSlots.includes('intent'));
    const clarifyingQuestions = (this.clarifyEnabled && ambiguous)
      ? this.clarifyingQuestionsFor(taskRequest.command.rawText, intent)
      : [];
    return {
      ...plan,
      planExplanation,
      clarification: {
        adapterId: this.adapterId,
        ambiguous,
        confidence: Number(intent.confidence ?? 1),
        questions: clarifyingQuestions
      }
    };
  }

  clarifyingQuestionsFor(rawText, intent) {
    const text = String(rawText ?? '').trim().slice(0, this.maxCommandLength);
    if (!text) return [];
    const prompt = [
      '당신은 작업 실행 전 요구사항을 확인하는 어시스턴트입니다.',
      '아래 사용자 명령을 실행하기에 애매하거나 정보가 부족한 부분이 있으면, 진행 전에 물어볼 핵심 질문을 최대 3개 만드세요.',
      '충분히 명확하면 빈 배열을 반환합니다. 불필요한 질문은 만들지 않습니다.',
      '반드시 JSON 객체 하나만 출력합니다: {"questions":["질문1","질문2"]}',
      `사용자 명령: ${text}`
    ].join('\n');
    let stdout;
    try {
      stdout = this.runner(prompt);
    } catch {
      return [];
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    if (!Array.isArray(payload?.questions)) return [];
    return payload.questions
      .filter((question) => typeof question === 'string' && question.trim())
      .slice(0, 3)
      .map((question) => question.trim().slice(0, 200));
  }

  preferenceHintsFrom(planningContext) {
    return (planningContext?.confirmedPreferenceHints ?? [])
      .filter((hint) => typeof hint?.statement === 'string' && hint.statement.trim())
      .sort((a, b) => (b.planningWeight ?? 0) - (a.planningWeight ?? 0))
      .slice(0, 5)
      .map((hint) => ({
        preferenceId: hint.preferenceId ?? null,
        statement: hint.statement.trim().slice(0, 200)
      }));
  }

  createPlanWithLlm(taskRequest, intent, options = {}) {
    const decomposition = this.decomposeWithLlm(taskRequest.command.rawText, intent);
    if (!decomposition) {
      const plan = super.createPlan(taskRequest, intent, options);
      return this.pendingPreferenceHints?.length && plan.action.arguments.contentDraft
        ? { ...plan, llmPlanning: { adapterId: this.adapterId, preferenceHintsApplied: this.pendingPreferenceHints.length, ...(plan.llmPlanning ?? {}) } }
        : plan;
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
          preferenceHintsApplied: this.pendingPreferenceHints?.length ?? 0,
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
      stdout = this.runner(buildPlanDecompositionPrompt(text, { preferenceHints: this.pendingPreferenceHints ?? [] }));
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

  argumentsFor(intent, taskRequest, contextSnapshot) {
    const base = super.argumentsFor(intent, taskRequest, contextSnapshot);
    // 셸 실행: 자연어를 안전한 PowerShell 한 줄 명령으로 LLM 변환한다. 실제 명령은 승인 카드에 노출된다.
    if (intent.actionType === ActionType.SHELL_EXECUTE) {
      const command = this.draftShellCommandFor({
        text: intent.slots?.rawCommand ?? taskRequest.command.rawText,
        locale: taskRequest.command?.locale ?? 'ko-KR'
      });
      if (!command) return { ...base, shell: 'powershell' };
      return {
        ...base,
        command,
        shell: 'powershell',
        rawText: taskRequest.command.rawText,
        shellDraft: { adapterId: this.adapterId, draftedByLlm: true }
      };
    }
    // 파일 검색: 자연어에서 검색 조건(이름/확장자/기간/내용)을 뽑는다.
    if (intent.actionType === ActionType.SEARCH_FILES) {
      const criteria = this.draftJsonFor(buildSearchCriteriaPrompt, { text: intent.slots?.rawCommand ?? taskRequest.command.rawText });
      return { ...base, rawText: taskRequest.command.rawText, ...(criteria ?? {}) };
    }
    // 메일 전송: 수신자/제목/본문/첨부 힌트를 뽑는다. 실제 전송은 승인 후 B가 수행.
    if (intent.actionType === ActionType.SEND_EMAIL) {
      const mail = this.draftJsonFor(buildEmailPrompt, { text: intent.slots?.rawCommand ?? taskRequest.command.rawText });
      return { ...base, rawText: taskRequest.command.rawText, ...(mail ?? {}) };
    }
    // 문서 편집: 대상 파일과 편집 지시(셀/값)를 뽑는다.
    if (intent.actionType === ActionType.EDIT_DOCUMENT) {
      const edit = this.draftJsonFor(buildDocumentEditPrompt, { text: intent.slots?.rawCommand ?? taskRequest.command.rawText });
      return { ...base, rawText: taskRequest.command.rawText, ...(edit ?? {}) };
    }
    if (!this.contentEnabled || intent.actionType !== ActionType.CREATE_FILE) return base;
    const sourceText = intent.slots?.llmPartText ?? taskRequest.command.rawText;
    // 채울 내용이 없는 단순 생성 명령은 콘텐츠 LLM을 건너뛰고 로컬 기본 템플릿을 쓴다(수십 초 절감).
    if (this.contentSmartSkip && !commandHasDraftableContent(sourceText)) return base;
    const draft = this.draftContentFor({
      text: sourceText,
      outputFormat: base.outputFormat ?? intent.slots?.outputFormat ?? 'txt',
      fileName: base.fileName ?? intent.slots?.fileName ?? null,
      locale: taskRequest.command?.locale ?? 'ko-KR'
    });
    if (!draft) return base;
    if (draft.kind === 'xlsx' && base.outputFormat === 'xlsx') {
      return {
        ...base,
        sheetName: draft.sheetName ?? base.sheetName,
        columns: draft.columns,
        rows: draft.rows,
        contentDraft: {
          adapterId: this.adapterId,
          kind: 'xlsx',
          draftedByLlm: true,
          appliedPreferences: (this.pendingPreferenceHints ?? []).map((hint) => hint.preferenceId).filter(Boolean)
        }
      };
    }
    if (draft.kind === 'txt' && base.outputFormat !== 'xlsx') {
      return {
        ...base,
        content: draft.content,
        contentDraft: {
          adapterId: this.adapterId,
          kind: 'txt',
          draftedByLlm: true,
          appliedPreferences: (this.pendingPreferenceHints ?? []).map((hint) => hint.preferenceId).filter(Boolean)
        }
      };
    }
    return base;
  }

  // 프롬프트 빌더로 LLM을 호출하고 JSON 객체를 돌려준다(검색/메일/편집 인자 추출용 공통 경로).
  draftJsonFor(promptBuilder, args) {
    const trimmed = String(args?.text ?? '').trim().slice(0, this.maxCommandLength);
    if (!trimmed) return null;
    let stdout;
    try {
      stdout = this.runner(promptBuilder({ ...args, text: trimmed }));
    } catch {
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    return payload && typeof payload === 'object' ? payload : null;
  }

  draftShellCommandFor({ text, locale }) {
    const trimmed = String(text ?? '').trim().slice(0, this.maxCommandLength);
    if (!trimmed) return null;
    let stdout;
    try {
      stdout = this.runner(buildShellCommandPrompt({ text: trimmed, locale }));
    } catch {
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
    if (!command || command.length > 1000) return null;
    // 여러 줄/세미콜론 남용을 막고 한 줄 명령만 허용한다(승인 카드 가독성·안전).
    if (/\r?\n/.test(command)) return null;
    return command;
  }

  draftContentFor({ text, outputFormat, fileName, locale }) {
    const trimmed = String(text ?? '').trim().slice(0, this.maxCommandLength);
    if (!trimmed) return null;
    const preferenceHints = this.pendingPreferenceHints ?? [];
    const cacheKey = `${outputFormat}:${trimmed}:${preferenceHints.map((hint) => hint.statement).join('|')}`;
    if (this.contentDraftCache.has(cacheKey)) return this.contentDraftCache.get(cacheKey);
    let stdout;
    try {
      stdout = this.contentRunner(buildContentDraftPrompt({ text: trimmed, outputFormat, fileName, locale, preferenceHints }));
    } catch {
      this.contentDraftCache.set(cacheKey, null);
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    const draft = this.sanitizeContentDraft(payload);
    this.contentDraftCache.set(cacheKey, draft);
    return draft;
  }

  sanitizeContentDraft(payload) {
    if (payload?.kind === 'xlsx') {
      const columns = Array.isArray(payload.columns)
        ? payload.columns.slice(0, 20).map((column) => String(column).slice(0, 120))
        : [];
      const rows = Array.isArray(payload.rows)
        ? payload.rows
            .slice(0, 200)
            .filter((row) => Array.isArray(row))
            .map((row) => row.slice(0, columns.length || 20).map((cell) => (
              typeof cell === 'number' ? cell : String(cell ?? '').slice(0, 500)
            )))
        : [];
      if (columns.length === 0 || rows.length === 0) return null;
      return {
        kind: 'xlsx',
        sheetName: typeof payload.sheetName === 'string' && payload.sheetName.trim()
          ? payload.sheetName.trim().slice(0, 30)
          : null,
        columns,
        rows
      };
    }
    if (payload?.kind === 'txt' && typeof payload.content === 'string' && payload.content.trim()) {
      return { kind: 'txt', content: payload.content.trim().slice(0, 20000) };
    }
    return null;
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
        slots: { ...this.parser.extractSlots(part.text, part.actionType), ...part.slots, llmPartText: part.text }
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
    contentEnabled: env.JARVIS_LLM_CONTENT === '1' || env.JARVIS_LLM_CONTENT === 'true',
    // 콘텐츠 모델 기본 haiku(프로 프롬프트로 이미 실무 품질, ~35s로 폰 타임아웃 안전).
    // 최고 품질을 원하면 JARVIS_LLM_CONTENT_MODEL=sonnet (지연 편차 큼, 타임아웃도 함께 늘릴 것).
    contentModel: env.JARVIS_LLM_CONTENT_MODEL ?? 'haiku',
    contentTimeoutMs: Number(env.JARVIS_LLM_CONTENT_TIMEOUT_MS ?? 90000),
    // 내용 없는 단순 생성 명령은 콘텐츠 LLM을 건너뛴다(기본 ON). 끄려면 JARVIS_LLM_CONTENT_SMART_SKIP=0.
    contentSmartSkip: env.JARVIS_LLM_CONTENT_SMART_SKIP !== '0' && env.JARVIS_LLM_CONTENT_SMART_SKIP !== 'false',
    runner,
    clock
  });
}
