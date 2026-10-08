import { tmpdir } from 'node:os';
import {PcAgentExecutionClient} from '../../../packages/core/src/client/pc-agent-execution-client.js';
import {RemoteEmailReadiness} from './remote-email-readiness.js';
import {planReviewedMcpMission} from '../../../packages/core/src/mission/reviewed-mcp-planner.js';
import {A2aServiceRegistry} from '../../../packages/core/src/capabilities/a2a-service-registry.js';
import { normalizeMemoryScope } from '../../growth-memory/src/memory-provenance.js';
import { join } from 'node:path';
import { CoreFacade } from '../../../packages/core/src/core-facade.js';
import { CognitiveRuntime } from '../../../packages/core/src/cognition/cognitive-runtime.js';
import { WorkMemory } from '../../../packages/core/src/conversation-memory.js';
import { createIntentParserFromEnv } from '../../../packages/core/src/intent/claude-cli-intent-adapter.js';
import { createTaskPlannerFromEnv } from '../../../packages/core/src/planning/claude-cli-task-planner.js';
import { CoreOrchestrationWorker } from '../../../packages/core/src/orchestration/core-orchestration-worker.js';
import { CoreWorkerDaemon } from '../../../packages/core/src/runtime/core-worker-daemon.js';
import { createExecutionEnvironmentProfile } from '../../../packages/core/src/runtime/execution-environment-optimizer.js';
import { createMissionPlannerFromEnv } from '../../../packages/core/src/mission/mission-planner.js';
import { describeModelProviders } from '../../../packages/core/src/mission/model-provider.js';
import { CapabilityPackageRegistry } from '../../../packages/core/src/capabilities/capability-package-registry.js';
import { FailureImprovementPipeline } from '../../../packages/core/src/capabilities/failure-improvement-pipeline.js';
import { createComparativeCapabilityEvaluator } from '../../../packages/core/src/capabilities/comparative-capability-evaluator.js';
import {McpPackageInstaller} from '../../../packages/core/src/capabilities/mcp-package-installer.js';
import {McpConnectionManager} from '../../../packages/core/src/personal-operations/mcp-connections.js';
import { CapabilityPackagePromotionManager } from '../../../packages/core/src/capabilities/capability-package-promotion.js';
import { CapabilityPackagePromotionJournal } from '../../../packages/core/src/capabilities/capability-package-promotion-journal.js';
import { createContainerCapabilityPackageEvaluator } from '../../../packages/core/src/capabilities/container-capability-package-evaluator.js';
import { registerMissionArgumentSchema } from '../../../packages/core/src/planning/mission-action-arguments.js';
import { MissionRuntime } from '../../../packages/core/src/mission/mission-runtime.js';
import { createMissionEgressAuthorizationPolicy } from '../../../packages/core/src/mission/mission-egress-authorization-policy.js';
import { consumeRecoveredMemoryScopeProof } from '../../../packages/core/src/mission/mission-action-recovery.js';
import { FileMissionStore, MemoryMissionStore } from '../../../packages/core/src/mission/mission-store.js';
import { createLocalMissionSnapshotRecovery } from '../../../packages/core/src/mission/local-mission-snapshot-recovery.js';
import { PersonalOwnerSessionManager } from '../../../packages/core/src/security/personal-owner-session.js';
import { createPersonalContextProvider } from '../../../packages/core/src/personal-operations/personal-profile.js';
import { RuntimeTrustKernel } from '../../../packages/core/src/security/runtime-trust-kernel.js';
import { PolicySecurityRuntime } from '../../policy-security/src/policy-runtime.js';
import { BridgeRuntime } from '../../bridge/src/bridge-runtime.js';
import { GrowthRuntime } from '../../growth-memory/src/growth-runtime.js';
import { VerificationRuntime } from '../../verification/src/verification-runtime.js';
import {createPcAgentExecutionComponents,activatePcWorkflowCapability} from './create-pc-runtime.js';
import {CapabilityLimitedRollout} from '../../../packages/core/src/capabilities/capability-limited-rollout.js';
import {assertBuiltWorkflowCapability} from '../../../packages/core/src/capabilities/workflow-artifact-builder.js';
import {EmailConnectionController} from './email-connection-controller.js';
import {createSelectedSourceCapabilityPackage} from './selected-source-capability-package.js';
import {createMicrosoftCollectionCapabilityPackage} from './microsoft-collection-capability-package.js';
import {createLifecycleCaseCapabilityPackage} from './lifecycle-case-capability-package.js';

