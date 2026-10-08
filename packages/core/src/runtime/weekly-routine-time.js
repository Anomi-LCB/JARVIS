const ISO_WEEKDAY = (date) => ((date.getUTCDay() + 6) % 7) + 1;

function zonedParts(instant, timeZone) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant);
  return Object.fromEntries(values.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function sameLocal(parts, target) {
  return ['year', 'month', 'day', 'hour', 'minute'].every(key => parts[key] === target[key]);
}

function offsetAt(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Resolve a local wall time deterministically: overlap chooses the earlier instant; DST gaps are skipped. */
export function resolveWeeklyWallTime(target, timeZone) {
  const wallUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const offsets = new Set();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) offsets.add(offsetAt(new Date(wallUtc + deltaHours * 3_600_000), timeZone));
  const matches = [...offsets].map(offset => new Date(wallUtc - offset))
    .filter(candidate => sameLocal(zonedParts(candidate, timeZone), target))
    .sort((a, b) => a - b);
  return matches[0]?.toISOString() ?? null;
}

export function validateWeeklyRecurrence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.frequency !== 'weekly'
    || !Number.isInteger(value.weekday) || value.weekday < 1 || value.weekday > 7
    || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23
    || !Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) {
    throw Object.assign(new Error('Weekly recurrence must define ISO weekday and local hour/minute.'), { code: 'A_ROUTINE_RECURRENCE_INVALID' });
  }
  return { frequency: 'weekly', weekday: value.weekday, hour: value.hour, minute: value.minute, dstGap: 'skip', dstOverlap: 'earlier' };
}

/** Checks that a persisted first/next occurrence matches the recurrence's local wall-clock contract. */
export function isWeeklyOccurrence(instantIso, recurrence, timeZone) {
  const normalized = validateWeeklyRecurrence(recurrence);
  let instant;
  try { instant = new Date(instantIso); new Intl.DateTimeFormat('en', { timeZone }); }
  catch { return false; }
  if (!Number.isFinite(instant.getTime())) return false;
  const local = zonedParts(instant, timeZone);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  return ISO_WEEKDAY(localDate) === normalized.weekday
    && local.hour === normalized.hour && local.minute === normalized.minute;
}

/** Returns the next wall-clock weekly occurrence strictly after `afterIso`; a nonexistent DST week is skipped. */
export function nextWeeklyOccurrence(afterIso, recurrence, timeZone) {
  const normalized = validateWeeklyRecurrence(recurrence);
  const after = new Date(afterIso);
  if (!Number.isFinite(after.getTime())) throw Object.assign(new Error('Invalid recurrence reference instant.'), { code: 'A_ROUTINE_TIME_INVALID' });
  const local = zonedParts(after, timeZone);
  const localMidnight = new Date(Date.UTC(local.year, local.month - 1, local.day));
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const date = new Date(localMidnight.getTime() + dayOffset * 86_400_000);
    if (ISO_WEEKDAY(date) !== normalized.weekday) continue;
    const target = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: normalized.hour, minute: normalized.minute };
    const candidate = resolveWeeklyWallTime(target, timeZone);
    if (candidate && candidate > after.toISOString()) return candidate;
  }
  throw Object.assign(new Error('No weekly occurrence found within the supported search window.'), { code: 'A_ROUTINE_RECURRENCE_UNRESOLVABLE' });
}
