import { MissionCapabilityAvailabilityGuard } from '../mission/mission-capability-availability.js';
import { PcOutboundExecutionClient } from '../client/pc-outbound-execution-client.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { ActionType, ApprovalDecision, createApprovalDecision, ModuleId, stableId, TaskStatus } from '../../../shared/src/types.js';
import { beginJsonlBatchSync, commitJsonlBatchSync } from '../../../shared/src/jsonl.js';
import { WorkerLeaseTable } from '../runtime/worker-lease-table.js';
import { FileWorkerQueueStore } from '../runtime/worker-queue-store.js';
import { observeFailedTask, archivedFailureTask } from '../runtime/task-failure-observation.js';
import {observeSuccessfulTask,archivedSuccessTask,readArchivedTextArtifact} from '../runtime/task-success-observation.js';

const parallelSafeQueueActionTypes = new Set([
  ActionType.LIST_FILES,
  ActionType.SEARCH_FILES,
  ActionType.CAPABILITY_QUERY
]);
const authorityFencedLocalTools = new Set(['filesystem.createTextFile','filesystem.moveFiles','excel.createWorkbook','archive.createZip','word.create','powerpoint.create','hwp.create','weather.createHwpReport','macro.save','visual.createCards','document.edit', 'filesystem.readText', 'document.readPdf', 'excel.readWorkbook','excel.exportPdf', 'filesystem.listFiles', 'filesystem.searchFiles','source.readSelectedInbox']);

authorityFencedLocalTools.add('case.readLocalRecord');
authorityFencedLocalTools.add('source.collectMicrosoftMetadata');

