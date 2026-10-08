import { nextWeeklyOccurrence } from './weekly-routine-time.js';

const WEEKDAYS = new Map([['월', 1], ['월요일', 1], ['화', 2], ['화요일', 2], ['수', 3], ['수요일', 3],
  ['목', 4], ['목요일', 4], ['금', 5], ['금요일', 5], ['토', 6], ['토요일', 6], ['일', 7], ['일요일', 7]]);

/** Parses only an explicit Korean weekly weekday and AM/PM wall-clock expression. */
export function parseKoreanWeeklyRoutineExpression(text, { clock = () => new Date(), timeZone = 'Asia/Seoul' } = {}) {
  if (typeof text !== 'string' || text.length > 300) return { success: false, code: 'A_ROUTINE_TIME_EXPRESSION_INVALID' };
  let now;
  try { now = clock(); new Intl.DateTimeFormat('en', { timeZone }); }
  catch { return { success: false, code: 'A_ROUTINE_TIMEZONE_INVALID' }; }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { success: false, code: 'A_ROUTINE_CLOCK_INVALID' };
  const match = text.match(/(?:^|\s)매주\s*(월요일|화요일|수요일|목요일|금요일|토요일|일요일|월|화|수|목|금|토|일)\s*(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/u);
  if (!match) return { success: false, code: 'A_ROUTINE_TIME_EXPRESSION_UNSUPPORTED', reason: '매주 요일과 오전/오후 시각을 명확히 입력해 주세요.' };
  let hour = Number(match[3]); const minute = Number(match[4] ?? 0);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return { success: false, code: 'A_ROUTINE_TIME_EXPRESSION_INVALID' };
  hour = (hour % 12) + (match[2] === '오후' ? 12 : 0);
  const recurrence = { frequency: 'weekly', weekday: WEEKDAYS.get(match[1]), hour, minute };
  try {
    return { success: true, recurrence, scheduledAt: nextWeeklyOccurrence(now.toISOString(), recurrence, timeZone), timeZone,
      expression: match[0].trim(), dstGap: 'skip', dstOverlap: 'earlier' };
  } catch (error) {
    return { success: false, code: error.code ?? 'A_ROUTINE_TIME_EXPRESSION_INVALID', reason: error.message };
  }
}
