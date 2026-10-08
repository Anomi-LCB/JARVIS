import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {GrowthRuntime} from '../../apps/growth-memory/src/growth-runtime.js';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {mkdirSync} from 'node:fs';
import {productServiceDefinitions,startProductRuntime} from '../../scripts/product-runtime.mjs';
const root=process.argv[2];
Object.assign(process.env,{JARVIS_CORE_ROOT:root,JARVIS_CORE_ALLOWED_ROOTS:join(root,'workspace'),
 JARVIS_PERSONAL_OPERATIONS_DB:join(root,'personal.sqlite'),JARVIS_CORE_INTEGRATION_VAULT:join(root,'integrations.json'),
 JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'1',
 JARVIS_TEST_TRUST_SECRET:randomBytes(32).toString('base64url'),JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0'});
mkdirSync(join(root,'workspace'));
for(const name of ['CORE','PC_AGENT','BRIDGE','UI']){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env['JARVIS_'+name+'_PORT']=String(server.address().port);await new Promise(r=>server.close(r));}
Object.assign(process.env,{JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_AUDIT_ROOT:join(root,'audit/core'),JARVIS_AUDIT_ROOT:join(root,'audit/pc'),JARVIS_TRUST_ROOT:join(root,'trust'),JARVIS_ALLOWED_ROOTS:join(root,'workspace'),
 JARVIS_BRIDGE_STATE_DIR:join(root,'bridge'),JARVIS_BRIDGE_REAL_EXECUTION:'0',JARVIS_BRIDGE_OPEN_OUTPUTS:'0',JARVIS_BROWSER_DRIVER:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',
 JARVIS_UNDO_JOURNAL:join(root,'audit/undo.jsonl'),JARVIS_ROLLBACK_TRANSACTIONS:join(root,'audit/rollback.jsonl'),JARVIS_PACKET_JOURNAL:join(root,'audit/packets.jsonl'),JARVIS_PACKET_QUEUE:join(root,'audit/queue.json'),JARVIS_TOKEN_VAULT:join(root,'audit/vault.json')});
process.env.JARVIS_CORE_GROWTH_DB=join(root,'knowledge.sqlite');
const opts={dbPath:join(root,'knowledge.sqlite'),reviewDir:join(root,'knowledge-reviews'),backupDir:join(root,'knowledge-backups')};
const store=new SqliteMemoryStore(opts),growth=new GrowthRuntime({memoryStore:store,auditRoot:join(root,'seed-audit')});
growth.ingest({eventId:'synthetic-knowledge',taskId:'synthetic-knowledge',eventType:'task.created',source:{module:'CORE',memoryScope:{userId:'local_user',workspaceRoot:join(root,'workspace'),conversationId:null}},payload:{rawText:"'합성 프로젝트'의 '위치'를 '로컬'로 결정했어. 이유는 '오프라인 작업'이야. 기억해줘"},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
for(const [eventId,value,createdAt,extra] of [
 ['conflict-a','첫 번째 위치','2026-02-20T00:00:00.000Z',{}],
 ['conflict-b','다른 위치','2026-02-21T00:00:00.000Z',{}],
 ['expired','만료된 위치','2026-02-20T00:00:00.000Z',{validUntil:'2026-02-21T00:00:00.000Z'}],
 ['future','PRIVATE_FUTURE_VALUE','2199-02-20T00:00:00.000Z',{}]
]) growth.ingest({eventId,taskId:eventId,eventType:'task.created',createdAt,
 source:{module:'CORE',memoryScope:{userId:'local_user',workspaceRoot:join(root,'workspace'),conversationId:null}},
 payload:{rawText:'합성 시험 기록',knowledge:{kind:'fact',subject:eventId.startsWith('conflict')?'충돌 시험':eventId,predicate:'위치',value,...extra}},
 learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,systemGenerated:false}});
store.close();
if(['notifications','followup-replan','followup-cancel','followup-source-replan'].includes(process.argv[3])){
 const {PersonalOperationsStore}=await import('../../packages/core/src/personal-operations/operations-store.js');
 const {PersonalOperationsReminderScheduler}=await import('../../packages/core/src/personal-operations/reminder-scheduler.js');
 const notices=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')});
 if(process.argv[3]==='followup-source-replan'){
  const {PersonalSourceInbox}=await import('../../packages/core/src/personal-operations/source-inbox.js');const inbox=new PersonalSourceInbox(notices);
  inbox.ingest({provider:'google-calendar',account:'fixture',scope:'primary',observedAt:'2026-10-01T00:00:00Z',items:[0,1].map(i=>({id:'fixture-event-'+i,title:'시험 일정 '+i,start:'2026-10-06T00:00:00Z'}))});
  for(const source of inbox.list())inbox.accept({id:source.id,dueAt:new Date(Date.now()+60000).toISOString()});
 }
 for(let i=process.argv[3]==='followup-source-replan'?2:0;i<21;i++)notices.createCommitment({title:'PRIVATE_SYNTHETIC_NOTIFICATION',dueAt:new Date(Date.now()+60000).toISOString(),sourceRef:'fixture:notification-ui'});
 new PersonalOperationsReminderScheduler({store:notices}).tick();notices.close();
}
if(process.argv[3]==='routine-notifications'){
 const {PersonalOperationsStore}=await import('../../packages/core/src/personal-operations/operations-store.js');
 const {SqliteDurableRoutineStore,createRoutineRecord}=await import('../../packages/core/src/runtime/durable-routine-store.js');
 const {RoutineNotificationOutbox}=await import('../../packages/core/src/runtime/routine-notification-outbox.js');
 const notices=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')}),routines=new SqliteDurableRoutineStore({operationsStore:notices}),clock=()=>new Date();
 for(const [i,kind] of ['routine-completed','routine-failed','routine-blocked','routine-needs-attention','routine-cancelled-by-user','routine-missed'].entries()){
  const routineId='fixture-routine-'+i,scheduledAt=new Date(Date.now()-60000).toISOString();
  routines.create(createRoutineRecord({routineId,scheduledAt,missionRequest:{objective:'PRIVATE_ROUTINE_OBJECTIVE'}}));
  if(kind==='routine-missed')routines.transition(routineId,'missed',{missedAt:clock().toISOString()});
  else routines.transition(routineId,kind==='routine-completed'?'completed':kind==='routine-failed'?'failed':'blocked',{notification:{kind},...(kind==='routine-cancelled-by-user'?{cancelledAt:clock().toISOString()}: {})});
 }
 await new RoutineNotificationOutbox({store:routines,onNotification:()=>{},clock,ownerId:'fixture-publisher'}).flush();notices.close();
}
const seed=process.env.JARVIS_TEST_TRUST_SECRET;
const definitions=productServiceDefinitions().map(d=>({...d,environment:{...d.environment,JARVIS_TEST_TRUST_SECRET:seed}}));
const runtime=await startProductRuntime({definitions,logger:{log(){},warn(){},error(){}},startupTimeoutMs:30000});
if(['followup-replan','followup-cancel','followup-source-replan'].includes(process.argv[3])){
 const {PersonalOperationsStore}=await import('../../packages/core/src/personal-operations/operations-store.js');const {PersonalOperationsReminderScheduler}=await import('../../packages/core/src/personal-operations/reminder-scheduler.js');
 const notices=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')});for(const c of notices.summary().commitments.slice(0,2)){const followup='followup:'+c.id;
 const post=async(op,body)=>{const r=await fetch(runtime.uiUrl+'/api/core/personal-operations/followups/'+encodeURIComponent(followup)+'/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('fixture replan setup '+r.status);return r.json();};
 await post('dispatch',{objective:'작업 폴더 파일 목록 확인',successCriteria:['파일 목록 검증']});if(['followup-replan','followup-source-replan'].includes(process.argv[3]))await post('cancel',{});
 if(process.argv[3]==='followup-source-replan'){const {PersonalSourceInbox}=await import('../../packages/core/src/personal-operations/source-inbox.js');const inbox=new PersonalSourceInbox(notices);const row=notices.db.prepare('SELECT provider_id FROM personal_source_items WHERE commitment_id=?').get(c.id);if(row)inbox.ingest({provider:'google-calendar',account:'fixture',scope:'primary',observedAt:'2026-10-02T00:00:00Z',items:[{id:row.provider_id,title:'자료 시간 변경 시험',start:'2026-10-08T00:00:00Z'}]});}
 notices.changeDeadline(c.id,{dueAt:new Date(Date.now()+120000).toISOString(),expectedRevision:1,changeId:'fixture-replan-change-'+c.id});}
 new PersonalOperationsReminderScheduler({store:notices}).tick();notices.close();
}
console.log(JSON.stringify({status:'ready',url:runtime.uiUrl,coreUrl:`http://127.0.0.1:${process.env.JARVIS_CORE_PORT}`,services:runtime.services().map(s=>({id:s.id,status:s.status}))}));
let closing=false;async function stop(){if(closing)return;closing=true;await runtime.stop();process.exit(0);}
process.stdin.on('data',data=>{if(String(data).trim()==='delete'){const s=new SqliteMemoryStore(opts);s.saveHygieneDecision({decisionId:'withdraw',targetType:'memory_event',targetId:'synthetic-knowledge',action:'delete',decidedAt:new Date().toISOString()});s.close();console.log(JSON.stringify({status:'deleted'}));}else void stop();});process.stdin.once('end',stop);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
