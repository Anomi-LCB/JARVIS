import {assessMissionGoalCompletionCoverage,verifiedMissionAction} from './mission-requirement-coverage.js';
import {createHash} from 'node:crypto';

function canonical(value) {
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}

// Recover proof only from the original task and its fingerprint-bound PC receipt.
// An available but invalid memory proof must never be replaced by another proof.
function executionEvidence(action,pcAgent,coreFacade,evidenceId) {
 const memory=pcAgent?.taskEvidence?.(action.taskId);
 if(memory?.evidenceId)return memory;
 if(memory?.error?.code!=='B_EVIDENCE_NOT_FOUND')return null;
 const dispatch=action.operation?.dispatch;
 const task=coreFacade?.getTask?.(action.taskId);
 if(!dispatch||dispatch.taskId!==action.taskId||(task&&task.taskId!==action.taskId))return null;
 // A present task remains authoritative; only an absent task uses the
 // checkpointed proof snapshot. Neither route authorizes provider execution.
 const original=task?task.plan?.action:dispatch.executionProofAction;
 if(!original||createHash('sha256').update(JSON.stringify(canonical(original))).digest('hex')!==dispatch.actionSha256)return null;
 const receipt=pcAgent?.receiptForTaskExecution?.({taskId:action.taskId,action:original,evidenceId});
 return receipt?.evidence??null;
}

/** Criterion proof uses current installed intent and durable receipt, not model praise. */
export function verifyMcpMissionCriterion({mission,criterion,evidenceActionIds,pcAgent,packageRegistry,coreFacade}) {
 const all=(mission.waves??[]).flatMap(wave=>wave.actions);
 if(criterion.verificationSpec||criterion.statement!==mission.objective||!all.some(action=>/^mcp\./u.test(action.actualToolName??action.expectedToolName??'')))return {applicable:false};
 const selected=new Set(evidenceActionIds);
 const actions=all.filter(action=>selected.has(action.actionId)&&/^mcp\./u.test(action.actualToolName??''));
 for(const action of actions){
  if(!verifiedMissionAction(mission,action))continue;
  const observation=mission.observations.find(item=>item.observationId===action.observationId);
  const evidence=executionEvidence(action,pcAgent,coreFacade,observation?.evidenceId);
  if(!evidence||evidence.evidenceId!==observation?.evidenceId||evidence.taskId!==action.taskId||evidence.toolName!==action.actualToolName
   ||evidence.adapterEvidence?.mcp?.requestId!==action.operation?.dispatch?.arguments?.requestId)continue;
  const coverage=assessMissionGoalCompletionCoverage({mission:{...mission,waves:mission.waves.map(wave=>({...wave,actions:wave.actions.filter(item=>item.actionId===action.actionId)}))},
   installedIntentBindingResolver:tool=>pcAgent.registry?.contractFor?.(tool)?.intentBinding??null});
  if(!coverage.allowed||coverage.status!=='installed-mcp-source-and-result-coverage')continue;
  const verification=packageRegistry?.verify(action.actualToolName,evidence);
  if(verification?.valid!==true||verification.reasons?.length!==0)continue;
  return {applicable:true,passed:true,status:'passed',reasons:[],checks:[{checkId:'mcp_current_source_and_receipt_verified',passed:true,
   actionId:action.actionId,evidenceId:evidence.evidenceId,requestId:evidence.adapterEvidence.mcp.requestId,
   verifierId:verification.verifierId,packageDigest:verification.packageDigest}]};
 }
 return {applicable:true,passed:false,status:'unverified',reasons:['mcp-current-source-or-receipt-unverified'],checks:[]};
}
