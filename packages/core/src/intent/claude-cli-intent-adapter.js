import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ActionType, createIntentCandidate, stableId } from '../../../shared/src/types.js';
import { IntentParser } from './intent-parser.js';
import { LocalSemanticIntentAdapter, PolicyGatedSemanticIntentAdapter } from './semantic-intent-adapter.js';

// LLM은 actionType 선택만 담당한다. 리스크 메타데이터는 이 고정 테이블에서만 부여되므로
// 모델 출력이 위험 등급을 낮추거나 카테고리를 조작할 수 없다.
export const actionProfiles = Object.freeze({
  [ActionType.CREATE_FILE]: { label: '로컬 산출물 생성', category: 'document', riskHint: 'local-reversible' },
  [ActionType.LIST_FILES]: { label: '파일 목록 조회', category: 'filesystem', riskHint: 'read-only-local' },
  [ActionType.COPY_FILE]: { label: '파일 복사', category: 'filesystem', riskHint: 'local-change' },
  [ActionType.MOVE_FILE]: { label: '파일 이동', category: 'filesystem', riskHint: 'local-change' },
  [ActionType.BROWSER_SEARCH]: { label: '브라우저 조사', category: 'browser', riskHint: 'read-only-web' },
  [ActionType.SHELL_EXECUTE]: { label: '셸 명령 실행', category: 'system', riskHint: 'system-command' },
  [ActionType.SEARCH_FILES]: { label: '파일 검색', category: 'filesystem', riskHint: 'read-only-local' },
  [ActionType.SEND_EMAIL]: { label: '메일 전송', category: 'external', riskHint: 'external-transfer' },
  [ActionType.EDIT_DOCUMENT]: { label: '문서 내용 편집', category: 'document', riskHint: 'local-change' },
  [ActionType.UPLOAD_FILE]: { label: '외부 전송 요청', category: 'external', riskHint: 'external-transfer' },
  [ActionType.DELETE_FILE]: { label: '삭제 요청', category: 'filesystem', riskHint: 'destructive' },
  [ActionType.MAKE_PAYMENT]: { label: '결제 요청', category: 'external', riskHint: 'forbidden' },
  [ActionType.CHANGE_SYSTEM_SETTING]: { label: '시스템 설정 변경', category: 'system', riskHint: 'forbidden' },
  [ActionType.READ_SECRET]: { label: '비밀정보 접근', category: 'system', riskHint: 'forbidden' }
});

const mergeableSlotKeys = Object.freeze(['fileName', 'outputFormat', 'destination', 'directoryHint', 'query', 'topic', 'dateHint']);

export function buildIntentPrompt(commandText) {
  const actionLines = Object.entries(actionProfiles)
    .map(([actionType, profile]) => `- ${actionType}: ${profile.label}`)
    .join('\n');
  return [
    '당신은 JARVIS 로컬 비서의 의도 분류기입니다. 사용자 명령을 아래 actionType 중 정확히 하나로 분류하세요.',
    actionLines,
    '',
    '규칙:',
    '- 반드시 JSON 객체 하나만 출력한다. 설명 문장, 마크다운 코드펜스를 붙이지 않는다.',
    '- confidence는 0과 1 사이 숫자로, 분류 확신도를 나타낸다.',
    '- slots에는 명령에서 읽어낸 값만 채우고 없으면 null로 둔다.',
    '',
    '출력 형식:',
    '{"actionType":"...","confidence":0.0,"reasons":["짧은 근거 1","짧은 근거 2"],"slots":{"fileName":null,"outputFormat":null,"destination":null,"directoryHint":null,"query":null,"topic":null,"dateHint":null}}',
    '',
    `사용자 명령: ${commandText}`
  ].join('\n');
}

export function createClaudeCliRunner({
  command = 'claude',
  model = null,
  timeoutMs = 45000,
  shell = process.platform === 'win32'
} = {}) {
  return defaultRunner({ command, model, timeoutMs, shell });
}

function defaultRunner({ command, model, timeoutMs, shell }) {
  return (prompt) => {
    const _startedAt = Date.now();
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    // 인자는 전부 고정 리터럴이고 사용자 텍스트는 stdin으로만 전달된다.
    // win32에서는 .cmd 셔틀 해석을 위해 셸 모드로 단일 커맨드 문자열을 사용한다.
    const result = shell
      ? spawnSync([command, ...args].join(' '), {
          input: prompt,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          shell: true,
          maxBuffer: 4 * 1024 * 1024
        })
      : spawnSync(command, args, {
          input: prompt,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024
        });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`claude-cli exited with ${result.status}: ${String(result.stderr ?? '').slice(0, 400)}`);
    }
    if (process.env.JARVIS_TIMING) {
      const head = String(prompt ?? '').slice(0, 50).replace(/\s+/g, ' ');
      process.stderr.write(`[LLM ${Date.now() - _startedAt}ms ${model ?? 'default'}] ${head}\n`);
    }
    return String(result.stdout ?? '');
  };
}

