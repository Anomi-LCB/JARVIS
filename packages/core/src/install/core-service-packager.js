import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCoreServiceLifecyclePlan, coreServiceCommandsFor, coreServiceAccountCommands, coreServiceRecoveryCommands } from './core-service-planner.js';
import {validateCoreInstalledRuntimeBinding,assertCoreWritablePathOutsidePackage,installedBindingPreflightLines,installedBindingCsharp} from './core-installed-runtime-binding.js';
import {renderTransactionalServiceUpdateScript} from '../../../../apps/pc-agent/src/install/transactional-update.js';

const CORE_SERVICE_PACKAGE_FILES = [
  'service-host.cs',
  'build-service-host.ps1',
  'install-service.ps1',
  'update-service.ps1',
  'start-service.ps1',
  'stop-service.ps1',
  'restart-service.ps1',
  'status-service.ps1',
  'uninstall-service.ps1',
  'core-admin-token.ps1',
  'configure-core-admin-token.ps1',
  'verify-package.ps1',
  'verify-installed-core-service.ps1',
  'run-installed-service-smoke.ps1',
  'run-installed-service-soak.ps1',
  'collect-core-logs.ps1',
  'install-all.ps1',
  'package-manifest.json',
  'README-install.md'
];

export function createCoreServicePackagePlan({
  cwd = process.cwd(),
  outputDir = 'dist/core-service-package',
  serviceName = 'JARVISCoreRuntime',
  displayName = 'JARVIS Core Runtime',
  description = 'Local-first JARVIS A Common Core runtime and orchestration API.',
  startType = 'Automatic',
  serviceAccount = 'virtual',
  updateServiceAccount = 'preserve',
  port = 4071,
  host = '127.0.0.1',
  logs = {},
  recovery = {},
  installedRuntime = null,
  serviceAuthority = null,
  signed = false,
  generatedAt = new Date().toISOString()
} = {}) {
  const binding=installedRuntime?validateCoreInstalledRuntimeBinding(installedRuntime):null;
  const resolvedOutputDir = resolve(cwd, outputDir);
  if(binding&&updateServiceAccount!=='preserve')throw new Error('CORE_INSTALLED_UPDATE_IDENTITY_MUST_PRESERVE');
  const common = {
    cwd:binding?.stateRoot??cwd,
    ...(binding?{entryScript:binding.launcherPath}:{}),
    updatePackageRoot:binding?resolvedOutputDir:null,
    serviceName,
    displayName,
    description,
    startType,
    serviceAccount,
    port,
    host,
    logs,
    recovery,
    execute: false
  };
  const installPlan = createCoreServiceLifecyclePlan({ ...common, action: 'install' });
  const updatePlan = createCoreServiceLifecyclePlan({ ...common, action: 'update', serviceAccount: updateServiceAccount });
  const startPlan = createCoreServiceLifecyclePlan({ ...common, action: 'start' });
  const stopPlan = createCoreServiceLifecyclePlan({ ...common, action: 'stop' });
  const restartPlan = createCoreServiceLifecyclePlan({ ...common, action: 'restart' });
  const statusPlan = createCoreServiceLifecyclePlan({ ...common, action: 'status' });
  const uninstallPlan = createCoreServiceLifecyclePlan({ ...common, action: 'uninstall' });
  if(serviceAuthority!==null){
    if(!binding||!serviceAuthority||Object.keys(serviceAuthority).sort().join(',')!=='id,initialExpectedToken,ttlMs'
      ||!/^service:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(serviceAuthority.id??'')
      ||!Number.isSafeInteger(serviceAuthority.initialExpectedToken)||serviceAuthority.initialExpectedToken<0
      ||!Number.isSafeInteger(serviceAuthority.ttlMs)||serviceAuthority.ttlMs<1000||serviceAuthority.ttlMs>3600000)throw Error('CORE_SERVICE_AUTHORITY_CONFIGURATION_INVALID');
    for(const plan of [installPlan,updatePlan,startPlan,stopPlan,restartPlan,statusPlan,uninstallPlan])Object.assign(plan.environment,{
      JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',
      JARVIS_CORE_MISSION_AUTHORITY_SERVICE_ID:serviceAuthority.id,JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:String(serviceAuthority.initialExpectedToken),
      JARVIS_CORE_MISSION_AUTHORITY_TTL_MS:String(serviceAuthority.ttlMs),JARVIS_PERSONAL_OPERATIONS_DB:resolve(binding.stateRoot,'operations.sqlite')});
  }
  if(binding)for(const plan of [installPlan,updatePlan,startPlan,stopPlan,restartPlan,statusPlan,uninstallPlan]){
    plan.installedRuntime=binding;
    plan.environment.JARVIS_CORE_STATE_ROOT=binding.stateRoot;
    plan.environment.JARVIS_CORE_ROOT=binding.stateRoot;
    for(const key of ['JARVIS_CORE_AUDIT_ROOT','JARVIS_CORE_ALLOWED_ROOTS','JARVIS_CORE_EVENT_LOG','JARVIS_CORE_ORCHESTRATION_JOURNAL','JARVIS_CORE_WORKER_LEASE_STORE','JARVIS_CORE_WORKER_QUEUE_STORE'])assertCoreWritablePathOutsidePackage(binding,plan.environment[key]);
    plan.commands=coreServiceCommandsFor({...plan,nodeCommand:`"${binding.nodePath}" "${plan.entryPath}"`});
  }
  const serviceHostExe = 'JarvisCoreRuntimeHost.exe';
  const baseFiles = {
    'service-host.cs': renderCoreServiceHostSource({ installPlan, serviceHostExe, nodeExecutable: binding?.nodePath??process.execPath, cwd:binding?.stateRoot??cwd }),
    'build-service-host.ps1': renderBuildServiceHostScript({ serviceHostExe }),
    'install-service.ps1': renderInstallServiceScript({ installPlan, serviceHostExe }),
    'update-service.ps1': renderUpdateServiceScript({ updatePlan, statusPlan, serviceHostExe }),
    'start-service.ps1': renderPowerShellCommandScript({
      title: 'Start JARVIS Core Runtime service',
      commands: startPlan.commands,
      requiresAdmin: true
    }),
    'stop-service.ps1': renderPowerShellCommandScript({
      title: 'Stop JARVIS Core Runtime service',
      commands: stopPlan.commands,
      requiresAdmin: true
    }),
    'restart-service.ps1': renderPowerShellCommandScript({
      title: 'Restart JARVIS Core Runtime service',
      commands: restartPlan.commands,
      requiresAdmin: true
    }),
    'status-service.ps1': renderPowerShellCommandScript({
      title: 'Inspect JARVIS Core Runtime service',
      commands: statusPlan.commands,
      requiresAdmin: false
    }),
    'uninstall-service.ps1': renderPowerShellCommandScript({
      title: 'Uninstall JARVIS Core Runtime service',
      commands: uninstallPlan.commands,
      requiresAdmin: true
    }),
    'core-admin-token.ps1': renderCoreAdminTokenScript(),
    'configure-core-admin-token.ps1': renderConfigureCoreAdminTokenScript({ installPlan }),
    'verify-package.ps1': renderVerifyPackageScript(),
    'verify-installed-core-service.ps1': renderVerifyInstalledCoreServiceScript({ installPlan }),
    'run-installed-service-smoke.ps1': renderInstalledServiceSmokeScript({ installPlan }),
    'run-installed-service-soak.ps1': renderInstalledServiceSoakScript({ installPlan }),
    'collect-core-logs.ps1': renderCollectCoreLogsScript({ installPlan, outputDir: resolvedOutputDir }),
    'install-all.ps1': renderInstallAllScript()
  };
  // Windows PowerShell reads UTF-8 without a BOM as the local code page.
  // Include the encoding marker before calculating the actual file hashes.
  for(const name of Object.keys(baseFiles))if(name.endsWith('.ps1')&&!baseFiles[name].startsWith('\uFEFF'))baseFiles[name]='\uFEFF'+baseFiles[name];
  const fileIntegrity = createFileIntegrityManifest(baseFiles);
  const manifest = {
    packageVersion: 'a-core-service-package-v1',
    packageId: 'jarvis-core-service-windows',
    serviceName,
    displayName,
    serviceAccount,
    updateServiceAccount,
    version: '1.0.0',
    platform: 'win32',
    signed,
    signatureStatus: signed ? 'signed-local-dev-digest' : 'unsigned-local-build',
    signature: signPackageManifest({ fileIntegrity, serviceName, version: '1.0.0' }),
    endpoint: installPlan.endpoint,
    localOnly: installPlan.localOnly,
    outputDir: resolvedOutputDir,
    entryPath: installPlan.entryPath,
    runtimeEntry: binding?'pc-agent-runtime/core-launch.mjs':'scripts/core-service-runtime.mjs',
    serviceHostExecutable: serviceHostExe,
    nodeExecutable: binding?.nodePath??process.execPath,
    installedRuntime:binding,
    serviceAuthority,
    environment: installPlan.environment,
    files: CORE_SERVICE_PACKAGE_FILES,
    fileIntegrity,
    safety: {
      dryRunGenerated: true,
      serviceInstalledByPackage: false,
      actualServiceInstallRequiresAdministrator: true,
      bindsTo: host,
      adminTokenHashRequired: true,
      fullAgRuntimeEntry: true,
      defaultServiceAccount: 'per-service-virtual-account',
      updatePreservesExistingServiceAccount: updateServiceAccount === 'preserve',
      dataAclScope: ['workspace-read-execute', 'audit-root-modify', 'allowed-root-modify', 'ProgramData-service-root-modify']
    },
    generatedAt
  };
  const files = {
    ...baseFiles,
    'package-manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'README-install.md': renderInstallReadme({ manifest, installPlan })+(binding?'\n\nInstalled runtime binding: the service executes the explicitly pinned PC package Core launcher and Node binary, with state outside installed code. Updates require a different versioned service folder, unchanged storage and credential paths, and a preserved Windows identity. Candidate verification and compilation finish before stopping. service-update-transaction.json retains recovery checkpoints; use update-service.ps1 -RollbackOnly for interrupted recovery. Existing stopped/disabled state and delayed auto start are preserved. Neither state nor credentials are copied or overwritten. Do not run two Core authorities against the same state. Package generation and host preflight do not prove SCM installation, update rollback or Authenticode signing.\n':'\n\nLegacy update is blocked before any service change. Prepare a reviewed installed-runtime binding and versioned Core service package to use the transactional update path.\n')
  };
  return {
    manifest,
    outputDir: resolvedOutputDir,
    installPlan,
    updatePlan,
    startPlan,
    stopPlan,
    restartPlan,
    statusPlan,
    uninstallPlan,
    files
  };
}

