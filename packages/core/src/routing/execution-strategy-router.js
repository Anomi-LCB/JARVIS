const ExecutionChannel = Object.freeze({
  DETERMINISTIC_LOCAL: 'deterministic-local',
  STRUCTURED_LOCAL: 'structured-local',
  SERVICE_API: 'service-api',
  MCP_CONNECTOR: 'mcp-connector',
  HOSTED_AI_TOOL: 'hosted-ai-tool',
  WEB_DOM: 'web-dom',
  SHELL: 'shell',
  DESKTOP_UIA: 'desktop-uia',
  DESKTOP_VISION: 'desktop-vision',
  POLICY_REVIEW: 'policy-review'
});

const routePreference = Object.freeze([
  ExecutionChannel.DETERMINISTIC_LOCAL,
  ExecutionChannel.STRUCTURED_LOCAL,
  ExecutionChannel.SERVICE_API,
  ExecutionChannel.MCP_CONNECTOR,
  ExecutionChannel.HOSTED_AI_TOOL,
  ExecutionChannel.WEB_DOM,
  ExecutionChannel.SHELL,
  ExecutionChannel.DESKTOP_UIA,
  ExecutionChannel.DESKTOP_VISION,
  ExecutionChannel.POLICY_REVIEW
]);

const defaultProfiles = Object.freeze({
  'capability.describe': profile(ExecutionChannel.DETERMINISTIC_LOCAL, 15, 0.999, 0, []),
  'filesystem.listFiles': profile(ExecutionChannel.DETERMINISTIC_LOCAL, 25, 0.995, 0, ['shell.execute']),
  'filesystem.searchFiles': profile(ExecutionChannel.DETERMINISTIC_LOCAL, 60, 0.99, 0, ['shell.execute']),
  'filesystem.readText': profile(ExecutionChannel.DETERMINISTIC_LOCAL, 35, 0.995, 0, ['shell.execute']),
  'filesystem.createTextFile': profile(ExecutionChannel.STRUCTURED_LOCAL, 45, 0.995, 0, ['desktop.control']),
  'filesystem.moveFiles': profile(ExecutionChannel.STRUCTURED_LOCAL, 80, 0.99, 0, ['shell.execute', 'desktop.control']),
  'filesystem.previewMoveFiles': profile(ExecutionChannel.DETERMINISTIC_LOCAL, 35, 0.995, 0, []),
  'visual.createCards': profile(ExecutionChannel.STRUCTURED_LOCAL, 500, 0.97, 0, ['desktop.control']),
  'archive.createZip': profile(ExecutionChannel.STRUCTURED_LOCAL, 180, 0.99, 0, ['shell.execute']),
  'excel.createWorkbook': profile(ExecutionChannel.STRUCTURED_LOCAL, 250, 0.98, 0, ['desktop.control']),
  'document.edit': profile(ExecutionChannel.STRUCTURED_LOCAL, 350, 0.96, 0, ['desktop.control']),
  'word.create': profile(ExecutionChannel.STRUCTURED_LOCAL, 280, 0.98, 0, ['desktop.control']),
  'powerpoint.create': profile(ExecutionChannel.STRUCTURED_LOCAL, 350, 0.97, 0, ['desktop.control']),
  'hwp.create': profile(ExecutionChannel.STRUCTURED_LOCAL, 700, 0.9, 0, ['desktop.control']),
  'weather.createHwpReport': profile(ExecutionChannel.SERVICE_API, 2600, 0.94, 0, ['hwp.create', 'desktop.control']),
  'macro.save': profile(ExecutionChannel.DETERMINISTIC_LOCAL, 20, 0.995, 0, []),
  'email.send': profile(ExecutionChannel.SERVICE_API, 900, 0.95, 0, ['desktop.control']),
  'news.fetchHeadlines': profile(ExecutionChannel.SERVICE_API, 850, 0.96, 0, ['browser.search']),
  'news.fetchPublisherFeed': profile(ExecutionChannel.SERVICE_API, 900, 0.96, 0, ['browser.search']),
  'news.fetchArticle': profile(ExecutionChannel.SERVICE_API, 1800, 0.94, 0, ['browser.search']),
  'browser.search': profile(ExecutionChannel.WEB_DOM, 2200, 0.88, 0, ['desktop.control']),
  'shell.execute': profile(ExecutionChannel.SHELL, 450, 0.86, 1, ['desktop.control']),
  'desktop.control': profile(ExecutionChannel.DESKTOP_UIA, 1800, 0.78, 1, []),
  'externalTransfer.reviewOnly': profile(ExecutionChannel.POLICY_REVIEW, 30, 0.999, 0, [])
});

