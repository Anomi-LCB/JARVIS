import {isDeepStrictEqual} from 'node:util';
import {normalizeMicrosoftCollection} from '../personal-operations/microsoft-collection-request.js';
import {captureMicrosoftCollection,collectMicrosoftCollectionResult,planMicrosoftCollection,microsoftCollectionGoalBound,microsoftCollectionPageLimit} from './microsoft-collection-result.js';
import { withMissionMandateFence } from '../personal-operations/mission-mandate-fence.js';
import {withManagedParentReadFence} from './managed-parent-read-fence.js';
import {reviewCancelledMission} from './cancelled-mission-review.js';
import {captureSelectedSource,collectSelectedSourceResult,planSelectedSourcePages,selectedSourceGoalBound} from './selected-source-result.js';
import {captureLifecycleCase,collectLifecycleCaseResult,planLifecycleCaseRead,lifecycleCaseGoalBound} from './lifecycle-case-result.js';
import {bindNaturalWorkflowDispatches} from './natural-workflow-mission-plan.js';
import {verifyMcpMissionCriterion} from './mcp-criterion-verifier.js';
import {missionDependencyImpact,missionDependencyImpacts} from './mission-dependency-impact.js';
import {reconcileMissionDependencyImpacts,listMissionDependencyImpactEvents} from './mission-dependency-impact-journal.js';
import {setMissionMoneyDependency} from './mission-money-dependency.js';
import {assessMissionQuantityConstraints} from './mission-quantity-constraints.js';
import {verifyMissionSourceQuantity,missionSourceQuantity} from './mission-allocation-plan.js';
import {parseLiteralTextFileBatch} from '../planning/literal-text-file-request.js';
import {readSendDefaultCriteria} from './read-send-default-criteria.js';
import {resolveClarificationContext} from './clarification-context.js';
import {explicitReadApproval,explicitApprovalAnswer} from './explicit-read-approval.js';
import {verifyFinancialReportResult} from './mission-financial-report-result.js';
import {createOfxSaveWorkflow} from './ofx-save-workflow.js';
import {planOfxSaveMission,verifyOfxSaveMission} from './ofx-save-mission.js';
import { clarificationQuestions, independentClarificationRead, clarificationReadBinding, sameClarificationReadBinding, clarificationDispatchAllowed, clarificationAnswerBatch } from './mission-clarification.js';
import {verifyFieldSummaryResult} from './mission-field-summary-result.js';
import {verifyHealthReportResult} from './mission-health-report-result.js';
import {verifyTheologyReviewResult} from './mission-theology-review-result.js';
import {verifySafetySimulationResult} from './mission-safety-simulation-result.js';
import {verifyFieldSummaryResultAsync,verifyHealthReportResultAsync,verifyFinancialReportResultAsync} from './field-summary-async.js';
import {pcLocalDenialNextAction,pcCommandDenialNextAction} from '../../../shared/src/pc-local-denial.js';
import {sourceChangeView} from '../../../shared/src/source-change-view.js';
import { createHash } from 'node:crypto';
import {captureTextRead} from './mission-text-read-delivery.js';
import {prepareSourceNotes,sourceProcessingView} from './mission-source-processing.js';
import { reservedMissionTaskId } from './mission-task-reservation.js';
import {verifyReadOnlyListing, planReadOnlyListingContinuation} from './read-only-listing-proof.js';
import {verifyReadOnlyText,planReadOnlyTextContinuation,planReadOnlyTextStart} from './read-only-text-proof.js';
import {planTypedTextInputReads} from './read-only-text-batch-plan.js';
import {planReadCriterionRoleClarification} from './read-criterion-role-clarification.js';
import {planResearchSourceWorkflow} from './research-source-workflow.js';
import { exhaustiveListingItems } from './listing-completeness.js';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { appendJsonlSync } from '../../../shared/src/jsonl.js';
import { ApprovalDecision, createApprovalDecision, InputSource, ModuleId, stableId, TaskStatus } from '../../../shared/src/types.js';
import { MemoryMissionStore } from './mission-store.js';
import { MissionEffectCoordinator } from './mission-effect-coordinator.js';
import {MacroStore} from '../macro-store.js';
import {createWorkflowResumeCheckpoint,readWorkflowResumeCheckpoint} from './workflow-resume-checkpoint.js';
import {MissionCompletionDeadline} from './mission-completion-deadline.js';
import { remoteArtifactDigest } from './remote-artifact-contract.js';
import { MissionGoalRevisionCoordinator } from './mission-goal-revision.js';
import { captureMissionGoalContract } from './mission-goal-contract.js';
import { assessMissionGoalCompletionCoverage, assessMissionRequirementCoverage, normalizeActionRequirementLinks, explainRequirementCoverageFailure } from './mission-requirement-coverage.js';
import { resolveMissionWorkReference } from '../work-reference-context.js';
import {
  checkpointMissionActionDispatch,
  ensureMissionActionOperation,
  recoverMissionAction
} from './mission-action-recovery.js';
import {
  boundNewsProvenance,
  evaluateObservedArticleCitations,
  observedArticleCitationRequirement,
  observedNewsSummaryRequirement
} from './news-article-provenance.js';
import { screenMissionObservationsForPlanning } from './mission-planner.js';
import { normalizeMissionRoleAssignment, validateMissionRoleTool } from './mission-role-scope.js';
import { prepareSourceOutcome, verifySourceOutcome } from './mission-source-outcome-oracle.js';
import { sanitizePlannerExceptionAccounting } from './planner-attempt-accounting.js';
import { capturePlannedCapabilityBinding, MissionCapabilityAvailabilityGuard, requiresCapabilityAvailability } from './mission-capability-availability.js';
import {
  CRITERION_EVIDENCE_VERSION,
  criterionVerificationSummary,
  legacyCriterionNeedsContentProof,
  normalizeCriterionExtensions,
  searchCoverageAllowsAbsence,
  verifyTypedCriterion
} from './criteria-evidence.js';

export const MissionStatus = Object.freeze({
  CREATED: 'CREATED',
  PLANNING: 'PLANNING',
  RUNNING: 'RUNNING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export const MissionGrant = Object.freeze({
  READ_ONLY: 'read_only',
  LOCAL_REVERSIBLE: 'local_reversible',
  HIGH_IMPACT: 'high_impact'
});

const terminalStatuses = new Set([
  MissionStatus.COMPLETED,
  MissionStatus.BLOCKED,
  MissionStatus.FAILED,
  MissionStatus.CANCELLED
]);
const terminalActionStatuses = new Set(['succeeded', 'failed', 'skipped']);
const acceptedGrants = new Set(Object.values(MissionGrant));

function hasValidPublisherFeedEvidence(item) {
  try {
    const feed = new URL(item?.feedUrl);
    const finalFeed = new URL(item?.finalFeedUrl);
    const portAllowed = url => !url.port || url.port === '443';
    if (feed.protocol !== 'https:' || finalFeed.protocol !== 'https:' || !portAllowed(feed) || !portAllowed(finalFeed)
      || feed.username || feed.password || finalFeed.username || finalFeed.password
      || finalFeed.hostname !== item?.sourceHost || item?.sourceHost === 'news.google.com'
      || !item?.retrievedAt || item?.live !== true || item?.replay === true || item?.fixture === true || item?.fetched !== true
      || Number(item?.httpStatus ?? 0) < 200 || Number(item?.httpStatus ?? 0) >= 300
      || !Number.isInteger(item?.itemCount) || item.itemCount <= 0
      || !Array.isArray(item?.items) || item.items.length !== item.itemCount) return false;
    return item.items.every(article => {
      const url = new URL(article?.url);
      return Boolean(article?.title && article?.source && article?.publishedAt)
        && url.protocol === 'https:' && portAllowed(url) && !url.username && !url.password
        && url.hostname !== 'news.google.com';
    });
  } catch { return false; }
}

export class MissionRuntime {
  #remoteCompletionChecks = new WeakMap();
  #pendingCompletionChecks = new WeakMap();
  #unpublishedPersonFailures = new WeakMap();
  #clarificationReadBindings = new WeakMap();
  clarificationReadAllowed(mission,wave,action,task,{capture=false}={}) {
    if(!(wave.clarificationGateId||wave.clarificationContextResolved))return true;
    if(!clarificationDispatchAllowed(wave,action,this.capabilityProfile(task)))return false;
    const binding=clarificationReadBinding(mission,task.plan?.action?.toolName,task.plan?.action?.arguments,this.allowedRoots);
    if(capture){if(!binding)return false;this.#clarificationReadBindings.set(action,structuredClone(binding));action.clarificationReadSource=structuredClone(binding);return true;}
    return sameClarificationReadBinding(this.#clarificationReadBindings.get(action),binding);
  }
  hasVerifiedUnpublishedPersonFailure(action){
    const proof=this.#unpublishedPersonFailures.get(action);
    return Boolean(proof&&action.status==='failed'&&proof.taskId===action.taskId
      &&proof.dispatchSha256===sha256(JSON.stringify(action.operation?.dispatch??null)));
  }
  constructor({
    coreFacade,
    orchestrationWorker,
    pcAgent,
    planner,
    store = new MemoryMissionStore(),
    allowedRoots = ['./workspace'],
    eventLogPath = null,
    ownerSessionManager = null,
    clock = () => new Date(),
    maxActionsPerWave = 4,
    maxPlannerTools = Number(process.env.JARVIS_MISSION_MAX_TOOLS ?? 12),
    observationInjectionDetector = null,
    injectionDetector = null,
    capabilityPackageRegistry = null,
    capabilityBindingResolver = null,
    capabilityAvailabilityProbe = null,
    managedAgentSessionBroker = null,
    dataClassifier = null,
    executionAuthority = null,
    remoteArtifactRecovery = null,
    selectedSourceAccess = null,
    lifecycleCaseAccess = null,
    microsoftCollectionAccess = null
  } = {}) {
    if (!coreFacade) throw new Error('MissionRuntime requires coreFacade.');
    if (!orchestrationWorker) throw new Error('MissionRuntime requires orchestrationWorker.');
    if (!pcAgent) throw new Error('MissionRuntime requires pcAgent.');
    if (!planner?.planNextWave) throw new Error('MissionRuntime requires planner.planNextWave.');
    if (managedAgentSessionBroker !== null && (typeof managedAgentSessionBroker.bindSession !== 'function'
      || typeof managedAgentSessionBroker.sendMissionMessage !== 'function'
      || typeof managedAgentSessionBroker.cancelMissionTurn !== 'function'
      || typeof managedAgentSessionBroker.reconcileMission !== 'function')) throw new Error('MissionRuntime managedAgentSessionBroker is invalid.');
    this.coreFacade = coreFacade;
    this.orchestrationWorker = orchestrationWorker;
    this.pcAgent = pcAgent;
    this.planner = planner;
    this.dataClassifier = dataClassifier ?? planner.dataClassifier ?? null;
    this.store = store;
    this.remoteArtifactRecovery = remoteArtifactRecovery;
    this.selectedSourceAccess = selectedSourceAccess;
    this.lifecycleCaseAccess=lifecycleCaseAccess;
    this.microsoftCollectionAccess=microsoftCollectionAccess;
    this.executionAuthority = executionAuthority;
    if (executionAuthority) {
      if (executionAuthority.store !== store || typeof executionAuthority.assertActive !== 'function') throw new Error('A_CORE_AUTHORITY_BINDING_INVALID');
      executionAuthority.assertActive({allowRecovery:true});
    }
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.eventLogPath = eventLogPath;
    this.ownerSessionManager = ownerSessionManager;
    this.managedAgentSessionBroker = managedAgentSessionBroker;
    this.clock = clock;
    this.completionDeadline=new MissionCompletionDeadline({clock});
    this.maxActionsPerWave = clampInteger(maxActionsPerWave, 1, 8, 4);
    this.maxPlannerTools = clampInteger(maxPlannerTools, 4, 64, 12);
    this.observationInjectionDetector = observationInjectionDetector ?? injectionDetector;
    this.capabilityPackageRegistry=capabilityPackageRegistry;
    this.capabilityAvailabilityGuard = new MissionCapabilityAvailabilityGuard({ registry: capabilityPackageRegistry,
      resolver: capabilityBindingResolver, probe: capabilityAvailabilityProbe, clock });
    this.missions = new Map();
    this.activeRuns = new Map();
    this.sourceOutcomePreparations = new Map();
    this.persistSequence = 0;
    this.effectCoordinator = new MissionEffectCoordinator(this);
    this.goalRevisions = new MissionGoalRevisionCoordinator(this, { normalizeSuccessCriteria, normalizeConstraints });
    this.loadPersistedMissions();
    this.goalRevisions.hydrate();
  }

  loadPersistedMissions() {
    const recovered = this.store.load?.() ?? [];
    let changed = false;
    for (const stored of recovered) {
      const mission = structuredClone(stored);
      if ([MissionStatus.PLANNING, MissionStatus.RUNNING].includes(mission.status)) {
        mission.status = MissionStatus.PAUSED;
        mission.stopReason = 'runtime-restart-recovery';
        mission.recovery = {
          recoveredAt: this.clock().toISOString(),
          previousStatus: stored.status,
          pendingActionIds: mission.waves
            .flatMap((wave) => wave.actions)
            .filter((action) => !terminalActionStatuses.has(action.status))
            .map((action) => action.actionId)
        };
        mission.updatedAt = this.clock().toISOString();
        for (const action of mission.waves.flatMap((wave) => wave.actions)) {
          if (['ready', 'running'].includes(action.status)) {
            action.recovery = { ...action.recovery, required: true, previousStatus: action.status };
            action.status = 'planned';
          }
        }
        mission.metrics.currentConcurrency = 0;
        changed = true;
      }
      if (terminalStatuses.has(mission.status)) {
        const danglingGates = mission.gates.filter((gate) => gate.status === 'pending');
        if (danglingGates.length > 0) {
          const recoveredAt = this.clock().toISOString();
          for (const gate of danglingGates) {
            gate.status = 'cancelled';
            gate.decision = 'cancelled';
            gate.decidedAt = recoveredAt;
            gate.decidedBy = 'runtime-recovery';
          }
          changed = true;
        }
      } else {
        for (const action of mission.waves.flatMap((wave) => wave.actions)) {
          // Approval cards are Core task instances, not durable execution grants.
          // Rebuild an undispatched pending action through current routing/E;
          // never attach the old decision to a newly created task implicitly.
          const gate=mission.gates.find(item=>item.gateId===action.gateId&&item.type==='action_approval'&&item.status==='pending');
          const task=action.taskId?this.coreFacade.getTask(action.taskId):null;
          const effect=this.effectCoordinator.effect(action);
          if(action.status==='waiting_approval'&&action.attempts===0&&gate&&gate.actionId===action.actionId
            &&gate.commandHash===action.commandHash&&!task
            &&!action.recovery?.required&&(!effect||effect.state==='prepared')){
            const recoveredAt=this.clock().toISOString();
            gate.status='cancelled';gate.decision='cancelled';gate.decidedAt=recoveredAt;
            gate.decidedBy='runtime-recovery';gate.cancelReason='approval-task-not-restored';
            action.approvalRestoration={previousGateId:gate.gateId,previousTaskId:action.taskId,
              recoveredAt,status:'current-policy-review-required'};
            action.status='planned';action.gateId=null;
            mission.status=MissionStatus.PAUSED;mission.stopReason='approval-task-restoration-required';
            mission.updatedAt=recoveredAt;changed=true;
          }
          if (['ready', 'running'].includes(action.status)) {
            action.recovery = { ...action.recovery, required: true, previousStatus: action.status };
            action.status = 'planned';
            changed = true;
          }
        }
      }
      if(this.orchestrationWorker.pcAgent===this.pcAgent){
        for(const action of mission.waves.flatMap(wave=>wave.actions)){
          if(action.status!=='failed'||action.actualToolName!=='workflow.execute'
            ||action.operation?.dispatch?.taskId!==action.taskId)continue;
          const proof=this.pcAgent.unpublishedPersonFailureForDispatch?.(action.operation.dispatch);
          if(proof)this.#unpublishedPersonFailures.set(action,{...proof,dispatchSha256:sha256(JSON.stringify(action.operation.dispatch))});
        }
      }
      this.missions.set(mission.missionId, mission);
    }
    if (this.effectCoordinator.hydrate()) changed = true;
    if (changed) this.persist('runtime-restart-recovery');
  }

  createMission({
    objective,
    successCriteria = [],
    constraints = [],
    budgets = {},
    authorization = {},
    metadata = {},
    idempotencyKey = null,
    executionMandateId = null,
    selectedSource = null,
    lifecycleCase = null,
    microsoftCollection = null
  } = {}) {
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(idempotencyKey))) {
      return failure('A_MISSION_IDEMPOTENCY_INVALID', 'Invalid mission idempotency key.');
    }
    const creationRequestHash = idempotencyKey ? sha256(JSON.stringify({ objective, successCriteria, constraints, budgets, authorization, metadata, ...(executionMandateId ? {executionMandateId} : {}),...(selectedSource?{selectedSource}:{}),...(lifecycleCase?{lifecycleCase}:{}),...(microsoftCollection?{microsoftCollection}:{}) })) : null;
    if (idempotencyKey) {
      const prior = [...this.missions.values()].find(item => item.idempotencyKey === idempotencyKey);
      if (prior) return prior.creationRequestHash === creationRequestHash
        ? this.publicMission(prior)
        : failure('A_MISSION_IDEMPOTENCY_CONFLICT', 'The key is already bound to a different mission request.');
    }
    if(executionMandateId!==null){
      try{if(!this.executionBudget)throw new Error('A_MANDATE_SERVICE_UNAVAILABLE');this.executionBudget.validate(executionMandateId);}
      catch(error){return failure(error.code==='A_PERSONAL_LINK_DEPENDENCY_CHANGED'?error.code:'A_MANDATE_EXECUTION_DENIED',error.message);}
    }
    if(this.executionAuthority?.recoveryOnly)return failure('A_CORE_AUTHORITY_RECOVERY_ONLY',
      'Recovery-only Core cannot create new missions. Reconcile existing effects before explicitly restarting normal execution.');
    if (typeof objective !== 'string' || objective.length > 32768) {
      return failure('A_MISSION_OBJECTIVE_INVALID', 'Mission objective must be text of at most 32768 characters.');
    }
    let normalizedObjective = objective.trim();
    if (!normalizedObjective) {
      return failure('A_MISSION_OBJECTIVE_REQUIRED', 'Mission objective is required.');
    }
    const referenced = resolveMissionWorkReference(this.coreFacade, normalizedObjective, metadata);
    if (referenced.resolution?.issue) {
      const issue = referenced.resolution.issue;
      return failure(issue.code, issue.message, { reference: issue });
    }
    normalizedObjective = referenced.objective;
    metadata = referenced.metadata;
    const createdAt = this.clock().toISOString();
    let microsoftCollectionContract;
    if(microsoftCollection!==null){try{if(!this.microsoftCollectionAccess||selectedSource!==null||lifecycleCase!==null)throw Error();microsoftCollectionContract=captureMicrosoftCollection(normalizedObjective,microsoftCollection);}catch{return failure('A_MICROSOFT_COLLECTION_REQUEST_UNSUPPORTED','선택한 연결의 한 페이지 또는 제한된 전체 페이지 메타데이터 수집을 지원합니다. 추가 요구를 생략하지 않습니다.');}}
    let selectedSourceContract;
    let lifecycleCaseContract;
    if(lifecycleCase!==null){try{if(!this.lifecycleCaseAccess||selectedSource!==null)throw Error();lifecycleCaseContract=captureLifecycleCase(normalizedObjective,lifecycleCase);}catch{return failure('A_LIFECYCLE_CASE_REQUEST_UNSUPPORTED','선택한 로컬 업무 기록 조회만 지원합니다. 추가 지시를 생략하지 않습니다.');}}
    if(selectedSource!==null){
      try{
        if(!this.selectedSourceAccess)throw new Error('A_SELECTED_SOURCE_UNAVAILABLE');
        selectedSourceContract=captureSelectedSource(normalizedObjective,selectedSource);
      }catch{return failure('A_SELECTED_SOURCE_REQUEST_UNSUPPORTED','선택 자료와 전체 조회 요청을 확인해야 합니다. 계정 연결이 준비되어야 하며 추가 지시를 생략하지 않습니다.');}
    }
    const missionId = stableId('mission', `${normalizedObjective}:${this.missions.size + 1}`, createdAt);
    let criteria, normalizedConstraints;
    try {
      criteria = normalizeSuccessCriteria(successCriteria, objective.length);
      normalizedConstraints = normalizeConstraints(constraints);
      // Derive concrete oracles only from the complete bounded source grammar.
      // Caller criteria remain authoritative; unsupported tails infer nothing.
      const literals = !criteria.length && !normalizedConstraints.length ? parseLiteralTextFileBatch(normalizedObjective) : null;
      if (literals) criteria = normalizeSuccessCriteria(literals.map((item,index)=>({
        criterionId:`literal_file_${index+1}`, statement:normalizedObjective,
        verificationSpec:{version:1,kind:'text.equals',path:item.fileName,equals:item.content}
      })),objective.length);
      if(!criteria.length && !normalizedConstraints.length && objective.trim()===normalizedObjective) {
        const readSend=readSendDefaultCriteria(objective);
        if(readSend) criteria=normalizeSuccessCriteria(readSend,objective.length);
      }
    }
    catch (error) { return failure(error.code ?? 'A_MISSION_CRITERION_INVALID', error.message); }
    const mission = {
      missionVersion: 'a-autonomous-mission-v1',
      ...(idempotencyKey ? { idempotencyKey, creationRequestHash } : {}),
      missionId,
      ...(executionMandateId ? {executionMandateId} : {}),
      ...(microsoftCollectionContract?{microsoftCollection:microsoftCollectionContract}:{}),
      ...(selectedSourceContract?{selectedSource:selectedSourceContract}:{}),
      ...(lifecycleCaseContract?{lifecycleCase:lifecycleCaseContract}:{}),
      objective: normalizedObjective,
      objectiveHash: sha256(normalizedObjective),
      successCriteria: criteria.length > 0 ? criteria : [{
        criterionId: 'criterion_1',
        statement: normalizedObjective
      }],
      verificationVersion: CRITERION_EVIDENCE_VERSION,
      verificationSummary: null,
      constraints: normalizedConstraints,
      budgets: normalizeBudgets(budgets),
      authorization: normalizeAuthorization(authorization),
      authorizationRevision: 1,
      metadata: sanitizeMetadata(metadata),
      status: MissionStatus.CREATED,
      stopReason: null,
      waves: [],
      gates: [],
      observations: [],
      planHistory: [],
      failureSignatures: {},
      metrics: {
        plannerCalls: 0,
        plannerAttempts: 0,
        plannerRetries: 0,
        plannedActions: 0,
        executedActions: 0,
        successfulActions: 0,
        failedActions: 0,
        routeMismatches: 0,
        routeAdaptations: 0,
        replans: 0,
        parallelBatches: 0,
        maxObservedParallelism: 0,
        activeRuntimeMs: 0,
        currentConcurrency: 0
      },
      completion: null,
      recovery: null,
      createdAt,
      updatedAt: createdAt
    };
    mission.goalContract = captureMissionGoalContract({
      objective, resolvedObjective: normalizedObjective, missionId,
      successCriteria: mission.successCriteria, createdAt
    });
    this.missions.set(missionId, mission);
    this.persist('mission-created');
    this.recordEvent('mission.created', mission, {
      criterionCount: mission.successCriteria.length,
      grants: mission.authorization.grants,
      budgets: mission.budgets
    });
    return this.publicMission(mission);
  }

  getMission(missionId) {
    const mission = this.missions.get(missionId);
    return mission ? this.publicMission(mission) : null;
  }
  createOfxSaveMission({input,authorization,idempotencyKey}){
    if(typeof idempotencyKey!=='string'||!/^(?:ofx_save_|workspace_)[a-zA-Z0-9-]{1,100}$/u.test(idempotencyKey))return failure('A_FINANCIAL_SAVE_KEY_INVALID','A stable request key is required.');
    const operationId=sha256(idempotencyKey).slice(0,32);
    let prepared;
    try{prepared=createOfxSaveWorkflow(input,{operationId});}catch{return failure('A_FINANCIAL_REQUEST_INVALID','Invalid supplied financial records.');}
    const objective=`'${prepared.inputPath}' OFX 금융자료를 대사해 '${prepared.reportPath}'에 저장하고 다시 읽어 확인해줘`;
    const created=this.createMission({objective,idempotencyKey,authorization,metadata:{longTermMemory:false,financialInputSha256:sha256(JSON.stringify(input))},
      successCriteria:[{criterionId:'financial-save',statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}]});
    if(created.success===false)return created;
    const mission=this.missions.get(created.missionId);
    if(!mission.ofxSave){mission.ofxSave={input:structuredClone(input),operationId,objective};this.touch(mission,'financial-save-prepared');}
    return this.publicMission(mission);
  }
  resultReadGuard(mission){
    if(!mission.executionMandateId)return undefined;
    return access=>{
      if(typeof this.executionBudget?.beforeResultRead!=='function')throw Object.assign(new Error('A_MANDATE_RESULT_PERMISSION_UNAVAILABLE'),{code:'A_MANDATE_RESULT_PERMISSION_UNAVAILABLE'});
      return this.executionBudget.beforeResultRead(mission,{...access,workspaceRoot:this.allowedRoots[0]});
    };
  }
  async getVerifiedFinancialReport(missionId){
    const mission=this.missions.get(missionId);
    if(!mission)return {success:false,error:{code:'A_MISSION_NOT_FOUND'}};
    if(mission.status!=='COMPLETED')return {missionId,status:'not-completed'};
    const objective=mission.objective,revision=mission.goalContract?.revision;
    const proof=mission.ofxSave?verifyOfxSaveMission({mission,prepared:mission.ofxSave,statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,observations:mission.observations,allowedRoots:this.allowedRoots??[],includeReport:true,beforeAccess:this.resultReadGuard(mission)}):await verifyFinancialReportResultAsync({objective,statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,observations:mission.observations,allowedRoots:this.allowedRoots??[]},{beforeAccess:this.resultReadGuard(mission)});
    if(mission.status!=='COMPLETED'||mission.objective!==objective||mission.goalContract?.revision!==revision)return {missionId,status:'changed-or-unavailable'};
    if(!proof.applicable)return {missionId,status:'unsupported'};
    if(!proof.passed||typeof proof.reportMarkdown!=='string'||proof.reportMarkdown.length>65536)return {missionId,status:'changed-or-unavailable'};
    return {missionId,status:'verified',checkedAt:proof.checkedAt,reportMarkdown:proof.reportMarkdown,sourceAuthenticated:false,executionAuthority:false};
  }
  async getVerifiedHealthReport(missionId){
    const mission=this.missions.get(missionId);
    if(!mission)return {success:false,error:{code:'A_MISSION_NOT_FOUND'}};
    if(mission.status!=='COMPLETED')return {missionId,status:'not-completed'};
    const objective=mission.objective,revision=mission.goalContract?.revision;
    const proof=await verifyHealthReportResultAsync({objective,statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,observations:mission.observations,allowedRoots:this.allowedRoots??[]},{beforeAccess:this.resultReadGuard(mission)});
    if(mission.status!=='COMPLETED'||mission.objective!==objective||mission.goalContract?.revision!==revision)return {missionId,status:'changed-or-unavailable'};
    if(!proof.applicable)return {missionId,status:'unsupported'};
    if(!proof.passed||typeof proof.reportMarkdown!=='string'||proof.reportMarkdown.length>65536)return {missionId,status:'changed-or-unavailable'};
    return {missionId,status:'verified',checkedAt:proof.checkedAt,reportMarkdown:proof.reportMarkdown,clinicalInterpretationVerified:false,deviceConnectionVerified:false};
  }
  async getVerifiedFieldSummary(missionId){
    const mission=this.missions.get(missionId);
    if(!mission)return {success:false,error:{code:'A_MISSION_NOT_FOUND'}};
    if(mission.status!=='COMPLETED')return {missionId,status:'not-completed',fields:[]};
    const objective=mission.objective,revision=mission.goalContract?.revision;
    const proof=await verifyFieldSummaryResultAsync({objective,statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,observations:mission.observations,allowedRoots:this.allowedRoots??[]},{beforeAccess:this.resultReadGuard(mission)});
    if(mission.status!=='COMPLETED'||mission.objective!==objective||mission.goalContract?.revision!==revision)return {missionId,status:'changed-or-unavailable',fields:[]};
    return {missionId,status:proof.passed?'verified':proof.applicable?'changed-or-unavailable':'unsupported',checkedAt:proof.checkedAt??new Date().toISOString(),fields:proof.passed?proof.fields:[],semanticAccuracyVerified:false};
  }

  findMissionByRequestId(requestId) {
    const mission = [...this.missions.values()].find(item => item.idempotencyKey === requestId);
    return mission ? this.publicMission(mission) : null;
  }

  reviseMissionGoal(missionId, input) {
    return this.goalRevisions.request(missionId, input);
  }