export async function writeCoreServicePackage(options = {}) {
  const plan = createCoreServicePackagePlan(options);
  await mkdir(plan.outputDir, { recursive: true });
  const written = [];
  for (const [fileName, content] of Object.entries(plan.files)) {
    const path = resolve(plan.outputDir, fileName);
    await writeFile(path, content, 'utf8');
    written.push(path);
  }
  return {
    success: true,
    packageId: plan.manifest.packageId,
    outputDir: plan.outputDir,
    files: written,
    manifest: plan.manifest
  };
}

function renderPowerShellCommandScript({ title, commands, trailingCommands = [], requiresAdmin }) {
  const guard = requiresAdmin ? administratorGuardLines() : [];
  return [
    '# Generated by JARVIS Core service packager.',
    '$ErrorActionPreference = "Stop"',
    `Write-Host "${title}"`,
    ...guard,
    ...commands,
    ...trailingCommands
  ].join('\n');
}

function renderInstallServiceScript({ installPlan, serviceHostExe }) {
  return [
    '# Generated by JARVIS Core service packager.',
    '$ErrorActionPreference = "Stop"',
    'Write-Host "Install JARVIS Core Runtime service"',
    ...administratorGuardLines(),
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    `$serviceName = "${installPlan.serviceName}"`,
    `$displayName = "${installPlan.displayName}"`,
    `$description = "${installPlan.description}"`,
    `$startType = "${installPlan.startType ?? 'Automatic'}"`,
    ...scConfigHelperLines(),
    `$serviceHost = Join-Path $root "${serviceHostExe}"`,
    '$binaryPathName = "\`"" + $serviceHost + "\`""',
    '$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue',
    'if ($null -ne $existingService) { throw "Core service already exists. Use update-service.ps1 to preserve its Windows identity and existing DPAPI data path." }',
    ...installedBindingPreflightLines(installPlan.installedRuntime),
    '& (Join-Path $root "build-service-host.ps1")',
    '  New-Service -Name $serviceName -DisplayName $displayName -Description $description -StartupType Manual -BinaryPathName $binaryPathName',
    ...renderServiceAccountSetupLines(installPlan),
    ...renderServiceAccessGrantLines(installPlan),
    'Set-Service -Name $serviceName -StartupType $startType',
    ...coreServiceRecoveryCommands({ serviceName: installPlan.serviceName, recovery: installPlan.recovery }),
    'Start-Service -Name $serviceName',
    'Get-Service -Name $serviceName'
  ].join('\n');
}

