[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$CertificateThumbprint = $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT
)

$ErrorActionPreference = "Stop"
$windowsPowerShellModulePaths = @(
  (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "WindowsPowerShell\Modules"),
  (Join-Path $env:ProgramFiles "WindowsPowerShell\Modules"),
  (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\Modules")
)
$inheritedModulePaths = @($env:PSModulePath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$env:PSModulePath = @(($windowsPowerShellModulePaths + $inheritedModulePaths) | Select-Object -Unique) -join ";"
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $workspaceRoot "dist\pc-agent-installer"
$packageCli = Join-Path $workspaceRoot "apps\pc-agent\src\cli\package-installer.mjs"
$reportPath = Join-Path $workspaceRoot "dist\pc-agent-local-release-rebuild.json"
$trayPath = Join-Path $packageRoot "JarvisPcAgentTray.exe"
$staleReportNames = @(
  "signature-verification-report.json",
  "production-signing-report.json",
  "release-gate-report.json",
  "release-evidence.json",
  "install-release-report.json"
)

function Write-SafeReport([string]$Status, [array]$Checks, [hashtable]$Detail = @{}) {
  $parent = Split-Path -Parent $reportPath
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $report = [pscustomobject]@{
    reportVersion = "jarvis-pc-agent-local-release-rebuild-v1"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    status = $Status
    executeRequested = [bool]$Execute
    checks = @($Checks)
    detail = $Detail
    privacy = [pscustomobject]@{
      certificateThumbprintStored = $false
      certificateSubjectStored = $false
      privateKeyMaterialStored = $false
      artifactPathsStored = $false
    }
  } | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($reportPath, $report + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Add-Check([System.Collections.ArrayList]$Checks, [string]$Id, [bool]$Passed) {
  [void]$Checks.Add([pscustomobject]@{ id = $Id; passed = $Passed })
}

function Resolve-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return @(Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1).FullName
}

function Resolve-NsisCompiler {
  $command = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return @(
    (Join-Path $env:ProgramFiles "NSIS\makensis.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Resolve-CSharpCompiler {
  return @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Resolve-DevelopmentCertificate([string]$RequestedThumbprint) {
  $candidateThumbprints = New-Object System.Collections.ArrayList
  if (-not [string]::IsNullOrWhiteSpace($RequestedThumbprint)) {
    [void]$candidateThumbprints.Add($RequestedThumbprint.Replace(" ", "").ToUpperInvariant())
  }
  if (Test-Path -LiteralPath $trayPath -PathType Leaf) {
    $signature = Get-AuthenticodeSignature -LiteralPath $trayPath
    if ($signature.SignerCertificate) { [void]$candidateThumbprints.Add($signature.SignerCertificate.Thumbprint) }
  }
  $certificateReportPath = Join-Path $packageRoot "dev-signing-cert-report.json"
  if (Test-Path -LiteralPath $certificateReportPath -PathType Leaf) {
    try {
      $certificateReport = Get-Content -LiteralPath $certificateReportPath -Raw | ConvertFrom-Json
      if ($certificateReport.thumbprint) { [void]$candidateThumbprints.Add([string]$certificateReport.thumbprint) }
    } catch { }
  }
  foreach ($thumbprint in @($candidateThumbprints | Select-Object -Unique)) {
    $certificate = Get-Item -LiteralPath ("Cert:\CurrentUser\My\" + $thumbprint) -ErrorAction SilentlyContinue
    if ($certificate -and $certificate.HasPrivateKey -and $certificate.NotAfter -gt (Get-Date)) { return $certificate }
  }
  return $null
}

function Replace-Atomic([string]$Source, [string]$Destination, [string]$TransactionId) {
  $incoming = "$Destination.jarvis-incoming-$TransactionId"
  $replacementBackup = "$Destination.jarvis-replaced-$TransactionId"
  $parent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Copy-Item -LiteralPath $Source -Destination $incoming -Force
  try {
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
      [IO.File]::Replace($incoming, $Destination, $replacementBackup, $true)
    } else {
      [IO.File]::Move($incoming, $Destination)
    }
  } finally {
    Remove-Item -LiteralPath $incoming -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction SilentlyContinue
  }
}

function Assert-Descendant([string]$Path, [string]$Parent) {
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Operation path escaped the allowed directory."
  }
}

$checks = New-Object System.Collections.ArrayList
$node = Get-Command node -ErrorAction SilentlyContinue
$signTool = Resolve-SignTool
$nsis = Resolve-NsisCompiler
$csc = Resolve-CSharpCompiler
$certificate = Resolve-DevelopmentCertificate $CertificateThumbprint
$certificateEkuOids = if ($certificate) { @($certificate.EnhancedKeyUsageList | ForEach-Object {
  if ($_.ObjectId -is [string]) { [string]$_.ObjectId }
  elseif ($_.ObjectId.Value) { [string]$_.ObjectId.Value }
  else { [string]$_.ObjectId }
}) } else { @() }
Add-Check $checks "node-runtime-available" ($null -ne $node)
Add-Check $checks "package-generator-present" (Test-Path -LiteralPath $packageCli -PathType Leaf)
Add-Check $checks "windows-sdk-signtool-available" (-not [string]::IsNullOrWhiteSpace($signTool))
Add-Check $checks "windows-csharp-compiler-available" (-not [string]::IsNullOrWhiteSpace($csc))
Add-Check $checks "nsis-installer-compiler-available" (-not [string]::IsNullOrWhiteSpace($nsis))
Add-Check $checks "development-signing-certificate-available" ($null -ne $certificate)
Add-Check $checks "development-signing-certificate-code-signing-eku" ($certificate -and $certificateEkuOids -contains "1.3.6.1.5.5.7.3.3")

$failedChecks = @($checks | Where-Object { -not $_.passed })
if (-not $Execute) {
  $status = if ($failedChecks.Count -eq 0) { "ready" } else { "blocked" }
  Write-SafeReport $status $checks @{ artifactMutationCount = 0 }
  if ($status -eq "ready") { exit 0 }
  exit 2
}
if ($failedChecks.Count -gt 0) {
  Write-SafeReport "blocked" $checks @{ artifactMutationCount = 0 }
  throw "Local PC Agent release rebuild prerequisites are not satisfied."
}

$transactionId = [guid]::NewGuid().ToString("N")
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) "jarvis-local-release-$transactionId"
$stagePackageRoot = Join-Path $stageRoot "pc-agent-installer"
$backupRoot = Join-Path $stageRoot "backup"
$promotions = New-Object System.Collections.ArrayList
$promotedCount = 0
$trayWasRunning = $false
$trayRestarted = $false
$rollbackSucceeded = $true
$archivedReportCount = 0

try {
  Assert-Descendant $stageRoot ([IO.Path]::GetTempPath())
  New-Item -ItemType Directory -Path $stagePackageRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

  $rootManifestPath = Join-Path $packageRoot "package-manifest.json"
  if (Test-Path -LiteralPath $rootManifestPath -PathType Leaf) {
    $rootManifest = Get-Content -LiteralPath $rootManifestPath -Raw | ConvertFrom-Json
    foreach ($name in @($rootManifest.files)) {
      $source = Join-Path $packageRoot ([string]$name)
      if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $stagePackageRoot ([string]$name)) -Force }
    }
  }

  & $node.Source $packageCli --output $packageRoot --write-output $stagePackageRoot
  if ($LASTEXITCODE -ne 0) { throw "Staged source package generation failed." }
  & (Join-Path $stagePackageRoot "verify-package.ps1") -SourceOnly
  & (Join-Path $stagePackageRoot "build-tray-exe.ps1")
  & (Join-Path $stagePackageRoot "build-service-host.ps1")
  & (Join-Path $stagePackageRoot "sign-artifacts.ps1") -CertificateThumbprint $certificate.Thumbprint -SignToolPath $signTool -RuntimeOnly
  Push-Location $stagePackageRoot
  try { & (Join-Path $stagePackageRoot "build-nsis-installer.ps1") } finally { Pop-Location }
  & (Join-Path $stagePackageRoot "sign-artifacts.ps1") -CertificateThumbprint $certificate.Thumbprint -SignToolPath $signTool -SetupOnly
  & (Join-Path $stagePackageRoot "verify-package.ps1")

  $stageManifest = Get-Content -LiteralPath (Join-Path $stagePackageRoot "package-manifest.json") -Raw | ConvertFrom-Json
  $promotionNames = @($stageManifest.files) + @(
    "JarvisPcAgentTray.exe",
    "JarvisPcAgentServiceHost.exe",
    "runtime-integrity.psd1",
    "JARVIS-PC-Agent-Setup.exe",
    "signature-report.json"
  ) | Select-Object -Unique
  $index = 0
  foreach ($name in $promotionNames) {
    $source = Join-Path $stagePackageRoot ([string]$name)
    $destination = Join-Path $packageRoot ([string]$name)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "A staged artifact is missing: $name" }
    Assert-Descendant $destination $packageRoot
    $destinationExisted = Test-Path -LiteralPath $destination -PathType Leaf
    $backup = if ($destinationExisted) { Join-Path $backupRoot ("artifact-{0:D3}.original" -f $index) } else { $null }
    if ($destinationExisted) { Copy-Item -LiteralPath $destination -Destination $backup -Force }
    [void]$promotions.Add([pscustomobject]@{ source = $source; destination = $destination; backup = $backup; destinationExisted = [bool]$destinationExisted })
    $index += 1
  }

  $runningTray = @(Get-Process -Name "JarvisPcAgentTray" -ErrorAction SilentlyContinue | Where-Object {
    try { [string]::Equals([IO.Path]::GetFullPath($_.Path), [IO.Path]::GetFullPath($trayPath), [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
  $trayWasRunning = $runningTray.Count -gt 0
  if ($trayWasRunning) {
    $runningTray | Stop-Process -Force
    Start-Sleep -Milliseconds 500
  }

  foreach ($promotion in $promotions) {
    Replace-Atomic $promotion.source $promotion.destination $transactionId
    $promotedCount += 1
  }
  & (Join-Path $packageRoot "verify-package.ps1")

  if ($trayWasRunning) {
    Start-Process -FilePath $trayPath -WindowStyle Hidden
    $trayRestarted = $true
  }

  $archiveRoot = Join-Path $workspaceRoot ("artifacts\release-history\pc-agent-" + (Get-Date -Format "yyyyMMdd-HHmmssfff"))
  Assert-Descendant $archiveRoot (Join-Path $workspaceRoot "artifacts\release-history")
  foreach ($reportName in $staleReportNames) {
    $sourceReport = Join-Path $packageRoot $reportName
    if (-not (Test-Path -LiteralPath $sourceReport -PathType Leaf)) { continue }
    if (-not (Test-Path -LiteralPath $archiveRoot -PathType Container)) { New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null }
    Move-Item -LiteralPath $sourceReport -Destination (Join-Path $archiveRoot $reportName) -Force
    $archivedReportCount += 1
  }

  Write-SafeReport "passed" $checks @{
    sourceFileCount = @($stageManifest.files).Count
    promotedCount = $promotedCount
    packageVerified = $true
    trayWasRunning = $trayWasRunning
    trayRestarted = $trayRestarted
    staleReportsArchived = $archivedReportCount
  }
} catch {
  $failure = $_
  $promotedItems = @($promotions | Select-Object -First $promotedCount)
  [array]::Reverse($promotedItems)
  foreach ($promotion in $promotedItems) {
    try {
      if ($promotion.destinationExisted) {
        Replace-Atomic $promotion.backup $promotion.destination "rollback-$transactionId"
      } else {
        Assert-Descendant $promotion.destination $packageRoot
        Remove-Item -LiteralPath $promotion.destination -Force -ErrorAction SilentlyContinue
      }
    } catch { $rollbackSucceeded = $false }
  }
  if ($trayWasRunning -and -not (Get-Process -Name "JarvisPcAgentTray" -ErrorAction SilentlyContinue)) {
    try { Start-Process -FilePath $trayPath -WindowStyle Hidden; $trayRestarted = $true } catch { }
  }
  Write-SafeReport $(if ($rollbackSucceeded) { "failed-rolled-back" } else { "failed-rollback-required" }) $checks @{
    promotedCount = $promotedCount
    rollbackSucceeded = $rollbackSucceeded
    trayRestarted = $trayRestarted
    failureType = $failure.Exception.GetBaseException().GetType().Name
  }
  throw $failure
} finally {
  try {
    $resolvedStageRoot = [IO.Path]::GetFullPath($stageRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedStageRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedStageRoot).StartsWith("jarvis-local-release-")) {
      Remove-Item -LiteralPath $resolvedStageRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch { }
}
