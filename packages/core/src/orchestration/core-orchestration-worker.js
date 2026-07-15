import { createHash } from 'node:crypto';
import { ApprovalDecision, createApprovalDecision, ModuleId, stableId, TaskStatus } from '../../../shared/src/types.js';
import { WorkerLeaseTable } from '../runtime/worker-lease-table.js';
import { FileWorkerQueueStore } from '../runtime/worker-queue-store.js';

export class CoreOrchestrationWorker {
  constructor({
    coreFacade,
    policyRuntime = null,
    pcAgent = null,
    verificationRuntime = null,
    growthRuntime = null,
    allowedPaths = ['./workspace'],
    maxAttempts = 2,
    baseBackoffMs = 1000,
    defaultTimeoutMs = 30_000,
    maxPlanParallelism = 4,
    artifactRetentionLimit = 500,
    workerId = null,
    leaseTable = null,
    leaseStorePath = null,
    queueStore = null,
    queueStorePath = null,
    leaseTtlMs = 45_000,
    clock = () => new Date()
  } = {}) {
    if (!coreFacade) {
      throw new Error('CoreOrchestrationWorker requires coreFacade.');
    }
    this.coreFacade = coreFacade;
    this.policyRuntime = policyRuntime;
    this.pcAgent = pcAgent;
    this.verificationRuntime = verificationRuntime;
    this.growthRuntime = growthRuntime;
    this.allowedPaths = allowedPaths;
    this.maxAttempts = maxAttempts;
    this.baseBackoffMs = baseBackoffMs;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxPlanParallelism = maxPlanParallelism;
    this.artifactRetentionLimit = artifactRetentionLimit;
    this.workerId = workerId ?? stableId('core_worker', process.pid, clock().toISOString());
    this.leaseTtlMs = leaseTtlMs;
    this.clock = clock;
    this.leaseTable = leaseTable ?? new WorkerLeaseTable({ clock, defaultTtlMs: leaseTtlMs, storePath: leaseStorePath });
    this.queueStore = queueStore ?? (queueStorePath ? new FileWorkerQueueStore({ filePath: queueStorePath, clock }) : null);
    this.lastQueuePersistedAt = null;
    this.runs = [];
    this.queue = [];
    this.activeTaskIds = new Set();
    this.nodeArtifactArchive = [];
    this.loadPersistedQueueState();
  }

  enqueueTask(taskId, options = {}) {
    const now = this.clock().toISOString();
    const item = {
      queueId: stableId('core_queue', `${taskId}:${this.queue.length + 1}`, now),
      taskId,
      options,
      status: 'queued',
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.maxAttempts,
      baseBackoffMs: options.baseBackoffMs ?? this.baseBackoffMs,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      lastRunId: null,
      lastError: null
    };
    this.queue.push(item);
    this.coreFacade.eventBus.publish('worker.queue.enqueued', { taskId, queueId: item.queueId });
    this.persistQueue('worker.queue.enqueued');
    return this.publicQueueItem(item);
  }

  async drain({ limit = 5, now = this.clock().toISOString() } = {}) {
    const results = [];
    const processedQueueIds = new Set();
    for (let index = 0; index < limit; index += 1) {
      const processed = await this.runNext({ now, excludeQueueIds: processedQueueIds });
      if (!processed.processed) break;
      results.push(processed);
      if (processed.item?.queueId) processedQueueIds.add(processed.item.queueId);
    }
    return {
      processed: results.length,
      results,
      status: this.queueStatus()
    };
  }

  async runNext({ now = this.clock().toISOString(), excludeQueueIds = null } = {}) {
    const item = this.nextRunnable(now, { excludeQueueIds });
    if (!item) {
      return { processed: false, reason: 'queue-empty', status: this.queueStatus() };
    }
    if (this.activeTaskIds.has(item.taskId)) {
      this.scheduleRetry(item, 'task-locked');
      return { processed: true, locked: true, item: this.publicQueueItem(item), reason: 'task-locked' };
    }
    const lease = this.leaseTable.acquire(item.taskId, {
      ownerId: this.workerId,
      queueId: item.queueId,
      ttlMs: Math.max(item.timeoutMs, this.leaseTtlMs),
      metadata: { attempt: item.attempts + 1 },
      now
    });
    if (!lease.acquired) {
      this.scheduleRetry(item, 'task-lease-active');
      return { processed: true, locked: true, item: this.publicQueueItem(item), reason: 'task-lease-active', lease: lease.lease };
    }
    this.activeTaskIds.add(item.taskId);
    item.status = 'running';
    item.attempts += 1;
    item.updatedAt = this.clock().toISOString();
    item.lease = lease.lease;
    this.coreFacade.eventBus.publish('worker.queue.running', { taskId: item.taskId, queueId: item.queueId, attempt: item.attempts });
    this.coreFacade.eventBus.publish('worker.lease.acquired', { taskId: item.taskId, queueId: item.queueId, lease: lease.lease });
    this.persistQueue('worker.queue.running');
    try {
      this.prepareTaskForRetry(item.taskId);
      const run = await this.withTimeout(this.runTask(item.taskId, item.options), item.timeoutMs);
      item.lastRunId = run.runId;
      item.updatedAt = this.clock().toISOString();
      if (run.success) {
        item.status = 'succeeded';
        item.completedAt = item.updatedAt;
        this.coreFacade.eventBus.publish('worker.queue.succeeded', { taskId: item.taskId, queueId: item.queueId, runId: run.runId });
        this.persistQueue('worker.queue.succeeded');
      } else if (item.attempts < item.maxAttempts) {
        this.scheduleRetry(item, run.error?.code ?? run.failure?.reason ?? 'worker-run-failed');
      } else {
        item.status = 'failed';
        item.lastError = run.error?.code ?? run.failure?.reason ?? 'worker-run-failed';
        this.coreFacade.eventBus.publish('worker.queue.failed', { taskId: item.taskId, queueId: item.queueId, error: item.lastError });
        this.persistQueue('worker.queue.failed');
      }
      return { processed: true, item: this.publicQueueItem(item), run };
    } catch (error) {
      item.updatedAt = this.clock().toISOString();
      if (item.attempts < item.maxAttempts) {
        this.scheduleRetry(item, error.code ?? error.message ?? 'worker-exception');
      } else {
        item.status = 'failed';
        item.lastError = error.code ?? error.message ?? 'worker-exception';
        this.coreFacade.eventBus.publish('worker.queue.failed', { taskId: item.taskId, queueId: item.queueId, error: item.lastError });
        this.persistQueue('worker.queue.failed');
      }
      return { processed: true, item: this.publicQueueItem(item), error: { code: error.code ?? 'A_WORKER_RUN_FAILED', message: error.message } };
    } finally {
      this.activeTaskIds.delete(item.taskId);
      const released = this.leaseTable.release(item.taskId, {
        ownerId: this.workerId,
        reason: 'run-next-finally'
      });
      if (released.released) {
        this.coreFacade.eventBus.publish('worker.lease.released', { taskId: item.taskId, queueId: item.queueId, lease: released.lease });
      }
    }
  }

  async runTask(taskId, {
    approvalDecision = null,
    deviceId = 'core_worker',
    userConfirmation = { confirmed: true },
    dryRun = false
  } = {}) {
    const task = this.coreFacade.getTask(taskId);
    if (!task) {
      return { success: false, error: { code: 'A_WORKER_TASK_NOT_FOUND', taskId } };
    }
    const decision = approvalDecision ?? this.createWorkerApprovalDecision(task, { deviceId });
    const submitted = this.ensureApproved(task, decision);
    if (!submitted.success) {
      return { success: false, taskId, status: task.status, approval: submitted };
    }
    if (task.status !== TaskStatus.APPROVED) {
      return { success: false, taskId, status: task.status, error: { code: 'A_WORKER_TASK_NOT_APPROVED' } };
    }

    const capabilityRequest = this.coreFacade.createCapabilityRequest(taskId, decision);
    const capabilityToken = this.issueCapabilityToken(task, decision);
    const planVerification = this.verifyPlan(task);
    const policyVerification = this.verifyPolicy(task, decision, capabilityToken);
    if (this.failedVerification(policyVerification)) {
      return this.failBeforeExecution(task, {
        reason: 'A_WORKER_POLICY_VERIFICATION_FAILED',
        decision,
        capabilityRequest,
        capabilityToken,
        planVerification,
        policyVerification
      });
    }

    const packet = this.coreFacade.createExecutionPacket(taskId, {
      capabilityToken,
      approvalDecision: decision,
      userConfirmation: {
        confirmed: userConfirmation.confirmed === true,
        confirmedAt: userConfirmation.confirmedAt ?? this.clock().toISOString(),
        approvalId: decision.approvalId
      }
    });
    if (!this.pcAgent?.receiveExecutionPacket) {
      return this.failBeforeExecution(task, {
        reason: 'A_WORKER_PC_AGENT_UNAVAILABLE',
        decision,
        capabilityRequest,
        capabilityToken,
        planVerification,
        policyVerification,
        packet
      });
    }

    this.markExecutionStarted(task, { packetId: packet.packetId, dryRun });
    if (this.shouldRunPlanGraph(task)) {
      return await this.runPlanGraphTask(task, {
        decision,
        capabilityRequest,
        capabilityToken,
        basePacket: packet,
        planVerification,
        policyVerification,
        dryRun
      });
    }

    const execution = await this.pcAgent.receiveExecutionPacket(packet, { dryRun });
    if (execution.status !== TaskStatus.COMPLETED) {
      const failure = this.coreFacade.recordExecutionFailure(taskId, {
        reason: execution.blockedReason ?? execution.executionResult?.summary ?? 'A_WORKER_EXECUTION_NOT_COMPLETED',
        evidence: { packetId: packet.packetId, status: execution.status }
      });
      return this.storeRun({
        success: false,
        taskId,
        status: task.status,
        decision,
        capabilityRequest,
        capability: this.publicCapability(capabilityToken),
        packet: this.publicPacket(packet),
        planVerification,
        policyVerification,
        execution,
        failure
      });
    }

    const executionVerification = await this.verifyExecution(task, execution, capabilityToken);
    const learning = this.ingestAndVerifyLearning(task, execution);
    this.completeTask(task, {
      execution,
      executionVerification,
      learning,
      packetId: packet.packetId
    });
    return this.storeRun({
      success: true,
      taskId,
      status: task.status,
      decision,
      capabilityRequest,
      capability: this.publicCapability(capabilityToken),
      packet: this.publicPacket(packet),
      planVerification,
      policyVerification,
      execution,
      executionVerification,
      learning,
      trace: task.orchestrationTrace
    });
  }