function renderServiceAccountSetupLines(plan) {
  if (plan.serviceAccount === 'preserve') return [];
  const account = plan.serviceAccount === 'virtual' ? `NT SERVICE\\${plan.serviceName}` : 'LocalSystem';
  const setup = [
    `$serviceAccountName = ${powershellString(account)}`,
    '$accountOutput = & sc.exe config $serviceName obj= $serviceAccountName password= "" 2>&1',
    'if ($LASTEXITCODE -ne 0) { throw "Could not configure Core service account ($LASTEXITCODE): $accountOutput" }',
    ...(plan.serviceAccount === 'virtual' ? [
      '$sidOutput = & sc.exe sidtype $serviceName unrestricted 2>&1',
      'if ($LASTEXITCODE -ne 0) { throw "Could not enable the Core service SID ($LASTEXITCODE): $sidOutput" }'
    ] : [])
  ];
  return setup;
}

function renderServiceAccessGrantLines(plan) {
  const workspaceRoot = plan.workspaceRoot;
  const auditRoot = plan.environment.JARVIS_CORE_AUDIT_ROOT;
  const allowedRoot = plan.environment.JARVIS_CORE_ALLOWED_ROOTS;
  const dataRoot = `Join-Path $env:ProgramData (Join-Path 'JARVIS\\CoreRuntime' $serviceName)`;
  return [
    `$serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"`,
    'if ($null -eq $serviceInfo) { throw "Core service disappeared before access permissions were configured." }',
    '$serviceIdentity = [string]$serviceInfo.StartName',
    'if ($serviceIdentity -eq "LocalSystem") { $serviceIdentity = "SYSTEM" }',
    `$workspaceRoot = ${powershellString(workspaceRoot)}`,
    `$auditRoot = ${powershellString(auditRoot)}`,
    `$allowedRoot = ${powershellString(allowedRoot)}`,
    `$serviceDataRoot = ${dataRoot}`,
    'New-Item -ItemType Directory -Force -Path $auditRoot, $allowedRoot, $serviceDataRoot | Out-Null',
    'function Grant-CoreRuntimePath([string]$Path, [string]$Rights) {',
    '  $ace = "{0}:(OI)(CI){1}" -f $serviceIdentity, $Rights',
    '  $aclOutput = & icacls.exe $Path /grant $ace /C 2>&1',
    '  if ($LASTEXITCODE -ne 0) { throw "Could not grant Core service access to $Path ($LASTEXITCODE): $aclOutput" }',
    '}',
    'Grant-CoreRuntimePath $workspaceRoot "RX"',
    ...(plan.installedRuntime?[
      `Grant-CoreRuntimePath ${powershellString(plan.installedRuntime.packageRoot)} "RX"`,
      'Grant-CoreRuntimePath $workspaceRoot "M"'
    ]:[]),
    'Grant-CoreRuntimePath $auditRoot "M"',
    'Grant-CoreRuntimePath $allowedRoot "M"',
    'Grant-CoreRuntimePath $serviceDataRoot "M"'
  ];
}

function renderUpdateServiceScript({ updatePlan, statusPlan, serviceHostExe }) {
  if(updatePlan.installedRuntime)return renderTransactionalServiceUpdateScript({serviceName:updatePlan.serviceName,helpers:scConfigHelperLines(),kind:'core',
    preflight:[...installedBindingPreflightLines(updatePlan.installedRuntime),
      '& (Join-Path $root "build-service-host.ps1")',
      '$checkInfo=New-Object Diagnostics.ProcessStartInfo',
      '$checkInfo.FileName=$newExe; $checkInfo.Arguments="--check-runtime"; $checkInfo.UseShellExecute=$false; $checkInfo.CreateNoWindow=$true',
      '$checkProcess=[Diagnostics.Process]::Start($checkInfo)',
      'try { if (-not $checkProcess.WaitForExit(30000)) {$checkProcess.Kill(); throw "CORE_UPDATE_RUNTIME_PREFLIGHT_TIMEOUT"}; if ($checkProcess.ExitCode -ne 0) {throw ("CORE_UPDATE_RUNTIME_PREFLIGHT_FAILED: "+$checkProcess.ExitCode)} } finally {$checkProcess.Dispose()}'
    ]});
  return [
    '# Generated by JARVIS Core service packager.',
    '$ErrorActionPreference = "Stop"',
    'Write-Host "Update JARVIS Core Runtime service"',
    `$serviceName = "${updatePlan.serviceName}"`,
    'Get-CimInstance Win32_Service -Filter ("Name="+"\'"+$serviceName+"\'") | Select-Object Name, State, StartName, PathName',
    'throw "CORE_UPDATE_INSTALLED_RUNTIME_REQUIRED: prepare a reviewed versioned installed-runtime package. The legacy update path will not stop or overwrite this service."'
  ].join('\n');
}

function renderBuildServiceHostScript({ serviceHostExe }) {
  return [
    '# Generated by JARVIS Core service packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$source = Join-Path $root "service-host.cs"',
    `$output = Join-Path $root "${serviceHostExe}"`,
    '$candidateCompilers = @(',
    '  (Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),',
    '  (Join-Path $env:WINDIR "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe")',
    ')',
    '$csc = $candidateCompilers | Where-Object { Test-Path $_ } | Select-Object -First 1',
    'if (-not $csc) { throw "No .NET Framework C# compiler found. Install .NET Framework build tools or .NET SDK with csc support." }',
    '& $csc /target:exe /out:$output /reference:System.ServiceProcess.dll $source',
    'if ($LASTEXITCODE -ne 0) { throw "C# service host build failed with exit code $LASTEXITCODE." }',
    'if (-not (Test-Path $output)) { throw "C# service host build did not create $output" }',
    'Write-Host "Built JARVIS Core service host: $output"'
  ].join('\n');
}