export class CoreOrchestrationWorker {
  constructor({
    coreFacade,
    policyRuntime = null,
    pcAgent = null,
    selectedSourceExecutor = null,
    verificationRuntime = null,
    growthRuntime = null,
    trustKernel = null,
    executionAuthority = null,
    capabilityPackageRegistry = null,
    capabilityBindingResolver = null,
    capabilityAvailabilityProbe = null,
    capabilityContractRegistry = null,
    allowedPaths = ['./workspace'],
    maxAttempts = 2,
    baseBackoffMs = 1000,
    defaultTimeoutMs = 30_000,
    abortSettleTimeoutMs = 1_000,
    maxPlanParallelism = 4,
    maxQueueConcurrency = 4,
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
    if (selectedSourceExecutor && selectedSourceExecutor.supportsTrustedLocalMissionEffects?.() !== true)
      throw new Error('A_SOURCE_LOCAL_EXECUTOR_FENCE_REQUIRED');
    this.selectedSourceExecutor = selectedSourceExecutor;
    this.verificationRuntime = verificationRuntime;
    this.growthRuntime = growthRuntime;
    this.trustKernel = trustKernel;
    this.executionAuthority = executionAuthority;
    this.capabilityAvailabilityGuard = new MissionCapabilityAvailabilityGuard({ registry: capabilityPackageRegistry,
      resolver: capabilityBindingResolver, probe: capabilityAvailabilityProbe, clock });
    this.capabilityContractRegistry = capabilityContractRegistry ?? pcAgent?.registry ?? null;
    this.taskCapabilityBindings = new WeakMap();
    this.executionAuthority?.assertActive({allowRecovery:true});
    if (!Array.isArray(allowedPaths) || !allowedPaths.length || allowedPaths.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('A_WORKER_ALLOWED_PATHS_INVALID');
    }
    // Resolve host-owned roots once before signing; a relative scope cannot be
    // interpreted consistently by the executor's final authorization check.
    this.allowedPaths = Object.freeze(allowedPaths.map(path => resolve(path)));
    this.maxAttempts = maxAttempts;
    this.baseBackoffMs = baseBackoffMs;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.abortSettleTimeoutMs = normalizePositiveInteger(abortSettleTimeoutMs, 1_000);
    this.maxPlanParallelism = maxPlanParallelism;
    this.maxQueueConcurrency = normalizeConcurrency(maxQueueConcurrency, 4);
    this.artifactRetentionLimit = artifactRetentionLimit;
    this.workerId = workerId ?? stableId('core_worker', process.pid, clock().toISOString());
    this.leaseTtlMs = leaseTtlMs;
    this.clock = clock;
    this.leaseTable = leaseTable ?? new WorkerLeaseTable({ clock, defaultTtlMs: leaseTtlMs, storePath: leaseStorePath });
    this.queueStore = queueStore ?? (queueStorePath ? new FileWorkerQueueStore({ filePath: queueStorePath, clock }) : null);
    this.lastQueuePersistedAt = null;
    this.runs = [];
    this.failureObservations = new Map();
    this.successObservations = new Map();
    this.queue = [];
    this.activeTaskIds = new Set();
    this.nodeArtifactArchive = [];
    this.queueScheduleHistory = [];
    this.durablePhaseHistory = [];
    this.deferredRunPersistenceTaskIds = new Set();
    this.loadPersistedQueueState();
  }

  enqueueTask(taskId, options = {}) {
    this.executionAuthority?.assertActive();
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
      abortSettleTimeoutMs: options.abortSettleTimeoutMs ?? this.abortSettleTimeoutMs,
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

  async drain({ limit = 5, now = this.clock().toISOString(), concurrency = this.maxQueueConcurrency } = {}) {
    this.executionAuthority?.assertActive();
    const normalizedLimit = normalizePositiveInteger(limit, 5);
    const normalizedConcurrency = Math.min(normalizedLimit, normalizeConcurrency(concurrency, this.maxQueueConcurrency));
    const results = [];
    const waves = [];
    const processedQueueIds = new Set();
    while (results.length < normalizedLimit) {
      const waveItems = this.nextQueueWave(now, {
        excludeQueueIds: processedQueueIds,
        limit: Math.min(normalizedConcurrency, normalizedLimit - results.length)
      });
      if (waveItems.length === 0) break;
      const startedAtMs = Date.now();
      const profiles = waveItems.map((item) => this.queueConcurrencyProfile(item));
      const waveResults = await Promise.all(waveItems.map((item) => this.runQueueItem(item, { now })));
      results.push(...waveResults);
      for (const processed of waveResults) {
        if (processed.item?.queueId) processedQueueIds.add(processed.item.queueId);
      }
      waves.push(this.recordQueueScheduleWave({
        waveIndex: waves.length + 1,
        profiles,
        results: waveResults,
        concurrency: normalizedConcurrency,
        durationMs: Date.now() - startedAtMs
      }));
    }
    return {
      processed: results.length,
      results,
      scheduler: {
        schedulerVersion: 'a-resource-aware-worker-queue-scheduler-v1',
        requestedLimit: normalizedLimit,
        maxConcurrency: normalizedConcurrency,
        waveCount: waves.length,
        parallelWaveCount: waves.filter((wave) => wave.parallelized).length,
        waves
      },
      status: this.queueStatus()
    };
  }

  async runNext({ now = this.clock().toISOString(), excludeQueueIds = null } = {}) {
    this.executionAuthority?.assertActive();
    const item = this.nextRunnable(now, { excludeQueueIds });
    if (!item) {
      return { processed: false, reason: 'queue-empty', status: this.queueStatus() };
    }
    return this.runQueueItem(item, { now });
  }

  async runQueueItem(item, { now = this.clock().toISOString() } = {}) {
    this.executionAuthority?.assertActive();
    const uncertainExecution = this.queue.find((candidate) => candidate.queueId !== item.queueId
      && candidate.taskId === item.taskId
      && candidate.status === 'quarantined'
      && candidate.executionUncertain === true);
    if (uncertainExecution) {
      this.quarantineUncertainExecution(item, {
        errorCode: 'A_WORKER_EXECUTION_UNCERTAIN',
        reason: 'task-execution-uncertain',
        relatedQueueId: uncertainExecution.queueId
      });
      return {
        processed: true,
        uncertain: true,
        quarantined: true,
        reason: 'task-execution-uncertain',
        item: this.publicQueueItem(item),
        error: {
          code: 'A_WORKER_EXECUTION_UNCERTAIN',
          message: 'A prior execution for this task has an unknown commit status.'
        }
      };
    }
    if (this.activeTaskIds.has(item.taskId)) {
      this.scheduleRetry(item, 'task-locked');
      return { processed: true, locked: true, item: this.publicQueueItem(item), reason: 'task-locked' };
    }
    const timeoutWindowMs = Number.isFinite(Number(item.timeoutMs)) && Number(item.timeoutMs) > 0
      ? Number(item.timeoutMs)
      : 0;
    const abortSettleWindowMs = normalizePositiveInteger(item.abortSettleTimeoutMs, this.abortSettleTimeoutMs);
    const lease = this.leaseTable.acquire(item.taskId, {
      ownerId: this.workerId,
      queueId: item.queueId,
      ttlMs: Math.max(timeoutWindowMs + abortSettleWindowMs, this.leaseTtlMs),
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
    let releaseGuardInFinally = true;
    let runPromise = null;
    try {
      const existingTask = this.coreFacade.getTask(item.taskId);
      if (existingTask?.status === TaskStatus.FAILED && existingTask.planGraphRun?.verificationFailed === true) {
        this.suppressPlanGraphVerificationRetry(item, { phase: 'before-reexecution' });
        return { processed: true, retrySuppressed: true, reason: item.lastError, item: this.publicQueueItem(item) };
      }
      if (existingTask?.status === TaskStatus.FAILED
        && shouldSuppressNonRollbackRetry({ success: false, execution: existingTask.executionResult })) {
        this.suppressNonRollbackRetry(item, { phase: 'before-reexecution' });
        return {
          processed: true,
          retrySuppressed: true,
          reason: item.lastError,
          item: this.publicQueueItem(item)
        };
      }
      const retryPreparation = this.prepareTaskForRetry(item.taskId, item.options);
      if (retryPreparation && retryPreparation.success !== true) {
        this.finishFailedQueueItem(item, retryPreparation.reason ?? 'worker-retry-not-authorized');
        return { processed: true, item: this.publicQueueItem(item),
          error: { code: 'A_WORKER_RETRY_NOT_AUTHORIZED', message: item.lastError } };
      }
      this.deferredRunPersistenceTaskIds.add(item.taskId);
      const abortController = new AbortController();
      runPromise = this.runTask(item.taskId, {
        ...item.options,
        signal: abortController.signal
      });
      void runPromise.then(() => {
        this.deferredRunPersistenceTaskIds.delete(item.taskId);
      }, () => {
        this.deferredRunPersistenceTaskIds.delete(item.taskId);
      });
      const run = await this.withTimeout(runPromise, item.timeoutMs, {
        abortController,
        abortSettleTimeoutMs: item.abortSettleTimeoutMs
      });
      item.lastRunId = run.runId;
      item.updatedAt = this.clock().toISOString();
      if (run.success) {
        item.status = 'succeeded';
        item.completedAt = item.updatedAt;
        this.coreFacade.eventBus.publish('worker.queue.succeeded', { taskId: item.taskId, queueId: item.queueId, runId: run.runId });
        this.persistQueue('worker.queue.succeeded');
      } else if (run.planGraphRun?.verificationFailed === true) {
        this.suppressPlanGraphVerificationRetry(item, { phase: 'after-execution', runId: run.runId });
      } else if (shouldSuppressNonRollbackRetry(run)) {
        this.suppressNonRollbackRetry(item, { phase: 'after-execution', runId: run.runId });
      } else if (run.error?.code === 'A_WORKER_CAPABILITY_UNAVAILABLE' && run.notDispatched === true) {
        this.finishFailedQueueItem(item, run.error.code);
      } else if (permanentReadFailure(this.coreFacade.getTask(item.taskId), run)) {
        this.finishFailedQueueItem(item, permanentReadFailure(this.coreFacade.getTask(item.taskId), run));
      } else if (item.attempts < item.maxAttempts) {
        this.scheduleRetry(item, run.error?.code ?? run.failure?.reason ?? 'worker-run-failed');
      } else {
        this.finishFailedQueueItem(item, run.error?.code ?? run.failure?.reason ?? 'worker-run-failed');
      }
      return { processed: true, item: this.publicQueueItem(item), run };
    } catch (error) {
      item.updatedAt = this.clock().toISOString();
      if (error?.executionUncertain === true || error?.code === 'A_WORKER_TIMEOUT_UNCERTAIN') {
        releaseGuardInFinally = !runPromise;
        if (runPromise) item.executionSettlementPending = true;
        this.quarantineUncertainExecution(item, {
          errorCode: error.code ?? 'A_WORKER_TIMEOUT_UNCERTAIN',
          reason: 'execution-commit-status-unknown'
        });
        if (runPromise) {
          this.releaseExecutionGuardWhenSettled(item, runPromise);
        }
        return {
          processed: true,
          uncertain: true,
          quarantined: true,
          reason: item.quarantineReason,
          item: this.publicQueueItem(item),
          error: {
            code: error.code ?? 'A_WORKER_TIMEOUT_UNCERTAIN',
            message: error.message
          }
        };
      }
      if (item.attempts < item.maxAttempts) {
        this.scheduleRetry(item, error.code ?? error.message ?? 'worker-exception');
      } else {
        this.finishFailedQueueItem(item, error.code ?? error.message ?? 'worker-exception');
      }
      return { processed: true, item: this.publicQueueItem(item), error: { code: error.code ?? 'A_WORKER_RUN_FAILED', message: error.message } };
    } finally {
      if (releaseGuardInFinally) {
        this.releaseExecutionGuard(item, { reason: 'run-next-finally' });
      }
    }
  }

  async assertTaskCapabilityAvailability(task, phase, packet = null) {
    // Clarification/rejection states remain governed by the existing intake/E path.
    if (!task.plan || typeof task.plan !== 'object' || !task.plan.action) return;
    let plans = this.taskCapabilityBindings.get(task);
    if (!plans) { plans = new WeakMap(); this.taskCapabilityBindings.set(task, plans); }
    let states = plans.get(task.plan);
    if (!states) { states = new Map(); plans.set(task.plan, states); }
    const candidates = packet ? [{ nodeId: packet.planGraphNodeId ?? 'base', action: packet.action }]
      : [{ nodeId: 'base', action: task.plan.action },
        ...this.actionNodesForTask(task).map(node => ({ nodeId: node.nodeId, action: {
          ...task.plan.action, toolName: node.toolName ?? task.plan.action.toolName,
          arguments: node.arguments ?? task.plan.action.arguments, actionType: node.actionType ?? task.plan.action.actionType } }))];
    for (const candidate of candidates) {
      let action = states.get(candidate.nodeId);
      if (!action) { action = { actionId: task.taskId, expectedToolName: candidate.action?.toolName }; states.set(candidate.nodeId, action); }
      const contract = this.capabilityContractRegistry?.contractFor?.(candidate.action?.toolName) ?? {};
      const result = await this.capabilityAvailabilityGuard.assess({ mission: null, action,
        task: { ...task, plan: { ...task.plan, action: candidate.action } }, toolName: candidate.action?.toolName, contract, phase });
      if (result.required) task.capabilityReadiness = result;
      if (!result.available) throw Object.assign(new Error('Capability prerequisites are unavailable.'), {
        code: 'A_WORKER_CAPABILITY_UNAVAILABLE', notDispatched: true, capabilityReadiness: result });
    }
  }

  taskCapabilitySnapshot(task, packet) {
    return this.taskCapabilityBindings.get(task)?.get(task.plan)?.get(packet.planGraphNodeId ?? 'base')?.availabilityBindingSnapshot ?? null;
  }

  async createTaskCapabilityFence(task, packet) {
    const plan = task.plan;
    try { await this.assertTaskCapabilityAvailability(task, 'dispatch', packet); }
    catch (error) {
      if (!error.capabilityReadiness) throw error;
      throw Object.assign(new Error('A_WORKER_CAPABILITY_UNAVAILABLE'), {code:'A_WORKER_CAPABILITY_UNAVAILABLE'});
    }
    const captured = this.taskCapabilitySnapshot(task, packet);
    if (!captured) return () => {};
    const snapshot = structuredClone(captured);
    const expected = JSON.stringify(snapshot);
    const assertFence = () => {
      const deny = () => { throw Object.assign(new Error('A_WORKER_CAPABILITY_REVOKED'), {code:'A_WORKER_CAPABILITY_REVOKED'}); };
      if([TaskStatus.CANCELLED,TaskStatus.BLOCKED,TaskStatus.EXPIRED].includes(task.status))deny();
      if (task.plan !== plan || JSON.stringify(this.taskCapabilitySnapshot(task, packet)) !== expected) deny();
      let available;
      try { available = this.capabilityAvailabilityGuard.registry?.availabilityFor(snapshot.binding,
        {minimumVerification:'live-probe',permissionRevision:snapshot.permissionRevision}); }
      catch { deny(); }
      if (available?.available !== true || available.codeVersion !== snapshot.codeVersion) deny();
    };
    assertFence();
    return assertFence;
  }

  denyTaskCapabilityAvailability(task, result) {
    const message = result.nextAction ?? '연결 상태와 권한을 확인한 후 작업을 다시 요청하세요.';
    if (task.stateMachine.canTransition(TaskStatus.BLOCKED)) {
      task.stateMachine.transition(TaskStatus.BLOCKED, 'A_WORKER_CAPABILITY_UNAVAILABLE');
      task.status = TaskStatus.BLOCKED;
      task.lifecycle.mark(TaskStatus.BLOCKED, message, 'worker-capability-readiness');
    }
    this.coreFacade.eventBus.publish('worker.capability.unavailable', { taskId: task.taskId,
      phase: result.phase, reasons: result.reasons, executionAuthorized: false });
    return { success: false, taskId: task.taskId, status: TaskStatus.BLOCKED, notDispatched: true, capabilityReadiness: result,
      error: { code: 'A_WORKER_CAPABILITY_UNAVAILABLE', message } };
  }

  async runTask(taskId, {
    approvalDecision = null,
    deviceId = 'core_worker',
    userConfirmation = { confirmed: true },
    dryRun = false,
    signal = null,
    localEffectHooks = null,
    beforePlanNodeExecute = null,
    beforePacketDispatch = null
  } = {}) {
    throwIfWorkerAborted(signal);
    this.executionAuthority?.assertActive();
    const task = this.coreFacade.getTask(taskId);
    if (!task) {
      return { success: false, error: { code: 'A_WORKER_TASK_NOT_FOUND', taskId } };
    }
    const reference = task.request?.metadata?.workReference;
    if (reference && typeof this.coreFacade.workMemory?.verifyArtifactReference === 'function') {
      const readAction = ['filesystem.readText','document.readPdf','excel.readWorkbook'].includes(task.plan?.action?.toolName) ? task.plan.action : null;
      const normalizePath = value => typeof value === 'string' && value.trim()
        ? (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)) : null;
      const targetMismatch = readAction && (!normalizePath(reference.path)
        || normalizePath(readAction.arguments?.path) !== normalizePath(reference.path));
      const checked = targetMismatch ? { status: 'target_mismatch' }
        : this.coreFacade.workMemory.verifyArtifactReference(reference, { scope: task.request.metadata.workReferenceScope });
      if (checked.status !== 'resolved') {
        const code = `A_WORK_REFERENCE_${String(checked.status ?? 'UNVERIFIED').toUpperCase()}`;
        const message = targetMismatch
          ? '이어서 사용할 파일과 실행 계획의 대상이 달라 실행을 멈췄습니다. 사용할 파일을 다시 지정해주세요.'
          : '요청을 해석한 뒤 대상 파일이 변경되었거나 확인할 수 없어 실행을 멈췄습니다. 사용할 파일을 다시 지정해주세요.';
        task.policy = { ...task.policy, decision: 'block', blockedReason: message, blockedCode: code };
        if (task.stateMachine.canTransition(TaskStatus.BLOCKED)) {
          task.stateMachine.transition(TaskStatus.BLOCKED, code);
          task.status = TaskStatus.BLOCKED;
          task.lifecycle.mark(TaskStatus.BLOCKED, message, 'work-reference-verification');
        }
        return { success: false, taskId, status: TaskStatus.BLOCKED, error: { code, message } };
      }
    }
    try {
      await this.assertTaskCapabilityAvailability(task, 'planning');
    } catch (error) {
      if (error.capabilityReadiness) return this.denyTaskCapabilityAvailability(task, error.capabilityReadiness);
      throw error;
    }
    const trustAuthorization = this.trustKernel?.authorizeExecution?.({
      action: task.plan?.action ?? {},
      dryRun,
      source: 'core-orchestration-worker'
    }) ?? { allowed: true, code: 'A_TRUST_KERNEL_NOT_ATTACHED', mode: 'unavailable' };
    if (!trustAuthorization.allowed) {
      this.coreFacade.eventBus.publish('worker.execution.trust_blocked', {
        taskId,
        code: trustAuthorization.code,
        mode: trustAuthorization.mode,
        actionType: trustAuthorization.actionType,
        toolName: trustAuthorization.toolName
      });
      return {
        success: false,
        taskId,
        status: TaskStatus.BLOCKED,
        error: {
          code: trustAuthorization.code,
          message: trustAuthorization.reason
        },
        trustAuthorization
      };
    }
    const decision = approvalDecision ?? this.createWorkerApprovalDecision(task, { deviceId });
    const submitted = this.ensureApproved(task, decision);
    if (!submitted.success) {
      return { success: false, taskId, status: task.status, approval: submitted };
    }
    if (task.status !== TaskStatus.APPROVED) {
      return { success: false, taskId, status: task.status, error: { code: 'A_WORKER_TASK_NOT_APPROVED' } };
    }

    const preflight = await this.runVerificationIndexBatch('worker.preflight.index', () => this.runDurablePhase('worker.preflight', () => {
      const capabilityRequest = this.coreFacade.createCapabilityRequest(taskId, decision);
      const capabilityToken = this.issueCapabilityToken(task, decision);
      const planVerification = this.verifyPlan(task);
      const policyVerification = this.verifyPolicy(task, decision, capabilityToken);
      return { capabilityRequest, capabilityToken, planVerification, policyVerification };
    }));
    throwIfWorkerAborted(signal);
    const { capabilityRequest, capabilityToken, planVerification, policyVerification } = preflight;
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
    if (localEffectHooks?.idempotencyKey && typeof localEffectHooks.beforeExecute === 'function') packet.idempotencyKey = localEffectHooks.idempotencyKey;
    await localEffectHooks?.onPacketPrepared?.(packet);
    if (!this.executorForPacket(packet)?.receiveExecutionPacket) {
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

    throwIfWorkerAborted(signal);
    // The worker's own guard applies even with no Mission or supplied callback.
    const packetPrerequisite = async currentPacket => {
      await this.assertTaskCapabilityAvailability(task, 'dispatch', currentPacket);
      if (this.taskCapabilitySnapshot(task, currentPacket) && this.executorForPacket(currentPacket).supportsTrustedLocalMissionEffects?.() !== true) {
        throw Object.assign(new Error('A_WORKER_CAPABILITY_UNAVAILABLE'), {
          code:'A_WORKER_CAPABILITY_UNAVAILABLE',notDispatched:true,capabilityReadiness:{phase:'dispatch',required:true,available:false,
            executionAuthorized:false,reasons:[{code:'executor-availability-fence-unsupported'}],
            nextAction:'연결 권한의 최종 검사를 지원하는 실행기로 연결한 후 다시 요청하세요.'} });
      }
      if (typeof beforePacketDispatch === 'function') await beforePacketDispatch(currentPacket);
    };
    try { await packetPrerequisite(packet); }
    catch (error) {
      if (error.capabilityReadiness) return this.denyTaskCapabilityAvailability(task, error.capabilityReadiness);
      throw error;
    }
    throwIfWorkerAborted(signal);
    this.markExecutionStarted(task, { packetId: packet.packetId, dryRun });
    if (this.shouldRunPlanGraph(task)) {
      return await this.runPlanGraphTask(task, {
        decision,
        capabilityRequest,
        capabilityToken,
        basePacket: packet,
        planVerification,
        policyVerification,
        trustAuthorization,
        dryRun,
        signal,
        beforePacketDispatch: packetPrerequisite,
        beforePlanNodeExecute
      });
    }

    const execution = await this.executePacketWithHealth(packet, { dryRun, source: 'worker-task', signal,
      beforeLocalExecute: localEffectHooks?.beforeExecute, capabilityTask: task });
    // A trusted local receipt is durable before G decides whether it proves success.
    if (localEffectHooks?.onReceipt) await localEffectHooks.onReceipt(execution, packet);
    if (execution.status !== TaskStatus.COMPLETED) {
      // Failure is still an observed B receipt: preserve partial effects and
      // recovery diagnostics for authenticated task reads. Never attach stale
      // G/learning success from an earlier attempt to this failed attempt.
      task.executionResult = execution;
      task.executionVerification = null;
      task.learningResult = null;
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
        trustAuthorization,
        failure
      });
    }

    throwIfWorkerAborted(signal, { executionUncertain: true });
    const postExecution = await this.runVerificationIndexBatch('worker.post-execution.index', async () => {
      const authorityCheck=phase=>{
        if(typeof localEffectHooks?.beforeVerification!=='function')return null;
        try{
          const result=localEffectHooks.beforeVerification(packet);
          if(result&&typeof result.then==='function')throw new Error('A_WORKER_VERIFICATION_FENCE_ASYNC_UNSUPPORTED');
          return null;
        }catch{
          return this.verificationRuntime.result({verificationId:stableId('ver_authority',`${taskId}-${phase}`,this.clock().toISOString()),taskId,
            checks:[{checkId:'current_mandate_verification_authority',status:'failed',severity:'critical',
              message:'현재 위임의 자료 범위 또는 유효기간이 검증 단계에서 확인되지 않았습니다.',evidence:{phase,executionReceiptPreserved:true}}]});
        }
      };
      const beforeDenied=authorityCheck('before-verification');
      if(beforeDenied)return {executionVerification:beforeDenied,learning:null,verificationFailed:true};
      const executionVerification = typeof localEffectHooks?.verifyExecution === 'function'
        ? await localEffectHooks.verifyExecution(execution)
        : await this.verifyExecution(task, execution, capabilityToken);
      const afterDenied=authorityCheck('after-verification');
      if(afterDenied)return {executionVerification:afterDenied,learning:null,verificationFailed:true};
      // Bind the actual dispatch and G objects before recording a decision outcome.
      // The current task alone may have been replanned while G was running.
      this.coreFacade.cognition?.bindDecisionVerification?.(executionVerification, {
        task, execution, packet, workspaceRoot: this.coreFacade.workspaceRoot
      });
      if (this.failedVerification(executionVerification)) {
        return { executionVerification, learning: null, verificationFailed: true };
      }
      return this.runDurablePhase('worker.post-execution', () => {
        const learning = this.ingestAndVerifyLearning(task, execution);
        this.completeTask(task, {
          execution,
          executionVerification,
          learning,
          packetId: packet.packetId
        });
        return { executionVerification, learning };
      });
    });
    const { executionVerification, learning, verificationFailed = false } = postExecution;
    if (verificationFailed) {
      const failure = this.failExecutionVerification(task, {
        execution,
        trustAuthorization,
        executionVerification,
        packetId: packet.packetId
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
        executionVerification,
        failure,
        trace: task.orchestrationTrace
      });
    }
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

  async runVerificationIndexBatch(operation, callback) {
    const reportStore = this.verificationRuntime?.reportStore;
    if (typeof reportStore?.runIndexBatch === 'function') {
      return await reportStore.runIndexBatch(callback, { operation });
    }
    return await callback();
  }

  runDurablePhase(operation, callback) {
    const batch = beginJsonlBatchSync({ operation });
    const startedAtMs = Date.now();
    let result;
    let operationError = null;
    try {
      result = callback();
      if (result && typeof result.then === 'function') {
        const error = new Error('Worker durable phases must remain synchronous.');
        error.code = 'A_WORKER_DURABLE_PHASE_ASYNC_UNSUPPORTED';
        throw error;
      }
    } catch (error) {
      operationError = error;
    }
    let summary = null;
    try {
      summary = commitJsonlBatchSync(batch);
    } catch (flushError) {
      if (operationError && typeof operationError === 'object') {
        operationError.durabilityFlushError = flushError?.message ?? String(flushError);
      } else {
        operationError = flushError;
      }
    }
    const record = {
      phaseVersion: 'a-worker-durable-phase-v1',
      operation,
      status: operationError ? 'failed' : 'completed',
      durationMs: Date.now() - startedAtMs,
      logicalRecordCount: summary?.logicalRecordCount ?? 0,
      physicalWriteCount: summary?.physicalWriteCount ?? 0,
      writeReductionRatio: summary?.writeReductionRatio ?? 0,
      rawPayloadStored: false,
      completedAt: this.clock().toISOString()
    };
    this.durablePhaseHistory.unshift(record);
    this.durablePhaseHistory = this.durablePhaseHistory.slice(0, 100);
    if (operationError) throw operationError;
    return result;
  }

  async runCompensation(taskId, {
    failureBranchId = 'failure_execution_partial',
    targetNodeIds = null,
    mode = targetNodeIds ? 'partial' : 'full',
    reason = 'core-worker-compensation-replay',
    userConfirmation = null
  } = {}) {
    const task = this.coreFacade.getTask(taskId);
    if (!task) {
      return { success: false, error: { code: 'A_WORKER_TASK_NOT_FOUND', taskId } };
    }
    const userInitiatedUndo = task.status === TaskStatus.COMPLETED;
    if (userInitiatedUndo && userConfirmation?.confirmed !== true) {
      return {
        success: false,
        taskId,
        status: task.status,
        error: {
          code: 'A_COMPENSATION_CONFIRMATION_REQUIRED',
          message: 'A completed task can only be undone after explicit user confirmation.'
        }
      };
    }
    const completedExecutionResult = task.executionResult?.executionResult ?? task.executionResult ?? null;
    if (userInitiatedUndo && completedExecutionResult?.rollbackAvailable !== true) {
      return {
        success: false,
        taskId,
        status: task.status,
        error: {
          code: 'A_COMPENSATION_NOT_AVAILABLE',
          message: 'This completed task does not expose a verified rollback path.'
        }
      };
    }
    const compensationActions = this.compensationActionsForReplay(task, { targetNodeIds });
    if (compensationActions.length === 0) {
      return {
        success: false,
        taskId,
        status: task.status,
        error: {
          code: 'A_COMPENSATION_ACTIONS_NOT_FOUND',
          message: 'No compensating actions are available for this task.'
        }
      };
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
    if (this.executionAuthority && compensationActions.length > 0) {
      this.executionAuthority.assertActive();
      // The rollback journal does not yet recheck this SQL authority per mutation.
      // Never silently use that unguarded path in authority-enabled mode.
      throw Object.assign(new Error('A_CORE_AUTHORITY_ROLLBACK_FENCE_UNSUPPORTED'), { code: 'A_CORE_AUTHORITY_ROLLBACK_FENCE_UNSUPPORTED' });
    }
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
    trustAuthorization,
    dryRun,
    signal = null,
    beforePlanNodeExecute = null,
    beforePacketDispatch = null
  }) {
    this.coreFacade.cognition?.beginDecisionGraph?.(task, {
      packet: basePacket, workspaceRoot: this.coreFacade.workspaceRoot
    });
    const graphRun = await this.executePlanGraph(task, { basePacket, decision, dryRun, signal, beforePacketDispatch, beforePlanNodeExecute });
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
        trustAuthorization,
        execution: graphRun.execution,
        failure: graphRun.failure,
        planGraphRun: graphRun
      });
    }

    throwIfWorkerAborted(signal, { executionUncertain: true });
    const { verificationTargets = [], ...publicGraphRun } = graphRun;
    const postExecution = await this.runVerificationIndexBatch('worker.plan-graph.post-execution.index', async () => {
      const executionVerification = await this.verifyPlanGraphExecution(task, verificationTargets);
      this.coreFacade.cognition?.bindDecisionGraphVerification?.(executionVerification, {
        task, execution: graphRun.execution, packet: basePacket, verificationTargets,
        workspaceRoot: this.coreFacade.workspaceRoot
      });
      if (this.failedVerification(executionVerification)) {
        return { executionVerification, learning: null, verificationFailed: true };
      }
      return this.runDurablePhase('worker.plan-graph.post-execution', () => {
        const learning = this.ingestAndVerifyLearning(task, graphRun.execution);
        this.completeTask(task, {
          execution: graphRun.execution,
          executionVerification,
          learning,
          packetId: basePacket.packetId
        });
        return { executionVerification, learning };
      });
    });
    const { executionVerification, learning, verificationFailed = false } = postExecution;
    if (verificationFailed) {
      const targetNodeIds = verificationTargets.map((target) => target.nodeId);
      const partialCompensation = this.coreFacade.orchestrator.planCompensation({
        task,
        failureBranchId: 'failure_dag_node_failed',
        targetNodeIds,
        mode: 'partial',
        evidence: {
          reason: 'execution-verification-failed',
          verificationId: executionVerification?.verificationId,
          failedNodeIds: executionVerification?.nodeVerifications
            ?.filter((item) => item.status === 'failed')
            .map((item) => item.nodeId) ?? [],
          nodeArtifactBundles: graphRun.execution?.evidence?.nodeArtifactBundles ?? [],
          schedule: graphRun.schedule
        }
      });
      this.coreFacade.eventBus.publish('compensation.partial.planned', { taskId: task.taskId, plan: partialCompensation });
      task.planGraphRun = {
        ...task.planGraphRun,
        status: 'verification_failed',
        verificationFailed: true,
        executionVerification,
        partialCompensation
      };
      const failure = this.failExecutionVerification(task, {
        execution: graphRun.execution,
        executionVerification,
        packetId: basePacket.packetId,
        evidence: {
          targetNodeIds,
          partialCompensationId: partialCompensation.compensationPlanId
        }
      });
      const failedGraphRun = {
        ...publicGraphRun,
        success: false,
        verificationFailed: true,
        executionVerification,
        partialCompensation,
        failure
      };
      this.coreFacade.eventBus.publish('worker.plan_graph.verification_failed', {
        taskId: task.taskId,
        verificationId: executionVerification?.verificationId,
        targetNodeIds
      });
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
        trustAuthorization,
        execution: graphRun.execution,
        executionVerification,
        failure,
        planGraphRun: failedGraphRun,
        trace: task.orchestrationTrace
      });
    }
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
      trustAuthorization,
      execution: graphRun.execution,
      executionVerification,
      learning,
      planGraphRun: publicGraphRun,
      trace: task.orchestrationTrace
    });
  }

  async executePlanGraph(task, { basePacket, decision, dryRun, signal = null, beforePacketDispatch = null, beforePlanNodeExecute = null }) {
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
      throwIfWorkerAborted(signal, { executionUncertain: completedNodeIds.size > 0 });
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
        signal,
        beforePacketDispatch,
        beforePlanNodeExecute,
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
      // Settle the already-started wave, then explicitly record unexecuted work.
      const recordedNodeIds = new Set(nodeRuns.map((run) => run.nodeId));
      for (const node of actionNodes.filter((node) => !recordedNodeIds.has(node.nodeId))) {
        const skipped = this.skipPlanNode(task, node, { reason: 'graph-stopped-after-node-failure', failedNodeId: failedRun.nodeId });
        skippedRuns.push(skipped);
        nodeRuns.push(skipped);
      }
      const verificationFailed = waveRuns.some((run) => run.verificationFailed === true);
      // G rejection cannot erase the effects of a B-completed node.
      const executedNodeIds = nodeRuns.filter((run) => run.execution?.status === TaskStatus.COMPLETED).map((run) => run.nodeId);
      const partialCompensation = this.coreFacade.orchestrator.planCompensation({
        task,
        failureBranchId: 'failure_dag_node_failed',
        targetNodeIds: executedNodeIds,
        mode: 'partial',
        evidence: {
          failedNodeId: failedRun.nodeId,
          skippedNodeIds: skippedRuns.map((run) => run.nodeId),
          artifactBundle: failedRun.artifactBundle,
          verificationFailed,
          verificationGate: failedRun.verificationGate ?? null,
          schedule
        }
      });
      this.coreFacade.eventBus.publish('compensation.partial.planned', { taskId: task.taskId, plan: partialCompensation });
      const executionSummary = this.aggregatePlanGraphExecution(task, nodeRuns, basePacket, TaskStatus.FAILED);
      task.planGraphRun = {
        runVersion: 'a-plan-graph-runner-v1',
        planId: task.plan?.planId ?? null,
        graphId: task.plan?.planGraph?.graphId ?? null,
        schedule,
        status: verificationFailed ? 'verification_failed' : 'failed',
        verificationFailed,
        failedNodeId: failedRun.nodeId,
        nodeRuns: this.publicNodeRuns(nodeRuns),
        partialCompensation
      };
      task.executionResult = executionSummary;
      task.learningResult = null;
      const failure = this.coreFacade.recordExecutionFailure(task.taskId, {
        reason: verificationFailed ? 'A_WORKER_PLAN_GRAPH_NODE_VERIFICATION_FAILED'
          : failedRun.execution?.blockedReason ?? failedRun.execution?.executionResult?.summary ?? 'A_WORKER_PLAN_GRAPH_NODE_FAILED',
        evidence: {
          failedNodeId: failedRun.nodeId,
          skippedNodeIds: skippedRuns.map((run) => run.nodeId),
          completedNodeIds: [...completedNodeIds],
          executedNodeIds,
          verificationFailed,
          verificationGate: failedRun.verificationGate ?? null,
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
        verificationFailed,
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
      planId: task.plan?.planId ?? null,
      graphId: task.plan?.planGraph?.graphId ?? null,
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
      execution,
      verificationTargets: nodeRuns
        .filter((run) => run.status === 'completed')
        .map((run) => ({
          nodeId: run.nodeId,
          packet: run.packet,
          capability: run.capability,
          execution: run.execution,
          verification: run.executionVerification
        }))
    };
  }

  async executePlanNode(task, { node, basePacket, decision, dryRun, signal = null, beforePacketDispatch = null, beforePlanNodeExecute = null, wave }) {
    throwIfWorkerAborted(signal);
    const nodeAction = {
      ...task.plan?.action,
      actionType: node.actionType ?? task.plan?.action?.actionType,
      toolName: node.toolName ?? task.plan?.action?.toolName,
      skillId: node.skillId ?? task.plan?.action?.skillId,
      arguments: node.arguments ?? task.plan?.action?.arguments,
      planGraphNode: {
        nodeId: node.nodeId,
        order: node.order,
        description: node.description
      }
    };
    const trustAuthorization = this.trustKernel?.authorizeExecution?.({
      action: nodeAction,
      dryRun,
      source: 'core-orchestration-worker-plan-node'
    }) ?? { allowed: true, code: 'A_TRUST_KERNEL_NOT_ATTACHED', mode: 'unavailable' };
    if (!trustAuthorization.allowed) {
      const execution = {
        taskId: task.taskId,
        status: TaskStatus.BLOCKED,
        blockedReason: trustAuthorization.code,
        trustAuthorization
      };
      const artifactBundle = this.nodeArtifactBundle({
        task,
        node,
        packet: null,
        execution,
        status: 'failed',
        extra: {
          scheduleWave: wave.waveIndex,
          trustMode: trustAuthorization.mode,
          trustCode: trustAuthorization.code
        }
      });
      this.coreFacade.orchestrator.markNode({
        task,
        nodeId: node.nodeId,
        status: 'failed',
        evidence: {
          blockedReason: trustAuthorization.code,
          artifactBundle,
          scheduleWave: wave.waveIndex,
          trustMode: trustAuthorization.mode
        }
      });
      this.coreFacade.eventBus.publish('worker.plan_node.trust_blocked', {
        taskId: task.taskId,
        nodeId: node.nodeId,
        code: trustAuthorization.code,
        mode: trustAuthorization.mode,
        scheduleWave: wave.waveIndex
      });
      return {
        nodeId: node.nodeId,
        status: 'failed',
        packet: null,
        capability: null,
        execution,
        trustAuthorization,
        executionVerification: null,
        artifactBundle
      };
    }
    const nodeCapability = this.issueNodeCapabilityToken(task, decision, node);
    const nodePacket = this.createNodeExecutionPacket({ basePacket, node, capabilityToken: nodeCapability });
    try {
      if (typeof beforePacketDispatch === 'function') await beforePacketDispatch(nodePacket);
    } catch (error) {
      // Settle this graph node as an undispatched denial. Promise.all must still
      // await siblings and retain previously completed B/G observations.
      const execution = { taskId: task.taskId, status: TaskStatus.BLOCKED,
        blockedReason: error?.code ?? 'A_WORKER_PACKET_PREREQUISITE_DENIED', notDispatched: true };
      const artifactBundle = this.nodeArtifactBundle({ task, node, packet: nodePacket,
        execution, status: 'failed', extra: { scheduleWave: wave.waveIndex, notDispatched: true } });
      this.coreFacade.orchestrator.markNode({ task, nodeId: node.nodeId, status: 'failed',
        evidence: { blockedReason: execution.blockedReason, artifactBundle, notDispatched: true } });
      return { nodeId: node.nodeId, status: 'failed', packet: this.publicPacket(nodePacket),
        capability: this.publicCapability(nodeCapability), execution, trustAuthorization,
        executionVerification: null, artifactBundle };
    }
    throwIfWorkerAborted(signal);
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

    const execution = await this.executePacketWithHealth(nodePacket, { dryRun, source: 'worker-plan-node', signal, capabilityTask: task,
      beforeLocalExecute: beforePlanNodeExecute });
    const executionCompleted = execution.status === TaskStatus.COMPLETED;
    // Capture each node's postcondition before downstream nodes consume or move its output.
    let executionVerification = null;
    let verificationGate = null;
    if (executionCompleted) {
      try {
        const verificationId = executionVerificationId(task, execution, node.nodeId, this.clock().toISOString());
        executionVerification = await this.verifyExecution(task, execution, nodeCapability, { contextId: node.nodeId, verificationId });
        verificationGate = nodeVerificationGate(task, executionVerification, verificationId);
      } catch (error) {
        throwIfWorkerAborted(signal, { executionUncertain: true });
        // Preserve the committed B result when G is unavailable. This is a gate
        // diagnostic, not a fabricated G report or an excuse to repeat the write.
        verificationGate = { status: 'failed', reason: 'verification-error', errorCode: healthErrorCode(error?.code) };
      }
    }
    const completed = executionCompleted && verificationGate?.status === 'passed';
    const verificationFailed = executionCompleted && !completed;
    if (executionVerification) {
      this.coreFacade.cognition?.bindDecisionNodeVerification?.(executionVerification, {
        task, node, execution, packet: nodePacket, basePacket,
        workspaceRoot: this.coreFacade.workspaceRoot
      });
    }
    const artifactBundle = this.nodeArtifactBundle({
      task,
      node,
      packet: nodePacket,
      execution,
      status: completed ? 'completed' : 'failed',
      extra: {
        scheduleWave: wave.waveIndex,
        verificationId: executionVerification?.verificationId ?? null,
        verificationStatus: executionVerification?.status ?? null,
        verificationScore: executionVerification?.score ?? null,
        verificationGate,
        verificationFailed
      }
    });
    const nodeRun = {
      nodeId: node.nodeId,
      status: completed ? 'completed' : 'failed',
      packet: this.publicPacket(nodePacket),
      capability: this.publicCapability(nodeCapability),
      execution,
      trustAuthorization,
      executionVerification,
      verificationGate,
      verificationFailed,
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
        scheduleWave: wave.waveIndex,
        verificationId: executionVerification?.verificationId ?? null,
        verificationStatus: executionVerification?.status ?? null,
        verificationGate,
        verificationFailed
      }
    });
    this.coreFacade.eventBus.publish(completed ? 'worker.plan_node.completed' : 'worker.plan_node.failed', {
      taskId: task.taskId,
      nodeId: node.nodeId,
      packetId: nodePacket.packetId,
      artifactBundle,
      scheduleWave: wave.waveIndex,
      verificationId: executionVerification?.verificationId ?? null,
      verificationStatus: executionVerification?.status ?? null,
      verificationGate,
      verificationFailed
    });
    return nodeRun;
  }

  executorForPacket(packet) {
    // This is a host-installed, read-only Core capability, never a fallback for
    // arbitrary PC actions. Preserve the original remote executor identity.
    return ['source.readSelectedInbox','case.readLocalRecord','source.collectMicrosoftMetadata'].includes(packet?.action?.toolName) && this.selectedSourceExecutor
      ? this.selectedSourceExecutor : this.pcAgent;
  }

  async executePacketWithHealth(packet, { dryRun = false, source = 'core-worker', signal = null, beforeLocalExecute = null, capabilityTask = null } = {}) {
    const executor = this.executorForPacket(packet);
    throwIfWorkerAborted(signal);
    const startedAt = performance.now();
    try {
      this.executionAuthority?.assertActive();
      let guardedBeforeExecute = beforeLocalExecute;
      if (!dryRun && capabilityTask && this.taskCapabilitySnapshot(capabilityTask, packet)) {
        if (executor.supportsTrustedLocalMissionEffects?.() !== true) {
          throw Object.assign(new Error('A_WORKER_REMOTE_AVAILABILITY_FENCE_UNSUPPORTED'), {
            code:'A_WORKER_REMOTE_AVAILABILITY_FENCE_UNSUPPORTED',notDispatched:true });
        }
        const originalGuard = guardedBeforeExecute;
        guardedBeforeExecute = async value => {
          const prerequisiteFence = await this.createTaskCapabilityFence(capabilityTask, value);
          const effectFence = originalGuard ? await originalGuard(value) : null;
          if (originalGuard && typeof effectFence !== 'function') throw new Error('B_LOCAL_EFFECT_FENCE_INVALID');
          const assertFence = () => { throwIfWorkerAborted(signal); prerequisiteFence(); effectFence?.(); };
          if (typeof effectFence?.onRemoteCancellation === 'function') assertFence.onRemoteCancellation=value=>effectFence.onRemoteCancellation(value);
          if(typeof effectFence?.assertMovePlan==='function')assertFence.assertMovePlan=items=>{assertFence();return effectFence.assertMovePlan(items);};
          if(typeof effectFence?.assertArtifactPlan==='function')assertFence.assertArtifactPlan=plan=>{assertFence();return effectFence.assertArtifactPlan(plan);};
          if(effectFence?.weatherPublication)assertFence.weatherPublication=structuredClone(effectFence.weatherPublication);
          if(effectFence?.macroPublication)assertFence.macroPublication=structuredClone(effectFence.macroPublication);
          assertFence();
          return assertFence;
        };
      }
      if (this.executionAuthority && !dryRun) {
        const fencedOutbound=executor instanceof PcOutboundExecutionClient&&executor.supportsCoreAuthorityFencing()
          &&packet.action?.toolName==='filesystem.createTextFile'&&typeof beforeLocalExecute==='function';
        const fencedLocal=executor.supportsTrustedLocalMissionEffects?.()===true&&authorityFencedLocalTools.has(packet.action?.toolName);
        if (!fencedLocal&&!fencedOutbound) {
          throw Object.assign(new Error('A_CORE_AUTHORITY_EXECUTOR_FENCE_UNSUPPORTED'), { code: 'A_CORE_AUTHORITY_EXECUTOR_FENCE_UNSUPPORTED' });
        }
        const prerequisiteGuard = guardedBeforeExecute;
        guardedBeforeExecute = async value => {
          this.executionAuthority.assertActive();
          const originalFence = prerequisiteGuard ? await prerequisiteGuard(value) : null;
          if (prerequisiteGuard && typeof originalFence !== 'function') throw new Error('B_LOCAL_EFFECT_FENCE_INVALID');
          const assertFence = () => { this.executionAuthority.assertActive(); originalFence?.(); };
          if(typeof originalFence?.onRemoteCancellation==='function')assertFence.onRemoteCancellation=value=>originalFence.onRemoteCancellation(value);
          if(typeof originalFence?.assertMovePlan==='function')assertFence.assertMovePlan=items=>{assertFence();return originalFence.assertMovePlan(items);};
          if(typeof originalFence?.assertArtifactPlan==='function')assertFence.assertArtifactPlan=plan=>{assertFence();return originalFence.assertArtifactPlan(plan);};
          if(originalFence?.weatherPublication)assertFence.weatherPublication=structuredClone(originalFence.weatherPublication);
          if(originalFence?.macroPublication)assertFence.macroPublication=structuredClone(originalFence.macroPublication);
          assertFence();
          return assertFence;
        };
      }
      const executionOptions = { dryRun, ...(signal ? { signal } : {}), ...(guardedBeforeExecute ? { beforeLocalExecute: guardedBeforeExecute } : {}) };
      const execution = await executor.receiveExecutionPacket(packet, executionOptions);
      throwIfWorkerAborted(signal, { executionUncertain: true });
      if (!dryRun) {
        this.coreFacade.recordToolExecution?.({
          toolName: packet.action?.toolName,
          status: execution.status === TaskStatus.COMPLETED ? 'completed' : 'failed',
          success: execution.status === TaskStatus.COMPLETED,
          durationMs: performance.now() - startedAt,
          errorCode: healthErrorCode(execution.blockedReason),
          source
        });
      }
      return execution;
    } catch (error) {
      if (!dryRun) {
        this.coreFacade.recordToolExecution?.({
          toolName: packet.action?.toolName,
          status: 'failed',
          success: false,
          durationMs: performance.now() - startedAt,
          errorCode: healthErrorCode(error?.code),
          source
        });
      }
      throw error;
    }
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
      packetId: stableId('packet', createHash('sha256')
        .update(JSON.stringify([basePacket.packetId, node.nodeId])).digest('hex'), createdAt),
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
    const executedRuns = nodeRuns.filter((run) => run.execution?.status === TaskStatus.COMPLETED);
    const artifactBundles = nodeRuns.map((run) => run.artifactBundle);
    const outputPaths = executedRuns.flatMap((run) => run.execution?.executionResult?.outputPaths ?? []);
    const changedItems = executedRuns.flatMap((run) => run.execution?.executionResult?.changedItems ?? []);
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
        rollbackAvailable: executedRuns.some((run) => run.execution?.executionResult?.rollbackAvailable === true),
        executedBy: {
          module: ModuleId.PC_AGENT,
          toolName: task.plan?.action?.toolName,
          runner: 'a-plan-graph-runner-v1'
        },
        evidence: {
          artifactBundleVersion: 'a-plan-node-artifact-bundle-v1',
          nodeArtifactBundles: artifactBundles,
          completedNodeIds: completedRuns.map((run) => run.nodeId),
          executedNodeIds: executedRuns.map((run) => run.nodeId),
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
      notDispatched: run.execution?.notDispatched === true,
      blockedReason: run.execution?.blockedReason ?? null,
      trustAuthorization: run.trustAuthorization ?? null,
      verificationStatus: run.executionVerification?.status ?? null,
      verificationScore: run.executionVerification?.score ?? null,
      verificationGate: run.verificationGate ?? null,
      verificationFailed: run.verificationFailed === true
    }));
  }

  createWorkerApprovalDecision(task, { deviceId }) {
    const decision = createApprovalDecision({
      approvalId: task.approvalCard.approvalId,
      taskId: task.taskId,
      decision: ApprovalDecision.APPROVE,
      deviceId,
      sourceModule: ModuleId.CORE,
      decidedAt: this.clock().toISOString()
    });
    this.coreFacade.cognition?.markWorkerDecision?.(decision);
    return decision;
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

  async verifyExecution(task, execution, capabilityToken, { contextId = null, verificationId = null, recoveryReadRoots = [], observationOnly = false, beforeResultRead = null } = {}) {
    // stableId truncates its readable value; hash the full node/dispatch identity so
    // long task names cannot collapse concurrently verified nodes into one report.
    return await (this.verificationRuntime?.verifyExecution?.({
      verificationId: verificationId ?? executionVerificationId(task, execution, contextId, this.clock().toISOString()),
      taskId: task.taskId,
      target: {
        executionResult: execution.executionResult,
        evidence: execution.evidence,
        capabilityToken,
        recoveryReadRoots,
        macroControlStorePath:execution.executionResult?.executedBy?.toolName==='macro.save'?this.pcAgent.registry?.get('macro.save')?.store?.path:null,
        adapterContract: execution.executionResult?.safety?.adapterContract
      }
    }, { observationOnly, beforeResultRead }) ?? null);
  }

  async verifyPlanGraphExecution(task, verificationTargets = []) {
    const targets = Array.isArray(verificationTargets) ? verificationTargets : [];
    const plannedNodes = Array.isArray(task.plan?.planGraph?.nodes) ? task.plan.planGraph.nodes : [];
    const requiredNodeIds = plannedNodes.filter(node => typeof node?.nodeId === 'string' && node.nodeId.startsWith('action_')).map(node => node.nodeId);
    const targetNodeIds = targets.map(target => target?.nodeId);
    const required = new Set(requiredNodeIds);
    const supplied = new Set(targetNodeIds);
    const guard = (checkId, passed, message) => ({
      checkId, checkName: checkId, status: passed ? 'passed' : 'failed', severity: 'critical', message
    });
    const contractChecks = [
      guard('plan_graph_required_nodes_present', requiredNodeIds.length > 0,
        'The current plan must declare action nodes.'),
      guard('plan_graph_required_nodes_unique', required.size === requiredNodeIds.length,
        'The current plan must declare each action node exactly once.'),
      guard('plan_graph_target_nodes_complete', Array.isArray(verificationTargets)
        && targetNodeIds.length === requiredNodeIds.length && supplied.size === targetNodeIds.length
        && targetNodeIds.every(nodeId => required.has(nodeId)),
        'Verification targets must contain every current action node exactly once, with no unknown nodes.')
    ];
    const nodeVerifications = [];
    for (const target of targets) {
      const verification = target?.verification ?? (target?.execution && target?.capability ? await this.verifyExecution(
        task,
        target.execution,
        target.capability,
        { contextId: target.nodeId }
      ) : null);
      nodeVerifications.push({
        nodeId: target?.nodeId ?? 'missing_node',
        verification
      });
    }

    const seenVerificationIds = new Set();
    const checks = [...contractChecks, ...nodeVerifications.flatMap(({ nodeId, verification }) => {
      if (!verification) {
        return [{
          checkId: `${nodeId}:execution_verification_report_present`,
          checkName: `${nodeId}:execution_verification_report_present`,
          status: 'failed',
          severity: 'critical',
          message: 'PlanGraph node execution verification report is required.',
          evidence: { nodeId }
        }];
      }
      const sourceChecks = Array.isArray(verification.checks) ? verification.checks : [];
      const validId = typeof verification.verificationId === 'string' && verification.verificationId.length > 0;
      const uniqueId = validId && !seenVerificationIds.has(verification.verificationId);
      if (validId) seenVerificationIds.add(verification.verificationId);
      const checksValid = sourceChecks.length > 0
        && sourceChecks.every(check => check && ['passed', 'failed'].includes(check.status));
      const statusConsistent = checksValid && (verification.status === 'passed'
        ? sourceChecks.every(check => check.status === 'passed')
        : verification.status === 'failed' && sourceChecks.some(check => check.status === 'failed'));
      return [
        guard(`${nodeId}:execution_verification_task_current`, verification.taskId === task.taskId,
          'The node verification must belong to the current task.'),
        guard(`${nodeId}:execution_verification_identity_unique`, uniqueId,
          'Every node verification must have its own nonempty verification identity.'),
        guard(`${nodeId}:execution_verification_checks_present`, checksValid,
          'Every node verification must contain valid, nonempty checks.'),
        guard(`${nodeId}:execution_verification_status_consistent`, statusConsistent,
          'The node report status must agree with its checks.'),
        ...sourceChecks.filter(check => check && typeof check === 'object').map((check) => ({
        ...check,
        checkId: `${nodeId}:${check.checkId}`,
        checkName: `${nodeId}:${check.checkName ?? check.checkId}`,
        evidence: {
          ...(check.evidence ?? {}),
          nodeId,
          sourceVerificationId: verification.verificationId
        }
      }))];
    })];
    if (targets.length === 0) {
      checks.push({
        checkId: 'plan_graph_verification_targets_present',
        checkName: 'plan_graph_verification_targets_present',
        status: 'failed',
        severity: 'critical',
        message: 'PlanGraph execution must contain at least one node verification target.',
        evidence: { nodeCount: 0 }
      });
    }

    const verificationId = stableId('ver_exec_graph', task.taskId, this.clock().toISOString());
    const aggregate = typeof this.verificationRuntime?.result === 'function'
      ? this.verificationRuntime.result({ verificationId, taskId: task.taskId, checks })
      : {
          verificationId,
          taskId: task.taskId,
          status: checks.some((check) => check.status === 'failed') ? 'failed' : 'passed',
          score: checks.length > 0
            ? Math.round((checks.filter((check) => check.status === 'passed').length / checks.length) * 100)
            : 0,
          checks,
          createdAt: this.clock().toISOString()
        };
    return {
      ...aggregate,
      verificationVersion: 'a-plan-graph-execution-verification-v1',
      nodeVerifications: nodeVerifications.map(({ nodeId, verification }) => ({
        nodeId,
        verificationId: verification?.verificationId ?? null,
        status: verification?.status ?? 'failed',
        score: verification?.score ?? 0,
        failedCheckIds: (Array.isArray(verification?.checks) ? verification.checks : null)
          ?.filter((check) => check?.status === 'failed')
          .map((check) => check.checkId) ?? ['execution_verification_report_missing']
      }))
    };
  }

  ingestAndVerifyLearning(task, execution, { recoveredScopeProof } = {}) {
    const memoryEvent = execution.memoryEvent ? { ...execution.memoryEvent, source: {
      ...execution.memoryEvent.source,
      memoryScope: { userId: task.request.userId, workspaceRoot: this.coreFacade.workspaceRoot, conversationId: task.request.metadata?.conversationId ?? null }
    } } : null;
    const ingest = memoryEvent
      ? (this.growthRuntime?.ingest?.(memoryEvent, { recoveredScopeProof }) ?? this.growthRuntime?.ingestor?.ingest?.(memoryEvent, { recoveredScopeProof }) ?? null)
      : null;
    if (ingest?.success === false) return { ingest, memoryEvent: null, verification: {
      status: 'failed', score: 0, error: { code: ingest.error?.code ?? 'F_MEMORY_EVENT_NOT_PERSISTED' },
      checks: [{ checkId: 'memory_event_persisted', status: 'failed' }] } };
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
    if (this.failedVerification(executionVerification)) {
      const error = new Error('A task cannot complete after execution verification has failed.');
      error.code = 'A_WORKER_COMPLETION_REQUIRES_PASSED_VERIFICATION';
      throw error;
    }
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
      phase: learning?.ingest?.success === false ? 'worker.learning.failed' : 'worker.learning.ingested',
      module: ModuleId.GROWTH_MEMORY,
      message: learning?.ingest?.success === false ? 'F growth memory did not persist execution memory event.' : 'F growth memory ingested execution memory event.',
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
    this.coreFacade.eventBus.publish(learning?.ingest?.success === false ? 'worker.learning.failed' : 'worker.learning.ingested', { taskId: task.taskId, learning });
    this.coreFacade.eventBus.publish('orchestration.trace.updated', { taskId: task.taskId, trace: task.orchestrationTrace });
    // 대화기억: 완료 작업을 작업 일지에 남겨 다음 명령의 "그거/방금 만든 파일" 참조를 가능하게 한다.
    const finalResult = execution?.executionResult ?? execution ?? {};
    this.coreFacade.workMemory?.record?.({
      taskId: task.taskId,
      scope: task.request?.metadata?.workReferenceScope ?? this.coreFacade.workReferenceScope?.({
        metadata: task.request?.metadata, userId: task.request?.userId
      }),
      missionId: task.request?.metadata?.missionId ?? null,
      operationId: task.request?.metadata?.operationId ?? null,
      rawText: task.request?.metadata?.workReferenceOriginalText ?? task.request?.command?.rawText ?? '',
      actionType: task.plan?.action?.actionType ?? null,
      outputPaths: finalResult.outputPaths ?? [],
      summary: finalResult.summary ?? null,
      status: finalResult.status === 'success' ? 'success' : 'failed'
    });
  }

  async previewCompensation(taskId, { targetNodeIds = null, mode = targetNodeIds ? 'partial' : 'full' } = {}) {
    const task = this.coreFacade.getTask(taskId);
    if (!task) {
      return { success: false, error: { code: 'A_WORKER_TASK_NOT_FOUND', taskId } };
    }
    const executionResult = task.executionResult?.executionResult ?? task.executionResult ?? null;
    if (task.status === TaskStatus.COMPLETED && executionResult?.rollbackAvailable !== true) {
      return {
        success: false,
        taskId,
        status: task.status,
        error: {
          code: 'A_COMPENSATION_NOT_AVAILABLE',
          message: 'This completed task does not expose a verified rollback path.'
        }
      };
    }
    const compensationActions = this.compensationActionsForReplay(task, { targetNodeIds });
    if (compensationActions.length === 0) {
      return {
        success: false,
        taskId,
        status: task.status,
        error: {
          code: 'A_COMPENSATION_ACTIONS_NOT_FOUND',
          message: 'No compensating actions are available for this task.'
        }
      };
    }
    if (typeof this.pcAgent?.rollbackPlan !== 'function') {
      return {
        success: false,
        taskId,
        status: task.status,
        error: {
          code: 'A_COMPENSATION_PREVIEW_UNAVAILABLE',
          message: 'The task-owning PC runtime cannot produce a rollback preview.'
        }
      };
    }
    const rollbackPlan = await this.pcAgent.rollbackPlan(taskId);
    if (rollbackPlan?.success !== true) return rollbackPlan;
    return {
      ...rollbackPlan,
      previewVersion: 'a-core-compensation-preview-v1',
      taskStatus: task.status,
      mode,
      compensationActionCount: compensationActions.length,
      targetNodeIds,
      safeToExecute: rollbackPlan.blockedCount === 0
        && rollbackPlan.chain?.status === 'valid'
        && rollbackPlan.readyCount > 0
    };
  }

  failExecutionVerification(task, {
    execution,
    executionVerification,
    packetId,
    reason = 'A_WORKER_EXECUTION_VERIFICATION_FAILED',
    evidence = {}
  }) {
    if (task.status !== TaskStatus.VERIFYING && task.stateMachine.canTransition(TaskStatus.VERIFYING)) {
      task.stateMachine.transition(TaskStatus.VERIFYING, 'core-worker-verification-started', {
        packetId,
        verificationId: executionVerification?.verificationId
      });
      task.status = task.stateMachine.status;
      task.lifecycle.mark(TaskStatus.VERIFYING, '검증 시작', 'G verification started after B execution');
    }
    task.executionResult = execution;
    task.executionVerification = executionVerification;
    task.learningResult = null;
    this.coreFacade.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'worker.execution.completed',
      module: ModuleId.PC_AGENT,
      message: 'B PC agent completed the execution packet.',
      evidence: {
        packetId,
        evidenceId: execution?.evidence?.evidenceId,
        status: execution?.status
      }
    });
    this.coreFacade.orchestrator.appendTrace(task.orchestrationTrace, {
      phase: 'worker.verification.failed',
      module: ModuleId.VERIFICATION,
      status: 'failed',
      message: 'G verification rejected execution evidence; completion was blocked.',
      evidence: {
        verificationId: executionVerification?.verificationId,
        status: executionVerification?.status,
        score: executionVerification?.score,
        failedCheckIds: executionVerification?.checks
          ?.filter((check) => check.status === 'failed')
          .map((check) => check.checkId) ?? [],
        ...evidence
      }
    });
    const failure = this.coreFacade.recordExecutionFailure(task.taskId, {
      reason,
      evidence: {
        packetId,
        verificationId: executionVerification?.verificationId,
        verificationStatus: executionVerification?.status,
        verificationScore: executionVerification?.score,
        ...evidence
      }
    });
    this.coreFacade.eventBus.publish('worker.verification.failed', {
      taskId: task.taskId,
      packetId,
      verificationId: executionVerification?.verificationId,
      status: task.status
    });
    return failure;
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
    return this.runnableQueueItems(now, { excludeQueueIds })[0] ?? null;
  }

  runnableQueueItems(now = this.clock().toISOString(), { excludeQueueIds = null } = {}) {
    const nowMs = Date.parse(now instanceof Date ? now.toISOString() : now);
    return this.queue
      .filter((item) => ['queued', 'retry_scheduled'].includes(item.status))
      .filter((item) => !excludeQueueIds?.has(item.queueId))
      .filter((item) => Date.parse(item.nextAttemptAt) <= nowMs)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt));
  }

  nextQueueWave(now = this.clock().toISOString(), { excludeQueueIds = null, limit = this.maxQueueConcurrency } = {}) {
    const candidates = this.runnableQueueItems(now, { excludeQueueIds });
    if (candidates.length === 0) return [];
    const maxItems = Math.min(candidates.length, normalizeConcurrency(limit, this.maxQueueConcurrency));
    const selected = [candidates[0]];
    const selectedTaskIds = new Set([candidates[0].taskId]);
    if (maxItems === 1 || !this.queueConcurrencyProfile(candidates[0]).parallelSafe) return selected;

    for (const candidate of candidates.slice(1)) {
      if (selected.length >= maxItems) break;
      const profile = this.queueConcurrencyProfile(candidate);
      if (!profile.parallelSafe || selectedTaskIds.has(candidate.taskId)) break;
      selected.push(candidate);
      selectedTaskIds.add(candidate.taskId);
    }
    return selected;
  }

  queueConcurrencyProfile(item) {
    const task = this.coreFacade.getTask(item?.taskId);
    const actionTypes = [...new Set(this.actionNodesForTask(task ?? {}).map((node) => node.actionType).filter(Boolean))];
    if (actionTypes.length === 0 && task?.plan?.action?.actionType) {
      actionTypes.push(task.plan.action.actionType);
    }
    const forcedSequential = item?.options?.forceSequential === true
      || item?.options?.queueConcurrency === 'exclusive';
    const policyBlocked = task?.policy?.decision === 'block';
    const parallelSafe = !forcedSequential
      && !policyBlocked
      && actionTypes.length > 0
      && actionTypes.every((actionType) => parallelSafeQueueActionTypes.has(actionType));
    let reason = 'read-only-independent';
    if (!task) reason = 'task-not-found';
    else if (forcedSequential) reason = 'caller-requested-exclusive';
    else if (policyBlocked) reason = 'policy-blocked';
    else if (actionTypes.length === 0) reason = 'action-type-unknown';
    else if (!parallelSafe) reason = 'mutating-or-exclusive-action';
    return {
      profileVersion: 'a-worker-queue-concurrency-profile-v1',
      parallelSafe,
      reason,
      actionTypes,
      riskTier: task?.policy?.risk?.tier ?? null,
      rawCommandStored: false,
      rawAffectedItemsStored: false
    };
  }

  recordQueueScheduleWave({ waveIndex, profiles, results, concurrency, durationMs }) {
    const record = {
      waveVersion: 'a-worker-queue-schedule-wave-v1',
      waveIndex,
      selectedCount: results.length,
      parallelized: results.length > 1,
      configuredConcurrency: concurrency,
      durationMs,
      actionTypes: [...new Set(profiles.flatMap((profile) => profile.actionTypes))],
      profileReasons: [...new Set(profiles.map((profile) => profile.reason))],
      succeededCount: results.filter((result) => result.item?.status === 'succeeded').length,
      failedCount: results.filter((result) => result.item?.status === 'failed' || result.error).length,
      rawCommandStored: false,
      rawAffectedItemsStored: false,
      completedAt: this.clock().toISOString()
    };
    this.queueScheduleHistory.unshift(record);
    this.queueScheduleHistory = this.queueScheduleHistory.slice(0, 100);
    this.coreFacade.eventBus.publish('worker.queue.wave.completed', {
      schedulerVersion: 'a-resource-aware-worker-queue-scheduler-v1',
      ...record
    });
    return record;
  }

  quarantineUncertainExecution(item, {
    errorCode = 'A_WORKER_TIMEOUT_UNCERTAIN',
    reason = 'execution-commit-status-unknown',
    relatedQueueId = null
  } = {}) {
    const quarantinedAt = this.clock().toISOString();
    item.status = 'quarantined';
    item.updatedAt = quarantinedAt;
    item.quarantinedAt = item.quarantinedAt ?? quarantinedAt;
    item.lastError = errorCode;
    item.retrySuppressed = true;
    item.retrySuppressionReason = reason;
    item.executionUncertain = true;
    item.quarantineReason = reason;
    if (relatedQueueId) item.relatedUncertainQueueId = relatedQueueId;
    this.coreFacade.eventBus.publish('worker.queue.quarantined', {
      taskId: item.taskId,
      queueId: item.queueId,
      errorCode,
      reason,
      relatedQueueId
    });
    this.persistQueue('worker.queue.quarantined');
    return this.publicQueueItem(item);
  }

  releaseExecutionGuardWhenSettled(item, runPromise) {
    item.executionSettlementPending = true;
    const settle = (outcome) => {
      try {
        item.executionSettlementPending = false;
        item.executionSettledAt = this.clock().toISOString();
        item.executionSettlementOutcome = outcome;
        item.updatedAt = item.executionSettledAt;
        this.coreFacade.eventBus.publish('worker.queue.quarantined_execution_settled', {
          taskId: item.taskId,
          queueId: item.queueId,
          outcome
        });
        this.persistQueue('worker.queue.quarantined_execution_settled');
      } finally {
        this.releaseExecutionGuard(item, { reason: 'quarantined-execution-settled' });
      }
    };
    void Promise.resolve(runPromise).then(
      () => settle('fulfilled'),
      () => settle('rejected')
    );
  }

  releaseExecutionGuard(item, { reason = 'worker-finished' } = {}) {
    this.activeTaskIds.delete(item.taskId);
    const released = this.leaseTable.release(item.taskId, {
      ownerId: this.workerId,
      reason
    });
    if (released.released) {
      this.coreFacade.eventBus.publish('worker.lease.released', {
        taskId: item.taskId,
        queueId: item.queueId,
        lease: released.lease
      });
    }
    return released;
  }

  scheduleRetry(item, reason) {
    if (item.status === 'quarantined' || item.executionUncertain === true) {
      return item;
    }
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

  suppressPlanGraphVerificationRetry(item, { phase, runId = null } = {}) {
    return this.suppressNonRollbackRetry(item, { phase, runId,
      errorCode: 'A_WORKER_PLAN_GRAPH_VERIFICATION_RETRY_SUPPRESSED',
      reason: 'partially-executed-graph-requires-verification-review' });
  }

  suppressNonRollbackRetry(item, { phase, runId = null,
    errorCode = 'A_WORKER_NON_ROLLBACK_RETRY_SUPPRESSED',
    reason = 'successful-non-rollback-execution-requires-verification-review' } = {}) {
    item.status = 'failed';
    item.updatedAt = this.clock().toISOString();
    item.completedAt = item.updatedAt;
    item.lastError = errorCode;
    item.retrySuppressed = true;
    item.retrySuppressionReason = reason;
    this.coreFacade.eventBus.publish('worker.queue.retry_suppressed', {
      taskId: item.taskId,
      queueId: item.queueId,
      runId: runId ?? item.lastRunId,
      phase,
      reason: item.lastError
    });
    this.persistQueue('worker.queue.retry_suppressed');
    return this.publicQueueItem(item);
  }

  recoverExpiredLeases({ now = this.clock().toISOString() } = {}) {
    const recovery = this.leaseTable.recoverExpired({ now });
    const heartbeatMonitor = this.leaseTable.heartbeatMonitor({ now });
    for (const lease of recovery.recovered) {
      const item = this.queue.find((candidate) => candidate.queueId === lease.queueId)
        ?? this.queue.find((candidate) => candidate.taskId === lease.taskId && candidate.status === 'running');
      if (item && this.activeTaskIds.has(lease.taskId)) {
        const held = this.leaseTable.acquire(lease.taskId, {
          ownerId: this.workerId,
          queueId: item.queueId,
          ttlMs: this.leaseTtlMs,
          metadata: {
            ...lease.metadata,
            recoveryDeferred: true,
            executionUncertain: item.executionUncertain === true
          },
          now
        });
        if (held.acquired) item.lease = held.lease;
        this.coreFacade.eventBus.publish('worker.lease.recovery_deferred', {
          taskId: lease.taskId,
          queueId: item.queueId,
          reason: 'local-execution-still-active',
          lease: held.lease
        });
        this.persistQueue('worker.lease.recovery_deferred');
      } else if (item && item.status === 'running') {
        this.activeTaskIds.delete(lease.taskId);
        this.scheduleRetry(item, 'task-lease-expired');
      } else {
        this.activeTaskIds.delete(lease.taskId);
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

  finishFailedQueueItem(item, reason) {
    item.status = 'failed';
    item.lastError = reason;
    item.completedAt = item.updatedAt = this.clock().toISOString();
    const task = this.coreFacade.getTask(item.taskId);
    if ([TaskStatus.EXECUTING, TaskStatus.VERIFYING, TaskStatus.RETRYING].includes(task?.status)) {
      this.coreFacade.recordExecutionFailure(item.taskId, {
        reason, evidence: { queueId: item.queueId, phase: 'worker-queue-terminal-failure' }
      });
    }
    this.coreFacade.eventBus.publish('worker.queue.failed', { taskId: item.taskId, queueId: item.queueId, error: item.lastError });
    this.persistQueue('worker.queue.failed');
  }

  prepareTaskForRetry(taskId, { approvalDecision = null, deviceId = 'core_worker' } = {}) {
    const task = this.coreFacade.getTask(taskId);
    if (!task || task.status !== TaskStatus.FAILED) return null;
    // Revalidate the original approval and consume the existing retry budget.
    // runTask enters from APPROVED; marking EXECUTING here prevents that entry.
    return this.coreFacade.submitApprovalDecision(approvalDecision
      ?? this.createWorkerApprovalDecision(task, { deviceId }));
  }

  async withTimeout(promise, timeoutMs, {
    abortController = null,
    abortSettleTimeoutMs = this.abortSettleTimeoutMs
  } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    const settlement = Promise.resolve(promise).then(
      (value) => ({ state: 'fulfilled', value }),
      (error) => ({ state: 'rejected', error })
    );
    let timeoutId;
    const firstOutcome = await Promise.race([
      settlement,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ state: 'timed_out' }), timeoutMs);
      })
    ]);
    clearTimeout(timeoutId);
    if (firstOutcome.state === 'fulfilled') return firstOutcome.value;
    if (firstOutcome.state === 'rejected') throw firstOutcome.error;

    const timeoutError = createWorkerTimeoutError(timeoutMs);
    if (!abortController) throw timeoutError;
    if (!abortController.signal.aborted) {
      abortController.abort(timeoutError);
    }

    const settleWindowMs = normalizePositiveInteger(abortSettleTimeoutMs, this.abortSettleTimeoutMs);
    let settleTimerId;
    const afterAbort = await Promise.race([
      settlement,
      new Promise((resolve) => {
        settleTimerId = setTimeout(() => resolve({ state: 'unsettled' }), settleWindowMs);
      })
    ]);
    clearTimeout(settleTimerId);
    if (afterAbort.state === 'rejected'
      && isCooperativeWorkerAbort(afterAbort.error, abortController.signal)) {
      throw timeoutError;
    }

    const uncertainError = createWorkerTimeoutUncertainError(timeoutMs, settleWindowMs);
    uncertainError.executionSettled = afterAbort.state !== 'unsettled';
    uncertainError.settlementState = afterAbort.state;
    throw uncertainError;
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
      timeoutMs: item.timeoutMs,
      abortSettleTimeoutMs: item.abortSettleTimeoutMs,
      nextAttemptAt: item.nextAttemptAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt ?? null,
      lastRunId: item.lastRunId,
      lease: item.lease ?? null,
      restoredAfterRestart: item.restoredAfterRestart === true,
      lastError: item.lastError,
      retrySuppressed: item.retrySuppressed === true,
      retrySuppressionReason: item.retrySuppressionReason ?? null,
      executionUncertain: item.executionUncertain === true,
      executionSettlementPending: item.executionSettlementPending === true,
      executionSettledAt: item.executionSettledAt ?? null,
      executionSettlementOutcome: item.executionSettlementOutcome ?? null,
      quarantinedAt: item.quarantinedAt ?? null,
      quarantineReason: item.quarantineReason ?? null,
      relatedUncertainQueueId: item.relatedUncertainQueueId ?? null
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
      scheduler: this.queueSchedulerStatus(),
      counts,
      items: this.queue.map((item) => this.publicQueueItem(item))
    };
  }

  queueSchedulerStatus() {
    return {
      schedulerVersion: 'a-resource-aware-worker-queue-scheduler-v1',
      maxConcurrency: this.maxQueueConcurrency,
      selectionPolicy: 'fifo-contiguous-read-only-independent',
      parallelSafeActionTypes: [...parallelSafeQueueActionTypes],
      mutatingActionsRemainSequential: true,
      duplicateTaskIdsRemainSequential: true,
      recentWaves: this.queueScheduleHistory.slice(0, 20),
      recentDurablePhases: this.durablePhaseHistory.slice(0, 20),
      privacy: {
        rawCommandsStored: false,
        rawAffectedItemsStored: false
      }
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
    this.failureObservations=new Map((snapshot.failureObservations??[]).map(item=>[item.taskId,item]));
    this.successObservations=new Map((snapshot.successObservations??[]).map(item=>[item.taskId,item]));
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
      runs: this.runs.slice(0, 50).map((run) => ({ ...run })),
      failureObservations:[...this.failureObservations.values()].slice(-500),
      successObservations:[...this.successObservations.values()].slice(-500)
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
    const observedTask=this.coreFacade.getTask(run.taskId);
    const observation=observeFailedTask(observedTask,this.clock().toISOString());
    if(observedTask) this.failureObservations.delete(run.taskId);
    const previousSuccess=this.successObservations.get(run.taskId);
    const sameVerification=previousSuccess&&observedTask?.status==='COMPLETED'&&previousSuccess.verificationId===observedTask.executionVerification?.verificationId&&previousSuccess.verificationId!==null;
    if(observedTask&&!sameVerification) this.successObservations.delete(run.taskId);
    const success=sameVerification?null:observeSuccessfulTask(observedTask,this.clock().toISOString(),this.allowedPaths);
    if(success&&!sameVerification){this.successObservations.set(success.taskId,success);while(this.successObservations.size>500)this.successObservations.delete(this.successObservations.keys().next().value);}
    if(observation) {
      this.failureObservations.set(observation.taskId,observation);
      while(this.failureObservations.size>500) this.failureObservations.delete(this.failureObservations.keys().next().value);
    }
    const cognition=this.coreFacade.cognition;
    const cognitiveResult=cognition?.observeRun(run, this.coreFacade.getTask(run.taskId));
    if(run.execution&&cognition)run.execution.cognitionPersistence={status:cognitiveResult?.recorded||cognitiveResult?.duplicate?'persisted':!cognitiveResult&&cognition.lastError?'pending':'excluded',reason:cognitiveResult?.reason??null};
    const item = {
      runId: stableId('worker_run', `${run.taskId}:${this.runs.length + 1}`, this.clock().toISOString()),
      createdAt: this.clock().toISOString(),
      ...run
    };
    this.runs.unshift(item);
    if (!this.deferredRunPersistenceTaskIds.has(run.taskId)) {
      this.persistQueue('worker.run.stored');
    }
    return item;
  }

  recentRuns(limit = 20) {
    return this.runs.slice(0, limit);
  }
  archivedTask(taskId) {
    const observation=this.failureObservations.get(taskId);
    return observation?archivedFailureTask(observation):this.successObservations.has(taskId)?archivedSuccessTask(this.successObservations.get(taskId),this.allowedPaths):null;
  }
  archivedTasks() { return [...this.failureObservations.values()].map(archivedFailureTask).concat([...this.successObservations.values()].map(item=>({...archivedSuccessTask({...item,artifacts:[]},this.allowedPaths)}))); }
  archivedTextArtifact(taskId,index){const item=this.successObservations.get(taskId);if(!item)throw Error('unavailable');return readArchivedTextArtifact(item,index,this.allowedPaths);}
}

