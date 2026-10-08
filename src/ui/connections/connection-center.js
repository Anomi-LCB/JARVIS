import {createMicrosoftPanel} from './microsoft.js';
import {renderMcpPackageSetup,mcpInstallationReasons} from './mcp-packages.js';
import {renderA2aServices,a2aRegistrationReasons} from './a2a.js';
import {createPersonalMandatePanel} from '../personal-mandates.js';
import { renderIntegrationReadiness } from '../integration-readiness.js';
import { storeModelProviderApiKey } from '../model-provider-credential-setup.js';
import { createGoogleSetup } from '../google-setup.js';
import { createPcNodeSetup } from './pc-nodes.js';
import {createPcTaskRegistration} from './pc-task-registration.js';
import { createPcLocalPermissions } from './pc-local-permissions.js';
import { schemaFields, renderSchemaForm, parseSchemaForm } from './schema-form.js';
import {loadRuntimeConnectionStatus,renderRuntimeConnectionStatus} from './runtime-status.js';
import {renderTravelConnection} from './travel.js';
import {renderEmailConnection,renderEmailConnectionUnavailable} from './email.js';
import {createSelectedSources} from './selected-sources.js';

export const connectionPages = Object.freeze({
  api: { title: 'API 연결', description: '모델 제공자를 연결하고 저장된 키의 접근 상태를 확인합니다.' },
  agents: { title: '에이전트 연결', description: '외부 에이전트의 자격증명과 실행 준비 상태를 별도로 관리합니다.' },
  a2a:{title:'전문 서비스 연결',description:'A2A 서비스 설명과 로컬 검토 상태를 독립적으로 관리합니다.'},
  delegation:{title:'실행 위임 관리',description:'허용한 행동의 대상·기간·횟수 한도를 별도 화면에서 확인하고 철회합니다.'},
  mcp: { title: 'MCP 연결', description: '이 PC에서 실행 중인 MCP 서버를 등록하고 제공하는 도구를 확인합니다.' },
  accounts: { title: '계정 연결', description: 'Google 메일·일정 인증과 수집 범위를 관리합니다.' },
  microsoft:{title:'Microsoft 자료 수집',description:'선택한 Outlook·Teams의 수집 범위·페이지 한도와 현재 결과 검증을 독립적으로 관리합니다.'},
  sources: {title:'저장 자료 조회',description:'선택한 연결의 저장 자료를 전체 조회하고 현재 검증 결과를 확인합니다.'},
  email: {title:'메일 발송 연결',description:'메일을 보내지 않고 연결을 확인하고, 이 프로그램의 사용을 중지합니다.'},
  'pc-email': {title:'이 PC의 메일 연결',description:'현재 PC 서비스에 저장된 메일 설정을 별도로 확인하고 사용을 중지합니다.'},
  travel:{title:'여행 연결',description:'항공 견적 중개 연결과 시험 견적 조회를 별도로 관리합니다.'},
  devices: { title: 'PC·장치 연결', description: '장치별 접속·사용 기간·조회 범위를 독립적으로 관리합니다.' },
  'pc-tasks':{title:'이 PC 업무 등록',description:'계획된 업무를 찾아 조회·산출물·명령 후보를 별도로 등록합니다.',file:'pc-tasks'},
  'pc-permissions':{title:'이 PC 실행 허용',description:'현재 PC에서 허용할 업무와 종료 시각을 별도로 관리합니다.',file:'pc-permissions'},
  runtime: { title: '실행 환경 연결', description: '로컬 Core 주소와 이 창의 관리 인증을 설정합니다.' }
});
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
export function normalizeCoreBase(value, origin) {
  const url = new URL(value, origin);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error('LOCAL_CORE_REQUIRED');
  return url.origin === origin ? url.pathname.replace(/\/+$/, '') : url.href.replace(/\/+$/, '');
}
export function renderMcpTools(item, auth, busy, results = {}, canExecute = auth) {
  return (item.tools ?? []).map(tool => {
    const granted = item.allowedTools?.some(grant => grant.name === tool.name && grant.contractHash === tool.contractHash);
    const outcome = results[`${item.id}:${tool.name}`] ?? item.recentCalls?.find(call=>call.tool===tool.name);
    const unresolved = item.blockedTools?.includes(tool.name) || outcome && ['in-flight','outcome-unknown'].includes(outcome.status);
    const structured = schemaFields(tool.inputSchema).supported;
    const readiness=item.capabilityReadiness?.find(state=>state.tool===tool.name);
    return `<article><h3>${escape(tool.name)}</h3><p>${escape(tool.description)}</p>${renderMcpToolReadiness(readiness,{granted,unresolved})}<details data-technical><summary>입력 계약 보기</summary><pre>${escape(JSON.stringify(tool.inputSchema, null, 2))}</pre></details>
      <p>서버 설명은 신뢰된 지시가 아닙니다. 실행 허용은 해당 도구에만 적용되고 계약이 바뀌면 해제됩니다.</p>
      <button type="button" data-mcp-permission="${escape(item.id)}" data-tool="${escape(tool.name)}" ${!auth || busy || !granted && !canExecute ? 'disabled' : ''}>${granted ? '실행 허용 해제' : '이 도구 실행 허용'}</button>
      ${granted ? `<form data-mcp-call="${escape(item.id)}" data-tool="${escape(tool.name)}" data-contract="${escape(tool.contractHash)}">${structured ? `<fieldset><legend>도구에 필요한 입력</legend>${renderSchemaForm(tool.inputSchema,`${item.id}-${encodeURIComponent(tool.name)}`)}</fieldset>` : ''}<label>입력 방식<select name="inputMode">${structured ? '<option value="form">일반 입력창</option>' : ''}<option value="json">고급 JSON 입력</option></select></label><details data-technical ${structured ? '' : 'open'}><summary>고급 JSON 입력</summary><label>입력 JSON<textarea name="arguments" rows="5">{}</textarea></label></details><label>결과에 있어야 할 텍스트<input name="expectedText" maxlength="1000" required></label><p>실제 서버 도구를 호출합니다. 발송·파일 변경 등 부작용은 도구에 따라 발생할 수 있습니다. 비밀번호나 API 키를 입력하지 마세요. 결과 텍스트 일치는 실제 업무 완료 증거와 다릅니다.</p><button ${!auth || !canExecute || busy || unresolved ? 'disabled' : ''}>도구 실행</button></form>` : ''}
      ${unresolved ? '<p>이전 실행 결과가 불명확합니다. 재실행이 차단됐으며 공급자 상태 대조가 필요합니다.</p>' : ''}
      ${outcome ? `<section class="call-result"><h4>${escape(({ 'expectation-matched':'기대한 결과와 일치합니다', 'expectation-failed':'기대한 결과와 다릅니다', 'tool-error':'도구가 오류를 반환했습니다', 'outcome-unknown':'실행 결과를 확인해야 합니다', 'not-dispatched':'서버 호출 전에 차단됐습니다' })[outcome.status] ?? outcome.status)}</h4><pre>${escape(outcome.result?.content?.map(item => item.text ?? '').join('\n') ?? outcome.errorCode ?? (outcome.historicalRecord?'보존된 호출 기록입니다. 원문 결과는 저장하지 않습니다.':''))}</pre><p>${outcome.historicalRecord?'재시작 후 조회한 호출 기록입니다. 실제 업무 완료나 재시도 허용을 의미하지 않습니다.':'서버가 반환한 결과입니다. 실제 파일 변경·발송 등의 완료 여부는 별도로 확인해야 합니다.'}</p><details data-technical><summary>실행 기록 상세</summary><pre>${escape(JSON.stringify(outcome,null,2))}</pre></details></section>` : ''}</article>`;
  }).join('');
}
export function renderMcpToolReadiness(state,{granted=false,unresolved=false}={}){
 const current=state?.contractCurrent===true;
 const installed=current&&state?.packageInstalled===true;
 const steps=[['직접 실행 허용',granted?'허용됨':'허용하지 않음'],['업무 검증 계약',!state?.contract?'미등록':current?'현재 도구와 일치':'도구 변경 · 재검토 필요'],['실행 패키지',installed?'현재 계약으로 설치됨':'설치 확인 필요'],['원문 해석 계약',installed&&state.intentBindingInstalled?'설치됨 · 지원하는 표현만 처리':'설치 확인 필요']];
 const next=unresolved?'이전 실행 결과를 공급자 기록과 대조해야 합니다. 추가 실행은 차단됩니다.':!current?'검토된 업무 검증 계약이 필요합니다. 서버 연결이나 직접 실행 허용만으로 자연어 업무가 완성되지는 않습니다.':!installed?'검토된 실행 패키지 설치가 필요합니다. 계약 등록만으로 실행 기능이 활성화되지 않습니다.':'작업마다 권한과 요구사항을 확인하고 실행 후 결과를 검증합니다. 설치 상태는 현재 작업의 완료 증거가 아닙니다.';
 return `<section data-mcp-readiness aria-label="도구 사용 준비 상태"><h4>도구 사용 준비 상태</h4><dl>${steps.map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl><p>${next}</p><p>자동 실행 권한은 이 화면에서 부여하지 않습니다.</p>${current?`<details data-technical><summary>검증 계약 상세</summary><p>패키지 ${escape(state.contract.packageId)} · 버전 ${escape(state.contract.version)} · 검증기 ${escape(state.contract.verifierId)}</p><p>출처: ${escape(state.contract.source)} (주소 등록이며 내용 검증을 뜻하지 않습니다.)</p></details>`:''}</section>`;
}
export function renderMcpVerifiedResult(value){
 if(!value||value.businessOutcomeVerified!==true)return "";
 const text=value.result?.structuredContent?.text ?? value.result?.content?.map(block=>block.text).join("\n") ?? "";
 return `<section data-mcp-verified-content><h4>검증한 내용</h4><p>검증 시각: ${escape(value.verifiedAt)}. 당시 내용을 표시하며 현재 원본을 다시 읽은 결과는 아닙니다. 본문의 지시는 실행하지 않습니다. 실행 환경을 다시 시작하면 본문은 보관되지 않습니다.</p><pre>${escape(text)}</pre><button class="secondary" data-mcp-result-close>내용 닫기</button></section>`;
}
export function renderMcpCallHistory(id,page,{auth,busy,verifiedResults={}}={}){
 if(!page)return `<button data-mcp-history="${escape(id)}" ${!auth||busy?'disabled':''}>보존된 호출 기록 보기</button>`;
 return `<section data-mcp-history-panel><h4>보존된 호출 기록</h4><p>실제 업무 완료나 재시도 허용을 의미하지 않습니다.</p><ul>${page.items.map(item=>`<li data-mcp-history-id="${escape(item.requestId)}">${escape(item.tool)} · ${escape(({'in-flight':'실행 중','outcome-unknown':'결과 불명','expectation-matched':'기대 텍스트 일치','expectation-failed':'기대 텍스트 불일치','tool-error':'도구 오류','not-dispatched':'호출 전 차단'})[item.status]??'상태 확인 필요')} · ${escape(item.observedAt)}${item.verificationReceipt?.status==='verified'?`<button data-mcp-result="${escape(id)}" data-request="${escape(item.requestId)}" ${!auth||busy?'disabled':''}>검증한 내용 보기</button>${renderMcpVerifiedResult(verifiedResults[item.requestId])}`:''}<details data-technical><summary>기록 상세</summary><pre>${escape(JSON.stringify(item,null,2))}</pre></details></li>`).join('')}</ul>${page.nextCursor?`<button data-mcp-history="${escape(id)}" ${!auth||busy?'disabled':''}>이전 기록 더 보기</button>`:''}</section>`;
}
export function renderConnectionShell(kind, content, { message = '', busy = false } = {}) {
  const page = connectionPages[kind] ?? connectionPages.api;
  return `<div class="connection-shell"><nav aria-label="연결 영역"><a class="brand" href="/">JARVIS</a><p>연결 관리</p>${Object.entries(connectionPages).map(([id, item]) => `<a href="${item.file??id}.html" ${kind === id ? 'aria-current="page"' : ''}>${escape(item.title)}</a>`).join('')}<a href="/">제어 센터</a></nav><main><header><div><h1>${escape(page.title)}</h1><p>${escape(page.description)}</p></div><button type="button" data-refresh ${busy ? 'disabled' : ''}>${busy ? '확인 중…' : '상태 새로고침'}</button></header><p class="connection-notice" role="status">${escape(message || '상태를 확인하고 있습니다.')}</p><div class="connection-content">${content}</div></main></div>`;
}
export function renderConnectionObservationFailure(code) {
  return `<section data-connection-unavailable aria-label="연결 상태 미확인"><h2>현재 연결 상태를 확인하지 못했습니다</h2><p>이전에 표시한 계정·서버·권한·준비 상태는 최신 상태로 사용할 수 없어 숨겼습니다. 연결을 삭제하거나 권한을 철회한 것은 아닙니다.</p><p>Core 실행 상태와 관리 인증을 확인한 뒤 상태 새로고침을 누르세요.</p><p>확인 코드: ${escape(code)}</p><a href="runtime.html">실행 환경 연결 확인</a></section>`;
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('#connection-app');
  if (root) initialize(root);
}
function initialize(root) {
  const kind = document.body.dataset.connectionKind;
  const isEmail=kind==='email'||kind==='pc-email';
  let base = '/api/core';
  try { base = normalizeCoreBase(localStorage.getItem('jarvis.coreBaseUrl') || base, location.origin); }
  catch { localStorage.removeItem('jarvis.coreBaseUrl'); }
  let token = sessionStorage.getItem('jarvis.coreAdminToken') || '';
  let readiness = {}, profiles = [], proxy = false, connected = false, busy = false, notice = '', callResults = {}, historyPages={},verifiedResults={},mcpPackages=null,trustMode = 'unknown';
  let runtimeObservation=null,a2aServices=null,a2aDraft={};
  let observationError=null;
  let travelStatus={},travelQuote=null;
  let emailStatus={};
  let pcEmailProxy=false;
  let travelSetup={};
  const refreshTravelSetup=async()=>{
    try{const response=await fetch('/api/local/duffel-setup',{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error();travelSetup=await response.json();}
    catch{travelSetup={available:false,state:'unavailable'};}
  };
  const formDrafts = new Map();
  const request = async (path, options = {}) => {
    const endpoint = new URL(base, location.origin);
    normalizeCoreBase(endpoint.href, location.origin);
    const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      cache: 'no-store',
      method: options.method ?? 'GET', credentials: 'omit', redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(options.timeout??10000),
      headers: { ...(options.body ? { 'content-type':'application/json' } : {}),
        ...((options.token ?? token) ? { authorization:`Bearer ${options.token ?? token}` } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload.error?.code ?? `HTTP_${response.status}`), { payload,status:response.status });
    return payload;
  };
  const emailRequest=async(path,options={})=>{
    if(kind!=='pc-email')return request(path,options);
    const response=await fetch(`/api/pc${path.replace('/personal-email','/email')}`,{method:options.method??'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),headers:options.body?{'content-type':'application/json'}:{},...(options.body?{body:JSON.stringify(options.body)}:{})});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error?.code??`HTTP_${response.status}`);return payload;
  };
  const google = createGoogleSetup({ request, changed: render, refresh, escape, simple:true });
  const microsoft=createMicrosoftPanel({request,storage:localStorage,changed:render,escape});
  if(kind==='microsoft')microsoft.attach(root);
  const selectedSources=createSelectedSources({request,changed:render,escape});
  if(kind==='sources'){selectedSources.attach(root);selectedSources.watch();}
  const mandates=createPersonalMandatePanel({request,changed:render,escape,initialOpen:true});
  if(kind==='delegation')mandates.attach(root);
  google.attach(root);
  const nodes = createPcNodeSetup({request,changed:render,refresh,escape});
  const localPermissions=createPcLocalPermissions({escape,changed:render,readLabels:(taskIds,{signal})=>request('/pc-nodes/task-labels',{method:'POST',body:{taskIds},signal}),request:async(options={})=>{
    const response=await fetch('/api/pc/outbound/local-task-scope',{method:options.method??'GET',credentials:'same-origin',headers:{...(options.body?{'content-type':'application/json'}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error?.code??'PC_SCOPE_REQUEST_FAILED');return payload;
  }});
  const registration=createPcTaskRegistration({escape,changed:render,readOptions:query=>request(`/pc-nodes/task-options${query}`),request:async(options={})=>{
    const response=await fetch('/api/pc/outbound/local-task-catalog',{method:options.method??'GET',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000),headers:{...(options.body?{'content-type':'application/json'}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error?.code??'PC_CATALOG_REQUEST_FAILED');return payload;
  }});
  registration.attach(root);
  localPermissions.attach(root);
  nodes.attach(root);
  window.addEventListener('pagehide',()=>{nodes.dispose();localPermissions.dispose();registration.dispose();microsoft.dispose();},{once:true});
  const available = () => connected && (kind==='pc-email'?pcEmailProxy:Boolean(token) || proxy && base === '/api/core');
  function render() {
    const a2aForm=root.querySelector('[data-a2a-register]');if(a2aForm){const fields=new FormData(a2aForm);a2aDraft={label:fields.get('label'),source:fields.get('source')};}
    for (const form of root.querySelectorAll('[data-mcp-call]')) formDrafts.set(`${form.dataset.mcpCall}:${form.dataset.tool}:${form.dataset.contract}`,[...new FormData(form).entries()]);
    const auth = available();
    let content;
    if(isEmail&&['A_EMAIL_CONNECTION_UNAVAILABLE','A_EMAIL_PC_ADMIN_PROXY_REQUIRED'].includes(observationError))content=renderEmailConnectionUnavailable({pc:kind==='pc-email',adminMissing:observationError==='A_EMAIL_PC_ADMIN_PROXY_REQUIRED'});
    else if(observationError&&kind!=='runtime')content=renderConnectionObservationFailure(observationError);
    else if (kind === 'runtime') content = renderRuntimeConnectionStatus(runtimeObservation)+`<section><h2>Core 연결 설정</h2><form data-runtime><label>로컬 Core 주소<input name="base" type="url" value="${escape(new URL(base, location.origin).href)}" required></label><label>Core 관리 토큰<input name="token" type="password" autocomplete="new-password" placeholder="새 토큰을 입력하면 이 창에서 사용합니다"></label><p>주소만 저장하며 토큰은 이 창의 세션에만 보관합니다. API 키나 계정 비밀번호를 넣는 곳이 아닙니다.</p><button ${busy?'disabled':''}>설정 적용·연결 확인</button></form></section>`;
    else if (kind === 'mcp') content = `<section><h2>로컬 서버 등록</h2><form data-mcp-add><label>연결 이름<input name="label" maxlength="80" required placeholder="예: 연구 자료 MCP"></label><label>서버 주소<input name="endpoint" type="url" required placeholder="http://127.0.0.1:3000/mcp"></label><label>프로토콜<select name="protocolVersion"><option>2026-07-28</option><option>2025-11-25</option></select></label><p>HTTP 방식의 127.0.0.1 서버만 지원합니다. 서버 주소에 토큰을 넣지 마세요. 외부 OAuth·stdio는 미지원입니다. 목록을 확인한 뒤 도구별 실행을 허용할 수 있습니다.</p><button ${!auth || busy ? 'disabled' : ''}>서버 등록</button></form></section><section><h2>등록한 MCP 서버</h2>${profiles.length ? profiles.map(item => `<article><h3>${escape(item.label)}</h3><p>${escape(item.endpoint)}</p><p>${escape(item.status === 'tools-listed' ? `도구 목록 확인됨 · 허용 도구 ${(item.allowedTools ?? []).length}개` : item.status === 'probe-failed' ? `연결 확인 실패 · ${item.errorCode}` : '등록됨 · 아직 점검하지 않음')}</p><button data-mcp-probe="${escape(item.id)}" ${!auth || busy ? 'disabled' : ''}>서버·도구 확인</button><button class="secondary" data-mcp-remove="${escape(item.id)}" ${!auth || busy ? 'disabled' : ''}>등록 해제</button>${renderMcpTools(item, auth, busy, callResults, trustMode === 'trusted')}${renderMcpCallHistory(item.id,historyPages[item.id],{auth,busy,verifiedResults})}</article>`).join('') : '<p>아직 등록한 서버가 없습니다. 서버를 실행한 뒤 위에서 주소를 등록하세요.</p>'}</section>`+renderMcpPackageSetup(mcpPackages,profiles,{escape,auth,busy});
    else if(kind==='travel')content=renderTravelConnection(travelStatus,travelQuote,{escape,enabled:auth,busy,setup:travelSetup});
    else if(isEmail)content=renderEmailConnection(emailStatus,{escape,enabled:auth,busy})+(kind==='pc-email'?'<section><h2>연결 대상</h2><p>이 화면은 현재 PC 서비스만 관리합니다. Core의 메일 설정이나 다른 원격 장치의 계정을 변경하지 않습니다. 연결 확인만으로 원격 자연어 발송이 활성화되는 것은 아닙니다.</p></section>':'');
    else if(kind==='a2a')content=renderA2aServices(a2aServices,{escape,auth,busy,draft:a2aDraft});
    else if(kind==='delegation')content=mandates.render();
    else if (kind === 'accounts') content = google.render();
    else if(kind==='microsoft')content=microsoft.render();
    else if(kind==='sources')content=selectedSources.render();
    else if (kind === 'devices') content = nodes.render({auth,busy});
    else if(kind==='pc-tasks')content=registration.render();
    else if(kind==='pc-permissions')content=localPermissions.render();
    else content = renderIntegrationReadiness({ ...readiness,
      canSetupProviderCredentials: true, canManageIntegrations: auth, providerSetupBusy: busy }, { kind })
      + (kind === 'agents' ? `<section><h2>관리형 세션 준비 상태</h2><p>현재 화면은 OpenAI Agents의 보호 키 등록과 읽기 검사를 지원합니다. 다른 에이전트 제품은 공개 실행 API와 어댑터가 준비되어야 추가됩니다.</p><pre>${escape(JSON.stringify(readiness.managedAgentCredentials ?? { status: '상태 미확인' }, null, 2))}</pre></section>` : '')
      + `<section><h2>저장한 연결</h2>${(readiness.connections ?? []).filter(item => kind === 'agents' ? item.connectorId === 'jarvis-openai-agents' : ['jarvis-model-xai','jarvis-model-meta','jarvis-model-gemini'].includes(item.connectorId)).map(item => `<article><h3>${escape(item.label ?? item.connectorId)}</h3><p>${escape(item.connectorId)}</p><button class="secondary" data-remove="${escape(item.connectionId)}" ${!auth || busy ? 'disabled' : ''}>이 PC의 키 삭제</button></article>`).join('') || '<p>표시할 연결 기록이 없습니다.</p>'}<p>로컬 키 삭제는 제공자 계정의 권한 철회를 대신하지 않습니다.</p></section>`;
    root.innerHTML = renderConnectionShell(kind, content, { busy, message: notice });
    for (const form of root.querySelectorAll('[data-mcp-call]')) for (const [name,value] of formDrafts.get(`${form.dataset.mcpCall}:${form.dataset.tool}:${form.dataset.contract}`) ?? []) { const input=[...form.elements].find(element=>element.name === name);if(input)input.value=value; }
    if (kind !== 'runtime' && kind!=='travel' && kind!=='pc-permissions' && kind!=='pc-tasks' && !auth) for (const button of root.querySelectorAll('.connection-content button')) button.disabled = true;
  }
  async function refresh() {
    verifiedResults={};
    if (busy) return;
    busy = true; render();
    let refreshFailed=false;
    try {
      const capabilities = await fetch('/api/local/capabilities').then(r => r.json()).catch(() => null);
      if(kind==='pc-tasks'){
        registration.setEnabled(capabilities?.credentialsExposed===false&&capabilities?.pcAgentProxyConfigured===true);
        await registration.load();notice='PC 업무 등록과 실행 허용은 독립적으로 관리합니다.';return;
      }
      if(kind==='pc-permissions'){
        localPermissions.setEnabled(capabilities?.credentialsExposed===false&&capabilities?.pcAgentProxyConfigured===true);
        await localPermissions.load();notice='이 PC의 실행 허용을 관리하는 독립 화면입니다. 아래 준비 상태를 확인하세요.';return;
      }
      proxy = capabilities?.credentialsExposed === false && capabilities?.coreAdminProxyConfigured === true;
      if(isEmail){
        pcEmailProxy=capabilities?.credentialsExposed===false&&capabilities?.pcAgentProxyConfigured===true;
        if(kind==='pc-email'&&!pcEmailProxy)throw new Error('A_EMAIL_PC_ADMIN_PROXY_REQUIRED');
        emailStatus=await emailRequest('/personal-email/connection');connected=true;
        notice='메일 연결 상태를 조회했습니다. 실제 발송·도착은 작업별 결과에서 확인하세요.';return;
      }
      if(kind==='travel')await refreshTravelSetup();
      if(kind==='runtime'){
        runtimeObservation=await loadRuntimeConnectionStatus({request});connected=runtimeObservation.connected;trustMode=runtimeObservation.trust;
        notice='현재 접속·실행 모드를 조회했습니다. 업무 완료 여부는 작업별 결과에서 확인합니다.';return;
      }
      if(kind==='microsoft'){await microsoft.refresh();connected=true;notice='수집 준비 상태와 현재 검증 결과를 구분해 확인하세요.';return;}
      if(kind==='sources'){await selectedSources.refresh();connected=true;notice='선택한 저장 자료의 조회·검증 상태는 아래에서 확인하세요.';return;}
      readiness = await request('/integrations'); connected = true;
      if(kind==='delegation'){await mandates.refresh();notice='목록의 위임은 행동 승인 정책과 별개입니다. 대상·한도·기간을 확인하세요.';return;}
      if(kind==='a2a'){a2aServices=await request('/integrations/a2a');notice='서비스 설명을 확인했습니다. 실행 권한이나 계정 연결을 의미하지 않습니다.';return;}
      if(kind==='travel'){
        travelStatus=await request('/travel/duffel/status');travelQuote=null;
        notice=travelStatus.credentialsConfigured===true?'견적 연결 설정을 확인했습니다. 공급자 조회와 예약 완료는 별도로 구분합니다.':'견적 연결이 준비되지 않았습니다. 아래의 연결 상태와 다음 단계를 확인하세요.';
        return;
      }
      let trustReasons = [];
      if (available()) { const trust = await request('/security/trust'); trustMode = trust.mode; trustReasons = trust.reasonCodes ?? []; }
      if (kind === 'mcp') {
        profiles = (await request('/integrations/mcp')).connections;
        mcpPackages=await request('/integrations/mcp/packages').catch(()=>null);
      }
      if (kind === 'accounts') { const inbox=await request('/personal-inbox');const connection=await request('/personal-google/connect?setup=1');const collection=await request('/personal-google/collection-state').catch(()=>({adapterAvailable:false}));google.update({...inbox,collection,localConnections:(readiness.connections??[]).filter(item=>item.connectorId==='jarvis-google-workspace'),connection:{...connection,...inbox.connection,productAuthorizationConfigured:connection.productAuthorizationConfigured}}); }
      if (kind === 'devices') { try { nodes.update({...await request('/pc-nodes'),configured:true}); } catch(error) { if(error.message!=='A_PC_OUTBOUND_NOT_CONFIGURED')throw error;nodes.update({configured:false,devices:[]}); } }
      notice = available() ? 'Core 연결 확인됨. 선택한 연결만 관리합니다.' : '읽기 상태를 확인했습니다. 변경하려면 실행 환경 연결에서 관리 인증을 설정하세요.';
      if (kind === 'mcp' && trustMode !== 'trusted') notice += ` MCP 실행 차단: ${trustMode} (${trustReasons.join(', ') || '신뢰 상태 확인 필요'}).`;
    } catch (error) {
      refreshFailed=true;
      connected = false;trustMode='unknown';observationError=error.message;
      readiness={};profiles=[];mcpPackages=null;a2aServices=null;runtimeObservation=null;
      callResults={};historyPages={};verifiedResults={};travelStatus={};travelQuote=null;
      emailStatus={};
      google.update({});nodes.update({configured:false,authorityActive:false,devices:[]});
      if(kind==='delegation')mandates.invalidate();
      notice = `연결 상태를 확인하지 못했습니다 (${error.message}). Core 실행 상태와 관리 인증을 실행 환경 연결에서 확인하세요.`;
    }
    finally { if(!refreshFailed)observationError=null;busy = false; render(); }
  }
  async function operation(fn, successMessage) {
    if (busy || !available()) return;
    verifiedResults={}; busy = true; notice = '요청을 처리하고 있습니다.'; render();
    let outcome;
    try { await fn(); outcome = successMessage ?? '요청을 처리했습니다. 저장과 실행 검증은 별도 상태입니다.'; }
    catch (error) { outcome = `처리하지 못했습니다 (${a2aRegistrationReasons[error.message] ?? mcpInstallationReasons[error.message] ?? error.setupCode ?? error.message}). 상태를 새로고침해 확인하세요.`; }
    finally { busy = false; await refresh(); if(!isEmail||!observationError)notice = outcome; render(); }
  }
  root.addEventListener('submit', async event => {
    const form = event.target;
    if(form.hasAttribute('data-a2a-register')){
      event.preventDefault();const fields=new FormData(form),file=fields.get('card');
      if(!file?.size||file.size>65536){notice='64 KiB 이하의 연결 설명 JSON 파일을 선택하세요.';render();return;}
      const label=fields.get('label'),source=fields.get('source');
      return operation(async()=>{let card;try{card=JSON.parse(await file.text());}catch{throw new Error('연결 설명 파일이 올바른 JSON이 아닙니다.');}
        await request('/integrations/a2a',{method:'POST',body:{label,source,card}});});
    }
    if (form.matches('[data-runtime]')) {
      event.preventDefault(); const values = new FormData(form);
      try { base = normalizeCoreBase(values.get('base'), location.origin); }
      catch { notice = '자격증명·쿼리가 없는 이 PC의 HTTP 주소를 입력하세요.'; render(); return; }
      if (values.get('token')) { token = String(values.get('token')); sessionStorage.setItem('jarvis.coreAdminToken', token); }
      localStorage.setItem('jarvis.coreBaseUrl', base); await refresh();
    } else if(form.matches('[data-travel-quote]')){
      event.preventDefault();const values=new FormData(form);travelQuote=null;
      let quote;
      await operation(async()=>{quote=(await request('/travel/duffel/quote',{method:'POST',body:{offerId:String(values.get('offerId')).trim()}})).quote;});
      travelQuote=quote??null;render();
    } else if (form.matches('[data-provider-credential-setup]')) {
      event.preventDefault(); const values = new FormData(form); const apiKey = String(values.get('apiKey')); form.querySelector('[name=apiKey]').value = '';
      await operation(() => storeModelProviderApiKey({ provider: values.get('provider'), apiKey, request, adminToken: token || (proxy ? 'same-origin-proxy-managed' : '') }));
    } else if(form.matches('[data-mcp-install]')) {
      event.preventDefault();const values=new FormData(form);
      await operation(()=>request(`/integrations/mcp/${encodeURIComponent(form.dataset.mcpInstall)}/install`,{method:'POST',body:{tool:form.dataset.tool,catalogId:String(values.get('catalogId'))}}));
    } else if (form.matches('[data-mcp-add]')) {
      event.preventDefault(); const values = new FormData(form);
      await operation(() => request('/integrations/mcp', { method: 'POST', body: Object.fromEntries(values) }));
    } else if (form.matches('[data-mcp-call]')) {
      event.preventDefault(); const values = new FormData(form); let args;
      const tool = profiles.find(item=>item.id === form.dataset.mcpCall)?.tools?.find(item=>item.name === form.dataset.tool);
      try { args = values.get('inputMode') === 'form' ? parseSchemaForm(tool?.inputSchema,values.entries()) : JSON.parse(values.get('arguments')); } catch { notice = '필수 입력·숫자·선택 항목을 확인하세요. 고급 입력을 사용한 경우 JSON 형식도 확인하세요.'; render(); return; }
      const key = `${form.dataset.mcpCall}:${form.dataset.tool}`;
      await operation(async () => { callResults[key] = await request(`/integrations/mcp/${encodeURIComponent(form.dataset.mcpCall)}/call`, { method:'POST', body:{ tool:form.dataset.tool, arguments:args, expectedText:String(values.get('expectedText')), requestId:crypto.randomUUID().replaceAll('-','') } }); });
    }
  });
  root.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    if(target.hasAttribute('data-email-probe')||target.hasAttribute('data-email-pause')){
      const path=target.hasAttribute('data-email-probe')?'/personal-email/probe':'/personal-email/pause';
      await operation(()=>emailRequest(path,{method:'POST',body:{}}),target.hasAttribute('data-email-probe')?'연결 확인을 마쳤습니다. 메일은 보내지 않았습니다. 아래 현재 상태를 확인하세요.':'이 프로그램의 메일 사용을 중지했습니다. 제공자 계정의 권한은 유지됩니다.');return;
    }
    if(target.hasAttribute('data-travel-setup-status')){
      await refreshTravelSetup();notice=travelSetup.state==='waiting-user'?'설정 창의 응답을 기다리고 있습니다.':travelSetup.state==='stored-unverified'?'보호 저장을 확인했습니다. 실제 계정 접근은 견적 조회로 확인하세요.':travelSetup.state==='cancelled'?'설정을 취소했습니다. 키 저장을 확인한 상태가 아닙니다.':'설정 결과를 확인했습니다. 아래 상태에 따라 다음 단계를 진행하세요.';
      render();return;
    }
    if(target.hasAttribute('data-travel-setup')){
      if(busy||travelSetup.available!==true||['waiting-user','metadata-pending','outcome-unknown'].includes(travelSetup.state))return;
      busy=true;render();
      try{const response=await fetch('/api/local/duffel-setup',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','x-jarvis-setup-nonce':travelSetup.nonce??''},body:'{}',signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error();travelSetup=await response.json();notice='별도 보호 설정 창에서 완료하거나 취소하세요.';}
      catch{notice='보호 설정 창의 시작 결과를 확인하지 못했습니다. 설정 결과 확인 버튼으로 상태를 확인하세요.';await refreshTravelSetup();}
      finally{busy=false;render();}return;
    }
    if (target.hasAttribute('data-refresh')) return refresh();
    if(target.hasAttribute('data-travel-disconnect')){
      travelQuote=null;
      await operation(()=>request('/travel/duffel/disconnect',{method:'POST',body:{}}));
      notice=travelStatus.brokerAccessRevoked===true?'중개 접근 해제를 서버 영수증으로 확인했습니다. 제공자 키 삭제는 수행하지 않았습니다.':'접근 해제 결과를 확인하지 못했습니다. 로컬 조회 상태와 운영자의 인증서 철회 기록을 확인하세요.';render();return;
    }
    if (target.dataset.verifyModelProvider) return operation(() => request(`/integrations/model-providers/${encodeURIComponent(target.dataset.verifyModelProvider)}/verify`, { method:'POST' }));
    if (target.dataset.remove) return operation(() => request(`/integrations/connections/${encodeURIComponent(target.dataset.remove)}`, { method:'DELETE' }));
    if(target.dataset.a2aRemove)return operation(()=>request(`/integrations/a2a/${encodeURIComponent(target.dataset.a2aRemove)}`,{method:'DELETE'}));
    if(target.hasAttribute('data-mcp-result-close')){verifiedResults={};render();return;}
    if(target.dataset.mcpResult){
      if(busy||!available())return;
      verifiedResults={};busy=true;notice='검증한 내용을 확인하고 있습니다.';render();
      try{const value=await request(`/integrations/mcp/${encodeURIComponent(target.dataset.mcpResult)}/calls/${encodeURIComponent(target.dataset.request)}/result`);verifiedResults[target.dataset.request]=value;notice='검증한 내용을 열었습니다. 본문은 화면과 메모리에서만 임시로 유지합니다.';}
      catch(error){notice=({'A_MCP_VERIFIED_RESULT_UNAVAILABLE':'본문 보관이 끝났거나 실행 환경이 다시 시작되었습니다. 호출을 자동으로 반복하지 않습니다.', 'A_MCP_VERIFIED_RESULT_ACCESS_REVOKED':'권한이 철회되었거나 검증 계약이 변경되어 본문을 열 수 없습니다.', 'A_MCP_VERIFIED_RESULT_INVALID':'본문과 검증 영수증이 일치하지 않습니다. 내용을 표시하지 않습니다.'})[error.message]??'검증한 내용을 열지 못했습니다. 관리 인증과 연결 상태를 확인하세요.';}
      finally{busy=false;render();}return;
    }
    if(target.dataset.mcpHistory)return operation(async()=>{
      const id=target.dataset.mcpHistory,prior=historyPages[id];
      if(prior&&!prior.nextCursor)return;
      const page=await request(`/integrations/mcp/${encodeURIComponent(id)}/calls?limit=20${prior?.nextCursor?'&before='+encodeURIComponent(prior.nextCursor):''}`);
      historyPages[id]={...page,items:[...new Map([...(prior?.items??[]),...page.items].map(item=>[item.requestId,item])).values()]};
    });
    if (target.dataset.mcpProbe) return operation(() => request(`/integrations/mcp/${encodeURIComponent(target.dataset.mcpProbe)}/probe`, { method:'POST' }));
    if (target.dataset.mcpRemove) return operation(() => request(`/integrations/mcp/${encodeURIComponent(target.dataset.mcpRemove)}`, { method:'DELETE' }));
    if (target.dataset.mcpPermission) {
      const item = profiles.find(item => item.id === target.dataset.mcpPermission);
      const tools = (item?.allowedTools ?? []).map(grant => grant.name);
      const name = target.dataset.tool;
      return operation(() => request(`/integrations/mcp/${encodeURIComponent(item.id)}/permissions`, { method:'POST', body:{tools:tools.includes(name) ? tools.filter(tool => tool !== name) : [...tools,name]} }));
    }
  });
  void refresh();
}
