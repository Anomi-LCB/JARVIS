import { PcAgentRuntime } from './pc-agent-runtime.js';
import { PcAgentExecutionClient } from '../../../packages/core/src/client/pc-agent-execution-client.js';
import { remoteArtifactDigest } from '../../../packages/core/src/mission/remote-artifact-contract.js';
import { PcLocalTaskScope } from './pc-local-task-scope.js';

const fail=code=>{throw new Error(`B_PC_COMMAND_${code}`);};
const terminalAck=error=>['A_PC_COMMAND_LEASE_INVALID','A_PC_COMMAND_SCOPE_CHANGED','A_PC_COMMAND_AUTHORITY_CHANGED','A_PC_COMMAND_EXECUTION_SCOPE_DENIED','A_PC_OUTBOUND_DEVICE_DENIED'].includes(error?.code??error?.message);

/** Opt-in PC-side delivery adapter. Only the existing loopback B operations
 * enforce execution. The read observer is unchanged; no arbitrary URL or shell.
 */
export function createPcOutboundCommandDispatcher({transport,pcClient,pcAgent=null,taskScope=null,allowedTaskIds=[],clock=Date.now}={}){
  if(!transport?.exchange||!(pcClient instanceof PcAgentExecutionClient)||!pcClient.supportsDurableMissionEffects()
    ||(pcAgent!==null&&!(pcAgent instanceof PcAgentRuntime))
    ||(taskScope!==null&&(!(taskScope instanceof PcLocalTaskScope)||!(pcAgent instanceof PcAgentRuntime)))
    ||!Array.isArray(allowedTaskIds)||new Set(allowedTaskIds).size!==allowedTaskIds.length)fail('CONFIG_INVALID');
  const selected=new Set(allowedTaskIds);let busy=false,pending=null,highWater=0;
  const now=()=>{const time=clock();if(!Number.isSafeInteger(time)||time<0)fail('CLOCK_INVALID');highWater=Math.max(highWater,time);return highWater;};
  return {
    async tick(){
      if(busy)return {status:'busy'};busy=true;
      try{
        // ACK retries contain the same value; they never repeat a B call.
        if(pending){try{await transport.exchange('submit',pending);pending=null;}catch(error){if(terminalAck(error))pending=null;throw error;}}
        const received=await transport.exchange('pull',{});if(!received)return {status:'idle'};
        const command=structuredClone(received);
        if(!['prepare','execute','cancel'].includes(command.kind)
          ||command.executionAuthority!==false||!command.requestId||!command.lease
          ||!Number.isSafeInteger(command.expiresAt)||command.expiresAt<=now())fail('DELIVERY_INVALID');
        let localLease=null;
        const validate=async()=>{
          if(localLease)taskScope.assertCurrent(command.taskId,localLease);
          const permit=await transport.exchange('validate',{requestId:command.requestId,lease:command.lease});
        if(permit?.allowed!==true||permit.executionAuthority!==false||permit.requestId!==command.requestId
          ||permit.taskId!==command.taskId||permit.operationId!==command.operationId||permit.kind!==command.kind
          ||permit.deviceGeneration!==command.deviceGeneration||permit.authorityToken!==command.authorityToken
          ||permit.bodySha256!==remoteArtifactDigest(command.body)||permit.expiresAt!==command.expiresAt||permit.expiresAt<=now())fail('DELIVERY_INVALID');
          if(localLease)taskScope.assertCurrent(command.taskId,localLease);
          return permit;
        };
        await validate();
        let result;
        let localAllowed=taskScope?.catalogEnabled?taskScope.catalog().allowedCommandTaskIds.includes(command.taskId):selected.has(command.taskId);
        if(taskScope){
          try{localLease=taskScope.capture(command.taskId);}
          catch(error){if(!['B_PC_LOCAL_SCOPE_DENIED','B_PC_LOCAL_SCOPE_EXPIRED'].includes(error?.code))throw error;localAllowed=false;}
        }
        if(!localAllowed)result={status:'unavailable',reason:taskScope?.catalogEnabled?
          taskScope.commandReadiness(command.taskId).reason??'B_PC_COMMAND_LOCAL_SCOPE_DENIED':'B_PC_COMMAND_LOCAL_SCOPE_DENIED',executionAuthority:false,verifiedCompletion:false};
        else try{
          if(taskScope&&command.kind==='execute'&&command.body.mutationFenceRequired!==true)fail('MUTATION_FENCE_REQUIRED');
          const value=command.kind==='prepare'?await pcClient.prepareOperation(command.body.packet)
            :command.kind==='execute'?pcAgent
              ?await pcAgent.executeRemoteOperation(command.body.packet,{ticket:command.body.ticket,generation:command.body.generation,beforeRemoteMutation:validate})
              :command.body.mutationFenceRequired===true?fail('MUTATION_FENCE_UNAVAILABLE')
              :await pcClient.request('/operations/execute',{method:'POST',body:command.body})
            :await pcClient.cancelOperation(command.body);
          result={status:'observed',value,executionAuthority:false,verifiedCompletion:false};
        }catch(error){
          const code=/^[A-Z][A-Z0-9_]{1,160}$/u.test(error?.code??'')?error.code:'B_PC_COMMAND_LOCAL_UNAVAILABLE';
          // An execute response failure is not evidence of no file effect.
          result={status:command.kind==='execute'?'uncertain':'unavailable',reason:code,executionAuthority:false,verifiedCompletion:false};
        }
        pending={requestId:command.requestId,lease:command.lease,result};
        try{await transport.exchange('submit',pending);pending=null;}catch(error){if(terminalAck(error))pending=null;throw error;}
        return {status:'observed',kind:command.kind,verifiedCompletion:false};
      }finally{busy=false;}
    }
  };
}
