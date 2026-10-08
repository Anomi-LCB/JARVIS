export function createSourceRevisionPanel({ request, changed = () => {}, escape = value => String(value), canManage = () => false } = {}) {
  if (typeof request !== 'function') throw new TypeError('Source revision request client is required.');
  const state = { items: [], watches: [], watcher: null, status: 'checking', busy: false, error: '', message: '', open: false, missionResults: {},
    draft: { sourceKey: '', sourcePath: '', quietPeriodMs: 750 } };

  function setDraft(target) {
    const field = target?.dataset?.sourceWatchField;
    if (field && Object.hasOwn(state.draft, field)) state.draft[field] = target.value;
  }

  async function refresh() {
    if (state.busy) return;
    if (!canManage()) { state.status = 'auth-required'; state.items = []; state.watches = []; changed(); return; }
    state.busy = true; state.error = ''; changed();
    try {
      const data = await request('/source-revisions');
      state.items = Array.isArray(data?.items) ? data.items : [];
      state.watches = Array.isArray(data?.watches) ? data.watches : [];
      state.watcher = data?.watcher ?? null;
      state.status = 'ready';
    } catch (error) {
      state.status = 'unavailable';
      state.error = sourceRevisionErrorMessage(error);
    } finally { state.busy = false; changed(); }
  }

  async function register(form) {
    if (state.busy || !canManage()) return;
    const formData = new FormData(form);
    const sourceKey = String(formData.get('sourceKey') ?? '').trim();
    const sourcePath = String(formData.get('sourcePath') ?? '').trim();
    const quietPeriodMs = Number(formData.get('quietPeriodMs') ?? 750);
    if (!sourceKey || !sourcePath || !Number.isSafeInteger(quietPeriodMs) || quietPeriodMs < 0 || quietPeriodMs > 60_000) {
      state.error = '식별자·파일 경로와 0~60,000ms 대기 시간을 확인해 주세요.'; changed(); return;
    }
    state.busy = true; state.error = ''; state.message = ''; changed();
    try {
      await request('/source-revisions/watch', { method: 'POST', body: { sourceKey, sourcePath, quietPeriodMs } });
      state.draft = { sourceKey: '', sourcePath: '', quietPeriodMs: 750 };
      state.message = '파일 감시를 등록했습니다. 변경은 확인 대기열에 기록되며 자동 실행되지 않습니다.';
    } catch (error) { state.error = sourceRevisionErrorMessage(error); }
    finally { state.busy = false; await refresh(); }
  }

  async function remove(sourceKey) {
    if (state.busy || !canManage() || !sourceKey) return;
    state.busy = true; state.error = ''; state.message = ''; changed();
    try {
      await request(`/source-revisions/watch/${encodeURIComponent(sourceKey)}`, { method: 'DELETE' });
      state.message = '파일 감시를 해제했습니다. 이전 변경 기록은 보존됩니다.';
    } catch (error) { state.error = sourceRevisionErrorMessage(error); }
    finally { state.busy = false; await refresh(); }
  }

  async function runRevision(form) {
    if (state.busy || !canManage()) return;
    const sourceKey = form.dataset.sourceRevisionMission;
    const item = state.items.find(entry => entry.sourceKey === sourceKey);
    const formData = new FormData(form);
    const objective = String(formData.get('objective') ?? '').trim();
    if (!item || !objective) { state.error = '작업 지시와 현재 파일 revision을 확인해 주세요.'; changed(); return; }
    state.busy = true; state.error = ''; state.message = ''; changed();
    try {
      const result = await request(`/source-revisions/${encodeURIComponent(sourceKey)}/mission`, { method: 'POST', body: {
        revision: item.revision, sourceSha256: item.sourceSha256, objective
      } });
      state.missionResults[sourceKey] = result;
      state.message = `읽기 전용 Mission ${result.missionId ?? ''} 실행을 마쳤습니다. 상태와 결과를 확인하세요. 외부 모델 비용은 제공자 설정에 따라 달라지며 여기서는 측정되지 않았습니다.`;
    } catch (error) {
      state.error = sourceRevisionErrorMessage(error);
    } finally { state.busy = false; await refresh(); }
  }

  function render() {
    const active = state.watcher?.registrations?.length ?? 0;
    const summary = state.status === 'auth-required' ? '관리자 연결 필요'
      : state.status === 'ready' ? `${active}개 감시 중 · 변경 ${state.items.length}건`
        : state.busy ? '상태 확인 중' : state.status === 'unavailable' ? 'Core 연결 확인 필요' : '확인 중';
    const canAdmin = canManage();
    return `<details id="source-revisions" class="source-revisions panel" data-source-revisions ${state.open ? 'open' : ''}>
      <summary><strong>로컬 파일 변경 감시</strong><span>${escape(summary)}</span></summary>
      <div class="source-revisions-content">
        <div class="source-revisions-toolbar"><p>변경은 자동 실행되지 않습니다. 각 revision에서 작업을 직접 제출하면 현재 파일 해시를 다시 확인한 뒤 읽기 전용 Mission을 1회 실행합니다. 모델 비용은 구성에 따라 발생할 수 있습니다.</p>
          <button type="button" data-source-watch-refresh ${state.busy ? 'disabled' : ''}>새로고침</button></div>
        <p role="status">${escape(state.error || state.message || (state.status === 'auth-required' ? '관리자 토큰을 설정하면 감시 상태를 확인할 수 있습니다.' : '허용된 작업공간 안의 일반 파일만 등록할 수 있습니다. 파일당 최대 16 MiB, 감시 최대 64개입니다.'))}</p>
        ${canAdmin ? `<form class="source-revisions-form" data-source-watch-form>
          <label>감시 이름<input name="sourceKey" maxlength="200" required value="${escape(state.draft.sourceKey)}" data-source-watch-field="sourceKey" placeholder="sermon-notes" /></label>
          <label>작업공간 파일 경로<input name="sourcePath" maxlength="2048" required value="${escape(state.draft.sourcePath)}" data-source-watch-field="sourcePath" placeholder="C:\\Users\\...\\workspace\\notes.md" /></label>
          <label>변경 대기 시간 (ms)<input name="quietPeriodMs" type="number" min="0" max="60000" step="50" value="${escape(state.draft.quietPeriodMs)}" data-source-watch-field="quietPeriodMs" /></label>
          <button type="submit" ${state.busy ? 'disabled' : ''}>감시 등록</button>
        </form>` : ''}
        <div class="source-revisions-grid">${state.watches.map(watch => `<article class="source-revision-card"><header><strong>${escape(watch.sourceKey)}</strong><span>${watch.active && state.watcher?.registrations?.some(item => item.sourceKey === watch.sourceKey) ? '감시 중' : watch.active ? '재연결 필요' : '해제됨'}</span></header>
          <p>${escape(watch.sourcePath)}</p><small>변경 대기 ${watch.quietPeriodMs}ms · 등록 ${escape(watch.createdAt)}</small>
          ${watch.active && canAdmin ? `<button type="button" data-source-watch-remove="${escape(watch.sourceKey)}" ${state.busy ? 'disabled' : ''}>감시 해제</button>` : ''}</article>`).join('') || '<p>등록된 파일 감시가 없습니다.</p>'}</div>
        <div class="source-revisions-grid">${state.items.map(item => `<article class="source-revision-card"><header><strong>${escape(item.sourceKey)}</strong><span>${escape(item.state)}</span></header>
          <p>${escape(item.sourcePath)}</p><small>revision ${item.revision} · 입력 해시 ${escape(String(item.sourceSha256).slice(0, 16))}…</small>
          <small>관측 ${escape(item.observedAt)} · 완료 revision ${item.completedRevision ?? '없음'} · 시도 ${item.attempts}</small>
          ${item.lastError ? `<small class="source-revision-error">실패 코드 ${escape(item.lastError)}</small>` : ''}
          ${canAdmin ? `<form class="source-revision-mission-form" data-source-revision-mission="${escape(item.sourceKey)}"><label>이 revision에서 할 일<textarea name="objective" maxlength="4000" required placeholder="예: 파일을 읽고 핵심 주장과 근거를 요약해줘"></textarea></label><button type="submit" ${state.busy ? 'disabled' : ''}>읽기 전용 Mission 실행</button></form>` : ''}
          ${state.missionResults[item.sourceKey] ? `<small>최근 실행 Mission: ${escape(state.missionResults[item.sourceKey].missionId)} · ${escape(state.missionResults[item.sourceKey].mission?.status ?? '결과 확인 필요')}</small>` : ''}</article>`).join('') || '<p>아직 기록된 변경이 없습니다.</p>'}</div>
      </div>
    </details>`;
  }

  function attach(root) {
    root.addEventListener('toggle', event => { if (event.target.matches?.('[data-source-revisions]')) state.open = event.target.open; }, true);
    root.addEventListener('input', event => setDraft(event.target));
    root.addEventListener('click', event => {
      if (event.target.closest('[data-source-watch-refresh]')) void refresh();
      const button = event.target.closest('[data-source-watch-remove]');
      if (button) void remove(button.dataset.sourceWatchRemove);
    });
    root.addEventListener('submit', event => {
      if (event.target.matches('[data-source-revision-mission]')) {
        event.preventDefault(); void runRevision(event.target); return;
      }
      if (!event.target.matches('[data-source-watch-form]')) return;
      event.preventDefault(); void register(event.target);
    });
  }

  return { render, attach, refresh, state };
}