function scConfigHelperLines() {
  return [
    'function Convert-ToScStartType([string]$Value) {',
    '  switch ($Value.ToLowerInvariant()) {',
    '    "automatic" { return "auto" }',
    '    "auto" { return "auto" }',
    '    "delayed-auto" { return "delayed-auto" }',
    '    "manual" { return "demand" }',
    '    "demand" { return "demand" }',
    '    "disabled" { return "disabled" }',
    '    default { throw "Unsupported service start type for sc.exe: $Value" }',
    '  }',
    '}',
    'function Invoke-ScConfig([string]$ServiceName, [string]$BinaryPathName, [string]$StartTypeValue) {',
    '  $scStartType = Convert-ToScStartType $StartTypeValue',
    '  $output = & sc.exe config $ServiceName binPath= $BinaryPathName start= $scStartType 2>&1',
    '  if ($LASTEXITCODE -ne 0) { throw "sc.exe config failed for $ServiceName ($LASTEXITCODE): $output" }',
    '}',
    'function Invoke-ScDescription([string]$ServiceName, [string]$Description) {',
    '  $output = & sc.exe description $ServiceName $Description 2>&1',
    '  if ($LASTEXITCODE -ne 0) { throw "sc.exe description failed for $ServiceName ($LASTEXITCODE): $output" }',
    '}',
    'function Stop-ServiceIfRunning([string]$ServiceName) {',
    '  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue',
    '  if ($null -ne $service -and $service.Status -ne "Stopped") {',
    '    Stop-Service -Name $ServiceName -Force -ErrorAction Stop',
    '    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))',
    '  }',
    '}'
  ];
}

function renderCoreServiceHostSource({ installPlan, nodeExecutable, cwd }) {
  const envLines = Object.entries(installPlan.environment)
    .filter(([key, value]) => shouldEmbedCoreServiceEnv(key, value))
    .map(([key, value]) => `    SetEnv(psi, ${csharpString(key)}, ${csharpString(value)});`);
  return [
    '// Generated by JARVIS Core service packager.',
    'using System;',
    'using System.Diagnostics;',
    'using System.IO;',
    'using System.ServiceProcess;',
    'using System.Threading;',
    '',
    'public sealed class JarvisCoreRuntimeHost : ServiceBase {',
    '  private Process child;',
    '  private volatile bool stopping = false;',
    '  private readonly object logLock = new object();',
    `  private readonly string workspaceRoot = ${csharpString(cwd)};`,
    `  private readonly string nodeExecutable = ${csharpString(nodeExecutable)};`,
    `  private readonly string entryPath = ${csharpString(installPlan.entryPath)};`,
    `  private readonly string serviceNameValue = ${csharpString(installPlan.serviceName)};`,
    '',
    '  public JarvisCoreRuntimeHost() {',
    '    ServiceName = serviceNameValue;',
    '    CanStop = true;',
    '    CanShutdown = true;',
    '    AutoLog = true;',
    '  }',
    '',
    '  protected override void OnStart(string[] args) {',
    '    VerifyRuntimeBinding();',
    '    var serviceDataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "JARVIS", "CoreRuntime", serviceNameValue);',
    '    Directory.CreateDirectory(serviceDataRoot);',
    '    Directory.CreateDirectory(Path.Combine(workspaceRoot, "logs"));',
    '    var psi = new ProcessStartInfo();',
    '    psi.FileName = nodeExecutable;',
    '    psi.Arguments = Quote(entryPath);',
    '    psi.WorkingDirectory = workspaceRoot;',
    '    psi.UseShellExecute = false;',
    '    psi.RedirectStandardOutput = true;',
    '    psi.RedirectStandardError = true;',
    '    psi.RedirectStandardInput = true;',
    '    psi.CreateNoWindow = true;',
    ...envLines,
    '    SetEnv(psi, "JARVIS_WINDOWS_SERVICE", "1");',
    '    SetEnv(psi, "JARVIS_CORE_SERVICE_STDIN_SHUTDOWN", "1");',
    '    child = new Process();',
    '    child.StartInfo = psi;',
    '    child.EnableRaisingEvents = true;',
    '    child.OutputDataReceived += (sender, eventArgs) => WriteLog(serviceDataRoot, eventArgs.Data);',
    '    child.ErrorDataReceived += (sender, eventArgs) => WriteLog(serviceDataRoot, eventArgs.Data);',
    '    child.Exited += (sender, eventArgs) => {',
    '      if (stopping) return;',
    '      var exitCode = child.ExitCode == 0 ? 1 : child.ExitCode;',
    '      WriteLog(serviceDataRoot, "JARVIS Core runtime child exited unexpectedly with code " + child.ExitCode + ". Terminating service host so SCM recovery can restart it.");',
    '      Environment.Exit(exitCode);',
    '    };',
    '    child.Start();',
    '    child.BeginOutputReadLine();',
    '    child.BeginErrorReadLine();',
    '    Thread.Sleep(1500);',
    '    if (child.HasExited) {',
    '      throw new Exception("JARVIS Core runtime exited during service startup with code " + child.ExitCode + ". See the service data directory under ProgramData.");',
    '    }',
    '  }',
    '',
    '  protected override void OnStop() {',
    '    stopping = true;',
    '    if (child == null) return;',
    '    try {',
    '      if (!child.HasExited) {',
    '        try { child.StandardInput.WriteLine("JARVIS_CORE_SERVICE_STOP_V1"); child.StandardInput.Flush(); child.StandardInput.Close(); } catch (IOException) {} catch (InvalidOperationException) {}',
    '        if (!child.WaitForExit(10000)) { child.Kill(); child.WaitForExit(10000); }',
    '      }',
    '    } catch (Exception error) {',
    '      WriteLog(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "JARVIS", "CoreRuntime", serviceNameValue), "Stop failed: " + error.Message);',
    '    }',
    '  }',
    '',
    '  private static void SetEnv(ProcessStartInfo psi, string key, string value) {',
    '    psi.EnvironmentVariables[key] = value ?? "";',
    '  }',
    '',
    '  private static string Quote(string value) {',
    '    return "\\\"" + value.Replace("\\\"", "\\\\\\\"") + "\\\"";',
    '  }',
    '',
    '  private void WriteLog(string packageRoot, string line) {',
    '    if (line == null) return;',
    '    lock (logLock) {',
    '      File.AppendAllText(Path.Combine(packageRoot, "core-service-host.log"), DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);',
    '    }',
    '  }',
    '',
    ...installedBindingCsharp(installPlan.installedRuntime,csharpString),
    '  public static void Main(string[] args) {',
    '    if(args.Length==1&&args[0]=="--check-runtime") { VerifyRuntimeBinding(); Console.WriteLine("CoreRuntimeBindingVerified"); return; }',
    '    ServiceBase.Run(new JarvisCoreRuntimeHost());',
    '  }',
    '}',
    ''
  ].join('\n');
}

