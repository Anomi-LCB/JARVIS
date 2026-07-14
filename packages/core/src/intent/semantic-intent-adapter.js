import { ActionType, createIntentCandidate, stableId } from '../../../shared/src/types.js';
import { IntentParser } from './intent-parser.js';

export const defaultSemanticIntentProfiles = Object.freeze([
  profile('semantic.create.file', ActionType.CREATE_FILE, '로컬 산출물 생성', 'document', 'local-reversible', [
    '보고서 작성', '문서 만들어', '엑셀 생성', '안내문 작성', '메모 정리', '스프레드시트 만들기',
    '정산표 만들어', '회의록 작성', '파일 생성', '자료 정리해서 문서화'
  ]),
  profile('semantic.list.files', ActionType.LIST_FILES, '파일 목록 조회', 'filesystem', 'read-only-local', [
    '파일 목록 보여줘', '폴더 안 파일 확인', '리스트 조회', '다운로드 폴더 봐', '작업공간 파일 보여줘',
    '문서함 목록 확인', '어떤 파일이 있는지 알려줘'
  ]),
  profile('semantic.move.file', ActionType.MOVE_FILE, '파일 이동', 'filesystem', 'local-change', [
    '파일 옮겨', '폴더로 이동', '다운로드에서 보관함으로 이동', '문서 정리해서 옮겨',
    '파일을 다른 폴더에 넣어', '보관함으로 정리'
  ]),
  profile('semantic.browser.search', ActionType.BROWSER_SEARCH, '브라우저 조사', 'browser', 'read-only-web', [
    '검색해', '뉴스 조사', '웹에서 찾아', '브라우저로 알아봐', '자료 조사', '정보 찾아봐',
    '보안 뉴스 조사', '일정 조사'
  ]),
  profile('semantic.shell.execute', ActionType.SHELL_EXECUTE, '셸 명령 실행', 'system', 'system-command', [
    '명령어 실행해', 'cmd 열어', '터미널에서 실행', '파워쉘 명령', '스크립트 실행',
    '프로그램 실행해', '메모장 열어', '앱 실행해', '명령 프롬프트로', '시스템 정보 알려줘'
  ]),
  profile('semantic.search.files', ActionType.SEARCH_FILES, '파일 검색', 'filesystem', 'read-only-local', [
    '파일 찾아', '문서 어디 있어', '엑셀 파일 검색', '사진 찾아줘', '이 이름 파일 찾아',
    '어제 만든 파일 찾아', '보고서 어디 저장했지', 'pdf 찾아'
  ]),
  profile('semantic.send.email', ActionType.SEND_EMAIL, '메일 전송', 'external', 'external-transfer', [
    '메일로 보내', '이메일 전송', '이 파일 메일로', '메일 발송', '첨부해서 메일 보내',
    '메일로 전달', '이메일로 보내줘'
  ]),
  profile('semantic.edit.document', ActionType.EDIT_DOCUMENT, '문서 내용 편집', 'document', 'local-change', [
    '엑셀 수정해', '표 내용 바꿔', '이 파일 고쳐', '셀 값 수정', '문서 내용 편집',
    '기존 파일에 채워', '엑셀 값 변경'
  ]),
  profile('semantic.capability.query', ActionType.CAPABILITY_QUERY, '능력 조회', 'system', 'read-only-local', [
    '뭘 할 수 있어', '무슨 기능 있어', '어떤 걸 해줄 수 있어', '기능 목록 알려줘',
    '네 능력 알려줘', '할 수 있는 게 뭐야'
  ]),
  profile('semantic.upload.file', ActionType.UPLOAD_FILE, '외부 전송 요청', 'external', 'external-transfer', [
    '메일로 보내', '이메일 전송', '카카오톡 공유', '밴드에 공유', '업로드해', '외부로 전송',
    '파일 전달', '보고서 공유'
  ]),
  profile('semantic.delete.file', ActionType.DELETE_FILE, '삭제 요청', 'filesystem', 'destructive', [
    '파일 삭제', '휴지통으로 보내', '지워', 'remove file', 'delete file', '자료 삭제', '파일 없애'
  ])
]);

