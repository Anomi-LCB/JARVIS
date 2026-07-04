import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';

const SERVICE_ACTIONS = new Set(['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'update']);

export function createCoreServiceLifecyclePlan({
  action,
  cwd = process.cwd(),
  execute = false,
  serviceName = 'JARVISCoreRuntime',
  displayName = 'JARVIS Core Runtime',
  description = 'Local-first JARVIS A Common Core runtime and orchestration API.',
  startType = 'Automatic',
  entryScript = 'scripts/core-service-runtime.mjs',
  port = 4071,
  host = '127.0.0.1',
  logs = {},
  recovery = {}
} = {}) {
  if (!SERVICE_ACTIONS.has(action)) {
    throw new Error(`Unsupported core service action: ${action}`);
  }
  const root = resolve(cwd);
  const entryPath = resolve(root, entryScript);
  const environment = {
    PORT: String(port),
    JARVIS_CORE_HOST: host,
    JARVIS_CORE_AUDIT_ROOT: resolve(root, logs.auditRoot ?? 'logs'),
    JARVIS_CORE_ALLOWED_ROOTS: resolve(root, logs.allowedRoot ?? 'workspace'),
    JARVIS_CORE_EVENT_LOG: resolve(root, logs.eventLogPath ?? 'logs/core-events.jsonl'),
    JARVIS_CORE_ORCHESTRATION_JOURNAL: resolve(root, logs.orchestrationJournalPath ?? 'logs/core-orchestration.jsonl'),
    JARVIS_CORE_WORKER_LEASE_STORE: resolve(root, logs.workerLeaseStorePath ?? 'logs/core-worker-leases.json'),
    JARVIS_CORE_WORKER_QUEUE_STORE: resolve(root, logs.workerQueueStorePath ?? 'logs/core-worker-queue.json'),
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: String(logs.workerDaemonAutostart ?? true),
    JARVIS_CORE_WORKER_DAEMON_INTERVAL_MS: String(logs.workerDaemonIntervalMs ?? 1000),
    JARVIS_CORE_WORKER_DAEMON_DRAIN_LIMIT: String(logs.workerDaemonDrainLimit ?? 5),
    JARVIS_CORE_ADMIN_TOKEN_SHA256: logs.adminTokenHash ?? '<set-admin-token-sha256-before-install>'
  };
  const nodeCommand = `node "${entryPath}"`;
  const commands = coreServiceCommandsFor({
    action,
    serviceName,
    displayName,
    description,
    startType,
    nodeCommand,
    environment,
    recovery
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
    localOnly: host === '127.0.0.1',
    endpoint: `http://${host}:${port}`,
    entryPath,
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
  add('admin-token-hash', servicePlan.environment.JARVIS_CORE_ADMIN_TOKEN_SHA256 !== '<set-admin-token-sha256-before-install>' ? 'pass' : 'warning', {
    message: 'Set JARVIS_CORE_ADMIN_TOKEN_SHA256 before production installation.'
  });
  add('persistent-runtime-stores', servicePlan.environment.JARVIS_CORE_EVENT_LOG && servicePlan.environment.JARVIS_CORE_WORKER_QUEUE_STORE && servicePlan.environment.JARVIS_CORE_WORKER_LEASE_STORE ? 'pass' : 'fail', {
    eventLogPath: servicePlan.environment.JARVIS_CORE_EVENT_LOG,
    queueStorePath: servicePlan.environment.JARVIS_CORE_WORKER_QUEUE_STORE,
    leaseStorePath: servicePlan.environment.JARVIS_CORE_WORKER_LEASE_STORE
  });
  add('service-recovery-policy', servicePlan.recovery.enabled && servicePlan.recovery.actions.some((action) => action.type === 'restart') ? 'pass' : 'warning', {
    recovery: servicePlan.recovery
  });
  add('service-plan-commands', servicePlan.commands.length >= 2 ? 'pass' : 'fail', {
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

export function coreServiceCommandsFor({ action, serviceName, displayName, description, startType, nodeCommand, environment, recovery }) {
  if (action === 'status') {
    return [
      `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      `Get-CimInstance Win32_Service -Filter "Name='${serviceName}'" | Select-Object Name, State, StartMode, PathName`
    ];
  }
  if (action === 'start') return [`Start-Service -Name "${serviceName}"`, `Get-Service -Name "${serviceName}"`];
  if (action === 'stop') return [`Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`, `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`];
  if (action === 'restart') return [`Restart-Service -Name "${serviceName}" -Force`, `Get-Service -Name "${serviceName}"`];
  if (action === 'uninstall') return [`Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`, `sc.exe delete "${serviceName}"`];

  const envAssignments = Object.entries(environment)
    .map(([key, value]) => `$env:${key}="${String(value).replaceAll('"', '\\"')}"`)
    .join('; ');
  const binaryPathName = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${envAssignments}; ${nodeCommand}"`;
  const configureCommands = [
    `sc.exe config "${serviceName}" binPath= '${binaryPathName}' start= ${startType}`,
    `sc.exe description "${serviceName}" "${description}"`,
    `Set-Service -Name "${serviceName}" -StartupType ${startType}`,
    ...coreServiceRecoveryCommands({ serviceName, recovery })
  ];
  if (action === 'update') {
    return [
      `Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      ...configureCommands,
      `Start-Service -Name "${serviceName}"`,
      `Get-Service -Name "${serviceName}"`
    ];
  }
  return [
    `$existingService = Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
    `if ($null -eq $existingService) { New-Service -Name "${serviceName}" -DisplayName "${displayName}" -Description "${description}" -StartupType ${startType} -BinaryPathName '${binaryPathName}' } else { sc.exe config "${serviceName}" binPath= '${binaryPathName}' start= ${startType}; sc.exe description "${serviceName}" "${description}" }`,
    `Set-Service -Name "${serviceName}" -StartupType ${startType}`,
    ...coreServiceRecoveryCommands({ serviceName, recovery }),
    `Start-Service -Name "${serviceName}"`
  ];
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
