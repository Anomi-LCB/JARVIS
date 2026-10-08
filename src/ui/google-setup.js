import {createGoogleCollection} from './google-collection.js';
export function createGoogleSetup({request,changed,refresh,escape,onQuotaChanged=async()=>{},simple=false}){
  const collection=createGoogleCollection({request,changed,refresh,escape});
  let open=false,scopeOpen=false,data={},clientPath='',busy=false,error='',timer=null;const drafts=new Map();
  const connecting=()=>['awaiting-consent','activating'].includes(data.connection?.status);
  const brokerMode=()=>data.connection?.credentialLocation==='broker';
  function update(next){data=next;collection.update(next.collection);clearTimeout(timer);if(connecting())timer=setTimeout(()=>void refresh(),2000);}
  function renderBroker(){
    const labels={'verification-required':'연결 준비 정보가 있습니다. 실제 계정 조회를 확인해 주세요.','activating':'안전한 중개 연결을 확인하고 있습니다.','connected':'계정 조회를 확인했습니다. 수집 범위와 결과는 별도로 확인합니다.','blocked':'연결 준비 정보를 다시 확인해야 합니다.','failed':'중개 연결을 확인하지 못했습니다. 운영자에게 연결 상태 점검을 요청해 주세요.'};
    return `<section data-google-broker><h2>Google 메일·일정 연결</h2><p>계정 인증정보는 별도 보안 보관소에서 관리합니다. 이 프로그램은 허용된 메일·일정 조회 결과만 받습니다.</p><form data-google-connect><button type="submit" ${busy||connecting()||data.connection?.brokerConfigured===false?'disabled':''}>안전한 연결 확인</button></form><p role="status">${escape(error||labels[data.connection?.status]||'아직 계정 조회를 확인하지 않았습니다.')}</p>${data.connection?.checkedAt?`<p>마지막 확인: ${escape(new Date(data.connection.checkedAt).toLocaleString())}</p>`:''}<p>이 화면에 비밀번호·인증 파일·보관소 토큰을 입력하지 않습니다. 계정 변경은 보안 연결 설정을 통해 반영합니다.</p><form data-google-sync><button type="submit" ${busy||!data.connection?.providerVerified?'disabled':''}>지금 자료 수집</button></form><p>설정한 계정·검색 기간·한도 안에서 메일과 일정을 확인합니다.</p></section>`;
  }
  const localInput=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):'';};
  function renderBrokerQuotas(){
    const strict=data.connection?.readScopeRequired===true||data.google?.evidence?.some(x=>x.scopeRequired);
    return `<details data-google-scope ${scopeOpen?'open':''}><summary>메일·일정 수집 범위 조절</summary><p>${strict?'먼저 계정 조회를 확인한 뒤 자료 검색 기간과 사용 기한을 설정하세요. 설정하지 않으면 메일·일정을 수집하지 않습니다. 현재 확인된 계정에만 적용됩니다.':'페이지 한도와 종료 시각은 실제 수집에 적용됩니다.'} 페이지 수는 HTTP 호출 수나 요금이 아닙니다.</p><div class="personal-inbox-grid">${['gmail','google-calendar'].map(provider=>{
      const current=data.google?.evidence?.find(x=>x.provider===provider),draft=drafts.get(provider)??{maxPages:String(current?.budget?.maxCalls??100),expiresAt:localInput(current?.mandateValidity?.expiresAt),readFrom:localInput(current?.readScope?.readFrom),readUntil:localInput(current?.readScope?.readUntil)},name=provider==='gmail'?'메일':'일정';
      return `<form class="personal-inbox-item" data-google-quota="${provider}"><h3>${name} 수집 한도</h3>${strict?`<p>${provider==='gmail'?'해당 검색 기간의 메일 제목을 수집합니다. 스팸·휴지통은 제외합니다.':'기본 캘린더에서 검색 기간과 겹치는 일정 제목·시각을 수집합니다.'}</p><label>자료 검색 시작 · ${name}<input name="readFrom" data-google-draft="${provider}" type="datetime-local" required value="${escape(draft.readFrom)}"/></label><label>자료 검색 종료 · ${name}<input name="readUntil" data-google-draft="${provider}" type="datetime-local" required value="${escape(draft.readUntil)}"/></label>${current?.readScope?`<p>저장된 검색 범위: ${escape(new Date(current.readScope.readFrom).toLocaleString())} ~ ${escape(new Date(current.readScope.readUntil).toLocaleString())}</p>`:''}`:''}<label>최대 페이지 수<input name="maxPages" data-google-draft="${provider}" type="number" min="1" max="100000" step="1" required value="${escape(draft.maxPages)}"/></label><label>수집 허용 기한<input name="expiresAt" data-google-draft="${provider}" type="datetime-local" required value="${escape(draft.expiresAt)}"/></label><button type="submit" ${busy||strict&&!data.connection?.providerVerified?'disabled':''}>${name} 한도 ${current?.mandateId?'교체':'설정'}</button></form>`;
    }).join('')}</div></details>`;
  }
  function renderAdvanced(){
    if(brokerMode())return renderBroker()+renderBrokerQuotas();
    const status=data.connection?.status,labels={'awaiting-consent':'열린 Google 브라우저에서 계정과 읽기 권한을 확인해 주세요.','activating':'연결 정보를 적용하고 있습니다.','connected':'연결 정보를 적용했습니다. 수집 결과는 아래에서 확인할 수 있습니다.','verification-required':'연결 정보는 저장됐지만 제공자 검증이 끝나지 않았습니다. OAuth를 다시 시작하지 말고 화면을 새로고침해 연결 상태를 확인해 주세요.','failed':'연결을 완료하지 못했습니다. 인증 창을 완료했는지, 클라이언트 파일이 올바른지 확인해 주세요.'};
    const connectionMessage=status==='failed'&&data.connection?.code?googleConnectErrorMessage({payload:{error:{code:data.connection.code}}}):labels[status];
    return `<details class="personal-inbox-item" data-google-setup ${open?'open':''}><summary>Google 연결 및 수집 한도 설정</summary><p>최초 연결에는 Google Desktop OAuth 클라이언트 JSON 파일이 필요합니다. 파일의 내용을 붙여넣지 말고 이 PC의 파일 경로를 입력해 주세요. Google 인증 화면에서 메일·일정 읽기 권한을 직접 확인합니다.</p><form data-google-connect><label for="google-client-path">클라이언트 JSON 파일 경로</label><input id="google-client-path" name="clientPath" required value="${escape(clientPath)}" placeholder="C:/Users/user/Downloads/client.json"/><button type="submit" ${busy||connecting()?'disabled':''}>${data.google?.configured?'Google 다시 연결':'Google 연결 열기'}</button></form><p role="status">${escape(error||connectionMessage||'인증 정보는 Windows 사용자 암호화 저장소에 저장합니다.')}</p><p>페이지 한도는 수집 페이지 수입니다. HTTP 호출 수나 요금 한도가 아닙니다. 같은 페이지 재시도는 중복 차감하지 않습니다.</p><div class="personal-inbox-grid">${['gmail','google-calendar'].map(provider=>{const current=data.google?.evidence?.find(x=>x.provider===provider),draft=drafts.get(provider)??{maxPages:'100',expiresAt:''},name=provider==='gmail'?'메일':'일정';return `<form class="personal-inbox-item" data-google-quota="${provider}"><h3>${name} 수집 한도</h3><label for="google-pages-${provider}">최대 페이지 수 · ${name}</label><input id="google-pages-${provider}" name="maxPages" data-google-draft="${provider}" type="number" min="1" max="100000" step="1" required value="${escape(draft.maxPages)}"/><label for="google-expiry-${provider}">종료 시각 · ${name} · 이 기기 기준</label><input id="google-expiry-${provider}" name="expiresAt" data-google-draft="${provider}" type="datetime-local" required value="${escape(draft.expiresAt)}"/><p>${current?.mandateId?'현재 위임을 새 한도로 교체합니다. 이전 사용 기록은 유지됩니다.':'설정하면 이후 직접 수집에 적용합니다.'}</p><button type="submit" ${busy?'disabled':''}>${name} 한도 ${current?.mandateId?'교체':'설정'}</button></form>`;}).join('')}</div></details>`;
  }
  function renderConnectionBase(){
    if(brokerMode())return renderBroker()+renderBrokerQuotas();
    if(!simple)return renderAdvanced();
    const ready=data.connection?.productAuthorizationConfigured===true;
    const failedMessage=data.connection?.status==='failed'&&data.connection?.code?googleConnectErrorMessage({payload:{error:{code:data.connection.code}}}):'';
    return `<section><h2>Google 메일·일정 연결</h2><p>공식 Google 로그인 화면에서 계정과 읽기 범위를 확인합니다. 비밀번호를 JARVIS에 입력하지 않습니다.</p>${ready?'<form data-google-connect><button type="submit" '+(busy||connecting()?'disabled':'')+'>Google 로그인으로 연결</button></form>':'<p>제품용 Google 인증 설정이 아직 준비되지 않았습니다. 배포 운영자가 인증 앱을 준비해야 하며 일반 사용자가 개발자 설정이나 인증 파일을 만들 필요는 없습니다.</p>'}<p role="status">${escape(error||failedMessage||({'awaiting-consent':'열린 Google 로그인 화면에서 연결을 완료하세요.','connected':'인증 정보를 적용했습니다. 실제 자료 수집 상태는 별도로 확인합니다.','verification-required':'인증 정보는 저장됐지만 확인이 필요합니다. 새로고침으로 현재 상태부터 확인하세요.'})[data.connection?.status]||'아직 실제 계정 연결이 확인되지 않았습니다.')}</p><details data-technical><summary>고급 인증·수집 범위 설정</summary>${renderAdvanced()}</details></section>`;
  }
  function renderConnection(){
    const options=Array.isArray(data.google?.recoveryOptions)?data.google.recoveryOptions:[];
    return renderConnectionBase()+(options.length?`<section data-google-window-recovery><h2>멈춘 자료 수집 복구</h2><p>이전 버전의 조회 기록을 보존하고, 현재 계정과 허용 범위를 다시 확인해 수집을 이어갑니다. 이미 저장된 자료와 사용 기록은 삭제하지 않습니다.</p>${options.map(option=>`<article><h3>${option.provider==='gmail'?'메일':'일정'} 수집 기록</h3><p>다시 확인할 기간: ${escape(new Date(option.timeMin).toLocaleString())} ~ ${escape(new Date(option.timeMax).toLocaleString())}</p><button type="button" data-google-recovery="${escape(option.expectedWindowId)}" ${busy?'disabled':''}>${option.provider==='gmail'?'메일':'일정'} 기록 복구하고 수집</button></article>`).join('')}</section>`:'');
  }
  function renderBase(){
    const paused=data.google?.status==='collection-paused';
    return renderConnection()+renderLocalRemoval()+`<section data-google-collection-control><h2>이 JARVIS의 자료 수집</h2><p role="status">${paused?'수집 중지됨 · 재시작 뒤에도 유지됩니다.':data.google?.status?'현재 수집 상태: '+escape(data.google.status):'자료 수집 상태를 아직 확인하지 못했습니다.'}</p><p>수집을 중지하면 새 메일·일정 조회와 늦게 도착한 결과 저장을 막습니다. 이미 저장된 자료와 자격증명은 삭제하지 않습니다.</p><form data-google-pause><button type="submit" ${busy||paused||!data.google?.status?'disabled':''}>이 JARVIS의 수집 중지</button></form><p>재개하려면 위에서 Google 연결을 다시 확인하세요. Google 자체 접근 권한을 철회하려면 <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Google 계정의 연결된 앱</a>에서 JARVIS 인증 앱의 접근을 삭제하세요. 이 화면에서는 Google 권한 철회를 확인하지 않습니다.</p></section>`;
  }
  function renderLocalRemoval(){
    if(brokerMode())return `<section><h2>보안 중개 접근 해제</h2><p>이 JARVIS 인증서로 허용된 모든 중개 조회를 중지합니다. 보관소 자격증명과 Google 자체 권한은 삭제하지 않습니다. 다시 연결하려면 운영자가 새 장치 인증서를 준비해야 합니다.</p>${data.connection?.brokerDisconnectSupported?`<form data-google-broker-disconnect><button ${busy||data.connection?.brokerAccessRevoked?'disabled':''}>이 JARVIS의 중개 접근 해제</button></form>`:'<p>중개 해제 경로가 준비되지 않았습니다. 먼저 수집을 중지하고 운영자에게 중개 인증서 철회를 요청하세요.</p>'}${data.connection?.brokerAccessRevoked?'<p>중개 서버의 접근 철회 응답을 확인했습니다.</p>':''}<p>원격 보관소 삭제와 Google 자체 권한 철회는 별도입니다.</p></section>`;
    if(!Array.isArray(data.localConnections))return '<section><h2>저장된 Google 연결</h2><p>보호 저장소 연결 목록을 아직 확인하지 못했습니다.</p></section>';
    return `<section><h2>저장된 Google 연결</h2><p>삭제하면 먼저 수집을 중지하고, 선택한 연결의 로컬 보호 저장소 자격증명을 제거합니다. 기존 자료와 Google 자체 접근 권한은 남습니다.</p>${data.localConnections.map(item=>`<article><h3>${escape(item.label??'Google 연결')}</h3><button type="button" data-google-remove="${escape(item.connectionId)}" ${busy?'disabled':''}>이 PC의 Google 자격증명 삭제</button></article>`).join('')||'<p>이 보호 저장소에 등록된 Google 연결이 없습니다.</p>'}</section>`;
  }
  function render(){return renderBase()+collection.render();}
  function attach(root){
    collection.attach(root);
    root.addEventListener('click',async e=>{
      const recovery=e.target.closest?.('[data-google-recovery]');
      if(recovery){
        if(busy)return;
        const option=data.google?.recoveryOptions?.find(x=>x.expectedWindowId===recovery.dataset.googleRecovery);if(!option)return;
        const body={provider:option.provider,expectedWindowId:option.expectedWindowId,expectedGeneration:option.expectedGeneration};
        busy=true;error='';changed();
        try{
          let result;
          try{result=await request('/personal-google/restart-window',{method:'POST',body});}
          catch(caught){if(caught?.payload?.error?.code)throw caught;result=await request('/personal-google/restart-window',{method:'POST',body});}
          if(result.currentWindowVerified===true&&!result.replayed){
            const collected=await request('/personal-google/sync',{method:'POST',body:{}});
            error=collected.status==='ready'?'이전 기록을 보존해 복구하고, 설정 범위의 자료 수집을 확인했습니다.':'기록을 복구했습니다. 자료 수집은 아직 완료되지 않았습니다. 계정과 수집 범위·한도를 확인하세요.';
          }else error='보관된 복구 결과를 확인했습니다. 현재 수집 상태는 새로고침한 화면에서 별도로 확인하세요.';
        }catch{error='복구를 완료하지 못했습니다. 현재 계정과 수집 범위·한도를 확인하고 새로고침하세요. 기존 자료는 삭제하지 않았습니다.';}
        finally{busy=false;await refresh();changed();}return;
      }
      const target=e.target.closest?.('[data-google-remove]');if(!target||busy)return;
      busy=true;error='';changed();
      try{const result=await request(`/integrations/connections/${encodeURIComponent(target.dataset.googleRemove)}`,{method:'DELETE'});error=result.localCredentialsRemoved?'로컬 자격증명을 삭제하고 수집을 중지했습니다. Google 자체 권한은 별도로 철회하세요.':'선택한 자격증명이 없습니다. 현재 목록을 다시 확인하세요.';}
      catch{error='자격증명 삭제를 확인하지 못했습니다. 수집 상태와 관리 인증을 새로고침해 확인하세요.';}
      finally{busy=false;await refresh();changed();}
    });
    // Preserve this disclosure across parent renders without storing credentials.
    root.addEventListener('toggle',e=>{if(e.target.matches?.('[data-google-setup]'))open=e.target.open;if(e.target.matches?.('[data-google-scope]'))scopeOpen=e.target.open;},true);
    root.addEventListener('input',e=>{if(e.target.id==='google-client-path')clientPath=e.target.value;const provider=e.target.dataset?.googleDraft;if(provider){const current=data.google?.evidence?.find(x=>x.provider===provider),draft=drafts.get(provider)??{maxPages:String(current?.budget?.maxCalls??100),expiresAt:localInput(current?.mandateValidity?.expiresAt),readFrom:localInput(current?.readScope?.readFrom),readUntil:localInput(current?.readScope?.readUntil)};draft[e.target.name]=e.target.value;drafts.set(provider,draft);}});
    root.addEventListener('submit',async e=>{
      const connect=e.target.matches('[data-google-connect]'),sync=e.target.matches('[data-google-sync]'),disconnect=e.target.matches('[data-google-broker-disconnect]'),pause=e.target.matches('[data-google-pause]'),provider=e.target.dataset?.googleQuota;if(!connect&&!sync&&!pause&&!disconnect&&!provider)return;e.preventDefault();if(busy)return;
      const form=new FormData(e.target);let body;
      if(sync||pause||disconnect)body={};else if(connect)body=brokerMode()||simple&&!form.has('clientPath')?{profile:'product'}:{clientPath:String(form.get('clientPath')).trim()};
      else{const expiry=new Date(form.get('expiresAt'));if(!Number.isFinite(expiry.getTime()))return;body={provider,maxPages:Number(form.get('maxPages')),validFrom:new Date().toISOString(),expiresAt:expiry.toISOString(),replaceMandateId:data.google?.evidence?.find(x=>x.provider===provider)?.mandateId??null};if(form.has('readFrom')){const from=new Date(form.get('readFrom')),until=new Date(form.get('readUntil'));if(!Number.isFinite(from.getTime())||!Number.isFinite(until.getTime())||from>=until)return;body.readFrom=from.toISOString();body.readUntil=until.toISOString();}}
      busy=true;error='';changed();
      try{const result=await request(disconnect?'/personal-google/broker-disconnect':pause?'/personal-google/pause':sync?'/personal-google/sync':connect?'/personal-google/connect':'/personal-google/mandate',{method:'POST',body});if(disconnect){error='중개 접근 철회 응답을 확인했습니다. 자격증명 삭제나 Google 자체 권한 철회를 뜻하지 않습니다.';}else if(pause){data.google={...data.google,...result};error='이 JARVIS의 수집을 중지했습니다. Google 자체 권한과 저장된 자격증명은 별도로 관리합니다.';}else if(sync){error=result.status==='ready'?'메일·일정 수집을 확인했습니다.':result.status==='busy'?'다른 수집 작업이 진행 중입니다. 잠시 뒤 확인해 주세요.':'수집을 완료하지 못했습니다. 계정 연결과 메일·일정별 검색 기간·한도·허용 기한을 확인해 주세요.';}else if(connect){data.connection=result;clientPath='';}else await onQuotaChanged();}
      catch(caught){error=disconnect?'중개 접근 해제를 확인하지 못했습니다. 수집은 중지 상태로 유지합니다. 운영자에게 중개 연결을 확인해 달라고 요청하세요.':pause?'수집 중지를 확인하지 못했습니다. 실행 환경과 관리 인증을 확인한 뒤 다시 시도하세요.':connect?(brokerMode()?'안전한 중개 연결을 확인하지 못했습니다. 계정 권한과 보관소 연결을 점검한 뒤 다시 확인해 주세요.':simple?'연결을 완료하지 못했습니다. 열린 인증 창과 실행 환경을 확인하고, 이전 연결 상태를 새로고침해 주세요.':googleConnectErrorMessage(caught)):'한도를 설정하지 못했습니다. 종료 시각·페이지 수를 확인하고 새로고침해 주세요.';}
      finally{busy=false;await refresh();changed();}
    });
  }
  return {update,render,attach};
}

