const escape = value => String(value ?? '').replace(/[&<>"']/gu, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const statusLabels = {
  scheduled: '예약됨', dispatching: '실행 중', completed: '완료', missed: '놓침', blocked: '조건 확인 필요', failed: '실패'
};

export { parseWeeklyRoutineCommand } from '../../packages/core/src/runtime/korean-weekly-routine-command.js';
import { parseWeeklyRoutineCommand } from '../../packages/core/src/runtime/korean-weekly-routine-command.js';

export function createRoutineRequest(draft, routineId) {
  const scheduleText = String(draft?.scheduleText ?? '').trim();
  const objective = String(draft?.objective ?? '').trim();
  const successCriteria = String(draft?.successCriteria ?? '').split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
  if (!/^[A-Za-z0-9:_-]{1,160}$/u.test(routineId ?? '')) throw new Error('예약 식별값을 만들지 못했습니다.');
  if (!scheduleText || scheduleText.length > 300) throw new Error('예약 시각을 1~300자로 입력해 주세요. 예: 내일 오전 9시');
  if (!objective || objective.length > 32768) throw new Error('실행할 작업을 1~32,768자로 입력해 주세요.');
  if (!successCriteria.length || successCriteria.length > 12 || successCriteria.some(item => item.length > 2000)) {
    throw new Error('완료 기준을 한 줄에 하나씩, 1~12개 입력해 주세요.');
  }
  const timeZone = String(draft?.timeZone ?? 'Asia/Seoul').trim();
  if (!timeZone || timeZone.length > 100) throw new Error('시간대를 확인해 주세요. 예: Asia/Seoul');
  const recurrence = draft?.recurrenceEnabled
    ? { frequency: 'weekly', weekday: Number(draft.weekday), hour: Number(draft.hour), minute: Number(draft.minute) }
    : null;
  if (recurrence && (!Number.isInteger(recurrence.weekday) || recurrence.weekday < 1 || recurrence.weekday > 7
    || !Number.isInteger(recurrence.hour) || recurrence.hour < 0 || recurrence.hour > 23
    || !Number.isInteger(recurrence.minute) || recurrence.minute < 0 || recurrence.minute > 59)) throw new Error('주간 반복 요일과 현지 시각을 확인해 주세요.');
  return {
    routineId,
    scheduleText,
    timeZone,
    ...(recurrence ? { recurrence } : {}),
    missionRequest: {
      objective,
      successCriteria,
      constraints: [
        '등록된 JARVIS 작업공간과 현재 연결된 저위험 로컬 기능 안에서만 실행한다.',
        '메일·메신저 발송, 예약 확정, 구매·결제·송금, 금융·의료 판단, 스마트홈·차량·도어락 제어를 하지 않는다.',
        '현재 준비 조건이나 권한이 부족하면 우회하거나 늦게 실행하지 말고 차단 이유와 필요한 조치를 남긴다.'
      ],
      authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }
    }
  };
}