function executionVerificationId(task, execution, contextId, createdAt) {
  const targetId = contextId ? createHash('sha256')
    .update(JSON.stringify([task.taskId, task.plan?.planId, contextId,
      execution.executionResult?.packetId, execution.evidence?.evidenceId])).digest('hex') : task.taskId;
  return stableId('ver_exec', targetId, createdAt);
}

function nodeVerificationGate(task, report, expectedVerificationId) {
  if (!report) return { status: 'failed', reason: 'report-missing' };
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (report.taskId !== task.taskId || report.verificationId !== expectedVerificationId
    || checks.length === 0 || !checks.every(check => check && ['passed', 'failed'].includes(check.status))
    || !['passed', 'failed'].includes(report.status)
    || report.status === 'passed' && checks.some(check => check.status !== 'passed')
    || report.status === 'failed' && checks.every(check => check.status === 'passed')) {
    return { status: 'failed', reason: 'report-invalid' };
  }
  return report.status === 'passed' ? { status: 'passed', reason: null } : { status: 'failed', reason: 'report-failed' };
}

export function shouldSuppressNonRollbackRetry(run) {
  const execution = run?.execution ?? run;
  const executionResult = execution?.executionResult;
  return run?.success !== true
    && execution?.status === TaskStatus.COMPLETED
    && executionResult?.status === 'success'
    && executionResult?.rollbackAvailable === false
    && executionResult?.safety?.adapterContract?.rollback === false;
}

