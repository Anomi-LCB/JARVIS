import { createHash } from 'node:crypto';
import { normalizeCriterionExtensions } from './criteria-evidence.js';
import {extractGoalAmounts} from './goal-money-expression.js';
import {extractGoalQuantities} from './goal-quantity-expression.js';

export const GOAL_CONTRACT_VERSION = 'a-goal-contract-v1';
const digest = text => createHash('sha256').update(text).digest('hex');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const actionFamilies = [
  ['delete', /삭제|제거/gu], ['send', /발송|전송|보내/gu], ['change', /수정|변경|덮어쓰/gu],
  ['save', /저장/gu], ['read', /읽/gu], ['summarize', /요약/gu], ['list', /목록을?\s*보여|나열/gu]
];
const zonedDateTimeFormatters = new Map();
function invalid(reason) { throw Object.assign(new Error(reason), { code: `A_GOAL_${reason}` }); }
function checkObjective(objective) {
  if (typeof objective !== 'string' || !objective.trim() || objective.length > 32768
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f§]/u.test(objective)) invalid('OBJECTIVE_INVALID');
}
function validId(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid('ID_INVALID');
  return value;
}
// Do not normalize whitespace inside quoted paths, templates or addresses.
function normalized(text) { return text.trim(); }
function likelySentenceEnd(text) {
  return /(?:습니다|니다|어요|해요|예요|이에요|세요|죠|네요|군요|나요|까요|다|요|네|까|냐|라|마|줘|봐|해|하자|말고|말아)$/u.test(text.trimEnd());
}

/** Shared quote-aware lexer. Offsets are UTF-16 indexes into the exact unmodified input. */
export function tokenizeGoalSource(objective) {
  checkObjective(objective);
  const strings = [], clauses = [], sourceSpans = [];
  let current = '', start = 0;
  const push = end => {
    if (!current.trim()) invalid('EMPTY_CLAUSE');
    while (start < end && /\s/u.test(objective[start])) start++;
    while (end > start && /\s/u.test(objective[end - 1])) end--;
    clauses.push(current.trim());
    sourceSpans.push({ start, end });
    current = '';
  };
  for (let i = 0; i < objective.length; i++) {
    const character = objective[i];
    const closer = ({ "'": "'", '"': '"', '“': '”', '‘': '’' })[character];
    if (closer) {
      let value = '', closed = false;
      while (++i < objective.length) {
        if (objective[i] === '\\' && [closer, '\\'].includes(objective[i + 1])) { value += objective[++i]; continue; }
        if (objective[i] === closer) { closed = true; break; }
        if (/[\r\n]/u.test(objective[i])) invalid('QUOTE_INVALID');
        value += objective[i];
      }
      if (!closed) invalid('QUOTE_INVALID');
      current += `§${strings.push(value) - 1}§`;
    } else if (character === ';' || character === '；' || character === '\n') {
      push(i); start = i + 1;
    } else if (/[.!?。！？]/u.test(character) && /\s/u.test(objective[i + 1] ?? '') && current.trim() && likelySentenceEnd(current)) {
      current += character;
      push(i + 1);
      start = i + 1;
    } else if (/\s/u.test(character) && current.trim()) {
      const connector = /^\s+(?:그리고|그다음(?:으로)?|다음으로|이어서|마지막으로)\s+/u.exec(objective.slice(i));
      if (connector) { push(i); i += connector[0].length - 1; start = i + 1; }
      // Split only a positive save conjunction followed by an explicit target.
      // Quoted conjunction words were consumed above and remain literal data.
      else if (/저장하고$/u.test(current.trimEnd()) && /^\s+(?:'[^'\r\n]*'|"[^"\r\n]*"|“[^”\r\n]*”|‘[^’\r\n]*’|[^\s"'“”‘’]+\.(?:txt|md|csv|json|xlsx|docx|pdf|hwpx|pptx))(?:을|를|은|는|도)\s+/iu.test(objective.slice(i))) {
        push(i); start = i + 1;
      }
      else current += character;
    } else current += character;
  }
  if (current.trim()) push(objective.length);
  if (clauses.length > 64) invalid('REQUIREMENT_LIMIT');
  return { clauses, strings, sourceSpans };
}

function quotedParts(text) {
  const parts = [];
  let masked = '';
  for (let i = 0; i < text.length; i++) {
    const closer = ({ "'": "'", '"': '"', '“': '”', '‘': '’' })[text[i]];
    if (!closer) { masked += text[i]; continue; }
    const start = i;
    let value = '';
    while (++i < text.length) {
      if (text[i] === '\\' && [closer, '\\'].includes(text[i + 1])) { value += text[++i]; continue; }
      if (text[i] === closer) break;
      value += text[i];
    }
    parts.push({ value, sourceSpan: { start, end: i + 1 } });
    masked += ' '.repeat(i + 1 - start);
  }
  return { parts, masked };
}

