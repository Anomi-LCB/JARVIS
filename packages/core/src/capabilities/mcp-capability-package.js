import {createHash} from 'node:crypto';
import {ActionType,ModuleId,TrustBoundary} from '../../../shared/src/types.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
export const mcpReceiptVerifierVersion='mcp-receipt-verifier-v2-planned-availability';

/** Called only by reviewed local installation code, never by MCP metadata. */
export function createMcpCapabilityPackage({manager,connectionId,tool,authorize,verifiers,intentBinding=null}) {
  if(intentBinding&&(typeof intentBinding.resolve!=='function'||typeof intentBinding.verify!=='function'||!/^[a-f0-9]{64}$/.test(intentBinding.fingerprint??'')))throw fail('A_MCP_INTENT_RESOLVER_REQUIRED');
  const readiness=manager.capabilityReadiness(connectionId,tool);
  if(!readiness.contractCurrent)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
  const binding=structuredClone(readiness.contract), bindingHash=hash(binding);
  const verifier=verifiers?.get(binding.verifierId);
  if(!verifier||typeof verifier.verify!=='function'||verifier.fingerprint!==binding.verifierFingerprint)throw fail('A_MCP_CAPABILITY_VERIFIER_REQUIRED');
  if(typeof authorize!=='function')throw fail('A_MCP_POLICY_REQUIRED');
  // Write/transaction adapters additionally need reconciliation and compensation contracts.
  if(binding.effect!=='read')throw fail('A_MCP_CAPABILITY_EFFECT_NOT_SUPPORTED');
  const toolName=`mcp.${connectionId}.${tool}`;
  const assertCurrent=()=>{
    const current=manager.capabilityReadiness(connectionId,tool);
    if(!current.contractCurrent||hash(current.contract)!==bindingHash)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
  };
  const verifyEvidence=evidence=>{
    try{
      assertCurrent();
      const proof=evidence?.adapterEvidence?.mcp;
      const receipt=manager.verificationReceipt(connectionId,proof?.requestId);
      const current=manager.capabilityReadiness(connectionId,tool);
      const valid=Boolean(receipt&&receipt.status==='verified'&&receipt.bindingHash===bindingHash
        &&current.toolAuthorized&&current.permissionRevision===(receipt.permissionRevision??null)
        &&receipt.verifierFingerprint===binding.verifierFingerprint&&proof.bindingHash===bindingHash);
      return {valid,reasons:valid?[]:['mcp-receipt-unverified'],scope:'tool-verifier-contract'};
    }catch{return {valid:false,reasons:['mcp-contract-or-receipt-unavailable'],scope:'tool-verifier-contract'};}
  };
  const verifierFingerprint=hash({version:mcpReceiptVerifierVersion,bindingHash,intentFingerprint:intentBinding?.fingerprint??null});
  Object.defineProperty(verifyEvidence,'verifierFingerprint',{value:verifierFingerprint});
  const resolveAvailability=async({phase,registry})=>{
    assertCurrent();
    let current=manager.capabilityReadiness(connectionId,tool),entry=manager.get(connectionId);
    if(!current.toolAuthorized)return {required:true,binding:null,permissionRevision:current.permissionRevision};
    // Discovery is a real read-only HTTP request, never a provider tool call.
    // Keep the actual probe timestamp rather than refreshing a stored manifest.
    if(phase==='dispatch'||!entry.checkedAt||Date.now()-Date.parse(entry.checkedAt)>=60000){
      await manager.probe(connectionId);assertCurrent();
      current=manager.capabilityReadiness(connectionId,tool);entry=manager.get(connectionId);
    }
    if(!current.toolAuthorized)return {required:true,binding:null,permissionRevision:current.permissionRevision};
    const availabilityBinding={capabilityId:toolName,providerId:`mcp-${connectionId}`,accountRef:null,deviceRef:null,scopes:[]};
    const codeVersion=registry?.availabilityFor(availabilityBinding).codeVersion;
    if(!codeVersion)throw fail('A_MCP_CAPABILITY_NOT_ACTIVATED');
    registry.recordAvailability({...availabilityBinding,codeVersion,permissionRevision:current.permissionRevision,
      observedAt:entry.checkedAt,accountStatus:'not-required',deviceStatus:'not-required',grantedScopes:[],
      verificationLevel:'live-probe',evidenceRef:`mcp-discovery-${hash({bindingHash,checkedAt:entry.checkedAt,permissionRevision:current.permissionRevision})}`});
    return {required:true,binding:availabilityBinding,permissionRevision:current.permissionRevision};
  };
  return {
    packageId:binding.packageId,version:binding.version,
    skill:{skillId:`mcp_${connectionId}_${tool}`,version:binding.version,label:`MCP ${tool}`,
      module:ModuleId.PC_AGENT,actionType:ActionType.CAPABILITY_QUERY,toolName,
      capability:{allowedModes:['shadow','execute'],requiresApproval:true,externalTransfer:true,externalNetwork:true,reversible:false},
      safety:{trustBoundary:TrustBoundary.USER_COMMAND},adapterContract:{preview:true,execute:true,rollback:false,evidence:['mcp']}},
    resolveIntent:intentBinding?.resolve??null,
    argumentSchema:{type:'object',fields:['arguments','requestId','expectedText',...(intentBinding?['objective']:[])]},
    evidenceSchema:{required:['adapterEvidence.mcp'],adapterEvidence:['mcp']},
    verifierId:`${binding.verifierId}.receipt`,verifierFingerprint,verifyEvidence,
    createAdapter:()=>({
      contract:{toolName,modes:['shadow','execute'],evidence:['mcp'],effectScope:'external',intentBinding,
        requiresAvailabilityBinding:true,resolveAvailability,readOnly:true,mutatesSystem:false,rollback:false},
      shadow(){assertCurrent();return {mode:'shadow',expectedChangesCount:0,warnings:['MCP preview performs no provider call; execution policy and independent verification remain required.']};},
      async execute(args,packet,{assertAccess=null}={}){
        assertCurrent();
        if(!args||Object.keys(args).some(key=>!['arguments','requestId','expectedText','rawText',...(intentBinding?['objective']:[])].includes(key)))throw fail('A_MCP_CALL_INVALID');
        if(intentBinding&&!intentBinding.verify({...args,toolName}))throw fail('A_MCP_INTENT_ARGUMENT_MISMATCH');
        if(args.rawText!==undefined&&(typeof args.rawText!=='string'||args.rawText.length>16000))throw fail('A_MCP_CALL_INVALID');
        const {objective,rawText,...callArgs}=args;
        const guardedAuthorize=input=>{
          const assertLive=()=>{try{
            if(packet?.taskId&&typeof assertAccess!=='function')throw fail('A_MCP_LOCAL_EXECUTION_FENCE_REQUIRED');
            assertAccess?.();
          }catch{throw fail('A_MCP_LOCAL_EXECUTION_AUTHORITY_CHANGED');}};
          assertLive();const decision=authorize(input);assertLive();return decision;
        };
        const result=await manager.callVerifiedCapability(connectionId,{...callArgs,tool},guardedAuthorize,{verifiers});
        assertCurrent();
        if(result.businessOutcomeVerified!==true)throw fail('A_MCP_CAPABILITY_VERIFICATION_FAILED');
        return {outputPaths:[],changedItems:[],files:[],readOnly:true,rollbackAvailable:false,evidence:{mcp:{requestId:args.requestId,bindingHash}},adapterEvidence:{mcp:{requestId:args.requestId,bindingHash}},
          verificationScope:'tool-verifier-contract'};
      }
    })
  };
}
