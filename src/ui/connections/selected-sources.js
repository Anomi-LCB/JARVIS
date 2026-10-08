const names={gmail:'Google 메일','google-calendar':'Google 일정',outlook:'Outlook 메일','teams-chat':'Teams 대화'};
const statuses={COMPLETED:'전체 조회 완료',PAUSED:'진행에 필요한 확인이 있습니다',WAITING_APPROVAL:'실행 허용 확인 필요',CANCELLED:'사용자가 중단했습니다',BLOCKED:'현재 조건에서 진행할 수 없습니다',FAILED:'조회 실패'};
/** Results remain in memory only. Every refresh clears old content before revalidation. */
export function createSelectedSources({request,changed,escape}){
 const state={streams:[],selected:'',missionId:null,mission:null,result:null,enabled:false,owner:null,busy:false,message:'',offset:0,history:null,historyOffset:0};
 let epoch=0,timer;
 const clear=()=>{state.result=null;state.offset=0;};
 async function refresh(){
  const ticket=++epoch;clear();state.busy=true;state.message='연결과 현재 권한을 확인하고 있습니다.';changed();
  try{
   const data=await request('/personal-inbox/streams');const owner=await request('/owner-session');
   if(ticket!==epoch)return;
   state.streams=data.items;state.enabled=data.missionEnabled===true;state.owner=owner.session?.status==='active'?owner.session:null;
   if(!state.streams.some(s=>s.streamRef===state.selected)){state.selected='';state.missionId=null;state.mission=null;}
   if(state.selected){
    const selected=state.streams.find(s=>s.streamRef===state.selected);
    const history=await request('/personal-inbox/selected-source-history',{method:'POST',body:{provider:selected.provider,streamRef:selected.streamRef,offset:0,limit:50}});
    if(ticket!==epoch)return;state.history=history;state.historyOffset=0;
   }else state.history=null;
   if(state.missionId){
    const result=await request(`/missions/${encodeURIComponent(state.missionId)}/verified-selected-source`,state.owner
      ?{method:'POST',body:{ownerSessionId:state.owner.sessionId}}:undefined);
    if(ticket!==epoch)return;
    const selection=state.streams.find(s=>s.streamRef===state.selected);
    if(result.success===true&&result.status==='verified'&&result.result?.streamRef===selection?.streamRef&&result.result.provider===selection.provider
      &&Array.isArray(result.result.items)&&result.result.items.length===result.result.total){state.result=result.result;state.message='현재 저장 자료와 권한을 다시 확인했습니다.';}
    else state.message='결과를 현재 상태로 확인할 수 없어 숨겼습니다. 자료 변경·권한·작업 상태를 확인하세요.';
   }else state.message=state.enabled?'조회할 저장 연결을 선택하세요.':'이 실행 환경에 전체 자료 조회 경로가 아직 연결되지 않았습니다.';
  }catch{if(ticket===epoch){state.enabled=false;state.owner=null;state.message='연결 또는 권한을 확인하지 못해 결과를 숨겼습니다. 다시 확인해 주세요.';}}
  finally{if(ticket===epoch){state.busy=false;changed();}}
 }
 function select(value){++epoch;clear();state.history=null;state.historyOffset=0;state.selected=state.streams.some(s=>s.streamRef===value)?value:'';state.missionId=null;state.mission=null;state.busy=false;state.message='선택한 저장 연결만 조회합니다.';changed();}
 async function openHistory(id){
  const entry=state.history?.items.find(m=>m.missionId===id&&m.status==='COMPLETED');
  if(state.busy||!state.owner||!entry)return;
  state.missionId=entry.missionId;state.mission={status:entry.status};await refresh();
 }
 async function historyPage(offset){
  if(state.busy||!state.history||offset<0)return;
  const ticket=++epoch,selection=state.streams.find(s=>s.streamRef===state.selected),revision=state.history.revision;
  clear();state.missionId=null;state.mission=null;state.busy=true;changed();
  try{
   const history=await request('/personal-inbox/selected-source-history',{method:'POST',body:{provider:selection.provider,streamRef:selection.streamRef,offset,limit:50,expectedRevision:revision}});
   if(ticket!==epoch)return;state.history=history;state.historyOffset=offset;
  }catch{if(ticket===epoch){state.history=null;state.message='조회 이력이 바뀌었거나 확인되지 않습니다. 현재 상태를 다시 확인하세요.';}}
  finally{if(ticket===epoch){state.busy=false;changed();}}
 }
 async function run(){
  if(state.busy||!state.enabled||!state.owner||!state.selected)return;
  const ticket=++epoch,selection=state.streams.find(s=>s.streamRef===state.selected);clear();state.busy=true;state.message='선택한 자료를 전체 조회하고 있습니다.';changed();
  try{
   const created=await request('/missions',{method:'POST',body:{objective:'선택한 연결의 저장 자료 전체를 조회해.',selectedSource:{provider:selection.provider,streamRef:selection.streamRef},
    authorization:{mode:'trusted_session',ownerSessionId:state.owner.sessionId,grants:['read_only','high_impact']},metadata:{longTermMemory:false}}});
   if(!created.missionId)throw new Error();
   if(ticket!==epoch){await request(`/missions/${encodeURIComponent(created.missionId)}/cancel`,{method:'POST',body:{reason:'선택 변경으로 조회 중단'}});return;}
   state.missionId=created.missionId;state.mission=await request(`/missions/${encodeURIComponent(created.missionId)}/run`,{method:'POST',body:{}});
   if(ticket!==epoch)return;state.message=statuses[state.mission.status]??'진행 상태를 확인하세요.';
  }catch{if(ticket===epoch)state.message='조회하지 못했습니다. 현재 연결과 실행 허용을 확인하세요.';}
  finally{if(ticket===epoch){state.busy=false;changed();if(state.mission?.status==='COMPLETED')await refresh();}}
 }
 async function cancel(){const id=state.missionId;++epoch;clear();state.busy=false;state.message='조회 중단을 요청했습니다. 결과를 숨겼습니다.';changed();if(id)try{await request(`/missions/${encodeURIComponent(id)}/cancel`,{method:'POST',body:{reason:'저장 자료 화면에서 중단'}});}catch{state.message='중단 여부를 확인하지 못했습니다. 주 작업 화면에서 확인하세요.';changed();}}
 function render(){const visible=state.result?.items.slice(state.offset,state.offset+50)??[];
  return `<section><h2>선택한 저장 자료 전체 조회</h2><p>기존에 저장된 제목·시각을 확인합니다. 실계정의 최신 동기화나 메일 본문 전체 조회는 별도입니다.</p>
   <label>저장 연결<select data-source-select ${state.busy?'disabled':''}><option value="">연결을 선택하세요</option>${state.streams.map((s,i)=>`<option value="${escape(s.streamRef)}" ${s.streamRef===state.selected?'selected':''}>${escape(names[s.provider])} · 저장 연결 ${i+1} · ${s.itemCount}개</option>`).join('')}</select></label>
   <p>${state.owner?'기존 개인 실행 허용을 사용합니다.':'주 작업 화면에서 개인 실행 허용을 먼저 켜세요. 이 화면은 권한을 자동 확장하지 않습니다.'}</p>
   <div class="node-actions"><button data-source-run ${state.busy||!state.enabled||!state.owner||!state.selected?'disabled':''}>선택 자료 전체 조회</button><button class="secondary" data-source-refresh>현재 상태 다시 확인</button><button class="secondary" data-source-cancel ${!state.missionId?'disabled':''}>조회 중단·결과 숨기기</button></div>
   <p role="status" data-source-status>${escape(state.message)}</p>${state.history?`<section><h3>이전 조회 찾기</h3><p>과거 작업 상태입니다. 내용을 열 때 현재 자료와 읽기 허용을 다시 확인합니다.</p>
   ${state.history.items.map(m=>`<article><p>${escape(m.createdAt)} · ${escape(statuses[m.status]??'상태 확인 필요')}</p><button class="secondary" data-source-history-open="${escape(m.missionId)}" ${state.busy||!state.owner||m.status!=='COMPLETED'?'disabled':''}>현재 자료로 다시 검증해 열기</button></article>`).join('')||'<p>이 연결의 이전 조회가 없습니다.</p>'}
   <div class="node-actions"><button class="secondary" data-source-history-prev ${state.busy||state.historyOffset===0?'disabled':''}>이전 조회 이력</button><span>${state.historyOffset+state.history.items.length} / ${state.history.total}건</span><button class="secondary" data-source-history-next ${state.busy||state.history.nextOffset===null?'disabled':''}>다음 조회 이력</button></div></section>`:''}${state.result?`<p>전체 ${state.result.total}개 검증 · ${state.result.pageCount}페이지 조회 · 외부 문장은 참고 자료입니다.</p>
   <div class="source-results">${visible.map(item=>`<article><h3>${escape(item.title)}</h3>${item.start?`<p>${escape(item.start)}</p>`:''}<p>${item.withdrawn?'취소·거절된 자료':'저장된 자료'}</p></article>`).join('')||'<p>저장된 자료가 없습니다.</p>'}</div>
   <div class="node-actions"><button class="secondary" data-source-prev ${state.offset===0?'disabled':''}>이전 50개</button><span>${state.result.total?state.offset+1:0}~${Math.min(state.offset+50,state.result.total)} / ${state.result.total}</span><button class="secondary" data-source-next ${state.offset+50>=state.result.total?'disabled':''}>다음 50개</button></div>`:''}</section>`;
 }
 function attach(root){root.addEventListener('change',e=>{if(e.target.matches('[data-source-select]')){select(e.target.value);void refresh();}});root.addEventListener('click',e=>{
  const historical=e.target.closest('[data-source-history-open]');if(historical)void openHistory(historical.dataset.sourceHistoryOpen);
  if(e.target.closest('[data-source-history-prev]'))void historyPage(Math.max(0,state.historyOffset-50));
  if(e.target.closest('[data-source-history-next]')&&state.history?.nextOffset!==null)void historyPage(state.history.nextOffset);
  if(e.target.closest('[data-source-refresh]'))void refresh();if(e.target.closest('[data-source-run]'))void run();if(e.target.closest('[data-source-cancel]'))void cancel();
  if(state.result&&e.target.closest('[data-source-next]')){state.offset=Math.min(state.offset+50,Math.floor((state.result.total-1)/50)*50);changed();}
  if(state.result&&e.target.closest('[data-source-prev]')){state.offset=Math.max(0,state.offset-50);changed();}
 });}
 function watch(){timer=setInterval(()=>{if(state.missionId&&!state.busy&&!globalThis.document?.hidden)void refresh();},5000);globalThis.document?.addEventListener('visibilitychange',()=>{clear();changed();if(!document.hidden)void refresh();});}
 return {render,attach,refresh,select,run,cancel,openHistory,historyPage,watch,dispose:()=>clearInterval(timer)};
}