function shouldEmbedCoreServiceEnv(key, value) {
  if (key === 'JARVIS_CORE_ADMIN_TOKEN_SHA256' || key === 'JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256') {
    return /^[a-f0-9]{64}$/i.test(String(value ?? ''));
  }
  return true;
}

function renderCoreAdminTokenScript() {
  return [
    '# Generated by JARVIS Core service packager.',
    'function Get-JarvisCoreAdminTokenPath([string]$Root) {',
    '  $base = $env:LOCALAPPDATA',
    '  if ([string]::IsNullOrWhiteSpace($base)) { $base = $Root }',
    '  $dir = Join-Path $base "JARVIS"',
    '  New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    '  return (Join-Path $dir "core-admin-token.dpapi")',
    '}',
    'function New-JarvisCoreAdminToken {',
    '  $bytes = New-Object byte[] 32',
    '  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()',
    '  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }',
    '  return ([Convert]::ToBase64String($bytes).TrimEnd("=") -replace "\\+", "-" -replace "/", "_")',
    '}',
    'function Get-JarvisCoreAdminTokenHash([string]$Token) {',
    '  $sha = [System.Security.Cryptography.SHA256]::Create()',
    '  try {',
    '    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Token)',
    '    return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")',
    '  } finally { $sha.Dispose() }',
    '}',
    'function Protect-JarvisCoreAdminToken([string]$Token, [string]$Root) {',
    '  $path = Get-JarvisCoreAdminTokenPath $Root',
    '  $secure = ConvertTo-SecureString -String $Token -AsPlainText -Force',
    '  $protected = $secure | ConvertFrom-SecureString',
    '  Set-Content -Path $path -Value $protected -Encoding UTF8',
    '  return $path',
    '}',
    'function Unprotect-JarvisCoreAdminToken([string]$Root) {',
    '  $path = Get-JarvisCoreAdminTokenPath $Root',
    '  if (-not (Test-Path $path)) { return "" }',
    '  $protected = Get-Content -Path $path -Raw',
    '  if ([string]::IsNullOrWhiteSpace($protected)) { return "" }',
    '  $secure = $protected | ConvertTo-SecureString',
    '  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    '  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }',
    '  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
    '}',
    'function Resolve-JarvisCoreAdminToken([string]$AdminToken, [string]$Root) {',
    '  if (-not [string]::IsNullOrWhiteSpace($AdminToken)) { return $AdminToken }',
    '  if (-not [string]::IsNullOrWhiteSpace($env:JARVIS_CORE_ADMIN_TOKEN)) { return $env:JARVIS_CORE_ADMIN_TOKEN }',
    '  return (Unprotect-JarvisCoreAdminToken $Root)',
    '}'
  ].join('\n');
}

function renderConfigureCoreAdminTokenScript() {
  return [
    '# Generated by JARVIS Core service packager.',
    'param([string]$AdminToken = $env:JARVIS_CORE_ADMIN_TOKEN, [switch]$CurrentUserOnly)',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '. (Join-Path $root "core-admin-token.ps1")',
    '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    '$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'if (-not $isAdmin -and -not $CurrentUserOnly) {',
    '  throw "Administrator PowerShell is required to set the Machine JARVIS_CORE_ADMIN_TOKEN_SHA256 environment variable. Use -CurrentUserOnly only for local script preparation."',
    '}',
    '$token = Resolve-JarvisCoreAdminToken -AdminToken $AdminToken -Root $root',
    '$generated = $false',
    'if ([string]::IsNullOrWhiteSpace($token)) {',
    '  $token = New-JarvisCoreAdminToken',
    '  $generated = $true',
    '}',
    '$tokenPath = Protect-JarvisCoreAdminToken -Token $token -Root $root',
    '$hash = Get-JarvisCoreAdminTokenHash $token',
    '$env:JARVIS_CORE_ADMIN_TOKEN = $token',
    '$env:JARVIS_CORE_ADMIN_TOKEN_SHA256 = $hash',
    'if (-not $CurrentUserOnly) {',
    '  [Environment]::SetEnvironmentVariable("JARVIS_CORE_ADMIN_TOKEN_SHA256", $hash, "Machine")',
    '}',
    '$report = [ordered]@{',
    '  reportVersion = "a-core-admin-token-configuration-v1"',
    '  status = "configured"',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  generatedNewToken = $generated',
    '  currentUserOnly = [bool]$CurrentUserOnly',
    '  machineHashConfigured = -not [bool]$CurrentUserOnly',
    '  encryptedTokenPath = $tokenPath',
    '  tokenHashPreview = ("sha256:" + $hash.Substring(0, 12) + "...")',
    '  rawAdminTokenStoredInReport = $false',
    '}',
    '$reportPath = Join-Path $root "core-admin-token-report.json"',
    '$report | ConvertTo-Json -Depth 8 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "JARVIS Core admin token configured. Raw token was sealed with Windows DPAPI for the current user and was not written to the report."',
    'Write-Host "Wrote $reportPath"'
  ].join('\n');
}

function renderVerifyPackageScript() {
  return [
    '# Generated by JARVIS Core service packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$manifestPath = Join-Path $root "package-manifest.json"',
    '$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json',
    'foreach ($file in $manifest.fileIntegrity.PSObject.Properties) {',
    '  $name = $file.Name',
    '  $expected = $file.Value.sha256',
    '  $path = Join-Path $root $name',
    '  if (-not (Test-Path $path)) { throw "Missing package file: $name" }',
    '  $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()',
    '  if ($actual -ne $expected) { throw "Digest mismatch for $name" }',
    '}',
    'if ($manifest.packageVersion -ne "a-core-service-package-v1") { throw "Unexpected package version: $($manifest.packageVersion)" }',
    'Write-Host "JARVIS Core service package verification passed."'
  ].join('\n');
}

