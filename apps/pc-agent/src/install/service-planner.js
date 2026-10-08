import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadPcAgentInstallConfig({
  daemonConfigPath = process.env.JARVIS_PC_DAEMON_CONFIG_PATH ?? 'apps/pc-agent/install/daemon-config.json',
  serviceManifestPath = process.env.JARVIS_PC_SERVICE_MANIFEST_PATH ?? 'apps/pc-agent/install/windows-service-manifest.json'
} = {}) {
  const daemonConfig = JSON.parse(await readFile(daemonConfigPath, 'utf8'));
  const serviceManifest = JSON.parse(await readFile(serviceManifestPath, 'utf8'));
  return { daemonConfig, serviceManifest };
}

export function createServicePlan({ action, daemonConfig, serviceManifest, cwd = process.cwd(), execute = false }) {
  if (!['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'update'].includes(action)) {
    throw new Error(`Unsupported service action: ${action}`);
  }
  const root = resolve(cwd);
  const entryPath = resolve(root, serviceManifest.entry.script);
  const nodeCommand = `node "${entryPath}"`;
  const serviceName = serviceManifest.serviceName;
  const port = String(daemonConfig.port ?? serviceManifest.entry.environment.PORT ?? '17776');
  const environment = {
    ...serviceManifest.entry.environment,
    PORT: port,
    JARVIS_AUDIT_ROOT: resolve(root, daemonConfig.logs.auditRoot),
    JARVIS_UNDO_JOURNAL: resolve(root, daemonConfig.logs.undoJournalPath),
    JARVIS_ROLLBACK_TRANSACTIONS: resolve(root, daemonConfig.logs.rollbackTransactionPath ?? 'apps/pc-agent/logs/rollback-transactions.jsonl'),
    JARVIS_PACKET_JOURNAL: resolve(root, daemonConfig.logs.packetJournalPath ?? 'apps/pc-agent/logs/packet-journal.jsonl'),
    JARVIS_PACKET_QUEUE: resolve(root, daemonConfig.logs.packetQueuePath ?? 'apps/pc-agent/logs/packet-queue.jsonl'),
    JARVIS_TOKEN_VAULT: resolve(root, daemonConfig.logs.tokenVaultPath ?? 'apps/pc-agent/logs/capability-vault.jsonl'),
    JARVIS_ALLOWED_ROOTS: (daemonConfig.allowedRoots ?? ['./workspace']).map((path) => resolve(root, path)).join(';'),
    JARVIS_QUEUE_DRAIN_ENABLED: String(daemonConfig.queueDrain?.enabled ?? true),
    JARVIS_QUEUE_DRAIN_INTERVAL_MS: String(daemonConfig.queueDrain?.intervalMs ?? 1000),
    JARVIS_QUEUE_DRAIN_BATCH_LIMIT: String(daemonConfig.queueDrain?.batchLimit ?? 5),
    JARVIS_QUEUE_DRAIN_MAX_FAILURES: String(daemonConfig.queueDrain?.maxConsecutiveFailures ?? 3)
  };
  const commands = commandsFor({ action, serviceName, nodeCommand, serviceManifest, environment });
  return {
    action,
    execute,
    dryRun: !execute,
    serviceName,
    displayName: serviceManifest.displayName,
    localOnly: daemonConfig.safety.localOnly === true,
    endpoint: `http://${daemonConfig.host}:${port}`,
    entryPath,
    environment,
    safety: {
      ...daemonConfig.safety,
      installSafety: serviceManifest.installSafety
    },
    commands,
    warnings: execute ? [] : ['dry-run-only: pass --execute to run these commands manually outside Codex automation']
  };
}

function commandsFor({ action, serviceName, nodeCommand, serviceManifest, environment }) {
  if (action === 'status') {
    return [
      `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      `Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*node*" }`
    ];
  }
  if (action === 'start') {
    return [
      `Start-Service -Name "${serviceName}"`,
      `Get-Service -Name "${serviceName}"`
    ];
  }
  if (action === 'stop') {
    return [
      `Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`
    ];
  }
  if (action === 'restart') {
    return [
      `Restart-Service -Name "${serviceName}" -Force`,
      `Get-Service -Name "${serviceName}"`
    ];
  }
  if (action === 'uninstall') {
    return [
      `Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      `sc.exe delete "${serviceName}"`
    ];
  }
  const envAssignments = Object.entries(environment)
    .map(([key, value]) => `$env:${key}="${String(value).replaceAll('"', '\\"')}"`)
    .join('; ');
  const binaryPathName = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${envAssignments}; ${nodeCommand}"`;
  if (action === 'update') {
    return [
      `Stop-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      `sc.exe config "${serviceName}" binPath= '${binaryPathName}' start= ${serviceManifest.startType}`,
      `sc.exe description "${serviceName}" "${serviceManifest.description}"`,
      `Set-Service -Name "${serviceName}" -StartupType ${serviceManifest.startType}`,
      ...serviceRecoveryCommands({ serviceName, recovery: serviceManifest.recovery }),
      `Start-Service -Name "${serviceName}"`,
      `Get-Service -Name "${serviceName}"`
    ];
  }
  return [
    `$existingService = Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
    `if ($null -eq $existingService) { New-Service -Name "${serviceName}" -DisplayName "${serviceManifest.displayName}" -Description "${serviceManifest.description}" -StartupType ${serviceManifest.startType} -BinaryPathName '${binaryPathName}' } else { sc.exe config "${serviceName}" binPath= '${binaryPathName}' start= ${serviceManifest.startType}; sc.exe description "${serviceName}" "${serviceManifest.description}" }`,
    `Set-Service -Name "${serviceName}" -StartupType ${serviceManifest.startType}`,
    ...serviceRecoveryCommands({ serviceName, recovery: serviceManifest.recovery }),
    `Start-Service -Name "${serviceName}"`
  ];
}

export function serviceRecoveryCommands({ serviceName, recovery = {} }) {
  if (!recovery.enabled) return [];
  const actionMap = {
    restart: 'restart',
    reboot: 'reboot',
    run: 'run',
    none: ''
  };
  const actions = (recovery.actions ?? [{ type: 'restart', delayMs: 5000 }, { type: 'restart', delayMs: 30000 }, { type: 'none', delayMs: 0 }])
    .map((action) => `${actionMap[action.type] ?? ''}/${Number(action.delayMs ?? 0)}`)
    .join('/');
  return [
    `sc.exe failure "${serviceName}" reset= ${Number(recovery.resetSeconds ?? 86400)} actions= ${actions}`,
    `sc.exe failureflag "${serviceName}" ${recovery.restartOnNonCrashFailures ? '1' : '0'}`
  ];
}