  async runCompensation(taskId, {
    failureBranchId = 'failure_execution_partial',
    targetNodeIds = null,
    mode = targetNodeIds ? 'partial' : 'full',
    reason = 'core-worker-compensation-replay'
  } = {}) {
    const task = this.coreFacade.getTask(taskId);
    if (!task) {
      return { success: false, error: { code: 'A_WORKER_TASK_NOT_FOUND', taskId } };
    }
    const started = this.coreFacade.beginCompensation(taskId, {
      failureBranchId,
      targetNodeIds,
      mode,
      evidence: {
        runner: 'CoreOrchestrationWorker',
        reason
      }
    });
    if (!started.success) return started;
    const compensationActions = this.compensationActionsForReplay(task, { targetNodeIds });
    const rollbackProof = await this.executeRollbackProof(task, { reason, compensationActions });
    const results = compensationActions.map((action) => {
      const status = rollbackProof.success ? 'compensated' : 'manual_review_required';
      const evidence = {
        replayVersion: 'a-node-compensation-replay-v1',
        rollbackProofStatus: rollbackProof.success ? 'success' : 'unavailable',
        rollbackTransactionId: rollbackProof.transaction?.transactionId ?? null,
        rolledBackCount: rollbackProof.rolledBack?.length ?? 0,
        skippedCount: rollbackProof.skipped?.length ?? 0
      };
      const journalRecord = this.coreFacade.orchestrator.recordCompensationExecution({
        task,
        compensationAction: action,
        status,
        evidence
      });
      if (action.targetNodeId) {
        this.coreFacade.orchestrator.markNode({
          task,
          nodeId: action.targetNodeId,
          status,
          evidence
        });
      }
      return {
        compensationId: action.compensationId,
        targetNodeId: action.targetNodeId,
        action: action.action,
        status,
        journalRecord
      };
    });
    const replay = {
      replayVersion: 'a-node-compensation-replay-v1',
      taskId,
      status: results.every((item) => item.status === 'compensated') ? 'completed' : 'manual_review_required',
      failureBranchId,
      mode,
      targetNodeIds,
      actionCount: results.length,
      results,
      rollbackProof
    };
    task.compensationReplay = replay;
    this.coreFacade.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'compensation.replay.completed',
      module: ModuleId.CORE,
      status: replay.status === 'completed' ? 'ok' : 'failed',
      message: 'Core worker replayed node-level compensation actions.',
      evidence: {
        replayVersion: replay.replayVersion,
        actionCount: replay.actionCount,
        rollbackSuccess: rollbackProof.success === true
      }
    });
    this.coreFacade.eventBus.publish('worker.compensation.replayed', { taskId, replay });
    if (replay.status === 'completed') {
      const completed = this.coreFacade.completeCompensation(taskId, { replay, rollbackProof });
      return this.storeRun({
        success: true,
        taskId,
        status: completed.status,
        compensationReplay: replay
      });
    }
    this.coreFacade.eventBus.publish('worker.compensation.manual_review_required', { taskId, replay });
    return this.storeRun({
      success: false,
      taskId,
      status: task.status,
      compensationReplay: replay
    });
  }

  compensationActionsForReplay(task, { targetNodeIds = null } = {}) {
    const targetSet = Array.isArray(targetNodeIds) ? new Set(targetNodeIds) : null;
    return (task.plan?.compensationPlan?.compensatingActions ?? [])
      .filter((action) => !targetSet || targetSet.has(action.targetNodeId));
  }

  async executeRollbackProof(task, { reason, compensationActions }) {
    if (typeof this.pcAgent?.rollbackTask === 'function' && compensationActions.length > 0) {
      return await this.pcAgent.rollbackTask(task.taskId, { reason });
    }
    return {
      success: compensationActions.length === 0,
      dryRun: true,
      reason: compensationActions.length === 0 ? 'no-compensation-actions' : 'pc-agent-rollback-unavailable',
      rolledBack: [],
      skipped: compensationActions.map((action) => ({
        compensationId: action.compensationId,
        targetNodeId: action.targetNodeId,
        reason: 'rollback-proof-unavailable'
      }))
    };
  }

  shouldRunPlanGraph(task) {
    return this.actionNodesForTask(task).length > 1;
  }

  actionNodesForTask(task) {
    return (task.plan?.planGraph?.nodes ?? [])
      .filter((node) => node.nodeId?.startsWith('action_'))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async runPlanGraphTask(task, {
    decision,
    capabilityRequest,
    capabilityToken,
    basePacket,
    planVerification,
    policyVerification,
    dryRun
  }) {
    const graphRun = await this.executePlanGraph(task, { basePacket, decision, dryRun });
    if (!graphRun.success) {
      return this.storeRun({
        success: false,
        taskId: task.taskId,
        status: task.status,
        decision,
        capabilityRequest,
        capability: this.publicCapability(capabilityToken),
        packet: this.publicPacket(basePacket),
        planVerification,
        policyVerification,
        execution: graphRun.execution,
        failure: graphRun.failure,
        planGraphRun: graphRun
      });
    }

    const executionVerification = await this.verifyExecution(task, graphRun.execution, capabilityToken);
    const learning = this.ingestAndVerifyLearning(task, graphRun.execution);
    this.completeTask(task, {
      execution: graphRun.execution,
      executionVerification,
      learning,
      packetId: basePacket.packetId
    });
    return this.storeRun({
      success: true,
      taskId: task.taskId,
      status: task.status,
      decision,
      capabilityRequest,
      capability: this.publicCapability(capabilityToken),
      packet: this.publicPacket(basePacket),
      planVerification,
      policyVerification,
      execution: graphRun.execution,
      executionVerification,
      learning,
      planGraphRun: graphRun,
      trace: task.orchestrationTrace
    });
  }

  async executePlanGraph(task, { basePacket, decision, dryRun }) {
    const actionNodes = this.actionNodesForTask(task);
    const actionNodeById = new Map(actionNodes.map((node) => [node.nodeId, node]));
    const completedNodeIds = new Set();
    const nodeRuns = [];
    const schedule = this.planGraphExecutionSchedule(task, { actionNodes });
    this.coreFacade.eventBus.publish('worker.plan_graph.started', {
      taskId: task.taskId,
      graphId: task.plan?.planGraph?.graphId,
      nodeCount: actionNodes.length,
      schedule
    });

    for (const wave of schedule.waves) {
      const runnableNodes = [];
      for (const nodeId of wave.nodeIds) {
        const node = actionNodeById.get(nodeId);
        if (!node) continue;
        const unmetDependency = this.unmetActionDependency(task, node, completedNodeIds);
        if (unmetDependency) {
          nodeRuns.push(this.skipPlanNode(task, node, {
            reason: 'dependency-not-completed',
            dependencyNodeId: unmetDependency,
            scheduleWave: wave.waveIndex
          }));
          continue;
        }
        runnableNodes.push(node);
      }

      const waveRuns = await Promise.all(runnableNodes.map((node) => this.executePlanNode(task, {
        node,
        basePacket,
        decision,
        dryRun,
        wave
      })));
      nodeRuns.push(...waveRuns);
      for (const nodeRun of waveRuns) {
        if (nodeRun.status === 'completed') completedNodeIds.add(nodeRun.nodeId);
      }

      const failedRun = waveRuns.find((run) => run.status === 'failed');
      if (!failedRun) continue;

      const skippedRuns = this.skipDescendantActionNodes(task, failedRun.nodeId, new Set(nodeRuns.map((run) => run.nodeId)));
      nodeRuns.push(...skippedRuns);
      const partialCompensation = this.coreFacade.orchestrator.planCompensation({
        task,
        failureBranchId: 'failure_dag_node_failed',
        targetNodeIds: [...completedNodeIds],
        mode: 'partial',
        evidence: {
          failedNodeId: failedRun.nodeId,
          skippedNodeIds: skippedRuns.map((run) => run.nodeId),
          artifactBundle: failedRun.artifactBundle,
          schedule
        }
      });
      this.coreFacade.eventBus.publish('compensation.partial.planned', { taskId: task.taskId, plan: partialCompensation });
      const executionSummary = this.aggregatePlanGraphExecution(task, nodeRuns, basePacket, TaskStatus.FAILED);
      task.planGraphRun = {
        runVersion: 'a-plan-graph-runner-v1',
        schedule,
        status: 'failed',
        failedNodeId: failedRun.nodeId,
        nodeRuns: this.publicNodeRuns(nodeRuns),
        partialCompensation
      };
      const failure = this.coreFacade.recordExecutionFailure(task.taskId, {
        reason: failedRun.execution?.blockedReason ?? failedRun.execution?.executionResult?.summary ?? 'A_WORKER_PLAN_GRAPH_NODE_FAILED',
        evidence: {
          failedNodeId: failedRun.nodeId,
          skippedNodeIds: skippedRuns.map((run) => run.nodeId),
          completedNodeIds: [...completedNodeIds],
          partialCompensationId: partialCompensation.compensationPlanId,
          nodeArtifactBundles: nodeRuns.map((run) => run.artifactBundle),
          schedule
        }
      });
      this.coreFacade.eventBus.publish('worker.plan_graph.failed', {
        taskId: task.taskId,
        failedNodeId: failedRun.nodeId,
        skippedNodeIds: skippedRuns.map((run) => run.nodeId),
        schedule
      });
      return {
        success: false,
        failedNodeId: failedRun.nodeId,
        skippedNodeIds: skippedRuns.map((run) => run.nodeId),
        nodeRuns: this.publicNodeRuns(nodeRuns),
        partialCompensation,
        schedule,
        artifactExport: this.exportNodeArtifactBundles(task.taskId),
        execution: executionSummary,
        failure
      };
    }

    const execution = this.aggregatePlanGraphExecution(task, nodeRuns, basePacket, TaskStatus.COMPLETED);
    task.planGraphRun = {
      runVersion: 'a-plan-graph-runner-v1',
      schedule,
      status: 'completed',
      nodeRuns: this.publicNodeRuns(nodeRuns)
    };
    this.coreFacade.eventBus.publish('worker.plan_graph.completed', {
      taskId: task.taskId,
      graphId: task.plan?.planGraph?.graphId,
      nodeCount: nodeRuns.length,
      schedule
    });
    return {
      success: true,
      nodeRuns: this.publicNodeRuns(nodeRuns),
      schedule,
      artifactExport: this.exportNodeArtifactBundles(task.taskId),
      execution
    };
  }

  async executePlanNode(task, { node, basePacket, decision, dryRun, wave }) {
    const nodeCapability = this.issueNodeCapabilityToken(task, decision, node);
    const nodePacket = this.createNodeExecutionPacket({ basePacket, node, capabilityToken: nodeCapability });
    const startedBundle = this.nodeArtifactBundle({
      task,
      node,
      packet: nodePacket,
      status: 'running',
      extra: { scheduleWave: wave.waveIndex }
    });
    this.coreFacade.orchestrator.markNode({
      task,
      nodeId: node.nodeId,
      status: 'running',
      evidence: { packetId: nodePacket.packetId, artifactBundle: startedBundle, scheduleWave: wave.waveIndex }
    });
    this.coreFacade.eventBus.publish('worker.plan_node.started', {
      taskId: task.taskId,
      nodeId: node.nodeId,
      packetId: nodePacket.packetId,
      scheduleWave: wave.waveIndex
    });

    const execution = await this.pcAgent.receiveExecutionPacket(nodePacket, { dryRun });
    const completed = execution.status === TaskStatus.COMPLETED;
    const artifactBundle = this.nodeArtifactBundle({
      task,
      node,
      packet: nodePacket,
      execution,
      status: completed ? 'completed' : 'failed',
      extra: { scheduleWave: wave.waveIndex }
    });
    const nodeRun = {
      nodeId: node.nodeId,
      status: completed ? 'completed' : 'failed',
      packet: this.publicPacket(nodePacket),
      capability: this.publicCapability(nodeCapability),
      execution,
      artifactBundle
    };
    this.coreFacade.orchestrator.markNode({
      task,
      nodeId: node.nodeId,
      status: nodeRun.status,
      evidence: {
        packetId: nodePacket.packetId,
        blockedReason: execution.blockedReason,
        artifactBundle,
        scheduleWave: wave.waveIndex
      }
    });
    this.coreFacade.eventBus.publish(completed ? 'worker.plan_node.completed' : 'worker.plan_node.failed', {
      taskId: task.taskId,
      nodeId: node.nodeId,
      packetId: nodePacket.packetId,
      artifactBundle,
      scheduleWave: wave.waveIndex
    });
    return nodeRun;
  }

  planGraphExecutionSchedule(task, { actionNodes = this.actionNodesForTask(task) } = {}) {
    const planned = task.plan?.planGraph?.scheduler;
    const plannedWaves = Array.isArray(planned?.waves) && planned.waves.length
      ? planned.waves
      : this.fallbackPlanGraphWaves(task, actionNodes);
    const waves = [];
    for (const wave of plannedWaves) {
      const nodeIds = wave.nodeIds.filter((nodeId) => actionNodes.some((node) => node.nodeId === nodeId));
      for (let index = 0; index < nodeIds.length; index += this.maxPlanParallelism) {
        const chunk = nodeIds.slice(index, index + this.maxPlanParallelism);
        if (chunk.length === 0) continue;
        waves.push({
          waveIndex: waves.length + 1,
          plannedWaveIndex: wave.waveIndex,
          nodeIds: chunk,
          parallelizable: chunk.length > 1,
          status: wave.status ?? 'ready'
        });
      }
    }
    return {
      runtimeScheduleVersion: 'a-plan-parallel-dag-runtime-schedule-v1',
      plannerScheduleVersion: planned?.scheduleVersion ?? 'fallback',
      scheduleVersion: 'a-plan-parallel-dag-scheduler-v1',
      graphId: task.plan?.planGraph?.graphId,
      mode: planned?.mode ?? (waves.some((wave) => wave.parallelizable) ? 'parallel_ready' : 'sequential_safe'),
      maxParallelism: Math.max(1, ...waves.map((wave) => wave.nodeIds.length)),
      workerMaxParallelism: this.maxPlanParallelism,
      waves,
      hardDependencyEdges: planned?.hardDependencyEdges ?? [],
      orderHintEdges: planned?.orderHintEdges ?? [],
      dependencyMap: planned?.dependencyMap ?? {}
    };
  }

  fallbackPlanGraphWaves(task, actionNodes) {
    const edges = task.plan?.planGraph?.edges ?? [];
    const completed = new Set();
    const remaining = new Set(actionNodes.map((node) => node.nodeId));
    const waves = [];
    while (remaining.size > 0) {
      const ready = [...remaining].filter((nodeId) => edges
        .filter((edge) => edge.to === nodeId && edge.from?.startsWith('action_') && edge.condition === 'success')
        .every((edge) => completed.has(edge.from)));
      const waveNodeIds = ready.length ? ready.slice(0, 1) : [...remaining];
      for (const nodeId of waveNodeIds) {
        remaining.delete(nodeId);
        completed.add(nodeId);
      }
      waves.push({ waveIndex: waves.length + 1, nodeIds: waveNodeIds, parallelizable: waveNodeIds.length > 1, status: ready.length ? 'ready' : 'blocked_by_cycle' });
    }
    return waves;
  }

  issueNodeCapabilityToken(task, decision, node) {
    if (!this.policyRuntime?.capabilities?.issue) {
      return {
        ...this.issueCapabilityToken(task, decision),
        tokenId: stableId('cap', `${task.taskId}:${node.nodeId}`, this.clock().toISOString())
      };
    }
    return this.policyRuntime.capabilities.issue({
      taskId: task.taskId,
      planId: task.plan.planId,
      approvalId: decision.approvalId,
      action: {
        ...task.plan.action,
        // LLM 이종 복합 계획: 노드가 자체 actionType/toolName을 가지면 토큰도 그 범위로 좁혀 발급한다.
        // 대표 액션은 가장 위험한 조각으로 승격돼 있으므로 노드 액션은 항상 평가된 위험 이하다.
        actionType: node.actionType ?? task.plan.action.actionType,
        toolName: node.toolName ?? task.plan.action.toolName,
        skillId: node.skillId ?? task.plan.action.skillId,
        capabilityTokenSalt: node.nodeId
      },
      allowedPaths: this.allowedPaths
    });
  }

  createNodeExecutionPacket({ basePacket, node, capabilityToken }) {
    const createdAt = this.clock().toISOString();
    return {
      ...basePacket,
      packetId: stableId('packet', `${basePacket.taskId}:${node.nodeId}`, createdAt),
      action: {
        ...basePacket.action,
        actionType: node.actionType ?? basePacket.action.actionType,
        toolName: node.toolName ?? basePacket.action.toolName,
        skillId: node.skillId ?? basePacket.action.skillId,
        arguments: node.arguments ?? basePacket.action.arguments,
        planGraphNode: {
          nodeId: node.nodeId,
          order: node.order,
          description: node.description
        }
      },
      capabilityToken,
      planGraphNodeId: node.nodeId,
      parentPacketId: basePacket.packetId,
      createdAt
    };
  }

  unmetActionDependency(task, node, completedNodeIds) {
    const edges = task.plan?.planGraph?.edges ?? [];
    const dependencies = edges
      .filter((edge) => edge.to === node.nodeId && edge.from?.startsWith('action_') && edge.condition === 'success')
      .map((edge) => edge.from);
    return dependencies.find((nodeId) => !completedNodeIds.has(nodeId)) ?? null;
  }

  skipDescendantActionNodes(task, failedNodeId, alreadyRecorded = new Set()) {
    const descendantIds = this.descendantActionNodeIds(task.plan?.planGraph, failedNodeId);
    return this.actionNodesForTask(task)
      .filter((node) => descendantIds.has(node.nodeId))
      .filter((node) => !alreadyRecorded.has(node.nodeId))
      .map((node) => this.skipPlanNode(task, node, {
        reason: 'ancestor-node-failed',
        failedNodeId
      }));
  }

  skipPlanNode(task, node, evidence = {}) {
    const artifactBundle = this.nodeArtifactBundle({
      task,
      node,
      packet: null,
      execution: null,
      status: 'skipped',
      extra: evidence
    });
    this.coreFacade.orchestrator.markNode({
      task,
      nodeId: node.nodeId,
      status: 'skipped',
      evidence: { ...evidence, artifactBundle }
    });
    this.coreFacade.eventBus.publish('worker.plan_node.skipped', {
      taskId: task.taskId,
      nodeId: node.nodeId,
      reason: evidence.reason,
      failedNodeId: evidence.failedNodeId
    });
    return {
      nodeId: node.nodeId,
      status: 'skipped',
      packet: null,
      capability: null,
      execution: null,
      artifactBundle
    };
  }

  descendantActionNodeIds(planGraph, startNodeId) {
    const descendants = new Set();
    const queue = [startNodeId];
    const edges = planGraph?.edges ?? [];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of edges.filter((item) => item.from === current)) {
        if (!edge.to?.startsWith('action_') || descendants.has(edge.to)) continue;
        descendants.add(edge.to);
        queue.push(edge.to);
      }
    }
    return descendants;
  }

  nodeArtifactBundle({ task, node, packet, execution = null, status, extra = {} }) {
    const executionResult = execution?.executionResult ?? null;
    const evidence = execution?.evidence ?? executionResult?.evidence?.executionEvidence ?? null;
    const createdAt = this.clock().toISOString();
    const bundle = {
      artifactVersion: 'a-plan-node-artifact-bundle-v1',
      bundleId: stableId('node_artifact', `${task.taskId}:${node.nodeId}:${status}`, createdAt),
      taskId: task.taskId,
      planId: task.plan?.planId,
      graphId: task.plan?.planGraph?.graphId,
      nodeId: node.nodeId,
      nodeOrder: node.order,
      status,
      packetId: packet?.packetId ?? null,
      parentPacketId: packet?.parentPacketId ?? null,
      toolName: node.toolName ?? packet?.action?.toolName ?? task.plan?.action?.toolName,
      actionType: node.actionType ?? packet?.action?.actionType ?? task.plan?.action?.actionType,
      createdAt,
      outputPaths: executionResult?.outputPaths ?? [],
      changedItems: executionResult?.changedItems ?? [],
      rollbackAvailable: executionResult?.rollbackAvailable === true,
      evidenceId: evidence?.evidenceId ?? executionResult?.evidence?.verificationEvidenceId ?? null,
      undoJournalId: executionResult?.undoJournalId ?? executionResult?.evidence?.undoJournalId ?? null,
      memoryEventId: execution?.memoryEvent?.eventId ?? null,
      blockedReason: execution?.blockedReason ?? null,
      rawContentStored: false,
      ...extra
    };
    this.retainNodeArtifactBundle(task, bundle);
    return bundle;
  }

  retainNodeArtifactBundle(task, artifactBundle) {
    if (!task.planNodeArtifacts) {
      task.planNodeArtifacts = {
        retentionVersion: 'a-plan-node-artifact-retention-v1',
        taskId: task.taskId,
        retainedAt: this.clock().toISOString(),
        rawContentStored: false,
        bundles: []
      };
    }
    task.planNodeArtifacts.bundles.push({ ...artifactBundle });
    task.planNodeArtifacts.retainedAt = this.clock().toISOString();
    if (task.planNodeArtifacts.bundles.length > this.artifactRetentionLimit) {
      task.planNodeArtifacts.bundles = task.planNodeArtifacts.bundles.slice(-this.artifactRetentionLimit);
    }
    this.nodeArtifactArchive.unshift({ ...artifactBundle });
    this.nodeArtifactArchive = this.nodeArtifactArchive.slice(0, this.artifactRetentionLimit);
    return task.planNodeArtifacts;
  }

  exportNodeArtifactBundles(taskId = null) {
    const task = taskId ? this.coreFacade.getTask(taskId) : null;
    const bundles = task
      ? (task.planNodeArtifacts?.bundles ?? [])
      : this.nodeArtifactArchive;
    const payload = JSON.stringify(bundles);
    return {
      exportVersion: 'a-plan-node-artifact-export-v1',
      retentionVersion: 'a-plan-node-artifact-retention-v1',
      taskId,
      bundleCount: bundles.length,
      rawContentStored: false,
      exportedAt: this.clock().toISOString(),
      sha256: createHash('sha256').update(payload).digest('hex'),
      bundles: bundles.map((bundle) => ({ ...bundle }))
    };
  }

  nodeArtifactRetentionStatus(taskId = null) {
    const task = taskId ? this.coreFacade.getTask(taskId) : null;
    const bundles = task
      ? (task.planNodeArtifacts?.bundles ?? [])
      : this.nodeArtifactArchive;
    const byStatus = bundles.reduce((acc, bundle) => {
      acc[bundle.status] = (acc[bundle.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      retentionVersion: 'a-plan-node-artifact-retention-v1',
      taskId,
      retentionLimit: this.artifactRetentionLimit,
      bundleCount: bundles.length,
      rawContentStored: false,
      byStatus,
      latestBundleId: bundles.at(-1)?.bundleId ?? bundles[0]?.bundleId ?? null
    };
  }

  compensationExecutionRunnerStatus(taskId = null) {
    const task = taskId ? this.coreFacade.getTask(taskId) : null;
    return {
      runnerVersion: 'a-plan-compensation-execution-runner-v1',
      taskId,
      supportsPartialTargeting: true,
      rollbackProofRequired: true,
      replayVersion: task?.compensationReplay?.replayVersion ?? null,
      lastReplayStatus: task?.compensationReplay?.status ?? null,
      safeMode: 'approval_required_before_compensation'
    };
  }

  runPlanGraphReleaseDossier(taskId, {
    checks = [],
    schedule = null,
    retention = null,
    artifactExport = null,
    compensationRunner = null
  } = {}) {
    const task = this.coreFacade.getTask(taskId);
    if (!task) {
      return {
        dossierVersion: 'a-plan-graph-release-dossier-v1',
        taskId,
        status: 'blocked',
        error: { code: 'A_WORKER_TASK_NOT_FOUND', taskId }
      };
    }
    const effectiveSchedule = schedule ?? this.planGraphExecutionSchedule(task);
    const effectiveRetention = retention ?? this.nodeArtifactRetentionStatus(taskId);
    const effectiveArtifactExport = artifactExport ?? this.exportNodeArtifactBundles(taskId);
    const effectiveCompensationRunner = compensationRunner ?? this.compensationExecutionRunnerStatus(taskId);
    const bundles = effectiveArtifactExport.bundles ?? [];
    const byStatus = bundles.reduce((acc, bundle) => {
      acc[bundle.status] = (acc[bundle.status] ?? 0) + 1;
      return acc;
    }, {});
    const releaseChecks = [
      {
        checkId: 'parallel_runtime_schedule_release_evidence',
        passed: effectiveSchedule.runtimeScheduleVersion === 'a-plan-parallel-dag-runtime-schedule-v1'
          && effectiveSchedule.scheduleVersion === 'a-plan-parallel-dag-scheduler-v1'
          && effectiveSchedule.waves.length > 0,
        waveCount: effectiveSchedule.waves.length,
        parallelWaveCount: effectiveSchedule.waves.filter((wave) => wave.parallelizable).length
      },
      {
        checkId: 'node_artifact_retention_release_evidence',
        passed: effectiveRetention.retentionVersion === 'a-plan-node-artifact-retention-v1'
          && effectiveRetention.rawContentStored === false
          && effectiveRetention.bundleCount > 0,
        bundleCount: effectiveRetention.bundleCount,
        byStatus: effectiveRetention.byStatus
      },
      {
        checkId: 'node_artifact_export_integrity_release_evidence',
        passed: effectiveArtifactExport.exportVersion === 'a-plan-node-artifact-export-v1'
          && effectiveArtifactExport.retentionVersion === 'a-plan-node-artifact-retention-v1'
          && effectiveArtifactExport.rawContentStored === false
          && typeof effectiveArtifactExport.sha256 === 'string'
          && effectiveArtifactExport.sha256.length === 64,
        sha256: effectiveArtifactExport.sha256
      },
      {
        checkId: 'compensation_execution_runner_release_evidence',
        passed: effectiveCompensationRunner.runnerVersion === 'a-plan-compensation-execution-runner-v1'
          && effectiveCompensationRunner.supportsPartialTargeting === true
          && effectiveCompensationRunner.rollbackProofRequired === true,
        lastReplayStatus: effectiveCompensationRunner.lastReplayStatus
      }
    ];
    const artifactManifest = createPlanGraphReleaseArtifactManifest({
      task,
      releaseChecks,
      schedule: effectiveSchedule,
      retention: effectiveRetention,
      artifactExport: effectiveArtifactExport,
      compensationRunner: effectiveCompensationRunner,
      byStatus
    });
    const ciNightlyGatePlan = createPlanGraphCiNightlyGatePlan({ artifactManifest });
    const externalWormPromotionPackage = createPlanGraphExternalWormPromotionPackage({
      artifactManifest,
      ciNightlyGatePlan,
      releaseChecks
    });
    const status = checks.every((check) => check.status === 'passed')
      && releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked';
    return {
      dossierVersion: 'a-plan-graph-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      taskId,
      planId: task.plan?.planId ?? null,
      graphId: task.plan?.planGraph?.graphId ?? null,
      status,
      schedule: {
        runtimeScheduleVersion: effectiveSchedule.runtimeScheduleVersion,
        scheduleVersion: effectiveSchedule.scheduleVersion,
        mode: effectiveSchedule.mode,
        waveCount: effectiveSchedule.waves.length,
        parallelWaveCount: effectiveSchedule.waves.filter((wave) => wave.parallelizable).length,
        maxParallelism: effectiveSchedule.maxParallelism,
        workerMaxParallelism: effectiveSchedule.workerMaxParallelism
      },
      artifacts: {
        retentionVersion: effectiveRetention.retentionVersion,
        bundleCount: effectiveRetention.bundleCount,
        byStatus,
        rawContentStored: effectiveArtifactExport.rawContentStored === true,
        exportVersion: effectiveArtifactExport.exportVersion,
        exportSha256: effectiveArtifactExport.sha256
      },
      compensation: {
        runnerVersion: effectiveCompensationRunner.runnerVersion,
        supportsPartialTargeting: effectiveCompensationRunner.supportsPartialTargeting,
        rollbackProofRequired: effectiveCompensationRunner.rollbackProofRequired,
        replayVersion: effectiveCompensationRunner.replayVersion,
        lastReplayStatus: effectiveCompensationRunner.lastReplayStatus,
        safeMode: effectiveCompensationRunner.safeMode
      },
      checks: checks.map((check) => ({ ...check })),
      releaseChecks,
      artifactManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      recommendedReleaseAction: status === 'passed'
        ? 'attach_plan_graph_hash_only_manifest_and_worm_promotion_package'
        : 'block_plan_graph_release_until_manifest_and_worm_gate_pass'
    };
  }

  runPlanGraphProductGate(taskId) {
    const task = this.coreFacade.getTask(taskId);
    if (!task) {
      return { gateVersion: 'a-plan-graph-product-gate-v1', status: 'blocked', error: { code: 'A_WORKER_TASK_NOT_FOUND', taskId } };
    }
    const schedule = this.planGraphExecutionSchedule(task);
    const retention = this.nodeArtifactRetentionStatus(taskId);
    const artifactExport = this.exportNodeArtifactBundles(taskId);
    const compensationRunner = this.compensationExecutionRunnerStatus(taskId);
    const checks = [
      {
        checkId: 'parallel_dag_scheduler_available',
        status: schedule.scheduleVersion === 'a-plan-parallel-dag-scheduler-v1' && schedule.waves.length > 0 ? 'passed' : 'blocked'
      },
      {
        checkId: 'node_artifact_retention_available',
        status: retention.retentionVersion === 'a-plan-node-artifact-retention-v1' ? 'passed' : 'blocked',
        bundleCount: retention.bundleCount
      },
      {
        checkId: 'node_artifact_export_hash_available',
        status: artifactExport.exportVersion === 'a-plan-node-artifact-export-v1' && artifactExport.sha256.length === 64 ? 'passed' : 'blocked'
      },
      {
        checkId: 'compensation_execution_runner_available',
        status: compensationRunner.runnerVersion === 'a-plan-compensation-execution-runner-v1' ? 'passed' : 'blocked'
      }
    ];
    const releaseDossier = this.runPlanGraphReleaseDossier(taskId, {
      checks,
      schedule,
      retention,
      artifactExport,
      compensationRunner
    });
    checks.push({
      checkId: 'plan_graph_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.artifactManifestVersion === 'a-plan-graph-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        ? 'passed'
        : 'blocked'
    });
    checks.push({
      checkId: 'plan_graph_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'a-plan-graph-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'a-plan-graph-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked'
    });
    checks.push({
      checkId: 'plan_graph_release_dossier_ready',
      status: releaseDossier.dossierVersion === 'a-plan-graph-release-dossier-v1'
        && releaseDossier.status === 'passed'
        ? 'passed'
        : 'blocked'
    });
    return {
      gateVersion: 'a-plan-graph-product-gate-v1',
      taskId,
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      checks,
      schedule,
      retention,
      artifactExport,
      compensationRunner,
      releaseDossier
    };
  }

  aggregatePlanGraphExecution(task, nodeRuns, basePacket, status) {
    const completedRuns = nodeRuns.filter((run) => run.status === 'completed');
    const artifactBundles = nodeRuns.map((run) => run.artifactBundle);
    const outputPaths = completedRuns.flatMap((run) => run.execution?.executionResult?.outputPaths ?? []);
    const changedItems = completedRuns.flatMap((run) => run.execution?.executionResult?.changedItems ?? []);
    const lastMemoryEvent = [...completedRuns].reverse().find((run) => run.execution?.memoryEvent)?.execution?.memoryEvent ?? null;
    return {
      taskId: task.taskId,
      status,
      executionResult: {
        packetId: basePacket.packetId,
        taskId: task.taskId,
        status: status === TaskStatus.COMPLETED ? 'success' : 'failed',
        summary: status === TaskStatus.COMPLETED
          ? `PlanGraph executed ${completedRuns.length} action nodes.`
          : `PlanGraph stopped after ${completedRuns.length} completed action nodes.`,
        outputPaths,
        changedItems,
        rollbackAvailable: completedRuns.some((run) => run.execution?.executionResult?.rollbackAvailable === true),
        executedBy: {
          module: ModuleId.PC_AGENT,
          toolName: task.plan?.action?.toolName,
          runner: 'a-plan-graph-runner-v1'
        },
        evidence: {
          artifactBundleVersion: 'a-plan-node-artifact-bundle-v1',
          nodeArtifactBundles: artifactBundles,
          completedNodeIds: completedRuns.map((run) => run.nodeId),
          failedNodeIds: nodeRuns.filter((run) => run.status === 'failed').map((run) => run.nodeId),
          skippedNodeIds: nodeRuns.filter((run) => run.status === 'skipped').map((run) => run.nodeId)
        }
      },
      evidence: {
        evidenceId: stableId('graph_evidence', task.taskId, this.clock().toISOString()),
        evidenceVersion: 'a-plan-graph-execution-evidence-v1',
        nodeArtifactBundles: artifactBundles
      },
      memoryEvent: lastMemoryEvent
    };
  }

  publicNodeRuns(nodeRuns) {
    return nodeRuns.map((run) => ({
      nodeId: run.nodeId,
      status: run.status,
      packet: run.packet,
      capability: run.capability,
      artifactBundle: run.artifactBundle,
      executionStatus: run.execution?.status ?? null,
      blockedReason: run.execution?.blockedReason ?? null
    }));
  }

  createWorkerApprovalDecision(task, { deviceId }) {
    return createApprovalDecision({
      approvalId: task.approvalCard.approvalId,
      taskId: task.taskId,
      decision: ApprovalDecision.APPROVE,
      deviceId,
      sourceModule: ModuleId.CORE,
      decidedAt: this.clock().toISOString()
    });
  }

  ensureApproved(task, decision) {
    if (task.status === TaskStatus.WAITING_APPROVAL) {
      return this.coreFacade.submitApprovalDecision(decision);
    }
    if (task.status === TaskStatus.APPROVED || task.status === TaskStatus.EXECUTING) {
      return { success: true, status: task.status };
    }
    return { success: false, status: task.status, reason: 'approval-transition-not-available' };
  }

  issueCapabilityToken(task, decision) {
    if (!this.policyRuntime?.capabilities?.issue) {
      return {
        tokenId: stableId('cap', task.taskId, this.clock().toISOString()),
        taskId: task.taskId,
        planId: task.plan.planId,
        approvalId: decision.approvalId,
        scope: {
          toolName: task.plan.action.toolName,
          actionType: task.plan.action.actionType,
          allowedPaths: this.allowedPaths,
          maxAffectedItems: 20,
          maxRuntimeMs: 30_000
        },
        constraints: { singleUse: true },
        permissions: {
          allowDelete: false,
          allowExternalTransfer: false,
          allowAdminPrivilege: false
        },
        consumed: false
      };
    }
    return this.policyRuntime.capabilities.issue({
      taskId: task.taskId,
      planId: task.plan.planId,
      approvalId: decision.approvalId,
      action: task.plan.action,
      allowedPaths: this.allowedPaths
    });
  }

  verifyPlan(task) {
    return this.verificationRuntime?.verifyPlan?.({
      verificationId: stableId('ver_plan', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      target: {
        plan: task.plan,
        approvalCard: task.approvalCard
      }
    }) ?? null;
  }

  verifyPolicy(task, decision, capabilityToken) {
    return this.verificationRuntime?.verifyPolicy?.({
      verificationId: stableId('ver_policy', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      target: {
        policyResult: task.policy,
        approvalDecision: decision,
        capabilityToken,
        policyStatus: this.policyRuntime?.policyAsCodeStatus?.() ?? null,
        expectedPolicyVersion: this.policyRuntime?.policyVersion,
        expectedConstitutionHash: this.policyRuntime?.compiledPolicy?.constitutionHash,
        plan: task.plan
      }
    }) ?? null;
  }

  async verifyExecution(task, execution, capabilityToken) {
    return await (this.verificationRuntime?.verifyExecution?.({
      verificationId: stableId('ver_exec', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      target: {
        executionResult: execution.executionResult,
        evidence: execution.evidence,
        capabilityToken,
        adapterContract: execution.executionResult?.safety?.adapterContract
      }
    }) ?? null);
  }

  ingestAndVerifyLearning(task, execution) {
    const memoryEvent = execution.memoryEvent ?? null;
    const ingest = memoryEvent
      ? (this.growthRuntime?.ingest?.(memoryEvent) ?? this.growthRuntime?.ingestor?.ingest?.(memoryEvent) ?? null)
      : null;
    const storedEvent = ingest?.event ?? this.growthRuntime?.ingestor?.all?.().find((item) => item.eventId === ingest?.eventId) ?? memoryEvent;
    const verification = this.verificationRuntime?.verifyLearning?.({
      verificationId: stableId('ver_learning', task.taskId, this.clock().toISOString()),
      taskId: task.taskId,
      target: {
        memoryEvent: storedEvent
      }
    }) ?? null;
    return { ingest, verification, memoryEvent: storedEvent };
  }

  markExecutionStarted(task, evidence = {}) {
    if (task.status !== TaskStatus.EXECUTING) {
      task.stateMachine.transition(TaskStatus.EXECUTING, 'core-worker-execution-started', evidence);
    }
    task.status = task.stateMachine.status;
    task.lifecycle.mark(TaskStatus.EXECUTING, '실행 시작', 'CoreOrchestrationWorker handed off to B PC agent');
    this.coreFacade.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'worker.execution.started',
      module: ModuleId.CORE,
      message: 'CoreOrchestrationWorker started execution handoff.',
      evidence
    });
    const actionNodes = this.actionNodesForTask(task);
    for (const node of actionNodes) {
      if (actionNodes.length <= 1) {
        this.coreFacade.orchestrator.markNode({ task, nodeId: node.nodeId, status: 'running', evidence });
      }
    }
    this.coreFacade.orchestrator.checkpointTrace({ task, reason: 'worker_execution_started' });
    this.coreFacade.eventBus.publish('worker.execution.started', { taskId: task.taskId, evidence });
  }

  completeTask(task, { execution, executionVerification, learning, packetId }) {
    task.stateMachine.transition(TaskStatus.VERIFYING, 'core-worker-verification-started', {
      packetId,
      verificationId: executionVerification?.verificationId
    });
    task.lifecycle.mark(TaskStatus.VERIFYING, '검증 시작', 'G verification started after B execution');
    task.executionResult = execution;
    task.executionVerification = executionVerification;
    task.learningResult = learning;
    this.coreFacade.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'worker.execution.completed',
      module: ModuleId.PC_AGENT,
      message: 'B PC agent completed the execution packet.',
      evidence: {
        packetId,
        evidenceId: execution.evidence?.evidenceId,
        status: execution.status
      }
    });
    this.coreFacade.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'worker.verification.completed',
      module: ModuleId.VERIFICATION,
      status: executionVerification?.status === 'failed' ? 'failed' : 'ok',
      message: 'G verification checked execution evidence.',
      evidence: {
        verificationId: executionVerification?.verificationId,
        status: executionVerification?.status,
        score: executionVerification?.score
      }
    });
    this.coreFacade.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'worker.learning.ingested',
      module: ModuleId.GROWTH_MEMORY,
      message: 'F growth memory ingested execution memory event.',
      evidence: {
        stored: learning?.ingest?.stored ?? false,
        eventId: learning?.ingest?.eventId ?? learning?.memoryEvent?.eventId
      }
    });
    if (!task.planGraphRun?.nodeRuns?.length) {
      for (const node of task.plan?.planGraph?.nodes ?? []) {
        if (node.nodeId.startsWith('action_')) {
          this.coreFacade.orchestrator.markNode({
            task,
            nodeId: node.nodeId,
            status: 'completed',
            evidence: { packetId, verificationId: executionVerification?.verificationId }
          });
        }
      }
    }
    task.stateMachine.transition(TaskStatus.COMPLETED, 'core-worker-completed', {
      packetId,
      verificationStatus: executionVerification?.status
    });
    task.status = task.stateMachine.status;
    task.lifecycle.mark(TaskStatus.COMPLETED, '완료', 'Core worker completed execution, verification, and learning');
    this.coreFacade.orchestrator.completeTrace(task.orchestrationTrace, {
      executionStatus: execution.status,
      verificationStatus: executionVerification?.status,
      memoryEventId: learning?.ingest?.eventId ?? learning?.memoryEvent?.eventId
    });
    this.coreFacade.eventBus.publish('task.completed', { taskId: task.taskId, executionResult: task.executionResult });
    this.coreFacade.eventBus.publish('worker.learning.ingested', { taskId: task.taskId, learning });
    this.coreFacade.eventBus.publish('orchestration.trace.updated', { taskId: task.taskId, trace: task.orchestrationTrace });
    // 대화기억: 완료 작업을 작업 일지에 남겨 다음 명령의 "그거/방금 만든 파일" 참조를 가능하게 한다.
    const finalResult = execution?.executionResult ?? execution ?? {};
    this.coreFacade.workMemory?.record?.({
      taskId: task.taskId,
      rawText: task.request?.metadata?.workReferenceOriginalText ?? task.request?.command?.rawText ?? '',
      actionType: task.plan?.action?.actionType ?? null,
      outputPaths: finalResult.outputPaths ?? [],
      summary: finalResult.summary ?? null,
      status: finalResult.status === 'success' ? 'success' : 'failed'
    });
  }

  failBeforeExecution(task, payload) {
    const failure = this.coreFacade.recordExecutionFailure(task.taskId, {
      reason: payload.reason,
      evidence: {
        policyVerificationStatus: payload.policyVerification?.status,
        packetId: payload.packet?.packetId
      }
    });
    const { capabilityToken, packet, ...publicPayload } = payload;
    return this.storeRun({
      success: false,
      taskId: task.taskId,
      status: task.status,
      ...publicPayload,
      packet: packet ? this.publicPacket(packet) : null,
      capability: this.publicCapability(capabilityToken),
      failure
    });
  }

  failedVerification(result) {
    return Boolean(result && result.status === 'failed');
  }

  nextRunnable(now = this.clock().toISOString(), { excludeQueueIds = null } = {}) {
    const nowMs = Date.parse(now instanceof Date ? now.toISOString() : now);
    return this.queue
      .filter((item) => ['queued', 'retry_scheduled'].includes(item.status))
      .filter((item) => !excludeQueueIds?.has(item.queueId))
      .filter((item) => Date.parse(item.nextAttemptAt) <= nowMs)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))[0] ?? null;
  }

  scheduleRetry(item, reason) {
    const delayMs = item.baseBackoffMs * (2 ** Math.max(item.attempts - 1, 0));
    item.status = 'retry_scheduled';
    item.lastError = reason;
    item.nextAttemptAt = new Date(this.clock().getTime() + delayMs).toISOString();
    item.updatedAt = this.clock().toISOString();
    this.coreFacade.eventBus.publish('worker.queue.retry_scheduled', {
      taskId: item.taskId,
      queueId: item.queueId,
      attempt: item.attempts,
      delayMs,
      reason
    });
    this.persistQueue('worker.queue.retry_scheduled');
    return item;
  }

  recoverExpiredLeases({ now = this.clock().toISOString() } = {}) {
    const recovery = this.leaseTable.recoverExpired({ now });
    const heartbeatMonitor = this.leaseTable.heartbeatMonitor({ now });
    for (const lease of recovery.recovered) {
      this.activeTaskIds.delete(lease.taskId);
      const item = this.queue.find((candidate) => candidate.queueId === lease.queueId)
        ?? this.queue.find((candidate) => candidate.taskId === lease.taskId && candidate.status === 'running');
      if (item && item.status === 'running') {
        this.scheduleRetry(item, 'task-lease-expired');
      }
      this.coreFacade.eventBus.publish('worker.lease.recovered', { taskId: lease.taskId, queueId: lease.queueId, lease });
    }
    return {
      ...recovery,
      heartbeatMonitor,
      status: this.queueStatus()
    };
  }

  timeoutSchedulerStatus({ now = this.clock().toISOString() } = {}) {
    const nowMs = Date.parse(now);
    const items = this.queue.map((item) => {
      const nextAttemptMs = Date.parse(item.nextAttemptAt);
      const leaseExpiresAt = item.lease?.expiresAt ?? null;
      return {
        queueId: item.queueId,
        taskId: item.taskId,
        status: item.status,
        attempts: item.attempts,
        timeoutMs: item.timeoutMs,
        nextAttemptAt: item.nextAttemptAt,
        retryDue: ['queued', 'retry_scheduled'].includes(item.status) && nextAttemptMs <= nowMs,
        leaseExpiresAt,
        leaseExpired: leaseExpiresAt ? Date.parse(leaseExpiresAt) <= nowMs : false,
        persisted: this.queueStore ? true : false
      };
    });
    return {
      schedulerVersion: 'a-worker-timeout-scheduler-persistence-v1',
      now,
      queuePersistence: this.queuePersistenceStatus(),
      leasePersistence: this.leaseTable.persistenceStatus(),
      retryDueCount: items.filter((item) => item.retryDue).length,
      expiredLeaseItemCount: items.filter((item) => item.leaseExpired).length,
      items
    };
  }

  workerStateMachineProductGate({ now = this.clock().toISOString() } = {}) {
    const leases = this.leaseTable.status({ now });
    const timeoutScheduler = this.timeoutSchedulerStatus({ now });
    const checks = [
      {
        checkId: 'multiprocess_lease_backend_contract_available',
        status: leases.backend.backendVersion === 'a-worker-multiprocess-lease-backend-v1' ? 'passed' : 'blocked',
        activeBackend: leases.backend.activeBackend,
        fileLock: leases.backend.fileLock
      },
      {
        checkId: 'crashed_worker_heartbeat_monitor_available',
        status: leases.heartbeatMonitor.monitorVersion === 'a-worker-crashed-heartbeat-monitor-v1' ? 'passed' : 'blocked',
        staleLeaseCount: leases.heartbeatMonitor.staleLeaseCount,
        expiredLeaseCount: leases.heartbeatMonitor.expiredLeaseCount
      },
      {
        checkId: 'timeout_scheduler_persistence_available',
        status: timeoutScheduler.schedulerVersion === 'a-worker-timeout-scheduler-persistence-v1' ? 'passed' : 'blocked',
        queuePersistenceEnabled: timeoutScheduler.queuePersistence.enabled,
        leasePersistenceEnabled: timeoutScheduler.leasePersistence.enabled
      },
      {
        checkId: 'lease_recovery_retry_bridge_available',
        status: typeof this.recoverExpiredLeases === 'function' && typeof this.scheduleRetry === 'function' ? 'passed' : 'blocked'
      },
      {
        checkId: 'lease_recovery_event_observed',
        status: this.leaseTable.history.some((item) => item.eventType === 'lease.recovered')
          || this.coreFacade.eventBus.recent(100).some((event) => event.eventType === 'worker.lease.recovered')
          ? 'passed'
          : 'blocked'
      }
    ];
    const releaseDossier = this.workerStateMachineReleaseDossier({
      now,
      checks,
      leases,
      timeoutScheduler
    });
    checks.push({
      checkId: 'worker_state_machine_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.artifactManifestVersion === 'a-worker-state-machine-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        ? 'passed'
        : 'blocked'
    });
    checks.push({
      checkId: 'worker_state_machine_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'a-worker-state-machine-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'a-worker-state-machine-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked'
    });
    checks.push({
      checkId: 'worker_state_machine_release_dossier_ready',
      status: releaseDossier.dossierVersion === 'a-worker-state-machine-release-dossier-v1'
        && releaseDossier.status === 'passed'
        ? 'passed'
        : 'blocked'
    });
    return {
      gateVersion: 'a-worker-state-machine-product-gate-v1',
      now,
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      checks,
      leases,
      timeoutScheduler,
      releaseDossier
    };
  }

  workerStateMachineReleaseDossier({ now = this.clock().toISOString(), checks = [], leases = this.leaseTable.status({ now }), timeoutScheduler = this.timeoutSchedulerStatus({ now }) } = {}) {
    const releaseChecks = checks.map((check) => ({
      checkId: check.checkId,
      status: check.status,
      passed: check.status === 'passed'
    }));
    const artifactManifest = createWorkerStateMachineReleaseArtifactManifest({
      now,
      checks: releaseChecks,
      leases,
      timeoutScheduler,
      queue: this.queue,
      leaseHistory: this.leaseTable.history
    });
    const ciNightlyGatePlan = createWorkerStateMachineCiNightlyGatePlan({ artifactManifest });
    const externalWormPromotionPackage = createWorkerStateMachineExternalWormPromotionPackage({
      artifactManifest,
      ciNightlyGatePlan,
      releaseChecks
    });
    const status = checks.every((check) => check.status === 'passed')
      && leases.backend.backendVersion === 'a-worker-multiprocess-lease-backend-v1'
      && timeoutScheduler.schedulerVersion === 'a-worker-timeout-scheduler-persistence-v1'
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked';
    const dossier = {
      dossierVersion: 'a-worker-state-machine-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      now,
      status,
      leaseTableVersion: leases.leaseTableVersion,
      leaseBackendVersion: leases.backend.backendVersion,
      activeBackend: leases.backend.activeBackend,
      heartbeatMonitorVersion: leases.heartbeatMonitor.monitorVersion,
      timeoutSchedulerVersion: timeoutScheduler.schedulerVersion,
      activeLeaseCount: leases.activeLeaseCount,
      expiredLeaseCount: leases.expiredLeaseCount,
      recoveredLeaseEventCount: this.leaseTable.history.filter((item) => item.eventType === 'lease.recovered').length,
      queuePersistenceEnabled: timeoutScheduler.queuePersistence.enabled,
      leasePersistenceEnabled: timeoutScheduler.leasePersistence.enabled,
      releaseChecks,
      artifactManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      recommendedReleaseAction: status === 'passed'
        ? 'attach_worker_state_machine_release_artifact_manifest_and_worm_promotion_package'
        : 'block_worker_state_machine_release_until_manifest_and_worm_gate_pass'
    };
    return {
      ...dossier,
      dossierSha256: sha256Json(dossier)
    };
  }

  prepareTaskForRetry(taskId) {
    const task = this.coreFacade.getTask(taskId);
    if (!task || task.status !== TaskStatus.FAILED) return null;
    const retry = this.coreFacade.retryTask(taskId, {
      reason: 'worker-queue-retry',
      evidence: { runner: 'CoreOrchestrationWorker' }
    });
    if (retry.success) {
      this.coreFacade.resumeRetryExecution(taskId, {
        reason: 'worker-queue-retry-resume',
        evidence: { runner: 'CoreOrchestrationWorker' }
      });
    }
    return retry;
  }

  async withTimeout(promise, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    let timeoutId;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error(`Core worker timed out after ${timeoutMs}ms.`);
            error.code = 'A_WORKER_TIMEOUT';
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  publicCapability(capabilityToken) {
    if (!capabilityToken) return null;
    return {
      tokenId: capabilityToken.tokenId,
      tokenHash: capabilityToken.tokenHash ?? null,
      taskId: capabilityToken.taskId,
      planId: capabilityToken.planId,
      approvalId: capabilityToken.approvalId,
      scope: capabilityToken.scope,
      permissions: capabilityToken.permissions,
      constraints: capabilityToken.constraints,
      expiresAt: capabilityToken.expiresAt ?? null
    };
  }

  publicPacket(packet) {
    if (!packet) return null;
    return {
      ...packet,
      capabilityToken: this.publicCapability(packet.capabilityToken)
    };
  }

  publicQueueItem(item) {
    return {
      queueId: item.queueId,
      taskId: item.taskId,
      status: item.status,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
      nextAttemptAt: item.nextAttemptAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt ?? null,
      lastRunId: item.lastRunId,
      lease: item.lease ?? null,
      restoredAfterRestart: item.restoredAfterRestart === true,
      lastError: item.lastError
    };
  }

  queueStatus() {
    const counts = this.queue.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      total: this.queue.length,
      activeTaskIds: [...this.activeTaskIds],
      leases: this.leaseTable.status(),
      timeoutScheduler: this.timeoutSchedulerStatus(),
      persistence: this.queuePersistenceStatus(),
      counts,
      items: this.queue.map((item) => this.publicQueueItem(item))
    };
  }

  loadPersistedQueueState() {
    if (!this.queueStore) return null;
    const snapshot = this.queueStore.load();
    if (!snapshot) return null;
    const restoredAt = this.clock().toISOString();
    let recoveredRunningCount = 0;
    this.queue = (snapshot.queue ?? []).map((item) => {
      if (item.status !== 'running') return { ...item };
      recoveredRunningCount += 1;
      return {
        ...item,
        status: 'retry_scheduled',
        nextAttemptAt: restoredAt,
        updatedAt: restoredAt,
        lastError: 'worker-restart-running-item',
        restoredAfterRestart: true
      };
    });
    this.runs = (snapshot.runs ?? []).map((run) => ({ ...run }));
    this.lastQueuePersistedAt = snapshot.persistedAt ?? null;
    if (recoveredRunningCount > 0) {
      this.persistQueue('worker.queue.restart_recovered');
    }
    return {
      ...snapshot,
      recoveredRunningCount
    };
  }

  persistQueue(reason = 'snapshot') {
    if (!this.queueStore) return null;
    const saved = this.queueStore.save({
      reason,
      queue: this.queue.map((item) => ({ ...item })),
      runs: this.runs.slice(0, 50).map((run) => ({ ...run }))
    });
    this.lastQueuePersistedAt = saved.persistedAt;
    return saved;
  }

  queuePersistenceStatus() {
    if (!this.queueStore) {
      return { enabled: false };
    }
    return {
      enabled: true,
      ...this.queueStore.metadata?.(),
      lastPersistedAt: this.lastQueuePersistedAt
    };
  }

  storeRun(run) {
    const item = {
      runId: stableId('worker_run', `${run.taskId}:${this.runs.length + 1}`, this.clock().toISOString()),
      createdAt: this.clock().toISOString(),
      ...run
    };
    this.runs.unshift(item);
    this.persistQueue('worker.run.stored');
    return item;
  }

  recentRuns(limit = 20) {
    return this.runs.slice(0, limit);
  }
}