function renderVerifyInstalledCoreServiceScript({ installPlan }) {
  return [
    '# Generated by JARVIS Core service packager.',
    'param([string]$AdminToken = $env:JARVIS_CORE_ADMIN_TOKEN)',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '. (Join-Path $root "core-admin-token.ps1")',
    '$AdminToken = Resolve-JarvisCoreAdminToken -AdminToken $AdminToken -Root $root',
    '$manifest = Get-Content (Join-Path $root "package-manifest.json") -Raw | ConvertFrom-Json',
    '$checks = @()',
    'function Add-Check([string]$Id, [string]$Status, [hashtable]$Detail = @{}) {',
    '  $item = [ordered]@{ id = $Id; status = $Status }',
    '  foreach ($key in $Detail.Keys) { $item[$key] = $Detail[$key] }',
    '  $script:checks += [pscustomobject]$item',
    '}',
    `$endpoint = "${installPlan.endpoint}"`,
    `$serviceName = "${installPlan.serviceName}"`,
    '$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue',
    'if ($null -eq $service) {',
    '  Add-Check "windows-service-present" "fail" @{ serviceName = $serviceName }',
    '} else {',
    '  $serviceStatus = "fail"',
    '  if ($service.Status -eq "Running") { $serviceStatus = "pass" }',
    '  Add-Check "windows-service-running" $serviceStatus @{ serviceName = $serviceName; serviceStatus = [string]$service.Status }',
    '}',
    `$serviceInfo = Get-CimInstance Win32_Service -Filter "Name='${installPlan.serviceName}'"`,
    `$expectedServiceAccount = ${powershellString(serviceAccountNameForPlan(installPlan))}`,
    '$actualServiceAccount = [string]$serviceInfo.StartName',
    '$accountStatus = "pass"',
    'if ($actualServiceAccount -ine $expectedServiceAccount) { $accountStatus = "fail" }',
    'Add-Check "service-logon-account" $accountStatus @{ expected = $expectedServiceAccount; actual = $actualServiceAccount }',
    'if ($actualServiceAccount -match "^NT SERVICE\\\\") {',
    '  $sidOutput = & sc.exe qsidtype $serviceName 2>&1 | Out-String',
    '  $sidStatus = "fail"',
    '  if ($sidOutput -match "UNRESTRICTED") { $sidStatus = "pass" }',
    '  Add-Check "service-sid-type" $sidStatus @{ actual = $sidOutput.Trim() }',
    '}',
    'try {',
    '  $health = Invoke-RestMethod -Uri "$endpoint/health" -Method Get -TimeoutSec 5',
    '  $healthStatus = "fail"',
    '  if ($health.module -eq "A_CORE") { $healthStatus = "pass" }',
    '  Add-Check "core-health-endpoint" $healthStatus @{ endpoint = "$endpoint/health"; module = $health.module; runtimeStatus = $health.status }',
    '} catch {',
    '  Add-Check "core-health-endpoint" "fail" @{ endpoint = "$endpoint/health"; error = $_.Exception.Message }',
    '}',
    'if ([string]::IsNullOrWhiteSpace($AdminToken)) {',
    '  Add-Check "admin-diagnostics" "warning" @{ message = "Set JARVIS_CORE_ADMIN_TOKEN or pass -AdminToken for protected diagnostics." }',
    '} else {',
    '  try {',
    '    $headers = @{ Authorization = "Bearer $AdminToken" }',
    '    $diag = Invoke-RestMethod -Uri "$endpoint/admin/diagnostics" -Method Get -Headers $headers -TimeoutSec 5',
    '    $diagStatus = "fail"',
    '    if ($diag.workerDaemon.daemonVersion -eq "a-core-worker-daemon-v1" -and $diag.adminAuth.authVersion -eq "a-core-admin-auth-v1") { $diagStatus = "pass" }',
    '    Add-Check "admin-diagnostics" $diagStatus @{ daemonVersion = $diag.workerDaemon.daemonVersion; adminAuthVersion = $diag.adminAuth.authVersion }',
    '  } catch {',
    '    Add-Check "admin-diagnostics" "fail" @{ error = $_.Exception.Message }',
    '  }',
    '}',
    '$failed = @($checks | Where-Object { $_.status -eq "fail" })',
    '$warnings = @($checks | Where-Object { $_.status -eq "warning" })',
    '$reportStatus = "passed"',
    'if ($failed.Count -gt 0) { $reportStatus = "failed" }',
    '$report = [ordered]@{',
    '  reportVersion = "a-core-installed-service-verification-v1"',
    '  status = $reportStatus',
    '  serviceName = $serviceName',
    '  endpoint = $endpoint',
    '  packageVersion = $manifest.packageVersion',
    '  checks = $checks',
    '  failedCount = $failed.Count',
    '  warningCount = $warnings.Count',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '}',
    '$reportPath = Join-Path $root "installed-service-verification.json"',
    '$report | ConvertTo-Json -Depth 10 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "Wrote $reportPath"',
    'if ($failed.Count -gt 0) { exit 1 }'
  ].join('\n');
}

