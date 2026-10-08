const FORMATTERS = new Map();

function formatter(timeZone) {
  if (!FORMATTERS.has(timeZone)) FORMATTERS.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }));
  return FORMATTERS.get(timeZone);
}

function partsAt(epochMs, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(epochMs)).map(item => [item.type, item.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

function sameWallTime(left, right) {
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].every(key => left[key] === right[key]);
}

function zoneOffsetMs(epochMs, timeZone) {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  const local = partsAt(wholeSecond, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - wholeSecond;
}

function resolveWallTime(wall, timeZone) {
  const wallEpoch = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(zoneOffsetMs(wallEpoch + hours * 3_600_000, timeZone));
  const matches = [...offsets].map(offset => wallEpoch - offset)
    .filter(candidate => sameWallTime(partsAt(candidate, timeZone), wall));
  const unique = [...new Set(matches)].sort((a, b) => a - b);
  if (unique.length === 0) return { error: 'A_ROUTINE_TIME_NONEXISTENT', reason: 'DST 전환으로 존재하지 않는 현지 시각입니다.' };
  if (unique.length > 1) return { error: 'A_ROUTINE_TIME_AMBIGUOUS', reason: 'DST 전환으로 두 번 발생하는 현지 시각입니다.' };
  return { epochMs: unique[0] };
}

/** Resolves a deliberately narrow Korean relative one-shot time; unsupported wording is never guessed. */
function parseKoreanOneTimeExpression(text, { clock = () => new Date(), timeZone = 'Asia/Seoul' } = {}, allowPast = false) {
  if (typeof text !== 'string' || text.length > 300) return { success: false, code: 'A_ROUTINE_TIME_EXPRESSION_INVALID' };
  let now; try { now = clock(); formatter(timeZone); } catch { return { success: false, code: 'A_ROUTINE_TIMEZONE_INVALID' }; }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { success: false, code: 'A_ROUTINE_CLOCK_INVALID' };
  const match = text.match(/(?:^|\s)(오늘|내일)\s*(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/u);
  if (!match) return { success: false, code: 'A_ROUTINE_TIME_EXPRESSION_UNSUPPORTED', reason: '오늘/내일과 오전/오후 시각 표현만 지원합니다.' };
  let hour = Number(match[3]); const minute = Number(match[4] ?? 0);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return { success: false, code: 'A_ROUTINE_TIME_EXPRESSION_INVALID' };
  hour = (hour % 12) + (match[2] === '오후' ? 12 : 0);
  const today = partsAt(now.getTime(), timeZone);
  const localDate = new Date(Date.UTC(today.year, today.month - 1, today.day + (match[1] === '내일' ? 1 : 0)));
  const wall = { year: localDate.getUTCFullYear(), month: localDate.getUTCMonth() + 1, day: localDate.getUTCDate(), hour, minute, second: 0 };
  const resolved = resolveWallTime(wall, timeZone);
  if (resolved.error) return { success: false, code: resolved.error, reason: resolved.reason };
  if (!allowPast && resolved.epochMs <= now.getTime()) return { success: false, code: 'A_ROUTINE_TIME_IN_PAST', reason: '지정한 현지 시각이 이미 지났습니다.' };
  return { success: true, scheduledAt: new Date(resolved.epochMs).toISOString(), timeZone,
    localDateTime: `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}:00`,
    expression: match[0].trim() };
}

export function parseKoreanOneTimeSchedule(text,options={}){
  return parseKoreanOneTimeExpression(text,options,false);
}

/** Resolve an existing source deadline even when elapsed; this grants no dispatch. */
export function resolveKoreanOneTimeDeadline(text,options={}){
  return parseKoreanOneTimeExpression(text,options,true);
}

/** Date-only "until" means the final millisecond of that local calendar date.
 * Resolve the wall clock, not midnight+24h: DST days need not last 24 hours.
 * Skipped dates and ambiguous final minutes remain unresolved. No authority. */
export function resolveLocalDateEnd(date,{timeZone='Asia/Seoul'}={}){
  const match=typeof date==='string'&&/^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if(!match)return {success:false,code:'A_DEADLINE_DATE_INVALID'};
  const [year,month,day]=match.slice(1).map(Number),calendar=new Date(Date.UTC(year,month-1,day));
  if(year<1000||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()+1!==month||calendar.getUTCDate()!==day)return {success:false,code:'A_DEADLINE_DATE_INVALID'};
  try{
    const wall={year,month,day,hour:23,minute:59,second:0},resolved=resolveWallTime(wall,timeZone);
    if(resolved.error)return {success:false,code:resolved.error};
    const end=resolved.epochMs+59_999,last=partsAt(end,timeZone),next=partsAt(end+1,timeZone);
    if(!sameWallTime(last,{...wall,second:59})||(next.year===year&&next.month===month&&next.day===day))return {success:false,code:'A_DEADLINE_DATE_BOUNDARY_UNRESOLVED'};
    return {success:true,deadlineAt:new Date(end).toISOString(),timeZone,date,dateOnlyPolicy:'end-of-local-calendar-date',executionAuthority:false};
  }catch{return {success:false,code:'A_ROUTINE_TIMEZONE_INVALID'};}
}
