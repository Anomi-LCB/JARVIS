import { createHash } from 'node:crypto';
import {pcLocalDenialNextAction} from '../../../shared/src/pc-local-denial.js';
import { performance } from 'node:perf_hooks';
import { PcOutboundCommandMailbox } from './pc-outbound-command-mailbox.js';
import { PcOutboundReceiptClient } from './pc-outbound-receipt-client.js';
import { createRemoteArtifactBinding, remoteArtifactDigest } from '../mission/remote-artifact-contract.js';
import { executionPacketFingerprint } from '../../../shared/src/execution-packet-fingerprint.js';

const fail=(code,nextAction=null,localScopeReason=null)=>{throw Object.assign(new Error(`A_PC_COMMAND_${code}`),{code:`A_PC_COMMAND_${code}`,executionUncertain:true,...(nextAction?{nextAction}:{}),...(localScopeReason?{localScopeReason}:{})});};
/** Core-side opt-in producer. Delivery observations are not G completion proofs.
 * Fixed operation/kind IDs survive restart; uncertain delivery is never requeued.
 * Coordinator integration must additionally bind its durable effect and authority.
 */
export class PcOutboundExecutionClient {
  #commands; #deviceId; #reader; #timeoutMs; #pollIntervalMs; #binding; #requireMutationFence;
  constructor({commands,deviceId,receiptClient=null,artifactBinding=null,requireMutationFence=false,timeoutMs=5000,pollIntervalMs=25}={}){
    if(typeof requireMutationFence!=='boolean'||!(commands instanceof PcOutboundCommandMailbox)||!/^[a-zA-Z0-9._-]{1,128}$/u.test(deviceId??'')
      ||(receiptClient!==null&&(!(receiptClient instanceof PcOutboundReceiptClient)||receiptClient.deviceId!==deviceId))
      ||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000
      ||!Number.isInteger(pollIntervalMs)||pollIntervalMs<10||pollIntervalMs>timeoutMs)fail('CLIENT_CONFIG_INVALID');
    this.#commands=commands;this.#deviceId=deviceId;this.#reader=receiptClient;
    if(artifactBinding!==null){
      const {version,...input}=artifactBinding;const canonical=createRemoteArtifactBinding(input);
      if(version!=='remote-artifact-binding-v2'||canonical.deviceId!==deviceId||remoteArtifactDigest(canonical)!==remoteArtifactDigest(artifactBinding)
        ||!receiptClient||!commands.executionFenceRequired)fail('CLIENT_BINDING_INVALID');
      this.#binding=canonical;
    }
    this.#requireMutationFence=requireMutationFence;this.#timeoutMs=timeoutMs;this.#pollIntervalMs=pollIntervalMs;
  }
  supportsDurableMissionEffects(){return !!this.#binding&&!!this.#reader&&this.#commands.executionFenceRequired;}
  supportsCoreAuthorityFencing(){return this.supportsDurableMissionEffects()&&this.#requireMutationFence;}
  matchesRecovery({client,binding}={}){return this.supportsDurableMissionEffects()&&client===this.#reader&&remoteArtifactDigest(binding)===remoteArtifactDigest(this.#binding);}
  executorBinding(){if(!this.supportsDurableMissionEffects())fail('CLIENT_BINDING_REQUIRED');return {kind:'pc-outbound-command',bindingSha256:remoteArtifactDigest(this.#binding),...(this.#requireMutationFence?{mutationFenceRequired:true}:{})};}
  health(){if(!this.#reader)fail('RECONCILIATION_REQUIRED');return this.#reader.health();}
  taskResult(taskId){if(!this.#reader)fail('RECONCILIATION_REQUIRED');return this.#reader.taskResult(taskId);}
  taskPublication(taskId){if(!this.#reader)fail('RECONCILIATION_REQUIRED');return this.#reader.taskPublication(taskId);}
  async #send(kind,input,dispatchGuard=null){
    const packet=kind==='cancel'?null:input.packet;
    const taskId=packet?.taskId??input.taskId,operationId=packet?.idempotencyKey??input.operationId,action=packet?.action??input.action;
    if(this.#binding){const device=this.#commands.scope(this.#deviceId,taskId);
      if(device.generation!==this.#binding.deviceGeneration||device.fingerprint!==this.#binding.certificateFingerprint)fail('CLIENT_DEVICE_CHANGED');}
    const requestId=`command-${createHash('sha256').update(JSON.stringify([this.#deviceId,operationId,kind])).digest('hex')}`;
    this.#commands.enqueue({requestId,deviceId:this.#deviceId,kind,taskId,operationId,action,body:input,dispatchGuard});
    const deadline=performance.now()+this.#timeoutMs;
    while(true){
      const status=this.#commands.status(requestId);
      if(!status||status.executionAuthority!==false||['invalidated','uncertain'].includes(status.state))fail('DELIVERY_UNRESOLVED');
      if(status.state==='observed'){
        const result=status.result;
        const nextAction=pcLocalDenialNextAction(result?.reason);
        if(result?.status==='unavailable'&&nextAction&&result.executionAuthority===false&&result.verifiedCompletion===false)fail('LOCAL_SCOPE_DENIED',nextAction,result.reason);
        if(result?.status!=='observed'||result.executionAuthority!==false||result.verifiedCompletion!==false)fail('DELIVERY_UNRESOLVED');
        return structuredClone(result.value);
      }
      if(!['queued','leased'].includes(status.state))fail('DELIVERY_UNRESOLVED');
      const remaining=deadline-performance.now();if(remaining<=0)fail('DELIVERY_TIMEOUT');
      await new Promise(resolve=>setTimeout(resolve,Math.min(this.#pollIntervalMs,remaining)));
    }
  }
  prepareOperation(packet){return this.#send('prepare',{packet:structuredClone(packet)});}
  cancelOperation(input){return this.#send('cancel',structuredClone(input));}
  async receiveExecutionPacket(packet,{dryRun=false,beforeLocalExecute=null}={}){
    if(dryRun||typeof beforeLocalExecute!=='function')fail('EFFECT_HOOK_REQUIRED');
    packet=structuredClone(packet);
    const fence=await beforeLocalExecute(packet);if(typeof fence!=='function')fail('EFFECT_FENCE_REQUIRED');
    await fence();const prepared=await this.prepareOperation(packet);
    const fingerprint=executionPacketFingerprint({taskId:packet.taskId,action:packet.action,requestedMode:'execute'});
    if(prepared?.operationId!==packet.idempotencyKey||prepared.taskId!==packet.taskId||prepared.fingerprint!==fingerprint)fail('PREPARE_BINDING_MISMATCH');
    try{await fence();}catch(cause){
      try{
        const cancellation=await this.cancelOperation({operationId:packet.idempotencyKey,taskId:packet.taskId,action:packet.action});
        if(cancellation?.state==='cancelled'&&cancellation.cancellationConfirmed===true&&cancellation.operationId===packet.idempotencyKey
          &&cancellation.taskId===packet.taskId&&cancellation.fingerprint===fingerprint)await fence.onRemoteCancellation?.(cancellation);
      }catch{/* Uncertain cancellation requires journal reconciliation. */}
      throw cause;
    }
    if(prepared.state==='succeeded')return prepared.receipt;
    if(prepared.state!=='prepared'||typeof prepared.ticket!=='string'||!prepared.ticket||!Number.isSafeInteger(prepared.generation)||prepared.generation<1)fail('PREPARE_UNRESOLVED');
    return this.#send('execute',{packet,ticket:prepared.ticket,generation:prepared.generation,...(this.#requireMutationFence?{mutationFenceRequired:true}:{})},fence);
  }
  async readOperation(input){
    if(!this.#reader)fail('RECONCILIATION_REQUIRED');
    const record=await this.#reader.read('operation-receipt',input.taskId,{operationId:input.operationId,action:input.action});
    if(record!==null&&(record?.operationId!==input.operationId||record.taskId!==input.taskId||record.executionAuthority!==false
      ||record.fingerprint!==executionPacketFingerprint({...input,requestedMode:'execute'})))fail('RECEIPT_BINDING_MISMATCH');
    return record;
  }
  async receiptForOperation(input){const record=await this.readOperation(input);return record?.state==='succeeded'?record.receipt:null;}
  async rollbackTask(){fail('ROLLBACK_UNSUPPORTED');}
  async resumeWorkflowPublication(){fail('WORKFLOW_UNSUPPORTED');}
}
