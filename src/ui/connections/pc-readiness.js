const actions=Object.freeze({
  PC_OBSERVATION_REQUIRED:'PC 연결과 업무 등록을 확인하고 다시 조회하세요.',PC_OBSERVATION_INVALID:'응답을 확인할 수 없습니다. 현재 상태를 다시 조회하세요.',
  PC_IDENTITY_CHANGED:'장치 연결이 바뀌었습니다. 같은 PC를 다시 선택하세요.',CORE_READ_SCOPE_MISSING:'이 PC의 기간·조회 범위에서 해당 업무를 선택하세요.',
  CORE_ARTIFACT_SCOPE_MISSING:'이 PC의 기간·조회 범위에서 해당 업무의 파일 검증을 허용하세요.',CORE_COMMAND_SCOPE_MISSING:'이 PC의 실행 범위에서 해당 업무와 허용 기간을 저장하세요.',
  B_PC_COMMAND_LOCAL_CATALOG_MISSING:'해당 PC 프로그램의 업무 등록 화면에서 명령 후보로 등록하세요.',B_PC_COMMAND_LOCAL_PERMISSION_MISSING:'해당 PC 프로그램의 실행 허용 화면에서 업무와 종료 시각을 저장하세요.',
  B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED:'해당 PC 프로그램의 실행 허용 기간이 끝났습니다. 업무와 새 종료 시각을 확인하세요.'
});
export function createPcReadiness({request,changed,escape,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
  let scope=null,selected='',version=0,pending=null,timer=null,expiry=null,state='idle',result=null;
  const clear=()=>{if(timer!==null)clearTimer(timer);if(expiry!==null)clearTimer(expiry);timer=expiry=null;};
  const current=item=>pending===item&&scope&&item.version===version;
  function reset(next=null){clear();version++;scope=next;selected=next?.taskIds?.[0]??'';pending=result=null;state='idle';}
  function valid(value,item){
    const readiness=value?.configurationReadiness;
    return value?.requestId===item.id&&value.deviceId===scope.deviceId&&value.deviceGeneration===scope.generation&&value.authorityToken===scope.authorityToken
      &&value.state==='observed'&&value.observationCurrent===true&&value.executionAuthority===false&&value.verifiedCompletion===false&&clock()<Date.parse(value.observationCurrentUntil)
      &&readiness?.deviceId===scope.deviceId&&readiness.taskId===item.taskId&&readiness.observedConfigurationOnly===true&&readiness.executionAuthority===false&&readiness.verifiedCompletion===false
      &&['configuration-matched','not-matched'].includes(readiness.status)&&Array.isArray(readiness.issues)&&readiness.issues.length<=9
      &&readiness.issues.every(issue=>Object.hasOwn(actions,issue?.code))&&(readiness.status==='configuration-matched'?readiness.issues.length===0:readiness.issues.length>0);
  }
  async function poll(item,left=20){
    if(!current(item))return;if(timer!==null)clearTimer(timer);timer=null;
    try{
      const value=await request(`/pc-nodes/observations/${encodeURIComponent(item.id)}`);if(!current(item))return;
      if(['queued','leased'].includes(value?.state)){state=left?'waiting':'waiting-retry';if(left)timer=setTimer(()=>void poll(item,left-1),500);}
      else{pending=null;if(!valid(value,item)){state='unavailable';result=null;changed();return;}
        result=structuredClone(value);state='observed';expiry=setTimer(()=>{if(item.version!==version||!scope)return;expiry=null;state='stale';result=null;changed();},Math.max(1,Date.parse(value.observationCurrentUntil)-clock()+1));}
      changed();
    }catch{if(current(item)){state='waiting-retry';changed();}}
  }
  async function queue(item){
    await request(`/pc-nodes/${encodeURIComponent(scope.deviceId)}/observations`,{method:'POST',body:{requestId:item.id,operation:'task-readiness',taskId:item.taskId}});
    if(current(item)){item.queued=true;void poll(item);}
  }
  async function load(){
    if(!scope||!scope.taskIds.includes(selected))return;
    if(pending){if(state!=='waiting-retry')return;const item=pending;try{if(item.queued)void poll(item);else await queue(item);}catch{if(current(item)){state='waiting-retry';changed();}}return;}
    clear();result=null;const item={id:`readiness-${crypto.randomUUID()}`,taskId:selected,version};pending=item;state='waiting';changed();
    try{await queue(item);}catch{if(current(item)){state='waiting-retry';changed();}}
  }
  function select(id){if(!scope?.taskIds.includes(id)||id===selected)return;const savedScope=scope;reset(savedScope);selected=id;changed();}
  function render({disabled=false,labels=new Map()}={}){
    const stale=result&&clock()>=Date.parse(result.observationCurrentUntil),visible=stale?null:result;
    const message=({idle:'업무를 선택해 같은 PC의 설정을 확인하세요.',waiting:'인증된 PC의 응답을 기다리고 있습니다.','waiting-retry':'응답을 아직 확인하지 못했습니다. 다시 확인하면 기존 조회를 이어갑니다.',observed:visible?.configurationReadiness.status==='configuration-matched'?'최근 확인한 등록·허용 설정이 일치합니다. 실제 실행과 완료는 별도로 검증합니다.':'설정이 일치하지 않습니다. 아래 조치를 확인하세요.',stale:'관측 유효기간이 끝났습니다. 같은 PC를 다시 조회하세요.',unavailable:'현재 준비 상태를 확인하지 못했습니다. 장치 연결과 PC 업무 등록 구성을 확인하세요.'})[stale?'stale':state];
    return `<section class="pc-readiness"><h3>업무 실행 전 설정 확인</h3><p>선택한 PC의 설정을 인증된 연결로 조회합니다. 조회로 권한이 늘어나거나 업무가 실행되지는 않습니다.</p><label>확인할 업무<select data-pc-readiness-task ${disabled||state==='waiting'?'disabled':''}>${(scope?.taskIds??[]).map(id=>`<option value="${escape(id)}" ${id===selected?'selected':''}>${escape(labels.get(id)?.title??`업무 이름 확인 필요 · ${id}`)}</option>`).join('')}</select></label><p role="status">${escape(message)}</p>${visible?`<ul>${visible.configurationReadiness.issues.map(issue=>`<li>${escape(actions[issue.code])}</li>`).join('')}</ul><p>관측 종료: ${escape(new Date(visible.observationCurrentUntil).toLocaleString())}</p>`:''}<button type="button" data-pc-readiness ${disabled||!selected||state==='waiting'?'disabled':''}>${state==='waiting-retry'?'기존 준비 상태 조회 이어가기':'선택 업무 준비 상태 조회'}</button><p>관측 후 설정이 바뀔 수 있습니다. 실제 실행 직전 검사는 계속 적용됩니다.</p></section>`;
  }
  return {reset,load,select,render,dispose:()=>reset(),invalidateAuthority(active,token){if(scope&&(!active||scope.authorityToken!==token))reset();}};
}