function interpret(text) {
  const { parts, masked } = quotedParts(text);
  const matches = actionFamilies.flatMap(([family, pattern]) => [...masked.matchAll(pattern)].map(match => ({ family, index: match.index, verb: match[0] })))
    .sort((a, b) => a.index - b.index);
  // These deictic and prior-turn phrases cannot be bound to a concrete target
  // by this bounded parser. Keep them unresolved instead of treating the noun
  // alone as a safely identified file, person, account, or device.
  const unresolvedReferences = [...masked.matchAll(/(?:그|이(?!메일)|저)\s*(?:자료|문서|파일|사람|계정|기기|메일|예약|이미지|사진|폴더|대상|분)|(?:그것|이것|저것|그거|이거|저거)|(?:저번|지난\s*번)(?:에)?(?:\s*(?:말한|언급한|보낸|읽은|작성한))?|(?:위에서|앞서)\s*(?:말한|언급한|보낸|작성한)/gu)].map(match => match[0]);
  // A fully bounded quoted source-revision query asks about data history;
  // it is distinct from an instruction to correct the user's goal.
  const sourceRevisionQuery = parts.length===4 && /^\s*에서\s+의\s+정정 후 현재 숫자를\s+단위로 추출(?:해서|해)\s*(?:로|으로) 만들어\s*$/u.test(masked);
  const hasCorrection = !sourceRevisionQuery && /(?:^|\s)(?:아니[,.]?|정정[,:]?|대신|취소하고)(?:\s|$)/u.test(masked);
  // The bounded grammar does not establish a predicate's truth. Prefix words
  // allowed by boundedSimple must not erase a conditional or a prior decision.
  // Quoted text was masked above, so filenames/content remain literal data.
  const unresolvedConditions = [...masked.matchAll(/(?:[^\s,，]*(?:다면|라면|하면|되면|으면|이면)|(?:승인|허락|동의|확인|답변|회신|선택|결정|완료|성공)[^\s,，]*(?:\s+[^\s,，]+){0,3}\s+(?:후|뒤|다음|이후))(?=\s|[,，]|$)/gu)]
    .map(match=>({text:text.slice(match.index,match.index+match[0].length),sourceSpan:{start:match.index,end:match.index+match[0].length},status:'unresolved'}));
  const single = matches.length === 1 ? matches[0] : null;
  const negative = single && new RegExp(`${single.verb}\\s*(?:하지|지|하지는|지는)\\s*(?:마|말|않)`, 'u').test(masked);
  const prefixedNegative = single && new RegExp(`안\\s*${single.verb}`, 'u').test(masked);
  // In "report.xlsx 내용을 읽어줘", 내용 is the operation's object,
  // not the source file. Bind only this explicit single-source read grammar;
  // quoted literals and unresolved compound references keep their existing rules.
  const explicitReadFile=single?.family==='read'
    ? /^(?:(?:먼저|그리고|다음으로|그다음|이어서|마지막으로)\s+)?([^\s"'“”‘’]+\.(?:xlsx|pdf|txt|md|csv|json|docx|hwpx))(?:의)?\s+(?:파일(?:의)?\s+)?(?:내용|본문|원문)(?:을|를)?\s+(?:안\s*)?읽/iu.exec(text.trim())?.[1]
    : null;
  const additiveFile = /(?:^|\s)([^\s]+\.(?:txt|md|csv|json|xlsx|docx|pdf|hwpx|pptx))도\s/iu.exec(masked)?.[1];
  const target = explicitReadFile ?? parts[0]?.value ?? additiveFile ?? /(?:^|\s)([^\s]+?)(?:을|를|은|는)\s/u.exec(masked)?.[1] ?? null;
  let simple = text;
  for (const part of [...parts].reverse()) simple = `${simple.slice(0, part.sourceSpan.start)}대상${simple.slice(part.sourceSpan.end)}`;
  // A filename-only creation request has a bounded meaning even without an
  // object particle. Do not recognize extra content, corrections or actions
  // by finding a creation verb somewhere inside a larger sentence.
  const creation = /^(?:(?:먼저|그리고|다음으로|그다음|이어서|마지막으로)\s+)?(대상|[^\s"'“”‘’]+\.(?:txt|md|csv|json|xlsx|docx|pdf|hwpx|pptx))(?:을|를|은|는|도)?\s+(?:(엑셀|Excel|워드|Word|파워포인트|PowerPoint|텍스트|한글|PDF)\s+)?파일(?:을|를)?\s+(?:(안)\s+)?(만들어(?:줘|주세요)|생성해(?:줘|주세요)|만들지\s*(?:마(?:세요)?|말아|말고)|생성하지\s*(?:마(?:세요)?|말아|말고))[.!。!?！？]?$/iu.exec(simple.trim());
  const creationTarget = creation?.[1] === '대상' ? (parts.length === 1 ? parts[0].value : null) : creation?.[1];
  const format = creation?.[2]?.toLowerCase();
  const formatExtensions = {엑셀:['xlsx'],excel:['xlsx'],워드:['docx'],word:['docx'],파워포인트:['pptx'],powerpoint:['pptx'],텍스트:['txt','md','csv','json'],한글:['hwpx'],pdf:['pdf']};
  const creationRecognized = Boolean(creationTarget && /\.(?:txt|md|csv|json|xlsx|docx|pdf|hwpx|pptx)$/iu.test(creationTarget)
    && (!format || formatExtensions[format]?.includes(creationTarget.split('.').at(-1).toLowerCase()))
    && !unresolvedReferences.length && !hasCorrection && parts.length <= 1);
  const creationProhibited = creationRecognized && Boolean(creation[3] || /(?:지|하지)\s*(?:마|말)/u.test(creation[4]));
  const creationAttempt = /^(?:(?:먼저|그리고|다음으로|그다음|이어서|마지막으로)\s+)?(?:대상|[^\s"'“”‘’]+\.(?:txt|md|csv|json|xlsx|docx|pdf|hwpx|pptx))(?:을|를|은|는|도)?\s+(?:(?:엑셀|Excel|워드|Word|파워포인트|PowerPoint|텍스트|한글|PDF)\s+)?파일(?:을|를)?\s+(?:안\s+)?(?:만들|생성)/iu.test(simple.trim())
    && !/파일(?:을|를)?\s*(?:만들어줘|만들어주세요|생성해줘|생성해주세요)[.!]?\s+내용은/u.test(simple);
  const boundedSimple = /^(?:(?:먼저|그리고|다음으로|그다음|이어서|마지막으로)\s+)?(?:[^\s]+\s+){0,5}[^\s]+(?:을|를|은|는|도)\s+(?:(?:아직|절대|안)\s+)?(?:(?:내|제)\s*(?:구글\s*)?(?:이메일|e?메일)(?:로|에)?\s+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?:\s*(?:이메일|e?메일)(?:로|에)?)?\s+)?(?:삭제|제거|발송|전송|보내|수정|변경|덮어쓰|저장|읽|요약|목록을?\s*보여|나열|보여)\s*(?:하지\s*(?:마(?:세요)?|말아|말고|않아)|지\s*(?:마(?:세요)?|말아|말고|않아)|해(?:줘|주세요)?|하고|어(?:줘|주세요)?|고|줘|주세요)?[.!。!?！？]?$/u.test(simple.trim());
  const hasProhibition = /(?:하지|지|하지는|지는)\s*(?:마|말|않)|(?:^|\s)안\s*(?:보내|읽|삭제|제거|발송|저장|수정|변경)/u.test(masked);
  const hasExclusion = /제외|빼고/u.test(masked);
  const recipientAddress = single?.family === 'send'
    ? /(?:^|\s)([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(?:\s*(?:이메일|e?메일)(?:로|에)?)?\s+(?:안\s*)?(?:보내|발송|전송)/i.exec(masked)?.[1] : null;
  const recipientSelf = single?.family === 'send' && /(?:^|\s)(?:내|제)\s*(?:구글\s*)?(?:이메일|e?메일)(?:로|에)?\s+(?:안\s*)?(?:보내|발송|전송)/iu.test(masked);
  const boundedSend = single?.family !== 'send' || /^(?:(?:먼저|그리고|다음으로|그다음|이어서|마지막으로)\s+)?(?:대상|[^\s"'“”‘’]+)(?:을|를|은|는|도)\s+(?:(?:아직|절대|안)\s+)?(?:(?:내|제)\s*(?:구글\s*)?(?:이메일|e?메일)(?:로|에)?\s+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}(?:\s*(?:이메일|e?메일)(?:로|에)?)?\s+)?(?:보내|발송|전송)(?:줘|주세요|해|해줘|해주세요|지\s*(?:마(?:세요)?|말아|말고)|하지\s*(?:마(?:세요)?|말아|말고))?[.!。!?！？]?$/iu.test(simple.trim());
  return {
    status: !unresolvedConditions.length && (creationRecognized || (single && target && boundedSimple && boundedSend && !unresolvedReferences.length && !hasCorrection)) ? 'recognized' : 'unresolved',
    action: creationRecognized ? 'save' : single?.family ?? null, target: creationRecognized ? creationTarget : target,
    polarity: creationProhibited || negative || prefixedNegative ? 'prohibited' : 'required',
    ...(creationRecognized ? {creation:true} : {}),
    ...(creationAttempt ? {creationAttempt:true} : {}),
    ...(unresolvedConditions.length ? {unresolvedConditions} : {}),
    ...(single?.family === 'send' ? {emailRecipient:recipientAddress?{mode:'address',address:recipientAddress}:
      recipientSelf?{mode:'self'}:{mode:'unspecified'}} : {}),
    compound: matches.length > 1,
    hasProhibition: hasProhibition || creationProhibited,
    hasExclusion,
    correction: hasCorrection,
    unresolvedReferences,
    // Quoted text is a literal/reference, never parsed as another instruction.
    quotedReferences: parts.map(part => ({ text: part.value, sourceSpan: part.sourceSpan }))
  };
}

function localDateTimeFormatter(timeZone) {
  if (!zonedDateTimeFormatters.has(timeZone)) zonedDateTimeFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }));
  return zonedDateTimeFormatters.get(timeZone);
}

function localPartsAt(instant, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(item => [item.type, item.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute) };
}

function localDateTimeResolution(date, localTime, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = localDateTimeFormatter(timeZone);
  const offsets = new Set();
  // Sampling both sides of common DST transitions discovers each applicable
  // offset; exact round-trips then distinguish unique, repeated and skipped
  // local wall times without assuming a one-hour transition.
  for (let delta = -48; delta <= 48; delta += 3) {
    const sample = wallClockUtc + delta * 60 * 60 * 1000;
    const local = localPartsAt(sample, formatter);
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample);
  }
  const matches = [...offsets].map(offset => wallClockUtc - offset).filter(instant => {
    const local = localPartsAt(instant, formatter);
    return local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute;
  });
  return matches.length === 1 ? 'unique' : matches.length === 0 ? 'nonexistent' : 'ambiguous';
}

function explicitDateTimes(masked) {
  // An ISO-looking token is one constraint. Never salvage its date/time while
  // discarding an invalid suffix, missing offset, or impossible calendar value.
  return [...masked.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}[Tt][0-9A-Za-z:.+-]*/gu)].map(match => {
    const text = match[0].replace(/(?<=[^.])\.$/u, '');
    const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
    let instant = null, offset = null;
    if (parts) {
      const dateEpoch = Date.parse(`${parts[1]}T00:00:00Z`);
      offset = parts[6];
      const validOffset = offset === 'Z' || (Number(offset.slice(1,3)) <= 23 && Number(offset.slice(4)) <= 59 && offset !== '-00:00');
      const value = Date.parse(text);
      if (Number.isFinite(dateEpoch) && new Date(dateEpoch).toISOString().slice(0,10) === parts[1]
        && Number(parts[2]) <= 23 && Number(parts[3]) <= 59 && Number(parts[4] ?? 0) <= 59
        && validOffset && Number.isFinite(value)) instant = new Date(value).toISOString();
    }
    return { kind:'date-time', text, sourceSpan:{start:match.index,end:match.index+text.length},
      instant, offset, timeZone:null, status:instant ? 'parsed-instant' : 'unresolved',
      ...(!instant ? {resolutionIssue:'explicit-date-time-unresolved'} : {}) };
  });
}

function temporalAndMoney(objective, referenceTime, timeZone, clauseSpans = []) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); } catch { invalid('TIME_ZONE_INVALID'); }
  const { masked } = quotedParts(objective);
  const amounts = extractGoalAmounts(objective, masked);
  const explicitTimes = explicitDateTimes(masked);
  let temporalSource = masked;
  for (const item of [...explicitTimes].reverse()) temporalSource = temporalSource.slice(0,item.sourceSpan.start)
    + ' '.repeat(item.sourceSpan.end-item.sourceSpan.start) + temporalSource.slice(item.sourceSpan.end);
  let localDate = null;
  if (referenceTime !== null) {
    if (typeof referenceTime !== 'string' || !Number.isFinite(Date.parse(referenceTime))) invalid('REFERENCE_TIME_INVALID');
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(referenceTime));
      const part = type => parts.find(item => item.type === type).value;
      localDate = `${part('year')}-${part('month')}-${part('day')}`;
    } catch { invalid('TIME_ZONE_INVALID'); }
  }
  const relativeWeekdayMatches = [...temporalSource.matchAll(/(이번|다음|다다음)\s*주\s*(월|화|수|목|금|토|일)(?:요일)?(?=$|\s|[,.!?;:)]|까지|부터|에는|에|은|는|을|를|쯤)/gu)];
  const relativeWeekdayDate = match => {
    if (!localDate) return null;
    const current = new Date(`${localDate}T00:00:00Z`);
    const mondayOffset = (current.getUTCDay() + 6) % 7;
    const targetWeekday = ['일', '월', '화', '수', '목', '금', '토'].indexOf(match[2]);
    const currentWeekMonday = Date.parse(`${localDate}T00:00:00Z`) - mondayOffset * 86400000;
    const weekOffset = match[1] === '이번' ? 0 : match[1] === '다음' ? 7 : 14;
    const dayOffset = (targetWeekday - 1 + 7) % 7;
    return new Date(currentWeekMonday + (weekOffset + dayOffset) * 86400000).toISOString().slice(0, 10);
  };
  const relativeWeekdaySpans = relativeWeekdayMatches.map(match => ({ start: match.index, end: match.index + match[0].length }));
  const times = [...explicitTimes,...relativeWeekdayMatches.map(match => {
    const date = relativeWeekdayDate(match);
    return { kind: 'date', text: match[0], sourceSpan: { start: match.index, end: match.index + match[0].length },
      date, timeZone, status: date ? 'parsed-date' : 'unresolved' };
  })];
  const relativeDateMatches = [...temporalSource.matchAll(/\d{4}-\d{2}-\d{2}|오늘|내일|모레|다음\s*주|다음\s*달/gu)]
    .filter(match => !relativeWeekdaySpans.some(span => match.index < span.end && match.index + match[0].length > span.start));
  times.push(...relativeDateMatches.map(match => {
    let date = null;
    if (/^\d/u.test(match[0])) {
      const parsed = Date.parse(`${match[0]}T00:00:00Z`);
      if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === match[0]) date = match[0];
    } else if (localDate && ['오늘', '내일', '모레'].includes(match[0])) {
      date = new Date(Date.parse(`${localDate}T00:00:00Z`) + ['오늘', '내일', '모레'].indexOf(match[0]) * 86400000).toISOString().slice(0, 10);
    }
    return { kind: 'date', text: match[0], sourceSpan: { start: match.index, end: match.index + match[0].length }, date, timeZone, status: date ? 'parsed-date' : 'unresolved' };
  }));
  // Preserve common relative expressions that this deterministic calendar
  // parser cannot safely anchor (for example, "next Tuesday" vs. "the Tuesday
  // of next week", or an entire weekend). Omitting these is worse than
  // returning an explicit unresolved value.
  // Elapsed durations are source constraints too; silently dropping seconds,
  // minutes or hours lets an expired request execute without a time fence.
  for (const match of temporalSource.matchAll(/(?<![\d.])(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)|한|두|세|몇)\s*(?:시간|분|초)(?:\s*(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)|한|두|세|몇)\s*(?:시간|분|초))*\s*(?:이내|안에|후|뒤)/gu)) {
    const numeric = /^(?:\d+\s*(?:시간|분|초)\s*){1,3}(?:이내|안에)$/u.test(match[0]);
    const parts = [...match[0].matchAll(/(\d+)\s*(시간|분|초)/gu)];
    const order = {시간:0,분:1,초:2}, scale = {시간:3600000,분:60000,초:1000};
    const ordered = parts.every((p,i)=>i===0 || order[p[2]]>order[parts[i-1][2]]);
    const durationMs = numeric && ordered ? parts.reduce((sum,p)=>sum+Number(p[1])*scale[p[2]],0) : null;
    const anchor = referenceTime === null ? NaN : Date.parse(referenceTime);
    const end = anchor + durationMs;
    const valid = numeric && ordered && Number.isSafeInteger(durationMs) && durationMs > 0
      && Number.isFinite(anchor) && Number.isSafeInteger(end) && Math.abs(end) <= 8640000000000000;
    times.push({kind:'elapsed-duration',text:match[0],sourceSpan:{start:match.index,end:match.index+match[0].length},
      timeZone,durationMs:valid ? durationMs : null,referenceTime:valid ? new Date(anchor).toISOString() : null,
      deadlineAt:valid ? new Date(end).toISOString() : null,status:valid ? 'parsed-duration' : 'unresolved'});
  }
  const ambiguousRelativeMatches = [...temporalSource.matchAll(/(?:다음|이번|다다음)\s*(?:월|화|수|목|금|토|일)(?:요일)?|(?:이번|다음|다다음)\s*주말|(?:금주|차주|익주|지난\s*주|이번\s*주)(?:\s*(?:초|중|중반|후반|말|주중|주말))?|(?:주중|주말|월초|월중|월말|말일|연초|연말|분기\s*(?:초|중|말)|상반기|하반기)|(?:금월|이번\s*달|지난\s*달|익월|차월)(?:\s*(?:초|중순|말))?|(?:\d+|며칠|몇\s*일)\s*(?:영업일|일|주|개월)\s*(?:후|뒤|이내|내|안에)|(?:오전|오후|점심|퇴근|업무)\s*(?:중|전|후|무렵)|(?:곧|조만간|이따|나중에|잠시\s*후|조금\s*후|가능한\s*한\s*빨리|최대한\s*빨리|asap)|(?:회의|미팅|예배|수업|행사|예약|출장|아이|가족|담당자|파일\s*업로드|업로드|다운로드|결제|입금|승인|확인|도착|출발)(?:.{0,8}?)(?:끝난\s*뒤|끝난\s*후|끝나고|시작\s*전|시작\s*후|완료\s*후|완료되면|확인\s*후|확인되면|승인\s*후|승인되면|도착\s*후|도착하면|출발\s*후|출발하면|전에|직전|직후|하자마자|되는\s*즉시)/giu)];
  for (const match of ambiguousRelativeMatches) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (times.some(item => span.start < item.sourceSpan.end && span.end > item.sourceSpan.start)) continue;
    times.push({ kind: 'relative-expression', text: match[0], sourceSpan: span,
      date: null, timeZone, status: 'unresolved' });
  }
  for (const match of temporalSource.matchAll(/(?:오전|오후)\s*\d{1,2}시(?:\s*\d{1,2}분)?|(?<!\d)\d{1,2}:\d{2}(?!\d)/gu)) {
    const values = match[0].match(/\d+/gu).map(Number);
    let [hour, minute = 0] = values;
    const period = /오전|오후/u.exec(match[0])?.[0];
    const valid = hour >= (period ? 1 : 0) && hour <= (period ? 12 : 23) && minute >= 0 && minute <= 59;
    if (valid && period) hour = hour % 12 + (period === '오후' ? 12 : 0);
    times.push({ kind: 'time-of-day', text: match[0], sourceSpan: { start: match.index, end: match.index + match[0].length },
      localTime: valid ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : null,
      timeZone, status: valid ? 'parsed-time' : 'unresolved' });
  }
  times.sort((a, b) => a.sourceSpan.start - b.sourceSpan.start);
  const clauseIndex = span => clauseSpans.findIndex(clause => span.start >= clause.start && span.end <= clause.end);
  for (const time of times.filter(item => item.kind === 'time-of-day' && item.status === 'parsed-time')) {
    const candidates = times.filter(item => item.kind === 'date' && item.status === 'parsed-date'
      && clauseIndex(item.sourceSpan) === clauseIndex(time.sourceSpan));
    const date = candidates.sort((a, b) => {
      const left = a.sourceSpan.end <= time.sourceSpan.start ? time.sourceSpan.start - a.sourceSpan.end : a.sourceSpan.start - time.sourceSpan.end;
      const right = b.sourceSpan.end <= time.sourceSpan.start ? time.sourceSpan.start - b.sourceSpan.end : b.sourceSpan.start - time.sourceSpan.end;
      return left - right;
    })[0];
    if (!date) continue;
    const resolution = localDateTimeResolution(date.date, time.localTime, timeZone);
    if (resolution !== 'unique') {
      time.status = 'unresolved';
      time.resolutionIssue = resolution === 'ambiguous' ? 'ambiguous-local-time' : 'nonexistent-local-time';
      time.relatedDateSourceSpan = structuredClone(date.sourceSpan);
    }
  }
  return { amounts, times, quantities:extractGoalQuantities(objective,masked) };
}