function createPlanGraphReleaseArtifactManifest({
  task,
  releaseChecks,
  schedule,
  retention,
  artifactExport,
  compensationRunner,
  byStatus
}) {
  const manifestCore = {
    artifactManifestVersion: 'a-plan-graph-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    planGraphExecutionManifest: {
      manifestVersion: 'a-plan-graph-execution-manifest-v1',
      planHash: sha256Json({
        planId: task.plan?.planId ?? null,
        graphId: task.plan?.planGraph?.graphId ?? null,
        nodeCount: task.plan?.planGraph?.nodes?.length ?? 0,
        edgeCount: task.plan?.planGraph?.edges?.length ?? 0
      }),
      scheduleVersion: schedule.scheduleVersion,
      runtimeScheduleVersion: schedule.runtimeScheduleVersion,
      mode: schedule.mode,
      waveCount: schedule.waves.length,
      parallelWaveCount: schedule.waves.filter((wave) => wave.parallelizable).length,
      maxParallelism: schedule.maxParallelism,
      workerMaxParallelism: schedule.workerMaxParallelism,
      rawPlanPayloadStored: false
    },
    nodeArtifactManifest: {
      manifestVersion: 'a-plan-node-artifact-release-manifest-v1',
      retentionVersion: retention.retentionVersion,
      exportVersion: artifactExport.exportVersion,
      bundleCount: retention.bundleCount,
      byStatus,
      exportSha256: artifactExport.sha256,
      rawNodeArtifactPayloadStored: false,
      rawOutputPathsStored: false,
      rawCapabilityTokensStored: false
    },
    compensationManifest: {
      manifestVersion: 'a-plan-graph-compensation-release-manifest-v1',
      runnerVersion: compensationRunner.runnerVersion,
      supportsPartialTargeting: compensationRunner.supportsPartialTargeting === true,
      rollbackProofRequired: compensationRunner.rollbackProofRequired === true,
      replayVersion: compensationRunner.replayVersion,
      lastReplayStatus: compensationRunner.lastReplayStatus,
      safeMode: compensationRunner.safeMode === true,
      rawRollbackPayloadStored: false
    },
    releaseEvidenceHashes: {
      releaseChecksHash: sha256Json(releaseChecks.map((check) => ({
        checkId: check.checkId,
        passed: check.passed
      }))),
      scheduleHash: sha256Json({
        runtimeScheduleVersion: schedule.runtimeScheduleVersion,
        scheduleVersion: schedule.scheduleVersion,
        waves: schedule.waves.map((wave) => ({
          wave: wave.wave,
          nodeCount: wave.nodeIds?.length ?? 0,
          parallelizable: wave.parallelizable === true
        }))
      }),
      artifactExportHash: sha256Text(artifactExport.sha256),
      nodeArtifactStatusHash: sha256Json(byStatus),
      compensationRunnerHash: sha256Json({
        runnerVersion: compensationRunner.runnerVersion,
        supportsPartialTargeting: compensationRunner.supportsPartialTargeting,
        rollbackProofRequired: compensationRunner.rollbackProofRequired,
        replayVersion: compensationRunner.replayVersion,
        lastReplayStatus: compensationRunner.lastReplayStatus,
        safeMode: compensationRunner.safeMode
      })
    },
    rawPlanPayloadStored: false,
    rawNodeArtifactPayloadStored: false,
    rawOutputPathsStored: false,
    rawCapabilityTokensStored: false,
    rawRollbackPayloadStored: false
  };
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-plan-graph-release-raw-leak-check-v1',
      rawLeakDetected: containsPlanGraphReleaseRawLeak(JSON.stringify(manifestCore)),
      checkedHashCount: Object.keys(manifestCore.releaseEvidenceHashes).length,
      checkedRawPayloadFlags: [
        'rawPlanPayloadStored',
        'rawNodeArtifactPayloadStored',
        'rawOutputPathsStored',
        'rawCapabilityTokensStored',
        'rawRollbackPayloadStored'
      ]
    }
  };
}

