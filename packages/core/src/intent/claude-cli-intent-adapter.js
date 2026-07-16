import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ActionType, createIntentCandidate, stableId } from '../../../shared/src/types.js';
import { appendJsonlSync } from '../../../shared/src/jsonl.js';
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
  [ActionType.CAPABILITY_QUERY]: { label: '능력 조회', category: 'system', riskHint: 'read-only-local' },
  [ActionType.MACRO_SAVE]: { label: '작업을 이름 붙여 매크로로 저장', category: 'system', riskHint: 'read-only-local' },
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

// Anthropic API 직접 호출 러너(동기, curl 경유). CLI와 달리 프로세스 시작 오버헤드가 없어 훨씬 빠르다.
// JARVIS_ANTHROPIC_API_KEY가 설정돼 있을 때만 쓰이며, 없으면 기존 claude CLI로 폴백한다.
const apiModelMap = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' };

export function createApiRunner({ apiKey, model = null, timeoutMs = 60000, maxTokens = 8000 }) {
  const apiModel = apiModelMap[model] ?? model ?? 'claude-haiku-4-5';
  return (prompt) => {
    const body = JSON.stringify({ model: apiModel, max_tokens: maxTokens, messages: [{ role: 'user', content: String(prompt ?? '') }] });
    let out;
    try {
      out = execFileSync('curl', [
        '-s', '--max-time', String(Math.max(5, Math.floor(timeoutMs / 1000))),
        'https://api.anthropic.com/v1/messages',
        '-H', `x-api-key: ${apiKey}`, '-H', 'anthropic-version: 2023-06-01', '-H', 'content-type: application/json',
        '-d', '@-'
      ], { input: body, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      throw new Error(`api-runner-error: ${String(error?.message ?? error).slice(0, 200)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error('api-runner: invalid JSON response');
    }
    if (parsed.error) throw new Error(`api: ${parsed.error.message ?? 'unknown'}`);
    // 모델 응답 텍스트만 돌려준다(CLI 러너와 동일하게 이후 extractJsonObject가 파싱).
    return Array.isArray(parsed.content) ? parsed.content.map((b) => b.text ?? '').join('') : '';
  };
}

export function createClaudeCliRunner({
  command = 'claude',
  model = null,
  timeoutMs = 45000,
  shell = process.platform === 'win32',
  apiKey = process.env.JARVIS_ANTHROPIC_API_KEY
} = {}) {
  if (apiKey) return createApiRunner({ apiKey, model, timeoutMs });
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
    // 파일에도 남겨 프로세스 재시작·다른 런타임(코어/브릿지/에이전트)에서도 즉시 재현한다.
    this.payloadCache = new Map();
    this.cachePath = process.env.JARVIS_INTENT_CACHE_PATH
      ?? (process.env.JARVIS_BRIDGE_STATE_DIR ? `${process.env.JARVIS_BRIDGE_STATE_DIR}/intent-cache.jsonl` : 'logs/intent-cache.jsonl');
    this.loadPayloadCache();
  }

  loadPayloadCache() {
    try {
      if (!existsSync(this.cachePath)) return;
      for (const line of readFileSync(this.cachePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const rec = JSON.parse(line);
          if (rec?.key && actionProfiles[rec.payload?.actionType]) this.payloadCache.set(rec.key, rec.payload);
        } catch { /* skip bad line */ }
      }
    } catch { /* cache is optional */ }
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
      if (actionProfiles[payload?.actionType]) {
        this.payloadCache.set(cacheKey, payload);
        try { appendJsonlSync(this.cachePath, { key: cacheKey, payload, at: this.clock().toISOString() }); } catch { /* optional */ }
      }
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