function contradictions(requirements) {
  const conflicts = [];
  for (let i = 0; i < requirements.length; i++) for (let j = i + 1; j < requirements.length; j++) {
    const a = requirements[i], b = requirements[j];
    if (a.interpretation.status === 'recognized' && b.interpretation.status === 'recognized'
      && a.interpretation.action === b.interpretation.action && a.interpretation.target === b.interpretation.target
      && a.interpretation.polarity !== b.interpretation.polarity) {
      conflicts.push({ code: 'contradictory-requirements', requirementIds: [a.requirementId, b.requirementId] });
    }
  }
  return conflicts;
}

function bindCriteria(criteria, requirements) {
  const sameSpan = (a, b) => a?.start === b?.start && a?.end === b?.end;
  const bindings = criteria.map(criterion => {
    const byId = requirements.find(item => item.requirementId === criterion.requirementId);
    const bySpan = criterion.sourceSpan ? requirements.find(item => sameSpan(item.sourceSpan, criterion.sourceSpan)) : null;
    const requirement = byId ?? bySpan;
    const mismatch = byId && criterion.sourceSpan && !sameSpan(byId.sourceSpan, criterion.sourceSpan);
    return { criterionId: criterion.criterionId,
      ...(criterion.requirementId ? { suppliedRequirementId: criterion.requirementId } : {}),
      status: mismatch ? 'unresolved' : requirement ? 'bound' : criterion.requirementId || criterion.sourceSpan ? 'unresolved' : 'unscoped',
      ...(requirement && !mismatch ? { requirementId: requirement.requirementId, basis: byId ? 'requirement-id' : 'exact-source-span' } : {}) };
  });
  const aliases = new Map();
  for (const binding of bindings) {
    if (!binding.suppliedRequirementId || binding.status !== 'bound') continue;
    const targets = aliases.get(binding.suppliedRequirementId) ?? new Set();
    targets.add(binding.requirementId);
    aliases.set(binding.suppliedRequirementId, targets);
  }
  return bindings.map(binding => {
    if ((aliases.get(binding.suppliedRequirementId)?.size ?? 0) <= 1) return binding;
    const { requirementId, basis, ...identity } = binding;
    return { ...identity, status: 'unresolved', reason: 'supplied-alias-conflicts-with-multiple-requirements' };
  });
}