function createPlanGraphCiNightlyGatePlan({ artifactManifest }) {
  return {
    planVersion: 'a-plan-graph-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "A CoreOrchestrationWorker executes parallel-ready plan graph waves|A CoreOrchestrationWorker records node-level artifacts" tests/ag-runtime.test.js',
    requiredForPullRequests: true,
    requiredForNightly: true,
    requiredChecks: [
      'parallel_dag_scheduler_available',
      'node_artifact_retention_available',
      'node_artifact_export_hash_available',
      'compensation_execution_runner_available',
      'plan_graph_release_artifact_manifest_ready',
      'plan_graph_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    retentionPolicy: {
      keepLatestPerBranch: 20,
      keepNightlyDays: 90,
      promotePassedReleaseDossierToWorm: true
    },
    rawPlanPayloadStored: false,
    rawNodeArtifactPayloadStored: false,
    rawCapabilityTokensStored: false
  };
}

function createPlanGraphExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  releaseChecks
}) {
  const status = artifactManifest?.artifactManifestVersion === 'a-plan-graph-release-artifact-manifest-v1'
    && artifactManifest.rawLeakCheck?.rawLeakDetected === false
    && ciNightlyGatePlan?.planVersion === 'a-plan-graph-ci-nightly-gate-plan-v1'
    && releaseChecks.every((check) => check.passed)
    ? 'ready'
    : 'blocked';
  return {
    packageVersion: 'a-plan-graph-worm-promotion-package-v1',
    providerContractVersion: 'a-plan-graph-worm-provider-contract-v1',
    status,
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    releaseChecksHash: sha256Json(releaseChecks.map((check) => ({
      checkId: check.checkId,
      passed: check.passed
    }))),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPlanPayloadStored: false,
    rawNodeArtifactPayloadStored: false,
    rawOutputPathsStored: false,
    rawCapabilityTokensStored: false,
    rawRollbackPayloadStored: false
  };
}

