export function createMemoryStatusPanel({ request, changed = () => {}, escape = String, canManage = () => false,
  setTimer = setInterval, clearTimer = clearInterval }) {
  const state = { open: false, busy: false, value: null, message: '' };
  let timer = null, host;
  async function refresh() {
    if (state.busy) return;
    if (!canManage()) { state.value = null; state.message = ''; changed(); return; }
    state.busy = true; changed();
    try {
      const result = await request('/memory/status');
      if (result.success !== true || !['ready', 'pending', 'not_configured'].includes(result.status)) throw new Error('Unavailable.');
      state.value = result; state.message = '';
    } catch { state.value = null; state.message = '지금은 상태를 확인할 수 없습니다. 저장이 완료됐다는 뜻은 아닙니다.'; }
    finally { state.busy = false; changed(); }
  }
  function stop() { if (timer !== null) clearTimer(timer); timer = null; }
  function renderRetractions(value) {
    const projection = value?.sourceRetractions;
    const labels = { not_configured: "삭제 반영 연결이 준비되지 않았습니다.",
      not_observed: "삭제 반영을 아직 확인하지 않았습니다.",
      unavailable: "최근 삭제 반영 상태를 확인할 수 없습니다.",
      retry_pending: "삭제 반영에 대기하거나 다시 처리할 항목이 있습니다.",
      checked: "최근 확인에서 삭제 반영 대기는 없었습니다." };
    const validCount = v => Number.isSafeInteger(v) && v >= 0;
    const measured = projection && ["checked", "retry_pending"].includes(projection.status)
      && [projection.pendingCount, projection.deferredCount, projection.preferenceUpdateFailedCount].every(validCount)
      && projection.deferredCount <= projection.pendingCount
      && (projection.status !== "checked" || (projection.pendingCount === 0 && projection.preferenceUpdateFailedCount === 0));
    const label = measured || ["not_configured", "not_observed", "unavailable"].includes(projection?.status)
      ? labels[projection.status] : "삭제 반영 상태가 아직 확인되지 않았습니다.";
    return `<section data-memory-retractions><h3>삭제한 기억의 반영</h3><p>${escape(label)}</p>
      ${measured ? `<p>전달 대기: ${escape(projection.pendingCount)}건 · 다음 회차로 미룬 전달: ${escape(projection.deferredCount)}건 · 선호 기록 갱신 실패: ${escape(projection.preferenceUpdateFailedCount)}건</p>` : ""}
      ${projection?.observedAt ? `<small>최근 처리 확인: ${escape(projection.observedAt)}</small>` : ""}
      <p>이 수치는 연결된 기억 반영 경로의 최근 관측입니다. 모든 파생 자료와 백업 삭제를 보장하지 않습니다. 화면의 ‘상태 다시 확인’은 조회만 하며 처리 재실행을 요청하지 않습니다.</p></section>`;
  }
  function render() {
    const value = state.value, pending = value?.pending?.pendingCount;
    const label = !value ? '확인 필요' : value.status === 'not_configured' ? '기억 저장 연결 필요'
      : value.status === 'pending' ? '아직 저장하지 못한 기억이 있습니다' : '현재 저장 대기는 없습니다';
    const replay = value?.worker?.lastReplay;
    const warning = replay && (!replay.success || replay.failed > 0);
    return `<details class="personal-inbox panel" data-memory-status-panel ${state.open ? 'open' : ''}><summary><strong>기억 저장 상태</strong><span>${escape(label)}</span></summary><div class="personal-inbox-content">
      ${!canManage() ? '<p>관리자 연결 후 기억 상태를 확인할 수 있습니다.</p>' : `<p role="status">${escape(state.message || label)}</p>
      ${value ? `<p>저장 대기: ${pending === null ? '미확인' : escape(pending)}건 · 재처리 시도: ${value.pending.replayAttempts === null ? '미확인' : escape(value.pending.replayAttempts)}회</p>
      <p>${value.worker?.running ? 'Core 자동 재처리가 실행 중입니다.' : 'Core 자동 재처리 실행을 확인하지 못했습니다. 별도 기억 서비스의 실행 여부는 이 화면에서 확인하지 않습니다.'}</p>
      ${replay ? `<p>${warning ? '최근 재처리에서 문제가 확인됐습니다.' : '최근 재처리 결과'} 저장 ${replay.stored === null ? '미확인' : escape(replay.stored)}건 · 철회로 제외 ${replay.suppressed === null ? '미확인' : escape(replay.suppressed)}건 · 실패 ${replay.failed === null ? '미확인' : escape(replay.failed)}건</p>` : '<p>Core 재처리 관측 기록이 아직 없습니다.</p>'}
      ${renderRetractions(value)}
      <small>확인 시각: ${escape(value.observedAt)}</small>` : ''}
      <p>대기가 없다는 것은 모든 기억의 정확성이나 후속 보고서 완료를 뜻하지 않습니다. 이 화면은 기억 내용과 개인 자료를 표시하지 않습니다.</p>
      <button type="button" data-memory-status-refresh ${state.busy ? 'disabled' : ''}>상태 다시 확인</button>`}
    </div></details>`;
  }
  function attach(root) {
    if (host === root) return; host = root;
    root.addEventListener('toggle', event => {
      if (!event.target.matches?.('[data-memory-status-panel]')) return;
      if (state.open === event.target.open) return;
      state.open = event.target.open;
      if (state.open) { void refresh(); if (timer === null) timer = setTimer(() => { void refresh(); }, 5000); }
      else stop();
    }, true);
    root.addEventListener('click', event => { if (event.target.closest?.('[data-memory-status-refresh]')) void refresh(); });
    globalThis.addEventListener?.('pagehide', stop, { once: true });
  }
  return { render, attach, refresh, stop };
}
