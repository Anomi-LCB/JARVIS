import {randomUUID,createHash} from 'node:crypto';
import {createGoalContract} from '../mission/goal-contract.js';
const contracts={shipment:{provider:'dhl',states:['created','in_transit','delivered','exception','cancelled'],url:'https://www.dhl.com/'},return:{provider:'shopify',states:['requested','approved','in_transit','received','refunded','declined','cancelled'],url:'https://help.shopify.com/en/manual/orders/refund-cancel-order/returns'},administration:{provider:'government24',states:['submitted','processing','supplement-required','approved','rejected','cancelled'],url:'https://www.gov.kr/'}};
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const text=(v,max=300)=>{if(typeof v!=='string'||!v.trim()||v!==v.trim()||v.length>max||/[\u0000-\u001f]/u.test(v))fail('A_CASE_TEXT_INVALID');return v;};
const fields=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('A_CASE_FIELDS_INVALID');};
const instant=v=>{
 text(v,40);const times=createGoalContract({objective:v}).times;
 if(times.length!==1||times[0].status!=='parsed-instant'||times[0].text!==v)fail('A_CASE_TIME_INVALID');return times[0].instant;
};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Supplied receipt/status tracking in the existing Core DB. Imported status
 * never becomes provider verification, a transaction grant, or completed work. */
