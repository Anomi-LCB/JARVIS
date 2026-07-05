import { createApprovalCard, createTaskRequest, InputSource, ModuleId, stableId, TaskStatus } from '../../shared/src/types.js';
import { EventBus } from './runtime/event-bus.js';
import { TaskStateMachine } from './runtime/state-machine.js';
import { TaskLifecycle } from './runtime/task-lifecycle.js';
import { CommandIntake } from './intake/command-intake.js';
import { IntentParser } from './intent/intent-parser.js';
import { AmbiguityResolver } from './intent/ambiguity-resolver.js';
import { ContextSnapshotBuilder } from './context/context-snapshot.js';
import { TaskPlanner } from './planning/task-planner.js';
import { SkillRouter } from './routing/skill-router.js';
import { AgentOrchestratorLite } from './orchestration/agent-orchestrator-lite.js';
import { OrchestrationJournal } from './orchestration/orchestration-journal.js';
import { createDefaultContractRegistry } from './contracts/default-contracts.js';

export class CoreFacade {
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
    taskPlanner = null
  } = {}) {
    this.policyEngine = policyEngine;
    this.memoryStore = memoryStore;
    this.verificationEngine = verificationEngine;
    this.contractRegistry = contractRegistry;
    this.clock = clock;
    this.eventBus = eventBus ?? new EventBus({ clock, eventLogPath });
    this.commandIntake = new CommandIntake({ clock, inputProviderRegistry });
    this.intentParser = intentParser ?? new IntentParser();
    this.ambiguityResolver = new AmbiguityResolver({ clock });
    this.contextBuilder = new ContextSnapshotBuilder({ cwd, clock, desktopContextProvider, desktopContextCollector });
    this.taskPlanner = taskPlanner ?? new TaskPlanner();
    this.skillRouter = new SkillRouter();
    this.orchestrator = new AgentOrchestratorLite({
      clock,
      journal: new OrchestrationJournal({ clock, journalPath: orchestrationJournalPath ?? 'logs/core-orchestration.jsonl' })
    });
    this.tasks = new Map();
  }

  createTask(rawText, options = {}) {
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

  createCliTask(rawText, options = {}) {
    return this.createTaskFromRequest(this.commandIntake.fromCli(rawText, options), options);
  }

  createTaskFromRequest(taskRequest, options = {}) {
    taskRequest = this.ensureUniqueTaskRequest(taskRequest);
    this.contractRegistry.assert('TaskRequest', taskRequest);
    const machine = new TaskStateMachine(TaskStatus.CREATED, { clock: this.clock });
    this.eventBus.publish('task.requested', { taskRequest });
    machine.transition(TaskStatus.PLANNING, 'intent-parsing');

    const memoryContext = this.memoryStore?.query?.(taskRequest.command.rawText) ?? [];
    const planningContext = this.memoryStore?.planningPreferenceContext?.(taskRequest.command.rawText) ?? null;
    const intent = this.intentParser.parse(taskRequest.command.rawText, {
      requestId: taskRequest.requestId,
      createdAt: taskRequest.createdAt
    });
    this.contractRegistry.assert('IntentCandidate', intent);
    const ambiguity = this.ambiguityResolver.resolve({ taskRequest, candidates: intent.candidates });
    this.contractRegistry.assert('AmbiguitySet', ambiguity);
    const route = this.skillRouter.route(ambiguity.selected ?? intent);
    const contextSnapshot = this.contextBuilder.build(taskRequest, {
      memoryContext,
      environment: options.environment,
      desktopContextApproval: options.desktopContextApproval
    });
    this.contractRegistry.assert('ContextSnapshot', contextSnapshot);
    const plan = this.taskPlanner.createPlan(taskRequest, ambiguity.selected ?? intent, { contextSnapshot, route, planningContext });
    this.contractRegistry.assert('TaskPlan', plan);
    this.contractRegistry.assert('PolicyCheckRequest', plan.policyCheckRequest);
    const lifecycle = new TaskLifecycle({ taskId: taskRequest.taskId, createdAt: taskRequest.createdAt });
    lifecycle.mark(TaskStatus.PLANNING, '계획 생성', 'IntentParser and TaskPlanner completed', taskRequest.createdAt);
    this.eventBus.publish('intent.parsed', { taskId: taskRequest.taskId, intent, ambiguity });
    this.eventBus.publish('context.snapshot.created', { taskId: taskRequest.taskId, contextSnapshot });
    this.eventBus.publish('task.plan.created', { taskId: taskRequest.taskId, plan });
    const policy = this.policyEngine?.evaluatePlan?.({ taskRequest, plan }) ?? {
      decision: 'require_approval',
      risk: { tier: 5, reasons: [] },
      approval: { required: true, mobileApprovalAllowed: true, expiresInSec: 1800 },
      constraints: { allowDelete: false, allowExternalTransfer: false, allowAdminPrivilege: false, reversibleRequired: true }
    };

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
    this.eventBus.publish('clarification.chain.updated', { taskId: plan.taskId, clarificationChain: record.clarificationChain });
    this.eventBus.publish('orchestration.trace.updated', { taskId: plan.taskId, trace: record.orchestrationTrace });
    this.eventBus.publish('approval.card.created', { taskId: plan.taskId, approvalCard });
    return record;
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

  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  submitApprovalDecision(decision) {
    this.contractRegistry.assert('ApprovalDecision', decision);
    const task = this.getTask(decision.taskId);
    if (!task) {
      return { success: false, status: TaskStatus.BLOCKED, reason: 'task-not-found' };
    }
    this.eventBus.publish(`approval.${decision.decision}`, { decision });
    if (decision.decision === 'reject') {
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
      return { success: true, status: task.status };
    }
    if (decision.decision === 'edit' || decision.decision === 'respond') {
      return this.replanTaskFromApprovalDecision(task, decision);
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
    return { success: true, status: task.status };
  }

  replanTaskFromApprovalDecision(task, decision) {
    const revisedText = decision.editRequest?.rawText
      ?? decision.editRequest?.text
      ?? decision.responseText
      ?? task.request.command.rawText;
    const previousPlan = task.plan;
    const revisedRequest = {
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
    const memoryContext = this.memoryStore?.query?.(revisedRequest.command.rawText) ?? [];
    const planningContext = this.memoryStore?.planningPreferenceContext?.(revisedRequest.command.rawText) ?? null;
    const contextSnapshot = this.contextBuilder.build(revisedRequest, {
      memoryContext,
      desktopContextApproval: task.contextSnapshot?.environment?.desktop?.approval?.approved
        ? task.contextSnapshot.environment.desktop.approval
        : null
    });
    this.contractRegistry.assert('ContextSnapshot', contextSnapshot);
    const plan = this.taskPlanner.createPlan(revisedRequest, ambiguity.selected ?? intent, { contextSnapshot, route, planningContext });
    plan.replanOf = previousPlan.planId;
    this.contractRegistry.assert('TaskPlan', plan);
    this.contractRegistry.assert('PolicyCheckRequest', plan.policyCheckRequest);
    const policy = this.policyEngine?.evaluatePlan?.({ taskRequest: revisedRequest, plan }) ?? task.policy;
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
      warnings: policy.securityWarnings ?? [],
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
    this.eventBus.publish('clarification.chain.updated', { taskId: task.taskId, clarificationChain: task.clarificationChain });
    this.eventBus.publish('task.replanned', { taskId: task.taskId, previousPlanId: previousPlan.planId, plan, approvalCard });
    this.eventBus.publish('approval.card.created', { taskId: task.taskId, approvalCard });
    this.eventBus.publish('orchestration.trace.updated', { taskId: task.taskId, trace: task.orchestrationTrace });
    return { success: true, status: task.status, plan, approvalCard };
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

  recordExecutionFailure(taskId, { reason = 'execution-failed', evidence = {} } = {}) {
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

  retryTask(taskId, { reason = 'retry-requested', evidence = {} } = {}) {
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
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
    const result = this.orchestrator.planCompensation({ task, failureBranchId, evidence, targetNodeIds, mode });
    this.eventBus.publish('compensation.planned', { taskId, result });
    this.eventBus.publish('orchestration.trace.updated', { taskId, trace: task.orchestrationTrace });
    return { success: true, ...result };
  }

  beginCompensation(taskId, { failureBranchId = 'failure_execution_partial', evidence = {}, targetNodeIds = null, mode = 'full' } = {}) {
    const task = this.getTask(taskId);
    if (!task) return { success: false, reason: 'task-not-found' };
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

  adminDiagnostics() {
    return {
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
      skillMatrix: this.skillRouter.capabilityMatrix(),
      skillPluginRegistry: this.skillRouter.pluginRegistry(),
      skillCompatibilitySnapshot: this.skillRouter.compatibilitySnapshot({ label: 'admin-diagnostics', record: false }),
      contextTelemetry: this.contextBuilder.desktopTelemetryReport?.() ?? null,
      contextProviderContract: this.contextProviderContractStatus(),
      contractSchemas: this.contractRegistry.schemas(),
      orchestration: [...this.tasks.values()].map((task) => this.resumeTask(task.taskId))
    };
  }
}
