const fail=()=>{throw Error('A_GOOGLE_COLLECTION_PAGE_INVALID');};
const token=value=>{if(typeof value!=='string'||!value||value.length>2000||/[\u0000-\u0020\u007f]/u.test(value))fail();return value;};
const history=value=>{if(typeof value!=='string'||!/^\d{1,100}$/u.test(value))fail();return value;};
export function snapshotGoogleCollectionPage(value){
 const keys=['provider','account','mode','syncToken','cursor','initialToken'];
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)fail();
 for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))fail();}
 const job=Object.freeze(Object.fromEntries(keys.map(k=>[k,value[k]])));
 if(!['gmail','google-calendar'].includes(job.provider)||!['initial','incremental'].includes(job.mode)
  ||typeof job.account!=='string'||job.account.length>200||!/^[^\s@]+@[^\s@]+$/u.test(job.account))fail();
 if(job.cursor!==null)token(job.cursor);
 if(job.mode==='initial'){
  if(job.syncToken!==null)fail();
  if(job.provider==='google-calendar'){if(job.initialToken!==null)fail();}
  else{if(job.initialToken!==null)history(job.initialToken);if(job.cursor!==null&&job.initialToken===null)fail();}
 }else{
  if(job.initialToken!==null)fail();(job.provider==='gmail'?history:token)(job.syncToken);
 }
 return job;
}
function id(value){if(typeof value!=='string'||!value||value.length>500||/[\u0000-\u001f\u007f]/u.test(value))fail();return value;}
function cursor(value){if(value===undefined)return null;return token(value);}
function title(value){if(value===undefined||value===null||value==='')return '(제목 없음)';if(typeof value!=='string'||value.length>2000||/[\u0000-\u001f]/u.test(value))fail();return value;}
/** Fixed metadata queries. No supplied URL, date filter, body fetch or external write. */
export async function readGoogleCollectionPage(raw,{read,authorize}){
 const job=snapshotGoogleCollectionPage(raw);
 if(typeof read!=='function'||typeof authorize!=='function')throw Error('A_GOOGLE_COLLECTION_AUTHORIZATION_REQUIRED');
 const check=()=>{if(authorize()!==true)throw Error('A_GOOGLE_COLLECTION_SCOPE_DENIED');};
 const get=async url=>{check();const result=await read(url,check);check();return result;};
 const profile=async()=>{const result=await get('https://gmail.googleapis.com/gmail/v1/users/me/profile');if(result.emailAddress!==job.account)throw Error('A_GOOGLE_ACCOUNT_MISMATCH');return result;};
 await profile();let output;
 if(job.provider==='google-calendar'){
  const url=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  for(const [key,value] of Object.entries({maxResults:'100',showDeleted:'true',singleEvents:'false',fields:'nextPageToken,nextSyncToken,items(id,summary,start,status,attendees(self,responseStatus))'}))url.searchParams.set(key,value);
  if(job.mode==='incremental')url.searchParams.set('syncToken',job.syncToken);
  if(job.cursor!==null)url.searchParams.set('pageToken',job.cursor);
  let result;try{result=await get(url);}catch(error){if(error.message==='A_GOOGLE_API_HTTP_410')throw Error('A_GOOGLE_COLLECTION_RESET_REQUIRED');throw error;}
  if(!result||typeof result!=='object'||(result.items!==undefined&&!Array.isArray(result.items))||(result.items??[]).length>100)fail();
  const nextCursor=cursor(result.nextPageToken);
  if(nextCursor!==null&&result.nextSyncToken!==undefined)fail();
  const nextSyncToken=nextCursor===null?token(result.nextSyncToken):null;
  const items=(result.items??[]).map(row=>{
   if(!row||typeof row!=='object'||row.status!==undefined&&!['confirmed','tentative','cancelled'].includes(row.status))fail();
   if(row.attendees!==undefined&&(!Array.isArray(row.attendees)||row.attendees.some(a=>!a||typeof a!=='object')))fail();
   const start=row.start?.dateTime??row.start?.date??null;if(start!==null&&(typeof start!=='string'||start.length>100))fail();
   return {id:id(row.id),title:title(row.summary),start,withdrawn:row.status==='cancelled'||row.attendees?.some(a=>a.self===true&&a.responseStatus==='declined')||false};
  });
  output={items,nextCursor,nextSyncToken,initialToken:null};
 }else{
  let initialToken=null,url,ids;
  if(job.mode==='initial'){
   initialToken=job.initialToken??history((await profile()).historyId);
   url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('maxResults','25');url.searchParams.set('includeSpamTrash','true');url.searchParams.set('fields','nextPageToken,messages/id');
  }else{
   url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');url.searchParams.set('maxResults','25');url.searchParams.set('startHistoryId',job.syncToken);
  }
  if(job.cursor!==null)url.searchParams.set('pageToken',job.cursor);
  let result;try{result=await get(url);}catch(error){if(error.message==='A_GOOGLE_API_HTTP_404'&&job.mode==='incremental')throw Error('A_GOOGLE_COLLECTION_RESET_REQUIRED');throw error;}
  if(!result||typeof result!=='object')fail();const nextCursor=cursor(result.nextPageToken);
  if(job.mode==='initial'){
   if(result.messages!==undefined&&!Array.isArray(result.messages)||(result.messages??[]).length>25)fail();ids=(result.messages??[]).map(row=>id(row?.id));
  }else{
   if(result.history!==undefined&&!Array.isArray(result.history)||(result.history??[]).length>25)fail();
   ids=[];
   for(const row of result.history??[]){
    if(!row||typeof row!=='object')fail();history(row.id);
    for(const kind of ['messagesAdded','messagesDeleted','labelsAdded','labelsRemoved']){
     if(row[kind]!==undefined&&!Array.isArray(row[kind]))fail();
     for(const entry of row[kind]??[])ids.push(id(entry?.message?.id));
    }
   }
   history(result.historyId);
   if(BigInt(result.historyId)<BigInt(job.syncToken)||(result.history??[]).some(row=>BigInt(row.id)<=BigInt(job.syncToken)||BigInt(row.id)>BigInt(result.historyId)))fail();
  }
  ids=[...new Set(ids)];if(ids.length>500)fail();const items=[];
  for(let start=0;start<ids.length;start+=4)items.push(...await Promise.all(ids.slice(start,start+4).map(async messageId=>{
   const detail=new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);detail.searchParams.set('format','metadata');detail.searchParams.set('metadataHeaders','Subject');detail.searchParams.set('fields','id,payload/headers');
   let message;try{message=await get(detail);}catch(error){if(error.message==='A_GOOGLE_API_HTTP_404')return {id:messageId,title:'(삭제된 메일)',withdrawn:true};throw error;}
   if(message?.id!==messageId||message.payload?.headers!==undefined&&!Array.isArray(message.payload.headers))fail();
   return {id:messageId,title:title(message.payload?.headers?.find(h=>h?.name?.toLowerCase()==='subject')?.value)};
  })));
  output={items,nextCursor,nextSyncToken:nextCursor===null?(job.mode==='initial'?initialToken:history(result.historyId)):null,initialToken:nextCursor!==null?initialToken:null};
 }
 if(output.nextCursor!==null&&output.nextCursor===job.cursor)fail();
 if(new Set(output.items.map(x=>x.id)).size!==output.items.length)fail();
 await profile();check();return output;
}
