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
      compensationPlan: task?.plan?.compensationPlan ?? null
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
    const nodeStates = new Map();
    for (const record of records.filter((item) => item.recordType === 'orchestration_node')) {
      nodeStates.set(record.nodeId, record.status);
    }
    const graphNodes = checkpoint?.planGraph?.nodes ?? [];
    const pendingNodes = graphNodes
      .filter((node) => !['completed', 'skipped', 'compensated'].includes(nodeStates.get(node.nodeId)))
      .map((node) => ({
        nodeId: node.nodeId,
        description: node.description,
        status: nodeStates.get(node.nodeId) ?? 'pending'
      }));
    return {
      taskId,
      resumable: Boolean(checkpoint),
      checkpoint,
      pendingNodes,
      records: records.slice(-20)
    };
  }
}
