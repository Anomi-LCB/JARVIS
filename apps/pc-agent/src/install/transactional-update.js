/** Versioned code folders, unchanged state/account, and a recoverable service-path switch. */
export function renderTransactionalPcUpdateScript({serviceName,helpers}) {
 return renderTransactionalServiceUpdateScript({serviceName,helpers,kind:'pc'});
}

export function renderTransactionalServiceUpdateScript({serviceName,helpers,kind='pc',preflight=[]}) {
 if(!['pc','core'].includes(kind))throw new Error('SERVICE_UPDATE_KIND_INVALID');
 if(!/^[A-Za-z0-9_.-]{1,100}$/u.test(serviceName))throw new Error('PC_UPDATE_SERVICE_NAME_INVALID');
 const quoted="'"+serviceName.replaceAll("'","''")+"'";
 const packageId=kind==='core'?'jarvis-core-service-windows':'jarvis-pc-agent-windows-service';
 const host=kind==='core'?'JarvisCoreRuntimeHost.exe':'JarvisPcAgentServiceHost.exe';
 const stateRead=kind==='core'?'$candidate.installedRuntime.stateRoot':'$candidate.runtimeState.root';
 const oldStateRead=kind==='core'?'$old.installedRuntime.stateRoot':'$old.runtimeState.root';
 const prefix=kind==='core'?'CORE_UPDATE':'PC_UPDATE';
 const coreContract=kind==='core'?String.raw`
 if (-not $candidate.installedRuntime) {throw "CORE_UPDATE_INSTALLED_RUNTIME_REQUIRED"}
 if (-not $old) {throw "CORE_UPDATE_PREVIOUS_MANIFEST_REQUIRED"}
 if ($old.installedRuntime -and $old.installedRuntime.packageRoot -eq $candidate.installedRuntime.packageRoot -and ($old.installedRuntime.launcherSha256 -ne $candidate.installedRuntime.launcherSha256 -or $old.installedRuntime.nodeSha256 -ne $candidate.installedRuntime.nodeSha256)) {throw "CORE_UPDATE_RUNTIME_VERSIONED_FOLDER_REQUIRED"}
 if ($old) {
  foreach($key in @('JARVIS_CORE_AUDIT_ROOT','JARVIS_CORE_ALLOWED_ROOTS','JARVIS_CORE_EVENT_LOG','JARVIS_CORE_ORCHESTRATION_JOURNAL','JARVIS_CORE_WORKER_LEASE_STORE','JARVIS_CORE_WORKER_QUEUE_STORE','JARVIS_CORE_INTEGRATION_VAULT','JARVIS_PERSONAL_OPERATIONS_DB','JARVIS_TRUST_ROOT','JARVIS_CORE_MISSION_STORE')) {
   if ([string]$old.environment.$key -ne [string]$candidate.environment.$key) {throw "CORE_UPDATE_DATA_CONTRACT_MIGRATION_REQUIRED"}
  }
  foreach($key in @('JARVIS_CORE_MISSION_STORE_BACKEND','JARVIS_CORE_MISSION_AUTHORITY_ENABLED','JARVIS_CORE_MISSION_AUTHORITY_SERVICE_ID','JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN','JARVIS_CORE_MISSION_AUTHORITY_TTL_MS','JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY')) {
   if ([string]$old.environment.$key -ne [string]$candidate.environment.$key) {throw "CORE_UPDATE_AUTHORITY_CONTRACT_MIGRATION_REQUIRED"}
  }
  foreach($key in @('id','initialExpectedToken','ttlMs')) {
   if ([string]$old.serviceAuthority.$key -ne [string]$candidate.serviceAuthority.$key) {throw "CORE_UPDATE_AUTHORITY_CONTRACT_MIGRATION_REQUIRED"}
  }
 }
 `:'';
 const healthCondition=kind==='core'?"$health.module -ne 'A_CORE' -or $health.status -ne 'running' -or $health.initialized -ne $true -or $health.apiAuthentication.configured -ne $true":"$health.module -ne 'B_PC_AGENT' -or $health.status -ne 'ok' -or $health.localOnly -ne $true";
 return String.raw`param([string]$ExistingStateRoot, [switch]$RollbackOnly)
$ErrorActionPreference = "Stop"
[void][Reflection.Assembly]::LoadWithPartialName('System.ServiceProcess')
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "관리자 권한이 필요합니다." }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceName = ${quoted}
${helpers.join('\n')}
function Canonical-State([string]$Path) {
 if (-not [IO.Path]::IsPathRooted($Path)) { throw "${prefix}_STATE_PATH_INVALID" }
 return [IO.Path]::GetFullPath($Path).TrimEnd('\','/')
}

function Read-NativeTarget([string]$Value) {
 $match = [regex]::Match($Value, '^"([^"\r\n]+\.exe)"\s*$|^([^"\r\n]+\.exe)\s*$', 'IgnoreCase')
 if (-not $match.Success) { throw "${prefix}_LEGACY_HOST_HANDOFF_REQUIRED" }
 if ($match.Groups[2].Success -and $match.Groups[2].Value -match '\s') {throw "${prefix}_LEGACY_HOST_HANDOFF_REQUIRED"}
 $path = if ($match.Groups[1].Success) {$match.Groups[1].Value} else {$match.Groups[2].Value}
 if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "${prefix}_OLD_HOST_MISSING" }
 if ($path.StartsWith('\\') -or ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw "${prefix}_LINKED_HOST_DENIED"}
 $cursor=[IO.Path]::GetFullPath($path)
 while (-not [string]::IsNullOrEmpty($cursor)) {if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw "${prefix}_LINKED_HOST_DENIED"}; $cursor=[IO.Path]::GetDirectoryName($cursor)}
 return [IO.Path]::GetFullPath($path)
}
function Read-CodeHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path); $sha=[Security.Cryptography.SHA256]::Create()
 try {return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose();$stream.Dispose()}
}
function Assert-LocalEndpoint([string]$Endpoint) {
 if ($Endpoint -notmatch '^http://127\.0\.0\.1:\d{1,5}/?$' -or ([uri]$Endpoint).Port -lt 1 -or ([uri]$Endpoint).Port -gt 65535) {throw "${prefix}_ENDPOINT_INVALID"}
}
function Wait-UpdateHealthy([string]$Endpoint, [DateTime]$NotBefore) {
 Assert-LocalEndpoint $Endpoint
 $NotBefore=$NotBefore.ToUniversalTime()
 $deadline=[DateTime]::UtcNow.AddSeconds(45)
 while ($true) {
  try {$health=Invoke-RestMethod -Uri ($Endpoint.TrimEnd('/')+'/health') -TimeoutSec 2 -MaximumRedirection 0; break}
  catch {if ($null -ne $_.Exception.Response -or [DateTime]::UtcNow -ge $deadline) {throw}; Start-Sleep -Milliseconds 250}
 }
 if (${healthCondition}) {throw "${prefix}_HEALTH_UNVERIFIED"}
 ${kind==='core'?String.raw`$started=[DateTimeOffset]::MinValue
 if (-not [DateTimeOffset]::TryParse([string]$health.startedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$started) -or $started.UtcDateTime -lt $NotBefore -or $started.UtcDateTime -gt [DateTime]::UtcNow.AddSeconds(5)) {throw "CORE_UPDATE_HEALTH_STALE"}`:''}
}
function Save-Transaction($Value) {
 $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 8))
 $temp = $journal + '.writing'
 $stream = [IO.File]::Open($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
 try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally {$stream.Dispose()}
 if ([IO.File]::Exists($journal)) {[IO.File]::Replace($temp,$journal,($journal+'.previous'))} else {[IO.File]::Move($temp,$journal)}
}
function Restore-Previous($Transaction) {
 $current = Get-CimInstance Win32_Service -Filter ("Name='"+$serviceName+"'")
 if ($Transaction.version -ne 1 -or $Transaction.serviceName -ne $serviceName) {throw "${prefix}_JOURNAL_INVALID"}
 if ($Transaction.wasRunning -isnot [bool] -or $Transaction.oldStartMode -notin @('Auto','Automatic','Manual','Disabled','Delayed-Auto') -or $Transaction.oldExecutableSha256 -notmatch '^[a-f0-9]{64}$' -or $Transaction.newExecutable -ne (Join-Path $root '${host}') -or (Read-NativeTarget $Transaction.oldBinaryPath) -ne $Transaction.oldExecutable) {throw "${prefix}_JOURNAL_INVALID"}
 if ($current.PathName -ne $Transaction.oldBinaryPath -and $current.PathName -ne ('"'+$Transaction.newExecutable+'"')) {throw "${prefix}_EXTERNAL_CONFIGURATION_CHANGED"}
 if ($current.StartName -ne $Transaction.account) { throw "${prefix}_ACCOUNT_CHANGED" }
 if ((Read-CodeHash $Transaction.oldExecutable) -ne $Transaction.oldExecutableSha256) {throw "${prefix}_ROLLBACK_CODE_CHANGED"}
 ${kind==='core'?'Assert-LocalEndpoint $Transaction.oldEndpoint':''}
 $Transaction.phase='rolling_back'; Save-Transaction $Transaction
 Stop-ServiceIfRunning $serviceName
 Invoke-ScConfig $serviceName $Transaction.oldBinaryPath $Transaction.oldStartMode
 if ($Transaction.wasRunning) {
  $restoringAt=[DateTime]::UtcNow
  Start-Service -Name $serviceName -ErrorAction Stop
  ${kind==='core'?'Wait-UpdateHealthy $Transaction.oldEndpoint $restoringAt':''}
 }
 $Transaction.phase='rolled_back'; Save-Transaction $Transaction
}
$mutex = New-Object Threading.Mutex($false, ("Global\JARVIS.${kind==='core'?'CoreUpdate':'PcUpdate'}."+$serviceName))
$owned=$false
try {
 try {$owned=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}
 if (-not $owned) {throw "${prefix}_ALREADY_RUNNING"}
 $candidate = Get-Content -LiteralPath (Join-Path $root 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if ($candidate.packageId -ne '${packageId}' -or $candidate.serviceName -ne $serviceName) {throw "${prefix}_MANIFEST_INVALID"}
 $state = Canonical-State ${stateRead}
 Assert-LocalEndpoint $candidate.endpoint
 # Privileged recovery instructions stay with trusted installed code, never in user task state.
 $journal = Join-Path $root 'service-update-transaction.json'
 & (Join-Path $root 'verify-package.ps1')
 if (Test-Path -LiteralPath $journal) {
  $previous = Get-Content -LiteralPath $journal -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($previous.serviceName -ne $serviceName -or (Canonical-State $previous.stateRoot) -ne $state) {throw "${prefix}_JOURNAL_INVALID"}
  if ($RollbackOnly) {Restore-Previous $previous; return}
  if ($previous.phase -notin @('committed','rolled_back')) {throw "${prefix}_RECOVERY_REQUIRED: update-service.ps1 -RollbackOnly"}
 } elseif ($RollbackOnly) {throw "${prefix}_RECOVERY_RECORD_MISSING"}
 $service = Get-CimInstance Win32_Service -Filter ("Name='"+$serviceName+"'")
 if ($null -eq $service) {throw "${prefix}_SERVICE_MISSING"}
 if ($service.State -notin @('Running','Stopped')) {throw "${prefix}_SERVICE_TRANSITIONING"}
 $oldExe=Read-NativeTarget $service.PathName
 $newExe=Join-Path $root '${host}'
 if ($oldExe -eq [IO.Path]::GetFullPath($newExe)) {throw "${prefix}_VERSIONED_FOLDER_REQUIRED"}
 $oldRecovery=Join-Path (Split-Path -Parent $oldExe) 'service-update-transaction.json'
 if (Test-Path -LiteralPath $oldRecovery) {
  $prior=Get-Content -LiteralPath $oldRecovery -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($prior.version -ne 1 -or $prior.serviceName -ne $serviceName -or $prior.phase -notin @('committed','rolled_back')) {throw '${prefix}_PREVIOUS_RECOVERY_REQUIRED'}
 }
 $old=$null
 $oldManifest=Join-Path (Split-Path -Parent $oldExe) 'package-manifest.json'
 if (Test-Path -LiteralPath $oldManifest) {
  $old=Get-Content -LiteralPath $oldManifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($old.packageId -ne $candidate.packageId -or $old.serviceName -ne $serviceName) {throw "${prefix}_PREVIOUS_MANIFEST_INVALID"}
  $knownState=${oldStateRead}
  if (-not $knownState) {$knownState=$ExistingStateRoot}
 } else {$knownState=$ExistingStateRoot}
 if (-not $knownState) {throw "${prefix}_EXISTING_STATE_REQUIRED"}
 if ((Canonical-State $knownState) -ne $state) {throw "${prefix}_STATE_MIGRATION_REQUIRED"}
 ${coreContract}
 ${preflight.join('\n')}
 [void](Read-NativeTarget ('"'+$newExe+'"'))
 $oldStartMode=$service.StartMode
 if ($oldStartMode -eq 'Auto' -and $service.DelayedAutoStart -eq $true) {$oldStartMode='Delayed-Auto'}
 $transaction=[pscustomobject]@{version=1;serviceName=$serviceName;stateRoot=$state;account=$service.StartName;oldExecutable=$oldExe;oldExecutableSha256=(Read-CodeHash $oldExe);oldBinaryPath=$service.PathName;oldStartMode=$oldStartMode;wasRunning=($service.State -eq 'Running');newExecutable=$newExe;${kind==='core'?'oldEndpoint=$old.endpoint;':''}phase='prepared';observedAt=[DateTime]::UtcNow.ToString('o')}
 Save-Transaction $transaction
 try {
  Stop-ServiceIfRunning $serviceName
  Invoke-ScConfig $serviceName ('"'+$newExe+'"') $transaction.oldStartMode
  $transaction.phase='switched'; Save-Transaction $transaction
  if ($transaction.wasRunning) {
   Start-Service -Name $serviceName -ErrorAction Stop
   Wait-UpdateHealthy $candidate.endpoint ([DateTime]$transaction.observedAt)
  }
  $transaction.phase='committed'; Save-Transaction $transaction
  if ($transaction.wasRunning) {Write-Host "업데이트 후 상태 확인 완료. 기존 상태 폴더와 서비스 계정을 보존했습니다."} else {Write-Host "실행 경로를 업데이트했습니다. 기존 중지 상태를 보존했으며 실행 검증은 보류입니다."}
 } catch {
  $failure=$_.Exception.Message
  try {Restore-Previous $transaction} catch {throw ("${prefix}_ROLLBACK_FAILED: "+$_.Exception.Message+"; initial: "+$failure)}
  throw ("${prefix}_FAILED_ROLLED_BACK: "+$failure)
 }
} finally {if ($owned) {$mutex.ReleaseMutex()}; $mutex.Dispose()}
`;
}

