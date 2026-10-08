import {prepareOwnerCommand,currentOwnerSession} from '../owner-command-session.js';
export const microsoftObjective='선택한 Microsoft 연결의 메타데이터를 한 페이지 수집해.';
export const microsoftPagesObjective='선택한 Microsoft 연결의 메타데이터를 전체 페이지 수집해.';
const storageKey='jarvis.microsoft.mission.pending.v1';
const id=s=>typeof s==='string'&&s.length>0&&s.length<=256&&!/[\u0000-\u001f]/u.test(s);
const canonical=r=>JSON.stringify(Object.entries(r).sort());
const valid=(r,pages=false)=>r&&['outlook','teams-chat'].includes(r.provider)&&id(r.connectionId)
 &&Object.keys(r).sort().join(',')===(r.provider==='outlook'?(pages?'connectionId,maxPages,provider':'connectionId,provider'):(pages?'chatId,connectionId,maxPages,provider':'chatId,connectionId,provider'))
 &&(r.provider!=='teams-chat'||id(r.chatId))&&(!pages||Number.isSafeInteger(r.maxPages)&&r.maxPages>=1&&r.maxPages<=50);
const job=selection=>{const {maxPages,...request}=selection;return request;};
const objectiveFor=j=>j.version===2?j.objective:microsoftObjective;
const bound=(m,j)=>m?.objective===objectiveFor(j)&&valid(m.microsoftCollection?.request)
 &&canonical(m.microsoftCollection.request)===canonical(job(j.selection))
 &&(j.version!==2||m.microsoftCollection.version==='microsoft-collection-pages-goal-v1'&&m.microsoftCollection.maxPages===j.selection.maxPages)
 &&id(m.missionId)&&(!j.missionId||m.missionId===j.missionId);