const genericFallbackTools = Object.freeze(['shell.execute', 'desktop.control']);

const creationToolNames = new Set([
  'visual.createCards',
  'archive.createZip',
  'excel.createWorkbook',
  'word.create',
  'powerpoint.create',
  'hwp.create',
  'filesystem.createTextFile'
]);

const explicitObjectiveToolRules = Object.freeze([
  ['news.fetchPublisherFeed', /(?:게시자|언론사|원문사).{0,24}(?:RSS|피드)|(?:RSS|피드).{0,30}https:\/\//iu],
  ['news.fetchArticle', /https?:\/\/[^\s]+.{0,80}(?:기사|본문|원문)|(?:기사|본문|원문).{0,80}https?:\/\//iu],
  ['filesystem.moveFiles', /(?:파일|문서|결과물|산출물)?.{0,40}(?:이동|옮겨|옮기)|\bmove\b/iu],
  ['filesystem.listFiles', /(?:폴더|디렉터리).{0,40}(?:나열|목록|리스트)|(?:나열|목록|리스트).{0,40}(?:폴더|디렉터리)|(?:다시\s*)?나열/iu],
  ['visual.createCards', /\.png\b|\bpng\b|(?:뉴스\s*)?카드(?:\s*이미지)?/iu],
  ['archive.createZip', /\.zip\b|\bzip\b|압축|묶어|묶고|묶은|묶음|패키지/iu],
  ['excel.createWorkbook', /\.xlsx\b|\bxlsx\b|엑셀|스프레드시트|워크북/iu],
  ['word.create', /\.docx\b|\bdocx\b|워드(?:\s*문서)?|\bword\s+document/iu],
  ['powerpoint.create', /\.pptx\b|\bpptx?\b|파워포인트|프레젠테이션|슬라이드(?:\s*자료|\s*덱)?/iu],
  ['hwp.create', /\.hwpx?\b|\bhwpx?\b|한글\s*(?:문서|파일)|아래아|한컴/iu],
  ['email.send', /(?:메일|이메일).{0,100}(?:보내|전송|발송)|(?:보내|전송|발송).{0,100}(?:메일|이메일)|\b(?:send\s+email|email\s+send)\b/iu],
  ['news.fetchHeadlines', /핫\s*뉴스|오늘.{0,20}뉴스|(?:최신|주요).{0,12}뉴스|뉴스.{0,30}(?:검색|수집|요약)|\bnews\b|\bheadline/iu],
  ['browser.search', /웹.{0,24}(?:검색|조사|읽)|(?:검색|조사).{0,24}웹|공식\s*(?:문서|자료).{0,40}(?:직접\s*)?읽|https?:\/\//iu],
  ['filesystem.createTextFile', /\.(?:md|txt|json|jsonl|csv|html|xml|ya?ml|log)\b.{0,100}(?:만들|작성|저장|생성|기록|내보내|정리|명시)|(?:만들|작성|저장|생성|기록|내보내|정리|명시).{0,100}\.(?:md|txt|json|jsonl|csv|html|xml|ya?ml|log)\b/iu],
  ['filesystem.readText', /\.(?:md|txt|json|jsonl|csv|html|xml|ya?ml|log)\b.{0,80}(?:다시\s*)?(?:읽|열어)|(?:다시\s*)?(?:읽|열어).{0,80}\.(?:md|txt|json|jsonl|csv|html|xml|ya?ml|log)\b/iu],
  ['filesystem.searchFiles', /workspace.{0,80}(?:다시\s*)?(?:찾|검색)|(?:파일명으로|산출물|결과물|파일).{0,50}(?:다시\s*)?(?:찾|검색)/iu]
]);

export class ExecutionStrategyRouter {
  constructor({ profiles = {}, maxCatalogSize = 12, healthRegistry = null } = {}) {
    this.profiles = { ...defaultProfiles, ...profiles };
    this.maxCatalogSize = clampInteger(maxCatalogSize, 4, 64, 12);
    this.healthRegistry = healthRegistry;
  }

  profileFor(skill = {}) {
    const explicit = skill.execution ?? skill.executionStrategy?.profile ?? null;
    const inferred = this.profiles[skill.toolName] ?? inferProfile(skill);
    return normalizeProfile({ ...inferred, ...(explicit ?? {}) });
  }

  strategyFor(skill, { objective = '', constraints = [], availableSkills = [] } = {}) {
    const scored = this.score(skill, { objective, constraints });
    const availableTools = new Set(availableSkills.map((item) => item.toolName));
    const fallbackToolNames = unique([
      ...scored.profile.fallbackToolNames,
      ...genericFallbackTools
    ]).filter((toolName) => toolName !== skill.toolName && availableTools.has(toolName));
    return {
      strategyVersion: 'a-execution-strategy-v1',
      channel: scored.profile.channel,
      planningMode: scored.profile.planningMode,
      structured: scored.profile.structured,
      local: scored.profile.local,
      expectedLatencyMs: scored.profile.expectedLatencyMs,
      reliability: scored.profile.reliability,
      profileMeasurement: 'configured-estimate',
      observedMeasurement: scored.health?.sampleCount > 0 ? 'tool-health-samples' : 'unmeasured',
      modelRoundTrips: scored.profile.modelRoundTrips,
      health: compactHealth(scored.health),
      score: scored.score,
      reasons: scored.reasons,
      fallbackToolNames,
      preferenceOrder: routePreference
    };
  }

  score(skill, { objective = '', constraints = [] } = {}) {
    const profile = this.profileFor(skill);
    const health = this.healthStatusFor(skill.toolName);
    const signals = objectiveSignals(objective, constraints);
    const reasons = [`channel:${profile.channel}`];
    let score = profile.reliability * 60;
    score += profile.structured ? 18 : 0;
    score += profile.local ? 10 : 0;
    score -= Math.log10(Math.max(10, profile.expectedLatencyMs)) * 6;
    score -= profile.modelRoundTrips * 10;

    const keywordMatches = matchingKeywords(skill, signals.text);
    if (keywordMatches.length > 0) {
      score += Math.min(60, 18 + keywordMatches.length * 8);
      reasons.push(`objective-keywords:${keywordMatches.join(',')}`);
    }
    if (signals.preferLocal && profile.local) {
      score += 28;
      reasons.push('constraint:prefer-local');
    }
    if (signals.preferLocal && !profile.local) score -= 22;
    if (signals.offline && !profile.local) {
      score -= 200;
      reasons.push('constraint:offline-external-blocked');
    }
    if (signals.requiresLiveData && supportsLiveRetrieval(skill, profile)) {
      score += 42;
      reasons.push('objective:live-data');
    }
    if (signals.requiresWebInteraction && (
      [ExecutionChannel.MCP_CONNECTOR, ExecutionChannel.HOSTED_AI_TOOL, ExecutionChannel.WEB_DOM].includes(profile.channel)
      || (profile.channel === ExecutionChannel.SERVICE_API && keywordMatches.length > 0)
    )) {
      score += 36;
      reasons.push('objective:web-workflow');
    }
    if (signals.requiresDesktop && [ExecutionChannel.DESKTOP_UIA, ExecutionChannel.DESKTOP_VISION].includes(profile.channel)) {
      score += 48;
      reasons.push('objective:desktop-interaction');
    }
    if (signals.requiresShell && profile.channel === ExecutionChannel.SHELL) {
      score += 48;
      reasons.push('objective:shell');
    }
    if (signals.requiresFileSearch && skill.toolName === 'filesystem.searchFiles') {
      score += 42;
      reasons.push('objective:named-file-search');
    }
    if (signals.requiresFileSearch && skill.toolName === 'filesystem.listFiles') score -= 12;
    if (signals.requiresFileList && skill.toolName === 'filesystem.listFiles') {
      score += 36;
      reasons.push('objective:file-list');
    }
    if (signals.requiresExternalTransfer && !signals.prohibitsExternalTransfer && skill.capability?.externalTransfer === true) {
      score += 44;
      reasons.push('objective:external-transfer');
    }
    if (signals.prohibitsExternalTransfer && skill.capability?.externalTransfer === true) {
      score -= 180;
      reasons.push('constraint:external-transfer-blocked');
    }
    if (skill.toolName === 'macro.save' && !signals.requiresMacroSave) {
      score -= 300;
      reasons.push('objective:macro-not-requested');
    }
    if (skill.toolName === 'capability.describe' && !signals.requiresCapabilityDescription) {
      score -= 300;
      reasons.push('objective:capability-description-not-requested');
    }
    if (skill.toolName === 'externalTransfer.reviewOnly' && !signals.requiresTransferReview) {
      score -= 300;
      reasons.push('objective:transfer-review-not-requested');
    }
    if (signals.highPrivacy && !profile.local) {
      score -= 55;
      reasons.push('constraint:privacy-external-penalty');
    }
    if (health?.sampleCount > 0) {
      const confidence = Math.min(1, health.sampleCount / 8);
      score += (health.observedReliability - profile.reliability) * 55 * confidence;
      if (health.p50LatencyMs > 0) {
        score += clampNumber(Math.log2(profile.expectedLatencyMs / health.p50LatencyMs) * 6 * confidence, -18, 18, 0);
      }
      reasons.push(`health:observed:${health.successCount}/${health.sampleCount}`);
    }
    if (health?.circuitState === 'open') {
      score -= 500;
      reasons.push('health:circuit-open');
    } else if (health?.circuitState === 'half_open') {
      score -= 70;
      reasons.push('health:circuit-half-open');
    }
    if (skill.lifecycle?.routable === false) score -= 1000;
    return { score: Math.round(score * 100) / 100, reasons, profile, health };
  }

  rank(skills = [], context = {}) {
    return skills
      .map((skill) => ({ skill, ...this.score(skill, context) }))
      .sort((left, right) => right.score - left.score || left.skill.toolName.localeCompare(right.skill.toolName));
  }

  shortlist(capabilities = [], { objective = '', constraints = [], maxTools = this.maxCatalogSize } = {}) {
    const boundedMax = clampInteger(maxTools, 4, 64, this.maxCatalogSize);
    const ranked = this.rank(capabilities, { objective, constraints });
    const byTool = new Map(ranked.map((candidate) => [candidate.skill.toolName, candidate]));
    const pinnedCandidates = ranked
      .filter((candidate) => explicitObjectiveToolNames(objective).includes(candidate.skill.toolName))
      .slice(0, boundedMax);
    const pinnedTools = new Set(pinnedCandidates.map((candidate) => candidate.skill.toolName));
    const selected = [...pinnedCandidates];
    const selectedTools = new Set(pinnedTools);
    for (const candidate of ranked) {
      if (selected.length >= boundedMax) break;
      if (selectedTools.has(candidate.skill.toolName)) continue;
      selected.push(candidate);
      selectedTools.add(candidate.skill.toolName);
    }

    for (const candidate of [...selected]) {
      for (const fallbackToolName of candidate.profile.fallbackToolNames) {
        if (selectedTools.has(fallbackToolName) || !byTool.has(fallbackToolName)) continue;
        if (selected.length >= boundedMax) {
          const replaceIndex = findReplaceableIndex(selected, selectedTools, candidate.skill.toolName, pinnedTools);
          if (replaceIndex < 0) continue;
          selectedTools.delete(selected[replaceIndex].skill.toolName);
          selected.splice(replaceIndex, 1);
        }
        selected.push(byTool.get(fallbackToolName));
        selectedTools.add(fallbackToolName);
      }
    }

    selected.sort((left, right) => right.score - left.score || left.skill.toolName.localeCompare(right.skill.toolName));
    const decorated = selected.map((candidate, index) => ({
      ...candidate.skill,
      executionStrategy: {
        ...this.strategyFor(candidate.skill, { objective, constraints, availableSkills: capabilities }),
        rank: index + 1
      }
    }));
    const deferredToolNames = ranked
      .map((candidate) => candidate.skill.toolName)
      .filter((toolName) => !selectedTools.has(toolName));
    return {
      selectionVersion: 'a-deferred-tool-selection-v1',
      totalCount: capabilities.length,
      selectedCount: decorated.length,
      deferredCount: deferredToolNames.length,
      maxTools: boundedMax,
      pinnedToolNames: [...pinnedTools],
      selectedToolNames: decorated.map((capability) => capability.toolName),
      deferredToolNames,
      capabilities: decorated
    };
  }

  fabricStatus(skills = []) {
    const channels = new Map();
    for (const skill of skills) {
      const channel = this.profileFor(skill).channel;
      const current = channels.get(channel) ?? { channel, skillCount: 0, tools: [] };
      current.skillCount += 1;
      current.tools.push(skill.toolName);
      channels.set(channel, current);
    }
    const availableChannels = [...channels.values()]
      .map((channel) => ({
        ...channel,
        health: summarizeChannelHealth(channel.tools.map((toolName) => this.healthStatusFor(toolName)).filter(Boolean))
      }))
      .sort((left, right) => routePreference.indexOf(left.channel) - routePreference.indexOf(right.channel));
    const missingChannels = routePreference.filter((channel) => !channels.has(channel));
    const health = this.healthRegistry?.snapshot?.(skills.map((skill) => skill.toolName)) ?? null;
    return {
      fabricVersion: 'a-adaptive-execution-fabric-v2',
      skillCount: skills.length,
      availableChannels,
      missingChannels,
      preferredOrder: routePreference,
      adaptiveRouting: {
        enabled: Boolean(this.healthRegistry),
        observedToolCount: health?.summary?.observedToolCount ?? 0,
        openCircuitCount: health?.summary?.openCircuitCount ?? 0,
        halfOpenCircuitCount: health?.summary?.halfOpenCircuitCount ?? 0,
        persistenceEnabled: health?.persistence?.enabled ?? false
      },
      deferredToolSelection: {
        enabled: true,
        maxCatalogSize: this.maxCatalogSize
      }
    };
  }

  healthStatusFor(toolName) {
    return this.healthRegistry?.statusFor?.(toolName) ?? null;
  }

  recordExecution(sample) {
    return this.healthRegistry?.record?.(sample) ?? null;
  }
}

export { ExecutionChannel, routePreference };

function profile(channel, expectedLatencyMs, reliability, modelRoundTrips, fallbackToolNames) {
  return normalizeProfile({ channel, expectedLatencyMs, reliability, modelRoundTrips, fallbackToolNames });
}

function normalizeProfile(value = {}) {
  const channel = routePreference.includes(value.channel) ? value.channel : ExecutionChannel.STRUCTURED_LOCAL;
  const structured = value.structured ?? ![ExecutionChannel.SHELL, ExecutionChannel.DESKTOP_VISION].includes(channel);
  const local = value.local ?? [
    ExecutionChannel.DETERMINISTIC_LOCAL,
    ExecutionChannel.STRUCTURED_LOCAL,
    ExecutionChannel.SHELL,
    ExecutionChannel.DESKTOP_UIA,
    ExecutionChannel.DESKTOP_VISION,
    ExecutionChannel.POLICY_REVIEW
  ].includes(channel);
  return {
    channel,
    planningMode: value.planningMode ?? (value.modelRoundTrips > 0 ? 'specialist-model' : 'deterministic'),
    structured: Boolean(structured),
    local: Boolean(local),
    expectedLatencyMs: clampInteger(value.expectedLatencyMs, 1, 300000, 1000),
    reliability: clampNumber(value.reliability, 0, 1, 0.8),
    modelRoundTrips: clampInteger(value.modelRoundTrips, 0, 8, 0),
    fallbackToolNames: unique(Array.isArray(value.fallbackToolNames) ? value.fallbackToolNames.filter(Boolean).map(String) : [])
  };
}

function inferProfile(skill = {}) {
  const toolName = String(skill.toolName ?? '').toLowerCase();
  if (toolName.startsWith('mcp.') || toolName.startsWith('mcp__')) {
    return profile(ExecutionChannel.MCP_CONNECTOR, 750, 0.93, 0, ['desktop.control']);
  }
  if (toolName.includes('browser') || toolName.includes('web.')) {
    return profile(ExecutionChannel.WEB_DOM, 2200, 0.82, 1, ['desktop.control']);
  }
  if (toolName.includes('desktop')) {
    return profile(ExecutionChannel.DESKTOP_UIA, 1800, 0.75, 1, []);
  }
  if (toolName.includes('shell')) {
    return profile(ExecutionChannel.SHELL, 500, 0.82, 1, ['desktop.control']);
  }
  if (skill.capability?.externalNetwork === true) {
    return profile(ExecutionChannel.SERVICE_API, 900, 0.9, 0, ['desktop.control']);
  }
  if (skill.adapterContract?.execute === false) {
    return profile(ExecutionChannel.POLICY_REVIEW, 25, 0.999, 0, []);
  }
  return profile(
    skill.capability?.writesLocalFiles ? ExecutionChannel.STRUCTURED_LOCAL : ExecutionChannel.DETERMINISTIC_LOCAL,
    skill.capability?.writesLocalFiles ? 180 : 50,
    0.94,
    0,
    skill.capability?.writesLocalFiles ? ['desktop.control'] : []
  );
}

function objectiveSignals(objective, constraints) {
  const constraintText = (Array.isArray(constraints) ? constraints : [constraints])
    .map((item) => typeof item === 'string' ? item : JSON.stringify(item ?? {}))
    .join(' ');
  const text = `${objective ?? ''} ${constraintText}`.toLowerCase();
  return {
    text,
    preferLocal: /로컬|오프라인|내 pc|내 컴퓨터|외부 전송 금지|local|on-device/.test(text),
    offline: /오프라인만|네트워크 금지|인터넷 없이|offline only|no network/.test(text),
    highPrivacy: /기밀|민감|비공개|개인정보|외부 공유 금지|privacy|confidential/.test(text),
    requiresLiveData: /최신|실시간|현재|오늘|뉴스|가격|날씨|검색|조사|latest|current|live|news|search/.test(text),
    requiresWebInteraction: /웹|사이트|브라우저|온라인|로그인|gpt|chatgpt|web|website|browser|online/.test(text),
    requiresDesktop: /화면|창|버튼|메뉴|클릭|앱에서|프로그램에서|desktop|window|click|menu/.test(text),
    requiresShell: /powershell|터미널|셸|쉘|명령어|스크립트|terminal|shell|command line/.test(text),
    requiresFileSearch: /(?:파일|문서).{0,30}(?:찾아|검색|어디)|(?:찾아|검색).{0,30}(?:파일|문서)|\b[^\s\\/]+\.[a-z0-9]{1,10}\b|\bfind\b|file search/.test(text),
    requiresFileList: /(?:파일|폴더).{0,20}(?:목록|리스트|나열)|(?:목록|리스트).{0,20}(?:파일|폴더)|list files/.test(text),
    requiresExternalTransfer: /메일|이메일|전송|업로드|공유|보내|email|upload|send|share/.test(text),
    prohibitsExternalTransfer: /(?:외부|인터넷|온라인).{0,20}(?:전송|공유|업로드).{0,12}(?:금지|하지\s*마|안\s*됨)|(?:전송|공유|업로드).{0,20}(?:금지|하지\s*마|안\s*됨)|no\s+(?:external\s+)?(?:transfer|upload|sharing)/.test(text),
    requiresMacroSave: /매크로|(?:명령|작업).{0,24}(?:기억|매크로로\s*저장)|(?:기억해|기억해줘)/.test(text),
    requiresCapabilityDescription: /(?:기능|능력|할\s*수\s*있는).{0,30}(?:목록|설명|알려|뭐|무엇)|what can you do|capabilit/.test(text),
    requiresTransferReview: /(?:전송|업로드|공유).{0,30}(?:검토|미리보기|승인만|실행\s*금지)|review only|dry run/.test(text)
  };
}

function explicitObjectiveToolNames(objective) {
  const text = String(objective ?? '').toLowerCase();
  const prohibitedEmail = /(?:메일|이메일).{0,100}(?:금지|보내지\s*마|하지\s*마|안\s*됨)|(?:no|do\s+not)\s+send\s+email/iu.test(text);
  const directedEmailRequest = /(?:내|자기|사용자\s*자신의).{0,50}(?:구글\s*메일|지메일|gmail|이메일)|(?:메일|이메일)(?:로|에|을|를).{0,100}(?:보내(?!지\s*마)|전송|발송)|recipientmode\s*=\s*["']?self/iu.test(text);
  return explicitObjectiveToolRules
    .filter(([toolName, pattern]) => explicitToolRequested(toolName, pattern, text)
      && !(toolName === 'email.send' && prohibitedEmail && !directedEmailRequest))
    .map(([toolName]) => toolName);
}

function explicitToolRequested(toolName, pattern, text) {
  if (!creationToolNames.has(toolName)) return pattern.test(text);
  return objectiveClauses(text).some((clause) => (
    pattern.test(clause) && !negatesArtifactCreation(clause)
  ));
}

function objectiveClauses(value) {
  return String(value ?? '')
    .split(/(?:^|\s)(?:\d{1,2}[.)]|[①-⑳])\s*|[!?;\n]+|\.(?=\s|$)|(?:말고|말며|않고)\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function negatesArtifactCreation(value) {
  return /(?:생성|작성|만들|저장|기록|내보내|정리|명시|묶|압축)(?:\s*하지|하지|\s*하지\s*말|\s*하지\s*않|\s*하지\s*마|\s*금지|\s*불가)|(?:만들|내보내|묶)(?:\s*지|지)\s*(?:말|않|마)|(?:do\s+not|don't|must\s+not|never)\s+(?:create|write|save|export|archive|zip|generate)/iu.test(String(value ?? ''));
}

function matchingKeywords(skill, text) {
  const keywords = [
    ...(skill.match?.keywords ?? []),
    ...(skill.match?.outputFormats ?? []),
    skill.category,
    skill.actionType,
    skill.toolName
  ].filter(Boolean).map((item) => String(item).toLowerCase());
  return unique(keywords.filter((keyword) => keyword.length > 1 && text.includes(keyword))).slice(0, 5);
}

function supportsLiveRetrieval(skill, executionProfile) {
  if ([ExecutionChannel.WEB_DOM, ExecutionChannel.HOSTED_AI_TOOL].includes(executionProfile.channel)) return true;
  if (![ExecutionChannel.SERVICE_API, ExecutionChannel.MCP_CONNECTOR].includes(executionProfile.channel)) return false;
  if (skill.capability?.externalTransfer === true) return false;
  return /search|query|fetch|read|research|lookup|browse|검색|조회|조사|탐색/i.test(`${skill.toolName ?? ''} ${skill.category ?? ''} ${skill.label ?? ''}`);
}

function findReplaceableIndex(selected, selectedTools, anchorToolName, protectedTools = new Set()) {
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const toolName = selected[index].skill.toolName;
    if (toolName !== anchorToolName
      && !protectedTools.has(toolName)
      && !genericFallbackTools.includes(toolName)
      && selectedTools.has(toolName)) return index;
  }
  return -1;
}

function unique(values) {
  return [...new Set(values)];
}

function compactHealth(health) {
  if (!health) return {
    circuitState: 'unobserved',
    eligible: true,
    sampleCount: 0,
    observedReliability: null,
    p50LatencyMs: null,
    p95LatencyMs: null
  };
  return {
    circuitState: health.circuitState,
    eligible: health.eligible,
    sampleCount: health.sampleCount,
    observedReliability: health.observedReliability,
    p50LatencyMs: health.p50LatencyMs,
    p95LatencyMs: health.p95LatencyMs,
    consecutiveFailures: health.consecutiveFailures,
    cooldownRemainingMs: health.cooldownRemainingMs,
    lastErrorCode: health.lastErrorCode
  };
}

function summarizeChannelHealth(tools) {
  const observed = tools.filter((tool) => tool.sampleCount > 0);
  return {
    observedToolCount: observed.length,
    openCircuitCount: tools.filter((tool) => tool.circuitState === 'open').length,
    halfOpenCircuitCount: tools.filter((tool) => tool.circuitState === 'half_open').length,
    averageObservedReliability: observed.length > 0
      ? Math.round((observed.reduce((total, tool) => total + tool.observedReliability, 0) / observed.length) * 10000) / 10000
      : null
  };
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