export function googleConnectErrorMessage(error){
  const code=error?.payload?.error?.code;
  if(code==='A_GOOGLE_HANDOFF_TOKEN_NOT_CONFIGURED')return '보안 연결 준비가 완료되지 않았습니다. 로그인된 Windows PowerShell에서 scripts/configure-integration-handoff-token.ps1을 실행하고 Core 서비스를 재시작한 뒤 다시 연결해 주세요.';
  if(code==='A_GOOGLE_HANDOFF_EXPIRED')return '인증을 마치는 동안 연결 요청이 만료됐습니다. Google 연결을 다시 시작해 주세요. 이전 요청은 사용되지 않습니다.';
  if(code==='A_GOOGLE_HANDOFF_RESTARTED')return '인증 중 JARVIS Core가 재시작되어 보안 연결 요청이 만료됐습니다. Google 연결을 다시 시작해 주세요.';
  if(code==='A_GOOGLE_HANDOFF_REJECTED')return '보안 연결 요청을 확인하지 못했습니다. 연결을 다시 시작해 주세요. 인증 정보는 화면에 표시되지 않습니다.';
  if(code==='A_GOOGLE_HANDOFF_STORED_UNVERIFIED')return 'Google 자격증명은 JARVIS 보관소에 저장됐지만 검증 결과를 받지 못했습니다. 중복 OAuth 승인을 피하려면 먼저 화면을 새로고침해 연결 상태를 확인해 주세요.';
  if(code==='A_GOOGLE_HANDOFF_RECEIPT_UNAVAILABLE')return '인증 창은 종료됐지만 JARVIS에서 연결 검증 기록을 확인하지 못했습니다. 연결 완료로 처리하지 않았습니다. 먼저 화면을 새로고침해 현재 연결 상태를 확인해 주세요.';
  if(error?.payload?.error?.code==='A_GOOGLE_INTERACTIVE_SESSION_REQUIRED')return '백그라운드 서비스는 로그인 창을 열 수 없습니다. 로그인된 Windows PowerShell에서 scripts/personal-google-connect-service.ps1 -ClientPath "OAuth JSON 경로"를 실행하세요. 연결은 Gmail·Calendar 읽기만 허용합니다. 통합 handoff 토큰이 설정되지 않았다면 scripts/configure-integration-handoff-token.ps1 실행 후 출력된 해시만 Core 서비스 설정에 넣고 재시작해야 합니다.';
  return '연결을 시작하지 못했습니다. 이 PC의 Desktop OAuth JSON 파일 경로를 확인해 주세요.';
}