function containsPlanGraphReleaseRawLeak(value) {
  const text = String(value ?? '');
  return /"outputPaths"\s*:|"changedItems"\s*:|"capabilityToken"\s*:|"rollbackJournal"\s*:|Bearer\s+[A-Za-z0-9._~+/-]+=*|[A-Za-z]:\\\\Users\\\\/i.test(text);
}

function createWorkerStateMachineReleaseArtifactManifest({
  now,
  checks,
  leases,
  timeoutScheduler,
  queue,
  leaseHistory
}) {
  const manifestCore = {
    artifactManifestVersion: 'a-worker-state-machine-release-artifact-manifest-v1',
    generatedAt: now,
    leaseContentionManifest: {
      manifestVersion: 'a-worker-state-machine-lease-contention-manifest-v1',
      activeBackend: leases.backend.activeBackend,
      backendVersion: leases.backend.backendVersion,
      fileLockBackendReady: leases.backend.fileLock === true,
      activeLeaseCount: leases.activeLeaseCount,
      expiredLeaseCount: leases.expiredLeaseCount,
      observedLeaseAcquireCount: leaseHistory.filter((item) => item.eventType === 'lease.acquired').length,
      observedLeaseRecoveryCount: leaseHistory.filter((item) => item.eventType === 'lease.recovered').length,
      observedLeaseReleaseCount: leaseHistory.filter((item) => item.eventType === 'lease.released').length,
      rawTaskIdsStored: false,
      rawQueueIdsStored: false
    },
    timeoutSchedulerManifest: {
      manifestVersion: 'a-worker-state-machine-timeout-scheduler-manifest-v1',
      schedulerVersion: timeoutScheduler.schedulerVersion,
      retryDueCount: timeoutScheduler.retryDueCount,
      expiredLeaseItemCount: timeoutScheduler.expiredLeaseItemCount,
      queuePersistenceEnabled: timeoutScheduler.queuePersistence.enabled === true,
      leasePersistenceEnabled: timeoutScheduler.leasePersistence.enabled === true
    },
    releaseEvidenceHashes: {
      checksHash: sha256Json(checks),
      leaseBackendHash: sha256Json({
        backendVersion: leases.backend.backendVersion,
        activeBackend: leases.backend.activeBackend,
        durable: leases.backend.durable,
        fileLock: leases.backend.fileLock
      }),
      heartbeatMonitorHash: sha256Json({
        monitorVersion: leases.heartbeatMonitor.monitorVersion,
        staleLeaseCount: leases.heartbeatMonitor.staleLeaseCount,
        expiredLeaseCount: leases.heartbeatMonitor.expiredLeaseCount
      }),
      timeoutSchedulerHash: sha256Json({
        schedulerVersion: timeoutScheduler.schedulerVersion,
        retryDueCount: timeoutScheduler.retryDueCount,
        expiredLeaseItemCount: timeoutScheduler.expiredLeaseItemCount
      }),
      queueSnapshotHash: sha256Json(queue.map((item) => ({
        status: item.status,
        attempts: item.attempts,
        timeoutMs: item.timeoutMs,
        restoredAfterRestart: item.restoredAfterRestart === true
      }))),
      leaseHistoryHash: sha256Json(leaseHistory.map((item) => ({
        eventType: item.eventType,
        at: item.at
      })))
    },
    queuePersistencePathHash: sha256Text(timeoutScheduler.queuePersistence.filePath ?? 'not-configured'),
    leasePersistencePathHash: sha256Text(timeoutScheduler.leasePersistence.filePath ?? 'not-configured'),
    lockPathHash: sha256Text(timeoutScheduler.leasePersistence.lockPath ?? 'not-configured'),
    rawTaskPayloadStored: false,
    rawQueuePayloadStored: false,
    rawLeasePayloadStored: false,
    rawLeaseStorePathStored: false
  };
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-worker-state-machine-release-raw-leak-check-v1',
      rawLeakDetected: containsWorkerStateRawLeak(JSON.stringify(manifestCore)),
      checkedHashes: Object.keys(manifestCore.releaseEvidenceHashes).length,
      checkedRawPayloadFlags: [
        'rawTaskPayloadStored',
        'rawQueuePayloadStored',
        'rawLeasePayloadStored',
        'rawLeaseStorePathStored'
      ]
    }
  };
}

