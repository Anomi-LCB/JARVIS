import {
  createCapabilityRequest,
  createExecutionPacket,
  createOrchestrationTrace,
  stableId,
  TaskStatus
} from '../../../shared/src/types.js';
import { OrchestrationJournal } from './orchestration-journal.js';

export class AgentOrchestratorLite {
  constructor({ clock = () => new Date(), journal = new OrchestrationJournal({ clock }) } = {}) {
    this.clock = clock;
    this.journal = journal;
  }

  startTrace({ task, status = 'started' }) {
    const createdAt = this.clock().toISOString();
    const trace = createOrchestrationTrace({
      traceId: stableId('trace', task.taskId, createdAt),
      taskId: task.taskId,
      planId: task.plan?.planId ?? null,
      status,
      steps: [],
      failures: [],
      createdAt,
      updatedAt: createdAt
    });
    this.journal?.recordCheckpoint({ trace, task, reason: 'trace_started' });
    for (const node of task.plan?.planGraph?.nodes ?? []) {
      this.journal?.recordNode({ trace, nodeId: node.nodeId, status: 'planned' });
    }
    return trace;
  }

  appendTrace(trace, { phase, module = 'A_CORE', status = 'ok', evidence = {}, message }) {
    const updatedAt = this.clock().toISOString();
    const step = {
      order: trace.steps.length + 1,
      phase,
      module,
      status,
      message,
      evidence,
      at: updatedAt
    };
    trace.steps.push(step);
    trace.status = status === 'failed' ? 'failed' : 'running';
    trace.updatedAt = updatedAt;
    if (status === 'failed') trace.failures.push(step);
    this.journal?.recordStep({ trace, step });
    return trace;
  }

  completeTrace(trace, evidence = {}) {
    const updatedAt = this.clock().toISOString();
    trace.status = 'completed';
    trace.updatedAt = updatedAt;
    trace.steps.push({
      order: trace.steps.length + 1,
      phase: 'orchestration.completed',
      module: 'A_CORE',
      status: 'ok',
      message: 'A orchestration trace completed.',
      evidence,
      at: updatedAt
    });
    this.journal?.recordCheckpoint({ trace, reason: 'trace_completed' });
    return trace;
  }

  checkpointTrace({ task, reason = 'manual_checkpoint' }) {
    return this.journal?.recordCheckpoint({ trace: task.orchestrationTrace, task, reason });
  }

  recordClarificationSnapshot({ task, reason = 'clarification_snapshot' }) {
    return this.journal?.recordClarificationSnapshot({
      trace: task.orchestrationTrace,
      task,
      clarificationChain: task.clarificationChain,
      approvalCard: task.approvalCard,
      reason
    });
  }

  markNode({ task, nodeId, status, evidence = {} }) {
    return this.journal?.recordNode({ trace: task.orchestrationTrace, nodeId, status, evidence });
  }

  resumeContext(taskId) {
    return this.journal?.resumeContext(taskId) ?? { taskId, resumable: false, pendingNodes: [], records: [] };
  }

  planCompensation({ task, failureBranchId = 'failure_execution_partial', evidence = {}, targetNodeIds = null, mode = 'full' }) {
    const targetSet = Array.isArray(targetNodeIds) ? new Set(targetNodeIds) : null;
    const compensationActions = (task.plan?.compensationPlan?.compensatingActions ?? [])
      .filter((compensationAction) => !targetSet || targetSet.has(compensationAction.targetNodeId));
    const planned = compensationActions.map((compensationAction) => this.journal?.recordCompensation({
      trace: task.orchestrationTrace,
      compensationAction,
      status: 'planned',
      evidence: { failureBranchId, mode, targetNodeIds: targetNodeIds ?? null, ...evidence }
    }));
    this.appendTrace(task.orchestrationTrace, {
      phase: mode === 'partial' ? 'compensation.partial.planned' : 'compensation.planned',
      module: 'A_CORE',
      status: planned.length ? 'ok' : 'ok',
      message: planned.length ? 'Compensation actions were planned from TaskPlan.' : 'No compensation actions are required for this task.',
      evidence: { failureBranchId, compensationCount: planned.length, mode, targetNodeIds: targetNodeIds ?? null }
    });
    return {
      taskId: task.taskId,
      failureBranchId,
      compensationPlanId: task.plan?.compensationPlan?.compensationPlanId ?? null,
      mode,
      targetNodeIds: targetNodeIds ?? null,
      actions: planned.filter(Boolean)
    };
  }

  recordCompensationExecution({ task, compensationAction, status = 'compensated', evidence = {} }) {
    const record = this.journal?.recordCompensation({
      trace: task.orchestrationTrace,
      compensationAction,
      status,
      evidence
    });
    this.appendTrace(task.orchestrationTrace, {
      phase: `compensation.action.${status}`,
      module: 'A_CORE',
      status: status === 'failed' ? 'failed' : 'ok',
      message: `Compensation action ${compensationAction.compensationId} marked ${status}.`,
      evidence: {
        compensationId: compensationAction.compensationId,
        targetNodeId: compensationAction.targetNodeId,
        action: compensationAction.action,
        ...evidence
      }
    });
    return record;
  }

  buildCapabilityRequest({ task, approvalDecision }) {
    const request = createCapabilityRequest({
      requestId: stableId('capreq', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      planId: task.plan.planId,
      approvalId: approvalDecision.approvalId,
      action: task.plan.action,
      constraints: task.policy.constraints,
      createdAt: this.clock().toISOString()
    });
    this.appendTrace(task.orchestrationTrace, {
      phase: 'capability.request.created',
      module: 'A_CORE',
      message: 'CapabilityRequest prepared after approval.',
      evidence: { requestId: request.requestId, approvalId: request.approvalId, toolName: request.action.toolName }
    });
    return request;
  }

  buildExecutionPacket({ task, capabilityToken, approvalDecision, userConfirmation = { confirmed: false } }) {
    const packet = createExecutionPacket({
      packetId: stableId('packet', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      planId: task.plan.planId,
      action: task.plan.action,
      capabilityToken,
      requestedMode: 'execute',
      userConfirmation,
      approvalDecision,
      traceId: task.orchestrationTrace?.traceId,
      createdAt: this.clock().toISOString()
    });
    this.appendTrace(task.orchestrationTrace, {
      phase: 'execution.packet.created',
      module: 'A_CORE',
      message: 'ExecutionPacket prepared for B PC agent.',
      evidence: { packetId: packet.packetId, toolName: packet.action.toolName, confirmed: packet.userConfirmation.confirmed }
    });
    return packet;
  }

  dummyExecutionResult({ task, approvalDecision }) {
    return {
      taskId: task.taskId,
      status: TaskStatus.COMPLETED,
      executionResult: {
        status: 'success',
        summary: `A dummy execution completed after ${approvalDecision.decision}.`,
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: true
      }
    };
  }
}
