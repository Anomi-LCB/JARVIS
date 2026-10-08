import { createHash,randomUUID } from 'node:crypto';
import {normalizeStrictIsoInstant} from '../../../shared/src/strict-iso-instant.js';
import {snapshotGooglePageJob} from './google-page-contract.js';

const reconnectAction='Google 계정 연결을 다시 승인한 뒤 동기화를 재개하세요.';
const pausedAction='수집을 재개하려면 Google 연결을 다시 확인하세요. Google 계정 권한 철회는 계정의 연결된 앱 설정에서 별도로 진행하세요.';

/** Bounded polling, not provider history/sync-token incremental synchronization. */
export class GoogleInboxSync {
  constructor({inbox,client,clock=()=>new Date(),intervalMs=300000,evidence=null}){
    this.evidence=evidence;this.inbox=inbox;this.client=client;this.clock=clock;this.intervalMs=intervalMs;this.pending=null;this.timer=null;this.reauthRequired=false;
    this.state={configured:client.configured(),running:false,status:client.configured()?'idle':'connection-required',mode:'bounded-poll',lastCheckedAt:null,providers:{}};
    inbox.store.db.exec('CREATE TABLE IF NOT EXISTS personal_google_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
    inbox.store.db.exec('CREATE TABLE IF NOT EXISTS personal_google_lock(id INTEGER PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)');
    inbox.store.db.exec('CREATE TABLE IF NOT EXISTS personal_google_sync_control(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)');
    inbox.store.db.exec('CREATE TABLE IF NOT EXISTS personal_google_sync_generation(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL)');
    inbox.store.db.exec('CREATE TABLE IF NOT EXISTS personal_google_window_recoveries(window_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
    inbox.store.db.prepare('INSERT OR IGNORE INTO personal_google_sync_generation VALUES(1,?)').run(randomUUID());
    this.owner=randomUUID();this.#refreshReauthPause();
  }
  status(){this.#refreshReauthPause();return JSON.parse(JSON.stringify({...this.state,evidence:this.evidence?.status()??[],recoveryOptions:this.#recoveryOptions()}));}
  #recoveryJob(job){
    if(!job||job.complete!==false||job.scope!==`direct:${job.provider}:v1`
      ||!job.account||!job.windowId||normalizeStrictIsoInstant(job.timeMin)===null||normalizeStrictIsoInstant(job.timeMax)===null
      ||![job.timeMin,job.timeMax].every(value=>value.endsWith('Z')))throw Error('A_GOOGLE_RECOVERY_NOT_REQUIRED');
    try{snapshotGooglePageJob(job);throw Error('A_GOOGLE_RECOVERY_NOT_REQUIRED');}
    catch(error){if(error.message!=='A_GOOGLE_PAGE_INVALID')throw error;}
    const replacement={...job,timeMin:new Date(Math.ceil(Date.parse(job.timeMin)/1000)*1000).toISOString(),timeMax:new Date(Math.floor(Date.parse(job.timeMax)/1000)*1000).toISOString()};
    snapshotGooglePageJob(replacement);return replacement;
  }
  #recoveryOptions(){
    if(this.reauthRequired||!this.client.configured())return [];
    const options=[];
    for(const row of this.inbox.store.db.prepare('SELECT body FROM personal_google_jobs').all())try{
      const job=JSON.parse(row.body),next=this.#recoveryJob(job);
      options.push({provider:job.provider,expectedWindowId:job.windowId,expectedGeneration:this.#generation(),timeMin:next.timeMin,timeMax:next.timeMax});
    }catch{}
    return options;
  }
  async restartWindow(input){
    const denied=()=>{throw Error('A_GOOGLE_RECOVERY_INPUT_INVALID');};
    if(!input||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)denied();
    const keys=['provider','expectedWindowId','expectedGeneration'];
    if(Reflect.ownKeys(input).length!==keys.length||Reflect.ownKeys(input).some(key=>!keys.includes(key)
      ||!Object.getOwnPropertyDescriptor(input,key)?.enumerable||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value')))denied();
    const request=Object.freeze(Object.fromEntries(keys.map(key=>[key,input[key]])));
    if(!['gmail','google-calendar'].includes(request.provider)||![request.expectedWindowId,request.expectedGeneration].every(value=>typeof value==='string'&&/^[a-zA-Z0-9._-]{1,128}$/u.test(value)))denied();
    const db=this.inbox.store.db,requestHash=createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const archived=db.prepare('SELECT body FROM personal_google_window_recoveries WHERE window_id=?').get(request.expectedWindowId);
    if(archived){
      const record=JSON.parse(archived.body);
      if(record.requestHash!==requestHash)throw Error('A_GOOGLE_RECOVERY_CONFLICT');
      const replacement=snapshotGooglePageJob(record.replacementJob);
      if(record.originalJob?.windowId!==request.expectedWindowId||replacement.provider!==request.provider
        ||record.originalJob?.account!==replacement.account||replacement.cursor!==null||replacement.complete!==false)
        throw Error('A_GOOGLE_RECOVERY_CONFLICT');
      // Reconstruct the historical acknowledgement from its closed job contract.
      // Stored receipt metadata cannot authorize collection or leak arbitrary fields.
      return {status:'record-restored',provider:replacement.provider,previousWindowId:request.expectedWindowId,
        windowId:replacement.windowId,timeMin:replacement.timeMin,timeMax:replacement.timeMax,observedAt:replacement.observedAt,
        sourceItemsPreserved:true,providerGrantChanged:false,collectionStarted:false,currentWindowVerified:false,
        proof:'atomic-local-recovery',executionAuthority:false,replayed:true};
    }
    const assertCurrent=()=>{
      this.#refreshReauthPause();
      if(this.reauthRequired||!this.client.configured())throw Error('A_GOOGLE_RECOVERY_PAUSED');
      if(this.pending||db.prepare('SELECT 1 FROM personal_google_lock WHERE id=1 AND expires>?').get(Date.now()))throw Error('A_GOOGLE_RECOVERY_BUSY');
      if(this.#generation()!==request.expectedGeneration)throw Error('A_GOOGLE_RECOVERY_CONFLICT');
    };
    assertCurrent();
    const account=await this.client.account();assertCurrent();
    const id=createHash('sha256').update(JSON.stringify([account,request.provider])).digest('hex');
    const stored=db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(id);
    if(!stored)throw Error('A_GOOGLE_RECOVERY_CONFLICT');
    const job=JSON.parse(stored.body);
    if(job.account!==account||job.provider!==request.provider||job.windowId!==request.expectedWindowId)throw Error('A_GOOGLE_RECOVERY_CONFLICT');
    const next=this.#recoveryJob(job),observedAt=this.clock().toISOString();
    if(Date.parse(observedAt)<=Date.parse(job.observedAt))throw Error('A_GOOGLE_RECOVERY_CLOCK_NOT_ADVANCED');
    const checkScope=()=>{const range=this.evidence?.window(request.provider,next)??next;if(range.timeMin!==next.timeMin||range.timeMax!==next.timeMax)throw Error('A_GOOGLE_READ_SCOPE_DENIED');};
    checkScope();next.windowId=randomUUID();next.observedAt=observedAt;next.cursor=null;next.complete=false;
    const stream=createHash('sha256').update(JSON.stringify([job.provider,job.account,job.scope])).digest('hex');
    db.exec('BEGIN IMMEDIATE');try{
      assertCurrent();checkScope();
      if(db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(id)?.body!==stored.body)throw Error('A_GOOGLE_RECOVERY_CONFLICT');
      const prior=db.prepare('SELECT cursor,last_hash,provider FROM personal_source_streams WHERE id=?').get(stream);
      if(prior?(prior.provider!==job.provider||prior.cursor!==(job.cursor??null)):job.cursor!=null)throw Error('A_GOOGLE_RECOVERY_SOURCE_CONFLICT');
      this.#rotateGeneration();const generation=this.#generation();
      const receipt={status:'record-restored',provider:job.provider,previousWindowId:job.windowId,windowId:next.windowId,timeMin:next.timeMin,timeMax:next.timeMax,observedAt,sourceItemsPreserved:true,providerGrantChanged:false,collectionStarted:false,currentWindowVerified:true,proof:'atomic-local-recovery',executionAuthority:false};
      db.prepare('INSERT INTO personal_google_window_recoveries VALUES(?,?)').run(job.windowId,JSON.stringify({requestHash,previousGeneration:request.expectedGeneration,replacementGeneration:generation,originalJob:job,originalStream:prior??null,replacementJob:next,receipt}));
      if(prior)db.prepare('UPDATE personal_source_streams SET cursor=NULL,last_hash=NULL WHERE id=?').run(stream);
      db.prepare('UPDATE personal_google_jobs SET body=? WHERE id=?').run(JSON.stringify(next),id);
      db.exec('COMMIT');this.state.status='idle';this.state.providers[job.provider]={status:'recovery-ready'};return receipt;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  start(){this.#refreshReauthPause();if(this.timer||this.reauthRequired||!this.client.configured())return;this.state.running=true;this.timer=setInterval(()=>{void this.run();},this.intervalMs);this.timer.unref();void this.run();}
  resumeAfterVerifiedConnection(){
    this.#rotateGeneration();
    this.inbox.store.db.prepare('DELETE FROM personal_google_sync_control WHERE id=1').run();
    this.reauthRequired=false;delete this.state.nextAction;delete this.state.requiredScopes;delete this.state.error;
    this.state.configured=Boolean(this.client.configured());this.state.status=this.state.configured?'idle':'connection-required';
    return this.status();
  }
  pauseCollection(){
    const control={version:1,reauthRequired:true,error:'A_GOOGLE_COLLECTION_PAUSED',requiredScopes:[],nextAction:pausedAction,observedAt:this.clock().toISOString()};
    const db=this.inbox.store.db;db.exec('BEGIN IMMEDIATE');try{
      this.#rotateGeneration();
      db.prepare('INSERT INTO personal_google_sync_control VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(control));db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    this.#refreshReauthPause();return {...this.status(),remoteGrantRevocationConfirmed:false,credentialsDeleted:false,inFlightRequestMayFinish:Boolean(this.pending)};
  }
  #rotateGeneration(){this.inbox.store.db.prepare('UPDATE personal_google_sync_generation SET revision=? WHERE id=1').run(randomUUID());}
  #generation(){return this.inbox.store.db.prepare('SELECT revision FROM personal_google_sync_generation WHERE id=1').get().revision;}
  async stop(){clearInterval(this.timer);this.timer=null;this.state.running=false;await this.pending;}
  run(){if(this.pending)return this.pending;this.pending=this.sync().finally(()=>{this.pending=null;});return this.pending;}
  async sync(){
    this.#refreshReauthPause();
    if(this.reauthRequired)return this.status();
    if(!this.client.configured())return this.status();this.state.status='syncing';delete this.state.error;
    const db=this.inbox.store.db;
    const generation=this.#generation();
    const assertCurrent=()=>{this.#refreshReauthPause();if(this.reauthRequired||generation!==this.#generation())throw new Error('A_GOOGLE_SYNC_CONTROL_CHANGED');};
    let interrupted=false;
    const lock=db.prepare('INSERT INTO personal_google_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE personal_google_lock.expires<?').run(this.owner,Date.now()+900000,Date.now());
    if(!lock.changes){this.state.status='busy';return this.status();}
    try{
      const account=await this.client.account();
      assertCurrent();
      for(const provider of ['gmail','google-calendar']){
        let receipt=null;
        try{
          const id=createHash('sha256').update(JSON.stringify([account,provider])).digest('hex');
          const stored=db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(id);
          let job=stored?JSON.parse(stored.body):null;
          if(!job||job.complete){
            const now=this.clock(),observedAt=now.toISOString();
            // Provider time filters have whole-second precision. Never round a boundary outward.
            const range={timeMin:new Date(Math.ceil((now.getTime()-14*86400000)/1000)*1000).toISOString(),timeMax:new Date(Math.floor((now.getTime()+(provider==='gmail'?1000:90*86400000))/1000)*1000).toISOString()};
            const window=this.evidence?.window(provider,range)??range;
            job={windowId:randomUUID(),account,provider,scope:`direct:${provider}:v1`,observedAt,...window,cursor:null,complete:false};
            db.prepare('INSERT INTO personal_google_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(job));
          }
          let pages=0;
          while(!job.complete&&pages<10){
            assertCurrent();
            if(!db.prepare('UPDATE personal_google_lock SET expires=? WHERE id=1 AND owner=? AND expires>?').run(Date.now()+900000,this.owner,Date.now()).changes)throw new Error('A_GOOGLE_LEASE_LOST');
            receipt=this.evidence?.before(job)??null;
            const result=await this.client.page(job,{authorization:receipt});
            assertCurrent();
            if(result.nextCursor!==null&&result.nextCursor===job.cursor)throw new Error('A_GOOGLE_REPEATED_CURSOR');
            const next={...job,cursor:result.nextCursor,complete:result.nextCursor===null};
            this.inbox.ingest({...job,nextCursor:result.nextCursor,items:result.items},{onCommit:()=>{
              assertCurrent();
              if(!db.prepare('SELECT 1 FROM personal_google_lock WHERE id=1 AND owner=? AND expires>?').get(this.owner,Date.now()))throw new Error('A_GOOGLE_LEASE_LOST');
              db.prepare('UPDATE personal_google_jobs SET body=? WHERE id=?').run(JSON.stringify(next),id);
              if(receipt)this.evidence.commit(receipt,result.items.length);
            }});
            receipt=null;job=next;pages++;
          }
          this.state.providers[provider]={status:job.complete?'window-complete':'partial',pages};
        }catch(error){
          this.evidence?.failed(receipt,safeCode(error));
          if(safeCode(error)==='A_GOOGLE_SYNC_CONTROL_CHANGED'){interrupted=true;break;}
          if(safeCode(error)==='A_GOOGLE_REAUTH_REQUIRED'){
            this.#pauseForReauthentication(error);break;
          }
          this.state.providers[provider]={status:'error',code:safeCode(error),
            ...(safeCode(error)==='A_GOOGLE_PAGE_INVALID'?{nextAction:'저장된 조회 기간과 페이지 정보를 확인해야 합니다. 자동으로 조회 범위를 넓히거나 기존 체크포인트를 초기화하지 않았습니다.'}:{}),
            ...(safeCode(error)==='A_GOOGLE_ACCOUNT_MISMATCH'?{nextAction:'수집을 시작한 Google 계정과 현재 연결된 계정이 다릅니다. 사용할 계정 연결을 확인한 뒤 수집을 다시 실행하세요.'}:{})};
        }
      }
      if(!this.reauthRequired)this.state.status=interrupted?'interrupted':Object.values(this.state.providers).some(p=>p.status==='error')?'degraded':Object.values(this.state.providers).some(p=>p.status==='partial')?'partial':'ready';
    }catch(error){
      if(safeCode(error)==='A_GOOGLE_REAUTH_REQUIRED')this.#pauseForReauthentication(error);
      else {this.state.status='error';this.state.error=safeCode(error);}
    }
    finally{db.prepare('DELETE FROM personal_google_lock WHERE id=1 AND owner=?').run(this.owner);}
    this.state.lastCheckedAt=this.clock().toISOString();return this.status();
  }
  #pauseForReauthentication(error){
    this.#refreshReauthPause();if(this.state.error==='A_GOOGLE_COLLECTION_PAUSED')return;
    this.#rotateGeneration();
    this.reauthRequired=true;clearInterval(this.timer);this.timer=null;this.state.running=false;this.state.status='reauth-required';
    this.state.error=safeCode(error);const requirements=this.client.connectionRequirements?.();
    this.state.requiredScopes=Array.isArray(requirements?.requiredScopes)?[...requirements.requiredScopes]:[];
    this.state.nextAction=reconnectAction;
    const control={version:1,reauthRequired:true,error:this.state.error,requiredScopes:this.state.requiredScopes,
      nextAction:this.state.nextAction,observedAt:this.clock().toISOString()};
    this.inbox.store.db.prepare('INSERT INTO personal_google_sync_control(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(JSON.stringify(control));
  }
  #refreshReauthPause(){
    const row=this.inbox.store.db.prepare('SELECT body FROM personal_google_sync_control WHERE id=1').get();
    if(!row)return false;
    try{
      const control=JSON.parse(row.body);
      const expectedScopes=control?.error==='A_GOOGLE_COLLECTION_PAUSED'?[]:[...(this.client.connectionRequirements?.().requiredScopes??[])];
      if(!control||Array.isArray(control)||Object.keys(control).some(key=>!['version','reauthRequired','error','requiredScopes','nextAction','observedAt'].includes(key))
        ||control.version!==1||control.reauthRequired!==true
        ||!['A_GOOGLE_COLLECTION_PAUSED','A_GOOGLE_REAUTH_REQUIRED'].includes(control.error)
        ||!Array.isArray(control.requiredScopes)||control.requiredScopes.length!==expectedScopes.length
        ||new Set(control.requiredScopes).size!==control.requiredScopes.length
        ||control.requiredScopes.some(scope=>typeof scope!=='string'||!expectedScopes.includes(scope))
        ||typeof control.nextAction!=='string'||normalizeStrictIsoInstant(control.observedAt)===null)throw new Error('A_GOOGLE_SYNC_CONTROL_INVALID');
      this.reauthRequired=true;this.state.running=false;this.state.status=control.error==='A_GOOGLE_COLLECTION_PAUSED'?'collection-paused':'reauth-required';this.state.error=control.error;
      this.state.requiredScopes=[...expectedScopes];this.state.nextAction=control.error==='A_GOOGLE_COLLECTION_PAUSED'?pausedAction:reconnectAction;
      clearInterval(this.timer);this.timer=null;return true;
    }catch{
      this.reauthRequired=true;this.state.running=false;this.state.status='reauth-required';this.state.error='A_GOOGLE_SYNC_CONTROL_INVALID';
      this.state.requiredScopes=[...(this.client.connectionRequirements?.().requiredScopes??[])];
      this.state.nextAction='Google 계정 연결 상태를 확인하고 다시 승인하세요.';clearInterval(this.timer);this.timer=null;return true;
    }
  }
}
function safeCode(error){return /^A_[A-Z0-9_]+$/.test(error.message)?error.message:'A_GOOGLE_SYNC_FAILED';}