export function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class ClaudeCliSemanticIntentAdapter {
  constructor({
    parser = new IntentParser(),
    command = 'claude',
    model = null,
    timeoutMs = 45000,
    maxCommandLength = 2000,
    runner = null,
    clock = () => new Date(),
    adapterId = 'claude-cli-semantic-intent-adapter-v1'
  } = {}) {
    this.parser = parser;
    this.command = command;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxCommandLength = maxCommandLength;
    this.clock = clock;
    this.adapterId = adapterId;
    this.runner = runner ?? defaultRunner({
      command,
      model,
      timeoutMs,
      shell: process.platform === 'win32'
    });
    // 결정화: (자연어→의도) 판정을 캐시해 같은 요청이면 claude 호출을 건너뛴다.
    this.payloadCache = new Map();
  }

  parse(rawText, { requestId = 'request', createdAt = this.clock().toISOString() } = {}) {
    const text = String(rawText ?? '').trim().slice(0, this.maxCommandLength);
    if (!text) return this.failure('empty-command', { requestId });
    const cacheKey = text.toLowerCase().replace(/\s+/g, ' ');
    const prompt = buildIntentPrompt(text);
    const startedAt = Date.now();
    let payload;
    let latencyMs;
    if (this.payloadCache.has(cacheKey)) {
      payload = this.payloadCache.get(cacheKey);
      latencyMs = 0;
    } else {
      let stdout;
      try {
        stdout = this.runner(prompt);
      } catch (error) {
        return this.failure(`cli-error:${error.message ?? error}`, { requestId });
      }
      latencyMs = Date.now() - startedAt;
      // --output-format json 래퍼({"result": "..."})와 모델이 직접 낸 JSON 둘 다 허용한다.
      const wrapper = extractJsonObject(stdout);
      payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
      if (actionProfiles[payload?.actionType]) this.payloadCache.set(cacheKey, payload);
    }
    const profile = actionProfiles[payload?.actionType];
    if (!profile) return this.failure('unrecognized-action-type', { requestId, latencyMs });

    const confidence = clampConfidence(payload.confidence);
    const ruleSlots = this.parser.extractSlots(text, payload.actionType);
    const slots = { ...ruleSlots };
    for (const key of mergeableSlotKeys) {
      const value = payload.slots?.[key];
      if ((slots[key] === undefined || slots[key] === null || slots[key] === '') && typeof value === 'string' && value.trim()) {
        slots[key] = value.trim().slice(0, 200);
      }
    }
    const reasons = Array.isArray(payload.reasons)
      ? payload.reasons.filter((item) => typeof item === 'string').slice(0, 4).map((item) => `llm:${item.slice(0, 120)}`)
      : [];
    const candidate = createIntentCandidate({
      intentId: stableId('intent_llm', `${requestId}:${payload.actionType}`, createdAt),
      label: profile.label,
      actionType: payload.actionType,
      category: profile.category,
      confidence,
      reasons: [`llm_adapter:${this.adapterId}`, ...reasons],
      riskHint: profile.riskHint,
      slots,
      entities: this.parser.extractEntities(text),
      missingSlots: this.parser.missingSlots(text, payload.actionType),
      complexity: this.parser.complexity(text)
    });
    return {
      ...candidate,
      title: candidate.label,
      candidates: [candidate],
      semantic: {
        adapterId: this.adapterId,
        matched: true,
        model: this.model ?? 'cli-default',
        latencyMs,
        externalService: 'anthropic-claude-cli',
        rawCommandSharedWithModel: true,
        promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16)
      }
    };
  }

  failure(reason, { requestId, latencyMs = 0 } = {}) {
    return {
      actionType: null,
      label: 'LLM 분류 실패',
      title: 'LLM 분류 실패',
      confidence: 0,
      candidates: [],
      blockedReason: null,
      semantic: {
        adapterId: this.adapterId,
        matched: false,
        failed: true,
        failureReason: String(reason).slice(0, 300),
        latencyMs,
        requestId
      }
    };
  }
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  // 외부 모델의 자기보고 확신도는 로컬 규칙 파서보다 높게 신뢰하지 않는다.
  return Math.min(0.93, Math.max(0, Math.round(numeric * 1000) / 1000));
}

export function createIntentParserFromEnv({ env = process.env, runner = null, clock = () => new Date() } = {}) {
  const enabled = env.JARVIS_LLM_INTENT === '1' || env.JARVIS_LLM_INTENT === 'true';
  if (!enabled) return null;
  return new PolicyGatedSemanticIntentAdapter({
    localAdapter: new LocalSemanticIntentAdapter(),
    externalAdapter: new ClaudeCliSemanticIntentAdapter({
      command: env.JARVIS_LLM_INTENT_COMMAND ?? 'claude',
      model: env.JARVIS_LLM_INTENT_MODEL ?? 'haiku',
      timeoutMs: Number(env.JARVIS_LLM_INTENT_TIMEOUT_MS ?? 45000),
      runner,
      clock
    }),
    externalEnabled: true,
    minLocalConfidence: Number(env.JARVIS_LLM_INTENT_MIN_LOCAL_CONFIDENCE ?? 0.72),
    minExternalConfidence: Number(env.JARVIS_LLM_INTENT_MIN_EXTERNAL_CONFIDENCE ?? 0.55)
  });
}
