import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKoreanOneTimeSchedule } from '../packages/core/src/runtime/korean-time-expression.js';

test('parses a Korean tomorrow-morning expression into the requested timezone instant', () => {
  const result = parseKoreanOneTimeSchedule('내일 오전 9시에 자료를 정리해', { clock: () => new Date('2026-09-28T10:00:00.000Z') });
  assert.deepEqual({ success: result.success, scheduledAt: result.scheduledAt, timeZone: result.timeZone, localDateTime: result.localDateTime }, {
    success: true, scheduledAt: '2026-09-29T00:00:00.000Z', timeZone: 'Asia/Seoul', localDateTime: '2026-09-29T09:00:00'
  });
});

test('handles month rollover, noon, and midnight with Korean AM/PM rules', () => {
  const clock = () => new Date('2026-01-31T00:00:00.000Z');
  const noon = parseKoreanOneTimeSchedule('내일 오후 12시', { clock });
  const midnight = parseKoreanOneTimeSchedule('내일 오전 12시', { clock });
  assert.equal(noon.scheduledAt, '2026-02-01T03:00:00.000Z');
  assert.equal(midnight.scheduledAt, '2026-01-31T15:00:00.000Z');
});

test('does not guess past, ambiguous DST, or nonexistent DST wall times', () => {
  const past = parseKoreanOneTimeSchedule('오늘 오전 9시', { clock: () => new Date('2026-09-28T01:00:00.000Z') });
  const ambiguous = parseKoreanOneTimeSchedule('내일 오전 1시', { timeZone: 'America/New_York', clock: () => new Date('2026-11-01T00:00:00.000Z') });
  const nonexistent = parseKoreanOneTimeSchedule('내일 오전 2시 30분', { timeZone: 'America/New_York', clock: () => new Date('2026-03-07T17:00:00.000Z') });
  assert.equal(past.code, 'A_ROUTINE_TIME_IN_PAST');
  assert.equal(ambiguous.code, 'A_ROUTINE_TIME_AMBIGUOUS');
  assert.equal(nonexistent.code, 'A_ROUTINE_TIME_NONEXISTENT');
});

test('unsupported schedule language and invalid timezone fail closed', () => {
  assert.equal(parseKoreanOneTimeSchedule('다음 주 중 편한 때', { clock: () => new Date('2026-09-28T10:00:00.000Z') }).code, 'A_ROUTINE_TIME_EXPRESSION_UNSUPPORTED');
  assert.equal(parseKoreanOneTimeSchedule('내일 오전 9시', { timeZone: 'Invalid/Zone' }).code, 'A_ROUTINE_TIMEZONE_INVALID');
});