function sourceRevisionErrorMessage(error) {
  const code = error?.payload?.error?.code ?? error?.code ?? '';
  if (code === 'A_SOURCE_WATCH_PATH_OUTSIDE_ALLOWED_ROOT') return '이 파일은 Core가 허용한 작업공간 밖에 있습니다.';
  if (code === 'A_SOURCE_WATCH_FILE_TYPE_REJECTED') return '심볼릭 링크와 일반 파일이 아닌 경로는 감시할 수 없습니다.';
  if (code === 'A_SOURCE_WATCH_FILE_MISSING') return '파일이 없거나 읽을 수 없습니다. 경로와 접근 권한을 확인해 주세요.';
  if (code === 'A_SOURCE_WATCH_FILE_TOO_LARGE') return '파일이 16 MiB 제한을 넘습니다.';
  if (code === 'A_SOURCE_WATCH_LIMIT_REACHED') return '활성 파일 감시 64개 제한에 도달했습니다.';
  if (code === 'A_SOURCE_REVISION_PATH_CONFLICT') return '같은 감시 이름은 기존 파일 경로를 계속 사용해야 합니다.';
  if (code === 'A_SOURCE_REVISION_STALE') return '파일이 바뀌어 요청한 revision이 오래됐습니다. 목록을 새로고침한 뒤 다시 선택해 주세요.';
  if (code === 'A_SOURCE_REVISION_CHANGED_DURING_MISSION') return 'Mission 실행 중 파일이 바뀌어 결과를 현재 revision으로 확인할 수 없습니다. 최신 변경을 확인하고 다시 요청해 주세요.';
  if (code === 'A_SOURCE_WATCH_NOT_ACTIVE') return '파일 감시가 활성 상태가 아닙니다. 감시를 다시 등록한 뒤 시도해 주세요.';
  if (code === 'A_SOURCE_WATCHER_DUPLICATE') return '이미 등록된 감시 이름 또는 파일입니다.';
  if (error?.status === 401 || error?.status === 403) return 'Core 관리자 인증 또는 권한을 확인해 주세요.';
  return '파일 감시 요청을 완료하지 못했습니다. Core 상태와 입력을 확인해 주세요.';
}
