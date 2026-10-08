import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { SqliteMissionStore } from './sqlite-mission-store.js';
import { WorkflowCognitionIntentStore } from './workflow-cognition-intent-store.js';
import { SqliteMemoryStore } from '../../../../apps/growth-memory/src/db/sqlite-store.js';
import { PcOutboundExecutionClient } from '../client/pc-outbound-execution-client.js';
import { PcAgentExecutionClient } from '../client/pc-agent-execution-client.js';
import { getRecoveredMemoryScopeProof } from './mission-action-recovery.js';
import { PcOutboundReceiptClient } from '../client/pc-outbound-receipt-client.js';
import { createRemoteArtifactIntent } from './remote-artifact-contract.js';
import { RemoteArtifactVerifier } from '../../../../apps/verification/src/remote-artifact-verifier.js';
import {createWorkbookBuffer} from '../../../../apps/pc-agent/src/adapters/excel/xlsx-writer.js';
import {xlsxArchiveContentSha256} from './xlsx-cell-evidence.js';
import { normalizeVerificationSpec, compareTypedCriterionContent, compareArtifactConsistencyContent } from './criteria-evidence.js';
import {validateDocumentEditResult} from '../../../../apps/pc-agent/src/adapters/excel/edit-contract.js';
import {validateWeatherPublicationResult} from '../../../../apps/pc-agent/src/adapters/weather/publication-contract.js';
import {validateMacroPublicationResult} from '../../../shared/src/macro-publication-contract.js';

const normalize = value => value && typeof value === 'object' ? Array.isArray(value)
  ? value.map(normalize) : Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
const error = code => Object.assign(new Error(code), { code, executionUncertain: true });
const pathIdentity = path => process.platform === 'win32' ? path.toLowerCase() : path;
function physicalTarget(path) {
  let cursor = resolve(path), suffix = [];
  while (true) {
    try { return resolve(realpathSync(cursor), ...suffix); }
    catch (e) { if (e.code !== 'ENOENT' || dirname(cursor) === cursor) throw e; }
    suffix.unshift(basename(cursor)); cursor = dirname(cursor);
  }
}