export class LocalSemanticIntentAdapter {
  constructor({
    parser = new IntentParser(),
    profiles = defaultSemanticIntentProfiles,
    minConfidence = 0.42,
    adapterId = 'local-semantic-intent-adapter-v1'
  } = {}) {
    this.parser = parser;
    this.profiles = profiles.map((item) => ({
      ...item,
      prototypeVectors: item.prototypes.map((prototype) => vectorize(prototype))
    }));
    this.minConfidence = minConfidence;
    this.adapterId = adapterId;
  }

  parse(rawText, { requestId = 'request', createdAt = new Date().toISOString() } = {}) {
    const text = String(rawText ?? '').trim();
    if (!text) {
      return {
        actionType: null,
        title: '빈 명령',
        label: '빈 명령',
        confidence: 0,
        candidates: [],
        blockedReason: 'empty-command',
        semantic: { adapterId: this.adapterId, matched: false }
      };
    }

    const commandVector = vectorize(text);
    const ranked = this.profiles
      .map((profileItem) => {
        const scores = profileItem.prototypeVectors.map((prototypeVector) => cosine(commandVector, prototypeVector));
        const bestScore = Math.max(...scores);
        const bestIndex = scores.indexOf(bestScore);
        const coverage = tokenCoverage(text, profileItem.prototypes[bestIndex]);
        const confidence = round(Math.min(0.96, 0.32 + bestScore * 0.52 + coverage * 0.18));
        return {
          ...profileItem,
          bestScore: round(bestScore),
          coverage: round(coverage),
          confidence,
          matchedPrototype: profileItem.prototypes[bestIndex]
        };
      })
      .sort((a, b) => b.confidence - a.confidence);

    const candidates = ranked
      .filter((item, index) => index < 4 || item.confidence >= this.minConfidence)
      .map((item) => this.createCandidate({ item, text, requestId, createdAt }));
    const selected = candidates[0];
    if (!selected || selected.confidence < this.minConfidence) {
      const fallback = this.parser.parse(text, { requestId, createdAt });
      return {
        ...fallback,
        reasons: [...(fallback.reasons ?? []), 'semantic_fallback_to_rule_parser'],
        semantic: {
          adapterId: this.adapterId,
          matched: false,
          topScore: selected?.semantic?.score ?? 0,
          fallback: true
        }
      };
    }
    return {
      ...selected,
      title: selected.label,
      candidates,
      semantic: {
        ...selected.semantic,
        matched: true,
        candidateCount: candidates.length
      }
    };
  }

  createCandidate({ item, text, requestId, createdAt }) {
    const candidate = createIntentCandidate({
      intentId: stableId('intent_semantic', `${requestId}:${item.actionType}:${item.profileId}`, createdAt),
      label: item.label,
      actionType: item.actionType,
      category: item.category,
      confidence: item.confidence,
      reasons: [
        `semantic_profile:${item.profileId}`,
        `prototype:${item.matchedPrototype}`,
        `score:${item.bestScore}`,
        `coverage:${item.coverage}`
      ],
      riskHint: item.riskHint,
      slots: this.parser.extractSlots(text, item.actionType),
      entities: this.parser.extractEntities(text),
      missingSlots: this.parser.missingSlots(text, item.actionType),
      complexity: this.parser.complexity(text)
    });
    return {
      ...candidate,
      semantic: {
        adapterId: this.adapterId,
        profileId: item.profileId,
        score: item.bestScore,
        coverage: item.coverage,
        matchedPrototype: item.matchedPrototype
      }
    };
  }
}

export class PolicyGatedSemanticIntentAdapter {
  constructor({
    localAdapter = new LocalSemanticIntentAdapter(),
    externalAdapter = null,
    externalEnabled = false,
    minLocalConfidence = 0.72,
    minExternalConfidence = 0.62,
    adapterId = 'policy-gated-semantic-intent-adapter-v1'
  } = {}) {
    this.localAdapter = localAdapter;
    this.externalAdapter = externalAdapter;
    this.externalEnabled = externalEnabled;
    this.minLocalConfidence = minLocalConfidence;
    this.minExternalConfidence = minExternalConfidence;
    this.adapterId = adapterId;
  }

