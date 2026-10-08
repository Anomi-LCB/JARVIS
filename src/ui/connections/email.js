const states=Object.freeze({
  'not-configured':'메일 설정 필요',unverified:'설정 있음 · 연결 확인 전',
  checking:'연결 확인 중',verified:'연결 확인됨',paused:'이 프로그램에서 사용 중지됨',
  stale:'연결을 다시 확인해야 합니다',failed:'연결 확인 실패'
});
export function renderEmailConnectionUnavailable({pc=false,adminMissing=false}={}){
 if(pc)return `<section data-connection-unavailable aria-label="PC 메일 연결 관리 미준비"><h2>${adminMissing?'이 PC의 보호 관리 연결이 필요합니다':'현재 PC 서비스의 메일 연결 관리가 준비되지 않았습니다'}</h2><p>${adminMissing?'PC 서비스 관리자 연결을 설치 설정에서 준비하세요. 이 페이지에 토큰이나 비밀번호를 입력하지 마세요.':'PC 서비스의 실행 상태와 설치 버전을 확인하세요. 메일 연결 관리가 포함된 서비스가 필요합니다.'}</p><p>현재 상태를 확인하지 못해 이전 연결과 실행 버튼을 숨겼습니다. Core 계정이나 다른 장치의 설정으로 대신 연결하지 않습니다.</p><a href="runtime.html">실행 환경 확인</a></section>`;
 return '<section data-connection-unavailable aria-label="메일 연결 관리 미준비"><h2>현재 실행 환경의 메일 연결 관리가 준비되지 않았습니다</h2><p>원격 PC 실행 환경은 이 화면의 로컬 메일 연결 확인을 지원하지 않습니다. 이 PC에 설정이 있더라도 원격 장치의 계정 연결로 대신 사용하지 않습니다.</p><p>이전 연결 상태는 숨겼으며 발송 권한을 부여하지 않았습니다. 설치 담당자에게 실제 실행 장치의 메일 연결과 보호 설정 지원을 확인하세요.</p><a href="runtime.html">실행 환경 확인</a></section>';
}
export function renderEmailConnection(status={}, {escape,enabled=false,busy=false}={}) {
  const verified=status.status==='verified'&&status.available===true&&status.providerVerified===true;
  const label=verified?states.verified:states[status.status==='verified'?'stale':status.status]??'현재 상태 미확인';
  return `<section aria-label="메일 연결 상태"><h2>메일 발송 연결</h2><p data-email-status>${escape(label)}</p>
    <p>설정이 있어도 연결 확인 전에는 자동 발송할 수 없습니다. 연결 확인은 서버 접속·암호화·인증만 검사하며 메일을 보내지 않습니다.</p>
    ${verified?'<p>서버 인증을 확인했습니다. 특정 발신자의 발송 허용·수신함 도착은 아직 확인하지 않았습니다. 실제 발송에는 별도의 대상·위임·검증이 필요합니다.</p>':''}
    <p>마지막 확인: ${escape(status.checkedAt??'아직 확인하지 않음')}</p>
    <button type="button" data-email-probe ${!enabled||!status.configured||busy?'disabled':''}>${busy?'처리 중…':'메일 보내지 않고 연결 확인'}</button>
    <button type="button" class="secondary" data-email-pause ${!enabled||!status.configured||busy||status.status==='paused'?'disabled':''}>이 프로그램에서 사용 중지</button></section>
    <section aria-label="메일 연결 준비"><h2>연결 준비와 다시 사용하기</h2>
    <p>${status.configured?'현재 실행 환경에 메일 설정이 있습니다. 사용을 재개하려면 연결 확인을 누르세요.':'현재 실행 환경에 지원되는 메일 설정이 없습니다. 설치 담당자가 이 실행 환경의 메일 설정을 준비해야 합니다.'}</p>
    <p>이 화면은 기존 로컬 메일 설정을 확인합니다. 비밀번호·인증 코드를 입력하거나 새로운 계정을 등록하는 화면은 아닙니다. Google 메일·일정 수집은 별도 화면에서 연결합니다.</p>
    <a href="accounts.html">Google 계정 연결 관리</a><p>사용 중지는 이 프로그램의 발송을 막습니다. 저장된 자격증명 삭제나 제공자 계정의 권한 철회를 수행하지 않습니다. 프로그램 재시작 후에는 연결을 다시 확인해야 합니다.</p></section>`;
}
