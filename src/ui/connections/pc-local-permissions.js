const timeInput = value => { const date=new Date(value);return Number.isFinite(date.getTime())?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):''; };
const validId = value => typeof value==='string'&&/^[\p{L}\p{N}._-]{1,128}$/u.test(value);
function validate(value){
  if(value?.configured!==true||value.executionAuthority!==false||value.verifiedCompletion!==false
    ||!Number.isSafeInteger(value.revision)||value.revision<0||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<0||typeof value.active!=='boolean'
    ||![value.allowedTaskIds,value.selectableTaskIds].every(ids=>Array.isArray(ids)&&ids.length<=1000&&ids.every(validId)&&new Set(ids).size===ids.length)
    ||value.allowedTaskIds.some(id=>!value.selectableTaskIds.includes(id)))throw new Error('PC_SCOPE_RESPONSE_INVALID');
  return structuredClone(value);
}
export function createPcLocalPermissions({request,readLabels=null,changed,escape,clock=Date.now}){
  let saved=null,draft=null,busy=false,enabled=false,notice='',disposed=false,version=0,labels=new Map(),attachedRoot=null,labelController=null;
  const apply=value=>{saved=validate(value);draft={revision:saved.revision,tasks:[...saved.allowedTaskIds],expiresAt:timeInput(saved.active?saved.expiresAt:clock()+3600000)};};
  const cancelLabels=()=>{labelController?.abort();labelController=null;};
  async function loadLabels(ids,current){
    if(!readLabels||!ids.length)return;
    const controller=new AbortController();labelController=controller;
    // Only update title text. Replacing the form would lose focus and partially entered dates.
    const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('LABEL_CANCELLED')),{once:true}));
    const timer=setTimeout(()=>controller.abort(),3000);
    try{
      const result=await Promise.race([Promise.resolve().then(()=>readLabels(ids,{signal:controller.signal})),cancelled]);
      const nextLabels=new Map();
      if(!['core-runtime-planning-records','core-runtime-and-mission-records'].includes(result?.source)||result.executionAuthority!==false||result.verifiedCompletion!==false||result.deviceAvailabilityVerified!==false||!Array.isArray(result.items)||result.items.length!==ids.length)throw new Error('LABEL_INVALID');
      for(let i=0;i<result.items.length;i++){const item=result.items[i];if(item.taskId!==ids[i]||typeof item.found!=='boolean'||(item.found?(typeof item.title!=='string'||!item.title.length||item.title.length>120||/[\p{Cc}\p{Cf}]/u.test(item.title)):item.title!==null))throw new Error('LABEL_INVALID');if(item.found)nextLabels.set(item.taskId,item.title);}
      if(disposed||!enabled||version!==current||controller.signal.aborted)return;
      labels=nextLabels;
      for(const element of attachedRoot?.querySelectorAll?.('[data-local-task-label]')??[]){
        element.textContent=labels.get(element.dataset.localTaskLabel)??'업무 이름 확인 필요';
      }
    }catch{ /* Optional metadata cannot change the local grant or prevent editing. */ }
    finally{clearTimeout(timer);if(labelController===controller)labelController=null;}
  }
  async function load(){
    if(busy||!enabled||disposed)return;cancelLabels();busy=true;const current=++version;notice='PC의 허용 범위를 확인하고 있습니다.';changed();
    let ids=null;
    try{const value=validate(await request());
      if(!disposed&&version===current){labels=new Map();apply(value);ids=value.selectableTaskIds;notice='현재 PC 설정을 불러왔습니다. 선택과 종료 시각을 확인하세요.';}}
    catch(error){if(!disposed&&version===current){saved=null;draft=null;notice=error.message==='B_PC_LOCAL_SCOPE_NOT_CONFIGURED'?'PC의 권한 설정 저장소가 아직 준비되지 않았습니다. 설치·연결 구성을 완료해야 합니다.':'PC 설정을 불러오지 못했습니다. PC 연결과 관리 인증을 확인하세요.';}}
    finally{busy=false;if(!disposed)changed();}
    if(ids&&!disposed&&version===current)void loadLabels(ids,current);
  }
  async function save(revoke=false){
    if(busy||!enabled||!draft||disposed)return;
    const expiresAt=revoke?0:new Date(draft.expiresAt).getTime();
    if(!revoke&&(!draft.tasks.length||!Number.isSafeInteger(expiresAt)||expiresAt<=clock())){notice='허용할 업무를 선택하고 미래의 종료 시각을 정하세요.';changed();return;}
    const input={expectedRevision:draft.revision,allowedTaskIds:revoke?[]:[...draft.tasks],expiresAt};
    cancelLabels();busy=true;const current=++version;notice='설정을 저장하고 있습니다.';changed();
    try{const value=await request({method:'PUT',body:input});if(!disposed&&version===current){apply(value);notice=revoke?'이 PC의 실행 허용을 모두 철회했습니다. 이미 발생한 결과는 별도로 확인합니다.':'이 PC의 실행 허용을 저장했습니다. 실제 업무 완료는 작업 결과에서 확인합니다.';}}
    catch(error){if(!disposed&&version===current){notice=error.message==='B_PC_LOCAL_SCOPE_REVISION_CONFLICT'?'다른 곳에서 설정을 바꿨습니다. 현재 설정 다시 불러오기를 누르고 선택을 확인하세요.':'저장 결과를 확인하지 못했습니다. 재전송 전에 현재 설정을 다시 불러오세요.';draft=null;}}
    finally{busy=false;if(!disposed)changed();}
  }
  function render(){
    const disabled=!enabled||busy;
    return `<section><h2>이 PC에서 실행할 업무</h2><p>현재 PC에 구성된 업무만 허용할 수 있습니다. Core의 위임과 자료 접근 권한도 함께 필요합니다.</p><p role="status">${escape(notice||(!enabled?'PC 관리 연결이 준비되지 않았습니다. 프로그램 연결 상태를 확인하세요.':'현재 설정을 불러오세요.'))}</p><button type="button" data-local-scope-load ${disabled?'disabled':''}>현재 설정 다시 불러오기</button>${draft?`<form data-local-scope-form><fieldset ${disabled?'disabled':''}><legend>허용할 업무 선택</legend>${saved.selectableTaskIds.map((id,index)=>`<label class="local-scope-task"><input type="checkbox" name="task-${index}" data-local-task="${escape(id)}" ${draft.tasks.includes(id)?'checked':''}><span><span data-local-task-label="${escape(id)}">${escape(labels.get(id)??'업무 이름 확인 필요')}</span><small>업무 식별자: ${escape(id)}</small></span></label>`).join('')||'<p>구성된 업무가 없습니다.</p>'}<label>허용 종료 시각<input type="datetime-local" name="expiresAt" value="${escape(draft.expiresAt)}" required></label><p>이 PC의 현지 시간으로 저장합니다. 현재 설정 버전 ${escape(draft.revision)} · ${saved.active?'실행 허용 중':'허용 없음 또는 기간 만료'}</p><div class="node-actions"><button ${disabled?'disabled':''}>선택한 업무 허용 저장</button><button type="button" class="secondary" data-local-scope-revoke ${disabled?'disabled':''}>실행 허용 모두 철회</button></div></fieldset></form>`:''}</section>`;
  }
  return {render,load,save,
    setEnabled(value){if(disposed)return;if(enabled!==Boolean(value)){enabled=Boolean(value);version++;cancelLabels();saved=null;draft=null;labels=new Map();}},
    attach(root){attachedRoot=root;root.addEventListener('change',event=>{if(!draft||busy||!enabled)return;const input=event.target;if(input.dataset.localTask&&saved.selectableTaskIds.includes(input.dataset.localTask)){draft.tasks=draft.tasks.filter(id=>id!==input.dataset.localTask);if(input.checked)draft.tasks.push(input.dataset.localTask);}if(input.name==='expiresAt')draft.expiresAt=input.value;});
      root.addEventListener('submit',event=>{if(event.target.matches('[data-local-scope-form]')){event.preventDefault();void save();}});
      root.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.hasAttribute('data-local-scope-load'))void load();if(button.hasAttribute('data-local-scope-revoke'))void save(true);});},
    dispose(){disposed=true;version++;cancelLabels();attachedRoot=null;saved=null;draft=null;labels=new Map();}
  };
}
