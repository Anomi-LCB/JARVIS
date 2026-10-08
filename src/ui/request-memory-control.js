export function createRequestMemoryControl() {
  let enabled = true;
  return {
    set(value) { enabled = value === true; },
    metadata() { return { longTermMemory: enabled }; },
    render({busy = false, language = 'ko'} = {}) {
      const english=language==='en';
      const label=english?'Use previous memory for new requests':'새 요청에 이전 기억 활용';
      const mode=english ? (enabled?'Uses previously confirmed preferences and memory.':'Does not recall previous memory or personal profile.')
        : (enabled?'과거에 확인한 선호와 기억을 참고합니다.':'과거 기억과 개인 프로필을 참고하지 않습니다.');
      const help=english?'Current conversation tasks remain available. Storage and deletion settings are separate.':'현재 대화의 작업 내용은 유지합니다. 기억 저장·삭제 설정과는 별개입니다.';
      return `<div class="request-memory-control"><label for="request-memory-choice"><input id="request-memory-choice" type="checkbox" data-request-memory ${enabled ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-describedby="request-memory-help"> ${label}</label><p id="request-memory-help">${mode} ${help}</p></div>`;
    },
    attach(root, {isBusy = () => false, changed = () => {}} = {}) {
      root.addEventListener('change', event => {
        if (!event.target.matches('[data-request-memory]')) return;
        if (!isBusy()) enabled = event.target.checked === true;
        changed();
      });
    }
  };
}
