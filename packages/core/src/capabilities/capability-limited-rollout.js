import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const sha=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const freezeJson=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeJson(child);Object.freeze(value);}return value;};
function boundedObservation(callback,request,timeoutMs){
 const abort=new AbortController();let timer;
 const operation=Promise.resolve().then(()=>callback(request,{signal:abort.signal})).then(value=>({value}),error=>({error}));
 const deadline=new Promise(resolve=>{timer=setTimeout(()=>{
  const error=Object.assign(new Error('Observation deadline exceeded'),{code:'A_ROLLOUT_OBSERVATION_TIMEOUT'});
  abort.abort(error);resolve({error});
 },timeoutMs);});
 return Promise.race([operation,deadline]).finally(()=>clearTimeout(timer));
}
/** Host-owned local workflow rollout. Selection runs after E authorization and
 * never grants permission. No caller/model-supplied verifier or route is used. */
export class CapabilityLimitedRollout {
 #live=new Map();
 #recoveryGuard=null;
 constructor({store,promotionManager,adapterRegistry,clock=()=>new Date()}){
  if(!store?.db||!promotionManager||!adapterRegistry?.executionSelectors)throw TypeError('Persistent store and runtime promotion/adapter authorities required');
  this.db=store.db;this.manager=promotionManager;this.registry=adapterRegistry;this.clock=clock;
  this.db.exec('CREATE TABLE IF NOT EXISTS capability_limited_rollouts(id TEXT PRIMARY KEY,stage_id TEXT NOT NULL,policy_json TEXT NOT NULL,status TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,passed INTEGER NOT NULL DEFAULT 0,rollback_id TEXT);CREATE TABLE IF NOT EXISTS capability_limited_calls(rollout_id TEXT NOT NULL,packet_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(rollout_id,packet_id))');
  this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS capability_limited_stage ON capability_limited_rollouts(stage_id)');
  const active=this.manager.registry.activations.get('workflow.execute')?.packageDigest;
  if(!this.registry.executionSelectors.has('workflow.execute')&&this.db.prepare("SELECT policy_json FROM capability_limited_rollouts WHERE status='expanding' OR status IN ('expanded','suspended') AND rollback_id IS NOT NULL").all()
    .some(row=>JSON.parse(row.policy_json).packageDigest===active))
    {this.#recoveryGuard=()=>{if(this.manager.registry.activations.get('workflow.execute')?.packageDigest===active)fail('A_ROLLOUT_RECOVERY_REQUIRED');return null;};
     this.registry.executionSelectors.set('workflow.execute',this.#recoveryGuard);}
 }
 async begin(stageId,{workspaceRoot,specPath,maxCalls,minimumPassed,expiresAt,verifyOutcome,autoRollbackOnRegression=false,
  phase='limited',observeRequest,minimumObservations=1,observationTimeoutMs=30000}){
  if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>100||!Number.isSafeInteger(minimumPassed)||minimumPassed<1||minimumPassed>maxCalls
    ||typeof verifyOutcome!=='function'||typeof autoRollbackOnRegression!=='boolean'||!['limited','observing'].includes(phase)
    ||phase==='observing'&&(typeof observeRequest!=='function'||!Number.isSafeInteger(minimumObservations)||minimumObservations<1||minimumObservations>100)
    ||!Number.isSafeInteger(observationTimeoutMs)||observationTimeoutMs<100||observationTimeoutMs>120000
    ||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=this.clock().getTime())fail('A_ROLLOUT_POLICY_INVALID');
  const stage=this.manager.getStage(stageId);
  if(stage.toolName!=='workflow.execute'||stage.evaluation?.receipt?.comparison?.improved!==true)fail('A_ROLLOUT_COMPARISON_REQUIRED');
  if(this.registry.executionSelectors.has(stage.toolName))fail('A_ROLLOUT_ROUTE_CONFLICT');
  const binding=await this.manager.createLimitedAdapter(stageId),root=realpathSync(workspaceRoot),spec=realpathSync(resolve(root,specPath));
  // Prevent unapproved workspace widening and require the immutable reviewed spec.
  if(!spec.startsWith(root+'\\')&&!spec.startsWith(root+'/'))fail('A_ROLLOUT_SCOPE_INVALID');
  const id=randomUUID(),policy={workspaceRoot:root,specPath:spec,specSha256:sha(readFileSync(spec)),maxCalls,minimumPassed,expiresAt,
    packageDigest:binding.packageDigest,baseActiveDigest:binding.baseActiveDigest,artifactSha256:binding.artifactSha256,autoRollbackOnRegression,minimumObservations,observationTimeoutMs};
  this.db.prepare('INSERT INTO capability_limited_rollouts(id,stage_id,policy_json,status) VALUES(?,?,?,?)').run(id,stageId,JSON.stringify(policy),phase);
  const live={binding,verifyOutcome,policy,stageId,observeRequest};
  live.selector=(packet,{dryRun}={})=>{
    const state=this.status(id);
    if(state.status==='expanding'||state.status==='suspended'&&state.rollbackId)fail('A_ROLLOUT_RECOVERY_REQUIRED');
    const expanded=state.status==='expanded';
    const observing=state.status==='observing';
    if(dryRun||packet?.requestedMode==='shadow'||!['limited','expanded','observing'].includes(state.status)||!expanded&&!observing&&state.used>=maxCalls)return null;
    if(observing&&state.observations+state.failedObservations+state.unresolvedCalls>=minimumObservations)return null;
    const args=packet.action?.arguments??{};
    let matches=false;try{const candidateSpec=realpathSync(resolve(root,args.specPath));matches=!args.spec&&args.allowOverwrite!==true
      &&realpathSync(args.workspaceRoot??dirname(candidateSpec))===root&&candidateSpec===spec;}catch{}
    if(!matches)return null;
    const assertPhase=()=>{expanded?binding.assertExpandedCurrent():binding.assertCurrent();this.#assertScope(id,live,state.status);};
    assertPhase();
    const packetId=packet.packetId;
    if(typeof packetId!=='string'||!packetId)fail('A_ROLLOUT_PACKET_REQUIRED');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(this.db.prepare('SELECT status FROM capability_limited_calls WHERE rollout_id=? AND packet_id=?').get(id,packetId))fail('A_ROLLOUT_REPLAY_REQUIRES_RECONCILIATION');
      if(observing){const count=this.db.prepare('SELECT COUNT(*) AS n FROM capability_limited_calls WHERE rollout_id=?').get(id).n;
        if(count>=minimumObservations||this.status(id).status!=='observing')fail('A_ROLLOUT_OBSERVATION_LIMIT_REACHED');}
      if(!expanded&&!observing){const changed=this.db.prepare("UPDATE capability_limited_rollouts SET used=used+1 WHERE id=? AND status='limited' AND used<?").run(id,maxCalls);
        if(changed.changes!==1)fail('A_ROLLOUT_LIMIT_REACHED');}
      this.db.prepare("INSERT INTO capability_limited_calls VALUES(?,?,'reserved')").run(id,packetId);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    const inner=expanded||observing?this.registry.get('workflow.execute'):binding.adapter,controller=this;
    const proxy=new Proxy(inner,{get(target,key){
      if(key==='shadow')return async(...values)=>{try{assertPhase();return await target.shadow(...values);}
        catch(error){controller.db.prepare("UPDATE capability_limited_calls SET status='preflight-failed' WHERE rollout_id=? AND packet_id=?").run(id,packetId);
          controller.db.prepare("UPDATE capability_limited_rollouts SET status='suspended' WHERE id=?").run(id);throw error;}};
      if(key==='execute')return async(args,packet,options={})=>{
        const fence=assertPhase;
        try{
          fence();
          const observationBytes=observing?readFileSync(policy.specPath):null;
          if(observing&&sha(observationBytes)!==policy.specSha256)fail('A_ROLLOUT_SCOPE_EXPIRED_OR_CHANGED');
          const observationSpec=observing?freezeJson(JSON.parse(observationBytes.toString('utf8'))):null;
          const observationPromise=observing?boundedObservation(observeRequest,Object.freeze({packetId,specSha256:policy.specSha256,
            spec:observationSpec,baselineDigest:binding.baseActiveDigest,
            candidateDigest:binding.packageDigest,artifactSha256:binding.artifactSha256}),observationTimeoutMs):null;
          const result=await target.execute(args,packet,{...options,assertAccess:()=>{fence();options.assertAccess?.();},
            beforePublication:options.beforePublication?async paths=>{fence();return options.beforePublication(paths);}:undefined});
          if(observing){
            let observation;
            try{
              fence();
              const settled=await observationPromise;if(settled.error)throw settled.error;observation=settled.value;
              // Observation authority is host-owned. Still require an actual
              // isolated receipt for these same bytes, identities and request.
              if(observation?.actualIsolatedExecution!==true||observation?.packetId!==packetId
                ||observation?.specSha256!==policy.specSha256||observation?.packageDigest!==binding.packageDigest
                ||observation?.artifactSha256!==binding.artifactSha256||observation?.baselineDigest!==binding.baseActiveDigest
                ||observation?.receipt?.isolationEnforced!==true||observation?.receipt?.packageDigest!==binding.packageDigest
                ||observation?.receipt?.artifactSha256!==binding.artifactSha256
                ||observation?.receipt?.comparison?.activePackageDigest!==binding.baseActiveDigest
                ||observation?.receipt?.comparison?.candidateArtifactSha256!==binding.artifactSha256
                ||!Array.isArray(observation?.receipt?.comparison?.runs)||observation.receipt.comparison.runs.length<3
                ||observation.receipt.comparison.runs.some(run=>run.candidate?.status!=='passed'||!Array.isArray(run.regressedCaseIds)||run.regressedCaseIds.length))
                fail('A_ROLLOUT_OBSERVATION_INVALID');
              fence();
              const saved=JSON.stringify(observation);if(Buffer.byteLength(saved)>1048576)fail('A_ROLLOUT_OBSERVATION_TOO_LARGE');
              controller.db.prepare("UPDATE capability_limited_calls SET status=? WHERE rollout_id=? AND packet_id=?")
                .run('observed:'+saved,id,packetId);
              return {...result,rolloutObservation:{status:'observed',candidateActivated:false,specSha256:policy.specSha256}};
            }catch(error){
              controller.db.prepare("UPDATE capability_limited_calls SET status='observation-failed' WHERE rollout_id=? AND packet_id=?").run(id,packetId);
              return {...result,rolloutObservation:{status:'failed',candidateActivated:false,errorCode:error.code??'A_ROLLOUT_OBSERVATION_FAILED'}};
            }
          }
          const passed=result.status==='success'&&await verifyOutcome(result,packet)===true;
          controller.db.exec('BEGIN IMMEDIATE');
          try{controller.db.prepare('UPDATE capability_limited_calls SET status=? WHERE rollout_id=? AND packet_id=?').run(passed?'passed':'regression',id,packetId);
            controller.db.prepare("UPDATE capability_limited_rollouts SET passed=passed+?,status=CASE WHEN ? THEN status ELSE 'suspended' END WHERE id=?").run(passed&&!expanded?1:0,passed?1:0,id);controller.db.exec('COMMIT');
          }catch(error){controller.db.exec('ROLLBACK');throw error;}
          let recovery;
          if(!passed&&expanded&&autoRollbackOnRegression){
            try{await binding.rollbackReviewed(controller.status(id).rollbackId);controller.#finishRollback(id);recovery={status:'rolled_back'};}
            catch(error){recovery={status:'blocked',errorCode:error.code??'A_ROLLOUT_ROLLBACK_FAILED'};}
          }
          if(!passed)return {...result,status:'failed',error:result.error??{code:'A_ROLLOUT_POSTCONDITION_FAILED'},...(recovery?{rolloutRecovery:recovery}:{})};
          return result;
        }catch(error){controller.db.prepare("UPDATE capability_limited_rollouts SET status='suspended' WHERE id=?").run(id);throw error;}
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    return {adapter:proxy,executionCodeVersion:observing?binding.baseActiveDigest:binding.packageDigest};
  };
  this.registry.executionSelectors.set(stage.toolName,live.selector);this.#live.set(id,live);return this.status(id);
 }
 #assertScope(id,live,phase='limited'){
  if(this.status(id).status!==phase||Date.parse(live.policy.expiresAt)<=this.clock().getTime()
    ||realpathSync(live.policy.workspaceRoot)!==live.policy.workspaceRoot||realpathSync(live.policy.specPath)!==live.policy.specPath
    ||sha(readFileSync(live.policy.specPath))!==live.policy.specSha256)fail('A_ROLLOUT_SCOPE_EXPIRED_OR_CHANGED');
 }
 status(id){const row=this.db.prepare('SELECT * FROM capability_limited_rollouts WHERE id=?').get(id);if(!row)fail('A_ROLLOUT_NOT_FOUND');
  return {id,stageId:row.stage_id,status:row.status,used:row.used,passed:row.passed,rollbackId:row.rollback_id,policy:JSON.parse(row.policy_json),
    unresolvedCalls:this.db.prepare("SELECT COUNT(*) AS n FROM capability_limited_calls WHERE rollout_id=? AND status='reserved'").get(id).n,
    observations:this.db.prepare("SELECT COUNT(*) AS n FROM capability_limited_calls WHERE rollout_id=? AND status LIKE 'observed:%'").get(id).n,
    failedObservations:this.db.prepare("SELECT COUNT(*) AS n FROM capability_limited_calls WHERE rollout_id=? AND status='observation-failed'").get(id).n,
    executionRouteLoaded:this.#live.has(id)};}
 startLimited(id){
  const live=this.#live.get(id),state=this.status(id);
  if(!live||state.status!=='observing'||state.unresolvedCalls||state.failedObservations||state.observations<state.policy.minimumObservations)
    fail('A_ROLLOUT_OBSERVATION_REQUIRED');
  live.binding.assertCurrent();this.#assertScope(id,live,'observing');
  const updated=this.db.prepare("UPDATE capability_limited_rollouts SET status='limited' WHERE id=? AND status='observing'").run(id);
  if(updated.changes!==1)fail('A_ROLLOUT_OBSERVATION_REQUIRED');
  return this.status(id);
 }
 async expand(id){
  const live=this.#live.get(id),state=this.status(id);if(!live||state.status!=='limited'||state.unresolvedCalls||state.passed<state.policy.minimumPassed)fail('A_ROLLOUT_EXPANSION_NOT_READY');
  live.binding.assertCurrent();this.#assertScope(id,live);
  this.db.prepare("UPDATE capability_limited_rollouts SET status='expanding' WHERE id=? AND status='limited'").run(id);
  const promoted=await this.manager.promote(live.stageId);
  this.db.prepare("UPDATE capability_limited_rollouts SET status='expanded',rollback_id=? WHERE id=?").run(promoted.rollbackId,id);
  return this.status(id);
 }
 async regress(id,reviewContext){
  const state=this.status(id);if(state.status==='rolled_back')return state;
  this.db.prepare("UPDATE capability_limited_rollouts SET status='suspended' WHERE id=?").run(id);
  if(!state.rollbackId)return this.status(id);
  await this.manager.rollback(state.rollbackId,reviewContext);
  this.#finishRollback(id);
  return this.status(id);
 }
 #finishRollback(id){
  this.db.prepare("UPDATE capability_limited_rollouts SET status='rolled_back' WHERE id=?").run(id);
  const live=this.#live.get(id);
  if(live&&this.registry.executionSelectors.get('workflow.execute')===live.selector)this.registry.executionSelectors.delete('workflow.execute');
  if(this.#recoveryGuard&&this.registry.executionSelectors.get('workflow.execute')===this.#recoveryGuard)this.registry.executionSelectors.delete('workflow.execute');
 }
 recoverExpansion(id){
  const state=this.status(id);if(state.status!=='expanding')fail('A_ROLLOUT_EXPANSION_NOT_UNCERTAIN');
  const journal=this.manager.journal;if(!journal?.stageHistory)fail('A_ROLLOUT_SIGNED_HISTORY_REQUIRED');
  const records=journal.stageHistory(state.stageId),commits=records.filter(r=>r.eventType==='promotion_committed');
  if(journal.status().pendingTransitions.length||commits.length!==1||commits[0].payload.packageDigest!==state.policy.packageDigest
    ||commits[0].payload.artifactSha256!==state.policy.artifactSha256
    ||this.manager.registry.activations.get('workflow.execute')?.packageDigest!==state.policy.packageDigest)fail('A_ROLLOUT_EXPANSION_RECONCILIATION_REQUIRED');
  this.db.prepare("UPDATE capability_limited_rollouts SET status='suspended',rollback_id=? WHERE id=? AND status='expanding'").run(commits[0].payload.rollbackId,id);
  return {...this.status(id),activationReplayed:false,ownerAuthorizationRestored:false};
 }
}