export function createMicrosoftMissionClient({request,storage,uuid=()=>crypto.randomUUID()}={}){
 let journal=null,invalid=false,busy=false,stopRequested=false;
 try{const raw=storage?.getItem(storageKey);if(raw){if(raw.length>3000)throw Error();journal=JSON.parse(raw);
  if(![1,2].includes(journal.version)||Object.keys(journal).sort().join(',')!==(journal.version===2?'key,missionId,objective,selection,version':'key,missionId,selection,version')||journal.version===2&&journal.objective!==microsoftPagesObjective||!/^ms_mission_[a-zA-Z0-9-]{1,100}$/u.test(journal.key)||!valid(journal.selection,journal.version===2)||journal.missionId!==null&&!id(journal.missionId))throw Error();}}
 catch{invalid=true;}
 const persist=()=>{if(!storage)throw Error('MS_JOURNAL_UNAVAILABLE');try{if(journal)storage.setItem(storageKey,JSON.stringify(journal));else storage.removeItem(storageKey);}catch{throw Error('MS_JOURNAL_UNAVAILABLE');}};
 const check=m=>{if(!bound(m,journal))throw Error('MS_BINDING_CHANGED');return m;};
 const guard=async fn=>{if(busy)throw Error('MS_BUSY');busy=true;try{if(invalid)throw Error('MS_JOURNAL_INVALID');return await fn();}finally{busy=false;}};
 const checkProgress=async selection=>{
  const progress=await request('/personal-inbox/microsoft/progress',{method:'POST',body:job(selection)});
  if(progress?.version!=='personal-source-cursor-v1'||progress.provider!==selection.provider||typeof progress.present!=='boolean'||progress.paginationComplete!==null
    ||progress.nextCursor!==null&&(typeof progress.nextCursor!=='string'||!progress.nextCursor.length))throw Error('MS_PROGRESS_UNAVAILABLE');
  if(progress.nextCursor!==null)throw Error('MS_PRIOR_COLLECTION_PENDING');
 };
 const owner=async()=>{const {session}=await prepareOwnerCommand({enabled:true,locked:false,readStatus:()=>request('/owner-session'),activate:()=>request('/owner-session/activate',{method:'POST',body:{durationMinutes:30,grants:['read_only']}})});if(!session?.grants.includes('read_only'))throw Error('MS_OWNER_REQUIRED');return session;};
 const finish=async(m,{renewRead=false}={})=>{check(m);let result={status:'unverified'};
  if(m.status==='COMPLETED'){
   const session=renewRead?await owner():currentOwnerSession(await request('/owner-session'));
   if(session?.grants.includes('read_only'))result=await request(`/missions/${encodeURIComponent(m.missionId)}/verified-microsoft-collection`,{method:'POST',body:{ownerSessionId:session.sessionId}});
   if(result.status==='verified'){
    const pages=journal.version===2;
    if(!result.success||canonical(result.result?.request??{})!==canonical(job(journal.selection))||result.allPages!==pages)throw Error('MS_RESULT_UNBOUND');
    if(pages){const receipts=result.result?.pages,limit=m.microsoftCollectionPageLimit??journal.selection.maxPages;
     if(!Number.isSafeInteger(limit)||limit<journal.selection.maxPages||limit>50||limit!==journal.selection.maxPages&&result.result?.maxPages!==limit)throw Error('MS_RESULT_UNBOUND');
     if(result.result.version!=='microsoft-collection-pages-receipt-v1'||result.snapshotVerified!==false||result.result.snapshotVerified!==false||result.result.verification?.status!=='passed'
       ||!Array.isArray(receipts)||!receipts.length||receipts.length>(m.microsoftCollectionPageLimit??journal.selection.maxPages)||receipts.at(-1)?.page?.nextCursor!==null
       ||receipts.some(r=>!Array.isArray(r.page?.items)||(()=>{const {cursor,...base}=r.request??{};return canonical(base)!==canonical(job(journal.selection));})()))throw Error('MS_RESULT_UNBOUND');
    }else if(!Array.isArray(result.result?.page?.items))throw Error('MS_RESULT_UNBOUND');
   }
  }
  return {mission:m,result};
 };
 const locate=async()=>{if(!journal)throw Error('MS_NO_PENDING');if(journal.missionId)return check(await request(`/missions/${encodeURIComponent(journal.missionId)}`));
  const found=await request(`/missions?requestId=${encodeURIComponent(journal.key)}`);if(found.items?.length!==1)throw Error('MS_RESULT_UNKNOWN');const m=check(found.items[0]);journal.missionId=m.missionId;persist();return m;
 };
 const run=async()=>finish(await request(`/missions/${encodeURIComponent(journal.missionId)}/run`,{method:'POST',body:{},timeout:180000}));
 return {pending:()=>journal!==null||invalid,selection:()=>journal?structuredClone(journal.selection):null,objective:()=>journal?objectiveFor(journal):null,
  submit:(selection,objective=microsoftObjective)=>guard(async()=>{
   if(journal)throw Error('MS_RESULT_UNKNOWN');stopRequested=false;const pages=typeof objective==='string'&&objective.trim()===microsoftPagesObjective;
   if(typeof objective!=='string'||![microsoftObjective,microsoftPagesObjective].includes(objective.trim())||!valid(selection,pages))throw Error('MS_OBJECTIVE_UNSUPPORTED');
   selection=structuredClone(selection);objective=pages?microsoftPagesObjective:microsoftObjective;
   const context=await request('/personal-inbox/microsoft/selections');if(context.version!=='microsoft-collection-selections-v1'||context.missionConfigured!==true||!context.items?.some(i=>i.provider===selection.provider&&i.connectionId===selection.connectionId&&i.ready===true))throw Error('MS_SELECTION_NOT_READY');
   if(pages)await checkProgress(selection);
   if(stopRequested)return {cancelledBeforeCreation:true,mission:null};
   const session=await owner();if(stopRequested)return {cancelledBeforeCreation:true,mission:null};journal={version:pages?2:1,key:`ms_mission_${uuid()}`,missionId:null,selection,...(pages?{objective}:{})};persist();
   const m=check(await request('/missions',{method:'POST',body:{objective,microsoftCollection:selection,idempotencyKey:journal.key,...(pages?{budgets:{maxWaves:selection.maxPages,maxActions:selection.maxPages}}:{}),authorization:{mode:'trusted_session',ownerSessionId:session.sessionId,grants:pages&&session.grants.includes('high_impact')?['read_only','high_impact']:['read_only']},metadata:{longTermMemory:false,submittedBy:'jarvis-microsoft-page'}}}));journal.missionId=m.missionId;persist();if(stopRequested)return finish(await request(`/missions/${encodeURIComponent(m.missionId)}/cancel`,{method:'POST',body:{reason:'Microsoft 자료 화면에서 중단'}}));return run();
  }),
  reconcile:()=>guard(async()=>finish(await locate(),{renewRead:true})),
  continuePaused:()=>guard(async()=>{const m=await locate();if(m.status!=='PAUSED'||!['run-wave-limit-reached','microsoft-collection-limit-extended'].includes(m.stopReason))throw Error('MS_CONTINUATION_UNSAFE');return run();}),
  extendLimit:maxPages=>guard(async()=>{
   const m=await locate(),expectedMaxPages=m.microsoftCollectionPageLimit??m.microsoftCollection?.maxPages;
   if(journal.version!==2||m.status!=='PAUSED'||m.stopReason!=='microsoft-collection-page-limit'
     ||!Number.isSafeInteger(maxPages)||maxPages<=expectedMaxPages||maxPages>50)throw Error('MS_CONTINUATION_UNSAFE');
   const session=currentOwnerSession(await request('/owner-session'));
   if(!session?.grants.includes('read_only')||!session.grants.includes('high_impact'))throw Error('MS_OWNER_REQUIRED');
   const extensionId=journal.key.replace('ms_mission_','ms_limit_')+'-'+expectedMaxPages+'-'+maxPages;
   check(await request(`/missions/${encodeURIComponent(m.missionId)}/extend-microsoft-collection`,{method:'POST',body:{extensionId,ownerSessionId:session.sessionId,expectedMaxPages,maxPages}}));
   return run();
  }),
  continueCreated:()=>guard(async()=>{const m=await locate();if(m.status!=='CREATED'||m.waves?.some(w=>w.actions?.length))throw Error('MS_NOT_UNSTARTED');return run();}),
  approve:()=>guard(async()=>{const m=await locate();if(m.status!=='WAITING_APPROVAL'||m.pendingGates?.length!==1||m.pendingGates[0].type==='clarification')throw Error('MS_GATE_CHANGED');
   await request(`/missions/${encodeURIComponent(m.missionId)}/gates/${encodeURIComponent(m.pendingGates[0].gateId)}/decision`,{method:'POST',body:{decision:'approve',decidedBy:'microsoft-page-owner',resume:false}});return run();}),
  cancel:async()=>{stopRequested=true;if(invalid)throw Error('MS_JOURNAL_INVALID');if(!journal&&busy)return {cancelledBeforeCreation:true,mission:null};const m=await locate();const stopped=await request(`/missions/${encodeURIComponent(m.missionId)}/cancel`,{method:'POST',body:{reason:'Microsoft 자료 화면에서 중단'}});return finish(stopped);},
  reset:()=>guard(async()=>{const m=await locate();if(!['COMPLETED','CANCELLED','FAILED','BLOCKED'].includes(m.status))throw Error('MS_RESULT_UNKNOWN');if(journal.version===2)await checkProgress(journal.selection);const old=journal;journal=null;try{persist();}catch(e){journal=old;throw e;}})
 };
}
