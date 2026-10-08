export function createPreferenceManagementPanel({ request, changed = () => {}, escape = String, canManage = () => false }) {
  const state = { open: false, items: [], busy: false, loaded: false, message: '', editing: null };
  let host;
  const inactive = item => item.contentWithheld || !['confirmed','expired'].includes(item.status);
  const localTime = value => {
    if(!value || !Number.isFinite(Date.parse(value)))return '';
    const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);
  };
  async function refresh() {
    if (state.busy) return;
    if (!canManage()) { state.items = []; state.editing = null; state.loaded = false; changed(); return; }
    state.busy = true; changed();
    try { const result = await request('/memory/preferences');
      if (!Number.isSafeInteger(result.memoryGeneration) || result.memoryGeneration < 0) throw new Error('Memory generation missing.');
      state.items = (result.items ?? []).map(item => ({ ...item, memoryGeneration: result.memoryGeneration })); state.loaded = true;
      if (state.editing) { const item = state.items.find(item => item.preferenceId === state.editing.id);
        if (!item || inactive(item)) state.editing = null;
        else if (item.memoryGeneration !== state.editing.memoryGeneration) {
          state.editing.conflict = true;
          state.message = '기억이 복구되어 저장하지 않았습니다. 최신 내용과 작성 중인 문구를 비교한 뒤 다시 저장해 주세요.';
        } } }
    catch { state.items = []; state.loaded = false; state.message = '기억을 불러오지 못했습니다. 관리자 연결을 확인해 주세요.'; }
    finally { state.busy = false; changed(); }
  }
  function edit(id) {
    const item = state.items.find(item => item.preferenceId === id);
    if (state.busy || !canManage() || !item || inactive(item)) return;
    state.editing = { id, revision: item.revision, memoryGeneration: item.memoryGeneration, statement: item.statement, expiry:localTime(item.validUntil), conflict: false };
    state.message = ''; changed();
  }
  async function mutate(id, action) {
    if (state.busy || !canManage()) return;
    const item = state.items.find(item => item.preferenceId === id);
    if (!item || inactive(item)) return;
    const draft = state.editing?.id === id ? state.editing : null;
    if (action === 'save' && (!draft || draft.conflict || !draft.statement.trim())) return;
    let validUntil;
    if(action==='save'){
      const parsed=draft.expiry?new Date(draft.expiry):null;
      if(parsed && !Number.isFinite(parsed.getTime())){state.message='유효기간을 올바르게 입력해 주세요.';changed();return;}
      validUntil=parsed?parsed.toISOString():null;
    }
    const revision = draft?.revision ?? item.revision;
    state.busy = true; state.message = ''; changed();
    try {
      const result = await request(`/memory/preferences/${encodeURIComponent(id)}${action === 'revoke' ? '/revoke' : ''}`, {
        method: action === 'save' ? 'PATCH' : 'POST', body: { expectedRevision: revision, expectedGeneration: draft?.memoryGeneration ?? item.memoryGeneration, ...(action === 'save' ? { statement: draft.statement, validUntil } : {}) } });
      if (result.success === false) throw { code: result.error?.code };
      state.editing = null;
      state.message = action === 'save' ? '기억을 수정했습니다.' : '이 선호의 사용을 중지했습니다. 저장 이력과 백업의 완전 삭제를 뜻하지는 않습니다.';
    } catch (error) {
      const code = error?.code ?? error?.payload?.error?.code ?? '';
      if (code === 'F_MEMORY_REVISION_CONFLICT') {
        if (draft) draft.conflict = true;
        state.message = '다른 곳에서 먼저 수정했습니다. 최신 내용과 작성 중인 문구를 비교한 뒤 다시 저장해 주세요.';
      } else if (code === 'F_MEMORY_GENERATION_CONFLICT') {
        if (draft) draft.conflict = true;
        state.message = '기억이 복구되어 저장하지 않았습니다. 최신 내용과 작성 중인 문구를 비교한 뒤 다시 저장해 주세요.';
      } else if (code === 'F_MEMORY_SOURCE_RETRACTED') {
        state.editing = null;
        state.message = '원자료가 철회되어 이 기억을 수정하거나 다시 사용할 수 없습니다.';
      } else state.message = '저장하지 못했습니다. 연결을 확인한 후 다시 시도해 주세요.';
    } finally {
      state.busy = false;
      await refresh();
      const latest = state.items.find(item => item.preferenceId === id);
      if (state.editing && latest && inactive(latest)) state.editing = null;
      changed();
    }
  }
  function render() {
    const disabled = state.busy ? 'disabled' : '';
    return `<details class="personal-inbox panel" data-preference-panel ${state.open ? 'open' : ''}><summary><strong>내가 확인한 선호</strong><span>내용 정정과 사용 중지</span></summary><div class="personal-inbox-content">
      <p>확정된 선호는 업무의 참고입니다. 실행 권한을 바꾸지 않습니다. 사용 중지는 저장 이력과 백업의 완전 삭제를 뜻하지 않습니다.</p>
      ${!canManage() ? '<p>관리자 연결 후 기억을 확인할 수 있습니다.</p>' : `<button type="button" data-preference-refresh ${disabled}>새로 확인</button>
      ${state.loaded && !state.items.length ? '<p>확인한 선호가 아직 없습니다.</p>' : ''}
      <div class="personal-inbox-grid">${state.items.map((item, index) => {
        const draft = state.editing?.id === item.preferenceId ? state.editing : null;
        return `<article class="personal-inbox-item"><h3>${item.contentWithheld ? '원자료가 철회된 기억' : item.status === 'revoked' ? '사용을 중지한 선호' : item.status === 'expired' ? '유효기간이 지난 선호' : '확정한 선호'}</h3>
        <p>${item.contentWithheld ? '내용을 표시하거나 재사용하지 않습니다.' : escape(item.statement)}</p><small>수정 버전 ${escape(item.revision)} · ${item.validUntil ? `유효기간 ${escape(item.validUntil)}` : '유효기간 미지정'}</small>
        ${item.status==='expired'?'<p>현재 업무에는 적용하지 않습니다. 기간을 수정하면 다시 참고할 수 있습니다.</p>':''}
        ${item.revisionHistory?.length?`<details><summary>수정 이력 ${escape(item.revisionHistory.length)}건</summary><ul>${item.revisionHistory.map(entry=>`<li>${escape(entry.action)} · ${escape(entry.at)}</li>`).join('')}</ul></details>`:''}
        ${inactive(item) ? '' : draft ? `<form data-preference-edit="${escape(item.preferenceId)}"><label for="preference-statement-${index}">정정할 내용</label><textarea id="preference-statement-${index}" name="statement" maxlength="2000" required data-preference-text ${disabled}>${escape(draft.statement)}</textarea>
        <label for="preference-expiry-${index}">유효기간 (비우면 미지정)</label><input id="preference-expiry-${index}" type="datetime-local" step="1" data-preference-expiry value="${escape(draft.expiry)}" ${disabled}>
        ${draft.conflict ? '<p>위에 표시된 최신 내용과 비교하세요.</p><button type="button" data-preference-rebase>최신 버전 확인 완료</button>' : ''}
        <button type="submit" ${state.busy || draft.conflict ? 'disabled' : ''}>수정 저장</button><button type="button" data-preference-cancel ${disabled}>수정 취소</button></form>`
        : `<button type="button" data-preference-edit-start="${escape(item.preferenceId)}" ${disabled}>내용 수정</button><button type="button" data-preference-revoke="${escape(item.preferenceId)}" ${disabled}>사용 중지</button>`}</article>`;
      }).join('')}</div>`}<p role="status" aria-live="polite">${escape(state.busy ? '처리 중입니다.' : state.message)}</p></div></details>`;
  }
  function attach(root) {
    host = root;
    root.addEventListener('toggle', event => { if (event.target.matches?.('[data-preference-panel]')) state.open = event.target.open; }, true);
    root.addEventListener('input', event => { if (event.target.matches?.('[data-preference-text]') && state.editing) state.editing.statement = event.target.value; if(event.target.matches?.('[data-preference-expiry]') && state.editing)state.editing.expiry=event.target.value; });
    root.addEventListener('submit', event => { if (event.target.matches?.('[data-preference-edit]')) { event.preventDefault(); void mutate(event.target.dataset.preferenceEdit, 'save'); } });
    root.addEventListener('click', event => {
      const target = event.target.closest?.('button'); if (!target || !host.contains(target)) return;
      if (target.hasAttribute('data-preference-refresh')) void refresh();
      if (target.hasAttribute('data-preference-edit-start')) edit(target.dataset.preferenceEditStart);
      if (target.hasAttribute('data-preference-revoke')) void mutate(target.dataset.preferenceRevoke, 'revoke');
      if (target.hasAttribute('data-preference-cancel') && !state.busy) { state.editing = null; changed(); }
      if (target.hasAttribute('data-preference-rebase') && state.editing && !state.busy) {
        const latest = state.items.find(item => item.preferenceId === state.editing.id);
        if (latest && !inactive(latest)) { state.editing.revision = latest.revision; state.editing.memoryGeneration = latest.memoryGeneration; state.editing.conflict = false; changed(); }
      }
    });
  }
  return { render, attach, refresh, edit, mutate };
}
