import { ActionType, createIntentCandidate, stableId } from '../../../shared/src/types.js';

const rules = [
  {
    label: '삭제 요청',
    actionType: ActionType.DELETE_FILE,
    category: 'filesystem',
    riskHint: 'destructive',
    patterns: [/삭제|delete|remove|휴지통|포맷|format/i]
  },
  {
    label: '메일 전송',
    actionType: ActionType.SEND_EMAIL,
    category: 'external',
    riskHint: 'external-transfer',
    // 메일 특정(카톡/밴드는 아래 외부 전송 리뷰로 간다).
    patterns: [/메일|이메일|email|mail/i, /보내|전송|첨부|발송/i]
  },
  {
    label: '외부 전송 요청',
    actionType: ActionType.UPLOAD_FILE,
    category: 'external',
    riskHint: 'external-transfer',
    patterns: [/업로드|공유/i, /카톡|카카오톡|밴드|드라이브/i]
  },
  {
    label: '파일 검색',
    actionType: ActionType.SEARCH_FILES,
    category: 'filesystem',
    riskHint: 'read-only-local',
    // 파일/문서 맥락의 찾기. 웹 검색과 구분한다.
    patterns: [/(파일|문서|폴더|사진|이미지|자료|엑셀|한글|hwp|pdf).*(찾|검색|어디)/i, /(찾아|어디\s*있)/i]
  },
  {
    label: '문서 내용 편집',
    actionType: ActionType.EDIT_DOCUMENT,
    category: 'document',
    riskHint: 'local-change',
    // 기존 파일 수정. 새로 만드는 생성과 구분한다.
    patterns: [/(수정|고쳐|바꿔|편집|변경|채워|덮어).*(파일|문서|엑셀|표|셀|한글|내용)|(파일|문서|엑셀|표|셀).*(수정|고쳐|바꿔|편집|채워)/i]
  },
  {
    label: '셸 명령 실행',
    actionType: ActionType.SHELL_EXECUTE,
    category: 'system',
    riskHint: 'system-command',
    // '실행'처럼 모호한 단어 대신 명확한 셸/시스템 지칭만 매칭한다.
    patterns: [/cmd|command\s*line|명령어|명령 프롬프트|터미널|파워\s*쉘|powershell|셸\b|쉘\b/i, /프로그램.*(실행|열어|켜)|(실행|열어|켜).*프로그램|앱.*(실행|열어)|스크립트.*실행/i]
  },
  {
    label: '브라우저 조사',
    actionType: ActionType.BROWSER_SEARCH,
    category: 'browser',
    riskHint: 'read-only-web',
    patterns: [/검색|조사|찾아|브라우저/i]
  },
  {
    label: '파일 목록 조회',
    actionType: ActionType.LIST_FILES,
    category: 'filesystem',
    riskHint: 'read-only-local',
    patterns: [/목록|리스트|list|폴더.*봐|파일.*보여/i]
  },
  {
    label: '파일 이동',
    actionType: ActionType.MOVE_FILE,
    category: 'filesystem',
    riskHint: 'local-change',
    patterns: [/이동|옮겨|move/i]
  },
  {
    label: '로컬 산출물 생성',
    actionType: ActionType.CREATE_FILE,
    category: 'document',
    riskHint: 'local-reversible',
    patterns: [/엑셀|xlsx|스프레드시트/i, /보고서|안내문|문서|메모/i, /만들|작성|생성/i]
  }
];

const outputFormatPatterns = [
  { format: 'xlsx', pattern: /엑셀|xlsx|스프레드시트/i },
  { format: 'hwp', pattern: /한글|hwp|hwpx|아래아/i },
  { format: 'docx', pattern: /워드|docx/i },
  { format: 'pdf', pattern: /pdf/i },
  { format: 'txt', pattern: /메모|텍스트|txt/i }
];

const destinationPatterns = [
  { destination: 'email', pattern: /메일|이메일/i },
  { destination: 'kakaotalk', pattern: /카톡|카카오톡/i },
  { destination: 'band', pattern: /밴드/i },
  { destination: 'web', pattern: /웹|사이트|업로드/i }
];

const directoryHints = [
  { hint: 'downloads', pattern: /다운로드|download/i },
  { hint: 'desktop', pattern: /바탕화면|desktop/i },
  { hint: 'documents', pattern: /문서함|문서 폴더|documents/i },
  { hint: 'archive', pattern: /보관|archive/i },
  { hint: 'workspace', pattern: /작업공간|workspace/i }
];

const commandTailPattern = /\s*(해줘|해주세요|해|줘|만들어줘|작성해줘|보여줘|알려줘|정리해줘|전송해줘|공유해줘|옮겨줘|이동해줘)\s*$/i;
const fileNameStopwords = new Set(['이', '그', '저', '새', '신규', '엑셀', '보고서', '문서', '파일', '안내문', '메모', '다음', '이번', '오늘', '내일', '주', '월', '년', '로', '으로', '메일', '이메일', '카톡', '카카오톡', '밴드', '보관함', '폴더']);