  parse(rawText, options = {}) {
    const local = this.localAdapter.parse(rawText, options);
    const shouldAskExternal = this.externalEnabled === true
      && this.externalAdapter?.parse
      && (local.unknown === true || local.confidence < this.minLocalConfidence || local.missingSlots?.includes('intent'));
    if (!shouldAskExternal) {
      return this.withPolicyGate(local, {
        usedExternal: false,
        reason: this.externalEnabled ? 'local_confidence_sufficient' : 'external_disabled',
        localConfidence: local.confidence
      });
    }
    const external = this.externalAdapter.parse(rawText, options);
    const externalUsable = Boolean(external?.actionType) && Number(external.confidence ?? 0) >= this.minExternalConfidence;
    const selected = externalUsable && Number(external.confidence ?? 0) >= Number(local.confidence ?? 0)
      ? external
      : local;
    return this.withPolicyGate(selected, {
      usedExternal: selected === external,
      reason: selected === external ? 'external_confidence_selected' : 'external_below_threshold_or_confidence',
      localActionType: local.actionType,
      externalActionType: external?.actionType ?? null,
      localConfidence: local.confidence,
      externalConfidence: external?.confidence ?? null,
      externalAdapterId: external?.semantic?.adapterId ?? this.externalAdapter.adapterId ?? 'external-semantic-adapter'
    }, { local, external });
  }

  withPolicyGate(result, policyGate, { local = null, external = null } = {}) {
    return {
      ...result,
      title: result.title ?? result.label,
      semantic: {
        ...(result.semantic ?? {}),
        adapterId: this.adapterId,
        policyGate: {
          externalEnabled: this.externalEnabled,
          minLocalConfidence: this.minLocalConfidence,
          minExternalConfidence: this.minExternalConfidence,
          ...policyGate
        },
        ...(local ? {
          localCandidate: {
            actionType: local.actionType,
            confidence: local.confidence,
            adapterId: local.semantic?.adapterId ?? null
          }
        } : {}),
        ...(external ? {
          externalCandidate: {
            actionType: external.actionType,
            confidence: external.confidence,
            adapterId: external.semantic?.adapterId ?? this.externalAdapter?.adapterId ?? null
          }
        } : {})
      }
    };
  }
}

function profile(profileId, actionType, label, category, riskHint, prototypes) {
  return { profileId, actionType, label, category, riskHint, prototypes };
}

function vectorize(text) {
  const tokens = tokenize(text);
  const vector = new Map();
  for (const token of tokens) vector.set(token, (vector.get(token) ?? 0) + 1);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const bigram = `${tokens[index]}_${tokens[index + 1]}`;
    vector.set(bigram, (vector.get(bigram) ?? 0) + 0.7);
  }
  const compact = tokens.join('');
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    if (gram.trim().length === 2) vector.set(`char:${gram}`, (vector.get(`char:${gram}`) ?? 0) + 0.25);
  }
  return vector;
}

function tokenize(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.@-]+/gu, ' ')
    .trim();
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .flatMap((token) => normalizeToken(token))
    .filter(Boolean);
}

function normalizeToken(token) {
  const cleaned = token
    .replace(/(으로|에게|한테|에서|부터|까지|을|를|은|는|이|가|에|로|와|과)$/u, '')
    .replace(/(해주세요|해줘|해|줘|합니다|하세요)$/u, '');
  const aliases = {
    xlsx: ['엑셀', '스프레드시트', 'xlsx'],
    txt: ['메모', '텍스트', 'txt'],
    upload: ['전송', '공유', '업로드', '보내', '메일', '이메일', '카톡', '카카오톡', '밴드'],
    create: ['만들', '작성', '생성', '정리'],
    list: ['목록', '리스트', '보여', '조회'],
    move: ['이동', '옮겨', '보관함'],
    search: ['검색', '조사', '찾아', '브라우저', '뉴스'],
    delete: ['삭제', '지워', '휴지통', 'delete', 'remove']
  };
  const expanded = [cleaned];
  for (const [alias, values] of Object.entries(aliases)) {
    if (values.some((value) => cleaned.includes(value))) expanded.push(alias);
  }
  return expanded;
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [key, value] of left.entries()) dot += value * (right.get(key) ?? 0);
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function tokenCoverage(command, prototypeText) {
  const commandTokens = new Set(tokenize(command));
  const prototypeTokens = tokenize(prototypeText);
  if (!prototypeTokens.length) return 0;
  return prototypeTokens.filter((token) => commandTokens.has(token)).length / prototypeTokens.length;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
