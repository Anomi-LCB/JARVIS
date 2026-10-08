import {snapshotGooglePageJob} from './google-page-contract.js';
import {readGoogleCollectionPage} from './google-collection-page.js';

export class GoogleReadClient {
  constructor({credentials,fetchImpl=fetch,clock=()=>Date.now(),signal=null}){this.credentials=credentials;this.fetch=fetchImpl;this.clock=clock;this.signal=signal;this.token=null;this.expires=0;this.refreshing=null;}
  requestSignal(){return this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);}
  configured(){return ['clientId','clientSecret','refreshToken'].every(k=>typeof this.credentials?.[k]==='string'&&this.credentials[k].trim());}
  async accessToken(){
    if(!this.configured())throw new Error('A_GOOGLE_CONNECTION_REQUIRED');
    if(this.token&&this.expires>this.clock()+60000)return this.token;
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      let response;try{this.signal?.throwIfAborted();response=await this.fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:this.requestSignal(),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:this.credentials.clientId,client_secret:this.credentials.clientSecret,refresh_token:this.credentials.refreshToken})});}catch{throw new Error('A_GOOGLE_TOKEN_NETWORK');}
      if(!response.ok)throw new Error(response.status===400?'A_GOOGLE_REAUTH_REQUIRED':`A_GOOGLE_TOKEN_HTTP_${response.status}`);
      let body;try{body=await response.json();}catch{throw new Error('A_GOOGLE_TOKEN_INVALID');}
      if(typeof body.access_token!=='string'||!body.access_token||!Number.isFinite(body.expires_in)||body.expires_in<=0)throw new Error('A_GOOGLE_TOKEN_INVALID');
      this.token=body.access_token;this.expires=this.clock()+body.expires_in*1000;return this.token;
    })().finally(()=>{this.refreshing=null;});return this.refreshing;
  }
  async get(url,retry=true){return this.#request(url,retry);}
  async collectionPage(job,{authorize}={}){
    return readGoogleCollectionPage(job,{authorize,read:(url,check)=>this.#request(url,true,check)});
  }
  async #request(url,retry=true,check=null){
    const target=new URL(url);
    if(target.protocol!=='https:'||target.username||target.password||!((target.origin==='https://gmail.googleapis.com'&&(/^\/gmail\/v1\/users\/me\/(profile|messages(?:\/[^/]+)?)$/.test(target.pathname)||check&&target.pathname==='/gmail/v1/users/me/history'))||(target.origin==='https://www.googleapis.com'&&target.pathname==='/calendar/v3/calendars/primary/events')))throw new Error('A_GOOGLE_ENDPOINT_DENIED');
    check?.();const token=await this.accessToken();check?.();let response;
    try{this.signal?.throwIfAborted();response=await this.fetch(target,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:this.requestSignal()});}catch{throw new Error('A_GOOGLE_API_NETWORK');}
    check?.();if(response.status===401&&retry){this.token=null;return this.#request(url,false,check);}
    if(!response.ok)throw new Error(`A_GOOGLE_API_HTTP_${response.status}`);
    try{return await response.json();}catch{throw new Error('A_GOOGLE_RESPONSE_INVALID');}
  }
  async account(){const profile=await this.get('https://gmail.googleapis.com/gmail/v1/users/me/profile');if(typeof profile.emailAddress!=='string'||!profile.emailAddress.includes('@'))throw new Error('A_GOOGLE_ACCOUNT_INVALID');return profile.emailAddress;}
  async page(job){
    job=snapshotGooglePageJob(job);
    const assertAccount=async()=>{if(job.account!==undefined&&await this.account()!==job.account)throw new Error('A_GOOGLE_ACCOUNT_MISMATCH');};
    if(job.account!==undefined){
      if(typeof job.account!=='string'||job.account.length>320||!/^[^\s@]+@[^\s@]+$/u.test(job.account))throw new Error('A_GOOGLE_ACCOUNT_INVALID');
    }
    await assertAccount();
    const result=await this.#pageMetadata(job);
    await assertAccount();return result;
  }
  async #pageMetadata(job){
    if(job.provider==='gmail'){
      const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('maxResults','25');url.searchParams.set('q',`after:${Math.floor(Date.parse(job.timeMin)/1000)} before:${Math.floor(Date.parse(job.timeMax)/1000)} -in:spam -in:trash`);
      if(job.cursor)url.searchParams.set('pageToken',job.cursor);
      const result=await this.get(url);if(result.messages!==undefined&&!Array.isArray(result.messages))throw new Error('A_GOOGLE_PAGE_INVALID');
      const items=[];const rows=result.messages??[];
      for(let start=0;start<rows.length;start+=4){items.push(...await Promise.all(rows.slice(start,start+4).map(async row=>{
        if(typeof row.id!=='string')throw new Error('A_GOOGLE_MESSAGE_INVALID');
        const detail=new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}`);detail.searchParams.set('format','metadata');detail.searchParams.set('metadataHeaders','Subject');detail.searchParams.set('fields','id,payload/headers');
        try{const message=await this.get(detail);return {id:row.id,title:message.payload?.headers?.find(h=>h.name?.toLowerCase()==='subject')?.value||'(제목 없음)'};}
        catch(error){if(error.message==='A_GOOGLE_API_HTTP_404')return {id:row.id,title:'(삭제된 메일)',withdrawn:true};throw error;}
      })));}
      return {items,nextCursor:result.nextPageToken??null};
    }
    if(job.provider!=='google-calendar')throw new Error('A_GOOGLE_PROVIDER_INVALID');
    const url=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    for(const [key,value] of Object.entries({maxResults:'100',timeMin:job.timeMin,timeMax:job.timeMax,singleEvents:'true',showDeleted:'true',fields:'nextPageToken,items(id,summary,start,status,attendees(self,responseStatus))'}))url.searchParams.set(key,value);
    if(job.cursor)url.searchParams.set('pageToken',job.cursor);
    const result=await this.get(url);if(result.items!==undefined&&!Array.isArray(result.items))throw new Error('A_GOOGLE_PAGE_INVALID');
    return {nextCursor:result.nextPageToken??null,items:(result.items??[]).map(row=>({id:row.id,title:row.summary||'(제목 없음)',start:row.start?.dateTime??row.start?.date??null,withdrawn:row.status==='cancelled'||row.attendees?.some(a=>a.self&&a.responseStatus==='declined')||false}))};
  }
}

export function googleCredentialsFromEnv(env){return {clientId:env.JARVIS_GOOGLE_CLIENT_ID,clientSecret:env.JARVIS_GOOGLE_CLIENT_SECRET,refreshToken:env.JARVIS_GOOGLE_REFRESH_TOKEN};}
