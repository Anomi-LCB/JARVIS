import { createHash, randomUUID } from 'node:crypto';
import { PcOutboundReceiptClient } from '../../../packages/core/src/client/pc-outbound-receipt-client.js';
import { createRemoteArtifactIntent,remoteArtifactDigest } from '../../../packages/core/src/mission/remote-artifact-contract.js';

/** Same-Core-process G verifier. Never accepts serialized observation grants. */
export class RemoteArtifactVerifier {
  #client;
  constructor({client}={}) {
    if(!(client instanceof PcOutboundReceiptClient))throw new TypeError('G_REMOTE_ARTIFACT_CLIENT_REQUIRED');
    this.#client=client;
  }
  verify({observation,action,taskId}={}) {
    const checks=[];
    const check=(name,pass)=>{checks.push({checkName:name,status:pass?'passed':'failed',severity:'high'});if(!pass)throw new Error(name);};
    try {
      check('remote_scope_v2',observation?.contract?.binding?.version==='remote-artifact-binding-v2');
      const expected=createRemoteArtifactIntent({binding:observation.contract.binding,taskId,
        operationId:observation.operationId,action});
      check('original_action_bound',remoteArtifactDigest(expected)===remoteArtifactDigest(observation.contract));
      const receipt=observation.receipt,result=receipt?.executionResult,evidence=receipt?.evidence;
      check('successful_original_receipt',receipt?.taskId===taskId&&receipt.status==='COMPLETED'
        &&result?.taskId===taskId&&result.executedBy?.toolName==='filesystem.createTextFile'
        &&(result.success===true||(result.success!==false&&result.status==='success'))
        &&result.dryRun!==true&&receipt.shadow?.dryRun!==true);
      check('single_output',Array.isArray(result.outputPaths)&&result.outputPaths.length===1);
      const published=createRemoteArtifactIntent({binding:expected.binding,taskId,operationId:expected.operationId,
        action:{...action,arguments:{...action.arguments,path:result.outputPaths[0]}}});
      check('requested_target',published.target===expected.target);
      const measured=this.#client.consumeDurableArtifactObservation(observation,{taskId,packetId:result.packetId,evidenceId:evidence?.evidenceId});
      check('current_private_observation',true);
      const hash=createHash('sha256').update(action.arguments?.content??'','utf8').digest('hex');
      check('original_content',measured.sha256===hash&&measured.size===Buffer.byteLength(action.arguments?.content??'','utf8'));
      check('target_and_scope',measured.target===expected.target&&measured.rootScopeSha256===expected.binding.rootScopeSha256);
      check('single_file_evidence',Array.isArray(evidence?.files)&&evidence.files.length===1);
      const file=evidence.files[0],fileTarget=createRemoteArtifactIntent({binding:expected.binding,taskId,
        operationId:expected.operationId,action:{...action,arguments:{...action.arguments,path:file.path}}});
      // Existing B collector omits exists. Current existence is independently
      // established by the provisioned descriptor read, never by this receipt.
      check('receipt_file_consistency',(file.exists===undefined||file.exists===true)&&fileTarget.target===expected.target
        &&file.sha256===measured.sha256&&file.size===measured.size);
    } catch(error) {
      if(!checks.some(item=>item.status==='failed'))checks.push({checkName:'current_private_observation',status:'failed',severity:'high',causeCode:error.code??'G_REMOTE_ARTIFACT_INVALID'});
    }
    return {taskId,verificationId:`g-remote-artifact-${randomUUID()}`,status:checks.some(item=>item.status==='failed')?'failed':'passed',
      checks,scope:'same-process-remote-filesystem.createTextFile',executionAuthority:false,missionCompletion:false};
  }
}
