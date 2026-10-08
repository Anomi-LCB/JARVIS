const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses={current:'조회 당시 연결 조건 유지',historical:'완료된 작업의 과거 기록',unknown:'확인하지 못한 조건 있음','requires-review':'변경된 조건 확인 필요'};
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const date=value=>validDate(value)?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'기록 없음';
const key=(mission,endpoint)=>JSON.stringify([endpoint,mission?.missionId,mission?.goalContract?.revision]);
export function createMissionDependencyPanel({request,endpoint=()=>'',accessContext=()=>'',changed=()=>{}}){
 const states=new Map();let lastAccessContext=accessContext();
 const stateKey=mission=>{const current=accessContext();if(current!==lastAccessContext){states.clear();lastAccessContext=current;}return key(mission,endpoint());};
 return {
  async inspect(mission){
   if(typeof mission?.missionId!=='string'||!mission.missionId)return;
   const id=stateKey(mission);if(states.get(id)?.busy)return;
   const state={busy:true};states.set(id,state);changed();
   try{
    const result=await request(`/missions/${encodeURIComponent(mission.missionId)}/dependency-impact`,{method:'GET',timeoutMs:10000});
    if(result?.impactVersion!=='a-mission-dependency-impact-v1'||result.missionId!==mission.missionId
     ||result.executionAuthority!==false||!Object.hasOwn(statuses,result.status)||!validDate(result.observedAt)
     ||!Array.isArray(result.affectedActionIds)||!Array.isArray(result.unknownActionIds))throw new Error('invalid-observation');
    state.result=result;
   }catch{state.error='조건을 조회하지 못했습니다. 연결과 접근 권한을 확인한 뒤 다시 조회하세요.';}
   finally{state.busy=false;changed();}
  },
  render(mission){
   if(!mission?.missionId)return '';
   const state=states.get(stateKey(mission))??{},r=state.result,d=r?.deadline;
   return `<section class="mission-outcome" data-mission-dependencies aria-label="작업 연결 조건 확인">
    <h4>작업 연결 조건</h4><p>연결된 기한·권한·기기·예산의 변경을 조회합니다.</p>
    <button type="button" data-mission-dependencies-inspect="${escape(mission.missionId)}" ${state.busy?'disabled':''}>${state.busy?'조건 확인 중…':'현재 조건 확인'}</button>
    <div role="status" aria-live="polite">${state.error?`<p>${escape(state.error)}</p>`:''}</div>
    ${r?`<p><strong>${statuses[r.status]}</strong></p><p>확인 시각: ${escape(date(r.observedAt))}</p>
     ${d?`<dl><div><dt>작업에 연결된 원래 기한</dt><dd>${escape(date(d.previousDueAt))}</dd></div><div><dt>현재 약속 기한</dt><dd>${escape(date(d.currentDueAt))}</dd></div></dl>
      `:''}
     ${r.actions?.length===0?'<p>아직 실행 단계가 계획되지 않았습니다.</p>':`<p>영향받는 단계 ${r.affectedActionIds.length}개 · 조건 미확인 단계 ${r.unknownActionIds.length}개</p>`}
     ${r.nextAction?`<p>${escape(r.nextAction)}</p>`:''}
     <p>조회 시점의 정보입니다. 작업을 실행하거나 권한을 부여하지 않습니다.</p>`:''}
   </section>`;
  }
 };
}