/** Bounded clause contract, not a claim that arbitrary Korean has been semantically understood. */
export function createGoalContract({ objective, goalId = null, revision = 1, successCriteria = [], referenceTime = null, timeZone = 'Asia/Seoul' } = {}) {
  checkObjective(objective);
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('REVISION_INVALID');
  if (!Array.isArray(successCriteria) || successCriteria.length > 20) invalid('CRITERIA_INVALID');
  const source = tokenizeGoalSource(objective);
  const occurrences = new Map();
  const requirements = source.sourceSpans.map(sourceSpan => {
    const text = objective.slice(sourceSpan.start, sourceSpan.end);
    const fingerprint = digest(normalized(text));
    const count = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, count);
    return { requirementId: `req_${fingerprint.slice(0, 24)}_${count}`, sourceSpan, text,
      sourceRevision: revision, interpretation: interpret(text), dependsOn: [] };
  });
  const criteria = successCriteria.map((criterion, index) => {
    const value = typeof criterion === 'string' ? { statement: criterion } : criterion;
    if (!value || typeof value !== 'object' || typeof value.statement !== 'string' || !value.statement.trim()) invalid('CRITERIA_INVALID');
    const extension = normalizeCriterionExtensions(value, { objectiveLength: objective.length });
    return { criterionId: value.criterionId ? validId(value.criterionId) : `criterion_${index + 1}`,
      statement: value.statement, ...extension };
  });
  if (new Set(criteria.map(item => item.criterionId)).size !== criteria.length) invalid('CRITERION_ID_DUPLICATE');
  const conflicts = contradictions(requirements);
  const facts = temporalAndMoney(objective, referenceTime, timeZone, source.sourceSpans);
  const criterionBindings = bindCriteria(criteria, requirements);
  return {
    schemaVersion: GOAL_CONTRACT_VERSION, goalId: goalId ? validId(goalId) : `goal_${digest(objective).slice(0, 24)}`,
    revision, objective, objectiveSha256: digest(objective), offsetEncoding: 'utf16-code-units',
    referenceTime, timeZone, requirements, successCriteria: criteria, criterionBindings,
    unresolvedCriterionIds: criterionBindings.filter(item => item.status === 'unresolved').map(item => item.criterionId),
    constraints: requirements.filter(item => item.interpretation.polarity === 'prohibited' || item.interpretation.hasProhibition || item.interpretation.hasExclusion)
      .map(item => ({ requirementId: item.requirementId, sourceSpan: item.sourceSpan, text: item.text,
        kind: item.interpretation.hasExclusion ? 'exclusion' : 'prohibition' })),
    amounts: facts.amounts, times: facts.times, quantities:facts.quantities,
    contradictions: conflicts,
    unresolvedRequirementIds: requirements.filter(item => item.interpretation.status !== 'recognized').map(item => item.requirementId),
    interpretationBasis: 'bounded-explicit-clauses', semanticCoverage: 'unverified', executionAuthorized: false
  };
}

