import { performance } from 'node:perf_hooks';
import { normalizePersonalContext } from './planning/personal-context.js';
import { createApprovalCard, createTaskRequest, InputSource, ModuleId, stableId, TaskStatus } from '../../shared/src/types.js';
import { beginJsonlBatchSync, commitJsonlBatchSync } from '../../shared/src/jsonl.js';
import { EventBus } from './runtime/event-bus.js';
import { TaskStateMachine } from './runtime/state-machine.js';
import { TaskLifecycle } from './runtime/task-lifecycle.js';
import { CorePerformanceTelemetry } from './runtime/core-performance-telemetry.js';
import { ExecutionHealthRegistry } from './routing/execution-health-registry.js';
import { CommandIntake } from './intake/command-intake.js';
import { IntentParser } from './intent/intent-parser.js';
import { AmbiguityResolver } from './intent/ambiguity-resolver.js';
import { ContextSnapshotBuilder } from './context/context-snapshot.js';
import { TaskPlanner } from './planning/task-planner.js';
import { sanitizeMissionArguments } from './planning/mission-action-arguments.js';
import { SkillRouter } from './routing/skill-router.js';
import { NexusSkillCenter } from './routing/nexus-skill-center.js';
import { AgentOrchestratorLite } from './orchestration/agent-orchestrator-lite.js';
import { OrchestrationJournal } from './orchestration/orchestration-journal.js';
import { createDefaultContractRegistry } from './contracts/default-contracts.js';
import { MacroStore } from './macro-store.js';
import { WorkMemory } from './conversation-memory.js';
import { workReferenceScope, resolveWorkReferenceContext, cleanWorkReferenceMetadata } from './work-reference-context.js';
import { normalizeMissionRoleAssignment } from './mission/mission-role-scope.js';
import { reservedMissionTaskId } from './mission/mission-task-reservation.js';
import {queryOwnerRelationships} from './context/owner-relationship-query.js';
import {parseMemoryRelationshipQuestion,relationshipMemoryReferences} from '../../../apps/growth-memory/src/personal-relationship-query.js';

const internalMissionPlanningCapability = Symbol('jarvis.internal-mission-planning');
const internalDeterministicPlanningCapability = Symbol('jarvis.internal-deterministic-planning');

export class CoreFacade {
  #missionRoleAssignments = new Map();

  constructor({
    policyEngine,
    memoryStore,
    verificationEngine,
    contractRegistry = createDefaultContractRegistry(),
    clock = () => new Date(),
    eventBus = null,
    eventLogPath = null,
    orchestrationJournalPath = null,
    cwd = () => process.cwd(),
    desktopContextProvider = null,
    desktopContextCollector = null,
    inputProviderRegistry = null,
    intentParser = null,
    taskPlanner = null,
    workspaceRoot = './workspace',
    macroStore = null,
    workMemory = null,
    durabilityBatching = true,
    performanceSampleLimit = 256,
    executionHealthRegistry = null,
    executionHealthPath = null,
    executionEnvironmentProfile = null,
    skillCenter = null,
    cognition = null,
    personalContextProvider = null
  } = {}) {
    this.policyEngine = policyEngine;
    this.memoryStore = memoryStore;
    this.verificationEngine = verificationEngine;
    this.contractRegistry = contractRegistry;
    this.clock = clock;
    this.eventBus = eventBus ?? new EventBus({ clock, eventLogPath });
    this.commandIntake = new CommandIntake({ clock, inputProviderRegistry });
    this.intentParser = intentParser ?? new IntentParser();
    this.localIntentParser = new IntentParser();
    this.ambiguityResolver = new AmbiguityResolver({ clock });
    this.contextBuilder = new ContextSnapshotBuilder({ cwd, clock, desktopContextProvider, desktopContextCollector });
    this.taskPlanner = taskPlanner ?? new TaskPlanner({ workspaceRoot });
    this.localTaskPlanner = new TaskPlanner({ workspaceRoot });
    this.macroStore = macroStore ?? new MacroStore();
    this.workMemory = workMemory ?? new WorkMemory({ clock });
    this.workspaceRoot = workspaceRoot;
    this.durabilityBatching = durabilityBatching !== false;
    this.operationDepth = 0;
    this.performanceTelemetry = new CorePerformanceTelemetry({
      clock,
      sampleLimit: performanceSampleLimit,
      durabilityBatching: this.durabilityBatching
    });
    this.executionHealthRegistry = executionHealthRegistry ?? new ExecutionHealthRegistry({
      clock,
      storePath: executionHealthPath
    });
    this.executionEnvironmentProfile = executionEnvironmentProfile;
    this.skillRouter = new SkillRouter({ executionHealthRegistry: this.executionHealthRegistry });
    this.skillCenter = skillCenter ?? new NexusSkillCenter({ clock });
    this.orchestrator = new AgentOrchestratorLite({
      clock,
      journal: new OrchestrationJournal({ clock, journalPath: orchestrationJournalPath ?? 'logs/core-orchestration.jsonl' })
    });
    this.tasks = new Map();
    // Trusted role assignments originate only from the private Mission planning capability.
    // Keep them outside mutable task/request objects so callers cannot forge or erase scope.
    this.cognition = cognition;
    this.personalContextProvider = personalContextProvider;
    if (cognition) {
      for (const topic of ['task.completed', 'task.failed', 'task.cancelled', 'task.replanned', 'task.retrying', 'approval.expired', 'compensation.completed', 'worker.execution.started']) {
        this.eventBus.subscribe(topic, event => cognition.updateTask(this.tasks.get(event.payload?.taskId ?? event.payload?.decision?.taskId)));
      }
    }
  }