/** Core SQL effects for single files and local workflows; remote scope remains file-only. */
export class MissionEffectCoordinator {
  constructor(runtime, { leaseTtlMs = 30_000, onBoundary = null, workflowEffectsEnabled = true } = {}) {
    this.runtime = runtime; this.store = runtime.store; this.leaseTtlMs = leaseTtlMs;
    this.ownerId = `mission-core:${randomUUID()}`; this.onBoundary = onBoundary;
    this.claims = new Map();
    if (typeof workflowEffectsEnabled !== 'boolean') throw error('A_MISSION_WORKFLOW_EFFECT_CONFIGURATION_INVALID');
    this.workflowEffectsEnabled = workflowEffectsEnabled;
    this.workflowCognitionIntents = this.store instanceof SqliteMissionStore ? new WorkflowCognitionIntentStore(this.store,{executorBinding:()=>this.executorBinding()}) : null;
    if (runtime.remoteArtifactRecovery && (!(runtime.remoteArtifactRecovery.client instanceof PcOutboundReceiptClient)
      || runtime.remoteArtifactRecovery.binding?.version !== 'remote-artifact-binding-v2'
      || !(this.store instanceof SqliteMissionStore))) throw error('A_MISSION_REMOTE_ARTIFACT_CONFIG_INVALID');
  }
  remoteArtifactRecoveryContext(action) {
    const effect = this.effect(action);
    if (!effect?.intent?.request?.remoteArtifactIntent) return null;
    const configured = this.runtime.remoteArtifactRecovery;
    return configured ? { client: configured.client, binding: configured.binding, store: this.store } : null;
  }
  // The closure owns one completion attempt's observations. No serialized or
  // caller-supplied observation can enter this cache; the next attempt is fresh.
  createRemoteCriterionValidator() {
    const observations = new Map();
    return (criterion, action, actions = []) => criterion.verificationSpec?.kind === 'artifact.consistency'
      ? this.#verifyRemoteConsistency(criterion, actions, observations) : this.#verifyRemoteCriterion(criterion, action, observations);
  }
  async verifyRemoteCriterion(criterion, action) {
    return this.#verifyRemoteCriterion(criterion, action, new Map());
  }
  async #verifyRemoteCriterion(criterion, action, observations) {
    const effect=this.effect(action),intent=effect?.intent?.request?.remoteArtifactIntent;
    if(!intent)return null;
    const failed=reason=>({status:'unverified',passed:false,reasons:[reason],checks:[{checkId:'current_remote_typed_criterion',passed:false}]});
    try{
      const spec=normalizeVerificationSpec(criterion.verificationSpec);
      if(!['text.equals','file.exists','json.value','csv.rows','xlsx.cells','xlsx.charts'].includes(spec.kind))return null;
      const measured=await this.#observeRemotePath(spec.path,action,observations);
      if(!measured)return null;
      const {observation,verification,context}=measured;
      const bytes=observation.artifact.bytes;
      const comparison=compareTypedCriterionContent({spec,bytes});
      const {passed}=comparison;
      return {revalidate:()=>context.client.assertConsumedArtifactObservationCurrent(observation),
        status:comparison.status,passed,reasons:comparison.reasons,checks:[{
        ...comparison.checks[0],contentCheckId:comparison.checks[0].checkId,
        checkId:'current_remote_typed_criterion',passed,verificationId:verification.verificationId,
        operationId:effect.operation_id,contentSha256:observation.artifact.sha256,size:bytes.length}]};
    }catch{return failed('remote-criterion-current-observation-unavailable');}
  }
  async #observeRemotePath(path, action, observations) {
    const effect=this.effect(action),intent=effect?.intent?.request?.remoteArtifactIntent;
    if(!intent)return null;
      const request=effect.intent.request;
      const target=createRemoteArtifactIntent({binding:intent.binding,taskId:request.taskId,operationId:effect.operation_id,
        action:{...request.action,arguments:{...request.action.arguments,path}}});
      if(target.target!==intent.target)return null;
      const context=this.remoteArtifactRecoveryContext(action);
      if(!context||effect.state!=='succeeded'||action.status!=='succeeded')throw error('remote-criterion-current-scope-required');
      const key=digest({effectId:effect.effect_id,request:effect.intent.request,receipt:effect.receipt});
      if(!observations.has(key))observations.set(key,(async()=>{
        const observation=await context.client.reconcileDurableArtifact({...context,effectId:effect.effect_id});
        const verification=new RemoteArtifactVerifier({client:context.client}).verify({observation,action:request.action,taskId:request.taskId});
        if(verification.status!=='passed')throw error('remote-criterion-current-g-failed');
        return {observation,verification};
      })());
      const {observation,verification}=await observations.get(key);
      // Reuse never bypasses current SQL, device, scope or freshness checks.
      context.client.assertConsumedArtifactObservationCurrent(observation);
    return {observation,verification,context,effect,intent};
  }
  async #verifyRemoteConsistency(criterion, actions, observations) {
    const fail=reason=>({passed:false,status:'unverified',reasons:[reason],checks:[]});
    try {
      if(!actions.some(action=>this.effect(action)?.intent?.request?.remoteArtifactIntent))return null;
      const spec=normalizeVerificationSpec(criterion.verificationSpec);
      const files={},proofs=[],targets=new Set(),effects=new Set();
      for(const key of ['source','report','table','card']) {
        let measured;
        for(const action of actions) {
          measured=await this.#observeRemotePath(spec[`${key}Path`],action,observations);
          if(measured)break;
        }
        if(!measured)return fail(`remote-consistency-${key}-evidence-missing`);
        const identity=digest({binding:measured.intent.binding,target:measured.intent.target});
        if(targets.has(identity)||effects.has(measured.effect.effect_id))return fail('remote-consistency-distinct-files-required');
        targets.add(identity);effects.add(measured.effect.effect_id);proofs.push(measured);
        files[key]=measured.observation.artifact.bytes;
      }
      const revalidate=()=>{for(const proof of proofs)proof.context.client.assertConsumedArtifactObservationCurrent(proof.observation);};
      revalidate();
      const comparison=compareArtifactConsistencyContent({files});
      return {...comparison,revalidate,checks:comparison.checks.map(check=>({...check,
        checkId:'current_remote_artifact_consistency',contentCheckId:check.checkId,
        verificationIds:proofs.map(proof=>proof.verification.verificationId),artifactCount:proofs.length}))};
    } catch { return fail('remote-consistency-current-observation-unavailable'); }
  }
  get remote() { const executor = this.runtime.orchestrationWorker.pcAgent; return (executor instanceof PcAgentExecutionClient || executor instanceof PcOutboundExecutionClient) && executor.supportsDurableMissionEffects(); }
  get enabled() { return this.store instanceof SqliteMissionStore && (this.remote
    || (this.runtime.orchestrationWorker.pcAgent === this.runtime.pcAgent && this.runtime.pcAgent.supportsTrustedLocalMissionEffects?.() === true)); }
  executorBinding() { const executor=this.runtime.orchestrationWorker.pcAgent;
    if(executor instanceof PcOutboundExecutionClient){if(!executor.matchesRecovery(this.runtime.remoteArtifactRecovery))throw error('A_MISSION_OUTBOUND_RECOVERY_BINDING_REQUIRED');return executor.executorBinding();}
    return this.remote ? { kind: 'pc-http-loopback', endpointHash: digest(this.runtime.orchestrationWorker.pcAgent.baseUrl) }
    : { kind: 'pc-local' }; }
  supported(action, task) {
    const tool=task?.plan?.action?.toolName;
    const localWorkflow=this.workflowEffectsEnabled===true && tool==='workflow.execute' && !this.remote
      && action.operation?.dispatch?.profile?.externalTransfer!==true;
    const file=tool==='filesystem.createTextFile' && typeof task.plan.action.arguments?.path==='string'
      && task.plan.action.arguments.path.trim().length>0;
    const move=tool==='filesystem.moveFiles' && !this.remote
      && action.operation?.dispatch?.profile?.externalTransfer!==true;
    const artifact=['excel.createWorkbook','excel.exportPdf','archive.createZip','word.create','powerpoint.create','hwp.create','weather.createHwpReport','visual.createCards','document.edit','macro.save'].includes(tool)&&!this.remote&&action.operation?.dispatch?.profile?.externalTransfer!==true;
    return this.enabled && (file || localWorkflow || move || artifact)
      && action.operation?.dispatch?.actionNodeCount === 1
      && !this.runtime.orchestrationWorker.shouldRunPlanGraph?.(task);
  }
  effect(action) {
    if (!this.enabled || !action.effect?.effectId) return null;
    return this.store.getEffect(action.effect.effectId);
  }
  project(action, effect) {
    const tool=effect.intent.request.toolName;
    action.effect = { version: 'a-local-mission-effect-v1', effectId: effect.effect_id,
      operationId: effect.operation_id, state: effect.state, receiptRecorded: effect.state === 'succeeded' && !!effect.receipt,
      scope: this.remote ? (this.runtime.orchestrationWorker.pcAgent instanceof PcOutboundExecutionClient ? 'durable-pc-outbound-filesystem.createTextFile' : 'durable-pc-http-filesystem.createTextFile') : `trusted-local-${tool}` };
  }
  snapshot(reason) { return { missions: [...this.runtime.missions.values()].map(mission => structuredClone(mission)), reason }; }
  async boundary(name, action) { if (this.onBoundary) await this.onBoundary(name, { action, effect: this.effect(action) }); }
  memoryReadiness(task) {
    // Outbound commands currently reconcile only the provisioned single-file
    // effect contract. They cannot persist/recover a workflow cognition intent
    // or resume its publication. A healthy memory DB cannot make that channel
    // ready; reject before staging rather than fail after an attempted handoff.
    if (this.workflowCognitionIntents && task?.plan?.action?.toolName === 'workflow.execute'
      && this.runtime.orchestrationWorker.pcAgent instanceof PcOutboundExecutionClient) {
      return { required: true, available: false,
        code: 'A_MISSION_WORKFLOW_RECOVERY_CHANNEL_UNSUPPORTED',
        reason: 'outbound-workflow-recovery-not-implemented',
        nextAction: '현재 외향 연결은 이 복합 작업의 중단 후 복구를 지원하지 않습니다. 지원되는 PC 실행 연결을 설정한 뒤 같은 작업을 이어가세요. 아직 파일 작업은 시작하지 않았습니다.' };
    }
    // The SQL workflow recovery contract requires persisted growth events. A
    // successful file is not recoverable memory, nor is an in-memory preview.
    if (!this.workflowCognitionIntents || !this.enabled || task?.plan?.action?.toolName !== 'workflow.execute') return { required: false, available: true };
    const store = this.runtime.orchestrationWorker.growthRuntime?.ingestor?.store;
    const unavailable = reason => ({ required: true, available: false,
      code: 'A_MISSION_DURABLE_MEMORY_UNAVAILABLE', reason,
      nextAction: '영속 성장 기억 저장소를 연결하거나 복구한 뒤 이 작업을 다시 실행하세요. 아직 파일 작업은 시작하지 않았습니다.' });
    if (!(store instanceof SqliteMemoryStore) || !store.dbPath || store.dbPath === ':memory:') return unavailable('persistent-growth-store-not-configured');
    try {
      if (store.db.prepare('PRAGMA query_only').get().query_only !== 0) return unavailable('persistent-growth-store-read-only');
      store.db.prepare('SELECT event_id FROM memory_events LIMIT 1').get();
      store.assertRestoreGeneration(this.runtime.orchestrationWorker.growthRuntime.memoryGeneration);
    } catch { return unavailable('persistent-growth-store-unavailable'); }
    return { required: true, available: true };
  }
  hydrate() {
    if (!this.enabled) return false;
    this.store.recoverExpiredEffects();
    let changed = false;
    for (const mission of this.runtime.missions.values()) for (const action of mission.waves.flatMap(wave => wave.actions)) {
      const effect = this.effect(action);
      if (!effect) continue;
      this.project(action, effect); changed = true;
      if (mission.status === 'CANCELLED' && effect.state === 'failed' && effect.receipt?.notDispatched === true) {
        action.status = 'skipped';
        action.recovery = { ...action.recovery, required: false, status: 'not-dispatched', error: null };
        continue;
      }
      if (!['succeeded', 'failed'].includes(action.status) || effect.state !== 'succeeded') {
        action.status = 'planned';
        action.recovery = { ...action.recovery, required: effect.state !== 'prepared' };
      }
    }
    return changed;
  }
  recoveryState(action) {
    const effect = this.effect(action);
    if (!effect) return null;
    if (digest(effect.intent.request.executorBinding ?? { kind: 'pc-local' }) !== digest(this.executorBinding())) {
      return { blocked: true, code: 'A_MISSION_EFFECT_EXECUTOR_CHANGED' };
    }
    this.store.recoverExpiredEffects();
    const current = this.store.getEffect(effect.effect_id); this.project(action, current);
    if (current.state === 'prepared') {
      action.attempts = 0;
      action.recovery = { ...action.recovery, required: false, status: 'not_dispatched' };
      return { notDispatched: true };
    }
    if (['in_flight', 'failed'].includes(current.state)) return { blocked: true, code: current.state === 'in_flight'
      ? 'A_MISSION_EFFECT_OWNED_OR_IN_FLIGHT' : 'A_MISSION_EFFECT_NOT_DISPATCHED_FAILED' };
    return null;
  }
  taskRequestFor(action) {
    const effect = this.effect(action);
    return effect?.state === 'prepared' ? structuredClone(effect.intent.request.taskRequest) : null;
  }
  cancelPrepared(action, { reason = 'mission-cancelled-before-dispatch' } = {}) {
    const effect = this.effect(action);
    if (!effect || effect.state !== 'prepared') return { cancelled: false, state: effect?.state ?? 'unconnected' };
    this.project(action, this.store.failUndispatchedEffect({ effectId: effect.effect_id, reason }));
    return { cancelled: true, notDispatched: true, state: action.effect.state };
  }
  async stage(mission, action, task) {
    if (this.workflowCognitionIntents && this.enabled && (!this.remote || this.runtime.orchestrationWorker.pcAgent instanceof PcAgentExecutionClient)
      && task?.plan?.action?.toolName === 'workflow.execute')
      this.workflowCognitionIntents.record(mission, action, task);
    if (!this.supported(action, task)) return null;
    const dispatch = action.operation.dispatch, effectId = `mission_effect:${action.operation.operationId}`;
    const remoteScope = this.runtime.remoteArtifactRecovery;
    if (remoteScope && !this.remote) throw error('A_MISSION_REMOTE_ARTIFACT_EXECUTOR_REQUIRED');
    const remoteArtifactIntent = remoteScope ? createRemoteArtifactIntent({ binding: remoteScope.binding,
      taskId: task.taskId, operationId: action.operation.operationId, action: task.plan.action }) : null;
    const movePlan=dispatch.toolName==='filesystem.moveFiles'
      ? (await this.runtime.pcAgent.registry.get(dispatch.toolName).shadow(dispatch.arguments)).batchPolicy.readyItems
        .map(({from,to,action})=>({from,to,action})) : null;
    const workbook=dispatch.toolName==='excel.createWorkbook'?await this.runtime.pcAgent.registry.get(dispatch.toolName).normalize(dispatch.arguments):null;
    const pdf=dispatch.toolName==='excel.exportPdf'?await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments):null;
    const zip=dispatch.toolName==='archive.createZip'?await this.runtime.pcAgent.registry.get(dispatch.toolName).normalize(dispatch.arguments):null;
    const word=dispatch.toolName==='word.create'?await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments):null;
    const presentation=dispatch.toolName==='powerpoint.create'?await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments):null;
    const assertWeatherAccess=()=>{
      this.runtime.executionAuthority?.assertActive();
      if(this.runtime.shutdownRequest||['CANCELLED','FAILED','BLOCKED','COMPLETED'].includes(mission.status)
        ||['CANCELLED','FAILED','BLOCKED'].includes(this.runtime.coreFacade.getTask(task.taskId)?.status)
        ||!this.runtime.actionAuthorized(mission,action,this.runtime.capabilityProfile(task)))throw error('A_MISSION_EFFECT_AUTHORITY_REVOKED');
    };
    let weather=null;
    if(dispatch.toolName==='weather.createHwpReport'){
      assertWeatherAccess();const previous=this.effect(action),request=previous?.intent?.request;
      if(request?.weatherPublication){
        if(previous.state!=='prepared'||request.taskId!==task.taskId||request.actionSha256!==dispatch.actionSha256
          ||request.plannedRequestSha256!==action.operation.requestSha256||request.allowedRootsSha256!==action.operation.allowedRootsSha256
          ||digest(request.arguments)!==digest(dispatch.arguments)||digest(request.executorBinding)!==digest(this.executorBinding()))throw error('A_MISSION_WEATHER_PREPARED_BINDING_MISMATCH');
        weather=structuredClone(request.weatherPublication);
      }else weather=await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments,{assertAccess:assertWeatherAccess});
      assertWeatherAccess();
    }
    const hancom=weather?.hancomPublication??(dispatch.toolName==='hwp.create'?await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments):null);
    const cards=dispatch.toolName==='visual.createCards'?await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments):null;
    const edit=dispatch.toolName==='document.edit'?await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments):null;
    let macro=null;
    if(dispatch.toolName==='macro.save'){
      assertWeatherAccess();const previous=this.effect(action),request=previous?.intent?.request;
      if(request?.macroPublication){
        if(previous.state!=='prepared'||request.taskId!==task.taskId||request.actionSha256!==dispatch.actionSha256
          ||request.plannedRequestSha256!==action.operation.requestSha256||request.allowedRootsSha256!==action.operation.allowedRootsSha256
          ||digest(request.arguments)!==digest(dispatch.arguments)||digest(request.executorBinding)!==digest(this.executorBinding()))throw error('A_MISSION_MACRO_PREPARED_BINDING_MISMATCH');
        macro=structuredClone(request.macroPublication);
      }else macro=await this.runtime.pcAgent.registry.get(dispatch.toolName).preparePublication(dispatch.arguments);
      assertWeatherAccess();
    }
    if(zip?.warnings.length)throw error('A_MISSION_ARCHIVE_PREFLIGHT_FAILED');
    const artifactPlan=edit?{paths:edit.paths,preparedSha256:digest(edit),documentEditPublication:edit}:cards?{paths:cards.paths,preparedSha256:digest(cards),cardPublication:cards}:hancom?{paths:hancom.paths,preparedSha256:digest(hancom),hancomPublication:hancom}:presentation?{paths:presentation.paths,preparedSha256:digest(presentation),presentationPublication:presentation}:word?{paths:word.paths,preparedSha256:digest(word),wordPublication:word}:workbook?{paths:[workbook.outputPath,...(workbook.pdfOutputPath?[workbook.pdfOutputPath]:[])],preparedSha256:digest(workbook),
      workbookContentSha256:xlsxArchiveContentSha256(createWorkbookBuffer(workbook))}:pdf?{
        paths:[pdf.inputPath,pdf.outputPath],preparedSha256:digest(pdf),sourceSha256:pdf.sourceSha256}:zip?{
        paths:[...zip.inputs.map(input=>input.path),zip.outputPath],preparedSha256:digest(zip),inputs:zip.inputs,outputPath:zip.outputPath}:null;
    const request = JSON.parse(JSON.stringify({ taskId: task.taskId, taskRequest: task.request,
      cognitionPlanId:task.plan.planId,cognitionApprovalId:task.approvalCard?.approvalId??null,
      plannedRequestSha256: action.operation.requestSha256, actionSha256: dispatch.actionSha256,
      allowedRootsSha256: action.operation.allowedRootsSha256, resolvedAllowedRootsSha256: action.operation.resolvedAllowedRootsSha256,
      toolName: dispatch.toolName, arguments: dispatch.arguments, action: task.plan.action, executorBinding: this.executorBinding(),
      ...(macro?{artifactPlan:{paths:[macro.path],preparedSha256:digest(macro)},macroPublication:macro}:artifactPlan?{artifactPlan}:{}),...(weather?{weatherPublication:weather}:{}),...(movePlan ? {movePlan} : {}),...(remoteArtifactIntent ? { remoteArtifactIntent } : {}) }));
    const effect = { effectId, operationId: action.operation.operationId, missionId: mission.missionId,
      request, resourceKey: macro?`local-macro:${digest(pathIdentity(physicalTarget(macro.path)))}`:remoteArtifactIntent?.resourceKey ?? (artifactPlan
        ? `local-artifact:${digest(artifactPlan.paths.map(path=>pathIdentity(physicalTarget(path))).sort())}`
        : dispatch.toolName==='filesystem.moveFiles'
        ? `local-move:${digest(movePlan.flatMap(move=>[move.from,move.to]).map(path=>pathIdentity(physicalTarget(resolve(path)))).sort())}`
        : dispatch.toolName==='workflow.execute'
        ? `local-workflow:${digest(pathIdentity(physicalTarget(resolve(dispatch.arguments.workspaceRoot??this.runtime.allowedRoots[0]))))}`
        : `local-file:${digest(pathIdentity(physicalTarget(resolve(this.runtime.allowedRoots[0], dispatch.arguments.path))))}`),
      providerIdempotencyKey: action.operation.operationId };
    const previous = action.effect;
    action.effect = { effectId, state: 'prepared', scope: `trusted-local-${dispatch.toolName}` };
    try { this.runtime.persist('mission-effect-prepared', { effects: [effect] }); }
    catch (e) { action.effect = previous; throw e; }
    this.project(action, this.store.getEffect(effectId));
    await this.boundary('prepared', action);
    return this.executionHooks(mission, action, task, request);
  }
  publicationRecoveryHooks(mission, action, task) {
    const effect = this.effect(action), request = effect?.intent?.request;
    if (!this.workflowEffectsEnabled || this.remote || effect?.state !== 'uncertain'
      || request?.toolName !== 'workflow.execute' || request.executorBinding?.kind !== 'pc-local'
      || effect.operation_id !== action.operation?.operationId
      || digest(task.plan?.action) !== request.actionSha256
      || task.taskId !== request.taskId || task.plan?.planId !== request.cognitionPlanId
      || Object.entries(task.request).some(([key, value]) => digest(value) !== digest(request.taskRequest[key]))) {
      throw error('A_MISSION_PUBLICATION_RECOVERY_BINDING_MISMATCH');
    }
    task.request = structuredClone(request.taskRequest);
    return this.executionHooks(mission, action, task, request, { publicationRecovery: true });
  }
  executionHooks(mission, action, task, request, { publicationRecovery = false } = {}) {
    const effectId = action.effect.effectId, remoteArtifactIntent = request.remoteArtifactIntent;
    const remoteScope = this.runtime.remoteArtifactRecovery;
    const coordinator = this;
    const authorizationRevision = mission.authorizationRevision ?? 1, goalRevision = action.goalRevision ?? 1;
    return {
      ...(remoteArtifactIntent ? { verifyExecution: async execution => {
        const observation = await remoteScope.client.reconcileDurableArtifact({ store: coordinator.store,
          binding: remoteScope.binding, effectId });
        if (digest(execution) !== digest(observation.receipt)) throw error('A_MISSION_REMOTE_ARTIFACT_RECEIPT_CHANGED');
        return new RemoteArtifactVerifier({ client: remoteScope.client }).verify({ observation,
          taskId: task.taskId, action: request.action });
      } } : {}),
      idempotencyKey: action.operation.operationId,
      async beforeExecute(packet) {
        const assertLive = () => {
          const liveTask = coordinator.runtime.coreFacade.getTask(task.taskId);
          const currentTask = publicationRecovery ? task : coordinator.runtime.coreFacade.getTask(task.taskId);
          if (coordinator.runtime.shutdownRequest || ['CANCELLED', 'FAILED', 'BLOCKED', 'COMPLETED'].includes(mission.status)
            || (publicationRecovery ? !['planned', 'running'].includes(action.status) : action.status !== 'running')
            || (mission.authorizationRevision ?? 1) !== authorizationRevision || (action.goalRevision ?? 1) !== goalRevision
            || (publicationRecovery && (liveTask?.status === 'CANCELLED'
              || (liveTask?.plan && digest(liveTask.plan.action) !== request.actionSha256)))
            || ['CANCELLED', 'FAILED', 'BLOCKED'].includes(currentTask?.status)
            || coordinator.runtime.goalRevisions?.actionIssue(mission, action, currentTask)) throw error('A_MISSION_EFFECT_REQUEST_STOPPED');
          // B calls this fence again after async shadow work, just before the
          // adapter mutates a file. A live lease alone is not live authority.
          const runtime = coordinator.runtime;
          runtime.executionAuthority?.assertActive();
          const profile = runtime.capabilityProfile(currentTask);
          if (mission.authorization.mode === 'trusted_session'
            && runtime.ownerSessionManager?.authorizeMission?.({ sessionId: mission.authorization.ownerSessionId,
              requestedGrants: [profile.executionClass] })?.allowed !== true) throw error('A_MISSION_EFFECT_OWNER_AUTHORITY_REVOKED');
          if (!runtime.actionAuthorized(mission, action, profile)) throw error('A_MISSION_EFFECT_AUTHORITY_REVOKED');
          runtime.personalDependencyGuard?.assertCurrentMission(mission);
          action.scheduleTemporalVerification=runtime.routineTemporalGuard?.assertCurrentMission(mission)??null;
          const deadlineProof=runtime.completionDeadline.assertCurrentMission(mission,{toolName:currentTask.plan?.action?.toolName});
          action.deadlineTemporalVerification=deadlineProof?{...deadlineProof,actionId:action.actionId}:null;
          if (mission.executionMandateId) {
            if (!runtime.executionBudget) throw error('A_MISSION_EFFECT_MANDATE_UNAVAILABLE');
            try { runtime.executionBudget.beforeAction(mission); }
            catch { throw error('A_MISSION_EFFECT_MANDATE_REVOKED'); }
          }
          const snapshot = action.availabilityBindingSnapshot;
          if (snapshot) {
            let availability;
            try { availability = runtime.capabilityAvailabilityGuard.registry?.availabilityFor(snapshot.binding,
              { minimumVerification: 'live-probe', permissionRevision: snapshot.permissionRevision }); }
            catch { throw error('A_MISSION_EFFECT_AVAILABILITY_UNVERIFIED'); }
            if (availability?.available !== true || availability.codeVersion !== snapshot.codeVersion) {
              throw error('A_MISSION_EFFECT_AVAILABILITY_REVOKED');
            }
          }
        };
        try { assertLive(); }
        catch (cause) { coordinator.cancelPrepared(action, { reason: 'mission-stopped-before-effect-claim' }); throw cause; }
        const stored = coordinator.effect(action);
        if (packet.taskId !== request.taskId || packet.action?.toolName !== request.toolName
          || digest(packet.action) !== request.actionSha256) throw error('A_MISSION_EFFECT_PACKET_MISMATCH');
        const claim = publicationRecovery
          ? coordinator.store.claimWorkflowPublicationRecovery({ effectId, requestSha256: stored.request_sha256, ownerId: coordinator.ownerId, ttlMs: coordinator.leaseTtlMs })
          : coordinator.store.claimEffect({ effectId, ownerId: coordinator.ownerId, ttlMs: coordinator.leaseTtlMs });
        if (!claim) { action.effect.dispatchDeferred = true; throw error('A_MISSION_EFFECT_CLAIM_UNAVAILABLE'); }
        coordinator.project(action, claim.effect);
        const timer = setInterval(() => {
          try { coordinator.store.heartbeatLease(claim.lease, coordinator.leaseTtlMs); }
          catch { clearInterval(timer); }
        }, Math.max(1, Math.floor(coordinator.leaseTtlMs / 3)));
        timer.unref?.(); coordinator.claims.set(effectId, { ...claim, timer });
        await coordinator.boundary('claimed', action);
        const assertFence = () => {
          assertLive();
          // A PC journal receipt can survive a crash before onReceipt commits
          // the Mission snapshot. Preserve the bound final dispatch observation
          // before B mutates a file; never reconstruct its time from recovery.
          if(action.scheduleTemporalVerification||action.deadlineTemporalVerification)coordinator.runtime.persist('mission-temporal-dispatch-observed');
          return coordinator.store.assertEffectDispatch({ effectId, lease: claim.lease, requestSha256: stored.request_sha256 });
        };
        if(request.movePlan)assertFence.assertMovePlan=items=>{
          assertFence();
          if(digest(items.map(({from,to,action})=>({from,to,action})))!==digest(request.movePlan))throw error('A_MISSION_MOVE_PLAN_CHANGED');
        };
        if(request.artifactPlan)assertFence.assertArtifactPlan=({paths,prepared})=>{
          assertFence();
          if(digest(paths)!==digest(request.artifactPlan.paths)||digest(prepared)!==request.artifactPlan.preparedSha256)throw error('A_MISSION_ARTIFACT_PLAN_CHANGED');
        };
        if(request.weatherPublication)assertFence.weatherPublication=structuredClone(request.weatherPublication);
        if(request.macroPublication)assertFence.macroPublication=structuredClone(request.macroPublication);
        if (coordinator.remote) assertFence.onRemoteCancellation = cancellation => {
          coordinator.project(action, coordinator.store.confirmRemoteCancellation({ effectId, lease: claim.lease, cancellation }));
          coordinator.stopTimer(action);
        };
        assertFence();
        return assertFence;
      },
      async onReceipt(execution, packet) {
        if (execution?.status !== 'COMPLETED') return;
        if(request.weatherPublication){try{validateWeatherPublicationResult(request.weatherPublication,execution.executionResult);}
          catch{throw error('A_MISSION_EFFECT_WEATHER_RECEIPT_CONTRACT_MISMATCH');}}
        if(request.macroPublication){try{validateMacroPublicationResult(request.macroPublication,execution.executionResult);}
          catch{throw error('A_MISSION_EFFECT_MACRO_RECEIPT_CONTRACT_MISMATCH');}}
        if(request.toolName==='document.edit'){
          try{validateDocumentEditResult(request.artifactPlan?.documentEditPublication,execution.executionResult);}
          catch{throw error('A_MISSION_EFFECT_EDIT_RECEIPT_CONTRACT_MISMATCH');}
        }
        const claim = coordinator.claims.get(effectId);
        if (!claim || execution.taskId !== task.taskId || execution.executionResult?.packetId !== packet.packetId
          || execution.executionResult?.executedBy?.toolName !== request.toolName || !execution.evidence?.evidenceId
          || execution.executionResult?.dryRun === true || execution.shadow?.dryRun === true) throw error('A_MISSION_EFFECT_RECEIPT_MISMATCH');
        const receipt = coordinator.receipt(execution);
        action.effect.state = 'succeeded'; action.effect.receiptRecorded = true;
        coordinator.store.completeEffect({ effectId, lease: claim.lease, receipt,
          followup: coordinator.followup(action), snapshot: coordinator.snapshot('mission-effect-receipt') });
        coordinator.stopTimer(action);
        await coordinator.boundary('receipt-persisted', action);
      }
    };
  }
  receipt(execution) { return { receiptRef: `pc-packet:${execution.executionResult.packetId}`, taskId: execution.taskId,
    packetId: execution.executionResult.packetId, evidenceId: execution.evidence.evidenceId, source: 'trusted-local-pc-journal' }; }
  followup(action) { return { type: 'verify-mission-observation', operationId: action.operation.operationId, actionId: action.actionId }; }
  stopTimer(action) { const claim = this.claims.get(action.effect?.effectId); if (claim) clearInterval(claim.timer); }
  finish(action, succeeded = false) {
    const effect = this.effect(action); if (!effect) return false;
    this.stopTimer(action);
    if (effect.state === 'prepared' && action.effect.dispatchDeferred === true) return true;
    if (effect.state === 'prepared') this.project(action, this.store.failUndispatchedEffect({ effectId: effect.effect_id, reason: 'worker-preflight-did-not-dispatch' }));
    else if (effect.state === 'in_flight') {
      const claim = this.claims.get(effect.effect_id);
      try { this.store.markUncertain({ effectId: effect.effect_id, lease: claim?.lease }); }
      catch { this.store.recoverExpiredEffects(); }
      this.project(action, this.store.getEffect(effect.effect_id));
    } else this.project(action, effect);
    if (action.effect.state !== 'in_flight') this.claims.delete(effect.effect_id);
    return action.effect.state === 'uncertain' || action.effect.state === 'in_flight' || (action.effect.state === 'succeeded' && !succeeded);
  }
  recovered(action, recovered) {
    const effect = this.effect(action); if (!effect) return;
    if (effect.state === 'uncertain') {
      action.effect.state = 'succeeded'; action.effect.receiptRecorded = true;
      this.store.reconcileEffect({ effectId: effect.effect_id, receipt: this.receipt(recovered.execution), followup: this.followup(action),
        reconciliation: { operationId: effect.operation_id, requestSha256: effect.request_sha256,
          evidenceRef: `g:${recovered.verification.verificationId}` }, snapshot: this.snapshot('mission-effect-reconciled') });
    }
    this.project(action, this.store.getEffect(effect.effect_id));
  }
  persistedGrowthEvent(action, execution) {
    const event = execution?.memoryEvent;
    if (!event?.eventId || event.taskId !== action.taskId || event.eventType !== 'execution.completed') return null;
    const store = this.runtime.orchestrationWorker.growthRuntime?.ingestor?.store;
    return store?.allEvents?.().find(item => item.eventId === event.eventId && item.taskId === action.taskId
      && item.eventType === event.eventType) ?? null;
  }
  recoverLearning(action, execution, recovered, missionId) {
    const effect = this.effect(action);
    if (!effect && !(this.workflowCognitionIntents && action.operation?.dispatch?.toolName === 'workflow.execute')) return null;
    try {
      const request = this.originalMemoryRequest(action, missionId);
      if (!request) throw error('A_MISSION_EFFECT_MEMORY_CONTEXT_MISSING');
      if (!this.persistedGrowthEvent(action, execution)) {
        const task = { taskId: action.taskId, request: structuredClone(request) };
        const learning = this.runtime.orchestrationWorker.ingestAndVerifyLearning(task, execution, { recoveredScopeProof: getRecoveredMemoryScopeProof(recovered) });
        if (learning?.ingest?.success !== true) throw error(learning?.ingest?.error?.code ?? 'A_MISSION_EFFECT_GROWTH_APPEND_FAILED');
      }
      if (!this.persistedGrowthEvent(action, execution)) throw error('A_MISSION_EFFECT_GROWTH_NOT_PERSISTED');
      return { status: 'persisted' };
    } catch (cause) { return { status: 'unavailable', reason: cause.code ?? 'A_MISSION_EFFECT_GROWTH_APPEND_FAILED' }; }
  }
  originalMemoryRequest(action, missionId) {
    const effect = this.effect(action);
    if (effect) return effect.intent.request.taskRequest;
    if (this.workflowCognitionIntents && action.operation?.dispatch?.toolName === 'workflow.execute') {
      return this.workflowCognitionIntents.load(missionId, action)?.request?.taskRequest ?? null;
    }
    return null;
  }
  recoverCognition(recovered){
    const cognition=this.runtime.coreFacade.cognition;
    if(!cognition)return {status:'not-configured'};
    if(!cognition.persistent)return {status:'non-durable-preview'};
    const result=cognition.observeRecovered(recovered);
    return result?.recorded||result?.duplicate?{status:'persisted'}:result?.excluded?{status:'excluded',reason:result.reason}:{status:'unavailable',reason:result?.reason??'cognition-storage-pending'};
  }
  assertMemoriesPersisted(action, execution) {
    if(execution?.cognitionPersistence?.status==='pending')throw error('A_MISSION_EFFECT_COGNITION_PENDING');
    if (!this.effect(action) && !(this.workflowCognitionIntents && action.operation?.dispatch?.toolName === 'workflow.execute')) return;
    if (!this.persistedGrowthEvent(action, execution)) throw error('A_MISSION_EFFECT_GROWTH_NOT_PERSISTED');
    const outputs = execution.executionResult?.outputPaths ?? [];
    const saved = this.runtime.coreFacade.workMemory?.load?.().some(entry => entry.taskId === action.taskId
      && entry.operationId === action.operation.operationId
      && entry.status === 'success' && entry.outputPaths?.length === outputs.length
      && entry.outputPaths.every((path, index) => pathIdentity(resolve(path)) === pathIdentity(resolve(outputs[index]))));
    if (!saved) throw error('A_MISSION_EFFECT_WORK_MEMORY_NOT_PERSISTED');
  }
  verified(action, execution) {
    const effect = this.effect(action);
    if (effect?.state !== 'succeeded') return;
    this.assertMemoriesPersisted(action, execution);
    this.store.acknowledgeFollowup(`effect-result:${effect.effect_id}`, { snapshot: this.snapshot('mission-effect-verified') });
  }
}
