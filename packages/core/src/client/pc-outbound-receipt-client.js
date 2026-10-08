import { executionPacketFingerprint } from '../../../shared/src/execution-packet-fingerprint.js';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SqliteMissionStore } from '../mission/sqlite-mission-store.js';
import { remoteArtifactDigest } from '../mission/remote-artifact-contract.js';

const fail = suffix => { throw Object.assign(new Error(`A_PC_OUTBOUND_${suffix}`),{code:`A_PC_OUTBOUND_${suffix}`}); };

/** Recovery-only executor interface. Observations remain inputs to G, not completion proofs. */
export class PcOutboundReceiptClient {
  #artifactObservations = new WeakMap();
  constructor({controller,deviceId,timeoutMs=5000,pollIntervalMs=50}={}) {
    if(['enqueue','result','status'].some(method=>typeof controller?.[method]!=='function')
      || !/^[a-zA-Z0-9._-]{1,128}$/u.test(deviceId??'')
      || !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000
      || !Number.isInteger(pollIntervalMs)||pollIntervalMs<10||pollIntervalMs>timeoutMs)fail('CONFIG_INVALID');
    Object.assign(this,{controller,deviceId,timeoutMs,pollIntervalMs});
  }
  supportsDurableMissionEffects(){return false;}
  async receiveExecutionPacket(){fail('RECOVERY_READ_ONLY');}
  async rollbackTask(){fail('RECOVERY_READ_ONLY');}
  health(){return this.read('health',null);}
  taskResult(taskId){return this.read('task-result',taskId);}
  taskPublication(taskId){return this.read('task-publication',taskId);}
  async reconcileDurableArtifact({store,effectId,binding}={}) {
    binding=structuredClone(binding);
    if(!(store instanceof SqliteMissionStore))fail('DURABLE_STORE_REQUIRED');
    const assertBinding=()=>{
      const current=this.controller.scope(this.deviceId);
      if(binding?.deviceId!==this.deviceId||binding.deviceGeneration!==current.generation
        ||binding.certificateFingerprint!==current.certificateFingerprint)fail('DURABLE_DEVICE_MISMATCH');
      return store.getRemoteArtifactIntent(effectId,binding);
    };
    const contract=assertBinding(),effect=store.getEffect(effectId);
    if(!['uncertain','succeeded'].includes(effect.state))fail('DURABLE_EFFECT_NOT_RECONCILABLE');
    if(effect.provider_idempotency_key!==effect.operation_id)fail('DURABLE_EFFECT_BINDING_MISMATCH');
    const request=effect.intent.request;
    const reconciled=await this.reconcileOperationArtifact({operationId:effect.operation_id,taskId:request.taskId,action:request.action});
    if(binding.version==='remote-artifact-binding-v2'&&reconciled.artifact.rootScopeSha256!==binding.rootScopeSha256)fail('DURABLE_ROOT_SCOPE_MISMATCH');
    if(reconciled.deviceGeneration!==binding.deviceGeneration)fail('DURABLE_DEVICE_MISMATCH');
    if(effect.state==='succeeded'){
      const saved=effect.receipt,result=reconciled.receipt.executionResult;
      if(saved?.taskId!==request.taskId||saved.packetId!==result.packetId
        ||saved.evidenceId!==reconciled.receipt.evidence.evidenceId||saved.receiptRef!==`pc-packet:${result.packetId}`
        ||saved.source!=='trusted-local-pc-journal')fail('DURABLE_RECEIPT_MISMATCH');
    }
    assertBinding();
    const current=store.getEffect(effectId);
    if(current.request_sha256!==effect.request_sha256||current.intent_sha256!==effect.intent_sha256
      ||current.state!==effect.state||remoteArtifactDigest(current.receipt)!==remoteArtifactDigest(effect.receipt))fail('DURABLE_EFFECT_CHANGED');
    const observation={...reconciled,effectId,operationId:effect.operation_id,requestSha256:effect.request_sha256,contract};
    if(binding.version==='remote-artifact-binding-v2') {
      const controller=this.controller,deviceId=this.deviceId;
      const digest=value=>remoteArtifactDigest({...value,artifact:{...value.artifact,bytes:value.artifact.bytes.toString('base64')}});
      const fingerprint=digest(observation);
      this.#artifactObservations.set(observation,{consumed:false,validate:()=>{
        if(digest(observation)!==fingerprint)fail('ARTIFACT_PROOF_CHANGED');
        const device=controller.scope(deviceId);
        if(device.generation!==binding.deviceGeneration||device.certificateFingerprint!==binding.certificateFingerprint)fail('ARTIFACT_PROOF_INVALIDATED');
        store.getRemoteArtifactIntent(effectId,binding);
        const stored=store.getEffect(effectId);
        if(stored.request_sha256!==effect.request_sha256||stored.intent_sha256!==effect.intent_sha256
          ||stored.state!==effect.state||remoteArtifactDigest(stored.receipt)!==remoteArtifactDigest(effect.receipt))fail('ARTIFACT_PROOF_INVALIDATED');
        for(const context of [observation.receiptObservation,observation.artifact.observation]){
          const current=controller.result(context.requestId);
          if(!current?.observationCurrent||current.deviceId!==deviceId||current.deviceGeneration!==context.deviceGeneration
            ||current.authorityToken!==context.authorityToken)fail('ARTIFACT_PROOF_INVALIDATED');
        }
      }});
    }
    return observation;
  }
  /** Same-process verification handoff. JSON/clone/another client has no grant. */
  consumeDurableArtifactObservation(observation,{taskId,packetId,evidenceId}={}) {
    const grant=observation&&typeof observation==='object'?this.#artifactObservations.get(observation):null;
    if(!grant||grant.consumed)fail('ARTIFACT_PROOF_UNRECOGNIZED');
    grant.consumed=true;
    grant.validate();
    if(observation.receipt.taskId!==taskId||observation.artifact.packetId!==packetId
      ||observation.artifact.evidenceId!==evidenceId)fail('ARTIFACT_PROOF_BINDING_MISMATCH');
    grant.consumedSuccessfully=true;
    return {deviceId:observation.deviceId,operationId:observation.operationId,requestSha256:observation.requestSha256,
      target:observation.contract.target,size:observation.artifact.size,sha256:observation.artifact.sha256,
      rootScopeSha256:observation.artifact.rootScopeSha256,executionAuthority:false,verifiedCompletion:false};
  }
  /** Recheck a consumed observation's freshness; never grants a second G use. */
  assertConsumedArtifactObservationCurrent(observation) {
    const grant=observation&&typeof observation==='object'?this.#artifactObservations.get(observation):null;
    if(!grant?.consumedSuccessfully)fail('ARTIFACT_PROOF_UNRECOGNIZED');
    grant.validate();
  }
  async reconcileOperationArtifact(input={}) {
    input=structuredClone(input);
    const snapshot=await this.read('operation-receipt',input.taskId,
      {operationId:input.operationId,action:input.action},true);
    const record=snapshot.value;
    if(!record||record.operationId!==input.operationId||record.taskId!==input.taskId||record.state!=='succeeded'
      ||record.executionAuthority!==false||record.fingerprint!==executionPacketFingerprint({...input,requestedMode:'execute'}))fail('RECEIPT_BINDING_MISMATCH');
    const receipt=record.receipt,result=receipt?.executionResult;
    if(receipt?.taskId!==input.taskId||receipt?.status!=='COMPLETED'||result?.taskId!==input.taskId
      ||result?.executedBy?.toolName!==input.action?.toolName||!result?.packetId||!receipt?.evidence?.evidenceId
      ||result?.dryRun===true||receipt?.shadow?.dryRun===true
      ||!(result.success===true||(result.success!==false&&result.status==='success')))fail('RECEIPT_BINDING_MISMATCH');
    const artifact=await this.artifactForOperation(input,true);
    if(artifact.packetId!==result.packetId||artifact.evidenceId!==receipt.evidence.evidenceId
      ||artifact.observation.deviceGeneration!==snapshot.observation.deviceGeneration
      ||artifact.observation.authorityToken!==snapshot.observation.authorityToken)fail('ARTIFACT_BINDING_MISMATCH');
    // Recheck both observations after the second asynchronous read. A new
    // device generation/authority must not reconcile an older receipt.
    for(const context of [snapshot.observation,artifact.observation]) {
      const current=this.controller.result(context.requestId);
      if(!current?.observationCurrent||current.deviceId!==this.deviceId
        ||current.deviceGeneration!==context.deviceGeneration||current.authorityToken!==context.authorityToken)fail('RECONCILIATION_INVALIDATED');
    }
    return {receipt,artifact,receiptObservation:snapshot.observation,deviceId:this.deviceId,deviceGeneration:snapshot.observation.deviceGeneration,
      authorityToken:snapshot.observation.authorityToken,executionAuthority:false,verifiedCompletion:false};
  }
  async artifactForOperation({operationId,taskId,action}={},includeContext=false) {
    action=structuredClone(action);
    if(action?.toolName!=='filesystem.createTextFile'||typeof (action.arguments?.content??'')!=='string'
      ||Buffer.byteLength(action.arguments?.content??'','utf8')>65536)fail('ARTIFACT_BINDING_MISMATCH');
    const snapshot=await this.read('operation-artifact',taskId,{operationId,action},true),record=snapshot.value;
    if(!record||record.operationId!==operationId||record.taskId!==taskId||record.executionAuthority!==false
      ||record.verifiedCompletion!==false||record.encoding!=='base64'||typeof record.bytes!=='string'
      ||record.bytes.length>87384||!Number.isInteger(record.size)||record.size<0||record.size>65536
      ||typeof record.packetId!=='string'||!record.packetId||typeof record.evidenceId!=='string'||!record.evidenceId
      ||record.fingerprint!==executionPacketFingerprint({taskId,action,requestedMode:'execute'}))fail('ARTIFACT_BINDING_MISMATCH');
    const bytes=Buffer.from(record.bytes,'base64');
    if(bytes.toString('base64')!==record.bytes||bytes.length!==record.size
      ||createHash('sha256').update(bytes).digest('hex')!==record.sha256
      ||!bytes.equals(Buffer.from(action.arguments?.content??'','utf8')))fail('ARTIFACT_CONTENT_MISMATCH');
    return {...record,bytes:Buffer.from(bytes),...(includeContext?{observation:snapshot.observation}:{})};
  }
  async receiptForOperation({operationId,taskId,action}={}){
    const record=await this.read('operation-receipt',taskId,{operationId,action});
    if(record===null)return null;
    if(record.operationId!==operationId||record.taskId!==taskId||record.executionAuthority!==false
      ||record.fingerprint!==executionPacketFingerprint({taskId,action,requestedMode:'execute'}))fail('RECEIPT_BINDING_MISMATCH');
    return record.state==='succeeded'?record.receipt:null;
  }
  async read(operation,taskId,binding={},includeContext=false) {
    const requestId=`reconcile-${randomUUID()}`;
    const initial=this.controller.enqueue(this.deviceId,{requestId,operation,taskId,...binding});
    const deadline=performance.now()+this.timeoutMs;
    while(true){
      const status=this.controller.status(),device=status.devices.find(d=>d.deviceId===this.deviceId);
      if(!status.authorityActive||status.authorityToken!==initial.authorityToken||!device||['revoked','expired','paused'].includes(device.status)
        ||device.generation!==initial.deviceGeneration)fail('RECONCILIATION_INVALIDATED');
      const result=this.controller.result(requestId);
      if(!result||result.deviceId!==this.deviceId||result.deviceGeneration!==initial.deviceGeneration
        ||result.authorityToken!==initial.authorityToken||result.state==='invalidated')fail('RECONCILIATION_INVALIDATED');
      if(result.state==='observed'){
        if(!result.observationCurrent)fail('OBSERVATION_STALE');
        if(result.observation?.status!=='observed')fail('OBSERVATION_UNAVAILABLE');
        const value=structuredClone(result.observation.value);
        return includeContext?{value,observation:{requestId,deviceId:this.deviceId,
          deviceGeneration:result.deviceGeneration,authorityToken:result.authorityToken}}:value;
      }
      const remaining=deadline-performance.now();
      if(remaining<=0)fail('RECONCILIATION_TIMEOUT');
      await new Promise(resolve=>setTimeout(resolve,Math.min(this.pollIntervalMs,remaining)));
    }
  }
}
