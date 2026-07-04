import { CoreFacade } from '../../../packages/core/src/core-facade.js';
import { CoreOrchestrationWorker } from '../../../packages/core/src/orchestration/core-orchestration-worker.js';
import { CoreWorkerDaemon } from '../../../packages/core/src/runtime/core-worker-daemon.js';
import { PolicySecurityRuntime } from '../../policy-security/src/policy-runtime.js';
import { PcAgentRuntime } from '../../pc-agent/src/pc-agent-runtime.js';
import { BridgeRuntime } from '../../bridge/src/bridge-runtime.js';
import { GrowthRuntime } from '../../growth-memory/src/growth-runtime.js';
import { VerificationRuntime } from '../../verification/src/verification-runtime.js';

export function createAgRuntime(options = {}) {
  const policyRuntime = new PolicySecurityRuntime(options);
  const growthRuntime = new GrowthRuntime({
    ...options,
    memoryStore: options.memoryStore ?? null,
    policyRuntime
  });
  const verificationRuntime = new VerificationRuntime({
    ...options,
    injectionDetector: policyRuntime.promptInjectionDetector,
    toolOutputEvaluator: (payload) => policyRuntime.evaluateToolOutput(payload),
    growthRuntime
  });
  growthRuntime.attachLearningVerifier(verificationRuntime.learningVerifier);
  const pcAgent = new PcAgentRuntime({
    policyRuntime,
    allowedRoots: options.allowedRoots ?? ['./workspace'],
    auditRoot: options.auditRoot,
    undoJournalPath: options.undoJournalPath,
    rollbackTransactionPath: options.rollbackTransactionPath,
    packetJournalPath: options.packetJournalPath,
    packetQueuePath: options.packetQueuePath,
    tokenVaultPath: options.tokenVaultPath,
    tokenVaultKeyProvider: options.tokenVaultKeyProvider,
    browserDriver: options.browserDriver,
    clock: options.clock
  });
  const coreFacade = new CoreFacade({
    policyEngine: policyRuntime,
    memoryStore: growthRuntime,
    verificationEngine: verificationRuntime,
    clock: options.clock,
    cwd: options.cwd,
    desktopContextProvider: options.desktopContextProvider,
    desktopContextCollector: options.desktopContextCollector,
    inputProviderRegistry: options.inputProviderRegistry,
    eventLogPath: options.coreEventLogPath ?? (options.auditRoot ? `${options.auditRoot}/core-events.jsonl` : 'logs/core-events.jsonl'),
    orchestrationJournalPath: options.coreOrchestrationJournalPath ?? (options.auditRoot ? `${options.auditRoot}/core-orchestration.jsonl` : 'logs/core-orchestration.jsonl')
  });
  const bridgeRuntime = new BridgeRuntime({
    coreFacade,
    policyRuntime,
    pcAgent,
    growthRuntime,
    verificationRuntime,
    clock: options.clock,
    auditRoot: options.auditRoot,
    eventCursorJournalPath: options.eventCursorJournalPath,
    rateLimiter: options.rateLimiter
  });
  if (options.outputPath) {
    bridgeRuntime.outputPath = options.outputPath;
  }
  const orchestrationWorker = new CoreOrchestrationWorker({
    coreFacade,
    policyRuntime,
    pcAgent,
    verificationRuntime,
    growthRuntime,
    allowedPaths: options.allowedRoots ?? ['./workspace'],
    maxAttempts: options.workerMaxAttempts,
    baseBackoffMs: options.workerBaseBackoffMs,
    defaultTimeoutMs: options.workerDefaultTimeoutMs,
    leaseStorePath: options.workerLeaseStorePath,
    queueStorePath: options.workerQueueStorePath,
    clock: options.clock
  });
  const workerDaemon = new CoreWorkerDaemon({
    worker: orchestrationWorker,
    enabled: options.workerDaemonEnabled ?? true,
    intervalMs: options.workerDaemonIntervalMs,
    drainLimit: options.workerDaemonDrainLimit,
    maxConsecutiveFailures: options.workerDaemonMaxConsecutiveFailures,
    clock: options.clock,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer
  });
  return {
    coreFacade,
    policyRuntime,
    pcAgent,
    bridgeRuntime,
    growthRuntime,
    verificationRuntime,
    orchestrationWorker,
    workerDaemon
  };
}
