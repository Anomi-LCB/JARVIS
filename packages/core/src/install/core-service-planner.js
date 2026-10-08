import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { platform } from 'node:os';
import { resolve,isAbsolute } from 'node:path';

const SERVICE_ACTIONS = new Set(['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'update']);

export function createCoreServiceLifecyclePlan({
  action,
  cwd = process.cwd(),
  execute = false,
  serviceName = 'JARVISCoreRuntime',
  displayName = 'JARVIS Core Runtime',
  description = 'Local-first JARVIS A Common Core runtime and orchestration API.',
  startType = 'Automatic',
  serviceAccount = ['update', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(action) ? 'preserve' : 'virtual',
  integrationVaultPath = action === 'update' ? '' : `%ProgramData%\\JARVIS\\CoreRuntime\\${serviceName}\\integrations\\credentials.dpapi.json`,
  entryScript = 'scripts/core-service-runtime.mjs',
  updatePackageRoot = null,
  port = 4071,
  host = '127.0.0.1',
  logs = {},
  recovery = {}
} = {}) {
  if (!SERVICE_ACTIONS.has(action)) {
    throw new Error(`Unsupported core service action: ${action}`);
  }
  const root = resolve(cwd);
  const normalizedServiceAccount = normalizeServiceAccount(serviceAccount, action);
  const entryPath = resolve(root, entryScript);
  if(updatePackageRoot!==null&&(!isAbsolute(updatePackageRoot)||/[\x00-\x1f]/u.test(updatePackageRoot)))throw new Error('CORE_UPDATE_PACKAGE_ROOT_INVALID');
  const environment = {
    PORT: String(port),
    JARVIS_CORE_HOST: host,
    JARVIS_CORE_AUDIT_ROOT: resolve(root, logs.auditRoot ?? 'logs'),
    JARVIS_CORE_ALLOWED_ROOTS: resolve(root, logs.allowedRoot ?? 'workspace'),
    JARVIS_CORE_EVENT_LOG: resolve(root, logs.eventLogPath ?? 'logs/core-events.jsonl'),
    JARVIS_CORE_ORCHESTRATION_JOURNAL: resolve(root, logs.orchestrationJournalPath ?? 'logs/core-orchestration.jsonl'),
    JARVIS_CORE_WORKER_LEASE_STORE: resolve(root, logs.workerLeaseStorePath ?? 'logs/core-worker-leases.json'),
    JARVIS_CORE_WORKER_QUEUE_STORE: resolve(root, logs.workerQueueStorePath ?? 'logs/core-worker-queue.json'),
    JARVIS_CORE_INTEGRATION_VAULT: integrationVaultPath,
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: String(logs.workerDaemonAutostart ?? true),
    JARVIS_CORE_WORKER_DAEMON_INTERVAL_MS: String(logs.workerDaemonIntervalMs ?? 1000),
    JARVIS_CORE_WORKER_DAEMON_DRAIN_LIMIT: String(logs.workerDaemonDrainLimit ?? 5),
    JARVIS_CORE_ADMIN_TOKEN_SHA256: logs.adminTokenHash ?? '<set-admin-token-sha256-before-install>',
    JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256: logs.integrationHandoffTokenHash ?? '<set-integration-handoff-token-sha256-before-broker-use>'
  };
  const nodeCommand = `node "${entryPath}"`;
  const commands = coreServiceCommandsFor({
    action,
    serviceName,
    displayName,
    description,
    startType,
    serviceAccount: normalizedServiceAccount,
    nodeCommand,
    environment,
    recovery,
    updatePackageRoot
  });
  return {
    planVersion: 'a-core-service-lifecycle-plan-v1',
    action,
    execute,
    dryRun: !execute,
    serviceName,
    displayName,
    description,
    startType,
    serviceAccount: normalizedServiceAccount,
    workspaceRoot: root,
    localOnly: host === '127.0.0.1',
    endpoint: `http://${host}:${port}`,
    entryPath,
    updatePackageRoot,
    environment,
    recovery: {
      enabled: recovery.enabled ?? true,
      actions: recovery.actions ?? [{ type: 'restart', delayMs: 5000 }, { type: 'restart', delayMs: 30000 }, { type: 'none', delayMs: 0 }],
      resetSeconds: recovery.resetSeconds ?? 86400,
      restartOnNonCrashFailures: recovery.restartOnNonCrashFailures ?? true
    },
    commands,
    warnings: execute ? [] : ['dry-run-only: review and run from Administrator PowerShell']
  };
}

export async function verifyCoreServiceReadiness({
  cwd = process.cwd(),
  osPlatform = platform(),
  isAdministrator = false,
  plan = null,
  clock = () => new Date()
} = {}) {
  const servicePlan = plan ?? createCoreServiceLifecyclePlan({ action: 'install', cwd, execute: false });
  const checks = [];
  const add = (id, status, detail = {}) => checks.push({ id, status, ...detail });
  add('windows-platform', osPlatform === 'win32' ? 'pass' : 'warning', {
    expected: 'win32',
    actual: osPlatform,
    message: osPlatform === 'win32' ? 'Windows service commands are platform-compatible.' : 'Install on a Windows host for final service validation.'
  });
  add('administrator-shell', isAdministrator ? 'pass' : 'warning', {
    message: isAdministrator ? 'Administrator shell is available.' : 'Install/update/start/stop require Administrator PowerShell.'
  });
  add('local-bind', servicePlan.localOnly ? 'pass' : 'fail', { endpoint: servicePlan.endpoint });
  add('entry-script', await canAccess(servicePlan.entryPath) ? 'pass' : 'fail', { path: servicePlan.entryPath });
  if(servicePlan.action==='update')add('transactional-update-entry',servicePlan.updatePackageRoot&&await canAccess(resolve(servicePlan.updatePackageRoot,'update-service.ps1'))?'pass':'fail',{
    message:'Updates require a reviewed versioned package with a recoverable update entry.'
  });
  add('admin-token-hash', servicePlan.environment.JARVIS_CORE_ADMIN_TOKEN_SHA256 !== '<set-admin-token-sha256-before-install>' ? 'pass' : 'warning', {
    message: 'Set JARVIS_CORE_ADMIN_TOKEN_SHA256 before production installation.'
  });
  add('integration-handoff-broker-token', /^[a-f0-9]{64}$/i.test(servicePlan.environment.JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256) ? 'pass' : 'warning', {
    message: 'A separately provisioned current-user DPAPI broker token hash is required before connecting the interactive integration broker.'
  });
  add('persistent-runtime-stores', servicePlan.environment.JARVIS_CORE_EVENT_LOG && servicePlan.environment.JARVIS_CORE_WORKER_QUEUE_STORE && servicePlan.environment.JARVIS_CORE_WORKER_LEASE_STORE ? 'pass' : 'fail', {
    eventLogPath: servicePlan.environment.JARVIS_CORE_EVENT_LOG,
    queueStorePath: servicePlan.environment.JARVIS_CORE_WORKER_QUEUE_STORE,
    leaseStorePath: servicePlan.environment.JARVIS_CORE_WORKER_LEASE_STORE
  });
  add('service-recovery-policy', servicePlan.recovery.enabled && servicePlan.recovery.actions.some((action) => action.type === 'restart') ? 'pass' : 'warning', {
    recovery: servicePlan.recovery
  });
  add('service-account-policy', servicePlan.serviceAccount === 'virtual' ? 'pass' : 'warning', {
    serviceAccount: servicePlan.serviceAccount,
    accountName: serviceAccountName(servicePlan.serviceName, servicePlan.serviceAccount),
    message: servicePlan.serviceAccount === 'virtual'
      ? 'New installation uses a dedicated Windows virtual account without a managed password.'
      : 'The service identity is preserved or uses a compatibility account; verify its data ACLs and DPAPI ownership before changing it.'
  });
  add('service-plan-commands', servicePlan.commands.length >= (servicePlan.action==='update'?1:2) ? 'pass' : 'fail', {
    action: servicePlan.action,
    commandCount: servicePlan.commands.length,
    hasRecoveryCommand: servicePlan.commands.some((command) => command.includes('sc.exe failure'))
  });
  const failed = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warning');
  return {
    readinessVersion: 'a-core-service-readiness-v1',
    status: failed.length ? 'blocked' : warnings.length ? 'ready-with-warnings' : 'ready',
    generatedAt: clock().toISOString(),
    serviceName: servicePlan.serviceName,
    endpoint: servicePlan.endpoint,
    checks,
    nextActions: coreServiceNextActions({ failed, warnings })
  };
}

export function coreServiceCommandsFor({ action, serviceName, displayName, description, startType, serviceAccount = 'virtual', nodeCommand, environment, recovery,updatePackageRoot=null }) {
  if (action === 'status') {
    return [
      `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      `Get-CimInstance Win32_Service -Filter "Name='${serviceName}'" | Select-Object Name, State, StartMode, StartName, PathName`
    ];
  }
  if (action === 'start') return [`Start-Service -Name "${serviceName}"`, `Get-Service -Name "${serviceName}"`];
  if (action === 'stop') return [`Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`, `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`];
  if (action === 'restart') return [`Restart-Service -Name "${serviceName}" -Force`, `Get-Service -Name "${serviceName}"`];
  if (action === 'uninstall') return [`Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`, `sc.exe delete "${serviceName}"`];
  if(action==='update'){
    if(updatePackageRoot)return [`& '${resolve(updatePackageRoot,'update-service.ps1').replaceAll("'","''")}'`];
    return [`Get-CimInstance Win32_Service -Filter "Name='${serviceName}'" | Select-Object Name, State, StartMode, StartName, PathName`,
      'throw "CORE_UPDATE_TRANSACTIONAL_PACKAGE_REQUIRED: prepare a reviewed versioned service package before updating."'];
  }

  const envAssignments = Object.entries(environment)
    .map(([key, value]) => `$env:${key}="${String(value).replaceAll('"', '\\"')}"`)
    .join('; ');
  const binaryPathName = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${envAssignments}; ${nodeCommand}"`;
  return [
    `$existingService = Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
    `if ($null -eq $existingService) { New-Service -Name "${serviceName}" -DisplayName "${displayName}" -Description "${description}" -StartupType ${startType} -BinaryPathName '${binaryPathName}' } else { sc.exe config "${serviceName}" binPath= '${binaryPathName}' start= ${startType}; sc.exe description "${serviceName}" "${description}" }`,
    `Set-Service -Name "${serviceName}" -StartupType ${startType}`,
    ...coreServiceAccountCommands({ serviceName, serviceAccount }),
    ...coreServiceRecoveryCommands({ serviceName, recovery }),
    `Start-Service -Name "${serviceName}"`
  ];
}

export function coreServiceAccountCommands({ serviceName, serviceAccount = 'virtual' }) {
  if (serviceAccount === 'preserve') return [];
  const account = serviceAccountName(serviceName, serviceAccount);
  return [
    `sc.exe config "${serviceName}" obj= "${account}" password= ""`,
    ...(serviceAccount === 'virtual' ? [`sc.exe sidtype "${serviceName}" unrestricted`] : [])
  ];
}

export function serviceAccountName(serviceName, serviceAccount) {
  if (serviceAccount === 'virtual') return `NT SERVICE\\${serviceName}`;
  if (serviceAccount === 'local-system') return 'LocalSystem';
  if (serviceAccount === 'preserve') return 'existing-service-account';
  throw new Error(`Unsupported Core service account: ${serviceAccount}`);
}

function normalizeServiceAccount(value, action) {
  const allowed = new Set(['virtual', 'local-system', 'preserve']);
  if (!allowed.has(value)) throw new Error(`Unsupported Core service account: ${value}`);
  if (value === 'preserve' && !['update', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(action)) {
    throw new Error(`The preserve service-account mode is not valid for ${action}.`);
  }
  if (action === 'update' && value !== 'preserve') {
    const error = new Error('Changing an installed service identity requires a DPAPI data migration first.');
    error.code = 'A_CORE_SERVICE_ACCOUNT_MIGRATION_REQUIRED';
    throw error;
  }
  return value;
}

export function coreServiceRecoveryCommands({ serviceName, recovery = {} }) {
  if (recovery.enabled === false) return [];
  const actionMap = { restart: 'restart', reboot: 'reboot', run: 'run', none: '' };
  const actions = (recovery.actions ?? [{ type: 'restart', delayMs: 5000 }, { type: 'restart', delayMs: 30000 }, { type: 'none', delayMs: 0 }])
    .map((action) => `${actionMap[action.type] ?? ''}/${Number(action.delayMs ?? 0)}`)
    .join('/');
  return [
    `sc.exe failure "${serviceName}" reset= ${Number(recovery.resetSeconds ?? 86400)} actions= ${actions}`,
    `sc.exe failureflag "${serviceName}" ${recovery.restartOnNonCrashFailures === false ? '0' : '1'}`
  ];
}

function coreServiceNextActions({ failed, warnings }) {
  const actions = [];
  if (failed.some((check) => check.id === 'entry-script')) actions.push('Fix the core service entry script path before installing.');
  if (failed.some((check) => check.id === 'local-bind')) actions.push('Bind the Core API only to 127.0.0.1 before service installation.');
  if (failed.some((check) => check.id === 'persistent-runtime-stores')) actions.push('Configure persistent event, queue, and lease store paths.');
  if (warnings.some((check) => check.id === 'admin-token-hash')) actions.push('Set JARVIS_CORE_ADMIN_TOKEN_SHA256 before production installation.');
  if (warnings.some((check) => check.id === 'integration-handoff-broker-token')) actions.push('Provision a separate current-user DPAPI token for the integration broker and set only its SHA-256 hash as JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256.');
  if (warnings.some((check) => check.id === 'administrator-shell')) actions.push('Run install/update/start/stop from Administrator PowerShell.');
  if (warnings.some((check) => check.id === 'windows-platform')) actions.push('Run final service verification on Windows.');
  return actions;
}

async function canAccess(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