function permanentReadFailure(task, run) {
  if (task?.plan?.action?.toolName !== 'filesystem.readText') return null;
  const permanent = new Set([
    'text-file-missing', 'read-target-not-file', 'text-file-too-large',
    'unsupported-text-extension', 'outside-allowed-roots-or-unreadable'
  ]);
  const result = run?.execution?.executionResult;
  const reasons = [run?.execution?.blockedReason, run?.failure?.reason, run?.error?.code,
    ...(Array.isArray(result?.warnings) ? result.warnings : [])];
  return reasons.find((reason) => typeof reason === 'string' && permanent.has(reason)) ?? null;
}

function createWorkerTimeoutError(timeoutMs) {
  const error = new Error(`Core worker timed out after ${timeoutMs}ms.`);
  error.code = 'A_WORKER_TIMEOUT';
  return error;
}

function createWorkerTimeoutUncertainError(timeoutMs, abortSettleTimeoutMs) {
  const error = new Error(
    `Core worker timed out after ${timeoutMs}ms and did not cooperatively abort within ${abortSettleTimeoutMs}ms; execution commit status is unknown.`
  );
  error.code = 'A_WORKER_TIMEOUT_UNCERTAIN';
  error.executionUncertain = true;
  return error;
}

function isCooperativeWorkerAbort(error, signal) {
  if (!error || error.executionUncertain === true) return false;
  if (signal?.aborted && error === signal.reason) return true;
  return error.name === 'AbortError'
    || ['ABORT_ERR', 'A_WORKER_ABORTED'].includes(error.code);
}

