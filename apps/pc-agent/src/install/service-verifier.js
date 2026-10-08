import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { createInstallerPackagePlan } from './installer-packager.js';
import { createServicePlan } from './service-planner.js';

const REQUIRED_PACKAGE_FILES = [
  'service-host.cs',
  'build-service-host.ps1',
  'install-service.ps1',
  'start-service.ps1',
  'stop-service.ps1',
  'restart-service.ps1',
  'update-service.ps1',
  'status-service.ps1',
  'uninstall-service.ps1',
  'verify-package.ps1',
  'installation-preflight.ps1',
  'verify-installed-service.ps1',
  'install-all.ps1',
  'install-verify-release.ps1',
  'sign-artifacts.ps1',
  'verify-signatures.ps1',
  'production-signing-policy.json',
  'verify-production-signing.ps1',
  'create-dev-signing-cert.ps1',
  'trust-dev-signing-cert.ps1',
  'untrust-dev-signing-cert.ps1',
  'verify-release-gate.ps1',
  'build-release-evidence.ps1',
  'installer.nsi',
  'build-nsis-installer.ps1',
  'release-manifest.json',
  'collect-logs.ps1',
  'tray-agent.ps1',
  'tray-agent.xaml',
  'jarvis.ico',
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.Wpf.dll',
  'WebView2Loader.dll',
  'WebView2-LICENSE.txt',
  'WebView2-provenance.json',
  'tray-agent.cs',
  'launch-tray.ps1',
  'build-tray-exe.ps1',
  'install-tray-shortcut.ps1',
  'uninstall-tray-shortcut.ps1',
  'tray-state.json',
  'package-manifest.json',
  'README-install.md'
];

export async function verifyPcAgentServiceReadiness({
  daemonConfig,
  serviceManifest,
  cwd = process.cwd(),
  packageDir = null,
  osPlatform = platform(),
  isAdministrator = false,
  clock = () => new Date()
} = {}) {
  const checks = [];
  const add = (id, status, detail = {}) => checks.push({ id, status, ...detail });
  const installPlan = createServicePlan({ action: 'install', daemonConfig, serviceManifest, cwd, execute: false });
  const statusPlan = createServicePlan({ action: 'status', daemonConfig, serviceManifest, cwd, execute: false });
  const endpoint = installPlan.endpoint;

  add('windows-platform', osPlatform === 'win32' ? 'pass' : 'warning', {
    expected: 'win32',
    actual: osPlatform,
    message: osPlatform === 'win32' ? 'Windows service scripts are platform-compatible.' : 'Service scripts can be packaged here, but must be installed on Windows.'
  });
  add('administrator-shell', isAdministrator ? 'pass' : 'warning', {
    message: isAdministrator ? 'Administrator shell is available.' : 'Install/update/start/stop actions require Administrator PowerShell.'
  });
  add('local-bind', daemonConfig.host === '127.0.0.1' && daemonConfig.safety?.localOnly === true ? 'pass' : 'fail', {
    host: daemonConfig.host,
    localOnly: daemonConfig.safety?.localOnly === true
  });
  add('capability-safety', daemonConfig.safety?.requiresCapabilityToken && daemonConfig.safety?.requiresUserConfirmation ? 'pass' : 'fail', {
    requiresCapabilityToken: daemonConfig.safety?.requiresCapabilityToken === true,
    requiresUserConfirmation: daemonConfig.safety?.requiresUserConfirmation === true
  });
  add('queue-drain-supervisor', daemonConfig.queueDrain?.enabled === true && Number(daemonConfig.queueDrain?.intervalMs) > 0 && Number(daemonConfig.queueDrain?.batchLimit) > 0 ? 'pass' : 'fail', {
    enabled: daemonConfig.queueDrain?.enabled === true,
    intervalMs: daemonConfig.queueDrain?.intervalMs ?? null,
    batchLimit: daemonConfig.queueDrain?.batchLimit ?? null,
    maxConsecutiveFailures: daemonConfig.queueDrain?.maxConsecutiveFailures ?? null
  });
  add('service-recovery-policy', serviceManifest.recovery?.enabled === true && (serviceManifest.recovery?.actions ?? []).some((action) => action.type === 'restart') ? 'pass' : 'warning', {
    enabled: serviceManifest.recovery?.enabled === true,
    actions: serviceManifest.recovery?.actions ?? [],
    restartOnNonCrashFailures: serviceManifest.recovery?.restartOnNonCrashFailures === true
  });

  const entryPath = resolve(cwd, serviceManifest.entry.script);
  add('entry-script', await canAccess(entryPath) ? 'pass' : 'fail', { path: entryPath });
  add('service-plan', installPlan.commands.length >= 3 && statusPlan.commands.length >= 1 ? 'pass' : 'fail', {
    installCommands: installPlan.commands.length,
    statusCommands: statusPlan.commands.length,
    hasIdempotentInstall: installPlan.commands.some((command) => command.includes('$existingService'))
  });

  const generatedPackage = createInstallerPackagePlan({ daemonConfig, serviceManifest, cwd, outputDir: packageDir ?? 'dist/pc-agent-installer' });
  add('generated-package-plan', REQUIRED_PACKAGE_FILES.every(name => generatedPackage.manifest.files.includes(name)) ? 'pass' : 'fail', {
    files: generatedPackage.manifest.files.length,
    requiredFiles: REQUIRED_PACKAGE_FILES.length,
    signatureDigestLength: generatedPackage.manifest.signature.digest.length
  });

  if (packageDir) {
    const packageReport = await verifyPackageDirectory({ packageDir, expectedFiles: REQUIRED_PACKAGE_FILES });
    add('package-directory', packageReport.missing.length === 0 ? 'pass' : 'fail', packageReport);
    const manifestReport = await verifyPackageManifest({ packageDir });
    add('package-manifest', manifestReport.valid ? 'pass' : 'fail', manifestReport);
  } else {
    add('package-directory', 'warning', { message: 'No packageDir supplied; generated plan was verified only in memory.' });
  }

  const failed = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warning');
  return {
    status: failed.length ? 'blocked' : warnings.length ? 'ready-with-warnings' : 'ready',
    generatedAt: clock().toISOString(),
    serviceName: serviceManifest.serviceName,
    endpoint,
    checks,
    nextActions: nextActionsFor({ failed, warnings, packageDir })
  };
}

