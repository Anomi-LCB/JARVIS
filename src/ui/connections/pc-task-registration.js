const validId=value=>typeof value==='string'&&/^[\p{L}\p{N}._-]{1,128}$/u.test(value);
const roles=['allowedTaskIds','allowedArtifactTaskIds','allowedCommandTaskIds'];
function validate(value){
  if(value?.configured!==true||value.executionAuthority!==false||value.verifiedCompletion!==false||!Number.isSafeInteger(value.revision)||value.revision<0
    ||roles.some(key=>!Array.isArray(value[key])||value[key].length>1000||!value[key].every(validId)||new Set(value[key]).size!==value[key].length)
    ||value.allowedArtifactTaskIds.some(id=>!value.allowedTaskIds.includes(id))||value.allowedCommandTaskIds.some(id=>!value.allowedArtifactTaskIds.includes(id)))throw new Error('PC_CATALOG_INVALID');
  return structuredClone(value);
}
export function createPcTaskRegistration({request,readOptions,changed,escape}){
  let draft=null,busy=false,enabled=false,disposed=false,version=0,notice='',page=null;
  const names=new Map();
  const current=revision=>!disposed&&enabled&&version===revision;
  async function load(){
    if(busy||!enabled||disposed)return;busy=true;const revision=++version;notice='PC 등록 목록을 확인하고 있습니다.';changed();
    try{const value=validate(await request());if(current(revision)){draft=value;page=null;notice='등록된 업무를 불러왔습니다. 등록은 실행 허용과 별도입니다.';}}
    catch(error){if(current(revision)){draft=null;notice=error.message==='B_PC_LOCAL_SCOPE_NOT_CONFIGURED'?'PC의 업무 등록 저장소가 준비되지 않았습니다. 설치·연결 구성을 확인하세요.':'목록을 불러오지 못했습니다. PC 연결과 관리 인증을 확인하세요.';}}
    finally{busy=false;if(!disposed)changed();}
  }
  async function find(next=false){
    if(busy||!enabled||!draft||disposed||next&&!page?.hasMore)return;
    busy=true;const revision=version,previous=page;notice='자비스에 계획된 업무를 찾고 있습니다.';changed();
    try{
      const value=await readOptions(next?`?offset=${previous.nextOffset}&limit=100&snapshot=${previous.snapshot}`:'?limit=100');
      if(!current(revision))return;
      if(!['core-runtime-planning-records','core-runtime-and-mission-records'].includes(value?.source)||value.executionAuthority!==false||value.verifiedCompletion!==false||value.deviceAvailabilityVerified!==false
        ||!Array.isArray(value.items)||value.items.length>100||!Number.isSafeInteger(value.offset)||value.offset!==(next?previous.nextOffset:0)||!Number.isSafeInteger(value.totalEntries)||value.totalEntries<value.offset+value.items.length
        ||value.nextOffset!==value.offset+value.items.length||value.hasMore!==(value.nextOffset<value.totalEntries)||!/^[a-f0-9]{64}$/u.test(value.snapshot??'')||next&&value.snapshot!==previous.snapshot
        ||new Set(value.items.map(item=>item.taskId)).size!==value.items.length||!value.items.every(item=>validId(item.taskId)&&typeof item.title==='string'&&item.title.length>0&&item.title.length<=120&&!/[\p{Cc}\p{Cf}]/u.test(item.title)&&typeof item.status==='string'))throw new Error('PC_OPTIONS_INVALID');
      page=structuredClone(value);for(const item of page.items)names.set(item.taskId,item.title);
      notice='업무별 접근 범위를 선택하세요. 다음 페이지를 열어도 선택한 업무는 유지됩니다.';
    }catch(error){if(current(revision)){page=null;notice=error.message==='A_PC_OUTBOUND_TASK_OPTIONS_CHANGED'?'계획된 업무 목록이 바뀌었습니다. 처음부터 다시 조회하세요. 기존 선택은 유지됩니다.':'업무 이름을 조회하지 못했습니다. 기존 PC 등록을 유지하며 자비스 연결을 확인하세요.';}}
    finally{busy=false;if(!disposed)changed();}
  }
  function select(id,level){
    if(!enabled||busy||!draft||disposed||!validId(id)||!Number.isInteger(level)||level<0||level>3
      ||!draft.allowedTaskIds.includes(id)&&!page?.items.some(item=>item.taskId===id))return;
    if(level&& !draft.allowedTaskIds.includes(id)&&draft.allowedTaskIds.length>=1000){notice='한 번에 등록할 수 있는 업무는 1,000개입니다.';changed();return;}
    for(let index=0;index<roles.length;index++){draft[roles[index]]=draft[roles[index]].filter(value=>value!==id);if(level>index)draft[roles[index]].push(id);}
    changed();
  }
  async function save(){
    if(busy||!enabled||!draft||disposed)return;
    const input={expectedRevision:draft.revision,...Object.fromEntries(roles.map(key=>[key,[...draft[key]]]))};
    busy=true;const revision=++version;notice='PC 등록 목록을 저장하고 있습니다.';changed();
    try{const result=validate(await request({method:'PUT',body:input}));if(current(revision)){
      if(result.revision!==input.expectedRevision+1||roles.some(key=>JSON.stringify([...result[key]].sort())!==JSON.stringify([...input[key]].sort())))throw new Error('PC_CATALOG_SAVE_MISMATCH');
      draft=result;notice='PC 등록을 저장했습니다. 새 업무 실행은 이 PC 실행 허용 화면에서 별도로 정하세요.';
    }}catch(error){if(current(revision)){draft=null;page=null;notice=error.message==='B_PC_LOCAL_SCOPE_REVISION_CONFLICT'?'다른 곳에서 등록을 변경했습니다. 현재 목록을 다시 불러와 선택하세요.':'저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 현재 목록을 불러오세요.';}}
    finally{busy=false;if(!disposed)changed();}
  }
  function render(){
    const disabled=!enabled||busy,items=new Map((page?.items??[]).map(item=>[item.taskId,item]));
    for(const id of draft?.allowedTaskIds??[])if(!items.has(id))items.set(id,{taskId:id,title:names.get(id)??'등록된 업무 · 이름 확인 필요',status:'REGISTERED'});
    return `<section><h2>PC 업무 등록</h2><p>업무를 등록한 뒤 실행을 허용할지 따로 정합니다. 등록을 제거하면 해당 업무의 기존 실행 허용도 철회됩니다. 자료 폴더와 자비스의 위임은 이 화면에서 확대되지 않습니다.</p><p role="status">${escape(notice||'PC 관리 연결과 등록 목록을 확인하세요.')}</p><div class="node-actions"><button type="button" data-registration-load ${disabled?'disabled':''}>현재 등록 다시 불러오기</button>${draft?`<button type="button" data-registration-find ${disabled?'disabled':''}>계획된 업무 찾기</button>${page?.hasMore?`<button type="button" data-registration-next ${disabled?'disabled':''}>다음 업무 보기</button>`:''}`:''}</div>${draft?`<p>조회 등록 ${draft.allowedTaskIds.length}개 · 산출물 접근 ${draft.allowedArtifactTaskIds.length}개 · 명령 후보 ${draft.allowedCommandTaskIds.length}개</p><form data-registration-form><fieldset ${disabled?'disabled':''}><legend>업무별 접근 범위</legend>${[...items.values()].map(item=>{
      const level=draft.allowedCommandTaskIds.includes(item.taskId)?3:draft.allowedArtifactTaskIds.includes(item.taskId)?2:draft.allowedTaskIds.includes(item.taskId)?1:0;
      return `<label class="registration-task"><span>${escape(item.title)}<small>${item.status==='RESERVED'?'계획된 단계 · 실행 전':'자비스 또는 저장된 PC 기록 · 현재 완료 여부는 별도 확인'}</small></span><select aria-label="${escape(item.title)} 접근 범위" data-registration-task="${escape(item.taskId)}">${['등록 안 함','업무 기록 조회','조회 + 산출물 읽기','조회 + 산출물 + 명령 후보'].map((title,index)=>`<option value="${index}" ${index===level?'selected':''}>${title}</option>`).join('')}</select><details><summary>업무 식별자</summary><small>${escape(item.taskId)}</small></details></label>`;
    }).join('')||'<p>등록된 업무가 없습니다. 계획된 업무 찾기를 눌러 시작하세요.</p>'}<button ${disabled?'disabled':''}>선택한 범위로 PC 등록 저장</button></fieldset></form><p><a href="pc-permissions.html">다음: 이 PC 실행 허용 설정</a></p>`:''}</section>`;
  }
  return {load,find,save,select,render,setEnabled(value){if(disposed)return;if(enabled!==Boolean(value)){enabled=Boolean(value);version++;draft=null;page=null;names.clear();}},
    attach(root){root.addEventListener('change',event=>{const id=event.target.dataset.registrationTask;if(id)select(id,Number(event.target.value));});root.addEventListener('submit',event=>{if(event.target.matches('[data-registration-form]')){event.preventDefault();void save();}});root.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.hasAttribute('data-registration-load'))void load();if(button.hasAttribute('data-registration-find'))void find();if(button.hasAttribute('data-registration-next'))void find(true);});},
    dispose(){disposed=true;version++;draft=null;page=null;names.clear();}};
}
