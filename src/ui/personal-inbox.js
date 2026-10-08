import {createGoogleSetup} from './google-setup.js';
export function createPersonalInboxPanel({request,changed,escape,onQuotaChanged}) {
  const setup=createGoogleSetup({request,changed,refresh,escape,onQuotaChanged});
  const state={items:[],worker:null,google:null,loaded:false,busy:false,error:'',message:'',open:globalThis.location?.hash==='#personal-inbox',drafts:new Map()};
  async function refresh(){
    if(state.busy)return;state.busy=true;state.error='';changed();
    try {const data=await request('/personal-inbox');state.items=data.items;state.worker=data.worker;state.google=data.google;state.loaded=true;setup.update(data);}
    catch{state.error='수집함을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.';}
    finally{state.busy=false;changed();}
  }
  function initialDue(item){
    // Preserve explicit offset for display conversion; ambiguous times require a user choice.
    if(!item.start||!/(Z|[+-]\d\d:\d\d)$/.test(item.start))return '';
    const date=new Date(item.start);if(!Number.isFinite(date.getTime()))return '';
    return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
  }
  function syncEvidence(){
    const describeError=code=>/MANDATE_DENIED/.test(code)?'위임이 만료되었거나 철회되었습니다.':/LIMIT_EXCEEDED/.test(code)?'수집 페이지 한도를 모두 사용했습니다.':/REAUTH|HTTP_401|HTTP_403/.test(code)?'Google 연결과 계정 권한을 확인해 주세요.':/429/.test(code)?(state.google?.configured&&state.google?.running?'Google 요청 한도에 도달했습니다. 다음 주기에 재시도합니다.':'Google 요청 한도 오류 기록입니다. 직접 조회를 연결·재개한 뒤 재시도합니다.'):'수집을 완료하지 못했습니다. 다음 조회에서 재시도합니다.';
    const labels={gmail:'메일','google-calendar':'일정'},states={reading:'조회 중',failed:'실패 · 다음 주기에 재시도',committed:'저장 검증 완료'};
    return (state.google?.evidence??[]).map(x=>{const current=state.google?.providers?.[x.provider];return '<article class="personal-inbox-item"><h3>'+labels[x.provider]+' 직접 수집</h3><p>'+ (x.budget?'남은 '+x.budget.remainingCalls+'페이지 · 위임 적용':'페이지 위임 미설정')+'</p><p>저장 완료 '+x.committedPages+'페이지 · 조회 시도 '+x.attempts+'회</p><p>'+escape(current?.code||x.latest?.errorCode?describeError(current?.code??x.latest.errorCode):states[x.latest?.state]??'실행 증빙 없음')+'</p>'+(x.latest?'<p>최근 기록 '+escape(x.latest.updatedAt)+'</p>':'')+'</article>';}).join('');
  }
  function render(){
    const status=state.worker?.running?'로컬 파일 자동 반영 중':'로컬 파일 자동 반영 중지';
    const googleStatus=!state.google?.configured?'Google 직접 연결에 최초 계정 인증이 필요합니다.':!state.google.running?'Google 직접 조회가 중지되어 있습니다.':['error','degraded'].includes(state.google.status)?'Google 조회에 실패했습니다. 연결과 권한을 확인해 주세요.':'Google 직접 조회가 켜져 있습니다. 최근 메일과 일정 범위를 5분마다 확인합니다.';
    return `<details id="personal-inbox" class="personal-inbox panel" data-personal-inbox ${state.open?'open':''}>
      <summary><strong>메일·일정 수집함</strong><span>${state.loaded?state.items.length+'개 항목':'연결 확인'} · ${state.busy?'불러오는 중':status}</span></summary>
      <div class="personal-inbox-content"><div class="personal-inbox-toolbar"><p>가져온 메일과 일정을 약속으로 연결합니다. ${googleStatus}</p><button type="button" data-inbox-refresh ${state.busy?'disabled':''}>새로고침</button></div>
      <p role="status">${escape(state.error||state.message|| (state.worker?.failedFiles?`${state.worker.failedFiles}개 수집 파일을 반영하지 못했습니다.`:'약속 등록은 선택한 기한을 저장합니다. 외부 발송이나 결제는 실행하지 않습니다.'))}</p>
      ${setup.render()}
      <div class="personal-inbox-grid">${syncEvidence()}</div>
      <div class="personal-inbox-grid">${state.items.map(item=>`<article class="personal-inbox-item"><span class="personal-inbox-source">${item.provider==='gmail'?'메일':'일정'} · ${item.withdrawn?'취소·거절됨':item.commitmentId?'약속 연결됨':'미연결'}</span><h3>${escape(item.title)}</h3>
      ${item.start?`<p>${escape(item.start)}${item.timeInterpretation==='unresolved-local-or-all-day'?' · 시간 확인 필요':''}</p>`:''}
      ${item.commitmentId?'<p>등록한 약속은 업무 원장에서 관리합니다.</p>':item.withdrawn?'<p>취소된 항목은 등록할 수 없습니다.</p>':`<form data-inbox-accept="${escape(item.id)}"><label for="due-${escape(item.id)}">기한 · 이 기기의 현지 시각</label><input id="due-${escape(item.id)}" name="dueAt" type="datetime-local" required value="${escape(state.drafts.get(item.id)??initialDue(item))}" data-inbox-due="${escape(item.id)}"/><button type="submit" ${state.busy?'disabled':''}>약속으로 등록</button></form>`}</article>`).join('')||'<p>아직 수집된 항목이 없습니다.</p>'}</div></div></details>`;
  }
  function attach(root){
    setup.attach(root);
    root.addEventListener('toggle',event=>{if(event.target.matches?.('[data-personal-inbox]'))state.open=event.target.open;},true);
    root.addEventListener('input',event=>{if(event.target.matches?.('[data-inbox-due]'))state.drafts.set(event.target.dataset.inboxDue,event.target.value);});
    root.addEventListener('click',event=>{if(event.target.closest('[data-inbox-refresh]'))void refresh();});
    root.addEventListener('submit',async event=>{
      if(!event.target.matches('[data-inbox-accept]'))return;event.preventDefault();if(state.busy)return;
      const id=event.target.dataset.inboxAccept,value=new FormData(event.target).get('dueAt'),date=new Date(value);
      if(!Number.isFinite(date.getTime()))return;
      state.busy=true;state.error='';state.message='';changed();
      try {await request('/personal-inbox/accept',{method:'POST',body:{id,dueAt:date.toISOString()}});state.message='약속을 등록했습니다.';}
      catch{state.error='등록하지 못했습니다. 기한과 항목 상태를 확인해 주세요.';}
      finally{state.busy=false;const error=state.error;await refresh();if(error){state.error=error;changed();}}
    });
  }
  return {render,attach,refresh};
}