/** Explicit replacement revision. Effects are compared; neither replay nor compensation is authorized. */
export function reviseGoalContract(previous, { objective, successCriteria = null, referenceTime = previous?.referenceTime ?? null, executedEffects = [] } = {}) {
  if (previous?.schemaVersion !== GOAL_CONTRACT_VERSION || !Array.isArray(previous.requirements)) invalid('PREVIOUS_CONTRACT_INVALID');
  if (!Array.isArray(executedEffects) || executedEffects.length > 1000) invalid('EFFECTS_INVALID');
  const preliminary = createGoalContract({ objective, goalId: previous.goalId, revision: previous.revision + 1,
    referenceTime, timeZone: previous.timeZone });
  const invalidatedCriterionIds = [];
  const carriedCriteria = (previous.successCriteria ?? []).map(criterion => {
    const result = structuredClone(criterion);
    const priorBinding = previous.criterionBindings?.find(item => item.criterionId === criterion.criterionId);
    const retained = preliminary.requirements.find(item => item.requirementId === (priorBinding?.requirementId ?? criterion.requirementId));
    if (retained) {
      if (criterion.sourceSpan) result.sourceSpan = { ...retained.sourceSpan };
    } else if (criterion.requirementId || criterion.sourceSpan) {
      invalidatedCriterionIds.push(criterion.criterionId);
      delete result.sourceSpan;
    }
    return result;
  });
  const next = createGoalContract({ objective, goalId: previous.goalId, revision: previous.revision + 1,
    successCriteria: successCriteria ?? carriedCriteria, referenceTime, timeZone: previous.timeZone });
  const priorIds = new Set(previous.requirements.map(item => item.requirementId));
  const nextIds = new Set(next.requirements.map(item => item.requirementId));
  const effects = executedEffects.map(item => {
    if (!priorIds.has(item.requirementId) || !['confirmed', 'unknown', 'failed'].includes(item.status)) invalid('EFFECTS_INVALID');
    return { requirementId: item.requirementId, effectId: validId(item.effectId), status: item.status };
  });
  next.revisionChange = {
    previousRevision: previous.revision,
    previousObjectiveSha256: previous.objectiveSha256,
    retainedRequirementIds: [...nextIds].filter(id => priorIds.has(id)),
    removedRequirementIds: [...priorIds].filter(id => !nextIds.has(id)),
    addedRequirementIds: [...nextIds].filter(id => !priorIds.has(id)),
    effectConflicts: effects.filter(item => item.status !== 'failed' && !nextIds.has(item.requirementId))
      .map(item => ({ ...item, code: item.status === 'unknown' ? 'uncertain-effect-before-revision' : 'completed-effect-before-revision' })),
    retainedEffects: effects.filter(item => nextIds.has(item.requirementId)),
    invalidatedCriterionIds: successCriteria === null ? invalidatedCriterionIds : [],
    compensationAuthorized: false
  };
  return next;
}