  listMissions({ limit = 50, status = null } = {}) {
    const items = [...this.missions.values()]
      .filter((mission) => !status || mission.status === status)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, clampInteger(limit, 1, 200, 50))
      .map((mission) => this.publicMission(mission, { detail: false }));
    return { success: true, items, status: this.status() };
  }

  async runMission(missionId, { maxWaves = null, reconciliationOnly = false } = {}) {
    if(typeof reconciliationOnly!=='boolean')return failure('A_CORE_AUTHORITY_RECOVERY_REQUEST_INVALID','Invalid reconciliation request.',{missionId});
    if(reconciliationOnly&&this.executionAuthority?.recoveryOnly!==true)return failure('A_CORE_AUTHORITY_RECOVERY_MODE_REQUIRED',
      'Reconciliation request requires recovery-only Core. No normal task was started.',{missionId});
    if (this.shutdownRequest) return failure('A_MISSION_RUNTIME_SHUTTING_DOWN', 'Mission runtime is shutting down.', { missionId });
    try { this.executionAuthority?.assertActive({allowRecovery:true}); }
    catch (error) { return failure('A_CORE_AUTHORITY_EXECUTION_DENIED',error.message,{missionId}); }
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if(this.executionAuthority?.recoveryOnly&&!terminalStatuses.has(mission.status)
      &&!mission.waves.some(wave=>wave.actions.some(action=>action.recovery?.required
        ||['in_flight','uncertain'].includes(this.effectCoordinator.effect(action)?.state))))
      return failure('A_CORE_AUTHORITY_RECOVERY_ONLY','Only existing interrupted effects may be reconciled in recovery mode.',{missionId});
    const revisionIssue = this.goalRevisions.blocksRun(mission);
    if (revisionIssue) return revisionIssue;
    if (this.activeRuns.has(missionId)) {
      return failure('A_MISSION_ALREADY_RUNNING', 'Mission already has an active run.', {
        missionId,
        mission: this.publicMission(mission)
      });
    }
    const quotaContext={missionStore:this.store,missions:[...this.missions.values()]};
    if (terminalStatuses.has(mission.status)) {this.executionBudget?.afterRun(mission,quotaContext);return this.publicMission(mission);}
    try{this.routineTemporalGuard?.assertCurrentMission(mission,{phase:'start'});}
    catch(error){return failure(error.code??'A_ROUTINE_TEMPORAL_UNAVAILABLE','예약의 현재 실행 조건을 확인하지 못해 작업을 시작하지 않았습니다.',{mission:this.publicMission(mission)});}
    try{
      if(mission.executionMandateId&&!this.executionBudget)throw new Error('A_MANDATE_SERVICE_UNAVAILABLE');
      this.personalDependencyGuard?.assertCurrentMission(mission);
      this.executionBudget?.beforeRun(mission,quotaContext);
    }catch(error){return failure(error.code==='A_PERSONAL_LINK_DEPENDENCY_CHANGED'?error.code:'A_MANDATE_EXECUTION_DENIED',error.message,{mission:this.publicMission(mission)});}
    const controller = new AbortController();
    const effectController = new AbortController();
    const runPromise = this.runMissionLoop(mission, {
      maxWaves: maxWaves === null ? mission.budgets.maxWaves : clampInteger(maxWaves, 1, mission.budgets.maxWaves, mission.budgets.maxWaves),
      signal: controller.signal
    });
    const settledPromise = runPromise.finally(() => {
      this.activeRuns.delete(missionId);
      this.executionBudget?.afterRun(mission,{missionStore:this.store,missions:[...this.missions.values()]});
    });
    this.activeRuns.set(missionId, { promise: settledPromise, controller, effectController });
    return await settledPromise;
  }

  requestShutdown({ reason = 'core-service-runtime-shutdown' } = {}) {
    this.shutdownRequest ??= { reason: cleanText(reason, 300) ?? 'core-service-runtime-shutdown', requestedAt: this.clock().toISOString() };
    for (const active of this.activeRuns.values()) {
      active.controller.abort(this.shutdownRequest.reason);active.effectController?.abort(this.shutdownRequest.reason);
    }
    return { success: true, acceptingRuns: false, activeRunCount: this.activeRuns.size };
  }

  pauseForShutdown(mission, wave = null) {
    // A late asynchronous result must not revive a cancelled or completed Mission.
    if (terminalStatuses.has(mission.status)) return true;
    // Both shutdown and a goal edit drain existing worker handoffs before applying changes.
    if (this.goalRevisions.pause(mission, wave)) return true;
    if (!this.shutdownRequest) return false;
    if (terminalStatuses.has(mission.status)) return true;
    if (wave) {
      wave.status = 'paused';
      // Preserve in-flight outcomes; only work which has not reached B becomes pending again.
      for (const action of wave.actions) if (action.status === 'ready') action.status = 'planned';
    }
    // A missing provider outcome still needs reconciliation after restart; shutdown
    // must not replace that stronger recovery reason with an ordinary pause reason.
    if (mission.status === MissionStatus.PAUSED && mission.stopReason && mission.stopReason !== this.shutdownRequest.reason) return true;
    if (mission.status !== MissionStatus.PAUSED || mission.stopReason !== this.shutdownRequest.reason) {
      mission.status = MissionStatus.PAUSED;
      mission.stopReason = this.shutdownRequest.reason;
      this.touch(mission, 'mission-service-shutdown-paused');
      this.recordEvent('mission.service-shutdown.paused', mission, { reason: mission.stopReason });
    }
    return true;
  }

  async runMissionLoop(mission, { maxWaves, signal = null }) {
    const startedAtMs = Date.now();
    let wavesPlannedThisRun = 0;
    mission.status = MissionStatus.RUNNING;
    mission.stopReason = null;
    this.touch(mission, 'mission-run-started');
    this.recordEvent('mission.run.started', mission, { maxWaves });
    try {
      while (!terminalStatuses.has(mission.status)) {
        if (this.pauseForShutdown(mission)) break;
        if (this.pauseForExecutionAuthority(mission)) break;
        const activeWave = mission.waves.find((wave) => !['completed', 'completed_with_failures'].includes(wave.status));
        const pendingGates = this.pendingGates(mission);
        const canObserve = activeWave?.clarificationGateId && pendingGates.every(gate => gate.type === 'clarification' && gate.gateId === activeWave.clarificationGateId);
        if (pendingGates.length > 0 && !canObserve) {
          mission.status = MissionStatus.WAITING_APPROVAL;
          mission.stopReason = pendingGates.every(gate => gate.type === 'clarification') ? 'clarification-required' : 'approval-required';
          this.touch(mission, 'mission-waiting-approval');
          break;
        }
        // Report the user's page boundary from current signed evidence before
        // the coincident general wave/action budget masks its actual cause.
        if (!activeWave && mission.microsoftCollection?.version === 'microsoft-collection-pages-goal-v1'
          && mission.waves.flatMap(w=>w.actions).length >= this.microsoftCollectionLimit(mission)) {
          const pageProof=collectMicrosoftCollectionResult(mission,this.microsoftCollectionDependencies(mission));
          if (!pageProof.passed && pageProof.reasons[0] === 'microsoft-collection-page-limit') {
            mission.status=MissionStatus.PAUSED;mission.stopReason='microsoft-collection-page-limit';
            this.touch(mission,'mission-microsoft-page-limit-paused');break;
          }
        }
        const budgetCheck = this.checkBudget(mission, startedAtMs, { forPlanning: !activeWave });
        if (!budgetCheck.allowed) {
          mission.status = MissionStatus.PAUSED;
          mission.stopReason = budgetCheck.reason;
          this.touch(mission, 'mission-budget-paused');
          break;
        }
        if (activeWave) {
          await this.executeWave(mission, activeWave);
          if (terminalStatuses.has(mission.status) || [MissionStatus.WAITING_APPROVAL, MissionStatus.PAUSED].includes(mission.status)) break;
          if (this.hasRepeatedFailure(mission)) {
            this.blockMission(mission, 'repeated-failure-stall-detected');
            break;
          }
          if (this.pendingGates(mission).length) continue;
          if (this.tryCompleteFromDeterministicEvidence(mission)) break;
          if (mission.status === MissionStatus.PAUSED) break;
          continue;
        }
        if (wavesPlannedThisRun >= maxWaves) {
          mission.status = MissionStatus.PAUSED;
          mission.stopReason = 'run-wave-limit-reached';
          this.touch(mission, 'mission-run-wave-limit-paused');
          break;
        }
        const readApproval=explicitReadApproval(mission);
        if(readApproval){
          const gate=this.createClarificationGate(mission,{questions:[readApproval.question]});
          gate.explicitReadApproval=structuredClone(readApproval);
          gate.title='요청하신 읽기 조건 확인';
          mission.status=MissionStatus.WAITING_APPROVAL;mission.stopReason='explicit-read-approval-required';
          this.touch(mission,'mission-explicit-read-approval-created');break;
        }
        mission.status = MissionStatus.PLANNING;
        this.touch(mission, 'mission-planning-started');
        const plannerContext = this.plannerContext(mission, startedAtMs);
        const planned = planMicrosoftCollection(mission,this.microsoftCollectionDependencies(mission))
          ?? planLifecycleCaseRead(mission,this.lifecycleCaseDependencies(mission))
          ?? planSelectedSourcePages(mission,this.selectedSourceDependencies(mission))
          ?? (mission.successCriteria.length===1&&mission.successCriteria[0].statement===mission.objective
            ||mission.gates.some(g=>g.explicitReadApproval&&g.decision==='approve'
              &&g.supersededByRevision===mission.goalContract.revision&&g.explicitReadApproval.effectiveObjective===mission.objective)
            ?planReadOnlyTextStart({mission,allowedRoots:this.allowedRoots??[]}):null)
          ?? planResearchSourceWorkflow({mission,roots:this.allowedRoots??[]})
          ?? planOfxSaveMission(plannerContext,mission.ofxSave)
          ?? this.planner.planReviewedMcp?.(plannerContext)
          ?? planReadOnlyListingContinuation({mission,allowedRoots:this.allowedRoots ?? [],maxActions:this.maxActionsPerWave})
          ?? planReadOnlyTextContinuation({mission,allowedRoots:this.allowedRoots??[],beforeRead:action=>this.executionBudget?.beforeAction(mission,{packet:{action},workspaceRoot:this.allowedRoots[0]})})
          ?? planTypedTextInputReads({mission,allowedRoots:this.allowedRoots??[],beforeRead:action=>this.executionBudget?.beforeAction(mission,{packet:{action},workspaceRoot:this.allowedRoots[0]})})
          ?? planReadCriterionRoleClarification({mission,allowedRoots:this.allowedRoots??[],maxActions:this.maxActionsPerWave})
          ?? this.planner.planDeterministicWorkflow?.(plannerContext)
          ?? this.planner.planDeterministicBootstrap?.(plannerContext)
          ?? await this.planner.planNextWave(plannerContext, { signal });
        mission.metrics.plannerCalls += 1;
        mission.metrics.plannerAttempts = Number(mission.metrics.plannerAttempts ?? 0)
          + Math.max(0, Number(planned.planning?.attemptCount ?? planned.planning?.modelRoundTrips ?? 0));
        mission.metrics.plannerRetries = Number(mission.metrics.plannerRetries ?? 0)
          + Math.max(0, Number(planned.planning?.retryCount ?? 0));
        if (this.pauseForShutdown(mission) || terminalStatuses.has(mission.status) || signal?.aborted) break;
        try{
          const state=prepareSourceNotes({mission,plan:planned,roots:this.allowedRoots,now:this.clock().toISOString()});
          if(state){
            const previous={state:mission.sourceProcessing,revision:mission.revision,updatedAt:mission.updatedAt};
            mission.sourceProcessing=state;
            try{this.touch(mission,'mission-source-checkpoint-saved');}
            catch(error){mission.sourceProcessing=previous.state;mission.revision=previous.revision;mission.updatedAt=previous.updatedAt;
              throw Object.assign(new Error('A_SOURCE_CHECKPOINT_STORAGE_FAILED'),{code:'A_SOURCE_CHECKPOINT_STORAGE_FAILED',cause:error});}
          }
        }catch(error){
          mission.status=MissionStatus.PAUSED;mission.stopReason='source-checkpoint-invalid';
          this.addObservation(mission,{category:'source_checkpoint_guard',outcome:'failed',summary:'원문 처리 초안을 저장하지 못했습니다. 원문과 전달 범위를 다시 확인하세요.',error:{code:error.code??'A_SOURCE_CHECKPOINT_INVALID'},trustBoundary:'SYSTEM_RESULT',untrusted:false});
          this.touch(mission,'mission-source-checkpoint-paused');break;
        }
        mission.planHistory.push({
          planIndex: mission.planHistory.length + 1,
          decision: planned.decision,
          summary: cleanText(planned.summary, 500),
          fingerprint: planned.fingerprint ?? sha256(JSON.stringify(planned.actions ?? [])),
          actionCount: planned.actions?.length ?? 0,
          criteriaAssessment: planned.criteriaAssessment ?? [],
          planning: planned.planning ?? null,
          createdAt: this.clock().toISOString()
        });
        mission.planHistory = mission.planHistory.slice(-50);
        this.updatePlanStallState(mission, planned);
        this.recordEvent('mission.plan.created', mission, {
          decision: planned.decision,
          actionCount: planned.actions?.length ?? 0,
          fingerprint: planned.fingerprint ?? null,
          degraded: planned.planning?.degraded === true
        });
        const repeatedCompletionClaim = planned.decision === 'complete'
          && mission.planStall?.consecutiveCount >= 2;
        if (repeatedCompletionClaim || mission.planStall?.consecutiveCount >= 3) {
          this.blockMission(mission, repeatedCompletionClaim
            ? 'repeated-completion-claim-without-new-evidence'
            : 'repeated-plan-stall-detected');
          break;
        }
        if (planned.decision === 'complete') {
          const completion = await this.validateCompletionWithRemoteEvidence(mission, planned.criteriaAssessment ?? []);
          if (completion.valid) {
            this.completeMission(mission, completion);
            break;
          }
          this.addObservation(mission, {
            category: 'completion_guard',
            outcome: 'failed',
            summary: 'Planner completion was rejected because success criteria lacked verified evidence.',
            error: { code: 'A_MISSION_COMPLETION_EVIDENCE_INSUFFICIENT', reasons: completion.reasons },
            trustBoundary: 'SYSTEM_RESULT',
            untrusted: false
          });
          if (completion.goalCoverage?.allowed === false || completion.criteria.some(criterion => criterion.verificationStatus === 'unverified') || this.uncertainEffectCount(mission) > 0) {
            mission.status = MissionStatus.PAUSED;
            mission.stopReason = this.uncertainEffectCount(mission) > 0 ? 'reconciliation-required' : 'verification-incomplete';
            this.touch(mission, 'mission-verification-paused');
            break;
          }
          mission.metrics.replans += 1;
          mission.status = MissionStatus.RUNNING;
          this.touch(mission, 'mission-completion-rejected');
          continue;
        }
        if (planned.decision === 'ask_user') {
          let questions = clarificationQuestions(planned);
          const actions = planned.actions ?? [];
          if (!Array.isArray(actions) || actions.some(action => !independentClarificationRead(action))) {
            this.blockMission(mission, 'clarification-read-scope-invalid'); break;
          }
          const context=resolveClarificationContext(mission,planned);
          if(context.resolved.length){
            this.addObservation(mission,{category:'clarification_context',outcome:'success',
              summary:'이미 원문에 지정됐거나 사용자가 답한 정보입니다. 다시 묻지 않고 같은 목표의 계획에 반영하세요.',
              data:{goalRevision:mission.goalContract?.revision??1,resolvedQuestions:context.resolved,executionAuthorized:false},
              trustBoundary:'SYSTEM_RESULT',untrusted:false});
            if(!context.questions.length){
              if(actions.length){
                const observationWave=this.createWave(mission,planned);if(!observationWave)break;
                observationWave.clarificationContextResolved=true;
                mission.metrics.plannedActions+=observationWave.actions.length;wavesPlannedThisRun+=1;
              }
              mission.metrics.replans+=1;this.touch(mission,'mission-clarification-context-reused');continue;
            }
            questions=context.questions;
          }
          const wave = actions.length ? this.createWave(mission, planned) : null;
          if (actions.length && !wave) break;
          const gate = this.createClarificationGate(mission, { ...planned, questions: questions ?? undefined });
          if (wave) {
            wave.clarificationGateId = gate.gateId;
            mission.metrics.plannedActions += wave.actions.length;
            wavesPlannedThisRun += 1;
            this.touch(mission, 'mission-clarification-observation-wave-created');
            continue;
          }
          mission.status = MissionStatus.WAITING_APPROVAL;
          mission.stopReason = 'clarification-required';
          this.touch(mission, 'mission-clarification-required');
          break;
        }
        if (planned.decision === 'pause') {
          mission.status = MissionStatus.PAUSED;
          mission.stopReason = cleanText(planned.pauseReason, 500) ?? 'mission-planner-transient-failure';
          mission.recovery = {
            recoveryVersion: 'a-mission-transient-planning-recovery-v1',
            reason: mission.stopReason,
            retryable: planned.planning?.retryable === true,
            resumeSupported: planned.planning?.resumeSupported === true,
            plannerAttemptCount: Number(planned.planning?.attemptCount ?? 0),
            plannerRetryCount: Number(planned.planning?.retryCount ?? 0),
            pausedAt: this.clock().toISOString()
          };
          this.touch(mission, 'mission-planner-transient-paused');
          this.recordEvent('mission.planner.paused', mission, {
            reason: mission.stopReason,
            retryable: mission.recovery.retryable,
            plannerAttemptCount: mission.recovery.plannerAttemptCount
          });
          break;
        }
        if (planned.decision === 'blocked') {
          this.blockMission(mission, planned.blockedReason ?? 'planner-declared-blocked');
          break;
        }
        const wave = this.createWave(mission, planned);
        if (!wave) break;
        mission.metrics.plannedActions += wave.actions.length;
        if (mission.waves.length > 1) mission.metrics.replans += 1;
        wavesPlannedThisRun += 1;
        mission.status = MissionStatus.RUNNING;
        this.touch(mission, 'mission-wave-created');
      }
    } catch (error) {
      const accounting = sanitizePlannerExceptionAccounting(error?.plannerAccounting);
      if (accounting) {
        const attemptCount = accounting.attempts.length;
        const retryCount = Math.max(0, attemptCount - 1);
        mission.metrics.plannerCalls += 1;
        mission.metrics.plannerAttempts = Number(mission.metrics.plannerAttempts ?? 0) + attemptCount;
        mission.metrics.plannerRetries = Number(mission.metrics.plannerRetries ?? 0) + retryCount;
        mission.planHistory.push({
          planIndex: mission.planHistory.length + 1,
          decision: signal?.aborted ? 'aborted' : 'failed',
          summary: '목표 계획이 중단되어 관측한 호출 계측을 보존했습니다.',
          fingerprint: null,
          actionCount: 0,
          criteriaAssessment: [],
          planning: {
            plannerVersion: 'a-goal-executive-planner-v1',
            ...accounting,
            attemptCount, retryCount,
            rawObjectiveSharedWithModel: true,
            degraded: true
          },
          createdAt: this.clock().toISOString()
        });
        mission.planHistory = mission.planHistory.slice(-50);
        this.recordEvent('mission.planner.interrupted', mission, { attemptCount, retryCount });
      }
      if (!this.pauseForShutdown(mission) && !terminalStatuses.has(mission.status)) {
        mission.status = MissionStatus.FAILED;
        mission.stopReason = error?.code ?? 'mission-runtime-exception';
        mission.lastError = {
          code: error?.code ?? 'A_MISSION_RUNTIME_EXCEPTION',
          message: cleanText(error?.message, 500) ?? 'Mission runtime failed.'
        };
        this.recordEvent('mission.run.failed', mission, { errorCode: mission.lastError.code });
        this.touch(mission, 'mission-runtime-failed');
      }
    } finally {
      mission.metrics.activeRuntimeMs += Date.now() - startedAtMs;
      mission.metrics.currentConcurrency = 0;
      this.touch(mission, 'mission-run-finished');
      this.recordEvent('mission.run.finished', mission, {
        status: mission.status,
        stopReason: mission.stopReason,
        waveCount: mission.waves.length,
        executedActions: mission.metrics.executedActions
      });
    }
    return this.publicMission(mission);
  }

  createWave(mission, planned) {
    const remainingActions = Math.max(0, mission.budgets.maxActions - mission.metrics.executedActions);
    const selectedActions = planned.actions;
    let rejection = !Array.isArray(selectedActions) || selectedActions.length === 0
      ? 'mission-wave-invalid-action-graph'
      : selectedActions.length > remainingActions ? 'mission-wave-action-budget-insufficient'
        : selectedActions.length > this.maxActionsPerWave ? 'mission-wave-size-exceeded' : null;
    const workerFailures = mission.managedAgentWorkerFailures ?? [];
    if (!rejection && workerFailures.some(item => item.handoffPermitted !== true)) {
      rejection = 'managed-agent-worker-result-uncertain';
    }
    if (!rejection) {
      try { for (const action of selectedActions) normalizeActionRequirementLinks(action, mission.goalContract); }
      catch { rejection = 'mission-wave-invalid-requirement-links'; }
    }
    if (!rejection) {
      for (const action of selectedActions) {
        const normalized = normalizeMissionRoleAssignment(action);
        if (!normalized.valid) { rejection = normalized.reason; break; }
        if (!normalized.assignment) continue;
        if (workerFailures.some(item => item.workerRole === normalized.assignment.workerRole
          && item.collaborationGroupId === normalized.assignment.collaborationGroupId)) {
          rejection = 'managed-agent-role-worker-unavailable';
          break;
        }
        const capability = this.capabilityCatalog().find(item => item.toolName === action.expectedToolName);
        const scope = validateMissionRoleTool({ roleId: normalized.assignment.workerRole,
          toolName: action.expectedToolName, contract: capability ?? {} });
        if (!scope.allowed) { rejection = `mission-role-scope-${scope.reason}`; break; }
      }
    }
    if (!rejection) {
      const ids = new Set(selectedActions.map((action) => action?.id));
      if (ids.size !== selectedActions.length || selectedActions.some((action) => (
        !action || typeof action.id !== 'string' || !action.id.trim()
        || !Array.isArray(action.dependencies)
        || action.dependencies.some((dependency) => dependency === action.id || !ids.has(dependency))
      ))) rejection = 'mission-wave-invalid-action-graph';
      if (!rejection) {
        const resolved = new Set();
        for (let pass = 0; pass < selectedActions.length; pass += 1) {
          for (const action of selectedActions) {
            if (action.dependencies.every((dependency) => resolved.has(dependency))) resolved.add(action.id);
          }
        }
        if (resolved.size !== selectedActions.length) rejection = 'mission-wave-invalid-action-graph';
      }
    }
    if (rejection) {
      mission.status = MissionStatus.PAUSED;
      mission.stopReason = rejection;
      mission.recovery = {
        recoveryVersion: 'a-mission-wave-integrity-recovery-v1',
        reason: rejection, retryable: true, resumeSupported: true,
        plannedActionCount: Array.isArray(selectedActions) ? selectedActions.length : 0,
        remainingActions, maxActionsPerWave: this.maxActionsPerWave,
        pausedAt: this.clock().toISOString()
      };
      this.addObservation(mission, {
        category: 'planning', outcome: 'failed',
        summary: '전체 행동과 선행 관계를 실행 한도 안에서 보존할 수 없어 부분 실행 전에 재계획 가능한 상태로 전환했습니다.',
        error: { code: 'A_MISSION_WAVE_INTEGRITY_REJECTED', reason: rejection,
          remainingActions, maxActionsPerWave: this.maxActionsPerWave },
        trustBoundary: 'SYSTEM_RESULT', untrusted: false
      });
      this.touch(mission, 'mission-wave-integrity-paused');
      return null;
    }
    const waveIndex = mission.waves.length + 1;
    const waveId = stableId('mission_wave', `${mission.missionId}:${waveIndex}`, this.clock().toISOString());
    const idMap = new Map(selectedActions.map((action, index) => [action.id, `${waveId}:action:${index + 1}`]));
    const wave = {
      waveVersion: 'a-mission-wave-v1',
      goalRevision: mission.goalContract?.revision ?? 1,
      waveId,
      waveIndex,
      status: 'planned',
      summary: cleanText(planned.summary, 500),
      plannerFingerprint: planned.fingerprint ?? null,
      ...(planned.planning?.missionSkillGuidance ? { planning: { missionSkillGuidance: structuredClone(planned.planning.missionSkillGuidance) } } : {}),
      actions: selectedActions.map((action, index) => ({
        goalRevision: mission.goalContract?.revision ?? 1,
        actionId: idMap.get(action.id),
        localActionId: action.id,
        order: index + 1,
        title: cleanText(action.title, 160) ?? `행동 ${index + 1}`,
        command: cleanText(action.command, 1200),
        commandHash: sha256(action.command),
        expectedToolName: action.expectedToolName ?? null,
        ...(normalizeMissionRoleAssignment(action).assignment ?? {}),
        ...normalizeActionRequirementLinks(action, mission.goalContract),
        plannedCapabilityBinding: capturePlannedCapabilityBinding(action.capabilityBinding),
        arguments: action.arguments ?? null,
        dependencies: action.dependencies.map((dependency) => idMap.get(dependency)),
        successSignal: cleanText(action.successSignal, 300),
        degradedRouteGuard: action.degradedRouteGuard === true,
        status: 'planned',
        attempts: 0,
        taskId: null,
        gateId: null,
        actualToolName: null,
        capabilityProfile: null,
        observationId: null,
        createdAt: this.clock().toISOString(),
        updatedAt: this.clock().toISOString()
      })),
      createdAt: this.clock().toISOString(),
      completedAt: null
    };
    for (const action of wave.actions) {
      ensureMissionActionOperation(mission.missionId, action, this.allowedRoots);
      action.reservedTaskId=reservedMissionTaskId(mission.missionId,action.actionId);
    }
    mission.waves.push(wave);
    return wave;
  }

  async executeWave(mission, wave) {
    if (this.pauseForShutdown(mission, wave)) return;
    // Assess every pending action before starting this wave so a missing connector does not
    // cause an avoidable partial wave. Dispatch checks still run after E authorization.
    for (const action of wave.actions.filter(item => item.status === 'planned' && item.attempts === 0)) {
      if (!await this.checkActionAvailability(mission, wave, action, null, 'planning')) return;
      if (this.pauseForShutdown(mission, wave)) return;
    }
    wave.status = 'running';
    this.touch(mission, 'mission-wave-running');
    while (true) {
      if (this.pauseForShutdown(mission, wave)) return;
      const unresolved = wave.actions.filter((action) => !terminalActionStatuses.has(action.status));
      if (unresolved.length === 0) break;
      let stateChanged = false;
      for (const action of unresolved) {
        const dependencyStates = action.dependencies.map((dependencyId) => wave.actions.find((item) => item.actionId === dependencyId)?.status);
        if (dependencyStates.some((status) => ['failed', 'skipped'].includes(status))) {
          action.status = 'skipped';
          mission.metrics.failedActions += 1;
          action.updatedAt = this.clock().toISOString();
          this.addObservation(mission, {
            actionId: action.actionId,
            category: 'dependency',
            outcome: 'failed',
            summary: 'A prerequisite action failed, so this action was not executed.',
            error: { code: 'A_MISSION_DEPENDENCY_FAILED' },
            trustBoundary: 'SYSTEM_RESULT',
            untrusted: false
          });
          stateChanged = true;
        }
      }
      const ready = wave.actions.filter((action) => action.status === 'planned'
        && action.dependencies.every((dependencyId) => wave.actions.find((item) => item.actionId === dependencyId)?.status === 'succeeded'));
      const prepared = [];
      for (const action of ready) {
        const item = await this.prepareAction(mission, wave, action);
        if (this.pauseForShutdown(mission, wave)) return;
        if (item) prepared.push(item);
        else stateChanged = true;
        if (mission.status === MissionStatus.PAUSED) {
          for (const item of prepared) item.action.status = 'planned';
          this.touch(mission, 'mission-wave-recovery-paused');
          return;
        }
      }
      const parallel = prepared.filter((item) => item.profile.executionClass === MissionGrant.READ_ONLY);
      const serial = prepared.filter((item) => item.profile.executionClass !== MissionGrant.READ_ONLY);
      if (parallel.length > 0) {
        if (parallel.length > 1) mission.metrics.parallelBatches += 1;
        await Promise.all(parallel.map((item) => this.executePreparedAction(mission, wave, item)));
        if (this.pauseForShutdown(mission, wave)) return;
        stateChanged = true;
        if (mission.status === MissionStatus.PAUSED) {
          for (const item of prepared) if (item.action.status === 'ready') item.action.status = 'planned';
          this.touch(mission, 'mission-wave-recovery-paused');
          return;
        }
      }
      for (const item of serial) {
        await this.executePreparedAction(mission, wave, item);
        if (this.pauseForShutdown(mission, wave)) return;
        stateChanged = true;
        if (mission.status === MissionStatus.PAUSED) {
          for (const pending of prepared) if (pending.action.status === 'ready') pending.action.status = 'planned';
          this.touch(mission, 'mission-wave-recovery-paused');
          return;
        }
      }
      const coverageBlocked = wave.actions.find(item => item.status === 'planned' && item.requirementCoverage?.allowed === false);
      if (coverageBlocked) {
        this.pauseForRequirementCoverage(mission, wave, coverageBlocked);
        return;
      }
      if (this.pendingGates(mission).some(gate => gate.gateId !== wave.clarificationGateId || gate.type !== 'clarification')) {
        wave.status = 'waiting_approval';
        mission.status = MissionStatus.WAITING_APPROVAL;
        mission.stopReason = 'approval-required';
        this.touch(mission, 'mission-wave-waiting-approval');
        return;
      }
      if (!stateChanged) {
        const cyclic = wave.actions.filter((action) => !terminalActionStatuses.has(action.status));
        for (const action of cyclic) {
          action.status = 'failed';
          mission.metrics.failedActions += 1;
          action.updatedAt = this.clock().toISOString();
          this.recordActionFailure(mission, action, {
            code: 'A_MISSION_DEPENDENCY_CYCLE',
            message: 'Action dependencies could not make progress.'
          });
        }
        break;
      }
    }
    const failed = wave.actions.filter((action) => action.status !== 'succeeded');
    wave.status = failed.length === 0 ? 'completed' : 'completed_with_failures';
    wave.completedAt = this.clock().toISOString();
    mission.status = MissionStatus.RUNNING;
    this.touch(mission, 'mission-wave-completed');
    this.recordEvent('mission.wave.completed', mission, {
      waveId: wave.waveId,
      status: wave.status,
      succeeded: wave.actions.length - failed.length,
      failed: failed.length
    });
  }

  pauseForExecutionAuthority(mission, wave = null) {
    try { this.executionAuthority?.assertActive({allowRecovery:true}); return false; }
    catch (error) {
      mission.status = MissionStatus.PAUSED;mission.stopReason = 'core-execution-authority-unavailable';
      mission.lastError = {code:'A_CORE_AUTHORITY_EXECUTION_DENIED',message:error.message};
      if(wave)wave.status='paused';
      this.touch(mission,'mission-core-authority-paused');return true;
    }
  }

  async prepareAction(mission, wave, action) {
    if(action.reservedTaskId!==undefined&&action.reservedTaskId!==null
      &&(action.reservedTaskId!==reservedMissionTaskId(mission.missionId,action.actionId)
        ||action.taskId!==null&&action.taskId!==undefined&&action.taskId!==action.reservedTaskId)){
      throw Object.assign(new Error('A_MISSION_TASK_RESERVATION_INVALID'),{code:'A_MISSION_TASK_RESERVATION_INVALID'});
    }
    if (this.pauseForShutdown(mission, wave)) return null;
    if (this.pauseForExecutionAuthority(mission, wave)) return null;
    const durableRecovery = this.effectCoordinator.recoveryState(action);
    if (durableRecovery?.blocked) {
      mission.status = MissionStatus.PAUSED; mission.stopReason = 'action-recovery-required'; wave.status = 'paused';
      action.recovery = { ...action.recovery, required: true, status: 'blocked', error: { code: durableRecovery.code } };
      this.touch(mission, 'mission-effect-recovery-blocked'); return null;
    }
    if (!durableRecovery?.notDispatched && (action.recovery?.required || action.attempts > 0 || action.operation)) {
      const recoveryInput = {
        missionId: mission.missionId,
        action,
        allowedRoots: this.allowedRoots,
        coreFacade: this.coreFacade,
        worker: this.orchestrationWorker,
        pcAgent: this.pcAgent,
        durableEffect: this.effectCoordinator.effect(action),
        workflowCognitionIntents: this.effectCoordinator.workflowCognitionIntents,
        remoteArtifactRecovery: this.effectCoordinator.remoteArtifactRecoveryContext(action),
        beforeResultRead: this.resultReadGuard({ ...mission }) ?? null
      };
      let recovered = await recoverMissionAction(recoveryInput);
      if (recovered.status === 'blocked' && await this.resumeWorkflowPublication(mission, wave, action, recovered)) {
        recoveryInput.durableEffect = this.effectCoordinator.effect(action);
        recovered = await recoverMissionAction(recoveryInput);
      }
      action.recovery = {
        ...action.recovery,
        required: recovered.status === 'blocked',
        status: recovered.status,
        checkedAt: this.clock().toISOString(),
        source: recovered.source ?? null,
        error: recovered.error ?? null
      };
      if (recovered.status === 'blocked') {
        mission.status = MissionStatus.PAUSED;
        mission.stopReason = 'action-recovery-required';
        wave.status = 'paused';
        action.status = 'planned';
        mission.lastError=structuredClone(action.recovery.error??{code:'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN'});
        this.touch(mission, 'mission-action-recovery-blocked');
        this.recordEvent('mission.action.recovery-blocked', mission, { actionId: action.actionId, error: recovered.error });
        return null;
      }
      if (recovered.status === 'recovered') {
        const cognitiveRecovery=this.effectCoordinator.recoverCognition(recovered);
        action.recovery.cognition=cognitiveRecovery;
        if(cognitiveRecovery.status==='unavailable'){
          action.status='planned';action.recovery.required=true;mission.status=MissionStatus.PAUSED;wave.status='paused';mission.stopReason='post-effect-cognition-pending';
          this.touch(mission,'mission-effect-cognition-pending');return null;
        }
        const learning = this.effectCoordinator.recoverLearning(action, recovered.execution, recovered, mission.missionId);
        action.recovery.learning = learning;
        action.recovery.memory = learning?.status === 'unavailable' ? { status: 'unavailable', reason: 'growth-memory-pending' }
          : this.rememberRecoveredAction(mission, action, recovered.execution.executionResult);
        if (learning?.status === 'persisted') {
          try { this.effectCoordinator.assertMemoriesPersisted(action, recovered.execution); }
          catch (error) { action.recovery.memory = { status: 'unavailable', reason: error.code ?? 'memory-persistence-unconfirmed' }; }
        }
        if (learning && (learning.status !== 'persisted' || !['recorded', 'already-recorded'].includes(action.recovery.memory?.status))) {
          action.status = 'planned'; action.recovery.required = true;
          mission.status = MissionStatus.PAUSED; wave.status = 'paused'; mission.stopReason = 'post-effect-memory-pending';
          this.touch(mission, 'mission-effect-memory-pending');
          return null;
        }
        action.status = 'succeeded';
        action.recovery.packetId = recovered.packetId;
        action.updatedAt = this.clock().toISOString();
        const observation = this.successObservation(action, { taskId: action.taskId }, {
          execution: recovered.execution,
          executionVerification: recovered.verification,
          evidence: recovered.execution.evidence
        });
        observation.recovery = { operationId: action.operation.operationId, source: recovered.source, reverified: true };
        action.observationId = this.addObservation(mission, observation).observationId;
        if (action.successCounted !== true) mission.metrics.successfulActions += 1;
        action.successCounted = true;
        if (action.executionCounted !== true) mission.metrics.executedActions += 1;
        action.executionCounted = true;
        mission.metrics.recoveredActions = Number(mission.metrics.recoveredActions ?? 0) + 1;
        this.effectCoordinator.recovered(action, recovered);
        this.touch(mission, 'mission-action-recovered');
        this.effectCoordinator.verified(action, recovered.execution);
        this.recordEvent('mission.action.recovered', mission, {
          actionId: action.actionId, taskId: action.taskId, operationId: action.operation.operationId,
          source: recovered.source, verificationId: recovered.verification.verificationId
        });
        return null;
      }
    }
    ensureMissionActionOperation(mission.missionId, action, this.allowedRoots);
    let task = action.taskId ? this.coreFacade.getTask(action.taskId) : null;
    if (!task) {
      task = this.coreFacade.createMissionActionTask(this.effectCoordinator.taskRequestFor(action) ?? action.command, {
        reservedTaskId: action.reservedTaskId ?? null,
        expectedToolName: action.expectedToolName,
        preparedArguments: action.operation?.dispatch?.arguments ?? action.arguments,
        workerRole: action.workerRole ?? null,
        collaborationGroupId: action.collaborationGroupId ?? null,
        source: InputSource.TRIGGER,
        sourceModule: ModuleId.CORE,
        deviceId: 'mission_executive',
        inputMode: 'text',
        userId: mission.metadata?.userId || 'local_user',
        ...(wave.waveIndex === 1 && action.order === 1 && mission.metadata?.workReference ? {
          workReferenceContext: {
            binding: mission.metadata.workReference,
            originalText: mission.metadata.workReferenceOriginalText
          }
        } : {}),
        metadata: {
          missionId: mission.missionId,
          missionWaveId: wave.waveId,
          missionActionId: action.actionId,
          expectedToolName: action.expectedToolName,
          commandHash: action.commandHash,
          operationId: action.operation.operationId,
          longTermMemory: mission.metadata?.longTermMemory !== false,
          conversationId: mission.metadata?.workReferenceScope?.conversationId ?? mission.metadata?.conversationId
        }
      });
      if(action.reservedTaskId&&task.taskId!==action.reservedTaskId){
        throw Object.assign(new Error('A_MISSION_TASK_RESERVATION_CONFLICT'),{code:'A_MISSION_TASK_RESERVATION_CONFLICT'});
      }
      action.taskId = task.taskId;
      action.actualToolName = task.plan?.action?.toolName ?? null;
      action.updatedAt = this.clock().toISOString();
    }
    if (task.status === TaskStatus.BLOCKED) {
      action.status = 'failed';
      mission.metrics.failedActions += 1;
      this.recordActionFailure(mission, action, {
        code: 'A_MISSION_TASK_POLICY_BLOCKED',
        message: task.policy?.blockedReason ?? 'Task policy blocked the action.'
      });
      return null;
    }
    const profile = this.capabilityProfile(task);
    action.capabilityProfile = profile;
    if (!this.clarificationReadAllowed(mission,wave,action,task,{capture:true})) {
      this.coreFacade.cancelTask?.(action.taskId, { reason: 'clarification-read-scope-invalid', source: mission.missionId });
      action.status = 'failed'; mission.metrics.failedActions += 1;
      this.recordActionFailure(mission, action, { code: 'A_MISSION_CLARIFICATION_READ_SCOPE_INVALID', message: 'Only independently scoped local reads may run while awaiting clarification.' });
      return null;
    }
    if (action.workerRole) {
      const registeredCapability = this.capabilityCatalog().find(item => item.toolName === action.actualToolName) ?? {};
      const roleScope = validateMissionRoleTool({ roleId: action.workerRole,
        toolName: action.actualToolName, contract: { ...profile, ...registeredCapability } });
      action.roleScope = { ...roleScope, checkedAt: this.clock().toISOString() };
      if (!roleScope.allowed) {
        action.status = 'failed';
        mission.metrics.failedActions += 1;
        this.recordActionFailure(mission, action, { code: 'A_MISSION_ROLE_SCOPE_DENIED',
          message: `Role ${action.workerRole} cannot use ${action.actualToolName ?? 'an unrouted tool'} (${roleScope.reason}).` });
        return null;
      }
    }
    if (action.expectedToolName && action.actualToolName !== action.expectedToolName) {
      const adaptation = this.routeAdaptation(action.expectedToolName, action.actualToolName, profile);
      if (!adaptation.allowed) {
        this.coreFacade.cancelTask?.(task.taskId, {
          reason: 'mission-route-mismatch',
          source: mission.missionId
        });
        action.status = 'failed';
        mission.metrics.failedActions += 1;
        mission.metrics.routeMismatches += 1;
        this.recordActionFailure(mission, action, {
          code: 'A_MISSION_ROUTE_MISMATCH',
          message: `Planned tool ${action.expectedToolName} did not match routed tool ${action.actualToolName ?? 'none'}.`
        });
        return null;
      }
      action.routeAdaptation = adaptation;
      mission.metrics.routeAdaptations = (mission.metrics.routeAdaptations ?? 0) + 1;
      this.recordEvent('mission.action.route-adapted', mission, {
        actionId: action.actionId,
        expectedToolName: action.expectedToolName,
        actualToolName: action.actualToolName,
        reason: adaptation.reason
      });
    }
    if (!await this.checkActionAvailability(mission, wave, action, task, 'preparation')) return null;
    action.requirementCoverage = assessMissionRequirementCoverage({ mission, wave, action, profile, phase: 'planning',
      dispatchToolName: task.plan?.action?.toolName, dispatchArguments: task.plan?.action?.arguments, allowedRoots: this.allowedRoots,
      microsoftRequestBindingResolver:request=>this.microsoftCollectionRequestBound(mission,action,request),temporalBindingResolver:(current,options)=>(this.routineTemporalGuard?.bindSourceTime(current,options)??false)||this.completionDeadline.bindSourceTime(current,options), installedIntentBinding:this.pcAgent.registry?.contractFor?.(task.plan?.action?.toolName)?.intentBinding??null });
    if (!action.requirementCoverage.allowed) {
      // Task routing can create an approval card before Mission's source-contract
      // guard runs. If the action is still undispatched and the user's request
      // explicitly rules it out, withdraw that stale approval instead of asking
      // the user to approve an action the request forbids.
      if (task.status === TaskStatus.WAITING_APPROVAL && action.attempts === 0
        && this.effectCoordinator.effect(action)?.state !== 'dispatched') {
        const cancelled = this.coreFacade.cancelTask?.(task.taskId, {
          reason: 'mission-requirement-coverage-rejected', source: mission.missionId
        });
        if (cancelled?.success === true) {
          this.recordEvent('mission.action.prohibited-approval-withdrawn', mission, {
            actionId: action.actionId, taskId: task.taskId,
            approvalId: task.approvalCard?.approvalId ?? null,
            reasonCodes: action.requirementCoverage.reasons.map(item => item.code)
          });
        }
      }
      action.status = 'planned';
      this.touch(mission, 'mission-requirement-coverage-pending');
      return null;
    }
    if (!this.actionAuthorized(mission, action, profile)) {
      this.recordEvent('mission.action.authorization-blocked', mission, {
        actionId: action.actionId,
        taskId: action.taskId,
        executionClass: profile.executionClass,
        authorizationRevision: mission.authorizationRevision ?? 1,
        grants: mission.authorization.grants
      });
      this.createActionGate(mission, wave, action, task, profile);
      action.status = 'waiting_approval';
      action.updatedAt = this.clock().toISOString();
      return null;
    }
    const microsoftScope = this.microsoftCollectionApprovalScope(mission, action, profile, task);
    if (microsoftScope && task.status === TaskStatus.WAITING_APPROVAL) {
      const applied = this.coreFacade.submitApprovalDecision(createApprovalDecision({
        approvalId: task.approvalCard.approvalId, taskId: task.taskId,
        decision: ApprovalDecision.APPROVE, deviceId: 'bounded-microsoft-mission',
        sourceModule: ModuleId.CORE, decidedAt: this.clock().toISOString()
      }));
      if (applied.success !== true || applied.status !== TaskStatus.APPROVED) {
        action.status = 'planned'; mission.status = MissionStatus.PAUSED;
        mission.stopReason = 'microsoft-scoped-approval-application-failed';
        this.touch(mission, 'mission-microsoft-scoped-approval-failed'); return null;
      }
      this.recordEvent('mission.action.microsoft-scope-approved', mission, {
        actionId: action.actionId, taskId: task.taskId, scopeGateId: microsoftScope.gateId,
        approvalId: task.approvalCard.approvalId, maxPages: microsoftScope.microsoftPaginationScope.maxPages
      });
    }
    if (mission.authorization.mode === 'trusted_session' && task.status === TaskStatus.WAITING_APPROVAL
      && task.policy?.constraints?.allowExternalTransfer !== true
      && task.policy?.constraints?.allowAdminPrivilege !== true
      && !['DELETE', 'SEND_EMAIL', 'PURCHASE', 'PAYMENT', 'TRANSFER_FUNDS'].includes(task.plan?.action?.actionType)) {
      const ownerAuthorization = this.ownerSessionManager?.authorizeTask?.({
        sessionId: mission.authorization.ownerSessionId,
        task
      });
      if (ownerAuthorization?.allowed === true && Date.parse(ownerAuthorization.expiresAt ?? '') > Date.parse(this.clock().toISOString())) {
        const decision = createApprovalDecision({
          approvalId: task.approvalCard.approvalId,
          taskId: task.taskId,
          decision: ApprovalDecision.APPROVE,
          deviceId: 'personal-owner-session',
          sourceModule: ModuleId.CORE,
          decidedAt: this.clock().toISOString()
        });
        const applied = this.coreFacade.submitApprovalDecision(decision);
        action.ownerAuthorization = {
          authorizationVersion: ownerAuthorization.authorizationVersion,
          allowed: applied.success === true && applied.status === TaskStatus.APPROVED,
          code: ownerAuthorization.code,
          sessionId: ownerAuthorization.sessionId,
          expiresAt: ownerAuthorization.expiresAt,
          taskId: task.taskId,
          requiredGrant: ownerAuthorization.requiredGrant,
          evaluatedAt: ownerAuthorization.evaluatedAt
        };
        this.recordEvent('mission.action.owner-session-approved', mission, {
          actionId: action.actionId,
          taskId: task.taskId,
          approvalId: task.approvalCard.approvalId,
          requiredGrant: ownerAuthorization.requiredGrant,
          sessionId: ownerAuthorization.sessionId
        });
        if (applied.success !== true || applied.status !== TaskStatus.APPROVED) {
          action.status = 'planned';
          mission.status = MissionStatus.PAUSED;
          mission.stopReason = 'owner-session-approval-application-failed';
          this.touch(mission, 'mission-owner-session-approval-failed');
          return null;
        }
      }
    }
    action.status = 'ready';
    action.updatedAt = this.clock().toISOString();
    return { action, task, profile };
  }

  async checkLearnedGuidance(mission, wave) {
    const binding = wave.planning?.missionSkillGuidance;
    if (!binding) return true;
    let valid = false;
    try {
      const references = binding.references;
      const supplied = mission.metadata?.longTermMemory === false ? []
        : await this.planner.skillGuidanceProvider?.({ objective: mission.objective, mission,
          scope: { userId: mission.metadata?.userId ?? 'local_user', workspaceRoot: this.coreFacade.workspaceRoot,
            conversationId: mission.metadata?.conversationId ?? null } });
      valid = binding.mode === 'reference-only' && binding.executableByDefault === false
        && Array.isArray(references) && references.length === 1 && Array.isArray(supplied)
        && references.every(ref => typeof ref.skillId === 'string' && typeof ref.revisionId === 'string'
          && supplied.some(current => current.skillId === ref.skillId && current.revisionId === ref.revisionId
            && (ref.lifecycleSha256 === undefined ? !current.procedureLifecycle
              : current.procedureLifecycle?.contractSha256 === ref.lifecycleSha256)));
    } catch { valid = false; }
    if (valid) return true;
    wave.status = 'paused'; mission.status = MissionStatus.PAUSED;
    mission.stopReason = 'learned-guidance-changed';
    mission.lastError = { code: 'A_MISSION_SKILL_GUIDANCE_STALE',
      message: '참고한 업무 절차가 만료되거나 변경되었습니다. 최신 절차로 다시 계획해야 합니다.' };
    this.touch(mission, 'mission-learned-guidance-stale');
    return false;
  }

  async executePreparedAction(mission, wave, { action, task, profile }) {
    if (!await this.checkLearnedGuidance(mission, wave)) return;
    if (this.pauseForShutdown(mission, wave)) return;
    if (!this.clarificationReadAllowed(mission,wave,action,task)) {
      action.status = 'failed'; mission.metrics.failedActions += 1;
      this.coreFacade.cancelTask?.(action.taskId, { reason: 'clarification-read-scope-invalid', source: mission.missionId });
      this.recordActionFailure(mission, action, { code: 'A_MISSION_CLARIFICATION_READ_SCOPE_INVALID', message: '읽기 권한이나 대상이 바뀌었습니다. 요청한 자료 범위를 다시 확인해야 합니다.' });
      return;
    }
    if (!await this.checkActionAvailability(mission, wave, action, task, 'dispatch')) return;
    if (this.pauseForShutdown(mission, wave)) return;
    const revisionIssue = this.goalRevisions.actionIssue(mission, action, task);
    if (revisionIssue) {
      action.status = 'planned'; wave.status = 'paused'; mission.status = MissionStatus.PAUSED;
      mission.stopReason = 'goal-revision-action-blocked'; mission.lastError = revisionIssue.error;
      this.touch(mission, 'mission-goal-revision-action-blocked'); return;
    }
    const currentAuthorizationRevision = mission.authorizationRevision ?? 1;
    if ((mission.authorization.mode === 'trusted_session'
        || action.authorizationRevision !== currentAuthorizationRevision)
      && !this.actionAuthorized(mission, action, profile)) {
      this.coreFacade.cancelTask?.(action.taskId, {
        reason: 'mission-authorization-revoked-before-dispatch',
        source: mission.missionId
      });
      this.recordEvent('mission.action.authorization-blocked', mission, {
        actionId: action.actionId,
        taskId: action.taskId,
        executionClass: profile.executionClass,
        authorizationRevision: mission.authorizationRevision ?? 1,
        grants: mission.authorization.grants,
        phase: 'dispatch'
      });
      this.createActionGate(mission, wave, action, task, profile);
      action.status = 'waiting_approval';
      action.updatedAt = this.clock().toISOString();
      this.touch(mission, 'mission-action-authorization-revoked-before-dispatch');
      return;
    }
    const sourceOutcomeRequested = action.actualToolName === 'workflow.execute'
      && mission.successCriteria.some(criterion => criterion.statement === `${mission.objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`
        || criterion.statement === '요청한 형식과 저장 위치에 실제 산출물이 생성되고 다시 열 수 있음이 확인된다.');
    if (sourceOutcomeRequested) {
      const preparation = prepareSourceOutcome({ objective: mission.objective, allowedRoots: this.allowedRoots });
      if (preparation.status === 'blocked') {
        action.status = 'planned';
        action.lastError = { code: 'A_SOURCE_OUTCOME_PREPARATION_BLOCKED', message: preparation.reasons?.[0] ?? '입력 사전 검증 실패' };
        wave.status = 'paused'; mission.status = MissionStatus.PAUSED;
        mission.stopReason = 'source-outcome-preparation-blocked';
        mission.lastError = action.lastError;
        this.touch(mission, 'mission-source-outcome-preparation-blocked');
        return;
      }
      if (preparation.status === 'prepared') {
        this.sourceOutcomePreparations.set(mission.missionId, preparation);
        if (this.sourceOutcomePreparations.size > 128) this.sourceOutcomePreparations.delete(this.sourceOutcomePreparations.keys().next().value);
      }
    }
    action.requirementCoverage = assessMissionRequirementCoverage({ mission, wave, action, profile, phase: 'dispatch',
      dispatchToolName: task.plan?.action?.toolName, dispatchArguments: task.plan?.action?.arguments, allowedRoots: this.allowedRoots,
      microsoftRequestBindingResolver:request=>this.microsoftCollectionRequestBound(mission,action,request),temporalBindingResolver:(current,options)=>(this.routineTemporalGuard?.bindSourceTime(current,options)??false)||this.completionDeadline.bindSourceTime(current,options), installedIntentBinding:this.pcAgent.registry?.contractFor?.(task.plan?.action?.toolName)?.intentBinding??null });
    if (!action.requirementCoverage.allowed) {
      this.pauseForRequirementCoverage(mission, wave, action);
      return;
    }
    try{
      if(mission.executionMandateId&&!this.executionBudget)throw new Error('A_MANDATE_SERVICE_UNAVAILABLE');
      this.personalDependencyGuard?.assertCurrentMission(mission);
      this.executionBudget?.beforeAction(mission);
    }catch(error){
      mission.status=MissionStatus.PAUSED;mission.stopReason=error.code==='A_PERSONAL_LINK_DEPENDENCY_CHANGED'?'personal-dependency-changed':'mandate-execution-denied';action.status='planned';
      mission.lastError={code:error.code==='A_PERSONAL_LINK_DEPENDENCY_CHANGED'?error.code:'A_MANDATE_EXECUTION_DENIED',message:error.message};this.touch(mission,'mission-mandate-paused');return;
    }
    const initialMemoryReadiness = this.effectCoordinator.memoryReadiness(task);
    if (!initialMemoryReadiness.available) {
      action.status = 'planned'; wave.status = 'paused'; mission.status = MissionStatus.PAUSED;
      mission.stopReason = 'durable-memory-unavailable';
      mission.lastError = { code: initialMemoryReadiness.code, reason: initialMemoryReadiness.reason,
        nextAction: initialMemoryReadiness.nextAction, actionId: action.actionId };
      this.touch(mission, 'mission-memory-unavailable-before-staging');
      return;
    }
    action.revisionNoHandoff = false;
    checkpointMissionActionDispatch(action, task, this.orchestrationWorker, profile, this.clock().toISOString());
    action.status = 'running';
    action.attempts += 1;
    action.updatedAt = this.clock().toISOString();
    mission.metrics.currentConcurrency += 1;
    mission.metrics.maxObservedParallelism = Math.max(
      mission.metrics.maxObservedParallelism,
      mission.metrics.currentConcurrency
    );
    try {
      const stagedEffectHooks = await this.effectCoordinator.stage(mission, action, task);
      let localEffectHooks = withMissionMandateFence({ mission, gate: this.executionBudget,
        executor: this.orchestrationWorker.executorForPacket?.({action:task.plan.action}) ?? this.orchestrationWorker.pcAgent, hooks: stagedEffectHooks,workspaceRoot:this.allowedRoots[0] });
      if(mission.metadata?.managedAgentReadScope)localEffectHooks={...(localEffectHooks??{}),beforeExecute:withManagedParentReadFence({runtime:this,mission,
        executor:this.orchestrationWorker.executorForPacket?.({action:task.plan.action})??this.orchestrationWorker.pcAgent,beforeExecute:localEffectHooks?.beforeExecute})};
      if (this.pauseForExecutionAuthority(mission, wave)) {
        this.effectCoordinator.cancelPrepared(action,{reason:'core-authority-lost-before-worker-handoff'});
        action.status='planned';return;
      }
      if (this.pauseForShutdown(mission, wave) || terminalStatuses.has(mission.status)) {
        const hadEffect = Boolean(this.effectCoordinator.effect(action));
        const cancelled = this.effectCoordinator.cancelPrepared(action, { reason: 'mission-stopped-before-worker-handoff' });
        if (!hadEffect || cancelled.notDispatched === true) {
          action.revisionNoHandoff = true;
          action.status = mission.status === MissionStatus.CANCELLED ? 'skipped' : 'planned';
        }
        this.touch(mission, 'mission-stopped-before-worker-handoff');
        return;
      }
      // Staging can yield to revocation, expiry or a connector update. The
      // earlier dispatch checks cannot authorize a later worker handoff.
      const denyHandoff = () => {
        this.effectCoordinator.cancelPrepared(action, { reason: 'mission-prerequisite-changed-before-worker-handoff' });
        action.revisionNoHandoff = true;
        action.status = mission.status === MissionStatus.CANCELLED ? 'skipped' : 'planned';
        action.attempts = Math.max(0, action.attempts - 1);
      };
      if (!await this.checkLearnedGuidance(mission, wave)) { denyHandoff(); return; }
      if (!await this.checkActionAvailability(mission, wave, action, task, 'dispatch')) {
        denyHandoff(); return;
      }
      if (this.pauseForShutdown(mission, wave) || terminalStatuses.has(mission.status)) {
        denyHandoff(); return;
      }
      const handoffRevisionIssue = this.goalRevisions.actionIssue(mission, action, task);
      if (handoffRevisionIssue) {
        denyHandoff(); wave.status = 'paused'; mission.status = MissionStatus.PAUSED;
        mission.stopReason = 'goal-revision-action-blocked'; mission.lastError = handoffRevisionIssue.error;
        return;
      }
      if ((mission.authorization.mode === 'trusted_session'
          || action.authorizationRevision !== (mission.authorizationRevision ?? 1))
        && !this.actionAuthorized(mission, action, profile)) {
        denyHandoff();
        this.coreFacade.cancelTask?.(action.taskId, { reason: 'mission-authorization-revoked-before-worker-handoff', source: mission.missionId });
        this.createActionGate(mission, wave, action, task, profile);
        action.status = 'waiting_approval';
        return;
      }
      try {
        if (mission.executionMandateId && !this.executionBudget) throw new Error('A_MANDATE_SERVICE_UNAVAILABLE');
        this.personalDependencyGuard?.assertCurrentMission(mission);
      this.executionBudget?.beforeAction(mission);
      } catch (error) {
        denyHandoff(); mission.status = MissionStatus.PAUSED;
        mission.stopReason = error.code==='A_PERSONAL_LINK_DEPENDENCY_CHANGED'?'personal-dependency-changed':'mandate-execution-denied';
        mission.lastError = { code: error.code==='A_PERSONAL_LINK_DEPENDENCY_CHANGED'?error.code:'A_MANDATE_EXECUTION_DENIED', message: error.message };
        return;
      }
      this.touch(mission, 'mission-action-running');
      // Connector/authority staging above can await and mutate final dispatch
      // arguments. Rebind the entire original request after the last await,
      // immediately before handing an effect to the worker.
      action.requirementCoverage = assessMissionRequirementCoverage({mission,wave,action,profile,phase:'dispatch',
        dispatchToolName:task.plan?.action?.toolName,dispatchArguments:task.plan?.action?.arguments,allowedRoots:this.allowedRoots,
        microsoftRequestBindingResolver:request=>this.microsoftCollectionRequestBound(mission,action,request),temporalBindingResolver:(current,options)=>(this.routineTemporalGuard?.bindSourceTime(current,options)??false)||this.completionDeadline.bindSourceTime(current,options), installedIntentBinding:this.pcAgent.registry?.contractFor?.(task.plan?.action?.toolName)?.intentBinding??null});
      if(!action.requirementCoverage.allowed){denyHandoff();this.pauseForRequirementCoverage(mission,wave,action);return;}
      if(!this.clarificationReadAllowed(mission,wave,action,task)){
        denyHandoff();this.coreFacade.cancelTask?.(action.taskId,{reason:'clarification-read-source-changed',source:mission.missionId});
        action.status='failed';mission.metrics.failedActions+=1;
        this.recordActionFailure(mission,action,{code:'A_MISSION_CLARIFICATION_READ_SCOPE_INVALID',message:'읽을 대상이 원문 요청과 달라졌습니다. 답변 대기 중에는 요청에서 확인된 자료만 읽습니다.'});return;
      }
      const memoryReadiness = this.effectCoordinator.memoryReadiness(task);
      if (!memoryReadiness.available) {
        denyHandoff(); wave.status = 'paused'; mission.status = MissionStatus.PAUSED;
        mission.stopReason = 'durable-memory-unavailable';
        mission.lastError = { code: memoryReadiness.code, reason: memoryReadiness.reason,
          nextAction: memoryReadiness.nextAction, actionId: action.actionId };
        this.touch(mission, 'mission-memory-unavailable-before-handoff');
        return;
      }
      const run = await this.orchestrationWorker.runTask(task.taskId, {
        signal:this.activeRuns.get(mission.missionId)?.effectController?.signal??null,
        beforePlanNodeExecute: withManagedParentReadFence({runtime:this,mission,
          executor:this.orchestrationWorker.executorForPacket?.({action:task.plan.action})??this.orchestrationWorker.pcAgent,
          beforeExecute:withMissionMandateFence({ mission, gate: this.executionBudget,
          executor: this.orchestrationWorker.executorForPacket?.({action:task.plan.action}) ?? this.orchestrationWorker.pcAgent, hooks: null,workspaceRoot:this.allowedRoots[0] })?.beforeExecute ?? null,
        }),
        beforePacketDispatch: async packet => {
          action.scheduleTemporalVerification=this.routineTemporalGuard?.assertCurrentMission(mission)??null;
          const deadlineProof=this.completionDeadline.assertCurrentMission(mission,{toolName:packet.action?.toolName});
          action.deadlineTemporalVerification=deadlineProof?{...deadlineProof,actionId:action.actionId}:null;
          this.executionBudget?.beforeAction(mission,{packet,workspaceRoot:this.allowedRoots[0]});
          const nodeId = packet.planGraphNodeId ?? null;
          let checkedAction = action;
          if (nodeId && packet.action?.toolName !== task.plan?.action?.toolName) {
            action.nodeAvailabilityChecks ??= [];
            checkedAction = action.nodeAvailabilityChecks.find(item => item.nodeId === nodeId);
            if (!checkedAction) {
              checkedAction = { nodeId, actionId: action.actionId, expectedToolName: packet.action?.toolName };
              action.nodeAvailabilityChecks.push(checkedAction);
            }
          }
          const packetTask = { ...task, plan: { ...task.plan, action: packet.action } };
          if (!await this.checkActionAvailability(mission, wave, checkedAction, packetTask, 'dispatch')) {
            throw Object.assign(new Error('Connection prerequisites changed before the PC handoff.'), {
              code: 'A_MISSION_CAPABILITY_UNAVAILABLE', notDispatched: true, planGraphNodeId: nodeId });
          }
          if(!this.clarificationReadAllowed(mission,wave,action,packetTask)){
            throw Object.assign(new Error('Clarification read no longer matches the original requested source.'),
              {code:'A_MISSION_CLARIFICATION_READ_SCOPE_INVALID',notDispatched:true});
          }
          const packetProfile=this.capabilityProfile(packetTask);
          if(packet.action?.toolName===action.actualToolName || packetProfile.readOnly!==true
            || packetProfile.externalTransfer===true || packetProfile.executionClass==='external_commit') {
            const packetAction=packet.action?.toolName===action.actualToolName?action:
              {...action,actualToolName:packet.action?.toolName,expectedToolName:packet.action?.toolName};
            const coverage=assessMissionRequirementCoverage({mission,wave,action:packetAction,profile:packetProfile,phase:'dispatch',
              dispatchToolName:packet.action?.toolName,dispatchArguments:packet.action?.arguments,allowedRoots:this.allowedRoots,
              microsoftRequestBindingResolver:request=>this.microsoftCollectionRequestBound(mission,action,request),temporalBindingResolver:(current,options)=>(this.routineTemporalGuard?.bindSourceTime(current,options)??false)||this.completionDeadline.bindSourceTime(current,options), installedIntentBinding:this.pcAgent.registry?.contractFor?.(packet.action?.toolName)?.intentBinding??null});
            if(!coverage.allowed){
              action.requirementCoverage=coverage;this.pauseForRequirementCoverage(mission,wave,action);
              throw Object.assign(new Error('Original request no longer matches the final PC packet.'),
                {code:'A_MISSION_REQUIREMENT_COVERAGE_INCOMPLETE',notDispatched:true,planGraphNodeId:nodeId});
            }
          }
        },
        localEffectHooks: { ...(localEffectHooks ?? {}), onPacketPrepared: packet => {
          if (packet.action?.toolName !== 'workflow.execute') return;
          const { capabilityToken, ...identity } = packet;
          const snapshot = { packet: identity, plan: task.plan, taskRequest: {
            taskId: task.request.taskId, createdAt: task.request.createdAt, command: task.request.command, source: task.request.source },
            goalRevision: action.goalRevision ?? 1, authorizationRevision: mission.authorizationRevision ?? 1 };
          Object.assign(action.operation,createWorkflowResumeCheckpoint(snapshot));
          this.touch(mission, 'mission-workflow-resume-authority-checkpoint');
        } },
        deviceId: 'mission_executive',
        userConfirmation: {
          confirmed: true,
          confirmedAt: this.clock().toISOString(),
          missionId: mission.missionId,
          missionActionId: action.actionId,
          grant: profile.executionClass
        }
      });
      if (run?.error?.code === 'A_WORKER_CAPABILITY_UNAVAILABLE' && run.notDispatched === true) {
        this.effectCoordinator.cancelPrepared(action, { reason: 'worker-capability-unavailable-before-pc-handoff' });
        action.status = 'planned'; wave.status = 'paused'; mission.status = MissionStatus.PAUSED;
        mission.stopReason = 'capability-unavailable'; action.availability = run.capabilityReadiness;
        mission.lastError = { code: 'A_MISSION_CAPABILITY_UNAVAILABLE', reasons: run.capabilityReadiness?.reasons ?? [],
          nextAction: run.capabilityReadiness?.nextAction ?? run.error.message, actionId: action.actionId };
        this.touch(mission, 'worker-capability-unavailable-before-pc-handoff');
        return;
      }
      if (this.confirmUndispatchedStop(mission, wave, action)) return;
      mission.metrics.executedActions += 1;
      action.executionCounted = true;
      const storedTask = this.coreFacade.getTask(task.taskId);
      if (this.effectCoordinator.finish(action, run.success === true && storedTask?.status === TaskStatus.COMPLETED)) {
        const failure=run.success===true?null:this.errorFromRun(run,storedTask);
        throw Object.assign(new Error('Local effect needs receipt reconciliation or G verification.'), {
          code: 'A_MISSION_EFFECT_RECONCILIATION_REQUIRED', executionUncertain: true,
          ...(failure?.code?{causeCode:failure.code}:{}) });
      }
      if (run.success === true && storedTask?.status === TaskStatus.COMPLETED) {
        this.effectCoordinator.assertMemoriesPersisted(action, run.execution);
        action.status = 'succeeded';
        if (action.successCounted !== true) mission.metrics.successfulActions += 1;
        action.successCounted = true;
        const observation = this.successObservation(action, storedTask, run);
        action.observationId = this.addObservation(mission, observation).observationId;
        if(action.actualToolName==='source.readSelectedInbox')this.selectedSourceAccess?.archiveCompletedAction?.(mission,action,storedTask);
        if(action.actualToolName==='source.collectMicrosoftMetadata')this.microsoftCollectionAccess?.archiveCompletedAction?.(mission,action,storedTask);
        if(action.actualToolName==='case.readLocalRecord')this.lifecycleCaseAccess?.archiveCompletedAction?.(mission,action,storedTask);
        this.effectCoordinator.verified(action, run.execution);
        this.recordEvent('mission.action.succeeded', mission, {
          waveId: wave.waveId,
          actionId: action.actionId,
          taskId: action.taskId,
          toolName: action.actualToolName,
          verificationStatus: observation.verification?.status ?? null
        });
      } else {
        action.status = 'failed';
        if(action.actualToolName==='workflow.execute'&&this.orchestrationWorker.pcAgent===this.pcAgent){
          const result=run.execution?.executionResult;
          const proof=result?.error?.code==='WORKFLOW_ASSERT_COUNT_FAILED'
            ?this.pcAgent.unpublishedPersonFailureForDispatch?.(action.operation?.dispatch):null;
          if(proof){
            this.#unpublishedPersonFailures.set(action,{...proof,dispatchSha256:sha256(JSON.stringify(action.operation?.dispatch??null))});
            action.unpublishedFailureEvidence={...proof,executionAuthority:false};
          }
        }
        mission.metrics.failedActions += 1;
        this.recordActionFailure(mission, action, this.errorFromRun(run, storedTask));
      }
    } catch (error) {
      if (error?.code === 'A_MISSION_CAPABILITY_UNAVAILABLE' && error.notDispatched === true
        && !error.planGraphNodeId && task.status === TaskStatus.APPROVED) {
        this.effectCoordinator.cancelPrepared(action, { reason: 'mission-capability-changed-before-pc-handoff' });
        action.status = 'planned';
        this.touch(mission, 'mission-capability-changed-before-pc-handoff');
        return;
      }
      if (this.confirmUndispatchedStop(mission, wave, action)) return;
      if (action.executionCounted !== true) mission.metrics.executedActions += 1;
      action.executionCounted = true;
      const handedOff = error?.executionUncertain === true
        || [TaskStatus.EXECUTING, TaskStatus.VERIFYING, TaskStatus.COMPLETED].includes(task.status)
        || task.orchestrationTrace?.steps?.some((step) => step.phase === 'worker.execution.started');
      if (handedOff) {
        action.status = 'planned';
        action.recovery = {
          required: true, status: 'blocked', checkedAt: this.clock().toISOString(),
          error: { code: 'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN',
            message: 'Execution handoff was interrupted. Confirm the original receipt before continuing.',
            causeCode: error?.causeCode ?? error?.code ?? null,...(pcCommandDenialNextAction(error)?{nextAction:pcCommandDenialNextAction(error)}:{}),...(error?.code==='A_PC_COMMAND_LOCAL_SCOPE_DENIED'?{
              localScopeReason:pcLocalDenialNextAction(error?.localScopeReason)?error.localScopeReason:'B_PC_COMMAND_LOCAL_SCOPE_DENIED',
              nextAction:pcLocalDenialNextAction(error?.localScopeReason)??pcLocalDenialNextAction('B_PC_COMMAND_LOCAL_SCOPE_DENIED')}:{}) }
        };
        // Cancellation stops new work; it does not establish that an in-flight
        // effect never happened. Keep its unresolved outcome visible as well.
        mission.lastError = structuredClone(action.recovery.error);
        if (mission.status !== MissionStatus.CANCELLED) {
          wave.status = 'paused';
          mission.status = MissionStatus.PAUSED;
          mission.stopReason = 'action-recovery-required';
        }
        this.recordEvent('mission.action.recovery-blocked', mission, { actionId: action.actionId, error: action.recovery.error });
      } else {
        mission.metrics.failedActions += 1;
        action.status = 'failed';
        this.recordActionFailure(mission, action, {
          code: error?.code ?? 'A_MISSION_ACTION_EXCEPTION',
          message: cleanText(error?.message, 500) ?? 'Mission action failed.'
        });
      }
    } finally {
      this.effectCoordinator.finish(action, action.status === 'succeeded');
      mission.metrics.currentConcurrency = Math.max(0, mission.metrics.currentConcurrency - 1);
      action.updatedAt = this.clock().toISOString();
      this.touch(mission, 'mission-action-finished');
    }
  }

  async checkActionAvailability(mission, wave, action, task, phase) {
    const toolName = task?.plan?.action?.toolName ?? action.expectedToolName;
    const contract = this.pcAgent.registry?.contractFor?.(toolName) ?? {};
    const result = await this.capabilityAvailabilityGuard.assess({ mission, action, task, toolName, contract, phase });
    if (terminalStatuses.has(mission.status)) return false;
    if (!result.required) return true;
    action.availability = result;
    if (result.available) return true;
    action.status = 'planned';
    wave.status = 'paused';
    mission.status = MissionStatus.PAUSED;
    mission.stopReason = 'capability-unavailable';
    mission.lastError = { code: 'A_MISSION_CAPABILITY_UNAVAILABLE', reasons: result.reasons,
      nextAction: result.nextAction, actionId: action.actionId };
    this.recordEvent('mission.action.capability-unavailable', mission, {
      actionId: action.actionId, phase, reasons: result.reasons, executionAuthorized: false
    });
    this.touch(mission, 'mission-capability-unavailable');
    return false;
  }

  confirmUndispatchedStop(mission, wave, action) {
    if (mission.status !== MissionStatus.CANCELLED && !this.shutdownRequest
      && mission.goalRevisionRequest?.state !== 'pending') return false;
    const effect = this.effectCoordinator.effect(action);
    // Only the durable executor's confirmed receipt establishes that no effect ran.
    // Task cancellation and worker-start traces alone cannot establish this fact.
    if (effect?.state !== 'failed' || effect.receipt?.notDispatched !== true) return false;
    action.status = mission.status === MissionStatus.CANCELLED ? 'skipped' : 'planned';
    action.revisionNoHandoff = true;
    action.recovery = { ...action.recovery, required: false, status: 'not-dispatched',
      checkedAt: this.clock().toISOString(), error: null };
    this.pauseForShutdown(mission, wave);
    this.recordEvent('mission.action.stopped-before-effect', mission, { actionId: action.actionId,
      operationId: effect.operation_id });
    return true;
  }

  pauseForRequirementCoverage(mission, wave, action) {
    action.status = 'planned';
    wave.status = 'paused';
    mission.status = MissionStatus.PAUSED;
    mission.stopReason = 'external-action-requirements-unverified';
    mission.lastError = { code: 'A_MISSION_REQUIREMENT_COVERAGE_INCOMPLETE', actionId: action.actionId,
      reasons: action.requirementCoverage.reasons, nextAction: action.requirementCoverage.nextAction,
      resolution: explainRequirementCoverageFailure({mission,action}) };
    this.touch(mission, 'mission-requirement-coverage-paused');
    this.recordEvent('mission.action.requirement-coverage-blocked', mission, {
      actionId: action.actionId, phase: action.requirementCoverage.phase,
      reasons: action.requirementCoverage.reasons, executionAuthority: false
    });
  }

  rememberRecoveredAction(mission, action, result) {
    const memory = this.coreFacade.workMemory;
    if (typeof memory?.record !== 'function') return { status: 'unavailable', reason: 'work-memory-unavailable' };
    // A restored Mission's editable metadata cannot relocate an already executed
    // operation into another user's or conversation's work memory.
    const originalRequest = this.effectCoordinator.originalMemoryRequest(action, mission.missionId)
      ?? this.coreFacade.getTask(action.taskId)?.request;
    const scope = originalRequest ? this.coreFacade.workReferenceScope?.(originalRequest)
      : mission.metadata?.workReferenceScope ?? this.coreFacade.workReferenceScope?.({
        metadata: mission.metadata, userId: mission.metadata?.userId ?? 'local_user'
      });
    try {
      const outputPaths = result.outputPaths ?? [];
      const sameOutputs = (entry) => Array.isArray(entry.outputPaths) && entry.outputPaths.length === outputPaths.length
        && entry.outputPaths.every((path, index) => resolve(path) === resolve(outputPaths[index]));
      const existing = (memory.recent?.(300, { scope }) ?? []).find((entry) => entry.status === 'success'
        && (entry.taskId === action.taskId || entry.operationId === action.operation.operationId) && sameOutputs(entry));
      if (existing) return { status: 'already-recorded', operationId: action.operation.operationId };
      const recorded = memory.record({
        taskId: action.taskId, missionId: mission.missionId, operationId: action.operation.operationId,
        scope, rawText: action.command, actionType: action.operation.dispatch.actionType,
        outputPaths, summary: result.summary ?? null, status: 'success'
      });
      return recorded ? { status: 'recorded', operationId: action.operation.operationId }
        : { status: 'unavailable', reason: 'work-memory-record-not-persisted' };
    } catch (error) {
      return { status: 'unavailable', reason: 'work-memory-record-failed', causeCode: error?.code ?? null };
    }
  }

  capabilityProfile(task) {
    const toolName = task.plan?.action?.toolName ?? null;
    const contract = this.pcAgent.registry?.contractFor?.(toolName) ?? {};
    const capability = task.plan?.action?.capability ?? task.route?.requiredCapability ?? {};
    const riskTier = Number(task.policy?.risk?.tier ?? task.approvalCard?.riskTier ?? 1);
    const externalTransfer = capability.externalTransfer === true || toolName === 'email.send';
    const readOnly = contract.readOnly === true
      || (capability.writesLocalFiles === false && externalTransfer === false && !['desktop.control', 'shell.execute'].includes(toolName));
    const mutatesSystem = contract.mutatesSystem === true || capability.writesLocalFiles === true;
    const rollback = contract.rollback === true || capability.reversible === true;
    let executionClass = MissionGrant.READ_ONLY;
    let perActionApproval = false;
    if (externalTransfer) {
      executionClass = 'external_commit';
      perActionApproval = true;
    } else if (['desktop.control', 'shell.execute'].includes(toolName) || riskTier <= 3) {
      executionClass = MissionGrant.HIGH_IMPACT;
    } else if (mutatesSystem && rollback) {
      executionClass = MissionGrant.LOCAL_REVERSIBLE;
    } else if (mutatesSystem) {
      executionClass = 'irreversible_commit';
      perActionApproval = true;
    }
    return {
      profileVersion: 'a-mission-capability-profile-v1',
      toolName,
      actionType: task.plan?.action?.actionType ?? null,
      readOnly,
      contractReadOnly: contract.readOnly === true,
      contractEffectScope: contract.effectScope ?? null,
      mutatesSystem,
      rollback,
      externalNetwork: capability.externalNetwork === true,
      externalTransfer,
      writesLocalFiles: capability.writesLocalFiles === true,
      riskTier,
      executionClass,
      perActionApproval
    };
  }

  routeAdaptation(expectedToolName, actualToolName, actualProfile) {
    const localFileReads = new Set(['filesystem.listFiles', 'filesystem.searchFiles', 'filesystem.readText', 'document.readPdf', 'excel.readWorkbook']);
    const safeActual = actualProfile?.readOnly === true
      && actualProfile?.mutatesSystem !== true
      && actualProfile?.externalNetwork !== true
      && actualProfile?.externalTransfer !== true;
    if (safeActual && localFileReads.has(expectedToolName) && localFileReads.has(actualToolName)) {
      return {
        allowed: true,
        policy: 'a-mission-route-adaptation-v1',
        reason: 'equivalent-local-file-read',
        privilegeChange: 'same'
      };
    }
    if (safeActual && expectedToolName === 'shell.execute' && localFileReads.has(actualToolName)) {
      return {
        allowed: true,
        policy: 'a-mission-route-adaptation-v1',
        reason: 'lower-privilege-local-file-read',
        privilegeChange: 'reduced'
      };
    }
    return {
      allowed: false,
      policy: 'a-mission-route-adaptation-v1',
      reason: 'incompatible-route',
      privilegeChange: 'unknown'
    };
  }

  actionAuthorized(mission, action, profile) {
    action.authorizationCheckRevision = mission.authorizationRevision ?? 1;
    const approvedGate = mission.gates.find((gate) => gate.gateId === action.gateId && gate.status === 'approved');
    if (approvedGate && (approvedGate.authorizationRevision ?? 1) === (mission.authorizationRevision ?? 1)) {
      action.authorizationRevision = mission.authorizationRevision ?? 1;
      return true;
    }
    if (profile.perActionApproval) {
      if (this.microsoftCollectionApprovalScope(mission, action, profile)) {
        action.authorizationRevision = mission.authorizationRevision ?? 1;
        action.authorizationMode = 'bounded-microsoft-pagination';
        return true;
      }
      if (this.trustedSelfEmailAuthorized(mission, action, profile)) {
        action.authorizationMode = 'trusted-owner-self-email';
        return true;
      }
      return false;
    }
    if (mission.authorization.mode === 'trusted_session') {
      const ownerAuthorization = this.ownerSessionManager?.authorizeMission?.({
        sessionId: mission.authorization.ownerSessionId,
        requestedGrants: [profile.executionClass]
      });
      if (ownerAuthorization?.allowed !== true) return false;
    }
    const allowed = mission.authorization.grants.includes(profile.executionClass);
    if (allowed) action.authorizationRevision = mission.authorizationRevision ?? 1;
    return allowed;
  }

  async resumeWorkflowPublication(mission, wave, action, recovered) {
    const publication = recovered.error?.publication, dispatch = action.operation?.dispatch;
    const worker = this.orchestrationWorker, executor = worker?.pcAgent ?? this.pcAgent;
    let saved;try{saved=readWorkflowResumeCheckpoint(action.operation);}catch{return false;}
    if (publication?.status !== 'observed' || publication.contractBinding?.status !== 'bound'
      || !publication.resumable || !saved || dispatch?.toolName !== 'workflow.execute'
      || typeof executor?.resumeWorkflowPublication !== 'function') return false;
    const digest = remoteArtifactDigest;
    if (saved.packet.taskId !== dispatch.taskId || saved.packet.planId !== saved.plan.planId
      || digest(saved.packet.action) !== digest(saved.plan.action)
      || digest(saved.packet.action.arguments) !== digest(dispatch.arguments)
      || saved.goalRevision !== (action.goalRevision ?? 1)
      || saved.authorizationRevision !== (mission.authorizationRevision ?? 1)) return false;
    const task = { taskId: dispatch.taskId, plan: structuredClone(saved.plan), request: structuredClone(saved.taskRequest) };
    const profile = dispatch.profile;
    if (profile?.executionClass !== 'local_reversible' || profile.externalTransfer || profile.perActionApproval
      || !this.actionAuthorized(mission, action, profile) || this.pauseForShutdown(mission, wave)
      || terminalStatuses.has(mission.status) || this.goalRevisions.actionIssue(mission, action, task)) return false;
    try {
      if (!await this.checkActionAvailability(mission, wave, action, task, 'dispatch')) return false;
      task.policy = this.coreFacade.policyEngine?.evaluatePlan?.({ taskRequest: task.request, plan: task.plan });
      if (!task.policy || task.policy.decision === 'block') return false;
      const currentProfile = this.capabilityProfile(task);
      if (currentProfile.executionClass !== 'local_reversible' || currentProfile.externalTransfer
        || currentProfile.perActionApproval || !this.actionAuthorized(mission, action, currentProfile)) return false;
      const decision = createApprovalDecision({ approvalId: stableId('resume_approval', dispatch.taskId, this.clock().toISOString()),
        taskId: dispatch.taskId, decision: ApprovalDecision.APPROVE, deviceId: 'mission_executive',
        sourceModule: ModuleId.CORE, decidedAt: this.clock().toISOString() });
      const capabilityToken = worker.issueCapabilityToken(task, decision);
      const verification = worker.verifyPolicy(task, decision, capabilityToken);
      if (!verification || worker.failedVerification(verification)) return false;
      if (mission.executionMandateId && !this.executionBudget) return false;
      this.personalDependencyGuard?.assertCurrentMission(mission);
      this.executionBudget?.beforeAction(mission);
      // Availability/policy may yield to cancellation or grant/revision changes.
      if (this.pauseForShutdown(mission, wave) || terminalStatuses.has(mission.status)
        || saved.authorizationRevision !== (mission.authorizationRevision ?? 1)
        || !this.actionAuthorized(mission, action, profile) || this.goalRevisions.actionIssue(mission, action, task)) return false;
      if (!await this.checkLearnedGuidance(mission, wave)) return false;
      action.recoveryResume = { status: 'requested', requestedAt: this.clock().toISOString() };
      mission.metrics.workflowResumeCalls = (mission.metrics.workflowResumeCalls ?? 0) + 1;
      this.touch(mission, 'mission-workflow-resume-requested');
      const hooks = this.effectCoordinator.effect(action)
        ? this.effectCoordinator.publicationRecoveryHooks(mission, action, task) : null;
      const packet = { ...saved.packet, capabilityToken, approvalDecision: decision,
        userConfirmation: { ...saved.packet.userConfirmation, confirmed: true, approvalId: decision.approvalId, confirmedAt: this.clock().toISOString() } };
      let result;
      try {
        result = await executor.resumeWorkflowPublication(packet, hooks ? { beforeLocalExecute: hooks.beforeExecute } : {});
        await hooks?.onReceipt(result, packet);
      } finally { if (hooks) this.effectCoordinator.finish(action, result?.status === TaskStatus.COMPLETED); }
      action.recoveryResume = { status: result.status === TaskStatus.COMPLETED ? 'receipt-returned' : 'blocked',
        checkedAt: this.clock().toISOString(), code: result.blockedReason ?? result.error?.code ?? null };
      this.touch(mission, 'mission-workflow-resume-result');
      return result.status === TaskStatus.COMPLETED;
    } catch (error) {
      action.recoveryResume = { status: 'uncertain', checkedAt: this.clock().toISOString(), code: error.code ?? 'A_WORKFLOW_RESUME_FAILED' };
      this.touch(mission, 'mission-workflow-resume-uncertain'); return false;
    }
  }

  trustedSelfEmailAuthorized(mission, action, profile) {
    if (profile.toolName !== 'email.send' || mission.authorization.mode !== 'trusted_session') return false;
    if (!mission.authorization.grants.includes(MissionGrant.HIGH_IMPACT)) return false;
    if (!/(?:내|제)\s*(?:구글\s*)?(?:이|e)?메일|나(?:에게|한테)|본인(?:에게)?|self/iu.test(mission.objective)) return false;
    const args = action.arguments ?? {};
    const to = String(args.to ?? '').trim();
    const selfRecipient = args.recipientMode === 'self' || (!to && /(?:내|제)\s*(?:구글\s*)?(?:이|e)?메일|나(?:에게|한테)|본인(?:에게)?|self/iu.test(action.command));
    if (!selfRecipient || (to && !/^self$/iu.test(to))) return false;
    const specs = Array.isArray(args.attachments)
      ? args.attachments
      : args.attachmentRef ? [{ attachmentRef: args.attachmentRef, attachmentSha256: args.attachmentSha256 }] : [];
    const exactAttachments = specs.every((spec) => {
      const ref = spec?.attachmentRef ?? spec?.ref;
      const sha256 = String(spec?.attachmentSha256 ?? spec?.sha256 ?? spec?.contentSha256 ?? '').trim().toLowerCase();
      return Number.isInteger(Number(ref?.rootIndex))
        && String(ref?.relativePath ?? '').trim().length > 0
        && /^[a-f0-9]{64}$/.test(sha256);
    });
    if (!exactAttachments) return false;
    const ownerAuthorization = this.ownerSessionManager?.authorizeMission?.({
      sessionId: mission.authorization.ownerSessionId,
      requestedGrants: [MissionGrant.HIGH_IMPACT]
    });
    return ownerAuthorization?.allowed === true;
  }

  createActionGate(mission, wave, action, task, profile) {
    const existing = mission.gates.find((gate) => gate.actionId === action.actionId && gate.status === 'pending');
    if (existing) {
      action.gateId = existing.gateId;
      return existing;
    }
    const createdAt = this.clock().toISOString();
    const gate = {
      goalRevision: mission.goalContract?.revision ?? 1,
      gateVersion: 'a-mission-decision-gate-v1',
      authorizationRevision: mission.authorizationRevision ?? 1,
      gateId: stableId('mission_gate', `${mission.missionId}:${action.actionId}:approval:${mission.gates.length+1}`, createdAt),
      missionId: mission.missionId,
      waveId: wave.waveId,
      actionId: action.actionId,
      type: 'action_approval',
      status: 'pending',
      title: action.title,
      question: `이 행동을 실행할까요? ${action.title}`,
      command: action.command,
      commandHash: action.commandHash,
      toolName: profile.toolName,
      executionClass: profile.executionClass,
      riskTier: profile.riskTier,
      externalTransfer: profile.externalTransfer,
      rollbackAvailable: profile.rollback,
      affectedItems: task.plan?.affectedItems ?? [],
      approvalCardId: task.approvalCard?.approvalId ?? null,
      createdAt,
      decidedAt: null,
      decision: null,
      responseText: null
    };
    const paginationScope = this.microsoftCollectionScopeBinding(mission, action, profile, task);
    if (paginationScope) {
      gate.microsoftPaginationScope = paginationScope;
      const request = mission.microsoftCollection.request;
      gate.question = `선택한 ${request.provider} 연결(${request.connectionId}${request.chatId ? ', 대화 '+request.chatId : ''})의 메타데이터를 최대 ${paginationScope.maxPages}페이지까지 수집해 로컬 원장에 저장할까요? 승인 유효기간과 현재 소유자 세션 안에서 나머지 페이지는 다시 묻지 않습니다. 본문·첨부·발송은 포함하지 않습니다.`;
    }
    action.gateId = gate.gateId;
    mission.gates.push(gate);
    this.recordEvent('mission.gate.created', mission, {
      gateId: gate.gateId,
      actionId: action.actionId,
      toolName: gate.toolName,
      executionClass: gate.executionClass,
      riskTier: gate.riskTier
    });
    return gate;
  }

  createClarificationGate(mission, planned) {
    const createdAt = this.clock().toISOString();
    const gate = {
      goalRevision: mission.goalContract?.revision ?? 1,
      gateVersion: 'a-mission-decision-gate-v1',
      gateId: stableId('mission_gate', `${mission.missionId}:clarification:${mission.gates.length + 1}`, createdAt),
      missionId: mission.missionId,
      waveId: null,
      actionId: null,
      type: 'clarification',
      goalObjectiveSha256:sha256(mission.objective),
      status: 'pending',
      title: '목표 진행에 필요한 판단',
      questions: clarificationQuestions(planned),
      question: planned.questions?.map((question, index) => `${index + 1}. ${question}`).join('\n') ?? planned.question ?? planned.summary ?? '진행에 필요한 정보를 입력해 주세요.',
      command: null,
      commandHash: null,
      toolName: null,
      executionClass: 'clarification',
      riskTier: null,
      externalTransfer: false,
      rollbackAvailable: false,
      affectedItems: [],
      approvalCardId: null,
      createdAt,
      decidedAt: null,
      decision: null,
      responseText: null
    };
    mission.gates.push(gate);
    this.recordEvent('mission.gate.created', mission, { gateId: gate.gateId, type: gate.type });
    return gate;
  }

  createExternalEgressGate(mission, { childMissionId, callKey, providerId, toolName, contentSha256, dataClass, ministryDataClass = null } = {}) {
    if (!mission?.missionId || typeof callKey !== 'string' || !callKey.trim() || !/^[a-f0-9]{64}$/u.test(contentSha256 ?? '')
      || !providerId || !toolName) return failure('A_MISSION_EGRESS_GATE_INVALID', 'External transfer gate scope is incomplete.');
    const existing = mission.gates.find(gate => gate.type === 'external_data_egress' && gate.callKey === callKey);
    if (existing) {
      if (existing.contentSha256 !== contentSha256 || existing.providerId !== providerId || existing.toolName !== toolName
        || existing.childMissionId !== childMissionId) return failure('A_MISSION_EGRESS_GATE_SCOPE_CONFLICT', 'The call already has a different egress approval scope.');
      return { success: true, gateId: existing.gateId, status: existing.status, replayed: true };
    }
    const createdAt = this.clock().toISOString();
    const gate = {
      goalRevision: mission.goalContract?.revision ?? 1,
      gateVersion: 'a-mission-decision-gate-v1',
      gateId: stableId('mission_gate', `${mission.missionId}:external-egress:${callKey}`, createdAt),
      missionId: mission.missionId,
      waveId: null,
      actionId: null,
      childMissionId,
      callKey,
      type: 'external_data_egress',
      status: 'pending',
      title: '로컬 자료를 외부 AI 제공자에게 전송',
      question: `${providerId}의 ${toolName} 요청에 따라 분류된 로컬 자료 일부를 전송할까요?`,
      command: null,
      commandHash: contentSha256,
      contentSha256,
      toolName,
      providerId,
      expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
      executionClass: 'external_data_transfer',
      riskTier: null,
      dataClass,
      ministryDataClass,
      externalTransfer: true,
      rollbackAvailable: false,
      affectedItems: [],
      approvalCardId: null,
      createdAt,
      decidedAt: null,
      decision: null,
      decidedBy: null,
      responseText: null
    };
    mission.gates.push(gate);
    mission.status = MissionStatus.PAUSED;
    mission.stopReason = 'external-data-transfer-approval-required';
    this.touch(mission, 'mission-external-egress-gate-created');
    this.recordEvent('mission.gate.created', mission, { gateId: gate.gateId, type: gate.type, providerId, toolName, contentSha256 });
    return { success: true, gateId: gate.gateId, status: gate.status, replayed: false };
  }

  decideGate(missionId, gateId, { decision, responseText = null, answers = undefined, decidedBy = 'core_admin' } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    const gate = mission.gates.find((item) => item.gateId === gateId);
    if (!gate) return failure('A_MISSION_GATE_NOT_FOUND', 'Mission gate was not found.', { missionId, gateId });
    let answerBatch = null;
    if (decision === 'approve' && answers !== undefined) {
      try { answerBatch = clarificationAnswerBatch(gate, answers); }
      catch { return failure('A_MISSION_CLARIFICATION_ANSWERS_INVALID', '모든 질문에 빠짐없이 답변해 주세요. 각 답변은 500자, 전체는 2,000자 이내입니다.', { missionId, gateId }); }
      responseText = answerBatch.responseText;
    }
    if (gate.type === 'clarification' && gate.questions?.length && decision === 'approve' && !cleanText(responseText, 2000)) {
      return failure('A_MISSION_CLARIFICATION_ANSWER_REQUIRED', '묶인 질문에 답변을 입력해 주세요.', { missionId, gateId });
    }
    const revisionIssue = this.goalRevisions.gateIssue(mission, gate);
    if (revisionIssue) return revisionIssue;
    if (gate.expiresAt && Date.parse(this.clock().toISOString()) >= Date.parse(gate.expiresAt)) {
      gate.status = 'expired';
      gate.decidedAt = this.clock().toISOString();
      gate.decidedBy = 'system:expiry';
      this.touch(mission, 'mission-egress-gate-expired');
      this.recordEvent('mission.gate.expired', mission, { gateId: gate.gateId, type: gate.type });
      return failure('A_MISSION_GATE_EXPIRED', 'The external-transfer approval window has expired.', {
        missionId, gateId, expiresAt: gate.expiresAt
      });
    }
    if (gate.status !== 'pending') {
      return failure('A_MISSION_GATE_ALREADY_DECIDED', 'Mission gate already has a decision.', {
        missionId,
        gateId,
        gate: structuredClone(gate)
      });
    }
    const normalizedDecision = decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : null;
    if (!normalizedDecision) return failure('A_MISSION_GATE_DECISION_INVALID', 'Gate decision must be approve or reject.');
    if(gate.explicitReadApproval&&normalizedDecision==='approve'){
      const current=explicitReadApproval(mission);
      if(!current||JSON.stringify(current)!==JSON.stringify(gate.explicitReadApproval)
        ||gate.questions?.length!==1||gate.questions[0]!==current.question||gate.goalObjectiveSha256!==current.objectiveSha256)
        return failure('A_MISSION_READ_CONDITION_STALE','원문 또는 승인 대상이 바뀌었습니다. 현재 요청을 다시 확인하세요.');
      if(!explicitApprovalAnswer({answers:answerBatch?.answers,responseText}))
        return failure('A_MISSION_READ_CONDITION_ANSWER_REQUIRED','지금 읽도록 승인한다면 “승인”이라고 답해 주세요. 모호한 답변으로 실행하지 않습니다.');
      if(this.activeRuns.has(missionId))return failure('A_MISSION_READ_CONDITION_BUSY','현재 실행 정리를 마친 뒤 같은 승인 요청을 다시 처리하세요.');
      const revised=this.reviseMissionGoal(missionId,{objective:current.effectiveObjective,successCriteria:current.successCriteria,
        expectedRevision:current.goalRevision,idempotencyKey:`read_condition_${sha256(gateId).slice(0,32)}`,
        reason:`사용자가 원문 읽기 조건을 승인함. gate=${gateId}; actor=${cleanText(decidedBy,120)??'core_admin'}`});
      if(revised.success===false||revised.status!=='applied')return revised.success===false?revised:failure('A_MISSION_READ_CONDITION_REVISION_PENDING','승인된 목표 변경을 저장한 뒤 재개합니다.');
      gate.decision='approve';gate.priorStatus='approved';gate.decidedAt=this.clock().toISOString();
      gate.decidedBy=cleanText(decidedBy,120)??'core_admin';gate.responseText='승인';gate.answers=['승인'];
      gate.answerSemanticVerification='explicit-user-read-permission';gate.executionAuthority=false;
      this.addObservation(mission,{category:'user_clarification',outcome:'success',summary:'사용자가 원문에 지정한 파일 읽기 조건을 승인했습니다. 실행 권한은 기존 정책에서 별도 확인합니다.',
        data:{gateId,originalGoalRevision:current.goalRevision,originalObjectiveSha256:current.objectiveSha256,currentGoalRevision:mission.goalContract.revision,executionAuthorized:false},trustBoundary:'USER_COMMAND',untrusted:false});
      this.touch(mission,'mission-explicit-read-condition-approved');
      this.recordEvent('mission.gate.decided',mission,{gateId,decision:'approve',type:gate.type,decidedBy:gate.decidedBy,conditionOnly:true});
      return this.publicMission(mission);
    }
    const decidedAt = this.clock().toISOString();
    let action = null;
    let approvalRefresh = null;
    if (gate.type === 'action_approval') {
      action = mission.waves.flatMap((wave) => wave.actions).find((item) => item.actionId === gate.actionId);
      if (!action) {
        return failure('A_MISSION_ACTION_NOT_FOUND', 'The action attached to this decision gate was not found.', {
          missionId,
          gateId,
          actionId: gate.actionId
        });
      }
      if (normalizedDecision === 'approve') {
        const task = this.coreFacade.getTask(action.taskId);
        if (!task || task.approvalCard?.approvalId !== gate.approvalCardId) {
          return failure('A_MISSION_GATE_APPROVAL_CARD_MISMATCH', 'The scoped approval card no longer matches this mission gate.', {
            missionId,
            gateId,
            taskId: action.taskId
          });
        }
        approvalRefresh = this.coreFacade.refreshApprovalDeadline?.(action.taskId, {
          at: decidedAt,
          reason: 'mission-gate-approved',
          source: gate.gateId
        });
        if (approvalRefresh?.success !== true) {
          return failure('A_MISSION_GATE_APPROVAL_REFRESH_FAILED', 'The fresh mission approval could not renew the execution window.', {
            missionId,
            gateId,
            taskId: action.taskId,
            reason: approvalRefresh?.reason ?? 'approval-refresh-unavailable'
          });
        }
      }
    }
    gate.decision = normalizedDecision;
    gate.status = normalizedDecision === 'approve' ? 'approved' : 'rejected';
    gate.decidedAt = decidedAt;
    gate.decidedBy = cleanText(decidedBy, 120) ?? 'core_admin';
    gate.responseText = cleanText(responseText, 2000);
    if (gate.type === 'clarification') {
      gate.answers = answerBatch?.answers ?? null;
      gate.answerCoverage = answerBatch?.coverage ?? 'unverified-free-text';
      gate.answerSemanticVerification = 'unverified';
    }
    gate.approvalExpiresAt = approvalRefresh?.expiresAt ?? null;
    if (gate.type === 'action_approval') {
      if (action) {
        if (normalizedDecision === 'approve') {
          action.status = 'planned';
        } else {
          this.coreFacade.cancelTask?.(action.taskId, {
            reason: 'mission-action-rejected',
            source: mission.missionId
          });
          action.status = 'failed';
          mission.metrics.failedActions += 1;
          this.recordActionFailure(mission, action, {
            code: 'A_MISSION_ACTION_REJECTED',
            message: 'User rejected the mission action.'
          });
        }
        action.updatedAt = gate.decidedAt;
      }
    } else if (gate.type === 'clarification') {
      this.addObservation(mission, {
        category: 'user_clarification',
        outcome: normalizedDecision === 'approve' ? 'success' : 'failed',
        summary: gate.responseText ?? (normalizedDecision === 'approve' ? 'User approved continuation.' : 'User rejected continuation.'),
        error: normalizedDecision === 'reject' ? { code: 'A_MISSION_CLARIFICATION_REJECTED' } : null,
        trustBoundary: 'USER_COMMAND',
        untrusted: false
      });
      if (normalizedDecision === 'reject') {
        mission.status = MissionStatus.CANCELLED;
        mission.stopReason = 'clarification-rejected';
      }
    }
    if (!terminalStatuses.has(mission.status)) {
      mission.status = MissionStatus.PAUSED;
      mission.stopReason = normalizedDecision === 'approve' ? 'gate-approved-ready-to-resume' : 'gate-rejected-ready-to-replan';
    }
    this.touch(mission, 'mission-gate-decided');
    this.recordEvent('mission.gate.decided', mission, {
      gateId,
      decision: normalizedDecision,
      type: gate.type,
      decidedBy: gate.decidedBy,
      approvalExpiresAt: gate.approvalExpiresAt
    });
    return this.publicMission(mission);
  }

  reviewCancelledMission(missionId, request) {
    return reviewCancelledMission(this, missionId, request);
  }

  cancelMission(missionId, { reason = 'cancelled-by-user' } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (mission.status === MissionStatus.COMPLETED) {
      return failure('A_MISSION_ALREADY_COMPLETED', 'Completed mission cannot be cancelled.', { missionId });
    }
    mission.status = MissionStatus.CANCELLED;
    mission.stopReason = cleanText(reason, 300) ?? 'cancelled-by-user';
    const cancelledAt = this.clock().toISOString();
    for (const gate of mission.gates.filter((item) => item.status === 'pending')) {
      gate.status = 'cancelled';
      gate.decision = 'cancelled';
      gate.decidedAt = cancelledAt;
      gate.decidedBy = 'mission-runtime';
    }
    for (const action of mission.waves.flatMap((wave) => wave.actions)) {
      if (terminalActionStatuses.has(action.status)) continue;
      this.coreFacade.cancelTask?.(action.taskId, {
        reason: 'mission-cancelled',
        source: mission.missionId
      });
      action.status = 'skipped';
      action.updatedAt = cancelledAt;
    }
    this.touch(mission, 'mission-cancelled');
    this.activeRuns.get(missionId)?.controller?.abort(mission.stopReason);
    this.activeRuns.get(missionId)?.effectController?.abort(mission.stopReason);
    this.recordEvent('mission.cancelled', mission, { reason: mission.stopReason });
    return this.publicMission(mission);
  }

  setManagedAgentSessionBroker(broker) {
    if (!broker || typeof broker.bindSession !== 'function' || typeof broker.sendMissionMessage !== 'function'
      || typeof broker.cancelMissionTurn !== 'function' || typeof broker.reconcileMission !== 'function') {
      return failure('A_MANAGED_AGENT_BROKER_INVALID', 'Managed agent session broker contract is invalid.');
    }
    this.managedAgentSessionBroker = broker;
    return { enabled: true, executionAuthority: false };
  }

  bindManagedAgentSession(missionId, sessionId, { workerRole = null, collaborationGroupId = null } = {}) {
    if (!this.managedAgentSessionBroker) return failure('A_MANAGED_AGENT_DISABLED', 'Managed agent sessions are not configured.', { missionId });
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (terminalStatuses.has(mission.status)) return failure('A_MANAGED_AGENT_MISSION_TERMINAL', 'A managed session cannot be bound to a terminal Mission.', { missionId });
    const role = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!role.valid) return failure('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID', 'Managed agent role assignment is invalid.', { missionId });
    if (role.assignment && this.managedAgentSessionBroker.supportsRoleScopedSessions !== true) {
      return failure('A_MANAGED_AGENT_ROLE_SESSIONS_UNSUPPORTED', 'This managed session broker cannot isolate sessions by role.', { missionId });
    }
    try {
      const binding = this.managedAgentSessionBroker.bindSession({ missionId, sessionId, ...(role.assignment ?? {}) });
      if (role.assignment) {
        const key = `${role.assignment.collaborationGroupId}:${role.assignment.workerRole}`;
        mission.managedAgentSessions = { ...(mission.managedAgentSessions ?? {}), [key]: binding.sessionId };
      } else mission.managedAgentSessionId = binding.sessionId;
      this.touch(mission, 'managed-agent-session-bound');
      this.recordEvent('mission.managed-agent.bound', mission, { sessionId: binding.sessionId, replayed: binding.replayed,
        ...(role.assignment ?? {}) });
      return { ...binding, missionStatus: mission.status, executionAuthority: false };
    } catch (error) {
      return failure(error.code ?? 'A_MANAGED_AGENT_BIND_FAILED', 'Managed agent session could not be bound.', { missionId });
    }
  }

  /** Create an empty remote session through the durable role broker. The
   * provider adapter forbids initial input; callers must bind first, then use
   * sendManagedAgentMessage so first-work data crosses the normal egress gate. */
  async createManagedAgentSession(missionId, { sessionConfig, authorization = null, workerRole = null, collaborationGroupId = null } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (!this.managedAgentSessionBroker) return failure('A_MANAGED_AGENT_DISABLED', 'Managed agent sessions are not configured.', { missionId });
    if (terminalStatuses.has(mission.status)) return failure('A_MANAGED_AGENT_MISSION_TERMINAL', 'A managed session cannot be created for a terminal Mission.', { missionId });
    if (typeof this.managedAgentSessionBroker.provisionSession !== 'function') {
      return failure('A_MANAGED_AGENT_SESSION_PROVISION_UNAVAILABLE', 'Managed session provisioning is unavailable.', { missionId });
    }
    const role = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!role.valid) return failure('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID', 'Managed agent role assignment is invalid.', { missionId });
    if (role.assignment && this.managedAgentSessionBroker.supportsRoleScopedSessions !== true) {
      return failure('A_MANAGED_AGENT_ROLE_SESSIONS_UNSUPPORTED', 'This managed session broker cannot isolate sessions by role.', { missionId });
    }
    // Session creation sends instructions, tool descriptions/schemas and metadata
    // to the remote provider before the first-message egress path is involved.
    // Classify the complete configuration at this boundary and fail closed for
    // D2/M2+ until an exact-config egress approval flow exists.
    let serializedSessionConfig;
    try { serializedSessionConfig = JSON.stringify(sessionConfig); }
    catch { return failure('A_MANAGED_AGENT_SESSION_CONFIG_INVALID', 'Managed session configuration must be serializable.', { missionId }); }
    if (typeof serializedSessionConfig !== 'string') {
      return failure('A_MANAGED_AGENT_SESSION_CONFIG_INVALID', 'Managed session configuration must be serializable.', { missionId });
    }
    let classification;
    try { classification = this.dataClassifier?.classify?.(serializedSessionConfig); }
    catch { return failure('A_MANAGED_AGENT_SESSION_CONFIG_CLASSIFICATION_UNAVAILABLE',
      'Session configuration could not be safely classified for remote transfer.', { missionId }); }
    const dataRank = /^D[0-4]$/u.test(classification?.dataClass ?? '') ? Number(classification.dataClass[1]) : null;
    const ministryRank = /^M[0-4]$/u.test(classification?.ministryDataClass ?? '') ? Number(classification.ministryDataClass[1]) : null;
    if (dataRank === null || ministryRank === null) {
      return failure('A_MANAGED_AGENT_SESSION_CONFIG_CLASSIFICATION_UNAVAILABLE',
        'Session configuration could not be safely classified for remote transfer.', { missionId });
    }
    if (dataRank >= 2 || ministryRank >= 2) {
      return failure('A_MANAGED_AGENT_SESSION_CONFIG_EGRESS_BLOCKED',
        'Session configuration contains material that requires an exact-scope external-transfer approval, which this session-create path does not support.',
        { missionId, dataClass: classification.dataClass, ministryDataClass: classification.ministryDataClass,
          sensitiveFlags: classification.sensitiveFlags ?? [] });
    }
    try {
      const result = await this.managedAgentSessionBroker.provisionSession({ missionId, sessionConfig, authorization,
        ...(role.assignment ?? {}) });
      if (result?.status === 'bound' && typeof result.sessionId === 'string') {
        if (role.assignment) {
          const key = `${role.assignment.collaborationGroupId}:${role.assignment.workerRole}`;
          mission.managedAgentSessions = { ...(mission.managedAgentSessions ?? {}), [key]: result.sessionId };
        } else mission.managedAgentSessionId = result.sessionId;
        this.touch(mission, 'managed-agent-session-provisioned');
        this.recordEvent('mission.managed-agent.provisioned', mission, { provisioningId: result.provisioningId,
          sessionId: result.sessionId, replayed: result.replayed === true, ...(role.assignment ?? {}) });
      }
      return { ...result, missionStatus: mission.status, ...(result?.status === 'blocked' ? { taskVerified: false } : {}), executionAuthority: false };
    } catch (error) {
      return failure(error.code ?? 'A_MANAGED_AGENT_SESSION_PROVISION_FAILED', 'Managed agent session could not be provisioned.', { missionId });
    }
  }

  /** Recover an ambiguous provider create without issuing another create. */
  async reconcileManagedAgentSessionProvision(missionId, { workerRole = null, collaborationGroupId = null, maxPages = 5 } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (!this.managedAgentSessionBroker) return failure('A_MANAGED_AGENT_DISABLED', 'Managed agent sessions are not configured.', { missionId });
    if (terminalStatuses.has(mission.status)) return failure('A_MANAGED_AGENT_MISSION_TERMINAL', 'A managed session cannot be recovered for a terminal Mission.', { missionId });
    if (typeof this.managedAgentSessionBroker.reconcileSessionProvision !== 'function') {
      return failure('A_MANAGED_AGENT_SESSION_PROVISION_RECONCILE_UNAVAILABLE', 'Managed session provisioning recovery is unavailable.', { missionId });
    }
    const role = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!role.valid) return failure('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID', 'Managed agent role assignment is invalid.', { missionId });
    if (role.assignment && this.managedAgentSessionBroker.supportsRoleScopedSessions !== true) {
      return failure('A_MANAGED_AGENT_ROLE_SESSIONS_UNSUPPORTED', 'This managed session broker cannot isolate sessions by role.', { missionId });
    }
    try {
      const result = await this.managedAgentSessionBroker.reconcileSessionProvision({ missionId, maxPages, ...(role.assignment ?? {}) });
      if (result?.status === 'bound' && typeof result.sessionId === 'string') {
        if (role.assignment) {
          const key = `${role.assignment.collaborationGroupId}:${role.assignment.workerRole}`;
          mission.managedAgentSessions = { ...(mission.managedAgentSessions ?? {}), [key]: result.sessionId };
        } else mission.managedAgentSessionId = result.sessionId;
        this.touch(mission, 'managed-agent-session-provision-reconciled');
        this.recordEvent('mission.managed-agent.provision-reconciled', mission, { provisioningId: result.provisioningId,
          sessionId: result.sessionId, ...(role.assignment ?? {}) });
      }
      return { ...result, missionStatus: mission.status, ...(result?.status === 'blocked' ? { taskVerified: false } : {}), executionAuthority: false };
    } catch (error) {
      return failure(error.code ?? 'A_MANAGED_AGENT_SESSION_PROVISION_RECONCILE_FAILED', 'Managed session provisioning could not be reconciled.', { missionId });
    }
  }

  async sendManagedAgentMessage(missionId, { messageId, text, workerRole = null, collaborationGroupId = null,
    messageAuthorization = null } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (!this.managedAgentSessionBroker) return failure('A_MANAGED_AGENT_DISABLED', 'Managed agent sessions are not configured.', { missionId });
    if (terminalStatuses.has(mission.status)) return failure('A_MANAGED_AGENT_MISSION_TERMINAL', 'Messages cannot be added to a terminal Mission.', { missionId });
    const role = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!role.valid) return failure('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID', 'Managed agent role assignment is invalid.', { missionId });
    if (role.assignment && this.managedAgentSessionBroker.supportsRoleScopedSessions !== true) {
      return failure('A_MANAGED_AGENT_ROLE_SESSIONS_UNSUPPORTED', 'This managed session broker cannot isolate sessions by role.', { missionId });
    }
    try {
      const result = await this.managedAgentSessionBroker.sendMissionMessage({ missionId, messageId, text,
        ...(role.assignment ?? {}), ...(messageAuthorization ? { messageAuthorization } : {}) });
      if (result.accepted) this.recordEvent('mission.managed-agent.message-accepted', mission, { messageId, eventId: result.eventId,
        providerStatus: result.providerStatus, ...(role.assignment ?? {}) });
      return { ...result, missionStatus: mission.status, taskVerified: false, executionAuthority: false };
    } catch (error) {
      return failure(error.code ?? 'A_MANAGED_AGENT_MESSAGE_FAILED', 'Managed agent message was not confirmed as accepted.', { missionId, messageId });
    }
  }

  async cancelManagedAgentTurn(missionId, cancellationId, { workerRole = null, collaborationGroupId = null } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (!this.managedAgentSessionBroker) return failure('A_MANAGED_AGENT_DISABLED', 'Managed agent sessions are not configured.', { missionId });
    if (terminalStatuses.has(mission.status)) return failure('A_MANAGED_AGENT_MISSION_TERMINAL', 'A remote turn cannot be cancelled through a terminal Mission.', { missionId });
    const role = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!role.valid) return failure('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID', 'Managed agent role assignment is invalid.', { missionId });
    if (role.assignment && this.managedAgentSessionBroker.supportsRoleScopedSessions !== true) {
      return failure('A_MANAGED_AGENT_ROLE_SESSIONS_UNSUPPORTED', 'This managed session broker cannot isolate sessions by role.', { missionId });
    }
    try {
      const result = await this.managedAgentSessionBroker.cancelMissionTurn({ missionId, cancellationId, ...(role.assignment ?? {}) });
      if (result.accepted) this.recordEvent('mission.managed-agent.cancel-accepted', mission, { cancellationId, eventId: result.eventId,
        providerStatus: result.providerStatus, ...(role.assignment ?? {}) });
      return { ...result, missionStatus: mission.status, taskVerified: false, executionAuthority: false };
    } catch (error) {
      return failure(error.code ?? 'A_MANAGED_AGENT_CANCEL_FAILED', 'Remote turn cancellation was not confirmed as accepted.', { missionId, cancellationId });
    }
  }

  async reconcileManagedAgentSession(missionId, roleAssignment = null) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (!this.managedAgentSessionBroker) return failure('A_MANAGED_AGENT_DISABLED', 'Managed agent sessions are not configured.', { missionId });
    if (terminalStatuses.has(mission.status)) return failure('A_MANAGED_AGENT_MISSION_TERMINAL', 'A managed session cannot reconcile a terminal Mission.', { missionId });
    const role = normalizeMissionRoleAssignment(roleAssignment ?? {});
    if (!role.valid) return failure('A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID', 'Managed agent role assignment is invalid.', { missionId });
    if (role.assignment && this.managedAgentSessionBroker.supportsRoleScopedSessions !== true) {
      return failure('A_MANAGED_AGENT_ROLE_SESSIONS_UNSUPPORTED', 'This managed session broker cannot isolate sessions by role.', { missionId });
    }
    try {
      const result = await this.managedAgentSessionBroker.reconcileMission(missionId, role.assignment);
      if (role.assignment && result.remoteStatus === 'failed') {
        if (this.activeRuns.has(missionId)) return failure('A_MANAGED_AGENT_FAILURE_RECONCILE_DURING_ACTIVE_MISSION',
          'The failed role was observed while the Mission was active; reconcile again after the active run settles.', { missionId });
        const handoffPermitted = result.outcomes.every(outcome => outcome?.verified === true);
        const failureRecord = {
          workerRole: role.assignment.workerRole,
          collaborationGroupId: role.assignment.collaborationGroupId,
          sessionId: result.sessionId,
          observedAt: this.clock().toISOString(),
          handoffPermitted,
          reason: handoffPermitted ? 'provider-session-failed-after-verified-work' : 'provider-session-failed-with-unverified-outcome'
        };
        mission.managedAgentWorkerFailures = [...(mission.managedAgentWorkerFailures ?? [])
          .filter(item => item.workerRole !== failureRecord.workerRole
            || item.collaborationGroupId !== failureRecord.collaborationGroupId), failureRecord].slice(-16);
        mission.status = MissionStatus.PAUSED;
        mission.stopReason = handoffPermitted ? 'managed-agent-worker-failed' : 'managed-agent-worker-result-uncertain';
        mission.lastError = {
          code: handoffPermitted ? 'A_MANAGED_AGENT_WORKER_FAILED' : 'A_MANAGED_AGENT_WORKER_RESULT_UNCERTAIN',
          workerRole: failureRecord.workerRole,
          collaborationGroupId: failureRecord.collaborationGroupId,
          nextAction: handoffPermitted ? 'Replan with another role using only G-verified artifacts.'
            : 'Resolve the uncertain tool outcome before replanning or handing off.'
        };
        this.addObservation(mission, {
          category: 'managed_agent_worker', outcome: 'failed',
          summary: handoffPermitted
            ? '역할 작업자가 실패했습니다. 기존 G 검증 산출물만 다른 역할에 전달할 수 있습니다.'
            : '역할 작업자가 실패했고 미검증 도구 결과가 남아 있어 인계를 보류했습니다.',
          data: { workerRole: failureRecord.workerRole, collaborationGroupId: failureRecord.collaborationGroupId,
            disposition: handoffPermitted ? 'handoff-permitted-from-verified-artifacts' : 'handoff-blocked-uncertain-result' },
          recovery: { status: handoffPermitted ? 'replan-allowed' : 'reconciliation-required',
            nextAction: mission.lastError.nextAction },
          trustBoundary: 'SYSTEM_RESULT', untrusted: false
        });
        this.touch(mission, 'managed-agent-worker-failed');
        this.recordEvent('mission.managed-agent.worker-failed', mission, {
          workerRole: failureRecord.workerRole,
          collaborationGroupId: failureRecord.collaborationGroupId,
          handoffPermitted,
          outcomeCount: result.outcomes.length
        });
        return { ...result, handoffPermitted, missionStatus: mission.status, taskVerified: false, executionAuthority: false };
      }
      this.recordEvent('mission.managed-agent.reconciled', mission, { sessionId: result.sessionId,
        remoteStatus: result.remoteStatus, outcomeCount: result.outcomes.length, ...(role.assignment ?? {}) });
      return { ...result, missionStatus: mission.status, taskVerified: false, executionAuthority: false };
    } catch (error) {
      return failure(error.code ?? 'A_MANAGED_AGENT_RECONCILE_FAILED', 'Managed session could not be reconciled.', { missionId });
    }
  }

  updateMission(missionId, { budgets = null, authorization = null } = {}) {
    const mission = this.missions.get(missionId);
    if (!mission) return failure('A_MISSION_NOT_FOUND', 'Mission was not found.', { missionId });
    if (budgets) mission.budgets = normalizeBudgets({ ...mission.budgets, ...budgets });
    let authorizationChanged = false;
    if (authorization) {
      const previousAuthorization = mission.authorization;
      const nextAuthorization = normalizeAuthorization({ ...previousAuthorization, ...authorization });
      authorizationChanged = previousAuthorization.mode !== nextAuthorization.mode
        || previousAuthorization.ownerSessionId !== nextAuthorization.ownerSessionId
        || JSON.stringify(previousAuthorization.grants) !== JSON.stringify(nextAuthorization.grants);
      mission.authorization = nextAuthorization;
      if (authorizationChanged) mission.authorizationRevision = (mission.authorizationRevision ?? 1) + 1;
    }
    if (mission.status === MissionStatus.PAUSED) mission.stopReason = 'mission-settings-updated';
    this.touch(mission, 'mission-settings-updated');
    this.recordEvent('mission.settings.updated', mission, {
      budgetsUpdated: Boolean(budgets),
      authorizationUpdated: Boolean(authorization),
      authorizationChanged,
      authorizationRevision: mission.authorizationRevision ?? 1,
      grants: mission.authorization.grants
    });
    return this.publicMission(mission);
  }

  async validateCompletionWithRemoteEvidence(mission, assessments) {
    const checks=new Map();
    const verifyRemote=this.effectCoordinator.createRemoteCriterionValidator();
    for(const criterion of mission.successCriteria){
      const assessment=assessments.find(item=>item.criterionId===criterion.criterionId);
      if(assessment?.status!=='satisfied'||!criterion.verificationSpec)continue;
      const ids=assessment.evidenceActionIds??[];
      const actions=mission.waves.flatMap(wave=>wave.actions).filter(action=>ids.includes(action.actionId)&&action.status==='succeeded');
      for(const action of actions){
        const snapshot=remoteArtifactDigest({criterion,ids,actions,goalContract:mission.goalContract});
        const result=await verifyRemote(criterion,action,actions);
        if(!result)continue;
        const unchanged=snapshot===remoteArtifactDigest({criterion,ids,actions,goalContract:mission.goalContract});
        checks.set(criterion.criterionId,{binding:remoteArtifactDigest({criterion,ids}),result:unchanged?result:
          {passed:false,status:'unverified',reasons:['remote-criterion-changed-during-observation'],checks:[]}});
        break;
      }
    }
    // Private, in-process, single validation scope. Persisted/JSON results never
    // grant completion; every new completion attempt re-observes the PC.
    this.#remoteCompletionChecks.set(mission,checks);
    try{
      const completion=this.validateCompletion(mission,assessments);
      if(completion.valid)this.#pendingCompletionChecks.set(completion,{mission,checks});
      return completion;
    }
    finally{this.#remoteCompletionChecks.delete(mission);}
  }

  validateCompletion(mission, assessments) {
    const revisionIssue = this.goalRevisions.completionIssue(mission);
    if (revisionIssue) return { valid: false, reasons: [revisionIssue.error.code], criteria: [], goalCoverage: { allowed: false } };
    const successfulActionIds = new Set(mission.waves
      .flatMap((wave) => wave.actions)
      .filter((action) => action.status === 'succeeded')
      .map((action) => action.actionId));
    const assessmentByCriterion = new Map(assessments.map((assessment) => [assessment.criterionId, assessment]));
    const reasons = [];
    const selectedProof=mission.microsoftCollection?collectMicrosoftCollectionResult(mission,this.microsoftCollectionDependencies(mission)):mission.lifecycleCase?collectLifecycleCaseResult(mission,this.lifecycleCaseDependencies(mission)):mission.selectedSource?collectSelectedSourceResult(mission,this.selectedSourceDependencies(mission)):null;
    const goalCoverage = selectedProof?{version:'a-mission-goal-completion-coverage-v1',required:true,allowed:selectedProof.passed,
      reasons:selectedProof.reasons.map(code=>({code})),coveredRequirementIds:selectedProof.passed?mission.goalContract.requirements.map(r=>r.requirementId):[],
      sourceBindingVerified:selectedProof.passed,semanticAccuracyVerified:false,executionAuthority:false}:assessMissionGoalCompletionCoverage({ mission, allowedRoots: this.allowedRoots,
      beforeTextRead:action=>this.executionBudget?.beforeAction(mission,{packet:{action},workspaceRoot:this.allowedRoots[0]}),
      installedIntentBindingResolver:toolName=>this.pcAgent.registry?.contractFor?.(toolName)?.intentBinding??null });
    mission.goalCompletionCoverage = goalCoverage;
    reasons.push(...goalCoverage.reasons.map(item => `goal:${item.code}${item.requirementId ? `:${item.requirementId}` : ''}`));
    const normalized = [];
    if (successfulActionIds.size === 0) reasons.push('no-successful-actions');
    for (const criterion of mission.successCriteria) {
      const assessment = assessmentByCriterion.get(criterion.criterionId);
      const evidenceActionIds = assessment?.evidenceActionIds ?? [];
      const validEvidence = evidenceActionIds.filter((actionId) => successfulActionIds.has(actionId));
      if (assessment?.status !== 'satisfied') reasons.push(`${criterion.criterionId}:not-satisfied`);
      if (validEvidence.length === 0) reasons.push(`${criterion.criterionId}:verified-evidence-missing`);
      const deterministicChecks = this.verifyCriterionEvidence(mission, criterion, validEvidence);
      reasons.push(...deterministicChecks.reasons.map((reason) => `${criterion.criterionId}:${reason}`));
      normalized.push({
        criterionId: criterion.criterionId,
        ...(criterion.requirementId ? { requirementId: criterion.requirementId } : {}),
        statement: criterion.statement,
        status: assessment?.status === 'satisfied' && validEvidence.length > 0 && deterministicChecks.passed
          ? 'satisfied'
          : 'unsatisfied',
        evidenceActionIds: validEvidence,
        reason: assessment?.reason ?? null,
        verificationStatus: deterministicChecks.status ?? (deterministicChecks.passed ? 'passed' : 'failed'),
        verificationReasons: deterministicChecks.reasons,
        deterministicChecks: deterministicChecks.checks
      });
    }
    if (this.pendingGates(mission).length > 0) reasons.push('pending-decision-gates');
    if (this.uncertainEffectCount(mission) > 0) reasons.push('uncertain-effects');
    mission.verificationSummary = criterionVerificationSummary(normalized.map(item => ({ ...item,
      status: item.verificationStatus, checks: item.deterministicChecks, reasons: item.verificationReasons
    })));
    return { valid: reasons.length === 0, reasons, criteria: normalized, goalCoverage };
  }

  tryCompleteFromDeterministicEvidence(mission) {
    if (this.pendingGates(mission).length > 0) return false;
    const successfulActionIds = mission.waves
      .flatMap((wave) => wave.actions)
      .filter((action) => action.status === 'succeeded')
      .map((action) => action.actionId);
    if (successfulActionIds.length === 0) return false;
    const assessments = [];
    let hasConcreteMissionEvidence = false;
    for (const criterion of mission.successCriteria) {
      const evidence = this.verifyCriterionEvidence(mission, criterion, successfulActionIds);
      // Every criterion needs a machine check, and the mission as a whole needs at least
      // one concrete artifact/observation/commit check. This permits a separate G-only
      // criterion while preventing a generic G statement from proving the whole mission.
      if (evidence.checks.length === 0 || !evidence.passed) return false;
      if (evidence.checks.some((check) => check.checkId !== 'g_verification_passed')) {
        hasConcreteMissionEvidence = true;
      }
      assessments.push({
        criterionId: criterion.criterionId,
        status: 'satisfied',
        evidenceActionIds: successfulActionIds,
        reason: 'Satisfied by deterministic execution and G-verification evidence.'
      });
    }
    if (!hasConcreteMissionEvidence) return false;
    const completion = this.validateCompletion(mission, assessments);
    if (!completion.valid) return false;
    completion.source = 'deterministic-evidence';
    return this.completeMission(mission, completion);
  }

  verifyCriterionEvidence(mission, criterion, evidenceActionIds) {
    const macroActions=(mission.waves??[]).flatMap(w=>w.actions).filter(a=>(a.actualToolName??a.expectedToolName)==='macro.save');
    if(macroActions.length){
      try{
        const action=macroActions[0],effect=this.effectCoordinator?.effect(action),prepared=effect?.intent?.request?.macroPublication;
        const registered=this.pcAgent.registry?.get('macro.save')?.store?.path;
        if(criterion.statement!==mission.objective||criterion.verificationSpec||macroActions.length!==1||effect.state!=='succeeded'
          ||!evidenceActionIds.includes(action.actionId)||prepared.rawText!==mission.objective.trim()
          ||effect.intent.request.taskId!==action.taskId||resolve(registered??'.')!==prepared.path
          ||!mission.observations.some(o=>o.actionId===action.actionId&&o.outcome==='success'&&o.verification?.status==='passed'&&!o.verification.failedCheckIds?.length))throw Error('macro-evidence-unverified');
        const observed=new MacroStore({path:registered}).inspectPublication(prepared);
        return {passed:true,status:'verified',reasons:[],checks:[{checkId:'macro_original_current_store',passed:true,sha256:observed.sha256}]};
      }catch{return {passed:false,status:'unverified',reasons:['macro-original-current-store-unverified'],checks:[]};}
    }
    // A borrowed local verifier has no private remote completion authority.
    const remote=(#remoteCompletionChecks in this)?this.#remoteCompletionChecks.get(mission)?.get(criterion.criterionId):undefined;
    if(remote&&remote.binding===remoteArtifactDigest({criterion,ids:evidenceActionIds})){
      try{remote.result.revalidate?.();const {revalidate,...result}=remote.result;return result;}
      catch{return {passed:false,status:'unverified',reasons:['remote-criterion-observation-invalidated'],checks:[]};}
    }
    // Remote SQL effects require a fresh PC observation even when this Core
    // happens to see the same file. A synchronous local read cannot substitute
    // for the private, single-attempt remote completion proof above.
    if(['text.equals','file.exists','json.value','csv.rows','xlsx.cells','xlsx.charts','pdf.text','xlsx.pdfRowText','artifact.consistency','research.sourceTrace','image.cardLayout','presentation.contentLayout','document.tables','document.paragraphs'].includes(criterion.verificationSpec?.kind)
      &&mission.waves?.flatMap(wave=>wave.actions).some(action=>evidenceActionIds.includes(action.actionId)
        &&this.effectCoordinator?.effect(action)?.intent?.request?.remoteArtifactIntent)){
      return {passed:false,status:'unverified',reasons:['remote-current-observation-required'],checks:[]};
    }
    const mcpCriterion=verifyMcpMissionCriterion({mission,criterion,evidenceActionIds,pcAgent:this.pcAgent,packageRegistry:this.capabilityPackageRegistry,coreFacade:this.coreFacade});
    if(mcpCriterion.applicable)return mcpCriterion;
    if(mission.microsoftCollection){
      const proof=collectMicrosoftCollectionResult(mission,this.microsoftCollectionDependencies(mission));
      const matched=criterion.statement===mission.objective&&proof.evidenceActionIds?.every(id=>evidenceActionIds.includes(id));
      return {passed:proof.passed&&matched,status:proof.passed&&matched?'passed':'unverified',reasons:matched?proof.reasons:['microsoft-collection-criterion-unbound'],checks:matched?proof.checks:[]};
    }
    if(mission.lifecycleCase){
      const proof=collectLifecycleCaseResult(mission,this.lifecycleCaseDependencies(mission));
      const matched=criterion.statement===mission.objective&&proof.evidenceActionIds?.every(id=>evidenceActionIds.includes(id));
      return {passed:proof.passed&&matched,status:proof.passed&&matched?'passed':'unverified',reasons:matched?proof.reasons:['lifecycle-case-criterion-unbound'],checks:matched?proof.checks:[]};
    }
    if(mission.selectedSource){
      const proof=collectSelectedSourceResult(mission,this.selectedSourceDependencies(mission));
      const matched=criterion.statement===mission.objective&&proof.evidenceActionIds?.every(id=>evidenceActionIds.includes(id));
      return {passed:proof.passed&&matched,status:proof.passed&&matched?'passed':'unverified',
        reasons:matched?proof.reasons:['selected-source-criterion-unbound'],checks:matched?proof.checks:[]};
    }
    const listingProof=verifyReadOnlyListing({mission,allowedRoots:this.allowedRoots ?? [],evidenceActionIds,statement:criterion.statement});
    if(listingProof.applicable)return listingProof;
    const textReadProof=criterion.verificationSpec?{applicable:false}:verifyReadOnlyText({mission,allowedRoots:this.allowedRoots??[],evidenceActionIds,statement:criterion.statement,
      beforeRead:action=>this.executionBudget?.beforeAction(mission,{packet:{action},workspaceRoot:this.allowedRoots[0]})});
    if(textReadProof.applicable)return textReadProof;
    const observations = mission.observations.filter((observation) => evidenceActionIds.includes(observation.actionId));
    const remoteQuantity=missionSourceQuantity(mission)&&criterion.statement===mission.objective&&mission.waves.flatMap(w=>w.actions).some(action=>evidenceActionIds.includes(action.actionId)&&this.effectCoordinator?.effect(action)?.intent?.request?.remoteArtifactIntent);
    if(remoteQuantity)return {passed:false,status:'unverified',reasons:['source-quantity-remote-observation-required'],checks:[]};
    const sourceQuantity=verifyMissionSourceQuantity({mission,criterion,observations,evidenceActionIds,allowedRoots:this.allowedRoots??[],beforeAccess:this.resultReadGuard(mission)});
    if(sourceQuantity.applicable){
      return sourceQuantity;
    }
    const preparedFinancial=verifyOfxSaveMission({mission,prepared:mission.ofxSave,allowedRoots:this.allowedRoots??[],observations,statement:criterion.statement,beforeAccess:this.resultReadGuard(mission)});
    if(preparedFinancial.applicable)return preparedFinancial;
    const fieldSummary=verifyFieldSummaryResult({objective:mission.objective,statement:criterion.statement,observations,allowedRoots:this.allowedRoots??[],beforeAccess:this.resultReadGuard(mission)});
    if(fieldSummary.applicable)return fieldSummary;
    const financialReport=verifyFinancialReportResult({objective:mission.objective,statement:criterion.statement,observations,allowedRoots:this.allowedRoots??[],beforeAccess:this.resultReadGuard(mission)});
    if(financialReport.applicable)return financialReport;
    const healthReport=verifyHealthReportResult({objective:mission.objective,statement:criterion.statement,observations,allowedRoots:this.allowedRoots??[],beforeAccess:this.resultReadGuard(mission)});
    if(healthReport.applicable)return healthReport;
    const theologyReview=verifyTheologyReviewResult({objective:mission.objective,statement:criterion.statement,observations,allowedRoots:this.allowedRoots??[],beforeAccess:this.resultReadGuard(mission)});
    if(theologyReview.applicable)return theologyReview;
    const safetySimulation = verifySafetySimulationResult({ objective: mission.objective, statement: criterion.statement, observations,
      allowedRoots: this.allowedRoots ?? [], beforeAccess: this.resultReadGuard(mission) });
    if (safetySimulation.applicable) return safetySimulation;
    const sourceOutcome = verifySourceOutcome({ objective: mission.objective, statement: criterion.statement,
      observations, allowedRoots: this.allowedRoots ?? [], prepared: this.sourceOutcomePreparations?.get(mission.missionId) ?? null });
    if (sourceOutcome.status === 'passed') return { passed: true, status: 'passed', reasons: [],
      checks: [{ checkId: 'independent-source-outcome-oracle', passed: true, ...sourceOutcome }] };
    if (/^직접 제공된 게시자 HTTPS 기사 본문이 실제로 추출되어 검증된다\.$/u.test(String(criterion.statement ?? ''))) {
      const articleObservation = observations.find(item => item.toolName === 'news.fetchArticle'
        && item.outcome === 'success' && item.verification?.status === 'passed');
      const article = articleObservation?.data?.article;
      let digestMatches = false;
      if (article?.live === true && typeof article.text === 'string' && article.text.length > 160
        && article.text.length <= 12_000 && /^[a-f0-9]{64}$/u.test(article.textSha256 ?? '')) {
        digestMatches = createHash('sha256').update(article.text, 'utf8').digest('hex') === article.textSha256;
      }
      let securePublisherUrl = false;
      try {
        const url = new URL(article?.finalUrl);
        securePublisherUrl = url.protocol === 'https:' && !url.username && !url.password
          && url.hostname === article?.finalHost;
      } catch { /* missing or malformed observed final URL remains unverified */ }
      const action = (mission.waves ?? []).flatMap(wave => wave.actions ?? [])
        .find(item => item.actionId === articleObservation?.actionId);
      let requestedUrlBound = false;
      try {
        const requestedUrl = new URL(action?.arguments?.url);
        const observedRequestedUrl = new URL(article?.requestedUrl);
        requestedUrlBound = requestedUrl.href === observedRequestedUrl.href
          && requestedUrl.protocol === 'https:' && !requestedUrl.username && !requestedUrl.password;
      } catch { /* no trusted action URL binding remains unverified */ }
      const passed = Boolean(articleObservation && article?.textIsUntrustedSourceMaterial === true
        && securePublisherUrl && requestedUrlBound && digestMatches && Number.isSafeInteger(article.textCharacters)
        && article.textCharacters === article.text.length);
      return { passed, status: passed ? 'passed' : 'unverified',
        reasons: passed ? [] : ['verified-live-article-evidence-incomplete'],
        checks: [{ checkId: 'verified-live-article-body-evidence', passed,
          observationActionId: articleObservation?.actionId ?? null, securePublisherUrl,
          requestedUrlBound,
          digestMatches, untrustedSourceMarked: article?.textIsUntrustedSourceMaterial === true,
          textCharacters: article?.textCharacters ?? null }] };
    }
    if (criterion.verificationSpec) return verifyTypedCriterion({ criterion, observations,
      evidenceActionIds, allowedRoots: this.allowedRoots ?? [],actions:(mission.waves??[]).flatMap(wave=>wave.actions??[]),beforeAccess:this.resultReadGuard(mission) });
    const checks = [];
    const statement = String(criterion.statement ?? '');
    const listingClause = /(?:목록|리스트|폴더를\s*점검)/u.test(statement)
      && !statement.replace(/API로|작업|현재|허용된|루트|폴더|파일|조회|검색|결과|목록|리스트|확인한다|확인해줘|보여줘|검증해줘|검증한다|점검한다|확인|G|검증|통과한다|그리고|하고|읽기|전용으로|실제|정상적으로|에서|으로|를|을|가|이|의|만|내|[\s.!]/gu, '');
    if (listingClause) {
      checks.push({ checkId: 'verified_file_listing_present', passed: observations.some(observation =>
        ['filesystem.listFiles', 'filesystem.searchFiles'].includes(observation.toolName)
        && observation.outcome === 'success' && observation.verification?.status === 'passed'
        && (Array.isArray(observation.data?.items) || Array.isArray(observation.data?.matches))) });
    }
    if (/^(?:승인\s*후\s*)?(?:결과\s*)?파일(?:을)?\s*(?:생성하라|생성한다|만들어줘)[.!\s]*$/u.test(statement)) {
      checks.push({ checkId: 'verified_file_creation_present', passed: observations.some(observation =>
        observation.outcome === 'success' && observation.verification?.status === 'passed'
        && observation.artifacts?.some(artifact => artifact.outsideAllowedRoots === false && artifact.contentSha256)) });
    }
    const references = [...statement.matchAll(/(?:(?:[A-Za-z]:[\\/]|\\\\|\/)?(?:[A-Za-z0-9가-힣_.-]+[\\/])*)([A-Za-z0-9가-힣_.-]+\.(?:txt|csv|xlsx|xls|docx|pdf|pptx|ppt|hwpx|hwp|json|md|html?|png|zip))(?![A-Za-z0-9])/giu)];
    const readStatement = statement.replace(/["'“‘]?(?:(?:[A-Za-z]:[\\/]|\\\\|\/)?(?:[A-Za-z0-9가-힣_.-]+[\\/])*)[A-Za-z0-9가-힣_.-]+\.(?:txt|csv|json|md)(?![A-Za-z0-9])["'”’]?/giu, 'FILE');
    if (/^FILE(?:\s*(?:와|과|및|[,·])\s*FILE)*\s*(?:파일)?(?:을|를)\s*(?:읽는다|읽어줘|읽어라)[.!\s]*$/u.test(readStatement)) {
      const readNames = observations.filter(observation => observation.outcome === 'success'
        && observation.verification?.status === 'passed' && observation.toolName === 'filesystem.readText')
        .flatMap(observation => {
          const action = (mission.waves ?? []).flatMap(wave => wave.actions ?? []).find(item => item.actionId === observation.actionId);
          return action?.arguments?.path ? [basename(action.arguments.path).toLowerCase()] : [];
        });
      checks.push({ checkId: 'verified_file_reads_present', passed: references.length > 0
        && references.every(match => readNames.includes(match[1].toLowerCase())), expected: references.map(match => match[1]), observed: readNames });
    }
    const readModifier = '(?:(?:UTF-?8|인코딩)\\s*(?:으로|로)?|모두|각각|전부|함께|먼저|다시|차례로|순서대로|동시에|하나씩|직접|정확히)';
    const readPrelude = '(?:찾아(?:서)?|검색(?:해|해서)|열(?:어|어서|고)|확인(?:해|해서))';
    const directReadRole = new RegExp(`^(?:["'”’])?\\s*(?:(?:파일\\s*)?(?:를|을))\\s*(?:${readModifier}\\s*)*(?:${readPrelude}\\s*)?(?:${readModifier}\\s*)*(?:내용(?:을)?\\s*)?(?:읽|근거)`, 'iu');
    const typedNamedReadRole = /^(?:["'”’])?\s*(?:JSON|CSV|텍스트)(?:를|을)\s*["'“‘][^"'”’\r\n]+["'”’](?:으로|로)\s*읽/iu;
    const joinedUnnamedReadRole = new RegExp(`^(?:와|과|및)\\s+[^.\\n]{0,80}(?:를|을)\\s*(?:${readModifier}\\s*)*(?:${readPrelude}\\s*)?(?:${readModifier}\\s*)*읽`, 'iu');
    const isDirectInputRole = (suffix) => directReadRole.test(suffix)
      || typedNamedReadRole.test(suffix)
      || joinedUnnamedReadRole.test(suffix)
      || /^(?:["'”’])?\s*(?:에서|의\s*중복)/iu.test(suffix);
    const inputReferenceIndexes = new Set();
    references.forEach((match, index) => {
      const suffix = statement.slice(match.index + match[0].length, references[index + 1]?.index ?? statement.length);
      if (!isDirectInputRole(suffix)) return;
      inputReferenceIndexes.add(index);
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const connector = statement.slice(
          references[previous].index + references[previous][0].length,
          references[previous + 1].index
        );
        if (!/^\s*(?:(?:와|과|및|그리고)|[,·/])\s*$/u.test(connector)) break;
        inputReferenceIndexes.add(previous);
      }
    });
    const negativeAbsence = /(?:생성|작성|저장|만들)[^.\n]{0,12}(?:않|말)|실제로\s*(?:존재하지\s*않|없)|미존재|부재|남아\s*있지\s*않|존재하지\s*않/iu;
    const absentReferenceIndexes = new Set();
    references.forEach((match, index) => {
      const suffix = statement.slice(match.index + match[0].length, references[index + 1]?.index ?? statement.length);
      if (!negativeAbsence.test(suffix.split(/[.\n]/u, 1)[0])) return;
      absentReferenceIndexes.add(index);
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const connector = statement.slice(references[previous].index + references[previous][0].length, references[previous + 1].index);
        if (!/^\s*(?:(?:와|과|및|그리고)|[,·/])\s*$/u.test(connector)) break;
        absentReferenceIndexes.add(previous);
      }
    });
    if (/(?:원본|입력|자료|근거)[^.\n]{0,30}(?:없으면|없을\s*경우|누락)/u.test(statement)) {
      const inputs=references.filter((match,index)=>inputReferenceIndexes.has(index)).map(match=>match[1].toLowerCase());
      const observedNames=observations.flatMap(o=>[...(o.data?.items??[]),...(o.data?.matches??[])]).map(item=>String(item.name??'').toLowerCase());
      const readInputs=observations.filter(o=>['shell.execute','filesystem.readText'].includes(o.toolName) && o.data?.stdoutPreview && o.verification?.status==='passed').flatMap(o=>{
        const action=(mission.waves??[]).flatMap(wave=>wave.actions).find(action=>action.actionId===o.actionId);
        const command=String(action?.arguments?.command??action?.arguments?.path??'');
        return o.toolName === 'filesystem.readText' || /Get-Content\b/i.test(command) ? inputs.filter(name=>command.toLowerCase().includes(name)) : [];
      });
      if(inputs.length) checks.push({checkId:'required_input_evidence_present',passed:inputs.every(name=>observedNames.includes(name)||readInputs.includes(name)),expected:inputs,observed:[...observedNames,...readInputs]});
    }
    // This check proves named outputs, not every filename mentioned in prose.
    // Explicit read inputs, preserved sources, and exclusions are not new outputs.
    // Unrecognized roles stay required; a mere listing still cannot prove a write.
    const namedFiles = references.filter((match, index) => {
      const suffix = statement.slice(match.index + match[0].length, references[index + 1]?.index ?? statement.length);
      return !inputReferenceIndexes.has(index) && !absentReferenceIndexes.has(index)
        && !/^(?:["'”’])?\s*(?:(?:를|을)[^.\n]*옮|(?:는|은)\s*(?:그대로\s*)?(?:보존|유지)(?:하고|한다|해|됨|된다|되어)|(?:는|은)[^.\n]*(?:덮어쓰지|넣지))/iu.test(suffix);
    }).map((match) => match[1].toLowerCase());
    if (namedFiles.length > 0) {
      const producedArtifactNames = observations
        .flatMap((observation) => observation.artifacts ?? [])
        .filter(Boolean)
        .map((artifact) => String(artifact.name ?? '').toLowerCase());
      const observedFileNames = observations.flatMap((observation) => [
        ...(observation.data?.items ?? []),
        ...(observation.data?.matches ?? [])
      ]).map((item) => String(item?.name ?? '').toLowerCase()).filter(Boolean);
      const observedReadFileNames = observations.filter((observation) => observation.toolName === 'filesystem.readText')
        .flatMap((observation) => {
          const action = (mission.waves ?? []).flatMap((wave) => wave.actions ?? []).find((item) => item.actionId === observation.actionId);
          return action?.arguments?.path ? [basename(action.arguments.path).toLowerCase()] : [];
        });
      const requiresProducedArtifact = /생성|작성|저장|만들|수정|변경|편집|정리해|기록|내보내|created|written|saved|export/iu.test(statement);
      const acceptedNames = [...new Set(requiresProducedArtifact
        ? producedArtifactNames
        : [...producedArtifactNames, ...observedFileNames, ...observedReadFileNames])];
      checks.push({
        checkId: 'named_artifacts_match',
        passed: namedFiles.every((fileName) => acceptedNames.includes(fileName)),
        expected: namedFiles,
        observed: acceptedNames,
        evidenceMode: requiresProducedArtifact ? 'produced-artifact-only' : 'verified-observation-or-artifact'
      });

      // A DOCX file existing is not proof that the structured content survived
      // native Word authoring. For DOCX outputs that were actually assigned to
      // word.create, require the adapter's semantic-content postcondition and
      // bind its counts to the exact trusted action arguments. This would have
      // rejected a table silently dropped by an adapter before mission complete.
      const namedDocxFiles = [...new Set(namedFiles.filter((fileName) => /\.docx$/iu.test(fileName)))];
      if (namedDocxFiles.length > 0) {
        const relevantWordActions = (mission.waves ?? [])
          .flatMap((wave) => wave.actions ?? [])
          .filter((action) => actionTool(action) === 'word.create')
          .map((action) => ({
            action,
            fileName: basename(String(action.arguments?.path ?? '')).toLowerCase(),
            expectedItemCount: countStructuredDocumentItems(action.arguments),
            expectedTableCount: countStructuredDocumentTables(action.arguments)
          }))
          .filter((item) => namedDocxFiles.includes(item.fileName));
        if (relevantWordActions.length > 0) {
          const observedContracts = relevantWordActions.map((item) => {
            const observation = (mission.observations ?? []).find((candidate) => candidate.actionId === item.action.actionId);
            const contract = observation?.data?.documentContentVerification;
            const passed = contract?.status === 'verified'
              && Number(contract.expectedItemCount) === item.expectedItemCount
              && Number(contract.expectedTableCount) === item.expectedTableCount;
            return {
              fileName: item.fileName,
              actionId: item.action.actionId,
              expectedItemCount: item.expectedItemCount,
              expectedTableCount: item.expectedTableCount,
              status: contract?.status ?? 'missing',
              observedItemCount: Number(contract?.expectedItemCount ?? 0),
              observedTableCount: Number(contract?.expectedTableCount ?? 0),
              passed
            };
          });
          checks.push({
            checkId: 'word_content_contract_verified',
            passed: namedDocxFiles
              .filter((fileName) => relevantWordActions.some((item) => item.fileName === fileName))
              .every((fileName) => observedContracts.some((item) => item.fileName === fileName && item.passed)),
            expected: namedDocxFiles.filter((fileName) => relevantWordActions.some((item) => item.fileName === fileName)),
            observed: observedContracts
          });
        }
      }
    }
    if (absentReferenceIndexes.size > 0) {
      checks.push(verifyNamedArtifactAbsence({
        mission,
        observations,
        references: [...absentReferenceIndexes].map((index) => references[index]),
        allowedRoot: this?.allowedRoots?.[0] ?? null
      }));
    }
    if (/actualToolName/iu.test(statement) && /workflow\.execute/iu.test(statement)) {
      const relevantActions = (mission.waves ?? [])
        .flatMap((wave) => wave.actions ?? [])
        .filter((action) => evidenceActionIds.includes(action.actionId));
      const observedToolNames = relevantActions.map((action) => action.actualToolName).filter(Boolean);
      checks.push({
        checkId: 'workflow_route_bound_to_actual_tool',
        passed: relevantActions.length > 0
          && observedToolNames.length === relevantActions.length
          && observedToolNames.every((toolName) => toolName === 'workflow.execute')
          && !observedToolNames.includes('shell.execute'),
        expected: ['workflow.execute'],
        observed: observedToolNames
      });
    }
    if (/검증|확인|verified|verification/iu.test(statement)) {
      checks.push({
        checkId: 'g_verification_passed',
        passed: observations.length > 0 && observations.every((observation) => observation.verification?.status === 'passed'),
        observed: observations.map((observation) => observation.verification?.status ?? 'missing')
      });
    }
    if (requiresEmailCommitEvidence(statement)) {
      const emailEvidence = observations.filter((observation) => (
        observation.toolName === 'email.send'
        && observation.data?.email?.providerAccepted === true
        && observation.data?.email?.passed === true
      ));
      checks.push({
        checkId: 'external_commit_evidence_present',
        passed: emailEvidence.length > 0,
        observed: emailEvidence.map((observation) => ({
          toolName: observation.toolName,
          providerAccepted: observation.data.email.providerAccepted,
          recipientMatched: observation.data.email.recipientMatched,
          attachmentCount: observation.data.email.attachmentCount
        }))
      });
    }
    // File names describe artifacts, not a request for live web provenance.
    // Keep the surrounding prose so an explicit source requirement still applies.
    let provenanceStatement = statement;
    for (const match of [...references].reverse()) provenanceStatement = `${provenanceStatement.slice(0, match.index)} ${provenanceStatement.slice(match.index + match[0].length)}`;
    if (/최신\s*(?:정보|뉴스|헤드라인)|오늘\s*(?:뉴스|핫뉴스)|뉴스\s*(?:출처|조회)|출처|조회\s*시점|\bretrieved\b|\bsource\b/iu.test(provenanceStatement)) {
      const weatherEvidence = observations
        .map((observation) => observation.data?.weatherReport)
        .filter(Boolean);
      const newsEvidence = observations
        .map((observation) => observation.data?.news)
        .filter((item) => (
          item?.live === true
          && item?.replay !== true
          && item?.fixture !== true
          && item?.fetched === true
          && item?.sourceHost === 'news.google.com'
          && Boolean(item?.sourceUrl)
          && Boolean(item?.retrievedAt)
          && Number(item?.httpStatus ?? 0) >= 200
          && Number(item?.httpStatus ?? 0) < 300
          && Number(item?.itemCount ?? 0) > 0
          && Array.isArray(item?.items)
          && item.items.length === Number(item.itemCount)
          && item.items.every((article) => (
            Boolean(article?.title)
            && Boolean(article?.url)
            && Boolean(article?.publishedAt)
            && Boolean(article?.source)
          ))
        ));
      const publisherNewsEvidence = observations
        .map(observation => observation.data?.news)
        .filter(hasValidPublisherFeedEvidence);
      const requiredSourceHosts = /\bMDN\b/i.test(statement) ? ['developer.mozilla.org'] : [];
      const webEvidence = observations.filter(item => item.toolName === 'browser.search' && item.data?.webProvenance?.live === true && item.data?.webProvenance?.capturedAt && item.data.webProvenance.navigationStatus >= 200 && item.data.webProvenance.navigationStatus < 400);
      const sourceUrls = [...new Set(webEvidence.flatMap(item=>item.data?.searchResults??[]).flatMap(result=>{
        try {
          const url=new URL(result.url);
          if(!/^https?:$/.test(url.protocol) || /(^|\.)(?:bing\.com|duckduckgo\.com)$/i.test(url.hostname) || (requiredSourceHosts.length && !requiredSourceHosts.includes(url.hostname))) return [];
          url.hash=''; return [url.href];
        } catch { return []; }
      }))];
      const minimumSources = /(?:URL|출처)\s*(?:두|2)\s*개/iu.test(statement) ? 2 : 1;
      checks.push({
        checkId: 'live_data_provenance_present',
        passed: sourceUrls.length >= minimumSources || newsEvidence.length > 0 || publisherNewsEvidence.length > 0 || weatherEvidence.some((item) => (
          item.fetched === true
          && Boolean(item.sourceProvider)
          && Boolean(item.sourceHost)
          && Boolean(item.retrievedAt)
          && Number(item.rowCount ?? 0) > 0
        )),
        observed: [{sourceUrls,requiredSourceHosts,minimumSources}, ...webEvidence.map(item => item.data.webProvenance), ...newsEvidence.map((item) => ({
          sourceProvider: item.sourceProvider ?? null,
          sourceHost: item.sourceHost ?? null,
          sourceUrl: item.sourceUrl ?? null,
          retrievedAt: item.retrievedAt ?? null,
          httpStatus: item.httpStatus ?? null,
          itemCount: item.itemCount ?? 0,
          live: item.live === true,
          replay: item.replay === true
        })), ...weatherEvidence.map((item) => ({
          sourceProvider: item.sourceProvider ?? null,
          sourceHost: item.sourceHost ?? null,
          retrievedAt: item.retrievedAt ?? null,
          rowCount: item.rowCount ?? 0
        })), ...publisherNewsEvidence.map(item => ({
          sourceProvider: item.sourceProvider ?? null,
          sourceHost: item.sourceHost ?? null,
          feedUrl: item.feedUrl ?? null,
          finalFeedUrl: item.finalFeedUrl ?? null,
          retrievedAt: item.retrievedAt ?? null,
          httpStatus: item.httpStatus ?? null,
          itemCount: item.itemCount ?? 0,
          live: true
        }))]
      });
    }
    const articleCitationRequirement = observedArticleCitationRequirement(statement)
      ?? observedNewsSummaryRequirement(statement);
    if (articleCitationRequirement) {
      const candidateActions = (mission.waves ?? [])
        .flatMap((wave) => wave.actions ?? [])
        .filter((action) => actionTool(action) === 'filesystem.createTextFile')
        .map((action) => ({
          action,
          evaluation: evaluateObservedArticleCitations({
            objective: statement,
            outputPath: action.arguments?.path,
            content: action.arguments?.content,
            observations,
            requireLive: true
          })
        }))
        .filter((item) => item.evaluation);
      const verifiedCandidates = candidateActions.filter(({ action }) => (
        evidenceActionIds.includes(action.actionId)
        && observations.some((observation) => (
          observation.actionId === action.actionId
          && observation.outcome === 'success'
          && observation.verification?.status === 'passed'
        ))
      ));
      const accepted = verifiedCandidates.find(({ evaluation }) => evaluation.passed);
      checks.push({
        checkId: 'observed_news_article_citations_bound',
        passed: Boolean(accepted),
        expected: {
          fileName: articleCitationRequirement.fileName,
          minimum: articleCitationRequirement.minimum,
          citationSource: 'news.items[].url'
        },
        observed: verifiedCandidates.map(({ action, evaluation }) => ({
          artifactActionId: action.actionId,
          artifactPath: action.arguments?.path ?? null,
          availableArticleCount: evaluation.availableArticleCount,
          citedArticleCount: evaluation.citedArticles.length,
          citedArticles: evaluation.citedArticles.map((article) => ({
            observationActionId: article.observationActionId,
            title: article.title,
            source: article.source,
            publishedAt: article.publishedAt,
            url: article.url
          })),
          ...(evaluation.claimEvidence ? { claimEvidence: {
            evidenceType: evaluation.claimEvidence.evidenceType,
            semanticEntailment: evaluation.claimEvidence.semanticEntailment,
            requiredClaimCount: evaluation.claimEvidence.requiredClaimCount,
            claimCount: evaluation.claimEvidence.claimCount,
            passedCount: evaluation.claimEvidence.passedCount,
            failedCount: evaluation.claimEvidence.failedCount,
            distinctSourceCount: evaluation.claimEvidence.distinctSourceCount,
            blockingReasons: evaluation.claimEvidence.blockingReasons,
            passed: evaluation.claimEvidence.passed
          } } : {})
        }))
      });
    }
    const failed = checks.filter((check) => !check.passed);
    const unknown = checks.length === 0 || legacyCriterionNeedsContentProof(statement, checks, {
      mission, observations, allowedRoots: this.allowedRoots ?? [], evidenceActionIds
    })
      || (checks.every(check => check.checkId === 'g_verification_passed')
      && !/^(?:검색\s*행동이\s*)?(?:G\s*)?(?:실행\s*)?검증(?:을|이)?\s*(?:통과(?:한다|했다|됨|함)?|완료(?:된다|됨)?)[.!\s]*$/iu.test(statement.trim()));
    return {
      status: unknown ? 'unverified' : failed.length ? 'failed' : 'passed',
      passed: !unknown && failed.length === 0,
      reasons: [...failed.map((check) => check.checkId), ...(unknown ? ['criterion-verifier-unavailable'] : [])],
      checks
    };
  }

  completeMission(mission, completion) {
    let scheduleTiming=null;
    try{scheduleTiming=this.routineTemporalGuard?.assertCurrentMission(mission,{phase:'completion'})??null;}
    catch(error){
      mission.status=MissionStatus.PAUSED;mission.stopReason='routine-temporal-completion-unverified';
      mission.lastError={code:error.code??'A_ROUTINE_TEMPORAL_UNAVAILABLE',message:'실제 실행 결과는 보존했지만 예약의 현재 상태와 완료 시각을 확인하지 못했습니다.'};
      this.touch(mission,'mission-schedule-completion-paused');return false;
    }
    // Evidence checks and the final planner call can yield after the last
    // dispatch check. Keep actual action receipts, but do not certify an
    // obsolete linked requirement as the current Mission outcome.
    try {
      this.personalDependencyGuard?.assertCurrentMission(mission);
    } catch (error) {
      const changed = error.code === 'A_PERSONAL_LINK_DEPENDENCY_CHANGED';
      mission.status = MissionStatus.PAUSED;
      mission.stopReason = changed ? 'personal-dependency-changed' : 'personal-dependency-check-unavailable';
      mission.lastError = { code: changed ? error.code : 'A_PERSONAL_DEPENDENCY_CHECK_UNAVAILABLE',
        message: changed ? '연결된 약속이 변경되었습니다. 현재 조건에 맞게 작업을 다시 계획하세요.'
          : '연결된 약속의 현재 상태를 확인하지 못했습니다. 상태 확인 후 다시 시도하세요.' };
      this.touch(mission, 'mission-completion-dependency-paused');
      this.recordEvent('mission.completion.dependency-paused', mission, { code: mission.lastError.code });
      return false;
    }
    let quantityVerification=null;
    const quantitySource=missionSourceQuantity(mission)??missionSourceQuantity({objective:mission.goalContract?.objective});
    if(quantitySource){
      const ids=mission.waves.flatMap(w=>w.actions).filter(a=>a.status==='succeeded').map(a=>a.actionId);
      const remote=mission.waves.flatMap(w=>w.actions).some(action=>ids.includes(action.actionId)&&this.effectCoordinator?.effect(action)?.intent?.request?.remoteArtifactIntent);
      quantityVerification=!missionSourceQuantity(mission)?{passed:false,reasons:['source-quantity-changed']}:remote?{passed:false,reasons:['source-quantity-remote-observation-required']}:
        verifyMissionSourceQuantity({mission,criterion:{statement:mission.objective},observations:mission.observations,evidenceActionIds:ids,allowedRoots:this.allowedRoots??[],beforeAccess:this.resultReadGuard(mission)});
      if(!quantityVerification.passed){
        mission.status=MissionStatus.PAUSED;mission.stopReason=quantitySource.kind==='allocation-plan'?'allocation-plan-completion-unverified':'record-count-completion-unverified';
        mission.lastError={code:quantitySource.kind==='allocation-plan'?'A_MISSION_ALLOCATION_PLAN_UNVERIFIED':'A_MISSION_RECORD_COUNT_UNVERIFIED',message:'파일은 보존했지만 원문의 대상·수량 조건과 현재 파일의 일치를 확인하지 못했습니다.',reasons:quantityVerification.reasons};
        this.touch(mission,'mission-source-quantity-completion-paused');return false;
      }
    }
    let deadlineTiming=null;
    try{deadlineTiming=this.completionDeadline.assertCurrentMission(mission,{phase:'completion'});}
    catch(error){
      mission.status=MissionStatus.PAUSED;mission.stopReason='completion-deadline-unverified';
      mission.lastError={code:error.code,message:'결과는 보존했지만 원문의 완료 기한과 실행 증거를 충족하지 못했습니다. 기한 변경이나 다음 조치를 확인하세요.'};
      this.touch(mission,'mission-deadline-completion-paused');return false;
    }
    // A passed assessment is not a durable certificate for mutable artifacts.
    // Re-observe local criteria at the final synchronous completion boundary.
    // Remote observations retain only private, one-use, in-process authority;
    // persisted or caller-supplied completion JSON cannot borrow that authority.
    const pending=this.#pendingCompletionChecks.get(completion);
    this.#pendingCompletionChecks.delete(completion);
    if(pending?.mission===mission)this.#remoteCompletionChecks.set(mission,pending.checks);
    let currentCompletion;
    try{currentCompletion=this.validateCompletion(mission,completion.criteria??[]);}
    catch(error){currentCompletion={valid:false,reasons:[error.code??'completion-current-evidence-unavailable']};}
    finally{this.#remoteCompletionChecks.delete(mission);}
    if(!currentCompletion.valid){
      mission.status=MissionStatus.PAUSED;mission.stopReason='completion-current-evidence-unverified';
      mission.lastError={code:'A_MISSION_COMPLETION_CURRENT_EVIDENCE_UNVERIFIED',message:'실행 결과는 보존했지만 완료 직전의 실제 내용과 요청 조건이 일치하지 않습니다. 결과를 확인한 뒤 이어서 진행하세요.',reasons:currentCompletion.reasons};
      this.touch(mission,'mission-current-evidence-completion-paused');
      this.recordEvent('mission.completion.current-evidence-paused',mission,{reasons:currentCompletion.reasons});
      return false;
    }
    completion={...completion,...currentCompletion};
    mission.status = MissionStatus.COMPLETED;
    mission.stopReason = null;
    mission.lastError = null;
    mission.completion = {
      completionVersion: 'a-mission-completion-v2',
      status: 'verified',
      source: completion.source ?? 'planner-assessment',
      criteria: completion.criteria,
      goalCoverage: structuredClone(completion.goalCoverage ?? null),
      completedAt: deadlineTiming?.checkedAt??this.clock().toISOString(),
      ...(scheduleTiming?{scheduleTiming}:{}),
      ...(deadlineTiming?{deadlineTiming}:{}),
      ...(quantityVerification?{quantityVerification}:{}),
      verificationPath: 'A-plan/E-policy/B-execution/G-verification/F-learning',
      successfulActionCount: mission.metrics.successfulActions,
      failedActionCount: mission.metrics.failedActions,
      recoveredFailureCount: mission.observations.filter((observation) => observation.outcome === 'failed').length
    };
    this.touch(mission, 'mission-completed');
    this.recordEvent('mission.completed', mission, {
      successfulActionCount: mission.completion.successfulActionCount,
      failedActionCount: mission.completion.failedActionCount,
      criterionCount: mission.completion.criteria.length
    });
    return true;
  }

  blockMission(mission, reason) {
    if(reason==='WORKFLOW_ASSERT_COUNT_FAILED'){
      let compiled;
      try{compiled=compileNaturalWorkflowObjective(mission.objective,{workspaceRoot:this.allowedRoots[0]});}catch{}
      const nodes=compiled?.spec?.nodes;
      if(compiled?.status==='compiled'&&nodes?.length===4
        &&nodes.map(n=>n.op).join(',')==='data.readJson,data.filter,assert.count,write.json'
        &&nodes[2].args.equals===1&&/사람 한 명(?:을|만)/u.test(compiled.clauses[1]?.sourceText??'')
        &&mission.observations.some(o=>o.outcome==='failed'&&o.error?.code===reason)){
        mission.status=MissionStatus.PAUSED;mission.stopReason='person-selection-confirmation-needed';
        mission.lastError={code:'A_MISSION_PERSON_SELECTION_UNRESOLVED',message:'명부에서 요청한 사람 한 명을 확정하지 못했습니다. 결과 파일은 저장하지 않았습니다.',
          nextAction:'소속을 명시하거나 명부에서 대상을 한 명으로 구분해 주세요. 요청을 정정한 뒤 같은 작업을 이어갈 수 있습니다.'};
        this.touch(mission,'mission-person-selection-paused');
        this.recordEvent('mission.person-selection.confirmation-needed',mission,{code:mission.lastError.code});return;
      }
    }
    mission.status = MissionStatus.BLOCKED;
    mission.stopReason = cleanText(reason, 500) ?? 'mission-blocked';
    this.touch(mission, 'mission-blocked');
    this.recordEvent('mission.blocked', mission, { reason: mission.stopReason });
  }

  successObservation(action, task, run) {
    const envelope = run.execution ?? task.executionResult ?? {};
    const result = envelope.executionResult ?? envelope;
    const toolName = action.actualToolName;
    const outputPaths = (result.outputPaths ?? []).slice(0, toolName==='powerpoint.create'?64:20);
    const executionEvidenceFiles = Array.isArray(result.evidence?.executionEvidence?.files)
      ? result.evidence.executionEvidence.files
      : Array.isArray(run.evidence?.files) ? run.evidence.files : [];
    const evidenceFileHashes = new Map(executionEvidenceFiles.flatMap((file) => {
      const path = cleanText(file?.path, 4000);
      const sha256 = normalizeContentSha256(file?.sha256);
      return path && sha256 ? [[resolve(path), sha256]] : [];
    }));
    const singleOutputSha256 = outputPaths.length === 1
      ? [
          result.sha256,
          result.contentSha256,
          result.evidence?.sha256,
          evidenceFileHashes.get(resolve(outputPaths[0]))
        ].map(normalizeContentSha256).find(Boolean) ?? null
      : null;
    const outputHashes = new Map((Array.isArray(result.cards) ? result.cards : [])
      .map((item) => [resolve(String(item.path ?? '')), normalizeContentSha256(item.sha256)]));
    for (const item of Array.isArray(result.evidence?.manifest) ? result.evidence.manifest : []) {
      if (typeof item?.path === 'string' && normalizeContentSha256(item.sha256)) outputHashes.set(resolve(item.path), normalizeContentSha256(item.sha256));
    }
    for (const [path, sha256] of evidenceFileHashes) outputHashes.set(path, sha256);
    const artifacts = outputPaths.map((path) => this.artifactReference(path, {
      contentSha256: outputHashes.get(resolve(path)) ?? singleOutputSha256
    }));
    const data = {};
    const workflow = result.evidence?.workflow;
    if (toolName === 'workflow.execute' && workflow && typeof workflow === 'object') {
      data.workflow = {
        workflowId: cleanText(workflow.workflowId, 160),
        specSha256: normalizeContentSha256(workflow.specSha256),
        nodeCount: Number(workflow.nodeCount ?? 0),
        receipts: Array.isArray(workflow.receipts) ? workflow.receipts.slice(0, 64).map(receipt => ({
          nodeId: cleanText(receipt.nodeId, 160), op: cleanText(receipt.op, 80), status: cleanText(receipt.status, 24),
          ...(receipt.op === 'safety.simulation' && normalizeContentSha256(receipt.resultSha256) ? { resultSha256: normalizeContentSha256(receipt.resultSha256) } : {}),
          ...(receipt.op==='health.report'&&receipt.status==='success'&&typeof receipt.healthReportGeneratedAt==='string'&&receipt.healthReportGeneratedAt.length<=32&&Number.isFinite(Date.parse(receipt.healthReportGeneratedAt))?{healthReportGeneratedAt:receipt.healthReportGeneratedAt}:{}),
          ...(receipt.op==='compute.compareChange'&&receipt.status==='success'&&sourceChangeView(receipt.changeComparison)?{changeComparison:sourceChangeView(receipt.changeComparison)}:{}),
          ...(receipt.op==='text.extractFields'&&receipt.status==='success'&&receipt.fieldProvenance&&typeof receipt.fieldProvenance==='object'?{
            sourceSha256:normalizeContentSha256(receipt.sourceSha256),
            fieldProvenance:Object.fromEntries(Object.entries(receipt.fieldProvenance).slice(0,10).flatMap(([id,binding])=>{
              if(!/^\w{1,80}$/u.test(id)||['__proto__','prototype','constructor'].includes(id)
                ||!['source-claim','source-declaration'].includes(binding?.basis)||!cleanText(binding?.sourceLabel,80))return [];
              return [[id,{basis:binding.basis,sourceLabel:cleanText(binding.sourceLabel,80),
                ...(typeof binding.unit==='string'&&binding.unit.length<=12&&cleanText(binding.unit,12)?{unit:cleanText(binding.unit,12)}:{}),
                ...(binding.basis==='source-claim'?{claimedBy:cleanText(binding.claimedBy,80)}:{}),independentlyVerified:false}]];
            }))
          }:{}),
          ...(receipt.source && typeof receipt.source === 'object' ? { source: {
            path: cleanText(receipt.source.path, 4000), sha256: normalizeContentSha256(receipt.source.sha256),
            size: Number.isSafeInteger(receipt.source.size) && receipt.source.size >= 0 ? receipt.source.size : null
          } } : {})
        })) : []
      };
    }
    if (Array.isArray(result.listedItems)) {
      if(toolName === 'filesystem.listFiles') {
        data.listingItems=result.listedItems.slice(0,1000).map(item=>({name:String(item.name ?? '').slice(0,512),type:item.type}));
        data.listingTotalEntries=Number.isSafeInteger(result.listingTotalEntries) ? result.listingTotalEntries : null;
        data.listingOffset=Number.isSafeInteger(result.listingOffset) ? result.listingOffset : null;
        data.listingSnapshotSha256=normalizeContentSha256(result.listingSnapshotSha256);
        data.listingHasMore=result.listingHasMore === true;
        data.listingTruncated=result.listingTruncated === true || result.listedItems.length > 1000;
      }
      data.items = result.listedItems.slice(0, 30).map((item) => ({
        name: cleanText(item.name, 240),
        type: item.type,
        size: item.size,
        modifiedAt: item.modifiedAt
      }));
    }
    if (Array.isArray(result.matches)) {
      data.matches = result.matches.slice(0, 30).map((item) => {
        const artifact = this.artifactReference(item.path);
        const root = Number.isInteger(artifact?.rootIndex) && artifact.rootIndex >= 0
          ? this.allowedRoots?.[artifact.rootIndex] : null;
        const candidate = root && typeof artifact?.relativePath === 'string' && !isAbsolute(artifact.relativePath)
          ? resolve(root, artifact.relativePath) : null;
        return {
          name: cleanText(item.name, 240), size: item.size, modifiedAt: item.modifiedAt, artifact,
          ...(toolName === 'filesystem.searchFiles' && candidate && artifact.outsideAllowedRoots === false && isInside(root, candidate)
            ? { path: candidate } : {})
        };
      });
    }
    if (toolName === 'filesystem.searchFiles' && Object.prototype.hasOwnProperty.call(result, 'searchCompleteness')) {
      const coverage = result.searchCompleteness;
      const valid = coverage?.version === 'pc-search-completeness-v1' && Number.isSafeInteger(coverage.requestedRootCount) && coverage.requestedRootCount > 0
        && Number.isSafeInteger(coverage.returnedMatchCount) && coverage.returnedMatchCount === result.matches?.length
        && Array.isArray(coverage.reasons) && coverage.reasons.every(reason => typeof reason === 'string' && /^[a-z-]{1,40}$/u.test(reason));
      data.searchCompleteness = { version: 'pc-search-completeness-v1', complete: valid && coverage.complete === true && coverage.reasons.length === 0,
        reasons: valid ? coverage.reasons.slice(0, 20) : ['invalid-coverage'], requestedRootCount: valid ? coverage.requestedRootCount : null,
        returnedMatchCount: valid ? coverage.returnedMatchCount : null, projectionTruncated: (result.matches?.length ?? 0) > 30 };
    }
    const browserPreview = result.search?.resultPreview ?? result.evidence?.browser?.resultPreview;
    if (Array.isArray(browserPreview)) {
      data.searchResults = browserPreview.slice(0, 8).map((item) => ({
        title: cleanText(item.title, 300),
        url: cleanText(item.url, 1000),
        snippet: cleanText(item.snippet, 1200)
      }));
      const capture = result.search?.liveCapture ?? result.evidence?.browser?.liveCapture;
      data.webProvenance = { live: capture?.live === true && capture?.replay !== true && capture?.driver !== 'recorded-network-replay', capturedAt: capture?.capturedAt ?? null, driver: capture?.driver ?? null, navigationStatus:capture?.navigationStatus??null };
    }
    const stdoutPreview = result.stdoutPreview ?? result.stdout;
    if (stdoutPreview) data.stdoutPreview = cleanText(String(stdoutPreview), 2000);
    const article = result.article ?? result.evidence?.article;
    if (toolName === 'news.fetchArticle' && article && typeof article === 'object') {
      data.article = {
        live: article.live === true,
        replay: article.replay === true,
        fixture: article.fixture === true,
        httpStatus: Number.isSafeInteger(article.httpStatus) ? article.httpStatus : null,
        requestedUrl: cleanText(article.requestedUrl, 2000),
        finalUrl: cleanText(article.finalUrl, 2000),
        finalHost: cleanText(article.finalHost, 255),
        title: cleanText(article.title, 300),
        fetchedAt: cleanText(article.fetchedAt, 80),
        textCharacters: Number.isSafeInteger(article.textCharacters) ? article.textCharacters : 0,
        textSha256: normalizeContentSha256(article.textSha256),
        text: cleanText(article.text, 12_000),
        textIsUntrustedSourceMaterial: article.textIsUntrustedSourceMaterial === true
      };
    }
    const readContentSha256 = [result.contentSha256, result.evidence?.contentSha256]
      .map(normalizeContentSha256)
      .find(Boolean) ?? null;
    if(toolName==='document.readPdf'&&action.arguments?.path&&readContentSha256) {
      data.fileEvidence=this.artifactReference(action.arguments.path,{contentSha256:readContentSha256});
      data.pdfRead=result.pdfRead;
    }
    if(toolName==='excel.readWorkbook'&&action.arguments?.path&&readContentSha256){
      data.fileEvidence=this.artifactReference(action.arguments.path,{contentSha256:readContentSha256});
      const {cells,...metadata}=result.xlsxRead??{};
      // One serialized local-content value lets egress screening classify numbers too.
      data.xlsxRead={...metadata,cellsJson:JSON.stringify(cells??{}),cellsAreStoredLiteralValues:true};
    }
    if (toolName === 'filesystem.readText' && action.arguments?.path && readContentSha256) {
      data.fileEvidence = this.artifactReference(action.arguments.path, { contentSha256: readContentSha256 });
      const readExtent = Object.fromEntries(['offset', 'returnedChars', 'bytes'].map(key => {
        const value = result[key] ?? result.evidence?.[key];
        return [key, Number.isSafeInteger(value) && value >= 0 ? value : null];
      }));
      const truncated = result.truncated ?? result.evidence?.truncated;
      data.readExtent = { ...readExtent, truncated: typeof truncated === 'boolean' ? truncated : null,
        encoding: result.evidence?.encoding === 'utf8' ? 'utf8' : null };
      const textRead=captureTextRead(result);
      if(textRead)data.textRead={...textRead,pathHash:normalizeContentSha256(result.pathHash??result.evidence?.pathHash)};
    }
    const documentContentVerification = result.contentVerification
      ?? result.evidence?.document?.contentVerification
      ?? result.evidence?.contentVerification;
    if (toolName === 'word.create' && documentContentVerification && typeof documentContentVerification === 'object') {
      data.documentContentVerification = {
        status: cleanText(documentContentVerification.status, 40),
        expectedItemCount: Number(documentContentVerification.expectedItemCount ?? 0),
        expectedTableCount: Number(documentContentVerification.expectedTableCount ?? 0)
      };
    }
    const weatherReport = result.weatherReport ?? result.evidence?.weatherReport;
    if (weatherReport && typeof weatherReport === 'object') {
      data.weatherReport = {
        reportVersion: cleanText(weatherReport.reportVersion, 120),
        reportType: cleanText(weatherReport.reportType, 120),
        location: cleanText(weatherReport.location, 240),
        periodStart: cleanText(weatherReport.periodStart, 40),
        periodEnd: cleanText(weatherReport.periodEnd, 40),
        timezone: cleanText(weatherReport.timezone, 120),
        rowCount: Number(weatherReport.rowCount ?? 0),
        tableCount: Number(weatherReport.tableCount ?? 0),
        sourceProvider: cleanText(weatherReport.sourceProvider, 120),
        sourceHost: cleanText(weatherReport.sourceHost, 200),
        sourceUrl: cleanText(weatherReport.sourceUrl, 1200),
        retrievedAt: cleanText(weatherReport.retrievedAt, 80),
        fetched: weatherReport.fetched === true
      };
    }
    const news = result.news ?? result.evidence?.news;
    if (news && typeof news === 'object') data.news = boundNewsProvenance(news, { maxItems: 10 });
    const emailVerification = result.verification ?? result.evidence?.email;
    if (toolName === 'email.send' && emailVerification && typeof emailVerification === 'object') {
      data.email = {
        passed: emailVerification.passed === true,
        providerAccepted: emailVerification.providerAccepted === true,
        recipientMatched: emailVerification.recipientMatched === true,
        acceptedRecipientCount: Number(emailVerification.acceptedRecipientCount ?? 0),
        rejectedRecipientCount: Number(emailVerification.rejectedRecipientCount ?? 0),
        attachmentCount: Number(result.attachmentCount ?? 0),
        attachmentSha256s: Array.isArray(result.attachmentSha256s) ? result.attachmentSha256s.slice(0, 20) : [],
        providerMessageIdSha256: normalizeContentSha256(emailVerification.providerMessageIdSha256),
        deduplicated: result.deduplicated === true
      };
    }
    const verification = run.executionVerification ?? task.executionVerification;
    if(toolName==='source.readSelectedInbox'){
      const receipt=envelope.evidence?.adapterEvidence;
      const proof=verification?.checks?.find(check=>check.checkId==='selected_source_current_core_verified'&&check.status==='passed');
      if(proof&&receipt?.version==='selected-source-receipt-v1')data.selectedSource={
        version:'a-selected-source-observation-v1',provider:receipt.snapshot.provider,streamRef:receipt.snapshot.streamRef,
        revision:receipt.snapshot.revision,resultSha256:receipt.resultSha256,
        offset:receipt.snapshot.offset,limit:receipt.snapshot.limit,total:receipt.snapshot.total,
        itemCount:receipt.snapshot.items.length,nextOffset:receipt.snapshot.nextOffset,
        providerObservationVerified:false,executionAuthority:false};
    }
    const layoutChecks=verification?.checks?.filter(item=>['artifact_current_content_layout_verified','word_current_table_coordinates_verified','word_current_paragraph_sequence_verified'].includes(item.checkId)&&item.status==='passed'&&item.evidence?.passed===true)??[];
    if(layoutChecks.length){
      data.artifactLayoutProofs=layoutChecks.flatMap(check=>check.evidence.proofs??[]).map(proof=>({kind:proof.kind,pathHash:createHash('sha256').update(resolve(proof.path)).digest('hex'),
        requirementsSha256:proof.requirementsSha256,...(proof.kind==='image.cardLayout'?{width:proof.width,height:proof.height}:{}),
        files:proof.files.map(file=>this.artifactReference(file.path,{contentSha256:file.sha256}))}));
    }
    if(toolName==='excel.readWorkbook'){
      const check=verification?.checks?.find(item=>item.checkId==='xlsx_region_current_source_verified'&&item.status==='passed');
      if(check?.evidence?.passed===true)data.xlsxReadProof={passed:true,
        sourceSha256:check.evidence.sourceSha256,cellsSha256:check.evidence.cellsSha256,
        sheetName:check.evidence.sheetName,range:check.evidence.range};
    }
    if(toolName==='document.readPdf'){
      const check=verification?.checks?.find(item=>item.checkId==='pdf_text_current_source_verified'&&item.status==='passed');
      if(check?.evidence?.passed===true)data.pdfReadProof={passed:true,
        sourceSha256:check.evidence.sourceSha256,pagesSha256:check.evidence.pagesSha256,
        firstPage:check.evidence.firstPage,totalPages:check.evidence.totalPages,truncated:check.evidence.truncated};
    }
    return {
      actionId: action.actionId,
      taskId: task.taskId,
      category: 'execution',
      outcome: 'success',
      toolName,
      summary: cleanText(result.summary, 800) ?? `${toolName} completed and passed verification.`,
      artifacts,
      data,
      verification: {
        verificationId: verification?.verificationId ?? null,
        status: verification?.status ?? 'passed',
        score: verification?.score ?? null,
        failedCheckIds: (verification?.checks ?? []).filter((check) => check.status === 'failed').map((check) => check.checkId)
      },
      evidenceId: envelope.evidence?.evidenceId ?? result.evidence?.verificationEvidenceId ?? null,
      trustBoundary: toolName==='source.readSelectedInbox'?'EMAIL_CONTENT':['browser.search', 'news.fetchHeadlines', 'news.fetchPublisherFeed', 'news.fetchArticle'].includes(toolName)
        ? 'WEB_CONTENT'
        : ['filesystem.listFiles', 'filesystem.searchFiles', 'filesystem.readText', 'document.readPdf', 'excel.readWorkbook'].includes(toolName) ? 'LOCAL_FILE_CONTENT' : 'TOOL_METADATA',
      untrusted: ['source.readSelectedInbox','browser.search', 'news.fetchHeadlines', 'news.fetchPublisherFeed', 'news.fetchArticle', 'filesystem.listFiles', 'filesystem.searchFiles', 'filesystem.readText', 'document.readPdf', 'excel.readWorkbook', 'shell.execute'].includes(toolName)
    };
  }

  recordActionFailure(mission, action, error) {
    const normalizedError = {
      code: cleanText(error?.code, 200) ?? 'A_MISSION_ACTION_FAILED',
      message: cleanText(error?.message, 500) ?? 'Mission action failed.',
      failedCheckIds: Array.isArray(error?.failedCheckIds) ? error.failedCheckIds.slice(0,20) : []
    };
    const signature = sha256(`${action.actualToolName ?? action.expectedToolName ?? 'unknown'}:${normalizedError.code}:${normalizedError.failedCheckIds.join(',')}`);
    mission.failureSignatures[signature] = (mission.failureSignatures[signature] ?? 0) + 1;
    const observation = this.addObservation(mission, {
      actionId: action.actionId,
      taskId: action.taskId,
      category: 'execution',
      outcome: 'failed',
      toolName: action.actualToolName ?? action.expectedToolName,
      summary: normalizedError.message,
      error: { ...normalizedError, signature, occurrence: mission.failureSignatures[signature] },
      artifacts: [],
      verification: null,
      trustBoundary: 'SYSTEM_RESULT',
      untrusted: false
    });
    action.observationId = observation.observationId;
    action.updatedAt = this.clock().toISOString();
    this.recordEvent('mission.action.failed', mission, {
      actionId: action.actionId,
      taskId: action.taskId,
      toolName: action.actualToolName ?? action.expectedToolName,
      errorCode: normalizedError.code,
      signature,
      occurrence: mission.failureSignatures[signature]
    });
    return observation;
  }

  errorFromRun(run, task) {
    const executionResult = run?.execution?.executionResult ?? task?.executionResult?.executionResult ?? {};
    const verification = run?.executionVerification ?? task?.executionVerification;
    const failedCheckIds = (verification?.checks ?? []).filter(check=>check.status==='failed').map(check=>check.checkId);
    if (verification?.status === 'failed' || failedCheckIds.length) return {
      code: 'A_MISSION_EXECUTION_VERIFICATION_FAILED',
      message: `실행 후 검증 실패: ${failedCheckIds.join(', ') || 'verification-failed'}`,
      failedCheckIds
    };
    const policyVerification = run?.policyVerification ?? task?.policyVerification;
    const failedPolicyChecks = (policyVerification?.checks ?? []).filter(check => check?.status === 'failed');
    if (policyVerification?.status === 'failed' || failedPolicyChecks.length) return {
      code: 'A_MISSION_WORKER_POLICY_VERIFICATION_FAILED',
      message: `실행 전 정책 검증 실패: ${failedPolicyChecks.map(check => check.checkId).filter(Boolean).join(', ') || 'policy-verification-failed'}`,
      failedCheckIds: failedPolicyChecks.map(check => check.checkId).filter(Boolean)
    };
    return {
      code: [run?.error?.code, run?.execution?.blockedReason?.code,
        typeof run?.execution?.blockedReason==='string'?run.execution.blockedReason:null,
        task?.executionResult?.blockedReason?.code,
        typeof task?.executionResult?.blockedReason==='string'?task.executionResult.blockedReason:null,
        executionResult?.error?.code, run?.failure?.reason,
        executionResult?.error, executionResult?.warnings?.[0]].map(value=>cleanText(value,200)).find(Boolean)
        ?? 'A_MISSION_WORKER_RUN_FAILED',
      message: run?.error?.message
        ?? (executionResult?.stderrPreview || executionResult?.summary)
        ?? run?.failure?.reason
        ?? `Worker ended with status ${run?.status ?? task?.status ?? 'unknown'}.`
    };
  }

  addObservation(mission, observation) {
    const createdAt = this.clock().toISOString();
    const record = {
      observationVersion: 'a-mission-observation-v1',
      observationId: stableId('mission_obs', `${mission.missionId}:${mission.observations.length + 1}`, createdAt),
      actionId: observation.actionId ?? null,
      taskId: observation.taskId ?? null,
      category: observation.category ?? 'system',
      outcome: observation.outcome ?? 'unknown',
      toolName: observation.toolName ?? null,
      summary: cleanText(observation.summary, 2000),
      artifacts: observation.artifacts ?? [],
      data: observation.data ?? {},
      verification: observation.verification ?? null,
      ...(observation.recovery ? { recovery: observation.recovery } : {}),
      evidenceId: observation.evidenceId ?? null,
      error: observation.error ?? null,
      trustBoundary: observation.trustBoundary ?? 'SYSTEM_RESULT',
      untrusted: observation.untrusted === true,
      createdAt
    };
    mission.observations.push(record);
    mission.observations = mission.observations.slice(-200);
    return record;
  }

  artifactReference(path, { contentSha256 = null } = {}) {
    const text = String(path ?? '');
    if (!text) return null;
    const absolute = isAbsolute(text) ? resolve(text) : resolve(this.allowedRoots[0], text);
    const root = this.allowedRoots.find((allowedRoot) => isInside(allowedRoot, absolute));
    const normalizedContentSha256 = normalizeContentSha256(contentSha256);
    return {
      name: basename(absolute),
      relativePath: root ? relative(root, absolute).replaceAll('\\', '/') : null,
      rootIndex: root ? this.allowedRoots.indexOf(root) : null,
      pathHash: sha256(absolute),
      contentSha256: normalizedContentSha256,
      outsideAllowedRoots: !root
    };
  }

  capabilityCatalog() {
    const skills = this.coreFacade.skillRouter?.capabilityMatrix?.() ?? [];
    const skillByTool = new Map(skills.map((skill) => [skill.toolName, skill]));
    return (this.pcAgent.registry?.capabilityMatrix?.() ?? []).map((contract) => {
      const skill = skillByTool.get(contract.toolName) ?? {};
      return {
        catalogVersion: 'a-mission-tool-capability-v1',
        toolName: contract.toolName,
        actionType: skill.actionType ?? null,
        label: skill.label ?? contract.toolName,
        description: skill.label ?? contract.toolName,
        category: skill.category ?? null,
        match: skill.match ?? null,
        readOnly: contract.readOnly === true,
        mutatesSystem: contract.mutatesSystem === true,
        rollback: contract.rollback === true,
        writesLocalFiles: skill.capability?.writesLocalFiles === true,
        externalNetwork: skill.capability?.externalNetwork === true,
        externalTransfer: skill.capability?.externalTransfer === true,
        requiresApproval: skill.capability?.requiresApproval !== false,
        requiresAvailabilityBinding: requiresCapabilityAvailability(contract.toolName, contract),
        modes: contract.modes ?? [],
        execution: skill.execution ?? null
      };
    }).sort((left, right) => left.toolName.localeCompare(right.toolName));
  }

  plannerContext(mission, startedAtMs) {
    const allCapabilities = this.capabilityCatalog();
    const selection = this.coreFacade.skillRouter?.shortlistCapabilities?.(allCapabilities, {
      objective: mission.objective,
      constraints: mission.constraints,
      maxTools: this.maxPlannerTools
    }) ?? {
      selectionVersion: 'a-deferred-tool-selection-v1',
      totalCount: allCapabilities.length,
      selectedCount: allCapabilities.length,
      deferredCount: 0,
      maxTools: allCapabilities.length,
      pinnedToolNames: [],
      selectedToolNames: allCapabilities.map((capability) => capability.toolName),
      deferredToolNames: [],
      capabilities: allCapabilities
    };
    const successfulActionIds = mission.waves.flatMap(wave => wave.actions)
      .filter(action => action.status === 'succeeded').map(action => action.actionId);
    const remoteEvidenceRequired = mission.waves.flatMap(wave => wave.actions)
      .some(action => this.effectCoordinator.effect(action)?.intent?.request?.remoteArtifactIntent);
    const criterionEvidence = successfulActionIds.length ? mission.successCriteria.map(criterion => {
      // Planner context is synchronous and cannot acquire current remote proof.
      // Keep the last actual completion audit for display; never replace it with
      // an unrelated local read, or use it to authorize a new completion.
      const evidence = remoteEvidenceRequired && criterion.verificationSpec
        ? {status:'unverified',passed:false,reasons:['remote-current-observation-required'],checks:[]}
        : this.verifyCriterionEvidence(mission, criterion, successfulActionIds);
      return { ...criterion, ...evidence, evidenceActionIds: successfulActionIds };
    }) : [];
    if (criterionEvidence.length && !remoteEvidenceRequired) mission.verificationSummary = criterionVerificationSummary(criterionEvidence);
    return bindNaturalWorkflowDispatches({
      workspaceRoot: this.allowedRoots[0] ?? null,
      memoryScope: { userId: mission.metadata?.userId ?? 'local_user',
        workspaceRoot: this.coreFacade.workspaceRoot, conversationId: mission.metadata?.conversationId ?? null },
      longTermMemory: mission.metadata?.longTermMemory !== false,
      personalContext: mission.metadata?.longTermMemory === false ? null : this.coreFacade.personalContextFor?.(mission.objective, mission.metadata?.userId ?? 'local_user') ?? null,
      sourceProcessing:sourceProcessingView(mission,this.allowedRoots),
      mission: {
        missionId: mission.missionId,
        objective: mission.objective,
        goalContract: structuredClone(mission.goalContract ?? null),
        successCriteria: mission.successCriteria,
        constraints: mission.constraints,
        remainingBudget: this.remainingBudget(mission, startedAtMs),
        waveCount: mission.waves.length
      },
      criterionEvidence,
      capabilities: selection.capabilities,
      managedAgentWorkerFailures: (mission.managedAgentWorkerFailures ?? []).map(item => ({
        workerRole: item.workerRole,
        collaborationGroupId: item.collaborationGroupId,
        disposition: item.handoffPermitted ? 'failed-handoff-allowed' : 'failed-result-uncertain',
        nextAction: item.handoffPermitted ? 'continue only from another role and G-verified artifacts'
          : 'reconcile the uncertain result before any role handoff'
      })),
      capabilitySelection: {
        selectionVersion: selection.selectionVersion,
        totalCount: selection.totalCount,
        selectedCount: selection.selectedCount,
        deferredCount: selection.deferredCount,
        maxTools: selection.maxTools,
        pinnedToolNames: selection.pinnedToolNames ?? [],
        selectedToolNames: selection.selectedToolNames,
        deferredToolNames: selection.deferredToolNames
      },
      observations: screenMissionObservationsForPlanning(mission.observations, {
        injectionDetector: this.observationInjectionDetector
      })
    },mission.waves.flatMap(wave=>wave.actions),mission.waves.flatMap(wave=>wave.actions)
      .filter(action=>action.goalRevision<(mission.goalContract?.revision??1)&&this.hasVerifiedUnpublishedPersonFailure(action)).map(action=>action.actionId));
  }

  remainingBudget(mission, startedAtMs = Date.now()) {
    return {
      waves: Math.max(0, mission.budgets.maxWaves - mission.waves.length),
      actions: Math.max(0, mission.budgets.maxActions - mission.metrics.executedActions),
      plannerCalls: Math.max(0, mission.budgets.maxPlannerCalls - mission.metrics.plannerCalls - Number(mission.metrics.plannerRetries ?? 0)),
      activeRuntimeMs: Math.max(0, mission.budgets.maxActiveRuntimeMs - mission.metrics.activeRuntimeMs - Math.max(0, Date.now() - startedAtMs))
    };
  }

  dependencyImpact(missionId) { return missionDependencyImpact(this,missionId); }
  dependencyImpacts(options) { return missionDependencyImpacts(this,options); }
  reconcileDependencyImpacts() { return reconcileMissionDependencyImpacts(this); }
  dependencyImpactEvents(options) { return listMissionDependencyImpactEvents(this,options); }
  setMoneyDependency(missionId,input) { return setMissionMoneyDependency(this,missionId,input); }
  quantityConstraints(missionId,input) { return assessMissionQuantityConstraints(this,missionId,input); }

  checkBudget(mission, startedAtMs, { forPlanning = true } = {}) {
    const remaining = this.remainingBudget(mission, startedAtMs);
    if (forPlanning && remaining.waves <= 0 && mission.waves.every((wave) => ['completed', 'completed_with_failures'].includes(wave.status))) {
      return { allowed: false, reason: 'mission-wave-budget-exhausted' };
    }
    if (remaining.actions <= 0) return { allowed: false, reason: 'mission-action-budget-exhausted' };
    if (forPlanning && remaining.plannerCalls <= 0) return { allowed: false, reason: 'mission-planner-budget-exhausted' };
    if (remaining.activeRuntimeMs <= 0) return { allowed: false, reason: 'mission-runtime-budget-exhausted' };
    return { allowed: true };
  }

  updatePlanStallState(mission, planned) {
    const fingerprint = semanticPlanFingerprint(planned);
    const previous = mission.planStall ?? { fingerprint: null, consecutiveCount: 0 };
    mission.planStall = {
      fingerprint,
      consecutiveCount: previous.fingerprint === fingerprint ? previous.consecutiveCount + 1 : 1,
      updatedAt: this.clock().toISOString()
    };
  }

  hasRepeatedFailure(mission) {
    return Object.values(mission.failureSignatures).some((count) => count >= mission.budgets.maxConsecutiveFailures);
  }

  pendingGates(mission) {
    return mission.gates.filter((gate) => gate.status === 'pending');
  }

  status() {
    const byStatus = {};
    for (const mission of this.missions.values()) byStatus[mission.status] = (byStatus[mission.status] ?? 0) + 1;
    return {
      runtimeVersion: 'a-autonomous-mission-runtime-v1',
      executionMode:this.executionAuthority?.recoveryOnly?'recovery-only':'standard',
      missionCount: this.missions.size,
      activeRunCount: this.activeRuns.size,
      byStatus,
      pendingGateCount: [...this.missions.values()].reduce((count, mission) => count + this.pendingGates(mission).length, 0),
      capabilityCount: this.capabilityCatalog().length,
      persistence: this.store.metadata?.() ?? { enabled: false }
    };
  }

  lifecycleCaseDependencies(mission,{ownerSessionId=null}={}){return {readTask:id=>{
    const task=this.coreFacade.getTask(id);if(task)return task;
    const actions=mission.waves.flatMap(w=>w.actions).filter(a=>a.taskId===id);
    return actions.length===1?this.lifecycleCaseAccess?.readRecoveredTask?.(mission,actions[0])??null:null;
  },readCurrentSnapshot:r=>this.lifecycleCaseAccess?.readCurrentSnapshot(r),beforeRead:(action,task)=>{
    if(['CANCELLED','FAILED','BLOCKED'].includes(mission.status)||!task)throw Error('A_LIFECYCLE_CASE_AUTHORITY_DENIED');
    if(ownerSessionId&&(mission.status!==MissionStatus.COMPLETED||!lifecycleCaseGoalBound(mission)||mission.authorization.mode!=='trusted_session'||!mission.authorization.grants.includes('read_only')))throw Error('A_LIFECYCLE_CASE_AUTHORITY_DENIED');
    if(mission.authorization.mode==='trusted_session'&&this.ownerSessionManager?.authorizeMission({sessionId:ownerSessionId??mission.authorization.ownerSessionId,requestedGrants:[ownerSessionId?'read_only':this.capabilityProfile(task).executionClass]})?.allowed!==true)throw Error('A_LIFECYCLE_CASE_AUTHORITY_DENIED');
    if(mission.executionMandateId&&!this.executionBudget)throw Error('A_MANDATE_SERVICE_UNAVAILABLE');
    this.executionBudget?.beforeSourceResultRead(mission,{action:action.operation.dispatch,workspaceRoot:this.allowedRoots[0]});
    if(task.recoveredLifecycleCaseReceipt)this.lifecycleCaseAccess?.revalidateReadBinding?.(action.operation.dispatch.arguments);
    if(this.lifecycleCaseAccess?.authorizeRequest(action.operation.dispatch.arguments,{taskId:task.taskId,action:task.plan.action})!==true)throw Error('A_LIFECYCLE_CASE_AUTHORITY_DENIED');
  }};}
  getVerifiedLifecycleCaseResult(missionId,readAuthorization={}){const mission=this.missions.get(missionId);if(!mission)return failure('A_MISSION_NOT_FOUND','Mission not found.');
    if(mission.status!==MissionStatus.COMPLETED)return {success:false,status:'unverified',reasons:['lifecycle-case-mission-not-completed']};
    const proof=collectLifecycleCaseResult(mission,this.lifecycleCaseDependencies(mission,readAuthorization));
    return proof.passed?{success:true,status:'verified',missionId,result:proof.snapshot,humanReadConfirmed:false,providerVerified:false}:{success:false,status:'unverified',reasons:proof.reasons};
  }
  microsoftCollectionLimit(mission){
    try{return microsoftCollectionPageLimit(mission,m=>this.microsoftCollectionAccess.resolvePageLimit(m));}
    catch{return null;}
  }
  extendMicrosoftCollectionLimit(missionId,input){
    const mission=this.missions.get(missionId);
    if(!mission)return failure('A_MISSION_NOT_FOUND','Mission was not found.');
    try{
      this.executionAuthority?.assertActive();
      if(!input||Object.keys(input).sort().join(',')!=='expectedMaxPages,extensionId,maxPages,ownerSessionId'
        ||!/^ms_limit_[a-zA-Z0-9-]{1,100}$/u.test(input.extensionId??'')||!Number.isSafeInteger(input.maxPages)||input.maxPages>50
        ||!Number.isSafeInteger(input.expectedMaxPages)||input.expectedMaxPages<1||input.maxPages<=input.expectedMaxPages)throw Error('A_MICROSOFT_LIMIT_INVALID');
      if(!microsoftCollectionGoalBound(mission)||mission.microsoftCollection.version!=='microsoft-collection-pages-goal-v1'
        ||mission.authorization.mode!=='trusted_session'||input.ownerSessionId!==mission.authorization.ownerSessionId
        ||!mission.authorization.grants.includes('read_only')||!mission.authorization.grants.includes('high_impact')
        ||this.ownerSessionManager?.authorizeMission({sessionId:input.ownerSessionId,requestedGrants:['read_only','high_impact']})?.allowed!==true)throw Error('A_MICROSOFT_LIMIT_AUTHORITY_REQUIRED');
      const limit=this.microsoftCollectionLimit(mission);if(limit===null)throw Error('A_MICROSOFT_LIMIT_PROOF_INVALID');
      const prior=(mission.microsoftCollectionLimitExtensions??[]).find(row=>JSON.parse(row.body).extensionId===input.extensionId);
      if(prior){const d=JSON.parse(prior.body);if(d.expectedMaxPages!==input.expectedMaxPages||d.maxPages!==input.maxPages)throw Error('A_MICROSOFT_LIMIT_CONFLICT');return this.publicMission(mission);}
      if(this.activeRuns.has(missionId)||mission.status!==MissionStatus.PAUSED||mission.stopReason!=='microsoft-collection-page-limit'
        ||limit!==input.expectedMaxPages)throw Error('A_MICROSOFT_LIMIT_CONFLICT');
      const proof=collectMicrosoftCollectionResult(mission,this.microsoftCollectionDependencies(mission),{allowPartial:true});
      if(!proof.passed||proof.complete||proof.reasons[0]!=='microsoft-collection-page-limit')throw Error('A_MICROSOFT_LIMIT_CURRENT_RESULT_REQUIRED');
      const row=this.microsoftCollectionAccess.signLimitExtension(mission,{...input,observedAt:this.clock().toISOString()});
      const priorState={extensions:mission.microsoftCollectionLimitExtensions,budgets:mission.budgets,stopReason:mission.stopReason,updatedAt:mission.updatedAt,revision:mission.revision};
      mission.microsoftCollectionLimitExtensions=[...(mission.microsoftCollectionLimitExtensions??[]),row];
      mission.budgets=normalizeBudgets({...mission.budgets,maxWaves:Math.max(mission.budgets.maxWaves,input.maxPages),maxActions:Math.max(mission.budgets.maxActions,input.maxPages)});
      mission.stopReason='microsoft-collection-limit-extended';
      try{this.touch(mission,'mission-microsoft-collection-limit-extended');}
      catch(error){mission.microsoftCollectionLimitExtensions=priorState.extensions;mission.budgets=priorState.budgets;mission.stopReason=priorState.stopReason;mission.updatedAt=priorState.updatedAt;mission.revision=priorState.revision;throw error;}
      this.recordEvent('mission.microsoft-collection.limit-extended',mission,{extensionId:input.extensionId,previousMaxPages:limit,maxPages:input.maxPages,executionAuthorized:false});
      return this.publicMission(mission);
    }catch(error){return failure(error.code??error.message??'A_MICROSOFT_LIMIT_EXTENSION_FAILED','Collection limit was not changed.',{missionId});}
  }
  microsoftCollectionScopeBinding(mission,action,profile,task=null){
    try {
      if(!microsoftCollectionGoalBound(mission)||mission.microsoftCollection.version!=='microsoft-collection-pages-goal-v1'
        ||mission.authorization.mode!=='trusted_session'||!mission.authorization.grants.includes('read_only')
        ||!mission.authorization.grants.includes('high_impact')||profile.toolName!=='source.collectMicrosoftMetadata'
        ||profile.externalTransfer||!profile.externalNetwork||!profile.mutatesSystem
        ||task?.policy?.constraints?.allowExternalTransfer===true||task?.policy?.constraints?.allowAdminPrivilege===true)return null;
      const owner=this.ownerSessionManager?.authorizeMission({sessionId:mission.authorization.ownerSessionId,requestedGrants:['read_only']});
      if(owner?.allowed!==true||this.ownerSessionManager?.authorizeMission({sessionId:mission.authorization.ownerSessionId,requestedGrants:['high_impact']})?.allowed!==true)return null;
      const request=task?.plan?.action?.arguments??action.operation?.dispatch?.arguments??action.arguments;
      if(!this.microsoftCollectionRequestBound(mission,action,request))return null;
      return {version:'microsoft-pagination-approval-scope-v1',missionId:mission.missionId,
        goalDigest:mission.microsoftCollection.goalDigest,goalRevision:mission.goalContract.revision,
        authorizationRevision:mission.authorizationRevision??1,ownerSessionId:mission.authorization.ownerSessionId,
        requestSha256:sha256(JSON.stringify(normalizeMicrosoftCollection(mission.microsoftCollection.request))),
        maxPages:this.microsoftCollectionLimit(mission)};
    } catch {return null;}
  }
  microsoftCollectionApprovalScope(mission,action,profile,task=null){
    const current=this.microsoftCollectionScopeBinding(mission,action,profile,task);
    if(!current)return null;
    const now=Date.parse(this.clock().toISOString());
    return mission.gates.find(g=>g.type==='action_approval'&&g.status==='approved'&&g.decision==='approve'
      &&g.toolName==='source.collectMicrosoftMetadata'&&g.goalRevision===current.goalRevision
      &&g.authorizationRevision===current.authorizationRevision&&Date.parse(g.approvalExpiresAt??'')>now
      &&isDeepStrictEqual(g.microsoftPaginationScope,current))??null;
  }
  microsoftCollectionPageAllowed(mission,action,page){
    try{
      if(!microsoftCollectionGoalBound(mission)||mission.microsoftCollection.version!=='microsoft-collection-pages-goal-v1')return false;
      const actions=mission.waves.flatMap(w=>w.actions),index=actions.findIndex(a=>a.actionId===action.actionId);
      if(index<0||index>=this.microsoftCollectionLimit(mission))return false;
      if(index===0)return page.cursor===null;
      const previous=new Set(actions.slice(0,index).map(a=>a.actionId));
      const prefix={...mission,waves:mission.waves.map(w=>({...w,actions:w.actions.filter(a=>previous.has(a.actionId))}))};
      const proof=collectMicrosoftCollectionResult(prefix,this.microsoftCollectionDependencies(mission),{allowPartial:true});
      if(!proof.passed||proof.complete||page.cursor!==proof.nextCursor)return false;
      const ids=new Set(proof.actionReceipts.flatMap(r=>r.page.items.map(item=>item.id)));
      const cursors=new Set([page.cursor,...proof.actionReceipts.map(r=>r.page.cursor)]);
      return !page.items.some(item=>ids.has(item.id))&&(page.nextCursor===null||!cursors.has(page.nextCursor));
    }catch{return false;}
  }
  microsoftCollectionRequestBound(mission,action,request){
    try{
      if(!microsoftCollectionGoalBound(mission))return false;
      const actions=mission.waves.flatMap(w=>w.actions),index=actions.findIndex(a=>a.actionId===action.actionId);
      if(index<0||index>=this.microsoftCollectionLimit(mission))return false;
      if(index===0)return isDeepStrictEqual(normalizeMicrosoftCollection(request),normalizeMicrosoftCollection({...mission.microsoftCollection.request,cursor:null}));
      let current=null;
      try{current=this.microsoftCollectionAccess.readOperationReceipt(action.taskId,request);}catch{}
      const previous=new Set(actions.slice(0,index).map(a=>a.actionId));
      const prefix={...mission,waves:mission.waves.map(w=>({...w,actions:w.actions.filter(a=>previous.has(a.actionId))}))};
      const deps=this.microsoftCollectionDependencies(mission);
      const proof=collectMicrosoftCollectionResult(prefix,{...deps,verifyCollectionPages:pages=>deps.verifyCollectionPages(current?[...pages,current.page]:pages)},
        {allowPartial:true,historicalTail:!!current});
      if(!proof.passed||proof.complete||proof.nextCursor===null)return false;
      const expected=normalizeMicrosoftCollection({...mission.microsoftCollection.request,cursor:proof.nextCursor});
      return isDeepStrictEqual(normalizeMicrosoftCollection(request),expected);
    }catch{return false;}
  }
  microsoftCollectionDependencies(mission,{ownerSessionId=null}={}){
    const readTask=id=>{const task=this.coreFacade.getTask(id);if(task)return task;
      // Recovered contents must not be materialized under the dead old session.
      if(!ownerSessionId||mission.status!==MissionStatus.COMPLETED||this.ownerSessionManager?.authorizeMission({sessionId:ownerSessionId,requestedGrants:['read_only']})?.allowed!==true)return null;
      const actions=mission.waves.flatMap(w=>w.actions).filter(a=>a.taskId===id);
      return actions.length===1?this.microsoftCollectionAccess?.readRecoveredTask?.(mission,actions[0])??null:null;
    };
    return {
    readTask,
    readCommittedReceipt:(id,r,options)=>this.microsoftCollectionAccess?.readCommittedReceipt(id,r,{...options,recoveredTask:readTask(id)}),
    resolvePageLimit:m=>this.microsoftCollectionAccess.resolvePageLimit(m),
    verifyCollectionPages:pages=>this.microsoftCollectionAccess?.verifyCollectionPages?.(pages),
    beforeRead:(action,task)=>{
      if(!microsoftCollectionGoalBound(mission)||['CANCELLED','FAILED','BLOCKED'].includes(mission.status)||!task)throw Error('A_MICROSOFT_EFFECT_RESULT_DENIED');
      if(task.recoveredMicrosoftCollectionReceipt&&(!ownerSessionId||mission.status!==MissionStatus.COMPLETED))throw Error('A_MICROSOFT_CURRENT_READ_AUTHORIZATION_REQUIRED');
      if(ownerSessionId&&mission.status!==MissionStatus.COMPLETED)throw Error('A_MICROSOFT_EFFECT_RESULT_DENIED');
      if((ownerSessionId||mission.authorization.mode==='trusted_session')&&this.ownerSessionManager?.authorizeMission({sessionId:ownerSessionId??mission.authorization.ownerSessionId,requestedGrants:['read_only']})?.allowed!==true)throw Error('A_MICROSOFT_EFFECT_RESULT_DENIED');
      if(mission.executionMandateId&&!this.executionBudget)throw Error('A_MANDATE_SERVICE_UNAVAILABLE');
      this.executionBudget?.beforeSourceResultRead(mission,{action:action.operation.dispatch,workspaceRoot:this.allowedRoots[0]});
    }
  };}
  getVerifiedMicrosoftCollectionResult(missionId,{ownerSessionId=null}={}){const mission=this.missions.get(missionId);
    if(!mission)return failure('A_MISSION_NOT_FOUND','Mission not found.');
    if(mission.status!==MissionStatus.COMPLETED)return {success:false,status:'unverified',reasons:['microsoft-collection-mission-not-completed']};
    const proof=collectMicrosoftCollectionResult(mission,this.microsoftCollectionDependencies(mission,{ownerSessionId}));
    return proof.passed?{success:true,status:'verified',missionId,result:proof.receipt,allPages:mission.microsoftCollection.version==='microsoft-collection-pages-goal-v1',snapshotVerified:false}:{success:false,status:'unverified',reasons:proof.reasons};
  }
  selectedSourceDependencies(mission,{ownerSessionId=null}={}){
    return {readTask:id=>{
      const task=this.coreFacade.getTask(id);if(task)return task;
      const actions=mission.waves.flatMap(w=>w.actions).filter(a=>a.taskId===id);
      return actions.length===1?this.selectedSourceAccess?.readRecoveredTask?.(mission,actions[0])??null:null;
    },readCurrentSnapshot:request=>{
      if(typeof this.selectedSourceAccess?.readCurrentSnapshot!=='function')throw new Error('A_SELECTED_SOURCE_UNAVAILABLE');
      return this.selectedSourceAccess.readCurrentSnapshot(request);
    },beforeRead:(action,task)=>{
      if(!selectedSourceGoalBound(mission)||['CANCELLED','FAILED','BLOCKED'].includes(mission.status))throw new Error('A_SELECTED_SOURCE_AUTHORITY_DENIED');
      if(task.recoveredSelectedSourceReceipt&&(!ownerSessionId||mission.status!==MissionStatus.COMPLETED))throw new Error('A_SELECTED_SOURCE_CURRENT_READ_AUTHORIZATION_REQUIRED');
      if(mission.authorization.mode==='trusted_session'&&this.ownerSessionManager?.authorizeMission({sessionId:ownerSessionId??mission.authorization.ownerSessionId,
        requestedGrants:[ownerSessionId&&mission.status===MissionStatus.COMPLETED?'read_only':this.capabilityProfile(task).executionClass]})?.allowed!==true)throw new Error('A_SELECTED_SOURCE_AUTHORITY_DENIED');
      if(mission.executionMandateId&&!this.executionBudget)throw new Error('A_MANDATE_SERVICE_UNAVAILABLE');
      this.executionBudget?.beforeSourceResultRead(mission,{action:action.operation.dispatch,workspaceRoot:this.allowedRoots[0]});
      const args=action.operation.dispatch.arguments,{rawText,...request}=args;
      if(task.recoveredSelectedSourceReceipt)this.selectedSourceAccess?.revalidateReadBinding?.(request);
      if(this.selectedSourceAccess?.authorizeRequest(request,{taskId:task.taskId,action:task.plan.action})!==true)throw new Error('A_SELECTED_SOURCE_AUTHORITY_DENIED');
    }};
  }

  getVerifiedSelectedSourceResult(missionId,{ownerSessionId=null}={}){
    const mission=this.missions.get(missionId);
    if(!mission)return failure('A_MISSION_NOT_FOUND','Mission not found.');
    if(mission.status!==MissionStatus.COMPLETED)return {success:false,status:'unverified',reasons:['selected-source-mission-not-completed']};
    if(ownerSessionId!==null&&this.ownerSessionManager?.authorizeMission({sessionId:ownerSessionId,requestedGrants:['read_only']})?.allowed!==true)
      return {success:false,status:'unverified',reasons:['selected-source-current-read-authorization-denied']};
    const proof=collectSelectedSourceResult(mission,this.selectedSourceDependencies(mission,{ownerSessionId}));
    if(!proof.passed)return {success:false,status:'unverified',reasons:proof.reasons};
    return {success:true,status:'verified',missionId,result:{version:'selected-source-full-result-v1',provider:mission.selectedSource.provider,
      streamRef:mission.selectedSource.streamRef,revision:proof.revision,total:proof.total,items:proof.items,pageCount:proof.pages.length,
      readOnly:true,containsUntrustedText:true,providerObservationVerified:false,executionAuthority:false},
      evidenceActionIds:proof.evidenceActionIds,humanReadConfirmed:false};
  }

  publicMission(mission, { detail = true } = {}) {
    const workReference = publicMissionWorkReference(mission.metadata?.workReference);
    const base = {
      success: ![MissionStatus.BLOCKED, MissionStatus.FAILED].includes(mission.status),
      missionVersion: mission.missionVersion,
      missionId: mission.missionId,
      ...(mission.executionMandateId ? {executionMandateId:mission.executionMandateId} : {}),
      ...(mission.microsoftCollection?{microsoftCollection:structuredClone(mission.microsoftCollection),microsoftCollectionPageLimit:mission.microsoftCollection.version==='microsoft-collection-pages-goal-v1'?this.microsoftCollectionLimit(mission):null}:{}),
      ...(mission.selectedSource?{selectedSource:structuredClone(mission.selectedSource)}:{}),
      ...(mission.lifecycleCase?{lifecycleCase:structuredClone(mission.lifecycleCase)}:{}),
      objective: mission.objective,
      longTermMemory: mission.metadata?.longTermMemory !== false,
      ...(workReference ? { metadata: { workReference } } : {}),
      status: mission.status,
      stopReason: mission.stopReason,
      verificationStatus: mission.verificationSummary?.status ?? (mission.status === MissionStatus.COMPLETED ? 'unverified' : 'pending'),
      verificationSummary: structuredClone(mission.verificationSummary ?? {
        version: mission.verificationVersion ?? 'legacy', status: mission.status === MissionStatus.COMPLETED ? 'unverified' : 'pending',
        verifiedCount: 0, totalCount: mission.successCriteria.length, criteria: []
      }),
      uncertainEffectCount: this.uncertainEffectCount(mission),
      goalCompletionCoverage: structuredClone(mission.goalCompletionCoverage ?? null),
      successCriteria: structuredClone(mission.successCriteria),
      constraints: structuredClone(mission.constraints),
      budgets: structuredClone(mission.budgets),
      authorization: structuredClone(mission.authorization),
      authorizationRevision: mission.authorizationRevision ?? 1,
      metrics: structuredClone(mission.metrics),
      waveCount: mission.waves.length,
      pendingGates: structuredClone(this.pendingGates(mission)),
      completion: structuredClone(mission.completion),
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt
    };
    if (!detail) return base;
    return {
      ...base,
      goalContract: structuredClone(mission.goalContract ?? null),
      goalRevisionRequest: structuredClone(mission.goalRevisionRequest ?? null),
      goalRevisionHistory: structuredClone(mission.goalRevisionHistory ?? []),
      goalRevisionConflicts: structuredClone(mission.goalRevisionConflicts ?? []),
      goalRevisionEffects: structuredClone(mission.goalRevisionEffects ?? []),
      waves: structuredClone(mission.waves),
      gates: structuredClone(mission.gates),
      observations: structuredClone(mission.observations),
      planHistory: structuredClone(mission.planHistory),
      recovery: structuredClone(mission.recovery),
      lastError: structuredClone(mission.lastError ?? null),
      capabilityCatalog: this.capabilityCatalog()
    };
  }

  uncertainEffectCount(mission) {
    const actions = mission.waves.flatMap(wave => wave.actions);
    return actions.filter(action => action.operation?.state === 'uncertain' || action.effect?.state === 'uncertain'
      || (action.recovery?.required === true && !terminalActionStatuses.has(action.status))
      || mission.observations.some(observation => observation.actionId === action.actionId && observation.outcome === 'uncertain'
        && !mission.observations.some(later => later.actionId === action.actionId && later.outcome === 'success'
          && later.verification?.status === 'passed' && later.createdAt >= observation.createdAt
          && Boolean(action.operation?.operationId) && later.recovery?.operationId === action.operation.operationId
          && later.recovery?.reverified === true))).length;
  }

  touch(mission, reason) {
    mission.updatedAt = this.clock().toISOString();
    mission.revision = (mission.revision ?? 0) + 1;
    this.persist(reason);
  }

  persist(reason, { effects = [] } = {}) {
    this.persistSequence += 1;
    return this.store.save?.([...this.missions.values()].map((mission) => structuredClone(mission)), {
      reason: `${reason}:${this.persistSequence}`,
      ...(effects.length ? { effects } : {})
    });
  }

  recordEvent(eventType, mission, details = {}) {
    const event = {
      eventVersion: 'a-mission-event-v1',
      eventType,
      missionId: mission.missionId,
      objectiveHash: mission.objectiveHash,
      status: mission.status,
      details,
      rawObjectiveStored: false,
      createdAt: this.clock().toISOString()
    };
    if (this.eventLogPath) appendJsonlSync(this.eventLogPath, event);
    this.coreFacade.eventBus?.publish?.(eventType, {
      missionId: mission.missionId,
      status: mission.status,
      ...details
    });
    return event;
  }
}

function publicMissionWorkReference(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || typeof reference.artifactId !== 'string' || !reference.artifactId.trim() || reference.artifactId.length > 160
    || typeof reference.path !== 'string' || !isAbsolute(reference.path) || reference.path.length > 32_768
    || /[\u0000-\u001f\u007f]/u.test(reference.path)
    || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(reference.sha256)
    || !Number.isSafeInteger(reference.size) || reference.size < 0
    || !Number.isSafeInteger(reference.version) || reference.version < 1) return null;
  return {
    artifactId: reference.artifactId,
    path: reference.path,
    sha256: reference.sha256,
    size: reference.size,
    version: reference.version
  };
}

function requiresEmailCommitEvidence(value) {
  const clauses = String(value ?? '').split(/[.\n]/u);
  const koreanMail = '(?:(?:내|제|사용자(?:의)?)\\s*)?(?:(?:구글\\s*)?(?:이메일|메일)|Gmail|SMTP)';
  const koreanCommit = '(?:보내(?:줘|라|세요|십시오|놔|두|고|기|자|면|야|도록)?|(?:전송|발송)(?!률|량|속도|비용|건수|현황|내역|기록|데이터|통계|지표))';
  const mailThenCommit = new RegExp(`${koreanMail}[^.\\n]{0,160}${koreanCommit}`, 'iu');
  const commitThenMail = new RegExp(`${koreanCommit}[^.\\n]{0,160}${koreanMail}(?:\\s*(?:로|으로|에))?`, 'iu');
  const englishMailThenCommit = /\b(?:e-?mail|gmail|smtp)\b[^.\n]{0,160}\b(?:send|sent|sending|deliver(?:y|ed|ing)?|dispatch(?:ed|ing)?|transmit(?:ted|ting)?)\b/iu;
  const englishCommitThenMail = /\b(?:send|sent|sending|deliver(?:ed|ing)?|dispatch(?:ed|ing)?|transmit(?:ted|ting)?)\b[^.\n]{0,160}\b(?:e-?mail|gmail|smtp)\b/iu;
  return clauses.some((clause) => (
    mailThenCommit.test(clause)
    || commitThenMail.test(clause)
    || englishMailThenCommit.test(clause)
    || englishCommitThenMail.test(clause)
  ));
}

function semanticPlanFingerprint(planned) {
  if (planned?.decision === 'complete') {
    const criteria = (planned.criteriaAssessment ?? []).map((item) => ({
      criterionId: item?.criterionId ?? null,
      status: item?.status ?? null,
      evidenceActionIds: [...new Set(item?.evidenceActionIds ?? [])].sort()
    })).sort((left, right) => String(left.criterionId).localeCompare(String(right.criterionId)));
    return sha256(JSON.stringify({ decision: 'complete', criteria }));
  }
  if (planned?.decision !== 'continue') {
    return planned?.fingerprint ?? sha256(JSON.stringify(planned?.actions ?? []));
  }
  const signatures = (planned.actions ?? []).map((action) => {
    const command = String(action.command ?? '').toLowerCase();
    const namedFiles = [...new Set(command.match(/[\p{L}\p{N}_-]+\.[a-z0-9]{1,12}/giu) ?? [])].sort();
    return {
      toolName: action.expectedToolName ?? null,
      ...(action.expectedToolName==='source.collectMicrosoftMetadata'?{metadataPage:(()=>{try{return normalizeMicrosoftCollection(action.arguments);}catch{return null;}})()}:{}),
      targetFiles: namedFiles,
      requirementIds: Array.isArray(action.requirementIds) ? [...action.requirementIds].sort() : [],
      constraintRequirementIds: Array.isArray(action.constraintRequirementIds) ? [...action.constraintRequirementIds].sort() : [],
      ...(action.expectedToolName === 'filesystem.readText' ? {readRange: {
        path: typeof action.arguments?.path === 'string' ? action.arguments.path : null,
        offset: action.arguments?.offset === undefined ? 0 : action.arguments.offset,
        maxChars: action.arguments?.maxChars === undefined ? 12000 : action.arguments.maxChars
      }} : {}),
      ...(action.expectedToolName==='document.readPdf'?{pdfReadRange:{path:action.arguments?.path??null,
        firstPage:action.arguments?.firstPage??1,maxPages:action.arguments?.maxPages??10,expectedSha256:action.arguments?.expectedSha256??null}}:{}),
      ...(action.expectedToolName==='excel.readWorkbook'?{xlsxReadRange:{path:action.arguments?.path??null,
        sheetName:action.arguments?.sheetName??null,range:action.arguments?.range??'A1:J100',expectedSha256:action.arguments?.expectedSha256??null}}:{}),
      ...(action.expectedToolName==='source.readSelectedInbox'?{selectedSourceRange:{
        provider:action.arguments?.provider??null,streamRef:action.arguments?.streamRef??null,
        offset:action.arguments?.offset??0,limit:action.arguments?.limit??100,
        expectedRevision:action.arguments?.expectedRevision??null}}:{}),
      command: namedFiles.length > 0 ? null : command.replace(/\s+/g, ' ').trim()
    };
  });
  return sha256(JSON.stringify({ decision: planned.decision, actions: signatures }));
}

function verifyNamedArtifactAbsence({ mission, observations, references, allowedRoot }) {
  const actionRecords = (mission.waves ?? []).flatMap((wave) => wave.actions ?? [])
    .map((action, index) => ({ action, index }));
  const actionById = new Map(actionRecords.map((record) => [record.action.actionId, record]));
  const successfulObservations = new Map((mission.observations ?? [])
    .filter((item) => item.outcome === 'success' && item.verification?.status === 'passed')
    .map((item) => [item.actionId, item]));
  const selected = observations.filter((item) => item.outcome === 'success' && item.verification?.status === 'passed');
  const uniqueTargets = [...new Map(references.map((reference) => {
    const target = absenceTarget(reference, allowedRoot);
    return [target.absolute ?? target.relative, target];
  })).values()];
  const results = uniqueTargets.map((target) => {
    const mutations = actionRecords.filter(({ action }) => {
      const observation = successfulObservations.get(action.actionId);
      if (!observation) return false;
      if (actionTool(action, observation) === 'filesystem.moveFiles') {
        return missionMoves(action).some((move) => pathMatchesAbsenceTarget(move.from, target, allowedRoot)
          || pathMatchesAbsenceTarget(move.to, target, allowedRoot));
      }
      return (observation.artifacts ?? []).some((artifact) => pathMatchesAbsenceTarget(artifact.relativePath ?? artifact.name, target, allowedRoot))
        || producedActionPaths(action).some((path) => pathMatchesAbsenceTarget(path, target, allowedRoot));
    });
    const lastMutationIndex = mutations.length ? Math.max(...mutations.map((record) => record.index)) : -1;
    const proofs = selected.flatMap((observation) => {
      const record = actionById.get(observation.actionId);
      if (!record) return [];
      const toolName = actionTool(record.action, observation);
      if (toolName === 'filesystem.moveFiles') {
        const exactMove = missionMoves(record.action).some((move) => pathMatchesAbsenceTarget(move.from, target, allowedRoot)
          && !pathMatchesAbsenceTarget(move.to, target, allowedRoot));
        return exactMove && record.index === lastMutationIndex
          ? [{ actionId: observation.actionId, evidenceType: 'exact-move-source-removed', actionIndex: record.index }]
          : [];
      }
      if (record.index <= lastMutationIndex) return [];
      if (toolName === 'filesystem.listFiles') {
        const items = exhaustiveListingItems(observation.data, record.action.arguments);
        const exactDirectory = directoryMatchesAbsenceTarget(record.action.arguments?.directory ?? record.action.arguments?.path, target, allowedRoot);
        const absent = Array.isArray(items) && !items.some((item) => String(item?.name ?? '').toLowerCase() === target.name);
        return exactDirectory && absent
          ? [{ actionId: observation.actionId, evidenceType: 'exact-directory-list-absent', actionIndex: record.index }]
          : [];
      }
      if (toolName === 'filesystem.searchFiles') {
        const args = record.action.arguments ?? {};
        const exactQuery = String(args.query ?? '').trim().toLowerCase() === target.name;
        const unfiltered = !String(args.contentQuery ?? '').trim() && args.modifiedWithinDays == null;
        const workspaceScope = args.scope === 'workspace';
        const directories = Array.isArray(args.directories) ? args.directories : [args.directory ?? allowedRoot];
        const relevantDirectory = directories.some(directory => directoryMatchesAbsenceTarget(directory, target, allowedRoot)
          || sameComparablePath(directory, allowedRoot));
        return searchCoverageAllowsAbsence(observation.data) && exactQuery && unfiltered && workspaceScope && relevantDirectory && Array.isArray(observation.data?.matches) && observation.data.matches.length === 0
          ? [{ actionId: observation.actionId, evidenceType: 'exact-search-no-match', actionIndex: record.index }]
          : [];
      }
      return [];
    });
    return { path: target.relative, lastMutationIndex, proofs };
  });
  return {
    checkId: 'named_artifact_absence_verified',
    passed: results.length > 0 && results.every((item) => item.proofs.length > 0),
    expected: results.map((item) => item.path),
    observed: results
  };
}

function absenceTarget(reference, allowedRoot) {
  const relativePath = comparablePath(reference[0]);
  const absolute = isAbsolute(reference[0])
    ? comparablePath(resolve(reference[0]))
    : allowedRoot ? comparablePath(resolve(allowedRoot, reference[0])) : null;
  return { relative: relativePath, absolute, name: String(reference[1]).toLowerCase() };
}

function comparablePath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/u, '').toLowerCase();
}

function candidatePath(value, allowedRoot) {
  if (!value) return null;
  return comparablePath(isAbsolute(value) ? resolve(value) : allowedRoot ? resolve(allowedRoot, value) : value);
}

function pathMatchesAbsenceTarget(value, target, allowedRoot) {
  const candidate = candidatePath(value, allowedRoot);
  if (!candidate) return false;
  return target.absolute ? candidate === target.absolute : candidate === target.relative || candidate.endsWith(`/${target.relative}`);
}

function directoryMatchesAbsenceTarget(value, target, allowedRoot) {
  const candidate = candidatePath(value, allowedRoot);
  const expected = target.absolute ? comparablePath(dirname(target.absolute)) : comparablePath(dirname(target.relative));
  return Boolean(candidate && (candidate === expected || (!target.absolute && candidate.endsWith(`/${expected}`))));
}

function sameComparablePath(left, right) {
  return Boolean(left && right && candidatePath(left, right) === comparablePath(resolve(right)));
}

function countStructuredDocumentItems(argumentsValue = {}) {
  const items = [];
  if (argumentsValue?.title) items.push(argumentsValue.title);
  for (const block of Array.isArray(argumentsValue?.blocks) ? argumentsValue.blocks : []) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type ?? '').toLowerCase();
    if (type === 'bullets') {
      items.push(...(Array.isArray(block.items) ? block.items : []));
    } else if (type === 'table') {
      const columns = Array.isArray(block.columns)
        ? block.columns
        : Array.isArray(block.headers) ? block.headers : [];
      items.push(...columns);
      for (const row of Array.isArray(block.rows) ? block.rows : []) {
        items.push(...(Array.isArray(row) ? row : [row]));
      }
    } else if (block.text != null) {
      items.push(block.text);
    }
  }
  return items.filter((item) => String(item ?? '').trim()).length;
}

function countStructuredDocumentTables(argumentsValue = {}) {
  return (Array.isArray(argumentsValue?.blocks) ? argumentsValue.blocks : [])
    .filter((block) => String(block?.type ?? '').toLowerCase() === 'table').length;
}

function actionTool(action, observation) {
  return observation?.toolName ?? action.actualToolName ?? action.expectedToolName;
}

function missionMoves(action) {
  const args = action.arguments ?? {};
  return args.moves ?? (args.from && args.to ? [{ from: args.from, to: args.to }] : []);
}

function producedActionPaths(action) {
  const args = action.arguments ?? {};
  return [args.path, args.outputPath, args.targetPath].filter(Boolean);
}

function normalizeSuccessCriteria(value, objectiveLength) {
  const input = Array.isArray(value) ? value : [value];
  if (input.length > 20) throw Object.assign(new Error('A mission supports at most 20 explicit success criteria; none may be silently discarded.'), { code: 'A_MISSION_CRITERION_INVALID' });
  const criteria = input.map((criterion, index) => {
    const object = criterion && typeof criterion === 'object' && !Array.isArray(criterion);
    const statement = object ? criterion.statement : criterion;
    if (typeof statement !== 'string' || !statement.trim() || statement.length > 1000
      || (object && criterion.criterionId !== undefined && (typeof criterion.criterionId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(criterion.criterionId)))) {
      throw Object.assign(new Error('Each success criterion needs a bounded nonempty statement and a valid ID.'), { code: 'A_MISSION_CRITERION_INVALID' });
    }
    const extensions = object ? normalizeCriterionExtensions(criterion, { objectiveLength }) : {};
    return {
      criterionId: object && criterion.criterionId !== undefined ? criterion.criterionId : `criterion_${index + 1}`,
      statement: cleanText(statement, 1000),
      ...extensions
    };
  });
  if (new Set(criteria.map(criterion => criterion.criterionId)).size !== criteria.length) throw Object.assign(new Error('Mission criterion IDs must be unique.'), { code: 'A_MISSION_CRITERION_INVALID' });
  return criteria;
}

function normalizeConstraints(value) {
  const invalid = () => Object.assign(new Error('Constraints must be nonempty text up to 1000 characters with unique IDs; at most 30 constraints are allowed. No constraints were discarded.'), { code: 'A_MISSION_CONSTRAINT_INVALID' });
  const input = Array.isArray(value) ? value : [value];
  if (input.length > 30) throw invalid();
  const result = input.map((constraint, index) => {
    const object = constraint && typeof constraint === 'object' && !Array.isArray(constraint);
    const statement = object ? constraint.statement : constraint;
    if (typeof statement !== 'string' || !statement.trim() || statement.length > 1000
      || (object && constraint.constraintId !== undefined
        && (typeof constraint.constraintId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(constraint.constraintId)))
      || (object && constraint.hard !== undefined && typeof constraint.hard !== 'boolean')) throw invalid();
    return { constraintId: object && constraint.constraintId ? constraint.constraintId : `constraint_${index + 1}`,
      statement, hard: object ? constraint.hard !== false : true };
  });
  if (new Set(result.map(item => item.constraintId)).size !== result.length) throw invalid();
  return result;
}

function normalizeBudgets(value = {}) {
  return {
    maxWaves: clampInteger(value.maxWaves, 1, 50, 12),
    maxActions: clampInteger(value.maxActions, 1, 200, 40),
    maxPlannerCalls: clampInteger(value.maxPlannerCalls, 1, 100, 20),
    maxConsecutiveFailures: clampInteger(value.maxConsecutiveFailures, 2, 10, 3),
    maxActiveRuntimeMs: clampInteger(value.maxActiveRuntimeMs, 10_000, 24 * 60 * 60 * 1000, 20 * 60 * 1000)
  };
}

function normalizeAuthorization(value = {}) {
  const requested = Array.isArray(value.grants) ? value.grants : [MissionGrant.READ_ONLY];
  const grants = [...new Set(requested.filter((grant) => acceptedGrants.has(grant)))];
  if (!grants.includes(MissionGrant.READ_ONLY)) grants.unshift(MissionGrant.READ_ONLY);
  return {
    authorizationVersion: 'a-mission-authorization-v1',
    mode: value.mode === 'trusted_session' ? 'trusted_session' : 'supervised',
    grants,
    ownerSessionId: value.mode === 'trusted_session' ? cleanIdentifier(value.ownerSessionId) : null,
    ownerSessionExpiresAt: value.mode === 'trusted_session' ? cleanIsoDate(value.ownerSessionExpiresAt) : null,
    externalCommitRequiresPerActionApproval: true,
    irreversibleCommitRequiresPerActionApproval: true
  };
}

function cleanIsoDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function normalizeConstraintsMetadataValue(value, depth = 0) {
  if (depth > 3) return null;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => normalizeConstraintsMetadataValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
      cleanIdentifier(key) ?? 'field',
      normalizeConstraintsMetadataValue(item, depth + 1)
    ]));
  }
  return null;
}

function sanitizeMetadata(value) {
  return normalizeConstraintsMetadataValue(value) ?? {};
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function cleanIdentifier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);
  return normalized || null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function normalizeContentSha256(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function isInside(root, target) {
  const offset = relative(root, target);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

function failure(code, message, extra = {}) {
  return { success: false, error: { code, message }, ...extra };
}


import {compileNaturalWorkflowObjective} from './natural-workflow-compiler.js';