let isolatedTestRuntimeSequence = 0;

export function createAgRuntime(options = {}) {
  if(options.capabilityPackageRecoveryDefinitions!==undefined&&!(options.capabilityPackageRecoveryDefinitions instanceof Map))throw Object.assign(new Error('Recovery definitions require a host-owned Map.'),{code:'A_CAPABILITY_PACKAGE_RECOVERY_CATALOG_INVALID'});
  const capabilityPackageRecoveryDefinitions=new Map(options.capabilityPackageRecoveryDefinitions??[]);
  if(options.workflowCapabilityDefinition) assertBuiltWorkflowCapability(options.workflowCapabilityDefinition);
  if(options.mcpReviewedPackageCatalog&&!(options.mcpReviewedPackageCatalog instanceof Map))throw Object.assign(new Error('Reviewed MCP catalog must be a local Map.'),{code:'A_MCP_INSTALL_CATALOG_INVALID'});
  if(options.pcAgentExecutor&&options.mcpReviewedPackageCatalog?.size)throw Object.assign(new Error('MCP packages require the local executor installation target.'),{code:'A_MCP_INSTALL_LOCAL_EXECUTOR_REQUIRED'});
  if (options.missionExecutionAuthority && (options.missionExecutionAuthority.store !== options.missionStore
    || typeof options.missionExecutionAuthority.assertActive !== 'function')) throw new Error('A_CORE_AUTHORITY_BINDING_INVALID');
  options.missionExecutionAuthority?.assertActive({allowRecovery:true});
  const runtimeEnv = options.env ?? process.env;
  const taskRuntimeEnv = options.taskEnv ?? runtimeEnv;
  const testMode = process.env.JARVIS_TEST_MODE === '1' || runtimeEnv.JARVIS_TEST_MODE === '1';
  if (!options.auditRoot && testMode) {
    const testRoot = process.env.JARVIS_TEST_AUDIT_ROOT ?? runtimeEnv.JARVIS_TEST_AUDIT_ROOT ?? tmpdir();
    isolatedTestRuntimeSequence += 1;
    options = { ...options, auditRoot: join(testRoot, `runtime-${process.pid}-${isolatedTestRuntimeSequence}`) };
  }
  const executionEnvironment = options.executionEnvironmentProfile ?? createExecutionEnvironmentProfile({
    env: runtimeEnv,
    requested: {
      workerMaxQueueConcurrency: options.workerMaxQueueConcurrency,
      workerMaxPlanParallelism: options.workerMaxPlanParallelism,
      workerDefaultTimeoutMs: options.workerDefaultTimeoutMs,
      missionMaxPlannerTools: options.missionMaxPlannerTools
    },
    browserDriverConfigured: Boolean(options.browserDriver),
    desktopControlConfigured: Boolean(options.desktopControlAdapter),
    desktopVisionConfigured: Boolean(options.desktopVisionAdapter)
  });
  const tuned = (name, fallback) => executionEnvironment.applied?.[name]?.value ?? fallback;
  const allowedRoots = options.allowedRoots ?? ['./workspace'];
  const capabilityPackageRegistry = options.capabilityPackageRegistry ?? new CapabilityPackageRegistry({ clock: options.clock });
  const trustActorId = options.trustActorId ?? 'ag-runtime';
  const trustRoot = options.trustRoot ?? options.auditRoot ?? null;
  const trustKernel = options.trustKernel ?? new RuntimeTrustKernel({
    actorId: trustActorId,
    clock: options.clock,
    statePath: options.trustStatePath ?? (trustRoot ? join(trustRoot, 'runtime-trust-state.json') : null),
    auditPath: options.trustAuditPath ?? (trustRoot ? join(trustRoot, `runtime-trust-audit-${trustActorId}.jsonl`) : null),
    keyPath: options.trustKeyPath ?? (trustRoot ? join(trustRoot, 'runtime-trust-key.json') : null),
    signingSecret: options.trustSigningSecret,
    testMode
  });
  const policyRuntime = new PolicySecurityRuntime({ ...options, trustKernel });
  const observationInjectionDetector = options.observationInjectionDetector
    ?? options.injectionDetector
    ?? policyRuntime.promptInjectionDetector;
  const growthRuntime = new GrowthRuntime({
    ...options,
    memoryStore: options.memoryStore ?? null,
    policyRuntime
  });
  const verificationRuntime = new VerificationRuntime({
    ...options,
    injectionDetector: policyRuntime.promptInjectionDetector,
    toolOutputEvaluator: (payload) => policyRuntime.evaluateToolOutput(payload),
    capabilityPackageVerifier: options.capabilityPackageVerifier
      ?? ((toolName, evidence) => capabilityPackageRegistry.verify(toolName, evidence)),
    growthRuntime
  });
  growthRuntime.attachLearningVerifier(verificationRuntime.learningVerifier);
  const pcAgent = createPcAgentExecutionComponents({options,policyRuntime,trustKernel,allowedRoots});
  const taskPlanner = options.taskPlanner ?? createTaskPlannerFromEnv({
    env: taskRuntimeEnv,
    workspaceRoot: allowedRoots[0]
  });
  taskPlanner?.configureWorkspaceRoot?.(allowedRoots[0]);
  const coreFacade = new CoreFacade({
    personalContextProvider: options.personalContextProvider ?? createPersonalContextProvider({
      env: testMode ? { ...runtimeEnv, JARVIS_TEST_MODE: '1' } : runtimeEnv,
      store: options.personalProfileStore
    }),
    cognition: options.cognitionRuntime ?? new CognitiveRuntime({ storePath: options.cognitionStorePath ?? null, clock: options.clock }),
    policyEngine: policyRuntime,
    memoryStore: growthRuntime,
    verificationEngine: verificationRuntime,
    intentParser: options.intentParser ?? createIntentParserFromEnv({ env: taskRuntimeEnv }),
    taskPlanner,
    workspaceRoot: allowedRoots[0],
    workMemory: options.workMemory ?? new WorkMemory({
      journalPath: options.workJournalPath ?? (options.auditRoot ? join(options.auditRoot, 'work-journal.jsonl') : null),
      clock: options.clock
    }),
    clock: options.clock,
    cwd: options.cwd,
    desktopContextProvider: options.desktopContextProvider,
    desktopContextCollector: options.desktopContextCollector,
    inputProviderRegistry: options.inputProviderRegistry,
    durabilityBatching: options.coreDurabilityBatching,
    performanceSampleLimit: options.corePerformanceSampleLimit,
    executionHealthRegistry: options.executionHealthRegistry,
    executionHealthPath: options.executionHealthPath ?? null,
    executionEnvironmentProfile: executionEnvironment,
    eventLogPath: options.coreEventLogPath ?? (options.auditRoot ? `${options.auditRoot}/core-events.jsonl` : 'logs/core-events.jsonl'),
    orchestrationJournalPath: options.coreOrchestrationJournalPath ?? (options.auditRoot ? `${options.auditRoot}/core-orchestration.jsonl` : 'logs/core-orchestration.jsonl')
  });
  growthRuntime.setSourceScopeResolver((taskId, context = {}) => {
    if (context.recoveredScopeProof !== undefined) {
      const verified = consumeRecoveredMemoryScopeProof(context.recoveredScopeProof, { taskId, event: context.event, workspaceRoot: coreFacade.workspaceRoot });
      if (!verified.valid) throw Object.assign(new Error('Recovered memory scope could not be authenticated.'), {
        code: 'F_MEMORY_RECOVERY_SCOPE_INVALID', reason: verified.reason
      });
      return verified.scope;
    }
    const task = coreFacade.getTask(taskId);
    return task?.request ? { userId: task.request.userId, workspaceRoot: coreFacade.workspaceRoot, conversationId: task.request.metadata?.conversationId ?? null } : null;
  });
  growthRuntime.setSourceRetractionHandler(input => coreFacade.cognition?.revokeSource(input),
    coreFacade.cognition?.sourceRetractionStatus && options.memoryStore ? {
      receiverId: coreFacade.cognition.identity, verify: input => coreFacade.cognition.sourceRetractionStatus(input)
    } : {});
  const localWorkflowActivation = activatePcWorkflowCapability({pcAgent,capabilityPackageRegistry,
    skillRouter:coreFacade.skillRouter,allowedRoots,clock:options.clock,processRunner:options.localWorkflowProcessRunner,workflowCapabilityDefinition:options.workflowCapabilityDefinition});
  // Only host-reviewed source access activates this tool. Credentials, selected
  // accounts and the independent oracle are never supplied through model JSON.
  const selectedSourceActivation = options.selectedSourceAccess ? capabilityPackageRegistry.activate(
    createSelectedSourceCapabilityPackage({readTrustedTask:id=>coreFacade.getTask(id),readCurrentSnapshot:options.selectedSourceAccess.readCurrentSnapshot}),{
      skillRouter:coreFacade.skillRouter,adapterRegistry:pcAgent.registry,evidenceSchemaRegistry:pcAgent.evidenceCollector.schemaRegistry,
      registerArgumentSchema:registerMissionArgumentSchema,adapterContext:options.selectedSourceAccess
    }) : null;
  const lifecycleCaseActivation=options.lifecycleCaseAccess?capabilityPackageRegistry.activate(
    createLifecycleCaseCapabilityPackage({readTrustedTask:id=>coreFacade.getTask(id),readCurrentSnapshot:options.lifecycleCaseAccess.readCurrentSnapshot,authorizeVerification:options.lifecycleCaseAccess.authorizeVerification}),{
      skillRouter:coreFacade.skillRouter,adapterRegistry:pcAgent.registry,evidenceSchemaRegistry:pcAgent.evidenceCollector.schemaRegistry,
      registerArgumentSchema:registerMissionArgumentSchema,adapterContext:options.lifecycleCaseAccess
    }):null;
  const microsoftCollectionActivation=options.microsoftCollectionAccess?capabilityPackageRegistry.activate(
    createMicrosoftCollectionCapabilityPackage({readTrustedTask:id=>coreFacade.getTask(id),verifyCollectedPage:options.microsoftCollectionAccess.verifyCollectedPage,authorizeVerification:options.microsoftCollectionAccess.authorizeVerification}),{
      skillRouter:coreFacade.skillRouter,adapterRegistry:pcAgent.registry,evidenceSchemaRegistry:pcAgent.evidenceCollector.schemaRegistry,
      registerArgumentSchema:registerMissionArgumentSchema,adapterContext:options.microsoftCollectionAccess
    }):null;
  const personalOwnerSession = options.personalOwnerSessionManager ?? new PersonalOwnerSessionManager({
    clock: options.clock,
    eventBus: coreFacade.eventBus
  });
  let capabilityPackagePromotionJournal = options.capabilityPackagePromotionJournal ?? null;
  let capabilityPackagePromotionJournalUnavailableReason = null;
  if (!capabilityPackagePromotionJournal && options.auditRoot) {
    try {
      const signer = trustKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' });
      capabilityPackagePromotionJournal = new CapabilityPackagePromotionJournal({
        filePath: options.capabilityPackagePromotionJournalPath ?? join(options.auditRoot, 'capability-package-promotions.jsonl'),
        signer,
        trustKernel,
        clock: options.clock
      });
    } catch (error) {
      capabilityPackagePromotionJournalUnavailableReason = error?.code ?? 'A_CAPABILITY_PACKAGE_JOURNAL_INITIALIZATION_FAILED';
    }
  }
  const isolatedPackageEvaluator=options.capabilityPackageEvaluator??(options.capabilityPackageEvaluationCases?createContainerCapabilityPackageEvaluator({
    casesForPackage:options.capabilityPackageEvaluationCases,dockerPath:options.dockerPath,timeoutMs:options.capabilityPackageEvaluationTimeoutMs,
    maxEvaluations:options.capabilityPackageEvaluationMaxCalls,persistentBudget:options.capabilityPackageEvaluationBudget,
    observeEvaluationCost:options.capabilityPackageEvaluationCostObserver,requirementContract:options.capabilityPackageEvaluationRequirements,
    resultContract:options.capabilityPackageEvaluationResultContract
  }):undefined);
  const packageEvaluator=options.capabilityPackageComparisonRequired?createComparativeCapabilityEvaluator({evaluateInIsolation:isolatedPackageEvaluator,
    registry:capabilityPackageRegistry,repeats:options.capabilityPackageComparisonRepeats,minimumAdditionalPasses:options.capabilityPackageComparisonMinimumGain,
    acceptanceBounds:options.capabilityPackageComparisonBounds}):isolatedPackageEvaluator;
  const capabilityPackagePromotionManager = new CapabilityPackagePromotionManager({
    protectImprovementContract: true,
    registry: capabilityPackageRegistry,
    targets: {
      skillRouter: coreFacade.skillRouter,
      adapterRegistry: pcAgent.registry,
      evidenceSchemaRegistry: pcAgent.evidenceCollector.schemaRegistry,
      registerArgumentSchema: registerMissionArgumentSchema
    },
    authorizeArtifact: options.capabilityPackageArtifactAuthorizer,
    evaluateInIsolation: packageEvaluator,
    restoreEvaluation:packageEvaluator?.restoreCompleted,
    authorizeReview: options.capabilityPackageReviewAuthorizer ?? (async ({ action, packageDigest, artifactSha256, reviewContext = {} }) => {
      const decision = personalOwnerSession.authorizeCapabilityPackageReview({
        action,
        sessionId: reviewContext.ownerSessionId,
        packageDigest,
        artifactSha256,
        deviceId: reviewContext.deviceId,
        remoteAddress: reviewContext.remoteAddress
      });
      return {
        approved: decision.allowed,
        reviewerId: decision.reviewerId,
        packageDigest: decision.packageDigest,
        artifactSha256: decision.artifactSha256
      };
    }),
    assertReviewCurrent: options.capabilityPackageReviewCurrentAssertion ?? (({ action, packageDigest, artifactSha256, reviewContext = {} }) => personalOwnerSession.authorizeCapabilityPackageReview({
      action,
      sessionId: reviewContext.ownerSessionId,
      packageDigest,
      artifactSha256,
      deviceId: reviewContext.deviceId,
      remoteAddress: reviewContext.remoteAddress
    })),
    journal: capabilityPackagePromotionJournal,
    journalUnavailableReason: capabilityPackagePromotionJournalUnavailableReason,
    journalRequired: options.capabilityPackagePromotionJournalRequired ?? (!testMode && Boolean(options.auditRoot)),
    clock: options.clock,
    adapterContext: {
      allowedRoots,
      undoJournal: pcAgent.undoJournal,
      clock: options.clock,
      processRunner: options.localWorkflowProcessRunner
    }
  });
  const capabilityLimitedRollout=options.capabilityRolloutStore?new CapabilityLimitedRollout({store:options.capabilityRolloutStore,
    promotionManager:capabilityPackagePromotionManager,adapterRegistry:pcAgent.registry,clock:options.clock}):null;
  const bridgeRuntime = new BridgeRuntime({
    deviceTokenSecret: options.bridgeDeviceTokenSecret,
    deviceTokenKeyChangePolicy: options.bridgeDeviceTokenKeyChangePolicy,
    coreFacade,
    policyRuntime,
    pcAgent,
    growthRuntime,
    verificationRuntime,
    clock: options.clock,
    auditRoot: options.bridgeAuditRoot ?? options.auditRoot,
    eventCursorJournalPath: options.eventCursorJournalPath,
    rateLimiter: options.rateLimiter
  });
  if (options.outputPath) {
    bridgeRuntime.outputPath = options.outputPath;
  }
  const emailConnection = options.emailConnectionController ?? (options.pcAgentExecutor ? null : new EmailConnectionController({
    pcAgent,capabilityPackageRegistry,skillRouter:coreFacade.skillRouter,clock:options.clock,timeoutMs:options.emailConnectionTimeoutMs??4000}));
  const remoteEmailReadiness=options.pcAgentExecutor instanceof PcAgentExecutionClient&&options.pcAgentExecutor.supportsDurableMissionEffects()
    ?new RemoteEmailReadiness({client:options.pcAgentExecutor,pcAgent,registry:capabilityPackageRegistry,skillRouter:coreFacade.skillRouter}):null;
  const defaultCapabilityBindingResolver = options.capabilityBindingResolver ?? (emailConnection||remoteEmailReadiness ? async input=>{
    if(input.toolName==='email.send') {
      if(remoteEmailReadiness)return remoteEmailReadiness.resolve();
      const resolved=emailConnection.resolve(input);
      if(input.phase==='dispatch'&&resolved.binding)await emailConnection.probe();
      return emailConnection.resolve(input);
    }
    const contract=pcAgent.registry.contractFor(input.toolName);
    return contract?.availabilityBinding?{required:true,binding:contract.availabilityBinding}:null;
  } : null);
  const capabilityBindingResolver = options.selectedSourceAccess?.resolveBinding||options.lifecycleCaseAccess?.resolveBinding||options.microsoftCollectionAccess?.resolveBinding ? input =>
    input.toolName === 'source.readSelectedInbox'&&options.selectedSourceAccess?.resolveBinding ? options.selectedSourceAccess.resolveBinding(input)
      :input.toolName==='case.readLocalRecord'&&options.lifecycleCaseAccess?.resolveBinding?options.lifecycleCaseAccess.resolveBinding(input)
      :input.toolName==='source.collectMicrosoftMetadata'&&options.microsoftCollectionAccess?.resolveBinding?options.microsoftCollectionAccess.resolveBinding(input)
      : defaultCapabilityBindingResolver?.(input) : defaultCapabilityBindingResolver;
  const capabilityAvailabilityProbe = options.capabilityAvailabilityProbe ?? null;
  const orchestrationWorker = new CoreOrchestrationWorker({
    coreFacade,
    policyRuntime,
    pcAgent: options.pcAgentExecutor ?? pcAgent,
    selectedSourceExecutor: selectedSourceActivation||lifecycleCaseActivation||microsoftCollectionActivation ? pcAgent : null,
    verificationRuntime,
    growthRuntime,
    trustKernel,
    executionAuthority: options.missionExecutionAuthority ?? null,
    capabilityPackageRegistry,
    capabilityBindingResolver,
    capabilityAvailabilityProbe,
    capabilityContractRegistry: pcAgent.registry,
    allowedPaths: allowedRoots,
    maxAttempts: options.workerMaxAttempts,
    baseBackoffMs: options.workerBaseBackoffMs,
    defaultTimeoutMs: tuned('workerDefaultTimeoutMs', options.workerDefaultTimeoutMs),
    maxPlanParallelism: tuned('workerMaxPlanParallelism', options.workerMaxPlanParallelism),
    maxQueueConcurrency: tuned('workerMaxQueueConcurrency', options.workerMaxQueueConcurrency),
    leaseStorePath: options.workerLeaseStorePath,
    queueStorePath: options.workerQueueStorePath,
    clock: options.clock
  });
  const missionPlanner = options.missionPlanner ?? createMissionPlannerFromEnv({
    env: runtimeEnv,
    credentialResolver: options.modelCredentialResolver ? provider => options.modelCredentialResolver.resolve(provider) : null,
    runner: options.missionRunner ?? null,
    clock: options.clock,
    observationInjectionDetector,
    dataClassifier: policyRuntime.dataClassifier,
    skillGuidanceProvider: ({ objective, scope }) => normalizeMemoryScope(scope)
      ? growthRuntime.missionSkillGuidance(objective, { scope }) : [],
    archivalReferenceProvider: ({ objective, scope }) => normalizeMemoryScope(scope)
      ? growthRuntime.selectedConversationImports?.query(objective, { scope }) ?? [] : []
  });
  const missionStorePath = options.missionStorePath
    ?? (options.auditRoot ? `${options.auditRoot}/missions.json` : null);
  const missionStore = options.missionStore
    ?? (missionStorePath
      ? new FileMissionStore({ filePath: missionStorePath, clock: options.clock })
      : new MemoryMissionStore({ clock: options.clock }));
  const missionRuntime = new MissionRuntime({
    coreFacade,
    orchestrationWorker,
    pcAgent,
    planner: missionPlanner,
    store: missionStore,
    executionAuthority: options.missionExecutionAuthority ?? null,
    remoteArtifactRecovery: options.missionRemoteArtifactRecovery ?? null,
    allowedRoots,
    eventLogPath: options.missionEventLogPath
      ?? (options.auditRoot ? `${options.auditRoot}/mission-events.jsonl` : null),
    ownerSessionManager: personalOwnerSession,
    clock: options.clock,
    maxActionsPerWave: options.missionMaxActionsPerWave,
    maxPlannerTools: tuned('missionMaxPlannerTools', options.missionMaxPlannerTools),
    capabilityPackageRegistry,
    capabilityBindingResolver,
    capabilityAvailabilityProbe,
    observationInjectionDetector,
    managedAgentSessionBroker: options.managedAgentSessionBroker ?? null,
    microsoftCollectionAccess: options.microsoftCollectionAccess ?? null,
    selectedSourceAccess: options.selectedSourceAccess ?? null,
    lifecycleCaseAccess: options.lifecycleCaseAccess ?? null,
    dataClassifier: policyRuntime.dataClassifier
  });
  const managedAgentEgressPolicy = options.managedAgentEgressPolicy
    ?? (options.managedAgentEgressKeyStore
      ? createMissionEgressAuthorizationPolicy({ missionRuntime, keyStore: options.managedAgentEgressKeyStore })
      : null);
  if (managedAgentEgressPolicy && (typeof managedAgentEgressPolicy.authorize !== 'function'
    || typeof managedAgentEgressPolicy.verify !== 'function')) throw new Error('managedAgentEgressPolicy must expose authorize and verify.');
  if(!options.missionPlanner)missionPlanner.planReviewedMcp=context=>planReviewedMcpMission({
    mission:missionRuntime.missions.get(context.mission.missionId),packageRegistry:capabilityPackageRegistry,adapterRegistry:pcAgent.registry});
  const brokerSources = [options.managedAgentSessionBroker, options.managedAgentSessionBrokerFactory,
    options.managedAgentRoleSessionPoolFactory].filter(value => value !== undefined && value !== null);
  if (brokerSources.length > 1) throw new Error('Configure only one managed agent broker or broker factory.');
  options.managedAgentSessionBroker?.setLocalSnapshotRecoveryIfAbsent?.(
    createLocalMissionSnapshotRecovery({ store: missionStore, allowedRoots }));
  if (options.managedAgentSessionBrokerFactory !== undefined || options.managedAgentRoleSessionPoolFactory !== undefined) {
    const roleScoped = options.managedAgentRoleSessionPoolFactory !== undefined;
    const factory = roleScoped ? options.managedAgentRoleSessionPoolFactory : options.managedAgentSessionBrokerFactory;
    const factoryName = roleScoped ? 'managedAgentRoleSessionPoolFactory' : 'managedAgentSessionBrokerFactory';
    if (typeof factory !== 'function') throw new Error(`${factoryName} must be a synchronous function.`);
    const restoreLocalMissionSnapshot = createLocalMissionSnapshotRecovery({ store: missionStore, allowedRoots });
    const broker = factory({ missionRuntime, coreFacade, orchestrationWorker, pcAgent, managedAgentEgressPolicy,
      restoreLocalMissionSnapshot });
    if (broker && typeof broker.then === 'function') throw new Error(`${factoryName} must initialize synchronously.`);
    broker?.setLocalSnapshotRecoveryIfAbsent?.(restoreLocalMissionSnapshot);
    if (roleScoped && broker?.supportsRoleScopedSessions !== true) {
      throw new Error('managedAgentRoleSessionPoolFactory must return a role-scoped session pool.');
    }
    const attached = missionRuntime.setManagedAgentSessionBroker(broker);
    if (attached?.enabled !== true) throw new Error(`${factoryName} returned an invalid broker.`);
  }
  // 모바일 승인 → 실행 핸드오프가 스텁 패킷 대신 실제 계획(A-E-B-G-F)을 실행하도록 워커를 노출한다.
  // realExecutionEnabled가 true일 때만 워커 경로를 쓴다(기본 false: 기존 스텁 계약 유지).
  bridgeRuntime.orchestrationWorker = orchestrationWorker;
  bridgeRuntime.missionRuntime = missionRuntime;
  bridgeRuntime.realExecutionEnabled = options.bridgeRealExecution === true;
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
  trustKernel
    .registerRecoveryProbe('policy-audit-chain', () => policyRuntime.auditLog.verifyChain())
    .registerRecoveryProbe('pc-undo-journal-chain', () => pcAgent.undoJournal.verifyChain())
    .registerRecoveryProbe('pc-rollback-transaction-chain', () => pcAgent.rollbackTransactionStatus().chain)
    .registerRecoveryProbe('capability-secrets-not-plaintext', () => ({
      valid: policyRuntime.capabilities.signingKeyProviderStatus().journalEncryption.plaintextTokenStored === false
        && pcAgent.capabilityVault.status().plaintextTokenStored === false
    }))
    .registerRecoveryProbe('policy-bundle-signature', () => ({ valid: policyRuntime.policyBundleVerification?.valid === true }));
  for (const [index, peer] of (options.trustPeerAuditPaths ?? []).entries()) {
    const peerAuditPath = typeof peer === 'string' ? peer : peer?.auditPath;
    const peerActorId = typeof peer === 'string' ? `peer-runtime-${index + 1}` : (peer?.actorId ?? `peer-runtime-${index + 1}`);
    if (!peerAuditPath) continue;
    trustKernel.registerRecoveryProbe(`peer-trust-audit-${peerActorId}`, () => trustKernel.verifyPeerAuditJournal({
      auditPath: peerAuditPath,
      actorId: peerActorId
    }));
  }
  trustKernel
    .registerLockdownHandler((incident) => personalOwnerSession.revoke({
      reason: `runtime-trust-lockdown:${incident?.reasonCode ?? 'unknown'}`,
      revokedBy: 'runtime-trust-kernel'
    }))
    .registerLockdownHandler((incident) => policyRuntime.capabilities.revokeAll({
      reason: `runtime-trust-lockdown:${incident?.reasonCode ?? 'unknown'}`
    }))
    .registerLockdownHandler((incident) => workerDaemon.stop({
      reason: `runtime-trust-lockdown:${incident?.reasonCode ?? 'unknown'}`
    }))
    .registerRecoveryHandler(() => workerDaemon.start({ reason: 'runtime-trust-recovered' }));
  const a2aServiceRegistry=options.a2aServiceRegistry??new A2aServiceRegistry({storePath:options.auditRoot?join(options.auditRoot,'a2a-services.sqlite'):null,clock:options.clock});
  const mcpConnections=options.mcpConnections??(options.mcpReviewedPackageCatalog?new McpConnectionManager({storePath:options.mcpStorePath??(options.auditRoot?join(options.auditRoot,'mcp.sqlite'):undefined)}):null);
  const mcpPackageInstaller=mcpConnections?new McpPackageInstaller({manager:mcpConnections,catalog:options.mcpReviewedPackageCatalog??new Map(),registry:capabilityPackageRegistry,
    targets:{skillRouter:coreFacade.skillRouter,adapterRegistry:pcAgent.registry,evidenceSchemaRegistry:pcAgent.evidenceCollector.schemaRegistry,registerArgumentSchema:registerMissionArgumentSchema}}):null;
  mcpPackageInstaller?.restore();
  const failureImprovementPipeline=options.failureImprovementConfig?new FailureImprovementPipeline({...options.failureImprovementConfig,promotionManager:capabilityPackagePromotionManager}):null;
  const processFailureImprovements=async()=>{
    if(!failureImprovementPipeline)return {configured:false,items:[]};
    const reconciliations=[],restorations=[];
    for(const item of failureImprovementPipeline.list().filter(item=>item.state==='evaluating')){
      try{capabilityPackagePromotionManager.getStage(item.stageId);}catch(error){
        if(error.code!=='A_CAPABILITY_PACKAGE_STAGE_NOT_FOUND')throw error;
        // Only host-loaded, separately re-admitted definitions. Never call the
        // candidate generator or import journal/SQL source text during recovery.
        if(capabilityPackageRecoveryDefinitions.has(item.stageId))restorations.push(capabilityPackagePromotionManager.restoreStage(item.stageId,capabilityPackageRecoveryDefinitions.get(item.stageId)));
      }
      reconciliations.push(failureImprovementPipeline.reconcile(item.id));
    }
    const queued=failureImprovementPipeline.enqueue([...orchestrationWorker.failureObservations.values()]);
    const items=[];for(const item of queued)if(item.state==='queued')items.push(await failureImprovementPipeline.process(item.id));
    return {configured:true,items,reconciliations,restorations};
  };
  return {
    coreFacade,
    policyRuntime,
    pcAgent,
    bridgeRuntime,
    growthRuntime,
    verificationRuntime,
    orchestrationWorker,
    missionPlanner,
    modelProviderStatus: { configuration: describeModelProviders(runtimeEnv, {
      credentialStatus: options.modelCredentialResolver ? provider => options.modelCredentialResolver.isConfigured(provider) : null,
      credentialResolverConfigured: Boolean(options.modelCredentialResolver)
    }),
      activePlanner: { provider: missionPlanner?.provider ?? 'local-fallback', model: missionPlanner?.model ?? null,
        externalService: missionPlanner?.externalService ?? 'none' }, connectionProbePerformed: false },
    missionRuntime,
    managedAgentEgressPolicy,
    personalOwnerSession,
    trustKernel,
    workerDaemon,
    executionEnvironment,
    capabilityPackageRegistry,
    capabilityPackagePromotionManager,
    capabilityLimitedRollout,
    capabilityPackagePromotionJournal,
    failureImprovementPipeline,processFailureImprovements,
    localWorkflowActivation,
    selectedSourceActivation,
    lifecycleCaseActivation,
    microsoftCollectionActivation,
    emailConnection,
    remoteEmailReadiness,
    mcpConnections,mcpPackageInstaller,a2aServiceRegistry
  };
}