/** Structural coverage gate only; an action's claimed links are not independent evidence of correctness. */
export function checkGoalPlanCoverage(contract, actions = []) {
  if (contract?.schemaVersion !== GOAL_CONTRACT_VERSION || !Array.isArray(actions)) invalid('PLAN_INVALID');
  const ids = new Set(contract.requirements.map(item => item.requirementId));
  const linked = new Set(), unknown = new Set(), prohibitedActions = new Set();
  const prohibitedIds = new Set(contract.requirements.filter(item => item.interpretation.status === 'recognized'
    && item.interpretation.polarity === 'prohibited').map(item => item.requirementId));
  const constraintIds = new Set(contract.constraints.map(item => item.requirementId));
  for (const action of actions) {
    if (!action || typeof action !== 'object'
      || (action.requirementIds !== undefined && !Array.isArray(action.requirementIds))
      || (action.constraintRequirementIds !== undefined && !Array.isArray(action.constraintRequirementIds))) invalid('PLAN_INVALID');
    for (const id of action.requirementIds ?? []) {
      if (ids.has(id)) linked.add(id); else unknown.add(id);
      if (prohibitedIds.has(id)) prohibitedActions.add(id);
    }
    for (const id of action.constraintRequirementIds ?? []) {
      if (constraintIds.has(id)) linked.add(id); else unknown.add(id);
    }
  }
  const missing = [...ids].filter(id => !linked.has(id));
  const unresolved = [...contract.unresolvedRequirementIds];
  const unresolvedTimes = (contract.times ?? []).filter(item => item.status === 'unresolved');
  const unresolvedAmounts = (contract.amounts ?? []).filter(item => item.status !== 'parsed');
  const unresolvedQuantities = (contract.quantities ?? []).filter(item => item.status !== 'parsed');
  const effectConflicts = contract.revisionChange?.effectConflicts ?? [];
  return {
    coveredRequirementIds: [...linked], missingRequirementIds: missing, unknownRequirementIds: [...unknown],
    unresolvedRequirementIds: unresolved, contradictions: structuredClone(contract.contradictions),
    unresolvedTimeExpressions: structuredClone(unresolvedTimes),
    unresolvedAmountExpressions: structuredClone(unresolvedAmounts),
    unresolvedQuantityExpressions: structuredClone(unresolvedQuantities),
    prohibitedActionRequirementIds: [...prohibitedActions],
    unresolvedCriterionIds: [...(contract.unresolvedCriterionIds ?? [])],
    canDispatchExternalEffects: !missing.length && !unknown.size && !unresolved.length && !unresolvedTimes.length && !unresolvedAmounts.length && !unresolvedQuantities.length && !prohibitedActions.size && !contract.contradictions.length && !effectConflicts.length
      && !(contract.revisionChange?.invalidatedCriterionIds?.length) && !contract.unresolvedCriterionIds?.length,
    semanticAccuracyVerified: false, executionAuthorized: false
  };
}
