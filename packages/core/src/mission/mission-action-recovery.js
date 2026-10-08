import { performance } from 'node:perf_hooks';
import {supportsScopedRecoveryTool} from '../../../shared/src/scoped-recovery-verification.js';
import { createHash } from 'node:crypto';
import {hancomActualOutputPaths} from '../../../../apps/pc-agent/src/adapters/hwpx/artifact-contract.js';
import {validateCardPublicationResult} from '../../../../apps/pc-agent/src/adapters/visual/artifact-contract.js';
import {validateDocumentEditResult} from '../../../../apps/pc-agent/src/adapters/excel/edit-contract.js';
import {validateWeatherPublicationResult} from '../../../../apps/pc-agent/src/adapters/weather/publication-contract.js';
import {validateMacroPublicationResult} from '../../../shared/src/macro-publication-contract.js';
import { realpathSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TaskStatus } from '../../../shared/src/types.js';
import { createRecoveredMemoryScopeAuthority } from './recovered-memory-scope.js';
import { validateWorkflowSpec } from './workflow-ir.js';
import { RemoteArtifactVerifier } from '../../../../apps/verification/src/remote-artifact-verifier.js';
import { WorkflowCognitionIntentStore } from './workflow-cognition-intent-store.js';
import {xlsxArchiveContentSha256,zipMemberEvidence} from './xlsx-cell-evidence.js';

const recoveredMemoryScopes = createRecoveredMemoryScopeAuthority();
export const getRecoveredMemoryScopeProof = recovered => recoveredMemoryScopes.proofFor(recovered);
export const consumeRecoveredMemoryScopeProof = (proof, input) => recoveredMemoryScopes.consume(proof, input);

const version = 'a-mission-operation-v1';
const minimumReadChunkBytes = 64 * 1024;
const maximumReadChunkBytes = 1024 * 1024;
export const DEFAULT_MISSION_RECOVERY_READ_CHUNK_BYTES = 64 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(sortValue(value));
const rootsHash = (roots) => hash(canonical(roots.map((root) => resolve(root)).sort()));
const resolvedRootsHash = (roots) => hash(canonical(roots.map(projectedRealPath).sort()));
const requestHash = (action) => hash(canonical({
  command: action.command,
  expectedToolName: action.expectedToolName ?? null,
  arguments: action.arguments ?? null
}));