async function verifyPackageDirectory({ packageDir, expectedFiles }) {
  const root = resolve(packageDir);
  const missing = [];
  const present = [];
  for (const fileName of expectedFiles) {
    const filePath = resolve(root, fileName);
    if (await canAccess(filePath)) present.push(fileName);
    else missing.push(fileName);
  }
  return { path: root, present, missing };
}

async function verifyPackageManifest({ packageDir }) {
  const manifestPath = resolve(packageDir, 'package-manifest.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const integrityFiles = Object.keys(manifest.fileIntegrity ?? {});
    const missingIntegrity = REQUIRED_PACKAGE_FILES
      .filter((fileName) => !['package-manifest.json', 'README-install.md'].includes(fileName))
      .filter((fileName) => !integrityFiles.includes(fileName));
    return {
      valid: missingIntegrity.length === 0 && manifest.signature?.digest?.length === 64,
      path: manifestPath,
      files: manifest.files?.length ?? 0,
      integrityFiles: integrityFiles.length,
      missingIntegrity,
      signatureStatus: manifest.signatureStatus,
      digestLength: manifest.signature?.digest?.length ?? 0
    };
  } catch (error) {
    return { valid: false, path: manifestPath, error: error.message };
  }
}

async function canAccess(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function nextActionsFor({ failed, warnings, packageDir }) {
  const actions = [];
  if (failed.some((check) => check.id === 'entry-script')) actions.push('Fix the service entry script path before installing.');
  if (failed.some((check) => check.id === 'local-bind')) actions.push('Bind the PC Agent only to 127.0.0.1 before service installation.');
  if (failed.some((check) => check.id === 'capability-safety')) actions.push('Require capability tokens and user confirmation in daemon-config.json.');
  if (failed.some((check) => check.id === 'queue-drain-supervisor')) actions.push('Enable queueDrain with a positive intervalMs and batchLimit in daemon-config.json.');
  if (failed.some((check) => check.id === 'package-directory')) actions.push('Run npm run pc-agent:package after npm run build so dist/pc-agent-installer contains the final package.');
  if (failed.some((check) => check.id === 'package-manifest')) actions.push('Regenerate the installer package and rerun verify-package.ps1.');
  if (warnings.some((check) => check.id === 'administrator-shell')) actions.push('Open Administrator PowerShell for install/update/start/stop operations.');
  if (warnings.some((check) => check.id === 'windows-platform')) actions.push('Run final service installation verification on a Windows host.');
  if (warnings.some((check) => check.id === 'service-recovery-policy')) actions.push('Configure Windows Service recovery restart actions before production installation.');
  if (!packageDir) actions.push('Pass a packageDir to verify the written installer package, not only the generated plan.');
  return actions;
}