export class PersonalLifecycleCases{
 constructor(store){this.store=store;this.db=store.db;this.db.exec(`CREATE TABLE IF NOT EXISTS personal_lifecycle_cases(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS personal_lifecycle_events(case_id TEXT NOT NULL REFERENCES personal_lifecycle_cases(id),event_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(case_id,event_id));
 CREATE TABLE IF NOT EXISTS personal_lifecycle_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL);`);
 this.db.prepare('INSERT OR IGNORE INTO personal_lifecycle_identity VALUES(1,?)').run(randomUUID());this.storeId=this.db.prepare('SELECT store_id FROM personal_lifecycle_identity WHERE singleton=1').get().store_id;}
 context(){return {version:'lifecycle-context-v1',storeId:this.storeId,providerVerified:false,executionAuthority:false};}
 requireStore(input){if(input.expectedStoreId!==undefined&&input.expectedStoreId!==this.storeId)fail('A_CASE_STORE_CHANGED',409);}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 create(input){
  fields(input,['requestId','kind','provider','accountRef','providerRef','title','dueAt','expectedStoreId']);this.requireStore(input);
  const contract=Object.hasOwn(contracts,input.kind)?contracts[input.kind]:null;if(!contract||input.provider!==contract.provider)fail('A_CASE_PROVIDER_INVALID');
  const request={requestId:text(input.requestId,100),kind:input.kind,provider:input.provider,accountRef:text(input.accountRef,200),providerRef:text(input.providerRef),title:text(input.title,200),dueAt:input.dueAt==null?null:instant(input.dueAt)},fingerprint=hash(request);
  return this.transaction(()=>{
   const prior=this.db.prepare('SELECT * FROM personal_lifecycle_cases WHERE request_key=?').get(request.requestId);
   if(prior){if(prior.request_hash!==fingerprint)fail('A_CASE_REQUEST_CONFLICT',409);return {...this.get(prior.id),replayed:true};}
   const id=randomUUID(),createdAt=this.store.now();
   const commitment=request.dueAt?this.store.createCommitment({title:request.title,dueAt:request.dueAt,sourceRef:`lifecycle-case:${id}`}):null;
   const body={...request,id,commitmentId:commitment?.id??null,observation:null,cancellation:null,handoff:null};
   this.db.prepare('INSERT INTO personal_lifecycle_cases VALUES(?,?,?,?,?,?)').run(id,request.requestId,fingerprint,JSON.stringify(body),1,createdAt);
   return {...this.get(id),replayed:false};
  });
 }
 get(id,{includeEvents=true}={}){text(id,100);const row=this.db.prepare('SELECT * FROM personal_lifecycle_cases WHERE id=?').get(id);if(!row)return null;const body=JSON.parse(row.body);
  return {...body,revision:row.revision,createdAt:row.created_at,deadlineState:body.dueAt?(Date.parse(this.store.now())>Date.parse(body.dueAt)?'elapsed':'upcoming'):'unknown',providerVerified:false,completionVerified:false,executionAuthority:false,
   nextAction:body.handoff?'공식 창구 안내를 준비했습니다. 아직 인계하거나 접수하지 않았습니다. 공식 창구에서 처리한 뒤 접수·취소 영수증을 확인하세요.':body.cancellation?'취소 요청을 기록했습니다. 공급자가 취소를 확인하기 전에는 취소 완료로 표시하지 않습니다.':body.observation?'제공된 상태 기록입니다. 실제 공급자 연결에서 최신 상태를 확인해야 합니다.':'공식 상태 조회 연결 또는 사용자가 선택한 접수 기록이 필요합니다.',
   events:includeEvents?this.db.prepare('SELECT body FROM personal_lifecycle_events WHERE case_id=? ORDER BY rowid').all(id).map(row=>JSON.parse(row.body)):[],eventsIncluded:includeEvents};
 }
 list(){return this.db.prepare('SELECT id FROM personal_lifecycle_cases ORDER BY created_at DESC,id LIMIT 100').all().map(row=>this.get(row.id));}
 listPage({limit=20,cursor=null}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('A_CASE_PAGE_LIMIT_INVALID');
  const maximum=this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM personal_lifecycle_cases').get().n;
  let snapshot=maximum,before=maximum+1;
  if(cursor!==null){
   let parsed;try{if(typeof cursor!=='string'||cursor.length>300||!/^[A-Za-z0-9_-]+$/u.test(cursor))throw Error();parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail('A_CASE_PAGE_CURSOR_INVALID');}
   if(!parsed||Object.keys(parsed).sort().join(',')!=='before,snapshot,version'||parsed.version!==1
    ||!Number.isSafeInteger(parsed.snapshot)||parsed.snapshot<0||parsed.snapshot>maximum
    ||!Number.isSafeInteger(parsed.before)||parsed.before<1||parsed.before>parsed.snapshot+1)fail('A_CASE_PAGE_CURSOR_INVALID');
   ({snapshot,before}=parsed);
  }
  const rows=this.db.prepare('SELECT rowid AS n,id FROM personal_lifecycle_cases WHERE rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(snapshot,before,limit+1);
  const visible=rows.slice(0,limit),hasMore=rows.length>limit;
  return {version:'lifecycle-case-page-v1',items:visible.map(r=>this.get(r.id,{includeEvents:false})),hasMore,
   nextCursor:hasMore?Buffer.from(JSON.stringify({version:1,snapshot,before:visible.at(-1).n})).toString('base64url'):null,
   membershipSnapshot:true,observedAt:this.store.now()};
 }
 record(id,type,input){
  if(!['observation','cancel','handoff'].includes(type))fail('A_CASE_EVENT_TYPE_INVALID');
  const allowed=type==='observation'?['eventId','expectedRevision','provider','accountRef','providerRef','observedAt','status','receiptRef']:type==='cancel'?['eventId','expectedRevision','reason']:['eventId','expectedRevision','reason'];
  fields(input,[...allowed,'expectedStoreId']);this.requireStore(input);const eventId=text(input.eventId,100);if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)fail('A_CASE_REVISION_INVALID');
  const supplied={eventId,expectedRevision:input.expectedRevision};
  if(type==='observation')Object.assign(supplied,{provider:text(input.provider,50),accountRef:text(input.accountRef,200),providerRef:text(input.providerRef),observedAt:instant(input.observedAt),status:text(input.status,50),receiptRef:text(input.receiptRef,500)});
  else supplied.reason=text(input.reason,500);
  const fingerprint=hash({type,...supplied});
  return this.transaction(()=>{
   const row=this.db.prepare('SELECT * FROM personal_lifecycle_cases WHERE id=?').get(text(id,100));if(!row)fail('A_CASE_NOT_FOUND',404);
   const prior=this.db.prepare('SELECT request_hash FROM personal_lifecycle_events WHERE case_id=? AND event_id=?').get(id,eventId);
   if(prior){if(prior.request_hash!==fingerprint)fail('A_CASE_EVENT_CONFLICT',409);return {...this.get(id),replayed:true};}
   if(row.revision!==input.expectedRevision)fail('A_CASE_REVISION_CONFLICT',409);
   const body=JSON.parse(row.body),now=this.store.now(),event={...supplied,type,recordedAt:now,provenance:'user-supplied',providerVerified:false};
   if(type==='observation'){
    if(supplied.provider!==body.provider||supplied.accountRef!==body.accountRef||supplied.providerRef!==body.providerRef)fail('A_CASE_SOURCE_MISMATCH',409);
    if(!contracts[body.kind].states.includes(supplied.status))fail('A_CASE_STATUS_INVALID');
    if(supplied.observedAt>now)fail('A_CASE_OBSERVATION_FUTURE');
    if(body.observation&&(supplied.observedAt<body.observation.observedAt||supplied.observedAt===body.observation.observedAt))fail('A_CASE_STALE_OR_CONFLICTING_OBSERVATION',409);
    body.observation=event;
   }else if(type==='cancel')body.cancellation={...event,state:'request-recorded',externalRequestSent:false};
   else body.handoff={...event,url:contracts[body.kind].url,state:'handoff-prepared',externalRequestSent:false};
   this.db.prepare('INSERT INTO personal_lifecycle_events VALUES(?,?,?,?)').run(id,eventId,fingerprint,JSON.stringify(event));
   this.db.prepare('UPDATE personal_lifecycle_cases SET body=?,revision=revision+1 WHERE id=?').run(JSON.stringify(body),id);
   return {...this.get(id),replayed:false};
  });
 }
}