const cognitionRecoveries=new WeakMap();
function bindCognitionRecovery(recovered,{request,requestSha256,workspaceRoot,clock=()=>new Date()}){
 if(hash(canonical(request))!==requestSha256)return;
 cognitionRecoveries.set(recovered,{request:structuredClone(request),requestSha256,workspaceRoot,
  snapshot:hash(canonical({execution:recovered.execution,verification:recovered.verification,packetId:recovered.packetId})),
  expires:performance.now()+30000,issuedAt:clock().getTime(),clock});
}
// Only a live successful durable recovery can supply this observation; JSON copies cannot.
export function getRecoveredCognitionObservation(recovered){
 const proof=recovered&&cognitionRecoveries.get(recovered);
 if(!proof||performance.now()>=proof.expires||proof.clock().getTime()<proof.issuedAt||proof.clock().getTime()>=proof.issuedAt+30000
  ||proof.snapshot!==hash(canonical({execution:recovered.execution,verification:recovered.verification,packetId:recovered.packetId})))return null;
 return {...proof,request:structuredClone(proof.request)};
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function ensureMissionActionOperation(missionId, action, allowedRoots) {
  action.operation ??= {
    version,
    operationId: `mission_op_${hash(`${missionId}:${action.actionId}`).slice(0, 32)}`,
    requestSha256: requestHash(action),
    allowedRootsSha256: rootsHash(allowedRoots),
    resolvedAllowedRootsSha256: resolvedRootsHash(allowedRoots),
    dispatch: null
  };
  return action.operation;
}

export function checkpointMissionActionDispatch(action, task, worker, profile, dispatchedAt) {
  action.operation.dispatch = {
    taskId: task.taskId,
    toolName: task.plan?.action?.toolName ?? null,
    actionType: task.plan?.action?.actionType ?? null,
    actionSha256: hash(canonical(task.plan?.action ?? null)),
    arguments: structuredClone(task.plan?.action?.arguments ?? {}),
    ...(task.plan?.action?.toolName==='workflow.execute' && task.plan.action.arguments?.spec
      ? { workflowSpecSource: JSON.stringify(task.plan.action.arguments.spec) } : {}),
    // Proof-only snapshot: Core tasks are volatile across process restart.
    // This is not a replay instruction or an authorization grant.
    ...(/^mcp\./u.test(task.plan?.action?.toolName ?? '')
      ? { executionProofAction: structuredClone(task.plan.action) } : {}),
    actionNodeCount: Math.max(1, worker.actionNodesForTask?.(task)?.length ?? 1),
    profile: structuredClone(profile),
    dispatchedAt
  };
}

function blocked(code, message, details = {}) {
  return { status: 'blocked', error: { code: `A_MISSION_RECOVERY_${code}`, message, ...details } };
}

export function createMissionActionRecovery({ readChunkBytes = DEFAULT_MISSION_RECOVERY_READ_CHUNK_BYTES, onFileRead = null } = {}) {
  if (!Number.isInteger(readChunkBytes) || readChunkBytes < minimumReadChunkBytes || readChunkBytes > maximumReadChunkBytes) {
    throw Object.assign(new TypeError('Recovery read chunks must be an integer from 64 KiB to 1 MiB.'), { code: 'A_MISSION_RECOVERY_INVALID_READ_CHUNK' });
  }
  if (onFileRead !== null && typeof onFileRead !== 'function') {
    throw Object.assign(new TypeError('onFileRead must be a function or null.'), { code: 'A_MISSION_RECOVERY_INVALID_READ_OBSERVER' });
  }
  return args => recoverMissionActionWithOptions(args, { readChunkBytes, onFileRead });
}

// Operational recovery retains the original 64 KiB read size. Larger buffers are
// opt-in evaluation candidates and do not cache or skip any verification pass.
export const recoverMissionAction = createMissionActionRecovery({ readChunkBytes: DEFAULT_MISSION_RECOVERY_READ_CHUNK_BYTES });

// A durable dispatch checkpoint means the effect may have happened. Absence of a
// receipt is never proof that it is safe to send that operation a second time.
async function recoverMissionActionWithOptions({ missionId, action, allowedRoots, coreFacade, worker, pcAgent, durableEffect = null, remoteArtifactRecovery = null, workflowCognitionIntents = null, observationOnly = false, beforeResultRead = null }, readOptions) {
  if (beforeResultRead !== null && typeof beforeResultRead !== 'function') return blocked('RESULT_GUARD_INVALID', 'Result read permission guard is unavailable.');
  readOptions = { ...readOptions, beforeResultRead };
  if (remoteArtifactRecovery && !durableEffect) {
    return blocked('REMOTE_SCOPE_REQUIRED', 'Remote recovery requires the original durable SQL effect.');
  }
  const operation = action.operation;
  const expectedId = `mission_op_${hash(`${missionId}:${action.actionId}`).slice(0, 32)}`;
  if (!operation || operation.version !== version || operation.operationId !== expectedId
    || operation.requestSha256 !== requestHash(action)) {
    return blocked('IDENTITY_MISMATCH', 'The persisted action identity is missing or has changed.');
  }
  if (operation.allowedRootsSha256 !== rootsHash(allowedRoots)) {
    return blocked('ROOTS_CHANGED', 'Allowed workspace roots changed after this operation was prepared.');
  }
  try {
    if (operation.resolvedAllowedRootsSha256 !== resolvedRootsHash(allowedRoots)) {
      return blocked('ROOTS_CHANGED', 'A workspace root now resolves to a different filesystem location.');
    }
  } catch (error) {
    return blocked('ROOTS_UNAVAILABLE', 'The original workspace roots cannot be verified.', { causeCode: error?.code ?? null });
  }
  const dispatch = operation.dispatch;
  if (!dispatch && action.attempts === 0) return { status: 'not_dispatched' };
  if (beforeResultRead && (remoteArtifactRecovery || !supportsScopedRecoveryTool(dispatch?.toolName))) {
    return blocked('RESULT_SCOPE_UNSUPPORTED', 'This executor or format does not have a reviewed per-file result read boundary.');
  }
  if (!dispatch || dispatch.taskId !== action.taskId || dispatch.toolName !== action.actualToolName) {
    return blocked('IDENTITY_MISMATCH', 'The original task dispatch cannot be bound to this action.');
  }
  if (dispatch.actionNodeCount !== 1 || dispatch.profile?.externalTransfer === true
    || ['email.send', 'desktop.control', 'shell.execute'].includes(dispatch.toolName)) {
    return blocked('EFFECT_CONFIRMATION_REQUIRED', 'This interrupted operation needs effect-specific confirmation before it can resume.');
  }
  const task = coreFacade.getTask(action.taskId);
  if (task && (task.taskId !== dispatch.taskId || hash(canonical(task.plan?.action ?? null)) !== dispatch.actionSha256)) {
    return blocked('IDENTITY_MISMATCH', 'The current task does not match the persisted dispatched action.');
  }
  let execution;
  let source;
  const executor = worker.pcAgent ?? pcAgent;
  if (durableEffect) {
    const request = durableEffect.intent?.request;
    if (durableEffect.mission_id !== missionId || durableEffect.operation_id !== operation.operationId
      || durableEffect.provider_idempotency_key !== operation.operationId
      || !['uncertain', 'succeeded'].includes(durableEffect.state)
      || (action.effect?.effectId && action.effect.effectId !== durableEffect.effect_id)
      || !request?.action || request.taskId !== dispatch.taskId || request.toolName !== dispatch.toolName
      || request.plannedRequestSha256 !== operation.requestSha256
      || request.allowedRootsSha256 !== operation.allowedRootsSha256
      || request.resolvedAllowedRootsSha256 !== operation.resolvedAllowedRootsSha256
      || hash(canonical(request)) !== durableEffect.request_sha256
      || request.actionSha256 !== dispatch.actionSha256 || hash(canonical(request.action)) !== dispatch.actionSha256
      || canonical(request.arguments) !== canonical(dispatch.arguments)
      || canonical(request.action.arguments) !== canonical(dispatch.arguments)) {
      return blocked('RECEIPT_DISPATCH_MISMATCH', 'The SQL intent does not bind the original action and dispatch.');
    }
    if (dispatch.toolName === 'workflow.execute') {
      // A SQL effect supplements the original cognition intent; it must not
      // silently bypass a missing or tampered context record on recovery.
      try {
        const original = workflowCognitionIntents?.load(missionId, action)?.request;
        const metadata = request.taskRequest?.metadata ?? {};
        const expected = { taskId: request.taskId, toolName: request.toolName,
          cognitionPlanId: request.cognitionPlanId, cognitionApprovalId: request.cognitionApprovalId,
          taskRequest: { requestId: request.taskRequest?.requestId, userId: request.taskRequest?.userId,
            metadata: { conversationId: metadata.conversationId ?? null, doNotRemember: metadata.doNotRemember === true,
              learningFlags: { doNotRemember: metadata.learningFlags?.doNotRemember === true } } } };
        if (!original || canonical(original) !== canonical(expected)) throw new Error('context-mismatch');
      } catch {
        return blocked('WORKFLOW_COGNITION_INTENT_INVALID', 'The original workflow context is missing or does not match its SQL effect.');
      }
    }
    // Explicitly provisioned remote scope only. Core workspace identity above is
    // retained separately from the PC's OS-specific, physically pinned roots.
    // The remote client re-reads SQL and current enrollment; a caller-supplied
    // receipt, verifier or serialized observation cannot bypass those checks.
    if (request.remoteArtifactIntent || remoteArtifactRecovery) {
      if (!remoteArtifactRecovery || !request.remoteArtifactIntent
        || request.remoteArtifactIntent.binding?.version !== 'remote-artifact-binding-v2'
        || dispatch.toolName !== 'filesystem.createTextFile') {
        return blocked('REMOTE_SCOPE_REQUIRED', 'Remote recovery requires a provisioned v2 artifact scope.');
      }
      try {
        const { client, store, binding } = remoteArtifactRecovery;
        const checkpointHash = hash(canonical({ action, durableEffect, allowedRoots }));
        const verifier = new RemoteArtifactVerifier({ client });
        const observation = await client.reconcileDurableArtifact({ store, binding, effectId: durableEffect.effect_id });
        if (observation.requestSha256 !== durableEffect.request_sha256
          || observation.operationId !== operation.operationId
          || checkpointHash !== hash(canonical({ action, durableEffect, allowedRoots }))) {
          return blocked('RECEIPT_DISPATCH_MISMATCH', 'The current SQL observation differs from the recovery checkpoint.');
        }
        const verification = verifier.verify({ observation, action: request.action, taskId: dispatch.taskId });
        if (verification.status !== 'passed') {
          return blocked('VERIFICATION_FAILED', 'The remote artifact did not pass G verification.');
        }
        const execution = structuredClone(observation.receipt);
        const recovered = { status: 'recovered', source: 'pc-outbound-verified-artifact', execution,
          verification, packetId: execution.executionResult.packetId };
        bindCognitionRecovery(recovered,{request,requestSha256:durableEffect.request_sha256,workspaceRoot:coreFacade.workspaceRoot,clock:coreFacade.clock});
        recoveredMemoryScopes.bind(recovered, { request, requestSha256: durableEffect.request_sha256,
          workspaceRoot: coreFacade.workspaceRoot, clock: coreFacade.clock });
        return recovered;
      } catch (error) {
        return blocked('REMOTE_ARTIFACT_UNAVAILABLE', 'The provisioned remote artifact could not be reconciled.', { causeCode: error?.code ?? null });
      }
    }
    if (typeof executor?.receiptForOperation !== 'function') {
      return blocked('RECEIPT_UNAVAILABLE', 'The local executor cannot bind its journal receipt to the original operation.');
    }
    try {
      execution = structuredClone(await executor.receiptForOperation({ operationId: operation.operationId,
        taskId: dispatch.taskId, action: request.action }));
      source = 'pc-operation-receipt';
    } catch (error) {
      return blocked('RECEIPT_UNAVAILABLE', 'The original operation receipt could not be read.', { causeCode: error?.code ?? null });
    }
  } else if (task?.status === TaskStatus.COMPLETED && task.executionResult) {
    execution = structuredClone(task.executionResult);
    source = 'core-completed-task';
  } else {
    // The worker's executor can be a remote PC service even when the runtime also
    // has a local registry. Read from the same executor that received the packet.
    if (typeof executor?.taskResult !== 'function') {
      return blocked('RECEIPT_UNAVAILABLE', 'The execution service cannot provide a durable task receipt.');
    }
    try {
      execution = structuredClone(await executor.taskResult(dispatch.taskId));
      source = 'pc-task-receipt';
    } catch (error) {
      return blocked('RECEIPT_UNAVAILABLE', 'The execution service receipt could not be read.', { causeCode: error?.code ?? null });
    }
  }
  const result = execution?.executionResult;
  if (execution?.taskId !== dispatch.taskId || execution?.status !== TaskStatus.COMPLETED
    || result?.taskId !== dispatch.taskId || result?.executedBy?.toolName !== dispatch.toolName
    || !(result?.success === true || (result?.success !== false && result?.status === 'success'))
    || !result?.packetId || !execution?.evidence?.evidenceId) {
    let publication;
    if (dispatch.toolName === 'workflow.execute' && typeof executor?.taskPublication === 'function') {
      try {
        const observed = await executor.taskPublication(dispatch.taskId);
        const args = dispatch.arguments;
        const originalSpec=dispatch.workflowSpecSource??JSON.stringify(args.spec);
        if(Object.hasOwn(args,'spec')&&(typeof originalSpec!=='string'||canonical(JSON.parse(originalSpec))!==canonical(args.spec)))throw new Error('checkpoint-spec-mismatch');
        const expectedHash = Object.hasOwn(args, 'spec') ? hash(originalSpec) : args.expectedSha256;
        if (['observed', 'conflict'].includes(observed?.status) && observed.taskId === dispatch.taskId
          && observed.specSha256 === expectedHash && observed.executionAuthority === false
          && observed.completedReceipt === false && typeof observed.workspaceRoot === 'string'
          && resolve(observed.workspaceRoot) === resolve(args.workspaceRoot ?? allowedRoots[0])
          && Array.isArray(observed.files) && observed.files.length <= 128) {
          publication = { status: observed.status, completedReceipt: false, executionAuthority: false,
            resumable: observed.resumable === true,
            contractBinding: { status: observed.contractBinding?.status ?? 'unavailable',
              reason: observed.contractBinding?.reason ?? null },
            files: observed.files.map(file => ({ path: file.path, state: file.state,
              stagedValid: file.stagedValid, backupValid: file.backupValid })),
            nextAction: 'Reconcile original publication under current authority; do not redispatch.' };
        }
      } catch { /* Diagnostics never change the uncertain execution verdict. */ }
    }
    return blocked('EXECUTION_UNCERTAIN', 'No complete successful execution receipt is bound to the interrupted action.',
      publication ? { publication } : {});
  }
  if (result.dryRun === true || execution.shadow?.dryRun === true) {
    return blocked('EXECUTION_UNCERTAIN', 'A preview cannot establish a completed execution.');
  }
  if (durableEffect?.state === 'succeeded') {
    const saved = durableEffect.receipt;
    if (!saved || saved.taskId !== dispatch.taskId || saved.packetId !== result.packetId
      || saved.evidenceId !== execution.evidence.evidenceId || saved.receiptRef !== `pc-packet:${result.packetId}`
      || saved.source !== 'trusted-local-pc-journal') {
      return blocked('RECEIPT_DISPATCH_MISMATCH', 'The PC journal receipt differs from the SQL-recorded receipt.');
    }
  }
  const files = Array.isArray(execution.evidence.files) ? execution.evidence.files : [];
  const outputs = result.outputPaths;
  if (!Array.isArray(outputs) || outputs.length > 128 || files.length > 256
    || (dispatch.profile?.mutatesSystem === true && outputs.length === 0)) {
    return blocked('ARTIFACT_EVIDENCE_REQUIRED', 'Recovery requires bounded, explicit evidence for every published artifact.');
  }
  const byPath = new Map();
  for (const file of files) {
    if (typeof file.path !== 'string' || !isAbsolute(file.path) || byPath.has(resolve(file.path))) {
      return blocked('ARTIFACT_EVIDENCE_REQUIRED', 'Artifact evidence contains ambiguous paths.');
    }
    byPath.set(resolve(file.path), file);
  }
  if (dispatch.toolName === 'filesystem.createTextFile') {
    const target = dispatch.arguments?.path, content = dispatch.arguments?.content ?? '';
    const samePath = (left, right) => process.platform === 'win32'
      ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
    const intended = typeof target === 'string' && target.trim() && allowedRoots[0]
      ? resolve(allowedRoots[0], target) : null;
    const file = intended ? files.find(item => samePath(item.path, intended)) : null;
    // G checks receipt self-consistency. Bind it to this dispatch before letting
    // those checks, F memory or a durable follow-up ACK prove the wrong file.
    if (!intended || typeof content !== 'string' || outputs.length !== 1 || typeof outputs[0] !== 'string'
      || !samePath(outputs[0], intended) || !file || file.sha256?.toLowerCase() !== hash(content)) {
      return blocked('RECEIPT_DISPATCH_MISMATCH', 'The receipt target or bytes differ from the originally dispatched file write.');
    }
  }
  if (dispatch.toolName === 'filesystem.moveFiles' && durableEffect) {
    const plan=durableEffect.intent.request.movePlan;
    const changes=result.changedItems;
    const pathKey=path=>typeof path==='string'&&isAbsolute(path)
      ?process.platform==='win32'?resolve(path).toLowerCase():resolve(path):null;
    const typeFor=action=>action==='copy'?'copy_file':action==='rename'?'move_file_renamed_target':'move_file';
    if(!Array.isArray(plan)||!plan.length||!Array.isArray(changes)||changes.length!==plan.length
      ||outputs.length!==plan.length||plan.some((move,index)=>!pathKey(move.from)||!pathKey(move.to)
        ||pathKey(changes[index]?.from)!==pathKey(move.from)||pathKey(changes[index]?.to)!==pathKey(move.to)
        ||changes[index]?.type!==typeFor(move.action)||pathKey(outputs[index])!==pathKey(move.to))){
      return blocked('RECEIPT_DISPATCH_MISMATCH','The move receipt differs from the original SQL-bound sources, destinations or move policy.');
    }
    try{
      for(const move of plan)if(move.action!=='copy'){
        try{await stat(move.from);throw recoveryError('MOVE_SOURCE_REAPPEARED');}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
    }catch(error){return blocked(error.recoveryCode??'ARTIFACT_UNAVAILABLE','The moved source must still be absent before recovery.',{causeCode:error.code??null});}
  }
  if(dispatch.toolName==='excel.createWorkbook'&&durableEffect){
    const plan=durableEffect.intent.request.artifactPlan;
    const pathKey=path=>typeof path==='string'&&isAbsolute(path)?process.platform==='win32'?resolve(path).toLowerCase():resolve(path):null;
    if(!Array.isArray(plan?.paths)||!plan.paths.length||outputs.length!==plan.paths.length
      ||plan.paths.some((path,index)=>!pathKey(path)||pathKey(outputs[index])!==pathKey(path))
      ||pathKey(result.evidence?.workbook?.outputPath)!==pathKey(plan.paths[0])){
      return blocked('RECEIPT_DISPATCH_MISMATCH','The workbook receipt does not match the original SQL-bound output paths.');
    }
  }
  if(dispatch.toolName==='excel.exportPdf'&&durableEffect){
    const plan=durableEffect.intent.request.artifactPlan,exported=result.pdfExport;
    const key=p=>typeof p==='string'&&isAbsolute(p)?process.platform==='win32'?resolve(p).toLowerCase():resolve(p):null;
    if(plan?.paths?.length!==2||outputs.length!==1||!key(plan.paths[0])||!key(plan.paths[1])
      ||key(outputs[0])!==key(plan.paths[1])||key(exported?.inputPath)!==key(plan.paths[0])
      ||key(exported?.outputPath)!==key(plan.paths[1])||exported?.sourceSha256!==plan.sourceSha256){
      return blocked('RECEIPT_DISPATCH_MISMATCH','PDF receipt differs from the original source and destination contract.');
    }
    try{
      const measured=await measureFile(plan.paths[0],allowedRoots,16*1024*1024,readOptions);
      if(measured.sha256!==plan.sourceSha256)throw recoveryError('ARTIFACT_CHANGED');
    }catch(error){return blocked(error.recoveryCode??'ARTIFACT_UNAVAILABLE','The original workbook changed before PDF recovery.',{causeCode:error.code??null});}
  }
  if(dispatch.toolName==='powerpoint.create'&&durableEffect){
    const plan=durableEffect.intent.request.artifactPlan;
    if(!plan?.presentationPublication||canonical(outputs)!==canonical(plan.paths)
      ||canonical(result.artifactManifest)!==canonical(plan.presentationPublication)
      ||canonical(result.layoutRequirements)!==canonical(plan.presentationPublication.deck.slides)
      ||result.targetPath!==plan.presentationPublication.outputPath
      ||result.renderDirectory!==plan.presentationPublication.renderDirectory){
      return blocked('RECEIPT_DISPATCH_MISMATCH','Presentation receipt differs from the original slides and complete output manifest.');
    }
  }
  if(dispatch.toolName==='word.create'&&durableEffect){
    const plan=durableEffect.intent.request.artifactPlan;
    if(!plan?.wordPublication||canonical(outputs)!==canonical(plan.paths)
      ||canonical(result.artifactManifest)!==canonical(plan.wordPublication)
      ||canonical(result.document)!==canonical(plan.wordPublication.document)
      ||result.targetPath!==plan.wordPublication.outputPath
      ||result.renderDirectory!==plan.wordPublication.renderDirectory){
      return blocked('RECEIPT_DISPATCH_MISMATCH','Word receipt differs from the original document and complete output manifest.');
    }
  }
  if(['hwp.create','weather.createHwpReport'].includes(dispatch.toolName)&&durableEffect){
    const plan=durableEffect.intent.request.artifactPlan,prepared=plan?.hancomPublication;
    const weather=durableEffect.intent.request.weatherPublication;
    if(weather){try{validateWeatherPublicationResult(weather,result);}catch{return blocked('RECEIPT_DISPATCH_MISMATCH','Weather receipt differs from original forecast and document.');}}
    try{
      if(canonical(outputs)!==canonical(hancomActualOutputPaths(prepared,result))
        ||canonical(result.artifactManifest)!==canonical(prepared)
        ||canonical(result.document)!==canonical(prepared.document)
        ||(prepared.outputPath.toLowerCase().endsWith('.hwpx')&&canonical(result.hwpxDocument)!==canonical(prepared.document))
        ||result.targetPath!==prepared.outputPath||result.renderDirectory!==prepared.renderDirectory)
        throw Error('hancom-original-contract-mismatch');
    }catch{return blocked('RECEIPT_DISPATCH_MISMATCH','Hancom receipt differs from the original document and bounded output manifest.');}
  }
  if(dispatch.toolName==='visual.createCards'&&durableEffect){
    try{validateCardPublicationResult(durableEffect.intent.request.artifactPlan?.cardPublication,result);}
    catch{return blocked('RECEIPT_DISPATCH_MISMATCH','Card receipt differs from the original complete content and output contract.');}
  }
  if(dispatch.toolName==='document.edit'&&durableEffect){
    try{validateDocumentEditResult(durableEffect.intent.request.artifactPlan?.documentEditPublication,result);}
    catch{return blocked('RECEIPT_DISPATCH_MISMATCH','Edit receipt differs from original input, edits or complete backup/output contract.');}
  }
  if(dispatch.toolName==='macro.save'){
    try{
      const prepared=durableEffect?.intent?.request?.macroPublication;
      validateMacroPublicationResult(prepared,result);
      if(resolve(worker.pcAgent?.registry?.get('macro.save')?.store?.path??'.')!==prepared.path)throw Error('registered-store-changed');
    }catch{return blocked('RECEIPT_DISPATCH_MISMATCH','Macro receipt differs from original request or registered control store.');}
  }
  if(dispatch.toolName==='archive.createZip'&&durableEffect){
    const plan=durableEffect.intent.request.artifactPlan;
    if(!Array.isArray(plan?.inputs)||!plan.inputs.length||outputs.length!==1||outputs[0]!==plan.outputPath
      ||canonical(result.evidence?.inputs)!==canonical(plan.inputs)
      ||canonical(plan.paths)!==canonical([...plan.inputs.map(input=>input.path),plan.outputPath]))
      return blocked('RECEIPT_DISPATCH_MISMATCH','ZIP receipt differs from the original input/output contract.');
    try{
      let size=0;
      for(const input of plan.inputs){
        const measured=await measureFile(input.path,allowedRoots,Math.min(128*1024*1024,512*1024*1024-size),readOptions);
        size+=measured.size;
        if(measured.sha256!==input.sha256)throw recoveryError('ARTIFACT_CHANGED');
      }
      const measured=await measureFile(plan.outputPath,allowedRoots,513*1024*1024,{...readOptions,retainBytes:true});
      const members=zipMemberEvidence(measured.bytes);
      if(members.length!==plan.inputs.length||members.some((item,index)=>item.name!==plan.inputs[index].archiveName||item.sha256!==plan.inputs[index].sha256))throw recoveryError('ARTIFACT_CHANGED');
    }catch(error){return blocked(error.recoveryCode??'ARTIFACT_UNAVAILABLE','The ZIP or original inputs cannot be verified.',{causeCode:error.code??null});}
  }
  if (dispatch.toolName === 'workflow.execute') {
    const args = dispatch.arguments;
    const workflow = result.evidence?.workflow ?? execution.evidence?.adapterEvidence?.workflow;
    let spec, expectedHash;
    try {
      if (Object.hasOwn(args, 'spec') && !Object.hasOwn(args, 'specPath') && args.expectedSha256 === undefined) {
        const serialized = dispatch.workflowSpecSource ?? JSON.stringify(args.spec);
        if (typeof serialized!=='string' || canonical(JSON.parse(serialized))!==canonical(args.spec))throw new Error('checkpoint-spec-mismatch');
        if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('spec-too-large');
        spec = validateWorkflowSpec(JSON.parse(serialized)); expectedHash = hash(serialized);
        if (workflow?.specSource !== 'inline') throw new Error('source-mismatch');
      } else if (!Object.hasOwn(args, 'spec') && typeof args.specPath === 'string'
        && /^[a-f0-9]{64}$/iu.test(args.expectedSha256 ?? '')) {
        expectedHash = args.expectedSha256.toLowerCase();
        if (workflow?.specSource !== 'file') throw new Error('source-mismatch');
      } else throw new Error('unbound-spec-source');
      if (workflow?.specSha256 !== expectedHash || (spec && (workflow.workflowId !== spec.workflowId
        || workflow.schemaVersion !== spec.schemaVersion || workflow.nodeCount !== spec.nodes.length
        || !Array.isArray(workflow.receipts) || workflow.receipts.length !== spec.nodes.length
        || new Set(workflow.receipts.map(item => item.nodeId)).size !== spec.nodes.length
        || spec.nodes.some(node => !workflow.receipts.some(item => item.nodeId === node.id && item.op === node.op)))))
        throw new Error('spec-receipt-mismatch');
      const secondary = execution.evidence?.adapterEvidence?.workflow;
      if (secondary && canonical(secondary) !== canonical(workflow)) throw new Error('conflicting-workflow-evidence');
      if (spec) {
        const pathKey = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
        const observed = outputs.map(path => {
          if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid-output-path');
          return pathKey(path);
        });
        if (new Set(observed).size !== observed.length) throw new Error('duplicate-output');
        const expected = new Set();
        let allDestinationsBound = true;
        for (const node of spec.nodes) {
          if (!node.op.startsWith('write.') && !['sqlite.import', 'process.run', 'process.pipeline'].includes(node.op)) continue;
          const receipt = workflow.receipts.find(item => item.nodeId === node.id);
          if (receipt.status === 'skipped') continue;
          if (receipt.status !== 'success') throw new Error('write-not-successful');
          // Relative file arguments are resolved against allowedRoots[0] by B,
          // even when workspaceRoot selects a different staging directory.
          const destination = node.op === 'sqlite.import' ? node.args.databasePath ?? node.args.path : node.args.path;
          if (node.op.startsWith('process.') || typeof destination !== 'string') {
            allDestinationsBound = false;
            continue; // Dynamic destinations still need a typed result/resource contract.
          }
          if (!destination.trim() || destination.includes('\0') || !allowedRoots[0]) throw new Error('invalid-destination');
          const intended = pathKey(resolve(allowedRoots[0], destination));
          if (!observed.includes(intended)) throw new Error('destination-mismatch');
          expected.add(intended);
        }
        if (allDestinationsBound && observed.some(path => !expected.has(path))) throw new Error('unexpected-destination');
      }
    } catch {
      return blocked('RECEIPT_DISPATCH_MISMATCH', 'The recovered workflow receipt differs from the originally dispatched spec, nodes or statically bound destinations.');
    }
  }
  let measuredBytes = 0;
  try {
    for (const output of outputs) {
      if (typeof output !== 'string' || !isAbsolute(output)) throw recoveryError('ARTIFACT_EVIDENCE_REQUIRED');
      const file = byPath.get(resolve(output));
      if (!file || !/^[a-f0-9]{64}$/i.test(file.sha256 ?? '')) throw recoveryError('ARTIFACT_EVIDENCE_REQUIRED');
    }
    // Validate all file evidence, including input files when the collector records
    // them. Do not re-use stale hashes merely because G accepted them previously.
    for (const file of files) {
      if (!/^[a-f0-9]{64}$/i.test(file.sha256 ?? '')) throw recoveryError('ARTIFACT_EVIDENCE_REQUIRED');
      const workbookPlan=dispatch.toolName==='excel.createWorkbook'?durableEffect?.intent?.request?.artifactPlan:null;
      const key=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
      const retainBytes=typeof workbookPlan?.paths?.[0]==='string'&&key(workbookPlan.paths[0])===key(file.path);
      const macro=dispatch.toolName==='macro.save'?durableEffect.intent.request.macroPublication:null;
      if(macro&&file.path!==macro.path)throw recoveryError('ARTIFACT_CHANGED');
      const measured = await measureFile(file.path, macro?[macro.path]:allowedRoots, macro?2*1024*1024:512 * 1024 * 1024 - measuredBytes, {...readOptions,retainBytes});
      measuredBytes += measured.size;
      if (measured.sha256 !== file.sha256.toLowerCase()) throw recoveryError('ARTIFACT_CHANGED');
      if(retainBytes&&xlsxArchiveContentSha256(measured.bytes)!==workbookPlan.workbookContentSha256)throw recoveryError('ARTIFACT_CHANGED');
      delete measured.bytes;
      Object.assign(file, measured, { exists: true });
    }
    if (dispatch.toolName === 'filesystem.readText' && dispatch.arguments.path) {
      const expected = result.contentSha256 ?? result.evidence?.contentSha256;
      if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) throw recoveryError('ARTIFACT_EVIDENCE_REQUIRED');
      const measured = await measureFile(dispatch.arguments.path, allowedRoots, 512 * 1024 * 1024 - measuredBytes, readOptions);
      if (measured.sha256 !== expected.toLowerCase()) throw recoveryError('ARTIFACT_CHANGED');
    }
  } catch (error) {
    return blocked(error.recoveryCode ?? 'ARTIFACT_UNAVAILABLE', 'The original artifact cannot be verified against the current filesystem.', { causeCode: error?.code ?? null });
  }
  let verification;
  try {
    verification = await worker.verifyExecution({ taskId: dispatch.taskId }, execution, null, {recoveryReadRoots:allowedRoots, observationOnly, beforeResultRead});
  } catch (error) {
    return blocked('VERIFICATION_UNAVAILABLE', 'The recovered execution could not be checked by G.', { causeCode: error?.code ?? null });
  }
  if (verification?.status !== 'passed' || !verification.verificationId
    || (verification.checks ?? []).some((check) => check.status === 'failed')) {
    return blocked('VERIFICATION_FAILED', 'The recovered execution did not pass G verification.');
  }
  const recovered = { status: 'recovered', source, execution, verification, packetId: result.packetId };
  // Only this successful SQL-intent/PC-receipt/current-file/G path can issue a
  // scope proof. Plain planner objects and serialized copies carry no authority.
  if(durableEffect)bindCognitionRecovery(recovered,{request:durableEffect.intent.request,requestSha256:durableEffect.request_sha256,workspaceRoot:coreFacade.workspaceRoot,clock:coreFacade.clock});
  else if(dispatch.toolName==='workflow.execute' && workflowCognitionIntents instanceof WorkflowCognitionIntentStore){
    try{
      const intent=workflowCognitionIntents.load(missionId,action);
      if(intent){
        const context={...intent,workspaceRoot:coreFacade.workspaceRoot,clock:coreFacade.clock};
        bindCognitionRecovery(recovered,context);
        recoveredMemoryScopes.bind(recovered,context);
      }
    }catch{return blocked('COGNITION_INTENT_MISMATCH','The original workflow cognition context cannot be verified.');}
  }
  if (durableEffect) recoveredMemoryScopes.bind(recovered, { request: durableEffect.intent.request,
    requestSha256: durableEffect.request_sha256, workspaceRoot: coreFacade.workspaceRoot, clock: coreFacade.clock });
  return recovered;
}

function recoveryError(code) {
  const error = new Error(code);
  error.recoveryCode = code;
  return error;
}

// Bind roots that do not exist yet to their nearest existing parent. Creating
// that directory later is valid; replacing a parent with a junction is not.
function projectedRealPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try { return resolve(realpathSync(cursor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(cursor) === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = dirname(cursor);
    }
  }
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function measureFile(path, roots, remainingBytes, { readChunkBytes, onFileRead,retainBytes=false, beforeResultRead=null }) {
  const guard = async target => { if (beforeResultRead) await beforeResultRead({ path: target, kind: 'read' }); };
  if (!isAbsolute(path) || !roots.some((root) => within(resolve(root), resolve(path)))) {
    throw recoveryError('ARTIFACT_OUTSIDE_ROOT');
  }
  await guard(path);
  const actual = await realpath(path);
  let allowed = false;
  for (const root of roots) {
    if (within(resolve(root), resolve(path)) && within(await realpath(root), actual)) allowed = true;
  }
  if (!allowed) throw recoveryError('ARTIFACT_OUTSIDE_ROOT');
  await guard(actual);
  const handle = await open(actual, 'r');
  try {
    // Filesystem IDs are 64-bit and timestamps may have sub-millisecond
    // precision. Number conversion can merge distinct observations.
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 128n * 1024n * 1024n || before.size > BigInt(remainingBytes)) {
      throw recoveryError('ARTIFACT_BUDGET_EXCEEDED');
    }
    // The bounded file size is now small enough to convert without precision
    // loss for Buffer allocation, offsets and the public evidence schema.
    const beforeSize = Number(before.size);
    const digest = createHash('sha256');
    const chunks=retainBytes?[]:null;
    const buffer = Buffer.alloc(Math.max(minimumReadChunkBytes, Math.min(beforeSize, readChunkBytes)));
    let offset = 0;
    while (true) {
      await guard(actual);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      await guard(actual);
      // Development-only instrumentation observes every read, including EOF.
      // Synchronous observers stay synchronous; returned promises are awaited.
      // Any observer failure follows the same fail-closed verification path.
      if (onFileRead) {
        const observation = onFileRead({ bytesRead, requestedBytes: buffer.length });
        if (observation && typeof observation.then === 'function') await observation;
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > beforeSize) throw recoveryError('ARTIFACT_CHANGED');
      digest.update(buffer.subarray(0, bytesRead));
      chunks?.push(Buffer.from(buffer.subarray(0,bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== beforeSize || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || await realpath(path) !== actual) throw recoveryError('ARTIFACT_CHANGED');
    if (before.ctimeNs !== after.ctimeNs || before.dev !== after.dev || before.ino !== after.ino) {
      throw recoveryError('ARTIFACT_CHANGED');
    }
    // The open handle may still identify an old file after rename-and-replace.
    // Bind the evidence to the file currently published at the requested path.
    const published = await stat(path, { bigint: true });
    if (!published.isFile() || published.dev !== after.dev || published.ino !== after.ino
      || published.size !== after.size || published.mtimeNs !== after.mtimeNs || published.ctimeNs !== after.ctimeNs) {
      throw recoveryError('ARTIFACT_CHANGED');
    }
    await guard(actual);
    return { sha256: digest.digest('hex'), size: Number(after.size),...(chunks?{bytes:Buffer.concat(chunks)}:{}) };
  } finally {
    await handle.close();
  }
}