export class IntentParser {
  parse(rawText, { requestId = 'request', createdAt = new Date().toISOString() } = {}) {
    const text = String(rawText ?? '').trim();
    if (!text) {
      return {
        actionType: null,
        title: '빈 명령',
        label: '빈 명령',
        confidence: 0,
        candidates: [],
        blockedReason: 'empty-command'
      };
    }
    const candidates = rules
      .map((rule) => {
        const matches = rule.patterns.filter((pattern) => pattern.test(text));
        if (!matches.length) return null;
        const confidence = Math.min(0.95, 0.55 + matches.length * 0.25 + Math.min(text.length, 40) / 400);
        return createIntentCandidate({
          intentId: stableId('intent', `${requestId}:${rule.actionType}`, createdAt),
          label: rule.label,
          actionType: rule.actionType,
          category: rule.category,
          confidence,
          reasons: matches.map((pattern) => `keyword:${pattern.source}`),
          riskHint: rule.riskHint,
          slots: this.extractSlots(text, rule.actionType),
          entities: this.extractEntities(text),
          missingSlots: this.missingSlots(text, rule.actionType),
          complexity: this.complexity(text)
        });
      })
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence);
    const selected = candidates[0] ?? createIntentCandidate({
      intentId: stableId('intent', `${requestId}:unknown`, createdAt),
      label: '알 수 없는 요청',
      actionType: ActionType.CREATE_FILE,
      category: 'unknown',
      confidence: 0.35,
      reasons: ['unknown_intent_fallback'],
      riskHint: 'needs-clarification',
      slots: this.extractSlots(text, ActionType.CREATE_FILE),
      entities: this.extractEntities(text),
      missingSlots: ['intent'],
      complexity: this.complexity(text)
    });
    return {
      ...selected,
      title: selected.label,
      candidates: candidates.length ? candidates : [selected],
      unknown: candidates.length === 0
    };
  }

  extractSlots(text, actionType) {
    const outputFormat = outputFormatPatterns.find((item) => item.pattern.test(text))?.format;
    const destination = destinationPatterns.find((item) => item.pattern.test(text))?.destination;
    const fileName = this.extractFileName(text, outputFormat);
    const dateHint = this.extractDateHint(text);
    const topic = this.extractTopic(text, fileName);
    if (actionType === ActionType.BROWSER_SEARCH) {
      return {
        query: this.cleanupCommandText(text.replace(/검색|조사|찾아|브라우저|알아봐|찾아봐/gi, '')) || text,
        dateHint,
        topic
      };
    }
    if (actionType === ActionType.LIST_FILES) {
      return { directoryHint: this.extractDirectoryHint(text) };
    }
    if (actionType === ActionType.SHELL_EXECUTE) {
      // 실제 셸 명령은 planner가 LLM으로 생성한다. 여기서는 원문을 넘긴다.
      return { rawCommand: text, dateHint, topic };
    }
    if (actionType === ActionType.SEARCH_FILES) {
      return { rawCommand: text, fileName, dateHint, topic };
    }
    if (actionType === ActionType.SEND_EMAIL) {
      return { rawCommand: text, recipient: this.extractRecipient(text, 'email'), fileName, dateHint, topic, externalTransfer: true };
    }
    if (actionType === ActionType.EDIT_DOCUMENT) {
      return { rawCommand: text, fileName, dateHint, topic };
    }
    if (actionType === ActionType.MOVE_FILE) {
      return {
        sourceHint: this.extractDirectoryHint(text, { role: 'source' }),
        destinationHint: this.extractDirectoryHint(text, { role: 'destination' }),
        fileName,
        dateHint,
        topic
      };
    }
    if (actionType === ActionType.UPLOAD_FILE) {
      return {
        destination,
        fileName,
        recipientHint: this.extractRecipient(text, destination),
        externalTransfer: true,
        dateHint,
        topic
      };
    }
    if (actionType === ActionType.CREATE_FILE) {
      return {
        outputFormat: outputFormat ?? 'txt',
        fileName,
        targetDirectoryHint: this.extractDirectoryHint(text),
        dateHint,
        topic
      };
    }
    return {};
  }

  extractEntities(text) {
    return {
      hasPhoneNumber: /\b01[016789]-?\d{3,4}-?\d{4}\b/.test(text),
      hasEmailAddress: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text),
      hasMoneyAmount: /\d+\s*(원|만원|달러|usd|krw)/i.test(text),
      hasDate: /\d{4}[-./]\d{1,2}[-./]\d{1,2}|오늘|내일|이번 주|다음 주/.test(text),
      mentionsExternalDestination: destinationPatterns.some((item) => item.pattern.test(text))
    };
  }

  missingSlots(text, actionType) {
    if (actionType === ActionType.UPLOAD_FILE && !destinationPatterns.some((item) => item.pattern.test(text))) {
      return ['destination'];
    }
    if (actionType === ActionType.MOVE_FILE && !/(에서|from).+(로|to)|옮겨|이동/.test(text)) {
      return ['sourcePath', 'destinationPath'];
    }
    return [];
  }

  complexity(text) {
    const connectors = text.match(/그리고|하고|또|후에|그다음|한 뒤|and|then/gi) ?? [];
    const matchedActions = rules.filter((rule) => rule.patterns.some((pattern) => pattern.test(text))).map((rule) => rule.actionType);
    return {
      multiStepHint: connectors.length > 0,
      matchedActionTypes: [...new Set(matchedActions)],
      needsPlanDecomposition: connectors.length > 0 || new Set(matchedActions).size > 1
    };
  }

  extractFileName(text, outputFormat) {
    const quoted = text.match(/["'“”](.+?)["'“”]/)?.[1];
    if (quoted) return this.normalizeFileName(quoted, outputFormat);
    const descriptor = text.match(/((?:[가-힣\w-]+\s*){1,5})(파일|문서|보고서|엑셀|안내문|메모)/);
    if (descriptor) {
      const phrase = descriptor[1]
        .trim()
        .split(/\s+/)
        .map((word) => this.normalizeFileToken(word))
        .filter((word) => word && !fileNameStopwords.has(word))
        .slice(-3)
        .join('-');
      if (phrase) return this.normalizeFileName(phrase, outputFormat);
    }
    const extension = text.match(/([가-힣\w-]+)\.(xlsx|docx|pdf|txt|hwp)\b/i);
    if (extension) return extension[0];
    return null;
  }

  normalizeFileName(name, outputFormat) {
    const cleaned = String(name ?? '')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!cleaned) return null;
    if (/\.(xlsx|docx|pdf|txt|hwp)$/i.test(cleaned)) return cleaned;
    return `${cleaned}.${outputFormat ?? 'txt'}`;
  }

  extractDirectoryHint(text, { role = 'any' } = {}) {
    if (role === 'destination') {
      const destinationWord = text
        .split(/\s+/)
        .map((word) => word.replace(/(으로|로|에)$/u, '').replace(/(폴더|문서함)$/u, ''))
        .filter((word) => word && !/(에서|부터)$/.test(word))
        .reverse()
        .find((word) => directoryHints.some((item) => item.pattern.test(word)));
      if (destinationWord) {
        const matched = directoryHints.find((item) => item.pattern.test(destinationWord));
        if (matched) return matched.hint;
      }
    }
    if (role === 'source') {
      const directional = text.match(/([가-힣\w-]+)\s*(?:폴더|문서함)?(?:에서|부터)/);
      if (directional) {
        const matched = directoryHints.find((item) => item.pattern.test(directional[1]));
        if (matched) return matched.hint;
      }
    }
    return directoryHints.find((item) => item.pattern.test(text))?.hint ?? 'workspace';
  }

  extractRecipient(text, destination) {
    if (!destination) return null;
    const recipient = text.match(/([가-힣\w.-]+)\s*(?:에게|한테|로|으로)\s*(?:메일|이메일|카톡|카카오톡|밴드)/i)?.[1];
    if (recipient && !destinationPatterns.some((item) => item.pattern.test(recipient))) return recipient;
    return null;
  }

  extractDateHint(text) {
    return text.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}|오늘|내일|이번 주|다음 주|이번 달|다음 달/)?.[0] ?? null;
  }

  extractTopic(text, fileName) {
    if (fileName) return fileName.replace(/\.(xlsx|docx|pdf|txt|hwp)$/i, '');
    const cleaned = this.cleanupCommandText(text.replace(/검색|조사|찾아|브라우저|목록|리스트|파일|폴더|보여|만들|작성|생성|전송|공유|업로드/gi, ''));
    return cleaned || null;
  }

  cleanupCommandText(text) {
    return String(text ?? '').replace(commandTailPattern, '').replace(/\s+/g, ' ').trim();
  }

  normalizeFileToken(word) {
    const raw = String(word ?? '').trim();
    if (!raw || /(에게|한테)$/.test(raw) || /\d+\s*(원|만원|달러|usd|krw)$/i.test(raw)) return null;
    const normalized = raw.replace(/(으로|에게|한테|에서|부터|까지|을|를|은|는|이|가|에|로)$/u, '');
    if (directoryHints.some((item) => item.pattern.test(normalized))) return null;
    if (/(검색|조사|찾아|만들|작성|생성|전송|공유|옮겨|이동)(하고)?$/u.test(normalized)) return null;
    return normalized;
  }
}