export function lifecycleCaseOpenApiPaths(){
 const s={type:'string',minLength:1},revision={type:'integer',minimum:1},time={type:'string',format:'date-time'};
 const schema=(properties,required)=>({type:'object',additionalProperties:false,properties:{...properties,expectedStoreId:s},required});
 const response={description:'Local recorded state only. Provider verification, completion and execution authority remain false.',content:{'application/json':{schema:{type:'object'}}}};
 const operation=(operationId,description,body=null,parameters=[])=>({operationId,description,security:[{bearerAuth:[]}],parameters,
  ...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),responses:{200:response,400:{description:'Invalid fields or time'},401:{description:'Authentication required'},403:{description:'ADMIN required'},404:{description:'Case not found'},409:{description:'Revision, source, replay or observation conflict'},413:{description:'Maximum request body 4096 bytes'},415:{description:'JSON required'},503:{description:'Personal operations store unavailable'}}});
 const parameter=[{name:'caseId',in:'path',required:true,schema:s}];
 const event={eventId:s,expectedRevision:revision,expectedStoreId:s},reason=schema({...event,reason:s},['eventId','expectedRevision','reason']);
 return {
  '/personal-operations/cases':{get:{...operation('listPersonalLifecycleCases','ADMIN-only latest 100 local cases by default. With limit/cursor returns rowid-ordered membership snapshot pages without full event history. Current values may change between pages; no provider calls.'),parameters:[{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100}},{name:'cursor',in:'query',schema:s}],responses:{200:{description:'Latest cases or explicit page envelope',content:{'application/json':{schema:{oneOf:[{type:'array',items:{type:'object'}},{type:'object'}]}}}},400:{description:'Invalid page limit or cursor'},401:{description:'Authentication required'},403:{description:'ADMIN required'},503:{description:'Store unavailable'}}},post:operation('createPersonalLifecycleCase','ADMIN-only local tracking; kind/provider pairs shipment/dhl, return/shopify, administration/government24. Account references are labels, not passwords.',schema({requestId:s,kind:{type:'string',enum:Object.keys(contracts)},provider:{type:'string',enum:['dhl','shopify','government24']},accountRef:s,providerRef:s,title:s,dueAt:{oneOf:[time,{type:'null'}]}},['requestId','kind','provider','accountRef','providerRef','title']))},
  '/personal-operations/cases/context':{get:operation('getPersonalLifecycleContext','ADMIN-only persisted ledger identity for pending request recovery. Not a Core authority lease or permission.',null)},
  '/personal-operations/cases/{caseId}':{get:operation('getPersonalLifecycleCase','ADMIN-only persisted state and event history; elapsed deadline does not mean failure or completion.',null,parameter)},
  '/personal-operations/cases/{caseId}/observation':{post:operation('recordPersonalLifecycleObservation','User-supplied observation only. Exact provider/account/reference; future, stale and conflicting observations rejected.',schema({...event,provider:s,accountRef:s,providerRef:s,observedAt:time,status:s,receiptRef:s},['eventId','expectedRevision','provider','accountRef','providerRef','observedAt','status','receiptRef']),parameter)},
  '/personal-operations/cases/{caseId}/cancel':{post:operation('recordPersonalLifecycleCancellation','Record cancellation intent. Sends no provider request and does not mark cancellation complete.',reason,parameter)},
  '/personal-operations/cases/{caseId}/handoff':{post:operation('preparePersonalLifecycleHandoff','Prepare fixed official destination. No automatic browser action, login, external submission or arbitrary URL.',reason,parameter)}
 };
}