function renderInstalledServiceSmokeScript({ installPlan }) {
  return [
    '# Generated by JARVIS Core service packager.',
    'param([string]$AdminToken = $env:JARVIS_CORE_ADMIN_TOKEN, [int]$TimeoutSec = 30)',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '. (Join-Path $root "core-admin-token.ps1")',
    '$AdminToken = Resolve-JarvisCoreAdminToken -AdminToken $AdminToken -Root $root',
    `$endpoint = "${installPlan.endpoint}"`,
    '$headers = @{}',
    'if (-not [string]::IsNullOrWhiteSpace($AdminToken)) { $headers.Authorization = "Bearer $AdminToken" }',
    '$checks = @()',
    'function Add-Check([string]$Id, [string]$Status, [hashtable]$Detail = @{}) {',
    '  $item = [ordered]@{ id = $Id; status = $Status }',
    '  foreach ($key in $Detail.Keys) { $item[$key] = $Detail[$key] }',
    '  $script:checks += [pscustomobject]$item',
    '}',
    '$health = Invoke-RestMethod -Uri "$endpoint/health" -Method Get -TimeoutSec 5',
    'if ($health.module -eq "A_CORE") { Add-Check "health" "pass" @{ module = $health.module } } else { Add-Check "health" "fail" @{ module = $health.module } }',
    '$taskBody = @{ rawText = "list files"; source = "installed-core-service-smoke" } | ConvertTo-Json -Depth 8',
    '$created = Invoke-RestMethod -Uri "$endpoint/tasks" -Method Post -ContentType "application/json" -Body $taskBody -TimeoutSec 5',
    'Add-Check "task-created" "pass" @{ taskId = $created.taskId }',
    '$queueBody = @{ options = @{ userConfirmation = @{ confirmed = $true }; timeoutMs = 30000 } } | ConvertTo-Json -Depth 8',
    '$queued = Invoke-RestMethod -Uri "$endpoint/tasks/$($created.taskId)/queue" -Method Post -ContentType "application/json" -Body $queueBody -TimeoutSec 5',
    'Add-Check "task-queued" "pass" @{ status = $queued.status }',
    'if ($headers.Authorization) {',
    '  $tickBody = @{ reason = "installed-core-service-smoke" } | ConvertTo-Json -Depth 8',
    '  $tick = Invoke-RestMethod -Uri "$endpoint/worker/daemon/tick" -Method Post -Headers $headers -ContentType "application/json" -Body $tickBody -TimeoutSec 10',
    '  Add-Check "daemon-tick" "pass" @{ processed = $tick.drain.processed }',
    '} else {',
    '  Add-Check "daemon-tick" "warning" @{ message = "No admin token supplied; relying on service daemon autostart." }',
    '}',
    '$detail = $null',
    '$completed = $false',
    'for ($i = 0; $i -lt ($TimeoutSec * 2); $i++) {',
    '  Start-Sleep -Milliseconds 500',
    '  $detail = Invoke-RestMethod -Uri "$endpoint/tasks/$($created.taskId)" -Method Get -Headers $headers -TimeoutSec 5',
    '  if ($detail.status -eq "COMPLETED") { $completed = $true; break }',
    '}',
    'if ($completed) { Add-Check "task-completed" "pass" @{ status = $detail.status } } else { Add-Check "task-completed" "fail" @{ status = $detail.status } }',
    '$verified = $false',
    'if ($detail.executionVerification.status -eq "passed") { $verified = $true }',
    'if ($verified) { Add-Check "execution-verified" "pass" @{ verification = $detail.executionVerification.status } } else { Add-Check "execution-verified" "fail" @{ verification = $detail.executionVerification.status } }',
    '$learned = $false',
    'if ($detail.learningResult.ingest.success -eq $true) { $learned = $true }',
    'if ($learned) { Add-Check "learning-ingested" "pass" @{} } else { Add-Check "learning-ingested" "fail" @{} }',
    '$failed = @($checks | Where-Object { $_.status -eq "fail" })',
    '$warnings = @($checks | Where-Object { $_.status -eq "warning" })',
    '$reportStatus = "passed"',
    'if ($failed.Count -gt 0) { $reportStatus = "failed" }',
    '$report = [ordered]@{',
    '  reportVersion = "a-core-installed-service-smoke-v1"',
    '  status = $reportStatus',
    '  endpoint = $endpoint',
    '  taskId = $created.taskId',
    '  taskStatus = $detail.status',
    '  checks = $checks',
    '  failedCount = $failed.Count',
    '  warningCount = $warnings.Count',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '}',
    '$reportPath = Join-Path $root "installed-service-smoke.json"',
    '$report | ConvertTo-Json -Depth 12 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "Wrote $reportPath"',
    'if ($failed.Count -gt 0) { exit 1 }'
  ].join('\n');
}

function renderInstalledServiceSoakScript({ installPlan }) {
  return [
    '# Generated by JARVIS Core service packager.',
    'param([string]$AdminToken = $env:JARVIS_CORE_ADMIN_TOKEN, [int]$TaskCount = 4, [int]$TimeoutSec = 60)',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '. (Join-Path $root "core-admin-token.ps1")',
    '$AdminToken = Resolve-JarvisCoreAdminToken -AdminToken $AdminToken -Root $root',
    `$endpoint = "${installPlan.endpoint}"`,
    '$headers = @{}',
    'if (-not [string]::IsNullOrWhiteSpace($AdminToken)) { $headers.Authorization = "Bearer $AdminToken" }',
    '$createdTasks = @()',
    'for ($index = 0; $index -lt $TaskCount; $index++) {',
    '  $taskBody = @{ rawText = "list files"; source = "installed-core-service-soak"; metadata = @{ soakIndex = $index } } | ConvertTo-Json -Depth 8',
    '  $task = Invoke-RestMethod -Uri "$endpoint/tasks" -Method Post -ContentType "application/json" -Body $taskBody -TimeoutSec 5',
    '  $queueBody = @{ options = @{ userConfirmation = @{ confirmed = $true }; timeoutMs = 30000 } } | ConvertTo-Json -Depth 8',
    '  Invoke-RestMethod -Uri "$endpoint/tasks/$($task.taskId)/queue" -Method Post -ContentType "application/json" -Body $queueBody -TimeoutSec 5 | Out-Null',
    '  $createdTasks += $task.taskId',
    '}',
    '$tickCount = 0',
    '$details = @{}',
    'for ($attempt = 0; $attempt -lt ($TimeoutSec * 2); $attempt++) {',
    '  if ($headers.Authorization) {',
    '    $tickBody = @{ reason = "installed-core-service-soak"; drainLimit = 2 } | ConvertTo-Json -Depth 8',
    '    Invoke-RestMethod -Uri "$endpoint/worker/daemon/tick" -Method Post -Headers $headers -ContentType "application/json" -Body $tickBody -TimeoutSec 10 | Out-Null',
    '    $tickCount += 1',
    '  }',
    '  $completed = 0',
    '  foreach ($taskId in $createdTasks) {',
    '    $detail = Invoke-RestMethod -Uri "$endpoint/tasks/$taskId" -Method Get -Headers $headers -TimeoutSec 5',
    '    $details[$taskId] = $detail',
    '    if ($detail.status -eq "COMPLETED") { $completed += 1 }',
    '  }',
    '  if ($completed -eq $createdTasks.Count) { break }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    '$completedCount = 0',
    '$verifiedCount = 0',
    '$learnedCount = 0',
    'foreach ($taskId in $createdTasks) {',
    '  $detail = $details[$taskId]',
    '  if ($detail.status -eq "COMPLETED") { $completedCount += 1 }',
    '  if ($detail.executionVerification.status -eq "passed") { $verifiedCount += 1 }',
    '  if ($detail.learningResult.ingest.success -eq $true) { $learnedCount += 1 }',
    '}',
    '$status = "passed"',
    'if ($completedCount -ne $createdTasks.Count -or $verifiedCount -ne $createdTasks.Count -or $learnedCount -ne $createdTasks.Count) { $status = "failed" }',
    '$report = [ordered]@{',
    '  reportVersion = "a-core-installed-service-soak-v1"',
    '  status = $status',
    '  endpoint = $endpoint',
    '  taskCount = $createdTasks.Count',
    '  completedCount = $completedCount',
    '  verifiedCount = $verifiedCount',
    '  learnedCount = $learnedCount',
    '  adminTickCount = $tickCount',
    '  taskIds = $createdTasks',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '}',
    '$reportPath = Join-Path $root "installed-service-soak.json"',
    '$report | ConvertTo-Json -Depth 12 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "Wrote $reportPath"',
    'if ($status -ne "passed") { exit 1 }'
  ].join('\n');
}