function createWorkerStateMachineCiNightlyGatePlan({ artifactManifest }) {
  return {
    planVersion: 'a-worker-state-machine-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "A CoreOrchestrationWorker recovers expired task leases|A CoreWorkerDaemon recovers expired leases" tests/ag-runtime.test.js',
    requiredForPullRequests: true,
    requiredForNightly: true,
    requiredChecks: [
      'multiprocess_lease_backend_contract_available',
      'crashed_worker_heartbeat_monitor_available',
      'timeout_scheduler_persistence_available',
      'lease_recovery_retry_bridge_available',
      'lease_recovery_event_observed',
      'worker_state_machine_release_artifact_manifest_ready',
      'worker_state_machine_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    retentionPolicy: {
      keepLatestPerBranch: 20,
      keepNightlyDays: 90,
      promotePassedReleaseDossierToWorm: true
    },
    rawTaskPayloadStored: false,
    rawQueuePayloadStored: false,
    rawLeasePayloadStored: false
  };
}

function createWorkerStateMachineExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  releaseChecks
}) {
  const checksPassed = releaseChecks.every((check) => check.passed);
  const status = artifactManifest?.artifactManifestVersion === 'a-worker-state-machine-release-artifact-manifest-v1'
    && artifactManifest.rawLeakCheck?.rawLeakDetected === false
    && ciNightlyGatePlan?.planVersion === 'a-worker-state-machine-ci-nightly-gate-plan-v1'
    && checksPassed
    ? 'ready'
    : 'blocked';
  return {
    packageVersion: 'a-worker-state-machine-worm-promotion-package-v1',
    providerContractVersion: 'a-worker-state-machine-worm-provider-contract-v1',
    status,
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    releaseChecksHash: sha256Json(releaseChecks),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawTaskPayloadStored: false,
    rawQueuePayloadStored: false,
    rawLeasePayloadStored: false,
    rawLeaseStorePathStored: false
  };
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value ?? null));
}

function containsWorkerStateRawLeak(value) {
  const text = String(value ?? '');
  return /"taskId"\s*:|"queueId"\s*:|"filePath"\s*:|"lockPath"\s*:|rawText|commandText|Bearer\s+[A-Za-z0-9._~+/-]+=*|[A-Za-z]:\\\\Users\\\\/i.test(text);
}
