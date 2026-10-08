export function createPersonalMandatePanel({request,changed,escape,initialOpen=false}){
  let selected='';try{selected=localStorage.getItem('jarvis.executionMandateId')??'';}catch{}
  const state={items:[],loaded:false,busy:false,error:'',open:initialOpen,selected,maxCalls:'10',expiresAt:''};
  const isQuota=x=>x.action==='mission.run'&&x.target==='jarvis:missions'&&x.maxAmountMinor===0&&x.budget?.totalMinor===0;
  function select(id){state.selected=id;try{localStorage.setItem('jarvis.executionMandateId',id);}catch{}}
  function invalidate(){state.items=[];state.loaded=false;state.error='현재 위임 상태를 확인하지 못했습니다. 실행 환경 연결과 관리 인증을 확인한 뒤 새로고침해 주세요.';}
  async function refresh(){if(state.busy)return;state.busy=true;state.error='';changed();try{const payload=await request('/personal-mandates');if(!Array.isArray(payload.items))throw new Error('INVALID_MANDATE_LIST');state.items=payload.items;state.loaded=true;}catch{state.items=[];state.loaded=false;state.error='위임 목록을 불러오지 못했습니다. 실행 환경 연결과 관리 인증을 확인한 뒤 새로고침해 주세요.';}finally{state.busy=false;changed();}}
  function render(){const quotas=state.items.filter(isQuota);return `<details class="personal-inbox panel" data-mandate-panel ${state.open?'open':''}><summary><strong>실행 위임 관리</strong><span>${state.loaded?`등록 ${state.items.length}개`:'목록 미확인'} · 실행 범위와 한도</span></summary><div class="personal-inbox-content">
    <div class="personal-inbox-toolbar"><p>위임을 선택하면 새 목표에 적용합니다. 기존 행동 승인 정책은 유지됩니다. 빠른 작업에는 적용되지 않습니다.</p><button type="button" data-mandate-refresh ${state.busy?'disabled':''}>새로고침</button></div>
    <label for="execution-mandate-select">새 목표에 적용할 위임</label><select id="execution-mandate-select" data-mandate-select><option value="" ${!state.selected?'selected':''}>위임 없이 기존 방식으로 실행</option>${state.selected&&!quotas.some(x=>x.id===state.selected)?`<option value="${escape(state.selected)}" selected>기존 선택한 위임 확인 필요</option>`:''}${quotas.map(x=>`<option value="${escape(x.id)}" ${state.selected===x.id?'selected':''}>${escape(x.id.slice(0,8))} · 남은 ${x.budget.remainingCalls}회${x.revoked?' · 철회됨':''}</option>`).join('')}</select>
    <p role="status">${escape(state.error||'금액 0은 실행 횟수 계산용입니다. 실제 결제나 AI 사용료가 무료라는 의미는 아닙니다.')}</p>
    <div class="personal-inbox-grid"><article class="personal-inbox-item"><h3>목표 실행 횟수 위임 만들기</h3><form data-mandate-create><label for="mandate-count">최대 목표 수</label><input id="mandate-count" name="maxCalls" type="number" min="1" max="100000" step="1" required value="${escape(state.maxCalls)}"/><label for="mandate-expiry">종료 시각 · 이 기기 기준</label><input id="mandate-expiry" name="expiresAt" type="datetime-local" required value="${escape(state.expiresAt)}"/><button type="submit" ${state.busy?'disabled':''}>만들고 다음 목표에 적용</button></form></article>
    ${state.loaded&&!state.items.length?'<p>등록한 위임이 없습니다. 필요한 목표 수와 종료 시각을 정해 만들 수 있습니다.</p>':''}
    ${state.items.map(x=>`<article class="personal-inbox-item" data-mandate-id="${escape(x.id)}"><h3>${isQuota(x)?'목표 실행 위임':escape(x.action)} · ${escape(x.id.slice(0,8))}</h3><p>${x.revoked?'철회됨':Date.parse(x.expiresAt)<=Date.now()?'만료됨':Date.parse(x.validFrom)>Date.now()?'시작 전':'등록됨'} · ${escape(x.expiresAt)}</p><p>대상: ${escape(x.target)} · 시작: ${escape(x.validFrom)} · 1회 금액 한도: ${escape(x.maxAmountMinor)} ${escape(x.currency)}</p><p>${x.budget?`사용·예약 ${escape(x.budget.usedOrHeldCalls)} / ${escape(x.budget.maxCalls)}회 · 남은 ${escape(x.budget.remainingCalls)}회`:'누적 한도 미설정'}</p>${!x.revoked?`<button type="button" data-mandate-revoke="${escape(x.id)}" ${state.busy?'disabled':''}>위임 철회</button>`:'<p>철회된 위임은 새 실행을 허용하지 않습니다. 기존 결과와 기록은 보존합니다.</p>'}</article>`).join('')}</div></div></details>`;}
  function attach(root){
    root.addEventListener('toggle',e=>{if(e.target.matches?.('[data-mandate-panel]'))state.open=e.target.open;},true);
    root.addEventListener('change',e=>{if(e.target.matches('[data-mandate-select]'))select(e.target.value);});
    root.addEventListener('input',e=>{if(e.target.id==='mandate-count')state.maxCalls=e.target.value;if(e.target.id==='mandate-expiry')state.expiresAt=e.target.value;});
    root.addEventListener('click',async e=>{
      if(e.target.closest('[data-mandate-refresh]')){void refresh();return;}
      const target=e.target.closest('[data-mandate-revoke]');if(!target||state.busy)return;state.busy=true;state.error='';changed();
      try{await request('/personal-mandates/revoke',{method:'POST',body:{id:target.dataset.mandateRevoke}});}catch{state.error='위임을 철회하지 못했습니다.';}finally{state.busy=false;const error=state.error;await refresh();if(error){state.error=error;changed();}}
    });
    root.addEventListener('submit',async e=>{
      if(!e.target.matches('[data-mandate-create]'))return;e.preventDefault();if(state.busy)return;
      const data=new FormData(e.target),expiry=new Date(data.get('expiresAt'));if(!Number.isFinite(expiry.getTime()))return;state.busy=true;state.error='';changed();
      try{const result=await request('/personal-mandates/create-mission-quota',{method:'POST',body:{maxCalls:Number(data.get('maxCalls')),validFrom:new Date().toISOString(),expiresAt:expiry.toISOString()}});select(result.mandate.id);}
      catch{state.error='위임을 만들지 못했습니다. 횟수와 종료 시각을 확인해 주세요.';}
      finally{state.busy=false;const error=state.error;await refresh();if(error){state.error=error;changed();}}
    });
  }
  return {render,attach,refresh,invalidate,selected:()=>state.selected||null};
}
