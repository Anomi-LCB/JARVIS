import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendJsonlSync } from '../../../shared/src/jsonl.js';

export class OrchestrationJournal {
  constructor({ journalPath = 'logs/core-orchestration.jsonl', clock = () => new Date() } = {}) {
    this.journalPath = journalPath;
    this.clock = clock;
    this.records = [];
    this.load();
  }

  load() {
    if (!this.journalPath || !existsSync(this.journalPath)) {
      this.records = [];
      return;
    }
    this.records = readFileSync(this.journalPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  append(record) {
    const item = {
      journalId: `orch_${this.records.length + 1}_${Date.parse(this.clock().toISOString()).toString(36)}`,
      recordedAt: this.clock().toISOString(),
      ...record
    };
    this.records.push(item);
    if (this.journalPath) appendJsonlSync(this.journalPath, item);
    return item;
  }

  recordCheckpoint({ trace, task = null, reason = 'checkpoint' }) {
    return this.append({
      recordType: 'orchestration_checkpoint',
      traceId: trace.traceId,
      taskId: trace.taskId,
      planId: trace.planId,
      status: trace.status,
      reason,
      stepCount: trace.steps.length,
      failureCount: trace.failures.length,
      planGraph: task?.plan?.planGraph ?? null,
      compensationPlan: task?.plan?.compensationPlan ?? null,
      recoveryContext: task?.recoveryContext ?? null
    });
  }

  recordClarificationSnapshot({ trace, task = null, clarificationChain = null, approvalCard = null, reason = 'clarification_snapshot' }) {
    const chain = clarificationChain ?? task?.clarificationChain ?? null;
    const card = approvalCard ?? task?.approvalCard ?? null;
    const entries = chain?.entries ?? [];
    const snapshot = {
      snapshotVersion: 'a-clarification-chain-snapshot-v1',
      recordType: 'clarification_chain_snapshot',
      traceId: trace.traceId,
      taskId: trace.taskId,
      planId: trace.planId,
      approvalId: card?.approvalId ?? null,
      reason,
      status: chain?.status ?? 'not_required',
      currentClarificationId: chain?.currentClarificationId ?? null,
      totalEntries: chain?.totalEntries ?? entries.length,
      latestPreviewDiff: entries.at(-1)?.previewDiff ?? null,
      chainHash: createHash('sha256').update(JSON.stringify({
        taskId: trace.taskId,
        planId: trace.planId,
        approvalId: card?.approvalId ?? null,
        status: chain?.status ?? null,
        entries
      })).digest('hex'),
      conversationSummary: {
        question: card?.clarificationRequest?.question ?? null,
        choiceCount: card?.clarificationRequest?.choices?.length ?? 0,
        missingSlots: card?.clarificationRequest?.missingSlots ?? [],
        responseCount: entries.filter((entry) => entry.response).length,
        lastDecision: entries.findLast?.((entry) => entry.response)?.response?.decision
          ?? [...entries].reverse().find((entry) => entry.response)?.response?.decision
          ?? null
      },
      chain
    };
    return this.append(snapshot);
  }

  recordStep({ trace, step }) {
    return this.append({
      recordType: 'orchestration_step',
      traceId: trace.traceId,
      taskId: trace.taskId,
      planId: trace.planId,
      phase: step.phase,
      module: step.module,
      status: step.status,
      order: step.order,
      evidence: step.evidence
    });
  }

  recordNode({ trace, nodeId, status, evidence = {} }) {
    return this.append({
      recordType: 'orchestration_node',
      traceId: trace.traceId,
      taskId: trace.taskId,
      planId: trace.planId,
      nodeId,
      status,
      evidence
    });
  }

  recordCompensation({ trace, compensationAction, status = 'planned', evidence = {} }) {
    return this.append({
      recordType: 'orchestration_compensation',
      traceId: trace.traceId,
      taskId: trace.taskId,
      planId: trace.planId,
      compensationId: compensationAction.compensationId,
      targetNodeId: compensationAction.targetNodeId,
      action: compensationAction.action,
      status,
      evidence
    });
  }

  recordsForTask(taskId) {
    return this.records.filter((record) => record.taskId === taskId);
  }

  latestCheckpoint(taskId) {
    return [...this.recordsForTask(taskId)]
      .reverse()
      .find((record) => record.recordType === 'orchestration_checkpoint') ?? null;
  }

  resumeContext(taskId) {
    const records = this.recordsForTask(taskId);
    const checkpoint = this.latestCheckpoint(taskId);
    const nodeRecords = new Map();
    for (const record of records.filter((item) => item.recordType === 'orchestration_node'
      && (!checkpoint?.planId || item.planId === checkpoint.planId))) {
      nodeRecords.set(record.nodeId, record);
    }
    const graphNodes = checkpoint?.planGraph?.nodes ?? [];
    const actionNodes = graphNodes.filter((node) => node.nodeId?.startsWith('action_'));
    const edges = checkpoint?.planGraph?.edges ?? [];
    const nodeRecovery = actionNodes.map((node) => {
      const record = nodeRecords.get(node.nodeId) ?? null;
      const evidence = record?.evidence ?? {};
      const artifact = evidence.artifactBundle ?? null;
      const verifiedCompletion = record?.status === 'completed'
        && evidence.verificationGate?.status === 'passed'
        && evidence.verificationStatus === 'passed'
        && typeof evidence.verificationId === 'string'
        && evidence.verificationId.length > 0
        && artifact?.status === 'completed'
        && artifact?.taskId === taskId
        && artifact?.planId === checkpoint?.planId
        && artifact?.graphId === checkpoint?.planGraph?.graphId
        && artifact?.nodeId === node.nodeId;
      const dependencies = edges
        .filter((edge) => edge.to === node.nodeId && edge.from?.startsWith('action_') && edge.condition === 'success')
        .map((edge) => edge.from);
      return {
        nodeId: node.nodeId,
        description: node.description,
        status: record?.status ?? 'pending',
        lastRecordedAt: record?.recordedAt ?? null,
        packetId: evidence.packetId ?? artifact?.packetId ?? null,
        verifiedCompletion,
        verificationId: evidence.verificationId ?? null,
        verificationStatus: evidence.verificationStatus ?? null,
        verificationGate: evidence.verificationGate ?? null,
        effectMayExist: evidence.verificationFailed === true
          || (artifact?.outputPaths?.length ?? 0) > 0
          || (artifact?.changedItems?.length ?? 0) > 0,
        artifactBundleId: artifact?.bundleId ?? null,
        outputPaths: artifact?.outputPaths ?? [],
        changedItems: artifact?.changedItems ?? [],
        dependencies,
        recoveryDisposition: recoveryDisposition(record, verifiedCompletion)
      };
    });
    const verifiedNodeIds = new Set(nodeRecovery.filter((node) => node.verifiedCompletion).map((node) => node.nodeId));
    const pendingNodes = nodeRecovery
      .filter((node) => node.recoveryDisposition !== 'already_verified')
      .map((node) => ({
        ...node,
        dependenciesReady: node.dependencies.every((nodeId) => verifiedNodeIds.has(nodeId))
      }));
    const uncertainNodes = nodeRecovery.filter((node) => node.recoveryDisposition === 'execution_uncertain');
    const reviewNodes = nodeRecovery.filter((node) => ['manual_review_required', 'reverify_before_resume'].includes(node.recoveryDisposition));
    const recoveryStatus = !checkpoint
      ? 'no_checkpoint'
      : uncertainNodes.length > 0
        ? 'execution_uncertain_review_required'
        : reviewNodes.some((node) => node.recoveryDisposition === 'manual_review_required')
          ? 'revised_plan_and_approval_required'
          : pendingNodes.length > 0
            ? 'reverify_prior_effects_before_resume'
            : 'no_pending_action_nodes';
    return {
      taskId,
      resumable: Boolean(checkpoint),
      recoveryStatus,
      automaticResumeAllowed: false,
      actionNodeCount: actionNodes.length,
      verifiedCompletedNodeIds: [...verifiedNodeIds],
      recoveryContext: checkpoint?.recoveryContext ?? null,
      checkpoint,
      pendingNodes,
      nodeRecovery,
      records: records.slice(-20)
    };
  }
}

function recoveryDisposition(record, verifiedCompletion) {
  if (!record) return 'not_started';
  if (verifiedCompletion) return 'already_verified';
  if (record.status === 'running') return 'execution_uncertain';
  if (record.status === 'completed') return 'reverify_before_resume';
  if (record.status === 'failed') return 'manual_review_required';
  if (record.status === 'skipped') {
    const reason = record.evidence?.reason;
    if (['graph-stopped-after-node-failure', 'ancestor-node-failed', 'dependency-not-completed'].includes(reason)) {
      return 'deferred_after_failure';
    }
    return 'manual_review_required';
  }
  if (['planned', 'ready'].includes(record.status)) return 'not_started';
  if (record.status === 'compensated') return 'compensated_review_required';
  return 'manual_review_required';
}