  createTask(rawText, options = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('task.create', () => this.createTask(rawText, options));
    }
    const taskRequest = typeof rawText === 'object'
      ? rawText
      : createTaskRequest({
          rawText,
          deviceId: options.deviceId ?? 'mobile_lcb_001',
          inputMode: options.inputMode ?? 'text',
          source: options.source ?? InputSource.MOBILE,
          sourceModule: options.sourceModule ?? ModuleId.MOBILE,
          userId: options.userId ?? 'local_user',
          locale: options.locale ?? 'ko-KR',
          attachments: options.attachments ?? [],
          metadata: options.metadata ?? {},
          createdAt: options.createdAt ?? this.clock().toISOString()
        });
    return this.createTaskFromRequest(taskRequest, options);
  }

  queryRelationships({taskRequest,entity,depth,direction,limit}) {
    return queryOwnerRelationships({growth:this.memoryStore,cognition:this.cognition,workspaceRoot:this.workspaceRoot,
      personalContext:this.personalContextFor(String(entity??'')+'의 연결 관계',taskRequest?.userId,{includeRelations:true}),
      taskRequest,entity,depth,direction,limit});
  }

  queryTaskMemory(taskRequest,memoryScope) {
    const question=parseMemoryRelationshipQuestion(taskRequest.command.rawText);
    if(question && this.memoryStore?.personalKnowledge){
      try{return relationshipMemoryReferences(this.queryRelationships({taskRequest,...question}),memoryScope.scope);}
      catch{return [{memoryId:'relationship-evidence-unavailable',memoryType:'personal_relationship_notice',
        text:'관계의 기억 또는 실행 근거를 현재 조회할 수 없습니다. 확인 후 다시 조회해야 합니다.',requiresUserResolution:true}];}
    }
    return this.memoryStore?.query?.(taskRequest.command.rawText,memoryScope)??[];
  }

  createMissionActionTask(rawText, { expectedToolName = null, preparedArguments = null, workReferenceContext = null,
    workerRole = null, collaborationGroupId = null, reservedTaskId = null, ...options } = {}) {
    const role = normalizeMissionRoleAssignment({ workerRole, collaborationGroupId });
    if (!role.valid) throw Object.assign(new TypeError('Mission worker role assignment is invalid.'), { code: 'A_MISSION_ROLE_ASSIGNMENT_INVALID' });
    return this.createTask(rawText, {
      ...options,
      [internalMissionPlanningCapability]: {
        expectedToolName,
        reservedTaskId,
        preparedArguments,
        workReferenceContext: role.assignment ? null : workReferenceContext,
        roleAssignment: role.assignment
      }
    });
  }

  trustedMissionSelection(parsedIntent, hint, diagnostics = null) {
    const reject = reason => {
      if (diagnostics && typeof diagnostics === 'object') diagnostics.reason = reason;
      return null;
    };
    const toolName = typeof hint?.expectedToolName === 'string' ? hint.expectedToolName : '';
    const preparedArguments = sanitizeMissionArguments(toolName, hint?.preparedArguments);
    if (!toolName) return reject('expected-tool-missing');
    const localReadTools = new Set(['filesystem.listFiles', 'filesystem.searchFiles', 'filesystem.readText', 'document.readPdf', 'excel.readWorkbook']);
    if (!preparedArguments && !localReadTools.has(toolName)) {
      return reject(hint?.preparedArguments == null ? 'prepared-arguments-missing' : 'prepared-arguments-invalid');
    }
    const registered = this.skillRouter.capabilityMatrix().find((skill) => (
      skill.toolName === toolName && skill.lifecycle?.routable !== false
    ));
    if (!registered) return reject('registered-tool-unavailable');
    const inferredRoute = this.skillRouter.route(parsedIntent);
    if (localReadTools.has(toolName) && localReadTools.has(inferredRoute?.skill?.toolName)
      && inferredRoute.skill.toolName !== toolName) {
      // Preserve the normal safer-equivalent read route so Mission Runtime can
      // verify and record its explicit route adaptation instead of hiding it.
      return reject('safe-equivalent-local-read-route-preserved');
    }

    const slots = { ...(parsedIntent.slots ?? {}) };
    delete slots.workflow;
    delete slots.outputFormat;
    if (registered.match?.workflows?.length) slots.workflow = registered.match.workflows[0];
    if (registered.match?.outputFormats?.length) {
      const preparedPath = preparedArguments.path ?? preparedArguments.outputPath ?? preparedArguments.targetPath ?? '';
      const extension = String(preparedPath).match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase();
      slots.outputFormat = registered.match.outputFormats.includes(extension)
        ? extension
        : registered.match.outputFormats[0];
    }
    if (typeof preparedArguments?.query === 'string' && preparedArguments.query.trim()) {
      slots.query = preparedArguments.query.trim();
    }

    const candidate = {
      intentId: parsedIntent.intentId,
      label: registered.label,
      actionType: registered.actionType,
      category: registered.category,
      confidence: 1,
      reasons: [...(parsedIntent.reasons ?? []), `trusted-mission-tool:${toolName}`],
      riskHint: missionRiskHintForSkill(registered),
      slots,
      entities: parsedIntent.entities ?? {},
      missingSlots: [],
      complexity: {
        ...(parsedIntent.complexity ?? {}),
        matchedActionTypes: [registered.actionType],
        needsPlanDecomposition: false
      }
    };
    const route = this.skillRouter.routeTrustedCapability(candidate, toolName);
    if (!route?.routable) return reject('registered-tool-route-unavailable');
    if (route.skill?.toolName !== toolName || route.skill?.actionType !== candidate.actionType) {
      return reject('registered-tool-route-mismatch');
    }
    return {
      intent: {
        ...candidate,
        title: candidate.label,
        candidates: [candidate],
        unknown: false,
        trustedMissionTool: toolName
      },
      route,
      preparedArguments
    };
  }

  createInternalAuditTask(rawText, options = {}) {
    return this.createTask(rawText, {
      ...options,
      [internalDeterministicPlanningCapability]: true
    });
  }

  createCliTask(rawText, options = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('task.create.cli', () => this.createCliTask(rawText, options));
    }
    return this.createTaskFromRequest(this.commandIntake.fromCli(rawText, options), options);
  }

  createTaskFromRequest(taskRequest, options = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('task.create.request', () => this.createTaskFromRequest(taskRequest, options));
    }
    const internalMissionHint = options[internalMissionPlanningCapability];
    if(internalMissionHint?.reservedTaskId!==null&&internalMissionHint?.reservedTaskId!==undefined){
      const expected=reservedMissionTaskId(taskRequest.metadata?.missionId,taskRequest.metadata?.missionActionId);
      if(internalMissionHint.reservedTaskId!==expected||taskRequest.source?.type!==InputSource.TRIGGER
        ||taskRequest.source?.module!==ModuleId.CORE||taskRequest.source?.deviceId!=='mission_executive'){
        throw Object.assign(new Error('A_MISSION_TASK_RESERVATION_INVALID'),{code:'A_MISSION_TASK_RESERVATION_INVALID'});
      }
      if(this.tasks.has(expected))throw Object.assign(new Error('A_MISSION_TASK_RESERVATION_CONFLICT'),{code:'A_MISSION_TASK_RESERVATION_CONFLICT'});
      taskRequest={...taskRequest,taskId:expected};
    }else taskRequest = this.ensureUniqueTaskRequest(taskRequest);
    const roleAssignment = internalMissionHint?.roleAssignment ?? null;
    if (!roleAssignment) {
      taskRequest = this.expandMacro(taskRequest);
      taskRequest = this.resolveWorkReference(taskRequest, { referenceContext: internalMissionHint?.workReferenceContext });
    }
    this.contractRegistry.assert('TaskRequest', taskRequest);
    const machine = new TaskStateMachine(TaskStatus.CREATED, { clock: this.clock });
    this.eventBus.publish('task.requested', { taskRequest });
    machine.transition(TaskStatus.PLANNING, 'intent-parsing');

    const memoryScope = { scope: { userId: taskRequest.userId, workspaceRoot: this.workspaceRoot, conversationId: taskRequest.metadata?.conversationId ?? null } };
    const memoryContext = roleAssignment || taskRequest.metadata?.longTermMemory === false ? [] : this.queryTaskMemory(taskRequest,memoryScope);
    let planningContext = roleAssignment || taskRequest.metadata?.longTermMemory === false ? null : this.memoryStore?.planningPreferenceContext?.(taskRequest.command.rawText, memoryScope) ?? null;
    const selectedSkillProfile = this.skillCenter.profileForRequest(taskRequest.command.rawText);
    const skillCenterSelection = this.skillCenter.activateProfile(selectedSkillProfile.id, {
      request: taskRequest.command.rawText,
      limit: this.skillCenter.maxActive
    });
    const deterministicLocal = options[internalDeterministicPlanningCapability] === true;
    const trustedMissionSource = Boolean(
      internalMissionHint
      && taskRequest.source?.type === InputSource.TRIGGER
      && taskRequest.source?.module === ModuleId.CORE
      && taskRequest.source?.deviceId === 'mission_executive'
      && typeof internalMissionHint.expectedToolName === 'string'
    );
    // The executive planner has already spent a model call choosing a registered tool
    // and supplying bounded arguments. Re-running the semantic intent model for each
    // atomic action adds latency and can reinterpret simple phrases such as a local
    // folder listing as a web search. The private Symbol plus the trusted source tuple
    // keeps this deterministic fast path inaccessible to public task options.
    const intentParser = deterministicLocal || trustedMissionSource ? this.localIntentParser : this.intentParser;
    const parsedIntent = intentParser.parse(taskRequest.command.rawText, {
      requestId: taskRequest.requestId,
      createdAt: taskRequest.createdAt
    });
    const trustedMissionSelectionDiagnostics = {};
    const trustedMissionSelection = trustedMissionSource
      ? this.trustedMissionSelection(parsedIntent, internalMissionHint, trustedMissionSelectionDiagnostics)
      : null;
    const intent = trustedMissionSelection?.intent ?? parsedIntent;
    this.contractRegistry.assert('IntentCandidate', intent);
    const ambiguity = this.ambiguityResolver.resolve({ taskRequest, candidates: intent.candidates });
    this.contractRegistry.assert('AmbiguitySet', ambiguity);
    const route = trustedMissionSelection?.route ?? this.skillRouter.route(ambiguity.selected ?? intent);
    if (!roleAssignment) planningContext = this.withCognitiveContext(planningContext, taskRequest, ambiguity.selected ?? intent, route);
    const trustedRouteHint = internalMissionHint
      && trustedMissionSource
      && internalMissionHint.expectedToolName === route?.skill?.toolName
      ? {
          source: 'mission-executive',
          toolName: internalMissionHint.expectedToolName,
          skipExternalPlanning: true
        }
      : null;
    const contextSnapshot = this.contextBuilder.build(taskRequest, {
      memoryContext,
      environment: options.environment,
      desktopContextApproval: options.desktopContextApproval
    });
    this.contractRegistry.assert('ContextSnapshot', contextSnapshot);
    const planner = this.taskPlanner;
    const plan = planner.createPlan(taskRequest, ambiguity.selected ?? intent, {
      contextSnapshot,
      route,
      planningContext,
      personalContext: roleAssignment || taskRequest.metadata?.longTermMemory === false ? null : this.personalContextFor(taskRequest.command.rawText, taskRequest.userId),
      trustedRouteHint,
      preparedMissionArguments: trustedRouteHint
        ? (trustedMissionSelection?.preparedArguments ?? internalMissionHint.preparedArguments)
        : null,
      deterministicArgumentsOnly: deterministicLocal || trustedMissionSource
    });
    if (trustedMissionSource) plan.trustedMissionRoute = {
      selected: Boolean(trustedMissionSelection),
      preparedArgumentsProvided: internalMissionHint?.preparedArguments != null,
      argumentMode: trustedMissionSelection?.preparedArguments ? 'validated-prepared' : trustedMissionSelection ? 'bounded-local-read-default' : 'not-bound',
      reason: trustedMissionSelection ? 'registered-tool-bound' : trustedMissionSelectionDiagnostics.reason ?? 'mission-tool-hint-invalid'
    };
    plan.skillCenter = {
      profileId: skillCenterSelection.profileId,
      profileVersion: skillCenterSelection.profileVersion,
      activeSkillCount: skillCenterSelection.activeSkillCount,
      skillIds: skillCenterSelection.skills.map((skill) => skill.id),
      requiresApproval: skillCenterSelection.security.requiresApproval,
      dependencyStatus: {
        ready: skillCenterSelection.dependencyReport.ready,
        needsConfiguration: skillCenterSelection.dependencyReport.needsConfiguration
      }
    };
    this.contractRegistry.assert('TaskPlan', plan);
    this.contractRegistry.assert('PolicyCheckRequest', plan.policyCheckRequest);
    const lifecycle = new TaskLifecycle({ taskId: taskRequest.taskId, createdAt: taskRequest.createdAt });
    lifecycle.mark(TaskStatus.PLANNING, '계획 생성', 'IntentParser and TaskPlanner completed', taskRequest.createdAt);
    this.eventBus.publish('intent.parsed', { taskId: taskRequest.taskId, intent, ambiguity });
    this.eventBus.publish('context.snapshot.created', { taskId: taskRequest.taskId, contextSnapshot });
    this.eventBus.publish('task.plan.created', { taskId: taskRequest.taskId, plan });
    let policy = this.policyEngine?.evaluatePlan?.({ taskRequest, plan }) ?? {
      decision: 'require_approval',
      risk: { tier: 5, reasons: [] },
      approval: { required: true, mobileApprovalAllowed: true, expiresInSec: 1800 },
      constraints: { allowDelete: false, allowExternalTransfer: false, allowAdminPrivilege: false, reversibleRequired: true }
    };
    if (taskRequest.metadata?.workReferenceIssue) {
      policy = { ...policy, decision: 'block', blockedReason: taskRequest.metadata.workReferenceIssue.message,
        blockedCode: taskRequest.metadata.workReferenceIssue.code };
    }

    const status = policy.decision === 'block' ? TaskStatus.BLOCKED : TaskStatus.WAITING_APPROVAL;
    machine.transition(status, 'policy-evaluation');
    lifecycle.mark(
      status,
      status === TaskStatus.BLOCKED ? '정책 차단' : '승인 대기',
      status === TaskStatus.BLOCKED ? policy.blockedReason : 'ApprovalCard created',
      taskRequest.createdAt
    );
    const approvalId = stableId('appr', plan.taskId, taskRequest.createdAt);
    const approvalCard = createApprovalCard({
      approvalId,
      taskId: plan.taskId,
      title: plan.title,
      interpretedIntent: plan.interpretedIntent,
      riskTier: policy.risk.tier,
      planSteps: plan.planSteps.map((step) => step.description),
      affectedItems: plan.affectedItems,
      externalTransfer: policy.constraints.allowExternalTransfer,
      irreversible: !policy.constraints.reversibleRequired && policy.risk.tier <= 2,
      rollbackAvailable: policy.constraints.reversibleRequired ?? true,
      warnings: policy.securityWarnings ?? [],
      clarificationRequest: ambiguity.clarificationRequest,
      createdAt: taskRequest.createdAt,
      expiresAt: new Date(Date.parse(taskRequest.createdAt) + policy.approval.expiresInSec * 1000).toISOString()
    });
    // 계획 설명 + LLM 명료화 질문을 승인 카드에 실어 폰이 보여줄 수 있게 한다.
    if (plan.planExplanation) approvalCard.planExplanation = plan.planExplanation;
    if (plan.clarification) {
      approvalCard.clarifyingQuestions = plan.clarification.questions ?? [];
      approvalCard.ambiguous = plan.clarification.ambiguous ?? false;
    }
    const clarificationPreview = this.clarificationPreviewDiff({
      previousPlan: null,
      nextPlan: plan,
      nextApprovalCard: approvalCard,
      ambiguity
    });
    if (approvalCard.clarificationRequest) {
      approvalCard.clarificationRequest.previewDiff = clarificationPreview;
    }
    this.contractRegistry.assert('ApprovalCard', approvalCard);

    const record = {
      taskId: plan.taskId,
      request: taskRequest,
      intent,
      ambiguity,
      route,
      contextSnapshot,
      plan,
      policy,
      approvalCard,
      memoryContext,
      planningContext,
      skillCenterSelection,
      clarificationChain: this.createClarificationChain({
        ambiguity,
        plan,
        approvalCard,
        previewDiff: clarificationPreview
      }),
      lifecycle,
      status,
      stateMachine: machine
    };
    record.orchestrationTrace = this.orchestrator.startTrace({ task: record });
    this.orchestrator.appendTrace(record.orchestrationTrace, {
      phase: 'task.created',
      message: 'TaskRequest, intent, context, plan, policy, and approval card were created.',
      evidence: {
        requestId: taskRequest.requestId,
        intentId: intent.intentId,
        planId: plan.planId,
        approvalId: approvalCard.approvalId,
        riskTier: approvalCard.riskTier
      }
    });
    this.attachClarificationJournalSnapshot(record, 'task_created');
    this.orchestrator.checkpointTrace({ task: record, reason: 'task_created' });
    this.tasks.set(plan.taskId, record);
    if (roleAssignment) this.#missionRoleAssignments.set(plan.taskId, Object.freeze({ ...roleAssignment }));
    this.cognition?.updateTask(record);
    this.cognition?.recordDecision?.(record, { kind: 'request', workspaceRoot: this.workspaceRoot });
    this.eventBus.publish('clarification.chain.updated', { taskId: plan.taskId, clarificationChain: record.clarificationChain });
    this.eventBus.publish('skill.profile.activated', {
      taskId: plan.taskId,
      profileId: skillCenterSelection.profileId,
      skillIds: plan.skillCenter.skillIds
    });
    this.eventBus.publish('orchestration.trace.updated', { taskId: plan.taskId, trace: record.orchestrationTrace });
    this.eventBus.publish('approval.card.created', { taskId: plan.taskId, approvalCard });
    return record;
  }

  runCoreOperation(operation, callback) {
    if (this.operationDepth > 0) return callback();
    const startedAt = performance.now();
    this.operationDepth += 1;
    const batch = this.durabilityBatching ? beginJsonlBatchSync({ operation }) : null;
    let result;
    let operationError = null;
    let durability = {
      enabled: false,
      logicalRecordCount: 0,
      physicalWriteCount: 0,
      fileCount: 0,
      writeReductionRatio: 0,
      flushDurationMs: 0
    };

    try {
      result = callback();
    } catch (error) {
      operationError = error;
    }

    if (batch) {
      const flushStartedAt = performance.now();
      try {
        const summary = commitJsonlBatchSync(batch);
        durability = {
          enabled: true,
          logicalRecordCount: summary.logicalRecordCount,
          physicalWriteCount: summary.physicalWriteCount,
          fileCount: summary.fileCount,
          writeReductionRatio: summary.writeReductionRatio,
          flushDurationMs: performance.now() - flushStartedAt
        };
      } catch (flushError) {
        if (operationError && typeof operationError === 'object') {
          operationError.durabilityFlushError = flushError?.message ?? String(flushError);
        } else {
          operationError = flushError;
        }
      }
    }

    this.operationDepth -= 1;
    this.performanceTelemetry.record({
      operation,
      durationMs: performance.now() - startedAt,
      status: operationError ? 'failed' : 'completed',
      durability
    });
    if (operationError) throw operationError;
    return result;
  }

  ensureUniqueTaskRequest(taskRequest) {
    if (!this.tasks.has(taskRequest.taskId)) return taskRequest;
    const originalTaskId = taskRequest.taskId;
    const originalRequestId = taskRequest.requestId;
    let collisionSequence = 2;
    let taskId = `${originalTaskId}_${collisionSequence}`;
    while (this.tasks.has(taskId)) {
      collisionSequence += 1;
      taskId = `${originalTaskId}_${collisionSequence}`;
    }
    return {
      ...taskRequest,
      requestId: `${originalRequestId}_${collisionSequence}`,
      taskId,
      metadata: {
        ...taskRequest.metadata,
        idCollisionAvoided: true,
        originalTaskId,
        originalRequestId,
        collisionSequence
      }
    };
  }

  // 저장된 매크로 이름으로 요청이 들어오면 원래 명령으로 바꿔 정상 파이프라인을 태운다.
  // 저장 자체("~를 XX로 저장")는 여기서 건드리지 않고 MACRO_SAVE 스킬이 처리한다.
  expandMacro(taskRequest) {
    try {
      const rawText = taskRequest?.command?.rawText;
      if (!rawText) return taskRequest;
      if (this.macroStore?.parseSave?.(rawText)) return taskRequest; // 저장 문장은 실행으로 오인하지 않는다.
      this.macroStore.macros = this.macroStore.load(); // 다른 프로세스가 저장했을 수 있어 최신화.
      const hit = this.macroStore?.resolveRun?.(rawText);
      if (!hit) return taskRequest;
      return {
        ...taskRequest,
        command: { ...taskRequest.command, rawText: hit.command },
        metadata: { ...taskRequest.metadata, macroExpanded: hit.name, macroOriginalText: rawText }
      };
    } catch {
      return taskRequest;
    }
  }

  // 대화기억: "그거 메일로 보내줘"/"방금 만든 보고서 열어줘"의 지시어를
  // 작업 일지의 최근 산출물 파일명으로 바꿔 정상 파이프라인을 태운다.
  workReferenceScope({ metadata = {}, userId = 'local_user' } = {}) {
    return workReferenceScope({ workspaceRoot: this.workspaceRoot, metadata, userId });
  }

  resolveWorkReference(taskRequest, { referenceContext = null } = {}) {
    const metadata = cleanWorkReferenceMetadata(taskRequest?.metadata ?? {});
    const scope = this.workReferenceScope({ metadata, userId: taskRequest?.userId });
    taskRequest = { ...taskRequest, metadata: { ...metadata, workReferenceScope: scope } };
    try {
      const rawText = taskRequest?.command?.rawText;
      if (!rawText) return taskRequest;
      if (referenceContext) {
        return { ...taskRequest, metadata: { ...taskRequest.metadata, workReference: structuredClone(referenceContext.binding),
          workReferenceOriginalText: referenceContext.originalText ?? rawText, workReferenceResolved: true } };
      }
      const hit = resolveWorkReferenceContext(this.workMemory, rawText, { scope });
      if (hit.status === 'not_reference') return taskRequest;
      if (hit.status !== 'resolved') return { ...taskRequest, metadata: { ...taskRequest.metadata, workReferenceIssue: hit.issue } };
      return {
        ...taskRequest,
        command: { ...taskRequest.command, rawText: hit.rewritten },
        metadata: {
          ...taskRequest.metadata,
          workReferenceResolved: true,
          workReference: hit.binding,
          workReferencePath: hit.path,
          workReferenceOriginalText: rawText
        }
      };
    } catch {
      return { ...taskRequest, metadata: { ...taskRequest.metadata, workReferenceIssue: {
        code: 'A_WORK_REFERENCE_UNAVAILABLE', status: 'unverified', message: '파일 기억을 확인할 수 없습니다. 사용할 파일 경로를 지정해주세요.'
      } } };
    }
  }

  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  cancelTask(taskId, { reason = 'cancelled-by-core', source = 'core' } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('task.cancel', () => this.cancelTask(taskId, { reason, source }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, status: null, reason: 'task-not-found' };
    if (!task.stateMachine.canTransition(TaskStatus.CANCELLED)) {
      return { success: false, status: task.status, reason: 'cancel-not-applicable' };
    }
    task.status = TaskStatus.CANCELLED;
    task.lifecycle.mark(task.status, reason, source);
    task.stateMachine.transition(task.status, reason, { source });
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'task.cancelled',
      status: 'failed',
      message: reason,
      evidence: { source }
    });
    this.orchestrator.checkpointTrace({ task, reason: 'task_cancelled' });
    this.eventBus.publish('task.cancelled', { taskId, reason, source });
    return { success: true, status: task.status, reason };
  }

  submitApprovalDecision(decision) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('approval.submit', () => this.submitApprovalDecision(decision));
    }
    this.contractRegistry.assert('ApprovalDecision', decision);
    const task = this.getTask(decision.taskId);
    if (!task) {
      return { success: false, status: TaskStatus.BLOCKED, reason: 'task-not-found' };
    }
    const activeApprovalId = task.approvalCard?.approvalId ?? null;
    if (!activeApprovalId || decision.approvalId !== activeApprovalId) {
      this.eventBus.publish('approval.invalid', {
        taskId: task.taskId,
        reason: 'approval-card-mismatch',
        submittedApprovalId: decision.approvalId,
        activeApprovalId
      });
      return { success: false, status: task.status, reason: 'approval-card-mismatch' };
    }
    const checkedAt = this.clock().toISOString();
    const approvalExpired = Number.isFinite(Date.parse(task.approvalCard?.expiresAt))
      && Date.parse(checkedAt) >= Date.parse(task.approvalCard.expiresAt);
    if (decision.decision !== 'reject'
      && approvalExpired
      && (task.status === TaskStatus.WAITING_APPROVAL || task.status === TaskStatus.FAILED)) {
      if (task.status === TaskStatus.WAITING_APPROVAL) {
        this.expireApproval(task.taskId, { at: checkedAt, reason: 'stale-approval-decision' });
      }
      this.eventBus.publish('approval.stale_decision_blocked', {
        taskId: task.taskId,
        approvalId: activeApprovalId,
        expiresAt: task.approvalCard.expiresAt,
        checkedAt
      });
      return { success: false, status: task.status, reason: 'approval-expired' };
    }
    this.eventBus.publish(`approval.${decision.decision}`, { decision });
    if (decision.decision === 'reject') {
      // 이미 종결된 작업(완료/차단/만료 등)의 카드에 온 거부는 조용히 현재 상태를 알려준다.
      if (!task.stateMachine.canTransition(TaskStatus.CANCELLED)) {
        return { success: false, status: task.status, reason: 'cancel-not-applicable' };
      }
      task.status = TaskStatus.CANCELLED;
      task.lifecycle.mark(task.status, '승인 거부', `ApprovalDecision:${decision.decision}`);
      task.stateMachine.transition(task.status, 'approval-decision');
      this.orchestrator.appendTrace(task.orchestrationTrace, {
        phase: 'approval.rejected',
        status: 'failed',
        message: 'User rejected the approval card.',
        evidence: { approvalId: decision.approvalId }
      });
      this.orchestrator.checkpointTrace({ task, reason: 'approval_rejected' });
      this.cognition?.updateTask(task);
      this.cognition?.recordDecision?.(task, { kind: 'reject', decision, workspaceRoot: this.workspaceRoot });
      return { success: true, status: task.status };
    }
    if (decision.decision === 'edit' || decision.decision === 'respond') {
      // 재계획은 승인 대기 중이거나 실패한 작업에서만 의미가 있다.
      if (task.status !== TaskStatus.WAITING_APPROVAL && task.status !== TaskStatus.FAILED) {
        return { success: false, status: task.status, reason: 'replan-not-applicable' };
      }
      return this.replanTaskFromApprovalDecision(task, decision);
    }
    // 폰이 같은 카드로 승인 요청을 반복해도(중복 탭·실패 후 재시도) 던지지 않고 상태에 맞게 처리한다.
    if (task.status === TaskStatus.APPROVED || task.status === TaskStatus.EXECUTING) {
      return { success: true, status: task.status, reason: 'already-approved' };
    }
    if (task.status === TaskStatus.COMPLETED) {
      return { success: true, status: task.status, reason: 'already-completed' };
    }
    if (task.status === TaskStatus.FAILED) {
      // 실패한 작업의 재승인 = 재시도. 예산(maxRetries)을 소진하면 차단으로 안내한다.
      const retry = task.stateMachine.retry({ reason: 'approval-after-failure', evidence: { approvalId: decision.approvalId } });
      task.status = task.stateMachine.status;
      if (!retry.retried) {
        task.lifecycle.mark(task.status, '재시도 한도 초과', 'approval-after-failure');
        return { success: false, status: task.status, reason: 'retry-budget-exhausted' };
      }
      task.lifecycle.mark(task.status, '실패 후 재승인', `ApprovalDecision:${decision.approvalId}`);
      this.orchestrator.appendTrace(task.orchestrationTrace, {
        phase: 'approval.retry.after_failure',
        message: 'User re-approved a failed task; retry budget consumed.',
        evidence: { approvalId: decision.approvalId, retryCount: retry.retryCount, maxRetries: retry.maxRetries }
      });
    }
    if (!task.stateMachine.canTransition(TaskStatus.APPROVED)) {
      return { success: false, status: task.status, reason: 'approval-not-applicable' };
    }
    task.stateMachine.transition(TaskStatus.APPROVED, 'approval-decision');
    task.lifecycle.mark(TaskStatus.APPROVED, '승인 완료', `ApprovalDecision:${decision.approvalId}`);
    task.status = TaskStatus.APPROVED;
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'approval.approved',
      message: 'ApprovalDecision approved by user.',
      evidence: { approvalId: decision.approvalId, deviceId: decision.decidedBy.deviceId }
    });
    this.orchestrator.checkpointTrace({ task, reason: 'approval_approved' });
    this.cognition?.recordDecision?.(task, { kind: 'approve', decision, workspaceRoot: this.workspaceRoot });
    return { success: true, status: task.status };
  }

  replanTaskFromApprovalDecision(task, decision) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('task.replan', () => this.replanTaskFromApprovalDecision(task, decision));
    }
    const revisedText = decision.editRequest?.rawText
      ?? decision.editRequest?.text
      ?? decision.responseText
      ?? task.request.metadata?.workReferenceOriginalText
      ?? task.request.command.rawText;
    const trustedRoleAssignment = this.#missionRoleAssignments.get(task.taskId) ?? null;
    const previousPlan = task.plan;
    const previousRecovery = this.orchestrator.resumeContext(task.taskId);
    const recoveryContext = buildReplanRecoveryContext({ task, previousPlan, previousRecovery });
    const rawRevisedRequest = {
      ...task.request,
      requestId: stableId('req', `${task.request.requestId}:replan:${revisedText}`, decision.decidedAt),
      command: {
        ...task.request.command,
        rawText: revisedText
      },
      metadata: {
        ...task.request.metadata,
        replanOf: previousPlan.planId,
        approvalDecision: decision.decision
      },
      createdAt: decision.decidedAt
    };
    const revisedRequest = trustedRoleAssignment ? rawRevisedRequest : this.resolveWorkReference(rawRevisedRequest);
    this.contractRegistry.assert('TaskRequest', revisedRequest);
    task.stateMachine.transition(TaskStatus.PLANNING, 'approval-replan-requested');
    task.lifecycle.mark(TaskStatus.PLANNING, '수정 재계획', `ApprovalDecision:${decision.decision}`, decision.decidedAt);
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'approval.replan.requested',
      message: 'User requested a plan edit or response during approval.',
      evidence: { previousPlanId: previousPlan.planId, revisedText }
    });

    const intent = this.intentParser.parse(revisedRequest.command.rawText, {
      requestId: revisedRequest.requestId,
      createdAt: revisedRequest.createdAt
    });
    this.contractRegistry.assert('IntentCandidate', intent);
    const ambiguity = this.ambiguityResolver.resolve({ taskRequest: revisedRequest, candidates: intent.candidates });
    this.contractRegistry.assert('AmbiguitySet', ambiguity);
    const route = this.skillRouter.route(ambiguity.selected ?? intent);
    const memoryScope = { scope: { userId: revisedRequest.userId, workspaceRoot: this.workspaceRoot, conversationId: revisedRequest.metadata?.conversationId ?? null } };
    const memoryContext = trustedRoleAssignment || revisedRequest.metadata?.longTermMemory === false ? [] : this.queryTaskMemory(revisedRequest,memoryScope);
    const planningContext = trustedRoleAssignment || revisedRequest.metadata?.longTermMemory === false ? null : this.withCognitiveContext(
      this.memoryStore?.planningPreferenceContext?.(revisedRequest.command.rawText, memoryScope) ?? null,
      revisedRequest, ambiguity.selected ?? intent, route
    );
    const contextSnapshot = this.contextBuilder.build(revisedRequest, {
      memoryContext,
      desktopContextApproval: task.contextSnapshot?.environment?.desktop?.approval?.approved
        ? task.contextSnapshot.environment.desktop.approval
        : null
    });
    this.contractRegistry.assert('ContextSnapshot', contextSnapshot);
    const plan = this.taskPlanner.createPlan(revisedRequest, ambiguity.selected ?? intent, {
      contextSnapshot, route, planningContext,
      personalContext: trustedRoleAssignment || revisedRequest.metadata?.longTermMemory === false ? null : this.personalContextFor(revisedRequest.command.rawText, revisedRequest.userId)
    });
    plan.replanOf = previousPlan.planId;
    this.contractRegistry.assert('TaskPlan', plan);
    this.contractRegistry.assert('PolicyCheckRequest', plan.policyCheckRequest);
    let policy = this.policyEngine?.evaluatePlan?.({ taskRequest: revisedRequest, plan }) ?? task.policy;
    if (revisedRequest.metadata?.workReferenceIssue) {
      policy = { ...policy, decision: 'block', blockedReason: revisedRequest.metadata.workReferenceIssue.message,
        blockedCode: revisedRequest.metadata.workReferenceIssue.code };
    }
    const status = policy.decision === 'block' ? TaskStatus.BLOCKED : TaskStatus.WAITING_APPROVAL;
    task.stateMachine.transition(status, 'replan-policy-evaluation');
    task.lifecycle.mark(status, status === TaskStatus.BLOCKED ? '재계획 정책 차단' : '재승인 대기', `Replan:${plan.planId}`, decision.decidedAt);
    const approvalCard = createApprovalCard({
      approvalId: stableId('appr', `${plan.taskId}:${plan.planId}`, decision.decidedAt),
      taskId: plan.taskId,
      title: plan.title,
      interpretedIntent: plan.interpretedIntent,
      riskTier: policy.risk.tier,
      planSteps: plan.planSteps.map((step) => step.description),
      affectedItems: plan.affectedItems,
      externalTransfer: policy.constraints.allowExternalTransfer,
      irreversible: !policy.constraints.reversibleRequired && policy.risk.tier <= 2,
      rollbackAvailable: policy.constraints.reversibleRequired ?? true,
      warnings: [
        ...(policy.securityWarnings ?? []),
        ...(recoveryContext ? ['이전 계획의 일부 효과가 이미 반영됐을 수 있습니다. 아래 복구 기록을 확인하고 남은 작업만 새 계획에 포함하세요.'] : [])
      ],
      clarificationRequest: ambiguity.clarificationRequest,
      createdAt: decision.decidedAt,
      expiresAt: new Date(Date.parse(decision.decidedAt) + policy.approval.expiresInSec * 1000).toISOString()
    });
    const clarificationPreview = this.clarificationPreviewDiff({
      previousPlan,
      nextPlan: plan,
      previousApprovalCard: task.approvalCard,
      nextApprovalCard: approvalCard,
      ambiguity,
      decision
    });
    if (approvalCard.clarificationRequest) {
      approvalCard.clarificationRequest.previewDiff = clarificationPreview;
    }
    approvalCard.replanPreviewDiff = clarificationPreview;
    this.contractRegistry.assert('ApprovalCard', approvalCard);

    Object.assign(task, {
      request: revisedRequest,
      intent,
      ambiguity,
      route,
      contextSnapshot,
      plan,
      policy,
      approvalCard,
      memoryContext,
      planningContext,
      recoveryContext,
      clarificationChain: this.extendClarificationChain({
        existing: task.clarificationChain,
        ambiguity,
        plan,
        approvalCard,
        previousPlan,
        decision,
        previewDiff: clarificationPreview
      }),
      status,
      capabilityRequest: null,
      executionPacket: null
    });
    task.orchestrationTrace.planId = plan.planId;
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'task.replanned',
      message: 'A created a revised plan and approval card.',
      evidence: {
        previousPlanId: previousPlan.planId,
        planId: plan.planId,
        approvalId: approvalCard.approvalId,
        clarificationDiff: clarificationPreview
      }
    });
    this.attachClarificationJournalSnapshot(task, 'task_replanned');
    this.orchestrator.checkpointTrace({ task, reason: 'task_replanned' });
    this.cognition?.recordDecision?.(task, { kind: 'replan', decision, workspaceRoot: this.workspaceRoot });
    this.eventBus.publish('clarification.chain.updated', { taskId: task.taskId, clarificationChain: task.clarificationChain });
    this.eventBus.publish('task.replanned', { taskId: task.taskId, previousPlanId: previousPlan.planId, plan, approvalCard });
    this.eventBus.publish('approval.card.created', { taskId: task.taskId, approvalCard });
    this.eventBus.publish('orchestration.trace.updated', { taskId: task.taskId, trace: task.orchestrationTrace });
    return { success: true, status: task.status, plan, approvalCard, recoveryContext };
  }

  attachClarificationJournalSnapshot(task, reason) {
    const snapshot = this.orchestrator.recordClarificationSnapshot({ task, reason });
    if (task.clarificationChain) {
      task.clarificationChain.journalSnapshot = {
        pointerVersion: 'a-clarification-chain-journal-pointer-v1',
        snapshotVersion: snapshot?.snapshotVersion ?? 'a-clarification-chain-snapshot-v1',
        durable: Boolean(snapshot?.journalId),
        journalId: snapshot?.journalId ?? null,
        recordType: snapshot?.recordType ?? 'clarification_chain_snapshot',
        recordedAt: snapshot?.recordedAt ?? null,
        chainHash: snapshot?.chainHash ?? null,
        reason
      };
    }
    return snapshot;
  }

  createClarificationChain({ ambiguity, plan, approvalCard, previewDiff }) {
    const entries = [];
    if (ambiguity.clarificationRequest) {
      entries.push(this.clarificationChainEntry({
        sequence: 1,
        ambiguity,
        plan,
        approvalCard,
        previewDiff
      }));
    }
    return {
      chainVersion: 'a-clarification-chain-v1',
      status: ambiguity.ambiguous ? 'waiting_response' : 'not_required',
      currentClarificationId: ambiguity.clarificationRequest?.clarificationId ?? null,
      totalEntries: entries.length,
      entries
    };
  }

  extendClarificationChain({ existing, ambiguity, plan, approvalCard, previousPlan, decision, previewDiff }) {
    const entries = [...(existing?.entries ?? [])];
    entries.push(this.clarificationChainEntry({
      sequence: entries.length + 1,
      ambiguity,
      plan,
      approvalCard,
      previousPlan,
      decision,
      previewDiff
    }));
    return {
      chainVersion: 'a-clarification-chain-v1',
      status: ambiguity.ambiguous ? 'waiting_response' : 'resolved',
      currentClarificationId: ambiguity.clarificationRequest?.clarificationId ?? null,
      totalEntries: entries.length,
      entries
    };
  }

  clarificationChainEntry({ sequence, ambiguity, plan, approvalCard, previousPlan = null, decision = null, previewDiff }) {
    return {
      entryVersion: 'a-clarification-chain-entry-v1',
      sequence,
      clarificationId: approvalCard.clarificationRequest?.clarificationId ?? null,
      approvalId: approvalCard.approvalId,
      planId: plan.planId,
      previousPlanId: previousPlan?.planId ?? null,
      status: ambiguity.ambiguous ? 'waiting_response' : 'resolved',
      reasonCodes: ambiguity.reasonCodes ?? [],
      selectedIntentId: ambiguity.selected?.intentId ?? null,
      response: decision ? {
        decision: decision.decision,
        responseText: decision.responseText ?? null,
        editRequest: decision.editRequest ?? null,
        decidedAt: decision.decidedAt,
        decidedBy: decision.decidedBy
      } : null,
      previewDiff,
      createdAt: approvalCard.createdAt
    };
  }

  clarificationPreviewDiff({ previousPlan = null, nextPlan, previousApprovalCard = null, nextApprovalCard = null, ambiguity = null, decision = null }) {
    const previousSteps = previousPlan?.planSteps?.map((step) => step.description) ?? [];
    const nextSteps = nextPlan?.planSteps?.map((step) => step.description) ?? [];
    return {
      previewVersion: 'a-clarification-preview-diff-v1',
      previousPlanId: previousPlan?.planId ?? null,
      nextPlanId: nextPlan?.planId ?? null,
      actionChanged: Boolean(previousPlan && previousPlan.action?.actionType !== nextPlan?.action?.actionType),
      toolChanged: Boolean(previousPlan && previousPlan.action?.toolName !== nextPlan?.action?.toolName),
      titleChanged: Boolean(previousPlan && previousPlan.title !== nextPlan?.title),
      riskTierChanged: Boolean(previousApprovalCard && nextApprovalCard && previousApprovalCard.riskTier !== nextApprovalCard.riskTier),
      previousActionType: previousPlan?.action?.actionType ?? null,
      nextActionType: nextPlan?.action?.actionType ?? null,
      previousToolName: previousPlan?.action?.toolName ?? null,
      nextToolName: nextPlan?.action?.toolName ?? null,
      previousRiskTier: previousApprovalCard?.riskTier ?? null,
      nextRiskTier: nextApprovalCard?.riskTier ?? null,
      planStepDelta: {
        previousCount: previousSteps.length,
        nextCount: nextSteps.length,
        added: nextSteps.filter((step) => !previousSteps.includes(step)),
        removed: previousSteps.filter((step) => !nextSteps.includes(step))
      },
      affectedItemDelta: {
        previousCount: previousPlan?.affectedItems?.length ?? 0,
        nextCount: nextPlan?.affectedItems?.length ?? 0
      },
      ambiguity: {
        ambiguous: ambiguity?.ambiguous ?? false,
        reasonCodes: ambiguity?.reasonCodes ?? [],
        selectedIntentId: ambiguity?.selected?.intentId ?? null,
        alternativeCount: ambiguity?.alternatives?.length ?? 0
      },
      decision: decision ? {
        decision: decision.decision,
        decidedAt: decision.decidedAt
      } : null
    };
  }

  createCapabilityRequest(taskId, approvalDecision) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('capability.create', () => this.createCapabilityRequest(taskId, approvalDecision));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const capabilityRequest = this.orchestrator.buildCapabilityRequest({ task, approvalDecision });
    this.contractRegistry.assert('CapabilityRequest', capabilityRequest);
    task.capabilityRequest = capabilityRequest;
    this.orchestrator.checkpointTrace({ task, reason: 'capability_request_created' });
    this.eventBus.publish('capability.request.created', { taskId, capabilityRequest });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return capabilityRequest;
  }

  createExecutionPacket(taskId, { capabilityToken, approvalDecision, userConfirmation } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('execution.packet.create', () => this.createExecutionPacket(taskId, {
        capabilityToken,
        approvalDecision,
        userConfirmation
      }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const packet = this.orchestrator.buildExecutionPacket({ task, capabilityToken, approvalDecision, userConfirmation });
    this.contractRegistry.assert('ExecutionPacket', packet);
    task.executionPacket = packet;
    for (const node of task.plan?.planGraph?.nodes ?? []) {
      if (node.nodeId.startsWith('action_')) {
        this.orchestrator.markNode({ task, nodeId: node.nodeId, status: 'ready', evidence: { packetId: packet.packetId } });
      }
    }
    this.orchestrator.checkpointTrace({ task, reason: 'execution_packet_created' });
    this.eventBus.publish('execution.packet.created', { taskId, packet });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return packet;
  }

  completeDummyExecution(taskId, approvalDecision) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('execution.complete.dummy', () => this.completeDummyExecution(taskId, approvalDecision));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    if (task.status !== TaskStatus.APPROVED) return { success: false, reason: 'approval-required' };
    task.stateMachine.transition(TaskStatus.EXECUTING, 'dummy-execution-started');
    task.lifecycle.mark(TaskStatus.EXECUTING, '더미 실행', 'A AgentOrchestratorLite started dummy execution');
    task.stateMachine.transition(TaskStatus.COMPLETED, 'dummy-execution-completed');
    task.lifecycle.mark(TaskStatus.COMPLETED, '완료', 'A dummy execution result stored');
    task.status = TaskStatus.COMPLETED;
    task.executionResult = this.orchestrator.dummyExecutionResult({ task, approvalDecision });
    for (const node of task.plan?.planGraph?.nodes ?? []) {
      this.orchestrator.markNode({ task, nodeId: node.nodeId, status: 'completed', evidence: { execution: 'dummy' } });
    }
    this.orchestrator.completeTrace(task.orchestrationTrace, { executionStatus: task.executionResult.status });
    this.eventBus.publish('task.completed', { taskId, executionResult: task.executionResult });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return task.executionResult;
  }

  expireApproval(taskId, { at = this.clock().toISOString(), reason = 'approval-expired' } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('approval.expire', () => this.expireApproval(taskId, { at, reason }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const expired = task.stateMachine.expireIfPast(task.approvalCard?.expiresAt, { now: at, reason });
    if (!expired.expired) return { success: false, status: task.status, reason: expired.reason ?? 'not-expired' };
    task.status = TaskStatus.EXPIRED;
    task.lifecycle.mark(TaskStatus.EXPIRED, '승인 만료', `expiresAt:${task.approvalCard.expiresAt}`, at);
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'approval.expired',
      status: 'failed',
      message: 'Approval window expired before execution could continue.',
      evidence: { expiresAt: task.approvalCard.expiresAt, checkedAt: at }
    });
    this.orchestrator.checkpointTrace({ task, reason: 'approval_expired' });
    this.eventBus.publish('approval.expired', { taskId, expiresAt: task.approvalCard.expiresAt, checkedAt: at });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: true, status: task.status, ...expired };
  }

  refreshApprovalDeadline(taskId, {
    at = this.clock().toISOString(),
    reason = 'approval-consent-refreshed',
    source = 'core'
  } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('approval.refresh', () => this.refreshApprovalDeadline(taskId, { at, reason, source }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, status: null, reason: 'task-not-found' };
    if (task.status !== TaskStatus.WAITING_APPROVAL || !task.approvalCard) {
      return { success: false, status: task.status, reason: 'approval-refresh-not-applicable' };
    }
    const refreshedAtMs = Date.parse(at);
    const expiresInSec = Number(task.policy?.approval?.expiresInSec);
    if (!Number.isFinite(refreshedAtMs) || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
      return { success: false, status: task.status, reason: 'approval-refresh-policy-invalid' };
    }
    const previousExpiresAt = task.approvalCard.expiresAt;
    const expiresAt = new Date(refreshedAtMs + expiresInSec * 1000).toISOString();
    task.approvalCard.expiresAt = expiresAt;
    task.lifecycle.mark(
      TaskStatus.WAITING_APPROVAL,
      '승인 유효시간 갱신',
      `${reason}:${source}`,
      new Date(refreshedAtMs).toISOString()
    );
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'approval.deadline_refreshed',
      status: 'running',
      message: 'A fresh scoped user decision renewed the execution approval window.',
      evidence: { approvalId: task.approvalCard.approvalId, previousExpiresAt, expiresAt, reason, source }
    });
    this.orchestrator.checkpointTrace({ task, reason: 'approval_deadline_refreshed' });
    this.eventBus.publish('approval.deadline_refreshed', {
      taskId,
      approvalId: task.approvalCard.approvalId,
      previousExpiresAt,
      expiresAt,
      reason,
      source
    });
    return {
      success: true,
      status: task.status,
      approvalId: task.approvalCard.approvalId,
      previousExpiresAt,
      expiresAt
    };
  }

  recordExecutionFailure(taskId, { reason = 'execution-failed', evidence = {} } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('execution.fail', () => this.recordExecutionFailure(taskId, { reason, evidence }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    if (task.status === TaskStatus.APPROVED) {
      task.stateMachine.transition(TaskStatus.EXECUTING, 'execution-started-before-failure', evidence);
      task.lifecycle.mark(TaskStatus.EXECUTING, '실행 시작', 'Failure was recorded after execution handoff');
    }
    const failure = task.stateMachine.recordFailure({ reason, evidence });
    task.status = task.stateMachine.status;
    task.lifecycle.mark(task.status, '실행 실패', reason);
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'execution.failed',
      status: 'failed',
      message: reason,
      evidence: { ...evidence, failureCount: failure.failureCount, retryable: failure.retryable }
    });
    this.orchestrator.checkpointTrace({ task, reason: 'execution_failed' });
    this.eventBus.publish('task.failed', { taskId, reason, evidence, retryable: failure.retryable });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: true, ...failure };
  }

  recordToolExecution(sample = {}) {
    const health = this.skillRouter.recordExecutionHealth(sample);
    if (health) {
      this.eventBus.publish('execution.health.updated', {
        toolName: health.toolName,
        circuitState: health.circuitState,
        eligible: health.eligible,
        sampleCount: health.sampleCount,
        observedReliability: health.observedReliability,
        p95LatencyMs: health.p95LatencyMs,
        rawCommandStored: false,
        rawArgumentsStored: false
      });
    }
    return health;
  }

  retryTask(taskId, { reason = 'retry-requested', evidence = {} } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('execution.retry', () => this.retryTask(taskId, { reason, evidence }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const retry = task.stateMachine.retry({ reason, evidence });
    task.status = task.stateMachine.status;
    task.lifecycle.mark(task.status, retry.retried ? '재시도 대기' : '재시도 차단', retry.reason ?? reason);
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: retry.retried ? 'execution.retrying' : 'execution.retry.blocked',
      status: retry.retried ? 'ok' : 'failed',
      message: retry.retried ? 'Execution retry was scheduled.' : 'Retry budget was exhausted.',
      evidence: { ...evidence, retryCount: retry.retryCount, maxRetries: retry.maxRetries }
    });
    this.orchestrator.checkpointTrace({ task, reason: retry.retried ? 'execution_retrying' : 'execution_retry_blocked' });
    this.eventBus.publish(retry.retried ? 'task.retrying' : 'task.retry.blocked', { taskId, retry });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: retry.retried, ...retry };
  }

  resumeRetryExecution(taskId, { reason = 'retry-resume-execution', evidence = {} } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('execution.retry.resume', () => this.resumeRetryExecution(taskId, { reason, evidence }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const resumed = task.stateMachine.resumeExecution({ reason, evidence });
    task.status = task.stateMachine.status;
    task.lifecycle.mark(task.status, '재시도 실행', reason);
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'execution.retry.resumed',
      message: 'Retry moved back into execution.',
      evidence
    });
    this.orchestrator.checkpointTrace({ task, reason: 'execution_retry_resumed' });
    this.eventBus.publish('task.retry.resumed', { taskId, resumed });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: true, ...resumed };
  }

  resumeTask(taskId) {
    return this.orchestrator.resumeContext(taskId);
  }

  planCompensation(taskId, { failureBranchId = 'failure_execution_partial', evidence = {}, targetNodeIds = null, mode = 'full' } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('compensation.plan', () => this.planCompensation(taskId, {
        failureBranchId,
        evidence,
        targetNodeIds,
        mode
      }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const result = this.orchestrator.planCompensation({ task, failureBranchId, evidence, targetNodeIds, mode });
    this.eventBus.publish('compensation.planned', { taskId, result });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: true, ...result };
  }

  beginCompensation(taskId, { failureBranchId = 'failure_execution_partial', evidence = {}, targetNodeIds = null, mode = 'full' } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('compensation.begin', () => this.beginCompensation(taskId, {
        failureBranchId,
        evidence,
        targetNodeIds,
        mode
      }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    if (!task.stateMachine.canTransition(TaskStatus.COMPENSATING)) {
      return {
        success: false,
        status: task.status,
        error: {
          code: 'A_COMPENSATION_STATE_NOT_ALLOWED',
          message: `Task status ${task.status} cannot enter compensation.`
        }
      };
    }
    const plan = this.orchestrator.planCompensation({ task, failureBranchId, evidence, targetNodeIds, mode });
    const state = task.stateMachine.beginCompensation({ reason: 'compensation-started', evidence: { failureBranchId, actionCount: plan.actions.length } });
    task.status = task.stateMachine.status;
    task.lifecycle.mark(task.status, '보상 처리 시작', `Compensation:${plan.compensationPlanId}`);
    this.orchestrator.checkpointTrace({ task, reason: 'compensation_started' });
    this.eventBus.publish('compensation.started', { taskId, plan });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: true, ...state, ...plan };
  }

  completeCompensation(taskId, { evidence = {} } = {}) {
    if (this.operationDepth === 0) {
      return this.runCoreOperation('compensation.complete', () => this.completeCompensation(taskId, { evidence }));
    }
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const state = task.stateMachine.completeCompensation({ reason: 'compensation-completed', evidence });
    task.status = task.stateMachine.status;
    task.lifecycle.mark(task.status, '보상 처리 완료', 'Compensation evidence stored');
    this.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'compensation.completed',
      message: 'Compensation completed and task moved to compensated state.',
      evidence
    });
    this.orchestrator.checkpointTrace({ task, reason: 'compensation_completed' });
    this.eventBus.publish('compensation.completed', { taskId, evidence });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: true, ...state };
  }

  contextProviderSoak(options = {}) {
    return this.contextBuilder.runDesktopProviderSoak?.(options) ?? null;
  }

  contextProviderContractStatus() {
    return this.contextBuilder.desktopProviderContractStatus?.() ?? null;
  }

  skillCenterStatus() {
    return {
      ...this.skillCenter.status(),
      profiles: [...this.skillCenter.profiles.values()],
      recipes: [...this.skillCenter.recipes.values()]
    };
  }

  skillCenterCatalog() {
    return this.skillCenter.catalogView();
  }

  searchSkills(query, options = {}) {
    return {
      searchVersion: 'nexus-skill-search-v1',
      query: String(query ?? ''),
      results: this.skillCenter.search(query, options)
    };
  }

  activateSkillProfile(profileId, options = {}) {
    return this.skillCenter.activateProfile(profileId, options);
  }

  deactivateSkillProfile() {
    return this.skillCenter.deactivateProfile();
  }

  composeSkillRecipe(recipeId, options = {}) {
    return this.skillCenter.compose(recipeId, options);
  }

  adminDiagnostics() {
    return {
      cognition: this.cognitiveStatus(),
      personalProfile: this.personalProfileStatus(),
      taskCount: this.tasks.size,
      tasks: [...this.tasks.values()].map((task) => ({
        taskId: task.taskId,
        status: task.status,
        planId: task.plan?.planId,
        traceId: task.orchestrationTrace?.traceId,
        lifecycleStep: task.lifecycle?.current?.()
      })),
      recentEvents: this.eventBus.recent(20),
      eventDelivery: this.eventBus.deliveryStatus?.() ?? null,
      performance: this.performanceTelemetry.snapshot(),
      skillMatrix: this.skillRouter.capabilityMatrix(),
      executionFabric: this.skillRouter.executionFabricStatus(),
      executionHealth: this.executionHealthRegistry.snapshot(this.skillRouter.capabilityMatrix().map((skill) => skill.toolName)),
      executionEnvironment: this.executionEnvironmentProfile,
      skillPluginRegistry: this.skillRouter.pluginRegistry(),
      skillCompatibilitySnapshot: this.skillRouter.compatibilitySnapshot({ label: 'admin-diagnostics', record: false }),
      skillCenter: {
        status: this.skillCenter.status(),
        usage: this.skillCenter.usageAnalytics(),
        librarian: this.skillCenter.librarianReport()
      },
      contextTelemetry: this.contextBuilder.desktopTelemetryReport?.() ?? null,
      contextProviderContract: this.contextProviderContractStatus(),
      contractSchemas: this.contractRegistry.schemas(),
      orchestration: [...this.tasks.values()].map((task) => this.resumeTask(task.taskId))
    };
  }

  withCognitiveContext(context, taskRequest, intent, route) {
    if (taskRequest.metadata?.longTermMemory === false) return null;
    const reflection = this.cognition?.planningContext({ taskRequest, intent, route, workspaceRoot: this.workspaceRoot });
    return reflection ? { ...context, cognition: reflection.cognition,
      planningGuardrails: [...(context?.planningGuardrails ?? []), ...reflection.planningGuardrails] } : context;
  }

  personalContextFor(rawText, userId = 'local_user', {includeRelations=false}={}) {
    if (userId !== 'local_user' || typeof this.personalContextProvider !== 'function') return null;
    try { return normalizePersonalContext(this.personalContextProvider({ rawText, userId,...(includeRelations?{includeRelations:true}:{}) })); }
    catch { return null; }
  }

  personalProfileStatus() {
    const context = this.personalContextFor('');
    return { available: Boolean(context), profileRevision: context?.profileRevision ?? null,
      generalSectionCount: context?.sectionIds.length ?? 0, identityIncluded: false };
  }

  cognitiveStatus() {
    const growth = this.memoryStore?.storageStatus?.();
    return this.cognition?.snapshot({ tasks: [...this.tasks.values()],
      registeredTools: this.skillRouter.capabilityMatrix().map(skill => skill.toolName),
      growthStorage: growth ? { configured: Boolean(growth.dbPath), integrity: growth.integrity?.status, counts: growth.counts } : null
    }) ?? { available: false };
  }
}

