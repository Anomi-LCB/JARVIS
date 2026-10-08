import {createHash,randomUUID} from 'node:crypto';
import {validateFailureObservations} from '../runtime/task-failure-observation.js';
import {snapshotImprovementEvaluationPolicy} from './improvement-evaluation-policy.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const groupIdentity=b=>({toolName:b.toolName,nativePhase:b.nativePhase??null,...(b.failureObservationVersion===2?{failureObservationVersion:2,failureCode:b.failureCode??null,executionCodeVersion:b.executionCodeVersion??null}:{})});
const groupKey=b=>hash(JSON.stringify(groupIdentity(b)));
async function bounded(operation,milliseconds){
 const controller=new AbortController();let timer;
 try{return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('Improvement preparation timed out'),{code:'A_IMPROVEMENT_PREPARATION_TIMEOUT'}));},milliseconds);})]);}
 finally{clearTimeout(timer);}
}

/** Durable candidate queue. Never a reviewer, activator or execution authority. */
export class FailureImprovementPipeline {
 #db; #manager; #sources; #factory; #fetch; #clock; #threshold; #policy;
 constructor({store,promotionManager,sourcesForTool,createCandidate,fetchSource=globalThis.fetch,clock=()=>new Date(),threshold=2}){
  if(!store?.db||!promotionManager||!(sourcesForTool instanceof Map)||typeof createCandidate!=='function'||typeof fetchSource!=='function'
   ||!Number.isSafeInteger(threshold)||threshold<2||threshold>500)fail('A_IMPROVEMENT_PIPELINE_CONFIG_INVALID');
  this.#sources=new Map();
  for(const [tool,urls] of sourcesForTool){
   if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(tool)||!Array.isArray(urls)||urls.length<1||urls.length>3)fail('A_IMPROVEMENT_SOURCE_CONFIG_INVALID');
   const pinned=urls.map(raw=>{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash
    ||!['nodejs.org','docs.python.org','learn.microsoft.com','developer.android.com','developers.google.com','platform.openai.com','unicode.org','www.unicode.org'].includes(u.hostname))fail('A_IMPROVEMENT_SOURCE_NOT_APPROVED');return u.href;});
   this.#sources.set(tool,Object.freeze([...new Set(pinned)]));
  }
  this.#db=store.db;this.#manager=promotionManager;this.#factory=createCandidate;this.#fetch=fetchSource;this.#clock=clock;this.#threshold=threshold;
  this.#policy=hash(JSON.stringify({threshold,sources:[...this.#sources].sort(([a],[b])=>a.localeCompare(b))}));
  this.#db.exec('CREATE TABLE IF NOT EXISTS failure_improvement_policy(id INTEGER PRIMARY KEY CHECK(id=1),sha256 TEXT NOT NULL);CREATE TABLE IF NOT EXISTS failure_improvement_queue(id TEXT PRIMARY KEY,group_key TEXT UNIQUE NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS failure_improvement_sources(sha256 TEXT PRIMARY KEY,url TEXT NOT NULL,content TEXT NOT NULL,observed_at TEXT NOT NULL)');
  this.#db.exec('CREATE TABLE IF NOT EXISTS failure_improvement_evaluation_policy(id INTEGER PRIMARY KEY CHECK(id=1),sha256 TEXT NOT NULL,body TEXT NOT NULL)');
  this.#db.prepare('INSERT OR IGNORE INTO failure_improvement_policy VALUES(1,?)').run(this.#policy);
  if(this.#db.prepare('SELECT sha256 FROM failure_improvement_policy WHERE id=1').get().sha256!==this.#policy)fail('A_IMPROVEMENT_PIPELINE_POLICY_CHANGED');
  // Content identity is not provenance identity: distinct URLs and observations
  // can legitimately contain identical bytes. Preserve the old table for rollback.
  this.#db.exec('CREATE TABLE IF NOT EXISTS failure_improvement_source_observations(url TEXT NOT NULL,sha256 TEXT NOT NULL,observed_at TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(url,sha256,observed_at));CREATE INDEX IF NOT EXISTS failure_improvement_source_content ON failure_improvement_source_observations(sha256,observed_at)');
  this.#db.exec('INSERT OR IGNORE INTO failure_improvement_source_observations(url,sha256,observed_at,content) SELECT url,sha256,observed_at,content FROM failure_improvement_sources');
  this.#db.exec('CREATE TABLE IF NOT EXISTS failure_improvement_observations(group_key TEXT NOT NULL,task_ref TEXT NOT NULL,observed_at TEXT NOT NULL,queue_id TEXT,PRIMARY KEY(group_key,task_ref))');
  this.#db.exec('CREATE TABLE IF NOT EXISTS failure_improvement_groups(group_key TEXT PRIMARY KEY,body TEXT NOT NULL)');
  this.#db.exec('CREATE INDEX IF NOT EXISTS failure_improvement_unconsumed ON failure_improvement_observations(group_key,queue_id,observed_at,task_ref);CREATE INDEX IF NOT EXISTS failure_improvement_queue_state ON failure_improvement_queue(state)');
  // Backfill already consumed observations before admitting a new cycle.
  for(const row of this.#db.prepare('SELECT id,body FROM failure_improvement_queue').all()){
   const body=JSON.parse(row.body),key=groupKey(body);
   this.#db.prepare('INSERT OR IGNORE INTO failure_improvement_groups VALUES(?,?)').run(key,JSON.stringify(groupIdentity(body)));
   for(const item of body.failures??[])this.#db.prepare('INSERT OR IGNORE INTO failure_improvement_observations VALUES(?,?,?,?)').run(key,item.taskRef,item.observedAt,row.id);
  }
 }
 enqueue(observations){
  validateFailureObservations(observations);const now=this.#clock().getTime(),groups=new Map();
  for(const item of observations){
   const when=Date.parse(item.observedAt);if(when>now||now-when>30*86400000||!this.#sources.has(item.toolName))continue;
   const identity={toolName:item.toolName,nativePhase:item.nativeRecovery?.phase??null,...(item.version===2?{failureObservationVersion:2,failureCode:item.failureCode,executionCodeVersion:item.executionCodeVersion}:{})};
   const key=groupKey(identity);
   const group=groups.get(key)??{...identity,failures:[]};
   group.failures.push({taskRef:hash(item.taskId),observedAt:item.observedAt});groups.set(key,group);
  }
  this.#db.exec('BEGIN IMMEDIATE');
  try{
   for(const [key,group] of groups){
    this.#db.prepare('INSERT OR IGNORE INTO failure_improvement_groups VALUES(?,?)').run(key,JSON.stringify(groupIdentity(group)));
    for(const item of group.failures)this.#db.prepare('INSERT OR IGNORE INTO failure_improvement_observations VALUES(?,?,?,NULL)').run(key,item.taskRef,item.observedAt);
   }
   const active=new Set(this.#db.prepare("SELECT body FROM failure_improvement_queue WHERE state IN ('queued','researching','generating','evaluating')").all().map(row=>{
    return groupKey(JSON.parse(row.body));
   }));
   // Include persisted single failures after reconnect even if the caller's rolling archive no longer contains them.
   for(const row of this.#db.prepare('SELECT DISTINCT group_key FROM failure_improvement_observations WHERE queue_id IS NULL').all()){
    const key=row.group_key;if(active.has(key))continue;
    const savedGroup=this.#db.prepare('SELECT body FROM failure_improvement_groups WHERE group_key=?').get(key);
    const group=groups.get(key)??(savedGroup?JSON.parse(savedGroup.body):null);
    if(!group)continue;
    const fresh=this.#db.prepare('SELECT task_ref,observed_at FROM failure_improvement_observations WHERE group_key=? AND queue_id IS NULL AND observed_at>=? AND observed_at<=? ORDER BY task_ref LIMIT 500').all(key,new Date(now-30*86400000).toISOString(),new Date(now).toISOString());
    if(fresh.length<this.#threshold)continue;
    const failures=fresh.map(f=>({taskRef:f.task_ref,observedAt:f.observed_at})),id=randomUUID();
    const cycleKey=hash(JSON.stringify({groupKey:key,taskRefs:failures.map(f=>f.taskRef)}));
    this.#db.prepare("INSERT INTO failure_improvement_queue VALUES(?,?,'queued',?,?)").run(id,cycleKey,JSON.stringify({...groupIdentity(group),failures,policySha256:this.#policy,executionAuthority:false}),this.#clock().toISOString());
    for(const item of failures)this.#db.prepare('UPDATE failure_improvement_observations SET queue_id=? WHERE group_key=? AND task_ref=? AND queue_id IS NULL').run(id,key,item.taskRef);
   }
   this.#db.exec('COMMIT');
  }catch(error){this.#db.exec('ROLLBACK');throw error;}
  return this.list();
 }
 list(){return this.#db.prepare('SELECT * FROM failure_improvement_queue ORDER BY updated_at,id').all().map(row=>({id:row.id,state:row.state,...JSON.parse(row.body),executionAuthority:false}));}
 readiness(){
  const bound=snapshotImprovementEvaluationPolicy(this.#manager.improvementPolicy?.());
  const blocked=reasonCode=>({ready:false,reasonCode,nextAction:'고정 원문 요구·평가 집합과 기간·횟수·비용 한도가 정해진 영속 평가 예산을 연결해 주세요.',executionAuthority:false});
  if(!bound)return blocked('A_IMPROVEMENT_EVALUATION_POLICY_REQUIRED');
  const pinned=this.#db.prepare('SELECT sha256 FROM failure_improvement_evaluation_policy WHERE id=1').get();
  if(pinned&&pinned.sha256!==bound.sha256)return blocked('A_IMPROVEMENT_EVALUATION_POLICY_CHANGED');
  const status=this.#manager.improvementBudgetStatus?.(),calls=bound.policy.comparison?bound.policy.comparison.repeats*2:1;
  if(status?.eligibleNow!==true)return blocked('A_BUDGET_MANDATE_DENIED');
  if(!status||!Number.isSafeInteger(status.remainingCalls)||status.remainingCalls<calls
    ||(bound.policy.monetaryPolicy&&(!Number.isSafeInteger(status.remainingMinor)||status.remainingMinor<bound.policy.monetaryPolicy.maxCostMinor*calls)))
    return blocked('A_IMPROVEMENT_EVALUATION_BUDGET_EXHAUSTED');
  return{ready:true,evaluationPolicySha256:bound.sha256,policy:bound.policy,executionAuthority:false};
 }
 #assertEvaluationPolicy(expected){
  const current=snapshotImprovementEvaluationPolicy(this.#manager.improvementPolicy?.());
  if(!current||current.sha256!==expected)fail('A_IMPROVEMENT_EVALUATION_POLICY_CHANGED');
  if(this.#manager.improvementBudgetStatus?.()?.eligibleNow!==true)fail('A_BUDGET_MANDATE_DENIED');
 }
 sourceSnapshot(contentSha256,url,observedAt){
  if(typeof contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(contentSha256)
   ||(url!==undefined&&typeof url!=='string')
   ||(observedAt!==undefined&&(url===undefined||typeof observedAt!=='string')))fail('A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID');
  if(url===undefined&&this.#db.prepare('SELECT DISTINCT url FROM failure_improvement_source_observations WHERE sha256=? LIMIT 2').all(contentSha256).length>1)fail('A_IMPROVEMENT_SOURCE_SNAPSHOT_AMBIGUOUS');
  const clauses=['sha256=?'],parameters=[contentSha256];
  if(url!==undefined){clauses.push('url=?');parameters.push(url);}
  if(observedAt!==undefined){clauses.push('observed_at=?');parameters.push(observedAt);}
  const row=this.#db.prepare(`SELECT * FROM failure_improvement_source_observations WHERE ${clauses.join(' AND ')} ORDER BY observed_at DESC LIMIT 1`).get(...parameters);
  if(!row||hash(row.content)!==contentSha256)fail('A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID');
  return {url:row.url,content:row.content,observedAt:row.observed_at,contentSha256,instructionAuthority:false,trustBoundary:'externalContent'};
 }
 /** Reconcile a completed host stage without rerunning research, candidate generation or evaluation. */
 reconcile(id){
  const row=this.#db.prepare('SELECT * FROM failure_improvement_queue WHERE id=?').get(id);
  if(!row)fail('A_IMPROVEMENT_CANDIDATE_NOT_FOUND');
  const body=JSON.parse(row.body),unchanged=reason=>({id,state:row.state,executedNow:false,needsReconciliation:['researching','generating','evaluating'].includes(row.state),reasonCode:reason,executionAuthority:false});
  if(row.state!=='evaluating')return unchanged(null);
  if(body.policySha256!==this.#policy)fail('A_IMPROVEMENT_PIPELINE_POLICY_CHANGED');
  let stage;
  try{stage=this.#manager.getStage(body.stageId);}catch(error){if(error.code==='A_CAPABILITY_PACKAGE_STAGE_NOT_FOUND')return unchanged('A_IMPROVEMENT_STAGE_NOT_RESTORED');throw error;}
  if(stage.stageId!==body.stageId || stage.toolName!==body.toolName || stage.packageDigest!==body.packageDigest || stage.artifactSha256!==body.artifactSha256)fail('A_IMPROVEMENT_STAGE_IDENTITY_CHANGED');
  const evaluation=stage.evaluation;
  if(!evaluation)return unchanged('A_IMPROVEMENT_EVALUATION_UNCONFIRMED');
  if(evaluation.packageDigest!==body.packageDigest || evaluation.artifactSha256!==body.artifactSha256
    ||evaluation.actualIsolatedExecution!==true || evaluation.receipt?.isolationEnforced!==true
    ||evaluation.receipt.packageDigest!==body.packageDigest || evaluation.receipt.artifactSha256!==body.artifactSha256
    ||evaluation.receipt.schemaVersion!=='a-capability-package-isolated-evaluation-v1'
    ||evaluation.evidenceRef!==`sha256:${hash(evaluation.receipt.comparison?.schemaVersion==='a-capability-comparison-v1'?JSON.stringify(evaluation.receipt):canonical(evaluation.receipt))}`
    ||evaluation.receipt.status!==evaluation.status)fail('A_IMPROVEMENT_EVALUATION_IDENTITY_CHANGED');
  if(!['passed','failed'].includes(evaluation.status))fail('A_IMPROVEMENT_EVALUATION_UNCONFIRMED');
  const configuredSources=this.#sources.get(body.toolName);
  if(!Array.isArray(body.sources)||body.sources.length!==configuredSources?.length
    ||new Set(body.sources.map(s=>s.url)).size!==body.sources.length
    ||body.sources.some(s=>!configuredSources.includes(s.url)))fail('A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID');
  for(const source of body.sources){
   if(typeof source.observedAt!=='string')fail('A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID');
   const saved=this.sourceSnapshot(source.contentSha256,source.url,source.observedAt);
   if(saved.url!==source.url||saved.observedAt!==source.observedAt)fail('A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID');
  }
  const state=evaluation.status==='passed'?'registration_candidate':'failed';
  const next={...body,evaluationEvidenceRef:evaluation.evidenceRef,...(state==='failed'?{errorCode:'A_IMPROVEMENT_EVALUATION_FAILED'}:{})};
  const changed=this.#db.prepare('UPDATE failure_improvement_queue SET state=?,body=?,updated_at=? WHERE id=? AND state=? AND body=?').run(state,JSON.stringify(next),this.#clock().toISOString(),id,row.state,row.body);
  if(!changed.changes)return {id,state:this.#db.prepare('SELECT state FROM failure_improvement_queue WHERE id=?').get(id).state,executedNow:false,reconciled:false,executionAuthority:false};
  return {id,state,...next,executedNow:false,reconciled:true,needsReconciliation:false,executionAuthority:false};
 }
 #save(id,state,body){
  const changed=this.#db.prepare("UPDATE failure_improvement_queue SET state=?,body=?,updated_at=? WHERE id=? AND state IN ('researching','generating','evaluating')").run(state,JSON.stringify(body),this.#clock().toISOString(),id);
  if(!changed.changes && this.#db.prepare('SELECT state FROM failure_improvement_queue WHERE id=?').get(id)?.state!==state)fail('A_IMPROVEMENT_QUEUE_STATE_CHANGED');
 }
 async process(id){
  const existing=this.#db.prepare('SELECT * FROM failure_improvement_queue WHERE id=?').get(id);
  if(!existing)fail('A_IMPROVEMENT_CANDIDATE_NOT_FOUND');
  if(existing.state!=='queued')return {...JSON.parse(existing.body),id,state:existing.state,executedNow:false,needsReconciliation:['researching','generating','evaluating'].includes(existing.state),executionAuthority:false};
  const readiness=this.readiness();
  if(!readiness.ready)return {...JSON.parse(existing.body),id,state:'queued',...readiness,blocked:true,executedNow:false};
  this.#db.prepare('INSERT OR IGNORE INTO failure_improvement_evaluation_policy VALUES(1,?,?)').run(readiness.evaluationPolicySha256,JSON.stringify(readiness.policy));
  if(this.#db.prepare('SELECT sha256 FROM failure_improvement_evaluation_policy WHERE id=1').get().sha256!==readiness.evaluationPolicySha256)fail('A_IMPROVEMENT_EVALUATION_POLICY_CHANGED');
  const claimed=this.#db.prepare("UPDATE failure_improvement_queue SET state='researching',updated_at=? WHERE id=? AND state='queued'").run(this.#clock().toISOString(),id);
  const row=this.#db.prepare('SELECT * FROM failure_improvement_queue WHERE id=?').get(id);if(!row)fail('A_IMPROVEMENT_CANDIDATE_NOT_FOUND');
  if(!claimed.changes)return {...JSON.parse(row.body),id,state:row.state,executedNow:false,needsReconciliation:['researching','generating','evaluating'].includes(row.state),executionAuthority:false};
  let body={...JSON.parse(row.body),evaluationPolicySha256:readiness.evaluationPolicySha256};
  let preparation;
  try{
   preparation=this.#manager.prepareImprovement(id);
   const sources=[];
   for(const url of this.#sources.get(body.toolName)){
    this.#assertEvaluationPolicy(body.evaluationPolicySha256);
    const source=await bounded(async signal=>{
    const response=await this.#fetch(url,{redirect:'manual',signal,headers:{Accept:'text/html,text/plain,application/json'}});
    if(!response.ok||(response.url&&response.url!==url))fail('A_IMPROVEMENT_SOURCE_UNAVAILABLE');
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)fail('A_IMPROVEMENT_SOURCE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
    let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{fail('A_IMPROVEMENT_SOURCE_ENCODING_UNSUPPORTED');}if(!content.trim())fail('A_IMPROVEMENT_SOURCE_EMPTY');
    return Object.freeze({url,observedAt:this.#clock().toISOString(),contentSha256:hash(content),content,instructionAuthority:false,trustBoundary:'externalContent'});
    },10000);
    this.#db.prepare('INSERT OR IGNORE INTO failure_improvement_source_observations(url,sha256,observed_at,content) VALUES(?,?,?,?)').run(url,source.contentSha256,source.observedAt,source.content);
    if(this.sourceSnapshot(source.contentSha256,url,source.observedAt).content!==source.content)fail('A_IMPROVEMENT_SOURCE_SNAPSHOT_INVALID');sources.push(source);
   }
   this.#assertEvaluationPolicy(body.evaluationPolicySha256);
   body={...body,sources:sources.map(({content,...metadata})=>metadata)};this.#save(id,'generating',body);
   const definition=await bounded(signal=>this.#factory(Object.freeze({...groupIdentity(body),failureCount:body.failures.length,sources:Object.freeze(sources)}),{signal,preparationId:id}),15000);
   if(definition?.skill?.toolName!==body.toolName)fail('A_IMPROVEMENT_CANDIDATE_TOOL_CHANGED');
   const diagnosis=this.#factory.diagnosisFor?.(definition);
   if(diagnosis)body={...body,repairDiagnosis:diagnosis};
   this.#assertEvaluationPolicy(body.evaluationPolicySha256);
   const stage=this.#manager.stage(definition);
   this.#manager.attachImprovementPreparation(stage.stageId,preparation);
   body={...body,stageId:stage.stageId,packageDigest:stage.packageDigest,artifactSha256:stage.artifactSha256};this.#save(id,'evaluating',body);
   this.#assertEvaluationPolicy(body.evaluationPolicySha256);
   const result=await this.#manager.evaluate(stage.stageId);
   body={...body,evaluationEvidenceRef:result.evaluation.evidenceRef};this.#save(id,'registration_candidate',body);
   return {id,state:'registration_candidate',...body,executedNow:true,executionAuthority:false};
  }catch(error){
   if(preparation)this.#manager.abandonImprovementPreparation(preparation);
   body={...body,errorCode:error.code??'A_IMPROVEMENT_PIPELINE_FAILED'};this.#save(id,'failed',body);throw error;
  }
 }
}
