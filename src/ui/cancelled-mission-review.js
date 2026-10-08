const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const labels = { 'verified-executed': '실행 결과 확인됨', 'not-dispatched': '실행기에 전달되지 않음', 'not-started': '시작하지 않음', unresolved: '실행 결과 미확인' };
const nextAction = item => /MANDATE|PERMISSION/u.test(item.causeCode ?? item.reason ?? '')
  ? '연결·위임 화면에서 현재 자료 접근 권한을 확인한 뒤 다시 조회하세요.'
  : /SCOPE_UNSUPPORTED/u.test(item.reason ?? '') ? '이 도구는 결과 조회를 아직 지원하지 않습니다. 해당 앱에서 처리 상태를 직접 확인하세요.'
  : '해당 앱의 결과 파일이나 처리 기록을 확인하세요. 같은 명령을 바로 다시 실행하면 중복될 수 있습니다.';
const keyFor = (mission, endpoint) => JSON.stringify([endpoint, mission.missionId, mission.goalContract?.revision, mission.goalContract?.objectiveSha256]);
const available = mission => mission?.status === 'CANCELLED' && typeof mission.missionId === 'string'
  && Number.isSafeInteger(mission.goalContract?.revision) && mission.goalContract.revision > 0
  && /^[a-f0-9]{64}$/u.test(mission.goalContract?.objectiveSha256 ?? '');

// Tab-local observations never grant execution authority or change Mission state.
export function createCancellationReviewPanel({ request, endpoint = () => '', changed = () => {} }) {
  const states = new Map();
  return {
    async review(mission) {
      if (!available(mission)) return;
      const key = keyFor(mission, endpoint());
      if (states.get(key)?.busy) return;
      const revision = mission.goalContract.revision, sha256 = mission.goalContract.objectiveSha256;
      const state = { busy: true }; states.set(key, state); changed();
      try {
        const result = await request(`/missions/${encodeURIComponent(mission.missionId)}/cancellation-review`, {
          method: 'POST', timeoutMs: 180_000,
          body: { expectedGoalRevision: revision, expectedObjectiveSha256: sha256 }
        });
        if (result?.success !== true || result.reviewVersion !== 'a-cancelled-mission-review-v1'
          || result.status !== 'CANCELLED' || result.missionId !== mission.missionId
          || result.goalRevision !== revision || result.objectiveSha256 !== sha256
          || result.executionAuthority !== false || result.effectsChanged !== false || result.memoriesChanged !== false
          || !Number.isFinite(Date.parse(result.checkedAt)) || !Array.isArray(result.items) || result.items.length > 40
          || result.items.some(item => !Object.hasOwn(labels, item.status)
            || item.currentArtifactVerified !== (item.status === 'verified-executed'))
          || result.unresolvedCount !== result.items.filter(item => item.status === 'unresolved').length) {
          throw Object.assign(new Error('Invalid observation'), { code: result?.error?.code ?? 'INVALID_OBSERVATION' });
        }
        state.result = result;
      } catch (error) {
        const code = String(error?.code ?? error?.payload?.error?.code ?? error?.body?.error?.code ?? '');
        state.error = /SOURCE_CHANGED/u.test(code) ? '목표 정보가 바뀌었습니다. 화면을 새로고침한 뒤 다시 조회하세요.'
          : /RUN_ACTIVE/u.test(code) ? '진행 중인 동작이 멈추는 중입니다. 잠시 후 다시 조회하세요.'
          : '결과를 조회하지 못했습니다. 연결과 접근 권한을 확인한 뒤 다시 조회하세요.';
      } finally { state.busy = false; changed(); }
    },
    render(mission) {
      if (mission?.status !== 'CANCELLED') return '';
      const state = states.get(keyFor(mission, endpoint())) ?? {};
      return `<section class="mission-outcome" data-cancellation-review aria-label="중단한 작업 결과 확인">
        <h4>중단한 작업의 실제 결과</h4>
        <p>취소 전에 일부 작업이 실행됐을 수 있습니다. 이 조회는 작업을 다시 실행하거나 이미 만든 결과를 되돌리지 않습니다.</p>
        <button type="button" data-mission-review="${escape(mission.missionId)}" ${state.busy || !available(mission) ? 'disabled' : ''}>${state.busy ? '결과 확인 중…' : '실행 결과 확인'}</button>
        <div role="status" aria-live="polite">${state.error ? `<p>${escape(state.error)}</p>` : ''}${state.busy ? '<p>기존 처리 기록과 현재 결과를 대조하고 있습니다.</p>' : ''}</div>
        ${!available(mission) ? '<p>이전 목표 기록에 조회 기준이 없습니다. 해당 앱에서 처리 상태를 확인하세요.</p>' : ''}
        ${state.result ? `<p>확인 시각: ${escape(state.result.checkedAt)} · 미확인 ${state.result.unresolvedCount}건</p>
          <ul class="mission-criteria">${state.result.items.map((item, i) => `<li><strong>작업 ${i + 1}: ${labels[item.status]}</strong>${item.status === 'unresolved' ? `<p>${escape(nextAction(item))}</p>` : ''}</li>`).join('')}</ul>
          ${!state.result.items.length ? '<p>기록된 실행 단계가 없습니다.</p>' : ''}
          <p>현재 관측 결과이며 전체 목표 완료나 취소에 따른 원상 복구를 뜻하지 않습니다.</p>` : ''}
      </section>`;
    }
  };
}
