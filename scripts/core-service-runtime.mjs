import {MicrosoftCollectionTaskReceipts} from '../packages/core/src/mission/microsoft-collection-task-receipts.js';
import { mkdir } from 'node:fs/promises';
import {assertLedgerPathSyntax,assertLocalLedgerStorage} from '../packages/core/src/runtime/local-ledger-storage.js';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalOperationsMissionLink } from '../packages/core/src/personal-operations/mission-link.js';
import { PersonalOperationsReminderScheduler } from '../packages/core/src/personal-operations/reminder-scheduler.js';
import { PersonalSourceInbox } from '../packages/core/src/personal-operations/source-inbox.js';
import { PersonalImportWorker } from '../packages/core/src/personal-operations/import-worker.js';
import { createManagedGoogleSync } from '../packages/core/src/personal-operations/google-sync-service.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { GoogleConnectionController } from '../packages/core/src/personal-operations/google-connection-controller.js';
import { createGoogleVaultReadClient, registerGoogleWorkspaceConnector } from '../packages/core/src/personal-operations/google-vault-client.js';
import { createConfiguredGoogleBroker } from '../packages/core/src/personal-operations/configured-google-broker.js';
import {createConfiguredDuffelBroker} from '../packages/core/src/personal-operations/configured-duffel-broker.js';
import { IntegrationCredentialHandoffs } from '../packages/core/src/personal-operations/integration-credential-handoffs.js';
import { MissionBudgetGate } from '../packages/core/src/personal-operations/mission-budget-gate.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { MissionExecutionAuthority } from '../packages/core/src/mission/mission-execution-authority.js';
import { SqliteDurableRoutineStore } from '../packages/core/src/runtime/durable-routine-store.js';
import { DurableRoutineScheduler } from '../packages/core/src/runtime/durable-routine-scheduler.js';
import { SqliteSourceRevisionInbox } from '../packages/core/src/runtime/source-revision-inbox.js';
import { SourceRevisionFileWatcher } from '../packages/core/src/runtime/source-revision-file-watcher.js';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { createBridgeServer } from '../apps/bridge/src/main.mjs';
import {DeviceRegistry,DeviceTokenService} from '../apps/bridge/src/bridge-runtime.js';
import { mountCoreMobileUpgrades } from '../apps/bridge/src/core-gateway.js';
import { createMicrosoftSourceReader } from '../packages/core/src/personal-operations/microsoft-source-reader.js';
import {createMicrosoftCollectionAccess} from '../apps/runtime-compose/src/microsoft-collection-access.js';
import {MicrosoftCollectionEffects} from '../packages/core/src/personal-operations/microsoft-collection-effects.js';
import {normalizeMicrosoftCollection,collectionDigest} from '../apps/runtime-compose/src/microsoft-collection-capability-package.js';
import { CoreAdminScope,createCoreAdminAuthProvider } from '../packages/core/src/security/core-admin-auth.js';
import {createSelectedSourceServiceAccess} from '../apps/runtime-compose/src/selected-source-service-access.js';
import {createLifecycleCaseServiceAccess} from '../apps/runtime-compose/src/lifecycle-case-service-access.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { createConfiguredPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import {readPcOutboundExecutionConfiguration,createConfiguredPcOutboundExecutor} from '../packages/core/src/client/configured-pc-outbound-executor.js';
import { MissionEgressDecisionKeyStore, missionEgressDecisionKeyPath } from '../packages/core/src/security/mission-egress-decision-key-store.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { IntegrationConnectorRegistry, IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';
import { createVaultModelCredentialAccess, createVaultOpenAiAgentsCredentialAccess, registerModelProviderConnectors } from '../packages/core/src/mission/model-provider-vault.js';
import { createModelProviderCredentialVerifier } from '../packages/core/src/mission/model-provider-credential-verifier.js';

function envBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function envList(value, fallback = []) {
  if (!value) return fallback;
  return String(value).split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

export function coreTaskRuntimeEnvFromEnv(env = process.env) {
  const synchronousTaskLlmEnabled = envBoolean(env.JARVIS_CORE_SYNC_TASK_LLM_ENABLED, false);
  if (synchronousTaskLlmEnabled) return { ...env };
  return {
    ...env,
    JARVIS_LLM_INTENT: '0',
    JARVIS_LLM_PLANNER: '0',
    JARVIS_LLM_CONTENT: '0'
  };
}

export function coreServiceRuntimeOptionsFromEnv({ env = process.env, cwd = process.cwd() } = {}) {
  for(const key of ['JARVIS_CORE_ROOT','JARVIS_CORE_AUDIT_ROOT','JARVIS_AUDIT_ROOT','JARVIS_TEST_AUDIT_ROOT','JARVIS_PERSONAL_OPERATIONS_DB','JARVIS_CORE_GROWTH_DB','JARVIS_CORE_COGNITION_DB','JARVIS_CORE_MISSION_STORE','JARVIS_CORE_WORKER_LEASE_STORE','JARVIS_CORE_WORKER_QUEUE_STORE']){
    if(env[key]!==undefined)assertLedgerPathSyntax(env[key]);
  }
  if (!['0', '1', undefined].includes(env.JARVIS_CORE_MOBILE_GATEWAY_ENABLED)) throw new Error('A_MOBILE_GATEWAY_CONFIG_INVALID');
  if (env.JARVIS_CORE_MOBILE_GATEWAY_ENABLED === '1'
    && (!env.JARVIS_DEVICE_TOKEN_SECRET || env.JARVIS_DEVICE_TOKEN_SECRET.length < 32)) throw new Error('A_MOBILE_DEVICE_SECRET_REQUIRED');
  const root = resolve(env.JARVIS_CORE_ROOT ?? cwd);
  const host = env.JARVIS_CORE_HOST ?? '127.0.0.1';
  const port = envNumber(env.PORT ?? env.JARVIS_CORE_PORT, 4071);
  const adminTokenHash = envSha256(env.JARVIS_CORE_ADMIN_TOKEN_SHA256);
  const integrationHandoffTokenHash = envSha256(env.JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256);
  const testMode = env.JARVIS_TEST_MODE === '1';
  const isolatedTestAuditRoot = resolve(
    env.JARVIS_TEST_AUDIT_ROOT ?? join(tmpdir(), 'jarvis-test-runtime'),
    `core-${port}`
  );
  const auditRoot = resolve(root, env.JARVIS_CORE_AUDIT_ROOT ?? env.JARVIS_AUDIT_ROOT ?? (testMode ? isolatedTestAuditRoot : 'logs'));
  const allowedRoots = envList(env.JARVIS_CORE_ALLOWED_ROOTS ?? env.JARVIS_ALLOWED_ROOTS, [resolve(root, 'workspace')])
    .map((item) => resolve(root, item));
  const coreEventLogPath = resolve(root, env.JARVIS_CORE_EVENT_LOG ?? `${auditRoot}/core-events.jsonl`);
  const coreOrchestrationJournalPath = resolve(root, env.JARVIS_CORE_ORCHESTRATION_JOURNAL ?? `${auditRoot}/core-orchestration.jsonl`);
  const workerLeaseStorePath = resolve(root, env.JARVIS_CORE_WORKER_LEASE_STORE ?? `${auditRoot}/core-worker-leases.json`);
  const workerQueueStorePath = resolve(root, env.JARVIS_CORE_WORKER_QUEUE_STORE ?? `${auditRoot}/core-worker-queue.json`);
  const missionStorePath = resolve(root, env.JARVIS_CORE_MISSION_STORE ?? `${auditRoot}/missions.json`);
  const missionStoreBackend = env.JARVIS_CORE_MISSION_STORE_BACKEND ?? 'file';
  if (!['file', 'sqlite'].includes(missionStoreBackend)) {
    throw Object.assign(new Error('Unsupported Mission store backend.'), { code: 'A_MISSION_STORE_BACKEND_INVALID' });
  }
  const missionAuthorityEnabled = envBoolean(env.JARVIS_CORE_MISSION_AUTHORITY_ENABLED, false);
  const recoveryFlag=env.JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY;
  if(!['0','1',undefined].includes(recoveryFlag))throw new Error('A_CORE_AUTHORITY_RECOVERY_INVALID');
  const missionAuthorityRecoveryOnly=recoveryFlag==='1';
  if(missionAuthorityRecoveryOnly&&(!missionAuthorityEnabled||envBoolean(env.JARVIS_CORE_WORKER_DAEMON_ENABLED,true)))throw new Error('A_CORE_AUTHORITY_RECOVERY_CONFIGURATION_REQUIRED');
  const expectedAuthorityToken = String(env.JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN ?? '').trim();
  const missionAuthorityExpectedToken = /^\d+$/.test(expectedAuthorityToken) ? Number(expectedAuthorityToken) : null;
  const missionAuthorityTtlMs = Number(env.JARVIS_CORE_MISSION_AUTHORITY_TTL_MS ?? 30_000);
  const missionAuthorityServiceId=env.JARVIS_CORE_MISSION_AUTHORITY_SERVICE_ID??null;
  if(missionAuthorityServiceId!==null&&(!missionAuthorityEnabled||env.JARVIS_WINDOWS_SERVICE!=='1'||env.JARVIS_CORE_SERVICE_STDIN_SHUTDOWN!=='1'
    ||typeof missionAuthorityServiceId!=='string'||!/^service:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(missionAuthorityServiceId)))throw Error('A_CORE_SERVICE_AUTHORITY_CONFIGURATION_REQUIRED');
  if (missionAuthorityEnabled) {
    if (missionStoreBackend !== 'sqlite') throw new Error('A_CORE_AUTHORITY_SQLITE_REQUIRED');
    if (!Number.isSafeInteger(missionAuthorityExpectedToken) || missionAuthorityExpectedToken < 0) throw new Error('A_CORE_AUTHORITY_EXPECTED_TOKEN_REQUIRED');
    if (!Number.isSafeInteger(missionAuthorityTtlMs) || missionAuthorityTtlMs < 1_000 || missionAuthorityTtlMs > 3_600_000) throw new Error('A_CORE_AUTHORITY_TTL_INVALID');
  }
  const missionEventLogPath = resolve(root, env.JARVIS_CORE_MISSION_EVENT_LOG ?? `${auditRoot}/mission-events.jsonl`);
  const executionHealthPath = resolve(root, env.JARVIS_CORE_EXECUTION_HEALTH ?? `${auditRoot}/execution-health.json`);
  const growthMemoryRoot = join(auditRoot, 'growth-memory');
  const personalOperationsDbPath=resolve(env.JARVIS_PERSONAL_OPERATIONS_DB??(testMode?join(auditRoot,'personal-operations.sqlite'):join(homedir(),'.jarvis','personal-operations.sqlite')));
  const trustRoot = resolve(root, env.JARVIS_TRUST_ROOT ?? `${auditRoot}/trust`);
  const pcAgentApiUrl = String(env.JARVIS_PC_AGENT_API_URL ?? '').trim() || null;
  const pcAgentExecutionToken = String(env.JARVIS_PC_AGENT_EXECUTION_TOKEN ?? '').trim() || null;
  const pcOutboundExecutionBinding=readPcOutboundExecutionConfiguration(env);
  if(pcOutboundExecutionBinding){
    if(!missionAuthorityEnabled||missionStoreBackend!=='sqlite')throw new Error('A_PC_OUTBOUND_EXECUTOR_AUTHORITY_REQUIRED');
    if(env.JARVIS_CORE_PC_OUTBOUND_ENABLED!=='1'||env.JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED!=='1')throw new Error('A_PC_OUTBOUND_EXECUTOR_COMMAND_SERVICE_REQUIRED');
    if(envBoolean(env.JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED,Boolean(pcAgentApiUrl&&pcAgentExecutionToken)))throw new Error('A_PC_OUTBOUND_EXECUTOR_CONFLICTING_TRANSPORT');
  }
  return {
    serviceRuntimeVersion: 'a-core-service-runtime-entry-v1',
    root,
    host,
    port,
    endpoint: `http://${host}:${port}`,
    adminToken: env.JARVIS_CORE_ADMIN_TOKEN
      ?? (adminTokenHash ? null : testMode ? 'local-core-admin' : null),
    adminTokenHash,
    integrationHandoffTokenHash,
    allowedRoots,
    auditRoot,
    coreEventLogPath,
    coreOrchestrationJournalPath,
    workerLeaseStorePath,
    workerQueueStorePath,
    missionStorePath,
    personalOperationsDbPath,
    missionStoreBackend,
    missionAuthorityEnabled,
    missionAuthorityRecoveryOnly,
    missionAuthorityExpectedToken,
    missionAuthorityServiceId,
    missionAuthorityTtlMs,
    missionEventLogPath,
    executionHealthPath,
    growthMemoryDbPath: resolve(root, env.JARVIS_CORE_GROWTH_DB ?? join(growthMemoryRoot, 'growth.sqlite')),
    growthMemoryReviewDir: resolve(root, env.JARVIS_CORE_GROWTH_REVIEW_DIR ?? join(growthMemoryRoot, 'reviews')),
    growthMemoryBackupDir: resolve(root, env.JARVIS_CORE_GROWTH_BACKUP_DIR ?? join(growthMemoryRoot, 'backups')),
    cognitionStorePath: resolve(root, env.JARVIS_CORE_COGNITION_DB ?? join(auditRoot, 'cognition.sqlite')),
    trustRoot,
    trustStatePath: resolve(trustRoot, 'runtime-trust-state.json'),
    trustAuditPath: resolve(trustRoot, 'runtime-trust-audit-core-runtime.jsonl'),
    trustPeerAuditPaths: [{
      actorId: 'pc-agent-runtime',
      auditPath: resolve(trustRoot, 'runtime-trust-audit-pc-agent-runtime.jsonl')
    }],
    trustKeyPath: resolve(trustRoot, 'runtime-trust-key.json'),
    trustActorId: 'core-runtime',
    managedAgentEgressKeyPath: resolve(root, env.JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH ?? missionEgressDecisionKeyPath(env)),
    pcAgentRemoteExecutionEnabled: envBoolean(
      env.JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED,
      Boolean(pcAgentApiUrl && pcAgentExecutionToken)
    ),
    pcAgentApiUrl,
    pcAgentExecutionToken,
    pcOutboundExecutionBinding,
    pcAgentExecutionTimeoutMs: envNumber(env.JARVIS_PC_AGENT_EXECUTION_TIMEOUT_MS, 90_000),
    workerDaemonEnabled: envBoolean(env.JARVIS_CORE_WORKER_DAEMON_ENABLED, true),
    workerDaemonAutostart: envBoolean(env.JARVIS_CORE_WORKER_DAEMON_AUTOSTART, true),
    workerDaemonIntervalMs: envNumber(env.JARVIS_CORE_WORKER_DAEMON_INTERVAL_MS, 1_000),
    workerDaemonDrainLimit: envNumber(env.JARVIS_CORE_WORKER_DAEMON_DRAIN_LIMIT, 5),
    workerDaemonMaxConsecutiveFailures: envNumber(env.JARVIS_CORE_WORKER_DAEMON_MAX_FAILURES, 3)
  };
}

function envSha256(value) {
  const normalized = String(value ?? '').replace(/^sha256:/, '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export async function createConfiguredCoreServiceRuntime({ env = process.env, clock, managedAgentEgressKeyStore = null,
  managedAgentSessionBrokerFactory = null, integrationVault = null, integrationRegistry = null,
  mcpReviewedPackageCatalog = null,
  modelProviderFetch = globalThis.fetch, pcOutboundServiceFactory = createConfiguredPcOutboundNodeService } = {}) {
  if (typeof pcOutboundServiceFactory !== 'function') throw new TypeError('pcOutboundServiceFactory must be a function.');
  if (managedAgentSessionBrokerFactory !== null && typeof managedAgentSessionBrokerFactory !== 'function') {
    throw new TypeError('managedAgentSessionBrokerFactory must be a function when configured.');
  }
  const options = coreServiceRuntimeOptionsFromEnv({ env });
  const bridgeAuditRoot = env.JARVIS_CORE_MOBILE_GATEWAY_ENABLED === '1'
    ? (env.JARVIS_BRIDGE_STATE_DIR ?? (env.JARVIS_TEST_MODE === '1' ? join(options.auditRoot, 'bridge-state') : resolve(options.root ?? process.cwd(), 'logs/bridge-state')))
    : undefined;
  if (bridgeAuditRoot) {
    // Fail before opening any SQLite stores. Migration must not revoke pairings
    // merely because the new process was configured with the wrong key.
    if (!env.JARVIS_DEVICE_TOKEN_SECRET || env.JARVIS_DEVICE_TOKEN_SECRET.length < 32) throw new Error('A_MOBILE_DEVICE_SECRET_REQUIRED');
    new DeviceRegistry({clock,tokenService:new DeviceTokenService({clock,secret:env.JARVIS_DEVICE_TOKEN_SECRET}),
      journalPath:join(bridgeAuditRoot,'bridge-devices.jsonl'),keyChangePolicy:'reject'});
  }
  // Observe local physical volumes before credential stores or service files open.
  const ledgerStorageObservation=assertLocalLedgerStorage([options.personalOperationsDbPath,options.growthMemoryDbPath,options.cognitionStorePath,options.missionStorePath,options.workerLeaseStorePath,options.workerQueueStorePath]);
  const googleBackend = env.JARVIS_CORE_GOOGLE_BACKEND ?? 'vault';
  if (!['vault', 'broker'].includes(googleBackend)) throw new Error('A_GOOGLE_BACKEND_INVALID');
  // Test runtimes must never inspect or mutate a developer's real DPAPI vault.
  integrationVault ??= new IntegrationCredentialVault({
    platform: env.JARVIS_TEST_MODE === '1' ? 'isolated-test' : process.platform
  });
  integrationRegistry ??= registerModelProviderConnectors(new IntegrationConnectorRegistry());
  registerGoogleWorkspaceConnector(integrationRegistry);
  if (googleBackend === 'broker' && integrationVault.list().some(row => row.connectorId === 'jarvis-google-workspace')) {
    throw new Error('A_GOOGLE_BROKER_LOCAL_CREDENTIALS_PRESENT');
  }
  const integrationHandoffs = new IntegrationCredentialHandoffs({ registry: integrationRegistry, vault: integrationVault, clock,
    blockedConnectorIds: googleBackend === 'broker' ? ['jarvis-google-workspace'] : [] });
  const modelCredentialAccess = createVaultModelCredentialAccess({ registry: integrationRegistry, vault: integrationVault });
  const managedAgentCredentialAccess = createVaultOpenAiAgentsCredentialAccess({ registry: integrationRegistry, vault: integrationVault });
  const modelProviderVerifier = typeof integrationVault?.recordProviderVerification === 'function'
    ? createModelProviderCredentialVerifier({ vault: integrationVault, fetchImpl: modelProviderFetch, clock })
    : null;
  const taskEnv = coreTaskRuntimeEnvFromEnv(env);
  if (options.pcAgentRemoteExecutionEnabled && (!options.pcAgentApiUrl || !options.pcAgentExecutionToken)) {
    const error = new Error('Remote PC execution requires an API URL and execution token.');
    error.code = 'A_REMOTE_PC_EXECUTION_CONFIG_INCOMPLETE';
    throw error;
  }
  await mkdir(options.auditRoot, { recursive: true });
  await mkdir(dirname(options.coreEventLogPath), { recursive: true });
  await mkdir(dirname(options.coreOrchestrationJournalPath), { recursive: true });
  await mkdir(dirname(options.workerLeaseStorePath), { recursive: true });
  await mkdir(dirname(options.workerQueueStorePath), { recursive: true });
  await mkdir(dirname(options.missionStorePath), { recursive: true });
  await mkdir(dirname(options.missionEventLogPath), { recursive: true });
  await mkdir(dirname(options.executionHealthPath), { recursive: true });
  await mkdir(options.trustRoot, { recursive: true });
  for (const root of options.allowedRoots) {
    await mkdir(root, { recursive: true });
  }
  const memoryStore = new SqliteMemoryStore({
    dbPath: options.growthMemoryDbPath,
    reviewDir: options.growthMemoryReviewDir,
    backupDir: options.growthMemoryBackupDir,
    clock
  });
  let personalStore;
  let runtime;
  let missionExecutionAuthority;
  let pcOutboundService;
  let sourceServiceAccess;
  let microsoftCollectionAccess;
  let caseServiceAccess;
  let sourceServer;
  try {
    personalStore = new PersonalOperationsStore({ dbPath: options.personalOperationsDbPath, clock });
    const missionStore = options.missionStoreBackend === 'sqlite'
      ? new SqliteMissionStore({ operationsStore: personalStore }) : null;
    if (options.missionAuthorityEnabled) {
      missionExecutionAuthority = new MissionExecutionAuthority({ store: missionStore, ttlMs: options.missionAuthorityTtlMs });
      // Claim before importing a legacy snapshot or hydrating Mission state.
      // A stale expected token or existing owner is an explicit startup failure.
      missionExecutionAuthority.activate({ expectedToken: options.missionAuthorityExpectedToken,recoveryOnly:options.missionAuthorityRecoveryOnly,serviceId:options.missionAuthorityServiceId });
    }
    pcOutboundService = await pcOutboundServiceFactory({ env,
      authorityGuard: missionExecutionAuthority ? () => missionExecutionAuthority.assertActive({allowRecovery:true}) : null });
    if (missionStore && existsSync(options.missionStorePath)) {
      missionStore.importLegacySnapshot(options.missionStorePath);
    }
    const outboundExecutor=createConfiguredPcOutboundExecutor({binding:options.pcOutboundExecutionBinding,service:pcOutboundService});
    const remotePcAgent = outboundExecutor?.executor??(options.pcAgentRemoteExecutionEnabled ? new PcAgentExecutionClient({
      baseUrl: options.pcAgentApiUrl, executionToken: options.pcAgentExecutionToken, timeoutMs: options.pcAgentExecutionTimeoutMs
    }) : null);
    const egressKeyStore = managedAgentEgressKeyStore ?? new MissionEgressDecisionKeyStore({ path: options.managedAgentEgressKeyPath });
    const personalInbox = new PersonalSourceInbox(personalStore);
    const microsoftSourceReader=createMicrosoftSourceReader({registry:integrationRegistry,vault:integrationVault,fetchImpl:modelProviderFetch,clock});
    const microsoftBinding=request=>({capabilityId:'source.collectMicrosoftMetadata',providerId:'microsoft-graph',accountRef:request.connectionId,deviceRef:null,
      scopes:[request.provider==='outlook'?'Mail.ReadBasic':'Chat.Read']});
    const microsoftRevision=request=>integrationVault.credentialRevision(request.connectionId);
    const assertMicrosoftAuthority=()=>{
      missionExecutionAuthority?.assertActive();
    };
    let microsoftEffects;
    microsoftCollectionAccess=createMicrosoftCollectionAccess({reader:microsoftSourceReader,inbox:personalInbox,readTrustedTask:id=>runtime?.coreFacade.getTask(id),
      effectContextFor:(taskId,request)=>{
        if(!missionStore||!missionExecutionAuthority)throw Error('A_MICROSOFT_EFFECT_SQL_AUTHORITY_REQUIRED');
        assertMicrosoftAuthority();
        const matches=[];
        for(const mission of runtime.missionRuntime.missions.values())for(const action of mission.waves.flatMap(w=>w.actions))
          if(action.taskId===taskId)matches.push({mission,action});
        if(matches.length!==1)throw Error('A_MICROSOFT_EFFECT_BINDING_REQUIRED');
        const {mission,action}=matches[0],operation=action.operation,dispatch=operation?.dispatch;
        if(['CANCELLED','FAILED','BLOCKED'].includes(mission.status)||dispatch?.taskId!==taskId
          ||dispatch.toolName!=='source.collectMicrosoftMetadata'||action.goalRevision!==mission.goalContract.revision
          ||action.authorizationRevision!==mission.authorizationRevision
          ||collectionDigest(normalizeMicrosoftCollection(dispatch.arguments))!==collectionDigest(request))throw Error('A_MICROSOFT_EFFECT_BINDING_CHANGED');
        microsoftEffects??=new MicrosoftCollectionEffects({store:personalStore,inbox:personalInbox,
          signer:runtime.trustKernel.createPurposeBoundSigner({purpose:'core-microsoft-collection-sql-commit-v1'}),authority:missionExecutionAuthority});
        return {ledger:microsoftEffects,...(mission.microsoftCollection?.version==='microsoft-collection-pages-goal-v1'?{validatePage:page=>runtime.missionRuntime.microsoftCollectionPageAllowed(mission,action,page)}:{}),binding:{operationId:operation.operationId,missionId:mission.missionId,actionId:action.actionId,taskId,
          goalRevision:action.goalRevision,authorizationRevision:action.authorizationRevision}};
      },
      authorizeConnection:request=>{try{
        assertMicrosoftAuthority();
        const record=integrationVault.list().find(row=>row.connectionId===request.connectionId);
        const binding=microsoftBinding(request),availability=runtime?.capabilityPackageRegistry.availabilityFor(binding);
        return record?.connectorId===(request.provider==='outlook'?'jarvis-outlook-read':'jarvis-teams-chat-read')
          &&!['revoked','removed','disconnected','expired','reauth-required'].includes(record.status)
          &&record.scopes?.includes(binding.scopes[0])&&availability?.codeReady&&availability.accountStatus==='connected'
          &&availability.permissionRevision===microsoftRevision(request)&&availability.reasons.length===0;
      }catch{return false;}}});
    let microsoftTaskReceipts;
    microsoftCollectionAccess.abandonUncommitted=operationId=>{
      if(!missionStore||!missionExecutionAuthority)throw Error('A_MICROSOFT_EFFECT_SQL_AUTHORITY_REQUIRED');
      missionExecutionAuthority.assertActive({allowRecovery:true});
      microsoftEffects??=new MicrosoftCollectionEffects({store:personalStore,inbox:personalInbox,
        signer:runtime.trustKernel.createPurposeBoundSigner({purpose:'core-microsoft-collection-sql-commit-v1'}),authority:missionExecutionAuthority});
      return microsoftEffects.abandonUncommitted(operationId);
    };
    const taskReceipts=()=>microsoftTaskReceipts??=new MicrosoftCollectionTaskReceipts({store:personalStore,
      signer:runtime.trustKernel.createPurposeBoundSigner({purpose:'core-microsoft-collection-task-receipt-v1'}),
      readOperationReceipt:(id,r,options)=>microsoftCollectionAccess.readOperationReceipt(id,r,options),
      readTrustedTask:id=>runtime.coreFacade.getTask(id),verifyCollectionPages:pages=>personalInbox.verifyCollection(pages),
      authorizeArchive:(m,a,t)=>{try{runtime.missionRuntime.microsoftCollectionDependencies(m).beforeRead(a,t);return true;}catch{return false;}}});
    microsoftCollectionAccess.resolvePageLimit=m=>taskReceipts().effectiveLimit(m);
    microsoftCollectionAccess.signLimitExtension=(m,input)=>taskReceipts().signLimitExtension(m,input);
    microsoftCollectionAccess.archiveCompletedAction=(m,a,t)=>taskReceipts().record(m,a,t);
    microsoftCollectionAccess.readRecoveredTask=(m,a)=>{try{return taskReceipts().recover(m,a);}catch{return null;}};
    microsoftCollectionAccess.readSelections=()=>{
      assertMicrosoftAuthority();
      const items=integrationVault.list().flatMap((record,index)=>{
        const provider=record.connectorId==='jarvis-outlook-read'?'outlook':record.connectorId==='jarvis-teams-chat-read'?'teams-chat':null;
        if(!provider)return [];
        const binding=microsoftBinding({provider,connectionId:record.connectionId}),a=runtime.capabilityPackageRegistry.availabilityFor(binding);
        const ready=!['revoked','removed','disconnected','expired','reauth-required'].includes(record.status)&&record.scopes?.includes(binding.scopes[0])
          &&a.codeReady&&a.accountStatus==='connected'&&a.permissionRevision===microsoftRevision({connectionId:record.connectionId})&&a.reasons.length===0;
        return [{provider,connectionId:record.connectionId,label:`${provider==='outlook'?'Outlook':'Teams'} 연결 ${index+1}`,ready,
          nextAction:ready?'선택한 연결에서 한 페이지 또는 한도가 있는 전체 페이지를 수집할 수 있습니다.':'로그인·읽기 권한과 현재 연결 확인이 필요합니다. 저장된 인증정보만으로 실행하지 않습니다.'}];
      });
      return {version:'microsoft-collection-selections-v1',missionConfigured:true,items};
    };
    // Credential presence is not a provider connectivity probe. Never manufacture readiness.
    microsoftCollectionAccess.resolveBinding=({action,task})=>{try{
      const request=action?.arguments??task?.plan?.action?.arguments;
      return {required:true,binding:microsoftBinding(request),permissionRevision:microsoftRevision(request)};
    }catch{return {required:true};}};
    const sourceAdminAuth=createCoreAdminAuthProvider({adminToken:options.adminToken,adminTokenHash:options.adminTokenHash,clock,
      adminTokenHashes:[
        ...(options.integrationHandoffTokenHash?[{tokenHash:options.integrationHandoffTokenHash,tokenId:'integration-handoff-broker',role:'integration-broker',scopes:[CoreAdminScope.MANAGE_INTEGRATION_HANDOFFS]}]:[]),
        ...(env.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_SHA256?[{tokenHash:env.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_SHA256,tokenId:'bridge-growth-review-authorizer',role:'bridge-growth-review-authorizer',scopes:[CoreAdminScope.AUTHORIZE_GROWTH_SKILL_REVIEW]}]:[])
      ]});
    sourceServiceAccess=createSelectedSourceServiceAccess({inbox:personalInbox,adminAuth:sourceAdminAuth,getRuntime:()=>runtime,getServer:()=>sourceServer,clock});
    caseServiceAccess=createLifecycleCaseServiceAccess({store:personalStore,getRuntime:()=>runtime,clock});
    runtime = createAgRuntime({
      selectedSourceAccess:sourceServiceAccess.access,
      lifecycleCaseAccess:caseServiceAccess.access,
      microsoftCollectionAccess,
      env,
      bridgeRealExecution: env.JARVIS_CORE_MOBILE_GATEWAY_ENABLED === '1',
      bridgeDeviceTokenSecret: env.JARVIS_DEVICE_TOKEN_SECRET,
      bridgeDeviceTokenKeyChangePolicy: env.JARVIS_CORE_MOBILE_GATEWAY_ENABLED === '1' ? 'reject' : undefined,
      bridgeAuditRoot,
      ...(mcpReviewedPackageCatalog?{mcpReviewedPackageCatalog,mcpStorePath:join(options.auditRoot,'mcp.sqlite')}:{}),
      taskEnv,
      modelCredentialResolver: modelCredentialAccess,
      memoryStore,
      ...(remotePcAgent ? { pcAgentExecutor: remotePcAgent } : {}),
      ...(outboundExecutor?{missionRemoteArtifactRecovery:outboundExecutor.recovery}:{}),
      cognitionStorePath: options.cognitionStorePath,
      allowedRoots: options.allowedRoots,
      auditRoot: options.auditRoot,
      cwd: () => options.allowedRoots[0],
      coreEventLogPath: options.coreEventLogPath,
      coreOrchestrationJournalPath: options.coreOrchestrationJournalPath,
      workerLeaseStorePath: options.workerLeaseStorePath,
      workerQueueStorePath: options.workerQueueStorePath,
      missionStorePath: options.missionStorePath,
      ...(missionStore ? { missionStore } : {}),
      ...(missionExecutionAuthority ? { missionExecutionAuthority } : {}),
      missionEventLogPath: options.missionEventLogPath,
      executionHealthPath: options.executionHealthPath,
      trustRoot: options.trustRoot,
      trustStatePath: options.trustStatePath,
      trustAuditPath: options.trustAuditPath,
      trustPeerAuditPaths: options.trustPeerAuditPaths,
      trustKeyPath: options.trustKeyPath,
      trustActorId: options.trustActorId,
      managedAgentEgressKeyStore: egressKeyStore,
      ...(managedAgentSessionBrokerFactory ? {
        managedAgentSessionBrokerFactory: context => managedAgentSessionBrokerFactory({
          ...context,
          managedAgentCredentialAccess,
          integrationRegistry,
          integrationVault
        })
      } : {}),
      workerDaemonEnabled: options.workerDaemonEnabled,
      workerDaemonIntervalMs: options.workerDaemonIntervalMs,
      workerDaemonDrainLimit: options.workerDaemonDrainLimit,
      workerDaemonMaxConsecutiveFailures: options.workerDaemonMaxConsecutiveFailures,
      clock
    });
    const routineStore = new SqliteDurableRoutineStore({ operationsStore: personalStore, clock });
    const routineScheduler = new DurableRoutineScheduler({ store: routineStore, missionRuntime: runtime.missionRuntime, clock,
      onNotification: notification => runtime.coreFacade.eventBus?.publish?.('core.routine.notification', notification) });
    runtime.workerDaemon.routineScheduler = routineScheduler;
    runtime.routineStore = routineStore;
    runtime.routineScheduler = routineScheduler;
    if (remotePcAgent) runtime.remotePcAgent = remotePcAgent;
    const personalOperations = new PersonalOperationsMissionLink({store:personalStore,missionRuntime:runtime.missionRuntime});
    const personalOperationsScheduler = new PersonalOperationsReminderScheduler({ store: personalStore, missionRuntime: runtime.missionRuntime,
      onNotification: notification => runtime.coreFacade.eventBus?.publish?.('core.personal-operations.notification', notification) });
    runtime.workerDaemon.personalOperationsScheduler = personalOperationsScheduler;
    runtime.personalOperationsScheduler = personalOperationsScheduler;
    const sourceRevisionInbox = new SqliteSourceRevisionInbox({ operationsStore: personalStore, clock });
    const sourceRevisionWatcher = new SourceRevisionFileWatcher({ inbox: sourceRevisionInbox, allowedRoots: options.allowedRoots, clock,
      onError: (error, context) => runtime.coreFacade.eventBus?.publish?.('core.source.revision.watch.error', {
        code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'A_SOURCE_WATCH_FAILED', sourceKey: context?.sourceKey ?? null
      }) });
    runtime.sourceRevisionInbox = sourceRevisionInbox;
    runtime.sourceRevisionWatcher = sourceRevisionWatcher;
    const personalBudget = new PersonalMandateBudget(personalStore);
    const duffelBroker=createConfiguredDuffelBroker({env,clock});
    const missionBudgetGate = new MissionBudgetGate({store:personalStore,budget:personalBudget});
    runtime.missionRuntime.executionBudget=missionBudgetGate;
    const googleBroker = googleBackend === 'broker' ? createConfiguredGoogleBroker({ env, clock, authorizePage:(job,authorization)=>googleSync.evidence.authorize(job,authorization), onVerified: async () => {
      googleSync.resumeAfterVerifiedConnection();
      if (env.JARVIS_GOOGLE_SYNC_ENABLED !== '0') googleSync.start();
    } }) : null;
    const googleClient = googleBroker?.client ?? createGoogleVaultReadClient({registry:integrationRegistry,vault:integrationVault,fetchImpl:modelProviderFetch,clock});
    const googleSync = createManagedGoogleSync({store:personalStore,client:googleClient,requireMandates:googleBackend==='broker'});
    const interactiveSession=env.JARVIS_WINDOWS_SERVICE!=='1'&&env.JARVIS_CORE_INTERACTIVE_SESSION!=='0';
    let googleConnection = null;
    const activateGoogleConnection = async () => {
      try {
        await googleSync.stop();
        const verification = await googleClient.verifyConnection();
        googleSync.client=googleClient;googleSync.resumeAfterVerifiedConnection();
        if(env.JARVIS_GOOGLE_SYNC_ENABLED!=='0')googleSync.start();
        if(googleConnection)googleConnection.state={status:'connected'};
        return { status: 'verified', providerVerified: true, checkedAt: verification.checkedAt };
      } catch(error) {
        if(googleConnection)googleConnection.state={status:'failed',code:/^A_GOOGLE_[A-Z0-9_]+$/u.test(error?.message??'')?error.message:'A_GOOGLE_ACTIVATION_FAILED'};
        throw error;
      }
    };
    googleConnection = googleBroker?.controller ?? new GoogleConnectionController({interactiveSession,handoffs:integrationHandoffs,helperEnv:env,onConnected:activateGoogleConnection});
    const personalImportWorker = new PersonalImportWorker({inbox:personalInbox,directory:resolve(env.JARVIS_PERSONAL_IMPORT_DIR ?? (env.JARVIS_TEST_MODE==='1'?join(options.auditRoot,'imports'):join(homedir(),'.jarvis','imports')))});
    let mobileRouter = null;
    if (env.JARVIS_CORE_MOBILE_GATEWAY_ENABLED === '1') {
      if (!env.JARVIS_DEVICE_TOKEN_SECRET || env.JARVIS_DEVICE_TOKEN_SECRET.length < 32) throw new Error('A_MOBILE_DEVICE_SECRET_REQUIRED');
      runtime.bridgeRuntime.executionAuthorityMode = 'core-api';
      runtime.bridgeRuntime.growthSkillReviewAuthorizer = input => {
        const authorization = runtime.personalOwnerSession.authorizeGrowthSkillReview(input);
        return authorization.allowed ? { allowed: true, authorization }
          : { allowed: false, error: { code: authorization.reason === 'owner-session-inactive' ? 'A_OWNER_SESSION_INACTIVE' : authorization.code } };
      };
      runtime.bridgeRuntime.growthSkillReviewAuthorizationKeyId = env.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_KEY_ID ?? null;
      mobileRouter = createBridgeServer(runtime.bridgeRuntime);
    }
    const server = createCoreServer(runtime.coreFacade, {
      adminAuth:sourceAdminAuth,
      mobileRouter,
      personalOperations,
      personalOperationsScheduler,
      personalInbox,
      microsoftSourceReader,
      personalBudget,
      missionBudgetGate,
      personalImportWorker,
      googleSync,
      googleConnection,
      emailConnection: runtime.emailConnection,
      duffelBroker,
      pcOutboundNodes: pcOutboundService?.controller ?? null,
      pcOutboundExecutionBinding: options.pcOutboundExecutionBinding,
      capabilityPackageRegistry: runtime.capabilityPackageRegistry,
      mcpConnections: runtime.mcpConnections,
      mcpPackageInstaller: runtime.mcpPackageInstaller,
      a2aServiceRegistry: runtime.a2aServiceRegistry,
      capabilityPackagePromotionManager: runtime.capabilityPackagePromotionManager,
      modelProviderStatus: runtime.modelProviderStatus,
      managedAgentCredentialAccess,
      integrationRegistry,
      integrationVault,
      integrationHandoffs,
      onIntegrationHandoffCompleted: async ({ connectorId }) => connectorId === 'jarvis-google-workspace'
        ? activateGoogleConnection()
        : { status: 'stored-unverified', providerVerified: false },
      modelProviderVerifier,
      adminToken: options.adminToken,
      adminTokenHash: options.adminTokenHash,
      adminTokenHashes: [
        ...(options.integrationHandoffTokenHash ? [{
        tokenHash: options.integrationHandoffTokenHash,
        tokenId: 'integration-handoff-broker',
        role: 'integration-broker',
        scopes: [CoreAdminScope.MANAGE_INTEGRATION_HANDOFFS]
        }] : []),
        ...(env.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_SHA256 ? [{
        tokenHash: env.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_SHA256,
        tokenId: 'bridge-growth-review-authorizer',
        role: 'bridge-growth-review-authorizer',
        scopes: [CoreAdminScope.AUTHORIZE_GROWTH_SKILL_REVIEW]
        }] : [])
      ],
      orchestrationWorker: runtime.orchestrationWorker,
      missionRuntime: runtime.missionRuntime,
      ownerSessionManager: runtime.personalOwnerSession,
      trustKernel: runtime.trustKernel,
      workerDaemon: runtime.workerDaemon,
      routineScheduler: runtime.routineScheduler,
      sourceRevisionInbox,
      sourceRevisionWatcher,
      managedAgentEgressPolicy: runtime.managedAgentEgressPolicy
    });
    sourceServer=server;
    const closeMobileConnections = mobileRouter ? mountCoreMobileUpgrades(server, mobileRouter) : () => {};
    server.once('listening', () => {if(env.JARVIS_PERSONAL_IMPORT_ENABLED!=='0')personalImportWorker.start();if(env.JARVIS_GOOGLE_SYNC_ENABLED!=='0')googleSync.start();});
    let resourcesClosePromise;
    let shutdownStarted = false;
    const beginShutdown = () => {
      sourceServiceAccess?.close();
      caseServiceAccess?.close();
      microsoftCollectionAccess?.close();
      // The HTTP listener may close before an operator calls runtime.close().
      // Never stop/read the scheduler again after its SQLite stores were closed.
      if (shutdownStarted) return;
      shutdownStarted = true;
      closeMobileConnections();
      runtime.workerDaemon.stop({ reason: 'core-service-runtime-shutdown' });
      runtime.missionRuntime.requestShutdown({ reason: 'core-service-runtime-shutdown' });
    };
    const closeResources = () => resourcesClosePromise ??= (async () => {
      beginShutdown();
      try {
        await pcOutboundService?.close();
        await googleConnection.close();
        duffelBroker?.close();
        await Promise.all([personalImportWorker.stop(), googleSync.stop(), sourceRevisionWatcher.close()]);
        // A timer may already have dispatched a task. Keep its learning store open
        // until that task finishes recording its result.
        while (runtime.workerDaemon.draining) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
      } finally {
        // A provider call may not honor cancellation. Keep DBs open until its observed
        // result, verification, memory and budget finalizers settle; never redispatch it.
        await Promise.allSettled([...runtime.missionRuntime.activeRuns.values()].map(active => active.promise));
        await Promise.allSettled([...runtime.missionRuntime.goalRevisions.drains.values()]);
        while (runtime.workerDaemon.draining) {
          await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
        }
        try { if (missionExecutionAuthority?.lease) missionExecutionAuthority.release(); }
        finally {
          missionExecutionAuthority?.stopHeartbeat();
          try { try { runtime.a2aServiceRegistry?.close(); } finally { try { runtime.mcpConnections?.close(); } finally { personalStore.close(); } } }
          finally {
            try { runtime.coreFacade.cognition?.close?.(); }
            finally { memoryStore.close(); }
          }
        }
      }
    })();
    server.once('close', () => {
      void closeResources().catch((error) => {
        process.emitWarning(`Core runtime resource cleanup failed: ${error.message}`, { code: 'A_CORE_RUNTIME_CLOSE_FAILED' });
      });
    });
    let closePromise;
    const close = () => closePromise ??= (async () => {
      beginShutdown();
      if (server.listening) {
        await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
      }
      await closeResources();
    })();
    return { ...runtime, server, options, personalOperations, missionExecutionAuthority, pcOutboundService, ledgerStorageObservation, close };
  } catch (error) {
    sourceServiceAccess?.close();
    caseServiceAccess?.close();
    microsoftCollectionAccess?.close();
    await pcOutboundService?.close();
    if (missionExecutionAuthority?.lease) {
      try { missionExecutionAuthority.release(); }
      catch { /* Leave unresolved state fenced for explicit reconciliation. */ }
      finally { missionExecutionAuthority.stopHeartbeat(); }
    }
    try { personalStore?.close(); }
    finally {
      try { runtime?.coreFacade.cognition?.close?.(); }
      finally { memoryStore.close(); }
    }
    throw error;
  }
}

export async function startCoreServiceRuntime({ env = process.env, clock } = {}) {
  const runtime = await createConfiguredCoreServiceRuntime({ env, clock });
  let address;
  try {
    address = await listenOnFetchSafePort(runtime.server, {
      host: runtime.options.host,
      port: runtime.options.port
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const actualPort = address.port;
  const baseUrl = `http://${runtime.options.host}:${actualPort}`;
  const sourceWatchRecovery = await runtime.sourceRevisionWatcher?.startRegistered?.() ?? null;
  const routineRecovery = runtime.routineScheduler?.startupReconcile
    ? await runtime.routineScheduler.startupReconcile()
    : null;
  const daemonStart = runtime.options.workerDaemonAutostart
    ? runtime.workerDaemon.start({ reason: 'core-service-runtime-start' })
    : { success: true, status: 'autostart-disabled', daemon: runtime.workerDaemon.status() };
  console.log(`JARVIS-A Core service runtime listening at ${baseUrl}`);
  console.log(`JARVIS-A worker daemon: ${daemonStart.status}`);
  if (routineRecovery) console.log(`JARVIS-A durable routines: recovered=${routineRecovery.recoveredDispatches}, missed=${routineRecovery.missed}`);
  if (sourceWatchRecovery?.attempted) console.log(`JARVIS-A source watches: restored=${sourceWatchRecovery.watching}/${sourceWatchRecovery.attempted}`);
  const {attachOwnedServiceShutdown}=await import('../packages/shared/src/owned-service-shutdown.js');
  const detachShutdown=attachOwnedServiceShutdown({env,close:()=>runtime.close()});
  return {
    ...runtime,
    close:async()=>{detachShutdown();await runtime.close();},
    host: runtime.options.host,
    port: actualPort,
    baseUrl,
    daemonStart,
    routineRecovery,
    sourceWatchRecovery
  };
}

async function shutdownRuntime(runtime) {
  try {
    await runtime.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCoreServiceRuntime().then((runtime) => {
    process.once('SIGINT', () => shutdownRuntime(runtime));
    process.once('SIGTERM', () => shutdownRuntime(runtime));
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