function renderCollectCoreLogsScript({ installPlan, outputDir }) {
  return [
    '# Generated by JARVIS Core service packager.',
    '$ErrorActionPreference = "Stop"',
    'Write-Host "Collect JARVIS Core Runtime logs"',
    `$source = "${installPlan.environment.JARVIS_CORE_AUDIT_ROOT}"`,
    `$serviceHostLog = Join-Path $env:ProgramData "JARVIS\\CoreRuntime\\${installPlan.serviceName}\\core-service-host.log"`,
    `$target = Join-Path "${outputDir}" ("core-service-logs-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")`,
    '$logPaths = @()',
    'if (Test-Path $source) { $logPaths += (Join-Path $source "*") }',
    'if (Test-Path $serviceHostLog) { $logPaths += $serviceHostLog }',
    'if ($logPaths.Count -eq 0) { throw "No Core runtime logs were found in $source or $serviceHostLog" }',
    'Compress-Archive -Path $logPaths -DestinationPath $target -Force',
    'Write-Host "Wrote $target"'
  ].join('\n');
}

function renderInstallAllScript() {
  return [
    '# Generated by JARVIS Core service packager.',
    'param([string]$AdminToken = $env:JARVIS_CORE_ADMIN_TOKEN, [switch]$SkipAdminTokenConfigure)',
    '$ErrorActionPreference = "Stop"',
    'Write-Host "Install, verify, and smoke-test JARVIS Core Runtime"',
    ...administratorGuardLines(),
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '. (Join-Path $root "core-admin-token.ps1")',
    'if (-not $SkipAdminTokenConfigure) {',
    '  $configureArgs = @()',
    '  if (-not [string]::IsNullOrWhiteSpace($AdminToken)) { $configureArgs += @("-AdminToken", $AdminToken) }',
    '  & (Join-Path $root "configure-core-admin-token.ps1") @configureArgs | Out-Null',
    '}',
    '$resolvedAdminToken = Resolve-JarvisCoreAdminToken -AdminToken $AdminToken -Root $root',
    '& (Join-Path $root "verify-package.ps1")',
    '& (Join-Path $root "install-service.ps1")',
    '& (Join-Path $root "verify-installed-core-service.ps1") -AdminToken $resolvedAdminToken',
    '& (Join-Path $root "run-installed-service-smoke.ps1") -AdminToken $resolvedAdminToken',
    'Write-Host "JARVIS Core Runtime install-all completed."'
  ].join('\n');
}

function renderInstallReadme({ manifest, installPlan }) {
  return [
    '# JARVIS Core Runtime Windows service package',
    '',
    `Package version: \`${manifest.packageVersion}\``,
    `Service: \`${manifest.serviceName}\``,
    `Endpoint: \`${manifest.endpoint}\``,
    `Runtime entry: \`${manifest.runtimeEntry}\``,
    '',
    '## Generated files',
    '',
    ...manifest.files.map((fileName) => `- \`${fileName}\``),
    '',
    '## Recommended flow',
    '',
    '```powershell',
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\verify-package.ps1',
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\configure-core-admin-token.ps1',
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-service.ps1',
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\verify-installed-core-service.ps1 -AdminToken $env:JARVIS_CORE_ADMIN_TOKEN',
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\run-installed-service-smoke.ps1 -AdminToken $env:JARVIS_CORE_ADMIN_TOKEN',
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\run-installed-service-soak.ps1 -AdminToken $env:JARVIS_CORE_ADMIN_TOKEN -TaskCount 4',
    '```',
    '',
    '## Service behavior',
    '',
    `The service installs \`${installPlan.entryPath}\`, which starts the full A-G Core runtime through \`scripts/core-service-runtime.mjs\`. The generated service environment includes persistent event, orchestration journal, worker queue, worker lease, admin auth, and CoreWorkerDaemon autostart settings.`,
    '',
    `A new installation runs as \`${serviceAccountNameForPlan(installPlan)}\`. The installer grants that identity read/execute access to the runtime workspace, modify access only to the configured audit and allowed-workspace roots, and modify access to its ProgramData log directory. Updates preserve the existing service identity by default because DPAPI-protected data is tied to its Windows identity; changing it requires an explicit migration and re-verification.`,
    'The install script refuses to run when the service already exists. Use the update script to avoid silently moving DPAPI-protected credentials between storage paths. Account migration is currently blocked until a verified decrypt/re-encrypt procedure exists.',
    '',
    '`configure-core-admin-token.ps1` seals the raw admin token with Windows DPAPI for the current user and writes only `JARVIS_CORE_ADMIN_TOKEN_SHA256` to the Machine environment for the service. The raw token is not written to reports.',
    '',
    'Installation, update, start, stop, restart, uninstall, and install-all scripts require Administrator PowerShell. The package itself is generated in dry-run mode; it does not install or modify a Windows service until one of those scripts is executed.'
  ].join('\n');
}

function administratorGuardLines() {
  return [
    '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    'if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
    '  throw "Administrator PowerShell is required for this operation."',
    '}'
  ];
}

function createFileIntegrityManifest(files) {
  return Object.fromEntries(
    Object.entries(files).map(([fileName, content]) => [
      fileName,
      {
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: Buffer.byteLength(content, 'utf8')
      }
    ])
  );
}

function signPackageManifest(payload) {
  return {
    algorithm: 'sha256-local-digest',
    digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
}

function csharpString(value) {
  return `@"${String(value ?? '').replaceAll('"', '""')}"`;
}

function serviceAccountNameForPlan(plan) {
  return plan.serviceAccount === 'virtual' ? `NT SERVICE\\${plan.serviceName}` : 'LocalSystem';
}

function powershellString(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}