/** Resolves timezone edits only when a quoted objective uniquely identifies a scheduled weekly routine. */
export function parseWeeklyRoutineTimezoneCommand(command, routines = []) {
  const text = String(command ?? '').trim();
  const match = /^(?:주간\s*)?예약\s*[“"‘'](.+?)[”"’']\s*시간대(?:를|을)?\s*([A-Za-z_+-]+(?:\/[A-Za-z_+-]+)+)\s*(?:로|으로)?\s*(?:바꿔줘|변경해줘|바꿔|변경)$/u.exec(text);
  if (!match) return { matched: false };
  const objective = match[1].trim();
  const candidates = (Array.isArray(routines) ? routines : []).filter(item => item?.status === 'scheduled'
    && item?.recurrence?.frequency === 'weekly' && String(item?.missionRequest?.objective ?? '').trim() === objective);
  if (candidates.length !== 1) return { matched: true, valid: false,
    reason: candidates.length ? '같은 작업의 주간 예약이 여러 개라 대상을 하나로 정할 수 없습니다.' : '해당 이름과 일치하는 대기 중 주간 예약을 찾지 못했습니다.' };
  return { matched: true, valid: true, routineId: candidates[0].routineId, timeZone: match[2] };
}

export function renderRoutineControlPanel({ items = [], status = 'checking', busy = false, error = null, notice = null,
  draft = {}, timezoneDrafts = {}, canManage = false } = {}) {
  const statusMessage = status === 'ready' ? 'Core SQLite 예약 장부에 연결됨'
    : status === 'auth-required' ? 'Core 관리자 토큰을 연결 설정에 입력한 뒤 새로고침하세요.'
      : status === 'unavailable' ? '예약 API에 연결할 수 없습니다. Core 서비스와 권한을 확인하세요.'
        : '예약 연결 확인 중';
  const rows = items.length ? `<ol class="routine-list">${items.slice(0, 8).map(item => {
    const cancelled = item.notification?.kind === 'routine-cancelled-by-user';
    const timeZone = typeof item.timeZone === 'string' ? item.timeZone : 'Asia/Seoul';
    const dateLabel = Number.isFinite(Date.parse(item.scheduledAt))
      ? new Date(item.scheduledAt).toLocaleString('ko-KR', { timeZone, dateStyle: 'medium', timeStyle: 'short' })
      : '시각 정보 없음';
    const detail = cancelled ? '실행 전에 취소했습니다. 필요하면 새 시각으로 다시 예약할 수 있습니다.'
      : item.status === 'missed' ? item.notification?.nextAction ?? '다시 실행할지 선택하거나 새 시각을 예약해 주세요.'
      : item.status === 'blocked' || item.status === 'failed' ? item.notification?.stopReason ?? item.notification?.kind ?? '실행 결과를 확인해 주세요.'
        : item.status === 'completed' ? 'Mission 완료 상태가 기록되었습니다.'
          : item.status === 'dispatching' ? 'Mission 실행과 결과 검증을 진행 중입니다.' : item.recurrence ? '매주 현지 시각 기준으로 실행합니다.' : '예약 시각에 한 번 실행합니다.';
    return `<li class="routine-item routine-${cancelled ? 'cancelled' : escape(item.status)}">
      <div><strong>${cancelled ? '취소됨' : escape(statusLabels[item.status] ?? '상태 미확인')}</strong><time datetime="${escape(item.scheduledAt)}">${escape(dateLabel)} · ${escape(timeZone)}</time></div>
      <p>${escape(item.missionRequest?.objective ?? '예약 작업')}</p><small>${escape(detail)}</small>
      ${item.status === 'scheduled' ? `${item.recurrence ? `<label>시간대 변경<input data-routine-timezone-field="${escape(item.routineId)}" value="${escape(timezoneDrafts[item.routineId] ?? timeZone)}" maxlength="100" placeholder="America/Los_Angeles" ${busy || !canManage ? 'disabled' : ''}></label><button type="button" class="ghost" data-routine-timezone="${escape(item.routineId)}" ${busy || !canManage ? 'disabled' : ''}>시간대 적용</button>` : ''}<button type="button" class="ghost routine-cancel" data-routine-cancel="${escape(item.routineId)}" ${busy || !canManage ? 'disabled' : ''}>예약 취소</button>` : ''}
    </li>`;
  }).join('')}</ol>` : `<p class="routine-empty">저장된 일회성 예약이 없습니다.</p>`;
  const errorMarkup = error ? `<p class="routine-feedback error" role="alert">${escape(error)}</p>` : '';
  const noticeMarkup = notice ? `<p class="routine-feedback success" role="status">${escape(notice)}</p>` : '';
  return `<section class="routine-control-panel" aria-labelledby="routine-title">
    <header class="routine-panel-heading"><div><h2 id="routine-title">예약 작업</h2><p>${escape(statusMessage)}</p></div>
      <button type="button" class="ghost" data-routine-refresh ${busy ? 'disabled' : ''}>새로고침</button></header>
    <p class="routine-scope">오늘·내일의 일회성 예약과 주간 반복을 지원합니다. 예약 권한은 읽기와 되돌릴 수 있는 로컬 작업으로 제한되며 외부 발송·거래·물리 기기는 예약 실행하지 않습니다. 반복 시 DST에 존재하지 않는 현지 시각은 그 주에 건너뛰고, 두 번 생기는 현지 시각은 먼저 오는 순간을 택합니다. 놓친 작업은 늦게 실행하지 않습니다.</p>
    ${errorMarkup}${noticeMarkup}
    <form class="routine-form" data-routine-form>
      <label>실행 시각<input name="scheduleText" data-routine-field="scheduleText" value="${escape(draft.scheduleText)}" maxlength="300" placeholder="내일 오전 9시" required ${busy || !canManage ? 'disabled' : ''}></label>
      <label>시간대<input name="timeZone" data-routine-field="timeZone" value="${escape(draft.timeZone ?? 'Asia/Seoul')}" maxlength="100" required ${busy || !canManage ? 'disabled' : ''}></label>
      <label class="routine-weekly-toggle"><input type="checkbox" name="recurrenceEnabled" data-routine-field="recurrenceEnabled" ${draft.recurrenceEnabled ? 'checked' : ''} ${busy || !canManage ? 'disabled' : ''}> 매주 반복</label>
      ${draft.recurrenceEnabled ? `<label>요일<select name="weekday" data-routine-field="weekday" ${busy || !canManage ? 'disabled' : ''}>${[[1,'월요일'],[2,'화요일'],[3,'수요일'],[4,'목요일'],[5,'금요일'],[6,'토요일'],[7,'일요일']].map(([value,label]) => `<option value="${value}" ${Number(draft.weekday ?? 1) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>현지 시각<input name="hour" data-routine-field="hour" type="number" min="0" max="23" value="${escape(draft.hour ?? 9)}" required ${busy || !canManage ? 'disabled' : ''}></label><label>분<input name="minute" data-routine-field="minute" type="number" min="0" max="59" value="${escape(draft.minute ?? 0)}" required ${busy || !canManage ? 'disabled' : ''}></label>` : ''}
      <label>실행할 작업<textarea name="objective" data-routine-field="objective" maxlength="32768" rows="2" placeholder="작업 폴더의 새 자료를 읽고 요약 초안을 저장해" required ${busy || !canManage ? 'disabled' : ''}>${escape(draft.objective)}</textarea></label>
      <label>완료 기준 <small>한 줄에 하나씩</small><textarea name="successCriteria" data-routine-field="successCriteria" maxlength="8000" rows="2" placeholder="요약 파일이 생성되고 내용 검증을 통과한다" required ${busy || !canManage ? 'disabled' : ''}>${escape(draft.successCriteria)}</textarea></label>
      <button type="submit" ${busy || !canManage ? 'disabled' : ''}>${busy ? '예약 저장 중…' : draft.recurrenceEnabled ? '매주 예약' : '한 번 예약'}</button>
    </form>
    <div class="routine-list-heading"><h3>최근 예약 ${items.length}건</h3><span>반복 일정은 occurrence별로 중복 실행을 차단</span></div>
    ${rows}
  </section>`;
}

export function routineApiFailureMessage(error) {
  const code = error?.payload?.error?.code;
  const messages = {
    A_ROUTINE_TIME_INPUT_CONFLICT: '실행 시각 표현을 확인해 주세요.',
    A_ROUTINE_TIME_EXPRESSION_UNSUPPORTED: '오늘 또는 내일의 오전/오후 시각만 예약할 수 있습니다.',
    A_ROUTINE_TIME_EXPRESSION_INVALID: '시각 표현이 올바르지 않습니다.',
    A_ROUTINE_TIME_IN_PAST: '지정한 시간은 이미 지났습니다.',
    A_ROUTINE_TIME_NONEXISTENT: '시간대 전환으로 존재하지 않는 시각입니다.',
    A_ROUTINE_TIME_AMBIGUOUS: '시간대 전환으로 두 번 발생하는 시각입니다.',
    A_ROUTINE_RECURRENCE_SCHEDULE_MISMATCH: '첫 실행 시각의 현지 요일과 시간이 주간 반복 규칙과 일치하지 않습니다.',
    A_ROUTINE_AUTHORITY_NOT_PERSISTABLE: '높은 권한을 저장하는 예약은 허용되지 않습니다.',
    A_ROUTINE_IDEMPOTENCY_CONFLICT: '같은 예약 식별값에 다른 내용이 등록되어 새 예약을 만들지 못했습니다.',
    A_ROUTINE_SCHEDULER_UNAVAILABLE: '예약 기능이 Core 서비스에서 준비되지 않았습니다.'
  };
  if (error?.status === 401 || error?.status === 403) return '예약 권한이 없습니다. Core 관리자 토큰과 허용 범위를 확인해 주세요.';
  return messages[code] ?? (error?.name === 'AbortError' ? '예약 요청 시간이 초과되었습니다. 저장 상태를 새로고침해 확인해 주세요.' : '예약을 저장하지 못했습니다. 입력과 Core 연결 상태를 확인해 주세요.');
}