function throwIfWorkerAborted(signal, { executionUncertain = false } = {}) {
  if (!signal?.aborted) return;
  const error = new Error(executionUncertain
    ? 'Worker execution was aborted after crossing a mutation boundary; commit status is unknown.'
    : 'Worker execution was aborted before crossing the next execution boundary.');
  error.name = 'AbortError';
  error.code = executionUncertain ? 'A_WORKER_ABORTED_UNCERTAIN' : 'A_WORKER_ABORTED';
  error.executionUncertain = executionUncertain;
  throw error;
}

function normalizeConcurrency(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.max(1, Math.min(16, Math.floor(fallback)));
  return Math.max(1, Math.min(16, Math.floor(numeric)));
}

function normalizePositiveInteger(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(numeric));
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

function healthErrorCode(value) {
  const normalized = String(value ?? 'EXECUTION_NOT_COMPLETED').trim();
  return /^[A-Z][A-Z0-9_.:-]{2,159}$/.test(normalized) ? normalized : 'EXECUTION_NOT_COMPLETED';
}

function containsWorkerStateRawLeak(value) {
  const text = String(value ?? '');
  return /"taskId"\s*:|"queueId"\s*:|"filePath"\s*:|"lockPath"\s*:|rawText|commandText|Bearer\s+[A-Za-z0-9._~+/-]+=*|[A-Za-z]:\\\\Users\\\\/i.test(text);
}
