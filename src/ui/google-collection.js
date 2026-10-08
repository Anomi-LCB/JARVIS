const names={gmail:'메일','google-calendar':'일정'};
const labels={'not-configured':'별도 수집 허용이 필요합니다.',blocked:'계정·권한·허용 기한을 확인하세요.','not-started':'범위 저장됨 · 아직 수집하지 않았습니다.',partial:'일부 페이지 저장됨 · 다음 페이지를 이어갈 수 있습니다.',complete:'마지막 페이지 저장됨 · 다음 실행에서 변경 사항을 확인합니다.','reset-required':'변경 이력이 만료됐습니다. 기존 자료를 보관하고 전체 재수집을 준비하세요.','renewal-required':'위임 갱신됨 · 기존 수집 기록을 새 위임으로 이어주세요.','checkpoint-unavailable':'수집 기록 검증 실패 · 자동 수집을 보류합니다.'};
export function createGoogleCollection({request,changed,refresh,escape,id=()=>crypto.randomUUID(),now=()=>new Date()}){
 let data={},busy=false,message='';const drafts=new Map(),enabled=()=>data.adapterAvailable===true&&data.connectionBinding&&!data.paused;
 const update=next=>{data=next??{};};
 function render(){
  if(data.adapterAvailable!==true)return '<section data-google-change-collection><h2>변경 사항 이어서 수집</h2><p>이 실행 환경의 변경 이력 수집 경로를 확인하지 못했습니다. 기존 기간별 수집은 위에서 관리할 수 있습니다.</p></section>';
  return `<section data-google-change-collection><h2>변경 사항 이어서 수집</h2><p>기간별 조회와 별도로 허용합니다. 스팸·휴지통을 포함한 전체 메일의 제목·삭제 상태, 기본 캘린더의 제목·시각·취소 상태를 확인합니다. 본문·첨부 조회나 발송은 하지 않습니다.</p><p>처음에는 전체 목록을 페이지별로 읽고 이후 변경 사항을 확인합니다. 페이지 한도는 HTTP 호출 수나 요금 한도가 아닙니다.</p>${data.paused?'<p>수집이 중지됐거나 연결 확인이 필요합니다.</p>':''}<p role="status">${escape(message)}</p><div class="personal-inbox-grid">${['gmail','google-calendar'].map(provider=>{
   const current=data.providers?.find(x=>x.provider===provider)??{status:'not-configured'},draft=drafts.get(provider)??{maxPages:'100',expiresAt:''},name=names[provider],ready=['not-started','partial','complete'].includes(current.status);
   return `<article class="personal-inbox-item"><h3>${name} 변경 수집</h3><p>${escape(labels[current.status]??'상태 미확인')}</p>${current.lastObservedAt?`<p>마지막 저장: ${escape(new Date(current.lastObservedAt).toLocaleString())}</p>`:''}<form data-google-collection-grant="${provider}"><label>최대 페이지 · ${name}<input name="maxPages" data-collection-draft="${provider}" type="number" min="1" max="100000" step="1" required value="${escape(draft.maxPages)}"/></label><label>허용 종료 시각 · ${name}<input name="expiresAt" data-collection-draft="${provider}" type="datetime-local" required value="${escape(draft.expiresAt)}"/></label><button ${busy||!enabled()?'disabled':''}>${name} 변경 수집 ${current.mandateId?'허용 갱신':'허용'}</button></form>${current.reset?`<p>기존 수집 자료는 보관 이력으로 옮기고 현재 목록을 비웁니다. 등록한 할 일과 사용 기록은 유지합니다. 준비 후 수집 시작을 눌러주세요.</p><button type="button" data-google-collection-action="reset" data-provider="${provider}" ${busy||!enabled()?'disabled':''}>${name} 자료 보관 후 재수집 준비</button>`:''}${current.transfer?`<button type="button" data-google-collection-action="transfer" data-provider="${provider}" ${busy||!enabled()?'disabled':''}>${name} 기존 기록 이어주기</button>`:''}<button type="button" data-google-collection-action="collect" data-provider="${provider}" ${busy||!enabled()||!ready?'disabled':''}>${name} ${current.status==='partial'?'다음 페이지 수집':'변경 수집 시작'}</button>${current.mandateId?`<button type="button" data-google-collection-action="revoke" data-provider="${provider}" ${busy?'disabled':''}>${name} 변경 수집 허용 철회</button>`:''}</article>`;
  }).join('')}</div><p>완료 표시는 로컬 저장 확인입니다. 실제 계정의 장기 안정성 검증을 뜻하지 않습니다. 갱신·철회는 기존 자료와 사용 기록을 삭제하지 않습니다.</p></section>`;
 }
 async function perform(path,body,retry=false){
  if(busy)return;busy=true;message='처리 중입니다.';changed();
  try{let result;try{result=await request(path,{method:'POST',body});}catch(error){if(!retry||error?.payload?.error?.code)throw error;result=await request(path,{method:'POST',body});}
   if(path.endsWith('/collection-sync')&&!['partial','window-complete'].includes(result?.status))throw Error('unverified collection result');
   message=result.replayed?'이전 요청의 기록입니다. 현재 상태는 새로고침 결과를 확인하세요.':path.endsWith('/collection-sync')?(result.status==='partial'?'페이지를 저장했습니다. 다음 페이지를 이어서 수집하세요.':'마지막 페이지를 저장했습니다. 다음 실행에서 변경 사항을 확인합니다.'):path.endsWith('/revoke')?'변경 수집 허용을 철회했습니다. Google 자체 권한은 남아 있습니다.':path.endsWith('/collection-reset')?'기존 자료를 보관했습니다. 전체 재수집을 시작하세요.':path.endsWith('/collection-transfer')?'기존 자료와 수집 위치를 새 위임으로 이어주었습니다.':'수집 범위를 저장했습니다. 수집 시작은 별도로 실행하세요.';
  }catch{message='완료를 확인하지 못했습니다. 새로고침한 계정·기한·한도·수집 상태를 확인하세요. 기존 자료는 삭제하지 않았습니다.';}
  finally{busy=false;try{await refresh();}catch{data={};message='현재 상태를 확인하지 못했습니다. 연결을 다시 확인하세요.';}changed();}
 }
 function attach(root){
  root.addEventListener('input',e=>{const p=e.target.dataset?.collectionDraft;if(!names[p])return;const draft=drafts.get(p)??{maxPages:'100',expiresAt:''};draft[e.target.name]=e.target.value;drafts.set(p,draft);});
  root.addEventListener('submit',async e=>{const provider=e.target.dataset?.googleCollectionGrant;if(!names[provider])return;e.preventDefault();if(busy||!enabled())return;
   const form=new FormData(e.target),expires=new Date(form.get('expiresAt')),maxPages=Number(form.get('maxPages'));
   if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100000||!Number.isFinite(expires.getTime())||expires<=now()){message='종료 시각은 현재보다 뒤로, 페이지 수는 1~100,000 사이로 입력하세요.';changed();return;}
   const current=data.providers?.find(x=>x.provider===provider);await perform('/personal-google/collection-delegation',{requestId:id(),provider,scope:provider==='gmail'?'gmail-all-message-metadata-v1':'primary-calendar-event-metadata-v1',...data.connectionBinding,maxPages,validFrom:now().toISOString(),expiresAt:expires.toISOString(),replaceMandateId:current?.mandateId??null},true);
  });
  root.addEventListener('click',async e=>{const b=e.target.closest?.('[data-google-collection-action]');if(!b||busy)return;const {provider,googleCollectionAction:action}=b.dataset,current=data.providers?.find(x=>x.provider===provider);if(!names[provider]||!current)return;
   if(action==='revoke'&&current.mandateId)return perform('/personal-google/collection-delegation/revoke',{provider,expectedMandateId:current.mandateId});if(!enabled())return;
   if(action==='reset'&&current.reset)return perform('/personal-google/collection-reset',{requestId:id(),provider,...current.reset},true);
   if(action==='transfer'&&current.transfer)return perform('/personal-google/collection-transfer',{requestId:id(),provider,...current.transfer},true);
   if(action==='collect'&&['not-started','partial','complete'].includes(current.status))return perform('/personal-google/collection-sync',{provider});
  });
 }
 return {update,render,attach};
}
