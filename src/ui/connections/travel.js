import {renderTravelPrerequisites} from './travel-prerequisites.js';
export function renderTravelConnection(status={},quote=null,{escape,enabled=false,busy=false,setup={}}={}) {
  const reasons={'broker-not-configured':'견적 중개 서비스가 아직 설정되지 않았습니다.','metadata-invalid':'연결 기록을 확인하지 못했습니다.',
    'connection-closed':'연결 서비스가 종료됐습니다.','provider-call-unverified':'연결 설정 있음 · 실제 견적 조회 전',
    'connection-required':'계정 연결이 필요합니다.','account-selection-required':'사용할 계정을 지정해야 합니다.',
    'broker-access-revoked':'중개 서버가 이 프로그램의 접근 해제를 확인했습니다.',
    'local-access-store-unavailable':'로컬 연결 중지 기록을 확인하지 못해 견적 조회를 차단했습니다. 운영자에게 저장소 접근과 무결성을 확인하세요.'};
  const configured=status.credentialsConfigured===true;
  const setupStates={idle:'보호 설정 창에서 시험 키를 직접 입력할 수 있습니다.','waiting-user':'별도 보호 설정 창에서 입력을 완료하거나 취소하세요.',
    'stored-unverified':'시험 키 저장을 확인했습니다. 상태 새로고침 후 견적을 조회해 실제 접근을 확인하세요.',cancelled:'사용자가 설정을 취소했습니다.',
    failed:'설정 완료를 확인하지 못했습니다. 설치 설정과 보호 저장소를 확인하세요.','metadata-pending':'키 저장 후 공개 연결 기록을 내보내지 못했습니다. 기존 저장 기록을 먼저 확인하세요.',
    'outcome-unknown':'설정 결과를 확인할 수 없습니다. 기존 보호 저장 기록을 확인하기 전에는 반복 실행하지 않습니다.'};
  const setupEnabled=setup.available===true&&!['waiting-user','metadata-pending','outcome-unknown'].includes(setup.state);
  return `${renderTravelPrerequisites(escape)}<section><h2>보호 계정 설정</h2><p>${escape(setup.available?setupStates[setup.state]??'설정 상태를 확인하세요.':'이 설치 환경에는 보호 설정 도우미가 준비되지 않았습니다.')}</p>
    <button type="button" data-travel-setup ${!setupEnabled||busy?'disabled':''}>보호 설정 창 열기</button>
    <button type="button" data-travel-setup-status ${busy?'disabled':''}>설정 결과 확인</button><p>키는 별도 Windows 입력 창에만 입력합니다. 이 페이지에서는 키·비밀번호를 받지 않습니다.</p></section>
    <section><h2>항공 견적 연결</h2><p>${escape(reasons[status.reason]??'연결 상태를 확인하지 못했습니다.')}</p>
    <p>현재 지원: Duffel 시험 환경의 기존 견적 조회. 예약·결제·취소는 아직 지원하지 않습니다.</p>
    <p>API 키는 별도 보호 중개 서비스에 보관합니다. 이 화면에 비밀번호나 키를 입력하지 마세요.</p>
    <form data-travel-quote><label>조회할 견적 번호<input name="offerId" maxlength="132" required pattern="off_[A-Za-z0-9_-]{1,128}" placeholder="off_로 시작하는 견적 번호"></label>
      <p>조회 버튼을 누를 때만 읽기 요청을 보냅니다. 기존 견적 번호가 필요하며 새 항공편 검색은 아직 연결되지 않았습니다.</p>
      <button ${!enabled||!configured||busy?'disabled':''}>${busy?'견적 조회 중…':'견적 조회'}</button></form>
    ${!configured?'<p>다음 단계: 중개 서비스의 시험 계정·인증서·연결 기록을 설정한 뒤 상태를 새로고침하세요. 일반 사용자용 보호 연결 설정 도우미는 아직 준비 중입니다.</p>':''}</section>
    <section aria-label="견적 연결 해제"><h2>견적 연결 해제</h2><p>이 프로그램의 중개 인증서 접근을 해제하고 현재 견적 조회를 중지합니다. 중개 서버에 저장된 키를 삭제하거나 제공자 계정의 키를 폐기하는 작업은 아닙니다. 같은 인증서에 허용된 모든 견적 연결에 적용됩니다.</p><button data-travel-disconnect ${!enabled||busy||!configured||status.brokerDisconnectSupported!==true?'disabled':''}>중개 접근 해제</button><p>${status.brokerAccessRevoked===true?'서버 확인 영수증을 받았습니다. 다시 연결하려면 운영자가 새 인증서와 연결 설정을 준비해야 합니다.':status.reason==='connection-closed'?`로컬 조회는 중지됐지만 원격 해제 결과를 확인하지 못했습니다. ${status.localPausePersisted===true?'저장된 중지 기록은 재시작 후에도 유지됩니다.':'중지 기록의 저장은 확인되지 않았습니다.'} 운영자에게 인증서 철회 상태를 확인하세요. 자동 재시도하지 않습니다.`:status.brokerDisconnectSupported!==true?'이 설치 환경에서 해제 경로를 확인하지 못했습니다. 운영자에게 중개 인증서 철회를 요청하세요.':'접근 해제 후 다시 연결하려면 새 인증서가 필요합니다.'}</p></section>
    ${quote?`<section aria-label="조회한 견적"><h2>조회한 시험 견적</h2><p>${escape(quote.offerId)} · ${escape(quote.offerTotalAmount)} ${escape(quote.currency)}</p>
      <p>견적 유효 시각: ${escape(quote.expiresAt)}</p><p>이 금액은 견적에 표시된 금액입니다. 추가 서비스·결제 비용을 포함한 최종 총액은 미검증입니다.</p>
      <p>조회 결과는 예약 완료나 실행 권한을 뜻하지 않습니다. 만료·가격 변경 시 다시 조회해야 합니다.</p></section>`:''}`;
}
