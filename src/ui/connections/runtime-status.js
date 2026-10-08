/** Read-only observations, never a grant or evidence of an actual completed job. */
export async function loadRuntimeConnectionStatus({request}) {
 const results=await Promise.allSettled(['/health','/missions?limit=1','/security/trust'].map(path=>request(path)));
 const value=index=>results[index].status==='fulfilled'?results[index].value:null;
 const health=value(0),missions=value(1),trust=value(2);
 const connected=health?.module==='A_CORE'&&['ok','running','healthy'].includes(health.status);
 const mode=['standard','recovery-only'].includes(missions?.status?.executionMode)?missions.status.executionMode:'unknown';
 return {connected,mode,trust:trust?.mode==='trusted'?'trusted':'unverified',
  missionStatusObserved:results[1].status==='fulfilled',observedAt:new Date().toISOString(),workCompletionVerified:false};
}
export function renderRuntimeConnectionStatus(observation) {
 const current=observation??{};
 const mode=current.connected!==true?'접속 확인 필요':current.mode==='recovery-only'?'기존 실행 결과 확인 전용':current.mode==='standard'?'일반 실행 모드':'실행 모드 미확인';
 const advice=current.connected!==true?'Core를 실행하고 주소와 관리 인증을 확인하세요.':current.mode==='recovery-only'?'새 작업을 실행하지 않습니다. 작업 화면에서 기존 결과를 확인하고, 확인이 끝난 뒤 일반 모드로 명시적으로 다시 시작하세요.':current.mode!=='standard'?'현재 실행 모드를 확인하지 못했습니다. 프로그램 버전과 관리 인증을 확인하세요.':current.trust!=='trusted'?'보안 상태를 확인하지 못했습니다. 작업을 맡기기 전에 진단 화면을 확인하세요.':'연결된 기능과 현재 위임 범위 안에서 작업할 수 있습니다. 계정·PC·도구별 준비 조건은 각 연결 화면에서 확인하세요.';
 return `<section aria-label="현재 실행 상태"><h2>현재 실행 상태</h2><p><strong>${mode}</strong></p><p>${advice}</p><dl><dt>Core 접속</dt><dd>${current.connected===true?'이번 조회에서 응답 확인':'미확인'}</dd><dt>보안 상태</dt><dd>${current.trust==='trusted'?'이번 조회에서 정상 확인':'미확인'}</dd><dt>실제 업무 완료 검증</dt><dd>이 연결 검사로는 확인하지 않습니다. 작업별 결과를 확인하세요.</dd></dl><p>주소 저장·서버 응답·실제 업무 완료는 서로 다른 상태입니다.</p><a href="/#tasks">작업과 확인된 결과 보기</a></section>`;
}