export function renderVersionInstallScript({serviceName}) {
 if(!/^[A-Za-z0-9_.-]{1,100}$/u.test(serviceName))throw new Error('PC_UPDATE_SERVICE_NAME_INVALID');
 return String.raw`# Generated version install entry. Does not enable login start by default.
param([switch]$EnableLoginStart)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceName='${serviceName}'
$before=Get-CimInstance Win32_Service -Filter ("Name='"+$serviceName+"'")
$wasRunning=$null -ne $before -and $before.State -eq 'Running'
if ($null -ne $before -and $before.State -notin @('Running','Stopped')) {throw 'PC_INSTALL_SERVICE_TRANSITIONING'}
& (Join-Path $root 'verify-package.ps1')
& (Join-Path $root 'install-service.ps1')
if ($null -eq $before) {& (Join-Path $root 'start-service.ps1')}
if ($null -eq $before -or $wasRunning) {& (Join-Path $root 'verify-installed-service.ps1')}
$startup=[Environment]::GetFolderPath('Startup')
if ($EnableLoginStart -or (Test-Path -LiteralPath (Join-Path $startup 'JARVIS PC Agent Tray.lnk'))) {
 & (Join-Path $root 'install-tray-shortcut.ps1')
}
if ($null -ne $before -and -not $wasRunning) {Write-Host '설정 업데이트 완료. 기존 중지 상태를 유지했으며 실행 검증은 보류입니다.'}
else {Write-Host '설치 및 서비스 확인을 완료했습니다.'}
`;
}