function missionRiskHintForSkill(skill) {
  if (skill.capability?.externalTransfer) return 'external-transfer';
  if (skill.capability?.writesLocalFiles) return 'local-reversible';
  if (skill.capability?.externalNetwork) return 'read-only-web';
  return 'read-only-local';
}

function buildReplanRecoveryContext({ task, previousPlan, previousRecovery }) {
  const graphRun = task.planGraphRun;
  const checkpointMatchesPlan = previousRecovery?.checkpoint?.planId === previousPlan?.planId;
  const journalNodes = checkpointMatchesPlan ? previousRecovery?.nodeRecovery ?? [] : [];
  const runNodes = graphRun?.planId && graphRun.planId !== previousPlan?.planId
    ? []
    : graphRun?.nodeRuns ?? [];
  const nodesById = new Map();
  for (const node of journalNodes) nodesById.set(node.nodeId, node);
  for (const node of runNodes) {
    const previous = nodesById.get(node.nodeId) ?? {};
    nodesById.set(node.nodeId, {
      ...previous,
      nodeId: node.nodeId,
      description: previous.description ?? node.description ?? null,
      status: node.status ?? previous.status,
      packetId: node.packet?.packetId ?? previous.packetId ?? null,
      verificationStatus: node.verificationStatus ?? previous.verificationStatus,
      verificationGate: node.verificationGate ?? previous.verificationGate,
      effectMayExist: previous.effectMayExist === true
        || node.executionStatus === TaskStatus.COMPLETED
        || node.verificationFailed === true,
      outputPaths: node.artifactBundle?.outputPaths ?? previous.outputPaths ?? [],
      changedItems: node.artifactBundle?.changedItems ?? previous.changedItems ?? []
    });
  }
  const nodes = [...nodesById.values()];
  if (!nodes.length || (!graphRun && !journalNodes.length)) return null;
  const mayHaveEffects = nodes.filter((node) => node.effectMayExist === true
    || (node.outputPaths?.length ?? 0) > 0 || (node.changedItems?.length ?? 0) > 0);
  return {
    recoveryVersion: 'a-plan-graph-replan-context-v1',
    sourceTaskId: task.taskId,
    sourcePlanId: previousPlan?.planId ?? null,
    sourceGraphId: previousPlan?.planGraph?.graphId ?? null,
    sourceRunStatus: graphRun?.status ?? previousRecovery?.recoveryStatus ?? 'unknown',
    effectMayExistNodeIds: mayHaveEffects.map((node) => node.nodeId),
    verifiedNodeIds: nodes.filter((node) => node.verifiedCompletion === true
      || (node.status === 'completed' && node.verificationStatus === 'passed'
        && node.verificationGate?.status === 'passed')).map((node) => node.nodeId),
    uncertainNodeIds: nodes.filter((node) => node.recoveryDisposition === 'execution_uncertain'
      || node.status === 'running').map((node) => node.nodeId),
    failedNodeIds: nodes.filter((node) => node.status === 'failed').map((node) => node.nodeId),
    deferredNodeIds: nodes.filter((node) => node.recoveryDisposition === 'deferred_after_failure'
      || node.status === 'skipped').map((node) => node.nodeId),
    effects: mayHaveEffects.map((node) => ({
      nodeId: node.nodeId,
      description: node.description ?? null,
      packetId: node.packetId ?? null,
      verificationStatus: node.verificationStatus ?? null,
      outputPaths: node.outputPaths ?? [],
      changedItems: node.changedItems ?? []
    })),
    currentStateReverificationRequired: true,
    explicitReplanAndApprovalRequired: true,
    automaticResumeAllowed: false
  };
}
